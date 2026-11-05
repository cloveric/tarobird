import { z } from "zod";

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
