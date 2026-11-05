import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import * as update from "../src/host-cli/update.js";
import * as service from "../src/hub/service.js";
import { captureUpdateRecovery, recoverUnchangedAutostart, recoverUnchangedRuntime } from "../src/host-cli/update-recovery.js";
import { withFileMutex } from "../src/state/file-mutex.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-update-recovery-")); roots.push(root);
  const directory = path.join(root, "host"), runtime = path.join(root, "host.runtime");
  await mkdir(runtime); await writeFile(path.join(runtime, "current.json"), "original selection");
  const selected = { entrypoint: "/original/index.js", executable: "/original/node", revisionId: "0.1.420-0000000000000000", runtimeId: "a".repeat(64) };
  const status = { running: true as const, pid: 123, publicKey: "original host", url: "http://127.0.0.1:1234", version: "0.1.420", runtimeId: selected.runtimeId };
  vi.spyOn(update, "resolveHostRuntime").mockResolvedValue(selected);
  vi.spyOn(service, "inspectHubService").mockResolvedValue(status);
  return { directory, runtime, status, selected };
}
it("restores availability after failed snapshot when the frozen selection never changed", async () => {
  const { directory, status } = await fixture();
  const before = await captureUpdateRecovery(directory, "/cli/index.js", status), start = vi.fn(async () => undefined);
  expect(await recoverUnchangedRuntime(directory, "/cli/index.js", before, start)).toBe(true);
  expect(start).toHaveBeenCalledOnce();
});
it("does not certify a still-draining original process as recovered", async () => {
  const { directory, status } = await fixture();
  const point = await captureUpdateRecovery(directory, "/cli/index.js", status);
  vi.mocked(service.inspectHubService).mockResolvedValue({ ...status, draining: true, drainId: "committed-stop" });
  const start = vi.fn(async () => undefined);
  await expect(recoverUnchangedRuntime(directory, "/cli/index.js", point, start, { timeoutMs: 0 })).rejects.toThrow("恢复验收不匹配");
  expect(start).not.toHaveBeenCalled();
});
it("waits through a closing control socket and terminal drain before restarting exactly once", async () => {
  const { directory, status } = await fixture(), point = await captureUpdateRecovery(directory, "/cli/index.js", status);
  const inspect = vi.mocked(service.inspectHubService).mockRejectedValueOnce(new Error("hub_control_closed")).mockResolvedValueOnce({ ...status, draining: true }).mockResolvedValueOnce({ running: false }).mockResolvedValue(status);
  const start = vi.fn(async () => { expect(inspect).toHaveBeenCalledTimes(3); });
  expect(await recoverUnchangedRuntime(directory, "/cli/index.js", point, start, { timeoutMs: 1000 })).toBe(true);
  expect(start).toHaveBeenCalledOnce();
});
it("never restarts or rolls back after a selected pointer changed", async () => {
  const { directory, runtime, status } = await fixture();
  const before = await captureUpdateRecovery(directory, "/cli/index.js", status), start = vi.fn(async () => undefined);
  await writeFile(path.join(runtime, "current.json"), "different selection");
  expect(await recoverUnchangedRuntime(directory, "/cli/index.js", before, start)).toBe(false);
  expect(start).not.toHaveBeenCalled();
});
it("does not auto-start an unknown runtime or accept another host's health", async () => {
  const { directory, status } = await fixture();
  expect(await captureUpdateRecovery(directory, "/cli/index.js", { ...status, runtimeId: undefined })).toBeUndefined();
  const before = await captureUpdateRecovery(directory, "/cli/index.js", status);
  vi.mocked(service.inspectHubService).mockResolvedValue({ ...status, publicKey: "another host" });
  await expect(recoverUnchangedRuntime(directory, "/cli/index.js", before, async () => undefined)).rejects.toThrow("恢复验收不匹配");
});

it("restores an offline frozen host's login intent without starting it, only while its selection is unchanged", async () => {
  const { directory, runtime } = await fixture();
  const point = await captureUpdateRecovery(directory, "/cli/index.js", { running: false });
  const start = vi.fn(async () => undefined), enable = vi.fn(async () => undefined);
  expect(await recoverUnchangedRuntime(directory, "/cli/index.js", point, start)).toBe(false);
  expect(start).not.toHaveBeenCalled();
  expect(await recoverUnchangedAutostart(directory, "/cli/index.js", point, enable)).toBe(true);
  expect(enable).toHaveBeenCalledOnce();
  await writeFile(path.join(runtime, "current.json"), "different selection");
  expect(await recoverUnchangedAutostart(directory, "/cli/index.js", point, enable)).toBe(false);
  expect(enable).toHaveBeenCalledOnce();
});

it("does not restore autostart for an unknown or changed runtime, and surfaces enable failures", async () => {
  const { directory, selected } = await fixture();
  const enable = vi.fn(async () => { throw new Error("enable failed"); });
  expect(await recoverUnchangedAutostart(directory, "/cli/index.js", undefined, enable)).toBe(false);
  const point = await captureUpdateRecovery(directory, "/cli/index.js", { running: false });
  await expect(recoverUnchangedAutostart(directory, "/cli/index.js", point, enable)).rejects.toThrow("enable failed");
  vi.mocked(update.resolveHostRuntime).mockResolvedValue({ ...selected, runtimeId: "b".repeat(64) });
  expect(await recoverUnchangedAutostart(directory, "/cli/index.js", point, enable)).toBe(false);
  expect(enable).toHaveBeenCalledOnce();
});

it.each([false, true])("serializes recovery with selection writes and rechecks after waiting (running=%s)", async running => {
  const { directory, runtime, status } = await fixture();
  const point = await captureUpdateRecovery(directory, "/cli/index.js", running ? status : { running: false });
  let entered!: () => void, release!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const writer = withFileMutex(path.join(runtime, "update"), async () => { entered(); await blocked; });
  await acquired;
  const enable = vi.fn(async () => undefined), recovery = (running ? recoverUnchangedRuntime : recoverUnchangedAutostart)(directory, "/cli/index.js", point, enable);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(enable).not.toHaveBeenCalled();
    await writeFile(path.join(runtime, "current.json"), "new selection while recovery waits");
  } finally { release(); await writer; }
  expect(await recovery).toBe(false); expect(enable).not.toHaveBeenCalled();
});

it("cannot capture an offline mutable runtime for automatic recovery", async () => {
  const { directory, selected } = await fixture();
  vi.mocked(update.resolveHostRuntime).mockResolvedValue({ ...selected, revisionId: undefined });
  expect(await captureUpdateRecovery(directory, "/cli/index.js", { running: false })).toBeUndefined();
});
