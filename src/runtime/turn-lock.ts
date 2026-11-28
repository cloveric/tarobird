import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";

import { withFileMutex, type FileMutexWaitEvent } from "../state/file-mutex.js";
import { getConversationKey } from "./conversation-key.js";

const TURN_LOCK_STALE_MS = 12 * 60 * 60 * 1000;
export const TURN_LOCK_WAIT_NOTIFY_AFTER_MS = 10_000;
const ordinaryTurns = new Map<string, number>();
const historyReaders = new Map<string, AbortController>();

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
    interruptHistorySnapshot?: boolean;
  } = {},
): Promise<T> {
  if (options.interruptHistorySnapshot) {
    options.signal?.throwIfAborted();
    ordinaryTurns.set(sessionId, (ordinaryTurns.get(sessionId) ?? 0) + 1);
    historyReaders.get(sessionId)?.abort(new Error("history_busy"));
  }
  try {
    return await withFileMutex(resolveBridgeTurnLockPath(sessionId), task, {
      staleLockMs: TURN_LOCK_STALE_MS,
      signal: options.signal,
      waitNotifyAfterMs: options.waitNotifyAfterMs ?? TURN_LOCK_WAIT_NOTIFY_AFTER_MS,
      onWait: options.onWait
        ? async (event) => await options.onWait?.(toBridgeTurnLockWaitEvent(sessionId, event))
        : undefined,
    });
  } finally {
    if (options.interruptHistorySnapshot) {
      const remaining = ordinaryTurns.get(sessionId)! - 1;
      if (remaining) ordinaryTurns.set(sessionId, remaining);
      else ordinaryTurns.delete(sessionId);
    }
  }
}

export async function withBridgeHistorySnapshotLock<T>(sessionId: string, controller: AbortController, task: () => Promise<T>): Promise<T> {
  const busy = new Error("history_busy");
  if (ordinaryTurns.has(sessionId)) throw busy;
  return withBridgeTurnLock(sessionId, async () => {
    if (ordinaryTurns.has(sessionId)) throw busy;
    historyReaders.set(sessionId, controller);
    try {
      // Wait for the adapter to finish cleanup before releasing either lock.
      const snapshot = await task();
      controller.signal.throwIfAborted();
      return snapshot;
    } finally {
      historyReaders.delete(sessionId);
    }
  }, { signal: controller.signal, waitNotifyAfterMs: 0, onWait: () => controller.abort(busy) });
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
