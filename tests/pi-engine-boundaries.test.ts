import { expect, it } from "vitest";
import { createBotSchema } from "../src/client-protocol/bots.js";
import { dispatchTicketRequestSchema } from "../src/client-protocol/dispatch.js";
import { requestTicketAssistanceSchema } from "../src/client-protocol/dispatch-assistance.js";
import { applyEngineSelection } from "../src/state/instance-config.js";
import { buildEngineEnvironment, resolveEngineRuntime } from "../src/core/engine-factory.js";
it("offers Pi as an ordinary Bot and refuses Superagent creation and engine conversion", () => {
  const request = { requestId: "create", name: "Pi", engine: "pi", model: "", effort: "" };
  expect(createBotSchema.safeParse(request).success).toBe(true);
  expect(createBotSchema.safeParse({ ...request, role: "dispatcher" }).success).toBe(false);
  expect(createBotSchema.safeParse({ ...request, engine: "codex", role: "dispatcher" }).success).toBe(true);
  const config = { engine: "codex", role: "dispatcher", model: "original" };
  expect(() => applyEngineSelection(config, "pi")).toThrow("Pi is available for ordinary Bots, not Superagent Bots.");
  expect(config).toEqual({ engine: "codex", role: "dispatcher", model: "original" });
  expect(resolveEngineRuntime("pi", "normal")).toBe("rpc");
});
it("keeps Pi out of the Superagent dispatch and helper engine lists", () => {
  expect(dispatchTicketRequestSchema.safeParse({ requestId: "request", ticketId: "ticket", engine: "pi", model: "provider/model", effort: "" }).success).toBe(false);
  expect(requestTicketAssistanceSchema.safeParse({ requestId: "request", engine: "pi", model: "provider/model", effort: "", text: "Task", note: "Why" }).success).toBe(false);
});

it("preserves the selected native Pi agent directory at the worker boundary", () => {
  expect(buildEngineEnvironment({ PI_CODING_AGENT_DIR: "/fixture/pi" }, "gateway").PI_CODING_AGENT_DIR).toBe("/fixture/pi");
});
it("does not offer Pi when a Superagent opens the command settings card", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const path = await import("node:path"), os = await import("node:os");
  const { renderCoreConfigCard } = await import("../src/core/config-card.js");
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-role-"));
  try {
    const render = () => renderCoreConfigCard({ stateDir, conversationKey: "test", bridgeChatType: "private", larkChatId: "test", bridgeChatId: 1, locale: "en" });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", role: "dispatcher" }));
    expect(JSON.stringify(await render())).not.toContain('"value":"pi"');
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }));
    expect(JSON.stringify(await render())).toContain('"value":"pi"');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
it("factory uses the native Pi adapter and never falls through to Codex", async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const path = await import("node:path"), os = await import("node:os");
  const { createBridgeDependencies } = await import("../src/core/engine-factory.js");
  const { PiRpcAdapter } = await import("../src/codex/pi-rpc-adapter.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-factory-"));
  const state = path.join(root, "bot"); await mkdir(state);
  await writeFile(path.join(state, "config.json"), JSON.stringify({ engine: "pi" }));
  try {
    const { bridge } = await createBridgeDependencies({ HOME: root, CODEX_TELEGRAM_STATE_DIR: state, PI_EXECUTABLE: "/fixture/pi", PI_CODING_AGENT_DIR: path.join(root, "agent") }, { transport: "gateway" });
    const adapter = (bridge as unknown as { adapter: InstanceType<typeof PiRpcAdapter> }).adapter;
    expect(adapter).toBeInstanceOf(PiRpcAdapter);
    expect(adapter.turnRuntimeLimitMs).toBeNull();
    expect(adapter.supportsTurnScopedEnv).toBe(false);
    // The Host's own test for text it would act on is what keeps a command reply from being executed.
    const wired = (adapter as unknown as { options: { carriesHostDirectives?: (text: string) => boolean } }).options.carriesHostDirectives;
    expect(wired?.("[send-file:/synthetic/x.txt]")).toBe(true);
    expect(wired?.("nothing to act on")).toBe(false);
    await adapter.destroy();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["command", "card"] as const)("rejecting a Pi Superagent conversion via %s preserves all session bindings", async entry => {
  const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
  const path = await import("node:path"), os = await import("node:os");
  const { SessionStore } = await import("../src/state/session-store.js");
  const { handleCoreMessage } = await import("../src/core/message-handler.js");
  const { applyCoreConfigCardAction } = await import("../src/core/config-card.js");
  const { createCoreServiceRuntime } = await import("../src/core/runtime.js");
  const { withChannelProfile } = await import("../src/gateway/platform-profile.js");
  const { fakeChannel, fakeLarkMessage } = await import("./helpers/core-compat-fixtures.js");
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-chief-reject-"));
  const config = { engine: "codex", role: "dispatcher", locale: "en" };
  const sessions = new SessionStore(path.join(stateDir, "session.json"));
  try {
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify(config));
    await sessions.upsert({ telegramChatId: 1, conversationKey: "lark:oc_chat", codexSessionId: "original-session", status: "idle", updatedAt: new Date().toISOString() });
    const before = await sessions.load();
    // A forbidden selection can arrive from typed text or an old card. UI
    // hiding alone must not erase history before the config mutation rejects it.
    let reply = "";
    try {
      if (entry === "card") {
        reply = await applyCoreConfigCardAction(stateDir, { cctb_lark: "config", action: "engine", value: "pi", conversationKey: "lark:oc_chat", bridgeChatType: "private" }, "en");
      } else {
        const channel = fakeChannel();
        await withChannelProfile("gateway", () => handleCoreMessage({ stateDir, channel, runtime: createCoreServiceRuntime(),
          bridge: { checkAccess: async () => ({ kind: "allow" as const }), handleAuthorizedMessage: async () => { throw new Error("unexpected model invocation"); } },
          message: fakeLarkMessage({ messageId: "msg_pi_switch", content: "/engine pi" }),
        }));
        reply = JSON.stringify(channel.send.mock.calls);
      }
    } catch { /* Rejection may be returned or raised; neither may alter state. */ }
    expect(reply).toContain("Pi is available for ordinary Bots, not Superagent Bots.");
    expect(await sessions.load()).toEqual(before);
    expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"))).toEqual(config);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

it("the local config API rejects a Pi Superagent conversion without clearing bindings", async () => {
  const { mkdir, mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
  const path = await import("node:path"), os = await import("node:os");
  const { handleUiApiRequest } = await import("../src/ui/ui-api.js");
  const { SessionStore } = await import("../src/state/session-store.js");
  const home = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-chief-api-"));
  const stateDir = path.join(home, ".cctb", "fixture");
  const config = { engine: "codex", role: "dispatcher", locale: "en" };
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify(config));
    const sessions = new SessionStore(path.join(stateDir, "session.json"));
    await sessions.upsert({ telegramChatId: 1, conversationKey: "lark:oc_chat", codexSessionId: "original-session", status: "idle", updatedAt: new Date().toISOString() });
    const before = await sessions.load();
    const response = await handleUiApiRequest("POST", "/api/instances/fixture/config", { engine: "pi" }, { HOME: home });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.json)).toContain("Pi is available for ordinary Bots, not Superagent Bots.");
    expect(await sessions.load()).toEqual(before);
    expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"))).toEqual(config);
  } finally { await rm(home, { recursive: true, force: true }); }
});
it("the local config API keeps Pi model identity intact and rejects invalid pairs before writing", async () => {
  const { mkdir, mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
  const path = await import("node:path"), os = await import("node:os");
  const { handleUiApiRequest } = await import("../src/ui/ui-api.js");
  const home = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-config-model-"));
  const stateDir = path.join(home, ".cctb", "fixture");
  const config = { engine: "pi", model: "provider/model", locale: "en" };
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify(config));
    for (const model of ["bare-model", "%invalid/model", "provider/" + "x".repeat(512)]) {
      expect((await handleUiApiRequest("POST", "/api/instances/fixture/config", { model }, { HOME: home })).status).toBe(400);
      expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"))).toEqual(config);
    }
    for (const model of ["provider/org/model:latest", ""]) {
      expect((await handleUiApiRequest("POST", "/api/instances/fixture/config", { model }, { HOME: home })).status).toBe(200);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
