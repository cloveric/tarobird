import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsPromises from "node:fs/promises";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { activateHostUpdate, assertFrozenNodeLibraries, hostRuntimeDirectory, hostUpdateStatus, identifyHostRuntime, inspectFrozenNodeDependencies, inspectHostUpdateRecovery, listHostUpdates, markHostUpdateHealthy, preflightHostUpdate, pruneHostUpdates, resolveHostRuntime, rollbackHostUpdate, stageHostUpdate } from "../src/host-cli/update.js";
import { HubStore } from "../src/hub/store.js";
import { HubAuth } from "../src/hub/auth.js";
import { HubDatabase } from "../src/hub/database.js";
import { acquireInstanceLock } from "../src/state/instance-lock.js";
import { startHubControl } from "../src/hub/service.js";
import { withFileMutex } from "../src/state/file-mutex.js";
import * as serviceManager from "../src/host-cli/service-manager.js";

vi.mock("node:fs/promises", async original => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, open: vi.fn(actual.open), readdir: vi.fn(actual.readdir), statfs: vi.fn(actual.statfs) }; });

const temporary: string[] = [];
async function fixture() { const base = await mkdtemp(path.join(os.tmpdir(), "hup-")); temporary.push(base); return { base, state: path.join(base, "host"), source: path.join(base, "candidate") }; }
async function file(root: string, name: string, content: string | object) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), typeof content === "string" ? content : JSON.stringify(content)); }
async function candidate(root: string, version = "0.1.500", maxHubSchema = 25) {
  await file(root, "package.json", { name: "tarobot", version, private: true, type: "module", engines: { node: ">=20.17.0" }, dependencies: { sqlite3: "6.0.1", zod: "4.1.5" }, tarobotHostUpdate: { format: 1, minHubSchema: 1, maxHubSchema } });
  await file(root, "standalone-graph.json", { inputs: { "src/index.ts": {} } });
  await file(root, "dist/src/index.js", "if(process.argv[2]!=='--help')throw Error('unexpected stateful probe'); console.log('TaroBot test CLI');");
  await file(root, "dist/relay-runtime.mjs", "export {};");
  await file(root, "client/dist/index.html", "<!doctype html><title>TaroBot</title>");
  await file(root, "npm-shrinkwrap.json", { lockfileVersion: 3 });
  for (const name of ["sqlite3", "zod"]) await file(root, `node_modules/${name}/package.json`, { name, type: "module", exports: "./index.js" });
  await file(root, "node_modules/sqlite3/index.js", "export default {Database: class {constructor(file,cb){if(file!==':memory:')throw Error('not isolated');queueMicrotask(()=>cb(null));} close(cb){cb(null);}}};");
  await file(root, "node_modules/zod/index.js", "export const z={string(){return {parse(v){return v;}}}};");
  return path.join(root, "dist/src/index.js");
}
async function initialize(state: string, schema = 21) {
  const store = await HubStore.open(state); await HubAuth.open(store, state);
  await store.db.run("UPDATE meta SET value=? WHERE key='schema_version'", [String(schema)]); await store.db.close();
  await file(state, "private-network.json", { networkId: "network-original", hostId: "host-original", peer: "second-host" });
  await file(state, "bots/bot_a/workspace/notes.txt", "keep bot context");
}
afterEach(async () => { vi.restoreAllMocks(); const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); vi.mocked(fsPromises.open).mockImplementation(actual.open); vi.mocked(fsPromises.readdir).mockImplementation(actual.readdir); vi.mocked(fsPromises.statfs).mockImplementation(actual.statfs); for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });

it("rejects an already selected revision during preflight, before a caller drains or stops the host", async () => {
  const { base, source, state } = await fixture();
  const fallback = await candidate(path.join(base, "old"), "0.1.499");
  await candidate(source); await initialize(state);
  const revision = await stageHostUpdate(state, source);
  await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
  await expect(preflightHostUpdate(state, revision.id)).rejects.toThrow("host_update_already_selected");
}, 30_000);

// The real Node executable is copied and hashed (over 100 MiB on macOS), and
// package probes run as actual subprocesses. Leave time for shared test runners.
describe("standalone host runtime updates", { timeout: 20_000 }, () => {
  it("activates unified TaroBird versions and CLI aliases without replacing existing host state", async () => {
    const { base, source, state } = await fixture();
    const fallback = await candidate(path.join(base, "old"), "0.1.475");
    await candidate(source, "1.1.0");
    const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    manifest.bin = { tarobot: "bin/tarobot.mjs", tarobird: "bin/tarobot.mjs" };
    manifest.engines = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).engines;
    await file(source, "package.json", manifest);
    await file(source, "bin/tarobot.mjs", "import '../dist/src/index.js';");
    await initialize(state);
    const retained = ["identity.json", "private-network.json", "bots/bot_a/workspace/notes.txt"];
    const before = await Promise.all(retained.map(name => readFile(path.join(state, name), "utf8")));
    const revision = await stageHostUpdate(state, source);
    expect(revision.version).toBe("1.1.0");
    await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    expect(await resolveHostRuntime(state, fallback)).toMatchObject({ entrypoint: revision.entrypoint, executable: revision.executable, version: "1.1.0" });
    const runtime = path.resolve(path.dirname(revision.entrypoint), "../..");
    const installed = JSON.parse(await readFile(path.join(runtime, "package.json"), "utf8"));
    expect(installed.name).toBe("tarobot");
    expect(installed.bin).toEqual(manifest.bin);
    expect(await readFile(path.join(runtime, installed.bin.tarobird), "utf8")).toContain("../dist/src/index.js");
    expect(await Promise.all(retained.map(name => readFile(path.join(state, name), "utf8")))).toEqual(before);
  });

  it("identifies the actual executable pair and checks native modules at launch", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499");
    await candidate(source); await file(source, "node_modules/sqlite3/check.node", "native module fixture");
    await file(source, "bin/tarobot-host-launcher.exe", "helper fixture"); await initialize(state);
    const revision = await stageHostUpdate(state, source);
    const receipt = await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    expect(receipt.after.runtimeId).toBe(revision.digest);
    expect(await identifyHostRuntime(state, revision.entrypoint, revision.executable)).toBe(revision.digest);
    expect(await identifyHostRuntime(state, fallback, process.execPath)).toBeUndefined();
    const runtime = path.resolve(path.dirname(revision.entrypoint), "../..");
    expect(await readFile(path.join(runtime, "bin/tarobot-host-launcher.exe"), "utf8")).toBe("helper fixture");
    await writeFile(path.join(runtime, "node_modules/sqlite3/check.node"), "tampered native module");
    await expect(identifyHostRuntime(state, revision.entrypoint, revision.executable)).rejects.toThrow("host_update_revision_changed");
  });

  it("refuses a forged tree identity even when the package version matches", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499");
    await candidate(source); await initialize(state); const revision = await stageHostUpdate(state, source);
    await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    const pointerFile = path.join(await hostRuntimeDirectory(state), "current.json"), pointer = JSON.parse(await readFile(pointerFile, "utf8"));
    pointer.current.runtimeId = "0".repeat(64); await writeFile(pointerFile, JSON.stringify(pointer));
    await expect(resolveHostRuntime(state, fallback)).rejects.toThrow("host_update_invalid_selection");
  });
  it("stages an isolated immutable package without changing state or selection", async () => {
    const { source, state } = await fixture(); const fallback = await candidate(source);
    await initialize(state); const identity = await readFile(path.join(state, "identity.json"), "utf8");
    const revision = await stageHostUpdate(state, source);
    expect(revision.version).toBe("0.1.500"); expect(revision.entrypoint).not.toBe(fallback);
    expect(await resolveHostRuntime(state, fallback)).toEqual({ entrypoint: fallback, executable: process.execPath });
    expect(revision.executable).not.toBe(process.execPath); expect(revision.platform).toBe(process.platform); expect(revision.arch).toBe(process.arch);
    expect(await readFile(path.join(state, "identity.json"), "utf8")).toBe(identity);
    expect(await listHostUpdates(state)).toEqual([revision]);
    expect((await stageHostUpdate(state, source)).id).toBe(revision.id);
    expect((await readdir(path.join(await hostRuntimeDirectory(state), "versions"))).filter(name => name.startsWith(".stage"))).toEqual([]);
  });

  it("reclaims abandoned staging trees while holding the stage writer lock", async () => {
    const { source, state } = await fixture(); await candidate(source); await initialize(state);
    const versions = path.join(await hostRuntimeDirectory(state), "versions"), abandoned = path.join(versions, ".stage-00000000-0000-4000-8000-000000000000");
    await file(abandoned, "package/partial", "interrupted stage");
    const outside = path.join(source, "outside-staging"); await file(outside, "keep", "not owned");
    const link = path.join(versions, ".stage-00000000-0000-4000-8000-000000000001"); await symlink(outside, link);
    await stageHostUpdate(state, source);
    await expect(readFile(path.join(abandoned, "package/partial"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(link, "keep"), "utf8")).toBe("not owned");
  });

  it("backs up original bytes and selects only the executable, preserving network and Bot identity", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499");
    await candidate(source); await initialize(state, 13);
    const baseline = await stageHostUpdate(state, path.join(base, "old")); await activateHostUpdate(state, baseline.id, { currentEntrypoint: fallback });
    const originals = await Promise.all(["identity.json", "private-network.json", "bots/bot_a/workspace/notes.txt"].map(name => readFile(path.join(state, name), "utf8")));
    const revision = await stageHostUpdate(state, source), receipt = await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    expect(receipt.state).toBe("selected"); expect(receipt.hubSchema).toBe(13); expect(receipt.backupPath).toBeTruthy();
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(revision.entrypoint);
    for (let i = 0; i < originals.length; i++) {
      const name = ["identity.json", "private-network.json", "bots/bot_a/workspace/notes.txt"][i]!;
      expect(await readFile(path.join(state, name), "utf8")).toBe(originals[i]);
      if (name.includes("/workspace/")) await expect(readFile(path.join(receipt.backupPath!, "state", name))).rejects.toThrow();
      else expect(await readFile(path.join(receipt.backupPath!, "state", name), "utf8")).toBe(originals[i]);
    }
    const db = await HubDatabase.snapshot(path.join(state, "hub.sqlite"));
    try { expect((await db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'"))?.value).toBe("13"); } finally { await db.close(); }
    const healthy = await markHostUpdateHealthy(state, receipt.id); expect(healthy.state).toBe("healthy");
    const reverted = await rollbackHostUpdate(state, { currentEntrypoint: fallback }); expect(reverted.after.entrypoint).toBe(baseline.entrypoint);
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(baseline.entrypoint);
    expect((await hostUpdateStatus(state)).transaction?.operation).toBe("rollback");
  });

  it("refuses downgrade after migration and keeps the new selection and live database", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499", 13);
    await candidate(source); await initialize(state, 13);
    const baseline = await stageHostUpdate(state, path.join(base, "old")); await activateHostUpdate(state, baseline.id, { currentEntrypoint: fallback });
    const revision = await stageHostUpdate(state, source);
    await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    const migrated = await HubStore.open(state); await migrated.db.close();
    await expect(preflightHostUpdate(state)).rejects.toThrow("host_update_schema_incompatible_restore_required");
    await expect(rollbackHostUpdate(state, { currentEntrypoint: fallback })).rejects.toThrow("host_update_schema_incompatible_restore_required");
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(revision.entrypoint);
  });

  it.each([17, 19, 23, 24])("refuses rollback to a schema-%i runtime after migration of scheduled or assisted Bot inputs", async oldSchema => {
    // Older Hubs do not understand Agent Bus (19), group discussion (20)
    // execution-time assistance (24) or paused queue (25) inputs. Only restoring the pre-update backup is a safe way back.
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499", oldSchema);
    await candidate(source); await initialize(state, oldSchema);
    const baseline = await stageHostUpdate(state, path.join(base, "old")); await activateHostUpdate(state, baseline.id, { currentEntrypoint: fallback });
    const revision = await stageHostUpdate(state, source), receipt = await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    expect(receipt.hubSchema).toBe(oldSchema); expect(receipt.backupPath).toBeTruthy();
    const migrated = await HubStore.open(state); await migrated.db.close();
    await expect(rollbackHostUpdate(state, { currentEntrypoint: fallback })).rejects.toThrow("host_update_schema_incompatible_restore_required");
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(revision.entrypoint);
  });

  it("refuses first-adoption rollback to a mutable App or source path even with matching metadata", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499");
    await candidate(source); await initialize(state); const revision = await stageHostUpdate(state, source);
    await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    await writeFile(fallback, "console.log('same version, replaced application code');");
    await expect(preflightHostUpdate(state)).rejects.toThrow("host_update_previous_runtime_not_frozen");
    await expect(rollbackHostUpdate(state, { currentEntrypoint: fallback })).rejects.toThrow("host_update_previous_runtime_not_frozen");
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(revision.entrypoint);
  });

  it("refuses old packages without declared database compatibility", async () => {
    const { source, state } = await fixture(); await candidate(source);
    const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")); delete pkg.tarobotHostUpdate;
    await file(source, "package.json", pkg); await expect(stageHostUpdate(state, source)).rejects.toThrow();
  });

  it("rejects running Hub and independently running retained Bot without changing runtime", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state);
    const fallback = await candidate(path.join(base, "old"), "0.1.499"), revision = await stageHostUpdate(state, source);
    const stop = await startHubControl(state, { running: true, pid: process.pid, url: "https://localhost:8788", publicKey: "fixture" }, () => {});
    try { await expect(activateHostUpdate(state, revision.id, { currentEntrypoint: fallback })).rejects.toThrow("host_update_requires_stopped_host"); } finally { await stop(); }
    const lock = await acquireInstanceLock(path.join(state, "bots/bot_a"));
    try { await expect(activateHostUpdate(state, revision.id, { currentEntrypoint: fallback })).rejects.toThrow("Instance lock already held"); } finally { await lock.release(); }
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(fallback);
  });

  it("rejects an enabled OS supervisor even if its Hub socket is temporarily absent", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state);
    const fallback = await candidate(path.join(base, "old"), "0.1.499"), revision = await stageHostUpdate(state, source);
    await file(state, "host-service.json", { enabled: true });
    await expect(activateHostUpdate(state, revision.id, { currentEntrypoint: fallback })).rejects.toThrow("host_update_requires_disabled_supervisor");
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(fallback);
  });

  it.each([["nativeRun", "streaming"], ["nativeRun", "complete"], ["scopedRun", "complete"]])("refuses unfinished %s %s Bot output even without a live worker", async (key, status) => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state);
    const store = await HubStore.open(state);
    await store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at) VALUES ('c','direct','test','owner',1)");
    await store.db.run("INSERT INTO messages (id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES ('m','c','bot','bot',?,?,1,1)", [JSON.stringify([{ type: "card", extra: { [key]: { phase: "thinking" } } }]), status]);
    await store.db.close(); const fallback = await candidate(path.join(base, "old"), "0.1.499"), revision = await stageHostUpdate(state, source);
    expect((await inspectHostUpdateRecovery(state)).unfinishedRuns).toEqual([{ botId: "bot", messageId: "m", conversationId: "c", status, phase: "thinking" }]);
    await expect(preflightHostUpdate(state, revision.id)).resolves.toMatchObject({ revisionId: revision.id });
    await expect(activateHostUpdate(state, revision.id, { currentEntrypoint: fallback })).rejects.toThrow('"botId":"bot","messageId":"m","conversationId":"c"');
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(fallback);
  });

  it("rejects external symlinks, missing graph modules, and mutation after staging", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await file(base, "secret.txt", "outside");
    await symlink(path.join(base, "secret.txt"), path.join(source, "client/dist/escape"));
    await expect(stageHostUpdate(state, source)).rejects.toThrow("host_update_external_symlink"); await rm(path.join(source, "client/dist/escape"));
    await file(source, "standalone-graph.json", { inputs: { "src/index.ts": {}, "src/missing.ts": {} } });
    await expect(stageHostUpdate(state, source)).rejects.toThrow("host_update_missing_file");
    await file(source, "standalone-graph.json", { inputs: { "src/index.ts": {} } });
    const revision = await stageHostUpdate(state, source); await writeFile(revision.entrypoint, "changed");
    await initialize(state); const fallback = await candidate(path.join(base, "old"), "0.1.499");
    await expect(activateHostUpdate(state, revision.id, { currentEntrypoint: fallback })).rejects.toThrow("host_update_revision_changed");
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(fallback);
  });

  it("keeps unstarted user messages queued across a stopped update", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state);
    const store = await HubStore.open(state);
    await store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at) VALUES ('c','direct','test','owner',1)");
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES ('bot','test','hash')");
    await store.db.run("INSERT INTO messages (id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES ('m','c','owner','user','[]','pending',1,1)");
    await store.db.run("INSERT INTO deliveries(message_id,bot_id,status) VALUES ('m','bot','pending')"); await store.db.close();
    const fallback = await candidate(path.join(base, "old"), "0.1.499"), revision = await stageHostUpdate(state, source);
    await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    const db = await HubDatabase.snapshot(path.join(state, "hub.sqlite"));
    try { expect(await db.get("SELECT status FROM deliveries WHERE message_id='m'")).toEqual({ status: "pending" }); } finally { await db.close(); }
  });

  it("reports a failed backup without selecting a new executable or hiding its transaction", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state);
    const fallback = await candidate(path.join(base, "old"), "0.1.499"), revision = await stageHostUpdate(state, source);
    const { open } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.open).mockImplementation((...args) => {
      if (String(args[0]).includes(`${path.sep}recovery${path.sep}`) && String(args[0]).endsWith("identity.json") && args[1] === "wx") return Promise.reject(Object.assign(new Error("fixture_disk_full"), { code: "ENOSPC" }));
      return open(...args);
    });
    await expect(activateHostUpdate(state, revision.id, { currentEntrypoint: fallback })).rejects.toThrow("fixture_disk_full");
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(fallback);
    const status = await hostUpdateStatus(state); expect(status.incomplete).toHaveLength(1); expect(status.selected).toBeUndefined();
    await expect(readFile(path.join(status.incomplete[0]!.backupPath!, "manifest.json"))).rejects.toThrow();
  });

  it("does not consider changed compatibility metadata proof of downgrade safety", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state);
    const fallback = await candidate(path.join(base, "old"), "0.1.499"), revision = await stageHostUpdate(state, source);
    await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    const currentPath = path.join(await hostRuntimeDirectory(state), "current.json"), pointer = JSON.parse(await readFile(currentPath, "utf8"));
    pointer.current.maxHubSchema = 100; await writeFile(currentPath, JSON.stringify(pointer));
    await expect(resolveHostRuntime(state, fallback)).rejects.toThrow("host_update_invalid_selection");
  });

  it("validates the frozen Node binary as part of the revision before activation", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state);
    const fallback = await candidate(path.join(base, "old"), "0.1.499"), revision = await stageHostUpdate(state, source);
    await writeFile(revision.executable, "replaced Node executable");
    await expect(preflightHostUpdate(state, revision.id)).rejects.toThrow("host_update_revision_changed");
    await expect(activateHostUpdate(state, revision.id, { currentEntrypoint: fallback })).rejects.toThrow("host_update_revision_changed");
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(fallback);
  });

  it("handles interruption after pointer selection without guessing healthy status", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state);
    const fallback = await candidate(path.join(base, "old"), "0.1.499"), revision = await stageHostUpdate(state, source);
    const receipt = await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    const receiptPath = path.join(await hostRuntimeDirectory(state), "transactions", `${receipt.id}.json`);
    await writeFile(receiptPath, JSON.stringify({ ...receipt, state: "prepared" }));
    expect((await hostUpdateStatus(state)).transaction?.state).toBe("selected");
    expect((await resolveHostRuntime(state, fallback)).entrypoint).toBe(revision.entrypoint);
    const unknown = "11111111-1111-4111-8111-111111111111";
    await expect(markHostUpdateHealthy(state, unknown)).rejects.toThrow("host_update_selection_changed");
  });

  it("leaves workspace symlinks in place and explicitly excludes the whole workspace from update recovery", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state); await file(base, "external.txt", "private");
    await symlink(path.join(base, "external.txt"), path.join(state, "bots/bot_a/workspace/external"));
    const fallback = await candidate(path.join(base, "old"), "0.1.499"), revision = await stageHostUpdate(state, source);
    const receipt = await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    const manifest = JSON.parse(await readFile(path.join(receipt.backupPath!, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 2, scope: "host-state-without-workspaces" });
    expect(manifest.entries.some((entry: { path: string }) => entry.path.startsWith("bots/bot_a/workspace"))).toBe(false);
    expect(manifest.skipped).toContainEqual({ path: "bots/bot_a/workspace", type: "workspace", reason: "workspace_preserved_in_place_not_in_update_recovery" });
    expect(await fsPromises.readlink(path.join(state, "bots/bot_a/workspace/external"))).toBe(path.join(base, "external.txt"));
    expect(manifest.entries.some((entry: { path: string }) => entry.path === "external.txt")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("preserves DeepSeek home links and native filenames while recording omitted sockets and FIFOs", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state);
    await file(base, "dsh-private/profiles/default.yaml", "private engine settings"); await file(base, "dsh-private/.credentials.yaml", "private token"); await file(base, "dsh-private/AGENTS.md", "instructions");
    await fsPromises.mkdir(path.join(state, "bots/bot_a/dsh-home"));
    for (const name of ["profiles", ".credentials.yaml", "AGENTS.md"]) await symlink(path.join(base, "dsh-private", name), path.join(state, "bots/bot_a/dsh-home", name));
    await file(state, "bots/bot_a/sessions/report: final. ", "native name");
    const socketName = "bots/bot_a/sessions/watch-socket", fifoName = "bots/bot_a/sessions/events.fifo";
    const socket = net.createServer(); await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(path.join(state, socketName), resolve); });
    execFileSync("mkfifo", [path.join(state, fifoName)]);
    try {
      const fallback = await candidate(path.join(base, "old"), "0.1.499"), revision = await stageHostUpdate(state, source);
      const receipt = await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
      const manifest = JSON.parse(await readFile(path.join(receipt.backupPath!, "manifest.json"), "utf8"));
      for (const name of ["profiles", ".credentials.yaml", "AGENTS.md"]) {
        const member = `bots/bot_a/dsh-home/${name}`;
        expect(manifest.entries.find((entry: { path: string }) => entry.path === member)).toMatchObject({ type: "link", target: path.join(base, "dsh-private", name) });
        expect((await fsPromises.lstat(path.join(receipt.backupPath!, "state", member))).isSymbolicLink()).toBe(true);
      }
      expect(manifest.entries.some((entry: { path: string }) => entry.path.includes("profiles/default.yaml"))).toBe(false);
      expect(await readFile(path.join(receipt.backupPath!, "state/bots/bot_a/sessions/report: final. "), "utf8")).toBe("native name");
      expect(manifest.skipped).toEqual(expect.arrayContaining([{ path: socketName, type: "socket", reason: "ephemeral_special_file" }, { path: fifoName, type: "fifo", reason: "ephemeral_special_file" }]));
    } finally { await new Promise<void>(resolve => socket.close(() => resolve())); }
  });

  it.each(["activate", "rollback"] as const)("can %s away from a damaged current revision while status still reports every version", async operation => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499"); await candidate(source); await initialize(state);
    const healthy = await stageHostUpdate(state, path.join(base, "old")), broken = await stageHostUpdate(state, source);
    await activateHostUpdate(state, healthy.id, { currentEntrypoint: fallback }); await activateHostUpdate(state, broken.id, { currentEntrypoint: fallback });
    await rm(broken.executable);
    const status = await hostUpdateStatus(state);
    expect(status.selected?.revisionId).toBe(broken.id);
    expect(status.revisions).toContainEqual(expect.objectContaining({ id: broken.id, corrupt: true, error: expect.any(String) }));
    expect(status.revisions).toContainEqual(expect.objectContaining({ id: healthy.id, digest: healthy.digest }));
    const receipt = operation === "rollback" ? await rollbackHostUpdate(state, { currentEntrypoint: fallback }) : await activateHostUpdate(state, healthy.id, { currentEntrypoint: fallback });
    expect(receipt.before.revisionId).toBe(broken.id); expect(receipt.beforeError).toBeTruthy();
    expect((await resolveHostRuntime(state, fallback)).revisionId).toBe(healthy.id);
    expect((await hostUpdateStatus(state)).transaction?.beforeError).toBeTruthy();
  });

  it("reports damaged transaction metadata without hiding the selected runtime", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499"); await candidate(source); await initialize(state);
    const revision = await stageHostUpdate(state, source), receipt = await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    await writeFile(path.join(await hostRuntimeDirectory(state), "transactions", `${receipt.id}.json`), "broken json");
    const status = await hostUpdateStatus(state);
    expect(status.selected?.revisionId).toBe(revision.id); expect(status.errors).toContainEqual({ path: `transactions/${receipt.id}.json`, error: expect.any(String) });
    expect(status.revisions).toContainEqual(revision);
  });

  it("never enters a large workspace during online estimates or offline update snapshots and ignores non-Bot files", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499"); await candidate(source); await initialize(state);
    await file(state, "bots/.DS_Store", "finder data"); await file(state, "bots/README.txt", "not a Bot");
    await file(state, "bots/bot_a/sessions/continue.json", { session: "preserve" });
    const revision = await stageHostUpdate(state, source);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.readdir).mockImplementation(((...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]).includes(`${path.sep}workspace`)) throw new Error("workspace contains >100000 files: must never traverse");
      return actual.readdir(...args);
    }) as typeof actual.readdir);
    const estimate = await inspectHostUpdateRecovery(state);
    expect(estimate.entries).toBeLessThan(100); expect(estimate.unfinishedRuns).toEqual([]);
    await preflightHostUpdate(state, revision.id);
    const receipt = await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    expect(await readFile(path.join(receipt.backupPath!, "state/bots/bot_a/sessions/continue.json"), "utf8")).toContain("preserve");
    expect(await readFile(path.join(state, "bots/.DS_Store"), "utf8")).toBe("finder data");
    expect(await readFile(path.join(state, "bots/bot_a/workspace/notes.txt"), "utf8")).toBe("keep bot context");
    await expect(fsPromises.lstat(path.join(receipt.backupPath!, "state/bots/bot_a/workspace"))).rejects.toThrow();
  });

  it("refuses insufficient disk space before downtime and repeats that check offline", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499"); await candidate(source); await initialize(state);
    const revision = await stageHostUpdate(state, source), original = await readFile(path.join(state, "hub.sqlite"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.statfs).mockImplementation(async (...args) => ({ ...await actual.statfs(...args), bavail: 1n, bsize: 4096n }) as never);
    await expect(preflightHostUpdate(state, revision.id)).rejects.toThrow("host_update_insufficient_space");
    expect(await readFile(path.join(state, "hub.sqlite"))).toEqual(original);
    expect((await resolveHostRuntime(state, fallback)).revisionId).toBeUndefined();
    vi.mocked(fsPromises.statfs).mockImplementation(actual.statfs);
    await preflightHostUpdate(state, revision.id);
    vi.mocked(fsPromises.statfs).mockImplementation(async (...args) => ({ ...await actual.statfs(...args), bavail: 0n, bsize: 4096n }) as never);
    await expect(activateHostUpdate(state, revision.id, { currentEntrypoint: fallback })).rejects.toThrow("host_update_insufficient_space");
    expect((await resolveHostRuntime(state, fallback)).revisionId).toBeUndefined();
    expect(await readFile(path.join(state, "hub.sqlite"))).toEqual(original);
  });

  it("tolerates a child directory disappearing after online lstat but rejects the same race offline", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499"); await candidate(source); await initialize(state);
    const revision = await stageHostUpdate(state, source), relative = "bots/bot_a/sessions/expired";
    await file(state, `${relative}/session.json`, "temporary");
    const disappearing = await fsPromises.realpath(path.join(state, relative));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.readdir).mockImplementation((async (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]) === disappearing) await rm(disappearing, { recursive: true });
      return actual.readdir(...args);
    }) as typeof actual.readdir);
    expect((await inspectHostUpdateRecovery(state)).excluded).toContainEqual({ path: relative, type: "transient", reason: "disappeared_during_preflight" });
    await file(state, `${relative}/session.json`, "temporary");
    await expect(preflightHostUpdate(state, revision.id)).resolves.toMatchObject({ revisionId: revision.id });
    await file(state, `${relative}/session.json`, "temporary");
    await expect(activateHostUpdate(state, revision.id, { currentEntrypoint: fallback })).rejects.toMatchObject({ code: "ENOENT" });
    expect((await resolveHostRuntime(state, fallback)).revisionId).toBeUndefined();
  });

  it("checks engines against stage Node but resolves and activates a frozen pair independently of caller Node", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499"); await candidate(source); await initialize(state);
    const revision = await stageHostUpdate(state, source), descriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    Object.defineProperty(process.versions, "node", { ...descriptor, value: "18.0.0" });
    try {
      await expect(stageHostUpdate(state, source)).rejects.toThrow("host_update_node_too_old");
      await expect(preflightHostUpdate(state, revision.id)).resolves.toMatchObject({ revisionId: revision.id });
      await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
      expect((await resolveHostRuntime(state, fallback)).executable).toBe(revision.executable);
      expect(await listHostUpdates(state)).toEqual([revision]);
    } finally { Object.defineProperty(process.versions, "node", descriptor); }
  });
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("resolves a frozen ARM host for an x64 inspecting CLI on Apple Silicon", async () => {
    const { source, state } = await fixture(); await candidate(source); await initialize(state);
    const revision = await stageHostUpdate(state, source), descriptor = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { ...descriptor, value: "x64" });
    try { expect(await listHostUpdates(state)).toEqual([revision]); }
    finally { Object.defineProperty(process, "arch", descriptor); }
  });

  it("checks managed environment compatibility before downtime and again under the offline selection lock", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499"); await candidate(source); await initialize(state);
    const revision = await stageHostUpdate(state, source);
    const guard = vi.spyOn(serviceManager, "assertManagedServiceRuntimeCompatible").mockRejectedValue(new Error("host_service_runtime_environment_incompatible"));
    await expect(preflightHostUpdate(state, revision.id)).rejects.toThrow("host_service_runtime_environment_incompatible");
    expect(guard).toHaveBeenCalledWith(state, expect.objectContaining({ entrypoint: revision.entrypoint }));
    expect((await resolveHostRuntime(state, fallback)).revisionId).toBeUndefined();
    guard.mockResolvedValue(undefined);
    await preflightHostUpdate(state, revision.id);
    guard.mockImplementation(async () => {
      await expect(acquireInstanceLock(state)).rejects.toThrow("Instance lock already held");
      throw new Error("host_service_runtime_environment_incompatible");
    });
    await expect(activateHostUpdate(state, revision.id, { currentEntrypoint: fallback })).rejects.toThrow("host_service_runtime_environment_incompatible");
    expect((await resolveHostRuntime(state, fallback)).revisionId).toBeUndefined();
    expect((await hostUpdateStatus(state)).incomplete).toEqual([]);
  });

  it("prunes only explicitly named unused revisions, previews by default, and never follows content symlinks", async () => {
    const { base, source, state } = await fixture(); await candidate(source); await initialize(state); await file(base, "outside/keep.txt", "user content");
    const revision = await stageHostUpdate(state, source), location = path.dirname(revision.executable);
    await symlink(path.join(base, "outside"), path.join(location, "package/external"), process.platform === "win32" ? "junction" : undefined);
    const preview = await pruneHostUpdates(state, { revisionId: revision.id });
    expect(preview).toMatchObject({ dryRun: true, deleted: false, paths: [location], kind: "revision", id: revision.id });
    expect((await fsPromises.lstat(location)).isDirectory()).toBe(true);
    expect(await pruneHostUpdates(state, { revisionId: revision.id, yes: true })).toMatchObject({ deleted: true, dryRun: false });
    await expect(fsPromises.lstat(location)).rejects.toThrow();
    expect(await readFile(path.join(base, "outside/keep.txt"), "utf8")).toBe("user content");
    expect(await readFile(path.join(state, "bots/bot_a/workspace/notes.txt"), "utf8")).toBe("keep bot context");
  });

  it("keeps selected/previous runtimes and recent recovery, while explicitly pruning older v1 receipts safely", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499"); await candidate(source); await initialize(state);
    const first = await stageHostUpdate(state, path.join(base, "old")), second = await stageHostUpdate(state, source);
    const receipt1 = await activateHostUpdate(state, first.id, { currentEntrypoint: fallback });
    const receipt2 = await activateHostUpdate(state, second.id, { currentEntrypoint: fallback });
    for (const id of [first.id, second.id]) await expect(pruneHostUpdates(state, { revisionId: id, yes: true })).rejects.toThrow("host_update_prune_selected_revision");
    for (const transactionId of [receipt1.id, receipt2.id]) await expect(pruneHostUpdates(state, { transactionId, yes: true })).rejects.toThrow("host_update_prune_required_recovery");
    const root = await hostRuntimeDirectory(state), id = "11111111-1111-4111-8111-111111111111", backupPath = path.join(root, "recovery", id);
    await fsPromises.cp(receipt1.backupPath!, backupPath, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(backupPath, "manifest.json"), "utf8")); manifest.version = 1; delete manifest.scope;
    await file(backupPath, "manifest.json", manifest);
    await file(root, `transactions/${id}.json`, { ...receipt1, id, backupPath, createdAt: "2000-01-01T00:00:00.000Z" });
    await file(base, "private/keep.txt", "preserve"); await symlink(path.join(base, "private"), path.join(backupPath, "state/external"), process.platform === "win32" ? "junction" : undefined);
    expect(await pruneHostUpdates(state, { transactionId: id })).toMatchObject({ deleted: false, paths: [backupPath, path.join(root, `transactions/${id}.json`)] });
    expect(await pruneHostUpdates(state, { transactionId: id, yes: true })).toMatchObject({ deleted: true });
    expect(await readFile(path.join(base, "private/keep.txt"), "utf8")).toBe("preserve");
    expect((await hostUpdateStatus(state)).transaction?.id).toBe(receipt2.id);
  });

  it("refuses forged recovery ownership and symlinked cleanup roots", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499"); await candidate(source); await initialize(state);
    const revision = await stageHostUpdate(state, source), receipt = await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    const root = await hostRuntimeDirectory(state), id = "11111111-1111-4111-8111-111111111111", backupPath = path.join(root, "recovery", id);
    await file(base, "private/keep.txt", "preserve");
    await file(root, `transactions/${id}.json`, { ...receipt, id, backupPath: path.join(base, "private"), createdAt: "2000-01-01T00:00:00.000Z" });
    await expect(pruneHostUpdates(state, { transactionId: id, yes: true })).rejects.toThrow("host_update_receipt_outside_runtime");
    await file(root, `transactions/${id}.json`, { ...receipt, id, backupPath, createdAt: "2000-01-01T00:00:00.000Z" });
    await symlink(path.join(base, "private"), backupPath, process.platform === "win32" ? "junction" : undefined);
    await expect(pruneHostUpdates(state, { transactionId: id, yes: true })).rejects.toThrow("host_update_directory_not_regular");
    expect(await readFile(path.join(base, "private/keep.txt"), "utf8")).toBe("preserve");
  });

  it("rechecks protected selection only after acquiring the shared update mutex", async () => {
    const { source, state } = await fixture(); await candidate(source); await initialize(state);
    const revision = await stageHostUpdate(state, source), root = await hostRuntimeDirectory(state);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), locked = new Promise<void>(resolve => { entered = resolve; });
    const writer = withFileMutex(path.join(root, "update"), async () => {
      entered(); await gate;
      const runtime = { entrypoint: revision.entrypoint, executable: revision.executable, revisionId: revision.id, version: revision.version, minHubSchema: revision.minHubSchema, maxHubSchema: revision.maxHubSchema, runtimeId: revision.digest };
      await file(root, "current.json", { format: 1, transactionId: "11111111-1111-4111-8111-111111111111", current: runtime, previous: runtime });
    });
    await locked;
    const prune = pruneHostUpdates(state, { revisionId: revision.id, yes: true });
    const rejected = expect(prune).rejects.toThrow("host_update_prune_selected_revision");
    release(); await writer; await rejected;
    expect((await fsPromises.lstat(revision.executable)).isFile()).toBe(true);
  });

  it("can explicitly prune an interrupted prepared copy without requiring its unwritten manifest", async () => {
    const { base, source, state } = await fixture(); const fallback = await candidate(path.join(base, "old"), "0.1.499"); await candidate(source); await initialize(state);
    const revision = await stageHostUpdate(state, source), receipt = await activateHostUpdate(state, revision.id, { currentEntrypoint: fallback });
    const root = await hostRuntimeDirectory(state), id = "11111111-1111-4111-8111-111111111111", backupPath = path.join(root, "recovery", id);
    await file(backupPath, "state/partial.json", "partial");
    await file(root, `transactions/${id}.json`, { ...receipt, id, backupPath, state: "prepared" });
    expect(await pruneHostUpdates(state, { transactionId: id, yes: true })).toMatchObject({ deleted: true });
    await expect(fsPromises.lstat(backupPath)).rejects.toThrow();
    expect((await hostUpdateStatus(state)).transaction?.id).toBe(receipt.id);
  });
});

describe("frozen Node loader dependencies", () => {
  it.each([
    ["darwin", ["/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/Security.framework/Versions/A/Security"], "/opt/homebrew/opt/icu4c/lib/libicuuc.dylib"],
    ["linux", ["libstdc++.so.6", "libc.so.6", "libpthread.so.0"], "libnode.so.115"],
    ["win32", ["KERNEL32.dll", "api-ms-win-crt-runtime-l1-1-0.dll"], "libcrypto-3-x64.dll"],
  ] as const)("only accepts operating-system dependencies on %s", (platform, allowed, denied) => {
    expect(() => assertFrozenNodeLibraries([...allowed], platform)).not.toThrow();
    expect(() => assertFrozenNodeLibraries([...allowed, denied], platform)).toThrow("host_update_node_external_library");
  });

  function elf(library: string, rpath = false): Buffer {
    const bytes = Buffer.alloc(1024); bytes.write("7f454c46", 0, "hex"); bytes[4] = 2; bytes[5] = 1;
    bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(2, 56);
    bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(0n, 72); bytes.writeBigUInt64LE(0x400000n, 80); bytes.writeBigUInt64LE(1024n, 96);
    bytes.writeUInt32LE(2, 120); bytes.writeBigUInt64LE(256n, 128); bytes.writeBigUInt64LE(64n, 152);
    bytes.writeBigUInt64LE(5n, 256); bytes.writeBigUInt64LE(0x400200n, 264);
    bytes.writeBigUInt64LE(1n, 272); bytes.writeBigUInt64LE(0n, 280);
    if (rpath) { bytes.writeBigUInt64LE(29n, 288); bytes.writeBigUInt64LE(0n, 296); }
    bytes.write(library, 512); return bytes;
  }
  it("reads ELF dependency tables without executing a distribution's libnode launcher", async () => {
    const { base } = await fixture(); const executable = path.join(base, "node");
    await writeFile(executable, elf("libc.so.6")); await expect(inspectFrozenNodeDependencies(executable, "linux")).resolves.toBeUndefined();
    await writeFile(executable, elf("libnode.so.115")); await expect(inspectFrozenNodeDependencies(executable, "linux")).rejects.toThrow("host_update_node_external_library");
    await writeFile(executable, elf("libc.so.6", true)); await expect(inspectFrozenNodeDependencies(executable, "linux")).rejects.toThrow("host_update_node_external_loader_path");
    await writeFile(executable, elf("libc.so.6").subarray(0, 130)); await expect(inspectFrozenNodeDependencies(executable, "linux")).rejects.toThrow("host_update_invalid_node_elf");
  });

  function pe(library: string, delay = false): Buffer {
    const bytes = Buffer.alloc(1024); bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64);
    bytes.writeUInt16LE(1, 70); bytes.writeUInt16LE(240, 84); bytes.writeUInt16LE(0x20b, 88); bytes.writeUInt32LE(16, 196);
    bytes.writeUInt32LE(0x1000, 200 + (delay ? 13 : 1) * 8); bytes.writeUInt32LE(delay ? 64 : 40, 204 + (delay ? 13 : 1) * 8);
    bytes.writeUInt32LE(0x1000, 340); bytes.writeUInt32LE(512, 344); bytes.writeUInt32LE(512, 348);
    bytes.writeUInt32LE(0x1080, 512 + (delay ? 4 : 12)); if (delay) bytes.writeUInt32LE(1, 512); bytes.write(library, 640); return bytes;
  }
  it.each([false, true])("inspects Windows %s delayed imports before accepting an executable", async delay => {
    const { base } = await fixture(); const executable = path.join(base, "node.exe");
    await writeFile(executable, pe("KERNEL32.dll", delay)); await expect(inspectFrozenNodeDependencies(executable, "win32")).resolves.toBeUndefined();
    await writeFile(executable, pe("node.dll", delay)); await expect(inspectFrozenNodeDependencies(executable, "win32")).rejects.toThrow("host_update_node_external_library");
  });
});
