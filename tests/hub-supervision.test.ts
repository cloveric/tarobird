import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { DEFAULT_UNCLEAN_BOOT_WINDOW_MS } from "../src/runtime/restart-loop-guard.js";

vi.mock("node:child_process", async (original) => {
  const module = await original<typeof import("node:child_process")>();
  return { ...module, fork: vi.fn(module.fork) };
});

let root: string, hub: HubServer, manager: BotManager;
let spawned: childProcess.ChildProcess[];
const spec = { requestId: "supervised", name: "Fixture", engine: "codex" as const, model: "", effort: "" as const, workspace: "" };
const until = async (check: () => boolean | Promise<boolean>, timeout = 10000) => {
  const deadline = performance.now() + timeout;
  while (!await check()) { if (performance.now() > deadline) throw new Error("supervisor_timeout"); await new Promise((resolve) => setTimeout(resolve, 20)); }
};
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-supervision-")); hub = await HubServer.start({ stateDir: root }); spawned = [];
  const { fork } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(childProcess.fork).mockImplementation((...args: Parameters<typeof childProcess.fork>) => { const child = fork(...args); spawned.push(child); return child; });
  manager = new BotManager(hub.store, root, { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { PATH: process.env.PATH, CODEX_EXECUTABLE: process.execPath } }, () => hub.instanceUrl, async () => {});
});
afterEach(async () => {
  // A supervision regression must not orphan the very child used to expose it.
  vi.restoreAllMocks();
  await manager?.close();
  await Promise.all(spawned.map(async (child) => { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); }); }));
  await hub.close(); await rm(root, { recursive: true, force: true });
});
async function create() { const bot = await manager.create("owner", spec); await until(async () => (await hub.store.bots("owner"))[0]?.online === 1); return bot.id; }
async function nextChild(old: childProcess.ChildProcess) { await until(() => spawned.at(-1) !== old && !!spawned.at(-1)?.pid); return spawned.at(-1)!; }

it("redacts chunked worker stderr in service status and exit logs, retaining safe history after restart", async () => {
  const id = await create(), child = spawned.at(-1)!;
  child.send({ type: "fixture.stderr" });
  await until(() => manager.serviceStatus(id).text.includes("[redacted]"));
  expect(manager.serviceStatus(id).text).not.toContain("Zml4dHVyZTpzZWNyZXQ=");
  child.kill("SIGKILL"); await nextChild(child);
  expect(manager.serviceStatus(id).text).toContain("[redacted]");
  const log = await readFile(path.join(root, "bots", id, "service.lifecycle.log.jsonl"), "utf8");
  expect(log).toContain("process.exit"); expect(log).not.toContain("Zml4dHVyZTpzZWNyZXQ=");
});

it("limits a burst of crashes but does not accumulate failures across healthy intervals", async () => {
  const id = await create(); let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  for (let i = 0; i < 4; i++) {
    now += DEFAULT_UNCLEAN_BOOT_WINDOW_MS + 1;
    const child = spawned.at(-1)!; child.kill("SIGKILL"); await nextChild(child);
    await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
  }
  expect(manager.serviceStatus(id).text).toContain("PID:");
  // Four fresh failures exhaust fast retries but retain a slow recovery probe.
  now += DEFAULT_UNCLEAN_BOOT_WINDOW_MS + 1;
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => timeout(fn, ms === 60_000 ? 500 : ms, ...args)) as typeof setTimeout);
  let lastStopped: childProcess.ChildProcess | undefined;
  let countBeforeLastStop = 0;
  for (let i = 0; i < 4; i++) {
    const child = spawned.at(-1)!; child.kill("SIGKILL");
    lastStopped = child; countBeforeLastStop = spawned.length;
    if (i < 3) { await nextChild(child); await until(async () => (await hub.store.bots("owner"))[0]?.online === 1); }
    else await until(() => child.signalCode !== null);
  }
  expect(manager.serviceStatus(id).text).toContain("慢速重试");
  // The exit callback publishes its audit asynchronously. Observing signalCode
  // or serviceStatus does not mean the serialized database write has finished.
  await until(async () => {
    const audit = await hub.store.db.get<{ detail_json: string }>("SELECT detail_json FROM audit_log WHERE kind='bot.worker_stopped' ORDER BY id DESC LIMIT 1");
    return !!audit && JSON.parse(audit.detail_json).recentFailures === 4;
  });
  const audit = await hub.store.db.get<{ detail_json: string }>("SELECT detail_json FROM audit_log WHERE kind='bot.worker_stopped' ORDER BY id DESC LIMIT 1");
  expect(JSON.parse(audit!.detail_json)).toMatchObject({ recentFailures: 4, restartPaused: false, retryAfterMs: 60_000 });
  expect(await readFile(path.join(root, "bots", id, "service.lifecycle.log.jsonl"), "utf8")).toContain('"retryAfterMs":60000');
  await nextChild(lastStopped!);
  expect(spawned).toHaveLength(countBeforeLastStop + 1);
  await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
}, 30000);

it("retains a live child after IPC errors and refuses to report a disconnected child as restarted", async () => {
  manager.options.env!.TAROCUB_FIXTURE_HOLD_DISCONNECT = "1";
  const id = await create(), child = spawned.at(-1)!;
  child.emit("error", new Error("synthetic_ipc_error"));
  expect(manager.serviceStatus(id).text).toContain(`PID: ${child.pid}`);
  await new Promise((resolve) => setTimeout(resolve, 1200)); expect(spawned).toHaveLength(1);
  const send = vi.spyOn(child, "send").mockImplementation((...args: unknown[]) => { const callback = args.at(-1); if (typeof callback === "function") callback(new Error("synthetic_send_failure")); return false; });
  expect(await manager.restart(id, "send_failed")).toEqual({ ok: false, error: "restart_send_failed" });
  send.mockRestore();
  child.disconnect(); await until(() => !child.connected);
  expect(await manager.restart(id, "disconnected")).toEqual({ ok: false, error: "bot_worker_stopping" });
  expect(manager.serviceStatus(id).text).toContain(`PID: ${child.pid}`); expect(spawned).toHaveLength(1);
  process.kill(child.pid!, 0);
});

it.each(["none", "wrong", "wrong_pid"])("requires a matching worker receipt when replies are %s", async (mode) => {
  manager.options.env!.TAROCUB_FIXTURE_ACK = mode;
  const id = await create(), child = spawned.at(-1)!;
  expect(await manager.restart(id, "unconfirmed")).toEqual({ ok: false, error: "restart_confirmation_unavailable" });
  expect(spawned).toHaveLength(1); expect(child.exitCode).toBeNull();
  // A cached uncertain result must never issue a second control message.
  const send = vi.spyOn(child, "send");
  expect(await manager.restart(id, "unconfirmed")).toEqual({ ok: false, error: "restart_confirmation_unavailable" }); expect(send).not.toHaveBeenCalled();
});

it("reports a failed spawn without pretending that an offline Bot has started", async () => {
  vi.mocked(childProcess.fork).mockImplementation(() => {
    const child = new childProcess.ChildProcess();
    queueMicrotask(() => child.emit("error", new Error("synthetic_spawn_failure")));
    return child;
  });
  const bot = await manager.create("owner", spec);
  expect(manager.serviceStatus(bot.id).text).toContain("等待自动重启");
  expect(await manager.restart(bot.id, "failed_spawn")).toEqual({ ok: false, error: "operation_failed" });
  expect(manager.serviceStatus(bot.id).text).not.toContain("PID:");
});

it("persists successful restart receipts across retries and Hub-manager restoration", async () => {
  const id = await create(), first = spawned.at(-1)!;
  const results = await Promise.all([manager.restart(id, "same_request"), manager.restart(id, "same_request")]);
  expect(results).toEqual([{ ok: true, result: { text: "已安排空闲后重启" } }, { ok: true, result: { text: "已安排空闲后重启" } }]);
  await nextChild(first); await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
  const second = spawned.at(-1)!, send = vi.spyOn(second, "send");
  expect(await manager.restart(id, "same_request")).toEqual(results[0]); expect(send).not.toHaveBeenCalled();
  await manager.close();
  manager = new BotManager(hub.store, root, manager.options, () => hub.instanceUrl, async () => {}); await manager.restore();
  await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
  const third = spawned.at(-1)!, nextSend = vi.spyOn(third, "send");
  expect(await manager.restart(id, "same_request")).toEqual(results[0]); expect(nextSend).not.toHaveBeenCalled();
  const receipts = path.join(root, "bot-operations", id, "gateway-receipts"); await mkdir(receipts, { recursive: true });
  const file = (key: string) => path.join(receipts, createHash("sha256").update(`restart:${key}`).digest("hex") + ".json");
  await writeFile(file("uncertain"), JSON.stringify({ state: "running" }));
  expect(await manager.restart(id, "uncertain")).toEqual({ ok: false, error: "operation_interrupted" });
  await writeFile(file("damaged"), "{bad"); await expect(manager.restart(id, "damaged")).rejects.toThrow();
  expect(await readFile(file("damaged"), "utf8")).toBe("{bad"); expect(nextSend).not.toHaveBeenCalled();
  await expect(manager.restart("unknown", "request")).rejects.toThrow("bot_forbidden");
});
