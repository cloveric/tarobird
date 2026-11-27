import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_PINS_CAPABILITY } from "../src/client-protocol/conversation-pins.js";
import { deviceProof } from "../src/hub/auth.js";
import { ConversationPins } from "../src/hub/conversation-pins.js";
import { HubDatabase } from "../src/hub/database.js";
import { HubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";

describe("conversation pins store", () => {
  let root: string, db: HubDatabase, store: HubStore, clock: number, pins: ConversationPins;
  let chatA: string, chatB: string, group: string, topic: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hub-pins-store-"));
    db = await HubDatabase.open(root);
    store = new HubStore(db);
    clock = 1000;
    pins = new ConversationPins(db, () => clock);
    await db.run("INSERT INTO users VALUES('owner','Owner','owner'),('other','Other','member')");
    await db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    chatA = (await store.createConversation("owner", ["bot"], "Chat A", "a")).id;
    chatB = (await store.createConversation("owner", ["bot"], "Chat B", "b")).id;
    group = (await store.createConversation("owner", ["bot"], "Group", "g", { type: "group" })).id;
    topic = (await store.createConversation("owner", [], "Topic", "t", { parentId: group })).id;
  });
  afterEach(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });

  it("persists pins and globalPins per user, enforces revisions, supports topics, and isolates users", async () => {
    expect(await pins.read("owner")).toEqual({ revision: 0, pins: [], globalPins: [] });
    const r1 = await pins.change("owner", { type: "set", revision: 0, scope: "group", conversationId: chatA, pinned: true });
    expect(r1).toEqual({ state: { revision: 1, pins: [chatA], globalPins: [] }, changed: true });

    clock = 1100;
    const r2 = await pins.change("owner", { type: "set", revision: 1, scope: "global", conversationId: topic, pinned: true });
    expect(r2).toEqual({ state: { revision: 2, pins: [chatA], globalPins: [topic] }, changed: true });

    await expect(pins.change("owner", { type: "set", revision: 1, scope: "group", conversationId: chatB, pinned: true })).rejects.toThrow("pins_changed");
    await expect(pins.change("other", { type: "set", revision: 0, scope: "group", conversationId: chatA, pinned: true })).rejects.toThrow("conversation_not_available");
    expect(await pins.read("other")).toEqual({ revision: 0, pins: [], globalPins: [] });

    await db.close();
    db = await HubDatabase.open(root);
    pins = new ConversationPins(db, () => clock);
    expect(await pins.read("owner")).toEqual({ revision: 2, pins: [chatA], globalPins: [topic] });
  });

  it("performs upgrade union merge without losing either device's pins and skips unavailable IDs", async () => {
    await store.updateConversation("owner", chatB, { archived: true });
    const mergedA = await pins.change("owner", {
      type: "merge",
      revision: 0,
      pins: [chatA, "deleted_id", chatB],
      globalPins: [group, "missing_global"],
    });
    expect(mergedA).toEqual({ state: { revision: 1, pins: [chatA], globalPins: [group] }, changed: true });

    await store.updateConversation("owner", chatB, { archived: false });
    const mergedB = await pins.change("owner", {
      type: "merge",
      revision: 1,
      pins: [chatB, chatA],
      globalPins: [topic],
    });
    expect(mergedB).toEqual({ state: { revision: 2, pins: [chatA, chatB], globalPins: [group, topic] }, changed: true });

    const noop = await pins.change("owner", { type: "merge", revision: 2, pins: [chatA], globalPins: [topic] });
    expect(noop).toEqual({ state: { revision: 2, pins: [chatA, chatB], globalPins: [group, topic] }, changed: false });
  });

  it("reconciles offline pin and unpin changes with last-change-wins per conversation pin", async () => {
    clock = 1000;
    await pins.change("owner", { type: "set", revision: 0, scope: "group", conversationId: chatA, pinned: true });
    clock = 1500;
    await pins.change("owner", { type: "set", revision: 1, scope: "global", conversationId: chatB, pinned: true });

    // Stale offline unpin of chatB (at 1200 < 1500) loses; newer offline unpin of chatA (at 1400 > 1000) wins;
    // collapsed offline sequence on group (pin at 1300 then unpin at 1600) keeps it unpinned;
    // newer offline global pin of topic (at 1700) wins; archived/missing chats are skipped.
    await store.updateConversation("owner", chatA, { archived: false });
    clock = 2000;
    const reconciled = await pins.change("owner", {
      type: "reconcile",
      revision: 2,
      changes: [
        { scope: "global", conversationId: chatB, pinned: false, at: 1200 },
        { scope: "group", conversationId: chatA, pinned: false, at: 1400 },
        { scope: "group", conversationId: group, pinned: true, at: 1300 },
        { scope: "group", conversationId: group, pinned: false, at: 1600 },
        { scope: "global", conversationId: topic, pinned: true, at: 1700 },
        { scope: "group", conversationId: "missing", pinned: true, at: 1800 },
      ],
    });
    expect(reconciled).toEqual({
      state: { revision: 3, pins: [], globalPins: [chatB, topic] },
      changed: true,
    });
  });

  it("rejects pinning topics under an archived parent group", async () => {
    await store.updateConversation("owner", group, { archived: true });
    await expect(pins.change("owner", { type: "set", revision: 0, scope: "global", conversationId: topic, pinned: true })).rejects.toThrow("conversation_not_available");
  });
});

describe("HubServer conversation pins sync", () => {
  let root: string, hub: HubServer;
  const sockets: WebSocket[] = [], warnings: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hub-pins-server-"));
    warnings.length = 0;
    hub = await HubServer.start({ stateDir: root, onWarning: code => warnings.push(code) });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
  });
  afterEach(async () => { sockets.splice(0).forEach(ws => ws.terminate()); await hub.close(); await rm(root, { recursive: true, force: true }); });

  async function connect(id: string, userId = "owner") {
    const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
    const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, id);
    await hub.auth.approve(pair.code, "local-owner", userId);
    const ws = new WebSocket(hub.url.replace("http", "ws") + "/ws"); sockets.push(ws);
    const frames: Record<string, any>[] = [];
    ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const send = (frame: object) => ws.send(JSON.stringify({ v: 1, ...frame }));
    send({ type: "hello", deviceId: id, nonce, protocolVersions: [1], capabilities: [], cursors: {} });
    await vi.waitFor(() => expect(frames.some(f => f.type === "challenge")).toBe(true));
    send({ type: "auth", signature: sign(null, deviceProof(id, frames.find(f => f.type === "challenge")!.nonce, nonce), keys.privateKey).toString("base64") });
    return { ws, frames, send };
  }

  it("syncs pins and globalPins between two devices of the owner and isolates other users", async () => {
    await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    await hub.store.db.run("INSERT INTO bot_grants(bot_id,user_id) VALUES('alpha','member')");
    const ownerChat = (await hub.store.createConversation("owner", ["alpha"], "Owner chat", "c1")).id;
    const memberChat = (await hub.store.createConversation("member", ["alpha"], "Member chat", "c2")).id;

    const devA = await connect("dev-a", "owner");
    const devB = await connect("dev-b", "owner");
    const otherUser = await connect("dev-other", "member");
    await vi.waitFor(() => {
      expect(devA.frames.some(f => f.type === "sync.complete")).toBe(true);
      expect(devB.frames.some(f => f.type === "sync.complete")).toBe(true);
      expect(otherUser.frames.some(f => f.type === "sync.complete")).toBe(true);
    });

    const readyA = devA.frames.find(f => f.type === "ready")!;
    expect(readyA.serverCapabilities).toContain(CONVERSATION_PINS_CAPABILITY);
    expect(readyA.conversationPins).toEqual({ revision: 0, pins: [], globalPins: [] });

    const headersA = { Authorization: `Bearer ${readyA.sessionToken}`, "Content-Type": "application/json" };
    const headersOther = { Authorization: `Bearer ${otherUser.frames.find(f => f.type === "ready")!.sessionToken}`, "Content-Type": "application/json" };

    const res = await fetch(hub.url + "/api/conversation-pins", {
      method: "PATCH",
      headers: headersA,
      body: JSON.stringify({ type: "set", revision: 0, scope: "global", conversationId: ownerChat, pinned: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 1, pins: [], globalPins: [ownerChat] });

    await vi.waitFor(() => {
      expect(devB.frames.some(f => f.type === "conversation-pins.updated" && f.pins?.revision === 1)).toBe(true);
    });
    expect(devB.frames.find(f => f.type === "conversation-pins.updated")!.pins).toEqual({ revision: 1, pins: [], globalPins: [ownerChat] });
    expect(otherUser.frames.some(f => f.type === "conversation-pins.updated")).toBe(false);

    // Member cannot pin owner's chat and keeps separate pin state.
    const forbidden = await fetch(hub.url + "/api/conversation-pins", {
      method: "PATCH",
      headers: headersOther,
      body: JSON.stringify({ type: "set", revision: 0, scope: "group", conversationId: ownerChat, pinned: true }),
    });
    expect(forbidden.status).toBe(404);
    const memberOk = await fetch(hub.url + "/api/conversation-pins", {
      method: "PATCH",
      headers: headersOther,
      body: JSON.stringify({ type: "set", revision: 0, scope: "group", conversationId: memberChat, pinned: true }),
    });
    expect(memberOk.status).toBe(200);
    expect(await memberOk.json()).toEqual({ revision: 1, pins: [memberChat], globalPins: [] });
  });

  it.each(["{invalid", JSON.stringify({ revision: 1, pins: "invalid", globalPins: [] })])(
    "keeps a device online when optional pins metadata is corrupt: %s",
    async raw => {
      await hub.store.db.run("INSERT INTO meta(key,value) VALUES('conversation-pins:owner',?)", [raw]);
      const peer = await connect("device");
      await vi.waitFor(() => expect(peer.frames.some(f => f.type === "sync.complete") || peer.ws.readyState === WebSocket.CLOSED).toBe(true));
      const ready = peer.frames.find(f => f.type === "ready");
      expect(ready).toBeDefined();
      expect(ready).not.toHaveProperty("conversationPins");
      expect(warnings).toContain("conversation_pins_unavailable");
      const headers = { Authorization: `Bearer ${ready!.sessionToken}`, "Content-Type": "application/json" };
      expect((await fetch(hub.url + "/api/conversation-pins", { headers })).ok).toBe(false);
      expect(await hub.store.db.get("SELECT value FROM meta WHERE key='conversation-pins:owner'")).toEqual({ value: raw });
    },
  );
});
