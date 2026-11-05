import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProcessEpoch, type ProcessEpoch } from "./process-epoch.js";

interface TicketOwner extends ProcessEpoch { pid: number; hostHash: string }
interface ObservedTicketEpoch { observedAt: number; value: Promise<ProcessEpoch> }
const inProcessQueues = new Map<string, Promise<void>>();
const hostHash = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
const bootPattern = /^(?:linux|darwin):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const birthPattern = /^(?:win32|linux|darwin):\d{1,20}$/;
const machinePattern = /^win32:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

interface FileMutexOptions {
  signal?: AbortSignal;
  /** Retained for callers; age never authorizes stealing a live/unknown owner. */
  staleLockMs?: number;
  waitNotifyAfterMs?: number;
  onWait?: (event: FileMutexWaitEvent) => void | Promise<void>;
  readEpoch?: (pid: number) => Promise<ProcessEpoch>;
  /** Explicit bound even for verified live owners; unknown owners default to 5m. */
  waitTimeoutMs?: number;
}
export class FileMutexTimeoutError extends Error {
  constructor(readonly lockPath: string, readonly waitedMs: number, readonly owner: Partial<TicketOwner>) {
    super(`file_mutex_wait_timeout: waited ${waitedMs}ms; pid=${owner.pid ?? "unknown"}; host=${owner.hostHash ?? "unknown"}; epoch=${owner.bootId ?? owner.processBirth ?? "unknown"}; ${lockPath}`);
    this.name = "FileMutexTimeoutError";
  }
}
export interface FileMutexWaitEvent {
  lockPath: string;
  waitedMs: number;
  reason: "in_process_queue" | "file_lock";
}
function isMissingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function waitOrAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await waitOrAbort(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { if (timer) clearTimeout(timer); }
}
function cleanEpoch(value: ProcessEpoch): ProcessEpoch {
  return {
    ...(typeof value.bootId === "string" && bootPattern.test(value.bootId) ? { bootId: value.bootId.toLowerCase() } : {}),
    ...(typeof value.processBirth === "string" && birthPattern.test(value.processBirth) ? { processBirth: value.processBirth } : {}),
    ...(typeof value.machineId === "string" && machinePattern.test(value.machineId) ? { machineId: value.machineId.toLowerCase() } : {}),
  };
}
function ticketName(owner: TicketOwner): string {
  // Keep ticket-v1 names readable by released runtimes during rollback. POSIX
  // birth evidence lives in an optional immutable sidecar, before number.
  const epoch = owner.machineId ? `win32-machine:${owner.machineId.slice(6)}:${owner.processBirth?.slice(6) ?? "-"}` : owner.bootId ?? (owner.processBirth?.startsWith("win32:") ? owner.processBirth : undefined);
  return `ticket-v1.${owner.pid}.${owner.hostHash}.${epoch ? Buffer.from(epoch).toString("base64url") : "-"}.${randomUUID()}`;
}
function ticketOwner(name: string): TicketOwner {
  const match = /^ticket-v1\.(\d+)\.([a-f0-9]{16})\.([A-Za-z0-9_-]+)\.([a-f0-9-]{36})$/.exec(name);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) throw new Error("file_mutex_invalid_ticket_identity");
  const epoch = match[3] === "-" ? "" : Buffer.from(match[3]!, "base64url").toString("utf8");
  const machine = /^win32-machine:([a-f0-9-]{36}):(\d{1,20}|-)$/i.exec(epoch);
  const posix = /^posix:((?:linux|darwin):[a-f0-9-]{36}):((?:linux|darwin):\d{1,20})$/i.exec(epoch);
  const parsed = cleanEpoch(posix ? { bootId: posix[1], processBirth: posix[2] } : machine ? { machineId: `win32:${machine[1]}`, ...(machine[2] !== "-" ? { processBirth: `win32:${machine[2]}` } : {}) } : { bootId: epoch, processBirth: epoch });
  if (machine && !parsed.machineId) throw new Error("file_mutex_invalid_ticket_epoch");
  if (epoch && !parsed.bootId && !parsed.processBirth && !parsed.machineId) throw new Error("file_mutex_invalid_ticket_epoch");
  return { pid: Number(match[1]), hostHash: match[2]!, ...parsed };
}
async function readTicketOwner(directory: string, name: string): Promise<TicketOwner> {
  const owner = ticketOwner(name);
  if (!owner.processBirth) {
    try {
      const birth = await readFile(path.join(directory, "birth"), "utf8");
      if (!birthPattern.test(birth) || !/^(linux|darwin):/.test(birth) || (owner.bootId && !birth.startsWith(owner.bootId.split(":")[0] + ":"))) throw new Error("file_mutex_invalid_ticket_birth");
      owner.processBirth = birth;
    } catch (error) { if (!isMissingError(error)) throw error; }
  }
  return owner;
}
async function ownerIsDead(owner: TicketOwner, readEpoch: (pid: number) => Promise<ProcessEpoch>): Promise<boolean> {
  let current: ProcessEpoch | undefined;
  if (owner.machineId) {
    current = cleanEpoch(await readEpoch(owner.pid).catch(() => ({})));
    if (owner.machineId !== current.machineId) return false;
  } else if (owner.hostHash !== hostHash) {
    // Only macOS boot UUIDs identify this PID namespace after a rename.
    // Linux containers share boot_id with the host but not PID identities.
    // Legacy Windows tickets have no stable machine identity: do not guess.
    current = cleanEpoch(await readEpoch(owner.pid).catch(() => ({})));
    if (!owner.bootId?.startsWith("darwin:") || owner.bootId !== current.bootId) return false;
  }
  try { process.kill(owner.pid, 0); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return true;
    // EPERM means alive. Any other unknown result must remain conservative.
  }
  if (!owner.bootId && !owner.processBirth) return false;
  current ??= cleanEpoch(await readEpoch(owner.pid).catch(() => ({})));
  return Boolean(owner.bootId && current.bootId && owner.bootId !== current.bootId)
    || Boolean(owner.processBirth && current.processBirth && owner.processBirth !== current.processBirth);
}
/** Legacy records are read only. New binaries never replace owner.json, so a
 * dead legacy record can be unlinked without touching any new owner's ticket.
 * Concurrent old binaries are unsupported; live/unknown legacy owners block. */
async function legacyOwnerBlocks(lockPath: string, readEpoch: (pid: number) => Promise<ProcessEpoch>): Promise<boolean> {
  const ownerPath = path.join(lockPath, "owner.json");
  let raw: string;
  try { raw = await readFile(ownerPath, "utf8"); } catch (error) { if (isMissingError(error)) return false; throw error; }
  let record: Record<string, unknown>;
  try { record = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error("file_mutex_invalid_legacy_owner_manual_recovery_required"); }
  if (!record || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0) throw new Error("file_mutex_invalid_legacy_owner_manual_recovery_required");
  const owner = { pid: Number(record.pid), hostHash: typeof record.host === "string" ? createHash("sha256").update(record.host).digest("hex").slice(0, 16) : hostHash, ...cleanEpoch(record as ProcessEpoch) };
  if (!await ownerIsDead(owner, readEpoch)) return true;
  await rm(ownerPath, { force: true });
  await rmdir(lockPath).catch(() => undefined);
  return false;
}
async function isReleased(directory: string): Promise<boolean> {
  try { await readFile(path.join(directory, "released")); return true; }
  catch (error) {
    if (isMissingError(error) || (typeof error === "object" && error !== null && "code" in error && ["EPERM", "EBUSY", "EACCES"].includes(String(error.code)))) return false;
    throw error;
  }
}
async function cleanupReleasedTicket(directory: string): Promise<void> {
  try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }); }
  catch {
    // NTFS may refuse deletion while a reader holds a handle. Preserve a
    // durable tombstone if recursive removal already removed that marker.
    try { await writeFile(path.join(directory, "released"), "", { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (!isMissingError(error) && !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
}
/** Missing number means choosing=true. A unique ticket is published atomically
 * by mkdir, with immutable owner identity in its name before any content write. */
async function readTicket(lockPath: string, name: string, readEpoch: (pid: number) => Promise<ProcessEpoch>, epochs: Map<string, ObservedTicketEpoch>): Promise<bigint | "choosing" | undefined> {
  const directory = path.join(lockPath, name);
  if (await isReleased(directory)) { await cleanupReleasedTicket(directory); return undefined; }
  const owner = await readTicketOwner(directory, name);
  // A ticket is immutable, but its PID may be reused while we wait. Refresh
  // process birth at most once a second instead of retaining stale live proof
  // forever or starting a PowerShell query on every 10ms poll.
  const ticketEpoch = (pid: number): Promise<ProcessEpoch> => {
    let observed = epochs.get(name);
    const now = performance.now();
    if (!observed || now - observed.observedAt >= 1_000) {
      observed = { observedAt: now, value: readEpoch(pid).catch(() => ({})) };
      epochs.set(name, observed);
    }
    return observed.value;
  };
  if (await ownerIsDead(owner, ticketEpoch)) {
    // This UUID path can never be acquired by a replacement owner. Unlike the
    // previous shared-directory rename, a late reaper cannot remove a live lock.
    await rm(directory, { recursive: true, force: true });
    return undefined;
  }
  try {
    const value = await readFile(path.join(directory, "number"), "utf8");
    if (!/^[1-9]\d{0,99}$/.test(value)) throw new Error("file_mutex_invalid_ticket_number");
    return BigInt(value);
  } catch (error) {
    if (!isMissingError(error) && !(typeof error === "object" && error !== null && "code" in error && ["EPERM", "EBUSY", "EACCES"].includes(String(error.code)))) throw error;
    if (await isReleased(directory)) { await cleanupReleasedTicket(directory); return undefined; }
    // A released directory and a live choosing directory both lack a number.
    // Readdir distinguishes them without ever deleting an unverified owner.
    try { await readdir(directory); return "choosing"; } catch (missing) {
      if (isMissingError(missing)) return undefined;
      if (typeof missing === "object" && missing !== null && "code" in missing && ["EPERM", "EBUSY", "EACCES"].includes(String(missing.code))) return "choosing";
      throw missing;
    }
  }
}
async function tickets(lockPath: string): Promise<string[]> {
  return (await readdir(lockPath)).filter(name => name.startsWith("ticket-v1."));
}
/** Lamport bakery protocol on a local filesystem. All participants publish a
 * choosing ticket, pick max(number)+1, then wait for choosing/lower tickets.
 * Later arrivals necessarily choose a higher number. Shared lock directories
 * are never renamed or recursively removed; an empty container may be rmdir'd.
 * Network filesystems and simultaneous legacy binaries are not supported. */
async function acquireFileMutex(lockPath: string, legacyPath: string, options: FileMutexOptions, notifyWait?: (reason: FileMutexWaitEvent["reason"]) => void): Promise<string> {
  options.signal?.throwIfAborted();
  const readEpoch = options.readEpoch ?? readProcessEpoch;
  const epoch = cleanEpoch(await readEpoch(process.pid).catch(() => ({})));
  const epochs = new Map<string, ObservedTicketEpoch>();
  const timeout = options.waitTimeoutMs ?? 300_000, started = performance.now();
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error("file_mutex_invalid_wait_timeout");
  const wait = async (owner: Partial<TicketOwner>, verifiedLive = false): Promise<void> => {
    options.signal?.throwIfAborted();
    const waited = Math.floor(performance.now() - started);
    if ((options.waitTimeoutMs !== undefined || !verifiedLive) && waited >= timeout) throw new FileMutexTimeoutError(lockPath, waited, owner);
    notifyWait?.("file_lock"); await sleep(10, options.signal);
  };
  const name = ticketName({ pid: process.pid, hostHash, ...epoch }), own = path.join(lockPath, name);
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      // A releasing process may rmdir the empty container during either mkdir,
      // including the filesystem steps inside recursive mkdir itself.
      await mkdir(lockPath, { recursive: true, mode: 0o700 });
      await mkdir(own, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isMissingError(error)) throw error;
      await wait({});
    }
  }
  try {
    if (epoch.processBirth && /^(linux|darwin):/.test(epoch.processBirth)) {
      await writeFile(path.join(own, "birth.tmp"), epoch.processBirth, { flag: "wx", mode: 0o600 });
      await rename(path.join(own, "birth.tmp"), path.join(own, "birth"));
    }
    let maximum = 0n;
    for (const other of await tickets(lockPath)) {
      if (other === name) continue;
      const number = await readTicket(lockPath, other, readEpoch, epochs);
      if (typeof number === "bigint" && number > maximum) maximum = number;
    }
    const number = maximum + 1n;
    await writeFile(path.join(own, "number.tmp"), number.toString(), { mode: 0o600 });
    await rename(path.join(own, "number.tmp"), path.join(own, "number"));
    while (await legacyOwnerBlocks(legacyPath, readEpoch)) {
      const record = JSON.parse(await readFile(path.join(legacyPath, "owner.json"), "utf8").catch(error => { if (isMissingError(error)) return "{}"; throw error; })) as Partial<TicketOwner> & { host?: string };
      await wait({ pid: record.pid, ...cleanEpoch(record), ...(typeof record.host === "string" ? { hostHash: createHash("sha256").update(record.host).digest("hex").slice(0, 16) } : {}) });
    }
    for (const other of await tickets(lockPath)) {
      if (other === name) continue;
      for (;;) {
        const before = await readTicket(lockPath, other, readEpoch, epochs);
        if (before === undefined || (typeof before === "bigint" && (before > number || (before === number && other > name)))) break;
        const owner = await readTicketOwner(path.join(lockPath, other), other), observed = await epochs.get(other)?.value;
        // A matching boot does not prove that this PID has not been reused.
        // Until a process birth identity is available, retain the lock but
        // apply the bounded unknown-owner wait instead of hanging forever.
        const sameMachine = owner.machineId ? owner.machineId === observed?.machineId : owner.hostHash === hostHash;
        const verifiedLive = before !== "choosing" && sameMachine
          && Boolean(owner.processBirth && observed?.processBirth === owner.processBirth);
        await wait(owner, verifiedLive);
      }
    }
    options.signal?.throwIfAborted();
    return own;
  } catch (error) {
    await releaseFileMutex(lockPath, own);
    throw error;
  }
}

async function releaseFileMutex(lockPath: string, ticket: string): Promise<void> {
  // Publish completion before deleting the number, so a busy/deletion-pending
  // file can never strand a live Hub PID in the choosing state.
  await writeFile(path.join(ticket, "released"), "", { flag: "wx", mode: 0o600 });
  await cleanupReleasedTicket(ticket);
  // The kernel only removes an empty directory. Never recursively remove or
  // rename this shared path: a concurrent entrant may already own a new ticket.
  try { await rmdir(lockPath); } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || !["ENOENT", "ENOTEMPTY", "EEXIST", "EBUSY", "EPERM", "EACCES"].includes(String(error.code))) throw error;
  }
}

function scheduleFileMutexWaitNotification(
  input: {
    lockPath: string;
    waitStartedAt: number;
    waitNotifyAfterMs: number;
    notify: (reason: FileMutexWaitEvent["reason"]) => void;
    reason: FileMutexWaitEvent["reason"];
  },
): NodeJS.Timeout | undefined {
  if (input.waitNotifyAfterMs <= 0) {
    input.notify(input.reason);
    return undefined;
  }

  const timer = setTimeout(() => {
    input.notify(input.reason);
  }, input.waitNotifyAfterMs);
  timer.unref?.();
  return timer;
}

export async function withFileMutex<T>(
  targetPath: string,
  task: () => Promise<T>,
  options: FileMutexOptions = {},
): Promise<T> {
  const lockPath = `${targetPath}.mutex.lock`;
  const legacyPath = `${targetPath}.lock`;
  const waitNotifyAfterMs = options.waitNotifyAfterMs ?? 0;
  const waitTimeoutMs = options.waitTimeoutMs;
  const waitStartedAt = Date.now();
  const budgetStartedAt = performance.now();
  let waitNotified = false;
  const notifyWait = (reason: FileMutexWaitEvent["reason"]): void => {
    if (waitNotified || !options.onWait) {
      return;
    }
    const waitedMs = Math.max(0, Date.now() - waitStartedAt);
    if (waitedMs < waitNotifyAfterMs) {
      return;
    }
    waitNotified = true;
    void Promise.resolve(options.onWait({ lockPath, waitedMs, reason })).catch((error: unknown) => {
      console.error("Failed to notify file mutex wait:", error instanceof Error ? error.message : error);
    });
  };
  const previous = inProcessQueues.get(lockPath);
  const waitForPrevious = async (): Promise<void> => {
    if (!previous) {
      return;
    }
    const timer = scheduleFileMutexWaitNotification({
      lockPath,
      waitStartedAt,
      waitNotifyAfterMs,
      notify: notifyWait,
      reason: "in_process_queue",
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const waiting = previous.catch(() => undefined);
      if (waitTimeoutMs === undefined) await waitOrAbort(waiting, options.signal);
      else await waitOrAbort(Promise.race([waiting, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new FileMutexTimeoutError(lockPath, performance.now() - budgetStartedAt, { pid: process.pid })), Math.max(0, waitTimeoutMs));
      })]), options.signal);
    } finally {
      if (deadline) clearTimeout(deadline);
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
  const acquireRunRelease = async (): Promise<T> => {
    const remaining = options.waitTimeoutMs === undefined ? undefined : options.waitTimeoutMs - (performance.now() - budgetStartedAt);
    if (remaining !== undefined && remaining <= 0) throw new FileMutexTimeoutError(lockPath, performance.now() - budgetStartedAt, {});
    const token = await acquireFileMutex(lockPath, legacyPath, remaining === undefined ? options : { ...options, waitTimeoutMs: remaining }, notifyWait);
    try {
      options.signal?.throwIfAborted();
      return await task();
    } finally {
      await releaseFileMutex(lockPath, token);
    }
  };
  const run = waitForPrevious().then(acquireRunRelease);

  // A timed-out waiter must never execute later or remove the live predecessor
  // from the queue. Later callers still wait for that predecessor to release.
  const queued = Promise.all([previous, run.catch(() => undefined)]).then(() => undefined);
  inProcessQueues.set(lockPath, queued);
  void queued.then(() => {
    if (inProcessQueues.get(lockPath) === queued) {
      inProcessQueues.delete(lockPath);
    }
  });
  return run;
}
