import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CronScheduler, type CronExecutor } from "../src/runtime/cron-scheduler.js";
import { CronStore, parseCronStoreState, resolveCronStorePath } from "../src/state/cron-store.js";
import { buildCoreCronExecutor } from "../src/core/cron.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { JsonStore } from "../src/state/json-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(run: (root: string, store: CronStore) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-once-claim-"));
  try { await run(root, new CronStore(root)); }
  finally { await removeTempRoot(root); }
}
const oneShot = { chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "once", runOnce: true, timeoutMins: 0,
  targetAt: "2099-01-01T00:00:00.000Z" };
const logger = { error: () => {}, warn: () => {} };

it("persists and disables a manual one-shot before the executor can cause a side effect", async () => fixture(async (root, store) => {
  const job = await store.add(oneShot);
  let admitted: Awaited<ReturnType<CronStore["get"]>>;
  const execute = vi.fn(async () => {
    admitted = await new CronStore(root).get(job.id);
  });
  const scheduler = new CronScheduler({ store, stateDir: root, executor: execute, logger });
  try {
    await scheduler.runJobNow(job.id);
    expect(execute).toHaveBeenCalledOnce();
    expect(admitted!).toMatchObject({ enabled: false,
      runOnceExecution: { status: "started", trigger: "manual", pid: process.pid } });
    expect(await store.get(job.id)).toMatchObject({ enabled: false, failureCount: 0, lastSuccessAt: expect.any(String) });
    expect((await store.get(job.id))?.runOnceExecution).toBeUndefined();
    await scheduler.runJobNow(job.id);
    expect(execute).toHaveBeenCalledOnce();
  } finally { await scheduler.stop(); }
}));

it("atomically admits only one scheduler and does not recover a live owner's claim", async () => fixture(async (root, store) => {
  const job = await store.add(oneShot), done = deferred();
  const execute = vi.fn(async () => { await done.promise; });
  const first = new CronScheduler({ store, stateDir: root, executor: execute, logger });
  const second = new CronScheduler({ store: new CronStore(root), stateDir: root, executor: execute, logger });
  const running = Promise.all([first.runJobNow(job.id), second.runJobNow(job.id)]);
  try {
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await second.start();
    expect(await store.get(job.id)).toMatchObject({ enabled: false, failureCount: 0, runOnceExecution: { status: "started" } });
    expect(second.countScheduled()).toBe(0);
  } finally { done.resolve(); await running; await first.stop(); await second.stop(); }
}));

it("recovers a persisted dead-owner claim as unconfirmed without retry or failure-count increment", async () => fixture(async (root, store) => {
  const job = await store.add({ ...oneShot, targetAt: new Date(Date.now() - 1000).toISOString() });
  await store.claimRunOnce(job.id, job.updatedAt, "scheduled");
  // Persisted crash fixture: no terminal bookkeeping, with a definitely absent
  // process owner. Restart uses a new store and scheduler, not in-memory state.
  const file = resolveCronStorePath(root), saved = JSON.parse(await readFile(file, "utf8"));
  saved.jobs[0].runOnceExecution.pid = 2_147_483_647;
  await writeFile(file, JSON.stringify(saved));
  const execute = vi.fn(async () => {}), freshStore = new CronStore(root);
  const fresh = new CronScheduler({ store: freshStore, stateDir: root, executor: execute, logger });
  try {
    await fresh.start(); await fresh.refresh(); await fresh.runJobNow(job.id);
    expect(execute).not.toHaveBeenCalled();
    const recovered = await freshStore.get(job.id);
    expect(recovered).toMatchObject({ enabled: false, failureCount: 0, lastError: expect.stringContaining("结果未确认"),
      runOnceExecution: { status: "unknown", trigger: "scheduled" } });
    expect(recovered?.runHistory).toHaveLength(1);
    // Explicit re-enable is the existing user's consent to retry. An ordinary
    // refresh/run does not silently rearm a disabled one-shot.
    await freshStore.update(job.id, { enabled: true });
    await fresh.runJobNow(job.id);
    expect(execute).toHaveBeenCalledOnce();
    expect((await freshStore.get(job.id))?.runOnceExecution).toBeUndefined();
  } finally { await fresh.stop(); }
}));

it.each([false, true])("keeps real queued one-shots unclaimed until admission (cancel=%s)", async cancel => fixture(async (root, store) => {
  await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
  const runtime = createCoreServiceRuntime(), unblock = deferred();
  const blocking = runtime.chatQueue.enqueue("lark:gw_scheduled", () => unblock.promise);
  const job = await store.add({ ...oneShot, channel: "lark", deliveryMode: "agent", larkChatId: "gw_scheduled", conversationKey: "lark:gw_scheduled" });
  const execute = vi.fn(async () => {
    expect(await store.get(job.id)).toMatchObject({ enabled: false, runOnceExecution: { status: "started" } });
    return { text: "done" };
  });
  const core = buildCoreCronExecutor({ stateDir: root, runtime, bridge: { handleAuthorizedMessage: execute },
    channel: { profile: "gateway", send: vi.fn(async () => ({ messageId: "reply" })), stream: vi.fn(), downloadResource: vi.fn() } });
  const scheduler = new CronScheduler({ store, stateDir: root, executorManagesAdmission: true, executor: core, logger });
  const running = withChannelProfile("gateway", () => scheduler.runJobNow(job.id));
  try {
    await vi.waitFor(() => expect(runtime.chatQueue.pendingCount("lark:gw_scheduled")).toBe(1));
    expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: 0 });
    expect((await store.get(job.id))?.runOnceExecution).toBeUndefined();
    const stopping = cancel ? scheduler.stop() : Promise.resolve();
    unblock.resolve(); await Promise.all([blocking, running, stopping]);
    expect(execute).toHaveBeenCalledTimes(cancel ? 0 : 1);
    expect((await store.get(job.id))?.enabled).toBe(cancel);
    expect((await store.get(job.id))?.runOnceExecution).toBeUndefined();
  } finally { unblock.resolve(); await running; await scheduler.stop(); }
}));

it("releases a claim when cancelled during its durable write before execution", async () => fixture(async (root, store) => {
  const job = await store.add(oneShot), written = deferred(), release = deferred();
  const claim = store.claimRunOnce.bind(store);
  vi.spyOn(store, "claimRunOnce").mockImplementationOnce(async (...args) => {
    const result = await claim(...args); written.resolve(); await release.promise; return result;
  });
  const execute = vi.fn(async () => {}), scheduler = new CronScheduler({ store, stateDir: root, executor: execute, logger });
  const running = scheduler.runJobNow(job.id);
  try {
    await written.promise;
    const stopped = scheduler.stop(); release.resolve(); await Promise.all([running, stopped]);
    expect(execute).not.toHaveBeenCalled();
    expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: 0 });
    expect((await store.get(job.id))?.runOnceExecution).toBeUndefined();
  } finally { release.resolve(); await running; await scheduler.stop(); }
}));

it("does not execute or consume the one-shot when the durable claim cannot be written", async () => fixture(async (root, store) => {
  const job = await store.add(oneShot);
  vi.spyOn(store, "claimRunOnce").mockRejectedValueOnce(new Error("disk unavailable"));
  const execute = vi.fn(async () => {}), scheduler = new CronScheduler({ store, stateDir: root, executor: execute, logger });
  try {
    await scheduler.runJobNow(job.id);
    expect(execute).not.toHaveBeenCalled();
    expect((await store.get(job.id))?.enabled).toBe(true);
  } finally { await scheduler.stop(); }
}));

it.each([false, true])("waits for explicit retry after a failed claim, even when recording the failure also fails (recordFailure=%s)", async recordFailure => fixture(async (root, store) => {
  await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
  const job = await store.add({ ...oneShot, targetAt: new Date(Date.now() - 1_000).toISOString(),
    channel: "lark", deliveryMode: "agent", larkChatId: "gw_claim_retry", conversationKey: "lark:gw_claim_retry" });
  const claim = vi.spyOn(store, "claimRunOnce").mockRejectedValue(new Error("disk unavailable"));
  const record = recordFailure ? vi.spyOn(store, "recordRun").mockRejectedValue(new Error("still unavailable")) : undefined;
  const execute = vi.fn(async () => ({ text: "done" })), failed = vi.fn(async (_job: unknown, _message: string) => {});
  const core = buildCoreCronExecutor({ stateDir: root, runtime: createCoreServiceRuntime(),
    bridge: { handleAuthorizedMessage: execute }, channel: { profile: "gateway",
      send: vi.fn(async () => ({ messageId: "reply" })), stream: vi.fn(), downloadResource: vi.fn() } });
  const scheduler = new CronScheduler({ store, stateDir: root, executorManagesAdmission: true,
    executor: (...args) => withChannelProfile("gateway", () => core(...args)), onJobFailure: failed, logger });
  try {
    await scheduler.start();
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce(); expect(scheduler.activeCount()).toBe(0); });
    expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: recordFailure ? 0 : 1 });
    expect((await store.get(job.id))?.runOnceExecution).toBeUndefined();
    expect(failed.mock.calls[0]?.[1]).toContain("未执行，等待重试");
    for (let index = 0; index < 3; index += 1) {
      await scheduler.refresh();
      scheduler.pauseAdmission(); await scheduler.resumeAdmission();
      expect(scheduler.countScheduled()).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(claim).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
    record?.mockRestore(); claim.mockRestore();
    await scheduler.runJobNow(job.id);
    expect(execute).toHaveBeenCalledOnce();
    expect(await store.get(job.id)).toMatchObject({ enabled: false, failureCount: 0, lastSuccessAt: expect.any(String) });
  } finally { record?.mockRestore(); claim.mockRestore(); await scheduler.stop(); }
}));

it.each(["edit", "enable", "restart"])("allows a failed claim to retry after explicit %s", async retry => fixture(async (root, store) => {
  const job = await store.add({ ...oneShot, targetAt: new Date(Date.now() - 1_000).toISOString() });
  const claim = vi.spyOn(store, "claimRunOnce").mockRejectedValueOnce(new Error("disk unavailable"));
  const execute = vi.fn(async () => {}), failed = vi.fn(async () => {});
  const create = () => new CronScheduler({ store, stateDir: root, executor: execute, onJobFailure: failed, logger });
  let scheduler = create();
  try {
    await scheduler.start();
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce(); expect(scheduler.activeCount()).toBe(0); });
    await scheduler.refresh(); expect(scheduler.countScheduled()).toBe(0);
    if (retry === "restart") { await scheduler.stop(); scheduler = create(); await scheduler.start(); }
    else {
      await store.update(job.id, retry === "enable" ? { enabled: true } : { prompt: "explicitly revised task" });
      await scheduler.refresh();
    }
    await vi.waitFor(() => { expect(execute).toHaveBeenCalledOnce(); expect(scheduler.activeCount()).toBe(0); });
    expect(claim).toHaveBeenCalledTimes(2); expect(failed).toHaveBeenCalledOnce();
    expect(await store.get(job.id)).toMatchObject({ enabled: false, failureCount: 0, lastSuccessAt: expect.any(String) });
  } finally { claim.mockRestore(); await scheduler.stop(); }
}));

it.each([false, true])("retains the retry fence when an older refresh snapshot finishes late (missingJob=%s)", async missingJob => fixture(async (root, store) => {
  const job = await store.add({ ...oneShot, targetAt: new Date(Date.now() - 1_000).toISOString() });
  const entered = deferred(), release = deferred();
  const list = vi.spyOn(store, "list").mockImplementationOnce(async () => {
    entered.resolve(); await release.promise; return missingJob ? [] : [job];
  });
  const claim = vi.spyOn(store, "claimRunOnce").mockRejectedValue(new Error("disk unavailable"));
  const execute = vi.fn(async () => {}), failed = vi.fn(async () => {});
  const scheduler = new CronScheduler({ store, stateDir: root, executor: execute, onJobFailure: failed, logger });
  const refresh = scheduler.refresh();
  try {
    await entered.promise;
    await scheduler.runJobNow(job.id);
    release.resolve(); await refresh;
    await scheduler.refresh();
    expect(scheduler.countScheduled()).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(claim).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
  } finally { release.resolve(); await refresh; list.mockRestore(); claim.mockRestore(); await scheduler.stop(); }
}));

it("does not fence a concurrent user revision when the old claim fails", async () => fixture(async (root, store) => {
  const job = await store.add(oneShot), entered = deferred(), release = deferred();
  const claim = vi.spyOn(store, "claimRunOnce").mockImplementationOnce(async () => {
    entered.resolve(); await release.promise; throw new Error("old claim failed");
  });
  const execute = vi.fn(async () => {}), failed = vi.fn(async () => {});
  const scheduler = new CronScheduler({ store, stateDir: root, executor: execute, onJobFailure: failed, logger });
  const running = scheduler.runJobNow(job.id);
  try {
    await entered.promise;
    await store.update(job.id, { prompt: "new plan", targetAt: new Date(Date.now() - 1_000).toISOString() });
    release.resolve(); await running;
    expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: 0, prompt: "new plan" });
    await scheduler.refresh();
    await vi.waitFor(() => { expect(execute).toHaveBeenCalledOnce(); expect(scheduler.activeCount()).toBe(0); });
    expect(claim).toHaveBeenCalledTimes(2); expect(failed).toHaveBeenCalledOnce();
  } finally { release.resolve(); await running; claim.mockRestore(); await scheduler.stop(); }
}));

it("settles a one-shot preparation failure once instead of retrying on refresh or restart", async () => fixture(async (root, store) => {
  const job = await store.add({ ...oneShot, targetAt: new Date(Date.now() - 1_000).toISOString() });
  const failed = vi.fn(async () => {});
  const execute = vi.fn<CronExecutor>(async (_job, _signal, lifecycle) => { await lifecycle!.deferTimeoutUntilStarted()(); });
  execute.mockRejectedValueOnce(new Error("Gateway channel is unavailable for this scheduled job"));
  let scheduler = new CronScheduler({ store, stateDir: root, executor: execute, executorManagesAdmission: true, onJobFailure: failed, logger });
  try {
    await scheduler.start();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(await store.get(job.id)).toMatchObject({ enabled: false, failureCount: 1,
      lastError: "Gateway channel is unavailable for this scheduled job" });
    expect((await store.get(job.id))?.runOnceExecution).toBeUndefined();
    for (let index = 0; index < 3; index += 1) { await scheduler.refresh(); await scheduler.runJobNow(job.id); }
    await scheduler.stop();
    scheduler = new CronScheduler({ store: new CronStore(root), stateDir: root, executor: execute,
      executorManagesAdmission: true, onJobFailure: failed, logger });
    await scheduler.start(); await scheduler.runJobNow(job.id);
    expect(execute).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
    expect((await store.get(job.id))?.runHistory).toHaveLength(1);
    await store.update(job.id, { enabled: true, targetAt: oneShot.targetAt });
    await scheduler.runJobNow(job.id);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await store.get(job.id)).toMatchObject({ enabled: false, failureCount: 0, lastSuccessAt: expect.any(String) });
  } finally { await scheduler.stop(); }
}));

it("does not disable a concurrently rescheduled one-shot when its old preparation fails", async () => fixture(async (root, store) => {
  const job = await store.add(oneShot), entered = deferred(), finish = deferred();
  const execute = vi.fn(async () => { entered.resolve(); await finish.promise; throw new Error("preparation failed"); });
  const scheduler = new CronScheduler({ store, stateDir: root, executor: execute, executorManagesAdmission: true, logger });
  const run = scheduler.runJobNow(job.id);
  try {
    await entered.promise;
    await store.update(job.id, { prompt: "explicitly rescheduled", targetAt: "2099-02-01T00:00:00.000Z" });
    finish.resolve(); await run;
    expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: 0,
      prompt: "explicitly rescheduled", targetAt: "2099-02-01T00:00:00.000Z" });
  } finally { finish.resolve(); await run; await scheduler.stop(); }
}));

it("records a one-shot executor returning without admission as not executed, never success", async () => fixture(async (root, store) => {
  const job = await store.add(oneShot);
  const execute = vi.fn(async () => {}), failed = vi.fn(async () => {});
  const scheduler = new CronScheduler({ store, stateDir: root, executor: execute,
    executorManagesAdmission: true, onJobFailure: failed, logger });
  try {
    await scheduler.runJobNow(job.id);
    const result = await store.get(job.id);
    expect(result).toMatchObject({ enabled: false, lastError: expect.stringContaining("not executed"), failureCount: 1 });
    expect(result?.lastSuccessAt).toBeUndefined(); expect(result?.runOnceExecution).toBeUndefined();
    await scheduler.refresh(); await scheduler.runJobNow(job.id);
    expect(execute).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
  } finally { await scheduler.stop(); }
}));

it("cancels a claim waiting behind the same store's earlier write without waiting for that write", async () => fixture(async (_root, store) => {
  const job = await store.add(oneShot), writing = deferred(), release = deferred();
  const original = JsonStore.prototype.write;
  const heldWrite = vi.spyOn(JsonStore.prototype, "write").mockImplementationOnce(async function (this: JsonStore<unknown>, value) {
    writing.resolve(); await release.promise; return original.call(this, value);
  });
  const preceding = store.update(job.id, { description: "fixture" });
  const controller = new AbortController();
  let claim: Promise<unknown> | undefined;
  try {
    await writing.promise;
    let rejected: unknown;
    const queuedStore = store as unknown as { pendingWrite: Promise<void> };
    const previousTail = queuedStore.pendingWrite;
    claim = store.claimRunOnce(job.id, job.updatedAt, "scheduled", controller.signal).catch(error => { rejected = error; });
    await vi.waitFor(() => expect(queuedStore.pendingWrite).not.toBe(previousTail), { timeout: 10_000 });
    controller.abort(new Error("cancel queued claim"));
    await vi.waitFor(() => expect(rejected).toMatchObject({ message: "cancel queued claim" }), { timeout: 500 });
    release.resolve(); await preceding; await claim;
    expect((await store.get(job.id))?.enabled).toBe(true);
    expect((await store.get(job.id))?.runOnceExecution).toBeUndefined();
  } finally { release.resolve(); await preceding; await claim; heldWrite.mockRestore(); }
}));

it("records an interrupted admitted one-shot as unconfirmed without counting task failure", async () => fixture(async (root, store) => {
  const job = await store.add(oneShot), started = deferred();
  const execute = vi.fn(async (_job, signal: AbortSignal) => {
    started.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const scheduler = new CronScheduler({ store, stateDir: root, executor: execute, logger });
  const running = scheduler.runJobNow(job.id);
  try {
    await started.promise; await scheduler.stop(); await running;
    expect(await store.get(job.id)).toMatchObject({ enabled: false, failureCount: 0,
      runOnceExecution: { status: "unknown" }, lastError: expect.stringContaining("结果未确认") });
  } finally { await scheduler.stop(); }
}));

it("keeps legacy one-shot records readable without inventing an execution claim", async () => fixture(async (_root, store) => {
  const job = await store.add(oneShot);
  const legacy = parseCronStoreState({ schemaVersion: 1, jobs: [job] });
  expect(legacy.jobs[0]).toMatchObject({ enabled: true, runOnce: true });
  expect(legacy.jobs[0]?.runOnceExecution).toBeUndefined();
}));
