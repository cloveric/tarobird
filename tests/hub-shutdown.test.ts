import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { closeHubRuntime } from "../src/hub/shutdown.js";
import { inspectHubService, startHubControl } from "../src/hub/service.js";
import { acquireInstanceLock, type InstanceLockHandle } from "../src/state/instance-lock.js";

let directory: string, hub: HubServer, lock: InstanceLockHandle, control: (() => Promise<void>) | undefined, url: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "h-shutdown-"));
  lock = await acquireInstanceLock(directory); hub = await HubServer.start({ stateDir: directory }); url = hub.url;
  control = await startHubControl(directory, { running: true, pid: process.pid, url, publicKey: hub.auth.publicKey }, () => hub.beginShutdown());
});
afterEach(async () => {
  vi.restoreAllMocks(); await hub.close().catch(() => undefined);
  if (!hub.shutdownComplete) await hub.store.db.close().catch(() => undefined);
  await control?.().catch(() => undefined); await lock.release(); await rm(directory, { recursive: true, force: true });
});
async function listenerClosed() {
  const target = new URL(url);
  await expect(new Promise<void>((resolve, reject) => {
    const socket = net.connect(Number(target.port), target.hostname);
    socket.once("connect", () => { socket.destroy(); reject(new Error("listener still open")); });
    socket.once("error", error => (error as NodeJS.ErrnoException).code === "ECONNREFUSED" ? resolve() : reject(error));
  })).resolves.toBeUndefined();
}
it("closes actual listeners, SQLite and control and releases ownership despite route and audit failures", async () => {
  vi.spyOn(hub.store, "flushAudit").mockRejectedValue(new Error("fixture_disk_full"));
  await expect(closeHubRuntime({ hub, stopRoutes: async () => { throw new Error("fixture_route_failed"); }, stopControl: control, releaseLock: () => lock.release() })).rejects.toThrow("fixture_route_failed");
  expect(hub.shutdownComplete).toBe(true); await listenerClosed();
  await expect(hub.store.db.get("SELECT 1")).rejects.toThrow();
  expect(await inspectHubService(directory)).toEqual({ running: false });
  const next = await acquireInstanceLock(directory); await next.release();
});
it("freezes admission synchronously before waiting on maintenance and aggregates its failure", async () => {
  let finish!: () => void;
  const maintenance = new Promise<void>(resolve => { finish = resolve; });
  const close = closeHubRuntime({ hub, finishMaintenance: async () => { await maintenance; throw new Error("fixture_maintenance_failed"); }, stopControl: control, releaseLock: () => lock.release() });
  const rejected = expect(close).rejects.toThrow("fixture_maintenance_failed");
  expect((await fetch(url + "/health")).status).toBe(503);
  await expect(hub.cancelHostDrain()).rejects.toThrow("hub_stopping");
  await expect(acquireInstanceLock(directory)).rejects.toThrow("Instance lock already held");
  finish(); await rejected; await listenerClosed(); expect(hub.shutdownComplete).toBe(true);
  const next = await acquireInstanceLock(directory); await next.release();
});
it("retains the instance lock if SQLite closure is unconfirmed, while still closing network resources", async () => {
  vi.spyOn(hub.store.db, "close").mockRejectedValueOnce(new Error("fixture_database_busy"));
  await expect(closeHubRuntime({ hub, stopControl: control, releaseLock: () => lock.release() })).rejects.toThrow("instance lock retained");
  expect(hub.shutdownComplete).toBe(false); await listenerClosed();
  expect(await inspectHubService(directory)).toEqual({ running: false });
  await expect(hub.store.db.get("SELECT 1 AS still_owned")).resolves.toEqual({ still_owned: 1 });
  await expect(acquireInstanceLock(directory)).rejects.toThrow("Instance lock already held");
});
