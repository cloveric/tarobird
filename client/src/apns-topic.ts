import { apnsTopicSchema, pushSubscriptionSchema, type PushSubscription } from "../../src/client-protocol/push.js";

export type ApnsTopicIssue = "apns_topic_unsupported" | "apns_topic_not_allowed";
export class ApnsTopicError extends Error {
  constructor(readonly code: ApnsTopicIssue) { super(code); this.name = "ApnsTopicError"; }
}

let installed: Promise<string> | undefined;
/** The APNs topic is this installation's native bundle identifier, never a
 * bundled constant: a token is only valid for the App that received it. */
export function nativeApnsTopic(read: () => Promise<{ id: string }> = async () => (await import("@capacitor/app")).App.getInfo()): Promise<string> {
  installed ??= read().then((info) => apnsTopicSchema.parse(info.id));
  installed.catch(() => { installed = undefined; });
  return installed;
}

/** Older Hubs push every token under one configured topic. Without their
 * advertised allowlist this App cannot know that topic, so it does not register. */
export function apnsTopicFor(state: unknown, topic: string): string {
  const advertised = state && typeof state === "object" ? (state as { apnsTopics?: unknown }).apnsTopics : undefined;
  if (!Array.isArray(advertised)) throw new ApnsTopicError("apns_topic_unsupported");
  if (!advertised.includes(topic)) throw new ApnsTopicError("apns_topic_not_allowed");
  return topic;
}

/** System-push subscription for a Hub write. FCM is unchanged; APNs carries
 * the native topic only after the Hub's current state allows it. */
export async function systemPushSubscription(provider: "apns" | "fcm", token: string, hubState: () => Promise<unknown>, topic: () => Promise<string> = nativeApnsTopic): Promise<PushSubscription> {
  if (provider === "fcm") return pushSubscriptionSchema.parse({ provider, token });
  const [state, own] = await Promise.all([hubState(), topic()]);
  return pushSubscriptionSchema.parse({ provider, token, topic: apnsTopicFor(state, own) });
}
