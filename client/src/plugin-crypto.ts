import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { registerPluginCryptoBackend, type PluginCryptoBackend } from "../../src/client-protocol/plugins.js";

const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function verifyEd25519Spki(publicKeySpkiBase64: string, signatureBase64: string, payload: Uint8Array): boolean {
  try {
    const spki = decodeBase64(publicKeySpkiBase64.trim());
    if (spki.length !== 44 || ED25519_SPKI_PREFIX.some((byte, index) => spki[index] !== byte)) {
      return false;
    }
    const sig = decodeBase64(signatureBase64.trim());
    if (sig.length !== 64) return false;
    return ed25519.verify(sig, payload, spki.subarray(12), { zip215: false });
  } catch {
    return false;
  }
}

export const noblePluginCryptoBackend: PluginCryptoBackend = {
  sha256: (bytes: Uint8Array): Uint8Array => sha256(bytes),
  verifyEd25519: verifyEd25519Spki,
};

registerPluginCryptoBackend(noblePluginCryptoBackend);
