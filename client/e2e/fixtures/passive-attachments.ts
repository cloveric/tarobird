import { PassiveAttachments } from "../../src/passive-attachments.js";
import type { HubConnection } from "../../src/connection.js";
/** Visual fixtures provide original bytes; production sharing/cancellation still runs. */
export function addPassiveAttachments(connection: HubConnection): void {
  const pool = new PassiveAttachments(async () => undefined, (id, signal) => connection.blob(id, { signal }));
  connection.acquireAttachment = (id, interactive) => pool.acquire(id, interactive);
}
