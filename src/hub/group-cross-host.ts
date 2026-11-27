import { createHash, randomBytes, randomUUID, verify } from "node:crypto";
import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import type { Block, Conversation, HubEvent, Message } from "../client-protocol/index.js";
import type { BotSource } from "../client-protocol/bot-messages.js";
import { blocksText } from "../client-protocol/index.js";
import { anyRun, isRunActive } from "../client-protocol/run.js";
import { activeAnswerFollowup, answerFollowup } from "../client-protocol/answer-followup.js";
import { queueNotice } from "../client-protocol/queue-notice.js";
import { orderedRoutes, type Route } from "../client-protocol/routes.js";
import {
  GROUP_MAX_REMOTE_MEMBERS,
  GROUP_MAX_TOTAL_MEMBERS,
  addGroupMemberInputSchema,
  createGroupRoomInputSchema,
  groupAutoSessionTitle,
  groupHistoryVisibilitySchema,
  groupMailDeliverSchema,
  groupMailReplySchema,
  makeGroupMemberKey,
  setDesignatedMemberInputSchema,
  switchGroupMemberSessionInputSchema,
  type AddGroupMemberInput,
  type CreateGroupRoomInput,
  type GroupFormerSession,
  type GroupHistoryVisibility,
  type GroupLocalSessionDispatch,
  type GroupMailDeliver,
  type GroupMailReply,
  type GroupMemberSession,
  type GroupMembersState,
  type GroupPeerBot,
  type GroupSessionCandidate,
  type RemoteGroupQuestion,
  type RemoteGroupQuestionStatus,
  type SwitchGroupMemberSessionInput,
} from "../client-protocol/group-members.js";
import { hashSecret, parsePublicKey, type HubAuth } from "./auth.js";
import { BOT_AVATAR_DEFAULT_PREFIX } from "./bot-avatar-default.js";
import { certificateAuthority, loopback } from "./network-peer.js";
import { forgetPeerPin, observePeerCertificate, peerPin, peerTlsOptions, TlsPinMismatch, type PeerTls } from "./peer-tls.js";
import { HubError, type HubStore, type RemoteGroupDispatch, type TransactionGuard } from "./store.js";

export type GroupPeerEndpoint = {
  hostId: string;
  hostName: string;
  publicKey: string;
  url?: string;
  routes?: Route[];
  /** Explicit opt-in for loopback/plain HTTP test fixtures via registerPeer(). Production network peers always leave this false. */
  allowLoopback?: boolean;
  /** True when registered via registerPeer() rather than PrivateNetwork manifest. */
  manualPeer?: boolean;
};

type PeerFetchResult = { status: number; json: unknown };
export type GroupPeerTransport = (
  peer: GroupPeerEndpoint,
  method: "GET" | "POST",
  routePath: string,
  headers: Record<string, string>,
  body?: string,
) => Promise<PeerFetchResult>;

type GrantRecord = { sourceKey: string; sourceBot: string; targetBot: string; revoked: boolean };

const PEER_CLOCK_SKEW_MS = 60_000;
const PEER_TIMEOUT_MS = 10_000;
const SENDING_SWEEP_GRACE_MS = 1_000;
const MAX_GROUP_MAIL_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_NONCE_ROWS = 16_384;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

function botGrantKey(sourceKey: string, sourceBot: string, targetBot: string): string {
  return `bot-messages:grant:${hashSecret(JSON.stringify([sourceKey, sourceBot, targetBot]))}`;
}

export function groupMailSignaturePayload(
  sourcePublicKey: string,
  targetPublicKey: string,
  method: string,
  routePath: string,
  timestamp: string,
  nonce: string,
  bodyText: string,
): string {
  const digest = createHash("sha256").update(bodyText).digest("hex");
  return `tarobot/group-mail/v2\0${sourcePublicKey}\0${targetPublicKey}\0${method}\0${routePath}\0${timestamp}\0${nonce}\0${digest}`;
}

function sendRouteHttp(
  route: Route,
  method: "GET" | "POST",
  routePath: string,
  headers: Record<string, string>,
  body: string | undefined,
  tls: PeerTls,
  allowLoopback: boolean,
): Promise<PeerFetchResult> {
  const base = new URL(route.url);
  const isHttps = base.protocol === "https:";
  const isHttp = base.protocol === "http:";
  if (!allowLoopback && (!isHttps || loopback(base.hostname))) {
    throw new HubError("network_route_must_be_remote", 400);
  }
  if (!isHttps && !isHttp) {
    throw new HubError("network_route_must_be_remote", 400);
  }
  const ca = isHttps ? certificateAuthority(route) : undefined;
  const payload = body !== undefined ? Buffer.from(body, "utf8") : undefined;
  const reqHeaders: Record<string, string | number> = {
    Accept: "application/json",
    ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
    ...headers,
  };
  const lookupOption: Pick<import("node:https").RequestOptions, "lookup"> = allowLoopback
    ? {}
    : {
        lookup: (hostname, options, callback) =>
          lookup(hostname, options, (err, address, family) => {
            if (err) {
              callback(err, address, family);
              return;
            }
            const addresses = Array.isArray(address) ? address.map((item) => item.address) : [address];
            if (addresses.some((addr) => !isIP(addr) || loopback(addr))) {
              callback(new Error("network_route_must_be_remote"), address, family);
              return;
            }
            callback(null, address, family);
          }),
      };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: unknown, value?: PeerFetchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value!);
    };
    const targetUrl = new URL(routePath, base);
    const onResponse = (res: import("node:http").IncomingMessage) => {
      if (isHttps) {
        const unobserved = observePeerCertificate(res, tls);
        if (unobserved) {
          finish(unobserved);
          res.destroy();
          return;
        }
      }
      // Never follow redirects on peer traffic.
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        res.destroy();
        finish(new HubError("group_peer_redirect_forbidden", 502));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_GROUP_MAIL_RESPONSE_BYTES) {
          res.destroy();
          finish(new HubError("group_peer_response_too_large", 502));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", (err) => finish(err));
      res.on("aborted", () => finish(new Error("group_peer_response_aborted")));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
        finish(undefined, { status: res.statusCode ?? 502, json });
      });
    };

    const req = isHttps
      ? httpsRequest(targetUrl, {
          method,
          agent: false,
          rejectUnauthorized: true,
          ...(ca ? { ca } : {}),
          ...peerTlsOptions(tls),
          ...lookupOption,
          headers: reqHeaders,
        }, onResponse)
      : httpRequest(targetUrl, {
          method,
          agent: false,
          ...lookupOption,
          headers: reqHeaders,
        }, onResponse);

    const timer = setTimeout(() => req.destroy(new HubError("group_peer_timeout", 504)), PEER_TIMEOUT_MS);
    timer.unref();
    req.on("error", (err) => finish(err));
    req.end(payload);
  });
}

async function defaultPeerTransport(
  peer: GroupPeerEndpoint,
  method: "GET" | "POST",
  routePath: string,
  headers: Record<string, string>,
  body?: string,
): Promise<PeerFetchResult> {
  const allowLoopback = peer.allowLoopback === true;
  const candidateRoutes: Route[] = peer.routes?.length
    ? orderedRoutes(peer.routes)
    : peer.url
      ? [{ name: "Direct", url: peer.url }]
      : [];
  if (!candidateRoutes.length) throw new HubError("peer_host_offline", 503);

  // Plain HTTP loopback routes (test fixtures without TLS).
  if (allowLoopback && candidateRoutes.every((r) => new URL(r.url).protocol === "http:")) {
    let lastError: unknown;
    for (const route of candidateRoutes) {
      try {
        return await sendRouteHttp(route, method, routePath, headers, body, {}, true);
      } catch (err) {
        lastError = err;
        if (method === "POST") throw err;
      }
    }
    throw lastError ?? new HubError("peer_host_offline", 503);
  }

  // Real HTTPS routes: prove peer identity on the TLS leaf via /api/tls-identity
  // (using route.certificateAuthority + peer-tls leaf pinning) before sending private payloads.
  if (method === "GET") {
    let lastError: unknown = new HubError("peer_host_offline", 503);
    for (const route of candidateRoutes) {
      for (let attempt = 0; ; attempt++) {
        try {
          const { pin, cached } = await peerPin(peer.publicKey, route, async (probePath, tls) => {
            const res = await sendRouteHttp(route, "GET", probePath, {}, undefined, tls, allowLoopback);
            if (res.status !== 200) throw new HubError("tls_identity_unavailable", res.status);
            return res.json;
          });
          try {
            return await sendRouteHttp(route, method, routePath, headers, body, { pin }, allowLoopback);
          } catch (error) {
            if (error instanceof TlsPinMismatch) {
              forgetPeerPin(peer.publicKey, route);
              if (cached && attempt === 0) continue;
            }
            throw error;
          }
        } catch (error) {
          lastError = error;
          break;
        }
      }
    }
    throw lastError;
  }

  // POST: probe routes without private data first, then transmit ONCE on the proven route.
  for (let attempt = 0; ; attempt++) {
    let chosen: Route | undefined;
    let pin: string | undefined;
    let cached = false;
    let lastProbeError: unknown;
    for (const route of candidateRoutes) {
      try {
        ({ pin, cached } = await peerPin(peer.publicKey, route, async (probePath, tls) => {
          const res = await sendRouteHttp(route, "GET", probePath, {}, undefined, tls, allowLoopback);
          if (res.status !== 200) throw new HubError("tls_identity_unavailable", res.status);
          return res.json;
        }));
        chosen = route;
        break;
      } catch (err) {
        lastProbeError = err;
      }
    }
    if (!chosen) throw lastProbeError ?? new HubError("peer_host_offline", 503);
    try {
      return await sendRouteHttp(chosen, method, routePath, headers, body, { pin }, allowLoopback);
    } catch (error) {
      if (error instanceof TlsPinMismatch) {
        forgetPeerPin(peer.publicKey, chosen);
        if (cached && attempt === 0) continue;
      }
      throw error;
    }
  }
}

export class HubCrossHostGroups {
  private readonly peers = new Map<string, GroupPeerEndpoint>();
  private initialized = false;
  private initPromise?: Promise<void>;
  private transport: GroupPeerTransport;
  private localUrlProvider: () => string | undefined;
  private localHostNameProvider: () => Promise<string>;
  private networkPeersProvider?: () => Promise<GroupPeerEndpoint[]>;
  private requireNetworkPeerInTransaction?: (publicKey: string) => Promise<void>;
  private onGroupStopLocal?: (groupId: string, userId: string) => Promise<void>;
  private onConversationsChanged?: (userId: string, conversations: Conversation[]) => void;
  private stoppingProvider: () => boolean;
  private flushingReplies = false;
  private recoveringQuestions = false;
  private readonly inFlightDeliveries = new Map<string, Promise<RemoteGroupQuestion | undefined>>();

  constructor(
    private readonly store: HubStore,
    private readonly auth: HubAuth,
    options?: {
      transport?: GroupPeerTransport;
      localUrl?: () => string | undefined;
      localHostName?: () => Promise<string>;
      networkPeers?: () => Promise<GroupPeerEndpoint[]>;
      requireNetworkPeerInTransaction?: (publicKey: string) => Promise<void>;
      onGroupStopLocal?: (groupId: string, userId: string) => Promise<void>;
      onConversationsChanged?: (userId: string, conversations: Conversation[]) => void;
      stopping?: () => boolean;
    },
  ) {
    this.transport = options?.transport ?? defaultPeerTransport;
    this.localUrlProvider = options?.localUrl ?? (() => undefined);
    this.localHostNameProvider = options?.localHostName ?? (async () => "local");
    this.networkPeersProvider = options?.networkPeers;
    this.requireNetworkPeerInTransaction = options?.requireNetworkPeerInTransaction;
    this.onGroupStopLocal = options?.onGroupStopLocal;
    this.onConversationsChanged = options?.onConversationsChanged;
    this.stoppingProvider = options?.stopping ?? (() => false);
  }

  /** Allows tests or custom deployments to override the cross-host transport (e.g. simulate mid-flight drops). */
  setTransport(transport: GroupPeerTransport): void {
    this.transport = transport;
  }

  registerPeer(peer: GroupPeerEndpoint): void {
    this.peers.set(peer.hostId, {
      ...peer,
      allowLoopback: peer.allowLoopback ?? true,
      manualPeer: true,
    });
  }

  unregisterPeer(hostId: string): void {
    this.peers.delete(hostId);
  }

  /** Grants a peer Host access to a local Bot for cross-host group operations using the shared bot-messages grant ledger. */
  async grantPeerBot(sourcePublicKey: string, targetBotId: string, sourceBot = "group"): Promise<void> {
    await this.init();
    await this.store.db.transaction(async () => {
      const bot = await this.store.db.get<{ role: string }>("SELECT role FROM bots WHERE id=? AND deleted_at IS NULL", [targetBotId]);
      if (!bot) throw new HubError("bot_not_found", 404);
      if (bot.role === "dispatcher") throw new HubError("dispatcher_group_forbidden", 409);
      if (bot.role === "worker") throw new HubError("dispatch_worker_internal", 409);
      const key = botGrantKey(sourcePublicKey, sourceBot, targetBotId);
      const record: GrantRecord = { sourceKey: sourcePublicKey, sourceBot, targetBot: targetBotId, revoked: false };
      await this.store.db.run(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [key, JSON.stringify(record)],
      );
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.store.db.serial(async () => {
          // Tables are created and migrated in HubDatabase.open() (schema v27).
          this.initialized = true;
        });
        // Recovery of interrupted `sending` questions is not part of init: peers
        // may be asleep, and every API call awaits init. HubServer.start runs
        // `recoverPendingQuestions({ includeRecent: true })` in the background.
      })();
    }
    await this.initPromise;
  }

  private safeLocalUrl(): string | undefined {
    try {
      return this.localUrlProvider();
    } catch {
      return undefined;
    }
  }

  private async allPeers(): Promise<GroupPeerEndpoint[]> {
    const merged = new Map<string, GroupPeerEndpoint>();
    if (this.networkPeersProvider) {
      for (const peer of await this.networkPeersProvider().catch(() => [])) {
        if (peer.publicKey !== this.auth.publicKey) merged.set(peer.hostId, { ...peer, allowLoopback: false, manualPeer: false });
      }
    }
    for (const peer of this.peers.values()) {
      if (peer.publicKey !== this.auth.publicKey) merged.set(peer.hostId, peer);
    }
    return [...merged.values()];
  }

  private async findPeer(hostId: string): Promise<GroupPeerEndpoint | undefined> {
    const peers = await this.allPeers();
    return peers.find((p) => p.hostId === hostId);
  }

  private async findPeerByPublicKey(publicKey: string): Promise<GroupPeerEndpoint | undefined> {
    const peers = await this.allPeers();
    return peers.find((p) => p.publicKey === publicKey);
  }

  private signPeerHeaders(peer: GroupPeerEndpoint, method: "GET" | "POST", routePath: string, bodyText: string): Record<string, string> {
    const timestamp = String(Date.now());
    const nonce = randomBytes(24).toString("base64url");
    const payload = groupMailSignaturePayload(this.auth.publicKey, peer.publicKey, method, routePath, timestamp, nonce, bodyText);
    const signature = this.auth.signGroupMail(payload);
    return {
      "X-TaroBot-Group-Peer-Key": this.auth.publicKey,
      "X-TaroBot-Group-Target-Key": peer.publicKey,
      "X-TaroBot-Group-Timestamp": timestamp,
      "X-TaroBot-Group-Nonce": nonce,
      "X-TaroBot-Group-Signature": signature,
    };
  }

  async verifyPeerRequest(
    method: "GET" | "POST",
    routePath: string,
    headers: Record<string, string | string[] | undefined>,
    bodyText: string,
  ): Promise<GroupPeerEndpoint> {
    await this.init();
    const key = String(headers["x-tarobot-group-peer-key"] ?? "");
    const targetKey = String(headers["x-tarobot-group-target-key"] ?? "");
    const timestamp = String(headers["x-tarobot-group-timestamp"] ?? "");
    const nonce = String(headers["x-tarobot-group-nonce"] ?? "");
    const signature = String(headers["x-tarobot-group-signature"] ?? "");
    if (!key || !targetKey || !timestamp || !nonce || !signature) {
      throw new HubError("group_peer_unauthorized", 401);
    }
    if (targetKey !== this.auth.publicKey) {
      throw new HubError("group_peer_target_mismatch", 403);
    }
    if (!NONCE_RE.test(nonce)) {
      throw new HubError("group_peer_unauthorized", 401);
    }
    const ts = Number(timestamp);
    const now = Date.now();
    if (!Number.isFinite(ts) || Math.abs(now - ts) > PEER_CLOCK_SKEW_MS) {
      throw new HubError("group_peer_timestamp_expired", 401);
    }
    const peer = await this.findPeerByPublicKey(key);
    if (!peer) throw new HubError("group_peer_unknown", 403);

    const payload = groupMailSignaturePayload(peer.publicKey, this.auth.publicKey, method, routePath, timestamp, nonce, bodyText);
    let ok = false;
    try {
      ok = verify(null, Buffer.from(payload), parsePublicKey(peer.publicKey), Buffer.from(signature, "base64"));
    } catch {
      ok = false;
    }
    if (!ok) throw new HubError("group_peer_signature_invalid", 403);

    await this.store.db.transaction(async () => {
      if (!peer.manualPeer && this.requireNetworkPeerInTransaction) {
        await this.requireNetworkPeerInTransaction(peer.publicKey);
      }
      await this.store.db.run("DELETE FROM group_mail_nonces WHERE expires_at <= ?", [now]);
      const countRow = await this.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM group_mail_nonces");
      if ((countRow?.n ?? 0) >= MAX_NONCE_ROWS) {
        throw new HubError("rate_limited", 429);
      }
      const inserted = await this.store.db.run(
        "INSERT OR IGNORE INTO group_mail_nonces(source_public_key, nonce, expires_at) VALUES(?,?,?)",
        [peer.publicKey, nonce, ts + PEER_CLOCK_SKEW_MS * 2],
      );
      if (inserted.changes !== 1) {
        throw new HubError("group_peer_replay", 403);
      }
    });

    return peer;
  }

  private async callPeer(peer: GroupPeerEndpoint, method: "GET" | "POST", routePath: string, body?: unknown): Promise<PeerFetchResult> {
    const bodyText = body !== undefined ? JSON.stringify(body) : "";
    const headers = this.signPeerHeaders(peer, method, routePath, bodyText);
    return this.transport(peer, method, routePath, headers, body !== undefined ? bodyText : undefined);
  }

  /** Caller holds store.db.serial / transaction. */
  private async peerAllowedBotIdsInTransaction(sourcePublicKey: string): Promise<Set<string>> {
    const allowed = new Set<string>();
    const rows = await this.store.db.all<{ key: string; value: string }>(
      "SELECT key, value FROM meta WHERE key LIKE 'bot-messages:grant:%'",
    );
    for (const row of rows) {
      let grant: GrantRecord;
      try { grant = JSON.parse(row.value) as GrantRecord; } catch { continue; }
      if (
        !grant.revoked
        && grant.sourceKey === sourcePublicKey
        && typeof grant.sourceBot === "string"
        && typeof grant.targetBot === "string"
        && row.key === botGrantKey(grant.sourceKey, grant.sourceBot, grant.targetBot)
      ) {
        allowed.add(grant.targetBot);
      }
    }
    return allowed;
  }

  /** Caller holds store.db.serial / transaction. */
  private async resolveBotAvatarInTransaction(botId: string): Promise<string | null> {
    const custom = await this.store.db.get<{ revision: number }>(
      "SELECT revision FROM profile_avatars WHERE kind='bot' AND target_id=? AND png IS NOT NULL",
      [botId],
    );
    if (custom) return `profile:bot:${botId}:v${custom.revision}`;
    const assigned = await this.store.db.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      [BOT_AVATAR_DEFAULT_PREFIX + botId],
    );
    return assigned?.value ?? null;
  }

  /** Caller holds store.db.serial / transaction. */
  private async listLocalBotSessionsInTransaction(ownerId: string, botId: string): Promise<GroupSessionCandidate[]> {
    const rows = await this.store.db.all<{ id: string; title: string; created_at: number }>(
      `SELECT c.id, c.title, c.created_at
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE c.type = 'direct' AND c.archived = 0 AND c.hidden = 0 AND c.parent_id IS NULL AND c.owner_id = ?
         AND cm.member_type = 'bot' AND cm.member_id = ?
       ORDER BY c.created_at DESC LIMIT 64`,
      [ownerId, botId],
    );
    return rows.map((row) => ({ sessionId: row.id, title: row.title, createdAt: row.created_at }));
  }

  /** Serves ONLY cross-host-granted, non-dispatcher, non-worker Bots + their non-hidden direct sessions to an authenticated peer Hub. */
  async handlePeerDirectory(peer: GroupPeerEndpoint): Promise<{ hostName: string; bots: GroupPeerBot[] }> {
    await this.init();
    const hostName = await this.localHostNameProvider();
    return this.store.db.serial(async () => {
      if (!peer.manualPeer && this.requireNetworkPeerInTransaction) {
        await this.requireNetworkPeerInTransaction(peer.publicKey);
      }
      const allowedBots = await this.peerAllowedBotIdsInTransaction(peer.publicKey);
      if (!allowedBots.size) return { hostName, bots: [] };
      const owner = await this.store.db.get<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY id ASC LIMIT 1");
      const ownerId = owner?.id ?? "owner";
      const bots = await this.store.db.all<{ id: string; name: string; engine: string; online: number }>(
        "SELECT id, name, engine, online FROM bots WHERE deleted_at IS NULL AND (role IS NULL OR role NOT IN ('dispatcher','worker')) ORDER BY name ASC",
      );
      const result: GroupPeerBot[] = [];
      for (const bot of bots) {
        if (!allowedBots.has(bot.id)) continue;
        const sessions = await this.listLocalBotSessionsInTransaction(ownerId, bot.id);
        const avatar = await this.resolveBotAvatarInTransaction(bot.id);
        result.push({
          hostId: "remote",
          hostName,
          hostPublicKey: this.auth.publicKey,
          online: !!bot.online,
          botId: bot.id,
          name: bot.name,
          engine: bot.engine,
          ...(avatar ? { avatar } : {}),
          sessions,
        });
      }
      return { hostName, bots: result };
    });
  }

  /** Creates a new direct session for an authorized non-dispatcher, non-worker Bot on this Hub when requested by a peer Hub. */
  async handlePeerEnsureSession(peer: GroupPeerEndpoint, body: { botId: string; title: string; requestId?: string }): Promise<GroupSessionCandidate> {
    await this.init();
    const created = await this.store.db.transaction(async () => {
      if (!peer.manualPeer && this.requireNetworkPeerInTransaction) {
        await this.requireNetworkPeerInTransaction(peer.publicKey);
      }
      const bot = await this.store.db.get<{ id: string; name: string; role: string | null }>(
        "SELECT id, name, role FROM bots WHERE id=? AND deleted_at IS NULL",
        [body.botId],
      );
      if (!bot) throw new HubError("bot_not_found", 404);
      if (bot.role === "dispatcher") throw new HubError("dispatcher_group_forbidden", 409);
      if (bot.role === "worker") throw new HubError("dispatch_worker_internal", 409);
      const allowedBots = await this.peerAllowedBotIdsInTransaction(peer.publicKey);
      if (!allowedBots.has(bot.id)) throw new HubError("bot_message_not_authorized", 403);

      const owner = await this.store.db.get<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY id ASC LIMIT 1");
      const ownerId = owner?.id ?? "owner";
      const actionId = body.requestId
        ? `gsess_${hashSecret(JSON.stringify([peer.publicKey, bot.id, body.requestId])).slice(0, 24)}`
        : `sess_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const conv = await this.store.createConversationInTransaction(ownerId, [bot.id], body.title.slice(0, 256), actionId, { type: "direct" });
      return { ownerId, conv };
    });
    this.onConversationsChanged?.(created.ownerId, [created.conv]);
    return { sessionId: created.conv.id, title: created.conv.title, createdAt: created.conv.createdAt };
  }

  /** Receives a cross-host group question on the target Hub, enforcing per-Bot grant, non-dispatcher/worker, direct non-archived non-hidden session, and strict ID binding. */
  async handlePeerDeliver(peer: GroupPeerEndpoint, raw: unknown): Promise<{
    requestId: string;
    status: "delivered";
    deliveredMessageId: string;
    botId: string;
    sessionId: string;
  }> {
    await this.init();
    const input = groupMailDeliverSchema.parse(raw);

    const committed = await this.store.db.transaction(async () => {
      if (!peer.manualPeer && this.requireNetworkPeerInTransaction) {
        await this.requireNetworkPeerInTransaction(peer.publicKey);
      }

      // Idempotent check across Hub restarts, bound strictly to the original peer key!
      const existing = await this.store.db.get<{ delivered_message_id: string; bot_id: string; session_id: string; source_public_key: string }>(
        "SELECT delivered_message_id, bot_id, session_id, source_public_key FROM group_mail_inbox WHERE request_id=?",
        [input.requestId],
      );
      if (existing) {
        if (existing.source_public_key !== peer.publicKey) {
          throw new HubError("group_mail_forbidden", 403);
        }
        return {
          result: {
            requestId: input.requestId,
            status: "delivered" as const,
            deliveredMessageId: existing.delivered_message_id,
            botId: existing.bot_id,
            sessionId: existing.session_id,
          },
          event: undefined as HubEvent | undefined,
        };
      }

      const bot = await this.store.db.get<{ id: string; name: string; role: string | null }>(
        "SELECT id, name, role FROM bots WHERE id=? AND deleted_at IS NULL",
        [input.botId],
      );
      if (!bot) throw new HubError("remote_bot_not_found", 404);
      if (bot.role === "dispatcher") throw new HubError("dispatcher_group_forbidden", 409);
      if (bot.role === "worker") throw new HubError("dispatch_worker_internal", 409);
      const allowedBots = await this.peerAllowedBotIdsInTransaction(peer.publicKey);
      if (!allowedBots.has(bot.id)) throw new HubError("bot_message_not_authorized", 403);

      const owner = await this.store.db.get<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY id ASC LIMIT 1");
      const ownerId = owner?.id ?? "owner";

      const validSession = await this.store.db.get<{ id: string }>(
        `SELECT c.id FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE c.id = ? AND c.type = 'direct' AND c.archived = 0 AND c.hidden = 0 AND c.parent_id IS NULL AND c.owner_id = ?
           AND cm.member_type = 'bot' AND cm.member_id = ?`,
        [input.sessionId, ownerId, input.botId],
      );
      if (!validSession) throw new HubError("remote_session_mismatch", 409);

      const contextPrefix = input.contextMessages.length
        ? `[Group "${input.groupTitle}" recent context]\n${input.contextMessages.map((m) => `${m.authorName}: ${m.text}`).join("\n")}\n\n`
        : "";
      const composedText = `${contextPrefix}[From ${input.sourceHostName} · Group "${input.groupTitle}"]\n${input.text}`;
      const botSource: BotSource = {
        hostId: input.sourceHostId,
        hostName: input.sourceHostName,
        botId: input.groupId,
        botName: input.groupTitle,
        requestId: input.requestId,
        hops: 1,
      };

      const delivered = await this.store.sendMessageInTransaction(ownerId, {
        conversationId: input.sessionId,
        clientMsgId: `gmail_${input.requestId}`,
        text: composedText,
        attachments: [],
        mentions: [input.botId],
        botSource,
      });

      await this.store.db.run(
        `INSERT INTO group_mail_inbox(
          request_id, group_id, conversation_id, source_host_id, source_host_name, source_public_key,
          bot_id, session_id, delivered_message_id, status, received_at, reply_forwarded, reply_attempts, reply_next_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'delivered',?,0,0,0)`,
        [
          input.requestId, input.groupId, input.conversationId, input.sourceHostId, input.sourceHostName,
          peer.publicKey, input.botId, input.sessionId, delivered.message.id, Date.now(),
        ],
      );

      return {
        result: {
          requestId: input.requestId,
          status: "delivered" as const,
          deliveredMessageId: delivered.message.id,
          botId: input.botId,
          sessionId: input.sessionId,
        },
        event: delivered.event,
      };
    });

    if (committed.event) this.store.emitCommitted([committed.event]);
    return committed.result;
  }

  /** Records a remote Bot's reply durably on the target Hub and forwards it back to the originating Hub (with durable retry on peer failure). */
  async recordRemoteBotReply(requestId: string, replyMessageId: string, replyText: string): Promise<void> {
    await this.init();
    const shouldForward = await this.store.db.transaction(async () => {
      const row = await this.store.db.get<{ request_id: string; reply_forwarded: number }>(
        "SELECT request_id, reply_forwarded FROM group_mail_inbox WHERE request_id=?",
        [requestId],
      );
      if (!row) return false;
      const now = Date.now();
      await this.store.db.run(
        `UPDATE group_mail_inbox
         SET reply_message_id=?, reply_text=?, status='answered', answered_at=COALESCE(answered_at, ?),
             reply_next_at=CASE WHEN reply_forwarded=1 THEN reply_next_at ELSE 0 END
         WHERE request_id=?`,
        [replyMessageId, replyText, now, requestId],
      );
      return !row.reply_forwarded;
    });
    if (shouldForward) {
      await this.forwardInboxReply(requestId);
    }
  }

  private async forwardInboxReply(requestId: string): Promise<void> {
    const row = await this.store.db.serial(() =>
      this.store.db.get<{
        request_id: string;
        group_id: string;
        conversation_id: string;
        source_public_key: string;
        bot_id: string;
        session_id: string;
        reply_text: string | null;
        reply_forwarded: number;
        reply_attempts: number;
      }>("SELECT request_id, group_id, conversation_id, source_public_key, bot_id, session_id, reply_text, reply_forwarded, reply_attempts FROM group_mail_inbox WHERE request_id=?", [requestId]),
    );
    if (!row || row.reply_forwarded || row.reply_text === null) return;

    const originPeer = await this.findPeerByPublicKey(row.source_public_key);
    if (!originPeer) {
      await this.scheduleReplyRetry(requestId, row.reply_attempts);
      return;
    }

    const payload: GroupMailReply = {
      requestId: row.request_id,
      groupId: row.group_id,
      conversationId: row.conversation_id,
      botId: row.bot_id,
      sessionId: row.session_id,
      text: row.reply_text,
    };

    try {
      const res = await this.callPeer(originPeer, "POST", "/api/group-mail/reply", payload);
      if (res.status === 200) {
        await this.store.db.serial(() =>
          this.store.db.run("UPDATE group_mail_inbox SET reply_forwarded=1 WHERE request_id=?", [requestId]),
        );
        return;
      }
      if (res.status === 404 || res.status === 403) {
        // Terminal rejection by origin Hub; avoid infinite tight retry, back off maximally.
        await this.scheduleReplyRetry(requestId, Math.max(row.reply_attempts, 6));
        return;
      }
      await this.scheduleReplyRetry(requestId, row.reply_attempts);
    } catch {
      await this.scheduleReplyRetry(requestId, row.reply_attempts);
    }
  }

  private async scheduleReplyRetry(requestId: string, currentAttempts: number): Promise<void> {
    const attempts = currentAttempts + 1;
    const backoffMs = Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6));
    await this.store.db.serial(() =>
      this.store.db.run(
        "UPDATE group_mail_inbox SET reply_attempts=?, reply_next_at=? WHERE request_id=? AND reply_forwarded=0",
        [attempts, Date.now() + backoffMs, requestId],
      ),
    );
  }

  /** Called periodically by HubServer.sweep() to durably retry unanswered reply forwards after peer outages or restarts. */
  async flushPendingReplies(): Promise<void> {
    if (this.flushingReplies) return;
    this.flushingReplies = true;
    try {
      await this.init();
      const due = await this.store.db.serial(() =>
        this.store.db.all<{ request_id: string }>(
          "SELECT request_id FROM group_mail_inbox WHERE status='answered' AND reply_forwarded=0 AND reply_next_at <= ? ORDER BY reply_next_at ASC LIMIT 16",
          [Date.now()],
        ),
      );
      for (const row of due) {
        await this.forwardInboxReply(row.request_id).catch(() => undefined);
      }
    } finally {
      this.flushingReplies = false;
    }
  }

  /** Checks whether a completed Bot reply belongs to a cross-host group-mail inbox turn and forwards it when the turn is settled. */
  private async collectAndForwardInboxReply(botId: string, deliveredMessageId: string, requireSettledDelivery: boolean): Promise<void> {
    await this.init();
    const candidate = await this.store.db.serial(async () => {
      const inbox = await this.store.db.get<{ request_id: string; session_id: string; status: string }>(
        "SELECT request_id, session_id, status FROM group_mail_inbox WHERE delivered_message_id=? AND bot_id=? AND status='delivered'",
        [deliveredMessageId, botId],
      );
      if (!inbox) return undefined;
      if (requireSettledDelivery) {
        const delivery = await this.store.db.get<{ status: string }>(
          "SELECT status FROM deliveries WHERE message_id=? AND bot_id=?",
          [deliveredMessageId, botId],
        );
        if (!delivery || !["accepted", "failed"].includes(delivery.status)) return undefined;
      }
      const replies = await this.store.db.all<{ id: string; blocks_json: string; status: Message["status"]; created_at: number }>(
        `SELECT id, blocks_json, status, created_at FROM messages
         WHERE conversation_id=? AND author_type='bot' AND author_id=? AND reply_to=? AND status!='deleted'
         ORDER BY created_at ASC, id ASC LIMIT 200`,
        [inbox.session_id, botId, deliveredMessageId],
      );
      if (!replies.length) return undefined;
      for (const reply of replies) {
        if (reply.status === "pending" || reply.status === "streaming") return undefined;
        let blocks: Block[];
        try { blocks = JSON.parse(reply.blocks_json) as Block[]; } catch { continue; }
        const meta = { authorType: "bot" as const, conversationId: inbox.session_id, replyTo: deliveredMessageId, createdAt: reply.created_at };
        for (const block of blocks) {
          if (block.type !== "card") continue;
          const run = anyRun(block);
          if (run && isRunActive(run.phase)) return undefined;
          if (activeAnswerFollowup(answerFollowup(block))) return undefined;
          if (["queued", "started"].includes(queueNotice(block, meta)?.state ?? "")) return undefined;
        }
      }
      const textParts: string[] = [];
      let latestId = replies[replies.length - 1]!.id;
      for (const reply of replies) {
        let blocks: Block[];
        try { blocks = JSON.parse(reply.blocks_json) as Block[]; } catch { continue; }
        const text = blocksText(blocks).trim();
        if (text) {
          textParts.push(text);
          latestId = reply.id;
        }
      }
      const finalText = textParts.join("\n\n").trim();
      if (!finalText) return undefined;
      return { requestId: inbox.request_id, replyMessageId: latestId, replyText: finalText };
    });
    if (candidate) {
      await this.recordRemoteBotReply(candidate.requestId, candidate.replyMessageId, candidate.replyText);
    }
  }

  /** Hook called from HubServer instanceRequest('publish'). */
  async onBotMessagePublished(botId: string, message: Message): Promise<void> {
    if (!message.replyTo || !["complete", "error"].includes(message.status)) return;
    await this.collectAndForwardInboxReply(botId, message.replyTo, true);
  }

  /** Hook called from HubServer instanceRequest('ack' | 'delivery.fail'). */
  async onBotTurnSettled(botId: string, deliveredMessageId: string): Promise<void> {
    await this.collectAndForwardInboxReply(botId, deliveredMessageId, false);
  }

  /** Allows ONLY the originating peer Hub to query status/recovery of its own request after target Hub restart. */
  async handlePeerStatus(peer: GroupPeerEndpoint, requestId: string): Promise<{
    found: boolean;
    status?: "delivered" | "answered";
    deliveredMessageId?: string;
    replyText?: string;
    botId?: string;
    sessionId?: string;
  }> {
    await this.init();
    return this.store.db.serial(async () => {
      const row = await this.store.db.get<{
        status: string;
        delivered_message_id: string;
        reply_text: string | null;
        bot_id: string;
        session_id: string;
        source_public_key: string;
      }>("SELECT status, delivered_message_id, reply_text, bot_id, session_id, source_public_key FROM group_mail_inbox WHERE request_id=?", [requestId]);
      if (!row) return { found: false };
      if (row.source_public_key !== peer.publicKey) {
        throw new HubError("group_mail_forbidden", 403);
      }
      return {
        found: true,
        status: row.status === "answered" ? "answered" : "delivered",
        deliveredMessageId: row.delivered_message_id,
        ...(row.reply_text !== null ? { replyText: row.reply_text } : {}),
        botId: row.bot_id,
        sessionId: row.session_id,
      };
    });
  }

  /** Receives a remote Bot's reply (verifying peer identity strictly against the question's host/key) and publishes via HubStore so WS/FTS/push stay live. */
  async handlePeerReply(peer: GroupPeerEndpoint, raw: unknown): Promise<{ accepted: true; messageId: string }> {
    await this.init();
    const input = groupMailReplySchema.parse(raw);

    const committed = await this.store.db.transaction(async () => {
      const question = await this.store.db.get<{
        id: string;
        group_id: string;
        conversation_id: string;
        member_key: string;
        host_id: string;
        host_name: string;
        host_public_key: string | null;
        bot_id: string;
        session_id: string;
        bot_name_snapshot: string;
        source_message_id: string;
        answer_message_id: string | null;
      }>("SELECT * FROM group_remote_questions WHERE request_id=?", [input.requestId]);
      if (!question) throw new HubError("group_question_not_found", 404);

      let expectedPublicKey = question.host_public_key;
      if (!expectedPublicKey) {
        const memberRow = await this.store.db.get<{ host_public_key: string | null }>(
          "SELECT host_public_key FROM group_session_members WHERE conversation_id=? AND member_key=? AND session_id=?",
          [question.conversation_id, question.member_key, question.session_id],
        );
        expectedPublicKey = memberRow?.host_public_key ?? null;
      }

      if (
        question.host_id !== peer.hostId
        || (expectedPublicKey && expectedPublicKey !== peer.publicKey)
        || question.group_id !== input.groupId
        || question.conversation_id !== input.conversationId
        || question.bot_id !== input.botId
        || question.session_id !== input.sessionId
      ) {
        throw new HubError("group_question_identity_mismatch", 403);
      }

      if (question.answer_message_id) {
        return { messageId: question.answer_message_id, event: undefined as HubEvent | undefined };
      }

      const published = await this.store.publishRemoteBotMessageInTransaction({
        conversationId: question.conversation_id,
        botId: question.bot_id,
        clientMsgId: `gans_${input.requestId}`,
        replyTo: question.source_message_id,
        blocks: [{ type: "text", text: input.text }],
        botSource: {
          hostId: peer.hostId,
          hostName: question.host_name,
          botId: question.bot_id,
          botName: question.bot_name_snapshot,
          requestId: input.requestId,
          hops: 1,
        },
      });

      const now = Date.now();
      await this.store.db.run(
        "UPDATE group_remote_questions SET status='delivered', error=NULL, updated_at=?, answered_at=?, answer_message_id=? WHERE id=?",
        [now, now, published.message.id, question.id],
      );
      return { messageId: published.message.id, event: published.event };
    });

    if (committed.event) this.store.emitCommitted([committed.event]);
    return { accepted: true, messageId: committed.messageId };
  }

  /** Caller holds store.db.serial / transaction. */
  private async currentGroupMaxSeqInTransaction(conversationId: string): Promise<number> {
    const row = await this.store.db.get<{ max_seq: number | null }>(
      "SELECT MAX(seq) AS max_seq FROM events WHERE conversation_id=?",
      [conversationId],
    );
    return row?.max_seq ?? 0;
  }

  private mapMemberRow(row: Record<string, unknown>): GroupMemberSession {
    return {
      memberKey: String(row.member_key),
      kind: row.kind === "remote" ? "remote" : "local",
      hostId: String(row.host_id),
      hostName: String(row.host_name),
      ...(row.host_public_key ? { hostPublicKey: String(row.host_public_key) } : {}),
      botId: String(row.bot_id),
      sessionId: String(row.session_id),
      sessionTitle: String(row.session_title),
      nameSnapshot: String(row.name_snapshot),
      ...(row.avatar_snapshot ? { avatarSnapshot: String(row.avatar_snapshot) } : {}),
      engineSnapshot: String(row.engine_snapshot),
      joinedAt: Number(row.joined_at),
      joinedAfterSeq: Number(row.joined_after_seq),
      historyVisibility: groupHistoryVisibilitySchema.parse(JSON.parse(String(row.history_visibility_json))),
      active: Boolean(row.active),
      ...(row.removed_at ? { removedAt: Number(row.removed_at) } : {}),
    };
  }

  private mapQuestionRow(row: Record<string, unknown>): RemoteGroupQuestion {
    return {
      id: String(row.id),
      groupId: String(row.group_id),
      conversationId: String(row.conversation_id),
      memberKey: String(row.member_key),
      hostId: String(row.host_id),
      hostName: String(row.host_name),
      botId: String(row.bot_id),
      sessionId: String(row.session_id),
      botNameSnapshot: String(row.bot_name_snapshot),
      sourceMessageId: String(row.source_message_id),
      requestId: String(row.request_id),
      status: String(row.status) as RemoteGroupQuestionStatus,
      stoppedUnanswered: Boolean(row.stopped_unanswered),
      ...(row.error ? { error: String(row.error) } : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      ...(row.answered_at ? { answeredAt: Number(row.answered_at) } : {}),
      ...(row.answer_message_id ? { answerMessageId: String(row.answer_message_id) } : {}),
    };
  }

  /** Caller holds store.db.serial / transaction. Computes read-only member list for a group/room without mutating SQLite. */
  private async readMembersInTransaction(group: Conversation, localHostName: string): Promise<GroupMemberSession[]> {
    const memberRows = await this.store.db.all<Record<string, unknown>>(
      "SELECT * FROM group_session_members WHERE conversation_id=? AND active=1 ORDER BY joined_at ASC",
      [group.id],
    );
    const members = memberRows.map((r) => this.mapMemberRow(r));
    const presentLocalBots = new Set(members.filter((m) => m.kind === "local").map((m) => m.botId));

    // Synthesize read-only views for legacy local Bots that have not yet bound an explicit direct session.
    for (const botId of group.botIds) {
      if (presentLocalBots.has(botId)) continue;
      const bot = await this.store.db.get<{ id: string; name: string; engine: string }>(
        "SELECT id, name, engine FROM bots WHERE id=? AND deleted_at IS NULL",
        [botId],
      );
      if (!bot) continue;
      const existingSessions = await this.listLocalBotSessionsInTransaction(group.ownerId, botId);
      const latest = existingSessions[0];
      const avatar = await this.resolveBotAvatarInTransaction(botId);
      members.push({
        memberKey: makeGroupMemberKey("local", "local", botId),
        kind: "local",
        hostId: "local",
        hostName: localHostName,
        hostPublicKey: this.auth.publicKey,
        botId: bot.id,
        sessionId: latest?.sessionId ?? group.id,
        sessionTitle: latest?.title ?? groupAutoSessionTitle(group.title, bot.name),
        nameSnapshot: bot.name,
        ...(avatar ? { avatarSnapshot: avatar } : {}),
        engineSnapshot: bot.engine || "codex",
        joinedAt: group.createdAt,
        joinedAfterSeq: 0,
        historyVisibility: { kind: "all" },
        active: true,
      });
    }
    return members;
  }

  /** Lists available local (respecting bot_grants) & peer (owner-only) Bots along with their direct sessions. */
  async listAvailableDirectory(userId: string, validate?: TransactionGuard): Promise<GroupPeerBot[]> {
    await this.init();
    const localHostName = await this.localHostNameProvider();
    const { isOwner, localEntries } = await this.store.db.serial(async () => {
      await validate?.();
      const user = await this.store.db.get<{ role: string }>("SELECT role FROM users WHERE id=?", [userId]);
      const owner = user?.role === "owner";
      const localBots = await this.store.db.all<{ id: string; name: string; engine: string; online: number }>(
        `SELECT id, name, engine, online FROM bots
         WHERE deleted_at IS NULL AND (role IS NULL OR role NOT IN ('dispatcher','worker'))
           AND (? = 1 OR id IN (SELECT bot_id FROM bot_grants WHERE user_id=?))
         ORDER BY name ASC`,
        [owner ? 1 : 0, userId],
      );
      const entries: GroupPeerBot[] = [];
      for (const bot of localBots) {
        const avatar = await this.resolveBotAvatarInTransaction(bot.id);
        entries.push({
          hostId: "local",
          hostName: localHostName,
          hostPublicKey: this.auth.publicKey,
          online: !!bot.online,
          botId: bot.id,
          name: bot.name,
          engine: bot.engine,
          ...(avatar ? { avatar } : {}),
          sessions: await this.listLocalBotSessionsInTransaction(userId, bot.id),
        });
      }
      return { isOwner: owner, localEntries: entries };
    });

    const directory: GroupPeerBot[] = [...localEntries];
    if (!isOwner) return directory;

    for (const peer of await this.allPeers()) {
      try {
        const res = await this.callPeer(peer, "GET", "/api/group-mail/directory");
        if (res.status === 200 && res.json && typeof res.json === "object") {
          const data = res.json as { hostName?: string; bots?: GroupPeerBot[] };
          for (const bot of data.bots ?? []) {
            directory.push({
              ...bot,
              hostId: peer.hostId,
              hostName: data.hostName || peer.hostName,
              hostPublicKey: peer.publicKey,
            });
          }
        }
      } catch {
        // Peer offline: omit live directory entries without failing local settings view.
      }
    }
    return directory;
  }

  /** Strictly read-only: never inserts conversations or member rows. Caps formerSessions at 512 per schema contract. */
  async getState(userId: string, groupId: string, includeDirectory = true, validate?: TransactionGuard): Promise<GroupMembersState> {
    await this.init();
    const localHostName = await this.localHostNameProvider();
    const snapshot = await this.store.db.serial(async () => {
      await validate?.();
      await this.store.requireMember(userId, groupId);
      const group = await this.store.conversationInTransaction(groupId);
      if (group.type !== "group" || group.parentId) throw new HubError("group_required", 400);

      const members = await this.readMembersInTransaction(group, localHostName);
      const formerRows = await this.store.db.all<Record<string, unknown>>(
        "SELECT * FROM group_former_sessions WHERE conversation_id=? ORDER BY revoked_at DESC LIMIT 512",
        [groupId],
      );
      const designatedRow = await this.store.db.get<{ member_key: string }>(
        "SELECT member_key FROM group_designated_member WHERE group_id=?",
        [groupId],
      );
      const questionRows = await this.store.db.all<Record<string, unknown>>(
        "SELECT * FROM group_remote_questions WHERE group_id=? ORDER BY created_at DESC LIMIT 200",
        [groupId],
      );
      const formerSessions: GroupFormerSession[] = formerRows.map((row) => ({
        sessionId: String(row.session_id),
        memberKey: String(row.member_key),
        botId: String(row.bot_id),
        hostId: String(row.host_id),
        revokedAt: Number(row.revoked_at),
      }));

      return {
        groupId,
        designatedMemberKey: designatedRow?.member_key ?? null,
        members,
        formerSessionIds: formerSessions.map((f) => f.sessionId),
        formerSessions,
        questions: questionRows.map((r) => this.mapQuestionRow(r)),
      };
    });

    return {
      ...snapshot,
      ...(includeDirectory ? { directory: await this.listAvailableDirectory(userId, validate) } : {}),
    };
  }

  /** Caller holds store.db.transaction. Enforces root-group owner, non-archived invariants and returns group + user role. */
  private async requireMutableGroupOwnerInTransaction(userId: string, groupId: string): Promise<{ group: Conversation; isOwner: boolean }> {
    await this.store.requireMember(userId, groupId);
    const group = await this.store.conversationInTransaction(groupId);
    if (group.type !== "group" || group.parentId) throw new HubError("group_required", 400);
    if (group.ownerId !== userId) throw new HubError("conversation_owner_required", 403);
    if (group.archived) throw new HubError("conversation_archived", 409);
    const user = await this.store.db.get<{ role: string }>("SELECT role FROM users WHERE id=?", [userId]);
    return { group, isOwner: user?.role === "owner" };
  }

  async addMember(
    userId: string,
    groupId: string,
    rawInput: AddGroupMemberInput | unknown,
    validate?: TransactionGuard,
  ): Promise<GroupMemberSession> {
    await this.init();
    const input = addGroupMemberInputSchema.parse(rawInput);
    const isRemote = !!input.hostId && input.hostId !== "local";
    const historyVisibility: GroupHistoryVisibility = input.historyVisibility ?? { kind: "none" };
    const localHostName = await this.localHostNameProvider();

    if (!isRemote) {
      const committed = await this.store.db.transaction(async () => {
        await validate?.();
        const { group, isOwner } = await this.requireMutableGroupOwnerInTransaction(userId, groupId);

        const bot = await this.store.db.get<{ id: string; name: string; engine: string; role: string | null }>(
          "SELECT id, name, engine, role FROM bots WHERE id=? AND deleted_at IS NULL",
          [input.botId],
        );
        if (!bot) throw new HubError("bot_not_found", 404);
        if (bot.role === "dispatcher") throw new HubError("dispatcher_group_forbidden", 409);
        if (bot.role === "worker") throw new HubError("dispatch_worker_internal", 409);
        if (!isOwner && !(await this.store.db.get("SELECT 1 FROM bot_grants WHERE user_id=? AND bot_id=?", [userId, bot.id]))) {
          throw new HubError("bot_forbidden", 403);
        }

        const memberKey = makeGroupMemberKey("local", "local", bot.id);
        const currentMembers = await this.readMembersInTransaction(group, localHostName);
        const replacingExisting = currentMembers.some((m) => m.memberKey === memberKey);
        if (!replacingExisting && currentMembers.length >= GROUP_MAX_TOTAL_MEMBERS) {
          throw new HubError("group_member_limit", 409);
        }

        const sessions = await this.listLocalBotSessionsInTransaction(userId, bot.id);
        let chosen: GroupSessionCandidate | undefined;
        const createdConvs: Conversation[] = [];
        if (input.sessionId) {
          chosen = sessions.find((s) => s.sessionId === input.sessionId);
          if (!chosen) throw new HubError("session_not_found", 404);
        } else if (sessions.length > 0) {
          chosen = sessions[0]!;
        } else {
          const sid = `sess_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
          const title = groupAutoSessionTitle(group.title, bot.name);
          const created = await this.store.createConversationInTransaction(userId, [bot.id], title, sid, { type: "direct" });
          createdConvs.push(created);
          chosen = { sessionId: created.id, title: created.title, createdAt: created.createdAt };
        }

        const now = Date.now();
        const joinedAfterSeq = await this.currentGroupMaxSeqInTransaction(groupId);
        const avatar = await this.resolveBotAvatarInTransaction(bot.id);

        const prevActive = await this.store.db.all<{ session_id: string }>(
          "SELECT session_id FROM group_session_members WHERE conversation_id=? AND member_key=? AND active=1",
          [groupId, memberKey],
        );
        for (const prev of prevActive) {
          if (prev.session_id === chosen.sessionId) continue;
          await this.store.db.run(
            "UPDATE group_session_members SET active=0, removed_at=? WHERE conversation_id=? AND member_key=? AND session_id=?",
            [now, groupId, memberKey, prev.session_id],
          );
          await this.store.db.run(
            "INSERT OR REPLACE INTO group_former_sessions(conversation_id, group_id, session_id, member_key, bot_id, host_id, revoked_at) VALUES(?,?,?,?,?,?,?)",
            [groupId, groupId, prev.session_id, memberKey, bot.id, "local", now],
          );
        }

        await this.store.db.run(
          `INSERT OR REPLACE INTO group_session_members(
            conversation_id, group_id, member_key, kind, host_id, host_name, host_public_key, bot_id,
            session_id, session_title, name_snapshot, avatar_snapshot, engine_snapshot,
            joined_at, joined_after_seq, history_visibility_json, history_backfilled, active, removed_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,NULL)`,
          [
            groupId, groupId, memberKey, "local", "local", localHostName, this.auth.publicKey,
            bot.id, chosen.sessionId, chosen.title, bot.name, avatar, bot.engine || "codex",
            now, joinedAfterSeq, JSON.stringify(historyVisibility),
          ],
        );

        const membershipChanged = !group.botIds.includes(bot.id);
        const updatedConvs: Conversation[] = [...createdConvs];
        const convRows = await this.store.db.all<{ id: string }>("SELECT id FROM conversations WHERE id=? OR parent_id=?", [groupId, groupId]);
        for (const row of convRows) {
          await this.store.db.run("INSERT OR IGNORE INTO conversation_members VALUES(?,'bot',?,0)", [row.id, bot.id]);
          if (membershipChanged) updatedConvs.push(await this.store.conversationInTransaction(row.id));
        }

        const settingsEvent = membershipChanged ? await this.store.groupSettingsEventInTransaction(groupId) : undefined;
        const saved = await this.store.db.get<Record<string, unknown>>(
          "SELECT * FROM group_session_members WHERE conversation_id=? AND member_key=? AND session_id=?",
          [groupId, memberKey, chosen.sessionId],
        );
        return { member: this.mapMemberRow(saved!), updatedConvs, settingsEvent };
      });

      if (committed.updatedConvs.length) this.onConversationsChanged?.(userId, committed.updatedConvs);
      if (committed.settingsEvent) this.store.emitCommitted([committed.settingsEvent]);
      return committed.member;
    }

    // Remote Host member: Phase 1 validate permissions/limits inside DB serial.
    const preflight = await this.store.db.serial(async () => {
      await validate?.();
      const { group, isOwner } = await this.requireMutableGroupOwnerInTransaction(userId, groupId);
      if (!isOwner) throw new HubError("owner_required", 403);
      const currentMembers = await this.readMembersInTransaction(group, localHostName);
      const memberKey = makeGroupMemberKey("remote", input.hostId!, input.botId);
      const replacingExisting = currentMembers.some((m) => m.memberKey === memberKey);
      if (!replacingExisting && currentMembers.length >= GROUP_MAX_TOTAL_MEMBERS) {
        throw new HubError("group_member_limit", 409);
      }
      const remoteCount = currentMembers.filter((m) => m.kind === "remote" && m.memberKey !== memberKey).length;
      if (remoteCount >= GROUP_MAX_REMOTE_MEMBERS) throw new HubError("group_remote_member_limit", 409);
      return { group };
    });

    // Phase 2: Network I/O outside SQLite lock.
    const peer = await this.findPeer(input.hostId!);
    if (!peer) throw new HubError("peer_host_not_found", 404);
    const dirRes = await this.callPeer(peer, "GET", "/api/group-mail/directory").catch(() => {
      throw new HubError("peer_host_offline", 503);
    });
    if (dirRes.status !== 200 || !dirRes.json || typeof dirRes.json !== "object") {
      throw new HubError("peer_host_unavailable", 503);
    }
    const dirData = dirRes.json as { hostName?: string; bots?: GroupPeerBot[] };
    const remoteBot = (dirData.bots ?? []).find((b) => b.botId === input.botId);
    if (!remoteBot) throw new HubError("remote_bot_not_found", 404);

    let chosen: GroupSessionCandidate | undefined;
    if (input.sessionId) {
      chosen = remoteBot.sessions.find((s) => s.sessionId === input.sessionId);
      if (!chosen) throw new HubError("remote_session_not_found", 404);
    } else if (remoteBot.sessions.length > 0) {
      chosen = remoteBot.sessions[0]!;
    } else {
      const title = groupAutoSessionTitle(preflight.group.title, remoteBot.name);
      const createdRes = await this.callPeer(peer, "POST", "/api/group-mail/sessions", {
        botId: remoteBot.botId,
        title,
        requestId: randomUUID(),
      });
      if (createdRes.status !== 200 || !createdRes.json || typeof createdRes.json !== "object") {
        throw new HubError("remote_session_create_failed", 502);
      }
      chosen = createdRes.json as GroupSessionCandidate;
    }

    // Phase 3: Re-validate & commit atomically.
    const memberKey = makeGroupMemberKey("remote", peer.hostId, remoteBot.botId);
    const hostNameSnapshot = dirData.hostName || peer.hostName;
    const saved = await this.store.db.transaction(async () => {
      await validate?.();
      const { group, isOwner } = await this.requireMutableGroupOwnerInTransaction(userId, groupId);
      if (!isOwner) throw new HubError("owner_required", 403);
      const currentMembers = await this.readMembersInTransaction(group, localHostName);
      const replacingExisting = currentMembers.some((m) => m.memberKey === memberKey);
      if (!replacingExisting && currentMembers.length >= GROUP_MAX_TOTAL_MEMBERS) {
        throw new HubError("group_member_limit", 409);
      }
      const remoteCount = currentMembers.filter((m) => m.kind === "remote" && m.memberKey !== memberKey).length;
      if (remoteCount >= GROUP_MAX_REMOTE_MEMBERS) throw new HubError("group_remote_member_limit", 409);

      const now = Date.now();
      const joinedAfterSeq = await this.currentGroupMaxSeqInTransaction(groupId);
      const prevActive = await this.store.db.all<{ session_id: string }>(
        "SELECT session_id FROM group_session_members WHERE conversation_id=? AND member_key=? AND active=1",
        [groupId, memberKey],
      );
      for (const prev of prevActive) {
        if (prev.session_id === chosen!.sessionId) continue;
        await this.store.db.run(
          "UPDATE group_session_members SET active=0, removed_at=? WHERE conversation_id=? AND member_key=? AND session_id=?",
          [now, groupId, memberKey, prev.session_id],
        );
        await this.store.db.run(
          "INSERT OR REPLACE INTO group_former_sessions(conversation_id, group_id, session_id, member_key, bot_id, host_id, revoked_at) VALUES(?,?,?,?,?,?,?)",
          [groupId, groupId, prev.session_id, memberKey, remoteBot.botId, peer.hostId, now],
        );
      }

      await this.store.db.run(
        `INSERT OR REPLACE INTO group_session_members(
          conversation_id, group_id, member_key, kind, host_id, host_name, host_public_key, bot_id,
          session_id, session_title, name_snapshot, avatar_snapshot, engine_snapshot,
          joined_at, joined_after_seq, history_visibility_json, history_backfilled, active, removed_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,NULL)`,
        [
          groupId, groupId, memberKey, "remote", peer.hostId, hostNameSnapshot, peer.publicKey,
          remoteBot.botId, chosen!.sessionId, chosen!.title, remoteBot.name, remoteBot.avatar ?? null,
          remoteBot.engine || "codex", now, joinedAfterSeq, JSON.stringify(historyVisibility),
        ],
      );
      const row = await this.store.db.get<Record<string, unknown>>(
        "SELECT * FROM group_session_members WHERE conversation_id=? AND member_key=? AND session_id=?",
        [groupId, memberKey, chosen!.sessionId],
      );
      return this.mapMemberRow(row!);
    });
    return saved;
  }

  async switchMemberSession(
    userId: string,
    groupId: string,
    memberKey: string,
    rawInput: SwitchGroupMemberSessionInput | unknown,
    validate?: TransactionGuard,
  ): Promise<GroupMemberSession> {
    await this.init();
    const input = switchGroupMemberSessionInputSchema.parse(rawInput);
    const localHostName = await this.localHostNameProvider();

    const preflight = await this.store.db.serial(async () => {
      await validate?.();
      const { group, isOwner } = await this.requireMutableGroupOwnerInTransaction(userId, groupId);
      const members = await this.readMembersInTransaction(group, localHostName);
      const existing = members.find((m) => m.memberKey === memberKey);
      if (!existing) throw new HubError("group_member_not_found", 404);
      if (existing.kind === "remote" && !isOwner) throw new HubError("owner_required", 403);
      if (existing.kind === "local" && !isOwner && !(await this.store.db.get("SELECT 1 FROM bot_grants WHERE user_id=? AND bot_id=?", [userId, existing.botId]))) {
        throw new HubError("bot_forbidden", 403);
      }
      return { group, existing };
    });

    const { group, existing } = preflight;

    let remoteNextSession: GroupSessionCandidate | undefined;
    if (existing.kind === "remote") {
      const peer = await this.findPeer(existing.hostId);
      if (!peer) throw new HubError("peer_host_not_found", 404);
      if (input.createNew || !input.sessionId) {
        const title = groupAutoSessionTitle(group.title, existing.nameSnapshot);
        const createdRes = await this.callPeer(peer, "POST", "/api/group-mail/sessions", {
          botId: existing.botId,
          title,
          requestId: randomUUID(),
        });
        if (createdRes.status !== 200 || !createdRes.json || typeof createdRes.json !== "object") {
          throw new HubError("remote_session_create_failed", 502);
        }
        remoteNextSession = createdRes.json as GroupSessionCandidate;
      } else {
        const dirRes = await this.callPeer(peer, "GET", "/api/group-mail/directory");
        if (dirRes.status !== 200 || !dirRes.json || typeof dirRes.json !== "object") {
          throw new HubError("peer_host_unavailable", 503);
        }
        const dirData = dirRes.json as { bots?: GroupPeerBot[] };
        const bot = (dirData.bots ?? []).find((b) => b.botId === existing.botId);
        const found = bot?.sessions.find((s) => s.sessionId === input.sessionId);
        if (!found) throw new HubError("remote_session_not_found", 404);
        remoteNextSession = found;
      }
    }

    const committed = await this.store.db.transaction(async () => {
      await validate?.();
      const { group: latestGroup, isOwner } = await this.requireMutableGroupOwnerInTransaction(userId, groupId);
      const currentMembers = await this.readMembersInTransaction(latestGroup, localHostName);
      const current = currentMembers.find((m) => m.memberKey === memberKey);
      if (!current) throw new HubError("group_member_not_found", 404);
      if (current.kind === "remote" && !isOwner) throw new HubError("owner_required", 403);

      const createdConvs: Conversation[] = [];
      let nextSession: GroupSessionCandidate;
      if (current.kind === "local") {
        if (!isOwner && !(await this.store.db.get("SELECT 1 FROM bot_grants WHERE user_id=? AND bot_id=?", [userId, current.botId]))) {
          throw new HubError("bot_forbidden", 403);
        }
        if (input.createNew || !input.sessionId) {
          const sid = `sess_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
          const title = groupAutoSessionTitle(latestGroup.title, current.nameSnapshot);
          const created = await this.store.createConversationInTransaction(userId, [current.botId], title, sid, { type: "direct" });
          createdConvs.push(created);
          nextSession = { sessionId: created.id, title: created.title, createdAt: created.createdAt };
        } else {
          const sessions = await this.listLocalBotSessionsInTransaction(userId, current.botId);
          const found = sessions.find((s) => s.sessionId === input.sessionId);
          if (!found) throw new HubError("session_not_found", 404);
          nextSession = found;
        }
      } else {
        nextSession = remoteNextSession!;
      }

      const now = Date.now();
      const seq = await this.currentGroupMaxSeqInTransaction(groupId);
      await this.store.db.run(
        "UPDATE group_session_members SET active=0, removed_at=? WHERE conversation_id=? AND member_key=? AND active=1",
        [now, groupId, memberKey],
      );
      if (current.sessionId !== nextSession.sessionId) {
        await this.store.db.run(
          "INSERT OR REPLACE INTO group_former_sessions(conversation_id, group_id, session_id, member_key, bot_id, host_id, revoked_at) VALUES(?,?,?,?,?,?,?)",
          [groupId, groupId, current.sessionId, memberKey, current.botId, current.hostId, now],
        );
      }
      await this.store.db.run(
        `INSERT OR REPLACE INTO group_session_members(
          conversation_id, group_id, member_key, kind, host_id, host_name, host_public_key, bot_id,
          session_id, session_title, name_snapshot, avatar_snapshot, engine_snapshot,
          joined_at, joined_after_seq, history_visibility_json, history_backfilled, active, removed_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,NULL)`,
        [
          groupId, groupId, memberKey, current.kind, current.hostId, current.hostName, current.hostPublicKey ?? null,
          current.botId, nextSession.sessionId, nextSession.title, current.nameSnapshot, current.avatarSnapshot ?? null,
          current.engineSnapshot, now, seq, JSON.stringify(current.historyVisibility),
        ],
      );
      const saved = await this.store.db.get<Record<string, unknown>>(
        "SELECT * FROM group_session_members WHERE conversation_id=? AND member_key=? AND session_id=?",
        [groupId, memberKey, nextSession.sessionId],
      );
      return { member: this.mapMemberRow(saved!), createdConvs };
    });

    if (committed.createdConvs.length) this.onConversationsChanged?.(userId, committed.createdConvs);
    return committed.member;
  }

  async removeMember(
    userId: string,
    groupId: string,
    memberKey: string,
    validate?: TransactionGuard,
  ): Promise<{ removed: GroupFormerSession }> {
    await this.init();
    const localHostName = await this.localHostNameProvider();

    const committed = await this.store.db.transaction(async () => {
      await validate?.();
      const { group } = await this.requireMutableGroupOwnerInTransaction(userId, groupId);
      const currentMembers = await this.readMembersInTransaction(group, localHostName);
      const existing = currentMembers.find((m) => m.memberKey === memberKey);
      if (!existing) throw new HubError("group_member_not_found", 404);

      if (currentMembers.length <= 1) {
        throw new HubError("bots_required", 400);
      }

      if (existing.kind === "local") {
        const remainingLocalBots = group.botIds.filter((id) => id !== existing.botId);
        if (remainingLocalBots.length === 0) {
          throw new HubError("bots_required", 400);
        }
        const activeDiscussion = await this.store.db.get<{ participants_json: string }>(
          "SELECT participants_json FROM group_discussions WHERE group_id=? AND status IN ('running','pausing','paused','ending')",
          [groupId],
        );
        if (activeDiscussion) {
          const participants = z.array(z.object({ botId: z.string() }).passthrough()).parse(JSON.parse(activeDiscussion.participants_json));
          if (participants.some((p) => p.botId === existing.botId)) {
            throw new HubError("group_discussion_active", 409);
          }
        }
        const convRows = await this.store.db.all<{ id: string }>("SELECT id FROM conversations WHERE id=? OR parent_id=?", [groupId, groupId]);
        for (const row of convRows) {
          const busy = await this.store.db.get(
            `SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=? AND d.bot_id=? AND d.status='pending'
             UNION ALL SELECT 1 FROM action_deliveries WHERE conversation_id=? AND bot_id=? AND status='pending'
             UNION ALL SELECT 1 FROM messages WHERE conversation_id=? AND author_type='bot' AND author_id=? AND status IN ('pending','streaming')
             LIMIT 1`,
            [row.id, existing.botId, row.id, existing.botId, row.id, existing.botId],
          );
          if (busy) throw new HubError("group_bot_busy", 409);
        }
      }

      const now = Date.now();
      const activeRows = await this.store.db.all<{ conversation_id: string; session_id: string }>(
        "SELECT conversation_id, session_id FROM group_session_members WHERE group_id=? AND member_key=? AND active=1",
        [groupId, memberKey],
      );
      await this.store.db.run(
        "UPDATE group_session_members SET active=0, removed_at=? WHERE group_id=? AND member_key=? AND active=1",
        [now, groupId, memberKey],
      );
      if (activeRows.length) {
        for (const row of activeRows) {
          await this.store.db.run(
            "INSERT OR REPLACE INTO group_former_sessions(conversation_id, group_id, session_id, member_key, bot_id, host_id, revoked_at) VALUES(?,?,?,?,?,?,?)",
            [row.conversation_id, groupId, row.session_id, memberKey, existing.botId, existing.hostId, now],
          );
        }
      } else {
        await this.store.db.run(
          "INSERT OR REPLACE INTO group_former_sessions(conversation_id, group_id, session_id, member_key, bot_id, host_id, revoked_at) VALUES(?,?,?,?,?,?,?)",
          [groupId, groupId, existing.sessionId, memberKey, existing.botId, existing.hostId, now],
        );
      }
      await this.store.db.run(
        "DELETE FROM group_designated_member WHERE group_id=? AND member_key=?",
        [groupId, memberKey],
      );

      const updatedConvs: Conversation[] = [];
      let settingsEvent: HubEvent | undefined;
      if (existing.kind === "local") {
        const convRows = await this.store.db.all<{ id: string }>("SELECT id FROM conversations WHERE id=? OR parent_id=?", [groupId, groupId]);
        for (const row of convRows) {
          await this.store.db.run(
            "DELETE FROM conversation_members WHERE conversation_id=? AND member_type='bot' AND member_id=?",
            [row.id, existing.botId],
          );
          updatedConvs.push(await this.store.conversationInTransaction(row.id));
        }
        settingsEvent = await this.store.groupSettingsEventInTransaction(groupId);
      }

      return {
        removed: {
          sessionId: existing.sessionId,
          memberKey,
          botId: existing.botId,
          hostId: existing.hostId,
          revokedAt: now,
        },
        updatedConvs,
        settingsEvent,
      };
    });

    if (committed.updatedConvs.length) this.onConversationsChanged?.(userId, committed.updatedConvs);
    if (committed.settingsEvent) this.store.emitCommitted([committed.settingsEvent]);
    return { removed: committed.removed };
  }

  /** Checks whether a session currently has access to new messages in a group/room. Former sessions return false. */
  async canSessionAccessGroup(conversationId: string, sessionId: string): Promise<boolean> {
    await this.init();
    return this.store.db.serial(async () => {
      const active = await this.store.db.get<{ session_id: string }>(
        "SELECT session_id FROM group_session_members WHERE conversation_id=? AND session_id=? AND active=1",
        [conversationId, sessionId],
      );
      return !!active;
    });
  }

  /** Resolves local Bot session binding + join-time history visibility for HubServer.dispatchBot, enforcing canSessionAccessGroup. */
  async localDispatchBinding(
    botId: string,
    message: Message,
    conversation: Conversation,
  ): Promise<{ blocked: true } | { blocked: false; groupSession?: GroupLocalSessionDispatch; historyIncluded?: { scopeConversationId: string; memberKey: string; sessionId: string } }> {
    if (conversation.type !== "group" || message.groupDiscussion || message.botSource) {
      return { blocked: false };
    }
    await this.init();
    return this.store.db.serial(async () => {
      const memberKey = makeGroupMemberKey("local", "local", botId);
      const hasRoomRows = conversation.parentId
        ? !!(await this.store.db.get("SELECT 1 FROM group_session_members WHERE conversation_id=? LIMIT 1", [conversation.id]))
        : true;
      const scopeConvId = hasRoomRows ? conversation.id : conversation.parentId!;
      const row = await this.store.db.get<Record<string, unknown>>(
        "SELECT * FROM group_session_members WHERE conversation_id=? AND member_key=? AND active=1",
        [scopeConvId, memberKey],
      );
      if (!row) {
        const former = await this.store.db.get<{ session_id: string }>(
          "SELECT session_id FROM group_former_sessions WHERE conversation_id=? AND member_key=? LIMIT 1",
          [scopeConvId, memberKey],
        );
        if (former) return { blocked: true };
        return { blocked: false };
      }
      const member = this.mapMemberRow(row);
      const sessionConv = await this.store.db.get<{ workspace_path: string | null }>(
        "SELECT workspace_path FROM conversations WHERE id=?",
        [member.sessionId],
      );
      const sessionWorkspacePath = sessionConv?.workspace_path?.trim() || undefined;
      const historyBackfilled = Boolean(row.history_backfilled);
      let contextMessages: Array<{ seq: number; authorName: string; text: string; createdAt: number }> = [];
      if (!historyBackfilled && member.historyVisibility.kind !== "none") {
        contextMessages = await this.visibleHistoryInTransaction(message.authorId, conversation.id, member, message.id);
      }
      return {
        blocked: false,
        groupSession: {
          sessionId: member.sessionId,
          sessionTitle: member.sessionTitle,
          groupTitle: conversation.title,
          ...(sessionWorkspacePath ? { workspacePath: sessionWorkspacePath } : {}),
          ...(contextMessages.length ? { contextMessages } : {}),
        },
        ...(!historyBackfilled && member.historyVisibility.kind !== "none"
          ? { historyIncluded: { scopeConversationId: scopeConvId, memberKey, sessionId: member.sessionId } }
          : {}),
      };
    });
  }

  async markLocalHistoryBackfilled(scopeConversationId: string, memberKey: string, sessionId: string): Promise<void> {
    await this.init();
    await this.store.db.serial(() =>
      this.store.db.run(
        "UPDATE group_session_members SET history_backfilled=1 WHERE conversation_id=? AND member_key=? AND session_id=?",
        [scopeConversationId, memberKey, sessionId],
      ),
    );
  }

  async setDesignatedMember(
    userId: string,
    groupId: string,
    rawInput: unknown,
    validate?: TransactionGuard,
  ): Promise<{ designatedMemberKey: string | null }> {
    await this.init();
    const input = setDesignatedMemberInputSchema.parse(rawInput);
    const localHostName = await this.localHostNameProvider();
    const committed = await this.store.db.transaction(async () => {
      await validate?.();
      const { group } = await this.requireMutableGroupOwnerInTransaction(userId, groupId);
      if (input.memberKey === null) {
        await this.store.db.run("DELETE FROM group_designated_member WHERE group_id=?", [groupId]);
        const settingsEvent = await this.store.groupSettingsEventInTransaction(groupId);
        return { designatedMemberKey: null, settingsEvent };
      }
      const members = await this.readMembersInTransaction(group, localHostName);
      if (!members.some((m) => m.memberKey === input.memberKey)) {
        throw new HubError("group_member_not_found", 404);
      }
      await this.store.db.run(
        "INSERT INTO group_designated_member(group_id, member_key) VALUES(?,?) ON CONFLICT(group_id) DO UPDATE SET member_key=excluded.member_key",
        [groupId, input.memberKey],
      );
      const settingsEvent = await this.store.groupSettingsEventInTransaction(groupId);
      return { designatedMemberKey: input.memberKey, settingsEvent };
    });
    this.store.emitCommitted([committed.settingsEvent]);
    return { designatedMemberKey: committed.designatedMemberKey };
  }

  /** Creates a new room/topic inside the group where every active member gets its own fresh room-scoped session WITHOUT revoking root group or sibling rooms. */
  async createRoom(
    userId: string,
    groupId: string,
    rawInput: CreateGroupRoomInput | unknown = {},
    validate?: TransactionGuard,
  ): Promise<{
    room: Conversation;
    memberSessions: Array<{ memberKey: string; sessionId: string; sessionTitle: string }>;
  }> {
    await this.init();
    const input = createGroupRoomInputSchema.parse(rawInput);
    const localHostName = await this.localHostNameProvider();

    // Phase 1: Validate and snapshot root group active members inside DB serial.
    const preflight = await this.store.db.serial(async () => {
      await validate?.();
      const { group } = await this.requireMutableGroupOwnerInTransaction(userId, groupId);
      if (!group.botIds.length) throw new HubError("bots_required", 400);
      const members = await this.readMembersInTransaction(group, localHostName);
      if (!members.length) throw new HubError("bots_required", 400);
      return { group, members };
    });

    const roomTitle = input.title ?? `${preflight.group.title} · Room ${new Date().toISOString().slice(11, 16)}`;

    // Phase 2: Allocate fresh remote sessions BEFORE creating the room in SQLite so partial remote failure leaves zero orphaned rooms!
    const remoteAllocated = new Map<string, GroupSessionCandidate>();
    for (const member of preflight.members) {
      if (member.kind !== "remote") continue;
      const peer = await this.findPeer(member.hostId);
      if (!peer) throw new HubError("peer_host_offline", 503);
      const sessionTitle = groupAutoSessionTitle(roomTitle, member.nameSnapshot);
      const createdRes = await this.callPeer(peer, "POST", "/api/group-mail/sessions", {
        botId: member.botId,
        title: sessionTitle,
        requestId: randomUUID(),
      }).catch(() => {
        throw new HubError("peer_host_offline", 503);
      });
      if (createdRes.status !== 200 || !createdRes.json || typeof createdRes.json !== "object") {
        throw new HubError("remote_session_create_failed", 502);
      }
      remoteAllocated.set(member.memberKey, createdRes.json as GroupSessionCandidate);
    }

    // Phase 3: Create the room, local sessions, and room-scoped group_session_members atomically in one SQLite transaction.
    const committed = await this.store.db.transaction(async () => {
      await validate?.();
      const { group } = await this.requireMutableGroupOwnerInTransaction(userId, groupId);
      if (!group.botIds.length) throw new HubError("bots_required", 400);
      const currentMembers = await this.readMembersInTransaction(group, localHostName);
      const room = await this.store.createConversationInTransaction(
        userId,
        group.botIds,
        roomTitle,
        `room_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        { parentId: groupId },
      );
      const createdConvs: Conversation[] = [room];
      const memberSessions: Array<{ memberKey: string; sessionId: string; sessionTitle: string }> = [];
      const now = Date.now();

      for (const member of currentMembers) {
        let nextSession: GroupSessionCandidate;
        if (member.kind === "local") {
          const sid = `sess_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
          const sessionTitle = groupAutoSessionTitle(roomTitle, member.nameSnapshot);
          const created = await this.store.createConversationInTransaction(userId, [member.botId], sessionTitle, sid, { type: "direct" });
          createdConvs.push(created);
          nextSession = { sessionId: created.id, title: created.title, createdAt: created.createdAt };
        } else {
          const allocated = remoteAllocated.get(member.memberKey);
          if (!allocated) throw new HubError("group_member_changed", 409);
          nextSession = allocated;
        }
        await this.store.db.run(
          `INSERT INTO group_session_members(
            conversation_id, group_id, member_key, kind, host_id, host_name, host_public_key, bot_id,
            session_id, session_title, name_snapshot, avatar_snapshot, engine_snapshot,
            joined_at, joined_after_seq, history_visibility_json, history_backfilled, active, removed_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,NULL)`,
          [
            room.id, groupId, member.memberKey, member.kind, member.hostId, member.hostName, member.hostPublicKey ?? null,
            member.botId, nextSession.sessionId, nextSession.title, member.nameSnapshot, member.avatarSnapshot ?? null,
            member.engineSnapshot, now, 0, JSON.stringify({ kind: "none" } satisfies GroupHistoryVisibility),
          ],
        );
        memberSessions.push({ memberKey: member.memberKey, sessionId: nextSession.sessionId, sessionTitle: nextSession.title });
      }
      return { room, memberSessions, createdConvs };
    });

    this.onConversationsChanged?.(userId, committed.createdConvs);
    return { room: committed.room, memberSessions: committed.memberSessions };
  }

  /** Caller holds store.db.serial / transaction.
   * Excludes sourceMessageId, user message_deletions, scheduler discussion inputs, and sealed blind discussion replies,
   * and respects member.joinedAfterSeq so join-time history never leaks post-join or current prompts. */
  private async visibleHistoryInTransaction(
    userId: string,
    conversationId: string,
    member: GroupMemberSession,
    sourceMessageId: string,
  ): Promise<Array<{ seq: number; authorName: string; text: string; createdAt: number }>> {
    if (member.historyVisibility.kind === "none") return [];
    if (member.joinedAfterSeq <= 0) return [];
    const limit = member.historyVisibility.kind === "recent" ? member.historyVisibility.count : 200;
    const rows = await this.store.db.all<{
      id: string;
      author_id: string;
      author_type: string;
      blocks_json: string;
      bot_source_json: string | null;
      created_at: number;
      event_seq: number;
    }>(
      `SELECT m.id, m.author_id, m.author_type, m.blocks_json, m.bot_source_json, m.created_at, e.seq AS event_seq
       FROM messages m
       JOIN events e ON e.conversation_id = m.conversation_id AND e.kind = 'message.created' AND json_extract(e.payload_json, '$.id') = m.id
       WHERE m.conversation_id = ?
         AND m.status = 'complete'
         AND m.id != ?
         AND e.seq <= ?
         AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = ?)
         AND NOT EXISTS (SELECT 1 FROM group_discussion_turns t WHERE t.input_message_id = m.id)
         AND NOT EXISTS (
           SELECT 1 FROM group_discussion_turns t
           JOIN group_discussions gd ON gd.id = t.discussion_id
           WHERE t.input_message_id = m.reply_to AND t.bot_id = m.author_id AND t.blind = 1
             AND gd.stage = 'blind' AND gd.status IN ('running','pausing','paused','ending')
             AND m.author_type = 'bot'
         )
       ORDER BY e.seq DESC LIMIT ?`,
      [conversationId, sourceMessageId, member.joinedAfterSeq, userId, limit],
    );

    const results: Array<{ seq: number; authorName: string; text: string; createdAt: number }> = [];
    for (const row of rows.reverse()) {
      let authorName: string;
      if (row.author_type === "user") {
        const u = await this.store.db.get<{ name: string }>("SELECT name FROM users WHERE id=?", [row.author_id]);
        authorName = u?.name || "User";
      } else if (row.bot_source_json) {
        try {
          const src = JSON.parse(row.bot_source_json) as BotSource;
          authorName = src.botName || row.author_id;
        } catch {
          authorName = row.author_id;
        }
      } else {
        const b = await this.store.db.get<{ name: string }>("SELECT name FROM bots WHERE id=?", [row.author_id]);
        authorName = b?.name || row.author_id;
      }
      const text = blocksText(JSON.parse(row.blocks_json) as Block[]).slice(0, 4000);
      if (!text.trim()) continue;
      results.push({
        seq: row.event_seq,
        authorName,
        text,
        createdAt: row.created_at,
      });
    }
    return results;
  }

  /** Delivers durable `sending` questions created atomically by HubStore.sendMessageInTransaction. */
  async deliverQueuedQuestions(dispatch: RemoteGroupDispatch): Promise<RemoteGroupQuestion[]> {
    await this.init();
    const results: RemoteGroupQuestion[] = [];
    for (const qid of dispatch.questionIds) {
      const delivered = await this.deliverQuestionById(dispatch.userId, qid);
      if (delivered) results.push(delivered);
    }
    return results;
  }

  /** Re-delivers persisted `sending` cross-host questions interrupted across Host restarts or missed listeners.
   * Checks peer `/status` first and relies on target-side `request_id` idempotency so restarts never double-deliver. */
  async recoverPendingQuestions(options?: { includeRecent?: boolean }): Promise<RemoteGroupQuestion[]> {
    await this.init();
    return this.recoverPendingQuestionsInternal(options);
  }

  private async recoverPendingQuestionsInternal(options?: { includeRecent?: boolean }): Promise<RemoteGroupQuestion[]> {
    if (this.recoveringQuestions || this.stoppingProvider()) return [];
    this.recoveringQuestions = true;
    try {
      const includeRecent = options?.includeRecent === true;
      const rows = await this.store.db.serial(() =>
        includeRecent
          ? this.store.db.all<{ id: string }>(
              "SELECT id FROM group_remote_questions WHERE status='sending' AND answer_message_id IS NULL ORDER BY created_at ASC LIMIT 32",
            )
          : this.store.db.all<{ id: string }>(
              "SELECT id FROM group_remote_questions WHERE status='sending' AND answer_message_id IS NULL AND updated_at <= ? ORDER BY created_at ASC LIMIT 32",
              [Date.now() - SENDING_SWEEP_GRACE_MS],
            ),
      );
      const results: RemoteGroupQuestion[] = [];
      for (const row of rows) {
        if (this.stoppingProvider()) break;
        if (this.inFlightDeliveries.has(row.id)) continue;
        const delivered = await this.deliverQuestionById(undefined, row.id, { reconcileFirst: true }).catch(() => undefined);
        if (delivered) results.push(delivered);
      }
      return results;
    } finally {
      this.recoveringQuestions = false;
    }
  }

  private deliverQuestionById(
    userId: string | undefined,
    questionId: string,
    options?: { reconcileFirst?: boolean },
  ): Promise<RemoteGroupQuestion | undefined> {
    const existing = this.inFlightDeliveries.get(questionId);
    if (existing) return existing;
    const task = this.deliverQuestionByIdInner(userId, questionId, options).finally(() => {
      if (this.inFlightDeliveries.get(questionId) === task) this.inFlightDeliveries.delete(questionId);
    });
    this.inFlightDeliveries.set(questionId, task);
    return task;
  }

  private async deliverQuestionByIdInner(
    userId: string | undefined,
    questionId: string,
    options?: { reconcileFirst?: boolean },
  ): Promise<RemoteGroupQuestion | undefined> {
    const localHostName = await this.localHostNameProvider();
    const reconcileFirst = options?.reconcileFirst === true;

    const prepared = await this.store.db.serial(async () => {
      const qRow = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [questionId]);
      if (!qRow) return undefined;
      const question = this.mapQuestionRow(qRow);
      if (question.status === "delivered" || question.answerMessageId) {
        return { done: question as RemoteGroupQuestion };
      }
      if (reconcileFirst && question.status !== "sending") {
        return { done: question as RemoteGroupQuestion };
      }
      let group: Conversation;
      try {
        group = await this.store.conversationInTransaction(question.groupId);
      } catch {
        return undefined;
      }
      const hasRoomRows = question.conversationId !== question.groupId
        ? !!(await this.store.db.get("SELECT 1 FROM group_session_members WHERE conversation_id=? LIMIT 1", [question.conversationId]))
        : true;
      const scopeConvId = hasRoomRows ? question.conversationId : question.groupId;
      const memberRow = await this.store.db.get<Record<string, unknown>>(
        "SELECT * FROM group_session_members WHERE conversation_id=? AND member_key=? AND session_id=? AND active=1",
        [scopeConvId, question.memberKey, question.sessionId],
      );
      const member = memberRow ? this.mapMemberRow(memberRow) : undefined;
      if (!member && !reconcileFirst) {
        return { revoked: question };
      }
      const historyBackfilled = memberRow ? Boolean(memberRow.history_backfilled) : true;
      const sourceRow = await this.store.db.get<{ author_id: string; blocks_json: string }>(
        "SELECT author_id, blocks_json FROM messages WHERE id=?",
        [question.sourceMessageId],
      );
      const effectiveUserId = userId ?? sourceRow?.author_id ?? group.ownerId;
      const text = sourceRow ? blocksText(JSON.parse(sourceRow.blocks_json) as Block[]) : "";
      const contextMessages = member && !historyBackfilled && member.historyVisibility.kind !== "none"
        ? await this.visibleHistoryInTransaction(effectiveUserId, question.conversationId, member, question.sourceMessageId)
        : [];
      return {
        question,
        groupTitle: group.title,
        scopeConvId,
        member,
        text,
        contextMessages,
        shouldMarkBackfilled: !!member && !historyBackfilled && member.historyVisibility.kind !== "none",
      };
    });

    if (!prepared) return undefined;
    if ("done" in prepared && prepared.done) return prepared.done;
    if ("revoked" in prepared && prepared.revoked) {
      const updated = await this.store.db.serial(async () => {
        await this.store.db.run(
          "UPDATE group_remote_questions SET status='failed', error='group_session_revoked', updated_at=? WHERE id=? AND answer_message_id IS NULL",
          [Date.now(), questionId],
        );
        const row = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [questionId]);
        return row ? this.mapQuestionRow(row) : undefined;
      });
      return updated;
    }

    const { question, groupTitle, scopeConvId, member, text, contextMessages, shouldMarkBackfilled } = prepared;
    const hostId = member?.hostId ?? question.hostId;
    const hostName = member?.hostName ?? question.hostName;
    const peer = await this.findPeer(hostId);
    if (!peer) {
      const errorText = member ? `${hostName} is offline; message kept without loss` : "group_session_revoked";
      return this.store.db.serial(async () => {
        await this.store.db.run(
          "UPDATE group_remote_questions SET status='failed', error=?, updated_at=? WHERE id=? AND answer_message_id IS NULL",
          [errorText, Date.now(), question.id],
        );
        const row = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [question.id]);
        return this.mapQuestionRow(row!);
      });
    }

    if (reconcileFirst) {
      try {
        const statusRes = await this.callPeer(peer, "GET", `/api/group-mail/status/${encodeURIComponent(question.requestId)}`);
        if (statusRes.status === 200 && statusRes.json && typeof statusRes.json === "object") {
          const info = statusRes.json as { found?: boolean; status?: string; replyText?: string };
          if (info.found) {
            await this.store.db.transaction(async () => {
              await this.store.db.run(
                "UPDATE group_remote_questions SET status='delivered', error=NULL, updated_at=? WHERE id=? AND answer_message_id IS NULL",
                [Date.now(), question.id],
              );
              if (shouldMarkBackfilled && member) {
                await this.store.db.run(
                  "UPDATE group_session_members SET history_backfilled=1 WHERE conversation_id=? AND member_key=? AND session_id=?",
                  [scopeConvId, member.memberKey, member.sessionId],
                );
              }
            });
            if (info.status === "answered" && typeof info.replyText === "string" && !question.answerMessageId) {
              await this.handlePeerReply(peer, {
                requestId: question.requestId,
                groupId: question.groupId,
                conversationId: question.conversationId,
                botId: question.botId,
                sessionId: question.sessionId,
                text: info.replyText,
              }).catch(() => undefined);
            }
            return this.store.db.serial(async () => {
              const row = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [question.id]);
              return row ? this.mapQuestionRow(row) : undefined;
            });
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const causeCode = String((error as { cause?: { code?: string } } | null)?.cause?.code ?? "");
        const isDefiniteRefused = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|peer_host_offline/i.test(`${msg} ${causeCode}`);
        const nextStatus: RemoteGroupQuestionStatus = isDefiniteRefused ? "failed" : "uncertain";
        const errorText = isDefiniteRefused ? `${hostName} is offline; message kept without loss` : `uncertain_delivery: ${msg}`;
        return this.store.db.serial(async () => {
          await this.store.db.run(
            "UPDATE group_remote_questions SET status=?, error=?, updated_at=? WHERE id=? AND answer_message_id IS NULL",
            [nextStatus, errorText, Date.now(), question.id],
          );
          const row = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [question.id]);
          return row ? this.mapQuestionRow(row) : undefined;
        });
      }
    }

    if (!member) {
      return this.store.db.serial(async () => {
        await this.store.db.run(
          "UPDATE group_remote_questions SET status='failed', error='group_session_revoked', updated_at=? WHERE id=? AND answer_message_id IS NULL",
          [Date.now(), question.id],
        );
        const row = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [question.id]);
        return row ? this.mapQuestionRow(row) : undefined;
      });
    }

    const callbackUrl = this.safeLocalUrl();
    const payload: GroupMailDeliver = {
      requestId: question.requestId,
      groupId: question.groupId,
      groupTitle,
      conversationId: question.conversationId,
      sourceHostId: "origin",
      sourceHostName: localHostName,
      sourceMessageId: question.sourceMessageId,
      botId: member.botId,
      sessionId: member.sessionId,
      text,
      contextMessages,
      ...(callbackUrl ? { callbackUrl } : {}),
    };

    let nextStatus: RemoteGroupQuestionStatus = "delivered";
    let errorText: string | null = null;
    try {
      const res = await this.callPeer(peer, "POST", "/api/group-mail/deliver", payload);
      if (res.status === 200) {
        nextStatus = "delivered";
        errorText = null;
      } else if (res.status >= 400 && res.status < 500) {
        nextStatus = "failed";
        errorText = (res.json as { error?: string } | undefined)?.error ?? `http_${res.status}`;
      } else {
        nextStatus = "uncertain";
        errorText = `http_${res.status}`;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const causeCode = String((error as { cause?: { code?: string } } | null)?.cause?.code ?? "");
      const isDefiniteRefused = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|peer_host_offline/i.test(`${msg} ${causeCode}`);
      nextStatus = isDefiniteRefused ? "failed" : "uncertain";
      errorText = isDefiniteRefused ? `${member.hostName} is offline; message kept without loss` : `uncertain_delivery: ${msg}`;
    }

    return this.store.db.transaction(async () => {
      await this.store.db.run(
        "UPDATE group_remote_questions SET status=?, error=?, updated_at=? WHERE id=? AND answer_message_id IS NULL",
        [nextStatus, errorText, Date.now(), question.id],
      );
      if (nextStatus === "delivered" && shouldMarkBackfilled) {
        await this.store.db.run(
          "UPDATE group_session_members SET history_backfilled=1 WHERE conversation_id=? AND member_key=? AND session_id=?",
          [scopeConvId, member.memberKey, member.sessionId],
        );
      }
      const finalRow = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [question.id]);
      return this.mapQuestionRow(finalRow!);
    });
  }

  /** Sends a group question to one or all active remote members with explicit 4-state tracking
   * (`sending`, `delivered`, `failed`, `uncertain`) and zero message loss when offline. Idempotent per (conversation, member, sourceMessage). */
  async sendToRemoteMembers(
    userId: string,
    groupId: string,
    conversationId: string,
    sourceMessage: Message,
    options?: { targetMemberKeys?: string[] },
  ): Promise<RemoteGroupQuestion[]> {
    await this.init();
    const questionIds = await this.store.db.transaction(async () => {
      await this.store.requireMember(userId, groupId);
      const hasRoomRows = conversationId !== groupId
        ? !!(await this.store.db.get("SELECT 1 FROM group_session_members WHERE conversation_id=? LIMIT 1", [conversationId]))
        : true;
      const scopeConvId = hasRoomRows ? conversationId : groupId;
      const memberRows = await this.store.db.all<Record<string, unknown>>(
        "SELECT * FROM group_session_members WHERE conversation_id=? AND kind='remote' AND active=1 ORDER BY joined_at ASC",
        [scopeConvId],
      );
      const targets = memberRows
        .map((r) => this.mapMemberRow(r))
        .filter((m) => !options?.targetMemberKeys || options.targetMemberKeys.includes(m.memberKey));

      const ids: string[] = [];
      const now = Date.now();
      for (const member of targets) {
        const existing = await this.store.db.get<{ id: string }>(
          "SELECT id FROM group_remote_questions WHERE conversation_id=? AND member_key=? AND source_message_id=?",
          [conversationId, member.memberKey, sourceMessage.id],
        );
        if (existing) {
          ids.push(existing.id);
          continue;
        }
        const qid = `gq_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const requestId = `greq_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        await this.store.db.run(
          `INSERT INTO group_remote_questions(
            id, group_id, conversation_id, member_key, host_id, host_name, host_public_key, bot_id, session_id,
            bot_name_snapshot, source_message_id, request_id, status, stopped_unanswered, error, created_at, updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'sending',0,NULL,?,?)`,
          [
            qid, groupId, conversationId, member.memberKey, member.hostId, member.hostName, member.hostPublicKey ?? null,
            member.botId, member.sessionId, member.nameSnapshot, sourceMessage.id, requestId, now, now,
          ],
        );
        ids.push(qid);
      }
      return ids;
    });

    const results: RemoteGroupQuestion[] = [];
    for (const qid of questionIds) {
      const delivered = await this.deliverQuestionById(userId, qid);
      if (delivered) results.push(delivered);
    }
    return results;
  }

  /** Reconciles or retries a `failed` or `uncertain` cross-host question (preserving join-time history on first-question retry!). */
  async reconcileOrRetryQuestion(
    userId: string,
    groupId: string,
    questionId: string,
    validate?: TransactionGuard,
  ): Promise<RemoteGroupQuestion> {
    await this.init();
    const localHostName = await this.localHostNameProvider();

    const preflight = await this.store.db.serial(async () => {
      await validate?.();
      await this.store.requireMember(userId, groupId);
      const group = await this.store.conversationInTransaction(groupId);
      if (group.type !== "group" || group.parentId) throw new HubError("group_required", 400);
      if (group.archived) throw new HubError("conversation_archived", 409);

      const row = await this.store.db.get<Record<string, unknown>>(
        "SELECT * FROM group_remote_questions WHERE id=? AND group_id=?",
        [questionId, groupId],
      );
      if (!row) throw new HubError("group_question_not_found", 404);
      const q = this.mapQuestionRow(row);

      const hasRoomRows = q.conversationId !== q.groupId
        ? !!(await this.store.db.get("SELECT 1 FROM group_session_members WHERE conversation_id=? LIMIT 1", [q.conversationId]))
        : true;
      const scopeConvId = hasRoomRows ? q.conversationId : q.groupId;
      const memberRow = await this.store.db.get<Record<string, unknown>>(
        "SELECT * FROM group_session_members WHERE conversation_id=? AND member_key=? AND session_id=? AND active=1",
        [scopeConvId, q.memberKey, q.sessionId],
      );
      const member = memberRow ? this.mapMemberRow(memberRow) : undefined;
      const historyBackfilled = memberRow ? Boolean(memberRow.history_backfilled) : true;

      const sourceRow = await this.store.db.get<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE id=?", [q.sourceMessageId]);
      const text = sourceRow ? blocksText(JSON.parse(sourceRow.blocks_json) as Block[]) : "";
      const contextMessages = member && !historyBackfilled && member.historyVisibility.kind !== "none"
        ? await this.visibleHistoryInTransaction(userId, q.conversationId, member, q.sourceMessageId)
        : [];

      return {
        group,
        q,
        scopeConvId,
        member,
        text,
        contextMessages,
        shouldMarkBackfilled: !!member && !historyBackfilled && member.historyVisibility.kind !== "none",
      };
    });

    const { group, q, scopeConvId, member, text, contextMessages, shouldMarkBackfilled } = preflight;
    const peer = await this.findPeer(q.hostId);
    if (!peer) throw new HubError("peer_host_offline", 503);

    // 1. Check remote status by idempotent requestId first (recovery without double-sending!).
    const statusRes = await this.callPeer(peer, "GET", `/api/group-mail/status/${encodeURIComponent(q.requestId)}`);
    if (statusRes.status === 200 && statusRes.json && typeof statusRes.json === "object") {
      const info = statusRes.json as { found?: boolean; status?: string; replyText?: string };
      if (info.found) {
        await this.store.db.transaction(async () => {
          await validate?.();
          await this.store.db.run(
            "UPDATE group_remote_questions SET status='delivered', error=NULL, updated_at=? WHERE id=?",
            [Date.now(), q.id],
          );
          if (shouldMarkBackfilled && member) {
            await this.store.db.run(
              "UPDATE group_session_members SET history_backfilled=1 WHERE conversation_id=? AND member_key=? AND session_id=?",
              [scopeConvId, member.memberKey, member.sessionId],
            );
          }
        });
        if (info.status === "answered" && typeof info.replyText === "string" && !q.answerMessageId) {
          await this.handlePeerReply(peer, {
            requestId: q.requestId,
            groupId: q.groupId,
            conversationId: q.conversationId,
            botId: q.botId,
            sessionId: q.sessionId,
            text: info.replyText,
          });
        }
        return this.store.db.serial(async () => {
          const updated = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [q.id]);
          return this.mapQuestionRow(updated!);
        });
      }
    }

    // 2. Not found on remote -> verify session still has active access before re-delivering!
    if (!member) {
      throw new HubError("group_session_revoked", 409);
    }

    const callbackUrl = this.safeLocalUrl();
    const res = await this.callPeer(peer, "POST", "/api/group-mail/deliver", {
      requestId: q.requestId,
      groupId: q.groupId,
      groupTitle: group.title,
      conversationId: q.conversationId,
      sourceHostId: "origin",
      sourceHostName: localHostName,
      sourceMessageId: q.sourceMessageId,
      botId: q.botId,
      sessionId: q.sessionId,
      text,
      contextMessages,
      ...(callbackUrl ? { callbackUrl } : {}),
    } satisfies GroupMailDeliver);

    return this.store.db.transaction(async () => {
      await validate?.();
      if (res.status === 200) {
        await this.store.db.run(
          "UPDATE group_remote_questions SET status='delivered', error=NULL, updated_at=? WHERE id=?",
          [Date.now(), q.id],
        );
        if (shouldMarkBackfilled) {
          await this.store.db.run(
            "UPDATE group_session_members SET history_backfilled=1 WHERE conversation_id=? AND member_key=? AND session_id=?",
            [scopeConvId, member.memberKey, member.sessionId],
          );
        }
      } else {
        const reason = (res.json as { error?: string } | undefined)?.error ?? `http_${res.status}`;
        await this.store.db.run(
          "UPDATE group_remote_questions SET status='failed', error=?, updated_at=? WHERE id=?",
          [reason, Date.now(), q.id],
        );
      }
      const updated = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [q.id]);
      return this.mapQuestionRow(updated!);
    });
  }

  /** Stops the whole group: cancels active discussions, halts active local work, and marks ONLY currently unanswered remote questions (`stoppedUnanswered: true`), while still letting late remote answers land. */
  async stopGroup(
    userId: string,
    groupId: string,
    validate?: TransactionGuard,
  ): Promise<{ stoppedUnansweredCount: number; questions: RemoteGroupQuestion[] }> {
    await this.init();
    await this.store.db.serial(async () => {
      await validate?.();
      await this.store.requireMember(userId, groupId);
      const group = await this.store.conversationInTransaction(groupId);
      if (group.type !== "group" || group.parentId) throw new HubError("group_required", 400);
      if (group.archived) throw new HubError("conversation_archived", 409);
    });

    if (this.onGroupStopLocal) await this.onGroupStopLocal(groupId, userId);

    return this.store.db.transaction(async () => {
      await validate?.();
      const now = Date.now();
      await this.store.db.run(
        "UPDATE group_remote_questions SET stopped_unanswered=1, updated_at=? WHERE group_id=? AND answer_message_id IS NULL",
        [now, groupId],
      );
      const rows = await this.store.db.all<Record<string, unknown>>(
        "SELECT * FROM group_remote_questions WHERE group_id=? AND stopped_unanswered=1 AND answer_message_id IS NULL ORDER BY created_at DESC",
        [groupId],
      );
      return {
        stoppedUnansweredCount: rows.length,
        questions: rows.map((r) => this.mapQuestionRow(r)),
      };
    });
  }
}
