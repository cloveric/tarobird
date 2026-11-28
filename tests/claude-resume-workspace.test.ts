import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blocksText } from "../src/client-protocol/index.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { handleCoreCardAction } from "../src/core/card-actions.js";
import { buildCoreCronExecutor } from "../src/core/cron.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../src/core/message-normalizer.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { attachGateway } from "../src/gateway/service.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { Bridge } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { CronStore } from "../src/state/cron-store.js";
import { FileWorkflowStore } from "../src/state/file-workflow-store.js";
import { SessionStore } from "../src/state/session-store.js";
import { fakeChannel, fakeLarkMessage } from "./helpers/core-compat-fixtures.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

type ClaudeSpawn = NonNullable<NonNullable<ConstructorParameters<typeof ClaudeStreamAdapter>[1]>["spawnFn"]>;

const cli = `
const { createInterface } = require("node:readline");
const args = process.argv.slice(1);
const resume = args[args.indexOf("-r") + 1];
const send = frame => console.log(JSON.stringify({ session_id: resume, ...frame }));
send({ type: "system", subtype: "init" });
createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
    send({ type: "control_request", request_id: "fixture-tools", request: {
      subtype: "mcp_message", server_name: "tarocub_app", message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    } });
    return;
  }
  if (frame.type !== "user") return;
  if (JSON.stringify(frame.message).includes("Hold this fixture turn")) {
    send({ type: "assistant", message: { content: [{ type: "text", text: "Fixture turn started" }] } });
    return;
  }
  send({ type: "result", subtype: "success", result: "CLI cwd: " + process.cwd() });
});
`;

describe("engine turns for a Claude /resume binding", () => {
  let root: string;
  let adapter: ClaudeStreamAdapter | undefined;

  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "claude-resume-workspace-")); });
  afterEach(async () => {
    vi.mocked(stat).mockReset();
    try { await adapter?.destroy(); } finally {
      adapter = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  async function setup(configureBot = true, saved = path.join(root, "saved"), engine = "claude") {
    const stateDir = path.join(root, "bot");
    const configPath = path.join(stateDir, "config.json");
    const managed = path.join(stateDir, "workspace");
    const configured = path.join(root, "configured");
    const pinned = path.join(root, "pinned");
    await Promise.all([mkdir(managed, { recursive: true }), mkdir(configured), mkdir(pinned)]);
    await writeFile(configPath, JSON.stringify({
      engine,
      locale: "en",
      ...(configureBot ? { workspacePath: configured } : {}),
    }));
    const sessionId = randomUUID();
    const resume = { sessionId, dirName: "saved-project", workspacePath: saved };
    const message = fakeLarkMessage();
    const conversationKey = buildCoreConversationKey(message.chatId);
    const store = new SessionStore(path.join(stateDir, "session.json"));
    const suspendedPrevious = { sessionId: randomUUID(), resume: null };
    await store.upsert({
      telegramChatId: stableCoreNumericId(conversationKey), conversationKey, codexSessionId: sessionId, resume, suspendedPrevious,
      updatedAt: new Date().toISOString(), status: "idle",
    });
    const launches = vi.fn<ClaudeSpawn>((command, args, options) =>
      spawn(command, ["-e", cli, "--", ...args], { ...options, stdio: ["pipe", "pipe", "pipe"] }));
    adapter = new ClaudeStreamAdapter(process.execPath, {
      childEnv: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, "claude-profile") },
      workspacePath: managed,
      configPath,
      historyHelper: null,
      spawnFn: launches,
    });
    const bridge = new Bridge({
      load: async () => ({ policy: "allowlist", multiChat: false, allowlist: [], pairedUsers: [], pendingPairs: [] }),
      issuePairingCode: vi.fn(),
    }, new SessionManager(store, adapter), adapter).createAuthenticatedSurface();
    const channel = {
      ...fakeChannel(), profile: "gateway" as const,
      conversationWorkspace: vi.fn<NonNullable<import("../src/core/types.js").CoreChannelLike["conversationWorkspace"]>>(),
      inConversation: <T>(_id: string, operation: () => T) => withChannelProfile("gateway", operation),
    };
    const runtime = createCoreServiceRuntime();

    async function send(workspaceOverride?: string, explicit?: string, content = "Continue the session") {
      const sent = { ...message, messageId: randomUUID(), content, workspaceOverride };
      return withChannelProfile("gateway", () => handleCoreMessage({
        channel, bridge, runtime, stateDir, message: sent, workspaceOverride: explicit,
      }));
    }

    const reply = () => JSON.stringify([...channel.send.mock.calls, ...channel.updateCard.mock.calls]);

    async function expectLaunch(cwd: string, delivered = reply, key = conversationKey) {
      expect(launches).toHaveBeenCalled();
      const [, args, options] = launches.mock.lastCall!;
      expect(options?.cwd).toBe(cwd);
      expect(args.slice(args.indexOf("-r"), args.indexOf("-r") + 2)).toEqual(["-r", sessionId]);
      expect(args).not.toContain("--session-id");
      expect(delivered()).toContain("CLI cwd: " + await realpath(cwd));
      await expect(store.findByConversationKey(key)).resolves.toMatchObject({
        codexSessionId: sessionId, resume, suspendedPrevious,
      });
    }

    return { stateDir, saved, pinned, configured, managed, launches, reply, send, expectLaunch, store, conversationKey, bridge, channel, runtime, message };
  }

  it("falls back to the pinned workspace and uses the original workspace again when it returns", async () => {
    const fixture = await setup();
    await fixture.send(fixture.pinned);
    await fixture.expectLaunch(fixture.pinned);
    await mkdir(fixture.saved);
    await fixture.send(fixture.pinned);
    await fixture.expectLaunch(fixture.saved);
    expect(fixture.launches).toHaveBeenCalledTimes(2);
  });

  it.each(["direct", "group pinned", "group default", "group unavailable"] as const)(
    "uses the bound workspace through the Hub and Gateway (%s)", async (kind) => {
    const fixture = await setup();
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), host: "127.0.0.1", port: 0 });
    let gateway: GatewayChannel | undefined;
    try {
      const secret = randomBytes(32).toString("base64url");
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('fixture','Fixture',?,'claude')", [hashSecret(secret)]);
      gateway = await attachGateway({
        url: hub.instanceUrl.replace(/^http/, "ws") + "/instance",
        botId: "fixture", secret, stateDir: fixture.stateDir, engine: "claude",
        bridge: fixture.bridge, runtime: createCoreServiceRuntime(), recoverDeliveries: false,
      });
      await vi.waitFor(async () => expect((await hub.store.bots("owner"))[0]?.online).toBe(1));
      const sessionChat = await hub.store.createConversation("owner", ["fixture"], "Fixture chat", "fixture-chat", {
        type: "direct", ...(kind !== "group default" ? { workspacePath: fixture.pinned } : {}),
      });
      const original = (await fixture.store.findByConversationKey(fixture.conversationKey))!;
      const conversationKey = buildCoreConversationKey(sessionChat.id);
      await fixture.store.removeByConversationKey(fixture.conversationKey);
      await fixture.store.upsert({ ...original, conversationKey });
      const otherWorkspace = path.join(root, "group-workspace");
      await mkdir(otherWorkspace);
      let conversation = sessionChat;
      let groupRecordKey: string | undefined;
      if (kind !== "direct") {
        await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('other','Other',?,'codex')", [hashSecret(randomBytes(32).toString("base64url"))]);
        conversation = await hub.store.createConversation("owner", ["other"], "Fixture group", "fixture-group", {
          type: "group", workspacePath: otherWorkspace,
        });
        await hub.crossHostGroups.addMember("owner", conversation.id, {
          botId: "fixture", sessionId: sessionChat.id, historyVisibility: { kind: "none" },
        });
        groupRecordKey = buildCoreConversationKey(conversation.id);
        const groupSessionId = randomUUID();
        await fixture.store.upsert({
          ...original, conversationKey: groupRecordKey, codexSessionId: groupSessionId,
          resume: { sessionId: groupSessionId, dirName: "group-project", workspacePath: otherWorkspace },
        });
      }
      const untouchedGroup = groupRecordKey ? await fixture.store.findByConversationKey(groupRecordKey) : undefined;
      if (kind === "group unavailable") await rm(fixture.pinned, { recursive: true });

      await hub.store.sendMessage("owner", {
        conversationId: conversation.id, clientMsgId: "fixture-message", text: "Continue the session", attachments: [],
        ...(kind !== "direct" ? { mentions: ["fixture"] } : {}),
      });
      await vi.waitFor(async () => {
        const snapshot = await hub.store.snapshot("owner", conversation.id);
        const text = snapshot.messages.filter(message => message.authorType === "bot").map(message => blocksText(message.blocks)).join("\n");
        if (kind === "group unavailable") {
          expect(text).toContain("choose a valid workspace folder");
          expect(fixture.launches).not.toHaveBeenCalled();
          await expect(fixture.store.findByConversationKey(conversationKey)).resolves.toEqual({ ...original, conversationKey });
        } else {
          await fixture.expectLaunch(kind === "group default" ? fixture.configured : fixture.pinned, () => text, conversationKey);
        }
      }, { timeout: 3000 });
      if (kind !== "group unavailable") expect(fixture.launches).toHaveBeenCalledOnce();

      if (kind === "group pinned") {
        await mkdir(fixture.saved);
        await hub.store.sendMessage("owner", {
          conversationId: conversation.id, clientMsgId: "restored-workspace-message",
          text: "Continue in the restored workspace", attachments: [], mentions: ["fixture"],
        });
        await vi.waitFor(async () => {
          const snapshot = await hub.store.snapshot("owner", conversation.id);
          const text = snapshot.messages.filter(message => message.authorType === "bot").map(message => blocksText(message.blocks)).join("\n");
          await fixture.expectLaunch(fixture.saved, () => text, conversationKey);
        }, { timeout: 3000 });
        expect(fixture.launches).toHaveBeenCalledTimes(2);
      }

      if (groupRecordKey) {
        await expect(fixture.store.findByConversationKey(groupRecordKey)).resolves.toEqual(untouchedGroup);
      }
    } finally {
      await gateway?.disconnect();
      await hub.close();
    }
  });

  it.each([true, false])("uses the Bot workspace rule without a pinned workspace (configured: %s)", async (configureBot) => {
    const fixture = await setup(configureBot);
    await fixture.send();
    await fixture.expectLaunch(configureBot ? fixture.configured : fixture.managed);
    expect(fixture.launches).toHaveBeenCalledOnce();
  });

  it("uses a valid saved directory ahead of a pinned workspace", async () => {
    const fixture = await setup();
    await mkdir(fixture.saved);
    await fixture.send(fixture.pinned);
    await fixture.expectLaunch(fixture.saved);
  });

  it("treats a file at the saved path as a missing workspace directory", async () => {
    const fixture = await setup();
    await writeFile(fixture.saved, "not a directory");
    await fixture.send(fixture.pinned);
    await fixture.expectLaunch(fixture.pinned);
  });

  it("uses the managed workspace when normal turn preparation recreates it", async () => {
    const fixture = await setup(false);
    await rm(fixture.managed, { recursive: true });
    await fixture.send();
    await fixture.expectLaunch(fixture.managed);
  });

  it.each(["pinned", "configured"] as const)("reports an unavailable %s fallback without starting Claude", async (kind) => {
    const fixture = await setup();
    const before = await fixture.store.findByConversationKey(fixture.conversationKey);
    await rm(fixture[kind], { recursive: true });
    await fixture.send(kind === "pinned" ? fixture.pinned : undefined);
    expect(fixture.launches).not.toHaveBeenCalled();
    expect(fixture.reply()).toContain("choose a valid workspace folder");
    await expect(fixture.store.findByConversationKey(fixture.conversationKey)).resolves.toEqual(before);
  });

  it("preserves an explicit runtime override even when the saved directory is available", async () => {
    const fixture = await setup();
    await mkdir(fixture.saved);
    await fixture.send(fixture.pinned, fixture.configured);
    await fixture.expectLaunch(fixture.configured);
  });

  it("reports a missing explicit runtime override without falling back", async () => {
    const fixture = await setup();
    const explicit = path.join(root, "explicit");
    await fixture.send(fixture.pinned, explicit);
    expect(fixture.launches).not.toHaveBeenCalled();
    expect(fixture.reply()).toContain("choose a valid workspace folder");
  });

  it("does not treat an I/O error on the saved path as a missing directory", async () => {
    const fixture = await setup();
    const before = await fixture.store.findByConversationKey(fixture.conversationKey);
    const { stat: original } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(stat).mockImplementation(((file, options) => file === fixture.saved
      ? Promise.reject(Object.assign(new Error("EIO: fixture I/O error"), { code: "EIO" }))
      : original(file, options)) as typeof stat);
    await fixture.send(fixture.pinned);
    expect(fixture.launches).not.toHaveBeenCalled();
    expect(fixture.reply()).not.toContain("choose a valid workspace folder");
    await expect(fixture.store.findByConversationKey(fixture.conversationKey)).resolves.toEqual(before);
  });

  it("preserves non-Claude workspace selection", async () => {
    const fixture = await setup(true, path.join(root, "saved"), "codex");
    await fixture.send(fixture.pinned);
    expect(fixture.launches.mock.lastCall?.[2]?.cwd).toBe(fixture.saved);
  });

  it("keeps the original binding after a fallback turn is interrupted", async () => {
    const fixture = await setup();
    const before = await fixture.store.findByConversationKey(fixture.conversationKey);
    const turn = fixture.send(fixture.pinned, undefined, "Hold this fixture turn");
    try {
      await vi.waitFor(() => expect(fixture.reply()).toContain("Fixture turn started"));
    } finally {
      fixture.runtime.activeRuns.get(fixture.conversationKey)?.abortController.abort();
      await turn;
    }
    expect(fixture.launches.mock.lastCall?.[2]?.cwd).toBe(fixture.pinned);
    await expect(fixture.store.findByConversationKey(fixture.conversationKey)).resolves.toMatchObject({
      codexSessionId: before?.codexSessionId, resume: before?.resume, suspendedPrevious: before?.suspendedPrevious,
    });
    await mkdir(fixture.saved);
    await fixture.send(fixture.pinned);
    await fixture.expectLaunch(fixture.saved);
  });

  it.each(["/goal reach the fixture objective", "/goal", "/goal clear", "/compact", "/context", "/ultrareview"])(
    "uses the same Claude session for %s", async (command) => {
      const fixture = await setup();
      await fixture.send(fixture.pinned, undefined, command);
      await fixture.expectLaunch(fixture.pinned);
    },
  );

  it("uses the configured fallback for an authorized question follow-up", async () => {
    const fixture = await setup();
    fixture.channel.conversationWorkspace.mockResolvedValue(fixture.pinned);
    const requestId = "question-fixture";
    fixture.runtime.pendingApprovals.set(requestId, {
      requestId, chatId: fixture.message.chatId, conversationKey: fixture.conversationKey, bridgeChatType: "private",
      requesterUserId: stableCoreNumericId("user:fixture-user"),
      askUserQuestionInput: { questions: [{ question: "Continue?", header: "Confirm", options: [{ label: "Yes", description: "Proceed" }], multiSelect: false }] },
      asyncQuestion: { nativeRequestId: "native-fixture" },
      resolve: () => {}, reject: () => {}, timer: setTimeout(() => {}, 3000).unref(),
    });
    await withChannelProfile("gateway", () => handleCoreCardAction({
      channel: fixture.channel, bridge: fixture.bridge, runtime: fixture.runtime, stateDir: fixture.stateDir,
      event: { chatId: fixture.message.chatId, messageId: "question-message", operator: { openId: "fixture-user" },
        action: { value: { cctb_lark: "ask_user_question", requestId }, form_value: { q0: "Yes" } } },
    }));
    await vi.waitFor(() => fixture.expectLaunch(fixture.pinned));
  });

  it("uses the configured fallback for an authorized archive continuation", async () => {
    const fixture = await setup();
    fixture.channel.conversationWorkspace.mockResolvedValue(fixture.pinned);
    const uploadId = "archive-fixture";
    const extractedPath = path.join(fixture.managed, "archive");
    await mkdir(extractedPath);
    const workflows = new FileWorkflowStore(fixture.stateDir);
    const now = new Date().toISOString();
    await workflows.append({
      uploadId, chatId: stableCoreNumericId(fixture.conversationKey), userId: stableCoreNumericId("user:fixture-user"),
      kind: "archive", status: "awaiting_continue", sourceFiles: [], derivedFiles: [],
      summary: "Archive fixture", extractedPath, createdAt: now, updatedAt: now,
    });
    await withChannelProfile("gateway", () => handleCoreCardAction({
      channel: fixture.channel, bridge: fixture.bridge, runtime: fixture.runtime, stateDir: fixture.stateDir,
      event: { chatId: fixture.message.chatId, messageId: "archive-message", operator: { openId: "fixture-user" },
        action: { value: { cctb_lark: "continue_archive", conversationKey: fixture.conversationKey,
          bridgeChatType: "private", uploadId } } },
    }));
    await vi.waitFor(async () => expect((await workflows.find(uploadId))?.status).toBe("completed"));
    await fixture.expectLaunch(fixture.pinned);
  });

  it("uses the configured fallback for a shared scheduled Claude turn", async () => {
    const fixture = await setup();
    fixture.channel.conversationWorkspace.mockResolvedValue(fixture.pinned);
    const execute = buildCoreCronExecutor({
      channel: fixture.channel, bridge: fixture.bridge, runtime: fixture.runtime, stateDir: fixture.stateDir,
    });
    const job = await new CronStore(fixture.stateDir).add({
      channel: "lark", chatId: 1, userId: 2, chatType: "private",
      larkChatId: fixture.message.chatId, conversationKey: fixture.conversationKey, prompt: "Fixture prompt",
      cronExpr: "0 9 * * *", deliveryMode: "agent", sessionMode: "reuse", locale: "en",
    });
    await withChannelProfile("gateway", () => execute(job));
    await fixture.expectLaunch(fixture.pinned);
  });

  it("can detach a resumed session with an unavailable workspace", async () => {
    const fixture = await setup();
    const before = await fixture.store.findByConversationKey(fixture.conversationKey);
    await rm(fixture.pinned, { recursive: true });
    await fixture.send(fixture.pinned, undefined, "/detach");
    expect(fixture.launches).not.toHaveBeenCalled();
    await expect(fixture.store.findByConversationKey(fixture.conversationKey)).resolves.toMatchObject({
      codexSessionId: before?.suspendedPrevious?.sessionId,
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports a pinned fallback that cannot be entered", async () => {
    const fixture = await setup();
    await chmod(fixture.pinned, 0o600);
    try {
      await fixture.send(fixture.pinned);
      expect(fixture.launches).not.toHaveBeenCalled();
      expect(fixture.reply()).toContain("accessible on the host");
    } finally {
      await chmod(fixture.pinned, 0o700);
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not fall back when traversing the saved path is denied", async () => {
    const blocked = path.join(root, "blocked");
    const fixture = await setup(true, path.join(blocked, "saved"));
    await mkdir(fixture.saved, { recursive: true });
    await chmod(blocked, 0o600);
    try {
      await fixture.send(fixture.pinned);
      expect(fixture.launches).not.toHaveBeenCalled();
      expect(fixture.reply()).toContain("permission");
    } finally {
      await chmod(blocked, 0o700);
    }
  });
});
