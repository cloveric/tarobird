import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { deviceProof } from "../src/hub/auth.js";
import { nodeFrameReader } from "../src/client-protocol/fragments-node.js";
import { DESIGN_SHARE_CLIENT_CAPABILITY, WORKBENCH_DESIGN_SHARE_CAPABILITY, type DesignShareRequest, type DesignShareServerFrame } from "../src/client-protocol/workbench-design-sharing.js";
import { DesignShareClient, joinDesignShare, openDesignShare } from "../client/src/workbench-design-collaboration.js";
import { decodeDesignFile, designTextFile } from "../client/src/workbench-design.js";
import { memoryDesign } from "../client/tests/design-session-fixture.js";

// Real HubServer, SQLite, signed authentication and loopback WebSockets. The
// last test uses production client/source/mirror sessions with memory storage;
// it does not establish browser, IndexedDB or physical-device acceptance.
class Peer {
  readonly frames: any[] = [];
  readonly listeners = new Set<(frame: DesignShareServerFrame) => void>();
  readonly shares: DesignShareClient;
  largestFrame = 0;
  private sequence = 0;
  constructor(readonly ws: WebSocket) {
    const reader = nodeFrameReader();
    ws.on("message", raw => {
      this.largestFrame = Math.max(this.largestFrame, Buffer.byteLength(raw.toString()));
      const frame = reader.read(raw.toString());
      if (!frame) return;
      this.frames.push(frame);
      if (typeof frame === "object" && "type" in frame && typeof frame.type === "string" && frame.type.startsWith("design.share.")) {
        for (const listener of this.listeners) listener(frame as DesignShareServerFrame);
      }
    });
    this.shares = new DesignShareClient({ send: frame => this.send(frame), onFrame: listener => {
      this.listeners.add(listener); return () => { this.listeners.delete(listener); };
    } }, 5_000);
  }
  send(frame: object) {
    const text = JSON.stringify({ v: 1, ...frame });
    this.largestFrame = Math.max(this.largestFrame, Buffer.byteLength(text));
    this.ws.send(text);
  }
  async next(type: string, match: (frame: any) => boolean = () => true) {
    const deadline = Date.now() + 4_000;
    for (;;) {
      const i = this.frames.findIndex(frame => frame.type === type && match(frame));
      if (i >= 0) return this.frames.splice(i, 1)[0];
      if (Date.now() >= deadline) throw new Error(`timed_out:${type}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  request(request: DesignShareRequest) {
    const requestId = `socket_${++this.sequence}`;
    this.send({ type: "design.share.request", requestId, request });
    return this.next("design.share.result", frame => frame.requestId === requestId);
  }
  dispose() { this.shares.dispose(); this.ws.terminate(); }
}

describe("Design sharing through the signed App socket", () => {
  let directory: string, hub: HubServer, conversationId: string, owner: Peer, guest: Peer;
  const peers: Peer[] = [];
  async function connect(deviceId: string, userId = "owner", capabilities = [DESIGN_SHARE_CLIENT_CAPABILITY]) {
    const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
    const pair = await hub.auth.pair({ deviceId, name: deviceId, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, deviceId);
    await hub.auth.approve(pair.code, "local-owner", userId);
    const peer = new Peer(new WebSocket(hub.url.replace(/^http/, "ws") + "/ws")); peers.push(peer);
    await new Promise<void>((resolve, reject) => { peer.ws.once("open", resolve); peer.ws.once("error", reject); });
    peer.send({ type: "hello", deviceId, nonce, protocolVersions: [1], capabilities, cursors: {} });
    const challenge = await peer.next("challenge");
    peer.send({ type: "auth", signature: sign(null, deviceProof(deviceId, challenge.nonce, nonce), keys.privateKey).toString("base64") });
    const ready = await peer.next("ready"); await peer.next("sync.complete");
    return { peer, ready };
  }
  async function open() {
    const opened = await owner.request({ op: "open", conversationId, designId: "design", windowId: "source", title: "Shared design", format: "canvas", revision: 0 });
    expect(opened.ok).toBe(true);
    const shareId = opened.result.shareId as string;
    expect((await owner.request({ op: "grant", shareId, userId: "guest", role: "editor" })).ok).toBe(true);
    expect((await guest.request({ op: "join", shareId, windowId: "guest-a" })).ok).toBe(true);
    return shareId;
  }
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "share-socket-"));
    hub = await HubServer.start({ stateDir: directory });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    await hub.store.db.run("INSERT INTO users VALUES('guest','Guest','member')");
    conversationId = (await hub.store.createConversation("owner", ["bot"], "Sharing", "create")).id;
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversationId]);
    owner = (await connect("source-device")).peer;
    guest = (await connect("guest-device", "guest")).peer;
  });
  afterEach(async () => { peers.splice(0).forEach(peer => peer.dispose()); await hub.close(); await rm(directory, { recursive: true, force: true }); });

  it("negotiates capability and rejects legacy clients and the old windowless schema", async () => {
    const { peer: legacy, ready } = await connect("legacy", "owner", []);
    expect(ready.serverCapabilities).toContain(WORKBENCH_DESIGN_SHARE_CAPABILITY);
    legacy.send({ type: "design.share.request", requestId: "legacy", request: { op: "list", conversationId } });
    expect(await legacy.next("error")).toMatchObject({ code: "design_share_capability_required", requestId: "legacy" });
    const shareId = await open();
    guest.send({ type: "design.share.request", requestId: "old-schema", request: { op: "presence", shareId, patch: {} } });
    expect(await guest.next("error")).toMatchObject({ code: "invalid_request" });
    guest.send({ type: "design.share.request", requestId: "removed-assets", request: { op: "call", shareId, windowId: "guest-a", call: "assets", payload: {} } });
    expect(await guest.next("error")).toMatchObject({ code: "invalid_request" });
  });

  it("keeps processing a participant socket while a relayed call waits for its source", async () => {
    const shareId = await open();
    const pending = guest.request({ op: "call", shareId, windowId: "guest-a", call: "list", payload: {} });
    const dispatch = await owner.next("design.share.dispatch");
    // An awaited handler in the ordered frame loop deadlocks here.
    expect((await guest.request({ op: "presence", shareId, windowId: "guest-a", patch: { who: { n: "Forged", c: "#112233" } } })).ok).toBe(true);
    expect(dispatch.from).toMatchObject({ userId: "guest", name: "Guest", role: "editor" });
    expect((await owner.request({ op: "reply", shareId, windowId: "source", dispatchId: dispatch.dispatchId, ok: true, result: { revision: 0, files: {} } })).ok).toBe(true);
    expect(await pending).toMatchObject({ ok: true, result: { revision: 0 } });
  });

  it("cancels a mutation revoked before admit and refuses its late admission", async () => {
    const shareId = await open();
    const pending = guest.request({ op: "call", shareId, windowId: "guest-a", call: "db.write", payload: { op: "set", path: "items/one", data: {} } });
    const dispatch = await owner.next("design.share.dispatch");
    expect((await owner.request({ op: "grant", shareId, userId: "guest", role: null })).ok).toBe(true);
    expect(await pending).toMatchObject({ ok: false, error: "design_share_role_changed" });
    expect(await owner.next("design.share.cancel")).toMatchObject({ dispatchId: dispatch.dispatchId });
    expect(await owner.request({ op: "admit", shareId, windowId: "source", dispatchId: dispatch.dispatchId })).toMatchObject({ ok: false, error: "design_share_dispatch_gone" });
  });

  it("preserves an admitted write across grant removal and reports unknown on source loss", async () => {
    const shareId = await open();
    const pending = guest.request({ op: "call", shareId, windowId: "guest-a", call: "db.write", payload: { op: "set", path: "items/one", data: {} } });
    const dispatch = await owner.next("design.share.dispatch");
    expect(await owner.request({ op: "admit", shareId, windowId: "source", dispatchId: dispatch.dispatchId })).toMatchObject({ ok: true, result: { admitted: true } });
    expect((await owner.request({ op: "grant", shareId, userId: "guest", role: null })).ok).toBe(true);
    expect(owner.frames.filter(frame => frame.type === "design.share.cancel" && frame.dispatchId === dispatch.dispatchId)).toEqual([]);
    owner.ws.terminate();
    expect(await pending).toMatchObject({ ok: false, error: "design_share_outcome_unknown" });
  });

  it("isolates participant windows, detaches only the bound source and rejects stale dispatches", async () => {
    const shareId = await open();
    expect((await guest.request({ op: "join", shareId, windowId: "guest-b" })).ok).toBe(true);
    expect((await guest.request({ op: "leave", shareId, windowId: "guest-a" })).ok).toBe(true);
    expect(await guest.request({ op: "presence", shareId, windowId: "guest-a", patch: {} })).toMatchObject({ ok: false, error: "design_share_not_joined" });
    expect((await guest.request({ op: "presence", shareId, windowId: "guest-b", patch: {} })).ok).toBe(true);
    expect(await owner.request({ op: "detach", shareId, windowId: "wrong" })).toMatchObject({ ok: true, result: { detached: false } });
    const pending = guest.request({ op: "call", shareId, windowId: "guest-b", call: "list", payload: {} });
    const dispatch = await owner.next("design.share.dispatch");
    expect((await owner.request({ op: "attach", shareId, windowId: "source-new", revision: 0 })).ok).toBe(true);
    expect((await pending).ok).toBe(false);
    expect(await owner.request({ op: "admit", shareId, windowId: "source-new", dispatchId: dispatch.dispatchId })).toMatchObject({ ok: false, error: "design_share_dispatch_gone" });
    expect((await owner.request({ op: "detach", shareId, windowId: "source-new" })).ok).toBe(true);
    expect(await guest.request({ op: "call", shareId, windowId: "guest-b", call: "list", payload: {} })).toMatchObject({ ok: false, error: "design_share_source_offline" });
    expect((await owner.request({ op: "attach", shareId, windowId: "source-new", revision: 0 })).ok).toBe(true);
  });

  it("rechecks SQLite membership at admit and never revives a removed grant", async () => {
    const shareId = await open();
    const pending = guest.request({ op: "call", shareId, windowId: "guest-a", call: "comments.create", payload: {} });
    const dispatch = await owner.next("design.share.dispatch");
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_id='guest'", [conversationId]);
    expect(await owner.request({ op: "admit", shareId, windowId: "source", dispatchId: dispatch.dispatchId })).toMatchObject({ ok: false, error: "design_share_not_member" });
    expect((await pending).ok).toBe(false);
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversationId]);
    expect(await guest.request({ op: "join", shareId, windowId: "guest-a" })).toMatchObject({ ok: false, error: "design_share_forbidden" });
  });

  it("keeps the close tombstone when a source change arrives on the same socket", async () => {
    const shareId = await open();
    // Both frames are intentionally in flight: the socket does not serialize
    // sharing requests, so the broker must order its own metadata writes.
    const closing = owner.request({ op: "close", shareId });
    const changing = owner.request({ op: "changed", shareId, windowId: "source", revision: 1, files: {} });
    expect((await closing).ok).toBe(true); await changing;
    const record = await hub.store.db.serial(() => hub.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [`workbench-design-share:${shareId}`]));
    expect(JSON.parse(record!.value)).toMatchObject({ state: "closed", generation: 2 });
    expect(await owner.request({ op: "attach", shareId, windowId: "source", revision: 1 })).toMatchObject({ ok: false, error: "design_share_closed" });
  });

  it("roundtrips production source and mirror sessions with large chunked files and trusted authors", async () => {
    const made = memoryDesign();
    // A valid shared DB listing exceeds the socket's 1 MiB frame ceiling.
    for (let i = 0; i < 6; i++) expect(await made.session.request("db.write", { op: "set", path: `items/item${i}`, data: { text: "中".repeat(70000) } })).toMatchObject({ status: 200 });
    const source = await openDesignShare(owner.shares, made.session, { conversationId, windowId: "source", title: "Design" });
    const shareId = source.view.shareId;
    await owner.shares.request({ op: "grant", shareId, userId: "guest", role: "editor" });
    const mirror = await joinDesignShare(guest.shares, { shareId, windowId: "guest-a", user: () => ({ id: "guest", name: "Guest" }) });
    const listed = await mirror.session.request("db.list", { path: "items" }) as { status: number; body: { docs: Record<string, { text: string }> } };
    expect(listed.status).toBe(200); expect(Object.keys(listed.body.docs)).toHaveLength(6);
    expect(listed.body.docs.item5.text).toBe("中".repeat(70000));
    expect(mirror.state().disconnected).toBe(false);
    const big = designTextFile("x".repeat(1_400_000), "text/plain");
    expect(await mirror.session.request("publish", { files: { "project/big.txt": { base64: big.base64, contentType: big.contentType, ifMatch: null } } })).toMatchObject({ status: 200 });
    expect(decodeDesignFile(made.store.design.files["project/big.txt"]!)).toHaveLength(1_400_000);
    expect(made.store.history!.versions.at(-1)).toMatchObject({ by: "human", user: { id: "user:guest", name: "Guest" } });
    expect(await mirror.session.request("comments.create", { anchor: "#a", label: "Board", text: "Socket comment" })).toMatchObject({ status: 201, body: { thread: { messages: [{ author: { principal: "user:guest", name: "Guest" } }] } } });
    expect(Math.max(owner.largestFrame, guest.largestFrame)).toBeLessThan(1024 * 1024);
    await mirror.leave(); await source.source.stop(true);
  }, 30_000);
});
