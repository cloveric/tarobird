import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { widgetBlock } from "../../src/client-protocol/widget.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
test("unchanged workbench re-registers after authenticated token renewal and retains its chat target", async ({ page }, info) => {
  test.setTimeout(35_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-renewal-")), hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  const events: unknown[] = []; let sockets = 0, readyCount = 0;
  page.on("websocket", socket => {
    if (!socket.url().endsWith("/ws")) return;
    const id = ++sockets;
    socket.on("framesent", ({ payload }) => { const frame = JSON.parse(String(payload)); if (frame.type === "workbench.register") events.push({ event: "register", socket: id, at: Date.now(), registration: frame.registration }); });
    socket.on("framereceived", ({ payload }) => { const frame = JSON.parse(String(payload)); if (frame.type === "ready") { readyCount++; events.push({ event: "ready", socket: id, at: Date.now() }); } });
    socket.on("close", () => events.push({ event: "close", socket: id, at: Date.now() }));
  });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','连接验收助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "工作台续期验收", "renewal_chat");
    await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [widgetBlock({ title: "保持不变的图表", summary: "续期前后不改变来源", report: { version: 1, columns: ["月份", "数量"], rows: [["一月", 2], ["二月", 5]], chart: { kind: "bar", category: 0, values: [1] } } })] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    const authenticate = hub.auth.authenticate.bind(hub.auth); let authentications = 0;
    // Only the first real App session expires early; pairing fixture authentication is complete.
    hub.auth.authenticate = async (...args) => { const session = await authenticate(...args); if (++authentications === 1) session.expiresAt = Date.now() + 36_000; return session; };
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
    await page.locator(".message-scroll").getByRole("button", { name: "在工作台打开", exact: true }).click();
    const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
    await expect.poll(async () => (await workbenchContentTargets(broker, actor))[0]?.tabs.length).toBe(1);
    const before = (await workbenchContentTargets(broker, actor))[0];
    await expect.poll(() => readyCount, { timeout: 12_000 }).toBe(2);
    await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length, { timeout: 2_000 }).toBe(1);
    const after = (await workbenchContentTargets(broker, actor))[0]; expect(after).toEqual(before);
    await page.locator(".conversation-main textarea").last().fill("续期后仍使用原工作台目标"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(async () => (await hub.store.db.get<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND author_type='user'", [conversation.id]))?.id).toBeTruthy();
    const sent = await hub.store.db.get<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND author_type='user'", [conversation.id]);
    expect(await broker.contextForMessage("owner", sent!.id, conversation.id)).toMatchObject({ target: { windowId: before.windowId, tabId: before.activeTabId } });
  } finally { await writeFile(info.outputPath("reconnect-evidence.json"), JSON.stringify({ events, readyCount, sockets }, null, 2)); await page.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
