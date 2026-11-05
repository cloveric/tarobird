import { Cron } from "croner";
import type { CronJobRecord } from "../state/cron-store-schema.js";

export interface CronJobSnapshot {
  id: string;
  channel: CronJobRecord["channel"];
  kind: "once" | "recurring";
  enabled: boolean;
  schedule: string;
  nextRunAt: string | null;
  targetAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  failureCount: number;
  maxFailures: number;
  timezone: string | null;
  prompt: string;
  chatId: number;
  userId: number;
  larkChatId: string | null;
  larkThreadId: string | null;
  larkMessageId: string | null;
}

function nextCronRunIso(expr: string, timezone?: string, reference?: Date): string | null {
  try {
    const cron = new Cron(expr, { paused: true, timezone });
    const next = cron.nextRun(reference);
    cron.stop();
    return next?.toISOString() ?? null;
  } catch {
    return null;
  }
}

function snapshot(job: CronJobRecord, nextRun: typeof nextCronRunIso): CronJobSnapshot {
  const kind = job.runOnce ? "once" : "recurring";
  const targetAt = job.targetAt ?? null;
  return {
    id: job.id,
    channel: job.channel,
    kind,
    enabled: job.enabled,
    schedule: kind === "once" && targetAt ? `once ${targetAt}` : job.cronExpr,
    nextRunAt: job.enabled
      ? kind === "once"
        ? targetAt
        : nextRun(job.cronExpr, job.timezone)
      : null,
    targetAt,
    lastRunAt: job.lastRunAt ?? null,
    lastSuccessAt: job.lastSuccessAt ?? null,
    lastError: job.lastError ?? null,
    failureCount: job.failureCount,
    maxFailures: job.maxFailures,
    timezone: job.timezone ?? null,
    prompt: job.prompt,
    chatId: job.chatId,
    userId: job.userId,
    larkChatId: job.larkChatId ?? null,
    larkThreadId: job.larkThreadId ?? null,
    larkMessageId: job.larkMessageId ?? null,
  };
}

export function toCronJobSnapshot(job: CronJobRecord): CronJobSnapshot {
  return snapshot(job, nextCronRunIso);
}

/** One read, one reference time. Never reuse results across dashboard refreshes. */
export function createCronSnapshotter(reference = new Date()): (job: CronJobRecord) => CronJobSnapshot {
  const nextRuns = new Map<string, string | null>();
  return (job) => snapshot(job, (expr, timezone) => {
    const key = JSON.stringify([expr, timezone ?? null]);
    if (!nextRuns.has(key)) nextRuns.set(key, nextCronRunIso(expr, timezone, reference));
    return nextRuns.get(key)!;
  });
}
