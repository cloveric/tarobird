import { z } from "zod";
import { isLoopbackOrUnspecified } from "./loopback-address.js";

// A nonce signature alone authenticates an identity but not the TLS endpoint:
// a terminating proxy can forward that signature unchanged. Native transports
// must compare this proof with the certificate on their OWN TLS connection,
// then enforce that certificate on every authenticated HTTP/WS connection.
export const tlsIdentityNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const fields = {
  v: z.literal(1),
  type: z.literal("tls.identity"),
  publicKey: z.string().regex(/^[A-Za-z0-9+/]{59}=$/),
  nonce: tlsIdentityNonceSchema,
  certificateSha256: z.string().regex(/^[a-f0-9]{64}$/),
};
export const tlsIdentitySchema = z.object({ ...fields, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type TlsIdentity = z.infer<typeof tlsIdentitySchema>;
export type TlsIdentityUnsigned = Omit<TlsIdentity, "signature">;

export function tlsIdentityProof(value: TlsIdentityUnsigned): string {
  // Native implementations must reproduce these exact UTF-8 bytes (including
  // literal '/', never '\\/'). All variable fields have ASCII-only schemas.
  return JSON.stringify(["tarocub/tls-identity/v1", value.publicKey, value.nonce, value.certificateSha256]);
}

/** Caller must provide the DER SHA-256 observed by its native TLS stack, never
 * a value read from /health, a response header, or this proof itself. A fresh
 * random nonce is required for each attempt, including reconnect/rotation. */
export function verifyTlsIdentity(
  raw: unknown,
  expected: { publicKey: string; nonce: string; certificateSha256: string },
  verifySignature: (publicKey: string, signature: string, message: Uint8Array) => boolean,
): TlsIdentity {
  try {
    const proof = tlsIdentitySchema.parse(raw);
    if (proof.publicKey === expected.publicKey && proof.nonce === expected.nonce
      && proof.certificateSha256 === expected.certificateSha256
      && verifySignature(proof.publicKey, proof.signature, new TextEncoder().encode(tlsIdentityProof(proof)))) return proof;
  } catch { /* Malformed keys, proofs and verifier errors all fail closed. */ }
  throw new Error("tls_identity_mismatch");
}

// Edge-terminated HTTPS routes (such as user-DIY Cloudflare Tunnels) cannot pin
// the Hub's local leaf certificate because the edge terminates outer TLS with a
// WebPKI certificate. Instead, the Host only issues this proof on loopback for
// explicitly authorized origins, binding publicKey + fresh nonce + canonical
// origin so an arbitrary third-party proxy cannot replay another Hub's proof.
export const edgeOriginSchema = z.string().trim().max(2048).url().refine((value) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/"
      && !isLoopbackOrUnspecified(u.hostname);
  } catch { return false; }
}, "Edge origin must be a public HTTPS origin").transform((value) => new URL(value).origin);

const edgeFields = {
  v: z.literal(1),
  type: z.literal("edge.identity"),
  publicKey: z.string().regex(/^[A-Za-z0-9+/]{59}=$/),
  nonce: tlsIdentityNonceSchema,
  origin: edgeOriginSchema,
};
export const edgeIdentitySchema = z.object({ ...edgeFields, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type EdgeIdentity = z.infer<typeof edgeIdentitySchema>;
export type EdgeIdentityUnsigned = Omit<EdgeIdentity, "signature">;

export function edgeIdentityProof(value: EdgeIdentityUnsigned): string {
  // Exact cross-language UTF-8 transcript (literal '/', never '\\/').
  return JSON.stringify(["tarocub/edge-identity/v1", value.publicKey, value.nonce, value.origin]);
}

/** Verify an edge-terminated Hub identity proof after outer system WebPKI TLS
 * validation has already succeeded for `expected.origin`. */
export function verifyEdgeIdentity(
  raw: unknown,
  expected: { publicKey: string; nonce: string; origin: string },
  verifySignature: (publicKey: string, signature: string, message: Uint8Array) => boolean,
): EdgeIdentity {
  try {
    const canonicalOrigin = edgeOriginSchema.parse(expected.origin);
    const proof = edgeIdentitySchema.parse(raw);
    if (proof.publicKey === expected.publicKey && proof.nonce === expected.nonce
      && proof.origin === canonicalOrigin
      && verifySignature(proof.publicKey, proof.signature, new TextEncoder().encode(edgeIdentityProof(proof)))) return proof;
  } catch { /* Malformed keys, proofs and verifier errors all fail closed. */ }
  throw new Error("tls_identity_mismatch");
}
