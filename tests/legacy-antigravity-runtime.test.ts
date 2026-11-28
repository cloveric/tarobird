import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { blocksText, type CardElement } from "../src/client-protocol/index.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../src/core/message-normalizer.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { SessionStore } from "../src/state/session-store.js";
import { gatewayRestartFixture } from "./helpers/gateway-restart-fixture.js";

it.skipIf(process.platform === "win32")("migrates a saved ordinary print Bot at idle restart and resumes its queued input on ACP", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-migrate-"));
  const stateDir = path.join(root, "bot"), home = path.join(root, "home"), workspace = path.join(root, "workspace");
  await Promise.all([stateDir, home, workspace].map(directory => mkdir(directory)));
  const versionFile = path.join(root, "version"), logFile = path.join(root, "commands");
  const executable = path.join(root, "agy.mjs"), sessionId = randomUUID();
  const configPath = path.join(stateDir, "config.json");
  const specPath = path.join(stateDir, "managed-bot-spec.json");
  const legacy = { engine: "antigravity", approvalMode: "full-auto", locale: "en", workspacePath: workspace, model: "fixture-model", effort: "high" };
  const spec = { requestId: "fixture_legacy", name: "Fixture", engine: "antigravity", workspace, model: "", effort: "" };
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const argv = process.argv.slice(2);
const version = readFileSync(${JSON.stringify(versionFile)}, "utf8");
const log = value => appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(value) + "\\n");
log({ argv, bridgeSecretsPresent: Boolean(process.env.TELEGRAM_BOT_TOKEN || process.env.CCTB_SEND_TOKEN) });
if (argv[0] === "--version") {
  if (version === "failed") process.exit(2);
  console.log(version === "old" ? "1.5.9" : "1.5.19");
} else if (argv[0] === "acp") {
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);
    log({ method, params });
    const send = body => console.log(JSON.stringify({ jsonrpc: "2.0", ...body }));
    const result = value => send({ id, result: value });
    if (method === "initialize") {
      if (version === "timeout") continue;
      result({ protocolVersion: 1, authMethods: [], agentCapabilities: { sessionCapabilities: version === "no-resume" ? {} : { resume: {}, close: {} } } });
    } else if (method === "session/resume" && params.sessionId === ${JSON.stringify(sessionId)}) {
      result({ configOptions: [
        { type: "select", id: "model", name: "Model", category: "model", currentValue: "fixture-model", options: [{ value: "fixture-model", name: "Fixture model" }] },
        { type: "select", id: "thinking", name: "Thinking", category: "thought_level", currentValue: "high", options: [{ value: "high", name: "High" }] },
      ] });
    } else if (method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Resumed fixture" } } } });
      result({ stopReason: "end_turn" });
    } else if (id !== undefined) {
      result({});
    }
  }
}`, { mode: 0o700 });
  const secret = randomBytes(32).toString("base64url");
  await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(legacy));
  await writeFile(specPath, JSON.stringify(spec));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  let fixture: ReturnType<typeof gatewayRestartFixture> | undefined;
  const readConfig = async () => JSON.parse(await readFile(configPath, "utf8"));
  const boot = async () => {
    fixture = gatewayRestartFixture(
      { stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", mode: "normal" },
      home, { ANTIGRAVITY_EXECUTABLE: executable, TELEGRAM_BOT_TOKEN: "fixture-only", CCTB_SEND_TOKEN: "fixture-only" },
    );
    await vi.waitFor(() => expect(fixture!.messages, fixture!.output()).toContain("boot-complete"), { timeout: 15_000 });
  };
  const idleRestart = async () => {
    fixture!.child.send({ type: "restart.whenIdle" });
    await vi.waitFor(() => expect(fixture!.child.exitCode, fixture!.output()).toBe(75), { timeout: 10_000 });
  };
  const commands = async () => (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash) VALUES('alpha','Fixture','antigravity',?)", [hashSecret(secret)]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Existing conversation", "existing_conversation");
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    const conversationKey = buildCoreConversationKey(conversation.id);
    await sessionStore.upsert({
      telegramChatId: stableCoreNumericId(conversation.id), conversationKey, codexSessionId: sessionId,
      status: "idle", updatedAt: new Date().toISOString(),
      resume: { sessionId, dirName: "workspace", workspacePath: workspace },
    });

    for (const [version, reason] of [
      ["old", "version_unsupported"], ["failed", "version_unavailable"],
      ["no-resume", "acp_resume_unsupported"], ["timeout", "acp_timed_out"],
    ]) {
      await writeFile(versionFile, version);
      await boot();
      expect(await readConfig()).toEqual(legacy);
      expect(fixture!.output()).toContain(reason);
      await idleRestart();
    }

    await writeFile(versionFile, "supported");
    const input = await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "pending_before_upgrade", text: "Continue existing work", attachments: [] });
    await boot();
    expect(await readConfig()).toEqual({ ...legacy, antigravityRuntime: "acp" });
    await vi.waitFor(async () => {
      const snapshot = await hub.store.snapshot("owner", conversation.id);
      expect(snapshot.messages.filter(message => message.authorType === "bot" && message.replyTo === input.message.id)
        .map(message => blocksText(message.blocks))).toEqual([expect.stringContaining("Resumed fixture")]);
    }, { timeout: 15_000 });
    const trace = await commands();
    expect(trace.filter(entry => entry.argv).every(entry => entry.bridgeSecretsPresent === false)).toBe(true);
    expect(trace.filter(entry => entry.method === "session/resume")).toEqual([
      { method: "session/resume", params: expect.objectContaining({ sessionId, cwd: workspace }) },
    ]);
    expect(trace.filter(entry => entry.method === "session/prompt")).toHaveLength(1);
    expect(trace.some(entry => entry.method === "session/new")).toBe(false);
    expect(trace.some(entry => entry.method === "session/load")).toBe(false);
    expect(trace.filter(entry => entry.argv?.includes("--add-dir"))).toEqual([
      { argv: ["acp", "--dangerously-skip-permissions", "--sandbox", "--add-dir", workspace], bridgeSecretsPresent: false },
    ]);
    expect((await sessionStore.findByConversationKeySafe(conversationKey)).record?.codexSessionId).toBe(sessionId);
    await idleRestart();

    // Rollback is explicit and remains sticky on subsequent starts.
    await writeFile(configPath, JSON.stringify({ ...legacy, antigravityRuntime: "print" }));
    await boot();
    expect(await readConfig()).toEqual({ ...legacy, antigravityRuntime: "print" });
    expect((await commands()).filter(entry => entry.method === "session/prompt")).toHaveLength(1);
    await idleRestart();

    const normal = { ...legacy, approvalMode: "normal" };
    await writeFile(configPath, JSON.stringify(normal));
    await boot();
    expect(await readConfig()).toEqual({ ...normal, antigravityRuntime: "acp", antigravityAcpLegacyTurnApproval: true });
    expect((await commands()).filter(entry => entry.method === "session/prompt")).toHaveLength(1);

    const cardActions = (elements: CardElement[]): CardElement[] =>
      elements.flatMap(element => [element, ...cardActions(element.children ?? [])]);
    for (const decision of ["deny", "allow_once"]) {
      const { message } = await hub.store.sendMessage("owner", {
        conversationId: conversation.id, clientMsgId: `normal_${decision}`, text: `Request ${decision}`, attachments: [],
      });
      const pickApprovalAction = async () => {
        const { messages } = await hub.store.snapshot("owner", conversation.id);
        for (const row of messages.filter(row => row.replyTo === message.id)) {
          const buttons = row.blocks.flatMap(block => block.type === "card" ? cardActions(block.elements) : []);
          const action = buttons.find(button => button.type === "button" && button.value?.decision === decision);
          if (action) return { row, action };
        }
      };
      await vi.waitFor(async () => expect(await pickApprovalAction()).toBeDefined(), { timeout: 10_000 });
      const { row, action } = (await pickApprovalAction())!;
      expect((await commands()).filter(entry => entry.method === "session/prompt")).toHaveLength(1);
      await hub.store.enqueueAction("owner", `normal_${decision}_action`, { decision }, "alpha", conversation.id, {
        conversationId: conversation.id, messageId: row.id, userId: "owner", actionId: action.actionId!,
        value: action.value, values: {},
      });
      await hub["dispatchActions"]("alpha");
      await vi.waitFor(async () => {
        expect(blocksText((await hub.store.snapshot("owner", conversation.id)).messages
          .filter(candidate => candidate.replyTo === message.id).flatMap(candidate => candidate.blocks)))
          .toMatch(decision === "deny" ? /denied/i : /Resumed fixture/);
      }, { timeout: 10_000 });
      expect((await commands()).filter(entry => entry.method === "session/prompt")).toHaveLength(decision === "deny" ? 1 : 2);
    }
    const afterNormal = await commands();
    expect(afterNormal.filter(entry => entry.argv?.includes("--add-dir"))).toHaveLength(2);
    const lastLaunch = afterNormal.filter(entry => entry.argv?.includes("--add-dir")).at(-1);
    expect(lastLaunch?.argv).toEqual(["acp", "--dangerously-skip-permissions", "--sandbox", "--add-dir", workspace]);
    expect(afterNormal.filter(entry => entry.method === "session/resume").map(entry => entry.params.sessionId)).toEqual([sessionId, sessionId]);
    expect(afterNormal.some(entry => ["session/new", "session/load"].includes(entry.method))).toBe(false);
    await idleRestart();

    for (const role of ["dispatcher", "worker"]) {
      const pinned = { ...legacy, ...(role === "dispatcher" ? { role } : {}) };
      await writeFile(configPath, JSON.stringify(pinned));
      await writeFile(specPath, JSON.stringify({ ...spec, ...(role ? { role } : {}) }));
      await boot();
      expect(await readConfig()).toEqual(pinned);
      await idleRestart();
    }
  } finally {
    await fixture?.kill();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
