import { randomUUID, timingSafeEqual } from "node:crypto";
import { ENGINE_QUOTA_REFRESH_MS, nativeQuotaRequestSchema, nativeQuotaReplySchema, quotaReadingExpired, quotaSnapshotSchema, type QuotaEngine, type QuotaSnapshot } from "../client-protocol/engine-quota.js";
import { unavailableQuota } from "../codex/account-quota.js";
import type { EngineQuotaReadResult, EngineQuotaReadOptions } from "../codex/adapter.js";
import { QUOTA_ACCOUNT_KEY_HEX, quotaAccountProofReplySchema, quotaAccountProofRequestSchema } from "../runtime/engine-quota-scope.js";

/** No credentials or raw account identifiers leave the worker. Equal HOME paths
 * are never evidence that two Bots share an account; only a native account proof
 * keyed with the Hub's ephemeral in-memory proof key may be matched via the
 * private `quota.accountProof` RPC, and it never enters `quota.get` replies. */
export function gatewayEngineQuota(options: {
  botId: string; engine: QuotaEngine;
  read?: (options: EngineQuotaReadOptions) => Promise<EngineQuotaReadResult | undefined>;
  getAccountProofKey?: () => Uint8Array | undefined;
  now?: () => number;
}) {
  const now = options.now ?? Date.now, unsupportedRevision = randomUUID();
  let active: Promise<EngineQuotaReadResult> | undefined;
  let activeRevision: string | undefined;
  let refreshRevision: string | undefined;
  let nextRefreshAt = 0;
  let lastProof: { revision: string; accountKey: string; proofKey: Uint8Array } | undefined;
  const read = async (refresh: boolean, expectedRevision?: string): Promise<EngineQuotaReadResult> => {
    if (!options.read) return { revision: unsupportedRevision, snapshot: unavailableQuota(options.engine, "not_adapted", now()) };
    const signal = AbortSignal.timeout(refresh ? ENGINE_QUOTA_REFRESH_MS + 500 : 2_000);
    const accountProofKey = options.getAccountProofKey?.();
    // A cancelled read must not stop a chatting worker. Native adapters own
    // their helpers and are responsible for observing this deadline.
    return await options.read({ refresh, ...(expectedRevision ? { expectedRevision } : {}), ...(accountProofKey ? { accountProofKey } : {}), signal, timeoutMs: refresh ? ENGINE_QUOTA_REFRESH_MS : 1_500 })
      ?? { revision: unsupportedRevision, snapshot: unavailableQuota(options.engine, "not_adapted", now()) };
  };
  const handle = async (raw: unknown) => {
    const request = nativeQuotaRequestSchema.parse(raw);
    if (request.scopeId !== options.botId || request.refresh && !request.expectedRevision) throw new Error("quota_request_invalid");
    // Read the current credential/configuration generation even on a cache hit.
    // Do not return a prior account's cache after a login or worker change.
    let result = await read(false);
    if (refreshRevision !== result.revision) { nextRefreshAt = 0; refreshRevision = result.revision; }
    if (request.expectedRevision && result.revision !== request.expectedRevision) {
      result = { revision: result.revision, snapshot: unavailableQuota(options.engine, "auth_changed", now()) };
    } else if (request.refresh && result.snapshot.capability.mode === "active") {
      if (!active && now() >= nextRefreshAt) {
        nextRefreshAt = now() + 60_000;
        const current = read(true, result.revision);
        active = current;
        activeRevision = result.revision;
        void current.finally(() => { if (active === current) { active = undefined; activeRevision = undefined; } }).catch(() => undefined);
      }
      if (active && activeRevision === result.revision) result = await active;
    }
    const snapshot: QuotaSnapshot = quotaSnapshotSchema.parse(result.snapshot);
    if (snapshot.state === "ready" && quotaReadingExpired(snapshot, now())) snapshot.state = "stale";
    // The cooldown belongs to the login it was started for; a reply about another one (auth_changed) has none.
    if (snapshot.capability.mode === "active" && nextRefreshAt > now() && result.revision === refreshRevision) snapshot.nextRefreshAt = new Date(nextRefreshAt).toISOString();
    const currentProofKey = options.getAccountProofKey?.();
    const proofAllowed = currentProofKey !== undefined
      && result.proof !== undefined
      && result.proof.engine === options.engine
      && result.proof.scopeStamp === result.revision
      && QUOTA_ACCOUNT_KEY_HEX.test(result.proof.accountKey)
      && snapshot.state !== "unsupported"
      && !["auth_changed", "scope_unverifiable", "login_required"].includes(snapshot.reason ?? "");
    lastProof = proofAllowed
      ? { revision: result.revision, accountKey: result.proof!.accountKey, proofKey: Uint8Array.from(currentProofKey) }
      : undefined;
    return nativeQuotaReplySchema.parse({ scopeId: options.botId, revision: result.revision,
      value: { ...snapshot, id: options.botId, revision: result.revision, engine: options.engine, label: options.engine,
        botIds: [options.botId], sharing: "unverified" } });
  };
  const accountProof = (raw: unknown) => {
    const request = quotaAccountProofRequestSchema.parse(raw);
    if (request.scopeId !== options.botId) throw new Error("quota_request_invalid");
    const currentKey = options.getAccountProofKey?.();
    const matched = !!lastProof
      && !!currentKey
      && lastProof.revision === request.expectedRevision
      && lastProof.proofKey.byteLength === currentKey.byteLength
      && timingSafeEqual(lastProof.proofKey, currentKey);
    return quotaAccountProofReplySchema.parse({
      scopeId: options.botId,
      revision: request.expectedRevision,
      ...(matched ? { accountKey: lastProof!.accountKey } : {}),
    });
  };
  return Object.assign(handle, { accountProof });
}
