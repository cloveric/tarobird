import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import { CronStore, resolveCronStorePath } from "../src/state/cron-store.js";
import { withBridgeTurnLock } from "../src/runtime/turn-lock.js";
import { childProcessTestEnv, removeTempRoot } from "./helpers/temp-files.js";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const sourceUrl = (file: string) => new URL(`../src/${file}`, import.meta.url).href;
const logger = { error: () => {}, warn: () => {} };

async function killChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGKILL");
  await closed;
}

async function startChild(script: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["--import", tsxLoader, script], {
    env: childProcessTestEnv(), stdio: "pipe",
  });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { errors += chunk.toString(); });
  try {
    await vi.waitFor(() => {
      if (child.exitCode !== null) throw new Error(`fixture exited ${child.exitCode}: ${errors}`);
      expect(output).toContain("READY\n");
    }, { timeout: 15_000 });
    return child;
  } catch (error) { await killChild(child); throw error; }
}

it("never replays an admitted one-shot after its actual owner is killed and a fresh scheduler starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-native-crash-"));
  const store = new CronStore(root);
  const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "fixture only", runOnce: true, timeoutMins: 0,
    targetAt: new Date(Date.now() - 1_000).toISOString() });
  const effects = path.join(root, "effects.txt"), script = path.join(root, "owner.mts");
  await writeFile(script, [
    `import { CronScheduler } from ${JSON.stringify(sourceUrl("runtime/cron-scheduler.ts"))};`,
    `import { CronStore } from ${JSON.stringify(sourceUrl("state/cron-store.ts"))};`,
    "import { appendFile } from 'node:fs/promises';",
    `const root = ${JSON.stringify(root)};`,
    "const keepAlive = setInterval(() => {}, 1000);",
    "const scheduler = new CronScheduler({ store: new CronStore(root), stateDir: root, executor: async () => {",
    `  await appendFile(${JSON.stringify(effects)}, 'effect\\n');`,
    "  process.stdout.write('READY\\n');",
    "  await new Promise(() => {});",
    "} });",
    `await scheduler.runJobNow(${JSON.stringify(job.id)});`,
    "clearInterval(keepAlive);",
  ].join("\n"));
  let child: ChildProcessWithoutNullStreams | undefined;
  let scheduler: CronScheduler | undefined;
  const execute = vi.fn(async () => {});
  try {
    child = await startChild(script);
    expect(await store.get(job.id)).toMatchObject({ enabled: false, runOnceExecution: { status: "started", pid: child.pid } });
    // A second scheduler must also preserve the claim while the owner is alive.
    const observer = new CronScheduler({ store: new CronStore(root), stateDir: root, executor: execute, logger });
    await observer.start(); await observer.runJobNow(job.id); await observer.stop();
    expect(execute).not.toHaveBeenCalled();
    expect((await store.get(job.id))?.runOnceExecution?.status).toBe("started");
    await killChild(child);
    const freshStore = new CronStore(root);
    scheduler = new CronScheduler({ store: freshStore, stateDir: root, executor: execute, logger });
    await scheduler.start(); await scheduler.refresh(); await scheduler.runJobNow(job.id);
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(effects, "utf8")).toBe("effect\n");
    expect(await freshStore.get(job.id)).toMatchObject({ enabled: false, failureCount: 0,
      runOnceExecution: { status: "unknown" }, lastError: expect.stringContaining("结果未确认"), runHistory: [expect.any(Object)] });
    await scheduler.stop();
    // A further restart must not duplicate the recovery record.
    scheduler = new CronScheduler({ store: new CronStore(root), stateDir: root, executor: execute, logger });
    await scheduler.start();
    expect((await freshStore.get(job.id))?.runHistory).toHaveLength(1);
  } finally {
    if (child) await killChild(child);
    await scheduler?.stop();
    await removeTempRoot(root);
  }
}, 30_000);

it("cancels a real cross-process session-lock wait, preserves the live owner, then recovers after owner death", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "turn-lock-native-"));
  const sessionId = `native-lock:${root}`, script = path.join(root, "owner.mts");
  await writeFile(script, [
    `import { withBridgeTurnLock } from ${JSON.stringify(sourceUrl("runtime/turn-lock.ts"))};`,
    "const keepAlive = setInterval(() => {}, 1000);",
    `await withBridgeTurnLock(${JSON.stringify(sessionId)}, async () => {`,
    "  process.stdout.write('READY\\n'); await new Promise(() => {});",
    "}); clearInterval(keepAlive);",
  ].join("\n"));
  let child: ChildProcessWithoutNullStreams | undefined;
  const abort = new AbortController(), entered = vi.fn(async () => {}), waiting = vi.fn();
  try {
    child = await startChild(script);
    const pending = withBridgeTurnLock(sessionId, entered, { signal: abort.signal, waitNotifyAfterMs: 10, onWait: waiting });
    const rejected = expect(pending).rejects.toThrow("cancel fixture wait");
    await vi.waitFor(() => expect(waiting).toHaveBeenCalled());
    abort.abort(new Error("cancel fixture wait"));
    await rejected;
    expect(entered).not.toHaveBeenCalled();
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
    const nextEntered = vi.fn(async () => "recovered");
    const next = withBridgeTurnLock(sessionId, nextEntered, { waitNotifyAfterMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(nextEntered).not.toHaveBeenCalled();
    await killChild(child);
    await expect(next).resolves.toBe("recovered");
    expect(nextEntered).toHaveBeenCalledOnce();
  } finally {
    abort.abort();
    if (child) await killChild(child);
    await removeTempRoot(root);
  }
}, 30_000);

it("cancels a one-shot claim blocked by another process without waiting for or disturbing its lock owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-native-lock-cancel-"));
  const store = new CronStore(root), script = path.join(root, "owner.mts");
  const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "fixture only", runOnce: true, timeoutMins: 0,
    targetAt: "2099-01-01T00:00:00.000Z" });
  await writeFile(script, [
    `import { withFileMutex } from ${JSON.stringify(sourceUrl("state/file-mutex.ts"))};`,
    "const keepAlive = setInterval(() => {}, 1000);",
    `await withFileMutex(${JSON.stringify(resolveCronStorePath(root))}, async () => {`,
    "  process.stdout.write('READY\\n'); await new Promise(() => {});",
    "}); clearInterval(keepAlive);",
  ].join("\n"));
  let child: ChildProcessWithoutNullStreams | undefined, claim: Promise<unknown> | undefined;
  const controller = new AbortController();
  try {
    child = await startChild(script);
    let rejected: unknown;
    claim = store.claimRunOnce(job.id, job.updatedAt, "scheduled", controller.signal).catch(error => { rejected = error; });
    await vi.waitFor(async () => {
      const tickets = await readdir(`${resolveCronStorePath(root)}.mutex.lock`);
      expect(tickets.filter(name => name.startsWith("ticket-v1.")).length).toBe(2);
    }, { timeout: 10_000 });
    controller.abort(new Error("cancel foreign-lock claim"));
    await vi.waitFor(() => expect(rejected).toMatchObject({ message: "cancel foreign-lock claim" }), { timeout: 500 });
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
    await killChild(child); await claim;
    const fresh = new CronStore(root);
    expect(await fresh.get(job.id)).toMatchObject({ enabled: true, failureCount: 0 });
    expect((await fresh.get(job.id))?.runOnceExecution).toBeUndefined();
  } finally {
    controller.abort();
    if (child) await killChild(child);
    await claim; await removeTempRoot(root);
  }
}, 30_000);
