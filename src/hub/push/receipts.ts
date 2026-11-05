import type { HubDatabase } from "../database.js";

/** Existing installations (including older compatible writers) may only have
 * outbox rows. Preserve their notification identities before retiring payloads.
 * The receipt has no message body and follows the physical message/device life.
 * Invalid legacy payloads were never deliverable and cannot create receipts. */
export async function retainPushReceipts(db: HubDatabase, before?: number): Promise<void> {
  await db.run(`INSERT OR IGNORE INTO push_receipts(id,device_id,message_id)
    SELECT p.id,p.device_id,m.id FROM push_outbox p
    JOIN messages m ON m.id=CASE WHEN json_valid(p.payload_json) THEN json_extract(p.payload_json,'$.messageId') END
    JOIN devices d ON d.id=p.device_id
    WHERE d.revoked=0${before === undefined ? "" : " AND p.status!='pending' AND p.next_at<?"}`, before === undefined ? [] : [before]);
}
