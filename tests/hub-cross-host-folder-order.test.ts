import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CROSS_HOST_FOLDER_ORDER_CAPABILITY } from "../src/client-protocol/cross-host-folder-order.js";
import { deviceProof } from "../src/hub/auth.js";
import { CrossHostFolderOrder } from "../src/hub/cross-host-folder-order.js";
import { HubDatabase } from "../src/hub/database.js";
import { HubServer } from "../src/hub/server.js";

const k = (hostKey: string, folderId: string | null) => JSON.stringify([hostKey, folderId]);

describe("cross-host folder order store", () => {
  let root: string, db: HubDatabase, clock: number, store: CrossHostFolderOrder;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hub-cross-host-order-"));
    db = await HubDatabase.open(root);
    clock = 10_000;
    store = new CrossHostFolderOrder(db, () => clock);
    await db.run("INSERT INTO users VALUES('owner','Owner','owner'),('other','Other','member')");
  });
  afterEach(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });

  it("persists per user across reopen, enforces revision, allows pinned restoration slot, and isolates users", async () => {
    expect(await store.read("owner")).toEqual({ version: 1, revision: 0, updatedAt: 0, pinned: [], ordinary: [] });

    const r1 = await store.change("owner", {
      revision: 0,
      updatedAt: 11_000,
      pinned: [k("hubA", "work")],
      ordinary: [k("hubB", "ops"), k("hubA", "work"), k("hubA", null)],
    });
    expect(r1).toEqual({
      changed: true,
      state: {
        version: 1,
        revision: 1,
        updatedAt: 11_000,
        pinned: [k("hubA", "work")],
        ordinary: [k("hubB", "ops"), k("hubA", "work"), k("hubA", null)],
      },
    });

    await expect(store.change("owner", {
      revision: 0,
      updatedAt: 12_000,
      pinned: [],
      ordinary: [k("hubA", null)],
    })).rejects.toThrow("cross_host_folder_order_changed");

    expect(await store.read("other")).toEqual({ version: 1, revision: 0, updatedAt: 0, pinned: [], ordinary: [] });

    await db.close();
    db = await HubDatabase.open(root);
    store = new CrossHostFolderOrder(db, () => clock);
    expect(await store.read("owner")).toEqual(r1.state);
  });

  it("applies LWW updatedAt, ignores stale timestamps, deduplicates within tiers, and clamps far-future clocks", async () => {
    clock = 10_000;
    const initial = await store.change("owner", {
      revision: 0,
      updatedAt: 10_000,
      pinned: [k("hubA", "f1"), k("hubA", "f1")],
      ordinary: [k("hubB", "f2"), k("hubA", null)],
    });
    expect(initial.state).toEqual({
      version: 1,
      revision: 1,
      updatedAt: 10_000,
      pinned: [k("hubA", "f1")],
      ordinary: [k("hubB", "f2"), k("hubA", null)],
    });

    // Stale updatedAt does not overwrite newer state or bump revision.
    const stale = await store.change("owner", {
      revision: 1,
      updatedAt: 9_000,
      pinned: [],
      ordinary: [k("hubA", null)],
    });
    expect(stale).toEqual({ changed: false, state: initial.state });

    // Identical timestamp + identical order is a no-op.
    const same = await store.change("owner", {
      revision: 1,
      updatedAt: 10_000,
      pinned: [k("hubA", "f1")],
      ordinary: [k("hubB", "f2"), k("hubA", null)],
    });
    expect(same).toEqual({ changed: false, state: initial.state });

    // Far-future timestamp is clamped to now + 60s.
    const clamped = await store.change("owner", {
      revision: 1,
      updatedAt: 999_999,
      pinned: [],
      ordinary: [k("hubB", "f2"), k("hubA", "f1"), k("hubA", null)],
    });
    expect(clamped.changed).toBe(true);
    expect(clamped.state.revision).toBe(2);
    expect(clamped.state.updatedAt).toBe(70_000);
  });
});

describe("HubServer cross-host folder order sync", () => {
  let root: string, hub: HubServer;
  const sockets: WebSocket[] = [], warnings: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hub-cross-host-server-"));
    warnings.length = 0;
    hub = await HubServer.start({ stateDir: root, onWarning: code => warnings.push(code) });
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

  it("exposes order in ready, updates via GET/PATCH, broadcasts to same owner devices, and isolates users", async () => {
    await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    const devA = await connect("dev-a", "owner");
    const devB = await connect("dev-b", "owner");
    const otherUser = await connect("dev-other", "member");
    await vi.waitFor(() => {
      expect(devA.frames.some(f => f.type === "sync.complete")).toBe(true);
      expect(devB.frames.some(f => f.type === "sync.complete")).toBe(true);
      expect(otherUser.frames.some(f => f.type === "sync.complete")).toBe(true);
    });

    const readyA = devA.frames.find(f => f.type === "ready")!;
    expect(readyA.serverCapabilities).toContain(CROSS_HOST_FOLDER_ORDER_CAPABILITY);
    expect(readyA.crossHostFolderOrder).toEqual({ version: 1, revision: 0, updatedAt: 0, pinned: [], ordinary: [] });

    const headersA = { Authorization: `Bearer ${readyA.sessionToken}`, "Content-Type": "application/json" };
    const payload = { revision: 0, updatedAt: Date.now(), pinned: [k("hubB", "f3")], ordinary: [k("hubA", "f1"), k("hubA", null)] };
    const patchRes = await fetch(hub.url + "/api/cross-host-folder-order", {
      method: "PATCH",
      headers: headersA,
      body: JSON.stringify(payload),
    });
    expect(patchRes.status).toBe(200);
    const saved = await patchRes.json();
    expect(saved).toMatchObject({ version: 1, revision: 1, pinned: payload.pinned, ordinary: payload.ordinary });

    const getRes = await fetch(hub.url + "/api/cross-host-folder-order", { headers: headersA });
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(saved);

    await vi.waitFor(() => {
      expect(devB.frames.some(f => f.type === "cross-host-folder-order.updated" && f.order?.revision === 1)).toBe(true);
    });
    expect(devB.frames.find(f => f.type === "cross-host-folder-order.updated")!.order).toEqual(saved);
    expect(otherUser.frames.some(f => f.type === "cross-host-folder-order.updated")).toBe(false);
  });

  it.each(["{invalid", JSON.stringify({ version: 1, revision: 1, updatedAt: 1, pinned: "bad", ordinary: [] })])(
    "keeps a device online when optional cross-host folder order metadata is corrupt: %s",
    async raw => {
      await hub.store.db.run("INSERT INTO meta(key,value) VALUES('cross-host-folder-order:owner',?)", [raw]);
      const peer = await connect("device");
      await vi.waitFor(() => expect(peer.frames.some(f => f.type === "sync.complete") || peer.ws.readyState === WebSocket.CLOSED).toBe(true));
      const ready = peer.frames.find(f => f.type === "ready");
      expect(ready).toBeDefined();
      expect(ready).not.toHaveProperty("crossHostFolderOrder");
      expect(warnings).toContain("cross_host_folder_order_unavailable");
      const headers = { Authorization: `Bearer ${ready!.sessionToken}`, "Content-Type": "application/json" };
      expect((await fetch(hub.url + "/api/cross-host-folder-order", { headers })).ok).toBe(false);
      expect(await hub.store.db.get("SELECT value FROM meta WHERE key='cross-host-folder-order:owner'")).toEqual({ value: raw });
    },
  );
});
