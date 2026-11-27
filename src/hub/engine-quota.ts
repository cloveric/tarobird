import { nativeQuotaReplySchema, projectQuotaScopeForClient, quotaDirectorySchema, quotaEngineSchema, quotaScopeSchema, type QuotaEngine, type QuotaScope } from "../client-protocol/engine-quota.js";
import { unavailableQuota } from "../codex/account-quota.js";
import { QUOTA_ACCOUNT_KEY_HEX } from "../runtime/engine-quota-scope.js";
import { HubError } from "./errors.js";

type Bot = { id: string; name: string; engine: string; role?: string; deletedAt?: number };
export type HubQuotaProofEntry = { connectionKey: object; engine: QuotaEngine; revision: string; accountKey: string };
const UNVERIFIABLE_PROOF_REASONS = new Set([
  "auth_changed",
  "scope_unverifiable",
  "login_required",
  "offline",
  "invalid_response",
  "host_upgrade_required",
]);

export function hubEngineQuotas(options: {
  bots: () => Promise<Bot[]>;
  connection: (botId: string) => { key: object; supported: boolean; ready: boolean } | undefined;
  call: (botId: string, request: { scopeId: string; refresh: boolean; expectedRevision?: string }) => Promise<unknown>;
  validate: () => Promise<void>;
  accountProof?: (botId: string, revision: string) => Promise<string | undefined>;
  proofStore?: Map<string, HubQuotaProofEntry>;
  /** Opt-in flag for clients that accept `"omp"` in `quotaEngineSchema`; 1.6.0 clients validate a closed 6-engine enum. */
  includeOmp?: boolean;
}) {
  const allowedEngine = (engine: string) => (engine !== "omp" || options.includeOmp === true) && quotaEngineSchema.safeParse(engine).success;
  const list = async () => (await options.bots()).filter(bot => !bot.deletedAt && bot.role !== "worker" && allowedEngine(bot.engine));
  const origins = new WeakMap<QuotaScope, object>();
  const fallback = (bot: Bot, reason: "offline" | "host_upgrade_required" | "timeout" | "invalid_response"): QuotaScope => {
    const engine = quotaEngineSchema.parse(bot.engine);
    return { ...unavailableQuota(engine, reason), id: bot.id, revision: reason, engine,
      label: bot.name.slice(0, 120).replace(/[\x00-\x1f\x7f]/g, " ") || engine,
      botIds: [bot.id], sharing: "unverified" };
  };
  const current = (bot: Bot, value: QuotaScope): QuotaScope => {
    const origin = origins.get(value), connection = options.connection(bot.id);
    return origin && (connection?.key !== origin || !connection.ready || bot.engine !== value.engine)
      ? fallback(bot, "offline") : value;
  };
  const pruneProofStore = (visible: ReadonlyMap<string, Bot>) => {
    if (!options.proofStore) return;
    for (const [id, entry] of options.proofStore) {
      const bot = visible.get(id), conn = options.connection(id);
      if (!bot || bot.engine !== entry.engine || !conn?.ready || conn.key !== entry.connectionKey) {
        options.proofStore.delete(id);
      }
    }
  };
  const applySharing = (
    scope: QuotaScope,
    visible: ReadonlyMap<string, Bot>,
    proofs: ReadonlyMap<string, HubQuotaProofEntry>,
  ): QuotaScope => {
    const origin = origins.get(scope);
    const mine = proofs.get(scope.id);
    const conn = options.connection(scope.id);
    if (!origin || !mine || mine.connectionKey !== origin || mine.engine !== scope.engine
      || mine.revision !== scope.revision || !conn?.ready || conn.key !== origin) {
      return scope;
    }
    const botIds: string[] = [];
    for (const [id, entry] of proofs) {
      const peerBot = visible.get(id), peerConn = options.connection(id);
      if (!peerBot || peerBot.engine !== scope.engine || entry.engine !== scope.engine || entry.accountKey !== mine.accountKey) continue;
      if (!peerConn?.ready || peerConn.key !== entry.connectionKey) continue;
      botIds.push(id);
    }
    if (!botIds.includes(scope.id)) botIds.push(scope.id);
    botIds.sort();
    return quotaScopeSchema.parse({ ...scope, botIds, sharing: "verified" });
  };
  const read = async (
    bot: Bot,
    refresh = false,
    revision?: string,
    deadline?: number,
    proofs?: Map<string, HubQuotaProofEntry>,
  ): Promise<QuotaScope> => {
    const engine = quotaEngineSchema.parse(bot.engine), initial = options.connection(bot.id);
    if (deadline !== undefined && Date.now() >= deadline) return fallback(bot, "timeout");
    if (!initial?.ready) { options.proofStore?.delete(bot.id); return fallback(bot, "offline"); }
    if (!initial.supported) { options.proofStore?.delete(bot.id); return fallback(bot, "host_upgrade_required"); }
    await options.validate();
    try {
      const result = nativeQuotaReplySchema.parse(await options.call(bot.id, { scopeId: bot.id, refresh, ...(revision ? { expectedRevision: revision } : {}) }));
      await options.validate();
      if (options.connection(bot.id)?.key !== initial.key) { options.proofStore?.delete(bot.id); return fallback(bot, "offline"); }
      if (result.scopeId !== bot.id || result.value.id !== bot.id || result.value.engine !== engine || result.revision !== result.value.revision
        || result.value.botIds.length !== 1 || result.value.botIds[0] !== bot.id) {
        options.proofStore?.delete(bot.id);
        return fallback(bot, "invalid_response");
      }
      // The owner directory is authoritative for labels and Bot membership.
      const value = quotaScopeSchema.parse({ ...result.value, label: fallback(bot, "offline").label, sharing: "unverified" });
      if (options.accountProof) {
        const eligible = value.state !== "offline" && value.state !== "unsupported" && !UNVERIFIABLE_PROOF_REASONS.has(value.reason ?? "");
        if (eligible) {
          const accountKey = await options.accountProof(bot.id, value.revision);
          await options.validate();
          if (options.connection(bot.id)?.key !== initial.key) { options.proofStore?.delete(bot.id); return fallback(bot, "offline"); }
          if (accountKey && QUOTA_ACCOUNT_KEY_HEX.test(accountKey)) {
            const entry: HubQuotaProofEntry = { connectionKey: initial.key, engine, revision: value.revision, accountKey };
            proofs?.set(bot.id, entry);
            options.proofStore?.set(bot.id, entry);
          } else {
            proofs?.delete(bot.id);
            options.proofStore?.delete(bot.id);
          }
        } else {
          proofs?.delete(bot.id);
          options.proofStore?.delete(bot.id);
        }
      }
      origins.set(value, initial.key); return value;
    } catch (error) {
      await options.validate();
      if (error instanceof HubError && (error.status === 401 || error.status === 403)) throw error;
      if (options.connection(bot.id)?.key !== initial.key) options.proofStore?.delete(bot.id);
      return fallback(bot, error instanceof HubError && error.code === "bot_timeout" ? "timeout" : "invalid_response");
    }
  };
  // The one place a reply is cut down for a client that did not ask for currency balances (a v1.6.0 App or CLI).
  const project = (scope: QuotaScope, includeCurrencyBalances: boolean): QuotaScope => projectQuotaScopeForClient(scope, { currencyBalances: includeCurrencyBalances });
  return {
    async directory(readOptions?: { includeCurrencyBalances?: boolean }) {
      const includeCurrency = readOptions?.includeCurrencyBalances === true;
      const bots = await list(), scopes: QuotaScope[] = [], deadline = Date.now() + 5_000;
      const localProofs = new Map<string, HubQuotaProofEntry>();
      // Bound concurrent worker reads. These are cache-only; none launches a CLI.
      for (let i = 0; i < Math.min(bots.length, 256); i += 4) scopes.push(...await Promise.all(bots.slice(i, Math.min(i + 4, 256)).map(bot => read(bot, false, undefined, deadline, localProofs))));
      const visible = new Map((await list()).map(bot => [bot.id, bot]));
      pruneProofStore(visible);
      await options.validate();
      return quotaDirectorySchema.parse({
        generatedAt: new Date().toISOString(),
        scopes: scopes
          .filter(scope => visible.has(scope.id))
          // Sharing is decided on the reading as the worker sent it; the cut for older clients comes last.
          .map(scope => project(applySharing(current(visible.get(scope.id)!, scope), visible, localProofs), includeCurrency)),
        ...(bots.length > 256 ? { truncated: true } : {}),
      });
    },
    async scope(id: string, refresh: boolean, revision?: string, readOptions?: { includeCurrencyBalances?: boolean }) {
      const includeCurrency = readOptions?.includeCurrencyBalances === true;
      if (refresh && !revision) throw new HubError("quota_revision_required", 400);
      const bot = (await list()).find(bot => bot.id === id);
      if (!bot) throw new HubError("quota_scope_missing", 404);
      const localProofs = new Map<string, HubQuotaProofEntry>();
      const result = await read(bot, refresh, revision, undefined, localProofs);
      const visible = new Map((await list()).map(item => [item.id, item]));
      const latest = visible.get(id);
      if (!latest) throw new HubError("quota_scope_missing", 404);
      pruneProofStore(visible);
      await options.validate();
      const checked = current(latest, result);
      return project(applySharing(checked, visible, options.proofStore ?? localProofs), includeCurrency);
    },
  };
}
