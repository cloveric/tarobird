import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runBotMessagesCommand } from "../src/host-cli/bot-messages.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { hashSecret } from "../src/hub/auth.js";

let root: string, hub: HubServer, control: (() => Promise<void>) | undefined;
const secret = "secret-".repeat(8);
beforeEach(async () => {
  for (const key of ["TAROBOT_ACTIVE_INSTANCE", "TAROBOT_INSTANCE", "TAROBOT_ACTIVE_STATE_DIR", "TAROBOT_STATE_DIR", "TAROBOT_MESSAGE_ID"]) vi.stubEnv(key, undefined);
  root = await mkdtemp(path.join(os.tmpdir(), "bot-cli-")); await initializeHost(root, "Local"); hub = await HubServer.start({ stateDir: root });
  for (const id of ["sender", "receiver"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'codex')", [id, id, hashSecret(secret)]);
  control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(root, { enroll: true }); client.close();
  await runBotMessagesCommand(root, "allow", { from: "Local/sender", bot: "receiver" });
  await writeFile(path.join(root, "task.txt"), "Process this file.");
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await control?.(); control = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });
const options = () => ({ to: "Local/receiver", "source-bot": "sender", "text-file": path.join(root, "task.txt") });

it("runs list/send/wait against the existing authenticated Hub, uploads a full chunk, times out without resend, and downloads verified replies", async () => {
  const file = path.join(root, "large.bin"), bytes = Buffer.alloc(8 * 1024 * 1024 + 5, 42); await writeFile(file, bytes);
  const receipt: any = await runBotMessagesCommand(root, "send", { ...options(), file: [file], "request-id": "stable_request" });
  const to = `${receipt.hostId}/${receipt.botId}/${receipt.conversationId}`;
  const list: any = await runBotMessagesCommand(root, "list", { host: "Local", bot: "receiver", "source-bot": "sender" });
  expect(list.conversations[0].id).toBe(receipt.conversationId);
  const waiting: any = await runBotMessagesCommand(root, "wait", { to, message: receipt.messageId, "source-bot": "sender", timeout: "0" });
  expect(waiting.status).toBe("timeout"); expect(await hub.store.pendingForBot("receiver")).toHaveLength(1);
  const sent = await hub.store.messageForBot("receiver", receipt.messageId), attachment = sent.blocks.find(b => b.type === "file")!;
  if (attachment.type !== "file") throw new Error("missing file");
  await hub.store.publishBotMessage("receiver", { conversationId: receipt.conversationId, replyTo: receipt.messageId, blocks: [{ type: "text", text: "Received" }, attachment] });
  await hub.store.acknowledgeDelivery("receiver", receipt.messageId);
  const result: any = await runBotMessagesCommand(root, "wait", { to, message: receipt.messageId, "source-bot": "sender", out: path.join(root, "result"), timeout: "0" });
  // Compare the bytes directly; deep-equality walks millions of Buffer indices
  // and can consume the transport test's timeout after the transfer has finished.
  expect(result.status).toBe("completed"); expect((await readFile(result.files[0].path)).equals(bytes)).toBe(true);
  const again: any = await runBotMessagesCommand(root, "wait", { to, message: receipt.messageId, "source-bot": "sender", out: path.join(root, "result"), timeout: "0" });
  expect(again.files[0].path).toBe(result.files[0].path);
  expect(result.files[0].sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  const replay: any = await runBotMessagesCommand(root, "send", { ...options(), file: [file], "request-id": "stable_request" });
  expect(replay).toMatchObject({ messageId: receipt.messageId, duplicate: true });
}, 30_000);

it("uses a Bot's private gateway credential and active-turn context without enrolling a controller", async () => {
  const state = path.join(root, "bots", "sender"); await mkdir(path.join(state, "workspace"), { recursive: true });
  await writeFile(path.join(state, "gateway.key"), secret, { mode: 0o600 }); await chmod(path.join(state, "gateway.key"), 0o600);
  await writeFile(path.join(state, "config.json"), JSON.stringify({ engine: "codex" }));
  const task = path.join(state, "workspace", "task.txt"); await writeFile(task, "A Bot task");
  const context = await hub.store.createConversation("owner", ["sender"], "Origin", "origin");
  const message = await hub.store.sendMessage("owner", { conversationId: context.id, clientMsgId: "origin", text: "Delegate", attachments: [] });
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [message.message.id]);
  vi.stubEnv("TAROBOT_INSTANCE", "sender"); vi.stubEnv("TAROBOT_STATE_DIR", state);
  // Persistent Codex cannot inherit per-turn env; the injected context flag is equivalent.
  await rm(path.join(root, "cli"), { recursive: true });
  await expect(runBotMessagesCommand(root, "send", { to: "Local/receiver", "text-file": task, "context-message": "foreign_message" })).rejects.toThrow("bot_message_context_not_active");
  const receipt: any = await runBotMessagesCommand(root, "send", { to: "Local/receiver", "text-file": task, "context-message": message.message.id });
  expect(receipt.messageId).toMatch(/^msg_/);
  await hub.store.db.run("UPDATE bots SET secret_hash=? WHERE id='sender'", [hashSecret("rotated")]);
  await expect(runBotMessagesCommand(root, "list", { host: "Local", bot: "receiver" })).rejects.toThrow("instance_unauthorized");
});

it.each([`${"报告".repeat(40)}.txt`, `${"report".repeat(35)}.txt`])("preserves the extension and reuses long reply filenames: %s", async name => {
  const bytes = Buffer.from("Long filename reply");
  const sent: any = await runBotMessagesCommand(root, "send", options());
  const id = await hub.attachments.importForBot("receiver", { conversationId: sent.conversationId, name, mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
  await hub.store.publishBotMessage("receiver", { conversationId: sent.conversationId, replyTo: sent.messageId, blocks: [{ type: "file", attachmentId: id, name, mime: "text/plain", size: bytes.length }] });
  await hub.store.acknowledgeDelivery("receiver", sent.messageId);
  const wait = { to: `${sent.hostId}/${sent.botId}/${sent.conversationId}`, message: sent.messageId, "source-bot": "sender", out: path.join(root, "unicode"), timeout: "0" };
  const result: any = await runBotMessagesCommand(root, "wait", wait);
  expect(await readFile(result.files[0].path)).toEqual(bytes);
  expect(Buffer.byteLength(path.basename(result.files[0].path))).toBeLessThanOrEqual(240);
  expect(result.files[0].path).toMatch(/\.txt$/);
  expect((await runBotMessagesCommand(root, "wait", wait)).files[0].path).toBe(result.files[0].path);
});

it.each([{ id: "../escape" }, { size: -1 }, { size: 513 * 1024 * 1024 }, { sha256: "bad" }])("rejects unsafe reply metadata before requesting file bytes: %j", async invalid => {
  const sent: any = await runBotMessagesCommand(root, "send", options());
  const original = hub.botMessages.local.bind(hub.botMessages);
  const calls = vi.spyOn(hub.botMessages, "local").mockImplementation(async (...args) => {
    if ((args[0] as { operation: string }).operation === "wait") return {
      status: "completed", files: [{ id: "reply_fixture", name: "reply.txt", size: 1, mime: "text/plain", sha256: "0".repeat(64), ...invalid }],
    };
    return original(...args);
  });
  await expect(runBotMessagesCommand(root, "wait", {
    to: `${sent.hostId}/${sent.botId}/${sent.conversationId}`, message: sent.messageId,
    "source-bot": "sender", out: path.join(root, "unsafe"), timeout: "0",
  })).rejects.toThrow();
  expect(calls.mock.calls.some(([input]) => (input as { operation: string }).operation === "download")).toBe(false);
});

it("rejects unsafe message IDs before asking a peer for replies", async () => {
  const sent: any = await runBotMessagesCommand(root, "send", options());
  const calls = vi.spyOn(hub.botMessages, "local");
  await expect(runBotMessagesCommand(root, "wait", {
    to: `${sent.hostId}/${sent.botId}/${sent.conversationId}`, message: "../escape",
    "source-bot": "sender", timeout: "0",
  })).rejects.toThrow();
  expect(calls.mock.calls.some(([input]) => (input as { operation: string }).operation === "wait")).toBe(false);
});

it("rejects credential files, invalid combinations and negative waits; emits JSON through the public CLI parser", async () => {
  await writeFile(path.join(root, ".env"), "SECRET=fixture");
  await expect(runBotMessagesCommand(root, "send", { ...options(), file: [path.join(root, ".env")] })).rejects.toThrow("credentials-file");
  await expect(runBotMessagesCommand(root, "send", { ...options(), to: "Local/receiver/Existing", "new-conversation": "New" })).rejects.toThrow("new_conversation_requires");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await runHostCli(["conversations", "list", "--host", "Local", "--bot", "receiver", "--source-bot", "sender", "--state-dir", root, "--json"]);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ botId: "receiver", conversations: expect.any(Array) });
  expect(await hub.store.db.all("SELECT * FROM deliveries")).toHaveLength(0);
});


it.each([-1, 90_000])("refreshes an owner session with %i ms left before an operation without enrolling or retransmitting", async remaining => {
  const connect = LocalHostClient.connect.bind(LocalHostClient);
  let calls = 0;
  const spy = vi.spyOn(LocalHostClient, "connect").mockImplementation(async (directory, options) => {
    expect(options?.enroll).not.toBe(true);
    const client = await connect(directory, options);
    if (++calls === 1) client.ready.expiresAt = Date.now() + remaining;
    return client;
  });
  const sent: any = await runBotMessagesCommand(root, "send", { ...options(), "request-id": "lease_refresh" });
  expect(spy).toHaveBeenCalledTimes(2);
  expect(sent.duplicate).toBe(false);
  expect(await hub.store.db.all("SELECT * FROM deliveries")).toHaveLength(1);
});
