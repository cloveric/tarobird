import { createHash } from "node:crypto";
import { open, lstat, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isInstanceLockOwnerAlive } from "../state/instance-lock.js";
import { HostDirectoryError, hostDirectoryState, inspectWindowsDirectory, probeWindowsState } from "./windows-state-admission.js";

async function smallJson(file: string): Promise<unknown> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 65536) throw new Error("host_recovery_unsafe_metadata");
  const handle = await open(file, "r");
  try { const buffer = Buffer.alloc(65537); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > 65536) throw new Error("host_recovery_unsafe_metadata"); return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
  finally { await handle.close(); }
}
async function exists(file: string) { try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function assertUnpackaged(): Promise<void> {
  if (process.platform !== "win32") return;
  const probe = await probeWindowsState();
  if (probe.packageFamily || probe.helperPackageFamily) throw new HostDirectoryError("redirected");
}
async function summary(directory: string) {
  const state = await hostDirectoryState(directory);
  let identityFingerprint: string | undefined;
  if (await exists(path.join(directory, "identity.json"))) {
    const identity = await smallJson(path.join(directory, "identity.json")) as { publicKey?: unknown };
    if (typeof identity.publicKey !== "string" || identity.publicKey.length > 16384) throw new Error("host_recovery_invalid_identity");
    identityFingerprint = createHash("sha256").update(identity.publicKey).digest("hex");
  }
  return { directory, state, identityFingerprint,
    sqliteSidecars: await Promise.all(["hub.sqlite-wal", "hub.sqlite-shm"].filter(Boolean).map(async name => await exists(path.join(directory, name)) ? name : undefined)).then(names => names.filter(Boolean)),
    serviceManifest: await exists(path.join(directory, "host-service.json")) };
}
async function safeSummary(directory: string) {
  try { return await summary(directory); }
  catch { return { directory, state: "unverified", error: "host_recovery_metadata_unreadable" }; }
}
export async function planDirectoryRecovery(directory?: string) {
  if (process.platform !== "win32") return { platform: process.platform, state: "not_applicable", recoveryApplied: false };
  const report = await inspectWindowsDirectory(directory);
  if (report.state === "redirected") return { state: report.state, recoveryApplied: false, action: "Use TaroBot from the Start menu or an unpackaged terminal. No host files were changed." };
  const { managedServiceStatus, assertNoManagedServiceRegistration } = await import("./service-manager.js");
  const { inspectHubService } = await import("../hub/service.js");
  let control: { running?: boolean; error?: string };
  try { control = { running: (await inspectHubService(report.observation.requestedDirectory)).running }; }
  catch (error) { control = { error: error instanceof HostDirectoryError ? error.issue : "control_state_unknown" }; }
  let task: { configured?: boolean; registered?: boolean; error?: string };
  try { const service = await managedServiceStatus(report.directory); task = { configured: service.configured, registered: service.registered };
    if (!service.configured) {
      try { await assertNoManagedServiceRegistration(report.directory); }
      catch (error) { task = { configured: false, error: error instanceof Error && error.message.startsWith("host_service_registration_exists:") ? "orphan_service_registration" : "service_registration_unverified" }; }
    } }
  catch (error) { task = { error: error instanceof HostDirectoryError ? error.issue : "service_state_unknown" }; }
  return { state: report.state, recoveryApplied: false, destination: await safeSummary(report.directory),
    sources: await Promise.all(report.shadows.map(safeSummary)), shadowWorkspaces: report.shadowWorkspaces ?? [], task, control,
    action: "No automatic overwrite or merge. Follow docs/client/windows-host-directory-2026-10-19.md; preserve an offline verified backup and retire the old launch entry before starting the restored host." };
}

/** Full-file checks, never SQLite opens, migration or WAL checkpoint. A running
 * writer or unconfirmed owner makes an offline comparison invalid. */
export async function recoveryManifest(directory: string, limits = { entries: 100000, bytes: 20 * 1024 ** 3, milliseconds: 120000 }) {
  directory = path.resolve(directory);
  if (path.resolve(await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("host_recovery_redirected_root");
  const entries: { path: string; bytes: number; sha256: string }[] = []; let total = 0, count = 0;
  const deadline = Date.now() + limits.milliseconds;
  const walk = async (relative: string): Promise<void> => {
    if (Date.now() > deadline) throw new Error("host_recovery_scan_limit");
    const folder = path.join(directory, relative);
    if ((await lstat(folder)).isSymbolicLink()) throw new Error("host_recovery_link_requires_manual_review");
    if (await exists(path.join(folder, "instance.lock.json"))) {
      const record = await smallJson(path.join(folder, "instance.lock.json")) as { pid: number };
      if (!Number.isSafeInteger(record.pid) || record.pid < 1 || await isInstanceLockOwnerAlive(record)) throw new Error("host_recovery_running_or_unknown");
    }
    for await (const entry of await opendir(folder)) {
      if (++count > limits.entries || Date.now() > deadline) throw new Error("host_recovery_scan_limit");
      const name = relative ? `${relative}/${entry.name}` : entry.name, file = path.join(directory, name);
      const before = await lstat(file);
      if (before.isSymbolicLink()) throw new Error("host_recovery_link_requires_manual_review");
      if (before.isDirectory()) { await walk(name); continue; }
      if (!before.isFile()) throw new Error("host_recovery_unsupported_file");
      // These process-local receipts must not be interpreted as different user data.
      if (entry.name === "instance.lock.json" || entry.name === "hub-control.key") continue;
      total += before.size; if (total > limits.bytes) throw new Error("host_recovery_scan_limit");
      const handle = await open(file, "r"); const hash = createHash("sha256"); let size = 0;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("host_recovery_changed_during_scan");
        const buffer = Buffer.alloc(256 * 1024);
        for (;;) {
          if (Date.now() > deadline) throw new Error("host_recovery_scan_limit");
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
          size += bytesRead; if (size > before.size) throw new Error("host_recovery_changed_during_scan"); hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat(), named = await lstat(file);
        if (size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== named.ino || before.dev !== named.dev) throw new Error("host_recovery_changed_during_scan");
      } finally { await handle.close(); }
      entries.push({ path: name, bytes: size, sha256: hash.digest("hex") });
    }
  };
  await walk(""); entries.sort((a,b) => a.path.localeCompare(b.path));
  return entries;
}
export async function verifyDirectoryRecovery(source: string, destination: string) {
  await assertUnpackaged();
  source = path.resolve(source); destination = path.resolve(destination);
  if (source === destination) throw new Error("host_recovery_same_directory");
  if (await hostDirectoryState(source) !== "ready" || await hostDirectoryState(destination) !== "ready") throw new Error("host_recovery_incomplete");
  const [sourceRoot, destinationRoot] = await Promise.all([stat(source, { bigint: true }), stat(destination, { bigint: true })]);
  if (sourceRoot.dev === destinationRoot.dev && sourceRoot.ino === destinationRoot.ino) throw new Error("host_recovery_same_directory");
  const sourceEntries = await recoveryManifest(source), destinationEntries = await recoveryManifest(destination);
  // A second source pass detects writers that changed already-hashed files.
  if (JSON.stringify(sourceEntries) !== JSON.stringify(await recoveryManifest(source))) throw new Error("host_recovery_changed_during_scan");
  const left = new Map(sourceEntries.map(e => [e.path, e.sha256])), right = new Map(destinationEntries.map(e => [e.path, e.sha256]));
  const differences = [...new Set([...left.keys(), ...right.keys()])].filter(name => left.get(name) !== right.get(name));
  return { source, destination, verified: differences.length === 0, files: sourceEntries.length,
    sameIdentityBytes: left.get("identity.json") === right.get("identity.json"), differences: differences.slice(0,100), differenceCount: differences.length,
    recoveryApplied: false, limitation: "Offline byte comparison only. Keep both copies stopped throughout; no automatic overwrite, merge, relocation or credential change." };
}
