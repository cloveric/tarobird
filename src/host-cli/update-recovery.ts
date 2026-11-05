import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspectHubService, type HubServiceStatus } from "../hub/service.js";
import { hostRuntimeDirectory, resolveHostRuntime } from "./update.js";
import { withFileMutex } from "../state/file-mutex.js";

type RecoveryPoint = { pointer: string; runtimeId: string } & ({ running: true; publicKey: string; version?: string } | { running: false });
async function pointerDigest(directory: string): Promise<string> {
  return createHash("sha256").update(await readFile(path.join(await hostRuntimeDirectory(directory), "current.json"))).digest("hex");
}
/** Only a verified, frozen, currently running runtime can be auto-restarted.
 * Legacy/unidentified processes remain an explicit recovery decision. */
export async function captureUpdateRecovery(directory: string, entrypoint: string, before: HubServiceStatus | { running: false }): Promise<RecoveryPoint | undefined> {
  if (before.running && (!before.publicKey || !before.runtimeId)) return;
  try {
    const runtime = await resolveHostRuntime(directory, entrypoint);
    if (!runtime.revisionId || !runtime.runtimeId || before.running && runtime.runtimeId !== before.runtimeId) return;
    const selection = { pointer: await pointerDigest(directory), runtimeId: runtime.runtimeId };
    return before.running ? { ...selection, running: true, publicKey: before.publicKey!, version: before.version } : { ...selection, running: false };
  } catch { return; }
}

/** Recover availability after a backup/selection failure only when selection
 * never changed. This never restores, downgrades or rewrites the database. */
export async function recoverUnchangedRuntime(directory: string, entrypoint: string, point: RecoveryPoint | undefined, start: () => Promise<unknown>, options: { timeoutMs?: number } = {}): Promise<boolean> {
  if (!point?.running) return false;
  return withUnchangedSelection(directory, entrypoint, point, async () => {
    const deadline = Date.now() + Math.min(60_000, Math.max(0, options.timeoutMs ?? 45_000));
    for (;;) {
      let current: Awaited<ReturnType<typeof inspectHubService>> | undefined;
      try { current = await inspectHubService(directory); }
      catch (error) {
        const value = error as NodeJS.ErrnoException;
        if (!["hub_control_closed", "hub_control_timeout"].includes(value.message) && !["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "ENOENT", "ECONNREFUSED"].includes(value.code ?? "")) throw error;
      }
      if (current?.running && (current.publicKey !== point.publicKey || current.runtimeId !== point.runtimeId || current.version !== point.version)) throw new Error("原运行时恢复验收不匹配，请执行 status 检查。");
      if (current && (!current.running || !current.draining && !current.drainId)) break;
      if (Date.now() >= deadline) throw new Error("原运行时恢复验收不匹配：主机仍在退出或状态未确认，请执行 status 检查。");
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    await start();
    const current = await inspectHubService(directory);
    if (!current.running || current.draining || current.drainId || current.publicKey !== point.publicKey || current.runtimeId !== point.runtimeId || current.version !== point.version) throw new Error("原运行时恢复验收不匹配，请执行 status 检查。");
  });
}

async function selectionUnchanged(directory: string, entrypoint: string, point: RecoveryPoint): Promise<boolean> {
  if (await pointerDigest(directory).catch(() => undefined) !== point.pointer) return false;
  return (await resolveHostRuntime(directory, entrypoint).catch(() => undefined))?.runtimeId === point.runtimeId;
}

/** Restore a host's existing login intent, never start it as a side
 * effect. The caller must have observed an installed, enabled service. */
export async function recoverUnchangedAutostart(directory: string, entrypoint: string, point: RecoveryPoint | undefined, enable: () => Promise<unknown>): Promise<boolean> {
  if (!point) return false;
  return withUnchangedSelection(directory, entrypoint, point, enable);
}

async function withUnchangedSelection(directory: string, entrypoint: string, point: RecoveryPoint, recover: () => Promise<unknown>): Promise<boolean> {
  // Keep the selection writer's lock through enable/start and health checking.
  // Their service-lock ordering matches selectRuntime; neither reacquires update.
  return withFileMutex(path.join(await hostRuntimeDirectory(directory), "update"), async () => {
    if (!await selectionUnchanged(directory, entrypoint, point)) return false;
    await recover(); return true;
  }, { waitTimeoutMs: 45_000 });
}
