import { preparePairing } from "./fixtures/pairing-invite.js";
import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { messageAction } from "./fixtures/message-actions.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";

const note = "⚠️ 核对提示：若它是退款，账上应有一笔对应的**原始消费**。目前只有另一笔消费记录，需要一起核对，暂时保留在待确认项目中。";
// Six columns deliberately exceed even the denser desktop table layout.
const header = "| 序号 | 项目 | 金额 | 日期 | 单号 | 备注 |\n| --- | --- | ---: | --- | --- | --- |\n";
const table = (rows = 3) => header + Array.from({ length: rows }, (_, i) => `| ${i + 1} | 酒店正向款项（示例） | **1,041.28** | 2026-10-12 | ORDER-20261012-${i + 1} | ${note} |`).join("\n");

test("desktop prose comparisons fit their chat pane without shrinking phone or body text", async ({ page }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "table-comparison-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const original = "本周我们整理了项目中的主要问题，并对每一项调整进行了检查。这里保留原始表述，方便结合上下文核对具体修改，也可以直接对比右侧的修改版本。";
  const revised = "本周已整理项目中的主要问题，并逐项检查调整结果。原文与修改后的版本并排展示，方便读者直接比较措辞、确认含义，再决定是否采用这次修改。";
  const comparison = "以下对比保留全部原文。\n\n| 位置 | 你的原版 | 调整后 |\n| --- | --- | --- |\n" +
    ["第3段", "第4段", "最后一段，前半"].map(label => `| ${label} | ${original} | ${revised} |`).join("\n");
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('compare','阅读助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["compare"], "修改前后对照", "compare");
    const source = await hub.store.publishBotMessage("compare", { conversationId: chat.id, blocks: [{ type: "text", text: comparison }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const row = page.locator(`[data-message-id="${source.id}"]`), scroller = row.locator(".table-scroll");
    const prose = row.getByText("以下对比保留全部原文。", { exact: true });
    const geometry = [];
    for (const width of [1360, 1080]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(scroller).toBeVisible();
      await expect.poll(() => scroller.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await expect(prose).toHaveCSS("font-size", "14px");
      await expect(row.locator("td").first()).toHaveCSS("font-size", "12.88px");
      await expect(row.getByRole("cell", { name: revised, exact: true })).toHaveCount(3);
      geometry.push(await scroller.evaluate(el => ({ viewport: el.clientWidth, table: el.scrollWidth, rowHeight: el.querySelector("tbody tr")!.getBoundingClientRect().height })));
      await page.screenshot({ path: info.outputPath(`comparison-${width}.png`), animations: "disabled" });
    }
    // A terminal theme's specificity must not silently restore the oversized table.
    for (const palette of ["cli"]) {
      await openSettings(page); await page.locator(`input[name="color-palette"][value="${palette}"]`).check(); await closeSettings(page);
      await page.evaluate(() => document.fonts.ready);
      await expect(row.locator("td").first()).toHaveCSS("font-size", "12.88px");
      await expect(prose).toHaveCSS("font-size", "14px");
      await expect.poll(() => scroller.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    // Narrow panes can still scroll readable columns, and expansion uses the same scale.
    await page.setViewportSize({ width: 800, height: 1000 });
    const expand = row.getByRole("button", { name: "展开表格", exact: true });
    await expect(expand).toBeVisible(); await expand.click();
    const dialog = page.getByRole("dialog", { name: "表格", exact: true });
    await expect(dialog.locator("td").first()).toHaveCSS("font-size", "12.88px");
    await expect.poll(() => dialog.locator(".markdown-table-reader").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await dialog.getByRole("button", { name: "关闭表格", exact: true }).click();
    expect(await page.locator(".message-scroll").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // Native landscape phones exceed the desktop breakpoint; do not shrink them.
    for (const platform of ["ios", "android"]) {
      await page.evaluate(platform => { document.documentElement.dataset.platform = platform; }, platform);
      await expect(row.locator("td").first()).toHaveCSS("font-size", "14px");
    }
    await page.evaluate(() => { document.documentElement.dataset.platform = "web"; });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row.locator("td").first()).toHaveCSS("font-size", "14px");
    await info.attach("comparison-geometry", { contentType: "application/json", body: JSON.stringify(geometry, null, 2) });
    await writeFile(info.outputPath("comparison-geometry.json"), JSON.stringify(geometry, null, 2));
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("user-sent tables keep their content width in desktop bubbles, quotes and narrow panes", async ({ page }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "table-user-bubble-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const small = "| 名称 | 说明 | 状态 |\n|---|---|---|\n| 原生输入 | 立即发送与撤回 | 已修复 |\n| 后台任务 | 分组卡与停靠栏 | 待复核 |";
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('compare','阅读助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["compare"], "用户表格", "user-table");
    const card = await hub.store.publishBotMessage("compare", { conversationId: chat.id, blocks: [{ type: "card", title: "汇总", elements: [{ type: "markdown", text: small }] }] });
    const { message: user } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "table", text: `表：\n\n${small}`, attachments: [] });
    const { message: quoting } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "quote", text: "引用上面的汇总", replyTo: card.id, attachments: [] });
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const fits = (id: string) => page.locator(`[data-message-id="${id}"]`).filter({ visible: true }).locator(".table-scroll").first()
      .evaluate(el => ({ fits: el.scrollWidth <= el.clientWidth + 1, viewport: el.clientWidth }));
    const bubble = page.locator(`[data-message-id="${user.id}"] .message-blocks`);
    for (const width of [1360, 1080, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(bubble.locator("td").first()).toHaveCSS("font-size", "12.88px");
      // Before the fix inline-size containment shrank this shrink-to-fit bubble to its caption.
      await expect.poll(async () => (await fits(user.id)).fits).toBe(true);
      expect((await fits(user.id)).viewport).toBeGreaterThan(200);
      await expect(bubble.locator(".markdown-table-tools")).toHaveCount(0);
      await expect.poll(async () => (await fits(card.id)).fits).toBe(true);
      await expect.poll(async () => (await fits(quoting.id)).fits).toBe(true);
      await page.screenshot({ path: info.outputPath(`user-table-${width}.png`), animations: "disabled" });
    }
    // The ADHD board renders each conversation in a narrower pane.
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("checkbox", { name: new RegExp(`^加入面板：.* · ${chat.title}$`) }).check();
    await expect.poll(async () => (await fits(user.id)).fits).toBe(true);
    expect((await fits(user.id)).viewport).toBeGreaterThan(200);
    await page.screenshot({ path: info.outputPath("user-table-adhd.png"), animations: "disabled" });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [1360, 390, 320]) test(`wide message tables scroll locally, expand and preserve context (${width}px)`, async ({ browser, browserName }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "markdown-tables-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 760 });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('tables','阅读助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["tables"], "账单核对示例", "tables");
    const blocks = (text: string) => [{ type: "card" as const, title: "账单核对", elements: [{ type: "markdown" as const, text }] }];
    const source = await hub.store.publishBotMessage("tables", { conversationId: chat.id, blocks: blocks(table()) });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const row = page.locator(`[data-message-id="${source.id}"]`), scroller = row.locator(".table-scroll");
    const expand = row.getByRole("button", { name: "展开表格", exact: true });
    await expect(expand).toBeVisible();
    await expand.scrollIntoViewIfNeeded();
    const dimensions = await scroller.evaluate(node => {
      const cells = node.querySelectorAll<HTMLTableCellElement>("tbody tr:first-child td");
      const amount = cells[2].querySelector(".markdown-table-cell")!;
      const rect = amount.getBoundingClientRect();
      return { viewport: node.clientWidth, table: node.scrollWidth, rowHeight: cells[0].parentElement!.getBoundingClientRect().height,
        amountHeight: rect.height, lineHeight: parseFloat(getComputedStyle(amount).lineHeight),
        noteWidth: cells[5].getBoundingClientRect().width, align: getComputedStyle(cells[2]).textAlign };
    });
    expect(dimensions.table).toBeGreaterThan(dimensions.viewport);
    expect(dimensions.rowHeight).toBeLessThan(200);
    expect(dimensions.noteWidth).toBeGreaterThan(width > 760 ? 220 : 260);
    expect(dimensions.amountHeight).toBeCloseTo(dimensions.lineHeight, 0);
    expect(dimensions.align).toBe("right");
    expect(await page.locator(".message-scroll").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`table-${width}.png`), animations: "disabled" });
    if (width < 760 && browserName === "chromium") {
      const cdp = await context.newCDPSession(page), bounds = (await scroller.boundingBox())!;
      const start = bounds.x + bounds.width - 20, y = bounds.y + 60;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start, y }] });
      for (let step = 1; step <= 6; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start - step * 25, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(() => scroller.evaluate(node => node.scrollLeft)).toBeGreaterThan(80);
      await expect(page.getByRole("dialog", { name: "消息操作", exact: true })).toHaveCount(0);
      await cdp.detach();
    }
    await scroller.focus(); await page.keyboard.press("ArrowRight");
    await expect.poll(() => scroller.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    await scroller.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    const offset = await scroller.evaluate(node => node.scrollLeft);
    await expect(scroller.getByText("原始消费", { exact: true }).first()).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`table-scrolled-${width}.png`), animations: "disabled" });

    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("保留这份草稿");
    await expand.click();
    const dialog = page.getByRole("dialog", { name: "表格", exact: true });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: info.outputPath(`table-expanded-${width}.png`), animations: "disabled" });
    const close = dialog.getByRole("button", { name: "关闭表格", exact: true });
    await expect(close).toBeInViewport({ ratio: 1 });
    const modalRect = (await dialog.boundingBox())!;
    expect(modalRect.x).toBeGreaterThanOrEqual(0); expect(modalRect.y).toBeGreaterThanOrEqual(0);
    expect(modalRect.x + modalRect.width).toBeLessThanOrEqual(width + 1);
    expect(modalRect.y + modalRect.height).toBeLessThanOrEqual(845);
    if (width < 760) expect(modalRect.height).toBeGreaterThanOrEqual(843);
    if (width === 390) {
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--safe-area-inset-top", "36px");
        document.documentElement.style.setProperty("--safe-area-inset-bottom", "24px");
      });
      const closeRect = (await close.boundingBox())!;
      expect(closeRect.y).toBeGreaterThanOrEqual(36);
      expect(await dialog.locator(".markdown-table-reader").evaluate(node => node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(820);
      await page.evaluate(() => {
        document.documentElement.style.removeProperty("--safe-area-inset-top");
        document.documentElement.style.removeProperty("--safe-area-inset-bottom");
      });
    }
    await hub.store.publishBotMessage("tables", { id: source.id, conversationId: chat.id, blocks: blocks(table(20)) });
    await expect(dialog.locator("tbody tr")).toHaveCount(20);
    const reader = dialog.getByRole("region", { name: "表格内容", exact: true });
    await reader.evaluate(node => { node.scrollTop = 300; node.scrollLeft = node.scrollWidth; });
    expect(await reader.evaluate(node => Math.abs(node.querySelector("th")!.getBoundingClientRect().top - node.getBoundingClientRect().top))).toBeLessThan(2);
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })))).toBe(true);
    await expect(dialog).toHaveCount(0); await expect(expand).toBeFocused();
    await expect(composer).toHaveValue("保留这份草稿");
    expect(await scroller.evaluate(node => node.scrollLeft)).toBeCloseTo(offset, 0);

    // A small table uses the available width without unnecessary reading controls.
    await hub.store.publishBotMessage("tables", { id: source.id, conversationId: chat.id, blocks: blocks("| 名称 | 金额 |\n| --- | ---: |\n| 小计 | 12.00 |") });
    await expect(row.getByRole("cell", { name: "小计", exact: true })).toBeVisible();
    await expect(expand).toHaveCount(0);
    expect(await scroller.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    // Plain Markdown messages share the layout. Very long tokens stay bounded.
    await hub.store.publishBotMessage("tables", { id: source.id, conversationId: chat.id, blocks: [{ type: "text", text: table() + `\n| 4 | ${"a".repeat(240)} | 50.00 | 2026-10-13 | ORDER-20261013-4 | [查看说明](https://example.com) |` }] });
    await expect(expand).toBeVisible();
    const longCell = row.getByRole("cell", { name: "a".repeat(240), exact: true });
    expect((await longCell.boundingBox())!.width).toBeLessThan(400);
    await messageAction(page, row, "引用回复");
    const preview = page.locator(".reply-preview .rich-message-preview");
    await expect(preview.locator("table")).toHaveCount(1);
    await expect(preview.locator(".markdown button, .markdown a[href], .markdown [tabindex]")).toHaveCount(0);
    await page.getByRole("button", { name: "取消引用", exact: true }).click();
    await expand.click(); await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expand.click();
    // Unmounting streamed content must not strand a modal or back handler.
    await hub.store.publishBotMessage("tables", { id: source.id, conversationId: chat.id, blocks: [{ type: "text", text: "核对完成" }] });
    await expect(dialog).toHaveCount(0);
    await expect(row.getByText("核对完成", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("保留这份草稿");
    expect(errors).toEqual([]);
    await info.attach("geometry", { contentType: "application/json", body: JSON.stringify(dimensions, null, 2) });
    await writeFile(info.outputPath("geometry.json"), JSON.stringify(dimensions, null, 2));
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
