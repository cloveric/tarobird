import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as service from "../src/hub/service.js";
import * as lifecycle from "../src/host-cli/lifecycle.js";
import * as manager from "../src/host-cli/service-manager.js";
import * as updates from "../src/host-cli/update.js";
import { HubDatabase } from "../src/hub/database.js";
import { HubStore } from "../src/hub/store.js";
import { desktopUpdateParentCommand, desktopUpdateSession } from "../src/hub/desktop-update.js";

let root: string, directory: string, entrypoint: string, running: boolean, restarted: boolean, count: number;
let ready: ReturnType<typeof vi.fn>, signal: AbortSignal;
const key = "retained-public-identity";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tarobot-desktop-update-"));
  directory = path.join(root, "state"); entrypoint = path.join(root, "runtime/dist/src/index.js");
  await mkdir(directory); await mkdir(path.dirname(entrypoint), { recursive: true });
  await writeFile(path.join(root, "runtime/package.json"), JSON.stringify({ version: "1.2.3" }));
  await writeFile(path.join(directory, "identity.json"), "retained identity");
  await writeFile(path.join(directory, "desktop-enabled.json"), "true\n");
  running = true; restarted = false; count = 4; ready = vi.fn(); signal = new AbortController().signal;
  vi.spyOn(updates, "resolveHostRuntime").mockResolvedValue({ entrypoint, executable: process.execPath });
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: false } as never);
  vi.spyOn(service, "inspectHubService").mockImplementation(async () => running ? { running: true, pid: restarted ? 2000000002 : 2000000001, publicKey: key, version: restarted ? "1.2.3" : "1.2.2", url: "http://127.0.0.1:1" } : { running: false });
  vi.spyOn(lifecycle, "waitForHostIdle").mockResolvedValue("update-test");
  vi.spyOn(lifecycle, "keepHostDrainLease").mockReturnValue({ stop: vi.fn(), check: vi.fn() });
  vi.spyOn(lifecycle, "captureDrainedStopGuard").mockResolvedValue({ drainId: "update-test", pid: 2000000001, publicKey: key });
  vi.spyOn(service, "hubServiceCommand").mockImplementation(async command => { if (command === "stop") running = false; if (command === "start") { running = true; restarted = true; } return {}; });
  vi.spyOn(HubDatabase, "snapshot").mockImplementation(async () => ({ get: async () => ({ count }), close: async () => undefined }) as unknown as HubDatabase);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const run = (finished: Promise<void | "retain-stopped"> = Promise.resolve()) => desktopUpdateSession({ directory, entrypoint, signal, ready, finished });

it("waits for existing work, stops the exact drained host, then restarts the new runtime with retained identity", async () => {
  let release!: (value: string) => void;
  vi.mocked(lifecycle.waitForHostIdle).mockReturnValue(new Promise(resolve => { release = resolve; }));
  const result = run();
  await vi.waitFor(() => expect(lifecycle.waitForHostIdle).toHaveBeenCalled());
  expect(ready).not.toHaveBeenCalled(); expect(service.hubServiceCommand).not.toHaveBeenCalled();
  release("update-test");
  await expect(result).resolves.toMatchObject({ restartedHost: true, identityPreserved: true, historyPreserved: true });
  expect(service.hubServiceCommand).toHaveBeenNthCalledWith(1, "stop", directory, entrypoint, { requireDrained: true, drainedStop: { drainId: "update-test", pid: 2000000001, publicKey: key } });
  expect(service.hubServiceCommand).toHaveBeenNthCalledWith(2, "start", directory, entrypoint);
  expect(await readFile(path.join(directory, "desktop-enabled.json"), "utf8")).toBe("true\n");
});
it("resumes the stopped host when the application closes its recovery pipe", async () => {
  let finish!: () => void;
  const result = run(new Promise(resolve => { finish = resolve; }));
  await vi.waitFor(() => expect(ready).toHaveBeenCalled());
  expect(running).toBe(false); finish();
  await result; expect(restarted).toBe(true);
});
it("an App that cannot confirm its installed bundle keeps the stopped host stopped", async () => {
  await expect(run(Promise.resolve("retain-stopped"))).resolves.toEqual({ retainedStoppedHost: true });
  expect(service.hubServiceCommand).toHaveBeenCalledTimes(1);
  expect(service.hubServiceCommand).toHaveBeenCalledWith("stop", directory, entrypoint, expect.objectContaining({ requireDrained: true }));
  expect(running).toBe(false); expect(restarted).toBe(false);
  expect(await readFile(path.join(directory, "desktop-enabled.json"), "utf8")).toBe("true\n");
});
it("the native parent protocol accepts exact commands only; anything else resumes like EOF", () => {
  expect(desktopUpdateParentCommand('{"command":"finish"}\n')).toBe("finish");
  expect(desktopUpdateParentCommand('{"command":"retain-stopped"}\n')).toBe("retain-stopped");
  for (const line of ['{"command":"retain"}\n', '{"command":"retain-stopped","x":1}\n', '{"command": "finish"}\n', "\n"]) expect(desktopUpdateParentCommand(line)).toBeUndefined();
});
it("cancellation or unanswered questions never force-stop active work", async () => {
  vi.mocked(lifecycle.waitForHostIdle).mockRejectedValue(new Error("pending question"));
  await expect(run()).rejects.toThrow("pending question");
  expect(service.hubServiceCommand).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled();
});
it("rejects a different host and releases only its own drain", async () => {
  vi.mocked(lifecycle.captureDrainedStopGuard).mockResolvedValue({ drainId: "update-test", pid: 2000000010, publicKey: key });
  await expect(run()).rejects.toThrow("desktop_update_host_changed");
  expect(service.hubServiceCommand).not.toHaveBeenCalled();
  expect(service.inspectHubService).toHaveBeenCalledWith(directory, "drain-cancel", { drainId: "update-test" });
});
it("leaves a configured CLI service running", async () => {
  vi.mocked(manager.managedServiceStatus).mockResolvedValue({ configured: true } as never);
  await expect(run()).resolves.toEqual({ retainedIndependentHost: true });
  expect(lifecycle.waitForHostIdle).not.toHaveBeenCalled(); expect(service.hubServiceCommand).not.toHaveBeenCalled();
});
it("also leaves an independently selected CLI runtime running without a service manager", async () => {
  vi.mocked(updates.resolveHostRuntime).mockResolvedValue({ entrypoint: "/separate/cli/index.js", executable: process.execPath });
  await expect(run()).resolves.toEqual({ retainedIndependentHost: true });
  expect(service.hubServiceCommand).not.toHaveBeenCalled();
});
it("does not enable a stopped host", async () => {
  running = false; await writeFile(path.join(directory, "desktop-enabled.json"), "false\n");
  await expect(run()).resolves.toEqual({ retainedStoppedHost: true });
  expect(service.hubServiceCommand).not.toHaveBeenCalled();
});
it("does not pause a running host when desktop hosting is disabled", async () => {
  await writeFile(path.join(directory, "desktop-enabled.json"), "false\n");
  await expect(run()).resolves.toEqual({ retainedIndependentHost: true });
  expect(lifecycle.waitForHostIdle).not.toHaveBeenCalled(); expect(service.hubServiceCommand).not.toHaveBeenCalled();
});
it("reports lost records instead of claiming a successful update", async () => {
  ready.mockImplementation(() => { count = 0; });
  await expect(run()).rejects.toThrow("desktop_update_history_changed");
});
it("reports a failed new host restart without rolling back its data", async () => {
  vi.mocked(service.hubServiceCommand).mockImplementation(async command => { if (command === "stop") running = false; if (command === "start") throw new Error("new runtime failed"); return {}; });
  await expect(run()).rejects.toThrow("new runtime failed");
  expect(await readFile(path.join(directory, "identity.json"), "utf8")).toBe("retained identity");
});
it("recovers a stop whose acknowledgement was lost after the process exited", async () => {
  vi.mocked(service.hubServiceCommand).mockImplementation(async command => {
    if (command === "stop") { running = false; throw new Error("pipe closed"); }
    running = true; restarted = true; return {};
  });
  await expect(run()).rejects.toThrow("pipe closed");
  expect(restarted).toBe(true); expect(ready).not.toHaveBeenCalled();
});
it("honors an explicit disable while paused without claiming a restart", async () => {
  let finish!: () => void;
  const result = run(new Promise(resolve => { finish = resolve; }));
  await vi.waitFor(() => expect(ready).toHaveBeenCalled());
  await writeFile(path.join(directory, "desktop-enabled.json"), "false\n");
  finish(); await expect(result).resolves.toEqual({ retainedStoppedHost: true });
  expect(restarted).toBe(false);
});

describe("ordinary macOS startup after a DMG replacement", () => {
  const safe = ["drain", "drain-renew", "drain-cancel", "drained-stop"];
  const proof = ["desktop-controller-challenge", "enroll-desktop-controller"];
  beforeEach(async () => {
    await writeFile(path.join(directory, "identity.json"), JSON.stringify({ publicKey: key, privateKey: "fixture-preserved" }));
    vi.mocked(service.inspectHubService).mockImplementation(async () => running ? {
      running: true, pid: restarted ? 2000000002 : 2000000001, publicKey: key,
      version: restarted ? "1.2.3" : "1.2.2", url: "http://127.0.0.1:1", drained: false,
      controlCapabilities: restarted ? [...safe, ...proof] : safe,
    } : { running: false });
  });
  const reconcile = () => desktopUpdateSession({ directory, entrypoint, signal, ready, finished: Promise.resolve(), timeoutMs: 1000, reconcileInstalled: true });
  it("hands off once and preserves bytes, rows and enabled intent without an installer", async () => {
    const original = await readFile(path.join(directory, "identity.json"));
    await expect(reconcile()).resolves.toMatchObject({ restartedHost: true, identityPreserved: true, historyPreserved: true });
    expect(await readFile(path.join(directory, "identity.json"))).toEqual(original);
    expect(JSON.parse(await readFile(path.join(directory, "desktop-runtime-recovery.json"), "utf8"))).toBeNull();
    await expect(reconcile()).resolves.toEqual({ retainedCurrentHost: true });
    expect(service.hubServiceCommand).toHaveBeenCalledTimes(2);
  });
  it.each(["host_drain_busy", "host_drain_owned"])("returns waiting on %s without stopping or writing an attempted switch", async code => {
    vi.mocked(lifecycle.waitForHostIdle).mockRejectedValue(Object.assign(new Error("fixture"), { code }));
    await expect(reconcile()).resolves.toEqual({ runtimeIssue: "runtime_waiting" });
    expect(service.hubServiceCommand).not.toHaveBeenCalled();
    await expect(readFile(path.join(directory, "desktop-runtime-recovery.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("waits without draining a pre-0.1.454 Host whose database shows live native background work", async () => {
    vi.mocked(lifecycle.waitForHostIdle).mockRestore(); vi.mocked(HubDatabase.snapshot).mockRestore();
    await writeFile(path.join(root, "runtime/package.json"), JSON.stringify({ version: "0.1.454" }));
    vi.mocked(service.inspectHubService).mockImplementation(async () => ({ running: true, pid: 2000000001, publicKey: key, version: "0.1.453", url: "http://127.0.0.1:1", drained: false, controlCapabilities: safe }));
    const store = await HubStore.open(directory);
    try {
      await store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('bot_c','Claude','00','claude',1)");
      await store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at) VALUES('conv_1','direct','c','owner',1)");
      await store.db.run("INSERT INTO conversation_members VALUES('conv_1','user','owner',0),('conv_1','bot','bot_c',0)");
      const card = { type: "card", elements: [{ type: "markdown", text: "subagent running" }], extra: { scopedRun: { id: "run_bg", phase: "working", startedAt: Date.now() - 1000, updatedAt: Date.now(), revision: 1 } } };
      await store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('msg_bg','conv_1','bot_c','bot',?,'complete',1,2)", [JSON.stringify([card])]);
      await expect(reconcile()).resolves.toEqual({ runtimeIssue: "runtime_waiting" });
    } finally { await store.db.close(); }
    expect(vi.mocked(service.inspectHubService).mock.calls.map(([, action]) => action ?? "status")).not.toContain("drain");
    expect(service.hubServiceCommand).not.toHaveBeenCalled();
    await expect(readFile(path.join(directory, "desktop-runtime-recovery.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["manager", "selected", "reported"])("does not replace an independent %s runtime", async mode => {
    if (mode === "manager") vi.mocked(manager.managedServiceStatus).mockResolvedValue({ configured: true } as never);
    if (mode === "selected") vi.mocked(updates.resolveHostRuntime).mockResolvedValue({ entrypoint: "/independent/index.js", executable: process.execPath });
    if (mode === "reported") vi.mocked(service.inspectHubService).mockResolvedValue({ running: true, pid: 2000000001, publicKey: key, version: "1.2.2", url: "http://127.0.0.1:1", supervisor: "launchd" });
    await expect(reconcile()).resolves.toEqual({ runtimeIssue: "runtime_update_required" });
    expect(lifecycle.waitForHostIdle).not.toHaveBeenCalled(); expect(service.hubServiceCommand).not.toHaveBeenCalled();
  });
  it("never stops a different identity", async () => {
    await writeFile(path.join(directory, "identity.json"), JSON.stringify({ publicKey: "another-host" }));
    await expect(reconcile()).rejects.toThrow("desktop_update_identity_changed");
    expect(service.hubServiceCommand).not.toHaveBeenCalled(); expect(lifecycle.waitForHostIdle).not.toHaveBeenCalled();
  });
  it("honors a disabled flag or runtime selection changed while waiting", async () => {
    vi.mocked(lifecycle.captureDrainedStopGuard).mockImplementation(async () => {
      await writeFile(path.join(directory, "desktop-enabled.json"), "false\n");
      return { drainId: "update-test", pid: 2000000001, publicKey: key };
    });
    await expect(reconcile()).rejects.toThrow("desktop_update_host_changed");
    expect(service.hubServiceCommand).not.toHaveBeenCalled();
    expect(service.inspectHubService).toHaveBeenCalledWith(directory, "drain-cancel", { drainId: "update-test" });
  });
  it("persists a failed switch so the old process is not restarted on every recovery timer", async () => {
    vi.mocked(service.hubServiceCommand).mockRejectedValue(new Error("fixture stop failed"));
    await expect(reconcile()).rejects.toThrow("fixture stop failed");
    vi.mocked(service.hubServiceCommand).mockClear();
    await expect(reconcile()).resolves.toEqual({ runtimeIssue: "runtime_recovery_failed" });
    expect(service.hubServiceCommand).not.toHaveBeenCalled();
  });
  it("rejects a replacement missing native verification instead of claiming success", async () => {
    vi.mocked(service.hubServiceCommand).mockImplementation(async action => {
      running = action === "start";
      if (running) vi.mocked(service.inspectHubService).mockResolvedValue({ running: true, pid: 2000000002, publicKey: key, version: "1.2.3", url: "http://127.0.0.1:1", controlCapabilities: safe });
      return {};
    });
    await expect(reconcile()).rejects.toThrow("desktop_update_restart_unconfirmed");
  });
  it("serializes concurrent windows and performs only one stop/start", async () => {
    const results = await Promise.all([reconcile(), reconcile()]);
    expect(results.filter(result => "restartedHost" in result)).toHaveLength(1);
    expect(results.filter(result => "retainedCurrentHost" in result)).toHaveLength(1);
    expect(service.hubServiceCommand).toHaveBeenCalledTimes(2);
  });
});
