import type { AuthSession, HubAuth } from "./auth.js";
import { HubError, type AttachmentRow, type HubStore } from "./store.js";
import { SIDE_LEASE_MS, sideReplySchema, type SideAttachmentRef, type SideReply, type SideScope } from "../client-protocol/side.js";

type Entry = { scope: SideScope; session: AuthSession; botId: string; id: string; expiresAt: number };
type Input = { sideId?: string; requestId?: string; text?: string; revision?: number; attachments?: string[]; withAttachments?: boolean; withAudio?: boolean; withTools?: boolean; withDelivery?: boolean; delivery?: true; tools?: "inherited" };
/** Authenticated leases only. Side text remains in the worker, outside the journal. */
export class HubSideSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly timer: ReturnType<typeof setInterval>;
  private sweeping = false;
  constructor(private readonly store: HubStore, private readonly auth: HubAuth, private readonly call: (botId: string, method: string, params: unknown, timeoutMs?: number) => Promise<unknown>) {
    this.timer = setInterval(() => { void this.sweep(); }, 5000); this.timer.unref();
  }
  private async validate(session: AuthSession, conversationId: string, botId: string): Promise<void> {
    await this.auth.validateSession(session);
    await this.store.db.serial(async () => {
      await this.store.requireMember(session.userId, conversationId); await this.store.requireBot(botId, conversationId);
      const row = await this.store.db.get<{ type: string; archived: number; parent_id: string | null; bots: number }>("SELECT type,archived,parent_id,(SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id=c.id AND m.member_type='bot') AS bots FROM conversations c WHERE id=?", [conversationId]);
      if (!row || row.type !== "direct" || row.parent_id || row.archived || row.bots !== 1) throw new HubError("side_unavailable", 409);
    });
  }
  /** Only the caller's own completed, unretired uploads in this conversation.
   * Unknown, foreign and incomplete IDs are indistinguishable to the caller. */
  private async attachments(session: AuthSession, conversationId: string, ids: string[]): Promise<SideAttachmentRef[] | undefined> {
    const rows = await this.store.db.serial(() => this.store.db.all<AttachmentRow>("SELECT * FROM attachments a WHERE a.id IN (SELECT value FROM json_each(?)) AND a.owner_id=? AND a.conversation_id=? AND a.complete=1 AND NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id)", [JSON.stringify(ids), session.userId, conversationId]));
    const found = new Map(rows.map(row => [row.id, row]));
    if (new Set(ids).size !== ids.length || ids.some(id => !found.has(id))) return undefined;
    return ids.map(id => { const row = found.get(id)!; return { id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256 }; });
  }
  async request(session: AuthSession, conversationId: string, botId: string, method: string, raw: Input = {}): Promise<SideReply> {
    await this.validate(session, conversationId, botId);
    const scope = { userId: session.userId, deviceId: session.deviceId, conversationId };
    const { attachments: ids, withAttachments, withAudio, withTools, withDelivery, ...input } = raw;
    let forwarded: Record<string, unknown> = { ...input, ...(method === "side.status" && withDelivery ? { delivery: true } : {}), ...(method === "side.status" && withTools ? { tools: true } : {}), ...(method === "side.status" && withAttachments ? { attachments: true, ...(withAudio ? { audio: true } : {}) } : {}) };
    if (method === "side.ask" && ids?.length) {
      // Paths and metadata never come from the client: the Worker receives
      // Hub-resolved names, sizes and hashes, then fetches bytes itself.
      const refs = await this.attachments(session, conversationId, ids);
      if (!refs) return { ok: false, error: "attachment_unavailable" };
      forwarded = { ...forwarded, attachments: refs };
    }
    if (input.sideId) {
      const entry = this.entries.get(input.sideId);
      if (entry && (entry.botId !== botId || entry.scope.deviceId !== scope.deviceId || entry.scope.userId !== scope.userId || entry.scope.conversationId !== conversationId)) return { ok: false, error: "expired" };
      // A lost Hub lease entry does not prove that the worker already closed
      // the handle. Forward Close with the authenticated scope; Core checks it.
      if (!entry && method !== "side.close") return { ok: false, error: "expired" };
    }
    if (method === "side.open" && this.entries.size >= 64) return { ok: false, error: "limit_reached" };
    let result: SideReply;
    if (method === "side.close" && input.sideId) this.entries.delete(input.sideId);
    const call = async (params: Record<string, unknown>) => sideReplySchema.parse(await this.call(botId, method, { ...params, ...scope }, method === "side.close" ? 90_000 : undefined));
    try { result = await call(forwarded); }
    catch (error) {
      if (method !== "side.status") throw error;
      // An older strict Gateway rejects an opt-in flag. Drop the newest first
      // (delivery, tools, audio, then attachments) so the side entry survives with what that
      // Gateway really supports; the final checks still apply.
      const { delivery: _delivery, ...withoutDelivery } = forwarded, { tools: _tools, ...withoutTools } = withoutDelivery, { audio: _audio, ...withoutAudio } = withoutTools, { attachments: _optIn, ...plain } = withoutAudio;
      let fallback: SideReply | undefined;
      for (const params of [..."delivery" in forwarded ? [withoutDelivery] : [], ..."tools" in forwarded ? [withoutTools] : [], ..."audio" in forwarded ? [withoutAudio] : [], ..."attachments" in forwarded ? [plain] : []]) {
        try { fallback = await call(params); break; } catch { /* Try the next older shape. */ }
      }
      if (!fallback) return { ok: true, capability: { supported: false, concurrent: false, liveContext: false, tools: "none", reason: "unsupported" } };
      result = fallback;
    }
    if (method === "side.status" && !withDelivery && result.ok && result.capability?.delivery) {
      const { delivery: _unrequested, ...capability } = result.capability; result = { ...result, capability };
    }
    // A strict client that did not opt in must never receive the audio key.
    if (method === "side.status" && !withAudio && result.ok && result.capability?.attachments?.audio !== undefined) {
      const { audio: _unrequested, ...attachments } = result.capability.attachments;
      result = { ...result, capability: { ...result.capability, attachments } };
    }
    const id = result.ok ? result.view?.id ?? input.sideId : input.sideId;
    if (result.ok && result.view && method === "side.open") this.entries.set(result.view.id, { scope, session, botId, id: result.view.id, expiresAt: Date.now() + SIDE_LEASE_MS });
    try { await this.validate(session, conversationId, botId); }
    catch (error) { if (id) await this.close(id); throw error; }
    if (id && (method === "side.close" || !result.ok && result.error === "expired")) this.entries.delete(id);
    else if (id) { const entry = this.entries.get(id); if (entry) { entry.session = session; entry.expiresAt = Date.now() + SIDE_LEASE_MS; } }
    return result;
  }
  private async close(id: string): Promise<void> {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id);
    await this.call(entry.botId, "side.close", { ...entry.scope, sideId: id }, 2000).catch(() => undefined);
  }
  revoke(deviceId: string): void { for (const entry of this.entries.values()) if (entry.scope.deviceId === deviceId) void this.close(entry.id); }
  private async sweep(): Promise<void> {
    if (this.sweeping) return; this.sweeping = true;
    try {
      for (const entry of this.entries.values()) {
        try { if (entry.expiresAt <= Date.now()) throw new Error("expired"); await this.validate(entry.session, entry.scope.conversationId, entry.botId); }
        catch { await this.close(entry.id); }
      }
    } finally { this.sweeping = false; }
  }
  dispose(): void { clearInterval(this.timer); for (const id of this.entries.keys()) void this.close(id); }
}
