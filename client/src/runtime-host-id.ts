import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Pure trust identity helper: importing it must never open or upgrade IDB. */
export function runtimeHostId(publicKey: string): string {
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(publicKey), c => c.charCodeAt(0)); } catch { throw new Error("invalid_hub_public_key"); }
  const prefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
  if (bytes.length !== 44 || prefix.some((v, i) => bytes[i] !== v) || btoa(String.fromCharCode(...bytes)) !== publicKey) throw new Error("invalid_hub_public_key");
  return `hub_${bytesToHex(sha256(bytes))}`;
}
