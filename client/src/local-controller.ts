import { invoke } from "./desktop-bridge.js";
import type { HostRegistry } from "./host-registry.js";
import type { HostConnections } from "./host-connections.js";
import { LocalControllerStartupError, startupAttempt, type StartupAttempt } from "./startup-diagnostics.js";
import { desktopControllerSupported, type DesktopRuntimeIssue } from "../../src/client-protocol/desktop-runtime.js";

export type LocalControllerIssue = DesktopRuntimeIssue | "directory_missing" | "redirected" | "shadow_only" | "conflict" | "incomplete" | "probe_failed" | "foreign_runtime" | "identity_changed" | "credentials" | "keychain" | "controller_failed" | "background" | "stopped";
type NativeHostStatus = { available?: boolean; publicKey?: string; running?: boolean; directoryState?: string; hostEnabled?: boolean; runtimeIssue?: DesktopRuntimeIssue; controlCapabilities?: string[] };
export type LocalControllerResult = { publicKey?: string; pending: boolean; issue?: LocalControllerIssue };
const directoryIssues = new Set(["redirected", "shadow_only", "conflict", "incomplete", "probe_failed", "foreign_runtime", "runtime_update_required"]);
const runtimeIssues = new Set<DesktopRuntimeIssue>(["runtime_update_required", "runtime_restart_required", "runtime_waiting", "runtime_recovery_failed"]);
type NativeRequest = (args: { action: "resume" | "status" | "pair"; device?: Record<string, unknown> }) => Promise<NativeHostStatus>;

function pairingIssue(error: unknown): LocalControllerIssue {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const reason = startupAttempt("resume", error).reason;
  if (reason === "runtime_update_required" || code === "desktop_host_update_required") return "runtime_update_required";
  if (["device_key_unavailable", "system_keychain_unavailable", "system_keychain_busy"].includes(code)) return "keychain";
  if (["desktop_host_device_key_mismatch", "device_key_invalid", "invalid_device_id"].includes(code) || reason === "controller_proof_rejected") return "credentials";
  // A transport, runtime or registry failure is not evidence of bad credentials.
  return "controller_failed";
}

/** Resume honors the native enabled/service flags. It never turns an explicitly
 * stopped or client-only install into a host. An App-owned obsolete runtime may
 * be replaced only through the native guarded, idle-only update lifecycle. */
export function watchLocalHostRecovery(request: NativeRequest = args => invoke("desktop_host", args), targets: EventTarget[] = [window, document]): () => void {
  let stopped = false, pending = false, attemptedAt = Date.now();
  const check = () => {
    if (stopped || pending || Date.now() - attemptedAt < 15_000) return;
    pending = true; attemptedAt = Date.now();
    void Promise.resolve().then(() => request({ action: "resume" })).catch(() => undefined).finally(() => { pending = false; });
  };
  const events = ["focus", "online", "pageshow", "visibilitychange"];
  for (const target of targets) for (const event of events) target.addEventListener(event, check);
  const timer = setInterval(check, 60_000);
  return () => { stopped = true; clearInterval(timer); for (const target of targets) for (const event of events) target.removeEventListener(event, check); };
}

/** Mark the native controller before any local authentication can classify a
 * legacy identity as a remotely paired device. Remote hosts can still start
 * when the local runtime or Keychain is temporarily unavailable. */
export async function prepareLocalController(registry: HostRegistry, request: NativeRequest = args => invoke("desktop_host", args), recovery?: { current: () => boolean; expectedKey?: string }): Promise<LocalControllerResult> {
  const current = () => { if (recovery && !recovery.current()) throw new Error("local_controller_recovery_superseded"); };
  const saved = await registry.nativeLocalHost(); current();
  const remembered = recovery?.expectedKey || saved;
  if (saved && remembered && saved !== remembered) return { publicKey: remembered, pending: true, issue: "identity_changed" };
  const attempts: StartupAttempt[] = [];
  let host: NativeHostStatus | undefined, resumed = false;
  try { host = await request({ action: "resume" }); resumed = true; }
  catch (error) {
    attempts.push(startupAttempt("resume", error));
    try { host = await request({ action: "status" }); }
    catch (error) { attempts.push(startupAttempt("status", error)); /* Use only a previously native-confirmed key. */ }
  }
  current();
  if (remembered && host?.publicKey && host.publicKey !== remembered) return { publicKey: remembered, pending: true, issue: "identity_changed" };
  const publicKey = host?.publicKey ?? remembered;
  const diagnosticIssue = attempts.map(attempt => attempt.reason?.replace(/^state_/, "")).find(reason => reason && directoryIssues.has(reason)) as LocalControllerIssue | undefined;
  if (host?.directoryState && directoryIssues.has(host.directoryState)) {
    if (!publicKey) {
      const records = await registry.list(); current();
      if (!records.length) return { pending: false, issue: host.directoryState as LocalControllerIssue };
      throw new LocalControllerStartupError([{ action: "status", code: "desktop_host_operation_failed", reason: `state_${host.directoryState}` }]);
    }
    return { publicKey, pending: true, issue: host.directoryState as LocalControllerIssue };
  }
  if (host?.publicKey && !recovery) { await registry.rememberNativeLocalHost(host.publicKey); current(); }
  if (!publicKey) {
    // A successfully queried, unconfigured/client-only install has no local
    // identity to migrate. Unknown native failure must not start an old one.
    if (!host) throw new LocalControllerStartupError(attempts);
    return { pending: false };
  }
  if (!resumed || host?.available === false || !host?.publicKey || host?.running === false) return { publicKey, pending: true,
    issue: host?.runtimeIssue && runtimeIssues.has(host.runtimeIssue) ? host.runtimeIssue : diagnosticIssue ?? (["missing", "empty"].includes(host?.directoryState ?? "") ? "directory_missing" : host?.hostEnabled === false ? "stopped" : "background") };
  const runtimeIssue = host.runtimeIssue && runtimeIssues.has(host.runtimeIssue) ? host.runtimeIssue : undefined;
  const usableOlderHost = runtimeIssue && ["runtime_waiting", "runtime_restart_required", "runtime_recovery_failed"].includes(runtimeIssue) && desktopControllerSupported(host);
  if (runtimeIssue && !usableOlderHost) return { publicKey, pending: true, issue: runtimeIssue };
  const local = (await registry.list()).find(entry => entry.publicKey === publicKey && entry.state === "ready"); current();
  if (local) {
    let handle: Awaited<ReturnType<HostRegistry["open"]>> | undefined;
    try {
      handle = await registry.open(local.id); current();
      const { deviceId, name, platform, publicKey: deviceKey, keyRef } = handle.identity;
      await request({ action: "pair", device: { deviceId, name, platform, publicKey: deviceKey, keyRef } });
      current();
      const latest = (await registry.list()).find(entry => entry.id === local.id);
      if (!latest || latest.registrationId !== local.registrationId || latest.state !== "ready") throw new Error("local_controller_registration_changed");
    } catch (error) { current(); return { publicKey, pending: true, issue: pairingIssue(error) }; }
    finally { handle?.cache.close(); }
  }
  current();
  return { publicKey, pending: false, ...(runtimeIssue ? { issue: runtimeIssue } : {}) };
}

/** Same verification path at boot and after wake. Publication is synchronous so
 * React state and pool identity change together before refresh emits events. */
export async function recoverLocalController(registry: HostRegistry, pool: Pick<HostConnections, "localHostKey" | "localControllerPending" | "refresh">,
  publish: (result: LocalControllerResult) => void, alive: () => boolean = () => true, request?: NativeRequest): Promise<boolean> {
  const expectedKey = pool.localHostKey;
  const current = () => alive() && pool.localHostKey === expectedKey;
  if (!pool.localControllerPending && expectedKey) {
    // Healthy connections already have native proof. A transient wake/probe or
    // keychain failure must not tear them down or re-enroll them every minute.
    let status: NativeHostStatus;
    try { status = await (request ?? (args => invoke<NativeHostStatus>("desktop_host", args)))({ action: "resume" }); }
    catch { return current(); }
    if (!current()) return false;
    const issue = status.publicKey && status.publicKey !== expectedKey ? "identity_changed"
      : status.directoryState && directoryIssues.has(status.directoryState) && status.directoryState !== "probe_failed" ? status.directoryState as LocalControllerIssue
      : status.runtimeIssue && runtimeIssues.has(status.runtimeIssue) ? status.runtimeIssue : undefined;
    // A previously authenticated connection can still handle questions and
    // approvals while its tasks finish. Do not deadlock drain behind pairing.
    if (issue === "runtime_waiting" || (issue === "runtime_restart_required" && desktopControllerSupported(status))
      || (issue === "runtime_recovery_failed" && status.running && status.publicKey === expectedKey && desktopControllerSupported(status))) {
      publish({ publicKey: expectedKey, pending: false, issue }); return true;
    }
    if (!issue) {
      // Clear an earlier "waiting for tasks" notice once the new host is live.
      if (status.running && status.publicKey === expectedKey) publish({ publicKey: expectedKey, pending: false });
      return true;
    }
    pool.localControllerPending = true; publish({ publicKey: expectedKey, pending: true, issue });
    await pool.refresh(); return current();
  }
  const result = await prepareLocalController(registry, request, { current, expectedKey });
  if (!current()) return false;
  pool.localHostKey = result.publicKey ?? expectedKey;
  pool.localControllerPending = result.pending;
  publish(result);
  await pool.refresh();
  return alive() && pool.localHostKey === (result.publicKey ?? expectedKey);
}
