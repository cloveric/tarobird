import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { CronAccessDeniedError } from "../src/runtime/cron-errors.js";
import { CronScheduler, validateCronExpression } from "../src/runtime/cron-scheduler.js";
import { CronStore } from "../src/state/cron-store.js";
import * as timeline from "../src/runtime/timeline-events.js";

async function withDeps<T>(
  fn: (ctx: {
    stateDir: string;
    store: CronStore;
    scheduler: CronScheduler;
    executor: ReturnType<typeof vi.fn>;
    logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  }) => Promise<T>,
  options: Partial<ConstructorParameters<typeof CronScheduler>[0]> = {},
): Promise<T> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-cron-sched-"));
  const store = new CronStore(stateDir);
  const executor = vi.fn().mockResolvedValue(undefined);
  const logger = { error: vi.fn(), warn: vi.fn() };
  const scheduler = new CronScheduler({
    store,
    executor,
    stateDir,
    instanceName: "test",
    logger,
    timeoutMsPerMinute: 10,
    ...options,
  });
  try {
    return await fn({ stateDir, store, scheduler, executor, logger });
  } finally {
    await scheduler.stop();
    await removeTempRoot(stateDir);
  }
}

describe("validateCronExpression", () => {
  it("returns the next-fire date for a valid expression", () => {
    const next = validateCronExpression("0 9 * * *");
    expect(next).toBeInstanceOf(Date);
  });

  it("returns null for an invalid expression", () => {
    expect(validateCronExpression("invalid")).toBeNull();
    expect(validateCronExpression("99 99 * * *")).toBeNull();
  });

  it("rejects six-field cron expressions instead of treating the first field as seconds", () => {
    expect(validateCronExpression("0 0 9 * * *")).toBeNull();
  });
});

describe("CronScheduler", () => {
  it("pauses new work while allowing an active cron to complete without abort or replay", async () => {
    await withDeps(async ({ store, scheduler, executor }) => {
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a", timeoutMins: 0 });
      let release!: () => void, signal: AbortSignal | undefined;
      executor.mockImplementationOnce((_job, activeSignal) => { signal = activeSignal; return new Promise<void>(resolve => { release = resolve; }); });
      await scheduler.start(); const active = scheduler.runJobNow(job.id);
      await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
      try {
        scheduler.pauseAdmission();
        expect(scheduler.countScheduled()).toBe(0); expect(scheduler.activeCount()).toBe(1);
        expect(signal?.aborted).toBe(false);
        await scheduler.runJobNow(job.id); await scheduler.refresh();
        expect(executor).toHaveBeenCalledTimes(1); expect(scheduler.countScheduled()).toBe(0);
      } finally { release(); await active; }
      expect(scheduler.activeCount()).toBe(0); expect(signal?.aborted).toBe(false);
      expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: 0, lastSuccessAt: expect.any(String) });
      await scheduler.resumeAdmission(); expect(scheduler.countScheduled()).toBe(1);
      expect(executor).toHaveBeenCalledTimes(1);
      await scheduler.runJobNow(job.id); expect(executor).toHaveBeenCalledTimes(2);
    });
  });

  it("holds overdue one-shot jobs during a pre-boot pause and runs them once after resume", async () => {
    await withDeps(async ({ store, scheduler, executor }) => {
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "* * * * *", prompt: "once", timeoutMins: 0, runOnce: true, targetAt: new Date(Date.now() - 1000).toISOString() });
      scheduler.pauseAdmission(); await scheduler.start(); await scheduler.runJobNow(job.id);
      expect(executor).not.toHaveBeenCalled(); expect(scheduler.countScheduled()).toBe(0);
      expect(await store.get(job.id)).toMatchObject({ enabled: true });
      // The timer deliberately starts work in the background. Await that actual
      // execution, including timeline/one-shot bookkeeping, rather than polling
      // an intermediate persisted lastSuccessAt under an arbitrary I/O deadline.
      const internal = scheduler as unknown as { runJob(id: string): Promise<void> };
      const original = internal.runJob.bind(scheduler);
      let finish!: (execution: Promise<void>) => void;
      const completed = new Promise<void>(resolve => { finish = resolve; });
      const run = vi.spyOn(internal, "runJob").mockImplementation(id => {
        const execution = original(id); finish(execution); return execution;
      });
      try {
        await scheduler.resumeAdmission(); await completed;
        expect(await store.get(job.id)).toMatchObject({ enabled: false, lastSuccessAt: expect.any(String) });
        expect(scheduler.activeCount()).toBe(0);
        await scheduler.resumeAdmission(); expect(executor).toHaveBeenCalledTimes(1);
      } finally { run.mockRestore(); }
    });
  });

  it("rechecks admission after the asynchronous timeline write", async () => {
    await withDeps(async ({ store, scheduler, executor }) => {
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a", timeoutMins: 0 });
      const append = timeline.appendTimelineEventBestEffort;
      let release!: () => void;
      const log = vi.spyOn(timeline, "appendTimelineEventBestEffort").mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); await append(...args); });
      const pending = scheduler.runJobNow(job.id);
      try {
        await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
        expect(scheduler.activeCount()).toBe(1); scheduler.pauseAdmission(); release(); await pending;
        expect(executor).not.toHaveBeenCalled(); expect(scheduler.activeCount()).toBe(0);
        expect((await store.get(job.id))?.lastRunAt).toBeUndefined();
      } finally { release?.(); await pending; log.mockRestore(); }
      await scheduler.resumeAdmission(); await scheduler.runJobNow(job.id); expect(executor).toHaveBeenCalledTimes(1);
    });
  });
  it("computes recurring runs in the persisted timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T12:59:59.000Z"));
    try {
      await withDeps(async ({ store }) => {
        const job = await store.add({
          chatId: 1,
          userId: 1,
          cronExpr: "0 9 * * *",
          prompt: "a",
          timezone: "America/New_York",
        } as never);

        expect(validateCronExpression(job.cronExpr, job.timezone)?.toISOString()).toBe("2026-04-29T13:00:00.000Z");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads existing enabled jobs at start()", async () => {
    await withDeps(async ({ store, scheduler }) => {
      const a = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a" });
      await store.add({ chatId: 1, userId: 1, cronExpr: "0 10 * * *", prompt: "b" });
      await store.toggleEnabled(a.id); // disable a

      await scheduler.start();
      expect(scheduler.countScheduled()).toBe(1);
    });
  });

  it("scheduleJob disables (not silently skips) jobs with invalid cron expressions", async () => {
    await withDeps(async ({ store, scheduler }) => {
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a" });
      // Forge an invalid expr (e.g. a 7-field cron the engine generated) on an enabled job.
      const forgedJob = { ...job, cronExpr: "0 */15 14 1 6 * 2026" };
      scheduler.scheduleJob(forgedJob);
      expect(scheduler.countScheduled()).toBe(0);
      // It must be DISABLED in the store (visible as ✗ in /cron list), not left "enabled"
      // and silently never-firing.
      let disabled = false;
      for (let i = 0; i < 30 && !disabled; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        disabled = (await store.get(job.id))?.enabled === false;
      }
      expect(disabled).toBe(true);
    });
  });

  it("unscheduleJob removes the timer", async () => {
    await withDeps(async ({ store, scheduler }) => {
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "* * * * *", prompt: "a" });
      scheduler.scheduleJob(job);
      expect(scheduler.countScheduled()).toBe(1);
      scheduler.unscheduleJob(job.id);
      expect(scheduler.countScheduled()).toBe(0);
    });
  });

  it("refresh reconciles disabled and removed jobs", async () => {
    await withDeps(async ({ store, scheduler }) => {
      const a = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a" });
      const b = await store.add({ chatId: 1, userId: 1, cronExpr: "0 10 * * *", prompt: "b" });
      await scheduler.start();
      expect(scheduler.countScheduled()).toBe(2);

      await store.toggleEnabled(a.id);
      await store.remove(b.id);
      await scheduler.refresh();
      expect(scheduler.countScheduled()).toBe(0);
    });
  });

  it("runJobNow invokes executor and records success", async () => {
    await withDeps(async ({ store, scheduler, executor }) => {
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a" });
      await scheduler.runJobNow(job.id);
      expect(executor).toHaveBeenCalledTimes(1);
      const reloaded = await store.get(job.id);
      expect(reloaded?.lastSuccessAt).toBeDefined();
      expect(reloaded?.lastError).toBeUndefined();
    });
  });

  it("does not convert a successful execution into a job failure when run bookkeeping fails", async () => {
    const onJobFailure = vi.fn().mockResolvedValue(undefined);
    await withDeps(async ({ store, scheduler, executor, logger }) => {
      const job = await store.add({
        chatId: 1,
        userId: 1,
        cronExpr: "0 9 * * *",
        prompt: "a",
        maxFailures: 1,
      });
      vi.spyOn(store, "recordRun").mockRejectedValueOnce(new Error("disk full"));

      await scheduler.runJobNow(job.id);

      expect(executor).toHaveBeenCalledTimes(1);
      expect(onJobFailure).not.toHaveBeenCalled();
      expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: 0 });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to record run"));
    }, { onJobFailure });
  });

  it("runs overdue one-shot jobs immediately and disables them after the attempt", async () => {
    await withDeps(async ({ store, scheduler, executor }) => {
      const targetAt = new Date(Date.now() - 1000).toISOString();
      const job = await store.add({
        chatId: 1,
        userId: 1,
        cronExpr: "* * * * *",
        prompt: "once",
        runOnce: true,
        targetAt,
      });

      await scheduler.start();
      await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () => {
        const reloaded = await store.get(job.id);
        expect(reloaded?.enabled).toBe(false);
        // The claim disables a one-shot before execution; wait for bookkeeping.
        expect(reloaded?.lastRunAt).toBeDefined();
      });

      const reloaded = await store.get(job.id);
      expect(reloaded?.enabled).toBe(false);
      expect(reloaded?.lastRunAt).toBeDefined();
    });
  });

  it("marks stale one-shot jobs missed instead of firing a boot storm", async () => {
    await withDeps(async ({ stateDir, store, scheduler, executor }) => {
      const targetAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const job = await store.add({
        chatId: 1,
        userId: 1,
        cronExpr: "* * * * *",
        prompt: "stale once",
        runOnce: true,
        targetAt,
      });

      await scheduler.start();

      await vi.waitFor(async () => {
        const reloaded = await store.get(job.id);
        expect(reloaded?.enabled).toBe(false);
      });
      expect(executor).not.toHaveBeenCalled();
      const reloaded = await store.get(job.id);
      expect(reloaded?.lastError).toContain("missed scheduled run");

      await vi.waitFor(async () => {
        const timeline = await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8").catch(() => "");
        expect(timeline).toContain('"type":"cron.skipped"');
        expect(timeline).toContain('"reason":"missed_run_once"');
      });
    });
  });

  it("runJobNow records failure when executor throws", async () => {
    await withDeps(async ({ store, scheduler, executor }) => {
      executor.mockRejectedValueOnce(new Error("boom"));
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a" });
      await scheduler.runJobNow(job.id);
      const reloaded = await store.get(job.id);
      expect(reloaded?.lastError).toBe("boom");
      expect(reloaded?.lastSuccessAt).toBeUndefined();
    });
  });

  it("disables recurring jobs after maxFailures consecutive failures", async () => {
    await withDeps(async ({ stateDir, store, scheduler, executor }) => {
      executor.mockRejectedValue(new Error("boom"));
      const job = await store.add({
        chatId: 1,
        userId: 1,
        cronExpr: "0 9 * * *",
        prompt: "a",
        maxFailures: 2,
      });

      await scheduler.runJobNow(job.id);
      expect((await store.get(job.id))?.enabled).toBe(true);

      await scheduler.runJobNow(job.id);
      const reloaded = await store.get(job.id);
      expect(reloaded?.enabled).toBe(false);
      expect(reloaded?.failureCount).toBe(2);

      const timeline = await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8");
      expect(timeline).toContain('"type":"cron.disabled_after_failures"');
      expect(timeline).toContain(`"cronJobId":"${job.id}"`);
    });
  });

  it("disables unauthorized recurring jobs immediately without notifying the target chat", async () => {
    const onJobFailure = vi.fn().mockResolvedValue(undefined);
    await withDeps(async ({ stateDir, store, scheduler, executor }) => {
      executor.mockRejectedValueOnce(new CronAccessDeniedError("cron access denied: unauthorized"));
      const job = await store.add({
        chatId: 1,
        userId: 1,
        cronExpr: "0 9 * * *",
        prompt: "a",
        maxFailures: 3,
      });

      await scheduler.runJobNow(job.id);

      const reloaded = await store.get(job.id);
      expect(reloaded?.enabled).toBe(false);
      expect(reloaded?.failureCount).toBe(1);
      expect(reloaded?.lastError).toBe("cron access denied: unauthorized");
      expect(onJobFailure).not.toHaveBeenCalled();

      const timeline = await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8");
      expect(timeline).toContain('"reason":"access_denied"');
    }, { onJobFailure });
  });

  it("notifies failures through onJobFailure", async () => {
    const onJobFailure = vi.fn().mockResolvedValue(undefined);
    await withDeps(async ({ store, scheduler, executor }) => {
      executor.mockRejectedValueOnce(new Error("boom"));
      const job = await store.add({ chatId: 1, userId: 2, cronExpr: "0 9 * * *", prompt: "a" });

      await scheduler.runJobNow(job.id);

      expect(onJobFailure).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), "boom");
    }, { onJobFailure });
  });

  it("still notifies job failure when disabling after max failures cannot be persisted", async () => {
    const onJobFailure = vi.fn().mockResolvedValue(undefined);
    await withDeps(async ({ store, scheduler, executor, logger }) => {
      executor.mockRejectedValueOnce(new Error("boom"));
      const job = await store.add({
        chatId: 1,
        userId: 2,
        cronExpr: "0 9 * * *",
        prompt: "a",
        maxFailures: 1,
      });
      vi.spyOn(store, "update").mockRejectedValueOnce(new Error("disk full"));

      await scheduler.runJobNow(job.id);

      expect(onJobFailure).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), "boom");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to disable job"));
    }, { onJobFailure });
  });

  it("runJobNow skips disabled jobs without invoking executor", async () => {
    await withDeps(async ({ store, scheduler, executor }) => {
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a", enabled: false });
      await scheduler.runJobNow(job.id);
      expect(executor).not.toHaveBeenCalled();
    });
  });

  it("runJobNow gracefully handles unknown id", async () => {
    await withDeps(async ({ scheduler, executor }) => {
      await scheduler.runJobNow("00000000");
      expect(executor).not.toHaveBeenCalled();
    });
  });

  it("treats timeoutMins=0 as unlimited (no timeout enforcement)", async () => {
    await withDeps(async ({ store, scheduler, executor }) => {
      executor.mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a", timeoutMins: 0 });
      await scheduler.runJobNow(job.id);
      expect(executor).toHaveBeenCalledTimes(1);
      const reloaded = await store.get(job.id);
      expect(reloaded?.lastSuccessAt).toBeDefined();
    });
  });

  it("aborts the executor when a timed job exceeds timeoutMins", async () => {
    await withDeps(async ({ store, scheduler, executor }) => {
      const aborted = vi.fn();
      executor.mockImplementationOnce((_job, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted();
          reject(new Error("aborted by test"));
        }, { once: true });
      }));

      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a", timeoutMins: 1 });
      await scheduler.runJobNow(job.id);

      expect(aborted).toHaveBeenCalledTimes(1);
      const reloaded = await store.get(job.id);
      expect(reloaded?.lastError).toContain("timed out");
    });
  });

  it("skips a job fire while the same job is already in flight", async () => {
    await withDeps(async ({ stateDir, store, scheduler, executor }) => {
      let release!: () => void;
      executor.mockImplementationOnce(() => new Promise<void>((resolve) => {
        release = resolve;
      }));

      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a" });
      const first = scheduler.runJobNow(job.id);
      await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
      await scheduler.runJobNow(job.id);
      release();
      await first;

      expect(executor).toHaveBeenCalledTimes(1);
      const timeline = await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8");
      expect(timeline).toContain('"type":"cron.skipped"');
      expect(timeline).toContain('"reason":"already_running"');
    });
  });

  it("emits cron.triggered and cron.completed timeline events", async () => {
    await withDeps(async ({ stateDir, store, scheduler }) => {
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "a" });
      await scheduler.runJobNow(job.id);
      const timeline = await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8");
      expect(timeline).toContain('"type":"cron.triggered"');
      expect(timeline).toContain('"type":"cron.completed"');
      expect(timeline).toContain(`"cronJobId":"${job.id}"`);
    });
  });

  it("stop() prevents future scheduleJob and noops on stopped scheduler", async () => {
    await withDeps(async ({ store, scheduler }) => {
      await scheduler.stop();
      const job = await store.add({ chatId: 1, userId: 1, cronExpr: "* * * * *", prompt: "a" });
      scheduler.scheduleJob(job);
      expect(scheduler.countScheduled()).toBe(0);
    });
  });
});

it("starts the execution timeout after queue admission and does not disable an unexecuted job", async () => {
  await withDeps(async ({ store, scheduler, executor }) => {
    const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "queued", timeoutMins: 1, maxFailures: 1 });
    let admit!: () => void;
    executor.mockImplementationOnce(async (_job, signal, lifecycle) => {
      const start = lifecycle.deferTimeoutUntilStarted();
      await new Promise<void>(resolve => { admit = resolve; });
      signal.throwIfAborted(); await start();
    });
    const run = scheduler.runJobNow(job.id);
    await vi.waitFor(() => expect(admit).toBeTypeOf("function"));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: 0 });
    admit(); await run;
    expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: 0, lastSuccessAt: expect.any(String) });
  }, { executorManagesAdmission: true });
});

it("does not count scheduler shutdown as a task failure", async () => {
  await withDeps(async ({ store, scheduler, executor }) => {
    const job = await store.add({ chatId: 1, userId: 1, cronExpr: "0 9 * * *", prompt: "running", timeoutMins: 0, maxFailures: 1 });
    executor.mockImplementationOnce((_job, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const run = scheduler.runJobNow(job.id);
    await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
    await scheduler.stop(); await run;
    expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: 0 });
  });
});
