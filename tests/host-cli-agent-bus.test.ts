import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgentBusCommand, type AgentBusCommandOptions } from "../src/host-cli/agent-bus.js";
import { HOST_CLI_HELP, runHostCli } from "../src/host-cli/cli.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { initializeHost } from "../src/host-cli/setup.js";
import type { AgentBusConfig, AgentBusRun, AgentBusWorkspace } from "../src/client-protocol/agent-bus.js";
import type { CollaborationSnapshot } from "../src/client-protocol/collaboration.js";
import { prepareCollaboration } from "../src/client-protocol/collaboration-prepare.js";
import { prepareCollaboration as clientPrepare } from "../client/src/collaboration-task.js";

const config: AgentBusConfig = {
  name: "设计评审", mode: "verify", coordinator: { botId: "coordinator" }, members: [{ botId: "reviewer" }],
  maxResearchQuestions: 5, maxRevisionRounds: 1,
};
const workspace: AgentBusWorkspace = {
  ...config, id: "bus-one", revision: "revision-one", coordinator: { botId: "coordinator", conversationId: "chat-one" },
  members: [{ botId: "reviewer", conversationId: "chat-two" }], createdAt: 100, updatedAt: 101,
};
const run: AgentBusRun = {
  id: "run-one", workspaceId: workspace.id, messageId: "message-one", status: "running", createdAt: 102,
  snapshot: { ...config, coordinator: workspace.coordinator, members: workspace.members },
  text: "逐项检查\n保留第二段", stages: [{ id: "stage-one", botId: "coordinator", conversationId: "chat-one", status: "running", startedAt: 102 }],
};
const detail = { workspace, runs: [run] };
let root: string, configFile: string, textFile: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-cli-"));
  configFile = path.join(root, "config.json"); textFile = path.join(root, "task.txt");
  await writeFile(configFile, JSON.stringify(config)); await writeFile(textFile, run.text);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("Agent Bus CLI requests", () => {
  it("routes all seven commands through the same management API and validates their payloads", async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [workspace] }).mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(workspace).mockResolvedValueOnce(workspace).mockResolvedValueOnce(run).mockResolvedValueOnce(run).mockResolvedValueOnce({ ok: true });
    const client = { request }, receipt = vi.fn();
    expect(await runAgentBusCommand(client, "list", undefined, {})).toEqual({ items: [workspace] });
    expect(await runAgentBusCommand(client, "show", workspace.id, {})).toEqual(detail);
    await runAgentBusCommand(client, "create", undefined, { from: configFile, "request-id": "create-one" }, receipt);
    await runAgentBusCommand(client, "update", workspace.id, { from: configFile, revision: workspace.revision });
    await runAgentBusCommand(client, "run", workspace.id, { "text-file": textFile, revision: workspace.revision, "request-id": "start-one" }, receipt);
    await runAgentBusCommand(client, "stop", workspace.id, { run: run.id, "request-id": "stop-one" }, receipt);
    expect(await runAgentBusCommand(client, "delete", workspace.id, { revision: workspace.revision, yes: true })).toEqual({ ok: true });
    expect(request.mock.calls).toEqual([
      ["/api/agent-buses"], ["/api/agent-buses/bus-one"],
      ["/api/agent-buses", "POST", { requestId: "create-one", config }],
      ["/api/agent-buses/bus-one", "PUT", { revision: workspace.revision, config }],
      ["/api/agent-buses/bus-one/runs", "POST", { requestId: "start-one", revision: workspace.revision, text: run.text }],
      ["/api/agent-buses/bus-one/runs/run-one/stop", "POST", { requestId: "stop-one" }],
      ["/api/agent-buses/bus-one", "DELETE", { revision: workspace.revision }],
    ]);
    expect(receipt.mock.calls).toEqual([["create-one"], ["start-one"], ["stop-one"]]);
  });

  it.each(["create", "run", "stop"])("prints a reusable ID before %s and never retries an uncertain response", async command => {
    const order: string[] = [], failure = new Error("cli_request_timeout");
    const request = vi.fn().mockImplementation(() => { order.push("request"); throw failure; });
    const receipts: string[] = [];
    const options: AgentBusCommandOptions = command === "create" ? { from: configFile } : command === "run" ? { "text-file": textFile, revision: workspace.revision } : { run: run.id };
    await expect(runAgentBusCommand({ request }, command, command === "create" ? undefined : workspace.id, options, id => { receipts.push(id); order.push("receipt"); })).rejects.toBe(failure);
    expect(order).toEqual(["receipt", "request"]); expect(request).toHaveBeenCalledTimes(1);
    expect(receipts[0]).toMatch(/^[a-f0-9-]{36}$/);
    const first = request.mock.calls[0];
    request.mockResolvedValue(command === "create" ? workspace : run);
    await runAgentBusCommand({ request }, command, command === "create" ? undefined : workspace.id, { ...options, "request-id": receipts[0] });
    expect(request.mock.calls[1]).toEqual(first);
  });

  it.each(["agent_bus_conflict", "agent_bus_busy"])("does not refresh or retry an update rejected with %s", async code => {
    const request = vi.fn().mockRejectedValue(new Error(code));
    await expect(runAgentBusCommand({ request }, "update", workspace.id, { from: configFile, revision: "old-revision" })).rejects.toThrow(code);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/agent-buses/bus-one", "PUT", { revision: "old-revision", config });
  });

  it("rejects invisible-only writes before dispatch while still reading legacy invisible names", async () => {
    const request = vi.fn().mockResolvedValue({ ...workspace, name: "\u200b" });
    await writeFile(configFile, JSON.stringify({ ...config, name: "\u200b" }));
    await writeFile(textFile, "\u200b\u200d\u2060");
    await expect(runAgentBusCommand({ request }, "create", undefined, { from: configFile })).rejects.toThrow("agent_bus_empty_name");
    await expect(runAgentBusCommand({ request }, "update", workspace.id, { from: configFile, revision: workspace.revision })).rejects.toThrow("agent_bus_empty_name");
    await expect(runAgentBusCommand({ request }, "run", workspace.id, { "text-file": textFile, revision: workspace.revision })).rejects.toThrow("agent_bus_empty_goal");
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({ items: [{ ...workspace, name: "\u200b" }] });
    expect((await runAgentBusCommand({ request }, "list", undefined, {}) as any).items[0].name).toBe("\u200b");
  });

  it("rejects malformed Hub responses without claiming success or replaying", async () => {
    const request = vi.fn().mockResolvedValue({ items: [{ ...workspace, coordinator: { botId: "coordinator" } }] });
    await expect(runAgentBusCommand({ request }, "list", undefined, {})).rejects.toThrow();
    request.mockResolvedValue({ ...run, status: "accepted" });
    await expect(runAgentBusCommand({ request }, "stop", workspace.id, { run: run.id })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves each historical run's snapshot when the workspace configuration has changed", async () => {
    const changed = { ...workspace, name: "新配置", mode: "ask", coordinator: { botId: "new-coordinator", conversationId: "new-chat" } };
    const response = { workspace: changed, runs: [{ ...run, status: "completed" }] };
    const request = vi.fn().mockResolvedValue(response);
    expect(await runAgentBusCommand({ request }, "show", workspace.id, {})).toEqual(response);
  });

  it.each(["missing", "coordinator", "member", "questions", "rounds", "duplicate"])("rejects a run with an incomplete or invalid %s snapshot", async problem => {
    const response: any = structuredClone(run);
    if (problem === "missing") delete response.snapshot;
    else if (problem === "coordinator") delete response.snapshot.coordinator.conversationId;
    else if (problem === "member") delete response.snapshot.members[0].conversationId;
    else if (problem === "questions") delete response.snapshot.maxResearchQuestions;
    else if (problem === "rounds") delete response.snapshot.maxRevisionRounds;
    else response.snapshot.members[0] = structuredClone(response.snapshot.coordinator);
    const request = vi.fn().mockResolvedValue(response);
    await expect(runAgentBusCommand({ request }, "run", workspace.id, { "text-file": textFile, revision: workspace.revision, "request-id": "snapshot-check" })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValue({ workspace, runs: [response] });
    await expect(runAgentBusCommand({ request }, "show", workspace.id, {})).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("requires IDs, command-specific options, revisions and explicit deletion confirmation before requests", async () => {
    const request = vi.fn();
    const invalid: [string | undefined, string | undefined, AgentBusCommandOptions][] = [
      [undefined, undefined, {}], ["constructor", undefined, {}], ["unknown", undefined, {}],
      ["list", workspace.id, {}], ["create", workspace.id, { from: configFile }], ["list", undefined, { revision: "rev" }],
      ["show", undefined, {}], ["show", "../escape", {}], ["show", "name with spaces", {}], ["show", "bus?query=1", {}],
      ["show", workspace.id, { "request-id": "unused" }], ["create", undefined, { from: configFile, "request-id": "../../id" }],
      ["update", workspace.id, { from: configFile }], ["update", workspace.id, { from: configFile, revision: "rev", yes: true }],
      ["run", workspace.id, { "text-file": textFile }], ["run", workspace.id, { "text-file": textFile, revision: "../rev" }],
      ["stop", workspace.id, {}], ["stop", workspace.id, { run: "../run" }], ["stop", workspace.id, { run: run.id, revision: "rev" }],
      ["delete", workspace.id, { revision: "rev" }], ["delete", workspace.id, { yes: true }],
    ];
    for (const [command, id, options] of invalid) await expect(runAgentBusCommand({ request }, command, id, options)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects duplicate members, wrong mode cardinality and unexpected config keys", async () => {
    const request = vi.fn();
    const invalid = [
      { ...config, coordinator: { botId: "coordinator", conversationId: "same" }, members: [{ botId: "coordinator", conversationId: "same" }] },
      { ...config, mode: "fan", members: [{ botId: "reviewer", conversationId: "same" }, { botId: "reviewer", conversationId: "same" }] },
      { ...config, mode: "crew" }, { ...config, mode: "fan", members: [{ botId: "../bot" }] },
      { ...config, id: workspace.id }, { ...config, maxRevisionRounds: 4 },
    ];
    for (const value of invalid) {
      await writeFile(configFile, JSON.stringify(value));
      await expect(runAgentBusCommand({ request }, "create", undefined, { from: configFile })).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects symlinks, directories, oversized, invalid UTF-8 and empty input without sending", async () => {
    const request = vi.fn(), link = path.join(root, "link.txt"), directory = path.join(root, "directory");
    await symlink(textFile, link); await mkdir(directory);
    for (const file of [link, directory, path.join(root, "missing"), "\0invalid", " "]) {
      await expect(runAgentBusCommand({ request }, "run", workspace.id, { "text-file": file, revision: workspace.revision })).rejects.toThrow();
    }
    for (const value of [Buffer.from([0xff, 0xfe, 0]), Buffer.from([0xc3, 0x28]), Buffer.alloc(0), Buffer.from(" \n "), Buffer.from("x".repeat(48_001)), Buffer.alloc(192_001, 120)]) {
      await writeFile(textFile, value);
      await expect(runAgentBusCommand({ request }, "run", workspace.id, { "text-file": textFile, revision: workspace.revision })).rejects.toThrow();
    }
    for (const value of ["{invalid", "null", "x".repeat(65_537)]) {
      await writeFile(configFile, value);
      await expect(runAgentBusCommand({ request }, "create", undefined, { from: configFile })).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });
});

describe("tarobot bus entry point", () => {
  it("uses the existing local controller, emits JSON and closes each one-shot session", async () => {
    await initializeHost(root, "CLI fixture");
    const request = vi.fn().mockResolvedValue(detail), close = vi.fn();
    const connect = vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ request, close } as unknown as LocalHostClient);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runHostCli(["bus", "show", workspace.id, "--state-dir", root]);
    expect(connect).toHaveBeenCalledExactlyOnceWith(await realpath(root), {});
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/agent-buses/bus-one");
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(detail); expect(close).toHaveBeenCalledTimes(1);
    expect(HOST_CLI_HELP).toContain("bus run ID --text-file FILE --revision REV");
    expect(HOST_CLI_HELP).toContain("bus stop ID --run RUN_ID");
  });

  it("routes create/run/stop/delete flags, prints request IDs to stderr and retains JSON-only stdout", async () => {
    await initializeHost(root, "CLI fixture");
    const request = vi.fn().mockResolvedValueOnce(workspace).mockResolvedValueOnce(run).mockResolvedValueOnce(run).mockResolvedValueOnce({ ok: true }), close = vi.fn();
    vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ request, close } as unknown as LocalHostClient);
    const log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cli = (args: string[]) => runHostCli(["bus", ...args, "--state-dir", root, "--json"]);
    await cli(["create", "--from", configFile, "--request-id", "create-cli"]);
    await cli(["run", workspace.id, "--text-file", textFile, "--revision", workspace.revision, "--request-id", "run-cli"]);
    await cli(["stop", workspace.id, "--run", run.id, "--request-id", "stop-cli"]);
    await cli(["delete", workspace.id, "--revision", workspace.revision, "--yes"]);
    expect(log.mock.calls.map(call => JSON.parse(call[0] as string))).toEqual([workspace, run, run, { ok: true }]);
    expect(error.mock.calls.map(call => call[0])).toEqual([expect.stringContaining("create-cli"), expect.stringContaining("run-cli"), expect.stringContaining("stop-cli")]);
    expect(request.mock.calls[1]).toEqual(["/api/agent-buses/bus-one/runs", "POST", { requestId: "run-cli", revision: workspace.revision, text: run.text }]);
    expect(request.mock.calls[2]).toEqual(["/api/agent-buses/bus-one/runs/run-one/stop", "POST", { requestId: "stop-cli" }]);
    expect(request.mock.calls[3]).toEqual(["/api/agent-buses/bus-one", "DELETE", { revision: workspace.revision }]);
    expect(close).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["show", "one", "two"], ["list", "unexpected"], ["create", "unexpected", "--from", "file"],
    ["show", "one", "--json", "--json"], ["show", "one", "--state-dir", "first", "--state-dir=second"],
    ["run", "one", "--revision", "first", "--revision=second"],
    ["run", "one", "--text-file", "first", "--text-file=second"],
    ["stop", "one", "--run", "first", "--run=second"],
    ["create", "--from", "first", "--from=second"],
    ["run", "one", "--request-id", "first", "--request-id=second"],
    ["delete", "one", "--yes", "--yes"], ["list", "--force"], ["list", "--unknown"],
    ["prepare", "unexpected"], ["prepare", "--coordinator", "one", "--coordinator=two"],
    ["prepare", "--members", "one", "--members=two"], ["permissions", "one", "two"],
  ])("rejects ambiguous CLI arguments %j before connecting", async (...args) => {
    const connect = vi.spyOn(LocalHostClient, "connect");
    await expect(runHostCli(["bus", ...args])).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it("surfaces an unavailable Hub without starting a daemon or retrying the connection", async () => {
    await initializeHost(root, "CLI fixture");
    const connect = vi.spyOn(LocalHostClient, "connect").mockRejectedValue(new Error("hub_not_running"));
    await expect(runHostCli(["bus", "list", "--state-dir", root])).rejects.toThrow("hub_not_running");
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

function permissionFixture() {
  const data = new Map<string, CollaborationSnapshot>(["coordinator", "reviewer", "writer", "existing"].map(id => [id, {
    revision: "a".repeat(64), listener: "offline",
    settings: { enabled: id === "coordinator", peers: id === "coordinator" ? ["existing"] : [], maxDepth: 3, parallel: [], chain: [], verifier: null, crew: null },
    peers: ["coordinator", "reviewer", "writer", "existing"].filter(peer => peer !== id).map(id => ({ id, name: id, online: true, allowsThisBot: false, listener: "offline" })),
  }]));
  const request = vi.fn(async (route: string, method = "GET", body?: any): Promise<any> => {
    const id = route.split("/")[3]!;
    if (route.endsWith("/restart")) return { ok: true, result: { text: "已安排空闲后重启" } };
    if (method === "PUT") data.set(id, { ...data.get(id)!, settings: body.settings });
    return structuredClone(data.get(id));
  });
  return { data, request };
}

describe("Agent Bus collaboration permissions", () => {
  it("keeps the browser wrapper on the exact shared preparation algorithm", () => { expect(clientPrepare).toBe(prepareCollaboration); });

  it("prepares repeated roles once per remote Bot and never grants self access", async () => {
    const { data, request } = permissionFixture();
    await runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer,coordinator,reviewer", yes: true });
    expect(data.get("coordinator")!.settings.peers).toEqual(["existing", "reviewer"]);
    expect(data.get("reviewer")!.settings.peers).toEqual(["coordinator"]);
    expect(request.mock.calls.filter(call => call[0].endsWith("/restart"))).toHaveLength(2);
    request.mockClear();
    data.get("coordinator")!.settings = { ...data.get("coordinator")!.settings, enabled: false, peers: "*" };
    await runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "coordinator,coordinator", yes: true });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/bots/coordinator/collaboration", "GET", undefined);
    expect(data.get("coordinator")!.settings.enabled).toBe(false);
  });

  it("reads and validates a selected Bot's permissions through the shared API", async () => {
    const { data, request } = permissionFixture();
    expect(await runAgentBusCommand({ request }, "permissions", "reviewer", {})).toEqual(data.get("reviewer"));
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/bots/reviewer/collaboration");
    request.mockResolvedValue({ settings: { enabled: true } });
    await expect(runAgentBusCommand({ request }, "permissions", "reviewer", {})).rejects.toThrow();
  });

  it("requires explicit authorization, unique Bot IDs and command-specific flags before reading", async () => {
    const request = vi.fn();
    const invalid: AgentBusCommandOptions[] = [
      { coordinator: "coordinator", members: "reviewer" }, { members: "reviewer", yes: true },
      { coordinator: "../coordinator", members: "reviewer", yes: true },
      { coordinator: "coordinator", members: "reviewer,", yes: true },
      { coordinator: "coordinator", members: "*", yes: true },
      { coordinator: "coordinator", members: "reviewer", yes: true, revision: "unused" },
      { coordinator: "coordinator", members: "reviewer", yes: true, "request-id": "../bad" },
    ];
    for (const options of invalid) await expect(runAgentBusCommand({ request }, "prepare", undefined, options)).rejects.toThrow();
    await expect(runAgentBusCommand({ request }, "permissions", "../bot", {})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("adds only coordinator-member pairs, preserves defaults and existing grants, and never sends work", async () => {
    const { data, request } = permissionFixture(), defaults = structuredClone(data.get("coordinator")!.settings), untouched = structuredClone(data.get("existing"));
    data.get("writer")!.listener = "online";
    const receipt = vi.fn();
    const result: any = await runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer,writer", yes: true, "request-id": "prepare-one" }, receipt);
    expect(request.mock.calls.slice(0, 3).map(call => call[0])).toEqual(["/api/bots/coordinator/collaboration", "/api/bots/reviewer/collaboration", "/api/bots/writer/collaboration"]);
    expect(data.get("coordinator")!.settings).toEqual({ ...defaults, enabled: true, peers: ["existing", "reviewer", "writer"] });
    expect(data.get("reviewer")!.settings.peers).toEqual(["coordinator"]); expect(data.get("writer")!.settings.peers).toEqual(["coordinator"]);
    expect(data.get("existing")).toEqual(untouched);
    expect(result).toMatchObject({ requestId: "prepare-one", permissionsPrepared: true, taskSent: false });
    expect(result.restarts.map((value: any) => value.botId)).toEqual(["coordinator", "reviewer"]);
    expect(result.restarts.every((value: any) => value.accepted === true && /^bus_prepare_[a-f0-9]{64}$/.test(value.receiptId))).toBe(true);
    expect(request.mock.calls.every(call => /^\/api\/bots\/(coordinator|reviewer|writer)\/(collaboration|restart)$/.test(call[0]))).toBe(true);
    expect(receipt).toHaveBeenCalledExactlyOnceWith("prepare-one");
  });

  it("preserves an already configured wildcard without granting it to another participant", async () => {
    const { data, request } = permissionFixture(); data.get("coordinator")!.settings.peers = "*"; data.get("coordinator")!.settings.enabled = true;
    await runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer", yes: true });
    expect(data.get("coordinator")!.settings.peers).toBe("*"); expect(data.get("reviewer")!.settings.peers).toEqual(["coordinator"]);
  });

  it("does not activate a dormant wildcard while authorizing only the selected pair", async () => {
    const { data, request } = permissionFixture(); data.get("coordinator")!.settings.peers = "*"; data.get("coordinator")!.settings.enabled = false;
    await expect(runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer", yes: true })).rejects.toThrow("collaboration_disabled_wildcard_requires_review");
    expect(data.get("coordinator")!.settings.enabled).toBe(false);
    expect(request.mock.calls.every(call => !call[1] || call[1] === "GET")).toBe(true);
  });

  it.each(["coordinator", "reviewer", "writer"])("does not enable dormant unrelated grants on %s", async id => {
    const { data, request } = permissionFixture();
    data.get(id)!.settings.enabled = false;
    data.get(id)!.settings.peers = id === "coordinator" ? ["existing"] : ["coordinator", id === "reviewer" ? "writer" : "reviewer"];
    await expect(runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer,writer", yes: true })).rejects.toThrow("collaboration_disabled_peers_requires_review");
    expect(request.mock.calls.every(call => !call[1] || call[1] === "GET")).toBe(true);
    expect(data.get(id)!.settings.enabled).toBe(false);
  });

  it("can enable dormant grants wholly inside each participant's selected pairs", async () => {
    const { data, request } = permissionFixture();
    data.get("coordinator")!.settings = { ...data.get("coordinator")!.settings, enabled: false, peers: ["reviewer"] };
    data.get("reviewer")!.settings.peers = ["coordinator"];
    await runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer,writer", yes: true });
    expect(data.get("coordinator")!.settings.peers).toEqual(["reviewer", "writer"]);
    for (const id of ["reviewer", "writer"]) expect(data.get(id)!.settings).toMatchObject({ enabled: true, peers: ["coordinator"] });
  });

  it.each(["malformed", "changed", "unknown"])("stops before further changes when a permission save returns %s state", async state => {
    const { request } = permissionFixture(), delegate = request.getMockImplementation()!;
    request.mockImplementation(async (route, method, body) => {
      const response = await delegate(route, method, body);
      if (method !== "PUT") return response;
      if (state === "malformed") return { ok: true };
      if (state === "changed") return { ...response, settings: { ...response.settings, enabled: false } };
      return { ...response, listener: "unknown" };
    });
    await expect(runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer", yes: true })).rejects.toThrow();
    expect(request.mock.calls.filter(call => call[1] === "PUT")).toHaveLength(1);
    expect(request.mock.calls.filter(call => call[0].endsWith("/restart"))).toHaveLength(0);
  });

  it("uses the confirmed save's listener status instead of restarting an already connected service", async () => {
    const { request } = permissionFixture(), delegate = request.getMockImplementation()!;
    request.mockImplementation(async (route, method, body) => {
      const response = await delegate(route, method, body);
      return method === "PUT" ? { ...response, listener: "online" } : response;
    });
    const result: any = await runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer", yes: true });
    expect(result.restarts).toEqual([]);
  });

  it("rejects an unsupported Hub without probing other routes or changing permission", async () => {
    const request = vi.fn().mockRejectedValue(new Error("not_found"));
    await expect(runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer", yes: true })).rejects.toThrow("not_found");
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/bots/coordinator/collaboration", "GET", undefined);
  });

  it.each(["unknown", "missing", "malformed", "revision", "unreadable"])("fails closed before any write when a participant is %s", async problem => {
    const { data, request } = permissionFixture(), delegate = request.getMockImplementation()!;
    if (problem === "unknown") data.get("reviewer")!.listener = "unknown";
    if (problem === "missing") data.get("reviewer")!.peers = [];
    if (problem === "malformed") (data.get("reviewer")!.settings as any).enabled = "true";
    if (problem === "revision") data.get("reviewer")!.revision = "legacy-unversioned";
    if (problem === "unreadable") request.mockImplementation(async (route, method, body) => { if (route.includes("/reviewer/")) throw new Error("bot_forbidden"); return delegate(route, method, body); });
    await expect(runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer", yes: true })).rejects.toThrow();
    expect(request.mock.calls.every(call => !call[1] || call[1] === "GET")).toBe(true);
  });

  it("retains confirmed additive grants on conflict and does not restart partially prepared services", async () => {
    const { data, request } = permissionFixture(), delegate = request.getMockImplementation()!;
    request.mockImplementation(async (route, method, body) => { if (route.includes("/reviewer/") && method === "PUT") throw new Error("collaboration_conflict"); return delegate(route, method, body); });
    await expect(runAgentBusCommand({ request }, "prepare", undefined, { coordinator: "coordinator", members: "reviewer", yes: true })).rejects.toThrow("collaboration_conflict");
    expect(data.get("coordinator")!.settings.peers).toEqual(["existing", "reviewer"]);
    expect(data.get("reviewer")!.settings.enabled).toBe(false);
    expect(request.mock.calls.filter(call => call[0].endsWith("/restart"))).toHaveLength(0);
  });

  it("recovers a lost permission-save response with fresh CAS reads and preserves intervening settings", async () => {
    const { data, request } = permissionFixture(), delegate = request.getMockImplementation()!;
    let loseResponse = true, revision = 0;
    request.mockImplementation(async (route, method, body) => {
      const id = route.split("/")[3]!;
      if (method === "PUT") {
        if (body.revision !== data.get(id)!.revision) throw new Error("collaboration_conflict");
        await delegate(route, method, body);
        data.get(id)!.revision = (++revision).toString(16).padStart(64, "0");
        if (loseResponse) { loseResponse = false; throw new Error("cli_request_timeout"); }
        return structuredClone(data.get(id));
      }
      return delegate(route, method, body);
    });
    const options = { coordinator: "coordinator", members: "reviewer", yes: true, "request-id": "save-recover" };
    await expect(runAgentBusCommand({ request }, "prepare", undefined, options)).rejects.toThrow("cli_request_timeout");
    expect(request.mock.calls.filter(call => call[1] === "PUT")).toHaveLength(1);
    expect(request.mock.calls.filter(call => call[0].endsWith("/restart"))).toHaveLength(0);
    data.get("coordinator")!.settings.maxDepth = 7;
    data.get("coordinator")!.revision = "f".repeat(64);
    await runAgentBusCommand({ request }, "prepare", undefined, options);
    expect(data.get("coordinator")!.settings.maxDepth).toBe(7);
    expect(request.mock.calls.filter(call => call[1] === "PUT").map(call => call[0])).toEqual(["/api/bots/coordinator/collaboration", "/api/bots/reviewer/collaboration"]);
  });

  it("reuses restart receipts across CLI invocations after a lost response or an accepted busy restart", async () => {
    const { request } = permissionFixture(), delegate = request.getMockImplementation()!;
    const accepted = new Set<string>(); let loseFirstResponse = true;
    request.mockImplementation(async (route, method, body) => {
      if (route.endsWith("/restart")) {
        accepted.add(body.receiptId);
        if (loseFirstResponse) { loseFirstResponse = false; throw new Error("cli_request_timeout"); }
      }
      return delegate(route, method, body);
    });
    const options = { coordinator: "coordinator", members: "reviewer", yes: true, "request-id": "prepare-recover" };
    await expect(runAgentBusCommand({ request }, "prepare", undefined, options)).rejects.toThrow("cli_request_timeout");
    expect(accepted.size).toBe(1);
    expect(request.mock.calls.filter(call => call[0].endsWith("/restart"))).toHaveLength(1);
    const second: any = await runAgentBusCommand({ request }, "prepare", undefined, options);
    const third: any = await runAgentBusCommand({ request }, "prepare", undefined, options);
    expect(accepted.size).toBe(2); expect(third.restarts).toEqual(second.restarts);
    expect(request.mock.calls.filter(call => call[1] === "PUT")).toHaveLength(2);
  });

  it("does not retry a rejected or unconfirmed restart and retains the same receipt for inspection", async () => {
    const { request } = permissionFixture(), delegate = request.getMockImplementation()!;
    request.mockImplementation(async (route, method, body) => route.endsWith("/restart") ? { ok: false, error: "bot_worker_stopping" } : delegate(route, method, body));
    const options = { coordinator: "coordinator", members: "reviewer", yes: true, "request-id": "prepare-busy" };
    await expect(runAgentBusCommand({ request }, "prepare", undefined, options)).rejects.toThrow("bot_worker_stopping");
    expect(request.mock.calls.filter(call => call[0].endsWith("/restart"))).toHaveLength(1);
    await expect(runAgentBusCommand({ request }, "prepare", undefined, options)).rejects.toThrow("bot_worker_stopping");
    const restarts = request.mock.calls.filter(call => call[0].endsWith("/restart"));
    expect(restarts[1]).toEqual(restarts[0]);
  });

  it("routes CLI prepare and permissions through the existing controller with reviewable JSON output", async () => {
    await initializeHost(root, "Preparation fixture");
    const { request } = permissionFixture(), close = vi.fn();
    vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ request, close } as unknown as LocalHostClient);
    const log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runHostCli(["bus", "prepare", "--coordinator", "coordinator", "--members", "reviewer", "--yes", "--request-id", "prepare-cli", "--state-dir", root]);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ requestId: "prepare-cli", permissionsPrepared: true, taskSent: false });
    expect(error.mock.calls[0]![0]).toContain("prepare-cli");
    await runHostCli(["bus", "permissions", "coordinator", "--state-dir", root]);
    expect(JSON.parse(log.mock.calls[1]![0] as string).settings.peers).toEqual(["existing", "reviewer"]);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
