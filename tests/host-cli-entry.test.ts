import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { desktopHostDirectory, resolveHostDirectory } from "../src/host-cli/paths.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { inspectHost } from "../src/host-cli/doctor.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { hostPairingLink } from "../src/host-cli/pairing.js";
import { parsePairingLink } from "../client/src/pairing-link.js";
import { hubServiceCommand } from "../src/hub/service.js";
import * as manager from "../src/host-cli/service-manager.js";
import { acquireInstanceLock } from "../src/state/instance-lock.js";
import { runHubCli } from "../src/hub/cli.js";
import { HubStore } from "../src/hub/store.js";
import { HOST_PROFILE_KEY } from "../src/hub/host-profile.js";
import { assertHostRuntimeCompatible } from "../src/host-cli/schema-guard.js";

const roots: string[] = [];
it("rejects relative Windows APPDATA instead of selecting a second identity from the current directory", () => {
  for (const APPDATA of ["relative\\Roaming", "C:Roaming", "\\Roaming", "   "]) {
    expect(() => desktopHostDirectory("win32", "C:\\Users\\Demo", { APPDATA })).toThrow("host_appdata_path_not_absolute");
  }
  expect(desktopHostDirectory("win32", "C:\\Users\\Demo", { APPDATA: "\\\\server\\share\\Roaming" })).toBe("\\\\server\\share\\Roaming\\com.tarobot.client\\host");
  expect(desktopHostDirectory("win32", "C:\\Users\\Demo", {})).toBe("C:\\Users\\Demo\\AppData\\Roaming\\com.tarobot.client\\host");
});
async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), "tb-cli-entry-")); roots.push(dir); return dir; }
afterEach(async () => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("matches native desktop directories and requires an explicit choice when a legacy identity exists", async () => {
  expect(desktopHostDirectory("darwin", "/Users/demo", {})).toBe("/Users/demo/Library/Application Support/com.tarobot.client/host");
  expect(desktopHostDirectory("win32", "C:\\Users\\Demo", { APPDATA: "C:\\Users\\Demo\\AppData\\Roaming" })).toBe("C:\\Users\\Demo\\AppData\\Roaming\\com.tarobot.client\\host");
  expect(desktopHostDirectory("linux", "/home/demo", { XDG_DATA_HOME: "/data" })).toBe("/data/com.tarobot.client/host");
  const home = await root(), legacy = path.join(home, ".cctb", "hub");
  await mkdir(legacy, { recursive: true }); await writeFile(path.join(legacy, "hub.sqlite"), "existing");
  await expect(resolveHostDirectory(undefined, { home, env: {} })).rejects.toThrow("不会自动合并身份");
  expect(await resolveHostDirectory(legacy, { home, env: {} })).toMatch(/\.cctb\/hub$/);
});

it("does not initialize from status and preserves the same named host identity across repeated init", async () => {
  const parent = await root(), directory = path.join(parent, "host");
  expect((await inspectHost(directory, {})).initialized).toBe(false);
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  const created = await initializeHost(directory, "Mac mini");
  const identity = await readFile(path.join(directory, "identity.json"));
  expect(await initializeHost(directory, "Mac mini")).toMatchObject({ created: false, publicKey: created.publicKey });
  await expect(initializeHost(directory, "Other host")).rejects.toThrow("不会覆盖");
  expect(await readFile(path.join(directory, "identity.json"))).toEqual(identity);
  expect((await inspectHost(directory, {})).service.running).toBe(false);
});

it("round-trips CLI pairing into the actual phone parser and refuses unreachable loopback or plaintext routes", () => {
  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const routes = [{ name: "Direct" as const, url: "https://host.example:8788" }];
  expect(parsePairingLink(hostPairingLink(key, routes, "i".repeat(43)))).toEqual({ v: 1, kind: "connect", hubPublicKey: key, routes, invite: "i".repeat(43) });
  for (const url of ["http://192.168.1.2:8788", "http://127.0.0.1:8788", "https://localhost:8788"]) expect(() => hostPairingLink(key, [{ name: "Direct", url }], "i".repeat(43))).toThrow();
});

it("rejects stray positional arguments and accidental force before touching host state", async () => {
  const directory = path.join(await root(), "unused");
  await expect(runHostCli(["start", "another-host", "--state-dir", directory])).rejects.toThrow("位置参数");
  await expect(runHostCli(["update", "apply", "revision", "--force", "--state-dir", directory])).rejects.toThrow("--force");
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses offline initialization while a host owns its state before its control socket is ready", async () => {
  const directory = await root(), lock = await acquireInstanceLock(directory);
  try { await expect(initializeHost(directory, "Racing host")).rejects.toThrow("Instance lock already held"); await expect(stat(path.join(directory, "hub.sqlite"))).rejects.toMatchObject({ code: "ENOENT" }); }
  finally { await lock.release(); }
});

it("leaves the managed host enabled during a desktop installer update", async () => {
  const directory = await root();
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: true, registered: true, enabled: true, supervisorRunning: true, running: false, directory, limitations: [] });
  const stop = vi.spyOn(manager, "managedServiceCommand");
  expect(await hubServiceCommand("installer-stop", directory, "unused")).toEqual({ running: false, retainedForDesktopUpdate: true });
  expect(stop).not.toHaveBeenCalled();
  await expect(stat(path.join(directory, "desktop-enabled.json"))).rejects.toMatchObject({ code: "ENOENT" });
});


it("requires explicit existing state for offline Hub maintenance without creating a legacy host", async () => {
  const directory = path.join(await root(), "missing");
  await expect(runHubCli(["devices", "list"])).rejects.toThrow("explicit --state-dir");
  await expect(runHubCli(["devices", "revoke", "unknown", "--state-dir", directory])).rejects.toThrow("host_not_initialized");
  await expect(runHubCli(["nonsense", "--state-dir", directory])).rejects.toThrow("Unknown hub command");
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses implicit migration during offline maintenance and profile repair before changing any state", async () => {
  const directory = path.join(await root(), "host"); await initializeHost(directory, "Original");
  const store = await HubStore.open(directory);
  await store.db.run("DELETE FROM meta WHERE key=?", [HOST_PROFILE_KEY]);
  await store.db.exec("ALTER TABLE bots DROP COLUMN deleted_at");
  await store.db.run("UPDATE meta SET value='13' WHERE key='schema_version'"); await store.db.close();
  const before = await readFile(path.join(directory, "hub.sqlite")), identity = await readFile(path.join(directory, "identity.json")), files = (await readdir(directory)).sort();
  await expect(runHubCli(["devices", "list", "--state-dir", directory])).rejects.toThrow("host_schema_migration_requires_update:13:25");
  await expect(initializeHost(directory, "Changed")).rejects.toThrow("host_schema_migration_requires_update:13:25");
  expect(await readFile(path.join(directory, "hub.sqlite"))).toEqual(before);
  expect(await readFile(path.join(directory, "identity.json"))).toEqual(identity);
  expect((await readdir(directory)).filter(file => !["hub.sqlite-shm", "hub.sqlite-wal"].includes(file)).sort()).toEqual(files.filter(file => !["hub.sqlite-shm", "hub.sqlite-wal"].includes(file)));
});

it("uses target runtime compatibility and preserves a frozen older selection when maintenance cannot open it", async () => {
  const parent = await root(), directory = path.join(parent, "host"), pkg = path.join(parent, "older-runtime");
  await initializeHost(directory, "Original"); await mkdir(pkg);
  const entrypoint = path.join(pkg, "index.js"); await writeFile(entrypoint, "// fixture runtime");
  await writeFile(path.join(pkg, "package.json"), JSON.stringify({ tarobotHostUpdate: { format: 1, minHubSchema: 1, maxHubSchema: 13 } }));
  await expect(assertHostRuntimeCompatible(directory, entrypoint, { allowMigration: true })).rejects.toThrow("host_schema_incompatible:25:runtime_1-13");
  await mkdir(`${directory}.runtime`);
  const current = { entrypoint, executable: process.execPath, minHubSchema: 1, maxHubSchema: 13 };
  const selection = JSON.stringify({ format: 1, transactionId: randomUUID(), current, previous: current });
  await writeFile(`${directory}.runtime/current.json`, selection);
  const before = await readFile(path.join(directory, "hub.sqlite"));
  await expect(runHubCli(["devices", "list", "--state-dir", directory])).rejects.toThrow("host_schema_incompatible:25:runtime_1-13");
  expect(await readFile(path.join(directory, "hub.sqlite"))).toEqual(before);
  expect(await readFile(`${directory}.runtime/current.json`, "utf8")).toBe(selection);
  const modernPackage = { tarobotHostUpdate: { format: 1, minHubSchema: 1, maxHubSchema: 25 }, tarobotHubSchema: 25 };
  await writeFile(path.join(pkg, "package.json"), JSON.stringify(modernPackage));
  expect(await assertHostRuntimeCompatible(directory, entrypoint)).toMatchObject({ schema: 25, maxHubSchema: 25, writeHubSchema: 25 });
  // Source tests and built packages use different depths; discovery must not
  // require the source tree's synthetic index.js path to exist.
  expect(await assertHostRuntimeCompatible(directory, path.join(pkg, "dist", "src", "index.js"))).toMatchObject({ schema: 25, writeHubSchema: 25 });
});

it("rejects an incompatible Hub run before startup can migrate state or change supervisor intent", async () => {
  const directory = path.join(await root(), "host"); await initializeHost(directory, "Original");
  const store = await HubStore.open(directory);
  await store.db.run("UPDATE meta SET value='26' WHERE key='schema_version'"); await store.db.close();
  const before = await readFile(path.join(directory, "hub.sqlite")), enabled = await readFile(path.join(directory, "desktop-enabled.json"));
  await expect(runHubCli(["run", "--state-dir", directory])).rejects.toThrow("host_schema_incompatible:26:runtime_1-25");
  expect(await readFile(path.join(directory, "hub.sqlite"))).toEqual(before);
  expect(await readFile(path.join(directory, "desktop-enabled.json"))).toEqual(enabled);
});

it.each([13, 18, 19, 20])("repairs only a missing legacy configuration through explicit offline init (schema %s)", async schema => {
  const directory = path.join(await root(), "host");
  const original = await initializeHost(directory, "Legacy");
  const previous = await HubStore.open(directory); await previous.db.run("UPDATE meta SET value=? WHERE key='schema_version'", [String(schema)]); await previous.db.close();
  await rm(path.join(directory, "config.json"));
  const identity = await readFile(path.join(directory, "identity.json")), database = await readFile(path.join(directory, "hub.sqlite")), enabled = await readFile(path.join(directory, "desktop-enabled.json"));
  await expect(runHubCli(["run", "--state-dir", directory])).rejects.toThrow("主机尚未初始化");
  await expect(initializeHost(directory, "Different")).rejects.toThrow("不会覆盖");
  const held = await acquireInstanceLock(directory);
  try { await expect(initializeHost(directory, "Legacy")).rejects.toThrow("Instance lock already held"); }
  finally { await held.release(); }
  await expect(stat(path.join(directory, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await initializeHost(directory, "Legacy")).toMatchObject({ created: false, configurationRestored: true, publicKey: original.publicKey });
  expect(JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"))).toMatchObject({ host: "127.0.0.1", port: 8788, instancePort: 8789 });
  expect(await readFile(path.join(directory, "identity.json"))).toEqual(identity);
  expect(await readFile(path.join(directory, "hub.sqlite"))).toEqual(database);
  expect(await readFile(path.join(directory, "desktop-enabled.json"))).toEqual(enabled);
});

it("never repairs missing configuration around corrupt legacy identity", async () => {
  const directory = path.join(await root(), "host"); await initializeHost(directory, "Legacy");
  await rm(path.join(directory, "config.json")); await writeFile(path.join(directory, "identity.json"), "{}");
  await expect(initializeHost(directory, "Legacy")).rejects.toThrow();
  await expect(stat(path.join(directory, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("repairs a legacy configuration without migrating an unnamed old database", async () => {
  const directory = path.join(await root(), "host"); const original = await initializeHost(directory, "Legacy");
  const store = await HubStore.open(directory); await store.db.run("DELETE FROM meta WHERE key=?", [HOST_PROFILE_KEY]); await store.db.run("UPDATE meta SET value='18' WHERE key='schema_version'"); await store.db.close();
  await rm(path.join(directory, "config.json"));
  const bytes = await readFile(path.join(directory, "hub.sqlite"));
  expect(await initializeHost(directory, "Recovered")).toMatchObject({ created: false, configurationRestored: true, profileNamePending: true, requestedName: "Recovered", publicKey: original.publicKey });
  expect(await readFile(path.join(directory, "hub.sqlite"))).toEqual(bytes);
  expect(JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"))).toMatchObject({ port: 8788, instancePort: 8789 });
});
it("never repairs configuration for an unsupported future database", async () => {
  const directory = path.join(await root(), "host"); await initializeHost(directory, "Future");
  const store = await HubStore.open(directory); await store.db.run("UPDATE meta SET value='26' WHERE key='schema_version'"); await store.db.close(); await rm(path.join(directory, "config.json"));
  await expect(initializeHost(directory, "Future")).rejects.toThrow("host_schema_incompatible");
  await expect(stat(path.join(directory, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it('reads legacy storage diagnostics without migration and refuses compaction while an instance owns the host',async()=>{
 const directory=path.join(await root(),'storage-host');await initializeHost(directory,'Storage fixture');
 const store=await HubStore.open(directory);await store.db.run("UPDATE meta SET value='21' WHERE key='schema_version'");await store.db.close();
 const before=await readFile(path.join(directory,'hub.sqlite'));const output=vi.spyOn(console,'log').mockImplementation(()=>{});
 await runHubCli(['storage','--state-dir',directory]);expect(output).toHaveBeenCalled();expect(await readFile(path.join(directory,'hub.sqlite'))).toEqual(before);
 const upgraded=await HubStore.open(directory);await upgraded.db.close();
 const held=await acquireInstanceLock(directory);
 try{await expect(runHubCli(['compact','--state-dir',directory])).rejects.toThrow('Instance lock already held');}finally{await held.release();}
});

it("rejects duplicate target flags and unknown network commands before opening a host", async () => {
  const directory = path.join(await root(), "unused");
  for (const args of [
    ["bots", "delete", "bot", "--expected-name", "A", "--expected-name", "B", "--yes"],
    ["devices", "revoke", "phone", "--yes", "--yes"],
    ["network", "create", "--name", "A", "--name", "B"],
    ["messages", "send", "--to", "A", "--to", "B"],
  ]) await expect(runHostCli([...args, "--state-dir", directory])).rejects.toThrow("不能重复");
  await expect(runHostCli(["network", "typo", "--state-dir", directory])).rejects.toThrow("未知 network 命令");
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("native rebrand keeps the existing desktop host without copying credentials or creating another host", async () => {
  const home = await root(), env = {}, preferred = desktopHostDirectory("darwin", home, env);
  const legacy = path.join(home, "Library/Application Support/com.tarocub.client/host");
  expect(await resolveHostDirectory(undefined, { home, env, platform: "darwin" })).toBe(preferred);
  await expect(stat(path.dirname(preferred))).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "identity.json"), "original");
  expect(await resolveHostDirectory(undefined, { home, env, platform: "darwin" })).toBe(legacy);
  expect(await readFile(path.join(legacy, "identity.json"), "utf8")).toBe("original");
  await expect(stat(path.dirname(preferred))).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(preferred, { recursive: true });
  await expect(resolveHostDirectory(undefined, { home, env, platform: "darwin" })).rejects.toThrow("host_directory_conflict");
  expect(await resolveHostDirectory(legacy, { home, env, platform: "darwin" })).toBe(legacy);
});
it("native rebrand does not abandon malformed or redirected legacy storage", async () => {
  const home = await root(), env = {}, legacy = path.join(home, "Library/Application Support/com.tarocub.client");
  await mkdir(path.dirname(legacy), { recursive: true }); await writeFile(legacy, "unexpected");
  await expect(resolveHostDirectory(undefined, { home, env, platform: "darwin" })).rejects.toThrow("host_directory_redirected");
  await rm(legacy); const target = path.join(home, "other"); await mkdir(target); await symlink(target, legacy, "dir");
  await expect(resolveHostDirectory(undefined, { home, env, platform: "darwin" })).rejects.toThrow("host_directory_redirected");
});

// Doctor must describe the same reused desktop Host as actual startup, without
// abandoning it or making inspection of an explicit recovery directory fail.
it.runIf(process.platform !== "win32")("doctor reports the existing legacy desktop Host and isolates a default-directory conflict", async () => {
  const home = await root(), env = { HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, "data") };
  const preferred = desktopHostDirectory(process.platform, home, env);
  const legacy = path.join(path.dirname(path.dirname(preferred)), "com.tarocub.client", "host");
  await mkdir(legacy, { recursive: true });
  const selected = path.join(home, "h");
  expect((await inspectHost(selected, env)).desktopDirectory).toBe(legacy);
  await expect(stat(preferred)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(preferred, { recursive: true });
  expect(await inspectHost(selected, env)).toMatchObject({ directory: selected, desktopDirectoryIssue: "conflict", initialized: false });
});
