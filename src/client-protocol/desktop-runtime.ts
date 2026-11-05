/** Capability checks describe the running process, not files replaced by a DMG. */
export const DESKTOP_CONTROLLER_CAPABILITIES = ["desktop-controller-challenge", "enroll-desktop-controller"] as const;
const SAFE_RESTART_CAPABILITIES = ["drain", "drain-renew", "drain-cancel", "drained-stop"] as const;
export type DesktopRuntimePolicy = "current" | "upgrade" | "update_required" | "restart_required";
export type DesktopRuntimeIssue = "runtime_update_required" | "runtime_restart_required" | "runtime_waiting" | "runtime_recovery_failed";
type RunningRuntime = { version?: string; controlCapabilities?: readonly string[]; drained?: boolean };

export function desktopControllerSupported(status: RunningRuntime): boolean {
  return DESKTOP_CONTROLLER_CAPABILITIES.every(capability => status.controlCapabilities?.includes(capability));
}
function version(value?: string): number[] | undefined {
  if (!value || !/^\d+\.\d+\.\d+$/.test(value)) return;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}
export function desktopRuntimePolicy(status: RunningRuntime, bundledVersion: string, independent: boolean): DesktopRuntimePolicy {
  const compatible = desktopControllerSupported(status);
  if (independent) return compatible ? "current" : "update_required";
  const actual = version(status.version), bundled = version(bundledVersion);
  // Unknown/prerelease versions cannot establish an upgrade direction.
  if (!actual || !bundled) return compatible ? "current" : "restart_required";
  const different = actual.findIndex((part, index) => part !== bundled[index]);
  if (different < 0 || actual[different]! > bundled[different]!) return compatible ? "current" : "update_required";
  return status.drained !== undefined && SAFE_RESTART_CAPABILITIES.every(capability => status.controlCapabilities?.includes(capability))
    ? "upgrade" : "restart_required";
}
