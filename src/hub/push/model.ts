import { createHash } from "node:crypto";
import type { HubEvent } from "../../client-protocol/index.js";
import { messageSchema } from "../../client-protocol/index.js";
import { quietNow, notificationAllowed, notificationOptionsSchema, notificationPreferencesSchema, notificationShowsPreview, type NotificationOptions, type NotificationPreferences, type PushPayload } from "../../client-protocol/push.js";
import { classifyNotification, encodeNotificationClass, genericNotificationBody, notificationPreview } from "../../client-protocol/notification-content.js";
import type { HubDatabase } from "../database.js";

export { quietNow } from "../../client-protocol/push.js";
export function parsePreferences(raw: string | null | undefined): NotificationPreferences { try { return notificationPreferencesSchema.parse(JSON.parse(raw ?? "{}")); } catch { return notificationPreferencesSchema.parse({}); } }
/** Customization lives outside `device_preferences`: a same-schema older Hub
 * strictly parses that JSON and would treat unknown keys as notifications off. */
export function parseNotificationOptions(raw: string | null | undefined): NotificationOptions { try { return notificationOptionsSchema.parse(JSON.parse(raw ?? "{}")); } catch { return {}; } }
export function effectivePreferences(preferences: string | null | undefined, options: string | null | undefined): NotificationPreferences {
  const legacy = parsePreferences(preferences);
  return { enabled: legacy.enabled, quietStart: legacy.quietStart, quietEnd: legacy.quietEnd, timeZone: legacy.timeZone, ...parseNotificationOptions(options) };
}
/** Called inside the same transaction that appends the event. No message can
 * commit while its notification disappears in the crash window afterwards. */
export async function enqueueEventPush(db: HubDatabase, event: HubEvent): Promise<void> {
  if (event.kind !== "message.created" && event.kind !== "message.updated") return;
  const message = messageSchema.parse(event.payload);
  const notice = classifyNotification(message); if (!notice) return;
  // Dispatcher worker conversations report through their dispatcher instead.
  if (await db.get("SELECT 1 FROM conversations WHERE id=? AND hidden=1", [event.conversationId])) return;
  const { kind } = notice;
  const recipients = await db.all<{ id: string; preferences_json: string | null; options_json: string | null }>("SELECT d.id,p.preferences_json,o.options_json FROM devices d JOIN conversation_members m ON m.member_type='user' AND m.member_id=d.user_id LEFT JOIN device_preferences p ON p.device_id=d.id LEFT JOIN device_notification_options o ON o.device_id=d.id WHERE m.conversation_id=? AND m.muted=0 AND d.revoked=0 AND d.push_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM message_deletions x WHERE x.user_id=d.user_id AND x.message_id=?)", [event.conversationId, message.id]);
  let preview: string | undefined;
  const previewBody = async () => {
    if (preview !== undefined) return preview;
    const context = await db.get<{ title: string; bot_name: string }>("SELECT c.title,COALESCE(b.name,'') bot_name FROM conversations c LEFT JOIN bots b ON b.id=? WHERE c.id=?", [message.authorId, event.conversationId]);
    return preview = notificationPreview(message, context?.title ?? "", context?.bot_name ?? "", kind, notice.incomplete, notice.uncertainBackground);
  };
  for (const device of recipients) {
    const preferences = effectivePreferences(device.preferences_json, device.options_json);
    if (!preferences.enabled || quietNow(preferences, event.at) || !notificationAllowed(preferences, notice.topics)) continue;
    const id = "push_" + createHash("sha256").update(`${device.id}\0${message.id}\0${kind}`).digest("hex");
    if (await db.get("SELECT 1 FROM push_receipts WHERE id=?", [id])) continue;
    // Hidden previews never store or send the conversation, Bot, file names or excerpt.
    const body = notificationShowsPreview(preferences) ? await previewBody() : genericNotificationBody(notice.generic);
    // Legacy wire discriminator used by installed clients' strict schema.
    // Providers/native shells render the current TaroBird/conversation title.
    const payload: PushPayload = { id, title: "TaroCub", body, conversationId: event.conversationId, messageId: message.id, kind, at: event.at };
    await db.run("INSERT OR IGNORE INTO push_outbox(id,device_id,conversation_id,event_seq,payload_json,next_at,notice_class) VALUES(?,?,?,?,?,?,?)", [id, device.id, event.conversationId, event.seq, JSON.stringify(payload), event.at + 1000, encodeNotificationClass(notice)]);
    // The same message transaction records admission even for an existing
    // compatible outbox row. Pruning old payloads must never re-arm its alert.
    await db.run("INSERT OR IGNORE INTO push_receipts(id,device_id,message_id) VALUES(?,?,?)", [id, device.id, message.id]);
  }
}
