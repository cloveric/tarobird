import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withFileMutex } from "../state/file-mutex.js";
import type { TelemetryAdapter, TelemetryTags } from "./telemetry.js";

export interface TurnPoolWaitEvent {
  waitedMs: number;
  activeCount: number;
  maxActive: number;
  reason: "turn_pool";
}

export interface TurnPoolRunOptions {
  signal?: AbortSignal;
  waitNotifyAfterMs?: number;
  onWait?: (event: TurnPoolWaitEvent) => void | Promise<void>;
  metadata?: {
    channel?: string;
    instanceName?: string;
    conversationKey?: string;
    sessionId?: string;
  };
}

export interface TurnPoolLike {
  run<T>(task: () => Promise<T>, options?: TurnPoolRunOptions): Promise<T>;
}

interface TurnPoolLease {
  id: string;
  pid: number;
  acquiredAt: string;
  updatedAt: string;
  channel?: string;
  instanceName?: string;
  conversationKey?: string;
  sessionId?: string;
}

interface TurnPoolState {
  leases: TurnPoolLease[];
}

export interface FileTurnPoolOptions {
  maxActive: number;
  poolPath?: string;
  staleLeaseMs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  telemetry?: TelemetryAdapter;
  telemetryTags?: TelemetryTags;
}

const DEFAULT_STALE_LEASE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;
// Refresh a held lease's updatedAt well within DEFAULT_STALE_LEASE_MS so a
// legitimately long-running turn (e.g. a "no timeout" task) is never mistaken
// for a dead/abandoned lease and evicted, which would over-admit past maxActive.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60 * 1000;

export function resolveDefaultTurnPoolPath(): string {
  return path.join(os.tmpdir(), "tarocub-turn-pool", "turns.json");
}

/**
 * The shared pool cannot be used safely. Pooled turns fail closed: an unread
 * or untrusted file could hide live leases and admit past maxActive. The file
 * is never rewritten or removed here, so it stays available as evidence.
 */
export class TurnPoolStateError extends Error {
  constructor(
    readonly code: "turn_pool_state_invalid" | "turn_pool_location_unsafe",
    readonly targetPath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(code === "turn_pool_state_invalid"
      ? `${code}: turn pool state ${targetPath} is unreadable (${detail}); active leases cannot be counted, so pooled turns are refused and the file is left unchanged. ` +
        "Recover: stop every service that shares this pool (TAROCUB_MAX_CONCURRENT_TURNS with the same TAROCUB_TURN_POOL_PATH or default path), " +
        `move the file aside (for example to ${targetPath}.corrupt), then start the services again.`
      : `${code}: turn pool path ${targetPath} is unsafe (${detail}); pooled turns are refused. ` +
        "Recover: stop every service that shares this pool, inspect and remove the unsafe path or set one private TAROCUB_TURN_POOL_PATH for all of them, then start them again. " +
        "Do not move only some services: separate pools would each admit the full limit.", options);
    this.name = "TurnPoolStateError";
  }
}

// Reading never follows a planted symlink where the platform supports it.
const READ_NO_FOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

export class FileTurnPool implements TurnPoolLike {
  private readonly maxActive: number;
  private readonly poolPath: string;
  // The default path lives in os.tmpdir(), which is shared by all users on
  // Linux. It keeps its historical location so old and new workers still share
  // one limit, but its directory must be a private, non-symlink directory.
  private readonly requirePrivateDirectory: boolean;
  private readonly staleLeaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly telemetry?: TelemetryAdapter;
  private readonly telemetryTags?: TelemetryTags;

  constructor(options: FileTurnPoolOptions) {
    this.maxActive = Math.max(0, Math.floor(options.maxActive));
    this.poolPath = options.poolPath ?? resolveDefaultTurnPoolPath();
    this.requirePrivateDirectory = options.poolPath === undefined;
    this.staleLeaseMs = options.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.telemetry = options.telemetry;
    this.telemetryTags = options.telemetryTags;
  }

  async run<T>(task: () => Promise<T>, options: TurnPoolRunOptions = {}): Promise<T> {
    if (this.maxActive <= 0) {
      return await task();
    }

    const leaseId = `${process.pid}-${Date.now()}-${randomUUID()}`;
    const waitStartedAt = Date.now();
    let waitNotified = false;
    let waitMetricRecorded = false;
    let acquired = false;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      for (;;) {
        throwIfAborted(options.signal);
        const activeCount = await this.tryAcquire(leaseId, options);
        if (activeCount < this.maxActive) {
          acquired = true;
          await this.recordPoolMetric("pool_active", activeCount + 1, options);
          await this.recordPoolMetric("pool_waiting", 0, options);
          break;
        }

        if (!waitMetricRecorded) {
          waitMetricRecorded = true;
          await this.recordPoolMetric("pool_active", activeCount, options);
          await this.recordPoolMetric("pool_waiting", 1, options);
        }
        const waitedMs = Math.max(0, Date.now() - waitStartedAt);
        if (!waitNotified && options.onWait && waitedMs >= (options.waitNotifyAfterMs ?? 0)) {
          waitNotified = true;
          await options.onWait({
            waitedMs,
            activeCount,
            maxActive: this.maxActive,
            reason: "turn_pool",
          });
        }
        await sleep(this.pollIntervalMs, options.signal);
      }

      heartbeat = setInterval(() => {
        void this.renewLease(leaseId).catch(() => undefined);
      }, this.heartbeatIntervalMs);
      heartbeat.unref?.();

      return await task();
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (acquired) {
        const activeAfterRelease = await this.release(leaseId).catch(() => undefined);
        if (typeof activeAfterRelease === "number") {
          await this.recordPoolMetric("pool_active", activeAfterRelease, options);
        }
      } else if (waitMetricRecorded) {
        // Aborted while still queued (e.g. /stop on a waiting turn): we set
        // pool_waiting=1 but never acquired, so clear the gauge — otherwise it leaks
        // at 1 forever and the dashboard shows a phantom waiter.
        await this.recordPoolMetric("pool_waiting", 0, options).catch(() => undefined);
      }
    }
  }

  private async renewLease(leaseId: string): Promise<void> {
    await this.preparePoolDirectory();
    await withFileMutex(this.poolPath, async () => {
      const state = await this.readState();
      let changed = false;
      const now = new Date().toISOString();
      const leases = state.leases.map((lease) => {
        if (lease.id === leaseId) {
          changed = true;
          return { ...lease, updatedAt: now };
        }
        return lease;
      });
      if (changed) {
        await this.writeState({ leases });
      }
    });
  }

  private async tryAcquire(leaseId: string, options: TurnPoolRunOptions): Promise<number> {
    let activeCount = 0;
    await this.preparePoolDirectory();
    await withFileMutex(this.poolPath, async () => {
      const state = await this.readState();
      const leases = state.leases.filter((lease) => this.isLeaseAlive(lease));
      activeCount = leases.length;
      if (leases.length < this.maxActive) {
        const now = new Date().toISOString();
        leases.push({
          id: leaseId,
          pid: process.pid,
          acquiredAt: now,
          updatedAt: now,
          ...(options.metadata?.channel ? { channel: options.metadata.channel } : {}),
          ...(options.metadata?.instanceName ? { instanceName: options.metadata.instanceName } : {}),
          ...(options.metadata?.conversationKey ? { conversationKey: options.metadata.conversationKey } : {}),
          ...(options.metadata?.sessionId ? { sessionId: options.metadata.sessionId } : {}),
        });
      }
      await this.writeState({ leases });
    });
    return activeCount;
  }

  private async release(leaseId: string): Promise<number> {
    let activeCount = 0;
    await this.preparePoolDirectory();
    await withFileMutex(this.poolPath, async () => {
      const state = await this.readState();
      const leases = state.leases.filter((lease) => lease.id !== leaseId);
      activeCount = leases.length;
      await this.writeState({ leases });
    });
    return activeCount;
  }

  private async recordPoolMetric(name: "pool_active" | "pool_waiting", value: number, options: TurnPoolRunOptions): Promise<void> {
    await Promise.resolve(this.telemetry?.recordMetric?.(name, value, {
      ...this.telemetryTags,
      ...(options.metadata?.channel ? { channel: options.metadata.channel } : {}),
      ...(options.metadata?.instanceName ? { instanceName: options.metadata.instanceName } : {}),
      ...(options.metadata?.conversationKey ? { conversationKey: options.metadata.conversationKey } : {}),
      ...(options.metadata?.sessionId ? { sessionId: options.metadata.sessionId } : {}),
    })).catch(() => undefined);
  }

  /** Runs before the file mutex, whose lock directory lives beside the pool. */
  private async preparePoolDirectory(): Promise<void> {
    const directory = path.dirname(this.poolPath);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!this.requirePrivateDirectory || (code !== "EEXIST" && code !== "ENOTDIR")) {
        throw error;
      }
    }
    if (!this.requirePrivateDirectory) {
      return;
    }
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new TurnPoolStateError("turn_pool_location_unsafe", directory, "not a real directory");
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      throw new TurnPoolStateError("turn_pool_location_unsafe", directory, `owned by uid ${stats.uid}, expected ${uid}`);
    }
    if (uid !== undefined && (stats.mode & 0o022) !== 0) {
      throw new TurnPoolStateError("turn_pool_location_unsafe", directory, `writable by other users (mode ${(stats.mode & 0o777).toString(8)})`);
    }
  }

  private async readState(): Promise<TurnPoolState> {
    let raw: string;
    let handle: FileHandle;
    try {
      if (!fsConstants.O_NOFOLLOW && (await lstat(this.poolPath)).isSymbolicLink()) {
        throw new TurnPoolStateError("turn_pool_location_unsafe", this.poolPath, "symbolic link");
      }
      handle = await open(this.poolPath, READ_NO_FOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { leases: [] };
      }
      if (code === "ELOOP") {
        throw new TurnPoolStateError("turn_pool_location_unsafe", this.poolPath, "symbolic link", { cause: error });
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new TurnPoolStateError("turn_pool_location_unsafe", this.poolPath, "not a regular file");
      }
      const uid = process.getuid?.();
      if (uid !== undefined && stats.uid !== uid) {
        throw new TurnPoolStateError("turn_pool_location_unsafe", this.poolPath, `owned by uid ${stats.uid}, expected ${uid}`);
      }
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new TurnPoolStateError("turn_pool_state_invalid", this.poolPath, "invalid JSON", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Array.isArray((parsed as Partial<TurnPoolState>).leases)) {
      throw new TurnPoolStateError("turn_pool_state_invalid", this.poolPath, "root must be an object with a leases array");
    }
    const leases = (parsed as { leases: unknown[] }).leases;
    const invalidIndex = leases.findIndex((lease) => !isTurnPoolLease(lease));
    if (invalidIndex >= 0) {
      throw new TurnPoolStateError("turn_pool_state_invalid", this.poolPath, `lease ${invalidIndex} is malformed`);
    }
    return { leases: leases as TurnPoolLease[] };
  }

  /** Readers only ever see the previous or the next complete state. */
  private async writeState(state: TurnPoolState): Promise<void> {
    const directory = path.dirname(this.poolPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(this.poolPath)}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    let renamed = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.poolPath);
      renamed = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
    // Best effort: the replacement is already complete and its bytes are
    // synced. Failing here would strand a lease this call just recorded.
    try {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Unsupported on some platforms/filesystems (e.g. Windows directories).
    }
  }

  private isLeaseAlive(lease: TurnPoolLease): boolean {
    const updatedAtMs = new Date(lease.updatedAt).getTime();
    if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > this.staleLeaseMs) {
      return false;
    }
    return isProcessAlive(lease.pid);
  }
}

// Strict: silently dropping a malformed lease would under-count active turns.
function isTurnPoolLease(value: unknown): value is TurnPoolLease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<TurnPoolLease>;
  return typeof record.id === "string" && record.id.length > 0 &&
    Number.isSafeInteger(record.pid) && (record.pid as number) > 0 &&
    isTimestamp(record.acquiredAt) &&
    isTimestamp(record.updatedAt);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return false;
      }
      if (code === "EPERM") {
        return true;
      }
    }
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("turn pool wait aborted");
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let abort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (signal && abort) {
        signal.removeEventListener("abort", abort);
      }
      resolve();
    }, ms);
    timer.unref?.();
    if (!signal) {
      return;
    }
    abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort!);
      reject(new Error("turn pool wait aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
