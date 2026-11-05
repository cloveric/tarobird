import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubError, HubStore } from "../src/hub/store.js";
import { DesignShareBroker, metaDesignShareRepository, type DesignSharePeer } from "../src/hub/workbench-design-sharing.js";
import type { DesignShareDispatchFrame, DesignShareEventFrame, DesignShareServerFrame } from "../src/client-protocol/workbench-design-sharing.js";
import { DesignShareClient, DesignShareManager, joinDesignShare, openDesignShare, type DesignShareTransport, type DesignShareView } from "../client/src/workbench-design-collaboration.js";
import { decodeDesignFile, designTextFile, encodeDesignFile, type DesignDocument } from "../client/src/workbench-design.js";
import { memoryDesign } from "../client/tests/design-session-fixture.js";

// The real broker on a real HubStore (SQLite users and conversation
// membership). Devices are in-process transports carrying the same frames a
// socket would; DesignSessions on both sides are the production classes. This
// is not a multi-device, browser or network acceptance test.
const text = (file: { base64: string }) => new TextDecoder().decode(decodeDesignFile(file));
const wire = (document: DesignDocument, file: string, content: string) => { const encoded = designTextFile(content, "text/plain"); return { [file]: { base64: encoded.base64, contentType: encoded.contentType, ifMatch: document.files[file]?.sha256 ?? null } }; };
type Device = ReturnType<typeof device>;
let broker: DesignShareBroker;
function device(userId: string, deviceId: string) {
  const frames: DesignShareServerFrame[] = [], listeners = new Set<(frame: DesignShareServerFrame) => void>();
  let alive = true, key: object = {};
  // The key is the authenticated connection; a reconnect is a new one.
  const peer: DesignSharePeer = { get key() { return key; }, userId, deviceId, active: () => alive,
    validate: async () => { if (!alive) throw new HubError("device_revoked", 401); },
    send: async frame => { if (!alive) return; frames.push(frame); for (const listener of [...listeners]) listener(frame); } };
  const calls: string[] = [], statuses = new Set<(online: boolean) => void>();
  // `gate` can hold one request on the wire (e.g. an attach) to order it against another action.
  let gate: ((op: string) => Promise<void> | undefined) | undefined;
  const transport: DesignShareTransport = { send: frame => { calls.push(frame.request.op === "call" ? `call:${frame.request.call}` : frame.request.op); if (!alive) throw new Error("design_share_app_unavailable");
    const deliver = () => void broker.handle(peer, frame).then(result => peer.send(result)), held = gate?.(frame.request.op); if (held) void held.then(deliver); else deliver(); },
    onFrame: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, onStatus: listener => { statuses.add(listener); return () => { statuses.delete(listener); }; } };
  const client = new DesignShareClient(transport, 5_000);
  return { peer, frames, client, calls, events: () => frames.filter((frame): frame is DesignShareEventFrame => frame.type === "design.share.event"),
    kill: () => { broker.disconnect(peer); alive = false; client.abortPending(); },
    reconnect: () => { broker.disconnect(peer); key = {}; alive = true; },
    /** The App connection drops/returns: what HubConnection reports to the share client. */
    setOnline: (online: boolean) => { broker.disconnect(peer); alive = online; if (online) key = {}; for (const listener of [...statuses]) listener(online); },
    gate: (value: typeof gate) => { gate = value; } };
}

describe("authenticated Baoyu sharing broker", () => {
  let directory: string, store: HubStore, conversationId: string, owner: Device, phone: Device, guest: Device, outsider: Device;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "hub-design-share-"));
    store = await HubStore.open(directory);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    await store.db.run("INSERT INTO users VALUES('guest','Guest','member'),('outsider','Outsider','member')");
    conversationId = (await store.createConversation("owner", ["bot"], "Share", "new")).id;
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversationId]);
    broker = new DesignShareBroker({ requireMember: (userId, conversation) => store.db.serial(() => store.requireMember(userId, conversation)), userName: async userId => (await store.user(userId))?.name, repository: metaDesignShareRepository(store.db) },
      { limits: { dispatchTimeoutMs: 2_000, presenceIntervalMs: 5 } });
    owner = device("owner", "mac"); phone = device("owner", "phone"); guest = device("guest", "guest-laptop"); outsider = device("outsider", "x");
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });
  const share = async (made = memoryDesign()) => ({ session: made.session, store: made.store, ...(await openDesignShare(owner.client, made.session, { conversationId, windowId: "w-src", title: "Deck" })) });

  it("does not disclose another user's private file names or hashes in change notifications", async () => {
    const made = await share(memoryDesign(undefined, { user: () => ({ id: "owner", name: "Owner" }) }));
    const shareId = (made.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    await guest.client.request({ op: "join", shareId, windowId: "w-guest" });
    await made.session.request("db.write", { op: "set", path: "data/users/me/preferences", data: { note: "owner-only fixture" } });
    await expect.poll(() => guest.events().filter(frame => frame.event.type === "changed").length).toBeGreaterThan(0);
    const events = guest.events().filter(frame => frame.event.type === "changed");
    expect(JSON.stringify(events)).not.toContain("project/db/data/users/owner/");
    expect(JSON.stringify(events)).not.toContain(made.store.design.files["project/db/data/users/owner/preferences.json"].sha256);
    const history = await guest.client.request({ op: "call", shareId, windowId: "w-guest", call: "history.list", payload: {} });
    expect(JSON.stringify(history)).not.toContain("project/db/data/users/owner/");
    expect(JSON.stringify(await made.session.historyList())).toContain("project/db/data/users/owner/");
  });

  it("cannot copy another user's private bytes into a public file by supplying their content hash", async () => {
    const made = await share(memoryDesign(undefined, { user: () => ({ id: "owner", name: "Owner" }) }));
    const shareId = (made.view as { shareId: string }).shareId;
    await made.session.request("db.write", { op: "set", path: "data/users/me/preferences", data: { note: "owner-only fixture" } });
    const privateFile = made.store.design.files["project/db/data/users/owner/preferences.json"];
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    await guest.client.request({ op: "join", shareId, windowId: "w-guest" });
    await expect(guest.client.request({ op: "commit", shareId, windowId: "w-guest", baseRevision: made.store.design.revision,
      files: { "project/copied.txt": { sha256: privateFile.sha256, size: privateFile.size, contentType: "text/plain", ifMatch: null } } }, "private-copy")).rejects.toThrow("design_share_blob_unavailable");
    expect(made.store.design.files["project/copied.txt"]).toBeUndefined();
  });

  it("preserves known write refusals and authorizes a successful no-op", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    await source.session.request("db.write", { op: "set", path: "polls/p1", data: { votes: 1 } });
    const mirror = await joinDesignShare(guest.client, { shareId, windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    expect(await mirror.session.request("db.write", { op: "set", path: "polls/p1", data: { votes: 2 } })).toMatchObject({ status: 409, body: { code: "conflict", current: { votes: 1 } } });
    expect(await mirror.session.request("db.write", { op: "delete", path: "polls/missing" })).toMatchObject({ status: 200 });
    expect(await mirror.session.request("db.write", { op: "set", path: "data/users/owner/x", data: { a: 1 } })).toMatchObject({ status: 403 });
    expect(await mirror.session.request("comments.reply", { id: "c_0123456789", text: "hi" })).toMatchObject({ status: 404 });
    expect(JSON.parse(text(source.store.design.files["project/db/polls/p1.json"]))).toEqual({ votes: 1 });
    await mirror.leave({ discard: true });
  });

  it("cancels an incomplete large source reply when its grant is removed", async () => {
    const made = await share(), shareId = made.view.shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
    await guest.client.request({ op: "join", shareId, windowId: "g" });
    await made.source.stop(false); // Handle this source dispatch manually to pause between fragments.
    const pending = guest.client.request({ op: "call", shareId, windowId: "g", call: "comments.snapshot", payload: {} });
    const outcome = pending.catch((error: Error) => error.message);
    await vi.waitFor(() => expect(owner.frames.some(frame => frame.type === "design.share.dispatch")).toBe(true));
    const dispatch = owner.frames.find(frame => frame.type === "design.share.dispatch") as DesignShareDispatchFrame;
    expect(await owner.client.request({ op: "reply", shareId, windowId: "w-src", dispatchId: dispatch.dispatchId, ok: true,
      part: { size: 600000, offset: 0, base64: Buffer.from("a".repeat(200000)).toString("base64") } })).toEqual({ partial: true });
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: null });
    expect(await outcome).toBe("design_share_role_changed");
    expect(await owner.client.request({ op: "reply", shareId, windowId: "w-src", dispatchId: dispatch.dispatchId, ok: true,
      part: { size: 600000, offset: 200000, base64: Buffer.from("b").toString("base64") } })).toEqual({ late: true });
  });

  it("does not retire the mirror for a failure of the source's own transport", async () => {
    const made = await share(), shareId = made.view.shareId;
    const mirror = await joinDesignShare(phone.client, { shareId, windowId: "p", user: () => ({ id: "owner", name: "Owner" }) });
    vi.spyOn(made.session, "requestForShare").mockRejectedValueOnce(new Error("design_share_app_unavailable"));
    await expect(mirror.session.request("comments.snapshot", {})).rejects.toThrow("design_share_source_offline");
    expect(mirror.state().disconnected).toBe(false);
    await mirror.leave({ discard: true });
  });

  it("bounds large replies waiting on a slow recipient and releases the budget afterward", async () => {
    broker.close();
    broker = new DesignShareBroker({ requireMember: (u, c) => store.db.serial(() => store.requireMember(u, c)), userName: async u => (await store.user(u))?.name, repository: metaDesignShareRepository(store.db) },
      { limits: { resultInlineBytes: 100000, resultBufferBytes: 500000, dispatchTimeoutMs: 2000 } });
    const made = memoryDesign();
    for (let i = 0; i < 2; i++) await made.session.request("db.write", { op: "set", path: `items/item${i}`, data: { text: "x".repeat(150000) } });
    const source = await share(made), shareId = source.view.shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
    await guest.client.request({ op: "join", shareId, windowId: "g" });
    let release!: () => void, started!: () => void, hold = true;
    const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { started = resolve; });
    const send = guest.peer.send.bind(guest.peer);
    guest.peer.send = async frame => { if (hold && frame.type === "design.share.result" && frame.part) { hold = false; started(); await blocked; } return send(frame); };
    const request = { op: "call" as const, shareId, windowId: "g", call: "db.list" as const, payload: { path: "items" } };
    const first = guest.client.request(request);
    await waiting;
    try { expect(await guest.client.request(request).then(() => "unexpected success", (error: Error) => error.message)).toBe("design_share_reply_busy"); }
    finally { release(); }
    expect(await first).toMatchObject({ status: 200 });
    expect(await guest.client.request(request)).toMatchObject({ status: 200 });
  });

  it("opens only for members, once per document, with owner-only grants to members", async () => {
    const { view, session } = await share();
    const shareId = (view as { shareId: string }).shareId;
    expect(shareId).toMatch(/^ds_[a-z0-9]{24}$/);
    expect(((await openDesignShare(owner.client, session, { conversationId, windowId: "w-src", title: "Deck" })).view as { shareId: string }).shareId).toBe(shareId);
    await expect(outsider.client.request({ op: "open", conversationId, designId: "d", windowId: "w", title: "x", format: "canvas", revision: 0 })).rejects.toThrow("conversation_forbidden");
    await expect(guest.client.request({ op: "grant", shareId, userId: "guest", role: "editor" })).rejects.toThrow("design_share_forbidden");
    await expect(owner.client.request({ op: "grant", shareId, userId: "outsider", role: "viewer" })).rejects.toThrow("design_share_not_member");
    await expect(guest.client.request({ op: "join", shareId, windowId: "w" })).rejects.toThrow("design_share_forbidden");
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
    expect(((await guest.client.request({ op: "list", conversationId })) as { shares: { shareId: string; role: string }[] }).shares).toMatchObject([{ shareId, role: "viewer" }]);
    await expect(outsider.client.request({ op: "list", conversationId })).rejects.toThrow("conversation_forbidden");
    // The source device itself cannot join as a participant; the owner's phone can.
    await expect(owner.client.request({ op: "join", shareId, windowId: "w2" })).rejects.toThrow("design_share_source_device");
    expect(await phone.client.request({ op: "join", shareId, windowId: "p" })).toMatchObject({ role: "owner" });
  });

  it("relays a participant's edits and comments to the source, applied there as that user", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    const mirror = await joinDesignShare(guest.client, { shareId, windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    const published = await mirror.session.request("publish", { files: wire(mirror.session.document, "project/note.txt", "from guest") }) as { status: number };
    expect(published.status).toBe(200);
    const sourceStore = source.store;
    expect(text(sourceStore.design.files["project/note.txt"])).toBe("from guest");
    expect(sourceStore.history!.versions.at(-1)).toMatchObject({ by: "human", user: { id: "user:guest", name: "Guest" } });
    // Identity comes from the Host, not from the page.
    const created = await mirror.session.request("comments.create", { anchor: "#a", label: "Board", text: "Bigger" }) as { status: number; body: { thread: { messages: { author: unknown }[] } } };
    expect(created.status).toBe(201);
    expect(created.body.thread.messages[0].author).toEqual({ kind: "user", name: "Guest", principal: "user:guest" });
    // A participant cannot open a Bot draft on the owner's device.
    expect(await mirror.session.request("comments.send", { id: sourceStore.comments!.threads[0].id })).toMatchObject({ status: 409, body: { code: "AGENT_UNAVAILABLE" } });
    // The owner's own edit reaches the participant.
    await source.session.request("publish", { files: wire(source.session.document, "project/note.txt", "owner edit") });
    await vi.waitFor(() => expect(text(mirror.session.document.files["project/note.txt"])).toBe("owner edit"));
    // Large content moves in chunks (above the 256 KiB chunk and the 1 MiB frame).
    const big = "z".repeat(1_400_000);
    expect(((await mirror.session.request("publish", { files: wire(mirror.session.document, "project/big.txt", big) })) as { status: number }).status).toBe(200);
    expect(text(sourceStore.design.files["project/big.txt"])).toBe(big);
    const largest = Math.max(...guest.frames.concat(owner.frames).map(frame => JSON.stringify(frame).length));
    expect(largest).toBeLessThan(1024 * 1024);
    await mirror.leave();
  });

  it("re-checks the requester at the commit point: a revoked grant writes nothing", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    await guest.client.request({ op: "join", shareId, windowId: "w" });
    // Replace the automatic source with a manual one so revocation lands between dispatch and admit.
    await source.source.stop(false);
    const dispatched = new Promise<DesignShareDispatchFrame>(resolve => owner.client.on(frame => { if (frame.type === "design.share.dispatch") resolve(frame); }));
    const encoded = designTextFile("never", "text/plain");
    await guest.client.request({ op: "stage", shareId, windowId: "w", sha256: encoded.sha256, size: encoded.size, offset: 0, base64: encoded.base64 });
    const commit = guest.client.request({ op: "commit", shareId, windowId: "w", baseRevision: 0, files: { "project/never.txt": { sha256: encoded.sha256, size: encoded.size, contentType: "text/plain", ifMatch: null } } }).then(() => "applied", (error: Error) => error.message);
    const frame = await dispatched;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: null });
    await expect(owner.client.request({ op: "admit", shareId, windowId: "w-src", dispatchId: frame.dispatchId })).rejects.toThrow(/design_share_(role_changed|dispatch_gone)/);
    expect(await commit).toBe("design_share_role_changed");
    expect(source.store.design.files["project/never.txt"]).toBeUndefined();
    expect(guest.events().some(event => event.event.type === "revoked")).toBe(true);
    // Viewers read but never write, at the Host.
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
    await guest.client.request({ op: "join", shareId, windowId: "w" });
    await expect(guest.client.request({ op: "call", shareId, windowId: "w", call: "db.write", payload: { op: "set", path: "a/b", data: {} } })).rejects.toThrow("design_share_read_only");
    await expect(guest.client.request({ op: "stage", shareId, windowId: "w", sha256: encoded.sha256, size: encoded.size, offset: 0, base64: encoded.base64 })).rejects.toThrow("design_share_read_only");
  });

  it("fails writes while the source is offline (no queue, no local fallback) and recovers on attach", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    const mirror = await joinDesignShare(guest.client, { shareId, windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    await source.source.stop(true); // detach: the share and grant remain
    expect(await mirror.session.request("publish", { files: wire(mirror.session.document, "project/x.txt", "x") })).toMatchObject({ status: 503, body: { code: "design_share_source_offline" } });
    expect(guest.events().some(event => event.event.type === "source" && !event.event.online)).toBe(true);
    expect(source.store.design.files["project/x.txt"]).toBeUndefined();
    const again = await openDesignShare(owner.client, source.session, { conversationId, windowId: "w-src-2", title: "Deck" });
    expect((again.view as { shareId: string }).shareId).toBe(shareId);
    expect(((await mirror.session.request("publish", { files: wire(mirror.session.document, "project/x.txt", "x") })) as { status: number }).status).toBe(200);
    // Losing the source socket is the same as detaching.
    owner.kill();
    await expect(guest.client.request({ op: "call", shareId, windowId: "w-guest", call: "list", payload: {} })).rejects.toThrow("design_share_source_offline");
  });

  it("closes to a tombstone and never restores a revoked membership grant", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    await guest.client.request({ op: "join", shareId, windowId: "w" });
    await store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_id='guest'", [conversationId]);
    await broker.revokeMember(conversationId, "guest");
    expect(guest.events().some(event => event.event.type === "revoked" && event.event.reason === "membership")).toBe(true);
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversationId]);
    await expect(guest.client.request({ op: "join", shareId, windowId: "w" })).rejects.toThrow("design_share_forbidden");
    await owner.client.request({ op: "close", shareId });
    await expect(phone.client.request({ op: "join", shareId, windowId: "p" })).rejects.toThrow("design_share_closed");
    await expect(owner.client.request({ op: "attach", shareId, windowId: "w-src", revision: 0 })).rejects.toThrow("design_share_closed");
    expect(((await owner.client.request({ op: "list", conversationId })) as { shares: unknown[] }).shares).toEqual([]);
    // Re-sharing the same document is a new share, never the closed one.
    const next = await openDesignShare(owner.client, source.session, { conversationId, windowId: "w-src", title: "Deck" });
    expect((next.view as { shareId: string }).shareId).not.toBe(shareId);
  });

  it("keeps the tombstone when close and a late change or re-open race on the same socket", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId, repository = metaDesignShareRepository(store.db);
    await source.source.stop(false);
    // Not awaited: close, then a change from the same source socket.
    const [closed, changed] = await Promise.allSettled([
      owner.client.request({ op: "close", shareId }),
      owner.client.request({ op: "changed", shareId, windowId: "w-src", revision: 5, files: {} }),
    ]);
    expect(closed.status).toBe("fulfilled");
    expect(changed).toMatchObject({ status: "rejected", reason: { code: "design_share_closed" } });
    expect(await repository.get(shareId)).toMatchObject({ state: "closed", generation: 2 });
    // A re-open racing a close never revives the closed share.
    const second = await openDesignShare(owner.client, source.session, { conversationId, windowId: "w-src", title: "Deck" }), secondId = (second.view as { shareId: string }).shareId;
    expect(secondId).not.toBe(shareId);
    const [, reopened] = await Promise.allSettled([owner.client.request({ op: "close", shareId: secondId }), owner.client.request({ op: "open", conversationId, designId: source.session.document.id, windowId: "w-src", title: "Deck", format: "canvas", revision: 0 })]);
    expect(await repository.get(secondId)).toMatchObject({ state: "closed", generation: 2 });
    if (reopened.status === "fulfilled") {
      const id = (reopened.value as { shareId: string }).shareId;
      if (id === secondId) throw new Error("re-open returned the closed share");
      expect(await repository.get(id)).toMatchObject({ state: "open", generation: 1 });
    }
    await expect(phone.client.request({ op: "join", shareId: secondId, windowId: "p" })).rejects.toThrow("design_share_closed");
  });
  it("lets exactly one of two concurrent writers of the same file win; the other conflicts and can retry", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    const a = await joinDesignShare(guest.client, { shareId, windowId: "w-a", user: () => ({ id: "guest", name: "Guest" }) });
    const b = await joinDesignShare(phone.client, { shareId, windowId: "w-b", user: () => ({ id: "owner", name: "Owner" }) });
    await a.session.request("publish", { files: wire(a.session.document, "project/race.txt", "base") });
    await vi.waitFor(async () => expect(text((await b.session.refresh()).files["project/race.txt"])).toBe("base"));
    await a.session.refresh();
    const [ra, rb] = await Promise.all([a.session.request("publish", { files: wire(a.session.document, "project/race.txt", "from a") }), b.session.request("publish", { files: wire(b.session.document, "project/race.txt", "from b") })]) as { status: number }[];
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const winner = ra.status === 200 ? "from a" : "from b", loser = ra.status === 200 ? b : a;
    expect(text(source.store.design.files["project/race.txt"])).toBe(winner);
    // The loser re-reads and retries on top of the winner's version.
    await loser.session.remoteChanged();
    expect(((await loser.session.request("publish", { files: wire(loser.session.document, "project/race.txt", "retried") })) as { status: number }).status).toBe(200);
    expect(text(source.store.design.files["project/race.txt"])).toBe("retried");
  });
  it("a joined copy, even on the owner's own other device, never offers or performs Send to Bot", async () => {
    const drafts: unknown[] = [], source = await share(memoryDesign(undefined, { sendToBot: async draft => { drafts.push(draft); return "opened"; } }));
    const shareId = (source.view as { shareId: string }).shareId;
    // The sharing device itself still sends.
    expect(((await source.session.request("comments.snapshot", {})) as { body: { agent: { available: boolean } } }).body.agent.available).toBe(true);
    const mirror = await joinDesignShare(phone.client, { shareId, windowId: "w-phone", user: () => ({ id: "owner", name: "Owner" }) });
    const snapshot = await mirror.session.request("comments.snapshot", {}) as { status: number; body: { agent: { available: boolean }; me: { canSend: boolean; canComment: boolean } } };
    expect(snapshot).toMatchObject({ status: 200, body: { agent: { available: false }, me: { canSend: false, canComment: true } } });
    const events: Array<{ type: string; snapshot?: { agent?: { available?: boolean } } }> = []; mirror.session.onEvent(event => events.push(event as never));
    await mirror.session.refreshComments();
    expect(events.find(event => event.type === "comments")?.snapshot?.agent?.available).toBe(false);
    // `send:true` saves the comment on the source and opens no draft anywhere.
    const created = await mirror.session.request("comments.create", { anchor: "#a", label: "Board", text: "Ask the Bot", send: true }) as { status: number; body: { thread: { id: string }; draft: string } };
    expect(created).toMatchObject({ status: 201, body: { draft: "declined" } });
    expect(source.store.comments!.threads.map(thread => thread.messages[0]!.text)).toEqual(["Ask the Bot"]);
    for (const op of ["comments.send", "comments.request"]) expect(await mirror.session.request(op, op === "comments.send" ? { id: created.body.thread.id } : { text: "x" })).toMatchObject({ status: 409, body: { code: "AGENT_UNAVAILABLE" } });
    expect(drafts).toEqual([]);
    // Nor can it mark the owner's threads delivered without a real local ACK.
    await mirror.session.markCommentsSent([created.body.thread.id], { messageId: "msg_fake" });
    // A raw remote `sent` is refused before the commit point, so the Host reports it as not admitted.
    expect(await phone.client.request({ op: "call", shareId, windowId: "w-phone", call: "comments.sent", payload: { ids: [created.body.thread.id] } })).toMatchObject({ status: 403 });
    expect(source.store.comments!.threads[0]!.agent).toBeUndefined();
  });

  it("drops staged uploads when a role is lowered mid-upload; a re-grant must start the upload again", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    await guest.client.request({ op: "join", shareId, windowId: "w" });
    const bytes = new Uint8Array(300 * 1024).fill(65), file = encodeDesignFile(bytes, "text/plain"), first = bytes.subarray(0, 256 * 1024);
    const b64 = (part: Uint8Array) => Buffer.from(part).toString("base64");
    expect(await guest.client.request({ op: "stage", shareId, windowId: "w", sha256: file.sha256, size: file.size, offset: 0, base64: b64(first) })).toMatchObject({ complete: false });
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
    await expect(guest.client.request({ op: "stage", shareId, windowId: "w", sha256: file.sha256, size: file.size, offset: first.length, base64: b64(bytes.subarray(first.length)) })).rejects.toThrow("design_share_read_only");
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    await expect(guest.client.request({ op: "stage", shareId, windowId: "w", sha256: file.sha256, size: file.size, offset: first.length, base64: b64(bytes.subarray(first.length)) })).rejects.toThrow("design_share_stage_order");
    expect(await guest.client.request({ op: "stage", shareId, windowId: "w", sha256: file.sha256, size: file.size, offset: 0, base64: b64(first) })).toMatchObject({ complete: false });
    expect(source.store.design.files["project/a.txt"]).toBeUndefined();
  });

  it("retires a participant copy when its socket reconnects; only an explicit rejoin recovers it, never a revoked one", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    const mirror = await joinDesignShare(guest.client, { shareId, windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    guest.reconnect();
    // The Host sees a new connection: the copy is retired, with no silent rejoin and no offline write.
    expect(await mirror.session.request("publish", { files: wire(mirror.session.document, "project/after.txt", "x") })).toMatchObject({ status: 503, body: { code: "design_share_disconnected" } });
    // Further remote requests refuse at once (no network attempt) until the explicit rejoin.
    await expect(mirror.session.historyList({})).rejects.toThrow("design_share_disconnected");
    expect(mirror.state()).toMatchObject({ disconnected: true });
    expect(source.store.design.files["project/after.txt"]).toBeUndefined();
    await mirror.resume();
    expect(mirror.state()).toMatchObject({ disconnected: false, role: "editor" });
    expect(((await mirror.session.request("publish", { files: wire(mirror.session.document, "project/after.txt", "after reconnect") })) as { status: number }).status).toBe(200);
    expect(text(source.store.design.files["project/after.txt"])).toBe("after reconnect");
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: null });
    guest.reconnect();
    await expect(mirror.resume()).rejects.toThrow(/design_share_(revoked|forbidden)/);
    await expect(guest.client.request({ op: "join", shareId, windowId: "w-guest" })).rejects.toThrow("design_share_forbidden");
  });

  it("serves again from the source after its socket reconnects; participants re-read on its return", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    const mirror = await joinDesignShare(guest.client, { shareId, windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    owner.reconnect();
    await vi.waitFor(() => expect(mirror.state().sourceOnline).toBe(false));
    expect(await mirror.session.request("publish", { files: wire(mirror.session.document, "project/x.txt", "x") })).toMatchObject({ status: 503, body: { code: "design_share_source_offline" } });
    // Edited on the source while it was disconnected from the Host.
    await source.session.request("publish", { files: wire(source.session.document, "project/offline.txt", "made offline") });
    await source.source.resume();
    await vi.waitFor(() => expect(mirror.session.document.files["project/offline.txt"] && text(mirror.session.document.files["project/offline.txt"])).toBe("made offline"));
    expect(((await mirror.session.request("publish", { files: wire(mirror.session.document, "project/x.txt", "x") })) as { status: number }).status).toBe(200);
  });

  it("does not re-read the source manifest for every editor request between changes", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "viewer" });
    const mirror = await joinDesignShare(guest.client, { shareId, windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    const lists = () => guest.calls.filter(item => item === "call:list").length, before = lists();
    for (let i = 0; i < 5; i++) await mirror.session.request("list", {});
    expect(lists() - before).toBe(0);
    await source.session.request("publish", { files: wire(source.session.document, "project/n.txt", "new") });
    await vi.waitFor(() => expect(mirror.session.document.files["project/n.txt"]).toBeDefined());
    expect(lists() - before).toBe(1);
  });
  it("acknowledges a repeated upload chunk instead of discarding the upload; same content from two windows both commits", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    await guest.client.request({ op: "join", shareId, windowId: "a" }); await guest.client.request({ op: "join", shareId, windowId: "b" });
    const bytes = new Uint8Array(300 * 1024).fill(66), file = encodeDesignFile(bytes, "text/plain"), cut = 256 * 1024, b64 = (part: Uint8Array) => Buffer.from(part).toString("base64");
    const chunk = (windowId: string, offset: number) => guest.client.request({ op: "stage", shareId, windowId, sha256: file.sha256, size: file.size, offset, base64: b64(bytes.subarray(offset, Math.min(offset + cut, bytes.length))) });
    expect(await chunk("a", 0)).toMatchObject({ received: cut, complete: false });
    expect(await chunk("b", 0)).toMatchObject({ received: cut, complete: false }); // the other window's duplicate
    expect(await chunk("a", 0)).toMatchObject({ received: cut, complete: false }); // a retry
    expect(await chunk("b", cut)).toMatchObject({ received: file.size, complete: true });
    expect(await chunk("a", cut)).toMatchObject({ received: file.size, complete: true });
    const entry = { sha256: file.sha256, size: file.size, contentType: "text/plain", ifMatch: null };
    expect(await guest.client.request({ op: "commit", shareId, windowId: "a", baseRevision: 0, files: { "project/dup.txt": entry } })).toMatchObject({ revision: 1 });
    expect(source.store.design.files["project/dup.txt"].sha256).toBe(file.sha256);
    // Out-of-order chunks are refused without destroying other progress.
    const other = encodeDesignFile(new Uint8Array(300 * 1024).fill(67), "text/plain");
    await guest.client.request({ op: "stage", shareId, windowId: "a", sha256: other.sha256, size: other.size, offset: 0, base64: Buffer.from(decodeDesignFile(other).subarray(0, cut)).toString("base64") });
    await expect(guest.client.request({ op: "stage", shareId, windowId: "b", sha256: other.sha256, size: other.size, offset: cut + 10, base64: "QUFB" })).rejects.toThrow("design_share_stage_order");
    expect(await guest.client.request({ op: "stage", shareId, windowId: "a", sha256: other.sha256, size: other.size, offset: cut, base64: Buffer.from(decodeDesignFile(other).subarray(cut)).toString("base64") })).toMatchObject({ complete: true });
  });
  it("verifies staged chunks and serves pulls only for the dispatch's own blobs", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    await guest.client.request({ op: "join", shareId, windowId: "w" });
    const good = designTextFile("abc", "text/plain"), bad = designTextFile("abd", "text/plain");
    await expect(guest.client.request({ op: "stage", shareId, windowId: "w", sha256: good.sha256, size: 3, offset: 0, base64: bad.base64 })).rejects.toThrow("design_share_blob_corrupt");
    await expect(guest.client.request({ op: "stage", shareId, windowId: "w", sha256: good.sha256, size: 3, offset: 1, base64: good.base64 })).rejects.toThrow("design_share_stage_order");
    await expect(owner.client.request({ op: "pull", shareId, windowId: "w-src", dispatchId: "d_none", sha256: good.sha256, offset: 0 })).rejects.toThrow("design_share_dispatch_gone");
    await expect(guest.client.request({ op: "pull", shareId, windowId: "w", dispatchId: "d_none", sha256: good.sha256, offset: 0 })).rejects.toThrow("design_share_not_source");
    // A commit naming content neither staged nor on the source fails there, writing nothing.
    await expect(guest.client.request({ op: "commit", shareId, windowId: "w", baseRevision: 0, files: { "project/a.txt": { sha256: good.sha256, size: 3, contentType: "text/plain", ifMatch: null } } })).rejects.toThrow("design_share_blob_unavailable");
    expect(source.store.design.files["project/a.txt"]).toBeUndefined();
  });

  it("names people from the Host in presence and keeps windows separate", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "commenter" });
    await guest.client.request({ op: "join", shareId, windowId: "a" });
    await guest.client.request({ op: "join", shareId, windowId: "b" });
    await guest.client.request({ op: "presence", shareId, windowId: "a", patch: { who: { n: "Owner", c: "#112233" }, cursor: { x: 1, y: 2 } } });
    await expect(guest.client.request({ op: "presence", shareId, windowId: "a", patch: { big: "x".repeat(5000) } })).rejects.toThrow("invalid_design_presence");
    await vi.waitFor(() => {
      const peers = owner.events().map(frame => frame.event).filter(event => event.type === "peers").at(-1);
      expect(peers && "peers" in peers ? peers.peers.filter(item => item.userId === "guest") : []).toHaveLength(2);
      expect(peers && "peers" in peers ? peers.peers.find(item => item.presence.cursor)?.presence.who : undefined).toEqual({ c: "#112233", n: "Guest" });
    });
    await guest.client.request({ op: "leave", shareId, windowId: "a" });
    await expect(guest.client.request({ op: "presence", shareId, windowId: "a", patch: {} })).rejects.toThrow("design_share_not_joined");
    expect(await guest.client.request({ op: "presence", shareId, windowId: "b", patch: { cursor: { x: 3 } } })).toBeNull();
    // A commenter comments but cannot write files.
    await expect(guest.client.request({ op: "call", shareId, windowId: "b", call: "restore", payload: {} })).rejects.toThrow("design_share_forbidden");
  });
  // Independent review (sharing-ui-independent-review.md, confirmed 2): Pause during a reconnect.
  it("Pause while a reconnect is still saving: the stopped source never re-attaches, and Start works again", async () => {
    const made = memoryDesign(), manager = new DesignShareManager(owner.client);
    const first = await manager.share(made.session, { conversationId, windowId: "w-src", title: "Deck" });
    await manager.grant(made.session, "guest", "viewer");
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), flush = made.session.flush.bind(made.session);
    made.session.flush = () => held;
    owner.setOnline(false); owner.setOnline(true);
    await manager.pause(made.session);
    release(); await new Promise(resolve => setTimeout(resolve, 30)); made.session.flush = flush;
    expect(manager.sourceFor(made.session)).toBeUndefined();
    expect(owner.calls.slice(owner.calls.lastIndexOf("detach"))).not.toContain("attach");
    const [view] = await manager.list(conversationId); expect(view).toMatchObject({ shareId: first.shareId, sourceOnline: false });
    await guest.client.request({ op: "join", shareId: first.shareId, windowId: "g" });
    await expect(guest.client.request({ op: "call", shareId: first.shareId, windowId: "g", call: "list", payload: {} })).rejects.toThrow("design_share_source_offline");
    // An ordinary Start afterwards serves the same share with its grants.
    const again = await manager.share(made.session, { conversationId, windowId: "w-src", title: "Deck" });
    expect(again).toMatchObject({ shareId: first.shareId, sourceOnline: true, members: [{ userId: "guest", role: "viewer" }] });
    expect(await guest.client.request({ op: "call", shareId: first.shareId, windowId: "g", call: "list", payload: {} })).toMatchObject({ files: expect.any(Object) });
  });
  it("Pause while the reconnect attach is already on the wire: the Host ends detached", async () => {
    const made = memoryDesign(), manager = new DesignShareManager(owner.client);
    const first = await manager.share(made.session, { conversationId, windowId: "w-src", title: "Deck" });
    let release!: () => void, sent!: () => void; const wire = new Promise<void>(resolve => { release = resolve; }), onWire = new Promise<void>(resolve => { sent = resolve; });
    owner.gate(op => { if (op !== "attach") return undefined; sent(); return wire; });
    owner.setOnline(false); owner.setOnline(true);
    await onWire; const pausing = manager.pause(made.session);
    await new Promise(resolve => setTimeout(resolve, 20)); release(); owner.gate(undefined); await pausing;
    const ops = owner.calls.slice(owner.calls.lastIndexOf("attach")); expect(ops).toContain("detach");
    expect((await manager.list(conversationId))[0]).toMatchObject({ shareId: first.shareId, sourceOnline: false });
  });
  // Independent review, confirmed 1: Leave must save before it revokes the joined copy.
  it("Leave saves the editor's last change first; a failed save keeps the copy joined until retry or discard", async () => {
    const source = await share(), shareId = (source.view as { shareId: string }).shareId;
    await owner.client.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    const manager = new DesignShareManager(guest.client);
    const mirror = await manager.join({ ...(source.view as DesignShareView), onThisDevice: false }, { windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    let pending = "last keystrokes", discarded = 0;
    const editor = { flush: async () => { if (!pending) return; const reply = await mirror.session.request("publish", { files: wire(mirror.session.document, "project/leave.txt", pending) }) as { status: number; body: { code?: string } }; if (reply.status >= 400) throw new Error(reply.body.code ?? "save_failed"); pending = ""; },
      reload: async () => undefined, retire: async () => undefined, discard: () => { discarded++; } };
    mirror.session.bindEditor(editor);
    // The source goes away: the save fails, so Leave refuses and the copy stays usable for a retry.
    source.source.stop(true); await vi.waitFor(() => expect(mirror.state().sourceOnline).toBe(false));
    await expect(manager.leave(shareId)).rejects.toThrow();
    expect(manager.mirrorFor(shareId)).toBeDefined(); expect(mirror.state()).toMatchObject({ revoked: false }); expect(discarded).toBe(0);
    // Back online: Leave saves first, then leaves.
    const resumed = new (await import("../client/src/workbench-design-collaboration.js")).DesignShareSource(owner.client, source.session, shareId, "w-src").start(); await resumed.resume();
    await vi.waitFor(() => expect(mirror.state().sourceOnline).toBe(true));
    await manager.leave(shareId);
    expect(text(source.store.design.files["project/leave.txt"]!)).toBe("last keystrokes");
    expect(manager.mirrorFor(shareId)).toBeUndefined(); expect(mirror.state().revoked).toBe(true); expect(discarded).toBe(1);
    // An explicit discard leaves without saving.
    const again = await manager.join({ ...(source.view as DesignShareView), onThisDevice: false }, { windowId: "w-guest", user: () => ({ id: "guest", name: "Guest" }) });
    again.session.bindEditor({ flush: async () => { throw new Error("design_not_saved"); }, reload: async () => undefined, retire: async () => undefined });
    await expect(manager.leave(shareId)).rejects.toThrow("design_not_saved"); expect(manager.mirrorFor(shareId)).toBeDefined();
    await manager.leave(shareId, { discard: true }); expect(manager.mirrorFor(shareId)).toBeUndefined();
    await resumed.stop(true);
  });
});
