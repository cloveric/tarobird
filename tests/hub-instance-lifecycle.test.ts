import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";

let directory: string, hub: HubServer;
const sockets: WebSocket[] = [];
const secret = randomBytes(32).toString("base64url");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "hub-instance-lifecycle-"));
  hub = await HubServer.start({ stateDir: directory });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
});
afterEach(async () => {
  vi.restoreAllMocks(); sockets.splice(0).forEach(ws => ws.terminate());
  await hub.close(); await rm(directory, { recursive: true, force: true });
});
async function peer() {
  const ws = new WebSocket(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
}
const hello = (key = secret) => JSON.stringify({ v: 1, type: "instance.hello", botId: "alpha", secret: key, engine: "codex", model: "fixture", effort: "" });

it.each([false, true])("drops a closed authentication attempt without changing live Bot ownership (existing=%s)", async existing => {
  let live: WebSocket | undefined;
  if (existing) {
    live = await peer();
    const ready = new Promise<void>(resolve => live!.once("message", () => resolve()));
    live.send(hello()); await ready;
  }
  const entered = deferred(), release = deferred();
  const closed = deferred();
  hub.http.once("upgrade", (_request, socket) => socket.once("close", () => closed.resolve()));
  const get = hub.store.db.get.bind(hub.store.db);
  vi.spyOn(hub.store.db, "get").mockImplementation(async (sql, params) => {
    const row = await get(sql, params);
    if (sql === "SELECT secret_hash FROM bots WHERE id=? AND deleted_at IS NULL") { entered.resolve(); await release.promise; }
    return row;
  });
  const status = vi.spyOn(hub.store, "botStatus");
  const ws = await peer(); ws.send(hello());
  try { await entered.promise; ws.close(); await closed.promise; }
  finally { release.resolve(); }
  // Drain the database read and any status write enqueued by its continuation.
  await hub.store.db.serial(async () => undefined);
  await hub.store.db.serial(async () => undefined);
  expect((await hub.store.bots("owner"))[0]?.online).toBe(existing ? 1 : 0);
  expect(status.mock.calls.some(([, value]) => value.online === 1)).toBe(false);
  if (live) expect(live.readyState).toBe(WebSocket.OPEN);
});

it("does not authenticate a pipelined hello after rejecting the same socket", async () => {
  const status = vi.spyOn(hub.store, "botStatus");
  const ws = await peer();
  const closed = new Promise<void>(resolve => ws.once("close", () => resolve()));
  ws.send(hello("wrong-secret")); ws.send(hello());
  await closed;
  await hub.store.db.serial(async () => undefined);
  await hub.store.db.serial(async () => undefined);
  expect((await hub.store.bots("owner"))[0]?.online).toBe(0);
  expect(status.mock.calls.some(([, value]) => value.online === 1)).toBe(false);
});
