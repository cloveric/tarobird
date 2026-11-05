import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { createServer } from "./fixtures/vite.js";

test.use({ serviceWorkers: "block" });
const workspace = (page: Page) => page.locator('.host-workspace:not([hidden])');
async function pair(page: Page, hub: HubServer, name: string, origin: string, add = false) {
  if (add) await clickAppAction(page, "连接另一台主机", workspace(page).getByRole("button", { name: "连接另一台主机", exact: true }));
  else await page.goto(origin);
  await page.getByLabel("主机名称", { exact: true }).fill(name);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
}
async function bounded(row: Locator, badge: Locator) {
  const box = await row.boundingBox(), tag = await badge.boundingBox();
  expect(box).not.toBeNull(); expect(tag).not.toBeNull();
  expect(tag!.x).toBeGreaterThan(box!.x + box!.width / 2);
  expect(tag!.x + tag!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  const layout = await row.evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth, children: Array.from(el.children).map(child => ({ class: child.className, width: child.getBoundingClientRect().width })) }));
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1);
}

test("source hosts stay on the right and same-name rows keep their owner across desktop and phone", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-source-badges-"));
  const vite = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false } }); await vite.listen();
  const origin = vite.resolvedUrls!.local[0]!;
  const a = await HubServer.start({ stateDir: path.join(root, "a"), origins: [new URL(origin).origin] });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [new URL(origin).origin] });
  const hostNames = ["Mac mini", "项目工作室的 Windows 主机"];
  try {
    for (const [hub, text] of [[a, "A 主机的回复"], [b, "B 主机的回复"]] as const) {
      await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_PROFILE_KEY, JSON.stringify({ name: hostNames[hub === a ? 0 : 1], revision: 1 })]);
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','同名助手','fixture',1)");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0)");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','bot','alpha',0)");
      await hub.store.publishBotMessage("alpha", { conversationId: "same", blocks: [{ type: "text", text }], status: "complete" });
    }
    await pair(page, a, hostNames[0]!, origin);
    await expect(workspace(page).locator(".host-source-badge")).toHaveCount(0);
    await pair(page, b, hostNames[1]!, origin, true);
    for (const [index, name] of hostNames.entries()) {
      const side = workspace(page).locator(".sidebar");
      const tree = side.locator('.bot-tree').filter({ has: page.locator(".host-source-badge", { hasText: name }) });
      const row = tree.locator('.conversation-row[data-conversation-id="same"]');
      const bot = side.locator('.bot-tree-heading').filter({ has: page.locator(".host-source-badge", { hasText: name }) });
      await bounded(bot, bot.locator(".host-source-badge"));
      await expect(row.locator(".host-source-badge")).toHaveCount(0);
      await row.click();
      await expect(workspace(page).locator(".message-blocks").filter({ hasText: `${index ? "B" : "A"} 主机的回复` })).toHaveCount(1);
      const header = workspace(page).locator(".conversation-header");
      await expect(header.locator(".host-source-badge")).toHaveAttribute("title", `运行于 ${name}`);
      await bounded(header, header.locator(".host-source-badge"));
    }
    await workspace(page).getByRole("button", { name: "按对话", exact: true }).click();
    const divider = workspace(page).getByRole("separator", { name: "调整侧栏宽度" });
    await divider.focus(); await page.keyboard.press("Home");
    // Add unread activity to the inactive chat while the other chat is selected.
    // A source badge plus an unread count must not create a third metadata row.
    await a.store.publishBotMessage("alpha", { conversationId: "same", blocks: [{ type: "text", text: "A 主机的新回复" }], status: "complete" });
    const unreadRow = workspace(page).locator('.sidebar .conversation-row').filter({ has: page.locator(".host-source-badge", { hasText: hostNames[0] }) });
    await expect(unreadRow.locator(".unread-badge")).toBeVisible();
    const metadataGeometry: Array<{ height: number; timeOffset: number; titleOffset: number }> = [];
    for (const name of hostNames) {
      const row = workspace(page).locator('.sidebar .conversation-row').filter({ has: page.locator(".host-source-badge", { hasText: name }) });
      await bounded(row, row.locator(".host-source-badge"));
      metadataGeometry.push(await row.evaluate(el => {
        const box = el.getBoundingClientRect();
        const time = el.querySelector(".inbox-row-meta time")!.getBoundingClientRect();
        return { height: box.height, timeOffset: time.top - box.top, titleOffset: el.querySelector(".inbox-row-title")!.getBoundingClientRect().top - box.top };
      }));
    }
    for (const row of metadataGeometry) expect(Math.abs(row.timeOffset - row.titleOffset)).toBeLessThan(2);
    expect(metadataGeometry[0]!.height).toBeCloseTo(metadataGeometry[1]!.height, 0);
    expect(metadataGeometry[0]!.timeOffset).toBeCloseTo(metadataGeometry[1]!.timeOffset, 0);
    await page.screenshot({ path: info.outputPath("desktop-host-sources.png") });
    await page.setViewportSize({ width: 320, height: 740 });
    await workspace(page).getByRole("button", { name: "打开会话列表", exact: true }).click();
    for (const [index, name] of hostNames.entries()) {
      const row = workspace(page).locator('.mobile-home .mh-row').filter({ has: page.locator(".host-source-badge", { hasText: name }) });
      await bounded(row, row.locator(".host-source-badge"));
      await expect(row.locator(".mh-row-tag")).not.toContainText(name);
      await row.click();
      await expect(workspace(page).locator(".message-blocks").filter({ hasText: `${index ? "B" : "A"} 主机的回复` })).toHaveCount(1);
      const header = workspace(page).locator(".conversation-header");
      await page.screenshot({ path: info.outputPath(`phone-header-${index}.png`) });
      await bounded(header, header.locator(".host-source-badge"));
      expect((await header.locator("h1").boundingBox())!.width).toBeGreaterThan(88);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await workspace(page).getByRole("button", { name: "打开会话列表", exact: true }).click();
    }
    await workspace(page).locator('.mh-tabbar').getByRole("button", { name: "Bot", exact: true }).click();
    for (const name of hostNames) {
      const row = workspace(page).locator('.mh-bot-main').filter({ has: page.locator(".host-source-badge", { hasText: name }) });
      await bounded(row, row.locator(".host-source-badge"));
    }
    await page.screenshot({ path: info.outputPath("phone-host-sources.png") });
  } finally { await page.close(); await Promise.all([a.close(), b.close(), vite.close()]); await rm(root, { recursive: true, force: true }); }
});
