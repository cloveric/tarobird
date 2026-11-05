import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile, readdir, symlink, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initializeHost } from "../src/host-cli/setup.js";
import * as admission from "../src/host-cli/windows-state-admission.js";
import * as paths from "../src/host-cli/paths.js";
import * as serviceManager from "../src/host-cli/service-manager.js";
import { assertNoForeignControlPipe, hubServiceCommand } from "../src/hub/service.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { HubStore } from "../src/hub/store.js";
import { HubServer } from "../src/hub/server.js";
import { closeHubRuntime } from "../src/hub/shutdown.js";
import { runHubCli } from "../src/hub/cli.js";
import net from "node:net";
import { desktopHost } from "../src/hub/desktop.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of roots.splice(0)) { await desktopHost("stop", directory, path.resolve("dist/src/index.js")).catch(() => undefined); await rm(directory, { recursive: true, force: true }); } });
it("desktop start must not mint a replacement identity when an existing database loses its identity file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-directory-missing-")); roots.push(directory);
  await initializeHost(directory, "Existing host");
  await unlink(path.join(directory, "identity.json"));
  await expect(desktopHost("start", directory, path.resolve("dist/src/index.js"))).rejects.toThrow("host_directory_incomplete");
  await expect(readFile(path.join(directory, "identity.json"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("cold desktop resume and CLI reuse the same identity, database and running process after background stop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-cold-shared-")); roots.push(directory);
  const entry = path.resolve("dist/src/index.js");
  await initializeHost(directory, "Shared fixture");
  const identity = await readFile(path.join(directory, "identity.json"));
  const database = await stat(path.join(directory, "hub.sqlite"));
  const store = await HubStore.open(directory);
  try { await store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", ["directory-test", "retained"]); }
  finally { await store.db.close(); }
  const first = await desktopHost("start", directory, entry);
  expect(first.running).toBe(true);
  // Stop the background process without disabling the owner's desktop intent.
  await hubServiceCommand("stop", directory, entry);
  const resumed = await desktopHost("resume", directory, entry);
  if (!("publicKey" in first) || !("publicKey" in resumed)) throw new Error("missing identity");
  expect(resumed).toMatchObject({ running: true, publicKey: first.publicKey });
  expect(await desktopHost("resume", directory, entry)).toEqual(resumed);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await runHostCli(["status", "--state-dir", directory, "--json"]);
  const cli = JSON.parse(String(output.mock.calls.at(-1)?.[0])); output.mockRestore();
  expect(cli.service).toMatchObject({ running: true, pid: resumed.pid, publicKey: first.publicKey });
  expect(await readFile(path.join(directory, "identity.json"))).toEqual(identity);
  const after = await stat(path.join(directory, "hub.sqlite")); expect([after.ino, after.dev]).toEqual([database.ino, database.dev]);
  const restored = await HubStore.open(directory);
  try { expect(await restored.db.get("SELECT value FROM meta WHERE key=?", ["directory-test"])).toEqual({ value: "retained" }); }
  finally { await restored.db.close(); }
}, 30_000);

async function layout() {
  // Leave space for the simulated Roaming path and macOS control socket.
  const root = await mkdtemp(path.join(os.tmpdir(), "wv-")); roots.push(root);
  const roaming = path.join(root, "Roaming"), local = path.join(root, "Local"), directory = path.join(roaming, "com.tarocub.client", "host");
  const shadow = path.join(local, "Packages", "Example.AnyPackage_abc", "LocalCache", "Roaming", "com.tarocub.client", "host");
  const probe: admission.WindowsStateProbe = { protocol: "TAROBOT_WINDOWS_STATE_PROBE_V1", version: 1, packageFamily: null, helperPackageFamily: null, roaming, local, profile: root, requestedDirectory: directory, directory, identity: null, database: null, config: null };
  const state = async (where: string, marker = "original") => { await mkdir(where, { recursive: true }); await writeFile(path.join(where, "identity.json"), marker); await writeFile(path.join(where, "hub.sqlite"), marker); };
  return { root, directory, shadow, probe, state };
}
it("ordinary desktop and CLI views select the same physical state without writing", async () => {
  const f = await layout(); await f.state(f.directory);
  const before = await readdir(f.directory);
  expect(await admission.admitWindowsDirectory(undefined, async () => f.probe)).toBe(f.directory);
  expect(await admission.admitWindowsDirectory(f.directory, async () => f.probe)).toBe(f.directory);
  expect(await readdir(f.directory)).toEqual(before);
});
it("initialization holds its directory admission until all identity and database writes settle", async () => {
  const f = await layout();
  let completedState: string | undefined;
  const release = vi.fn(async () => { completedState = await admission.hostDirectoryState(f.directory); });
  vi.spyOn(admission, "acquireHostAdmission").mockResolvedValue(release);
  await initializeHost(f.directory, "Lease lifetime");
  expect(release).toHaveBeenCalledOnce();
  expect(completedState).toBe("ready");
});
it("Windows Known Folder selection still refuses to silently abandon an older headless identity", async () => {
  const f = await layout();
  const legacy = path.join(f.root, ".cctb", "hub");
  await f.state(legacy);
  vi.spyOn(admission, "admitWindowsDirectory").mockResolvedValue(f.directory);
  const { resolveHostDirectory } = await import("../src/host-cli/paths.js");
  await expect(resolveHostDirectory(undefined, { platform: "win32", home: f.root, env: {} })).rejects.toThrow("发现旧版主机");
  expect(await resolveHostDirectory(f.directory, { platform: "win32", home: f.root, env: {} })).toBe(f.directory);
});
it("packaged callers are rejected even when handle paths report the nominal location", async () => {
  const f = await layout(); await f.state(f.shadow);
  await expect(admission.admitWindowsDirectory(f.directory, async () => ({ ...f.probe, packageFamily: "Any.StoreApp_xyz" }))).rejects.toThrow("host_directory_redirected");
  await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(f.shadow, "identity.json"), "utf8")).toBe("original");
});
it("shadow-only data blocks creating a desktop identity; renamed backups are ignored", async () => {
  const f = await layout(); await f.state(f.shadow);
  await expect(admission.admitWindowsDirectory(f.directory, async () => f.probe)).rejects.toThrow("host_directory_shadow_only");
  const { rename } = await import("node:fs/promises"); await rename(f.shadow, f.shadow + ".backup");
  expect(await admission.admitWindowsDirectory(f.directory, async () => f.probe)).toBe(f.directory);
  await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("workspace-only shadow files do not block a verified real host, but cannot authorize a fresh identity", async () => {
  const f = await layout(); await mkdir(path.join(f.shadow, "bots", "one", "workspace"), { recursive: true });
  await writeFile(path.join(f.shadow, "bots", "one", "workspace", "note.txt"), "engine output");
  await expect(admission.admitWindowsDirectory(f.directory, async () => f.probe)).rejects.toThrow("host_directory_shadow_only");
  await f.state(f.directory);
  expect(await admission.admitWindowsDirectory(f.directory, async () => f.probe)).toBe(f.directory);
  expect(await admission.inspectWindowsDirectory(f.directory, async () => f.probe)).toMatchObject({ state: "ready", shadowWorkspaces: [f.shadow], shadows: [] });
});
it.each(["conflict", "shadow_only"] as const)("%s still permits verified lifecycle-down commands", async issue => {
  const f = await layout(); await initializeHost(f.directory, "Recovery fixture");
  const entry = path.resolve("dist/src/index.js");
  const guard = vi.spyOn(admission, "guardHostDirectory").mockImplementation(async (_dir, inspection) => { if (!inspection) throw new admission.HostDirectoryError(issue); });
  const resolve = vi.spyOn(paths, "resolveHostDirectory").mockImplementation(async (_dir, options) => { if (!options?.inspection) throw new admission.HostDirectoryError(issue); return f.directory; });
  const uninstall = vi.spyOn(serviceManager, "uninstallManagedService").mockResolvedValue({ configured: false } as any);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await runHostCli(["stop", "--state-dir", f.directory, "--json"]);
  await runHostCli(["service", "uninstall", "--state-dir", f.directory, "--json", "--yes"]);
  await runHubCli(["service", "installer-stop", "--state-dir", f.directory]);
  expect(resolve.mock.calls.every(([, options]) => options?.inspection)).toBe(true);
  expect(guard).toHaveBeenCalledWith(f.directory, true); expect(uninstall).toHaveBeenCalledOnce();
  await expect(desktopHost("start", f.directory, entry)).rejects.toThrow(`host_directory_${issue}`);
});
it("temporary probe failure retries under supervisor policy while definitive conflicts stop", () => {
  expect(new admission.HostDirectoryError("probe_failed").exitCode).toBe(1);
  expect(new admission.HostDirectoryError("conflict").exitCode).toBe(78);
});
it("idempotent init reads an existing initialized host without competing for its writer lease", async () => {
  const f = await layout(); const first = await initializeHost(f.directory, "Existing");
  const acquire = vi.spyOn(admission, "acquireHostAdmission").mockRejectedValue(new admission.HostDirectoryError("foreign_runtime"));
  expect(await initializeHost(f.directory, "Existing")).toMatchObject({ created: false, publicKey: first.publicKey });
  expect(acquire).not.toHaveBeenCalled();
  await expect(initializeHost(f.directory, "Different")).rejects.toThrow("已经叫");
});
it.each(["original", "different"])("two active directories with %s identity never auto-select or merge", async marker => {
  const f = await layout(); await f.state(f.directory); await f.state(f.shadow, marker);
  await expect(admission.admitWindowsDirectory(f.directory, async () => f.probe)).rejects.toThrow("host_directory_conflict");
  expect(await readFile(path.join(f.shadow, "identity.json"), "utf8")).toBe(marker);
  expect(await readFile(path.join(f.directory, "identity.json"), "utf8")).toBe("original");
});
it("detects split SQLite sidecars and refuses redirected core files", async () => {
  const f = await layout(); await f.state(f.directory); await mkdir(f.shadow, { recursive: true }); await writeFile(path.join(f.shadow, "hub.sqlite-wal"), "uncheckpointed");
  await expect(admission.admitWindowsDirectory(f.directory, async () => f.probe)).rejects.toThrow("host_directory_conflict");
  expect(() => admission.validateWindowsProbe({ ...f.probe, database: path.join(f.shadow, "hub.sqlite") })).toThrow("host_directory_redirected");
});
it("bounded scan and junction-like candidates fail closed", async () => {
  const f = await layout(); await f.state(f.shadow);
  await expect(admission.findShadowHosts(path.join(f.probe.local, "Packages"), "com.tarocub.client/host", "Roaming", { packages: 0, milliseconds: 1000 })).rejects.toThrow("host_directory_probe_failed");
  await rm(f.shadow, { recursive: true }); await mkdir(f.directory, { recursive: true }); await symlink(f.directory, f.shadow, "junction");
  await expect(admission.admitWindowsDirectory(f.directory, async () => f.probe)).rejects.toThrow("host_directory_probe_failed");
});
it("guard failures reach desktop status without opening SQLite and stop init before mkdir", async () => {
  const f = await layout(); vi.spyOn(admission, "guardHostDirectory").mockRejectedValue(new admission.HostDirectoryError("redirected"));
  expect(await desktopHost("resume", f.directory, "unused")).toMatchObject({ running: false, directoryState: "redirected" });
  await expect(initializeHost(f.directory, "New")).rejects.toThrow("host_directory_redirected");
  await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("hub run never creates an identity or database from an empty directory", async () => {
  const f = await layout(); await expect(runHubCli(["run", "--state-dir", f.directory])).rejects.toThrow("尚未初始化");
  await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("kernel admission lease rejects another owner and releases cleanly", async () => {
  const f = await layout();
  const address = process.platform === "win32" ? admission.hostAdmissionPipe("identity", f.root) : path.join(f.root, "admit.sock");
  const release = await admission.acquireAdmissionPipe(address);
  await expect(admission.acquireAdmissionPipe(address)).rejects.toThrow("host_directory_foreign_runtime");
  await release(); const next = await admission.acquireAdmissionPipe(address); await next();
});
it("an unconfirmed runtime shutdown retains its kernel lease until confirmed closure or exit", async () => {
  const f = await layout(), address = process.platform === "win32" ? admission.hostAdmissionPipe("directory", f.root) : path.join(f.root, "shutdown.sock");
  const release = await admission.acquireAdmissionPipe(address);
  try {
    await expect(closeHubRuntime({ hub: { beginShutdown() {}, close: async () => {}, shutdownComplete: false }, releaseLock: release })).rejects.toThrow("hub_shutdown_unconfirmed");
    await expect(admission.acquireAdmissionPipe(address)).rejects.toThrow("host_directory_foreign_runtime");
    await closeHubRuntime({ hub: { beginShutdown() {}, close: async () => {}, shutdownComplete: true }, releaseLock: release });
    const next = await admission.acquireAdmissionPipe(address); await next();
  } finally { await release(); }
});
it("a duplicate identity is rejected before opening or migrating its copied database", async () => {
  const f = await layout();
  vi.spyOn(admission, "acquireExistingHostIdentityAdmission").mockRejectedValue(new admission.HostDirectoryError("foreign_runtime"));
  const openStore = vi.spyOn(HubStore, "open");
  await expect(HubServer.start({ stateDir: f.directory, port: 0 })).rejects.toThrow("host_directory_foreign_runtime");
  expect(openStore).not.toHaveBeenCalled();
});
it("a database-open failure releases a previously acquired identity lease", async () => {
  const f = await layout(), release = vi.fn(async () => {});
  vi.spyOn(admission, "acquireExistingHostIdentityAdmission").mockResolvedValue({ publicKey: "fixture", release });
  vi.spyOn(HubStore, "open").mockRejectedValue(new Error("database unavailable"));
  await expect(HubServer.start({ stateDir: f.directory, port: 0 })).rejects.toThrow("database unavailable");
  expect(release).toHaveBeenCalledOnce();
});
it("a connected control pipe with no local token is a foreign runtime, never stopped", async () => {
  const f = await layout(); const address = process.platform === "win32" ? admission.hostAdmissionPipe("directory", f.root) : path.join(f.root, "control.sock");
  let requests = 0; const server = net.createServer(socket => { socket.on("data", () => requests++); socket.on("end", () => socket.end()); });
  await new Promise<void>(resolve => server.listen(address, resolve));
  try { await expect(assertNoForeignControlPipe(address)).rejects.toThrow("host_directory_foreign_runtime"); expect(requests).toBe(0); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  await assertNoForeignControlPipe(address);
});
it.runIf(process.platform === "win32")("native Windows probe returns the unpackaged caller and physical Known Folders", async () => {
  const probe = await admission.probeWindowsState(); expect(probe.packageFamily).toBeNull(); expect(probe.helperPackageFamily).toBeNull();
  const legacy = path.join(probe.roaming, "com.tarocub.client", "host");
  const legacyExists = await stat(legacy).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  expect(admission.windowsPathKey(probe.requestedDirectory)).toBe(admission.windowsPathKey(legacyExists ? legacy : path.join(probe.roaming, "com.tarobot.client", "host")));
});

it("new application identity still detects a host virtualized under the legacy package", async () => {
  const f = await layout();
  const current = path.join(f.probe.roaming, "com.tarobot.client", "host");
  const observation = { ...f.probe, directory: current, requestedDirectory: current };
  await f.state(f.shadow);
  const report = await admission.inspectWindowsDirectory(undefined, async () => observation);
  expect(report.state).toBe("shadow_only"); expect(report.shadows).toContain(f.shadow);
  await expect(admission.admitWindowsDirectory(undefined, async () => observation)).rejects.toMatchObject({ issue: "shadow_only" });
  await expect(stat(current)).rejects.toMatchObject({ code: "ENOENT" });
  await f.state(current);
  expect((await admission.inspectWindowsDirectory(undefined, async () => observation)).state).toBe("conflict");
});
