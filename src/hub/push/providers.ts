import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, sensitiveHeaders } from "node:http2";
import webpush from "web-push";
import { z } from "zod";
import { apnsTopicSchema, pushSubscriptionSchema, type PushPayload, type PushSubscription } from "../../client-protocol/push.js";

export const pushConfigSchema = z.object({
  // `topic` stays the route for subscriptions without one (older clients).
  // `topics` adds bundle IDs that newer clients may declare for themselves.
  apns: z.object({ teamId: z.string().regex(/^[A-Z0-9]{10}$/), keyId: z.string().regex(/^[A-Z0-9]{10}$/), keyFile: z.string().min(1), topic: z.string().min(1).max(200), topics: z.array(apnsTopicSchema).max(8).optional(), sandbox: z.boolean().default(false) }).strict().optional(),
  fcm: z.object({ serviceAccountFile: z.string().min(1) }).strict().optional(),
  webpush: z.object({ subject: z.string().regex(/^(mailto:|https:\/\/)/), publicKey: z.string().min(80).max(100), privateKeyFile: z.string().min(1) }).strict().optional(),
  unifiedpush: z.object({ origins: z.array(z.string().url()).max(16) }).strict().optional(),
}).strict();
export type PushConfig = z.infer<typeof pushConfigSchema>;
/** `rejected`: the provider refused this delivery for a Host routing reason;
 * the device's subscription is still valid and must be kept. */
export type PushResult = "sent" | "retry" | "gone" | "unconfigured" | "rejected";
export type PushSender = (subscription: PushSubscription, payload: PushPayload) => Promise<PushResult>;
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function signedJwt(algorithm: "ES256" | "RS256", key: string, claims: object, keyId?: string): string {
  const input = encoded({ alg: algorithm, typ: "JWT", ...(keyId ? { kid: keyId } : {}) }) + "." + encoded(claims);
  return input + "." + sign("sha256", Buffer.from(input), algorithm === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key).toString("base64url");
}
/** Topics a client may declare: the default first, then configured additions. */
export function allowedApnsTopics(config: PushConfig): string[] {
  return config.apns ? [...new Set([config.apns.topic, ...config.apns.topics ?? []])] : [];
}
/** Registration and rotation must never store a topic this Host cannot use. */
export function assertApnsTopicAllowed(subscription: PushSubscription, config: PushConfig): void {
  if (subscription.provider === "apns" && subscription.topic !== undefined && !allowedApnsTopics(config).includes(subscription.topic)) throw new Error("apns_topic_not_allowed");
}
export function validatePushDestination(raw: unknown, config: PushConfig): PushSubscription {
  const subscription = pushSubscriptionSchema.parse(raw);
  assertApnsTopicAllowed(subscription, config);
  if (subscription.provider === "webpush") {
    const host = new URL(subscription.endpoint).hostname;
    if (!["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(host) && !host.endsWith(".push.services.mozilla.com") && !host.endsWith(".notify.windows.com")) throw new Error("push_endpoint_not_allowed");
  }
  if (subscription.provider === "unifiedpush") {
    const url = new URL(subscription.endpoint);
    if (!config.unifiedpush?.origins.includes(url.origin) || !/^\/[A-Za-z0-9_-]{16,512}$/.test(url.pathname)) throw new Error("unifiedpush_endpoint_not_allowed");
  }
  return subscription;
}
export function createPushSender(config: PushConfig, request: typeof fetch = fetch): PushSender {
  let apnsToken: { value: string; until: number } | undefined; let fcmToken: { value: string; until: number } | undefined; let refresh: Promise<string> | undefined;
  const fcmAccessToken = async () => {
    if (fcmToken && fcmToken.until > Date.now()) return fcmToken.value;
    if (!refresh) refresh = (async () => {
      const service = z.object({ project_id: z.string().regex(/^[a-z0-9-]+$/), client_email: z.string().email(), private_key: z.string().min(1) }).parse(JSON.parse(await readFile(config.fcm!.serviceAccountFile, "utf8")));
      const now = Math.floor(Date.now() / 1000); const assertion = signedJwt("RS256", service.private_key, { iss: service.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
      const response = await request("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
      if (!response.ok) throw new Error("push_oauth_failed");
      const token = z.object({ access_token: z.string(), expires_in: z.number().positive() }).parse(await response.json()); fcmToken = { value: token.access_token, until: Date.now() + Math.min(3300, token.expires_in - 60) * 1000 }; return token.access_token;
    })().finally(() => { refresh = undefined; });
    return refresh;
  };
  return async (subscription, payload) => {
    try {
      // A declared topic later removed from the allowlist waits for the
      // configuration; it is never sent under another topic or discarded.
      if (subscription.provider === "apns" && (!config.apns || subscription.topic !== undefined && !allowedApnsTopics(config).includes(subscription.topic))) return "unconfigured";
      validatePushDestination(subscription, config);
      if (subscription.provider === "apns") {
        if (!config.apns) return "unconfigured";
        const settings = config.apns, topic = subscription.topic ?? settings.topic;
        if (!apnsToken || apnsToken.until < Date.now()) apnsToken = { value: signedJwt("ES256", await readFile(settings.keyFile, "utf8"), { iss: settings.teamId, iat: Math.floor(Date.now() / 1000) }, settings.keyId), until: Date.now() + 50 * 60_000 };
        return await new Promise<PushResult>((resolve) => {
          const session = connect(settings.sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com"); let settled = false;
          const finish = (result: PushResult) => { if (settled) return; settled = true; session.destroy(); resolve(result); };
          session.on("error", () => finish("retry")); session.setTimeout(10_000, () => finish("retry"));
          const stream = session.request({ ":method": "POST", ":path": `/3/device/${subscription.token}`, authorization: `bearer ${apnsToken!.value}`, "apns-topic": topic, "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(Math.floor(payload.at / 1000) + 86400), "apns-collapse-id": payload.id.slice(-64), [sensitiveHeaders]: ["authorization", ":path"] });
          let status = 0; let body = ""; stream.on("response", (headers) => { status = Number(headers[":status"]); }); stream.on("error", () => finish("retry")); stream.on("data", (chunk: Buffer) => { body += chunk.toString(); if (body.length > 4096) finish("retry"); });
          // A token for another App's topic is a Host routing mismatch, not a
          // dead token: clearing it would destroy a valid subscription.
          stream.on("end", () => { if (status === 403) apnsToken = undefined; finish(status === 200 ? "sent" : status === 400 && /DeviceTokenNotForTopic/.test(body) ? "rejected" : status === 410 || status === 400 && /BadDeviceToken/.test(body) ? "gone" : "retry"); });
          stream.end(JSON.stringify({ aps: { alert: { title: "TaroBird", body: payload.body }, sound: "default" }, ...payload }));
        });
      }
      if (subscription.provider === "fcm") {
        if (!config.fcm) return "unconfigured";
        const service = z.object({ project_id: z.string().regex(/^[a-z0-9-]+$/) }).parse(JSON.parse(await readFile(config.fcm.serviceAccountFile, "utf8")));
        const response = await request(`https://fcm.googleapis.com/v1/projects/${service.project_id}/messages:send`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${await fcmAccessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: { token: subscription.token, data: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])), android: { priority: "HIGH", ttl: "86400s" } } }) });
        // Data-only messages are non-collapsible; the native service displays
        // each reminder under its own durable notification id.
        if (response.ok) return "sent";
        const error = z.object({ error: z.object({ details: z.array(z.object({ errorCode: z.string().optional() })).optional() }).optional() }).safeParse(await response.json());
        if (response.status === 401) fcmToken = undefined;
        return error.success && error.data.error?.details?.some((d) => d.errorCode === "UNREGISTERED") ? "gone" : "retry";
      }
      if (subscription.provider === "webpush") {
        if (!config.webpush) return "unconfigured";
        try { await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 86400, urgency: "high", timeout: 10_000, vapidDetails: { subject: config.webpush.subject, publicKey: config.webpush.publicKey, privateKey: (await readFile(config.webpush.privateKeyFile, "utf8")).trim() } }); return "sent"; }
        catch (error) { const status = (error as { statusCode?: number }).statusCode; return status === 404 || status === 410 ? "gone" : "retry"; }
      }
      if (!config.unifiedpush) return "unconfigured";
      const encrypted = subscription.keys ? webpush.generateRequestDetails({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify(payload), { TTL: 86400, urgency: "high" }) : undefined;
      const response = await request(subscription.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { ...(encrypted?.headers as Record<string, string> | undefined), "Content-Type": "application/octet-stream", "X-UnifiedPush": "1" }, body: encrypted?.body ? new Uint8Array(encrypted.body) : JSON.stringify(payload) });
      return response.ok ? "sent" : response.status === 404 || response.status === 410 ? "gone" : "retry";
    } catch { return "retry"; } // Provider bodies/errors can contain credentials.
  };
}
