import { createHash, randomBytes, verify } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { checkServerIdentity, type PeerCertificate, type TLSSocket } from "node:tls";
import type { Route } from "../client-protocol/routes.js";
import { verifyTlsIdentity } from "../client-protocol/tls-identity.js";
import { parsePublicKey } from "./auth.js";
import { HubError } from "./store.js";

// The App's TLS identity proof, applied Host to Host: a peer Hub signs the DER
// SHA-256 of the leaf certificate on the probing connection, and requests then
// go only to that pinned certificate. A relay that terminates TLS with its own
// valid certificate cannot reuse a forwarded proof. Every Hub that can join a
// private network or exchange Bot messages serves /api/tls-identity. Pins follow
// the native App transport's lifetime and bound the shared proof rate budget.
const PIN_MS = 5 * 60_000, MAX_PINS = 256;
const pins = new Map<string, { sha256: string; until: number }>();

export class TlsPinMismatch extends HubError { constructor() { super("peer_tls_identity_mismatch", 502); } }
export type PeerTls = { pin?: string; observe?: (sha256: string) => void };

const pinKey = (publicKey: string, route: Route) => `${publicKey}\0${new URL(route.url).origin}`;
const certificateSha256 = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");

/** Request options: runs inside the handshake, so a pin mismatch destroys the
 * socket before any request header or body is written to it. */
export function peerTlsOptions(tls: PeerTls): { checkServerIdentity: (hostname: string, certificate: PeerCertificate) => Error | undefined } {
  return {
    checkServerIdentity: (hostname, certificate) => {
      const error = checkServerIdentity(hostname, certificate);
      if (error) return error;
      if (tls.pin && (!certificate.raw || certificateSha256(certificate.raw) !== tls.pin)) return new TlsPinMismatch();
      return undefined;
    },
  };
}

/** Report the response connection's leaf certificate to a probe. Returns an
 * error instead of destroying, so callers reject before any 'error' event. */
export function observePeerCertificate(res: IncomingMessage, tls: PeerTls): HubError | undefined {
  if (!tls.observe) return undefined;
  const raw = (res.socket as TLSSocket).getPeerCertificate?.()?.raw;
  if (!raw?.length) return new HubError("tls_certificate_unavailable", 502);
  tls.observe(certificateSha256(raw));
  return undefined;
}

export function forgetPeerPin(publicKey: string, route: Route): void { pins.delete(pinKey(publicKey, route)); }

/** Prove `publicKey` on this route over a fresh connection and pin the TLS
 * leaf it signed. Probes carry only a random nonce. */
export async function peerPin(publicKey: string, route: Route, probe: (path: string, tls: PeerTls) => Promise<unknown>): Promise<{ pin: string; cached: boolean }> {
  const key = pinKey(publicKey, route), now = Date.now(), cached = pins.get(key);
  if (cached && cached.until > now) return { pin: cached.sha256, cached: true };
  const nonce = randomBytes(32).toString("base64url");
  let observed = "";
  const proof = await probe(`/api/tls-identity?nonce=${nonce}`, { observe: sha256 => { observed = sha256; } });
  verifyTlsIdentity(proof, { publicKey, nonce, certificateSha256: observed },
    (signer, signature, message) => verify(null, message, parsePublicKey(signer), Buffer.from(signature, "base64")));
  if (!pins.has(key) && pins.size >= MAX_PINS) for (const [old, entry] of pins) if (entry.until <= now || pins.size >= MAX_PINS) pins.delete(old);
  pins.set(key, { sha256: observed, until: Date.now() + PIN_MS });
  return { pin: observed, cached: false };
}
