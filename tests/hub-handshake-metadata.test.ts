import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceProof } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import type { HubAvatars } from "../src/hub/avatars.js";
import { avatarDataUrl } from "./helpers/avatar-fixture.js";

let root: string, hub: HubServer;
const sockets: WebSocket[] = [], warnings: string[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-handshake-metadata-"));
  warnings.length = 0;
  hub = await HubServer.start({ stateDir: root, onWarning: code => warnings.push(code) });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
});
afterEach(async () => { sockets.splice(0).forEach(ws => ws.terminate()); await hub.close(); await rm(root, { recursive: true, force: true }); });

async function connect(id: string) {
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, id);
  await hub.auth.approve(pair.code, "local-owner");
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

it("delivers metadata changes after ready when they happen after handshake snapshots are read", async () => {
  const first = await connect("first");
  await vi.waitFor(() => expect(first.frames.some(f => f.type === "sync.complete")).toBe(true));
  const headers = { Authorization: `Bearer ${first.frames.find(f => f.type === "ready")!.sessionToken}` };
  const avatars = (hub as unknown as { avatars: HubAvatars }).avatars;
  const list = avatars.list.bind(avatars);
  let held = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(avatars, "list").mockImplementationOnce(async (...args) => { const result = await list(...args); held = true; await gate; return result; });
  try {
    const second = await connect("second");
    await vi.waitFor(() => expect(held).toBe(true));
    expect((await fetch(hub.url + "/api/bots/alpha/name", { method: "PUT", headers, body: JSON.stringify({ name: "Renamed", expectedName: "Alpha" }) })).status).toBe(200);
    expect((await fetch(hub.url + "/api/conversation-folders", { method: "PATCH", headers, body: JSON.stringify({ type: "create", id: "work", name: "Work", revision: 0 }) })).status).toBe(200);
    expect((await fetch(hub.url + "/api/avatars/bot/alpha", { method: "PUT", headers, body: JSON.stringify({ dataUrl: avatarDataUrl(), expectedRevision: 0 }) })).status).toBe(200);
    first.send({ type: "conversation.create", clientActionId: "new_chat", botIds: ["alpha"], title: "During handshake" });
    await vi.waitFor(() => expect(first.frames.some(f => f.type === "conversation.updated")).toBe(true));
    const conversationId = first.frames.find(f => f.type === "conversation.updated")!.conversation.id as string;
    const message = await hub.store.sendMessage("owner", { conversationId, clientMsgId: "during_handshake", text: "Also retain the journal event", attachments: [] });
    release();
    await vi.waitFor(() => expect(second.frames.some(f => f.type === "sync.complete")).toBe(true));
    const readyIndex = second.frames.findIndex(f => f.type === "ready");
    for (const type of ["bot.status", "conversation.updated", "conversation-folders.updated", "avatar.updated"]) {
      expect(second.frames.findIndex(f => f.type === type), type).toBeGreaterThan(readyIndex);
    }
    // The App ignores application frames before ready, then applies these updates.
    const visible = second.frames.slice(readyIndex + 1);
    expect(visible.find(f => f.type === "bot.status")?.bot.name).toBe("Renamed");
    expect(visible.find(f => f.type === "conversation.updated")?.conversation.title).toBe("During handshake");
    expect(visible.find(f => f.type === "conversation-folders.updated")?.folders.revision).toBe(1);
    expect(visible.find(f => f.type === "avatar.updated")?.avatar.revision).toBe(1);
    expect(visible.find(f => f.type === "event" && f.payload?.id === message.message.id)?.payload.conversationId).toBe(conversationId);
  } finally { release(); spy.mockRestore(); }
});

it.each(["{invalid", JSON.stringify({ revision: 1, folders: "invalid", assignments: [] })])("keeps a device online with unreadable optional folders: %s", async raw => {
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES('conversation-folders:owner',?)", [raw]);
  const peer = await connect("device");
  await vi.waitFor(() => expect(peer.frames.some(f => f.type === "sync.complete") || peer.ws.readyState === WebSocket.CLOSED).toBe(true));
  const ready = peer.frames.find(f => f.type === "ready");
  expect(ready).toBeDefined(); expect(ready).not.toHaveProperty("conversationFolders");
  expect(warnings).toContain("conversation_folders_unavailable");
  const headers = { Authorization: `Bearer ${ready!.sessionToken}` };
  expect((await fetch(hub.url + "/api/conversation-folders", { headers })).ok).toBe(false);
  expect((await fetch(hub.url + "/api/conversation-folders", { method: "PATCH", headers, body: JSON.stringify({ type: "create", id: "work", name: "Work", revision: 0 }) })).ok).toBe(false);
  expect(await hub.store.db.get("SELECT value FROM meta WHERE key='conversation-folders:owner'")).toEqual({ value: raw });
});
