import { constants } from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ROTATE_OPTIONS, type RotateOptions } from "../state/log-rotation.js";

// stdout/stderr are already open in launchd, systemd and detached Hub processes.
// Their append handles must keep the live inode; rename rotation cannot do that.
export const HUB_LOG_ROTATION: RotateOptions = { maxBytes: DEFAULT_ROTATE_OPTIONS.maxBytes, keepCount: 3 };
const PROBE_MS = 30_000;
export const isHubLogFile = (relative: string): boolean => /^(?:hub\.log(?:\.[1-9]\d*)?|\.hub\.log\.rotation\.tmp)$/.test(relative);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
async function regular(file: string) {
  const info = await lstat(file).catch(error => { if (missing(error)) return undefined; throw error; });
  if (info && (!info.isFile() || info.nlink !== 1)) throw new Error("hub_log_not_regular");
  return info;
}
async function openRegular(file: string, writable: boolean): Promise<FileHandle | undefined> {
  const before = await regular(file); if (!before) return undefined;
  const handle = await open(file, (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino) throw new Error("hub_log_not_regular");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function tail(handle: FileHandle, limit: number): Promise<Buffer> {
  const size = (await handle.stat()).size, bytes = Buffer.alloc(Math.min(size, limit));
  const start = Math.max(0, size - bytes.length); let read = 0;
  while (read < bytes.length) {
    const result = await handle.read(bytes, read, bytes.length - read, start + read);
    if (!result.bytesRead) break;
    read += result.bytesRead;
  }
  return bytes.subarray(0, read);
}
/** Bounded tail snapshots plus copy-truncate: the live pathname/inode never
 * changes. Like logrotate's copytruncate, bytes appended between copying and
 * truncation can be lost; this is an operational log, not the DB audit journal.
 * Size may exceed the threshold by traffic written between periodic probes. */
export async function rotateHubLog(directory: string, options: RotateOptions = HUB_LOG_ROTATION): Promise<boolean> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 || options.maxBytes > 100 * 1024 * 1024 || !Number.isSafeInteger(options.keepCount) || options.keepCount < 1 || options.keepCount > 10) throw new Error("hub_log_rotation_invalid");
  const file = path.join(directory, "hub.log"), handle = await openRegular(file, true);
  if (!handle) return false;
  const temporary = path.join(directory, ".hub.log.rotation.tmp");
  try {
    const current = await handle.stat(); if (current.size < options.maxBytes) return false;
    for (let i = 1; i <= options.keepCount; i++) await regular(`${file}.${i}`);
    // The Hub's instance lock and single-flight timer own one staging name.
    // A crashed rotation cannot accumulate one temporary snapshot per restart.
    await regular(temporary); await rm(temporary, { force: true });
    const snapshot = await open(temporary, "wx", 0o600);
    try { await snapshot.writeFile(await tail(handle, options.maxBytes)); await snapshot.sync(); }
    finally { await snapshot.close(); }
    for (let i = options.keepCount - 1; i >= 1; i--) {
      await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(error => { if (!missing(error)) throw error; });
    }
    await rename(temporary, `${file}.1`);
    // Do not truncate a replaced pathname, hard link or somebody else's log.
    const same = await regular(file);
    if (!same || same.dev !== current.dev || same.ino !== current.ino) throw new Error("hub_log_changed");
    await handle.truncate(0);
    return true;
  } finally { await handle.close(); await rm(temporary, { force: true }); }
}
/** One owner, one in-flight rotation; shutdown only drains maintenance and
 * never closes the supervisor's output handles or stops the Hub. */
export function startHubLogRotation(directory: string, onWarning: () => void, options: RotateOptions = HUB_LOG_ROTATION, interval = PROBE_MS): () => Promise<void> {
  let pending: Promise<unknown> | undefined, stopped = false;
  const tick = () => {
    if (stopped || pending) return;
    pending = rotateHubLog(directory, options).catch(onWarning).finally(() => { pending = undefined; });
  };
  tick(); const timer = setInterval(tick, interval); timer.unref();
  return async () => { stopped = true; clearInterval(timer); await pending; };
}
/** Preserve service logs visibility immediately after a rotation. */
export async function readHubLogTail(directory: string, maxBytes = 1024 * 1024): Promise<string> {
  const parts: Buffer[] = []; let remaining = maxBytes, found = false;
  for (let i = 0; i <= HUB_LOG_ROTATION.keepCount && remaining > 0; i++) {
    const handle = await openRegular(path.join(directory, `hub.log${i ? `.${i}` : ""}`), false);
    if (!handle) continue;
    found = true;
    try { const bytes = await tail(handle, remaining); parts.unshift(bytes); remaining -= bytes.length; }
    finally { await handle.close(); }
  }
  return found ? Buffer.concat(parts).toString("utf8").split("\n").slice(-200).join("\n") : "No Hub log yet.";
}
