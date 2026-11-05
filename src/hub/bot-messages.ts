import { createHash, randomUUID, verify } from "node:crypto";
import { open } from "node:fs/promises";
import { z } from "zod";
import { CHUNK_BYTES, idSchema, textSchema, uploadSchema, blocksText, type Block, type Conversation } from "../client-protocol/index.js";
import { BOT_PASSPORT_TTL_MS, BOT_PASSPORT_CLOCK_SKEW_MS, TargetResolutionError, botLocalRequestSchema, botMessageTargetSchema, botPassportProof, botSourceSchema, isBotControl, resolveBotTarget, signedBotPassportSchema, type BotPassport, type BotSource, type BotMessageTarget, type SignedBotPassport } from "../client-protocol/bot-messages.js";
import { networkCanonical, type NetworkHost } from "../client-protocol/private-network.js";
import { isRunActive, runSummarySchema } from "../client-protocol/run.js";
import { hashSecret, parsePublicKey, type HubAuth } from "./auth.js";
import { HubError, type HubStore } from "./store.js";
import type { HubAttachments } from "./attachments.js";
import type { PrivateNetwork } from "./private-network.js";
import { exchangeBotMessage } from "./bot-message-transport.js";
import { botMessageGrantsCommandSchema, crossHostMessageGrantsCommandSchema, type BotMessageGrantsSnapshot, type CrossHostMessageGrantsSnapshot } from "../client-protocol/bot-message-grants.js";

export const messageHostId = (key: string) => `hub_${createHash("sha256").update(Buffer.from(key, "base64")).digest("hex")}`;
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const activeRunPhases = runSummarySchema.shape.phase.options.filter(isRunActive);
const activeRunPhaseParams = activeRunPhases.map(() => "?").join(",");
const memoKey = (kind: string, ...parts: string[]) => `bot-messages:${kind}:${hashSecret(JSON.stringify(parts))}`;
type Guard = () => Promise<unknown>;
type Grant = { sourceKey: string; sourceBot: string; targetBot: string; revoked: boolean };
const grantSchema = z.object({ sourceHost: z.string().min(1).max(256), sourceBot: idSchema, targetBot: z.string().min(1).max(256), revoke: z.boolean().default(false) }).strict();
const LOCAL_GRANTS_EPOCH = "bot-messages:local-grants-revision", CROSS_HOST_GRANTS_EPOCH = "bot-messages:cross-host-grants-revision";
// Only the host list of the stored signed membership is read here; message
// eligibility itself is always PrivateNetwork.requireMessagePeerInTransaction.
const storedMembershipHostsSchema = z.object({ membership: z.object({ manifest: z.object({ id: z.string(),
  hosts: z.array(z.object({ publicKey: z.string(), name: z.string(), state: z.string(), revoked: z.boolean() }).passthrough()) }).passthrough() }).passthrough().optional() }).passthrough();
type CrossHostState = { snapshot: CrossHostMessageGrantsSnapshot; keys: Map<string, string>; live: Set<string>; listed: Set<string> };

/** A narrow peer protocol, independent of Agent Bus. All authority is checked
 * by the receiving Hub; the CLI never receives either Hub's signing key. */
export class BotMessages {
  constructor(readonly store: HubStore, readonly auth: HubAuth, readonly network: PrivateNetwork, readonly attachments: HubAttachments,
    readonly exchange: typeof exchangeBotMessage = exchangeBotMessage,
    readonly workerCapable: (botId: string) => boolean | undefined = () => undefined,
    // Live App sockets learn about conversations only when told, as for every
    // other creation path; otherwise a delegated chat stays hidden until reconnect.
    readonly conversationCreated: (userId: string, conversation: Conversation) => void = () => undefined) {}
  private async memo<T>(key: string): Promise<T | undefined> {
    const row = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [key]);
    return row ? JSON.parse(row.value) as T : undefined;
  }
  private put(key: string, value: unknown) { return this.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, JSON.stringify(value)]); }
  private async hosts(guard?: Guard) {
    const view = await this.network.view(guard);
    const hosts = [view.host, ...(view.membership?.manifest.hosts ?? []).filter(h => h.publicKey !== view.host.publicKey && h.state === "active" && !h.revoked)];
    return hosts.map(h => ({ ...h, id: messageHostId(h.publicKey) }));
  }
  /** This Host as a Bot-message source (dispatcher ticket inputs and notices). */
  async ownSource(): Promise<{ hostId: string; hostName: string }> {
    const host = (await this.hosts()).find(h => h.publicKey === this.auth.publicKey)!;
    return { hostId: host.id, hostName: host.name };
  }
  async grant(raw: unknown, guard: Guard, admit?: Guard, actor = "owner") {
    const input = grantSchema.parse(raw), host = resolveBotTarget(input.sourceHost, await this.hosts(guard), "host");
    const bot = resolveBotTarget(input.targetBot, await this.store.bots("owner"), "bot");
    const key = memoKey("grant", host.publicKey, input.sourceBot, bot.id);
    await this.store.db.transaction(async () => {
      await guard(); await admit?.(); await this.network.requireMessagePeerInTransaction(host.publicKey);
      if (!await this.store.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NULL", [bot.id])) throw new HubError("bot_deleted", 410);
      await this.put(key, { sourceKey: host.publicKey, sourceBot: input.sourceBot, targetBot: bot.id, revoked: input.revoke } satisfies Grant);
      // Either tab's revision covers CLI writes, including allow/revoke ABA.
      await this.put(host.publicKey === this.auth.publicKey ? LOCAL_GRANTS_EPOCH : CROSS_HOST_GRANTS_EPOCH, randomUUID());
      await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), actor, input.revoke ? "bot-message.grant-revoked" : "bot-message.granted", JSON.stringify({ hostId: host.id, sourceBot: input.sourceBot, targetBot: bot.id })]);
    });
    return { hostId: host.id, sourceBotId: input.sourceBot, botId: bot.id, revoked: input.revoke };
  }
  private async grantsInTransaction(): Promise<BotMessageGrantsSnapshot> {
    // Internal dispatch workers are not user-selectable grant endpoints. Keep
    // their stored grants and task history intact; filter only this snapshot.
    const bots = await this.store.db.all<{ id: string; name: string; online: number }>("SELECT id,name,online FROM bots WHERE deleted_at IS NULL AND role!='worker' ORDER BY id");
    const ids = new Set(bots.map(bot => bot.id));
    const rows = await this.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:grant:%' ORDER BY key");
    const local: Grant[] = [];
    for (const row of rows) {
      const grant = JSON.parse(row.value) as Grant;
      if (grant.sourceKey === this.auth.publicKey && ids.has(grant.sourceBot) && ids.has(grant.targetBot)
        && row.key === memoKey("grant", grant.sourceKey, grant.sourceBot, grant.targetBot)) local.push(grant);
    }
    const epoch = await this.memo<string>(LOCAL_GRANTS_EPOCH) ?? "legacy";
    return { revision: hashSecret(networkCanonical({ epoch, ids: [...ids], local, selfTargetSupported: true })), selfTargetSupported: true,
      bots: bots.map(bot => ({ ...bot, online: !!bot.online })),
      grants: local.filter(grant => !grant.revoked).map(({ sourceBot, targetBot }) => ({ sourceBot, targetBot })) };
  }
  async readGrants(userId: string, guard: Guard): Promise<BotMessageGrantsSnapshot> {
    return this.store.db.serial(async () => { await guard(); await this.store.requireOwner(userId); return this.grantsInTransaction(); });
  }
  async updateGrants(userId: string, actor: string, raw: unknown, guard: Guard, admit: Guard): Promise<BotMessageGrantsSnapshot> {
    const command = botMessageGrantsCommandSchema.parse(raw);
    return this.store.db.transaction(async () => {
      await guard(); await this.store.requireOwner(userId); await admit();
      const before = await this.grantsInTransaction();
      if (command.revision !== before.revision) throw new HubError("bot_message_grants_changed", 409);
      const ids = new Set(before.bots.map(bot => bot.id));
      if (!ids.has(command.sourceBot) || command.changes.some(change => !ids.has(change.targetBot))) throw new HubError("bot_deleted", 410);
      for (const change of command.changes) {
        await this.put(memoKey("grant", this.auth.publicKey, command.sourceBot, change.targetBot),
          { sourceKey: this.auth.publicKey, sourceBot: command.sourceBot, targetBot: change.targetBot, revoked: !change.allowed } satisfies Grant);
      }
      await this.put(LOCAL_GRANTS_EPOCH, randomUUID());
      await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), actor, "bot-message.grants-updated", JSON.stringify({ sourceBot: command.sourceBot, changes: command.changes.map(change => ({ ...change,
        previous: before.grants.some(grant => grant.sourceBot === command.sourceBot && grant.targetBot === change.targetBot) })) })]);
      return this.grantsInTransaction();
    });
  }
  /** Caller holds the DB queue. The receiving Host's view of one-way edges from
   * other Hosts to its own Bots. `hostName` is display-only. Workers stay hidden
   * as in the local tab; their stored grants and history remain untouched. */
  private async crossHostInTransaction(hostName: string): Promise<CrossHostState> {
    const own = this.auth.publicKey, ownId = messageHostId(own);
    const row = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'");
    const manifest = row ? storedMembershipHostsSchema.parse(JSON.parse(row.value)).membership?.manifest : undefined;
    const names = new Map<string, string>(), keys = new Map<string, string>(), available = new Set<string>();
    for (const host of manifest?.hosts ?? []) {
      if (host.publicKey === own) continue;
      const id = messageHostId(host.publicKey);
      names.set(id, host.name); keys.set(id, host.publicKey);
      // Each check reloads network state; only active entries (at most 32) can pass.
      if (host.state !== "active" || host.revoked) continue;
      try { await this.network.requireMessagePeerInTransaction(host.publicKey); available.add(id); }
      catch (error) { if (!(error instanceof HubError)) throw error; }
    }
    const bots = await this.store.db.all<{ id: string; name: string; online: number; deleted_at: number | null }>("SELECT id,name,online,deleted_at FROM bots WHERE role!='worker' ORDER BY id");
    const byId = new Map(bots.map(bot => [bot.id, bot]));
    const grants: CrossHostMessageGrantsSnapshot["grants"] = [];
    for (const row of await this.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:grant:%' ORDER BY key")) {
      const grant = JSON.parse(row.value) as Grant;
      if (grant.revoked || grant.sourceKey === own || !byId.has(grant.targetBot) || !idSchema.safeParse(grant.sourceBot).success
        || row.key !== memoKey("grant", grant.sourceKey, grant.sourceBot, grant.targetBot)) continue;
      const id = messageHostId(grant.sourceKey);
      keys.set(id, grant.sourceKey);
      grants.push({ sourceHost: id, sourceBot: grant.sourceBot, targetBot: grant.targetBot });
    }
    const order = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
    grants.sort((x, y) => order(x.sourceHost, y.sourceHost) || order(x.sourceBot, y.sourceBot) || order(x.targetBot, y.targetBot));
    const targets = new Set(grants.map(grant => grant.targetBot)), live = new Set(bots.filter(bot => bot.deleted_at === null).map(bot => bot.id));
    const listed = bots.filter(bot => bot.deleted_at === null || targets.has(bot.id));
    const residual = new Set(grants.map(grant => grant.sourceHost));
    const hosts = [...new Set([...available, ...residual])].sort(order).map(id => ({ id, name: names.get(id) ?? id, available: available.has(id) }));
    // Names and online state are excluded so they never invalidate a draft.
    const epoch = await this.memo<string>(CROSS_HOST_GRANTS_EPOCH) ?? "legacy";
    const revision = hashSecret(networkCanonical({ kind: "cross-host", epoch, network: manifest?.id ?? null, available: [...available].sort(order), live: [...live], grants }));
    return { keys, live, listed: new Set(listed.map(bot => bot.id)), snapshot: { revision, host: { id: ownId, name: hostName }, hosts, grants,
      bots: listed.map(bot => bot.deleted_at === null ? { id: bot.id, name: bot.name, online: !!bot.online } : { id: bot.id, name: bot.name, online: false, deleted: true as const }) } };
  }
  async readCrossHostGrants(userId: string, guard: Guard): Promise<CrossHostMessageGrantsSnapshot> {
    const check = async () => { await guard(); await this.store.requireOwner(userId); };
    const { host } = await this.network.view(check);
    return this.store.db.serial(async () => { await check(); return (await this.crossHostInTransaction(host.name)).snapshot; });
  }
  /** Owner + one-use device proof (`admit`); every check repeats in the write
   * transaction. A batch is all-or-nothing: an allow for a source that is not
   * a current message peer rejects its revocations too. Revocation needs an
   * existing visible edge, which keeps removed/offline sources revocable. */
  async updateCrossHostGrants(userId: string, actor: string, raw: unknown, guard: Guard, admit: Guard): Promise<CrossHostMessageGrantsSnapshot> {
    const command = crossHostMessageGrantsCommandSchema.parse(raw);
    const check = async () => { await guard(); await this.store.requireOwner(userId); };
    const { host } = await this.network.view(check);
    return this.store.db.transaction(async () => {
      await check(); await admit();
      const before = await this.crossHostInTransaction(host.name);
      if (command.revision !== before.snapshot.revision) throw new HubError("bot_message_grants_changed", 409);
      // This Host's own Bots use the local tab, which also excludes worker sources.
      if (command.sourceHost === before.snapshot.host.id) throw new HubError("bot_message_grant_local_source", 400);
      const sourceKey = before.keys.get(command.sourceHost);
      if (!sourceKey) throw new HubError("bot_message_host_not_found", 404);
      const existing = new Set(before.snapshot.grants.filter(grant => grant.sourceHost === command.sourceHost && grant.sourceBot === command.sourceBot).map(grant => grant.targetBot));
      if (command.changes.some(change => change.allowed)) await this.network.requireMessagePeerInTransaction(sourceKey);
      for (const change of command.changes) {
        if (change.allowed ? !before.live.has(change.targetBot) : !before.listed.has(change.targetBot)) throw new HubError("bot_deleted", 410);
        if (!change.allowed && !existing.has(change.targetBot)) throw new HubError("bot_message_grant_not_found", 409);
      }
      for (const change of command.changes) await this.put(memoKey("grant", sourceKey, command.sourceBot, change.targetBot),
        { sourceKey, sourceBot: command.sourceBot, targetBot: change.targetBot, revoked: !change.allowed } satisfies Grant);
      await this.put(CROSS_HOST_GRANTS_EPOCH, randomUUID());
      await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), actor, "bot-message.cross-host-grants-updated", JSON.stringify({ sourceHost: command.sourceHost, sourceBot: command.sourceBot,
        changes: command.changes.map(change => ({ ...change, previous: existing.has(change.targetBot) })) })]);
      return (await this.crossHostInTransaction(host.name)).snapshot;
    });
  }
  private async allowed(p: BotPassport, botId: string): Promise<void> {
    if (p.expiresAt <= Date.now() - BOT_PASSPORT_CLOCK_SKEW_MS || p.expiresAt > Date.now() + BOT_PASSPORT_TTL_MS + BOT_PASSPORT_CLOCK_SKEW_MS) throw new HubError("bot_message_passport_expired", 401);
    await this.network.requireMessagePeerInTransaction(p.sourceKey);
    const grant = await this.memo<Grant>(memoKey("grant", p.sourceKey, p.source.botId, botId));
    if (!grant || grant.revoked) throw new HubError(grant ? "bot_message_grant_revoked" : "bot_message_not_authorized", 403);
    if (!await this.store.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NULL", [botId])) throw new HubError("bot_deleted", 410);
  }
  /** Only local instance auth or the enrolled owner controller may invoke this. */
  async local(raw: unknown, sourceBot: string, guard: Guard, operator = false): Promise<unknown> {
    let requestId = "invalid";
    try {
      const input = botLocalRequestSchema.parse(raw); requestId = input.requestId;
      const hosts = await this.hosts(guard), own = hosts.find(h => h.publicKey === this.auth.publicKey)!;
      const host = resolveBotTarget(input.host, hosts, "host");
      const source = await this.store.db.serial(async () => {
        await guard(); await this.network.requireMessagePeerInTransaction(host.publicKey);
        const bot = await this.store.db.get<{ name: string }>("SELECT name FROM bots WHERE id=? AND deleted_at IS NULL", [sourceBot]);
        if (!bot || input.sourceBot && input.sourceBot !== sourceBot) throw new HubError("bot_message_source_invalid", 403);
        let hops = 1;
        if (input.contextMessage && ["resolve", "send", "upload", "chunk", "complete"].includes(input.operation)) {
          const row = await this.store.db.get<{ bot_source_json: string | null }>("SELECT m.bot_source_json FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.id=? AND d.bot_id=? AND d.status='pending' AND d.dispatched=1", [input.contextMessage, sourceBot]);
          if (!row) throw new HubError("bot_message_context_not_active", 403);
          // A group discussion turn speaks only in its own group. It never
          // delegates or messages other Bots (which could also leak a sealed
          // independent answer), whatever the Hub-side grants allow.
          if (await this.store.db.get("SELECT 1 FROM group_discussion_turns WHERE input_message_id=?", [input.contextMessage])) throw new HubError("group_discussion_bot_messages_blocked", 403);
          hops = row.bot_source_json ? botSourceSchema.parse(JSON.parse(row.bot_source_json)).hops + 1 : 1;
        } else if (!operator && (["send", "upload", "chunk", "complete"].includes(input.operation) || input.operation === "resolve" && !input.conversation)) throw new HubError("bot_message_context_required", 403);
        if (hops > 3 && (input.operation !== "resolve" || !input.conversation)) throw new HubError("bot_message_hop_limit", 429);
        return { hostId: own.id, hostName: own.name, botId: sourceBot, botName: bot.name, requestId: input.requestId, hops: Math.min(hops, 3) };
      });
      const data = input.data;
      const routes = {
        list: "/api/bot-messages/conversations", resolve: "/api/bot-messages/resolve", send: "/api/bot-messages/send", wait: "/api/bot-messages/wait",
        upload: "/api/uploads", chunk: `/api/uploads/${idSchema.optional().parse(data.uploadId) ?? "invalid"}/${z.number().int().nonnegative().optional().parse(data.index) ?? 0}`,
        complete: `/api/uploads/${idSchema.optional().parse(data.uploadId) ?? "invalid"}/complete`, download: "/api/bot-messages/download",
      };
      const body = input.operation === "chunk" ? Buffer.from(z.string().max(CHUNK_BYTES * 2).parse(data.bytes), "base64") : Buffer.from(JSON.stringify(data));
      if (body.length > CHUNK_BYTES) throw new HubError("bot_message_body_too_large", 413);
      const passport: BotPassport = { v: 1, sourceKey: this.auth.publicKey, targetKey: host.publicKey, source, targetBot: input.bot, ...(input.conversation ? { conversation: input.conversation } : {}),
        method: input.operation === "chunk" ? "PUT" : "POST", path: routes[input.operation], digest: digest(body), expiresAt: Date.now() + BOT_PASSPORT_TTL_MS, nonce: randomUUID() };
      // A lost reply is uncertain. Only an explicit caller rerun can transmit
      // again; the same request number cannot change target or content.
      if (input.operation === "send") await this.store.db.transaction(async () => {
        await guard(); await this.network.requireMessagePeerInTransaction(host.publicKey);
        const key = memoKey("outgoing", sourceBot, input.requestId);
        const content = hashSecret(networkCanonical({ target: host.publicKey, bot: input.bot, conversation: input.conversation, data }));
        const old = await this.memo<{ content: string }>(key);
        if (old && old.content !== content) throw new HubError("bot_message_request_conflict", 409);
        await this.put(key, { content, state: "unconfirmed", at: Date.now() });
      });
      const signed = { passport, signature: this.auth.signBotPassport(passport) };
      await this.store.db.serial(guard);
      let result = host.publicKey === this.auth.publicKey ? await this.receive(signed, passport.method, passport.path, body) : await this.exchange(host as NetworkHost, signed, body);
      if (input.operation === "resolve") {
        const parsed = botMessageTargetSchema.safeParse(result);
        if (!parsed.success) throw new HubError("bot_message_reply_invalid", 502);
        if (parsed.data.hostId !== messageHostId(host.publicKey)) throw new HubError("bot_message_reply_target_mismatch", 502);
        result = parsed.data;
      }
      await this.store.db.serial(async () => { await guard(); await this.network.requireMessagePeerInTransaction(host.publicKey); });
      if (input.operation === "send" || input.operation === "wait") await this.store.audit(`bot-message.outgoing-${input.operation}`, sourceBot, { requestId: input.requestId, hostId: host.id });
      return result;
    } catch (error) {
      await this.store.audit("bot-message.rejected", sourceBot, { stage: "source", requestId, reason: error instanceof HubError ? error.code : "invalid_request" }); throw error instanceof TargetResolutionError ? new HubError(error.message, 409) : error;
    }
  }
  /** Authenticate the bounded header before accepting an upload/request body.
   * receive() repeats the grant/expiry checks after reading, closing revocation
   * races while leaving request idempotency and digest verification intact. */
  async authorizePassport(raw: unknown, method: string, path: string): Promise<{ signed: SignedBotPassport; bot: { id: string; name: string } }> {
      let signed: SignedBotPassport;
      try {
        signed = signedBotPassportSchema.parse(raw);
        const p = signed.passport;
        if (p.targetKey !== this.auth.publicKey || p.method !== method || p.path !== path
          || p.source.hostId !== messageHostId(p.sourceKey) || !verify(null, Buffer.from(botPassportProof(p)), parsePublicKey(p.sourceKey), Buffer.from(signed.signature, "base64"))) throw new Error("signature");
      } catch { throw new HubError("bot_message_signature_invalid", 403); }
      const passport = signed.passport;
      const allowedRoute = method === "POST" && (/^\/api\/bot-messages\/(conversations|resolve|send|wait|download)$/.test(path) || path === "/api/uploads" || /^\/api\/uploads\/[\w-]+\/complete$/.test(path))
        || method === "PUT" && /^\/api\/uploads\/[\w-]+\/\d+$/.test(path);
      if (!allowedRoute) throw new HubError("bot_message_operation_forbidden", 403);
      const bots = await this.store.db.serial(async () => {
        await this.network.requireMessagePeerInTransaction(passport.sourceKey);
        const rows = await this.store.db.all<{ id: string; name: string }>("SELECT id,name FROM bots WHERE deleted_at IS NULL ORDER BY name,id");
        const allowed = [];
        for (const bot of rows) { const grant = await this.memo<Grant>(memoKey("grant", passport.sourceKey, passport.source.botId, bot.id)); if (grant && !grant.revoked) allowed.push(bot); }
        return allowed;
      });
      // Do not disclose a private Bot directory to an unauthorized source.
      if (!bots.length) throw new HubError("bot_message_not_authorized_or_revoked", 403);
      const bot = resolveBotTarget(passport.targetBot, bots, "bot");
      await this.store.db.serial(() => this.allowed(passport, bot.id));
      return { signed, bot };
  }
  async receive(raw: unknown, method: string, path: string, body: Buffer): Promise<unknown> {
    let p: BotPassport | undefined;
    try {
      const { signed, bot } = await this.authorizePassport(raw, method, path);
      p = signed.passport;
      if (p.digest !== digest(body)) throw new HubError("bot_message_signature_invalid", 403);
      const passport = p;
      const guard = () => this.allowed(passport, bot.id), validate = () => this.store.db.serial(guard);
      await validate();
      const data = method === "PUT" ? {} : z.record(z.string(), z.unknown()).parse(JSON.parse(body.toString("utf8")));
      const conversations = () => this.store.db.serial(async () => {
        await guard(); return this.store.db.all<{ id: string; name: string; lastActivityAt: number }>(`SELECT c.id,c.title AS name,COALESCE(MAX(m.created_at),c.created_at) AS lastActivityAt FROM conversations c
          JOIN conversation_members b ON b.conversation_id=c.id AND b.member_type='bot' AND b.member_id=?
          JOIN conversation_members u ON u.conversation_id=c.id AND u.member_type='user' AND u.member_id='owner'
          LEFT JOIN messages m ON m.conversation_id=c.id WHERE c.archived=0 GROUP BY c.id ORDER BY lastActivityAt DESC,c.id`, [bot.id]);
      });
      const profile = await this.network.view(guard);
      const base = { hostId: messageHostId(this.auth.publicKey), hostName: profile.host.name, botId: bot.id, botName: bot.name };
      if (path === "/api/bot-messages/conversations" && method === "POST") { const result = { ...base, conversations: await conversations() }; await validate(); return result; }
      let conversation;
      if (p.conversation) conversation = resolveBotTarget(p.conversation, await conversations(), "conversation");
      else if (path === "/api/bot-messages/resolve" && method === "POST") {
        const name = z.string().min(1).max(256).optional().parse(data.newConversation);
        const key = memoKey(name ? "new-conversation" : "collaboration", p.sourceKey, p.source.botId, bot.id, name ? p.source.requestId : "default");
        const actionId = `bm_${hashSecret(key)}`;
        const c = await this.store.createConversation("owner", [bot.id], name ?? `来自 ${p.source.botName} 的协作`.slice(0, 256), actionId, {}, async () => {
          await guard();
          if (await this.store.db.get("SELECT 1 FROM conversations WHERE owner_id='owner' AND client_action_id=?", [actionId])) return;
          const rateKey = memoKey("conversation-rate", passport.sourceKey, passport.source.botId);
          const times = (await this.memo<number[]>(rateKey) ?? []).filter(t => t > Date.now() - 60_000);
          if (times.length >= 10) throw new HubError("bot_message_rate_limit", 429);
          await this.put(rateKey, [...times, Date.now()]);
        });
        this.conversationCreated("owner", c);
        conversation = { id: c.id, name: c.title };
      } else throw new HubError("bot_message_conversation_required", 400);
      const target: BotMessageTarget = { ...base, conversationId: conversation.id, conversationName: conversation.name };
      const scope = async () => { await guard(); await this.store.requireMember("owner", target.conversationId); await this.store.requireBot(bot.id, target.conversationId); };
      if (path === "/api/bot-messages/resolve" && method === "POST") { await validate(); return target; }
      const attachmentGuard = async (id: string) => {
        await scope();
        if (!await this.memo(memoKey("upload", p!.sourceKey, p!.source.botId, bot.id, target.conversationId, id))) throw new HubError("bot_message_upload_forbidden", 403);
      };
      if (path === "/api/uploads" && method === "POST") {
        const input = uploadSchema.parse({ ...data, conversationId: target.conversationId });
        const result = await this.attachments.create("owner", input, scope);
        await this.store.db.transaction(async () => {
          await scope();
          const key = memoKey("upload", passport.sourceKey, passport.source.botId, bot.id, target.conversationId, result.id);
          const existing = await this.memo(key);
          await this.put(key, { requestId: passport.source.requestId });
          // Only a newly created permit has known consumption history. Keep
          // the old wire value and never reclassify an existing/legacy permit.
          // The SQL reference trigger also tracks compatible older writers.
          if (!existing) await this.store.db.run(`INSERT INTO bot_message_upload_permits(permit_key,attachment_id,used)
            VALUES(?,?,EXISTS(SELECT 1 FROM message_attachments WHERE attachment_id=?))`, [key, result.id, result.id]);
        });
        await validate(); return result;
      }
      const upload = /^\/api\/uploads\/([\w-]+)\/(complete|\d+)$/.exec(path);
      if (upload) {
        const check = () => this.store.db.serial(() => attachmentGuard(upload[1]!));
        if (upload[2] === "complete" && method === "POST") { const result = await this.attachments.complete("owner", upload[1]!, check); await check(); return { id: result.id }; }
        if (method === "PUT" && upload[2] !== "complete") { await this.attachments.putChunk("owner", upload[1]!, Number(upload[2]), body, check); await check(); return { ok: true }; }
      }
      if (path === "/api/bot-messages/send" && method === "POST") {
        const input = z.object({ text: textSchema, attachments: z.array(idSchema).max(50).default([]) }).strict().parse(data);
        if (isBotControl(input.text)) throw new HubError("bot_message_control_forbidden", 400);
        const key = memoKey("incoming", p.sourceKey, p.source.botId, p.source.requestId);
        const content = hashSecret(networkCanonical({ bot: bot.id, conversation: target.conversationId, ...input }));
        const result = await this.store.sendMessage("owner", { ...input, conversationId: target.conversationId, clientMsgId: `bm_${hashSecret(key)}`, mentions: [bot.id], botSource: p.source, previewUrl: null }, async () => {
          await scope();
          const old = await this.memo<{ content: string }>(key);
          if (old && old.content !== content) throw new HubError("bot_message_request_conflict", 409);
          for (const id of input.attachments) await attachmentGuard(id);
          if (!old) {
            if (this.workerCapable(bot.id) === false) throw new HubError("bot_message_worker_update_required", 409);
            const rateKey = memoKey("rate", passport.sourceKey, passport.source.botId);
            const times = (await this.memo<number[]>(rateKey) ?? []).filter(t => t > Date.now() - 60_000);
            if (times.length >= 10) throw new HubError("bot_message_rate_limit", 429);
            await this.put(rateKey, [...times, Date.now()]); await this.put(key, { content, at: Date.now() });
          }
          await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), passport.source.botId, "bot-message.send", JSON.stringify({ ...target, requestId: passport.source.requestId, duplicate: !!old, sourceHost: passport.source.hostId, hops: passport.source.hops })]);
        });
        await validate(); return { ...target, requestId: p.source.requestId, messageId: result.message.id, duplicate: result.duplicate, status: "queued" };
      }
      if (["/api/bot-messages/wait", "/api/bot-messages/download"].includes(path) && method === "POST") {
        const messageId = idSchema.parse(data.messageId);
        const result = await this.store.db.serial(async () => {
          await scope();
          const row = await this.store.db.get<{ bot_source_json: string; status: string }>("SELECT m.bot_source_json,d.status FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.id=? AND m.conversation_id=? AND d.bot_id=?", [messageId, target.conversationId, bot.id]);
          const origin = row?.bot_source_json ? botSourceSchema.parse(JSON.parse(row.bot_source_json)) : undefined;
          if (!row || !origin || origin.hostId !== passport.source.hostId || origin.botId !== passport.source.botId) throw new HubError("bot_message_reply_forbidden", 403);
          const messages = await this.store.db.all<{ id: string; blocks_json: string; status: string }>("SELECT id,blocks_json,status FROM messages WHERE conversation_id=? AND author_type='bot' AND author_id=? AND reply_to=? AND status!='deleted' ORDER BY created_at,id LIMIT 201", [target.conversationId, bot.id, messageId]);
          const files = await this.store.db.all<{ id: string; name: string; size: number; mime: string; sha256: string }>(`SELECT DISTINCT a.id,a.name,a.size,a.mime,a.sha256 FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id JOIN messages m ON m.id=ma.message_id WHERE m.reply_to=? AND m.author_type='bot' AND m.author_id=? AND m.conversation_id=? AND m.status!='deleted' AND a.complete=1`, [messageId, bot.id, target.conversationId]);
          // An accepted delivery only ends the foreground turn. Bound background
          // work keeps replying to the same input; its process cards always carry
          // a complete envelope, so their run phase decides whether more may come.
          const { active } = (await this.store.db.get<{ active: number }>(`SELECT COUNT(*) AS active FROM messages m WHERE m.reply_to=? AND m.author_type='bot' AND m.author_id=? AND m.conversation_id=? AND m.status!='deleted'
            AND (m.status IN ('pending','streaming') OR EXISTS (SELECT 1 FROM json_each(m.blocks_json) b WHERE json_extract(b.value,'$.type')='card'
              AND (json_extract(b.value,'$.extra.nativeRun.phase') IN (${activeRunPhaseParams}) OR json_extract(b.value,'$.extra.scopedRun.phase') IN (${activeRunPhaseParams}))))`,
          [messageId, bot.id, target.conversationId, ...activeRunPhases, ...activeRunPhases]))!;
          const replying = row.status === "accepted" && active > 0;
          return { ...target, messageId, status: replying ? "pending" : row.status === "accepted" ? messages.some(m => m.status === "error") ? "failed" : "completed" : row.status === "failed" ? "failed" : row.status === "cancelled" ? "cancelled" : "pending",
            ...(replying ? { activeReplies: active } : {}), text: messages.slice(0, 200).map(m => blocksText(JSON.parse(m.blocks_json) as Block[])).filter(Boolean).join("\n\n"), files, truncated: messages.length > 200 };
        });
        if (path.endsWith("/wait")) { await this.store.audit("bot-message.wait", p.source.botId, { messageId, sourceHost: p.source.hostId, status: result.status }); await validate(); return result; }
        const id = idSchema.parse(data.attachmentId), file = result.files.find(f => f.id === id);
        if (!file) throw new HubError("bot_message_reply_file_forbidden", 403);
        const offset = z.number().int().min(0).parse(data.offset);
        if (offset >= file.size) throw new HubError("invalid_offset", 416);
        const download = await this.attachments.download({ botId: bot.id }, id), handle = await open(download.path, "r");
        try { const bytes = Buffer.alloc(Math.min(1024 * 1024, file.size - offset)); const read = await handle.read(bytes, 0, bytes.length, offset); await validate(); return { bytes: bytes.subarray(0, read.bytesRead).toString("base64"), offset, ...file }; }
        finally { await handle.close(); }
      }
      throw new HubError("bot_message_operation_forbidden", 403);
    } catch (error) {
      await this.store.audit("bot-message.rejected", p?.source.botId ?? null, { stage: "target", reason: error instanceof HubError ? error.code : "invalid_request" }); throw error instanceof TargetResolutionError ? new HubError(error.message, 409) : error;
    }
  }
}
