import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpRpcCommandError, OmpStartupError } from "../src/codex/omp-rpc-client.js";
import { OmpFrameError, OmpProtocolVersionError } from "../src/codex/omp-rpc-protocol.js";
import { buildEngineEnvironment } from "../src/core/engine-factory.js";
import { renderCoreUserFacingError } from "../src/core/errors.js";
import { handleCoreSimpleCommand, isCoreGoalControlCommand, tryHandleCoreGoalControlBeforeQueue } from "../src/core/commands.js";
import { applyCoreConfigCardAction, renderCoreConfigCard } from "../src/core/config-card.js";
import { handleLocalSessionCoreCommand } from "../src/core/shared/session-commands.js";
import { gatewayCommands } from "../src/gateway/commands.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { HostCliError } from "../src/host-cli/client.js";
import { buildHostEnvironment } from "../src/host-cli/environment.js";
import { explainPiModelRejection, piLevelArgumentError } from "../src/host-cli/pi-rejections.js";
import { assertManagedServiceRuntimeCompatible, OMP_STATE_CAPABILITY } from "../src/host-cli/service-manager.js";
import { engineStateFiles } from "../src/hub/model-catalog-cache.js";
import { readEngineCapabilities } from "../src/runtime/bot-capabilities.js";
import { classifyFailure, renderEngineSettingsError } from "../src/runtime/error-classification.js";
import { engineSettingsFile } from "../src/runtime/host-engine-settings.js";
import { ompAgentDir, resolveOmpExecutable } from "../src/runtime/omp-executable.js";
import * as engineProcess from "../src/runtime/engine-process.js";
import { permissionOptions } from "../src/state/permission-options.js";
import { loadInstanceConfig } from "../src/state/instance-config.js";
import { piModelSettingsRejectionText } from "../client/src/pi-rejection-text.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreNormalizedBridgeMessage } from "../src/core/message-normalizer.js";

const dirs: string[] = [];
async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function makeCoreMessage(text: string): CoreNormalizedBridgeMessage {
  return {
    channel: "feishu",
    chatId: "oc_test_1",
    messageId: "om_msg_1",
    senderId: "ou_owner_1",
    senderOpenId: "ou_owner_1",
    bridgeChatId: 1001,
    bridgeAccessChatId: 1001,
    bridgeUserId: 2001,
    bridgeChatType: "private",
    conversationKey: "lark:oc_test_1",
    text,
    attachments: [],
    mentions: [],
    mentionedBot: false,
  } as unknown as CoreNormalizedBridgeMessage;
}

function makeFakeChannel() {
  const sent: Array<{ chatId: string; text?: string; card?: Record<string, unknown> }> = [];
  return {
    sent,
    channel: {
      profile: "feishu" as const,
      send: vi.fn(async (chatId: string, payload: { text?: string; markdown?: string; card?: Record<string, unknown> }) => {
        sent.push({ chatId, text: payload.text ?? payload.markdown, card: payload.card });
        return { messageId: `msg_${sent.length}` };
      }),
      sendCard: vi.fn(async (chatId: string, card: Record<string, unknown>) => {
        sent.push({ chatId, card });
        return { messageId: `card_${sent.length}` };
      }),
      stream: vi.fn(),
    },
  };
}

describe("PR #134 parity & hardening: errors, Core/Feishu commands, discovery, compat fences, and UI copy", () => {
  it("Bug #17: classifies and renders OmpProtocolVersionError, OmpFrameError, OmpStartupError, and OmpRpcCommandError cleanly", () => {
    const protoErr = new OmpProtocolVersionError("Unsupported omp protocol version 99", 99, [99]);
    expect(classifyFailure(protoErr)).toBe("engine-cli");
    expect(renderCoreUserFacingError(protoErr, "engine", "en")).toMatch(/protocol version/i);
    expect(renderCoreUserFacingError(protoErr, "engine", "zh")).toContain("协议版本");

    const frameErr = new OmpFrameError("RPC frame exceeded 67108864 bytes");
    expect(classifyFailure(frameErr)).toBe("engine-cli");
    expect(renderCoreUserFacingError(frameErr, "engine", "en")).toMatch(/RPC frame/i);
    expect(renderCoreUserFacingError(frameErr, "engine", "zh")).toContain("通信帧");

    const missingExe = new OmpStartupError("omp executable was not found", "spawn");
    expect(classifyFailure(missingExe)).toBe("engine-cli");
    expect(renderCoreUserFacingError(missingExe, "engine", "en")).toMatch(/executable or working directory was not found/i);

    const costCap = new OmpRpcCommandError("prompt", "Session cost cap reached", "cost_cap");
    expect(classifyFailure(costCap)).toBe("engine-quota");
    expect(renderCoreUserFacingError(costCap, "engine", "en")).toMatch(/cost cap/i);

    const noModel = new OmpRpcCommandError("prompt", "No model configured", "no_model");
    expect(classifyFailure(noModel)).toBe("engine-settings");
    const noModelMsg = renderEngineSettingsError(noModel, "en");
    expect(noModelMsg).toContain("/login");
    expect(noModelMsg).not.toContain("pi auth login");

    const goalDisabled = new OmpRpcCommandError("goal", "RPC continuation disabled", "goal_continuation_disabled");
    expect(classifyFailure(goalDisabled)).toBe("engine-settings");
    expect(renderEngineSettingsError(goalDisabled, "en")).toMatch(/goal continuation/i);

    const authErr = new OmpRpcCommandError("prompt", "Unauthorized", "auth", { httpStatus: 401 });
    expect(classifyFailure(authErr)).toBe("auth");
    const authMsg = renderCoreUserFacingError(authErr, "engine", "en");
    expect(authMsg).toContain("/login");
    expect(authMsg).not.toContain("pi auth login");

    expect(classifyFailure(new OmpRpcCommandError("prompt", "Rate limited", "rate_limit", { httpStatus: 429 }))).toBe("engine-rate-limit");
    expect(classifyFailure(new OmpRpcCommandError("fork", "Busy", "session_busy"))).toBe("engine-busy");
    expect(classifyFailure(new OmpRpcCommandError("prompt", "Upstream 503", undefined, { httpStatus: 503 }))).toBe("engine-backend");
    const badReq = new OmpRpcCommandError("prompt", "Invalid payload", undefined, { httpStatus: 400 });
    expect(classifyFailure(badReq)).toBe("engine-request-rejected");
    expect(renderCoreUserFacingError(badReq, "engine", "en")).toMatch(/HTTP 400/);

    const unavailableModel = new Error("Invalid model selection: anthropic/missing is not available in omp.");
    expect(classifyFailure(unavailableModel)).toBe("engine-settings");
    expect(renderEngineSettingsError(unavailableModel, "en")).toContain("omp");
    expect(renderEngineSettingsError(unavailableModel, "en")).not.toContain("in Pi");
  });

  it("Bug #19: ompAgentDir, Windows omp.ps1 discovery, bot-capabilities, model-catalog-cache, and env overlays", async () => {
    const root = await tmpDir("omp-env-");
    const home = path.join(root, "home");
    const agentDir = path.join(home, ".omp", "agent");
    await mkdir(path.join(agentDir, "skills", "hello-skill"), { recursive: true });
    await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "node", args: ["srv.js"] } } }));
    await writeFile(path.join(agentDir, "skills", "hello-skill", "SKILL.md"), "---\nname: hello-skill\ndescription: Greets user\n---\nHello\n");

    // Default ~/.omp/agent resolution
    expect(ompAgentDir({}, home)).toBe(agentDir);
    // PI_CODING_AGENT_DIR overrides default
    expect(ompAgentDir({ PI_CODING_AGENT_DIR: "~/custom-agent" }, home)).toBe(path.join(home, "custom-agent"));
    // OMP_PROFILE supersedes PI_CODING_AGENT_DIR
    expect(ompAgentDir({ PI_CODING_AGENT_DIR: "~/custom-agent", OMP_PROFILE: "work" }, home)).toBe(path.join(home, ".omp", "profiles", "work", "agent"));
    // PI_CONFIG_DIR / OMP_CONFIG_DIR changes base root
    expect(ompAgentDir({ PI_CONFIG_DIR: path.join(root, "pi-root"), OMP_PROFILE: "dev" }, home)).toBe(path.join(root, "pi-root", "profiles", "dev", "agent"));

    // bot-capabilities scans ~/.omp/agent/mcp.json & skills
    const caps = await readEngineCapabilities("omp", { env: { HOME: home } });
    expect(caps.entries.some(e => e.kind === "mcp" && e.name === "docs")).toBe(true);
    expect(caps.entries.some(e => e.kind === "skill" && e.name === "hello-skill")).toBe(true);

    // model-catalog-cache uses ompAgentDir (respecting OMP_PROFILE)
    const stateFiles = engineStateFiles("omp", { HOME: home, OMP_PROFILE: "work" });
    expect(stateFiles.some(f => f === path.join(home, ".omp", "profiles", "work", "agent", "auth.json"))).toBe(true);

    // buildEngineEnvironment forwards omp env keys
    const childEnv = buildEngineEnvironment({
      OMP_EXECUTABLE: "/opt/bin/omp",
      PI_CONFIG_DIR: "~/custom-pi",
      OMP_CONFIG_DIR: "~/custom-omp",
      OMP_PROFILE: "work",
      PI_CODING_AGENT_SESSION_DIR: "rel/sessions",
    }, "gateway");
    expect(childEnv.OMP_EXECUTABLE).toBe("/opt/bin/omp");
    expect(childEnv.PI_CONFIG_DIR).toBe("~/custom-pi");
    expect(childEnv.OMP_CONFIG_DIR).toBe("~/custom-omp");
    expect(childEnv.OMP_PROFILE).toBe("work");
    expect(childEnv.PI_CODING_AGENT_SESSION_DIR).toBe("rel/sessions");

    // buildHostEnvironment preserves relative/tilde omp dirs & safe OMP_PROFILE, rejects traversal
    const hostEnv = buildHostEnvironment({
      platform: "darwin",
      home: "/synthetic/home",
      env: { PATH: "", PI_CONFIG_DIR: "~/pi-cfg", OMP_CONFIG_DIR: "./omp-cfg", OMP_PROFILE: "prod_1" },
    });
    expect(hostEnv.PI_CONFIG_DIR).toBe("~/pi-cfg");
    expect(hostEnv.OMP_CONFIG_DIR).toBe("./omp-cfg");
    expect(hostEnv.OMP_PROFILE).toBe("prod_1");
    expect(() => buildHostEnvironment({
      platform: "darwin",
      home: "/synthetic/home",
      env: { PATH: "", OMP_PROFILE: "../escape" },
    })).toThrow(/host_service_invalid_environment: OMP_PROFILE/);

    // Windows omp.ps1 candidate resolution
    const winProfile = "C:\\Synthetic\\Users\\dev";
    const winRoaming = `${winProfile}\\AppData\\Roaming`;
    const ps1Path = `${winRoaming}\\npm\\omp.ps1`;
    vi.spyOn(engineProcess, "resolveEngineExecutable").mockImplementation((cmd) => (cmd === ps1Path ? ps1Path : undefined));
    expect(resolveOmpExecutable({ PATH: "", USERPROFILE: winProfile, APPDATA: winRoaming }, "win32")).toBe(ps1Path);
  });

  it("Bug #4: service-manager enforces omp-state-v1 capability fence before rollback to older runtimes", async () => {
    const stateDir = await tmpDir("omp-fence-state-");
    const oldRuntimeDir = await tmpDir("omp-fence-old-");
    const newRuntimeDir = await tmpDir("omp-fence-new-");

    const ompBin = path.join(stateDir, "fake-omp");
    await writeFile(ompBin, "#!/bin/sh\nexit 0\n");
    await chmod(ompBin, 0o700);
    await writeFile(
      engineSettingsFile(stateDir),
      JSON.stringify({ format: 1, revision: "r1", paths: { omp: ompBin }, receipts: [] }),
      { mode: 0o600 },
    );

    await mkdir(path.join(oldRuntimeDir, "dist", "src"), { recursive: true });
    const oldEntry = path.join(oldRuntimeDir, "dist", "src", "index.js");
    await writeFile(oldEntry, "");
    await writeFile(path.join(oldRuntimeDir, "package.json"), JSON.stringify({
      tarobotHostCapabilities: ["service-extra-environment-v1", "pi-state-v1"],
    }));

    await mkdir(path.join(newRuntimeDir, "dist", "src"), { recursive: true });
    const newEntry = path.join(newRuntimeDir, "dist", "src", "index.js");
    await writeFile(newEntry, "");
    await writeFile(path.join(newRuntimeDir, "package.json"), JSON.stringify({
      tarobotHostCapabilities: ["service-extra-environment-v1", "pi-state-v1", OMP_STATE_CAPABILITY],
    }));

    await expect(assertManagedServiceRuntimeCompatible(stateDir, { entrypoint: oldEntry })).rejects.toThrow(/host_service_runtime_omp_state_incompatible/);
    await expect(assertManagedServiceRuntimeCompatible(stateDir, { entrypoint: newEntry })).resolves.toBeUndefined();
  });

  it("lists omp in top-level CLI help", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runHostCli(["--help"]);
      expect(output.mock.calls.flat().join("\n")).toMatch(/引擎：[^\n]*、omp[；。]/);
    } finally { output.mockRestore(); }
  });

  it("Bugs #7, #9, #10: Core/Feishu commands, config card, session resume/detach, goal controls, and gatewayCommands support omp", async () => {
    const stateDir = await tmpDir("omp-core-");
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "omp", locale: "en", approvalMode: "normal", budgetUsd: 5 }));

    // Config card shows omp for ordinary Bot and hides YOLO On
    const card = await renderCoreConfigCard({
      stateDir,
      conversationKey: "lark:oc_test_1",
      bridgeChatType: "private",
      larkChatId: "oc_test_1",
      bridgeChatId: 1001,
      locale: "en",
    });
    const cardJson = JSON.stringify(card);
    expect(cardJson).toContain('"value":"omp"');
    expect(cardJson).not.toContain('"YOLO On"');

    // applyCoreConfigCardAction blocks yolo "on" for omp
    const yoloRes = await applyCoreConfigCardAction(stateDir, {
      cctb_lark: "config",
      action: "yolo",
      value: "on",
      conversationKey: "lark:oc_test_1",
    }, "en");
    expect(yoloRes).toMatch(/omp does not provide sandboxed full-auto/i);
    expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")).approvalMode).toBe("normal");

    // Dispatcher rejects omp in config card
    const dispDir = await tmpDir("omp-disp-");
    await writeFile(path.join(dispDir, "config.json"), JSON.stringify({ engine: "codex", role: "dispatcher", locale: "en" }));
    const dispRes = await applyCoreConfigCardAction(dispDir, {
      cctb_lark: "config",
      action: "engine",
      value: "omp",
      conversationKey: "lark:oc_test_1",
    }, "en");
    expect(dispRes).toMatch(/Superagent/i);

    // Core commands: /model, /effort, /yolo, /engine, /status, /usage, /goal pause
    const runtime = createCoreServiceRuntime();
    const { channel, sent } = makeFakeChannel();
    const updateThreadGoal = vi.fn(async () => ({
      goal: {
        threadId: "omp_s1",
        objective: "Ship fixes",
        status: "paused" as const,
        tokenBudget: 10000,
        tokensUsed: 1200,
        timeUsedSeconds: 15,
      },
      sessionId: "omp_s1",
    }));
    const bridge = {
      handleAuthorizedMessage: vi.fn(),
      listExternalSessions: vi.fn(async () => [{ sessionId: "omp_ext_1", cwd: stateDir, title: "Work", updatedAt: new Date().toISOString() }]),
      validateExternalSession: vi.fn(async (id: string) => ({ sessionId: id, cwd: stateDir })),
      getThreadGoal: vi.fn(async () => ({
        goal: {
          threadId: "omp_s1",
          objective: "Ship fixes",
          status: "active" as const,
          tokenBudget: 10000,
          tokensUsed: 1200,
          timeUsedSeconds: 15,
        },
        sessionId: "omp_s1",
      })),
      updateThreadGoal,
      clearThreadGoal: vi.fn(async () => ({ cleared: true })),
    };

    const runCmd = async (text: string) => {
      sent.length = 0;
      await handleCoreSimpleCommand({
        channel: channel as never,
        bridge: bridge as never,
        runtime,
        stateDir,
        requestApproval: vi.fn(),
      }, makeCoreMessage(text), text);
      return sent.map(s => s.text ?? JSON.stringify(s.card ?? {})).join("\n");
    };

    // /model without args shows omp guidance, NOT agy models
    const modelHelp = await runCmd("/model");
    expect(modelHelp).toContain("oh-my-pi (omp)");
    expect(modelHelp).not.toContain("agy models");

    // /model rejects bare name without provider prefix
    const badModel = await runCmd("/model claude-sonnet-4-6");
    expect(badModel).toMatch(/provider prefix/i);

    // /model accepts provider/model
    const goodModel = await runCmd("/model anthropic/claude-sonnet-4-6");
    expect(goodModel).toContain("anthropic/claude-sonnet-4-6");
    expect((await loadInstanceConfig(stateDir)).model).toBe("anthropic/claude-sonnet-4-6");

    // /effort off saves "off" (does NOT delete!), /effort ultra rejected, /effort default clears
    vi.stubEnv("OMP_EXECUTABLE", path.join(stateDir, "no-such-omp-binary"));
    try {
      const effortOff = await runCmd("/effort off");
      expect(effortOff).toMatch(/off.*all of this Bot.s conversations/i);
      expect(await runCmd("/effort")).toMatch(/off.*all of this Bot.s conversations/i);
      expect((await loadInstanceConfig(stateDir)).effort).toBe("off");
      const effortUltra = await runCmd("/effort ultra");
      expect(effortUltra).toMatch(/omp thinking level supports only/i);
      expect(await runCmd("/effort default")).toMatch(/default.*all of this Bot.s conversations/i);
      expect((await loadInstanceConfig(stateDir)).effort).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }

    // /yolo on blocked for omp
    const yoloCmd = await runCmd("/yolo on");
    expect(yoloCmd).toMatch(/omp does not provide sandboxed full-auto/i);

    // /engine lists omp
    const engineList = await runCmd("/engine");
    expect(engineList).toContain("/engine omp");

    // /usage includes omp note (NOT Codex/Antigravity)
    const usageOut = await runCmd("/usage");
    expect(usageOut).toContain("omp reports usage and cost");
    expect(usageOut).not.toContain("Codex/Antigravity");

    // /goal pause works pre-queue for omp
    expect(isCoreGoalControlCommand("/goal pause")).toBe(true);
    const handledPreQueue = await tryHandleCoreGoalControlBeforeQueue({
      channel: channel as never,
      bridge: bridge as never,
      runtime,
      stateDir,
      requestApproval: vi.fn(),
    }, makeCoreMessage("/goal pause"), "/goal pause");
    expect(handledPreQueue).toBe(true);
    expect(updateThreadGoal).toHaveBeenCalledWith(expect.objectContaining({ status: "paused", origin: "user" }));

    // /resume & /detach in shared/session-commands.ts handle omp
    const messages: string[] = [];
    const sessionApi = { sendMessage: vi.fn(async (_chatId: number, text: string) => { messages.push(text); }) };
    const stored = new Map<string, { codexSessionId: string; resume?: unknown }>();
    const sessionStore = {
      inspect: async () => ({}),
      findByChatIdSafe: async () => ({ record: null }),
      findByConversationKeySafe: async (key: string) => ({ record: (stored.get(key) as never) ?? null }),
      removeByChatId: async () => false,
      removeByConversationKey: async (key: string) => stored.delete(key),
      upsert: async (rec: { conversationKey?: string; codexSessionId: string; resume?: unknown }) => {
        stored.set(rec.conversationKey ?? "k", { codexSessionId: rec.codexSessionId, resume: rec.resume });
      },
    };
    const resumed = await handleLocalSessionCoreCommand({
      stateDir,
      startedAt: Date.now(),
      locale: "en",
      cfg: { engine: "omp" },
      normalized: { chatId: 1001, userId: 2001, chatType: "private", conversationKey: "lark:oc_test_1", text: "/resume", attachments: [] },
      context: { api: sessionApi as never, instanceName: "test", updateId: 1 },
      sessionStore: sessionStore as never,
      updateInstanceConfig: async () => undefined,
      scanRecentOmpSessions: async () => [{ sessionId: "omp_ext_1", dirName: "omp_ext_1", workspacePath: stateDir, modifiedAt: new Date(), displayName: "Work" }],
    });
    expect(resumed).toBe(true);
    expect(messages.at(-1)).toContain("omp sessions:");

    stored.set("lark:oc_test_1", { codexSessionId: "omp_ext_1" });
    const detached = await handleLocalSessionCoreCommand({
      stateDir,
      startedAt: Date.now(),
      locale: "en",
      cfg: { engine: "omp" },
      normalized: { chatId: 1001, userId: 2001, chatType: "private", conversationKey: "lark:oc_test_1", text: "/detach", attachments: [] },
      context: { api: sessionApi as never, instanceName: "test", updateId: 2 },
      sessionStore: sessionStore as never,
      updateInstanceConfig: async () => undefined,
    });
    expect(detached).toBe(true);
    expect(messages.at(-1)).toContain("Detached from the current omp session");

    // gatewayCommands forwards omp advertised commands without shadowing host commands
    const cmds = gatewayCommands("omp", "", [
      { name: "compact", description: "Native compact (should not duplicate host /compact)" },
      { name: "review", description: "Run code review" },
    ]);
    expect(cmds.filter(c => c.command === "compact")).toHaveLength(1);
    expect(cmds.some(c => c.command === "review" && c.description.defaultValue === "Run code review")).toBe(true);
  });

  it("Bug #1 & #20: omp permission copy, client rejection copy, and Host CLI rejection copy are tailored to omp", () => {
    const ompNormal = permissionOptions("omp").find(o => o.id === "normal")!;
    expect(ompNormal.description).toContain("在写入、执行命令和扩展工具前询问");

    // Client rejection copy for omp mentions omp + /login, never pi auth login
    const clientNoCred = piModelSettingsRejectionText("model_unavailable", {
      engine: "omp",
      model: "openai/gpt-5",
      effort: "",
      choices: [{ id: "anthropic/claude-sonnet-4-6", provider: "anthropic", efforts: ["low", "high"] }],
    });
    expect(clientNoCred).toContain("omp");
    expect(clientNoCred).toContain("/login");
    expect(clientNoCred).not.toContain("pi auth login");

    const clientMissingModel = piModelSettingsRejectionText("model_unavailable", {
      engine: "omp",
      model: "anthropic/nonexistent",
      effort: "",
      choices: [{ id: "anthropic/claude-sonnet-4-6", provider: "anthropic", efforts: ["low", "high"] }],
    });
    expect(clientMissingModel).toContain("omp 的模型目录");
    expect(clientMissingModel).not.toContain("Pi 的模型目录");

    // Host CLI rejection copy for omp
    const levelErr = piLevelArgumentError("--effort", "ultra", "omp");
    expect(levelErr.message).toContain("omp");
    expect(levelErr.message).not.toContain("Pi");

    const cliErr = explainPiModelRejection(
      new HostCliError("model_unavailable", 400),
      {
        scope: "bot",
        engine: "omp",
        model: "",
        effort: "",
        choices: [{ id: "anthropic/claude-sonnet-4-6", provider: "anthropic", efforts: ["low", "high"] }],
        customEfforts: ["low", "high"],
        catalogStatus: "ready",
        revision: "r1",
        activeTurns: 0,
      },
      "openai/gpt-5",
      "",
    ) as Error;
    expect(cliErr.message).toContain("omp");
    expect(cliErr.message).toContain("/login");
    expect(cliErr.message).not.toContain("pi auth login");
  });
});
