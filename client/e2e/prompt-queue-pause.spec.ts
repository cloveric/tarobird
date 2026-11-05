import { test, expect, type Page, type Locator, type CDPSession } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubPromptQueue } from "../../src/hub/prompt-queue.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function pair(page: Page, hub: HubServer, title: string) {
  await page.goto(hub.url); await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await selectConversation(page, title);
}
async function touchStart(text: Locator, cdp?: CDPSession) {
  const box = await text.boundingBox(); if (!box) throw new Error("queue_text_not_visible");
  const point = { clientX: box.x + 12, clientY: box.y + 8, pointerId: 42, pointerType: "touch", isPrimary: true, button: 0, bubbles: true };
  if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.clientX, y: point.clientY }] });
  else await text.dispatchEvent("pointerdown", point); // WebKit automation has no touch-hold API.
  return point;
}
for (const layout of ["desktop", "phone", "adhd"] as const) test.describe(layout, () => {
 test.use({ isMobile: layout === "phone", hasTouch: layout === "phone" });
 test(`pause/start preserve order and synchronize with another App (${layout})`, async ({ page, browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-pause-app-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const secondContext = await browser.newContext({ serviceWorkers: "block" });
  const second = await secondContext.newPage();
  const cdp = layout === "phone" && browser.browserType().name() === "chromium" ? await page.context().newCDPSession(page) : undefined;
  try {
    await hub.profile.update({ name: "暂停测试主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('alpha','测试助手','fixture','codex',1)");
    const queue = new HubPromptQueue(hub.store); await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "暂停与继续", "create");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `pause-${i}`, text: `排队任务 ${i + 1}`, attachments: [] })).message.id);
    await page.setViewportSize({ width: layout === "phone" ? 320 : 1500, height: 900 });
    await pair(page, hub, chat.title); await pair(second, hub, chat.title);
    if (layout === "adhd") {
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await page.getByRole("checkbox", { name: `加入面板：暂停测试主机 · ${chat.title}`, exact: true }).check();
    }
    const composer = page.locator(".composer textarea").filter({ visible: true }); await composer.fill("保留聊天草稿");
    const open = () => page.getByRole("button", { name: "管理待执行消息，共 3 条", exact: true }).click();
    await open(); await second.getByRole("button", { name: "管理待执行消息，共 3 条", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    const row = (id: string) => panel.locator(`[data-queue-message-id="${id}"]`);
    const secondRow = (id: string) => second.locator(`[data-queue-message-id="${id}"]`);
    await row(ids[0]).getByRole("button", { name: "暂停第 1 条消息", exact: true }).click();
    await expect(row(ids[0])).toHaveAttribute("data-paused", "true");
    await expect(row(ids[0]).getByText("已暂停", { exact: true })).toBeVisible();
    await expect(secondRow(ids[0])).toHaveAttribute("data-paused", "true");
    expect((await queue.read("owner", "alpha", chat.id)).items.map(item => item.message.id)).toEqual(ids);
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await panel.screenshot({ path: info.outputPath(`pause-${layout}.png`) });
    if (layout === "phone") {
      // Keep a normal phone's five actions on one row, with touch-size targets.
      await page.setViewportSize({ width: 390, height: 900 });
      const actions = row(ids[0]).locator(".prompt-queue-actions button");
      await expect.poll(async () => actions.evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().top))).size)).toBe(1);
      expect(await actions.evaluateAll(nodes => nodes.every(node => { const r = node.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }))).toBe(true);
      await panel.screenshot({ path: info.outputPath("pause-phone-390.png") });
      await page.setViewportSize({ width: 320, height: 900 });
    }
    // A menu targets the canonical ID, not a row number. Closing it must not send anything.
    if (layout === "phone") {
      const text = row(ids[0]).locator(".prompt-queue-text");
      const point = await touchStart(text, cdp);
      await expect(page.getByRole("menu", { name: "待执行消息操作" })).toBeVisible();
      if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      else await text.dispatchEvent("pointerup", point);
      await expect(page.getByRole("menu", { name: "待执行消息操作" })).toBeVisible();
      // Only a new deliberate tap activates the menu, not the finger releasing the hold.
      await page.getByRole("menuitem", { name: "开始", exact: true }).tap();
    } else {
      await row(ids[0]).click({ button: "right" });
      await page.getByRole("menuitem", { name: "开始", exact: true }).click();
    }
    await expect(row(ids[0])).not.toHaveAttribute("data-paused", "true");
    await expect(secondRow(ids[0])).not.toHaveAttribute("data-paused", "true");
    // Restore from a second device and reopen locally: no client-only state.
    for (let i = 0; i < ids.length; i++) await secondRow(ids[i]).getByRole("button", { name: `暂停第 ${i + 1} 条消息`, exact: true }).click();
    await expect(row(ids[2])).toHaveAttribute("data-paused", "true");
    await panel.getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    await expect(page.locator(".prompt-queue-trigger").filter({ visible: true })).toContainText("全部已暂停");
    await expect(composer).toHaveValue("保留聊天草稿");
    await open(); await expect(row(ids[0])).toHaveAttribute("data-paused", "true");
    if (layout === "phone") {
      const text = row(ids[0]).locator(".prompt-queue-text"), point = await touchStart(text, cdp);
      if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.clientX, y: point.clientY + 30 }] });
      else await text.dispatchEvent("pointermove", { ...point, clientY: point.clientY + 30 });
      await page.waitForTimeout(550);
      await expect(page.getByRole("menu", { name: "待执行消息操作" })).toHaveCount(0);
      if (cdp) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      else await text.dispatchEvent("pointerup", point);
    }
    await row(ids[1]).getByRole("button", { name: "开始第 2 条消息", exact: true }).click();
    await expect(row(ids[1])).not.toHaveAttribute("data-paused", "true");
    const claimed = await queue.take("alpha", chat.id, () => true); expect(claimed?.id).toBe(ids[1]);
    await expect(row(ids[1])).toHaveCount(0); await expect(secondRow(ids[1])).toHaveCount(0);
    await expect(row(ids[0])).toHaveAttribute("data-paused", "true");
  } finally { await cdp?.detach().catch(() => {}); await page.close(); await secondContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
});
