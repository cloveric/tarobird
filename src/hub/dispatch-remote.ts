import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import os from "node:os";
import { z } from "zod";
import { blocksText, idSchema, type Block, type Conversation, type HubEvent } from "../client-protocol/index.js";
import { isBotControl } from "../client-protocol/bot-messages.js";
import {
  DISPATCH_ENGINES, REMOTE_DISPATCH_TARGET_BOT, crossHostDispatchGrantCommandSchema, crossHostDispatchGrantsSnapshotSchema,
  engineHealthSchema, hostLoadReportSchema, remoteDispatchRunRequestSchema, remoteDispatchRunResponseSchema,
  remoteDispatchStatusResponseSchema, remoteDispatchStopRequestSchema, remoteDispatchStopResponseSchema,
  type CrossHostDispatchGrantsSnapshot, type DispatchEngine, type EngineHealth, type HostEngineCapacity, type HostLoadReport,
  type RemoteDispatchRunResponse, type RemoteDispatchStatusResponse, type RemoteDispatchStopResponse, type TicketArtifact, type TicketFailure,
} from "../client-protocol/dispatch.js";
import type { BotCatalog } from "../client-protocol/bots.js";
import { anyRun, isRunActive, nativeRun, runSummarySchema } from "../client-protocol/run.js";
import { renderedEngineFailure, renderedEngineResetHint } from "../core/errors.js";
import { getEngineEffortValidationError } from "../state/instance-config.js";
import type { QuotaScope } from "../client-protocol/engine-quota.js";
import type { HubAuth } from "./auth.js";
import type { HubAttachments } from "./attachments.js";
import type { PrivateNetwork } from "./private-network.js";
import { HubError, newId, type HubStore, type TransactionGuard } from "./store.js";

const activeRunPhases = runSummarySchema.shape.phase.options.filter(isRunActive);
const activeRunPhaseParams = activeRunPhases.map(() => "?").join(",");
const SWITCH_CATEGORIES = new Set(["engine-quota", "auth", "engine-rate-limit", "engine-backend", "engine-cli"]);
const RESULT_CHARS = 4000;
const REMOTE_DISPATCH_RATE_LIMIT = 20;
const REMOTE_DISPATCH_RATE_WINDOW_MS = 60_000;

type DispatchGrant = { sourceKey: string; sourceBot: string; revoked: boolean };
type RemoteTicketRow = {
  id: string; source_key: string; source_host_id: string; source_bot_id: string; remote_request_id: string;
  title: string; request: string; engine: string; model: string; effort: string;
  bot_id: string; conversation_id: string; input_message_id: string; status: string; stop_requested: string | null;
  created_at: number; updated_at: number;
};

const hostIdOfKey = (key: string) => `hub_${createHash("sha256").update(Buffer.from(key, "base64")).digest("hex")}`;
const dispatchGrantKey = (sourceKey: string, sourceBot: string) =>
  `bot-messages:dispatch-grant:${createHash("sha256").update(JSON.stringify([sourceKey, sourceBot])).digest("hex")}`;
const dispatchRateKey = (sourceKey: string, sourceBot: string) =>
  `bot-messages:dispatch-rate:${createHash("sha256").update(JSON.stringify([sourceKey, sourceBot])).digest("hex")}`;

export interface RemoteTicketWorkspace {
  path: string;
  removeIfEmpty?: () => Promise<void>;
}

export interface RemoteDispatchWorkers {
  catalog(): Promise<BotCatalog>;
  engineAvailable?(engine: DispatchEngine): boolean;
  remoteDispatchWorker?(sourceHostId: string, engine: DispatchEngine, validate?: TransactionGuard): Promise<string>;
  remoteTicketWorkspace?(sourceHostId: string, remoteTicketId: string): Promise<RemoteTicketWorkspace>;
}

export interface RemoteDispatchContext {
  store: HubStore;
  auth: HubAuth;
  network: PrivateNetwork;
  attachments: HubAttachments;
  workers?: RemoteDispatchWorkers;
  workerCapable?: (botId: string) => boolean | undefined;
  quotaScopes?: () => Promise<QuotaScope[]>;
  conversationCreated: (userId: string, conversation: Conversation) => void;
  stop: (botId: string, conversationId: string, userId: string, messageId: string) => Promise<unknown>;
}

function summarizeEngineQuota(scopes: readonly QuotaScope[], engine: DispatchEngine): { quotaState: HostEngineCapacity["quotaState"]; quotaSummary?: string } {
  const matching = scopes.filter(s => s.engine === engine && (s.state === "ready" || s.state === "stale"));
  if (!matching.length) return { quotaState: "unknown" };
  let worst: "ok" | "warning" | "blocked" = "ok";
  let summary: string | undefined;
  for (const scope of matching) {
    if (scope.availability === "blocked") {
      worst = "blocked";
      summary = "quota_blocked";
      break;
    }
    const maxPct = Math.max(0, ...scope.pools.flatMap(p => p.windows.map(w => w.metric === "percent" ? w.usedPercent : 0)));
    if (scope.availability === "warning" || maxPct >= 85) {
      if (worst === "ok") worst = "warning";
      summary = `${Math.round(maxPct)}% used`;
    } else if (!summary && maxPct > 0) {
      summary = `${Math.round(maxPct)}% used`;
    }
  }
  return { quotaState: worst, ...(summary ? { quotaSummary: summary } : {}) };
}

/** Read-only local Host load, capacity and cached engine quota snapshot (aligned with #88). */
export async function readLocalHostLoad(ctx: RemoteDispatchContext, health: readonly EngineHealth[]): Promise<HostLoadReport> {
  const view = await ctx.network.view();
  const hostId = hostIdOfKey(ctx.auth.publicKey);
  const hostName = view.host.name;
  const cpuCount = Math.max(1, os.cpus().length || 1);
  // Node.js os.loadavg() always returns [0, 0, 0] on Windows; omit cpuLoadRatio there.
  let cpuLoadRatio: number | undefined;
  if (process.platform !== "win32") {
    const load1m = os.loadavg()[0];
    if (Number.isFinite(load1m) && load1m >= 0) {
      cpuLoadRatio = Math.round((load1m / cpuCount) * 100) / 100;
    }
  }
  const totalMem = os.totalmem();
  const freeMemoryRatio = totalMem > 0 ? Math.round((os.freemem() / totalMem) * 100) / 100 : undefined;

  const counts = await ctx.store.db.serial(async () => {
    const turns = await ctx.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE status='pending' AND dispatched=1");
    const localTickets = await ctx.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dispatch_tickets WHERE status='working'");
    const remoteTickets = await ctx.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM remote_dispatch_tickets WHERE status='working'");
    return { activeTurns: turns?.n ?? 0, activeTickets: (localTickets?.n ?? 0) + (remoteTickets?.n ?? 0) };
  });

  const catalog = ctx.workers ? await ctx.workers.catalog() : { engines: [] };
  const quotas = await ctx.quotaScopes?.().catch(() => [] as QuotaScope[]) ?? [];
  const engines: HostEngineCapacity[] = DISPATCH_ENGINES.map(engine => {
    const cat = catalog.engines.find(e => e.id === engine);
    const installed = cat?.available ?? (ctx.workers?.engineAvailable?.(engine) ?? false);
    const state = health.find(h => h.engine === engine);
    const quota = summarizeEngineQuota(quotas, engine);
    const available = installed && (!state || state.state === "ok") && quota.quotaState !== "blocked";
    return {
      engine,
      installed,
      available,
      ...(state ? { health: state } : {}),
      ...quota,
      models: cat ? cat.models.map(m => ({ ...m, label: m.label ?? (m.id || "CLI default") })) : [{ id: "", efforts: [""] }],
      defaultModel: cat?.defaultModel ?? "",
      defaultEffort: cat?.defaultEffort ?? "",
    };
  });

  return hostLoadReportSchema.parse({
    hostId,
    hostName,
    online: true,
    authorized: true,
    cpuCount,
    ...(cpuLoadRatio !== undefined ? { cpuLoadRatio } : {}),
    ...(freeMemoryRatio !== undefined ? { freeMemoryRatio } : {}),
    activeTurns: counts.activeTurns,
    activeTickets: counts.activeTickets,
    engines,
    observedAt: Date.now(),
  });
}

export async function readCrossHostDispatchGrants(ctx: RemoteDispatchContext, userId: string, guard: () => Promise<unknown>): Promise<CrossHostDispatchGrantsSnapshot> {
  const view = await ctx.network.view(guard);
  const ownId = hostIdOfKey(ctx.auth.publicKey);
  return ctx.store.db.serial(async () => {
    await guard();
    await ctx.store.requireOwner(userId);
    const peers = (view.membership?.manifest.hosts ?? []).filter(h => h.publicKey !== ctx.auth.publicKey);
    const hosts: CrossHostDispatchGrantsSnapshot["hosts"] = [];
    const seenHosts = new Set<string>();
    for (const peer of peers) {
      let available = false;
      if (peer.state === "active" && !peer.revoked) {
        try { await ctx.network.requireMessagePeerInTransaction(peer.publicKey); available = true; } catch { available = false; }
      }
      const id = hostIdOfKey(peer.publicKey);
      seenHosts.add(id);
      hosts.push({ id, name: peer.name, available });
    }
    const rows = await ctx.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:dispatch-grant:%' ORDER BY key");
    const grants: CrossHostDispatchGrantsSnapshot["grants"] = [];
    for (const row of rows) {
      try {
        const grant = JSON.parse(row.value) as DispatchGrant;
        if (!grant.revoked && row.key === dispatchGrantKey(grant.sourceKey, grant.sourceBot)) {
          const sourceHost = hostIdOfKey(grant.sourceKey);
          grants.push({ sourceHost, sourceBot: grant.sourceBot });
          if (!seenHosts.has(sourceHost) && grant.sourceKey !== ctx.auth.publicKey) {
            seenHosts.add(sourceHost);
            hosts.push({ id: sourceHost, name: sourceHost, available: false });
          }
        }
      } catch { /* ignore malformed entry */ }
    }
    return crossHostDispatchGrantsSnapshotSchema.parse({ host: { id: ownId, name: view.host.name }, hosts, grants });
  });
}

export async function updateCrossHostDispatchGrants(
  ctx: RemoteDispatchContext,
  userId: string,
  actor: string,
  raw: unknown,
  guard: () => Promise<unknown>,
  admit: () => Promise<unknown>,
): Promise<CrossHostDispatchGrantsSnapshot> {
  const command = crossHostDispatchGrantCommandSchema.parse(raw);
  const view = await ctx.network.view(guard);
  await ctx.store.db.transaction(async () => {
    await guard();
    await ctx.store.requireOwner(userId);
    const peer = view.membership?.manifest.hosts.find(h => hostIdOfKey(h.publicKey) === command.sourceHost);
    let sourceKey: string | undefined;
    let residual = false;
    if (peer) {
      if (peer.publicKey === ctx.auth.publicKey) throw new HubError("bot_message_grant_local_source", 400);
      if (command.allowed) await ctx.network.requireMessagePeerInTransaction(peer.publicKey);
      sourceKey = peer.publicKey;
    } else if (!command.allowed) {
      // Allow revoking a residual stored grant for a departed/removed source Host by exact host ID.
      const rows = await ctx.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:dispatch-grant:%' ORDER BY key");
      for (const row of rows) {
        try {
          const grant = JSON.parse(row.value) as DispatchGrant;
          if (!grant.revoked && grant.sourceBot === command.sourceBot && hostIdOfKey(grant.sourceKey) === command.sourceHost
            && row.key === dispatchGrantKey(grant.sourceKey, grant.sourceBot)) {
            sourceKey = grant.sourceKey;
            residual = true;
            break;
          }
        } catch { /* ignore malformed entry */ }
      }
      if (!sourceKey) throw new HubError("bot_message_host_not_found", 404);
    } else {
      throw new HubError("bot_message_host_not_found", 404);
    }
    // Consume the one-use device proof only after peer/grant validation succeeds.
    await admit();
    await ctx.store.db.run(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [dispatchGrantKey(sourceKey, command.sourceBot), JSON.stringify({ sourceKey, sourceBot: command.sourceBot, revoked: !command.allowed } satisfies DispatchGrant)],
    );
    await ctx.store.db.run(
      "INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)",
      [Date.now(), actor, command.allowed ? "dispatch.cross-host-granted" : "dispatch.cross-host-revoked", JSON.stringify({ sourceHost: command.sourceHost, sourceBot: command.sourceBot, ...(residual ? { residual: true } : {}) })],
    );
  });
  return readCrossHostDispatchGrants(ctx, userId, guard);
}

/** Caller holds DB serial/transaction. True only when `(sourceKey, sourceBot)` has an explicit remote dispatch grant. */
export async function isRemoteDispatchAuthorizedInTransaction(
  ctx: RemoteDispatchContext,
  sourceKey: string,
  sourceBot: string,
  targetBot: string = REMOTE_DISPATCH_TARGET_BOT,
): Promise<boolean> {
  if (targetBot !== REMOTE_DISPATCH_TARGET_BOT) return false;
  await ctx.network.requireMessagePeerInTransaction(sourceKey);
  const dispatchRow = await ctx.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [dispatchGrantKey(sourceKey, sourceBot)]);
  if (dispatchRow) {
    try {
      const grant = JSON.parse(dispatchRow.value) as DispatchGrant;
      if (!grant.revoked && grant.sourceKey === sourceKey && grant.sourceBot === sourceBot) return true;
    } catch { /* ignore */ }
  }
  return false;
}

async function healthList(ctx: RemoteDispatchContext): Promise<EngineHealth[]> {
  const rows = await ctx.store.db.all<{ engine: string; state: string; until: number | null; reason: string | null; updated_at: number }>("SELECT * FROM engine_health ORDER BY engine");
  const now = Date.now();
  return rows.flatMap(row => {
    const parsed = engineHealthSchema.safeParse({ engine: row.engine, state: row.state, ...(row.until ? { until: row.until } : {}), ...(row.reason ? { reason: row.reason } : {}), updatedAt: row.updated_at });
    return parsed.success && !(parsed.data.state === "cooldown" && parsed.data.until !== undefined && parsed.data.until <= now) ? [parsed.data] : [];
  });
}

async function inspectRemoteTicketState(ctx: RemoteDispatchContext, row: RemoteTicketRow): Promise<RemoteDispatchStatusResponse> {
  const delivery = await ctx.store.db.get<{ status: string; dispatched: number }>("SELECT status,dispatched FROM deliveries WHERE message_id=? AND bot_id=?", [row.input_message_id, row.bot_id]);
  const deleted = !await ctx.store.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NULL", [row.bot_id]);
  const active = (await ctx.store.db.get<{ active: number }>(`SELECT 1 AS active FROM messages m WHERE m.reply_to=? AND m.author_type='bot' AND m.author_id=? AND m.conversation_id=? AND m.status!='deleted'
    AND (m.status IN ('pending','streaming') OR EXISTS (SELECT 1 FROM json_each(m.blocks_json) b WHERE json_extract(b.value,'$.type')='card'
      AND (json_extract(b.value,'$.extra.nativeRun.phase') IN (${activeRunPhaseParams}) OR json_extract(b.value,'$.extra.scopedRun.phase') IN (${activeRunPhaseParams})))) LIMIT 1`,
  [row.input_message_id, row.bot_id, row.conversation_id, ...activeRunPhases, ...activeRunPhases]))?.active ?? 0;

  const waiting = !row.stop_requested ? await ctx.store.db.get<{ id: string; phase: string }>(`SELECT m.id,COALESCE(json_extract(b.value,'$.extra.nativeRun.phase'),json_extract(b.value,'$.extra.scopedRun.phase')) AS phase
    FROM messages m,json_each(m.blocks_json) b WHERE m.reply_to=? AND m.author_type='bot' AND m.author_id=? AND m.conversation_id=? AND m.status!='deleted'
    AND COALESCE(json_extract(b.value,'$.extra.nativeRun.phase'),json_extract(b.value,'$.extra.scopedRun.phase')) IN ('waiting_answer','waiting_approval') ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
  [row.input_message_id, row.bot_id, row.conversation_id]) : undefined;
  const waitingFor = waiting ? { kind: (waiting.phase === "waiting_answer" ? "answer" : "approval") as "answer" | "approval", messageId: waiting.id } : undefined;

  const files = await ctx.store.db.all<{ id: string; name: string; size: number; mime: string; sha256: string }>(
    `SELECT DISTINCT a.id,a.name,a.size,a.mime,a.sha256 FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id JOIN messages m ON m.id=ma.message_id
     WHERE m.reply_to=? AND m.author_type='bot' AND m.author_id=? AND m.conversation_id=? AND m.status!='deleted' AND a.complete=1`,
    [row.input_message_id, row.bot_id, row.conversation_id],
  );

  // Page replies in bounded batches instead of truncating at 200; inspect only
  // foreground nativeRun phases so handled scopedRun errors do not fail the turn.
  let after: { created_at: number; id: string } | undefined;
  let error = false, incomplete = false, runs = 0, foregroundRuns = 0, allForegroundDone = true;
  let tail = "", length = 0, updatedAt = row.updated_at;
  let category: NonNullable<ReturnType<typeof renderedEngineFailure>>["category"] | undefined, resetHint: string | undefined;
  const categories = [...SWITCH_CATEGORIES];
  const priority = (value: string) => { const idx = categories.indexOf(value); return idx < 0 ? categories.length : idx; };
  for (;;) {
    const replies = await ctx.store.db.all<{ id: string; blocks_json: string; status: string; created_at: number }>(
      `SELECT id,blocks_json,status,created_at FROM messages WHERE conversation_id=? AND author_type='bot' AND author_id=? AND reply_to=? AND status!='deleted'
       ${after ? "AND (created_at,id)>(?,?)" : ""} ORDER BY created_at,id LIMIT 32`,
      [row.conversation_id, row.bot_id, row.input_message_id, ...(after ? [after.created_at, after.id] : [])],
    );
    for (const r of replies) {
      updatedAt = Math.max(updatedAt, r.created_at);
      error ||= r.status === "error";
      const blocks = JSON.parse(r.blocks_json) as Block[];
      for (const block of blocks) {
        const run = block.type === "card" ? anyRun(block) : undefined;
        if (run) runs++;
        const fg = block.type === "card" ? nativeRun(block) : undefined;
        if (fg) { foregroundRuns++; allForegroundDone &&= fg.phase === "done"; }
        if (fg?.phase === "error") error = true;
        if (fg && ["partial", "stopped", "interrupted"].includes(fg.phase)) incomplete = true;
      }
      const text = blocksText(blocks).trim();
      if (text) {
        const part = (length ? "\n\n" : "") + text;
        tail = (tail + part).slice(-RESULT_CHARS);
        length += part.length;
        const f = renderedEngineFailure(text);
        if (f && SWITCH_CATEGORIES.has(f.category) && (!category || priority(f.category) < priority(category))) category = f.category;
        resetHint = renderedEngineResetHint(text) ?? resetHint;
      }
    }
    if (replies.length < 32) break;
    after = replies.at(-1)!;
  }

  let status: RemoteDispatchStatusResponse["status"];
  let failure: TicketFailure | undefined;
  if (deleted) {
    status = "failed";
    failure = { category: "bot-deleted", message: "Worker bot was deleted" };
  } else if (waitingFor) {
    status = "needs_answer";
  } else if (!delivery && row.status === "cancelled") {
    status = "cancelled";
  } else if (active > 0 || !delivery || delivery.status === "pending") {
    status = delivery?.dispatched || active > 0 ? "working" : "queued";
  } else if (delivery.status === "cancelled") {
    status = "cancelled";
  } else if (row.stop_requested) {
    const finished = delivery.status === "accepted" && !error && !incomplete && (runs === 0 || (foregroundRuns > 0 && allForegroundDone));
    status = finished ? "completed" : "cancelled";
  } else if (delivery.status === "failed" || error || incomplete) {
    status = "failed";
    failure = { category: (!incomplete ? category : undefined) ?? "task", ...(resetHint ? { resetHint } : {}), ...(tail ? { message: tail.slice(-1000) } : {}) };
  } else {
    status = "completed";
  }

  const artifacts: TicketArtifact[] = files.slice(0, 64).map(f => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, sha256: f.sha256 }));
  return remoteDispatchStatusResponseSchema.parse({
    remoteTicketId: row.id,
    status,
    ...(waitingFor ? { waitingFor } : {}),
    ...(tail ? { result: tail } : {}),
    ...(length > RESULT_CHARS ? { resultTruncated: true } : {}),
    ...(failure ? { failure } : {}),
    artifacts,
    updatedAt,
  });
}

/** Handles authenticated `/api/bot-messages/dispatch/*` requests on the receiving Host B. */
export async function handleRemoteDispatchRequest(
  ctx: RemoteDispatchContext,
  sourceKey: string,
  source: { hostId: string; hostName: string; botId: string; botName: string; requestId: string; hops: number },
  targetBot: string,
  routePath: string,
  data: Record<string, unknown>,
  localAdmission?: () => Promise<unknown>,
): Promise<unknown> {
  if (targetBot !== REMOTE_DISPATCH_TARGET_BOT) throw new HubError("bot_message_operation_forbidden", 403);
  if (routePath === "/api/bot-messages/dispatch/probe") {
    const authorized = await ctx.store.db.serial(() => isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot));
    if (!authorized) {
      const view = await ctx.network.view();
      return hostLoadReportSchema.parse({
        hostId: hostIdOfKey(ctx.auth.publicKey),
        hostName: view.host.name,
        online: true,
        authorized: false,
        activeTurns: 0,
        activeTickets: 0,
        engines: [],
        observedAt: Date.now(),
      });
    }
    const health = await ctx.store.db.serial(() => healthList(ctx));
    const load = await readLocalHostLoad(ctx, health);
    return hostLoadReportSchema.parse({ ...load, authorized: true });
  }

  const authorized = await ctx.store.db.serial(() => isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot));
  if (!authorized) throw new HubError("bot_message_not_authorized", 403);

  if (routePath === "/api/bot-messages/dispatch/run") {
    const input = remoteDispatchRunRequestSchema.parse(data);
    if (isBotControl(input.request)) throw new HubError("bot_message_control_forbidden", 400);
    if ((input.model || input.effort) && getEngineEffortValidationError(input.engine, input.effort || undefined, input.model || undefined)) {
      throw new HubError("dispatch_effort_incompatible", 409);
    }
    const matchesExisting = (row: RemoteTicketRow) =>
      row.title === input.title && row.request === input.request && row.engine === input.engine && row.model === input.model && row.effort === input.effort;
    const existing = await ctx.store.db.serial(() => ctx.store.db.get<RemoteTicketRow>(
      "SELECT * FROM remote_dispatch_tickets WHERE source_key=? AND source_bot_id=? AND remote_request_id=?",
      [sourceKey, source.botId, input.remoteRequestId],
    ));
    if (existing) {
      if (!matchesExisting(existing)) throw new HubError("idempotency_conflict", 409);
      const bot = await ctx.store.db.serial(() => ctx.store.db.get<{ name: string }>("SELECT name FROM bots WHERE id=?", [existing.bot_id]));
      return remoteDispatchRunResponseSchema.parse({
        remoteTicketId: existing.id,
        conversationId: existing.conversation_id,
        messageId: existing.input_message_id,
        botId: existing.bot_id,
        botName: bot?.name ?? existing.bot_id,
        engine: existing.engine,
        model: existing.model,
        effort: existing.effort,
        status: existing.status === "working" ? "working" : "queued",
      });
    }

    if (!ctx.workers?.remoteDispatchWorker) throw new HubError("dispatch_worker_unavailable", 409);
    const validate = async () => {
      if (!await isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot)) {
        throw new HubError("bot_message_not_authorized", 403);
      }
      await localAdmission?.();
    };
    const workerId = await ctx.workers.remoteDispatchWorker(source.hostId, input.engine, validate);
    const events: HubEvent[] = [];
    let createdConversation: Conversation | undefined;
    let pendingWorkspace: { ticketId: string; removeIfEmpty: () => Promise<void> } | undefined;
    const response = await ctx.store.db.transaction(async (): Promise<RemoteDispatchRunResponse> => {
      if (!await isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot)) {
        throw new HubError("bot_message_not_authorized", 403);
      }
      await localAdmission?.();
      const dup = await ctx.store.db.get<RemoteTicketRow>(
        "SELECT * FROM remote_dispatch_tickets WHERE source_key=? AND source_bot_id=? AND remote_request_id=?",
        [sourceKey, source.botId, input.remoteRequestId],
      );
      if (dup) {
        if (!matchesExisting(dup)) throw new HubError("idempotency_conflict", 409);
        const bot = await ctx.store.db.get<{ name: string }>("SELECT name FROM bots WHERE id=?", [dup.bot_id]);
        return remoteDispatchRunResponseSchema.parse({
          remoteTicketId: dup.id,
          conversationId: dup.conversation_id,
          messageId: dup.input_message_id,
          botId: dup.bot_id,
          botName: bot?.name ?? dup.bot_id,
          engine: dup.engine,
          model: dup.model,
          effort: dup.effort,
          status: dup.status === "working" ? "working" : "queued",
        });
      }
      const bot = await ctx.store.db.get<{ id: string; name: string; role: string }>("SELECT id,name,role FROM bots WHERE id=? AND deleted_at IS NULL", [workerId]);
      if (!bot || bot.role !== "worker") throw new HubError("dispatch_worker_unavailable", 409);
      if (ctx.workerCapable?.(bot.id) === false) throw new HubError("bot_message_worker_update_required", 409);
      const now = Date.now();
      const rateKey = dispatchRateKey(sourceKey, source.botId);
      const rateRow = await ctx.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [rateKey]);
      const times = (rateRow ? JSON.parse(rateRow.value) as number[] : []).filter(t => t > now - REMOTE_DISPATCH_RATE_WINDOW_MS);
      if (times.length >= REMOTE_DISPATCH_RATE_LIMIT) throw new HubError("bot_message_rate_limit", 429);
      const remoteTicketId = newId("rtk");
      await ctx.store.db.run(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [rateKey, JSON.stringify([...times, now])],
      );
      const conv = await ctx.store.createConversationInTransaction("owner", [bot.id], input.title.slice(0, 256), `rtk_${remoteTicketId}`, { dispatchWorker: true });
      const sent = await ctx.store.sendMessageInTransaction("owner", {
        conversationId: conv.id,
        clientMsgId: `rtk_${remoteTicketId}`,
        text: input.request,
        attachments: [],
        mentions: [bot.id],
        previewUrl: null,
        botSource: {
          hostId: source.hostId,
          hostName: source.hostName.slice(0, 256),
          botId: source.botId,
          botName: source.botName.slice(0, 256),
          requestId: remoteTicketId,
          hops: Math.min(source.hops, 3),
        },
      });
      if (sent.event) events.push(sent.event);
      await ctx.store.db.run(
        `INSERT INTO remote_dispatch_tickets(id,source_key,source_host_id,source_bot_id,remote_request_id,title,request,engine,model,effort,bot_id,conversation_id,input_message_id,status,stop_requested,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [remoteTicketId, sourceKey, source.hostId, source.botId, input.remoteRequestId, input.title, input.request, input.engine, input.model, input.effort, bot.id, conv.id, sent.message.id, "working", null, now, now],
      );
      await ctx.store.db.run(
        "INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)",
        [now, source.botId, "dispatch.remote_run_started", JSON.stringify({ remoteTicketId, sourceHost: source.hostId, engine: input.engine })],
      );
      const workspace = await ctx.workers?.remoteTicketWorkspace?.(source.hostId, remoteTicketId);
      if (workspace?.removeIfEmpty) pendingWorkspace = { ticketId: remoteTicketId, removeIfEmpty: workspace.removeIfEmpty };
      const marker = { id: remoteTicketId, dispatcherBotId: source.botId, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(workspace ? { workspace: workspace.path } : {}) };
      await ctx.store.db.run("UPDATE conversations SET hidden=1,ticket_json=? WHERE id=?", [JSON.stringify(marker), conv.id]);
      createdConversation = await ctx.store.conversationInTransaction(conv.id);
      return remoteDispatchRunResponseSchema.parse({
        remoteTicketId,
        conversationId: conv.id,
        messageId: sent.message.id,
        botId: bot.id,
        botName: bot.name,
        engine: input.engine,
        model: input.model,
        effort: input.effort,
        status: "working",
      });
    }).catch(async error => {
      const allocation = pendingWorkspace;
      if (allocation) {
        // An unconfirmed commit or a failed readback is insufficient proof
        // that the workspace is unowned.
        const absent = await ctx.store.db.serial(async () =>
          !await ctx.store.db.get("SELECT 1 FROM remote_dispatch_tickets WHERE id=?", [allocation.ticketId]),
        ).catch(() => false);
        if (absent) await allocation.removeIfEmpty().catch(() => undefined);
      }
      throw error;
    });
    if (createdConversation) ctx.conversationCreated("owner", createdConversation);
    ctx.store.emitCommitted(events);
    return response;
  }

  if (routePath === "/api/bot-messages/dispatch/status") {
    const { remoteTicketId } = z.object({ remoteTicketId: idSchema }).strict().parse(data);
    return ctx.store.db.serial(async () => {
      if (!await isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot)) throw new HubError("bot_message_not_authorized", 403);
      const row = await ctx.store.db.get<RemoteTicketRow>("SELECT * FROM remote_dispatch_tickets WHERE id=?", [remoteTicketId]);
      if (!row || row.source_key !== sourceKey || row.source_bot_id !== source.botId) throw new HubError("ticket_not_found", 404);
      const result = await inspectRemoteTicketState(ctx, row);
      if (result.status !== row.status && ["completed", "failed", "cancelled"].includes(result.status)) {
        await ctx.store.db.run("UPDATE remote_dispatch_tickets SET status=?,updated_at=? WHERE id=?", [result.status, Date.now(), row.id]);
      }
      return result;
    });
  }

  if (routePath === "/api/bot-messages/dispatch/stop") {
    const input = remoteDispatchStopRequestSchema.parse(data);
    const events: HubEvent[] = [];
    const prep = await ctx.store.db.transaction(async () => {
      if (!await isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot)) throw new HubError("bot_message_not_authorized", 403);
      const row = await ctx.store.db.get<RemoteTicketRow>("SELECT * FROM remote_dispatch_tickets WHERE id=?", [input.remoteTicketId]);
      if (!row || row.source_key !== sourceKey || row.source_bot_id !== source.botId) throw new HubError("ticket_not_found", 404);
      const before = await inspectRemoteTicketState(ctx, row);
      if (before.status === "completed" || before.status === "failed" || before.status === "cancelled") {
        if (before.status !== row.status) {
          await ctx.store.db.run("UPDATE remote_dispatch_tickets SET status=?,updated_at=? WHERE id=?", [before.status, Date.now(), row.id]);
        }
        return { row, needRpc: false };
      }
      const cancelled = await ctx.store.db.run(
        "UPDATE deliveries SET status='cancelled' WHERE message_id=? AND bot_id=? AND dispatched=0 AND status='pending'",
        [row.input_message_id, row.bot_id],
      );
      const intent = row.stop_requested === "cancel" ? "cancel" : input.action;
      if (cancelled.changes) {
        events.push(await ctx.store.queueEventInTransaction(row.conversation_id, row.bot_id));
        await ctx.store.db.run("UPDATE remote_dispatch_tickets SET status='cancelled',stop_requested=?,updated_at=? WHERE id=?", [intent, Date.now(), row.id]);
        return { row, needRpc: false };
      }
      // Record durable stop intent without marking the running turn cancelled
      // before worker execution settles; prompt-queue withholds reconnect replay.
      await ctx.store.db.run("UPDATE remote_dispatch_tickets SET stop_requested=?,updated_at=? WHERE id=?", [intent, Date.now(), row.id]);
      return { row, needRpc: true };
    });
    ctx.store.emitCommitted(events);
    if (prep.needRpc) {
      await ctx.stop(prep.row.bot_id, prep.row.conversation_id, "owner", prep.row.input_message_id).catch(() => undefined);
    }
    const latest = await ctx.store.db.serial(async () => {
      const row = (await ctx.store.db.get<RemoteTicketRow>("SELECT * FROM remote_dispatch_tickets WHERE id=?", [input.remoteTicketId]))!;
      const state = await inspectRemoteTicketState(ctx, row);
      if (state.status !== row.status && ["completed", "failed", "cancelled"].includes(state.status)) {
        await ctx.store.db.run("UPDATE remote_dispatch_tickets SET status=?,updated_at=? WHERE id=?", [state.status, Date.now(), row.id]);
      }
      return state;
    });
    return remoteDispatchStopResponseSchema.parse({
      remoteTicketId: input.remoteTicketId,
      status: latest.status,
      stopped: latest.status === "cancelled" || latest.status === "failed" || latest.status === "completed",
    } satisfies RemoteDispatchStopResponse);
  }

  if (routePath === "/api/bot-messages/dispatch/download") {
    const input = z.object({ remoteTicketId: idSchema, attachmentId: idSchema, offset: z.number().int().min(0) }).strict().parse(data);
    const meta = await ctx.store.db.serial(async () => {
      if (!await isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot)) throw new HubError("bot_message_not_authorized", 403);
      const row = await ctx.store.db.get<RemoteTicketRow>("SELECT * FROM remote_dispatch_tickets WHERE id=?", [input.remoteTicketId]);
      if (!row || row.source_key !== sourceKey || row.source_bot_id !== source.botId) throw new HubError("ticket_not_found", 404);
      const state = await inspectRemoteTicketState(ctx, row);
      const file = state.artifacts.find(a => a.id === input.attachmentId);
      if (!file) throw new HubError("bot_message_reply_file_forbidden", 403);
      return { botId: row.bot_id, file };
    });
    if (input.offset >= meta.file.size) throw new HubError("invalid_offset", 416);
    const download = await ctx.attachments.download({ botId: meta.botId }, meta.file.id);
    const handle = await open(download.path, "r");
    try {
      const bytes = Buffer.alloc(Math.min(1024 * 1024, meta.file.size - input.offset));
      const read = await handle.read(bytes, 0, bytes.length, input.offset);
      return { bytes: bytes.subarray(0, read.bytesRead).toString("base64"), offset: input.offset, ...meta.file };
    } finally {
      await handle.close();
    }
  }

  throw new HubError("bot_message_operation_forbidden", 403);
}
