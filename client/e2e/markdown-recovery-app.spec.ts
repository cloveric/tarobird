import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { showDisconnectedBots, selectConversation } from "./fixtures/mobile.js";

for (const width of [1360, 390]) test(`built App restores formatting locally without sending another message (${width}px)`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-format-retry-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const text = "**整理好了。**\n\n这份阅读清单会保留在当前对话中。\n\n| 项目 | 进度 |\n|---|---|\n| 阅读清单 | 已完成 |\n| 参考资料 | 已归档 |";
  const sends: unknown[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    try { const value = JSON.parse(String(frame.payload)); if (value.type === "message.send" || value.type === "card.action") sends.push(value); } catch { /* non-JSON frame */ }
  }));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','阅读助手',?)", [hashSecret("synthetic-formatting-recovery")]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "本周阅读清单", "formatting-recovery");
    const message = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text }] });
    await page.addInitScript(() => {
      const api = window as any, NativeWorker = window.Worker;
      Object.assign(api, { allowMarkdown: false, markdownAttempts: 0 });
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          if (String(url).includes("markdown.worker")) { api.markdownAttempts++; if (!api.allowMarkdown) throw new Error("test_worker_unavailable"); }
          super(url, options);
        }
      };
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    if (width <= 760) await selectConversation(page, "本周阅读清单");
    const row = page.locator(`[data-message-id="${message.id}"]`), retry = row.getByRole("button", { name: "恢复排版", exact: true });
    await expect(retry).toBeVisible();
    await expect(row.locator(".markdown-pending")).toHaveText(text);
    expect(await page.evaluate(() => (window as any).markdownAttempts)).toBe(2);
    if (width === 390) await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    // Capture the settled dark-theme foreground, not the first transition frame.
    await expect(retry).toHaveCSS("color", await row.locator(".markdown").evaluate(node => getComputedStyle(node).color));
    await page.screenshot({ path: info.outputPath(`built-formatting-fallback-${width}.png`), animations: "disabled" });
    await page.evaluate(() => { (window as any).allowMarkdown = true; });
    await retry.click();
    await expect(row.locator(".markdown strong")).toHaveText("整理好了。");
    await expect(row.locator(".markdown table")).toHaveCount(1);
    await expect(retry).toHaveCount(0);
    await expect(row.locator(".markdown")).toBeFocused();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
    expect(sends).toEqual([]);
    const rows = await hub.store.db.all<{ id: string; blocks_json: string }>("SELECT id,blocks_json FROM messages WHERE conversation_id=?", [chat.id]);
    expect(rows).toHaveLength(1); expect(rows[0].id).toBe(message.id); expect(JSON.parse(rows[0].blocks_json)).toEqual([{ type: "text", text }]);
    expect(await page.evaluate(() => (window as any).markdownAttempts)).toBe(3);
    await page.screenshot({ path: info.outputPath(`built-formatting-restored-${width}.png`), animations: "disabled" });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
