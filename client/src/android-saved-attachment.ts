import { Capacitor, registerPlugin } from "@capacitor/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const remembersSavedAttachments = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

/** Names and network addresses are not file identities. Receipts stay on this
 * device and are isolated by the paired Hub, local identity and attachment. */
export function savedAttachmentKey(identity: { hubPublicKey?: string; deviceId?: string } | undefined, attachmentId: string): string | undefined {
  if (!remembersSavedAttachments() || !identity?.hubPublicKey || !identity.deviceId || !attachmentId) return;
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(["saved-attachment-v1", identity.hubPublicKey, identity.deviceId, attachmentId]))));
}

export type SavedAttachment = { path: string; location?: string };
/** null is a confirmed absent/stale receipt; undefined is an older bridge or
 * an unavailable check. Neither may manufacture a saved-file grant. */
export async function restoreSavedAttachment(key: string): Promise<SavedAttachment | null | undefined> {
  try {
    const plugin = registerPlugin<{ getSaved(options: { key: string }): Promise<{ saved: boolean; uri?: string; location?: string }> }>("TaroBotAttachmentSaver");
    const result = await plugin.getSaved({ key });
    if (result.saved === false) return null;
    if (result.saved === true && typeof result.uri === "string" && result.uri.startsWith("content://")) {
      return { path: result.uri, ...(typeof result.location === "string" ? { location: result.location } : {}) };
    }
  } catch { /* Old native bridges and transient storage errors remain retryable. */ }
}
