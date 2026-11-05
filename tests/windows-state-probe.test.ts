import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ error: {} as Record<string, unknown> }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn((_file, _args, _options, callback) => callback(state.error)),
}));
import { probeWindowsState } from "../src/host-cli/windows-state-admission.js";

it.each(["conflict", "redirected"])("preserves the native %s refusal instead of reporting a broken probe", async issue => {
  state.error = { code: 78, stderr: `host_directory_${issue}\n` };
  await expect(probeWindowsState()).rejects.toMatchObject({ issue, exitCode: 78 });
});
it.each([
  { code: 78, stderr: "untrusted diagnostic secret" },
  { code: "ENOENT", stderr: "host_directory_conflict" },
  { code: 78, killed: true, stderr: "host_directory_conflict" },
  { code: 78, stderr: "prefix host_directory_conflict" },
])("keeps unknown or interrupted probe failures generic: %j", async error => {
  state.error = error;
  await expect(probeWindowsState()).rejects.toMatchObject({ issue: "probe_failed", message: "host_directory_probe_failed" });
});
