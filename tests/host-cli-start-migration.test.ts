import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostCli } from "../src/host-cli/cli.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import * as setup from "../src/host-cli/setup.js";
import * as runtime from "../src/host-cli/update.js";
import * as guard from "../src/host-cli/schema-guard.js";
import * as manager from "../src/host-cli/service-manager.js";
import * as desktop from "../src/hub/desktop.js";
import { HubStore } from "../src/hub/store.js";
import { readHostSchema } from "../src/host-cli/schema-guard.js";

// Issue #63: `tarobot start` for a desktop-managed host (no OS service, no
// separately selected runtime) starts it like the App does: the Hub upgrades
// an older database itself. It never switches the host to a standalone runtime.
const roots: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t63-cli-")); roots.push(directory);
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const notes = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(setup, "requireInitialized").mockResolvedValue(undefined as never);
  vi.spyOn(runtime, "resolveHostRuntime").mockResolvedValue({ entrypoint: "/app/host/dist/src/index.js", executable: process.execPath } as never);
  vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ deviceId: "cli_fixture", publicKey: "same-host", close: vi.fn() } as never);
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: false } as never);
  // Mirrors the real guard: only an explicit allowance may cross 25 -> 26.
  const compatible = vi.spyOn(guard, "assertHostRuntimeCompatible").mockImplementation(async (_directory, _entry, options = {}) => {
    if (!options.allowMigration) throw new Error("host_schema_migration_requires_update:25:26");
    return { schema: 25, minHubSchema: 1, maxHubSchema: 26, writeHubSchema: 26 };
  });
  return { directory, output, notes, compatible };
}
afterEach(async () => { vi.restoreAllMocks(); for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });
const startedHost = () => vi.spyOn(desktop, "desktopHost").mockImplementation(async action => (action === "status" ? { available: true, running: false } : { available: true, running: true, publicKey: "same-host" }) as never);

it("starts a desktop-managed host whose database needs an upgrade, through the shared desktop start", async () => {
  const f = await fixture();
  const switched = vi.spyOn(runtime, "activateHostUpdate"), staged = vi.spyOn(runtime, "stageHostUpdate");
  const host = startedHost();
  await runHostCli(["start", "--state-dir", f.directory]);
  expect(host.mock.calls.map(call => call[0])).toEqual(["status", "start"]);
  expect(f.compatible).toHaveBeenCalledWith(expect.any(String), "/app/host/dist/src/index.js", { allowMigration: true });
  expect(switched).not.toHaveBeenCalled(); expect(staged).not.toHaveBeenCalled();
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ running: true, cliController: { ready: true } });
});

it("keeps refusing an unsnapshotted upgrade on a host run by an OS service manager", async () => {
  const f = await fixture();
  vi.mocked(manager.managedServiceStatus).mockResolvedValue({ configured: true } as never);
  const host = startedHost();
  await expect(runHostCli(["start", "--state-dir", f.directory])).rejects.toThrow("host_schema_migration_requires_update:25:26");
  expect(host.mock.calls.map(call => call[0])).toEqual(["status"]);
});

it("explains a database from a newer version and exits non-zero without enrolling", async () => {
  const f = await fixture();
  vi.spyOn(desktop, "desktopHost").mockImplementation(async action => (action === "status" ? { available: true, running: false }
    : { available: true, running: false, hostEnabled: false, startIssue: { code: "schema_incompatible", schema: 27, minHubSchema: 1, maxHubSchema: 26 } }) as never);
  const failure = runHostCli(["start", "--state-dir", f.directory]);
  await expect(failure).rejects.toThrow("来自更新版本的 TaroBird");
  await expect(failure).rejects.toThrow("数据库未修改");
  expect(LocalHostClient.connect).not.toHaveBeenCalled();
  expect(f.output).not.toHaveBeenCalled();
});

it("a Hub that never became ready is explained with the command that shows why", async () => {
  const f = await fixture();
  vi.spyOn(desktop, "desktopHost").mockImplementation(async action => { if (action === "status") return { available: true, running: false } as never; throw new Error("Hub did not become ready. Inspect hub service logs."); });
  const failure = runHostCli(["start", "--state-dir", f.directory]);
  await expect(failure).rejects.toThrow("tarobot logs");
  await expect(failure).rejects.toThrow("端口被占用");
  expect(f.output).not.toHaveBeenCalled();
});

it("keeps foreground run refusing an unsnapshotted upgrade, pointing desktop users to the explicit start", async () => {
  const f = await fixture();
  const host = vi.spyOn(desktop, "desktopHost").mockResolvedValue({ available: true, running: false } as never);
  await expect(runHostCli(["run", "--state-dir", f.directory])).rejects.toThrow("host_schema_migration_requires_update:25:26");
  expect(host).not.toHaveBeenCalledWith("start", expect.anything(), expect.anything());
});

it("tells the user how to re-enable after stopping, without assuming a desktop App", async () => {
  const f = await fixture();
  vi.spyOn(desktop, "desktopHost").mockResolvedValue({ available: true, running: false, hostEnabled: false } as never);
  await runHostCli(["stop", "--force", "--state-dir", f.directory]);
  const note = f.notes.mock.calls.flat().join("\n");
  expect(note).toContain("不会重新启用"); expect(note).toContain("tarobot start"); expect(note).toContain("使用桌面 App 时");
  f.notes.mockClear();
  await runHostCli(["stop", "--force", "--state-dir", f.directory, "--json"]);
  expect(f.notes).not.toHaveBeenCalled();
});

it("end to end, unmocked: the built CLI starts a stopped host whose database is older, and the Hub upgrades it", async () => {
  vi.restoreAllMocks();
  const root = await mkdtemp(path.join(os.tmpdir(), "t63-e2e-")); roots.push(root);
  const directory = path.join(root, "host"), cli = (...args: string[]) => spawnSync(process.execPath, [path.resolve("dist/src/index.js"), ...args, "--state-dir", directory], { encoding: "utf8", timeout: 120_000 });
  try {
    expect(cli("init", "--name", "CLI Fixture", "--json").status).toBe(0);
    expect(cli("start", "--json").status).toBe(0);
    const stopped = cli("stop", "--force");
    expect(stopped.status).toBe(0); expect(stopped.stderr).toContain("tarobot start");
    const store = await HubStore.open(directory); await store.db.run("UPDATE meta SET value='26' WHERE key='schema_version'"); await store.db.close();
    // Foreground run still refuses; its guidance names the explicit start, not a runtime switch.
    const run = cli("run");
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("host_schema_migration_requires_update:26:28"); expect(run.stderr).toContain("启动本机主机"); expect(run.stderr).not.toContain("service install");
    expect(await readHostSchema(directory)).toBe(26);
    const started = cli("start", "--json");
    expect(started.status, started.stderr).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ running: true });
    expect(await readHostSchema(directory)).toBe(28);
    // The runtime selection is unchanged and nothing is written beside the host.
    await expect(stat(path.join(root, "host.runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { cli("stop", "--force", "--json"); }
}, 180_000);
