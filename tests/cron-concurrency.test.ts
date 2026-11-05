import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import { CronStore, type CronJobRecord } from "../src/state/cron-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(run: (store: CronStore, scheduler: CronScheduler, executor: ReturnType<typeof vi.fn>) => Promise<void>) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cron-concurrency-"));
  const store = new CronStore(stateDir), executor = vi.fn(async () => {});
  const scheduler = new CronScheduler({ store, stateDir, executor, logger: { warn() {}, error() {} } });
  try { await run(store, scheduler, executor); }
  finally { await scheduler.stop(); await removeTempRoot(stateDir); }
}

it.each(["start", "refresh"] as const)("a delayed %s cannot restore an older schedule after a newer refresh", async method => {
  await fixture(async (store, scheduler) => {
    const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "old" });
    const delayed = deferred<CronJobRecord[]>();
    vi.spyOn(store, "list").mockReturnValueOnce(delayed.promise);
    const first = scheduler[method]();
    await store.update(job.id, { enabled: false });
    await scheduler.refresh();
    delayed.resolve([job]); await first;
    expect(scheduler.countScheduled()).toBe(0);
    expect((await store.get(job.id))?.enabled).toBe(false);
  });
});

it.each([false, true])("an old one-shot result (failure=%s) cannot disable a rescheduled task", async failed => {
  await fixture(async (store, scheduler, executor) => {
    const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "old", runOnce: true, targetAt: new Date(Date.now() + 60_000).toISOString() });
    const started = deferred<void>(), finish = deferred<void>();
    executor.mockImplementationOnce(async () => { started.resolve(); await finish.promise; if (failed) throw new Error("old failure"); });
    const execution = scheduler.runJobNow(job.id); await started.promise;
    const nextAt = new Date(Date.now() + 120_000).toISOString();
    await store.update(job.id, { targetAt: nextAt, prompt: "new" }); await scheduler.refresh();
    finish.resolve(); await execution;
    const saved = await store.get(job.id);
    expect(saved).toMatchObject({ enabled: true, targetAt: nextAt, prompt: "new", failureCount: 0 });
    expect(saved?.runHistory).toHaveLength(1);
    expect(scheduler.countScheduled()).toBe(1);
  });
});

it("an old recurring failure cannot disable the task after its configuration was corrected", async () => {
  await fixture(async (store, scheduler, executor) => {
    const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "old", maxFailures: 1 });
    const started = deferred<void>(), finish = deferred<void>();
    executor.mockImplementationOnce(async () => { started.resolve(); await finish.promise; throw new Error("old failure"); });
    const execution = scheduler.runJobNow(job.id); await started.promise;
    await store.update(job.id, { prompt: "corrected", cronExpr: "0 10 * * *" }); await scheduler.refresh();
    finish.resolve(); await execution;
    expect(await store.get(job.id)).toMatchObject({ enabled: true, prompt: "corrected", failureCount: 0 });
    expect(scheduler.countScheduled()).toBe(1);
  });
});

it("a task remains active until its execution result has been persisted", async () => {
  await fixture(async (store, scheduler, executor) => {
    const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "once at a time" });
    const saving = deferred<void>(), saved = deferred<void>(), record = store.recordRun.bind(store);
    vi.spyOn(store, "recordRun").mockImplementationOnce(async (...args) => { saving.resolve(); await saved.promise; return record(...args); });
    const first = scheduler.runJobNow(job.id); await saving.promise;
    try {
      await scheduler.runJobNow(job.id);
      expect(executor).toHaveBeenCalledTimes(1);
    } finally { saved.resolve(); await first; }
    await scheduler.runJobNow(job.id);
    expect(executor).toHaveBeenCalledTimes(2);
  });
});

it.each([false, true])("a revised one-shot due during the previous execution runs after release (converted=%s)", async converted => {
  await fixture(async (store, scheduler, executor) => {
    const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "old", ...(converted ? {} : { runOnce: true, targetAt: new Date(Date.now() + 60_000).toISOString() }) });
    const started = deferred<void>(), finish = deferred<void>();
    executor.mockImplementationOnce(async () => { started.resolve(); await finish.promise; });
    const first = scheduler.runJobNow(job.id); await started.promise;
    try {
      await store.update(job.id, { runOnce: true, targetAt: new Date(Date.now() + 50).toISOString(), prompt: "revised" });
      await scheduler.refresh();
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(executor).toHaveBeenCalledTimes(1);
    } finally { finish.resolve(); await first; }
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
    expect(executor.mock.calls[1]![0]).toMatchObject({ prompt: "revised" });
    await vi.waitFor(() => expect(scheduler.activeCount()).toBe(0));
    await scheduler.refresh();
    expect(executor).toHaveBeenCalledTimes(2);
  });
});

it.each(["pause", "disable", "remove"] as const)("a deferred one-shot respects a later %s", async change => {
  await fixture(async (store, scheduler, executor) => {
    const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "old" });
    const started = deferred<void>(), finish = deferred<void>();
    executor.mockImplementationOnce(async () => { started.resolve(); await finish.promise; });
    const first = scheduler.runJobNow(job.id); await started.promise;
    try {
      await store.update(job.id, { runOnce: true, targetAt: new Date(Date.now() + 30).toISOString(), prompt: "revised" });
      await scheduler.refresh(); await new Promise(resolve => setTimeout(resolve, 100));
      if (change === "pause") scheduler.pauseAdmission();
      else if (change === "remove") await store.remove(job.id);
      else await store.update(job.id, { enabled: false });
    } finally { finish.resolve(); await first; }
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(executor).toHaveBeenCalledTimes(1);
    if (change === "pause") { await scheduler.resumeAdmission(); await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2)); }
  });
});
