import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { HostCliError, LocalHostClient } from "../src/host-cli/client.js";
import * as botEndpoint from "../src/host-cli/bot-messages.js";
import { runTicketsCommand } from "../src/host-cli/tickets.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { hashSecret } from "../src/hub/auth.js";

let root: string, hub: HubServer, control: (() => Promise<void>) | undefined;
const secret = "secret-".repeat(8), receipt = () => undefined;
beforeEach(async () => {
  for (const key of ["TAROBOT_ACTIVE_INSTANCE", "TAROBOT_INSTANCE", "TAROBOT_ACTIVE_STATE_DIR", "TAROBOT_STATE_DIR", "TAROBOT_MESSAGE_ID"]) vi.stubEnv(key, undefined);
  root = await mkdtemp(path.join(os.tmpdir(), "tickets-cli-")); await initializeHost(root, "Local"); hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('planner','Planner',?,'claude','dispatcher')", [hashSecret(secret)]);
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('coder','Planner · Codex',?,'codex','worker')", [hashSecret(secret)]);
  hub.dispatch.workers = { engineAvailable: engine => engine === "codex", catalog: async () => ({ engines: [{ id: "codex", available: true, models: [{ id: "gpt-x", efforts: ["low"] }], defaultModel: "gpt-x", defaultEffort: "" }] }), dispatchWorker: async () => "coder", ticketWorkspace: async (_dispatcher, ticketId) => path.join(root, "tickets", ticketId) };
  control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(root, { enroll: true }); client.close();
});
afterEach(async () => { vi.unstubAllEnvs(); await control?.(); control = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });

it("lets the owner create, dispatch, inspect and control tickets by Bot name", async () => {
  await hub.store.createConversation("owner", ["planner"], "Planner", "home");
  const created: any = await runTicketsCommand(root, "create", undefined, { title: "Notes", text: "Summarize the notes", "request-id": "c1" }, receipt);
  const dispatched: any = await runTicketsCommand(root, "dispatch", created.id, { engine: "codex", model: "gpt-x", effort: "low", "request-id": "d1" }, receipt);
  expect(dispatched).toMatchObject({ status: "working", attempts: [{ botId: "coder", model: "gpt-x", effort: "low" }] });
  expect(await runTicketsCommand(root, "list", undefined, { open: true }, receipt)).toMatchObject({ tickets: [{ id: created.id, request: "Summarize the notes", attempts: [{ botId: "coder", model: "gpt-x" }] }], engines: [] });
  expect(await runTicketsCommand(root, "pause", created.id, { "request-id": "p1" }, receipt)).toMatchObject({ paused: true, status: "queued" });
  const settings: any = await runTicketsCommand(root, "settings", undefined, { "dispatch-mode": "auto", "max-concurrent": "3", allow: "codex,claude" }, receipt);
  expect(settings.settings).toEqual({ mode: "auto", maxConcurrent: 3, allowedEngines: ["codex", "claude"] });
  expect((await runTicketsCommand(root, "settings", undefined, { allow: "all" }, receipt) as any).settings).toEqual({ mode: "auto", maxConcurrent: 3 });
});

it("uses the dispatcher's own credential and active turn, and refuses owner-only controls", async () => {
  const home = await hub.store.createConversation("owner", ["planner"], "Planner", "home");
  const state = path.join(root, "bots", "planner"); await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "gateway.key"), secret, { mode: 0o600 }); await chmod(path.join(state, "gateway.key"), 0o600);
  const turn = await hub.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "turn", text: "Plan", attachments: [] });
  vi.stubEnv("TAROBOT_ACTIVE_INSTANCE", "planner"); vi.stubEnv("TAROBOT_ACTIVE_STATE_DIR", state); vi.stubEnv("TAROBOT_MESSAGE_ID", turn.message.id);
  await expect(runTicketsCommand(root, "create", undefined, { title: "T", text: "R", "request-id": "c1" }, receipt)).rejects.toThrow("dispatch_context_not_active");
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [turn.message.id]);
  const created: any = await runTicketsCommand(root, "create", undefined, { title: "T", text: "R", "request-id": "c1" }, receipt);
  expect(await runTicketsCommand(root, "targets", undefined, {}, receipt)).toMatchObject({ targets: [{ engine: "codex", installed: true, allowed: true, models: [{ id: "gpt-x" }] }] });
  expect(await runTicketsCommand(root, "dispatch", created.id, { engine: "codex", "request-id": "d1" }, receipt)).toMatchObject({ status: "working", attempts: [{ botId: "coder", engine: "codex" }] });
  expect(await runTicketsCommand(root, "list", undefined, {}, receipt)).toMatchObject({ tickets: [{ id: created.id, request: "R", attempts: [{ botId: "coder" }] }] });
  await expect(runTicketsCommand(root, "cancel", created.id, {}, receipt)).rejects.toThrow("只能由主人");
  await expect(runTicketsCommand(root, "remove", created.id, {}, receipt)).rejects.toThrow("只能由主人");
  await expect(runTicketsCommand(root, "list", undefined, { bot: "coder" }, receipt)).rejects.toThrow("不要传 --bot");
  await expect(runTicketsCommand(root, "dispatch", created.id, { engine: "vim", "request-id": "d2" }, receipt)).rejects.toThrow();
});

it("explains missing and rejected contexts without guessing a turn, retrying or creating tickets", async () => {
  const home = await hub.store.createConversation("owner", ["planner"], "Planner", "home");
  const state = path.join(root, "bots", "planner"); await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "gateway.key"), secret, { mode: 0o600 }); await chmod(path.join(state, "gateway.key"), 0o600);
  const turn = await hub.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "turn", text: "Plan", attachments: [] });
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [turn.message.id]);
  vi.stubEnv("TAROBOT_ACTIVE_INSTANCE", "planner"); vi.stubEnv("TAROBOT_ACTIVE_STATE_DIR", state);
  const notified = vi.fn();
  // Even with a live turn, the CLI must not infer its authority or read the file.
  const missing = await runTicketsCommand(root, "create", undefined, { title: "T", "text-file": "/missing/request.md" }, notified).catch(error => error);
  expect(missing).toMatchObject({ code: "dispatch_context_not_active", message: expect.stringContaining("--context-message") });
  expect(missing.message).toContain("未发送");
  expect(notified).not.toHaveBeenCalled();
  expect(await runTicketsCommand(root, "targets", undefined, {}, notified)).toMatchObject({ targets: [{ engine: "codex", installed: true }] });

  const options = { title: "T", text: "R", "request-id": "recover-context" };
  const rejected = await runTicketsCommand(root, "create", undefined, { ...options, "context-message": "msg_other" }, notified).catch(error => error);
  expect(rejected).toMatchObject({ code: "dispatch_context_not_active", status: 403, message: expect.stringContaining("--context-message") });
  expect(rejected.message).toContain("不是工单接口未启用");
  expect(rejected.message).toContain("不要直接启动引擎 CLI");
  expect((await runTicketsCommand(root, "list", undefined, {}, notified) as any).tickets).toEqual([]);
  const created: any = await runTicketsCommand(root, "create", undefined, { ...options, "context-message": turn.message.id }, notified);
  expect((await runTicketsCommand(root, "create", undefined, { ...options, "context-message": turn.message.id }, notified) as any).id).toBe(created.id);
  await hub.store.db.run("UPDATE deliveries SET status='done' WHERE message_id=?", [turn.message.id]);
  await expect(runTicketsCommand(root, "update", created.id, { status: "blocked", "context-message": turn.message.id }, notified)).rejects.toMatchObject({ code: "dispatch_context_not_active", status: 403 });
  expect((await runTicketsCommand(root, "show", created.id, {}, notified) as any).status).toBe("queued");
});

it.each([new HostCliError("cli_request_timeout"), new HostCliError("instance_unauthorized", 401), new HostCliError("dispatch_context_not_active", 500)])("preserves an unrelated or uncertain failure without replay: %s", async failure => {
  vi.stubEnv("TAROBOT_ACTIVE_INSTANCE", "planner");
  const post = vi.fn(async () => { throw failure; });
  const endpoint = vi.spyOn(botEndpoint, "instanceEndpoint").mockResolvedValue({ post });
  const notified = vi.fn();
  try {
    await expect(runTicketsCommand(root, "create", undefined, { title: "T", text: "R", "request-id": "keep-this-id", "context-message": "msg_turn" }, notified)).rejects.toBe(failure);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/instance/tickets", { operation: "create", contextMessage: "msg_turn", data: { title: "T", request: "R", requestId: "keep-this-id" } });
    expect(notified).toHaveBeenCalledExactlyOnceWith("keep-this-id");
  } finally { endpoint.mockRestore(); }
});

it("queries capability metadata through both owner and Bot CLI routes without a turn write", async () => {
  hub.dispatch.workers!.capabilities = async engine => ({ engine, workspace: null, generatedAt: new Date().toISOString(), runtime: "unverified", coverage: "partial", entries: [], sources: [], warnings: ["runtime_unverified", "partial_catalog"] });
  const result = await runTicketsCommand(root, "capabilities", undefined, { engine: "codex", match: "图 & notes", offset: "0" }, receipt);
  expect(result).toMatchObject({ engine: "codex", scope: "user", entries: [], total: 0 });
  const state = path.join(root, "bots", "planner"); await mkdir(state, { recursive: true }); await writeFile(path.join(state, "gateway.key"), secret, { mode: 0o600 });
  vi.stubEnv("TAROBOT_ACTIVE_INSTANCE", "planner"); vi.stubEnv("TAROBOT_ACTIVE_STATE_DIR", state);
  expect(await runTicketsCommand(root, "capabilities", undefined, { engine: "codex" }, receipt)).toMatchObject({ engine: "codex", runtime: "unverified", scope: "user" });
  await expect(runTicketsCommand(root, "capabilities", undefined, {}, receipt)).rejects.toThrow("--engine");
  await expect(runTicketsCommand(root, "capabilities", undefined, { engine: "codex", offset: "NaN" }, receipt)).rejects.toThrow();
  await expect(runTicketsCommand(root, "capabilities", undefined, { engine: "codex", bot: "coder" }, receipt)).rejects.toThrow("不要传 --bot");
  expect(await hub.store.db.get("SELECT 1 FROM dispatch_tickets")).toBeUndefined();
});

it("parses capability options through the real CLI entrypoint and rejects unrelated path input", async () => {
  const scan = vi.fn(async (engine: "codex" | "claude" | "kimi" | "deepseek" | "antigravity") => ({ engine, workspace: null, generatedAt: new Date().toISOString(), runtime: "unverified" as const, coverage: "partial" as const, entries: [], sources: [], warnings: [] }));
  hub.dispatch.workers!.capabilities = scan;
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runHostCli(["tickets", "capabilities", "--engine", "codex", "--match", "图 & text", "--offset", "40", "--state-dir", root, "--json"]);
    expect(scan).toHaveBeenCalledExactlyOnceWith("codex");
    expect(output.mock.calls.map(call => call.join(" ")).join("\n")).toContain('"offset": 40');
    const client = await LocalHostClient.connect(root);
    try { await expect(client.request("/api/bots/planner/dispatch-capabilities?engine=codex&path=/private")).rejects.toThrow(); } finally { client.close(); }
    expect(scan).toHaveBeenCalledTimes(1);
  } finally { output.mockRestore(); }
});


it("removes cancelled tickets through the owner CLI and retains show and request receipts", async () => {
  await hub.store.createConversation("owner", ["planner"], "Planner", "home");
  const created: any = await runTicketsCommand(root, "create", undefined, { title: "Done", text: "Keep my conversation", "request-id": "remove-cli-create" }, receipt);
  await runTicketsCommand(root, "cancel", created.id, { "request-id": "remove-cli-cancel" }, receipt);
  const received = vi.fn();
  const first = await runTicketsCommand(root, "remove", created.id, { "request-id": "remove-cli" }, received);
  expect(first).toMatchObject({ id: created.id, status: "cancelled" });
  expect(received).toHaveBeenCalledWith("remove-cli");
  expect(await runTicketsCommand(root, "remove", created.id, { "request-id": "remove-cli" }, receipt)).toEqual(first);
  expect(await runTicketsCommand(root, "list", undefined, {}, receipt)).toMatchObject({ tickets: [] });
  expect(await runTicketsCommand(root, "show", created.id, {}, receipt)).toEqual(first);
});
