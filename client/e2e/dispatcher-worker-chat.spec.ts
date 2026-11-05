import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const clientDir = () => path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist");
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
}

test("a ticket's worker conversation offers no new chat with its hidden engine worker", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatcher-worker-chat-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: clientDir() });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('disp','调度员','fixture','claude','dispatcher'),('w_codex','调度员 · Codex','fixture','codex','worker')");
    const home = await hub.store.createConversation("owner", ["disp"], "调度台", "home");
    const worker = await hub.store.createConversation("owner", ["w_codex"], "工单：整理资料", "worker", { dispatchWorker: true });
    await hub.store.db.run("UPDATE conversations SET hidden=1,ticket_json=? WHERE id=?", [JSON.stringify({ id: "t_work", dispatcherBotId: "disp" }), worker.id]);
    const attempts = JSON.stringify([{ id: "a_work", botId: "w_codex", engine: "codex", model: "", effort: "", conversationId: worker.id, inputMessageId: "m_work", startedAt: Date.now() }]);
    await hub.store.db.run("INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,paused,attempts_json,created_at,updated_at) VALUES('t_work','disp',?,'r_work','整理资料','整理资料','working',0,?,?,?)", [home.id, attempts, Date.now(), Date.now()]);
    await pair(page, hub); await showDisconnectedBots(page); await waitForClientOnline(page);
    await page.getByRole("button", { name: "打开 调度员", exact: true }).click();
    await page.locator(".host-workspace:not([hidden]) .dispatch-tickets-trigger").click();
    await page.locator('[data-ticket-id="t_work"]').getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.getByRole("heading", { name: "工单：整理资料", exact: true, level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "对话详情", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "对话设置", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "对话设置", exact: true });
    await expect(panel.getByRole("heading", { name: "聊天与上下文", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "新建独立对话", exact: true })).toHaveCount(0);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
