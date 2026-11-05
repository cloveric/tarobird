/** An in-process marker set only by an authorized App user-stop action.
 * Shutdown, timeouts and Feishu/Telegram retain their existing grace period. */
export const APP_USER_STOP_REASON = Object.freeze(new Error("Task was stopped by user"));
export const APP_STOP_PROCESS_GRACE_MS = 650;

/** Keep native CLI cleanup bounded after an explicit App stop. The process-tree
 * helper still attempts SIGTERM first and checks PID identity before SIGKILL. */
export function appStopKillOptions(signal?: AbortSignal): { graceMs: number } | undefined {
  return signal?.aborted && signal.reason === APP_USER_STOP_REASON
    ? { graceMs: APP_STOP_PROCESS_GRACE_MS }
    : undefined;
}
