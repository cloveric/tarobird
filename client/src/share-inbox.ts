import { Capacitor } from "@capacitor/core";
import { shareInbox } from "./share-inbox-bridge.js";
export { shareInbox } from "./share-inbox-bridge.js";
import { sharedItemSchema } from "./share-controller.js";
import type { RuntimeHost } from "./host-registry.js";
export const supportsShareInbox = () => Capacitor.isNativePlatform();
/** An offline staging hint only: the authenticated Hub rechecks every upload. */
export async function syncShareUploadLimit(maxFileBytes: number): Promise<void> { if (supportsShareInbox()) await shareInbox.setMaxFileBytes({ maxFileBytes }); }
export async function clearShareInbox(): Promise<void> { if (supportsShareInbox()) await shareInbox.clear(); }
/** Unassigned shares and every other pairing remain available. */
export async function clearHostShares(host: RuntimeHost): Promise<void> {
  if (!supportsShareInbox()) return;
  for (const raw of (await shareInbox.list()).items) {
    const parsed = sharedItemSchema.safeParse(raw);
    // Unknown records cannot be safely attributed to this pairing. Retain them.
    if (!parsed.success) continue;
    const item = parsed.data;
    if (item.delivery?.hubKey === host.publicKey && item.delivery.deviceId === host.deviceId) await shareInbox.remove({ id: item.id });
  }
}
