import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { JsonStore } from "./json-store.js";
import { withFileMutex } from "./file-mutex.js";
import { readProcessEpoch } from "./process-epoch.js";
import { normalizeCronTimezone, resolveDefaultCronTimezone } from "./cron-timezone.js";
import {
  CronJobRecordSchema,
  CronStoreStateSchema,
  type CronJobRecord,
  type CronChannel,
  type CronDeliveryMode,
  type CronLocale,
  type CronSessionMode,
} from "./cron-store-schema.js";

export type { CronJobRecord, CronChannel, CronDeliveryMode, CronLocale, CronSessionMode } from "./cron-store-schema.js";

/** Cancel only preparatory waits. Once the durable write starts it must finish,
 * so the scheduler can release a claim written just as cancellation arrived. */
function waitWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface CronJobInput {
  channel?: CronChannel;
  chatId: number;
  messageThreadId?: number;
  userId: number;
  chatType?: string;
  conversationKey?: string;
  larkChatId?: string;
  larkThreadId?: string;
  larkMessageId?: string;
  locale?: CronLocale;
  cronExpr: string;
  timezone?: string;
  prompt: string;
  description?: string;
  enabled?: boolean;
  runOnce?: boolean;
  targetAt?: string;
  sessionMode?: CronSessionMode;
  deliveryMode?: CronDeliveryMode;
  mute?: boolean;
  silent?: boolean;
  timeoutMins?: number;
  maxFailures?: number;
}

export interface CronJobUpdate {
  channel?: CronChannel;
  cronExpr?: string;
  timezone?: string;
  prompt?: string;
  description?: string | null;
  conversationKey?: string | null;
  larkChatId?: string | null;
  larkThreadId?: string | null;
  larkMessageId?: string | null;
  enabled?: boolean;
  runOnce?: boolean;
  targetAt?: string | null;
  sessionMode?: CronSessionMode;
  deliveryMode?: CronDeliveryMode;
  mute?: boolean;
  silent?: boolean;
  timeoutMins?: number;
  maxFailures?: number;
}

export interface CronRunResult {
  success: boolean;
  error?: string;
  ranAt: string;
  claimId?: string;
  /** Terminal preparation failure before the executor requested admission. */
  failedBeforeAdmission?: boolean;
}

interface CronStoreState {
  jobs: CronJobRecord[];
}

export function resolveCronStorePath(stateDir: string): string {
  return path.join(stateDir, "cron-jobs.json");
}

export function generateCronJobId(): string {
  return randomBytes(4).toString("hex");
}

export const MAX_ENABLED_CRON_JOBS_PER_CHAT = 50;

function nowIso(): string {
  return new Date().toISOString();
}

function createDefaultState(): CronStoreState {
  return { jobs: [] };
}

export function parseCronStoreState(value: unknown, defaultTimezone = resolveDefaultCronTimezone()): CronStoreState {
  const result = CronStoreStateSchema.safeParse(value);
  if (result.success) {
    const rawJobs = typeof value === "object" &&
      value !== null &&
      Array.isArray((value as { jobs?: unknown }).jobs)
      ? (value as { jobs: unknown[] }).jobs
      : [];
    return {
      jobs: result.data.jobs.map((job, index) => {
        const rawJob = rawJobs[index];
        const hasStoredDeliveryMode = typeof rawJob === "object" &&
          rawJob !== null &&
          "deliveryMode" in rawJob;
        return {
          ...job,
          timezone: job.timezone ?? defaultTimezone,
          deliveryMode: hasStoredDeliveryMode ? job.deliveryMode : (job.runOnce ? "notify" : job.deliveryMode),
        };
      }),
    };
  }
  throw new Error(`invalid cron store state: ${result.error.message}`);
}

export class CronStore {
  private readonly filePath: string;
  private readonly store: JsonStore<CronStoreState>;
  private readonly defaultTimezone: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { defaultTimezone?: string } = {}) {
    this.filePath = resolveCronStorePath(stateDir);
    this.defaultTimezone = normalizeCronTimezone(options.defaultTimezone) ?? resolveDefaultCronTimezone();
    this.store = new JsonStore<CronStoreState>(this.filePath, (value) => {
      return parseCronStoreState(value, this.defaultTimezone);
    });
  }

  async list(): Promise<CronJobRecord[]> {
    const state = await this.store.read(createDefaultState());
    return [...state.jobs];
  }

  async listByChat(chatId: number): Promise<CronJobRecord[]> {
    const jobs = await this.list();
    return jobs.filter((job) => job.chatId === chatId);
  }

  async listByConversation(chatId: number, messageThreadId?: number): Promise<CronJobRecord[]> {
    const jobs = await this.list();
    return jobs.filter((job) => job.chatId === chatId && job.messageThreadId === messageThreadId);
  }

  async get(id: string): Promise<CronJobRecord | null> {
    const jobs = await this.list();
    return jobs.find((job) => job.id === id) ?? null;
  }

  async add(input: CronJobInput): Promise<CronJobRecord> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      const enabled = input.enabled ?? true;
      this.assertEnabledJobLimit(state.jobs, input.chatId, enabled, undefined, input.messageThreadId);
      const id = generateCronJobId();
      const timestamp = nowIso();
      const record = CronJobRecordSchema.parse({
        id,
        channel: input.channel ?? "telegram",
        chatId: input.chatId,
        messageThreadId: input.messageThreadId,
        userId: input.userId,
        chatType: input.chatType ?? "private",
        conversationKey: input.conversationKey,
        larkChatId: input.larkChatId,
        larkThreadId: input.larkThreadId,
        larkMessageId: input.larkMessageId,
        locale: input.locale,
        cronExpr: input.cronExpr,
        timezone: normalizeCronTimezone(input.timezone) ?? this.defaultTimezone,
        prompt: input.prompt,
        description: input.description,
        enabled,
        runOnce: input.runOnce ?? false,
        targetAt: input.targetAt,
        sessionMode: input.sessionMode ?? "new_per_run",
        deliveryMode: input.deliveryMode ?? (input.runOnce ? "notify" : "agent"),
        mute: input.mute ?? false,
        silent: input.silent ?? false,
        timeoutMins: input.timeoutMins ?? 30,
        maxFailures: input.maxFailures ?? 3,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      state.jobs = [...state.jobs, record];
      await this.store.write(state);
      return record;
    });
  }

  async remove(id: string, expectedUpdatedAt?: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      if (expectedUpdatedAt !== undefined && state.jobs.find((job) => job.id === id)?.updatedAt !== expectedUpdatedAt) throw new Error("schedule_conflict");
      const next = state.jobs.filter((job) => job.id !== id);
      if (next.length === state.jobs.length) {
        return false;
      }
      state.jobs = next;
      await this.store.write(state);
      return true;
    });
  }

  async update(id: string, patch: CronJobUpdate, expectedUpdatedAt?: string): Promise<CronJobRecord | null> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      const index = state.jobs.findIndex((job) => job.id === id);
      if (index === -1) {
        if (expectedUpdatedAt !== undefined) throw new Error("schedule_conflict");
        return null;
      }
      const existing = state.jobs[index]!;
      if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt) throw new Error("schedule_conflict");
      const rearmed = patch.enabled === true || (existing.runOnceExecution !== undefined && patch.targetAt != null && patch.targetAt !== existing.targetAt);
      const nextEnabled = patch.enabled ?? (rearmed ? true : existing.enabled);
      if (!existing.enabled && nextEnabled) {
        this.assertEnabledJobLimit(state.jobs, existing.chatId, true, existing.id, existing.messageThreadId);
      }
      const merged: CronJobRecord = {
        ...existing,
        runOnceExecution: rearmed ? undefined : existing.runOnceExecution,
        channel: patch.channel ?? existing.channel,
        cronExpr: patch.cronExpr ?? existing.cronExpr,
        timezone: patch.timezone === undefined
          ? existing.timezone
          : normalizeCronTimezone(patch.timezone) ?? this.defaultTimezone,
        prompt: patch.prompt ?? existing.prompt,
        description:
          patch.description === null
            ? undefined
            : patch.description ?? existing.description,
        conversationKey:
          patch.conversationKey === null
            ? undefined
            : patch.conversationKey ?? existing.conversationKey,
        larkChatId:
          patch.larkChatId === null
            ? undefined
            : patch.larkChatId ?? existing.larkChatId,
        larkThreadId:
          patch.larkThreadId === null
            ? undefined
            : patch.larkThreadId ?? existing.larkThreadId,
        larkMessageId:
          patch.larkMessageId === null
            ? undefined
            : patch.larkMessageId ?? existing.larkMessageId,
        enabled: nextEnabled,
        runOnce: patch.runOnce ?? existing.runOnce,
        targetAt:
          patch.targetAt === null
            ? undefined
            : patch.targetAt ?? existing.targetAt,
        sessionMode: patch.sessionMode ?? existing.sessionMode,
        deliveryMode: patch.deliveryMode ?? existing.deliveryMode,
        mute: patch.mute ?? existing.mute,
        silent: patch.silent ?? existing.silent,
        timeoutMins: patch.timeoutMins ?? existing.timeoutMins,
        maxFailures: patch.maxFailures ?? existing.maxFailures,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString(),
      };
      const validated = CronJobRecordSchema.parse(merged);
      state.jobs = [...state.jobs];
      state.jobs[index] = validated;
      await this.store.write(state);
      return validated;
    });
  }

  async toggleEnabled(id: string): Promise<CronJobRecord | null> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      const index = state.jobs.findIndex((job) => job.id === id);
      if (index === -1) {
        return null;
      }
      const existing = state.jobs[index]!;
      if (!existing.enabled) {
        this.assertEnabledJobLimit(state.jobs, existing.chatId, true, existing.id, existing.messageThreadId);
      }
      const updated = CronJobRecordSchema.parse({
        ...existing,
        enabled: !existing.enabled,
        runOnceExecution: !existing.enabled ? undefined : existing.runOnceExecution,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString(),
      });
      state.jobs = [...state.jobs];
      state.jobs[index] = updated;
      await this.store.write(state);
      return updated;
    });
  }

  /** Keep execution history after edits, but only return a revision eligible for
   * automatic control changes when this run still belongs to the same config. */
  async recordRun(id: string, result: CronRunResult, expectedUpdatedAt?: string): Promise<CronJobRecord | null> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      const index = state.jobs.findIndex((job) => job.id === id);
      if (index === -1) {
        return null;
      }
      const existing = state.jobs[index]!;
      const currentRun = expectedUpdatedAt === undefined || existing.updatedAt === expectedUpdatedAt;
      const historyEntry = result.success
        ? { ranAt: result.ranAt, success: true }
        : { ranAt: result.ranAt, success: false, error: result.error ?? "unknown error" };
      const merged: CronJobRecord = {
        ...existing,
        // Persist failure and disable atomically, so a refresh or restart cannot
        // turn an expired one-shot preparation failure into an automatic retry.
        // Concurrent edits retain their new schedule; explicit re-enable retries.
        enabled: currentRun && existing.runOnce && !result.success && result.failedBeforeAdmission ? false : existing.enabled,
        runOnceExecution: result.claimId && existing.runOnceExecution?.id === result.claimId ? undefined : existing.runOnceExecution,
        lastRunAt: result.ranAt,
        lastSuccessAt: result.success ? result.ranAt : existing.lastSuccessAt,
        lastError: result.success ? undefined : result.error ?? "unknown error",
        failureCount: currentRun ? result.success ? 0 : (existing.failureCount ?? 0) + 1 : existing.failureCount,
        runHistory: [...(existing.runHistory ?? []), historyEntry].slice(-10),
        updatedAt: new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString(),
      };
      const validated = CronJobRecordSchema.parse(merged);
      state.jobs = [...state.jobs];
      state.jobs[index] = validated;
      await this.store.write(state);
      return currentRun ? validated : null;
    });
  }

  /** Durable admission before any side effect; CAS also fences another scheduler. */
  async claimRunOnce(id: string, expectedUpdatedAt: string, trigger: "scheduled" | "manual", signal?: AbortSignal): Promise<CronJobRecord> {
    signal?.throwIfAborted();
    const epoch = await waitWithAbort(readProcessEpoch(process.pid), signal);
    return this.enqueueWrite(async () => {
      signal?.throwIfAborted();
      const state = await this.store.read(createDefaultState());
      const index = state.jobs.findIndex(job => job.id === id);
      const job = state.jobs[index];
      if (!job || !job.runOnce || !job.enabled || job.runOnceExecution || job.updatedAt !== expectedUpdatedAt) throw new Error("schedule_conflict");
      signal?.throwIfAborted();
      const next = CronJobRecordSchema.parse({ ...job, enabled: false,
        runOnceExecution: { id: randomUUID(), startedAt: nowIso(), trigger, status: "started", pid: process.pid, ...epoch },
        updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt) + 1)).toISOString(),
      });
      state.jobs[index] = next;
      await this.store.write(state);
      return next;
    }, signal);
  }

  /** Cancellation while persisting admission has not executed the task yet. */
  async releaseUnstartedRunOnce(id: string, claimId: string, expectedUpdatedAt: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      const index = state.jobs.findIndex(job => job.id === id);
      const job = state.jobs[index];
      if (!job || job.updatedAt !== expectedUpdatedAt || job.runOnceExecution?.id !== claimId) return;
      state.jobs[index] = CronJobRecordSchema.parse({ ...job, enabled: true, runOnceExecution: undefined,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt) + 1)).toISOString(),
      });
      await this.store.write(state);
    });
  }

  async markRunOnceUnconfirmed(id: string, claimId: string): Promise<CronJobRecord | null> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(createDefaultState());
      const index = state.jobs.findIndex(job => job.id === id);
      const job = state.jobs[index], claim = job?.runOnceExecution;
      if (!job || !claim || claim.id !== claimId || claim.status !== "started") return null;
      const error = "执行结果未确认；为避免重复操作，未自动重试。请确认结果后再手动启用。 (Execution result unconfirmed; automatic retry disabled.)";
      const next = CronJobRecordSchema.parse({ ...job, enabled: false, runOnceExecution: { ...claim, status: "unknown" },
        lastRunAt: claim.startedAt, lastError: error,
        runHistory: [...job.runHistory, { ranAt: claim.startedAt, success: false, error }].slice(-10),
        updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt) + 1)).toISOString(),
      });
      state.jobs[index] = next;
      await this.store.write(state);
      return next;
    });
  }

  /** Recover only proven dead owners. Unknown or live owners remain fenced. */
  async recoverRunOnceExecutions(): Promise<CronJobRecord[]> {
    const recovered: CronJobRecord[] = [];
    for (const job of await this.list()) {
      const claim = job.runOnceExecution;
      if (claim?.status !== "started") continue;
      const epoch = await readProcessEpoch(claim.pid);
      if (claim.machineId && epoch.machineId && claim.machineId !== epoch.machineId) continue;
      let dead = Boolean(claim.bootId && epoch.bootId && claim.bootId !== epoch.bootId)
        || Boolean(claim.processBirth && epoch.processBirth && claim.processBirth !== epoch.processBirth);
      if (!dead) {
        try { process.kill(claim.pid, 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (!dead) continue;
      const record = await this.markRunOnceUnconfirmed(job.id, claim.id);
      if (record) recovered.push(record);
    }
    return recovered;
  }

  private enqueueWrite<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.pendingWrite;
    const run = waitWithAbort(previous, signal).then(() => withFileMutex(this.filePath, task, { signal }));
    // An aborted waiter settles promptly but cannot let later writes jump past
    // the still-running predecessor; keep that predecessor in the queue tail.
    this.pendingWrite = Promise.allSettled([previous, run]).then(() => undefined);
    return run;
  }

  private assertEnabledJobLimit(
    jobs: CronJobRecord[],
    chatId: number,
    enabled: boolean,
    excludeId?: string,
    messageThreadId?: number,
  ): void {
    if (!enabled) {
      return;
    }

    const enabledCount = jobs.filter((job) =>
      job.chatId === chatId &&
      job.messageThreadId === messageThreadId &&
      job.enabled &&
      job.id !== excludeId
    ).length;
    if (enabledCount >= MAX_ENABLED_CRON_JOBS_PER_CHAT) {
      throw new Error(`maximum enabled cron jobs per chat reached (${MAX_ENABLED_CRON_JOBS_PER_CHAT})`);
    }
  }
}
