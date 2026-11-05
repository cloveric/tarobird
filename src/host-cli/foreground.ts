import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import { inspectHubService, type HubServiceStatus } from "../hub/service.js";

/** Node preserves some invoked symlinks/casing in argv; compare physical files
 * before dispatching so an alias of this runtime cannot recursively spawn itself. */
export async function isCurrentHostRuntime(selected: { entrypoint: string; executable: string }, entrypoint: string): Promise<boolean> {
  const canonical = async (file: string) => {
    const value = await realpath(file);
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  const [selectedEntry, currentEntry, selectedNode, currentNode] = await Promise.all([
    canonical(selected.entrypoint), canonical(entrypoint), canonical(selected.executable), canonical(process.execPath),
  ]);
  return selectedEntry === currentEntry && selectedNode === currentNode;
}

type Child = Pick<ChildProcess, "once" | "off" | "kill" | "pid" | "exitCode" | "signalCode">;
export interface ForegroundRuntimeOptions {
  platform?: NodeJS.Platform;
  spawn?: (executable: string, args: string[], options: SpawnOptions) => Child;
  signals?: Pick<EventEmitter, "on" | "off">;
  inspect?: (directory: string, action: "status" | "stop", target?: { expectedPid: number; expectedPublicKey: string }) => Promise<HubServiceStatus | { running: false }>;
  setExitCode?: (code: number) => void;
  report?: (message: string) => void;
  retryMs?: number;
  warnAfterMs?: number;
}

/** The foreground wrapper owns no Hub lock and never detaches the child.
 * SIGINT from a POSIX terminal already reaches the inherited process group;
 * forwarding it would deliver a second interrupt during graceful shutdown.
 * A signal sent only to the wrapper still needs to reach its exact child, so
 * use idempotent private control rather than assuming a terminal delivered it. */
export async function runHostRuntime(executable: string, entry: string, args: string[], directory: string, options: ForegroundRuntimeOptions = {}): Promise<void> {
  const child = (options.spawn ?? spawn)(executable, [entry, ...args], { stdio: "inherit", windowsHide: true });
  const signals = options.signals ?? process, windows = (options.platform ?? process.platform) === "win32";
  const inspect = options.inspect ?? ((dir, action, target) => inspectHubService(dir, action, { authenticate: true, ...target }));
  const report = options.report ?? console.error;
  let exited = false, terminateSent = false, controlling = false, interruptedAt = 0, warned = false;
  let timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
  const pause = () => new Promise<void>(resolve => {
    wake = resolve;
    timer = setTimeout(() => { timer = undefined; wake = undefined; resolve(); }, options.retryMs ?? 100);
  });
  const controlStop = async () => {
    if (controlling || exited) return;
    controlling = true;
    try {
      while (!exited) {
        try {
          const status = await inspect(directory, "status");
          // Another Hub can already own the same directory while this child is
          // failing its instance lock. Never stop that unrelated process.
          if (!exited && status.running && status.pid === child.pid) {
            if (status.controlCapabilities?.includes("target-stop")) await inspect(directory, "stop", { expectedPid: child.pid, expectedPublicKey: status.publicKey });
            else if (!windows && !terminateSent) { terminateSent = true; child.kill("SIGTERM"); }
          }
        } catch { /* Startup/shutdown can close the pipe; wait for actual exit. */ }
        if (exited) break;
        if (!warned && Date.now() - interruptedAt >= (options.warnAfterMs ?? 45_000)) {
          warned = true;
          report("Host shutdown is not confirmed; still waiting for its private control channel. The foreground process remains attached.");
        }
        await pause();
      }
    } finally { controlling = false; }
  };
  const handleSignal = (signal: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK") => {
    if (exited) return;
    interruptedAt ||= Date.now();
    if (windows || signal === "SIGINT") { void controlStop(); return; }
    if (!terminateSent) { terminateSent = true; child.kill("SIGTERM"); }
  };
  const handlers = { SIGINT: () => handleSignal("SIGINT"), SIGTERM: () => handleSignal("SIGTERM"), SIGHUP: () => handleSignal("SIGHUP"), ...(windows ? { SIGBREAK: () => handleSignal("SIGBREAK") } : {}) };
  for (const [signal, handler] of Object.entries(handlers)) signals.on(signal, handler);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        exited = true;
        const status = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : 1);
        (options.setExitCode ?? (value => { process.exitCode = value; }))(status);
        resolve();
      });
    });
  } finally {
    exited = true;
    if (timer) clearTimeout(timer);
    wake?.(); wake = undefined;
    // Keep all signal handlers until the child has really exited, including
    // repeated Ctrl+C while Windows is still processing control stop.
    for (const [signal, handler] of Object.entries(handlers)) signals.off(signal, handler);
  }
}
