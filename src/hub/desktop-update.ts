import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutex } from "../state/file-mutex.js";
import { waitForHostIdle, keepHostDrainLease, captureDrainedStopGuard } from "../host-cli/lifecycle.js";
import { managedServiceStatus } from "../host-cli/service-manager.js";
import { resolveHostRuntime } from "../host-cli/update.js";
import { hubServiceCommand, inspectHubService } from "./service.js";
import { HubDatabase } from "./database.js";
import { JsonStore } from "../state/json-store.js";
import { desktopControllerSupported, desktopRuntimePolicy, type DesktopRuntimeIssue } from "../client-protocol/desktop-runtime.js";

function processExists(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
async function waitForExit(pid: number) {
  const deadline = Date.now() + 15_000;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error("desktop_update_stop_unconfirmed");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** A desktop update may replace its App, never a separately selected CLI runtime. */
export async function desktopUpdateSession(options: {
  directory: string; entrypoint: string; signal: AbortSignal;
  /** Resolves when the native parent is done; "retain-stopped" when it could
   * not confirm which App bundle is installed. */
  ready(): void; finished: Promise<void | "retain-stopped">; timeoutMs?: number;
  /** Reconcile a replaced App bundle at ordinary startup, without an installer. */
  reconcileInstalled?: boolean;
}) {
  const { directory, entrypoint, signal, ready, finished } = options;
  return withFileMutex(path.join(directory, "desktop-start"), async () => {
    const selected = await resolveHostRuntime(directory, entrypoint);
    const independent = (await managedServiceStatus(directory)).configured || path.resolve(selected.entrypoint) !== path.resolve(entrypoint)
      || path.resolve(selected.executable) !== path.resolve(process.execPath);
    if (independent && !options.reconcileInstalled) {
      ready(); await finished; return { retainedIndependentHost: true };
    }
    const initial = options.reconcileInstalled ? await inspectHubService(directory, "status", { authenticate: true }) : await inspectHubService(directory);
    if (!initial.running) { ready(); await finished; return { retainedStoppedHost: true }; }
    let runtimeVersion: string | undefined;
    if (options.reconcileInstalled) {
      runtimeVersion = (JSON.parse(await readFile(path.resolve(path.dirname(entrypoint), "../../package.json"), "utf8")) as { version: string }).version;
      const policy = desktopRuntimePolicy(initial, runtimeVersion, independent || Boolean(initial.runtimeId || initial.supervisor));
      if (policy === "current") return { retainedCurrentHost: true };
      if (policy !== "upgrade") return { runtimeIssue: `runtime_${policy}` as DesktopRuntimeIssue };
    }
    const desktopEnabled = async () => (await readFile(path.join(directory, "desktop-enabled.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "false";
      throw error;
    })).trim() === "true";
    if (!await desktopEnabled()) { ready(); await finished; return { retainedIndependentHost: true }; }
    const identityBytes = await readFile(path.join(directory, "identity.json"));
    if (options.reconcileInstalled && JSON.parse(identityBytes.toString("utf8")).publicKey !== initial.publicKey) throw new Error("desktop_update_identity_changed");
    const identity = createHash("sha256").update(identityBytes).digest("hex");
    // A failed handoff must not restart the same incompatible host every minute.
    // A newer installed bundle can try again; a compatible live host needs no handoff.
    type Attempt = { version: string; identity: string };
    const attempt = options.reconcileInstalled ? new JsonStore<Attempt | null>(path.join(directory, "desktop-runtime-recovery.json")) : undefined;
    const previous = await attempt?.read(null);
    if (previous?.version === runtimeVersion && previous?.identity === identity) return { runtimeIssue: "runtime_recovery_failed" as const };
    const retention = async () => {
      const db = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
      try {
        const counts: Record<string, number> = {};
        for (const table of ["bots", "conversations", "messages", "devices"]) counts[table] = (await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))!.count;
        return counts;
      } finally { await db.close(); }
    };
    let drainId: string | undefined, stopped = false, stopAttempted = false, restarted = false, parent: void | "retain-stopped" = undefined;
    let lease: ReturnType<typeof keepHostDrainLease> | undefined;
    let before: Record<string, number> | undefined;
    try {
      try { drainId = await waitForHostIdle(directory, options.timeoutMs ?? 300_000, signal); }
      catch (error) {
        if (options.reconcileInstalled && error && typeof error === "object" && "code" in error && ["host_drain_busy", "host_drain_owned"].includes(String(error.code))) return { runtimeIssue: "runtime_waiting" as const };
        throw error;
      }
      if (signal.aborted) throw new Error("desktop_update_cancelled");
      lease = drainId ? keepHostDrainLease(directory, drainId) : undefined;
      const guard = await captureDrainedStopGuard(directory, drainId);
      if (!guard || guard.pid !== initial.pid || guard.publicKey !== initial.publicKey) throw new Error("desktop_update_host_changed");
      lease?.check();
      if (options.reconcileInstalled) {
        const nowSelected = await resolveHostRuntime(directory, entrypoint);
        if (!await desktopEnabled() || (await managedServiceStatus(directory)).configured
          || path.resolve(nowSelected.entrypoint) !== path.resolve(selected.entrypoint)
          || path.resolve(nowSelected.executable) !== path.resolve(selected.executable)) throw new Error("desktop_update_host_changed");
        await attempt!.write({ version: runtimeVersion!, identity });
      }
      // Keep the user's enabled/stopped flag intact. This is an update pause.
      stopAttempted = true;
      await hubServiceCommand("stop", directory, entrypoint, { requireDrained: true, drainedStop: guard });
      await waitForExit(guard.pid);
      stopped = true; lease?.stop();
      before = await retention();
      if (signal.aborted) throw new Error("desktop_update_cancelled");
      ready();
      parent = await finished;
    } finally {
      lease?.stop();
      // The control pipe can close after the process stopped but before its
      // acknowledgment arrives. Recover that case without stopping a new Hub.
      if (!stopped && stopAttempted && initial.pid && !processExists(initial.pid)) {
        stopped = !(await inspectHubService(directory)).running;
      }
      if (stopped) {
        // EOF also reaches here: an exited/crashed App must not strand its Hub.
        // The App owns restoration of its bundle before closing the pipe on an
        // install error. Never roll an older runtime over a migrated database.
        // An App that could not confirm which bundle is installed keeps the Hub
        // stopped rather than starting an unverified or missing runtime.
        if (parent !== "retain-stopped" && await desktopEnabled()) {
          await hubServiceCommand("start", directory, entrypoint);
          const current = await inspectHubService(directory);
          const runtime = JSON.parse(await readFile(path.resolve(path.dirname(entrypoint), "../../package.json"), "utf8")) as { version: string };
          if (!current.running || current.publicKey !== initial.publicKey || current.version !== runtime.version || current.pid === initial.pid) throw new Error("desktop_update_restart_unconfirmed");
          if (options.reconcileInstalled && !desktopControllerSupported(current)) throw new Error("desktop_update_restart_unconfirmed");
          if (identity !== createHash("sha256").update(await readFile(path.join(directory, "identity.json"))).digest("hex")) throw new Error("desktop_update_identity_changed");
          if (before) {
            const after = await retention();
            for (const table of Object.keys(before)) if (after[table]! < before[table]!) throw new Error("desktop_update_history_changed");
          }
          restarted = true;
          await attempt?.write(null);
        }
      } else if (drainId) {
        const resumed = await inspectHubService(directory, "drain-cancel", { drainId });
        if (resumed.running && resumed.controlError) throw new Error("desktop_update_resume_failed");
      }
    }
    return restarted ? { restartedHost: true, identityPreserved: true, historyPreserved: true } : { retainedStoppedHost: true };
  }, { waitTimeoutMs: 30_000 });
}

/** One exact line from the native parent; anything else is treated as EOF. */
export function desktopUpdateParentCommand(data: string): "finish" | "retain-stopped" | undefined {
  const line = data.trim();
  return line === '{"command":"finish"}' ? "finish" : line === '{"command":"retain-stopped"}' ? "retain-stopped" : undefined;
}

/** Private native child protocol. Not a WebView API; all paths are native-owned.
 * The child is intentionally not killed with the GUI: stdin EOF resumes work. */
export async function runDesktopUpdateCli(args: string[]) {
  if (process.platform !== "darwin" || args.length !== 1 || !path.isAbsolute(args[0]!)) throw new Error("desktop_update_invalid_arguments");
  const directory = args[0]!, entrypoint = fileURLToPath(new URL("../index.js", import.meta.url));
  const controller = new AbortController();
  let finish!: (outcome?: "retain-stopped") => void, data = "", finished = false, retained = false;
  const completion = new Promise<void | "retain-stopped">(resolve => { finish = resolve; });
  const end = () => { controller.abort(); finish(); };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    data += chunk;
    if (data.length > 256) { end(); return; }
    if (data.includes("\n")) {
      const command = desktopUpdateParentCommand(data);
      if (command === "finish") { finished = true; finish(); }
      else if (command === "retain-stopped") { retained = true; finish("retain-stopped"); }
      else end();
    }
  });
  process.stdin.on("end", end); process.stdin.on("error", end);
  process.on("SIGTERM", end); process.on("SIGINT", end);
  process.stdout.on("error", end);
  const emit = (value: unknown) => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + "\n"); };
  try {
    const result = await desktopUpdateSession({ directory, entrypoint, signal: controller.signal, ready: () => emit({ phase: "ready" }), finished: completion });
    const receipt = { completedAt: new Date().toISOString(), parentConfirmed: finished, ...(retained ? { appRecoveryRequired: true } : {}), ...result };
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await writeFile(path.join(path.dirname(directory), "desktop-update-receipt.json"), JSON.stringify(receipt) + "\n", { mode: 0o600 });
    emit({ phase: "complete" });
  } catch {
    // Never expose raw paths, keys, logs, or task text to the renderer.
    emit({ phase: "error" }); process.exitCode = 1;
  } finally {
    process.stdin.pause(); process.stdin.destroy();
  }
}
