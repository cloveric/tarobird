import { expect, it, vi } from "vitest";
import { prepareLocalController, recoverLocalController } from "../client/src/local-controller.js";
import type { HostRegistry } from "../client/src/host-registry.js";
import { desktopStartupError } from "../src/runtime/startup-error.js";
import { startupAttempt } from "../client/src/startup-diagnostics.js";
import { HostDirectoryError } from "../src/host-cli/windows-state-admission.js";
function registry() {
  return { nativeLocalHost: async () => "original-host-key", rememberNativeLocalHost: vi.fn(), list: async () => [] } as unknown as HostRegistry;
}
it("does not replace a remembered native identity merely because another directory responds", async () => {
  const value = registry();
  const result = await prepareLocalController(value, async () => ({ available: true, running: true, publicKey: "other-host-key" }));
  expect(result).toMatchObject({ publicKey: "original-host-key", pending: true, issue: "identity_changed" });
  expect(value.rememberNativeLocalHost).not.toHaveBeenCalled();
});
it("distinguishes a missing data directory from missing native credentials", async () => {
  const result = await prepareLocalController(registry(), async () => ({ available: true, running: false, directoryState: "missing" }));
  expect(result).toMatchObject({ pending: true, issue: "directory_missing" });
});
it("retains a recovered pool identity even before a native key has been persisted", async () => {
  const value = registry(); vi.spyOn(value, "nativeLocalHost").mockResolvedValue(undefined);
  const pool = { localHostKey: "recovered-key", localControllerPending: true, refresh: vi.fn(async () => {}) };
  const publish = vi.fn();
  await recoverLocalController(value, pool, publish, () => true, async () => ({ available: true, running: true, publicKey: "different-key" }));
  expect(pool.localHostKey).toBe("recovered-key");
  expect(pool.localControllerPending).toBe(true);
  expect(publish).toHaveBeenCalledWith({ publicKey: "recovered-key", pending: true, issue: "identity_changed" });
});
it.each(["redirected", "shadow_only", "conflict", "incomplete", "probe_failed", "foreign_runtime", "runtime_update_required"] as const)("keeps %s diagnostics distinct without raw paths or credentials", issue => {
  const error = new HostDirectoryError(issue); error.message += " private-path credential";
  const marker = desktopStartupError(error, "desktop_command");
  expect(marker).toBe(`TAROBOT_STARTUP_V1|phase=desktop_command|error=${error.code}|kind=Error`);
  const parsed = startupAttempt("resume", `desktop_host_operation_failed|exit=78|reason=state_${issue}|error=${error.code}`);
  expect(parsed).toMatchObject({ reason: `state_${issue}`, error: error.code, exit: 78 });
});
it.each(["throw", "probe_failed", "healthy"])("healthy recovery does not re-pair or pause on %s", async mode => {
  const value = registry(), pool = { localHostKey: "original-host-key", localControllerPending: false, refresh: vi.fn(async () => {}) };
  const request = vi.fn(async () => { if (mode === "throw") throw new Error("transient failure"); return mode === "healthy" ? { running: true, publicKey: "original-host-key" } : { running: false, directoryState: "probe_failed" }; });
  const publish = vi.fn(); await recoverLocalController(value, pool, publish, () => true, request);
  expect(request).toHaveBeenCalledExactlyOnceWith({ action: "resume" });
  expect(pool.localControllerPending).toBe(false); expect(pool.refresh).not.toHaveBeenCalled();
  if (mode === "healthy") expect(publish).toHaveBeenCalledExactlyOnceWith({ publicKey: "original-host-key", pending: false });
  else expect(publish).not.toHaveBeenCalled();
});
it("a proven identity change still fences a previously healthy connection", async () => {
  const pool = { localHostKey: "original-host-key", localControllerPending: false, refresh: vi.fn(async () => {}) };
  await recoverLocalController(registry(), pool, vi.fn(), () => true, async () => ({ running: true, publicKey: "other" }));
  expect(pool.localHostKey).toBe("original-host-key"); expect(pool.localControllerPending).toBe(true);
});
it("a client with no saved connections can show host diagnostics without a startup dead end", async () => {
  const value = registry(); vi.spyOn(value, "nativeLocalHost").mockResolvedValue(undefined);
  expect(await prepareLocalController(value, async () => ({ available: true, running: false, directoryState: "shadow_only" }))).toEqual({ pending: false, issue: "shadow_only" });
  vi.spyOn(value, "list").mockResolvedValue([{ publicKey: "ambiguous" }] as any);
  await expect(prepareLocalController(value, async () => ({ available: true, running: false, directoryState: "shadow_only" }))).rejects.toThrow("local_controller_unavailable");
});
it("a same-key pairing generation supersedes an in-flight recovery", async () => {
  const value = registry(), pool = { localHostKey: "original-host-key", localControllerPending: true, refresh: vi.fn(async () => {}) };
  let current = true; const publish = vi.fn();
  await expect(recoverLocalController(value, pool, publish, () => current, async () => { current = false; return { running: true, publicKey: "original-host-key" }; })).rejects.toThrow("local_controller_recovery_superseded");
  expect(publish).not.toHaveBeenCalled(); expect(pool.refresh).not.toHaveBeenCalled();
});


it.each(["identity", "missing-proof", "stopped"])("still fences %s after a failed runtime switch", async mode => {
  const pool = { localHostKey: "original-host-key", localControllerPending: false, refresh: vi.fn(async () => {}) };
  await recoverLocalController(registry(), pool, vi.fn(), () => true, async () => ({
    running: mode !== "stopped", publicKey: mode === "identity" ? "other" : "original-host-key", runtimeIssue: "runtime_recovery_failed",
    controlCapabilities: mode === "missing-proof" ? [] : ["desktop-controller-challenge", "enroll-desktop-controller"],
  }));
  expect(pool.localControllerPending).toBe(true); expect(pool.refresh).toHaveBeenCalledOnce();
});
