import { isDesignShareRefusal, appendDesignShareResult, encodeDesignShareResult, splitDesignShareResult, type DesignShareResultBuffer } from "../../src/client-protocol/workbench-design-sharing-result.js";
import { designShareRequestFrameSchema, DESIGN_SHARE_READ_CALLS, DESIGN_SHARE_LIMITS, sanitizeDesignPresence, type DesignShareCall, type DesignShareDispatchFrame, type DesignShareEvent, type DesignSharePeerView, type DesignShareRequest, type DesignShareRequestFrame, type DesignShareServerFrame } from "../../src/client-protocol/workbench-design-sharing.js";
import { decodeDesignFile, encodeDesignFile, validateDesignDocument, type DesignDocument, type DesignFile } from "./workbench-design.js";
import { DesignSession } from "./workbench-design-session.js";
import type { DesignRole } from "./workbench-design-comments.js";

// Client side of authenticated Baoyu collaboration. Frames ride the existing,
// authenticated App socket (Root wires `DesignShareTransport` in connection.ts);
// the Host broker re-checks identity, membership and grants. The source device
// applies everything through its own DesignSession, so CAS, receipts, history
// and comment identity stay exactly as for local edits. There is no offline
// copy for participants: with the source offline, their writes fail.

export { sanitizeDesignPresence as sanitizePresencePatch } from "../../src/client-protocol/workbench-design-sharing.js";
export interface DesignShareTransport {
  send(frame: DesignShareRequestFrame): void | Promise<unknown>;
  onFrame(listener: (frame: DesignShareServerFrame) => void): () => void;
  /** Connection online/offline; offline retires every share session at once. */
  onStatus?(listener: (online: boolean) => void): () => void;
}
export class DesignShareError extends Error { constructor(readonly code: string) { super(code); } }
const newId = () => crypto.randomUUID();

/** Request/response correlation and event routing for one App connection. */
export class DesignShareClient {
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; mutating: boolean; timer: ReturnType<typeof setTimeout>; parts?: DesignShareResultBuffer }>();
  private listeners = new Set<(frame: DesignShareServerFrame) => void>();
  private statusListeners = new Set<(online: boolean) => void>();
  private stop: () => void;
  private stopStatus: () => void;
  private outgoingReplyBytes = 0;
  private disposed = false;
  private live = true;
  constructor(private readonly transport: DesignShareTransport, private readonly timeoutMs = 30_000) {
    this.stopStatus = transport.onStatus?.(online => {
      this.live = online;
      if (!online) this.abortPending("design_share_outcome_unknown");
      for (const listener of [...this.statusListeners]) { try { listener(online); } catch { /* One window cannot block another. */ } }
    }) ?? (() => {});
    this.stop = transport.onFrame(frame => {
      if (frame.type === "design.share.result") {
        const task = this.pending.get(frame.requestId); if (!task) return;
        let result = frame.result;
        try {
          if (frame.ok && frame.part) {
            const next = appendDesignShareResult(task.parts, frame.part, this.availableResultBytes());
            task.parts = next.buffer;
            if (!next.complete) return;
            result = next.value;
          } else if (frame.ok && task.parts) throw new Error("design_share_bad_chunk");
          frame.ok ? task.resolve(result ?? null) : task.reject(new DesignShareError(task.mutating && task.parts ? "design_share_outcome_unknown" : frame.error ?? "design_share_failed"));
        } catch (error) { task.reject(new DesignShareError(task.mutating ? "design_share_outcome_unknown" : error instanceof Error ? error.message : "design_share_bad_chunk")); }
        this.pending.delete(frame.requestId); clearTimeout(task.timer);
        return;
      }
      for (const listener of [...this.listeners]) { try { listener(frame); } catch { /* One window cannot block another. */ } }
    });
  }
  private availableResultBytes() { return DESIGN_SHARE_LIMITS.resultBufferBytes - this.outgoingReplyBytes - [...this.pending.values()].reduce((n, task) => n + (task.parts?.size ?? 0), 0); }
  /** All source windows on this connection share the same bounded transfer budget. */
  reserveReply(bytes: number) {
    if (bytes > this.availableResultBytes()) throw new DesignShareError("design_share_reply_busy");
    this.outgoingReplyBytes += bytes;
    let held = true;
    return () => { if (held) { held = false; this.outgoingReplyBytes -= bytes; } };
  }
  /** Resolves with the Host result; rejects with DesignShareError(code). A timeout is "unknown", never "not executed". */
  request(request: DesignShareRequest, requestId: string = newId()): Promise<unknown> {
    if (this.disposed) return Promise.reject(new DesignShareError("design_share_closed"));
    // One owner per request id: a duplicate is refused before anything is sent.
    if (this.pending.has(requestId)) return Promise.reject(new DesignShareError("design_share_request_pending"));
    const parsed = designShareRequestFrameSchema.safeParse({ v: 1, type: "design.share.request", requestId, request });
    if (!parsed.success) return Promise.reject(new DesignShareError(parsed.error.issues.some(issue => issue.message === "design_share_payload_too_large") ? "design_share_payload_too_large" : "invalid_design_share_request"));
    return new Promise((resolve, reject) => {
      // Settle only this exact task: a late timer or send failure of an earlier
      // request must not remove a retry that reuses the same id.
      const task: { resolve(value: unknown): void; reject(error: Error): void; mutating: boolean; timer: ReturnType<typeof setTimeout> } = { resolve, reject,
        mutating: request.op === "commit" || request.op === "call" && !DESIGN_SHARE_READ_CALLS.includes(request.call), timer: setTimeout(() => settle("design_share_outcome_unknown"), this.timeoutMs) };
      this.pending.set(requestId, task);
      const settle = (code: string) => { if (this.pending.get(requestId) !== task) return; this.pending.delete(requestId); clearTimeout(task.timer); reject(new DesignShareError(code)); };
      let sent: void | Promise<unknown>;
      // A transport that refuses synchronously (offline, read-only) never sent the frame.
      try { sent = this.transport.send(parsed.data); }
      catch (error) { settle(error instanceof Error && /^[a-z0-9_]{1,128}$/.test(error.message) ? error.message : "design_share_app_unavailable"); return; }
      // An asynchronous send failure may have reached the Host: unknown, never "not executed".
      Promise.resolve(sent).catch(() => settle("design_share_outcome_unknown"));
    });
  }
  /** The socket dropped: every request that may have reached the Host is now unknown. Reconcile by re-reading. */
  abortPending(code = "design_share_outcome_unknown") {
    for (const [id, task] of [...this.pending]) { this.pending.delete(id); clearTimeout(task.timer); task.reject(new DesignShareError(code)); }
  }
  on(listener: (frame: DesignShareServerFrame) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** False after the connection dropped, until it is online again. */
  get online() { return this.live; }
  onStatus(listener: (online: boolean) => void) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }
  dispose() { this.disposed = true; this.stop(); this.stopStatus(); this.statusListeners.clear(); for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new DesignShareError("design_share_closed")); } this.pending.clear(); this.listeners.clear(); }
}
const toBase64 = (bytes: Uint8Array) => { let binary = ""; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary); };
/** Reassembles a chunked transfer and verifies its sha256 by re-encoding. */
async function chunked(read: (offset: number) => Promise<unknown>, sha256: string, size: number, contentType: string): Promise<DesignFile> {
  const parts: Uint8Array[] = []; let received = 0;
  for (;;) {
    const chunk = await read(received) as { base64: string; offset: number; eof: boolean; contentType?: string };
    if (chunk.offset !== received) throw new DesignShareError("design_share_bad_chunk");
    const bytes = decodeDesignFile({ base64: chunk.base64 }); parts.push(bytes); received += bytes.length;
    if (received > size) throw new DesignShareError("design_share_bad_chunk");
    if (chunk.eof || received === size) break;
    if (!bytes.length) throw new DesignShareError("design_share_bad_chunk");
  }
  const whole = new Uint8Array(received); let at = 0; for (const part of parts) { whole.set(part, at); at += part.length; }
  const file = encodeDesignFile(whole, contentType);
  if (file.sha256 !== sha256 || file.size !== size) throw new DesignShareError("design_share_blob_corrupt");
  return file;
}

/** The owner's window that holds a shared document: answers relayed requests. */
export class DesignShareSource {
  private cancelled = new Set<string>();
  private stops: (() => void)[] = [];
  /** Serving through the Host now (false after a disconnect or detach until `resume`). */
  attached = true;
  constructor(private readonly client: DesignShareClient, private readonly session: DesignSession, readonly shareId: string, readonly windowId: string) {}
  start() {
    // The Host drops this binding with the socket; nothing is served until an explicit re-attach.
    this.stops.push(this.client.onStatus(online => { if (!online) this.attached = false; }));
    this.stops.push(this.client.on(frame => {
      if (frame.type === "design.share.dispatch" && frame.shareId === this.shareId) void this.handle(frame);
      if (frame.type === "design.share.cancel" && frame.shareId === this.shareId) this.cancelled.add(frame.dispatchId);
    }));
    // Every committed save (local typing, Bot, restore, relayed) is announced once.
    this.stops.push(this.session.onSaved((before, next, author) => {
      const files: Record<string, string | null> = {};
      for (const path of new Set([...Object.keys(before.files), ...Object.keys(next.files)])) if (before.files[path]?.sha256 !== next.files[path]?.sha256) files[path] = next.files[path]?.sha256 ?? null;
      void this.client.request({ op: "changed", shareId: this.shareId, windowId: this.windowId, revision: next.revision, files, ...(author ? { by: { id: author.user.id.slice(0, 200), name: author.user.name.slice(0, 100), ...(author.by === "agent" ? { agent: true as const } : {}) } } : {}) }).catch(() => undefined);
    }));
    this.stops.push(this.session.onEvent(event => { if (event.type === "comments") void this.client.request({ op: "changed", shareId: this.shareId, windowId: this.windowId, revision: this.session.document.revision, files: {}, comments: true }).catch(() => undefined); }));
    return this;
  }
  private async handle(frame: DesignShareDispatchFrame) {
    const { dispatchId } = frame, base = { shareId: this.shareId, windowId: this.windowId, dispatchId };
    const admit = async () => {
      if (this.cancelled.has(dispatchId) || Date.now() > frame.deadline) throw new DesignShareError("design_share_cancelled");
      await this.client.request({ op: "admit", ...base });
      if (this.cancelled.has(dispatchId)) throw new DesignShareError("design_share_cancelled");
    };
    const pull = (sha256: string, size: number, contentType: string) => chunked(offset => this.client.request({ op: "pull", ...base, sha256, offset }), sha256, size, contentType);
    let releaseReply: (() => void) | undefined, writeResult = false;
    try {
      const result = await this.session.requestForShare({ kind: frame.kind, payload: frame.payload, from: { userId: frame.from.userId, name: frame.from.name, role: frame.from.role as DesignRole, requestId: frame.from.requestId }, admit, pull });
      writeResult = frame.kind === "commit" || frame.kind === "call" && !DESIGN_SHARE_READ_CALLS.includes((frame.payload as { call: DesignShareCall }).call) && !isDesignShareRefusal(result);
      const bytes = encodeDesignShareResult(result);
      if (bytes.length <= DESIGN_SHARE_LIMITS.resultInlineBytes) await this.client.request({ op: "reply", ...base, ok: true, result: result ?? null });
      else {
        releaseReply = this.client.reserveReply(bytes.length);
        for (const part of splitDesignShareResult(bytes)) {
          if (this.cancelled.has(dispatchId) || this.retired || Date.now() > frame.deadline) throw new DesignShareError("design_share_cancelled");
          const ack = await this.client.request({ op: "reply", ...base, ok: true, part }) as { late?: boolean; rejected?: boolean } | null;
          if (ack?.late || ack?.rejected) break;
        }
      }
    } catch (error) {
      const code = writeResult ? "design_share_outcome_unknown" : error instanceof Error && /^[a-z0-9_]{1,128}$/.test(error.message) ? error.message : "design_share_failed";
      await this.client.request({ op: "reply", ...base, ok: false, error: code }).catch(() => undefined);
    } finally { releaseReply?.(); this.cancelled.delete(dispatchId); }
  }
  private retired = false;
  private attaching?: Promise<unknown>;
  /** True once stop() ran: this instance never serves or attaches again. */
  get stopped() { return this.retired; }
  private live() { if (this.retired) throw new DesignShareError("design_share_source_stopped"); }
  /** After the App socket reconnects: serve this share again from this window.
   * Pause/close/forget may run during any await here; a stopped instance never attaches. */
  async resume() {
    this.live(); await this.session.flush();
    this.live(); const revision = (await this.session.refresh()).revision;
    this.live();
    const attaching = this.client.request({ op: "attach", shareId: this.shareId, windowId: this.windowId, revision }); this.attaching = attaching;
    try { const view = await attaching; this.live(); this.attached = true; return view; }
    finally { if (this.attaching === attaching) this.attaching = undefined; }
  }
  /** Stops answering at once; `detach` tells the Host this window no longer serves the share (grants remain).
   * An attach already on the wire is awaited first, so the Host never ends up attached to a stopped source. */
  async stop(detach = true) {
    this.retired = true;
    for (const stop of this.stops.splice(0)) stop();
    this.attached = false;
    const attaching = this.attaching; if (attaching) await attaching.catch(() => undefined);
    if (detach) await this.client.request({ op: "detach", shareId: this.shareId, windowId: this.windowId }).catch(() => undefined);
  }
}
/** Owner action (an explicit click): share this document and serve it from this window. */
export async function openDesignShare(client: DesignShareClient, session: DesignSession, input: { conversationId: string; windowId: string; title: string }, options: { live?(): boolean } = {}) {
  await session.flush();
  const document = await session.refresh(), format = document.format ?? "canvas";
  // Dropped (window closed, design deleted) while saving: nothing reaches the Host.
  if (options.live && !options.live()) throw new DesignShareError("design_share_source_stopped");
  // Sharing is offered for canvas and PPT documents only.
  if (format !== "canvas" && format !== "slides") throw new DesignShareError("design_share_format_unsupported");
  // Another owner device can end this share before its open reply arrives.
  // Observe that interval too; a late reply cannot resurrect a closed source.
  const ended = new Set<string>();
  const stop = client.on(frame => { if (frame.type === "design.share.event" && frame.event.type === "revoked") ended.add(frame.shareId); });
  try {
    const view = await client.request({ op: "open", conversationId: input.conversationId, designId: document.id, windowId: input.windowId, title: input.title.slice(0, 128) || "Design", format, revision: document.revision }) as { shareId: string };
    if (ended.has(view.shareId)) throw new DesignShareError("design_share_source_stopped");
    return { view, source: new DesignShareSource(client, session, view.shareId, input.windowId).start() };
  } finally { stop(); }
}

export type DesignShareMirrorState = { role: DesignRole; disconnected: boolean; revoked: boolean; sourceOnline: boolean; peers: DesignSharePeerView[] };
export type DesignShareMirror = { session: DesignSession; role: () => DesignRole; state: () => DesignShareMirrorState; onChange(listener: () => void): () => void;
  /** Saves the editor's last changes while still joined, then leaves. A failed save throws and keeps the copy joined; `discard` leaves without saving. */
  leave(options?: { discard?: boolean }): Promise<void>; resume(): Promise<void> };
/** A joined copy re-reads the source's manifest only after a change, its own commit, a reconnect, or this long. */
export const DESIGN_SHARE_MIRROR_TTL_MS = 15_000;
/**
 * Joins a share from another device or member and returns a DesignSession that
 * the existing editor frame can use unchanged. Reads come from the source;
 * saves stage new content in chunks and commit with per-file CAS there.
 */
export async function joinDesignShare(client: DesignShareClient, input: { shareId: string; windowId: string; user: () => { id: string; name: string } | undefined; title?: () => string; onEvent?(event: DesignShareEvent): void }): Promise<DesignShareMirror> {
  const { shareId, windowId } = input;
  let role: DesignRole = "viewer", generation = 0, revoked = false, session: DesignSession | undefined;
  let current: DesignDocument | undefined, stale = true, loadedAt = 0, disconnected = false, sourceOnline = true, peers: DesignSharePeerView[] = [];
  let loadEpoch = 0, roleObserved = false, sourceObserved = false;
  const invalidate = () => { stale = true; loadEpoch++; };
  // Content cache by SHA, bounded to what the current document references:
  // superseded versions and bytes of a refused save are dropped (re-fetched if needed).
  const cache = new Map<string, DesignFile>(), changeListeners = new Set<() => void>();
  const keepOnly = (...documents: (DesignDocument | undefined)[]) => {
    const active = new Set(documents.flatMap(document => document ? Object.values(document.files).map(file => file.sha256) : []));
    for (const sha of [...cache.keys()]) if (!active.has(sha)) cache.delete(sha);
  };
  const changed = () => { for (const listener of [...changeListeners]) { try { listener(); } catch { /* One view cannot block another. */ } } };
  // A dropped connection retires this copy at once: no offline editing, no
  // silent rejoin. Recovery is an explicit `resume()` (join) by the App.
  const retire = () => { if (!disconnected) { disconnected = true; changed(); } };
  const requireJoined = () => {
    if (revoked) throw new DesignShareError("design_share_revoked");
    if (disconnected || !client.online) { retire(); throw new DesignShareError("design_share_disconnected"); }
  };
  const joinedCall = async <T>(work: () => Promise<T>): Promise<T> => {
    requireJoined();
    try { return await work(); }
    catch (error) {
      if (error instanceof DesignShareError && (error.code === "design_share_not_joined" || error.code === "design_share_app_unavailable")) { retire(); throw new DesignShareError("design_share_disconnected"); }
      throw error;
    }
  };
  const call = (name: DesignShareCall, payload: unknown) => joinedCall(() => client.request({ op: "call", shareId, windowId, call: name, payload: payload ?? {} }));
  const fetchFile = async (sha256: string, size: number, contentType: string) => {
    const known = cache.get(sha256);
    if (known) return known.contentType === contentType ? known : encodeDesignFile(decodeDesignFile(known), contentType);
    const file = await chunked(offset => joinedCall(() => client.request({ op: "fetch", shareId, windowId, sha256, offset })), sha256, size, contentType);
    cache.set(sha256, file);
    return file;
  };
  const load = async (): Promise<DesignDocument> => {
    requireJoined();
    if (current && !stale && Date.now() - loadedAt < DESIGN_SHARE_MIRROR_TTL_MS) return current;
    for (let attempt = 0; ; attempt++) {
      const epoch = loadEpoch;
      try {
        const manifest = await call("list", {}) as { id: string; format: DesignDocument["format"]; revision: number; files: Record<string, { sha256: string; size: number; contentType: string }> };
        const files: DesignDocument["files"] = {};
        for (const [path, meta] of Object.entries(manifest.files)) files[path] = await fetchFile(meta.sha256, meta.size, meta.contentType);
        requireJoined();
        current = validateDesignDocument({ schema: 1, id: manifest.id, revision: manifest.revision, ...(manifest.format && manifest.format !== "canvas" ? { format: manifest.format } : {}), files, receipts: [] });
        // A change received during the fetch belongs to a newer snapshot. Keep
        // it stale so the queued refresh cannot mistake this older reply for it.
        stale = epoch !== loadEpoch; loadedAt = Date.now();
        return current;
      } catch (error) {
        requireJoined();
        // The source holds current bytes only: typing between list and fetch
        // can retire that SHA. Re-read the manifest, with a finite retry budget.
        if (attempt >= 2 || !(error instanceof DesignShareError) || error.code !== "design_share_blob_unavailable") throw error;
        invalidate();
      } finally { keepOnly(current, session?.document); }
    }
  };
  const persist = async (expected: number, next: DesignDocument) => {
    if (revoked) throw new DesignShareError("design_share_revoked");
    const before = session!.document;
    try { return await commitTo(expected, before, next); } catch (error) { keepOnly(before); throw error; }
  };
  const commitTo = async (expected: number, before: DesignDocument, next: DesignDocument) => {
    const entries: Record<string, unknown> = {};
    for (const path of new Set([...Object.keys(before.files), ...Object.keys(next.files)])) {
      const was = before.files[path], now = next.files[path];
      if (was?.sha256 === now?.sha256) continue;
      if (!now) { entries[path] = { delete: true, ifMatch: was!.sha256 }; continue; }
      if (!Object.values(before.files).some(file => file.sha256 === now.sha256)) {
        const bytes = decodeDesignFile(now);
        for (let offset = 0; offset < bytes.length || offset === 0; offset += DESIGN_SHARE_LIMITS.chunkBytes) {
          const at = offset;
          await joinedCall(() => client.request({ op: "stage", shareId, windowId, sha256: now.sha256, size: now.size, offset: at, base64: toBase64(bytes.subarray(at, at + DESIGN_SHARE_LIMITS.chunkBytes)) }));
          if (!bytes.length) break;
        }
        cache.set(now.sha256, now);
      }
      entries[path] = { sha256: now.sha256, size: now.size, contentType: now.contentType, ifMatch: was?.sha256 ?? null };
    }
    if (!Object.keys(entries).length) return;
    let committed = false;
    try { await joinedCall(() => client.request({ op: "commit", shareId, windowId, baseRevision: expected, files: entries as Extract<DesignShareRequest, { op: "commit" }>["files"] })); committed = true; }
    catch (error) { if (error instanceof DesignShareError && /conflict|revision/.test(error.code)) throw new Error("design_revision_conflict"); throw error; }
    finally { invalidate(); if (committed) keepOnly(next); else keepOnly(before); }
  };
  // Subscribe before joining or fetching: source changes and revocation can
  // arrive while either reply is on the wire, before a session exists.
  const stopStatus = client.onStatus(online => { if (!online) retire(); });
  const stop = client.on(frame => {
    if (frame.type !== "design.share.event" || frame.shareId !== shareId) return;
    if (frame.generation < generation) return;
    generation = frame.generation;
    const event = frame.event;
    if (event.type === "changed") { invalidate(); void session?.remoteChanged().catch(() => undefined); }
    else if (event.type === "source") { invalidate(); sourceObserved = true; sourceOnline = event.online; if (event.online && !disconnected) void session?.remoteChanged().catch(() => undefined); changed(); }
    else if (event.type === "comments") void session?.refreshComments().catch(() => undefined);
    else if (event.type === "role") { roleObserved = true; role = event.role; changed(); }
    else if (event.type === "revoked") { revoked = true; role = "viewer"; changed(); }
    else if (event.type === "peers") { peers = event.peers; changed(); }
    input.onEvent?.(event);
  });
  let joined = false;
  try {
    const view = await client.request({ op: "join", shareId, windowId }) as { role: DesignRole; sourceOnline?: boolean };
    joined = true;
    if (!roleObserved && !revoked) role = view.role;
    if (!sourceObserved) sourceOnline = view.sourceOnline !== false;
    session = new DesignSession(await load(), load, persist, () => {}, {
      // No sendToBot: a joined copy never opens Bot drafts (see DesignSession.noSend).
      user: input.user, role: () => role, title: input.title,
      forward: async (operation, payload) => {
        if (operation === "restore") return call("restore", payload);
        return call(operation as DesignShareCall, payload);
      },
      presence: async patch => { const clean = sanitizeDesignPresence(patch); if (!clean) return { status: 400, body: { code: "invalid_argument" } }; await joinedCall(() => client.request({ op: "presence", shareId, windowId, patch: patch as Record<string, unknown> })); return { status: 204, body: null }; },
    });
    if (stale) await session.remoteChanged();
  } catch (error) {
    stop(); stopStatus(); revoked = true; cache.clear();
    if (joined) await client.request({ op: "leave", shareId, windowId }).catch(() => undefined);
    throw error;
  }
  const mirror = session;
  return { session: mirror, role: () => role, state: () => ({ role, disconnected, revoked, sourceOnline, peers }),
    onChange: listener => { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
    leave: async ({ discard = false } = {}) => {
      // Explicit Leave saves first, while this copy may still write; only then revoke it.
      if (!discard) await mirror.flush();
      stop(); stopStatus(); revoked = true; mirror.discard(); cache.clear(); changed();
      await client.request({ op: "leave", shareId, windowId }).catch(() => undefined);
    },
    /** Explicit rejoin after the App connection is back (refused after revocation). */
    resume: async () => {
      if (revoked) throw new DesignShareError("design_share_revoked");
      const view = await client.request({ op: "join", shareId, windowId }) as { role: DesignRole; sourceOnline?: boolean };
      role = view.role; sourceOnline = view.sourceOnline !== false; disconnected = false; invalidate(); changed();
      await mirror.remoteChanged();
    } };
}

export type DesignShareView = { shareId: string; conversationId: string; designId: string; format: string; title: string; generation: number; ownerUserId: string; ownerName: string;
  role: "owner" | "editor" | "commenter" | "viewer"; revision: number; sourceOnline: boolean; onThisDevice?: boolean; members?: { userId: string; name: string; role: "editor" | "commenter" | "viewer" }[] };
export type DesignShareMember = { userId: string; name: string; you?: true };
type SourceEntry = { source: DesignShareSource; view: DesignShareView; conversationId: string; windowId: string; title: string };
/** What a listed share offers here. Grantees and the owner's other devices open it
 * (a source device cannot join its own share). The owner may also end it from any
 * of their devices, including a share whose document or window is gone. */
export function designShareListActions(view: Pick<DesignShareView, "role" | "onThisDevice">) {
  return { open: !view.onThisDevice, end: view.role === "owner" };
}
/** The Host no longer has this share open (ended here or elsewhere, or its tombstone expired). */
const shareEnded = (error: unknown) => error instanceof DesignShareError && (error.code === "design_share_closed" || error.code === "design_share_not_found");
/**
 * Keeps this connection's shared sources and joined copies alive across UI
 * re-renders. Owner sources re-attach (an explicit `attach`) when the App comes
 * back online; joined copies stay retired until the person rejoins.
 */
export class DesignShareManager {
  private sources = new Map<DesignSession, SourceEntry>();
  /** A source being stopped: a new share for the same document waits, so an old detach never hits its replacement. */
  private stopping = new Map<DesignSession, Promise<void>>();
  /** A first open still on the wire. pause/forget/close cancel it; it then cleans up instead of becoming a source. */
  private opening = new Map<DesignSession, { cancelled?: "detach" | "close"; done: Promise<unknown> }>();
  /** Bumped by every pause/forget/close: a share() begun before that never opens after it. */
  private epochs = new WeakMap<DesignSession, number>();
  private epoch(session: DesignSession) { return this.epochs.get(session) ?? 0; }
  private mirrors = new Map<string, { mirror: DesignShareMirror; view: DesignShareView; stop: () => void }>();
  private listeners = new Set<() => void>();
  private version = 0;
  constructor(readonly client: DesignShareClient) {
    client.onStatus(online => { if (online) void this.reattach(); this.changed(); });
    // Ended on another of the owner's devices: this window stops serving it. Joined
    // copies keep their own revoked state, so their viewer can still say so.
    client.on(frame => { if (frame.type === "design.share.event" && frame.event.type === "revoked") void this.ended(frame.shareId); });
    if (typeof window !== "undefined") window.addEventListener("pagehide", () => { void this.retireAll(); });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private changed() { this.version++; for (const listener of [...this.listeners]) { try { listener(); } catch { /* One view cannot block another. */ } } }
  sourceFor(session: DesignSession) { return this.sources.get(session); }
  mirrorFor(shareId: string) { return this.mirrors.get(shareId); }
  /** An explicit owner action: share this document and serve it from this window. */
  share(session: DesignSession, input: { conversationId: string; windowId: string; title: string }): Promise<DesignShareView> {
    // One share attempt per document at a time, registered before any await so a
    // pause/forget/close in the same tick still cancels it; a cancelled attempt
    // finishes its cleanup before the next one starts (no detach of a replacement).
    const epoch = this.epoch(session), stopped = () => new DesignShareError("design_share_source_stopped");
    const pending = this.opening.get(session);
    // The same live attempt: share its result (or its cancellation).
    if (pending && !pending.cancelled) return pending.done as Promise<DesignShareView>;
    // A new share after a cancellation waits for that cleanup; one that a later pause/forget/close overtook never opens.
    if (pending) return pending.done.catch(() => undefined).then(() => { if (this.epoch(session) !== epoch) throw stopped(); return this.share(session, input); });
    const ticket: { cancelled?: "detach" | "close"; done: Promise<unknown> } = { done: Promise.resolve() };
    const run = (async (): Promise<DesignShareView> => {
      await this.stopping.get(session);
      if (ticket.cancelled || this.epoch(session) !== epoch) throw stopped();
      const known = this.sources.get(session);
      if (known?.source.attached) return known.view;
      if (known) {
        try { known.view = await known.source.resume() as DesignShareView; this.changed(); return known.view; }
        catch (error) { if (!shareEnded(error)) throw error; await this.retire(session, known, false); }
        // That share is over (ended while this window was away): share again as a new one.
        if (ticket.cancelled || this.epoch(session) !== epoch) throw stopped();
      }
      const live = () => !ticket.cancelled && this.epoch(session) === epoch;
      const { view, source } = await openDesignShare(this.client, session, input, { live });
      if (!live()) {
        // The Host bound this window while the document was being dropped: undo
        // that here (close for a deletion, else detach) and never list the source.
        let closed = false;
        if (ticket.cancelled === "close") closed = await this.client.request({ op: "close", shareId: (view as DesignShareView).shareId }).then(() => true, () => false);
        await source.stop(!closed);
        throw stopped();
      }
      this.sources.set(session, { source, view: view as DesignShareView, ...input }); this.changed();
      return view as DesignShareView;
    })();
    ticket.done = run; this.opening.set(session, ticket);
    return run.finally(() => { if (this.opening.get(session) === ticket) this.opening.delete(session); });
  }
  /** Cancels a first open still on the wire (it cleans up when its reply arrives). */
  private cancelOpening(session: DesignSession, how: "detach" | "close") {
    this.epochs.set(session, this.epoch(session) + 1);
    const pending = this.opening.get(session); if (!pending) return;
    if (pending.cancelled !== "close") pending.cancelled = how;
  }
  async grant(session: DesignSession, userId: string, role: "editor" | "commenter" | "viewer" | null) {
    const entry = this.sources.get(session); if (!entry) throw new DesignShareError("design_share_not_shared");
    entry.view = await this.client.request({ op: "grant", shareId: entry.view.shareId, userId, role }) as DesignShareView; this.changed();
    return entry.view;
  }
  /** Stop serving from this window; the share and its grants remain for later. */
  async pause(session: DesignSession) { this.cancelOpening(session, "detach"); const entry = this.sources.get(session); if (!entry) return; await this.retire(session, entry, true); }
  /** End the share for everyone (a tombstone: it never reopens). */
  async close(session: DesignSession) {
    this.cancelOpening(session, "close");
    const entry = this.sources.get(session); if (!entry) return;
    await this.client.request({ op: "close", shareId: entry.view.shareId });
    if (this.sources.get(session) === entry) await this.retire(session, entry, false);
  }
  /** Owner action from a share list: end a share for everyone by its ID, also when no
   * window here holds its document (deleted while offline, another device's share).
   * The Host authorises owners only. A source this connection serves for it retires
   * only after the Host confirms; nothing changes when the request fails. */
  async closeShare(shareId: string) {
    await this.client.request({ op: "close", shareId });
    await this.ended(shareId);
  }
  /** The share is closed on the Host: retire any source this connection serves for it (no detach). */
  private async ended(shareId: string) {
    const served = [...this.sources].filter(([, entry]) => entry.view.shareId === shareId);
    await Promise.allSettled(served.map(([session, entry]) => this.retire(session, entry, false)));
    this.changed();
  }
  private async retire(session: DesignSession, entry: SourceEntry, detach: boolean) {
    // Leave the map first: a reconnect running now must not resume this entry.
    if (this.sources.get(session) === entry) this.sources.delete(session);
    this.changed();
    const stopping = entry.source.stop(detach); this.stopping.set(session, stopping);
    try { await stopping; } finally { if (this.stopping.get(session) === stopping) this.stopping.delete(session); }
  }
  async list(conversationId: string) { return ((await this.client.request({ op: "list", conversationId })) as { shares: DesignShareView[] }).shares; }
  async members(conversationId: string) { return ((await this.client.request({ op: "members", conversationId })) as { members: DesignShareMember[] }).members; }
  async join(view: DesignShareView, input: { windowId: string; user: () => { id: string; name: string } | undefined }) {
    const known = this.mirrors.get(view.shareId);
    if (known) { if (known.mirror.state().disconnected) await known.mirror.resume(); return known.mirror; }
    const mirror = await joinDesignShare(this.client, { shareId: view.shareId, windowId: input.windowId, user: input.user, title: () => view.title });
    this.mirrors.set(view.shareId, { mirror, view, stop: mirror.onChange(() => this.changed()) }); this.changed();
    return mirror;
  }
  /** Leaves a joined copy after saving its last edits. A failed save throws and keeps it joined and listed. */
  async leave(shareId: string, options: { discard?: boolean } = {}) {
    const entry = this.mirrors.get(shareId); if (!entry) return;
    await entry.mirror.leave(options);
    entry.stop(); if (this.mirrors.get(shareId) === entry) this.mirrors.delete(shareId); this.changed();
  }
  /** This window stops serving the document (window closed, session dropped); the share and grants remain. */
  async forget(session: DesignSession) { await this.pause(session); }
  private async reattach() {
    await Promise.allSettled([...this.sources].map(async ([session, entry]) => {
      try { const view = await entry.source.resume() as DesignShareView; if (this.sources.get(session) === entry) entry.view = view; }
      catch (error) { if (this.sources.get(session) !== entry) return; if (shareEnded(error)) await this.retire(session, entry, false); else entry.source.attached = false; }
    }));
    this.changed();
  }
  private async retireAll() {
    for (const session of [...this.opening.keys()]) this.cancelOpening(session, "detach");
    await Promise.allSettled([...this.sources].map(([session, entry]) => this.retire(session, entry, true)));
    // Page teardown: try to save, then leave regardless (the Host drops the join with the socket anyway).
    await Promise.allSettled([...this.mirrors.keys()].map(shareId => this.leave(shareId).catch(() => this.leave(shareId, { discard: true }))));
  }
}
const managers = new WeakMap<object, DesignShareManager>();
/** The connection's manager only if sharing was used (lifecycle hooks must not create one). */
export function existingDesignShareManager(owner: object) { return managers.get(owner); }
/** One manager per App connection (pass the connection object as `owner`). */
export function designShareManager(owner: object, client: DesignShareClient) {
  let manager = managers.get(owner);
  if (!manager) { manager = new DesignShareManager(client); managers.set(owner, manager); }
  return manager;
}

/**
 * Local lifecycle fence: once a document is deleted, reset or its access is
 * revoked, a late remote event for the same generation can never recreate it.
 */
export class DesignLifecycleFence {
  private retired = new Map<string, number>();
  retire(id: string, generation: number) { this.retired.set(id, Math.max(generation, this.retired.get(id) ?? -1)); }
  accepts(id: string, generation: number) { const retired = this.retired.get(id); return retired === undefined || generation > retired; }
}
export type { DesignRole };
