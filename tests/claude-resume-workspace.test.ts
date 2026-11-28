import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blocksText } from "../src/client-protocol/index.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { buildCoreConversationKey, normalizeCoreMessage } from "../src/core/message-normalizer.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { attachGateway } from "../src/gateway/service.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { Bridge } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { fakeChannel, fakeLarkMessage } from "./helpers/core-compat-fixtures.js";

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
  send({ type: "result", subtype: "success", result: "CLI cwd: " + process.cwd() });
});
`;

describe("ordinary messages for a Claude /resume binding", () => {
  let root: string;
  let adapter: ClaudeStreamAdapter | undefined;

  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "claude-resume-workspace-")); });
  afterEach(async () => {
    try { await adapter?.destroy(); } finally {
      adapter = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  async function setup(configureBot = true, saved = path.join(root, "saved")) {
    const stateDir = path.join(root, "bot");
    const configPath = path.join(stateDir, "config.json");
    const managed = path.join(stateDir, "workspace");
    const configured = path.join(root, "configured");
    const pinned = path.join(root, "pinned");
    await Promise.all([mkdir(managed, { recursive: true }), mkdir(configured), mkdir(pinned)]);
    await writeFile(configPath, JSON.stringify({
      engine: "claude",
      locale: "en",
      ...(configureBot ? { workspacePath: configured } : {}),
    }));
    const sessionId = randomUUID();
    const resume = { sessionId, dirName: "saved-project", workspacePath: saved };
    const message = fakeLarkMessage();
    const conversationKey = buildCoreConversationKey(message.chatId);
    const { bridgeChatId, bridgeAccessChatId } = normalizeCoreMessage(message);
    const store = new SessionStore(path.join(stateDir, "session.json"));
    const suspendedPrevious = { sessionId: randomUUID(), resume: null };
    await store.upsert({
      telegramChatId: bridgeChatId, conversationKey, codexSessionId: sessionId, resume, suspendedPrevious,
      updatedAt: new Date().toISOString(), status: "idle",
    });
    const launches = vi.fn((command: string, args: string[], options: Parameters<typeof spawn>[2]) =>
      spawn(command, ["-e", cli, "--", ...args], options));
    adapter = new ClaudeStreamAdapter(process.execPath, {
      childEnv: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, "claude-profile") },
      workspacePath: managed,
      configPath,
      historyHelper: null,
      spawnFn: launches,
    });
    const bridge = new Bridge({
      load: async () => ({ policy: "allowlist", allowlist: [bridgeAccessChatId], pairedUsers: [], pendingPairs: [] }),
      issuePairingCode: vi.fn(),
    }, new SessionManager(store, adapter), adapter).createAuthenticatedSurface();
    const channel = { ...fakeChannel(), profile: "gateway" as const };
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

    return { stateDir, saved, pinned, configured, managed, launches, reply, send, expectLaunch, store, conversationKey, bridge };
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

  it("uses the conversation's pinned fallback through the Hub and Gateway", async () => {
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
      const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture chat", "fixture-chat", {
        type: "direct", workspacePath: fixture.pinned,
      });
      const original = (await fixture.store.findByConversationKey(fixture.conversationKey))!;
      const conversationKey = buildCoreConversationKey(conversation.id);
      await fixture.store.removeByConversationKey(fixture.conversationKey);
      await fixture.store.upsert({ ...original, conversationKey });
      await hub.store.sendMessage("owner", {
        conversationId: conversation.id, clientMsgId: "fixture-message", text: "Continue the session", attachments: [],
      });
      await vi.waitFor(async () => {
        const snapshot = await hub.store.snapshot("owner", conversation.id);
        const text = snapshot.messages.filter(message => message.authorType === "bot").map(message => blocksText(message.blocks)).join("\n");
        await fixture.expectLaunch(fixture.pinned, () => text, conversationKey);
      }, { timeout: 3000 });
      expect(fixture.launches).toHaveBeenCalledOnce();
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

  it("keeps the existing launch error for a missing explicit runtime override", async () => {
    const fixture = await setup();
    const explicit = path.join(root, "explicit");
    await fixture.send(fixture.pinned, explicit);
    expect(fixture.launches).toHaveBeenCalledOnce();
    expect(fixture.launches.mock.lastCall?.[2]?.cwd).toBe(explicit);
    expect(fixture.reply()).toContain("executable or working directory was not found");
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
