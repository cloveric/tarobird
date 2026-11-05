import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { assertHostSupervisor, assertManagedServiceRuntimeCompatible, assertNoManagedServiceRegistration, assertWindowsHostLauncher, enableManagedServiceOnLogin, installManagedService, managedServiceEnvironmentDifferences, managedServiceCommand, managedServiceStatus, quoteWindowsServiceArgument, reassertManagedServiceIntent, refreshManagedServiceRuntime, uninstallManagedService, type ManagedServiceOptions, type ServiceCommandRunner } from "../src/host-cli/service-manager.js";
import { buildHostEnvironment } from "../src/host-cli/environment.js";
import { acquireInstanceLock } from "../src/state/instance-lock.js";
import { hubServiceCommand } from "../src/hub/service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function packageFixture(root: string) {
  const entrypoint = path.join(root, "dist/src/index.js"), launcher = path.join(root, "bin/tarobot-host-launcher.exe");
  await mkdir(path.dirname(entrypoint), { recursive: true }); await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(entrypoint, "export {};\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ tarobotHostCapabilities: ["service-extra-environment-v1"] }));
  // Native execution is covered separately; this is an OS-manager contract fixture.
  const bytes = Buffer.alloc(512); bytes.writeUInt32LE(128, 60); bytes.write("PE\0\0", 128); bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(0x20b, 152); bytes.writeUInt16LE(2, 220);
  await writeFile(launcher, bytes); return entrypoint;
}
async function fixture(platform: "darwin" | "linux" | "win32") {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-service-")); roots.push(root);
  const directory = path.join(root, "host"), home = path.join(root, "user"), entrypoint = await packageFixture(path.join(root, "package"));
  await mkdir(directory); await mkdir(home);
  let registered = false, enabled = false, running = false, fail: string | undefined;
  const calls: { executable: string; args: string[] }[] = [];
  const runner: ServiceCommandRunner = async (executable, args) => {
    calls.push({ executable, args });
    if (fail && args.includes(fail)) return { code: 7, stdout: "", stderr: "fixture error" };
    let stdout = "", stderr = "", code = 0;
    if (executable === "powershell.exe") return { code: 0, stdout: JSON.stringify({ registered, enabled, supervisorRunning: registered && running }), stderr: "" };
    if (platform === "darwin") {
      if (args[0] === "print") { code = registered ? 0 : 113; stderr = registered ? "" : "Could not find service"; stdout = registered && running ? " pid = 987654\n" : ""; }
      if (args[0] === "print-disabled") { const manifest = await readFile(path.join(directory, "host-service.json"), "utf8").then(value => JSON.parse(value), () => null); stdout = manifest ? `disabled services = {\n"${manifest.label}" => ${!enabled}\n}` : "disabled services = {}"; }
      if (args[0] === "enable") enabled = true;
      if (args[0] === "disable") enabled = false;
      if (args[0] === "bootstrap") { registered = true; running = true; }
      if (args[0] === "kickstart") running = true;
      if (args[0] === "bootout") { registered = false; running = false; }
    } else if (platform === "linux") {
      if (args[1] === "show") stdout = `LoadState=${registered ? "loaded" : "not-found"}\nUnitFileState=${enabled ? "enabled" : "disabled"}\nMainPID=${registered && running ? 987654 : 0}\n`;
      if (args[1] === "daemon-reload") registered = await import("node:fs/promises").then(fs => fs.readdir(path.join(home, ".config/systemd/user"))).then(entries => entries.some(name => name.endsWith(".service")), () => false);
      if (args[1] === "enable") enabled = true;
      if (args[1] === "disable") enabled = false;
      if (args[1] === "start") running = true;
      if (args[1] === "stop") running = false;
    } else {
      if (args[0] === "/Query") { code = registered ? 0 : 1; stdout = registered ? `<Settings><Enabled>${enabled}</Enabled></Settings>` : ""; }
      if (args[0] === "/Create") { registered = true; enabled = false; }
      if (args.includes("/Enable")) enabled = true;
      if (args.includes("/Disable")) enabled = false;
      if (args[0] === "/Run") running = true;
      if (args[0] === "/End") running = false;
      if (args[0] === "/Delete") registered = false;
    }
    return { code, stdout, stderr };
  };
  const options: ManagedServiceOptions = { platform, home, uid: 501, windowsUserSid: "S-1-5-21-123-456-789-1001", runner, executable: process.execPath, timeoutMs: 30, processAlive: () => false,
    resolveRuntime: async () => ({ entrypoint, executable: process.execPath, revisionId: "fixture-revision" }),
    env: { PATH: "/usr/bin:/a dir/$custom/%bin", HOME: "/wrong-user", ANTHROPIC_API_KEY: "never-save-me", NODE_OPTIONS: "never-save-me" },
    inspect: async (_directory, action) => {
      if (action === "stop") { calls.push({ executable: "hub-control", args: ["stop"] }); running = false; }
      const supervisor = registered ? await readFile(path.join(directory, "host-service.json"), "utf8").then(text => JSON.parse(text).label as string, () => undefined) : undefined;
      return running ? { running: true, pid: 987654, url: "https://localhost:8788", publicKey: "fixture", supervisor } : { running: false };
    },
  };
  return { root, directory, home, entrypoint, calls, options, setRunning: (value: boolean) => { running = value; }, setFailure: (value?: string) => { fail = value; }, setRegistered: (value: boolean) => { registered = value; } };
}
it.each(["darwin", "linux", "win32"] as const)("installs %s login supervision without starting Hub and retains host data when uninstalled", async platform => {
  const f = await fixture(platform);
  await writeFile(path.join(f.directory, "identity.json"), "fixture identity");
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ configured: false, registered: false, running: false });
  const installed = await installManagedService(f.directory, f.entrypoint, f.options);
  expect(installed).toMatchObject({ configured: true, registered: platform !== "darwin", enabled: true, running: false });
  const manifest = await readFile(path.join(f.directory, "host-service.json"), "utf8");
  expect(manifest).not.toContain("never-save-me"); expect(manifest).not.toContain("/wrong-user");
  expect(await managedServiceCommand("start", f.directory, "/do-not-use-caller-runtime", f.options)).toMatchObject({ configured: true, registered: true, enabled: true, running: true, entrypoint: f.entrypoint });
  expect(await managedServiceCommand("stop", f.directory, undefined, f.options)).toMatchObject({ configured: true, enabled: false, running: false });
  expect(await managedServiceCommand("start", f.directory, undefined, f.options)).toMatchObject({ running: true, enabled: true });
  expect(await uninstallManagedService(f.directory, f.options)).toMatchObject({ configured: false, running: false });
  expect(await readFile(path.join(f.directory, "identity.json"), "utf8")).toBe("fixture identity");
  expect(f.calls.some(call => call.executable === "sudo")).toBe(false);
});
it.each(["darwin", "linux", "win32"] as const)("refuses to take over a running unmanaged host on %s", async platform => {
  const f = await fixture(platform); f.setRunning(true);
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_handoff_required");
  expect(f.calls).toEqual([]);
  await expect(readFile(path.join(f.directory, "host-service.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["darwin", "linux", "win32"] as const)("reasserts %s login intent without starting an already owned healthy Hub", async platform => {
  const f = await fixture(platform); await installManagedService(f.directory, f.entrypoint, f.options);
  await managedServiceCommand("start", f.directory, undefined, f.options);
  const file = path.join(f.directory, "host-service.json"), manifest = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...manifest, enabled: false })); await writeFile(path.join(f.directory, "desktop-enabled.json"), "false");
  f.calls.length = 0;
  expect(await reassertManagedServiceIntent(f.directory, f.options)).toMatchObject({ enabled: true, running: true });
  expect(f.calls.some(call => call.args.some(arg => ["start", "bootstrap", "kickstart", "/Run"].includes(arg)))).toBe(false);
  expect(JSON.parse(await readFile(file, "utf8")).enabled).toBe(true);
  const original = f.options.inspect!; f.options.inspect = async (...args) => ({ ...await original(...args), running: true, pid: 123, publicKey: "unowned", url: "http://localhost", supervisor: "unowned" });
  await expect(reassertManagedServiceIntent(f.directory, f.options)).rejects.toThrow("handoff_required");
});
it("disarms the Windows task before asking the Hub to stop", async () => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options); f.calls.length = 0;
  await managedServiceCommand("stop", f.directory, undefined, f.options);
  expect(f.calls.findIndex(call => call.args.includes("/Disable"))).toBeLessThan(f.calls.findIndex(call => call.executable === "hub-control"));
  expect(f.calls.some(call => call.args.includes("/End"))).toBe(false);
});
it.each(["darwin", "linux", "win32"] as const)("commits a drained %s stop after disabling persisted intent and before OS termination", async platform => {
  const f = await fixture(platform); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options); f.calls.length = 0;
  const original = f.options.inspect!, guard = { drainId: "guard_owner", pid: 987654, publicKey: "fixture" };
  f.options.drainedStop = guard;
  f.options.inspect = async (directory, command, received) => {
    if (command !== "drained-stop") return original(directory, command);
    expect(received).toEqual(guard);
    expect(JSON.parse(await readFile(path.join(directory, "host-service.json"), "utf8")).enabled).toBe(false);
    expect((await readFile(path.join(directory, "desktop-enabled.json"), "utf8")).trim()).toBe(platform === "win32" ? "true" : "false");
    expect(f.calls.filter(call => call.executable !== "powershell.exe" && !call.args.includes("/Disable"))).toHaveLength(0);
    f.calls.push({ executable: "atomic-drained-stop", args: [] });
    const status = await original(directory);
    if (!status.running) throw new Error("fixture unexpectedly stopped");
    f.setRunning(false);
    return { ...status, controlCapabilities: ["drained-stop"] };
  };
  expect(await managedServiceCommand("stop", f.directory, undefined, f.options)).toMatchObject({ running: false, enabled: false });
  expect(f.calls.find(call => call.executable !== "powershell.exe" && !call.args.includes("/Disable"))?.executable).toBe("atomic-drained-stop");
});
it("does not send any OS termination when the lease expired; restores intent only on definite rejection", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options); f.calls.length = 0;
  const original = f.options.inspect!; f.options.drainedStop = { drainId: "old_owner", pid: 987654, publicKey: "fixture" };
  f.options.inspect = async (directory, command) => {
    const status = await original(directory);
    return command === "drained-stop" && status.running ? { ...status, controlError: "host_drain_lease_expired" } : status;
  };
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("host_drain_lease_expired");
  expect(f.calls).toEqual([]); expect(await original(f.directory)).toMatchObject({ running: true });
  expect(JSON.parse(await readFile(path.join(f.directory, "host-service.json"), "utf8")).enabled).toBe(true);
  f.options.inspect = async (_directory, command) => { if (command === "drained-stop") throw new Error("reply_lost"); return original(f.directory); };
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("reply_lost");
  expect(f.calls).toEqual([]); expect(JSON.parse(await readFile(path.join(f.directory, "host-service.json"), "utf8")).enabled).toBe(false);
});
it.each(["darwin", "linux", "win32"] as const)("refuses a safe %s stop when another Hub is starting before opening its control channel", async platform => {
  const f = await fixture(platform); await installManagedService(f.directory, f.entrypoint, f.options); f.calls.length = 0;
  const startup = await acquireInstanceLock(f.directory);
  try {
    await expect(managedServiceCommand("stop", f.directory, undefined, { ...f.options, requireDrained: true })).rejects.toThrow("host_safe_stop_starting_or_unconfirmed");
    await expect(uninstallManagedService(f.directory, { ...f.options, requireDrained: true })).rejects.toThrow("host_safe_stop_starting_or_unconfirmed");
    expect(f.calls.filter(call => call.executable !== "powershell.exe" && !call.args.includes("/Disable") && !call.args.includes("/Enable"))).toEqual([]);
    expect(JSON.parse(await readFile(path.join(f.directory, "host-service.json"), "utf8")).enabled).toBe(true);
  } finally { await startup.release(); }
});
it("holds the real offline lock across OS disarming so a concurrent startup cannot enter", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options);
  const original = f.options.runner!; let probed = false;
  f.options.runner = async (executable, args) => {
    if (args[0] === "disable") {
      probed = true;
      await expect(acquireInstanceLock(f.directory)).rejects.toThrow("Instance lock already held");
    }
    return original(executable, args);
  };
  await managedServiceCommand("stop", f.directory, undefined, { ...f.options, requireDrained: true });
  expect(probed).toBe(true); const next = await acquireInstanceLock(f.directory); await next.release();
});
it("also refuses an unmanaged safe stop while startup owns the lock but has no control socket", async () => {
  const f = await fixture("darwin"), startup = await acquireInstanceLock(f.directory);
  try { await expect(hubServiceCommand("stop", f.directory, f.entrypoint, { requireDrained: true })).rejects.toThrow("host_safe_stop_starting_or_unconfirmed"); }
  finally { await startup.release(); }
  expect(await hubServiceCommand("stop", f.directory, f.entrypoint, { requireDrained: true })).toEqual({ running: false });
  const next = await acquireInstanceLock(f.directory); await next.release();
});
it("uses a frozen native GUI launcher with a private exact-owner configuration", async () => {
  const f = await fixture("win32"), installed = await installManagedService(f.directory, f.entrypoint, f.options);
  const config = JSON.parse(await readFile(path.join(f.directory, "host-service/launcher.json"), "utf8"));
  expect(config).toMatchObject({ version: 1, executable: process.execPath, entrypoint: f.entrypoint, directory: await realpath(f.directory), home: f.home, supervisor: installed.label });
  expect(config.control_pipe).toMatch(/^\\\\\.\\pipe\\tarobot-hub-/);
  expect(config.environment).toMatchObject({ HOME: f.home, TAROBOT_HOST_SUPERVISOR: installed.label });
  expect(config.environment.NODE_OPTIONS).toBeUndefined();
  const task = await readFile(path.join(f.directory, "host-service/task.xml"), "utf8");
  expect(task).toContain("bin/tarobot-host-launcher.exe</Command>"); expect(task).toContain("--config");
  expect(task).not.toContain("RestartOnFailure"); expect(task).not.toContain("wscript");
});
it("refuses Windows console or missing launchers without registering an OS job", async () => {
  const f = await fixture("win32"), launcher = path.join(f.root, "package/bin/tarobot-host-launcher.exe");
  const bytes = await readFile(launcher); bytes.writeUInt16LE(3, 220); await writeFile(launcher, bytes);
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_windows_launcher_invalid");
  await rm(launcher);
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_windows_launcher_missing");
  expect(f.calls.some(call => call.args.includes("/Create"))).toBe(false);
});
it("checks a Windows source launcher without creating state or consulting the OS manager", async () => {
  const f = await fixture("win32");
  await expect(assertWindowsHostLauncher(f.entrypoint)).resolves.toBeUndefined();
  await rm(path.join(f.root, "package/bin/tarobot-host-launcher.exe"));
  await expect(assertWindowsHostLauncher(f.entrypoint)).rejects.toThrow("host_service_windows_launcher_missing");
  await expect(stat(path.join(f.directory, "host-service.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.calls).toEqual([]);
});
it("installs Windows services with empty PATHEXT segments while still rejecting unsafe extensions", async () => {
  const f = await fixture("win32"); f.options.env = { PATHEXT: ";.COM;;.EXE;" };
  await installManagedService(f.directory, f.entrypoint, f.options);
  expect(JSON.parse(await readFile(path.join(f.directory, "host-service.json"), "utf8")).environment.PATHEXT).toBe(".COM;.EXE");
  expect(buildHostEnvironment({ platform: "win32", env: { PATHEXT: ";;" } }).PATHEXT).toBeUndefined();
  expect(() => buildHostEnvironment({ platform: "win32", env: { PATHEXT: ".EXE;invalid;" } })).toThrow("host_service_invalid_pathext");
});
it("does not silently discard ownership after OS registration failure", async () => {
  const f = await fixture("linux"); f.setFailure("enable");
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("fixture error");
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ configured: true, enabled: false, running: false });
  f.setFailure();
  expect(await managedServiceCommand("start", f.directory, undefined, f.options)).toMatchObject({ running: true });
});
it("does not claim success if the supervised process never opens its control endpoint", async () => {
  const f = await fixture("darwin"); f.options.inspect = async () => ({ running: false });
  await installManagedService(f.directory, f.entrypoint, f.options);
  await expect(managedServiceCommand("start", f.directory, undefined, f.options)).rejects.toThrow("host_service_start_timed_out");
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ configured: true, registered: true, running: false });
});
it("refuses another user's ownership receipt and a different platform", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options);
  await expect(managedServiceStatus(f.directory, { ...f.options, uid: 502 })).rejects.toThrow("host_service_user_mismatch");
  await expect(managedServiceStatus(f.directory, { ...f.options, home: path.join(f.root, "another") })).rejects.toThrow("host_service_owner_mismatch");
  await expect(managedServiceStatus(f.directory, { ...f.options, platform: "linux" })).rejects.toThrow("host_service_owner_mismatch");
});
it("does not execute an edited service artifact or overwrite an unowned artifact", async () => {
  const f = await fixture("darwin"); const installed = await installManagedService(f.directory, f.entrypoint, f.options);
  const file = path.join(f.home, "Library/LaunchAgents", `${installed.label}.plist`);
  await writeFile(file, "modified"); f.calls.length = 0;
  await expect(managedServiceCommand("start", f.directory, undefined, f.options)).rejects.toThrow("host_service_artifact_changed"); expect(f.calls).toEqual([]);
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_artifact_conflict"); expect(await readFile(file, "utf8")).toBe("modified");
  await expect(uninstallManagedService(f.directory, f.options)).rejects.toThrow("restore the original service definition");
  expect(await readFile(file, "utf8")).toBe("modified");
});
it.each(["darwin", "linux", "win32"] as const)("manages a %s definition using its recorded template bytes across CLI template changes", async platform => {
  const f = await fixture(platform), installed = await installManagedService(f.directory, f.entrypoint, f.options);
  const receipt = path.join(f.directory, "host-service.json");
  const definition = platform === "darwin" ? path.join(f.home, "Library/LaunchAgents", `${installed.label}.plist`) : platform === "linux" ? path.join(f.home, ".config/systemd/user", `${installed.label}.service`) : path.join(f.directory, "host-service/task.xml");
  const simulatePriorTemplate = async () => {
    const manifest = JSON.parse(await readFile(receipt, "utf8"));
    expect(manifest.artifactTemplateVersion).toBe(1);
    const previousTemplate = (await readFile(definition, "utf8")) + (platform === "linux" ? "# previously installed template\n" : "<!-- previously installed template -->\n");
    await writeFile(definition, previousTemplate);
    manifest.artifactHash = createHash("sha256").update(previousTemplate).digest("hex");
    if (platform === "win32") {
      const file = path.join(f.directory, "host-service/launcher.json");
      const previousRuntime = JSON.stringify(JSON.parse(await readFile(file, "utf8")), null, 4) + "\n";
      await writeFile(file, previousRuntime); manifest.runtimeHash = createHash("sha256").update(previousRuntime).digest("hex");
    }
    await writeFile(receipt, JSON.stringify(manifest));
  };
  await simulatePriorTemplate();
  expect(await managedServiceCommand("start", f.directory, undefined, f.options)).toMatchObject({ running: true });
  await managedServiceCommand("stop", f.directory, undefined, f.options);
  const entrypoint = await packageFixture(path.join(f.root, "next"));
  f.options.resolveRuntime = async () => ({ entrypoint, executable: process.execPath, revisionId: "next-revision" });
  await refreshManagedServiceRuntime(f.directory, { entrypoint, executable: process.execPath }, f.options);
  expect(JSON.parse(await readFile(receipt, "utf8")).artifactHash).toBe(createHash("sha256").update(await readFile(definition, "utf8")).digest("hex"));
  await simulatePriorTemplate();
  await installManagedService(f.directory, entrypoint, f.options);
  await simulatePriorTemplate();
  expect(await uninstallManagedService(f.directory, f.options)).toMatchObject({ configured: false });
});
it("keeps hashless legacy receipts compatible and refuses edits without stored provenance", async () => {
  const f = await fixture("darwin"), installed = await installManagedService(f.directory, f.entrypoint, f.options);
  const receipt = path.join(f.directory, "host-service.json"), manifest = JSON.parse(await readFile(receipt, "utf8"));
  delete manifest.artifactHash; delete manifest.artifactTemplateVersion;
  await writeFile(receipt, JSON.stringify(manifest));
  expect(await managedServiceCommand("start", f.directory, undefined, f.options)).toMatchObject({ running: true });
  await managedServiceCommand("stop", f.directory, undefined, f.options);
  const definition = path.join(f.home, "Library/LaunchAgents", `${installed.label}.plist`);
  await writeFile(definition, (await readFile(definition, "utf8")) + "<!-- unknown edit -->\n");
  await expect(uninstallManagedService(f.directory, f.options)).rejects.toThrow("host_service_artifact_changed");
});
it("rejects a symlink receipt rather than following it", async () => {
  const f = await fixture("darwin"), external = path.join(f.root, "external.json"); await writeFile(external, "null"); await symlink(external, path.join(f.directory, "host-service.json"));
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_unsafe_file"); expect(await readFile(external, "utf8")).toBe("null");
});
it("recognizes a host that still owns the lock while its control endpoint is unavailable", async () => {
  const f = await fixture("linux"), lock = await acquireInstanceLock(f.directory);
  try { await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_handoff_required"); expect(f.calls).toEqual([]); }
  finally { await lock.release(); }
});
it("holds host ownership through service installation so a foreground startup cannot race it", async () => {
  const f = await fixture("darwin"), original = f.options.runner!; let probed = false;
  f.options.runner = async (executable, args) => {
    if (args[0] === "enable") {
      probed = true;
      await expect(acquireInstanceLock(f.directory)).rejects.toThrow("Instance lock already held");
    }
    return original(executable, args);
  };
  await installManagedService(f.directory, f.entrypoint, f.options);
  expect(probed).toBe(true); const next = await acquireInstanceLock(f.directory); await next.release();
});
it.skipIf(process.platform === "win32")("recovers a previous-boot instance lock when installing a service", async () => {
  const f = await fixture("darwin"), lock = await acquireInstanceLock(f.directory);
  const file = path.join(f.directory, "instance.lock.json"), record = JSON.parse(await readFile(file, "utf8"));
  await lock.release();
  expect(record.bootId).toBeTruthy();
  await writeFile(file, JSON.stringify({ ...record, bootId: `${process.platform}:00000000-0000-0000-0000-000000000000` }));
  f.options.processAlive = () => true;
  expect(await installManagedService(f.directory, f.entrypoint, f.options)).toMatchObject({ configured: true, running: false });
});
it("can uninstall a stopped service whose old runtime has been removed", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options); await rm(f.entrypoint);
  expect(await uninstallManagedService(f.directory, f.options)).toMatchObject({ configured: false });
});
it("does not report Windows shutdown complete while its original process is still exiting", async () => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options); f.options.processAlive = () => true;
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("host_service_stop_timed_out");
  expect(f.calls.some(call => call.args.includes("/End"))).toBe(false);
});
it("refuses to start an OS job over a separately running host even when a manifest exists", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options); f.setRunning(true); f.calls.length = 0;
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ configured: true, running: true, supervisorRunning: false, error: expect.stringContaining("outside") });
  await expect(managedServiceCommand("start", f.directory, undefined, f.options)).rejects.toThrow("host_service_handoff_required");
  expect(f.calls.some(call => call.args.includes("bootstrap"))).toBe(false);
});
it("keeps POSIX manifests and artifacts private and shares ownership through state-directory aliases", async () => {
  const f = await fixture("darwin"), alias = path.join(f.root, "alias"); await symlink(f.directory, alias); const installed = await installManagedService(alias, f.entrypoint, f.options);
  expect(installed.directory).toBe(await import("node:fs/promises").then(fs => fs.realpath(f.directory)));
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ configured: true, label: installed.label });
  expect((await stat(path.join(f.directory, "host-service.json"))).mode & 0o777).toBe(0o600);
});
it("escapes XML, systemd percent/dollar expansion and Windows trailing backslashes", async () => {
  const f = await fixture("linux"); const installed = await installManagedService(f.directory, f.entrypoint, f.options);
  const content = await readFile(path.join(f.home, ".config/systemd/user", `${installed.label}.service`), "utf8");
  expect(content).toContain('/usr/bin:/a dir/$custom/%%bin"');
  expect(content).toContain('"host" "run" "--state-dir"'); expect(content).not.toContain("never-save-me");
  expect(content).toContain(`WorkingDirectory=${f.home}/.\n`);
  expect(content).toContain(`StandardOutput=append:${await realpath(f.directory)}/hub.log\n`);
  expect(content).not.toContain('WorkingDirectory="'); expect(content).not.toContain('StandardOutput="');
  expect(content).toContain("UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES");
  expect(quoteWindowsServiceArgument('C:\\Users\\A B\\')).toBe('"C:\\Users\\A B\\\\"'); expect(quoteWindowsServiceArgument('a"b')).toBe('"a\\"b"');
  const win = await fixture("win32"); await installManagedService(win.directory, win.entrypoint, win.options);
  const task = await readFile(path.join(win.directory, "host-service/task.xml"), "utf8");
  expect(task).toContain("<LogonType>InteractiveToken</LogonType>"); expect(task).toContain("<RunLevel>LeastPrivilege</RunLevel>"); expect(task).not.toContain("Password");
});

it("emits exactly two systemd dollar characters for each literal dollar in ExecStart", async () => {
  const f = await fixture("linux"), entrypoint = await packageFixture(path.join(f.root, "package$literal"));
  f.options.resolveRuntime = async () => ({ entrypoint, executable: process.execPath, revisionId: "fixture-revision" });
  const installed = await installManagedService(f.directory, entrypoint, f.options);
  const content = await readFile(path.join(f.home, ".config/systemd/user", `${installed.label}.service`), "utf8");
  expect(content.split("\n").find(line => line.startsWith("ExecStart="))).toContain("package$$literal/");
  expect(content).not.toContain("package$$$$literal/");
});
it("requires the selected immutable Node+entrypoint pair before installation", async () => {
  const f = await fixture("linux"); f.options.resolveRuntime = async () => ({ entrypoint: f.entrypoint, executable: process.execPath });
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_staged_runtime_required");
  f.options.resolveRuntime = async () => ({ entrypoint: f.entrypoint, executable: "/different-node", revisionId: "fixture" });
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_runtime_pair_mismatch");
});
it("fences direct starts, wrong supervisors and stale OS jobs after uninstall", async () => {
  const f = await fixture("darwin"); await assertHostSupervisor(f.directory, f.options);
  const installed = await installManagedService(f.directory, f.entrypoint, f.options);
  await expect(assertHostSupervisor(f.directory, f.options)).rejects.toMatchObject({ exitCode: 78 });
  await expect(assertHostSupervisor(f.directory, { ...f.options, env: { TAROBOT_HOST_SUPERVISOR: "another" } })).rejects.toThrow("supervisor_required");
  const supervised = { ...f.options, env: { TAROBOT_HOST_SUPERVISOR: installed.label } }; await assertHostSupervisor(f.directory, supervised);
  await uninstallManagedService(f.directory, f.options);
  await expect(assertHostSupervisor(f.directory, supervised)).rejects.toThrow("supervisor_required");
});
it.each(["darwin", "linux", "win32"] as const)("shares desktop resume intent and switches a stopped %s service to its selected frozen runtime", async platform => {
  const f = await fixture(platform); await installManagedService(f.directory, f.entrypoint, f.options);
  expect((await readFile(path.join(f.directory, "desktop-enabled.json"), "utf8")).trim()).toBe("true");
  await managedServiceCommand("stop", f.directory, undefined, f.options);
  expect((await readFile(path.join(f.directory, "desktop-enabled.json"), "utf8")).trim()).toBe("false");
  const entrypoint = await packageFixture(path.join(f.root, "next"));
  f.options.resolveRuntime = async () => ({ entrypoint, executable: process.execPath, revisionId: "next-revision" });
  const refreshed = await refreshManagedServiceRuntime(f.directory, { entrypoint, executable: process.execPath }, f.options);
  expect(refreshed).toMatchObject({ entrypoint, revisionId: "next-revision", enabled: false, running: false });
  expect(await managedServiceCommand("start", f.directory, undefined, f.options)).toMatchObject({ entrypoint, running: true, enabled: true });
});
it("reconciles a manually selected runtime during start without taking the manager mutex twice", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("stop", f.directory, undefined, f.options);
  const entrypoint = await packageFixture(path.join(f.root, "next")); f.options.resolveRuntime = async () => ({ entrypoint, executable: process.execPath, revisionId: "next-revision" });
  expect(await managedServiceCommand("start", f.directory, undefined, f.options)).toMatchObject({ entrypoint, running: true });
});
it("keeps the service receipt version when the real runtime selection includes its package version", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("stop", f.directory, undefined, f.options);
  const entrypoint = await packageFixture(path.join(f.root, "next"));
  f.options.resolveRuntime = async () => ({ entrypoint, executable: process.execPath, revisionId: "next-revision", version: "0.1.420", runtimeId: "a".repeat(64) });
  expect(await refreshManagedServiceRuntime(f.directory, { entrypoint, executable: process.execPath }, f.options)).toMatchObject({ entrypoint, revisionId: "next-revision", enabled: false });
  expect(JSON.parse(await readFile(path.join(f.directory, "host-service.json"), "utf8")).version).toBe(1);
  expect(await managedServiceCommand("start", f.directory, undefined, f.options)).toMatchObject({ running: true, entrypoint });
});
it("rejects runtime rebinding until the OS owner is explicitly stopped", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options);
  await expect(refreshManagedServiceRuntime(f.directory, { entrypoint: f.entrypoint, executable: process.execPath }, f.options)).rejects.toThrow("host_service_stop_before_runtime_change");
});
it("matches desktop engine PATH vectors and preserves only validated engine path overrides", () => {
  expect(buildHostEnvironment({ platform: "darwin", home: "/Users/Case", executable: "/runtime/node", env: { PATH: "/usr/bin", CLAUDE_EXECUTABLE: "/custom/claude", API_KEY: "secret" } })).toEqual({
    HOME: "/Users/Case", PATH: "/runtime:/Users/Case/.local/bin:/Users/Case/.npm-global/bin:/Users/Case/.kimi-code/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin", CLAUDE_EXECUTABLE: "/custom/claude",
  });
  const win = buildHostEnvironment({ platform: "win32", home: "C:\\Users\\Case", executable: "C:\\runtime\\node.exe", env: { Path: "C:\\Windows", APPDATA: "C:\\Users\\Case\\AppData\\Roaming" } });
  expect(win.PATH).toBe("C:\\runtime;C:\\Users\\Case\\.local\\bin;C:\\Users\\Case\\.npm-global\\bin;C:\\Users\\Case\\.kimi-code\\bin;C:\\Users\\Case\\AppData\\Roaming\\npm;C:\\Users\\Case\\.cargo\\bin;C:\\Users\\Case\\scoop\\shims;C:\\Windows");
  expect(() => buildHostEnvironment({ env: { CODEX_EXECUTABLE: "codex --unsafe-flag" } })).toThrow("absolute_path_required");
});
it("recovers an interrupted runtime refresh without starting either revision implicitly", async () => {
  const f = await fixture("linux"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("stop", f.directory, undefined, f.options);
  const entrypoint = await packageFixture(path.join(f.root, "next")); f.options.resolveRuntime = async () => ({ entrypoint, executable: process.execPath, revisionId: "next-revision" });
  f.setFailure("daemon-reload");
  await expect(refreshManagedServiceRuntime(f.directory, { entrypoint, executable: process.execPath }, f.options)).rejects.toThrow("fixture error");
  expect(await stat(path.join(f.directory, "host-service-refresh.json"))).toBeDefined();
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ running: false, enabled: false });
  f.setFailure();
  expect(await managedServiceCommand("start", f.directory, undefined, f.options)).toMatchObject({ running: true, entrypoint, revisionId: "next-revision" });
  await expect(stat(path.join(f.directory, "host-service-refresh.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

async function pendingRefreshFixture(platform: "darwin" | "linux" | "win32", phases: ("before" | "after")[], changedTemplate = true, committed = false) {
  const f = await fixture(platform), installed = await installManagedService(f.directory, f.entrypoint, f.options);
  await managedServiceCommand("stop", f.directory, undefined, f.options);
  const receipt = path.join(f.directory, "host-service.json"), pendingFile = path.join(f.directory, "host-service-refresh.json");
  const files = [platform === "darwin" ? path.join(f.home, "Library/LaunchAgents", `${installed.label}.plist`) : platform === "linux" ? path.join(f.home, ".config/systemd/user", `${installed.label}.service`) : path.join(f.directory, "host-service/task.xml")];
  if (platform === "win32") files.push(path.join(f.directory, "host-service/launcher.json"));
  const before = JSON.parse(await readFile(receipt, "utf8")), beforeBytes = await Promise.all(files.map(file => readFile(file, "utf8")));
  const entrypoint = await packageFixture(path.join(f.root, "next"));
  f.options.resolveRuntime = async () => ({ entrypoint, executable: process.execPath, revisionId: "next-revision" });
  await refreshManagedServiceRuntime(f.directory, { entrypoint, executable: process.execPath }, f.options);
  const after = JSON.parse(await readFile(receipt, "utf8")), afterBytes = await Promise.all(files.map(file => readFile(file, "utf8")));
  if (changedTemplate) for (const [manifest, bytes] of [[before, beforeBytes], [after, afterBytes]] as const) {
    for (let i = 0; i < files.length; i++) {
      // Represent the bytes recorded by a previous CLI template without teaching
      // the current renderer how that historical template was constructed.
      bytes[i] = i === 1 ? JSON.stringify(JSON.parse(bytes[i]!), null, 4) + "\n" : bytes[i] + (platform === "linux" ? "# previous template\n" : "<!-- previous template -->\n");
      manifest[i === 1 ? "runtimeHash" : "artifactHash"] = createHash("sha256").update(bytes[i]!).digest("hex");
    }
  }
  await writeFile(receipt, JSON.stringify(committed ? after : before));
  await writeFile(pendingFile, JSON.stringify({ before, after }));
  await Promise.all(files.map((file, i) => writeFile(file, (phases[i] === "after" ? afterBytes : beforeBytes)[i]!)));
  f.calls.length = 0;
  return { ...f, receipt, pendingFile, files, before, after, beforeBytes, afterBytes, entrypoint };
}

it.each(["darwin", "linux", "win32"] as const)("commits a fully written %s refresh from another template without rewriting its artifacts", async platform => {
  const f = await pendingRefreshFixture(platform, ["after", "after"]), inodes = await Promise.all(f.files.map(async file => (await stat(file)).ino));
  expect(await managedServiceCommand("stop", f.directory, undefined, f.options)).toMatchObject({ running: false, enabled: false, entrypoint: f.entrypoint });
  for (let i = 0; i < f.files.length; i++) {
    expect(await readFile(f.files[i]!, "utf8")).toBe(f.afterBytes[i]);
    expect((await stat(f.files[i]!)).ino).toBe(inodes[i]);
  }
  expect(JSON.parse(await readFile(f.receipt, "utf8"))).toEqual(f.after);
  await expect(stat(f.pendingFile)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.calls.some(call => call.args.includes("start") || call.args.includes("/Run") || call.args.includes("kickstart"))).toBe(false);
});

it.each(["darwin", "linux", "win32"] as const)("abandons an unstarted %s refresh from another template while retaining the previous stopped service", async platform => {
  const f = await pendingRefreshFixture(platform, ["before", "before"]);
  expect(await managedServiceCommand("stop", f.directory, undefined, f.options)).toMatchObject({ running: false, enabled: false, entrypoint: f.before.entrypoint });
  expect(JSON.parse(await readFile(f.receipt, "utf8"))).toEqual(f.before);
  for (let i = 0; i < f.files.length; i++) expect(await readFile(f.files[i]!, "utf8")).toBe(f.beforeBytes[i]);
  await expect(stat(f.pendingFile)).rejects.toMatchObject({ code: "ENOENT" });
});

it("finishes a fully committed refresh receipt from another template", async () => {
  const f = await pendingRefreshFixture("win32", ["after", "after"], true, true);
  expect(await managedServiceCommand("stop", f.directory, undefined, f.options)).toMatchObject({ entrypoint: f.entrypoint, running: false });
  expect(JSON.parse(await readFile(f.receipt, "utf8"))).toEqual(f.after);
  await expect(stat(f.pendingFile)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([["before", "after"], ["after", "before"]] as const)("refuses mixed %s/%s refresh artifacts from another template without overwriting either", async (first, second) => {
  const f = await pendingRefreshFixture("win32", [first, second]), original = await Promise.all([...f.files, f.receipt, f.pendingFile].map(file => readFile(file)));
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("host_service_refresh_template_changed");
  expect(await Promise.all([...f.files, f.receipt, f.pendingFile].map(file => readFile(file)))).toEqual(original);
});

it.each([["before", "after"], ["after", "before"]] as const)("recovers mixed %s/%s refresh artifacts when their recorded template is still available", async (first, second) => {
  const f = await pendingRefreshFixture("win32", [first, second], false);
  expect(await managedServiceCommand("stop", f.directory, undefined, f.options)).toMatchObject({ running: false, enabled: false, entrypoint: f.entrypoint });
  expect(await Promise.all(f.files.map(file => readFile(file, "utf8")))).toEqual(f.afterBytes);
  expect(JSON.parse(await readFile(f.receipt, "utf8"))).toEqual(f.after);
  await expect(stat(f.pendingFile)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses to invent a missing artifact from an unavailable refresh template", async () => {
  const f = await pendingRefreshFixture("win32", ["after", "after"]);
  await rm(f.files[1]!);
  const retainedFiles = [f.files[0]!, f.receipt, f.pendingFile], original = await Promise.all(retainedFiles.map(file => readFile(file)));
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("host_service_refresh_template_changed");
  expect(await Promise.all(retainedFiles.map(file => readFile(file)))).toEqual(original);
  await expect(stat(f.files[1]!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not discard a refresh whose manifest and old artifact state disagree", async () => {
  const f = await pendingRefreshFixture("win32", ["before", "before"], true, true), files = [...f.files, f.receipt, f.pendingFile];
  const original = await Promise.all(files.map(file => readFile(file)));
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("host_service_refresh_template_changed");
  expect(await Promise.all(files.map(file => readFile(file)))).toEqual(original);
});

it("checks every pending refresh artifact before writing any of them", async () => {
  const f = await pendingRefreshFixture("win32", ["before", "before"], false);
  await writeFile(f.files[1]!, "unowned edit");
  const original = await Promise.all([...f.files, f.receipt, f.pendingFile].map(file => readFile(file)));
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("host_service_artifact_conflict");
  expect(await Promise.all([...f.files, f.receipt, f.pendingFile].map(file => readFile(file)))).toEqual(original);
});

it("does not infer historical refresh bytes from hashless legacy receipts", async () => {
  const f = await pendingRefreshFixture("win32", ["after", "after"]);
  for (const manifest of [f.before, f.after]) { delete manifest.artifactHash; delete manifest.runtimeHash; delete manifest.artifactTemplateVersion; }
  await writeFile(f.receipt, JSON.stringify(f.before)); await writeFile(f.pendingFile, JSON.stringify({ before: f.before, after: f.after }));
  const original = await Promise.all([...f.files, f.receipt, f.pendingFile].map(file => readFile(file)));
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("host_service_artifact_conflict");
  expect(await Promise.all([...f.files, f.receipt, f.pendingFile].map(file => readFile(file)))).toEqual(original);
});
it("does not traverse an injected service artifact directory symlink", async () => {
  const f = await fixture("win32"), external = path.join(f.root, "external"); await mkdir(external); await symlink(external, path.join(f.directory, "host-service"));
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_unsafe_directory");
  await expect(stat(path.join(external, "task.xml"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("validates engine override files and embeds the exact supervisor token in all service environments", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const f = await fixture(platform);
    if (platform !== "win32") f.options.env = { ...f.options.env, CODEX_EXECUTABLE: process.execPath, CLAUDE_EXECUTABLE: process.execPath, ANTIGRAVITY_EXECUTABLE: process.execPath, KIMI_EXECUTABLE: process.execPath, DSH_EXECUTABLE: process.execPath };
    const installed = await installManagedService(f.directory, f.entrypoint, f.options);
    const manifest = JSON.parse(await readFile(path.join(f.directory, "host-service.json"), "utf8"));
    if (platform !== "win32") expect(manifest.environment).toMatchObject({ CODEX_EXECUTABLE: process.execPath, CLAUDE_EXECUTABLE: process.execPath, ANTIGRAVITY_EXECUTABLE: process.execPath, KIMI_EXECUTABLE: process.execPath, DSH_EXECUTABLE: process.execPath });
    const file = platform === "darwin" ? path.join(f.home, "Library/LaunchAgents", `${installed.label}.plist`) : platform === "linux" ? path.join(f.home, ".config/systemd/user", `${installed.label}.service`) : path.join(f.directory, "host-service/launcher.json");
    const content = await readFile(file, "utf8"); expect(content).toContain("TAROBOT_HOST_SUPERVISOR"); expect(content).toContain(installed.label);
  }
  const f = await fixture("linux"); f.options.env = { PATH: "/usr/bin", DSH_EXECUTABLE: "/no-such-engine" };
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_engine_override_unavailable");
});
it("retains stopped intent if restart is interrupted while disarming supervision", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  f.setFailure("bootout"); await expect(managedServiceCommand("restart", f.directory, undefined, f.options)).rejects.toThrow("fixture error");
  expect((await readFile(path.join(f.directory, "desktop-enabled.json"), "utf8")).trim()).toBe("false");
  expect(JSON.parse(await readFile(path.join(f.directory, "host-service.json"), "utf8")).enabled).toBe(false);
  f.setFailure(); expect(await managedServiceCommand("start", f.directory, undefined, f.options)).toMatchObject({ running: true, enabled: true });
});
it.each(["darwin", "linux", "win32"] as const)("rejects restore over an exact orphan %s registration and removes it without recreating state", async platform => {
  const f = await fixture(platform); await assertNoManagedServiceRegistration(f.directory, f.options);
  await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  await rm(f.directory, { recursive: true }); f.setRunning(false);
  await expect(assertNoManagedServiceRegistration(f.directory, f.options)).rejects.toThrow("host_service_registration_exists");
  expect(await uninstallManagedService(f.directory, f.options)).toMatchObject({ configured: false });
  await expect(stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  await assertNoManagedServiceRegistration(f.directory, f.options);
  expect(f.calls.every(call => !call.args.includes("--all") && !call.args.includes("*"))).toBe(true);
});
it("will not delete an orphan service while a live Hub lock owns its state", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options);
  await rm(path.join(f.directory, "host-service.json"));
  await writeFile(path.join(f.directory, "instance.lock.json"), JSON.stringify({ pid: 123 })); f.options.processAlive = () => true; f.calls.length = 0;
  await expect(uninstallManagedService(f.directory, f.options)).rejects.toThrow("host_service_handoff_required");
  expect(f.calls.some(call => call.args.includes("disable") || call.args.includes("bootout"))).toBe(false);
});

it("keeps malformed epoch metadata conservative when uninstalling an orphan owned by a live PID", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options);
  await rm(path.join(f.directory, "host-service.json"));
  await writeFile(path.join(f.directory, "instance.lock.json"), JSON.stringify({ pid: process.pid, bootId: "invalid", processBirth: "invalid" }));
  f.options.processAlive = () => true; f.calls.length = 0;
  await expect(uninstallManagedService(f.directory, f.options)).rejects.toThrow("host_service_handoff_required");
  expect(f.calls.some(call => call.args.includes("disable") || call.args.includes("bootout"))).toBe(false);
});

it.skipIf(process.platform === "win32")("can remove an orphan service despite a previous-boot PID collision", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options);
  const lock = await acquireInstanceLock(f.directory), file = path.join(f.directory, "instance.lock.json");
  const record = JSON.parse(await readFile(file, "utf8")); await lock.release();
  await writeFile(file, JSON.stringify({ ...record, bootId: `${process.platform}:00000000-0000-0000-0000-000000000000` }));
  await rm(path.join(f.directory, "host-service.json")); f.options.processAlive = () => true;
  expect(await uninstallManagedService(f.directory, f.options)).toMatchObject({ configured: false });
});
it("does not attribute an unrelated Hub to the Windows GUI supervisor", async () => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); f.setRunning(true);
  f.options.inspect = async () => ({ running: true, pid: 112233, url: "https://localhost:8788", publicKey: "fixture", supervisor: "another-service" });
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ supervisorRunning: true, running: true, error: expect.stringContaining("outside") });
  await expect(managedServiceCommand("start", f.directory, undefined, f.options)).rejects.toThrow("host_service_handoff_required");
});
it("retries closed/reset controls after launchd bootout and waits for the original PID before restarting", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  const inspect = f.options.inspect!, runner = f.options.runner!; let stopping = false, transient = 0, pidChecks = 0;
  f.options.timeoutMs = 1000;
  f.options.runner = async (executable, args) => { const result = await runner(executable, args); if (args[0] === "bootout") stopping = true; if (args[0] === "bootstrap") { expect(pidChecks).toBeGreaterThanOrEqual(3); stopping = false; } return result; };
  f.options.inspect = async (directory, action) => {
    if (stopping && transient++ < 2) { if (transient === 1) throw new Error("hub_control_closed"); throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); }
    return inspect(directory, action);
  };
  f.options.processAlive = pid => { expect(pid).toBe(987654); return pidChecks++ < 2; };
  expect(await managedServiceCommand("restart", f.directory, undefined, f.options)).toMatchObject({ running: true, enabled: true });
  expect(transient).toBeGreaterThanOrEqual(3); expect(pidChecks).toBeGreaterThanOrEqual(3);
});
it("never treats permanently closed control connections as a successful stop", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  const inspect = f.options.inspect!, runner = f.options.runner!; let stopping = false;
  f.options.runner = async (executable, args) => { const result = await runner(executable, args); if (args[0] === "bootout") stopping = true; return result; };
  f.options.inspect = async (directory, action) => { if (stopping) throw new Error("hub_control_closed"); return inspect(directory, action); };
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("host_service_stop_timed_out");
});
it("waits through a transient startup connection reset before confirming a supervised Hub", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options);
  const inspect = f.options.inspect!, runner = f.options.runner!; let starting = false, transient = 0; f.options.timeoutMs = 1000;
  f.options.runner = async (executable, args) => { const result = await runner(executable, args); if (args[0] === "bootstrap") starting = true; return result; };
  f.options.inspect = async (directory, action) => { if (starting && transient++ < 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); return inspect(directory, action); };
  expect(await managedServiceCommand("start", f.directory, undefined, f.options)).toMatchObject({ running: true });
});
it("verifies Windows termination when the stop response socket closes during shutdown", async () => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  const inspect = f.options.inspect!; f.options.timeoutMs = 1000;
  f.options.inspect = async (directory, action) => { const status = await inspect(directory, action); if (action === "stop") throw new Error("hub_control_closed"); return status; };
  expect(await managedServiceCommand("stop", f.directory, undefined, f.options)).toMatchObject({ running: false, enabled: false });
});
it("honors a persisted stopped intent before a supervised process can initialize Hub", async () => {
  const f = await fixture("darwin"); const installed = await installManagedService(f.directory, f.entrypoint, f.options);
  await managedServiceCommand("stop", f.directory, undefined, f.options);
  await expect(assertHostSupervisor(f.directory, { ...f.options, env: { TAROBOT_HOST_SUPERVISOR: installed.label } })).rejects.toThrow("host_service_desired_stopped");
});
it.each([["disabled", false], ["enabled", true], ["true", false], ["false", true]] as const)("parses launchctl print-disabled's %s state", async (value, enabled) => {
  const f = await fixture("darwin"), installed = await installManagedService(f.directory, f.entrypoint, f.options);
  await managedServiceCommand("stop", f.directory, undefined, f.options);
  const runner = f.options.runner!;
  f.options.runner = async (executable, args) => args[0] === "print-disabled"
    ? { code: 0, stdout: `disabled services = {\n\t"com.apple.unrelated" => enabled\n\t"${installed.label}" => ${value}\n}\n`, stderr: "" }
    : runner(executable, args);
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ registered: false, running: false, enabled: false, osEnabled: enabled });
  expect((await managedServiceStatus(f.directory, f.options)).error).toBeUndefined();
  if (!enabled) expect(await refreshManagedServiceRuntime(f.directory, { entrypoint: f.entrypoint, executable: process.execPath }, f.options)).toMatchObject({ enabled: false, running: false });
});
it.each(["unknown", "TRUE", "disabled unexpected"])("does not assume an unknown launchd state (%s) is safely disabled", async value => {
  const f = await fixture("darwin"), installed = await installManagedService(f.directory, f.entrypoint, f.options);
  await managedServiceCommand("stop", f.directory, undefined, f.options);
  const runner = f.options.runner!;
  f.options.runner = async (executable, args) => args[0] === "print-disabled"
    ? { code: 0, stdout: `disabled services = {\n\t"${installed.label}" => ${value}\n}\n`, stderr: "" }
    : runner(executable, args);
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ enabled: false, osEnabled: true, error: expect.stringContaining("Could not parse launchd") });
  await expect(refreshManagedServiceRuntime(f.directory, { entrypoint: f.entrypoint, executable: process.execPath }, f.options)).rejects.toThrow("Could not parse launchd");
});
it.each(["stop", "restart"] as const)("stops through local control and disables resume when systemd's user bus is unavailable during %s", async action => {
  const f = await fixture("linux"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  f.options.timeoutMs = 1000; f.calls.length = 0;
  const runner = f.options.runner!;
  f.options.runner = async (executable, args) => {
    if (executable === "systemctl") { f.calls.push({ executable, args }); return { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" }; }
    return runner(executable, args);
  };
  await expect(managedServiceCommand(action, f.directory, undefined, f.options)).rejects.toThrow("host_service_stop_degraded: Hub stopped and automatic resume disabled");
  expect(f.calls.some(call => call.executable === "hub-control" && call.args[0] === "stop")).toBe(true);
  expect(f.calls.some(call => call.executable === "systemctl" && call.args.includes("start"))).toBe(false);
  expect(await f.options.inspect!(f.directory)).toMatchObject({ running: false });
  expect((await readFile(path.join(f.directory, "desktop-enabled.json"), "utf8")).trim()).toBe("false");
  expect(JSON.parse(await readFile(path.join(f.directory, "host-service.json"), "utf8")).enabled).toBe(false);
});

it("keeps a legacy Windows helper from racing a drain-guarded stop, including slow task queries", async () => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  const inspect = f.options.inspect!, runner = f.options.runner!; let ordinaryStops = 0, accepted = false;
  f.options.timeoutMs = 2000; f.options.drainedStop = { drainId: "lease", pid: 987654, publicKey: "fixture" };
  const legacyTick = async () => {
    const live = await inspect(f.directory);
    if (live.running && (await readFile(path.join(f.directory, "desktop-enabled.json"), "utf8")).trim() === "false") { ordinaryStops++; f.setRunning(false); }
  };
  f.options.runner = async (exe, args) => {
    if (exe === "powershell.exe") { await new Promise(resolve => setTimeout(resolve, 260)); await legacyTick(); }
    return runner(exe, args);
  };
  f.options.inspect = async (directory, action) => {
    if (action === "stop") { ordinaryStops++; throw Error("ordinary stop is forbidden"); }
    if (action === "drained-stop") {
      await legacyTick(); const live = await inspect(directory);
      expect(live.running).toBe(true);
      expect(JSON.parse(await readFile(path.join(directory, "host-service.json"), "utf8")).enabled).toBe(false);
      accepted = true; setTimeout(() => f.setRunning(false), 80);
      return live.running ? { ...live, controlCapabilities: ["drained-stop"] } : live;
    }
    return inspect(directory, action);
  };
  expect(await managedServiceCommand("stop", f.directory, undefined, f.options)).toMatchObject({ running: false, enabled: false });
  expect(accepted).toBe(true); expect(ordinaryStops).toBe(0);
  expect((await readFile(path.join(f.directory, "desktop-enabled.json"), "utf8")).trim()).toBe("false");
});

it("a guarded Windows stop never sends ordinary stop to a replacement Hub", async () => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  const inspect = f.options.inspect!; let accepted = false, ordinary = false;
  f.options.drainedStop = { drainId: "lease", pid: 987654, publicKey: "fixture" };
  f.options.inspect = async (directory, action) => {
    const live = await inspect(directory);
    if (action === "stop") { ordinary = true; return live; }
    if (action === "drained-stop") { accepted = true; return live.running ? { ...live, controlCapabilities: ["drained-stop"] } : live; }
    return accepted && live.running ? { ...live, pid: 987655 } : live;
  };
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("host_drain_target_changed");
  expect(ordinary).toBe(false);
});

it.each(["darwin", "linux", "win32"] as const)("restores %s login intent without starting the stopped Hub", async platform => {
  const f = await fixture(platform); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("stop", f.directory, undefined, f.options); f.calls.length = 0;
  expect(await enableManagedServiceOnLogin(f.directory, f.options)).toMatchObject({ enabled: true, running: false });
  expect(f.calls.some(call => call.args.includes("/Run") || call.args.includes("kickstart") || call.args.includes("bootstrap") || call.args.includes("start"))).toBe(false);
});

it.each(["darwin", "linux", "win32"] as const)("preserves explicit engine directories and proxy whitelist privately on %s", async platform => {
  const f = await fixture(platform), directory = platform === "win32" ? "C:\\Private\\engine" : "/private/engine";
  f.options.env = { PATH: "/usr/bin", CODEX_HOME: directory, CLAUDE_CONFIG_DIR: directory, DSH_HOME: directory, KIMI_CODE_HOME: directory, HTTPS_PROXY: "http://proxy-user:private-proxy-password@proxy.invalid:8080", NO_PROXY: "localhost,127.0.0.1", http_proxy: "http://proxy.invalid:8080", NODE_OPTIONS: "--require /do-not-load", ANTHROPIC_API_KEY: "never-store-api-key" };
  const installed = await installManagedService(f.directory, f.entrypoint, f.options), file = path.join(f.directory, "host-service.json");
  const text = await readFile(file, "utf8"), manifest = JSON.parse(text);
  expect(manifest.extraEnvironment).toMatchObject({ CODEX_HOME: directory, CLAUDE_CONFIG_DIR: directory, DSH_HOME: directory, KIMI_CODE_HOME: directory, HTTPS_PROXY: f.options.env.HTTPS_PROXY });
  expect(manifest.environment.CODEX_HOME).toBeUndefined(); // Old frozen hosts still parse their strict environment.
  expect(text).not.toContain("never-store-api-key"); expect(text).not.toContain("--require /do-not-load");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const generated = platform === "darwin" ? path.join(f.home, "Library/LaunchAgents", `${installed.label}.plist`) : platform === "linux" ? path.join(f.home, ".config/systemd/user", `${installed.label}.service`) : path.join(f.directory, "host-service/launcher.json");
  expect(await readFile(generated, "utf8")).toContain("private-proxy-password"); expect((await stat(generated)).mode & 0o777).toBe(0o600);
  expect(await managedServiceEnvironmentDifferences(f.directory, f.options.env, f.options)).toEqual([]);
  const changes = await managedServiceEnvironmentDifferences(f.directory, { ...f.options.env, CODEX_HOME: directory + "-changed", HTTPS_PROXY: "http://different-secret@proxy.invalid" }, f.options);
  expect(changes).toEqual(["CODEX_HOME", "HTTPS_PROXY"]); expect(JSON.stringify(changes)).not.toContain("secret");
});

it("rejects invalid config directories and conflicting Windows proxy case without leaking values", () => {
  expect(() => buildHostEnvironment({ platform: "darwin", env: { CODEX_HOME: "relative" } })).toThrow("CODEX_HOME");
  expect(() => buildHostEnvironment({ platform: "darwin", env: { HTTPS_PROXY: "private\nvalue" } })).toThrow("HTTPS_PROXY");
  expect(() => buildHostEnvironment({ platform: "win32", env: { HTTPS_PROXY: "first-secret", https_proxy: "second-secret" } })).toThrow("host_service_conflicting_environment: HTTPS_PROXY");
});

it("keeps OS ownership format independent of the global state schema version", async () => {
  const f = await fixture("darwin"); await installManagedService(f.directory, f.entrypoint, f.options);
  const file = path.join(f.directory, "host-service.json"), manifest = JSON.parse(await readFile(file, "utf8"));
  expect(manifest.schemaVersion).toBeUndefined();
  await writeFile(file, JSON.stringify({ ...manifest, schemaVersion: 999 }));
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ configured: true });
  await managedServiceCommand("stop", f.directory, undefined, f.options);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 });
  expect(JSON.parse(await readFile(file, "utf8")).schemaVersion).toBeUndefined();
});

it("disabled ownership prevents resume and startup while legacy Windows desired-state stays true", async () => {
  const f = await fixture("win32"), installed = await installManagedService(f.directory, f.entrypoint, f.options);
  const file = path.join(f.directory, "host-service.json"), manifest = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...manifest, enabled: false }));
  expect((await readFile(path.join(f.directory, "desktop-enabled.json"), "utf8")).trim()).toBe("true");
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ enabled: false, osEnabled: true });
  await expect(assertHostSupervisor(f.directory, { ...f.options, env: { TAROBOT_HOST_SUPERVISOR: installed.label } })).rejects.toThrow("host_service_desired_stopped");
});

it.each(["query", "disable"] as const)("restores Windows intent when pre-guard %s fails, without sending stop", async failure => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  const runner = f.options.runner!, inspect = f.options.inspect!; let ordinary = false, guarded = false;
  f.options.drainedStop = { drainId: "lease", pid: 987654, publicKey: "fixture" };
  f.options.runner = async (exe, args) => {
    if (failure === "query" && exe === "powershell.exe" || failure === "disable" && args.includes("/Disable")) return { code: 1, stdout: "", stderr: "pre-stop fixture failure" };
    return runner(exe, args);
  };
  f.options.inspect = async (directory, action) => { ordinary ||= action === "stop"; guarded ||= action === "drained-stop"; return inspect(directory); };
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toMatchObject({ stopRejected: true });
  expect(ordinary || guarded).toBe(false);
  expect(JSON.parse(await readFile(path.join(f.directory, "host-service.json"), "utf8")).enabled).toBe(true);
  expect((await readFile(path.join(f.directory, "desktop-enabled.json"), "utf8")).trim()).toBe("true");
  f.options.runner = runner;
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ running: true, enabled: true, osEnabled: true });
});

it("does not restore Windows automatic startup after an unknown drained-stop commit", async () => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  const inspect = f.options.inspect!;
  f.options.drainedStop = { drainId: "lease", pid: 987654, publicKey: "fixture" };
  f.options.inspect = async (directory, action) => { if (action === "drained-stop") throw new Error("reply_lost"); return inspect(directory); };
  await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("reply_lost");
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ enabled: false, osEnabled: false });
  expect((await readFile(path.join(f.directory, "desktop-enabled.json"), "utf8")).trim()).toBe("true");
});

it("rejects an old runtime before rollback can strip persisted extra environment", async () => {
  const f = await fixture("darwin"); f.options.env = { PATH: "/usr/bin", CODEX_HOME: "/private/engine", HTTPS_PROXY: "http://private-secret@proxy.invalid" };
  await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("stop", f.directory, undefined, f.options);
  const old = await packageFixture(path.join(f.root, "old-package")); await writeFile(path.join(f.root, "old-package/package.json"), JSON.stringify({ version: "0.1.420" }));
  f.options.resolveRuntime = async () => ({ entrypoint: old, executable: process.execPath, revisionId: "old" });
  const before = await readFile(path.join(f.directory, "host-service.json")), count = f.calls.length;
  await expect(assertManagedServiceRuntimeCompatible(f.directory, { entrypoint: old }, f.options)).rejects.toThrow("host_service_runtime_environment_incompatible");
  await expect(managedServiceCommand("start", f.directory, undefined, f.options)).rejects.toThrow("host_service_runtime_environment_incompatible");
  await expect(refreshManagedServiceRuntime(f.directory, { entrypoint: old, executable: process.execPath }, f.options)).rejects.toThrow("host_service_runtime_environment_incompatible");
  expect(f.calls).toHaveLength(count); expect(await readFile(path.join(f.directory, "host-service.json"))).toEqual(before);
});

it.each(["missing", "invalid"])("rejects a Windows update/rollback target with a %s launcher before stopping the current service", async problem => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options);
  const entrypoint = await packageFixture(path.join(f.root, "next")), launcher = path.join(f.root, "next/bin/tarobot-host-launcher.exe");
  if (problem === "missing") await rm(launcher); else await writeFile(launcher, "not a Windows launcher");
  const before = await readFile(path.join(f.directory, "host-service.json")), count = f.calls.length;
  await expect(assertManagedServiceRuntimeCompatible(f.directory, { entrypoint }, f.options)).rejects.toThrow(`host_service_windows_launcher_${problem}`);
  expect(f.calls).toHaveLength(count);
  expect(await readFile(path.join(f.directory, "host-service.json"))).toEqual(before);
  expect(await managedServiceStatus(f.directory, f.options)).toMatchObject({ running: true, enabled: true, entrypoint: f.entrypoint });
});

it.each([false, true])("only explicitly forced Windows stopping may end a verified hung task: force=%s", async force => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options); f.calls.length = 0;
  const inspect = f.options.inspect!; let ordinary = 0;
  f.options.inspect = async (directory, action) => { if (action === "stop") ordinary++; return inspect(directory); };
  if (force) expect(await managedServiceCommand("stop", f.directory, undefined, { ...f.options, force })).toMatchObject({ running: false, enabled: false });
  else await expect(managedServiceCommand("stop", f.directory, undefined, f.options)).rejects.toThrow("host_service_stop_timed_out");
  expect(ordinary).toBeGreaterThan(0);
  expect(f.calls.filter(call => call.args.includes("/End"))).toHaveLength(force ? 1 : 0);
});

it("never force-ends an unknown owner or a drain-guarded Windows task", async () => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options); f.calls.length = 0;
  const inspect = f.options.inspect!;
  await expect(managedServiceCommand("stop", f.directory, undefined, { ...f.options, force: true, drainedStop: { drainId: "lease", pid: 987654, publicKey: "fixture" } })).rejects.toThrow("host_service_force_incompatible_with_drain");
  f.options.inspect = async directory => { const live = await inspect(directory); return live.running ? { ...live, supervisor: "unrelated" } : live; };
  await expect(managedServiceCommand("stop", f.directory, undefined, { ...f.options, force: true })).rejects.toThrow("host_service_stop_timed_out");
  expect(f.calls.some(call => call.args.includes("/End"))).toBe(false);
});

it("refuses first service installation with extra environment on a runtime lacking the capability", async () => {
  const f = await fixture("darwin"); f.options.env = { PATH: "/usr/bin", CODEX_HOME: "/private/preserved" };
  await writeFile(path.join(f.root, "package/package.json"), JSON.stringify({ version: "0.1.420" }));
  await expect(installManagedService(f.directory, f.entrypoint, f.options)).rejects.toThrow("host_service_runtime_environment_incompatible");
  expect(f.calls).toEqual([]);
  await expect(readFile(path.join(f.directory, "host-service.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not call force-stop successful until the original Windows Hub PID has exited", async () => {
  const f = await fixture("win32"); await installManagedService(f.directory, f.entrypoint, f.options); await managedServiceCommand("start", f.directory, undefined, f.options); f.calls.length = 0;
  const inspect = f.options.inspect!; f.options.inspect = directory => inspect(directory); f.options.processAlive = () => true;
  await expect(managedServiceCommand("stop", f.directory, undefined, { ...f.options, force: true })).rejects.toThrow("host_service_stop_timed_out");
  expect(f.calls.filter(call => call.args.includes("/End"))).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(f.directory, "host-service.json"), "utf8")).enabled).toBe(false);
});
