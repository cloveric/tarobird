import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runQueueCommand } from "../src/host-cli/queue.js";
import { removeTempRoot } from "./helpers/temp-files.js";
import { HubServer } from "../src/hub/server.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { initializeHost } from "../src/host-cli/setup.js";

const snapshot = { supported: true, revision: "revision_1", botId: "bot", conversationId: "chat", items: [], capabilities: { reorder: true, edit: true, cancel: true } };
const request = () => vi.fn().mockResolvedValue(snapshot);
const common = { bot: "bot", message: "message", revision: "revision_1", "request-id": "operation_1" };

describe("headless prompt queue commands", () => {
  it("reads only the selected host conversation and Bot", async () => {
    const call = request();
    expect(await runQueueCommand({ request: call }, "list", "chat", { bot: "bot" })).toEqual(snapshot);
    expect(call.mock.calls).toEqual([["/api/conversations/chat/queue?botId=bot"]]);
  });

  it.each([
    ["move", { before: "other" }, { type: "move", messageId: "message", beforeId: "other" }],
    ["move", { last: true }, { type: "move", messageId: "message", beforeId: null }],
    ["edit", { text: "第一段\n\n第二段" }, { type: "edit", messageId: "message", text: "第一段\n\n第二段" }],
    ["cancel", {}, { type: "cancel", messageId: "message" }],
    ["pause", {}, { type: "pause", messageId: "message" }],
    ["resume", {}, { type: "resume", messageId: "message" }],
  ] as const)("sends %s through the shared API with CAS and receipt ID", async (operation, extra, action) => {
    const call = request(), seen: string[] = [];
    await runQueueCommand({ request: call }, operation, "chat", { ...common, ...extra }, id => seen.push(id));
    expect(call.mock.calls).toEqual([["/api/conversations/chat/queue", "POST", { botId: "bot", requestId: "operation_1", revision: "revision_1", action }]]);
    expect(seen).toEqual(["operation_1"]);
  });

  it("does not silently fetch a newer revision or retry uncertain mutations", async () => {
    const call = vi.fn().mockRejectedValue(new Error("connection_lost")), seen: string[] = [];
    await expect(runQueueCommand({ request: call }, "cancel", "chat", { ...common, "request-id": undefined }, id => seen.push(id))).rejects.toThrow("connection_lost");
    expect(seen).toHaveLength(1);
    expect(call).toHaveBeenCalledExactlyOnceWith("/api/conversations/chat/queue", "POST", expect.objectContaining({ requestId: seen[0], revision: "revision_1" }));
  });

  it.each([
    ["move", { ...common, before: "other", last: true }],
    ["move", common],
    ["edit", { ...common, text: "x", "text-file": "/not-read" }],
    ["edit", common],
    ["cancel", { ...common, text: "ignored?" }],
    ["cancel", { ...common, revision: undefined }],
    ["list", common],
    ["pause", { ...common, last: true }],
    ["resume", { ...common, revision: undefined }],
  ])("rejects ambiguous or ignored %s options before any request", async (operation, options) => {
    const call = request();
    await expect(runQueueCommand({ request: call }, operation, "chat", options)).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps a UTF-8 file's multiline content exactly, without shell interpolation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-queue-text-"));
    try {
      const file = path.join(root, "prompt.txt"), text = '中文\n\n`literal` $(literal)\n';
      await writeFile(file, text);
      const call = request();
      await runQueueCommand({ request: call }, "edit", "chat", { ...common, "text-file": file });
      expect(call.mock.calls[0]?.[2].action.text).toBe(text);
      await writeFile(file, Buffer.from([0xff]));
      await expect(runQueueCommand({ request: call }, "edit", "chat", { ...common, "text-file": file })).rejects.toThrow();
      await writeFile(file, Buffer.from([0xff, 0xfe, 0x61, 0]));
      await expect(runQueueCommand({ request: call }, "edit", "chat", { ...common, "text-file": file })).rejects.toThrow("UTF-16");
      expect(call).toHaveBeenCalledTimes(1);
    } finally { await removeTempRoot(root); }
  });

  it("enrolls a real local controller and edits the same owner's App queue through the CLI entrypoint", async () => {
    const root = await mkdtemp(process.platform === "win32" ? path.join(os.tmpdir(), "tqcli-") : "/tmp/tqcli-");
    await initializeHost(root, "Isolated queue host");
    const hub = await HubServer.start({ stateDir: root });
    let control: (() => Promise<void>) | undefined, client: LocalHostClient | undefined;
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Bot','fixture','codex')");
      const conversation = await hub.store.createConversation("owner", ["bot"], "CLI queue", "create");
      await new HubPromptQueue(hub.store).registerWorker("bot", true);
      const a = (await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "a", text: "First", attachments: [] })).message;
      const b = (await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "b", text: "Second", attachments: [] })).message;
      control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
      client = await LocalHostClient.connect(root, { enroll: true });
      let queue = await runQueueCommand(client, "list", conversation.id, { bot: "bot" });
      expect(queue.items.map(item => item.canEdit)).toEqual([true, true]);
      const log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runHostCli(["queue", "edit", conversation.id, "--state-dir", root, "--bot", "bot", "--message", b.id, "--text", "Actual CLI change\nSecond paragraph", "--revision", queue.revision, "--request-id", "cli-edit", "--json"]);
        expect(JSON.parse(log.mock.calls.at(-1)![0] as string).items[1].message.blocks[0].text).toBe("Actual CLI change\nSecond paragraph");
        expect(error.mock.calls.flat().join(" ")).toContain("cli-edit");
      } finally { log.mockRestore(); error.mockRestore(); }
      queue = await runQueueCommand(client, "list", conversation.id, { bot: "bot" });
      queue = await runQueueCommand(client, "move", conversation.id, { bot: "bot", message: b.id, before: a.id, revision: queue.revision });
      expect(queue.items.map(item => item.message.id)).toEqual([b.id, a.id]);
      queue = await runQueueCommand(client, "pause", conversation.id, { bot: "bot", message: b.id, revision: queue.revision });
      expect((await new HubPromptQueue(hub.store).read("owner", "bot", conversation.id)).items[0].paused).toBe(true);
      queue = await runQueueCommand(client, "resume", conversation.id, { bot: "bot", message: b.id, revision: queue.revision });
      expect(queue.items[0].paused).toBe(false);
      queue = await runQueueCommand(client, "cancel", conversation.id, { bot: "bot", message: a.id, revision: queue.revision });
      expect(queue.items.map(item => item.message.id)).toEqual([b.id]);
      expect((await hub.store.messageForUser("owner", b.id)).blocks[0]).toEqual({ type: "text", text: "Actual CLI change\nSecond paragraph" });
    } finally { client?.close(); await control?.(); await hub.close(); await removeTempRoot(root); }
  });
});
