import { createHmac } from "node:crypto";
import { z } from "zod";
import type { QuotaEngine } from "../client-protocol/engine-quota.js";

/** Internal Gateway-to-Hub capability for matching Host-verified account proofs in memory.
 * Private proofs never enter client-facing DTOs. */
export const ENGINE_QUOTA_ACCOUNT_MATCH_CAPABILITY = "engines.quota.account-match.v1";
const scopeIdentifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
export const QUOTA_ACCOUNT_KEY_HEX = /^[0-9a-f]{64}$/;
export const quotaAccountProofRequestSchema = z.object({
  scopeId: scopeIdentifier,
  expectedRevision: scopeIdentifier,
}).strict();
export const quotaAccountProofReplySchema = z.object({
  scopeId: scopeIdentifier,
  revision: scopeIdentifier,
  accountKey: z.string().regex(QUOTA_ACCOUNT_KEY_HEX).optional(),
}).strict();

export type QuotaScopeGenerations = {
  engine: QuotaEngine;
  configurationGeneration: string;
  credentialGeneration: string;
  workerGeneration: string;
};
// Private, ephemeral evidence: never add this object to a client-protocol reply.
export type QuotaAccountProof = { engine: QuotaEngine; accountKey: string; scopeStamp: string };

function digest(key: Uint8Array, values: string[]): string {
  if (key.byteLength < 32 || values.some(value => !value || value.length > 65536)) throw new Error("scope_unverifiable");
  return createHmac("sha256", key).update(JSON.stringify(values)).digest("hex");
}

/** Generations must represent current effective configuration/auth, not just the path of a home directory. */
export function createQuotaScopeStamp(key: Uint8Array, parts: QuotaScopeGenerations): string {
  return digest(key, ["quota-scope-v1", parts.engine, parts.configurationGeneration, parts.credentialGeneration, parts.workerGeneration]);
}

// Native identifiers carry no length/format contract (Codex 0.170.0 marks both optional). Only a
// bounded, whitespace-free token is accepted as identity; anything else is "not identified".
const NATIVE_ACCOUNT_IDENTIFIER = /^[\x21-\x7e]{1,512}$/;

/** Valid only while the caller can still prove scopeStamp is current. A user alone does not identify the billed workspace. */
export function proveQuotaAccount(key: Uint8Array, parts: {
  engine: QuotaEngine; scopeStamp: string; accountId: string | null | undefined; userId: string | null | undefined;
}): QuotaAccountProof | undefined {
  if (!parts.accountId || !parts.userId || !parts.scopeStamp) return undefined;
  if (!NATIVE_ACCOUNT_IDENTIFIER.test(parts.accountId) || !NATIVE_ACCOUNT_IDENTIFIER.test(parts.userId)) return undefined;
  return { engine: parts.engine, scopeStamp: parts.scopeStamp, accountKey: digest(key, ["quota-account-v1", parts.engine, parts.accountId, parts.userId]) };
}
