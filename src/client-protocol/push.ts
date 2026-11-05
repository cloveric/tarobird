import { z } from "zod";
import { idSchema } from "./index.js";
const httpsUrl = z.string().max(4096).url().refine((v) => { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.hash; }, "HTTPS push endpoint required");
const pushKeysSchema = z.object({ p256dh: z.string().min(80).max(128).regex(/^[A-Za-z0-9_=-]+$/), auth: z.string().min(16).max(64).regex(/^[A-Za-z0-9_=-]+$/) }).strict();
/** The installed iOS App's bundle identifier. Sent only to Hubs that advertise
 * `apnsTopics`; a subscription without it keeps the Hub's configured topic. */
export const apnsTopicSchema = z.string().min(3).max(155).regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/);
export const pushSubscriptionSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("apns"), token: z.string().regex(/^[a-f0-9]{32,512}$/i), topic: apnsTopicSchema.optional() }).strict(),
  z.object({ provider: z.literal("fcm"), token: z.string().min(32).max(4096).regex(/^[A-Za-z0-9_:\-]+$/) }).strict(),
  z.object({ provider: z.literal("webpush"), endpoint: httpsUrl, keys: pushKeysSchema }).strict(),
  z.object({ provider: z.literal("unifiedpush"), endpoint: httpsUrl, keys: pushKeysSchema.optional() }).strict(),
]);
export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;
// A binding is user intent, separate from a provider-invalidated token. Never
// disclose tokens to clients reading settings or deciding whether to refresh.
export const pushBindingSchema = z.object({ provider: z.enum(["apns", "fcm", "webpush", "unifiedpush"]).nullable(), revision: idSchema.nullable(), enabled: z.boolean(), subscribed: z.boolean().optional() }).strict()
  .refine((v) => (v.provider === null) === (v.revision === null));
export const pushRotationSchema = z.discriminatedUnion("provider", [
  pushSubscriptionSchema.options[0].extend({ expectedRevision: idSchema }),
  pushSubscriptionSchema.options[1].extend({ expectedRevision: idSchema }),
]);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
// Optional per-device customization. Absent means the original behavior (on).
// Hubs advertise support with `customization: true`; older Hubs reject these keys.
export const notificationOptionsSchema = z.object({ replyCompleted: z.boolean(), filesReceived: z.boolean(), needsAttention: z.boolean(), showPreview: z.boolean() }).partial().strict();
export type NotificationOptions = z.infer<typeof notificationOptionsSchema>;
export const legacyNotificationPreferencesSchema = z.object({ enabled: z.boolean().default(false), quietStart: time.or(z.literal("")).default(""), quietEnd: time.or(z.literal("")).default(""), timeZone: z.string().max(100).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }).default("UTC") }).strict();
export const notificationPreferencesSchema = legacyNotificationPreferencesSchema.extend(notificationOptionsSchema.shape).strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export const NOTIFICATION_OPTION_KEYS = ["replyCompleted", "filesReceived", "needsAttention", "showPreview"] as const satisfies readonly (keyof NotificationOptions)[];
export type NotificationTopic = Exclude<keyof NotificationOptions, "showPreview">;
/** A notice is allowed when any topic it belongs to is enabled. */
export function notificationAllowed(preferences: NotificationPreferences, topics: readonly NotificationTopic[]): boolean { return topics.some(topic => preferences[topic] !== false); }
export function notificationShowsPreview(preferences: NotificationPreferences): boolean { return preferences.showPreview !== false; }
export const pushPayloadSchema = z.object({ id: idSchema, hostId: z.string().regex(/^hub_[0-9a-f]{64}$/).optional(), title: z.literal("TaroCub"), body: z.string().max(200), conversationId: idSchema, messageId: idSchema, kind: z.enum(["answer", "action", "error"]), at: z.number().int() }).strict();
export type PushPayload = z.infer<typeof pushPayloadSchema>;
export function notificationLink(payload: Pick<PushPayload, "conversationId" | "messageId" | "hostId">): string { return `tarocub://conversation/${payload.conversationId}?message=${payload.messageId}${payload.hostId ? `&host=${payload.hostId}` : ""}`; }

export function quietNow(preferences: NotificationPreferences, now: number): boolean {
  if (!preferences.quietStart || !preferences.quietEnd || preferences.quietStart === preferences.quietEnd) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: preferences.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const current = `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`;
  return preferences.quietStart < preferences.quietEnd ? current >= preferences.quietStart && current < preferences.quietEnd : current >= preferences.quietStart || current < preferences.quietEnd;
}
