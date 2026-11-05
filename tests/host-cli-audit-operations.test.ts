import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHostCli } from "../src/host-cli/cli.js";
import { pairingSharedRoutes } from "../src/host-cli/pairing.js";
import { isCurrentHostRuntime } from "../src/host-cli/foreground.js";
import { resetCliController, LocalHostClient } from "../src/host-cli/client.js";
import * as manager from "../src/host-cli/service-manager.js";
import * as setup from "../src/host-cli/setup.js";
import * as runtime from "../src/host-cli/update.js";
import * as guard from "../src/host-cli/schema-guard.js";
import * as service from "../src/hub/service.js";
import * as desktop from "../src/hub/desktop.js";
import * as management from "../src/host-cli/management.js";
import * as lifecycle from "../src/host-cli/lifecycle.js";

const roots: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-cli-audit-ops-")); roots.push(directory);
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(setup, "requireInitialized").mockResolvedValue(undefined as never);
  return { directory, output, args: ["--state-dir", directory, "--json"] };
}
afterEach(async () => { vi.restoreAllMocks(); for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });

it("does not stop an ordinary foreground Hub when no background service is installed", async () => {
  const f = await fixture();
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: false, running: true, registered: false, enabled: false, directory: f.directory, limitations: [] });
  const inspect = vi.spyOn(service, "inspectHubService"), stop = vi.spyOn(desktop, "desktopHost");
  const uninstall = vi.spyOn(manager, "uninstallManagedService").mockResolvedValue({ configured: false, running: false, registered: false, enabled: false, directory: f.directory, limitations: [] });
  await runHostCli(["service", "uninstall", "--yes", ...f.args]);
  expect(inspect).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
  expect(uninstall).toHaveBeenCalledWith(await realpath(f.directory), { requireDrained: true });
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ configured: false });
});

it.each(["restart", "pair"])("checks schema before %s can stop or reconfigure the current host", async command => {
  const f = await fixture();
  vi.spyOn(runtime, "resolveHostRuntime").mockResolvedValue({ entrypoint: "/old/index.js", executable: process.execPath } as never);
  vi.spyOn(guard, "assertHostRuntimeCompatible").mockRejectedValue(new Error("host_schema_incompatible"));
  const stop = vi.spyOn(desktop, "desktopHost"), inspect = vi.spyOn(service, "inspectHubService");
  await expect(runHostCli([command, ...(command === "pair" ? ["--lan"] : []), ...f.args])).rejects.toThrow("host_schema_incompatible");
  expect(stop).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
});

it("reports an already-started host separately from failed local controller enrollment", async () => {
  const f = await fixture();
  vi.spyOn(runtime, "resolveHostRuntime").mockResolvedValue({ entrypoint: "/index.js", executable: process.execPath } as never);
  vi.spyOn(guard, "assertHostRuntimeCompatible").mockResolvedValue({ schema: 14, minHubSchema: 1, maxHubSchema: 14, writeHubSchema: 14 });
  vi.spyOn(desktop, "desktopHost").mockResolvedValue({ available: true, running: true, publicKey: "same-host" } as never);
  vi.spyOn(LocalHostClient, "connect").mockRejectedValue(new Error("cli_controller_orphaned_revoke_explicitly:cli_old"));
  await runHostCli(["start", ...f.args]);
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ running: true, publicKey: "same-host", cliController: { ready: false, recovery: "tarobot enroll" } });
});

it("treats start on an already-running newer host as a read without migrating or restarting it", async () => {
  const f = await fixture();
  const compatible = vi.spyOn(guard, "assertHostRuntimeCompatible").mockRejectedValue(new Error("host_schema_incompatible"));
  const host = vi.spyOn(desktop, "desktopHost").mockResolvedValue({ available: true, running: true, publicKey: "newer-host" } as never);
  vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ deviceId: "cli_fixture", publicKey: "newer-host", close: vi.fn() } as never);
  await runHostCli(["start", ...f.args]);
  expect(compatible).not.toHaveBeenCalled(); expect(host).toHaveBeenCalledExactlyOnceWith("status", await realpath(f.directory), expect.any(String));
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ running: true, cliController: { ready: true } });
});

it("retains the CLI path for safe orphan registration cleanup without stopping an ordinary Hub", async () => {
  const f = await fixture();
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: false, running: false, registered: false, enabled: false, directory: f.directory, limitations: [] });
  vi.spyOn(manager, "uninstallManagedService").mockRejectedValue(new Error("host_service_handoff_required"));
  const stop = vi.spyOn(desktop, "desktopHost");
  await expect(runHostCli(["service", "uninstall", "--yes", ...f.args])).rejects.toThrow("host_service_handoff_required");
  expect(stop).not.toHaveBeenCalled();
});

it("previews an update without enrollment, stop, or selection changes", async () => {
  const f = await fixture();
  vi.spyOn(runtime, "preflightHostUpdate").mockResolvedValue({ version: "new" } as never);
  vi.spyOn(runtime, "inspectHostUpdateRecovery").mockResolvedValue({ entries: 7, bytes: 1024, excluded: ["bots/b/workspace"], unfinishedRuns: [] } as never);
  const stop = vi.spyOn(desktop, "desktopHost"), select = vi.spyOn(runtime, "activateHostUpdate"), enroll = vi.spyOn(LocalHostClient, "connect");
  await runHostCli(["update", "apply", "revision", "--dry-run", ...f.args]);
  expect(stop).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); expect(enroll).not.toHaveBeenCalled();
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ dryRun: true, recovery: { bytes: 1024 } });
});

it("reports the actual running host when update drain fails before shutdown", async () => {
  const f = await fixture();
  vi.spyOn(runtime, "preflightHostUpdate").mockResolvedValue({ version: "new" } as never);
  vi.spyOn(service, "inspectHubService").mockResolvedValue({ running: true, publicKey: "unfrozen-host" } as never);
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: false, running: true, registered: false, enabled: false, directory: f.directory, limitations: [] });
  vi.spyOn(lifecycle, "waitForHostIdle").mockRejectedValue(new Error("busy timeout"));
  const select = vi.spyOn(runtime, "activateHostUpdate");
  await expect(runHostCli(["update", "apply", "revision", "--yes", ...f.args])).rejects.toThrow("原主机仍在运行");
  expect(select).not.toHaveBeenCalled();
});

it.each(["apply", "rollback"])("preserves cancellation exit status and recovery guidance for update %s", async action => {
  const f = await fixture();
  vi.spyOn(runtime, "preflightHostUpdate").mockResolvedValue({ version: "new" } as never);
  vi.spyOn(service, "inspectHubService").mockResolvedValue({ running: true, publicKey: "unfrozen-host" } as never);
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: false, running: true, registered: false, enabled: false, directory: f.directory, limitations: [] });
  vi.spyOn(lifecycle, "waitForHostIdle").mockImplementation(async () => {
    process.emit("SIGINT"); throw new Error("cancelled drain");
  });
  const select = vi.spyOn(runtime, "activateHostUpdate"), rollback = vi.spyOn(runtime, "rollbackHostUpdate");
  await expect(runHostCli(["update", action, ...(action === "apply" ? ["revision"] : []), "--yes", ...f.args])).rejects.toMatchObject({
    exitCode: 130, message: expect.stringMatching(/原主机仍在运行.*update status.*原数据保留/),
  });
  expect(select).not.toHaveBeenCalled(); expect(rollback).not.toHaveBeenCalled();
});

it("resolves relative Bot workspaces in the invoking terminal, before sending to the Hub", async () => {
  const f = await fixture(), createBot = vi.fn(async value => value);
  vi.spyOn(management, "withHostManagement").mockImplementation(async (_directory, operation) => operation({ createBot } as never));
  await runHostCli(["bots", "create", "--name", "Test", "--engine", "codex", "--workspace", "./demo-work", ...f.args]);
  expect(createBot).toHaveBeenCalledWith(expect.objectContaining({ workspace: path.resolve("./demo-work") }));
});

it("leaves an existing shared route intact when pairing through another local interface", () => {
  const existing = [{ name: "Direct" as const, url: "https://custom.example", label: "Public endpoint" }, { name: "VPS" as const, url: "https://relay.example" }];
  for (const selected of [{ name: "Direct" as const, url: "https://192.168.1.2:8788" }, { name: "Tailscale" as const, url: "https://100.64.1.2:8788" }]) expect(pairingSharedRoutes(existing, selected)).toEqual(existing);
  expect(pairingSharedRoutes(existing.slice(1), { name: "Direct", url: "https://192.168.1.2:8788" })).toEqual([{ name: "Direct", url: "https://192.168.1.2:8788" }, existing[1]]);
  expect(pairingSharedRoutes(existing, { name: "Direct", url: "https://custom.example", certificateAuthority: "A".repeat(100) })[0]).toMatchObject({ label: "Public endpoint", certificateAuthority: "A".repeat(100) });
});

it("returns a usable enrollment instruction when resetting a missing controller identity", async () => {
  const f = await fixture();
  vi.spyOn(service, "inspectHubService").mockResolvedValue({ running: true, publicKey: "host" } as never);
  await expect(resetCliController(f.directory)).rejects.toThrow("cli_controller_missing_run_host_enroll");
});

it("does not lower the desktop flag ahead of the manager's guarded stop", async () => {
  const f = await fixture(), flag = path.join(f.directory, "desktop-enabled.json"); await writeFile(flag, "true\n");
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: true, enabled: true, running: true, directory: f.directory, limitations: [] });
  vi.spyOn(service, "inspectHubService").mockResolvedValue({ running: false });
  const stop = vi.spyOn(service, "hubServiceCommand").mockImplementation(async () => { expect(await readFile(flag, "utf8")).toBe("true\n"); return { running: false }; });
  await desktop.desktopHost("stop", f.directory, "/entry.js", { requireDrained: true });
  expect(stop).toHaveBeenCalledWith("stop", f.directory, "/entry.js", { requireDrained: true });
});

it("does not resume while manager intent is stopped even if the legacy desktop flag is still true", async () => {
  const f = await fixture(); await writeFile(path.join(f.directory, "desktop-enabled.json"), "true\n");
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: true, enabled: false, running: false, directory: f.directory, limitations: [] });
  vi.spyOn(service, "inspectHubService").mockResolvedValue({ running: false }); const start = vi.spyOn(service, "hubServiceCommand");
  expect(await desktop.desktopHost("resume", f.directory, "/entry.js")).toMatchObject({ running: false }); expect(start).not.toHaveBeenCalled();
});

it("recognizes physical runtime aliases without recursively redispatching the CLI", async () => {
  const f = await fixture(), node = path.join(f.directory, "node-alias"), entry = path.join(f.directory, "entry-alias");
  const source = fileURLToPath(import.meta.url);
  await symlink(process.execPath, node); await symlink(source, entry);
  expect(await isCurrentHostRuntime({ executable: node, entrypoint: entry }, source)).toBe(true);
});
