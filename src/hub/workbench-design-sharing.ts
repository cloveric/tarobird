import { isDesignShareRefusal, appendDesignShareResult, encodeDesignShareResult, splitDesignShareResult, type DesignShareResultBuffer } from "../client-protocol/workbench-design-sharing-result.js";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { HubDatabase } from "./database.js";
import { HubError } from "./store.js";
import { designFormatSchema } from "../client-protocol/workbench-design.js";
import { DESIGN_SHARE_COMMENT_CALLS, DESIGN_SHARE_LIMITS, DESIGN_SHARE_READ_CALLS, designShareChunkSchema, designShareIdSchema, designShareRequestFrameSchema, designShareRoleSchema, sanitizeDesignPresence,
  type DesignShareCall, type DesignShareEvent, type DesignShareLimits, type DesignShareParticipantRole, type DesignSharePeerView, type DesignShareRequest, type DesignShareResultFrame, type DesignShareRole, type DesignShareServerFrame } from "../client-protocol/workbench-design-sharing.js";

/**
 * Authenticated collaboration broker for one Baoyu document at a time.
 *
 * The source device (the owner's App window holding the document) remains the
 * only authority: every write is relayed to it and applied there with the same
 * CAS, receipts and history as a local edit. The Host checks the socket's
 * session, live conversation membership and the owner's explicit grants on
 * every operation, stamps identities, and moves content only as bounded,
 * content-addressed chunks over the existing App socket. When the source is
 * offline, writes fail (`design_share_source_offline`); nothing is queued and
 * nothing is reported as synced. A closed share keeps a tombstone so late
 * frames cannot revive it; a revoked grant is removed, not suspended.
 */
export interface DesignSharePeer {
  readonly key: object; readonly userId: string; readonly deviceId: string;
  active(): boolean; validate(): Promise<unknown>;
  send(frame: DesignShareServerFrame): Promise<unknown>;
  /** A stalled socket cannot retain a result reservation forever. */
  terminate?(): void;
}
const recordSchema = z.object({
  v: z.literal(1), shareId: designShareIdSchema, conversationId: z.string().min(1).max(128), ownerUserId: z.string().min(1).max(128), sourceDeviceId: z.string().min(1).max(128),
  designId: z.string().min(1).max(128), format: designFormatSchema, title: z.string().max(128), state: z.enum(["open", "closed"]), generation: z.number().int().positive(),
  members: z.record(z.string().min(1).max(128), designShareRoleSchema), revision: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(), closedAt: z.number().optional(),
}).strict();
export type DesignShareRecord = z.infer<typeof recordSchema>;
export interface DesignShareRepository {
  get(shareId: string): Promise<DesignShareRecord | undefined>;
  put(record: DesignShareRecord): Promise<void>;
  byConversation(conversationId: string): Promise<DesignShareRecord[]>;
  openByOwner(userId: string): Promise<DesignShareRecord[]>;
  /** Removes closed tombstones older than `before`. */
  prune(before: number): Promise<void>;
  /** The conversation's human members (Hub users), for the owner's grant picker. */
  members?(conversationId: string): Promise<{ userId: string; name: string }[]>;
}
export interface DesignShareHostPort {
  /** Throws (HubError 403) unless the user is a member of the conversation now. */
  requireMember(userId: string, conversationId: string): Promise<void>;
  userName(userId: string): Promise<string | undefined>;
  repository: DesignShareRepository;
}
/** Share records in the Hub's existing meta table (no schema migration). */
export function metaDesignShareRepository(db: HubDatabase): DesignShareRepository {
  const prefix = "workbench-design-share:", pattern = `${prefix}*`;
  const parse = (value: string) => { try { return recordSchema.parse(JSON.parse(value)); } catch { return undefined; } };
  const many = async (sql: string, params: (string | number)[]) => (await db.serial(() => db.all<{ value: string }>(sql, params))).map(row => parse(row.value)).filter((row): row is DesignShareRecord => !!row);
  return {
    get: async shareId => { const row = await db.serial(() => db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [prefix + shareId])); return row ? parse(row.value) : undefined; },
    put: async record => { await db.serial(() => db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [prefix + record.shareId, JSON.stringify(recordSchema.parse(record))])); },
    byConversation: conversationId => many("SELECT value FROM meta WHERE key GLOB ? AND json_valid(value) AND json_extract(value,'$.conversationId')=?", [pattern, conversationId]),
    openByOwner: userId => many("SELECT value FROM meta WHERE key GLOB ? AND json_valid(value) AND json_extract(value,'$.ownerUserId')=? AND json_extract(value,'$.state')='open'", [pattern, userId]),
    prune: async before => { await db.serial(() => db.run("DELETE FROM meta WHERE key GLOB ? AND json_valid(value) AND json_extract(value,'$.state')='closed' AND json_extract(value,'$.closedAt')<?", [pattern, before])); },
    members: async conversationId => (await db.serial(() => db.all<{ id: string; name: string }>("SELECT u.id,u.name FROM conversation_members m JOIN users u ON u.id=m.member_id WHERE m.conversation_id=? AND m.member_type='user' ORDER BY u.name,u.id LIMIT 200", [conversationId]))).map(row => ({ userId: row.id, name: row.name })),
  };
}

type Join = { peer: DesignSharePeer; peerId: string; windowId: string; userId: string; name: string; role: DesignShareParticipantRole; presence: Record<string, unknown>; updatedAt: number };
type Source = { peer: DesignSharePeer; peerId: string; windowId: string; name: string; presence: Record<string, unknown>; updatedAt: number };
type Dispatch = { parts?: DesignShareResultBuffer; kind: "commit" | "call" | "fetch"; mutating: boolean; roles: readonly DesignShareParticipantRole[]; userId: string; joinKey: string; epoch: number; binding: string; admitted: boolean; allowed: Set<string>; resolve(value: unknown): void; reject(error: HubError): void; timer: ReturnType<typeof setTimeout> };
type Live = { record: DesignShareRecord; source?: Source; joins: Map<string, Join>; dispatches: Map<string, Dispatch>; epochs: Map<string, number>; presenceTimer?: ReturnType<typeof setTimeout> };
type Staged = { shareId: string; userId: string; sha256: string; size: number; parts: Buffer[]; received: number; complete: boolean; expires: number };
const WRITE_CALLS: readonly DesignShareCall[] = ["db.write", "restore"];
const ALL_ROLES: readonly DesignShareParticipantRole[] = ["owner", "editor", "commenter", "viewer"];
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const forbidden = (code = "design_share_forbidden") => new HubError(code, 403);
const callRoles = (call: DesignShareCall): readonly DesignShareParticipantRole[] => DESIGN_SHARE_READ_CALLS.includes(call) ? ALL_ROLES
  : DESIGN_SHARE_COMMENT_CALLS.includes(call) ? ["owner", "editor", "commenter"] : WRITE_CALLS.includes(call) ? ["owner", "editor"] : ["owner"];

export class DesignShareBroker {
  private outgoingReplyBytes = 0;
  private availableResultBytes() {
    return this.limits.resultBufferBytes - this.outgoingReplyBytes - [...this.live.values()].reduce((n, value) => n + [...value.dispatches.values()].reduce((m, task) => m + (task.parts?.size ?? 0), 0), 0);
  }
  private readonly live = new Map<string, Live>();
  private readonly staged = new Map<string, Staged>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly keys = new WeakMap<object, number>();
  private nextKey = 1;
  private stagedBytes = 0;
  private closed = false;
  private readonly limits: DesignShareLimits;
  private readonly now: () => number;
  constructor(private readonly port: DesignShareHostPort, options: { limits?: Partial<DesignShareLimits>; now?: () => number } = {}) {
    this.limits = { ...DESIGN_SHARE_LIMITS, ...options.limits }; this.now = options.now ?? Date.now;
  }
  /** One participant session per authenticated connection and App window. */
  private joinKey(peer: DesignSharePeer, windowId: string) {
    let id = this.keys.get(peer.key); if (id === undefined) { id = this.nextKey++; this.keys.set(peer.key, id); }
    return `${id}\0${windowId}`;
  }

  /** One `design.share.request` frame → its `design.share.result`. Expected refusals are results, not throws.
   * Callers should not serialize a client's frames behind this: a commit waits for the source device. */
  async handle(peer: DesignSharePeer, input: unknown): Promise<DesignShareResultFrame> {
    const parsed = designShareRequestFrameSchema.safeParse(input);
    const given = (input as { requestId?: unknown } | null)?.requestId;
    const requestId = parsed.success ? parsed.data.requestId : typeof given === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(given) ? given : "invalid";
    if (!parsed.success) return { v: 1, type: "design.share.result", requestId, ok: false, error: "invalid_design_share_request" };
    let writeResult = false;
    try {
      if (this.closed) throw new HubError("design_share_host_stopping", 503);
      await peer.validate();
      if (!peer.active()) throw new HubError("design_share_app_unavailable", 409);
      const request = parsed.data.request, result = await this.operate(peer, requestId, request);
      writeResult = request.op === "commit" || request.op === "call" && !DESIGN_SHARE_READ_CALLS.includes(request.call) && !isDesignShareRefusal(result);
      const bytes = encodeDesignShareResult(result);
      if (bytes.length > this.limits.resultInlineBytes) {
        if (bytes.length > this.availableResultBytes()) throw new HubError("design_share_reply_busy", 429);
        this.outgoingReplyBytes += bytes.length;
        const deadline = this.now() + 2 * this.limits.dispatchTimeoutMs;
        try {
          for (const part of splitDesignShareResult(bytes)) {
            // A grant or socket can disappear while a large read is being sent.
            await this.resultStep(peer, deadline, async () => {
              await peer.validate();
              if (!peer.active()) throw new HubError("design_share_app_unavailable", 409);
              if (request.op === "call") await this.participant(peer, request.shareId, request.windowId, callRoles(request.call));
            });
            const frame: DesignShareResultFrame = { v: 1, type: "design.share.result", requestId, ok: true, part };
            if (part.offset + DESIGN_SHARE_LIMITS.chunkBytes >= part.size) return frame;
            await this.resultStep(peer, deadline, () => peer.send(frame));
          }
          throw new HubError("design_share_bad_chunk", 502);
        } finally { this.outgoingReplyBytes -= bytes.length; }
      }
      return { v: 1, type: "design.share.result", requestId, ok: true, ...(result === undefined ? {} : { result }) };
    } catch (error) {
      return { v: 1, type: "design.share.result", requestId, ok: false, error: writeResult ? "design_share_outcome_unknown" : error instanceof HubError ? error.code : "design_share_failed" };
    }
  }
  private async resultStep<T>(peer: DesignSharePeer, deadline: number, work: () => Promise<T>): Promise<T> {
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new HubError("design_share_timeout", 504);
    // A whole-result cap releases its reservation without punishing a healthy
    // but slow socket. Only a full interval with no progress retires the peer.
    const idle = this.limits.dispatchTimeoutMs, stalled = remaining >= idle;
    const expire = () => {
      if (stalled) {
        this.disconnect(peer);
        try { peer.terminate?.(); } catch { /* The expired stream is abandoned either way. */ }
      }
      return new HubError("design_share_timeout", 504);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expire()), Math.min(remaining, idle)); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    const tail = run.catch(() => undefined); this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }
  private async operate(peer: DesignSharePeer, requestId: string, request: DesignShareRequest): Promise<unknown> {
    switch (request.op) {
      case "open": return this.open(peer, request);
      case "attach": return this.serial(request.shareId, () => this.attach(peer, request));
      case "detach": return this.serial(request.shareId, async () => this.detach(peer, request.shareId, request.windowId));
      case "close": return this.serial(request.shareId, () => this.closeShare(peer, request.shareId));
      case "grant": return this.serial(request.shareId, () => this.grant(peer, request));
      case "list": return this.list(peer, request.conversationId);
      case "members": {
        await this.port.requireMember(peer.userId, request.conversationId);
        if (!this.port.repository.members) throw new HubError("design_share_members_unavailable", 501);
        return { members: (await this.port.repository.members(request.conversationId)).map(member => ({ ...member, ...(member.userId === peer.userId ? { you: true } : {}) })) };
      }
      case "join": return this.serial(request.shareId, () => this.join(peer, request));
      case "leave": { const live = this.live.get(request.shareId), key = this.joinKey(peer, request.windowId); if (live?.joins.delete(key)) { this.failDispatches(live, "design_share_requester_gone", dispatch => dispatch.joinKey === key && !dispatch.admitted); this.peers(live); } return null; }
      case "presence": return this.presence(peer, request);
      case "stage": return this.stage(peer, request);
      case "commit": return this.commit(peer, requestId, request);
      case "call": return this.call(peer, requestId, request);
      case "fetch": return this.fetch(peer, requestId, request);
      case "pull": return this.pull(peer, request);
      case "admit": return this.admit(peer, request);
      case "reply": return this.reply(peer, request);
      case "changed": return this.serial(request.shareId, () => this.changed(peer, request));
    }
  }

  // ---- owner / source window ------------------------------------------------
  private async open(peer: DesignSharePeer, request: Extract<DesignShareRequest, { op: "open" }>) {
    await this.port.requireMember(peer.userId, request.conversationId);
    return this.serial(`open:${peer.userId}`, async () => {
      const mine = await this.port.repository.openByOwner(peer.userId);
      const candidate = mine.find(item => item.sourceDeviceId === peer.deviceId && item.designId === request.designId && item.conversationId === request.conversationId);
      if (candidate) {
        // Re-read under the share's own lock: a close may have landed since the listing.
        const reused = await this.serial(candidate.shareId, async () => {
          const live = this.live.get(candidate.shareId), fresh = live?.record ?? await this.port.repository.get(candidate.shareId);
          if (fresh?.state !== "open") return undefined;
          await this.bindSource(fresh, peer, request.windowId, request.revision);
          return this.view(this.live.get(candidate.shareId)!.record, peer.userId, peer.deviceId);
        });
        if (reused) return reused;
      }
      if (mine.filter(item => item.shareId !== candidate?.shareId).length >= this.limits.sharesPerOwner) throw new HubError("design_share_limit", 429);
      await this.port.repository.prune(this.now() - this.limits.tombstoneMs);
      const now = this.now(), record: DesignShareRecord = { v: 1, shareId: `ds_${hex(12)}`, conversationId: request.conversationId, ownerUserId: peer.userId, sourceDeviceId: peer.deviceId, designId: request.designId,
        format: request.format, title: request.title, state: "open", generation: 1, members: {}, revision: request.revision, createdAt: now, updatedAt: now };
      return this.serial(record.shareId, async () => {
        await this.port.repository.put(record);
        await this.bindSource(record, peer, request.windowId, request.revision);
        return this.view(this.live.get(record.shareId)!.record, peer.userId, peer.deviceId);
      });
    });
  }
  private async loadLive(shareId: string): Promise<Live> {
    const known = this.live.get(shareId);
    if (known) return known;
    const record = await this.port.repository.get(shareId);
    if (!record) throw new HubError("design_share_not_found", 404);
    const live: Live = { record, joins: new Map(), dispatches: new Map(), epochs: new Map() };
    if (record.state === "open") this.live.set(shareId, live);
    return live;
  }
  /** Called only under the share's lock with its current open record. */
  private async bindSource(record: DesignShareRecord, peer: DesignSharePeer, windowId: string, revision: number) {
    if (record.state !== "open") throw new HubError("design_share_closed", 410);
    const live: Live = this.live.get(record.shareId) ?? { record, joins: new Map(), dispatches: new Map(), epochs: new Map() };
    this.live.set(record.shareId, live);
    live.record = { ...live.record, revision };
    // A new binding replaces the old one; nothing dispatched to the old window can complete.
    this.failDispatches(live, "design_share_source_offline");
    live.source = { peer, peerId: `p_${hex(8)}`, windowId, name: await this.port.userName(peer.userId) ?? "", presence: {}, updatedAt: this.now() };
    this.emit(live, { type: "source", online: true, revision });
    this.peers(live);
  }
  private async attach(peer: DesignSharePeer, request: Extract<DesignShareRequest, { op: "attach" }>) {
    const live = await this.loadLive(request.shareId), record = live.record;
    if (record.state !== "open") throw new HubError("design_share_closed", 410);
    if (record.ownerUserId !== peer.userId || record.sourceDeviceId !== peer.deviceId) throw forbidden();
    await this.port.requireMember(peer.userId, record.conversationId);
    await this.bindSource(record, peer, request.windowId, request.revision);
    return this.view(live.record, peer.userId, peer.deviceId);
  }
  private detach(peer: DesignSharePeer, shareId: string, windowId: string) {
    const live = this.live.get(shareId);
    if (!live?.source || live.source.peer.key !== peer.key || live.source.windowId !== windowId) return { detached: false };
    live.source = undefined; this.failDispatches(live, "design_share_source_offline");
    this.emit(live, { type: "source", online: false, revision: live.record.revision }); this.peers(live);
    return { detached: true };
  }
  private async closeShare(peer: DesignSharePeer, shareId: string) {
    const live = await this.loadLive(shareId);
    if (live.record.ownerUserId !== peer.userId) throw forbidden();
    if (live.record.state !== "closed") await this.retire(live, "closed");
    return { shareId, closed: true };
  }
  /** Close as a tombstone: the generation advances so nothing older is accepted again. */
  private async retire(live: Live, reason: "closed" | "membership") {
    const now = this.now(), record: DesignShareRecord = { ...live.record, state: "closed", generation: live.record.generation + 1, updatedAt: now, closedAt: now };
    await this.port.repository.put(record);
    this.failDispatches(live, "design_share_closed");
    for (const join of live.joins.values()) this.send(live, join.peer, { type: "revoked", reason });
    if (live.source) this.send(live, live.source.peer, { type: "revoked", reason });
    if (live.presenceTimer) clearTimeout(live.presenceTimer);
    live.record = record; live.joins.clear(); live.source = undefined;
    this.live.delete(record.shareId); this.purgeStaged(item => item.shareId === record.shareId);
  }
  /** Ends a user's participation now: grant epoch advances, unadmitted work fails, sessions close. */
  private revokeSessions(live: Live, userId: string, reason: "removed" | "membership" | undefined, role?: DesignShareParticipantRole) {
    live.epochs.set(userId, (live.epochs.get(userId) ?? 0) + 1);
    this.failDispatches(live, "design_share_role_changed", dispatch => dispatch.userId === userId && !dispatch.admitted);
    for (const [key, join] of live.joins) if (join.userId === userId) {
      if (reason) { live.joins.delete(key); this.send(live, join.peer, { type: "revoked", reason }); }
      else if (role) { join.role = role; this.send(live, join.peer, { type: "role", role }); }
    }
    if (role !== "editor" && role !== "owner") this.purgeStaged(item => item.shareId === live.record.shareId && item.userId === userId);
    this.peers(live);
  }
  private async grant(peer: DesignSharePeer, request: Extract<DesignShareRequest, { op: "grant" }>) {
    const live = await this.loadLive(request.shareId), record = live.record;
    if (record.state !== "open") throw new HubError("design_share_closed", 410);
    if (record.ownerUserId !== peer.userId) throw forbidden();
    if (request.userId === record.ownerUserId) throw new HubError("design_share_owner_role", 400);
    if (request.role) {
      try { await this.port.requireMember(request.userId, record.conversationId); } catch { throw forbidden("design_share_not_member"); }
      if (!(request.userId in record.members) && Object.keys(record.members).length >= this.limits.membersPerShare) throw new HubError("design_share_limit", 429);
    }
    const members = { ...record.members };
    if (request.role) members[request.userId] = request.role; else delete members[request.userId];
    live.record = { ...record, members, updatedAt: this.now() };
    await this.port.repository.put(live.record);
    this.revokeSessions(live, request.userId, request.role ? undefined : "removed", request.role ?? undefined);
    return this.view(live.record, peer.userId, peer.deviceId);
  }
  private async list(peer: DesignSharePeer, conversationId: string) {
    await this.port.requireMember(peer.userId, conversationId);
    const records = (await this.port.repository.byConversation(conversationId)).filter(record => record.state === "open" && (record.ownerUserId === peer.userId || record.members[peer.userId]));
    return { shares: await Promise.all(records.map(record => this.view(this.live.get(record.shareId)?.record ?? record, peer.userId, peer.deviceId))) };
  }
  private async view(record: DesignShareRecord, userId: string, deviceId?: string) {
    const live = this.live.get(record.shareId), owner = record.ownerUserId === userId;
    return { shareId: record.shareId, conversationId: record.conversationId, designId: record.designId, format: record.format, title: record.title, generation: record.generation,
      ownerUserId: record.ownerUserId, ownerName: await this.port.userName(record.ownerUserId) ?? "", role: owner ? "owner" : record.members[userId], revision: record.revision,
      sourceOnline: !!live?.source?.peer.active(), onThisDevice: owner && deviceId === record.sourceDeviceId, ...(owner ? { members: await Promise.all(Object.entries(record.members).map(async ([id, role]) => ({ userId: id, name: await this.port.userName(id) ?? "", role }))) } : {}) };
  }

  // ---- participants ---------------------------------------------------------
  private currentRole(live: Live, userId: string): DesignShareParticipantRole | undefined { return live.record.ownerUserId === userId ? "owner" : live.record.members[userId]; }
  private async join(peer: DesignSharePeer, request: Extract<DesignShareRequest, { op: "join" }>) {
    const live = await this.loadLive(request.shareId), record = live.record;
    if (record.state !== "open") throw new HubError("design_share_closed", 410);
    if (record.ownerUserId === peer.userId && record.sourceDeviceId === peer.deviceId) throw new HubError("design_share_source_device", 409);
    await this.port.requireMember(peer.userId, record.conversationId);
    const role = this.currentRole(live, peer.userId);
    if (!role) throw forbidden();
    const key = this.joinKey(peer, request.windowId), previous = live.joins.get(key);
    if (!previous && live.joins.size >= this.limits.peersPerShare) throw new HubError("design_share_full", 429);
    const join: Join = { peer, peerId: previous?.peerId ?? `p_${hex(8)}`, windowId: request.windowId, userId: peer.userId, name: await this.port.userName(peer.userId) ?? "", role, presence: {}, updatedAt: this.now() };
    live.joins.set(key, join);
    this.peers(live);
    return { ...(await this.view(record, peer.userId, peer.deviceId)), peer: join.peerId };
  }
  /** Re-checks the window's session, live membership and current role on every call. */
  private async participant(peer: DesignSharePeer, shareId: string, windowId: string, roles: readonly DesignShareParticipantRole[]) {
    const live = this.live.get(shareId);
    if (!live || live.record.state !== "open") throw new HubError("design_share_closed", 410);
    const key = this.joinKey(peer, windowId), join = live.joins.get(key);
    if (!join || join.peer !== peer && join.peer.key !== peer.key) throw new HubError("design_share_not_joined", 409);
    try { await this.port.requireMember(peer.userId, live.record.conversationId); }
    catch { live.joins.delete(key); this.peers(live); throw forbidden("design_share_not_member"); }
    const role = this.currentRole(live, peer.userId);
    if (!role) { live.joins.delete(key); this.peers(live); throw forbidden(); }
    join.role = role;
    if (!roles.includes(role)) throw forbidden(role === "viewer" ? "design_share_read_only" : "design_share_forbidden");
    return { live, join, key };
  }
  private async presence(peer: DesignSharePeer, request: Extract<DesignShareRequest, { op: "presence" }>) {
    const live = this.live.get(request.shareId);
    if (!live || live.record.state !== "open") throw new HubError("design_share_closed", 410);
    const holder = live.source?.peer.key === peer.key && live.source.windowId === request.windowId ? live.source : (await this.participant(peer, request.shareId, request.windowId, ALL_ROLES)).join;
    const next = sanitizeDesignPresence(request.patch, holder.presence);
    if (!next) throw new HubError("invalid_design_presence", 400);
    holder.presence = next; holder.updatedAt = this.now();
    if (!live.presenceTimer) live.presenceTimer = setTimeout(() => { live.presenceTimer = undefined; if (this.live.get(live.record.shareId) === live) this.peers(live); }, this.limits.presenceIntervalMs);
    return null;
  }
  private sweepStaged() { const now = this.now(); this.purgeStaged(item => item.expires < now); }
  private purgeStaged(match: (item: Staged) => boolean) {
    for (const [key, item] of this.staged) if (match(item)) { this.staged.delete(key); this.stagedBytes -= item.received; }
  }
  private async stage(peer: DesignSharePeer, request: Extract<DesignShareRequest, { op: "stage" }>) {
    await this.participant(peer, request.shareId, request.windowId, ["owner", "editor"]);
    this.sweepStaged();
    const key = `${request.shareId}\0${peer.userId}\0${request.sha256}`, bytes = Buffer.from(request.base64, "base64");
    let item = this.staged.get(key);
    if (item?.complete && item.size === request.size) { item.expires = this.now() + this.limits.stageTtlMs; return { received: item.size, complete: true }; }
    if (!item) {
      if (request.offset !== 0) throw new HubError("design_share_stage_order", 409);
      item = { shareId: request.shareId, userId: peer.userId, sha256: request.sha256, size: request.size, parts: [], received: 0, complete: false, expires: 0 };
      this.staged.set(key, item);
    }
    const entry = item;
    if (entry.size !== request.size || bytes.length > this.limits.chunkBytes) { this.purgeStaged(found => found === entry); throw new HubError("design_share_stage_order", 409); }
    // A chunk already received (a retry after an unknown outcome, or the same
    // person's other window uploading the same content) is acknowledged, never
    // allowed to discard the upload in progress.
    if (request.offset + bytes.length <= entry.received && !(bytes.length === 0 && entry.size !== 0)) { entry.expires = this.now() + this.limits.stageTtlMs; return { received: entry.received, complete: entry.complete }; }
    if (request.offset !== entry.received || entry.received + bytes.length > entry.size || bytes.length === 0 && entry.size !== 0) throw new HubError("design_share_stage_order", 409);
    const mine = [...this.staged.values()].filter(found => found.userId === peer.userId).reduce((sum, found) => sum + found.received, 0);
    if (mine + bytes.length > this.limits.stagedBytesPerUser || this.stagedBytes + bytes.length > this.limits.stagedBytesTotal) { this.purgeStaged(found => found === entry); throw new HubError("design_share_stage_full", 429); }
    entry.parts.push(bytes); entry.received += bytes.length; this.stagedBytes += bytes.length; entry.expires = this.now() + this.limits.stageTtlMs;
    if (entry.received === entry.size) {
      const whole = Buffer.concat(entry.parts);
      if (createHash("sha256").update(whole).digest("hex") !== entry.sha256) { this.purgeStaged(found => found === entry); throw new HubError("design_share_blob_corrupt", 400); }
      entry.parts = [whole]; entry.complete = true;
    }
    return { received: entry.received, complete: entry.complete };
  }
  private async commit(peer: DesignSharePeer, requestId: string, request: Extract<DesignShareRequest, { op: "commit" }>) {
    const { live, join, key } = await this.participant(peer, request.shareId, request.windowId, ["owner", "editor"]);
    this.sweepStaged();
    const allowed = new Set<string>();
    for (const entry of Object.values(request.files)) if ("sha256" in entry) {
      const staged = this.staged.get(`${request.shareId}\0${peer.userId}\0${entry.sha256}`);
      if (staged?.complete) { if (staged.size !== entry.size) throw new HubError("design_share_blob_mismatch", 400); allowed.add(entry.sha256); }
    }
    const result = await this.dispatch(live, join, key, requestId, "commit", { baseRevision: request.baseRevision, files: request.files }, true, ["owner", "editor"], allowed);
    this.purgeStaged(item => item.shareId === request.shareId && item.userId === peer.userId && allowed.has(item.sha256));
    return result;
  }
  private async call(peer: DesignSharePeer, requestId: string, request: Extract<DesignShareRequest, { op: "call" }>) {
    const roles = callRoles(request.call), { live, join, key } = await this.participant(peer, request.shareId, request.windowId, roles);
    return this.dispatch(live, join, key, requestId, "call", { call: request.call, payload: request.payload }, !DESIGN_SHARE_READ_CALLS.includes(request.call), roles);
  }
  private async fetch(peer: DesignSharePeer, requestId: string, request: Extract<DesignShareRequest, { op: "fetch" }>) {
    const { live, join, key } = await this.participant(peer, request.shareId, request.windowId, ALL_ROLES);
    const chunk = designShareChunkSchema.safeParse(await this.dispatch(live, join, key, requestId, "fetch", { sha256: request.sha256, offset: request.offset }, false, ALL_ROLES));
    if (!chunk.success || chunk.data.sha256 !== request.sha256 || chunk.data.offset !== request.offset || Buffer.byteLength(chunk.data.base64, "base64") > this.limits.chunkBytes) throw new HubError("design_share_bad_chunk", 502);
    return chunk.data;
  }
  private dispatch(live: Live, join: Join, joinKey: string, requestId: string, kind: Dispatch["kind"], payload: unknown, mutating: boolean, roles: readonly DesignShareParticipantRole[], allowed = new Set<string>()): Promise<unknown> {
    const source = live.source;
    if (!source || !source.peer.active()) throw new HubError("design_share_source_offline", 409);
    if ([...live.dispatches.values()].filter(item => item.userId === join.userId).length >= this.limits.inflightPerUser) throw new HubError("design_share_busy", 429);
    const dispatchId = `d_${hex(12)}`, deadline = this.now() + this.limits.dispatchTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failDispatch(live, dispatchId, "design_share_timeout"), this.limits.dispatchTimeoutMs);
      live.dispatches.set(dispatchId, { kind, mutating, roles, userId: join.userId, joinKey, epoch: live.epochs.get(join.userId) ?? 0, binding: source.peerId, admitted: false, allowed, resolve, reject, timer });
      void source.peer.send({ v: 1, type: "design.share.dispatch", shareId: live.record.shareId, generation: live.record.generation, dispatchId, deadline,
        from: { userId: join.userId, name: join.name, role: join.role, requestId }, kind, payload }).catch(() => this.failDispatch(live, dispatchId, "design_share_source_offline"));
    });
  }
  private failDispatch(live: Live, dispatchId: string, code: string) {
    const dispatch = live.dispatches.get(dispatchId);
    if (!dispatch) return;
    live.dispatches.delete(dispatchId); clearTimeout(dispatch.timer);
    // An admitted write may already be durable on the source: "unknown", never "not executed".
    dispatch.reject(new HubError(dispatch.mutating && (dispatch.admitted || code === "design_share_timeout") ? "design_share_outcome_unknown" : code, 409));
    if (live.source) void live.source.peer.send({ v: 1, type: "design.share.cancel", shareId: live.record.shareId, dispatchId, reason: code }).catch(() => undefined);
  }
  private failDispatches(live: Live, code: string, match: (dispatch: Dispatch) => boolean = () => true) {
    for (const [id, dispatch] of [...live.dispatches]) if (match(dispatch)) this.failDispatch(live, id, code);
  }
  private sourceOf(peer: DesignSharePeer, shareId: string, windowId: string) {
    const live = this.live.get(shareId);
    if (!live || live.record.state !== "open") throw new HubError("design_share_closed", 410);
    if (live.source?.peer.key !== peer.key || live.source.windowId !== windowId) throw forbidden("design_share_not_source");
    return live;
  }
  private dispatchFor(live: Live, dispatchId: string) {
    const dispatch = live.dispatches.get(dispatchId);
    if (!dispatch || dispatch.binding !== live.source?.peerId) throw new HubError("design_share_dispatch_gone", 409);
    return dispatch;
  }
  private async pull(peer: DesignSharePeer, request: Extract<DesignShareRequest, { op: "pull" }>) {
    const live = this.sourceOf(peer, request.shareId, request.windowId), dispatch = this.dispatchFor(live, request.dispatchId);
    if (dispatch.kind !== "commit" || !dispatch.allowed.has(request.sha256)) throw new HubError("design_share_blob_unavailable", 404);
    const staged = this.staged.get(`${request.shareId}\0${dispatch.userId}\0${request.sha256}`);
    if (!staged?.complete || request.offset > staged.size) throw new HubError("design_share_blob_unavailable", 404);
    const bytes = staged.parts[0].subarray(request.offset, request.offset + this.limits.chunkBytes);
    return { sha256: request.sha256, size: staged.size, offset: request.offset, base64: bytes.toString("base64"), eof: request.offset + bytes.length >= staged.size };
  }
  /** The commit point: everything the requester needed at dispatch must still hold now. */
  private async admit(peer: DesignSharePeer, request: Extract<DesignShareRequest, { op: "admit" }>) {
    const live = this.sourceOf(peer, request.shareId, request.windowId), dispatch = this.dispatchFor(live, request.dispatchId);
    if (dispatch.admitted) return { admitted: true };
    const join = live.joins.get(dispatch.joinKey), fail = (code: string) => { this.failDispatch(live, request.dispatchId, code); return new HubError(code, 409); };
    if (!join?.peer.active()) throw fail("design_share_requester_gone");
    if ((live.epochs.get(dispatch.userId) ?? 0) !== dispatch.epoch) throw fail("design_share_role_changed");
    try { await this.port.requireMember(dispatch.userId, live.record.conversationId); } catch { await this.revokeMember(live.record.conversationId, dispatch.userId); throw new HubError("design_share_not_member", 403); }
    // The role this exact request needs (a comment write, db.write or restore), not merely any role.
    const role = this.currentRole(live, dispatch.userId);
    if (!role || !dispatch.roles.includes(role) || live.dispatches.get(request.dispatchId) !== dispatch) throw fail("design_share_role_changed");
    dispatch.admitted = true;
    return { admitted: true };
  }
  private reply(peer: DesignSharePeer, request: Extract<DesignShareRequest, { op: "reply" }>) {
    const live = this.sourceOf(peer, request.shareId, request.windowId), dispatch = live.dispatches.get(request.dispatchId);
    if (!dispatch || dispatch.binding !== live.source?.peerId) return { late: true };
    let result = request.result;
    try {
      if (request.ok && request.part) {
        const next = appendDesignShareResult(dispatch.parts, request.part, this.availableResultBytes());
        dispatch.parts = next.buffer;
        if (!next.complete) return { partial: true };
        result = next.value;
      } else if (request.ok && dispatch.parts) throw new Error("design_share_bad_chunk");
    } catch (error) {
      this.failDispatch(live, request.dispatchId, error instanceof Error ? error.message : "design_share_bad_chunk");
      return { rejected: true };
    }
    live.dispatches.delete(request.dispatchId); clearTimeout(dispatch.timer);
    // A definite source refusal has not written anything and needs no admission.
    const refused = dispatch.kind === "call" && isDesignShareRefusal(result);
    if (request.ok && dispatch.mutating && !dispatch.admitted && !refused) dispatch.reject(new HubError("design_share_outcome_unknown", 409));
    else if (request.ok) dispatch.resolve(result ?? null);
    else {
      let code = request.error && /^[a-z0-9_]{1,128}$/.test(request.error) ? request.error : "design_share_failed";
      // These belong to the source's transport, never the participant's join.
      if (code === "design_share_app_unavailable" || code === "design_share_not_joined") code = "design_share_source_offline";
      dispatch.reject(new HubError(code, 409));
    }
    return null;
  }
  /** Under the share's lock: a change can never land after (and overwrite) a close. */
  private async changed(peer: DesignSharePeer, request: Extract<DesignShareRequest, { op: "changed" }>) {
    const live = this.sourceOf(peer, request.shareId, request.windowId);
    if (request.revision < live.record.revision) return { stale: true };
    if (request.revision > live.record.revision) {
      // The revision is advisory (the source is the authority) but persisted in order.
      const next: DesignShareRecord = { ...live.record, revision: request.revision, updatedAt: this.now() };
      await this.port.repository.put(next);
      if (this.live.get(request.shareId) !== live || live.record.state !== "open") throw new HubError("design_share_closed", 410);
      live.record = { ...next, members: live.record.members };
    }
    if (Object.keys(request.files).length) this.emit(live, { type: "changed", revision: request.revision, files: request.files, ...(request.by ? { by: request.by } : {}) }, false);
    if (request.comments) this.emit(live, { type: "comments" }, false);
    return null;
  }

  // ---- fan-out and lifecycle ------------------------------------------------
  private send(live: Live, peer: DesignSharePeer, event: DesignShareEvent) {
    if (event.type === "changed") event = { ...event, files: Object.fromEntries(Object.entries(event.files).filter(([path]) => {
      const owner = /^project\/db\/data\/users\/([^/]+)\//.exec(path)?.[1];
      return owner === undefined || owner === peer.userId;
    })) };
    void peer.send({ v: 1, type: "design.share.event", shareId: live.record.shareId, generation: live.record.generation, event }).catch(() => undefined);
  }
  private emit(live: Live, event: DesignShareEvent, includeSource = true) {
    for (const join of live.joins.values()) if (join.peer.active()) this.send(live, join.peer, event);
    if (includeSource && live.source?.peer.active() && event.type !== "source") this.send(live, live.source.peer, event);
  }
  private peers(live: Live) {
    const named = (presence: Record<string, unknown>, name: string) => ({ ...presence, who: { ...(typeof presence.who === "object" && presence.who ? presence.who as object : {}), n: name } });
    const peers: DesignSharePeerView[] = [...live.joins.values()].map(join => ({ peer: join.peerId, userId: join.userId, name: join.name, role: join.role, source: false, presence: named(join.presence, join.name), updatedAt: join.updatedAt }));
    if (live.source) peers.push({ peer: live.source.peerId, userId: live.record.ownerUserId, name: live.source.name, role: "owner", source: true, presence: named(live.source.presence, live.source.name), updatedAt: live.source.updatedAt });
    this.emit(live, { type: "peers", peers });
  }
  /** Socket closed, session revoked or reset: every window of that connection leaves. */
  disconnect(peer: DesignSharePeer) {
    this.sweepStaged();
    for (const live of this.live.values()) {
      if (live.source?.peer.key === peer.key) { live.source = undefined; this.failDispatches(live, "design_share_source_offline"); this.emit(live, { type: "source", online: false, revision: live.record.revision }); }
      let left = false;
      for (const [key, join] of live.joins) if (join.peer.key === peer.key) { live.joins.delete(key); left = true; this.failDispatches(live, "design_share_requester_gone", dispatch => dispatch.joinKey === key && !dispatch.admitted); }
      if (left || !live.source) this.peers(live);
    }
  }
  /** A user left or was removed from the conversation: their grants are deleted (re-adding does not restore them), and an owner's shares close. */
  async revokeMember(conversationId: string, userId: string) {
    for (const record of await this.port.repository.byConversation(conversationId)) {
      if (record.state !== "open") continue;
      await this.serial(record.shareId, async () => {
        const live = await this.loadLive(record.shareId);
        if (live.record.state !== "open") return;
        if (live.record.ownerUserId === userId) { await this.retire(live, "membership"); return; }
        if (userId in live.record.members) {
          const members = { ...live.record.members }; delete members[userId];
          live.record = { ...live.record, members, updatedAt: this.now() }; await this.port.repository.put(live.record);
        }
        this.revokeSessions(live, userId, "membership");
      });
    }
  }
  close() {
    this.closed = true;
    for (const live of this.live.values()) { this.failDispatches(live, "design_share_host_stopping"); if (live.presenceTimer) clearTimeout(live.presenceTimer); }
    this.live.clear(); this.staged.clear(); this.stagedBytes = 0;
  }
}
