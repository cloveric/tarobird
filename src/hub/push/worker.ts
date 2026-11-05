import { notificationAllowed, notificationShowsPreview, pushPayloadSchema, pushSubscriptionSchema } from "../../client-protocol/push.js";
import type { HubStore } from "../store.js";
import { decodeNotificationClass, genericNotificationBody } from "../../client-protocol/notification-content.js";
import { effectivePreferences, quietNow } from "./model.js";
import type { PushSender } from "./providers.js";

type Row = { id: string; device_id: string; conversation_id: string; event_seq: number; payload_json: string; attempts: number; push_json: string | null; binding_revision: string | null; revoked: number; muted: number; read_seq: number; preferences_json: string | null; options_json: string | null; notice_class: string | null };
const readJson = (value: string | null): unknown => { try { return JSON.parse(value ?? "null"); } catch { return null; } };
export class PushWorker {
  private timer?: ReturnType<typeof setInterval>; private running?: Promise<void>; private stopped = false;
  constructor(private store: HubStore, private send: PushSender, private foreground: (deviceId: string) => boolean = () => false, private now: () => number = Date.now) {}
  start(): void { if (this.timer) return; this.stopped = false; this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 500); this.timer.unref(); }
  tick(): Promise<void> { if (this.running) return this.running; this.running = this.drain().finally(() => { this.running = undefined; }); return this.running; }
  private async drain(): Promise<void> {
    const rows = await this.store.db.serial(() => this.store.db.all<Row>("SELECT o.*,d.push_json,d.revoked,b.revision binding_revision,COALESCE(m.muted,1) muted,COALESCE(r.seq,0) read_seq,p.preferences_json,n.options_json FROM push_outbox o JOIN devices d ON d.id=o.device_id LEFT JOIN conversation_members m ON m.conversation_id=o.conversation_id AND m.member_type='user' AND m.member_id=d.user_id LEFT JOIN reads r ON r.user_id=d.user_id AND r.conversation_id=o.conversation_id LEFT JOIN device_preferences p ON p.device_id=d.id LEFT JOIN device_notification_options n ON n.device_id=d.id LEFT JOIN push_bindings b ON b.device_id=d.id WHERE o.status='pending' AND o.next_at<=? ORDER BY o.next_at,o.rowid LIMIT 32", [this.now()]));
    const deliveries = await Promise.allSettled(rows.map(async (row) => {
      if (this.stopped) return;
      const update = (status: string) => this.store.db.serial(() => this.store.db.run("UPDATE push_outbox SET status=? WHERE id=? AND status='pending'", [status, row.id]));
      const parsed = pushPayloadSchema.safeParse(readJson(row.payload_json)); const sub = pushSubscriptionSchema.safeParse(readJson(row.push_json)); const prefs = effectivePreferences(row.preferences_json, row.options_json);
      // Preferences can change while a row waits or retries: re-check the topic
      // and never send an excerpt queued before previews were hidden.
      const notice = parsed.success ? decodeNotificationClass(row.notice_class, parsed.data.kind) : undefined;
      if (!parsed.success || !notice || !sub.success || row.revoked || row.muted || !prefs.enabled || !notificationAllowed(prefs, notice.topics) || row.read_seq >= row.event_seq || this.now() - parsed.data.at > 86400_000) { await update("cancelled"); return; }
      if (this.foreground(row.device_id) || quietNow(prefs, this.now())) { await update("suppressed"); return; }
      const payload = notificationShowsPreview(prefs) ? parsed.data : { ...parsed.data, body: genericNotificationBody(notice.generic) };
      const result = await this.send(sub.data, payload).catch(() => "retry" as const);
      if (result === "sent") await update("sent");
      else if (result === "gone") { await this.store.db.transaction(async () => { await this.store.db.run("UPDATE devices SET push_json=NULL WHERE id=? AND push_json=? AND (SELECT revision FROM push_bindings WHERE device_id=devices.id) IS ?", [row.device_id, row.push_json, row.binding_revision]); await this.store.db.run("UPDATE push_outbox SET status='cancelled' WHERE id=?", [row.id]); }); }
      // Topic mismatch: this alert cannot be delivered, the subscription stays.
      else if (result === "rejected") await update("failed");
      else if (result === "unconfigured") await this.store.db.serial(() => this.store.db.run("UPDATE push_outbox SET next_at=? WHERE id=? AND status='pending'", [this.now() + 300_000, row.id]));
      else if (row.attempts >= 8) await update("failed");
      else await this.store.db.serial(() => this.store.db.run("UPDATE push_outbox SET attempts=attempts+1,next_at=? WHERE id=? AND status='pending'", [this.now() + Math.min(300_000, 1000 * 2 ** row.attempts), row.id]));
    }));
    const failures = deliveries.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "push_delivery_failed");
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.running; }
}
