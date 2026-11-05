import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";

import { withFileMutex, type FileMutexWaitEvent } from "../state/file-mutex.js";
import { getConversationKey } from "./conversation-key.js";

const TURN_LOCK_STALE_MS = 12 * 60 * 60 * 1000;
export const TURN_LOCK_WAIT_NOTIFY_AFTER_MS = 10_000;

export function resolveBridgeTurnLockPath(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return path.join(os.tmpdir(), "tarocub-turn-locks", digest);
}

export async function sessionLockNamespace(sessionFile: string): Promise<string> {
  try { return await realpath(sessionFile); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await realpath(path.dirname(sessionFile)).catch((parentError: NodeJS.ErrnoException) => {
      if (parentError.code !== "ENOENT") throw parentError;
      return path.resolve(path.dirname(sessionFile));
    });
    return path.join(parent, path.basename(sessionFile));
  }
}

export function bridgeConversationLockId(scope: { chatId: number; messageThreadId?: number; conversationKey?: string }, namespace?: string): string {
  const logicalScope = scope.conversationKey ?? getConversationKey(scope.chatId, scope.messageThreadId);
  return `conversation-scope:${namespace ? JSON.stringify([namespace, logicalScope]) : logicalScope}`;
}

export async function withBridgeTurnLock<T>(
  sessionId: string,
  task: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    waitNotifyAfterMs?: number;
    onWait?: (event: BridgeTurnLockWaitEvent) => void | Promise<void>;
  } = {},
): Promise<T> {
  return await withFileMutex(resolveBridgeTurnLockPath(sessionId), task, {
    staleLockMs: TURN_LOCK_STALE_MS,
    signal: options.signal,
    waitNotifyAfterMs: options.waitNotifyAfterMs ?? TURN_LOCK_WAIT_NOTIFY_AFTER_MS,
    onWait: options.onWait
      ? async (event) => await options.onWait?.(toBridgeTurnLockWaitEvent(sessionId, event))
      : undefined,
  });
}

export interface BridgeTurnLockWaitEvent {
  sessionId: string;
  waitedMs: number;
  reason: FileMutexWaitEvent["reason"];
  lockPath: string;
}

function toBridgeTurnLockWaitEvent(sessionId: string, event: FileMutexWaitEvent): BridgeTurnLockWaitEvent {
  return {
    sessionId,
    waitedMs: event.waitedMs,
    reason: event.reason,
    lockPath: event.lockPath,
  };
}
