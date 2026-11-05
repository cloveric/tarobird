import { it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runMessagesCommand } from "../src/host-cli/messages.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { startHubControl } from "../src/hub/service.js";
import { HubServer } from "../src/hub/server.js";
import { removeTempRoot } from "./helpers/temp-files.js";

it("rejects ambiguous targets and unconfirmed deletion before making a request", async () => {
  const request = vi.fn();
  for (const [command, options] of [["delete", { ids: "one" }], ["delete", { ids: "one,../bad", yes: true }], ["delete", { ids: "one", yes: true, before: "two" }], ["list", { ids: "one" }]] as const) {
    await expect(runMessagesCommand({ request }, command, "chat", options)).rejects.toThrow();
  }
  expect(request).not.toHaveBeenCalled();
});

it("uses the real authenticated shared API for personal list/delete, pagination, idempotency and atomic validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "messages-cli-")); await initializeHost(root, "Message fixture");
  const hub = await HubServer.start({ stateDir: root });
  let control: (() => Promise<void>) | undefined, client: LocalHostClient | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "Chat", "chat"), ids: string[] = [];
    for (let i = 0; i < 52; i++) ids.push((await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: `message ${i}` }] })).id);
    control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
    client = await LocalHostClient.connect(root, { enroll: true });
    const page: any = await runMessagesCommand(client, "list", chat.id, {});
    expect(page.messages).toHaveLength(50); expect(page.messages[0].id).toBe(ids[51]);
    expect((await runMessagesCommand(client, "list", chat.id, { before: page.nextBefore }) as any).messages).toHaveLength(2);
    await expect(client.request(`/api/conversations/${chat.id}/messages`, "DELETE", { messageIds: [ids[0], "missing"] })).rejects.toThrow();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runHostCli(["messages", "delete", chat.id, "--ids", `${ids[0]},${ids[1]}`, "--yes", "--state-dir", root, "--json"]);
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({ deletedIds: ids.slice(0, 2) });
    } finally { log.mockRestore(); }
    await runMessagesCommand(client, "delete", chat.id, { ids: ids[0], yes: true });
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(message => message.status === "deleted")).toHaveLength(2);
    expect((await hub.store.messageForBot("bot", ids[0]!)).status).toBe("complete");
  } finally { client?.close(); await control?.(); await hub.close(); await removeTempRoot(root); }
});

it("keeps long-history list pages within the CLI byte budget without losing IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "messages-cli-large-")); await initializeHost(root, "Large history fixture");
  const hub = await HubServer.start({ stateDir: root });
  let control: (() => Promise<void>) | undefined, client: LocalHostClient | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "Long history", "long-history"), ids: string[] = [];
    for (let i = 0; i < 45; i++) ids.push((await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: `message ${i}: ${"x".repeat(200 * 1024)}` }] })).id);
    const largeText = "large:" + "z".repeat(9 * 1024 * 1024);
    ids.push((await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: largeText }] })).id);
    control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
    client = await LocalHostClient.connect(root, { enroll: true });
    const seen: string[] = []; let before: string | undefined;
    do {
      const page: any = await runMessagesCommand(client, "list", chat.id, { before });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan((page.messages.length === 1 ? 33 : 8) * 1024 * 1024);
      if (!before) { expect(page.messages).toHaveLength(1); expect(page.messages[0].blocks[0].text).toBe(largeText); }
      seen.push(...page.messages.map((message: { id: string }) => message.id)); before = page.nextBefore;
    } while (before);
    expect(seen).toEqual(ids.reverse());
  } finally { client?.close(); await control?.(); await hub.close(); await removeTempRoot(root); }
}, 30_000);

it("previews clear without writing, resumes an exact boundary after a lost receipt, and preserves later messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "messages-clear-cli-")); await initializeHost(root, "Clear fixture");
  const hub = await HubServer.start({ stateDir: root });
  let control: (() => Promise<void>) | undefined, client: LocalHostClient | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "History", "history");
    for (let n = 0; n < 205; n++) await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: `old ${n}` }] });
    control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
    client = await LocalHostClient.connect(root, { enroll: true });
    const preview = await runMessagesCommand(client, "clear", chat.id, {}) as { count: number; throughId: string };
    expect(preview).toMatchObject({ count: 205, preview: true, scope: "personal", sessionPreserved: true });
    expect((await hub.store.snapshot("owner", chat.id)).messages.every(m => m.status === "complete")).toBe(true);
    const later = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "Keep after preview" }] });
    const losing = { request: async (...args: Parameters<LocalHostClient["request"]>) => {
      await client!.request(...args); throw new Error("lost receipt");
    } };
    await expect(runMessagesCommand(losing, "clear", chat.id, { through: preview.throughId, yes: true })).rejects.toThrow(`--through ${preview.throughId} --yes`);
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.status === "deleted")).toHaveLength(100);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runHostCli(["messages", "clear", chat.id, "--through", preview.throughId, "--yes", "--state-dir", root, "--json"]);
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ cleared: 105, throughId: preview.throughId, sessionPreserved: true });
    } finally { log.mockRestore(); }
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.status !== "deleted").map(m => m.id)).toEqual([later.id]);
    expect((await hub.store.messageForBot("bot", preview.throughId)).status).toBe("complete");
    expect(await runMessagesCommand(client, "clear", chat.id, { through: preview.throughId, yes: true })).toMatchObject({ cleared: 0 });
    const active = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "Still running" }], status: "streaming" });
    await expect(runMessagesCommand(client, "clear", chat.id, { through: active.id, yes: true })).rejects.toThrow("请先处理运行中的任务、待回答的问题或审批。");
    expect((await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.status !== "deleted").map(m => m.id)).toEqual([later.id, active.id]);
    await hub.store.publishBotMessage("bot", { id: active.id, conversationId: chat.id, blocks: [{ type: "text", text: "Finished" }], status: "complete" });
    expect(await runMessagesCommand(client, "clear", chat.id, { through: active.id, yes: true })).toMatchObject({ cleared: 2 });
  } finally { client?.close(); await control?.(); await hub.close(); await removeTempRoot(root); }
}, 30_000);

it("refuses malformed or ambiguous clear options without any HTTP request", async () => {
  const request = vi.fn();
  for (const [command, options] of [["clear", { ids: "one", yes: true }], ["clear", { before: "one", yes: true }], ["clear", { through: "one" }], ["clear", { through: "../bad", yes: true }], ["list", { through: "one" }], ["delete", { ids: "one", yes: true, through: "two" }]] as const)
    await expect(runMessagesCommand({ request }, command, "chat", options)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
