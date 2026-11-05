import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubDatabase } from "../src/hub/database.js";
import { HubStore } from "../src/hub/store.js";

const fault = vi.hoisted(() => ({ chmod: undefined as Error | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, chmod: async (file: string, mode: number) => {
    if (fault.chmod && file.endsWith("hub.sqlite")) throw fault.chmod;
    return fs.chmod(file, mode);
  } };
});
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "hub-startup-cleanup-")); });
afterEach(async () => { fault.chmod = undefined; vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("closes a corrupt database without replacing its bytes or opening WAL sidecars", async () => {
  const file = path.join(root, "hub.sqlite"), bytes = Buffer.alloc(1024, "not sqlite");
  await writeFile(file, bytes);
  const close = vi.spyOn(HubDatabase.prototype, "close");
  await expect(HubDatabase.open(root)).rejects.toMatchObject({ code: "SQLITE_NOTADB" });
  expect(close).toHaveBeenCalledTimes(1);
  expect(await readFile(file)).toEqual(bytes);
  expect(await readdir(root)).not.toContain("hub.sqlite-wal");
});

it("closes after chmod failure and preserves that error even if cleanup reports another error", async () => {
  const originalClose = HubDatabase.prototype.close;
  const close = vi.spyOn(HubDatabase.prototype, "close").mockImplementation(async function () {
    await originalClose.call(this);
    throw new Error("synthetic close failure");
  });
  fault.chmod = Object.assign(new Error("synthetic permission failure"), { code: "EPERM" });
  await expect(HubDatabase.open(root)).rejects.toBe(fault.chmod);
  expect(close).toHaveBeenCalledTimes(1);
});

it("closes the database if initial owner insertion fails, then permits a fresh startup", async () => {
  const originalRun = HubDatabase.prototype.run;
  const failure = Object.assign(new Error("synthetic full disk"), { code: "SQLITE_FULL" });
  const run = vi.spyOn(HubDatabase.prototype, "run").mockImplementation(function (sql, params) {
    if (sql.startsWith("INSERT OR IGNORE INTO users")) return Promise.reject(failure);
    return originalRun.call(this, sql, params);
  });
  const close = vi.spyOn(HubDatabase.prototype, "close");
  await expect(HubStore.open(root)).rejects.toBe(failure);
  expect(close).toHaveBeenCalledTimes(1);
  run.mockRestore();
  const store = await HubStore.open(root);
  try { expect(await store.db.get("SELECT id FROM users WHERE id='owner'")).toEqual({ id: "owner" }); }
  finally { await store.db.close(); }
});
