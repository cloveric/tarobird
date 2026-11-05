import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "./secret-redaction.js";
import { redactLogMetadata } from "../state/log-redaction.js";

export const SERVICE_LIFECYCLE_LOG_FILE = "service.lifecycle.log.jsonl";

export interface ServiceLifecycleEvent {
  type:
    | "service.starting"
    | "service.started"
    | "service.stopped"
    | "service.startup_maintenance"
    | "service.shutdown_cleanup"
    | "service.fatal"
    | "process.signal"
    | "process.exit"
    | "process.uncaught_exception"
    | "process.unhandled_rejection";
  instanceName: string;
  outcome?: "success" | "error";
  detail?: string;
  metadata?: Record<string, unknown>;
}

// Defense-in-depth: a thrown error's message/stack can carry a bearer token or a
// `*_secret=...` assignment, and lifecycle events persist verbatim to disk. Scrub
// `detail` and metadata before writing. Use the same bounded recursive scrub as
// audit/timeline logs, including nested arrays and non-string secret values.
function redactLifecycleEvent(event: ServiceLifecycleEvent): ServiceLifecycleEvent {
  const redacted: ServiceLifecycleEvent = { ...event };
  if (typeof redacted.detail === "string") {
    redacted.detail = redactSecrets(redacted.detail);
  }
  if (redacted.metadata) {
    redacted.metadata = redactLogMetadata(redacted.metadata);
  }
  return redacted;
}

export function appendServiceLifecycleEventSync(stateDir: string, event: ServiceLifecycleEvent): void {
  try {
    // 0700/0600: the lifecycle log records instance names, pids and error detail.
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const record = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      ...redactLifecycleEvent(event),
    };
    appendFileSync(
      path.join(stateDir, SERVICE_LIFECYCLE_LOG_FILE),
      `${JSON.stringify(record)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Lifecycle logging must never take the bot down.
  }
}

/** Observe Node's fatal path without installing an exception/rejection handler
 * that would swallow it or change the supervisor's exit/restart semantics. */
export function monitorServiceCrashes(stateDir: string, instanceName: string, channel: string): () => void {
  const monitor = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
    appendServiceLifecycleEventSync(stateDir, { type: origin === "unhandledRejection" ? "process.unhandled_rejection" : "process.uncaught_exception", instanceName, outcome: "error", detail: error.message, metadata: { channel } });
  };
  process.on("uncaughtExceptionMonitor", monitor);
  return () => process.off("uncaughtExceptionMonitor", monitor);
}
