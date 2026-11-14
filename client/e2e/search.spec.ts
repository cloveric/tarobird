import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, openMobileSearch } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { mobileHome } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await expect((page.viewportSize()?.width ?? 1360) <=760 ? mobileHome(page) : page.locator(".connection-pill.online")).toBeVisible();
}
async function search(page: Page, query: string) {
  const menu = page.getByRole("button", { name: "打开会话列表", exact: true });
  if (await menu.isVisible()) await menu.click();
  if ((page.viewportSize()?.width ?? 1360) <=760) { await openMobileSearch(page); await mobileHome(page).getByLabel("查找会话或 Bot", {exact:true}).fill(query); await mobileHome(page).getByRole("button",{name:"搜索历史消息",exact:true}).click(); return; }
  const input = page.getByRole("textbox", { name: "搜索历史消息", exact: true }); await input.fill(query); await input.press("Enter");
}
function holdSearch(page: Page, keyword: string, cursor?: boolean) {
  let release!: () => void, entered!: () => void, complete!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
  const finished = new Promise<void>((resolve) => { complete = resolve; });
  const installed = page.route((url) => url.pathname === "/api/search/page" && url.searchParams.get("q") === keyword && (cursor === undefined || url.searchParams.has("cursor") === cursor), async (route) => {
    try { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); } catch { /* The user can close or supersede this real request. */ } finally { complete(); }
  });
  return { installed, ready, release, finished };
}

for (const scenario of [
  { name: "Android phone", width: 480, height: 900, touch: true, platform: "android", english: false },
  { name: "iPhone narrow English", width: 320, height: 740, touch: true, platform: "ios", english: true },
  { name: "iPad touch", width: 1024, height: 768, touch: true, platform: "ios", english: false },
  { name: "desktop English", width: 1360, height: 900, touch: false, platform: "web", english: true },
]) test(`history pagination never covers long results (${scenario.name})`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "search-pager-layout-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, hasTouch: scenario.touch, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.profile.update({ name: "Sample host", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Archive assistant','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "Archive notes", "pager-layout");
    for (let i = 0; i < 55; i++) await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: `Archive ${i}: ${"长段落和 English text should remain readable while scrolling. ".repeat(16)}` }] });
    await pair(page, hub);
    if (scenario.english) {
      await openSettings(page, "general");
      await page.locator("#font-size").focus();
      await page.locator("#font-size").press("End");
      await expect(page.locator("#font-size")).toHaveValue("20");
      await page.locator("#language").selectOption("en");
      await closeSettings(page, true);
    }
    if (!scenario.english) await search(page, "Archive");
    else if (scenario.width <= 760) {
      await mobileHome(page).getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("button", { name: /^Message/ }).click();
      await mobileHome(page).getByRole("button", { name: "Search conversations or Bots", exact: true }).click();
      await mobileHome(page).getByLabel("Find chats or bots", { exact: true }).fill("Archive");
      await mobileHome(page).getByRole("button", { name: "Search message history", exact: true }).click();
    } else {
      const field = page.getByRole("textbox", { name: "Search message history", exact: true });
      await field.fill("Archive"); await field.press("Enter");
    }
    // Browser layout coverage only: platform skin and safe-area tokens do not
    // claim a native device or keyboard run.
    await page.evaluate(({ platform, touch }) => {
      document.documentElement.dataset.platform = platform;
      if (touch) document.documentElement.style.setProperty("--app-safe-bottom", "24px");
    }, scenario);
    const results = page.locator(".search-results"), items = results.locator(":scope > button");
    const pager = page.getByRole("navigation", { name: scenario.english ? "Search pages" : "搜索翻页", exact: true });
    await expect(items).toHaveCount(50);
    await results.evaluate(node => { node.scrollTop = 650; });
    await page.screenshot({ path: info.outputPath("long-results-pagination.png"), animations: "disabled" });
    const checkLayout = async () => {
      const content = (await results.boundingBox())!, controls = (await pager.boundingBox())!;
      // The reader and the control strip own disjoint space; no excerpt can
      // pass behind a floating pager, including part-way down a long card.
      expect(content.y + content.height).toBeLessThanOrEqual(controls.y + 1);
      expect(controls.y + controls.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1);
      const card = (await items.first().boundingBox())!;
      const previous = (await pager.locator("button").first().boundingBox())!;
      const next = (await pager.locator("button").last().boundingBox())!;
      expect(Math.abs(previous.x - card.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(next.x + next.width - card.x - card.width)).toBeLessThanOrEqual(1);
      for (const button of await pager.locator("button").all()) {
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
        expect(await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    };
    await checkLayout();
    await results.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(items.last()).toBeInViewport(); await checkLayout();
    await pager.getByRole("button", { name: scenario.english ? "Next" : "下一页", exact: true }).click();
    await expect(items).toHaveCount(5); await expect.poll(() => results.evaluate(node => node.scrollTop)).toBe(0);
    await pager.getByRole("button", { name: scenario.english ? "Previous" : "上一页", exact: true }).click();
    await expect(items).toHaveCount(50);
    if (scenario.touch) {
      await page.setViewportSize({ width: scenario.width, height: 420 });
      await checkLayout();
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [390, 1360]) test(`search highlights literal applied matches safely in light and dark themes (${width})`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "search-highlight-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await hub.profile.update({ name: "示例电脑", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "项目讨论", "highlight");
    const text = "好的，📎好的。下一步核对资料。";
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: `## ${text}` }] });
    for (const text of ["AbC abc ABC", "a+b.*[x](?)", '<img onerror="alert(1)">', "[报告](https://example.com/needle) needle", "x".repeat(220)]) {
      await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text }] });
    }
    await pair(page, hub); await search(page, "好的");
    const results = page.locator(".search-results"), items = results.locator(":scope > button"), input = results.getByLabel("搜索关键词", { exact: true });
    await expect(items).toHaveCount(1); await expect(items.locator("mark")).toHaveText(["好的", "好的"]);
    await expect(items.locator("p")).toHaveText(text);
    // Selecting/copying a snippet keeps the original visible text exactly once.
    expect(await items.locator("p").evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); return r.toString(); })).toBe(text);
    for (const palette of ["white-violet", "white-orange", "mono", "sage", "cli"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      const readColors = () => items.locator("mark").first().evaluate(el => {
        const style = getComputedStyle(el), rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
        const luminance = (s: string) => rgb(s).slice(0, 3).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
        const fg = luminance(style.color), bg = luminance(style.backgroundColor);
        return { background: style.backgroundColor, row: getComputedStyle(el.closest("button")!).backgroundColor, contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) };
      });
      // Result buttons transition inherited text color. Measure the settled
      // palette, not the previous theme's foreground over the new background.
      await expect.poll(async () => (await readColors()).contrast, `${palette}/${theme}`).toBeGreaterThanOrEqual(4.5);
      const colors = await readColors();
      expect(colors.background, `${palette}/${theme}`).not.toBe(colors.row);
      if (palette === "white-orange" || palette === "mono") await page.screenshot({ path: info.outputPath(`highlight-${width}-${palette}-${theme}.png`), animations: "disabled" });
    }
    await input.fill("abc");
    await expect(items.locator("mark")).toHaveText(["好的", "好的"]);
    await input.press("Enter"); await expect(items.locator("mark")).toHaveText(["AbC", "abc", "ABC"]);
    for (const [query, expected] of [["a+b.*[x](?)", ["a+b.*[x](?)"]], ['<img onerror="alert(1)">', ['<img onerror="alert(1)">']], ["needle", ["needle", "needle"]], ["x".repeat(220), ["x".repeat(220)]]] as const) {
      await input.fill(query); await input.press("Enter"); await expect(items).toHaveCount(1); await expect(items.locator("mark")).toHaveText([...expected]);
      await expect(items.locator("img,script,a")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await input.fill(""); await input.press("Enter"); await expect(items).toHaveCount(6); await expect(items.locator("mark")).toHaveCount(0);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("literal history search, filters and result navigation work on two devices without stale query races", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-search-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "搜索测试主机", revision: (await hub.profile.read()).revision });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const errors: string[] = []; for (const page of [desktop, phone]) page.on("pageerror", (error) => errors.push(error.message));
  const releases: (() => void)[] = [];
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','写作助手','fixture'),('beta','工作助手','fixture')");
    const group = await hub.store.createConversation("owner", ["alpha"], "项目讨论", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "发布资料", "topic", { parentId: group.id });
    const other = await hub.store.createConversation("owner", ["beta"], "工作记录", "other");
    const original = await hub.store.publishBotMessage("alpha", { conversationId: group.id, blocks: [{ type: "text", text: "项目记录：预算 abc%def，按原文查找。" }] });
    await hub.store.publishBotMessage("alpha", { conversationId: group.id, blocks: [{ type: "text", text: "项目记录：abcZZdef 不应命中字面百分号。" }] });
    await hub.store.db.run("INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES('search_file',?,'owner','fixture',3,'text/plain','发布说明.txt','fixture',1,0)", [topic.id]);
    const fileMessage = await hub.store.publishBotMessage("alpha", { conversationId: topic.id, blocks: [{ type: "text", text: "项目记录：发布资料与说明一起发送。" }, { type: "file", attachmentId: "search_file", name: "发布说明.txt", size: 3, mime: "text/plain" }] });
    const older = await hub.store.publishBotMessage("beta", { conversationId: other.id, blocks: [{ type: "text", text: "项目记录：八月旧资料。" }] });
    await hub.store.db.run("UPDATE messages SET created_at=?", [Date.parse("2026-09-20T12:00:00Z")]);
    await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [Date.parse("2026-08-01T12:00:00Z"), older.id]);
    for (const [page, device] of [[desktop, "desktop"], [phone, "phone"]] as const) {
      await pair(page, hub); await showDisconnectedBots(page);
      if (device === "desktop") {
        await page.locator(".conversation-row").filter({ hasText: "工作记录" }).click();
        await page.getByRole("textbox", { name: "消息", exact: true }).fill("搜索前的草稿");
        await page.getByRole("button", { name: "查看对话详情", exact: true }).click();
        await expect(page.getByRole("complementary", { name: "对话详情", exact: true })).toBeVisible();
      }
      await search(page, "abc%def");
      const results = page.locator(".search-results"), items = results.locator(":scope > button");
      const header = page.locator(".conversation-header");
      const searchContext = async () => {
        await expect(header.getByRole("heading", { name: "搜索历史消息", exact: true })).toBeVisible();
        await expect(header).toContainText("搜索范围：搜索测试主机 · 全部对话");
        await expect(header.locator(".chat-identity")).toHaveCount(0);
        await expect(header.getByRole("button", { name: "更多聊天操作", exact: true })).toHaveCount(0);
        await expect(page.getByRole("complementary", { name: "对话详情", exact: true })).toHaveCount(0);
      };
      await searchContext();
      await expect(results.getByRole("heading", { name: "搜索结果 · 1", exact: true })).toBeVisible();
      await expect(items).toHaveCount(1); await expect(items.first()).toContainText("预算 abc%def"); await expect(items.first().locator("mark")).toHaveText("abc%def");
      // Phones do not render the desktop drawer at all; none may be shown.
      if (device === "phone") await expect(page.locator(".sidebar.shown")).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveCount(0);
      if (device === "desktop") {
        await results.getByRole("button", { name: "关闭搜索", exact: true }).click();
        await expect(header.getByRole("heading", { name: "工作记录", exact: true })).toBeVisible();
        await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("搜索前的草稿");
        await page.getByRole("button", { name: "关闭对话详情", exact: true }).click();
        await search(page, "abc%def"); await searchContext(); await expect(items).toHaveCount(1);
      }
      await items.first().click(); await expect(page.locator(`[data-message-id="${original.id}"].focused-message`)).toBeVisible();
      await expect(header.getByRole("heading", { name: "项目讨论", exact: true })).toBeVisible();
      await search(page, "项目记录"); await expect(items).toHaveCount(4);
      await results.getByLabel("搜索 Bot", { exact: true }).selectOption("alpha");
      await results.getByLabel("搜索开始日期", { exact: true }).fill("2026-09-01");
      await results.getByLabel("搜索结束日期", { exact: true }).fill("2026-09-30");
      await results.getByRole("checkbox", { name: "含附件", exact: true }).check();
      await results.getByRole("button", { name: "应用筛选", exact: true }).click(); await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText("发布资料");
      await page.screenshot({ path: info.outputPath(`search-${device}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await items.first().click(); await expect(page.getByRole("heading", { name: "发布资料", exact: true })).toBeVisible();
      await expect(page.locator(`[data-message-id="${fileMessage.id}"].focused-message`)).toBeVisible();
      await search(page, "不存在的关键词"); await expect(results.getByText("没有找到匹配的消息。试试其他关键词或放宽筛选条件。", { exact: true })).toBeVisible();
      await searchContext();
      await results.getByLabel("搜索结束日期", { exact: true }).fill("2026-09-30");
      await results.getByLabel("搜索开始日期", { exact: true }).fill("2026-10-01");
      await results.getByRole("button", { name: "应用筛选", exact: true }).click();
      await expect(results.getByRole("alert")).toHaveText("开始日期不能晚于结束日期。");
      await searchContext();
      await results.getByLabel("搜索开始日期", { exact: true }).fill(""); await results.getByLabel("搜索结束日期", { exact: true }).fill("");
      await results.getByLabel("搜索 Bot", { exact: true }).selectOption(""); await results.getByRole("checkbox", { name: "含附件", exact: true }).uncheck();
      await results.getByRole("button", { name: "关闭搜索", exact: true }).click();
      const old = holdSearch(page, "八月旧资料"); releases.push(old.release); await old.installed;
      await search(page, "八月旧资料"); await old.ready;
      await expect(results.getByRole("heading", { name: "正在搜索…", exact: true })).toBeVisible();
      await searchContext();
      await results.getByRole("textbox", { name: "搜索关键词", exact: true }).fill("abc%def");
      await results.getByRole("button", { name: "应用筛选", exact: true }).click();
      await expect(items).toHaveCount(1); await expect(items.first()).toContainText("预算 abc%def"); await expect(items.first().locator("mark")).toHaveText("abc%def"); old.release(); await old.finished; await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(results.getByRole("heading", { name: "搜索结果 · 1", exact: true })).toBeVisible(); await expect(items.first()).toContainText("预算 abc%def"); await expect(items.first().locator("mark")).toHaveText("abc%def");
      const closing = holdSearch(page, "按原文查找"); releases.push(closing.release); await closing.installed;
      await results.getByRole("textbox", { name: "搜索关键词", exact: true }).fill("按原文查找");
      await results.getByRole("button", { name: "应用筛选", exact: true }).click(); await closing.ready;
      await results.getByRole("button", { name: "关闭搜索", exact: true }).click(); closing.release(); await closing.finished; await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(results).toHaveCount(0); await expect(device === "phone" ? mobileHome(page) : page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
    }
    expect(errors).toEqual([]);
  } finally {
    releases.forEach((release) => release()); await desktopContext.close().catch(() => {}); await phoneContext.close().catch(() => {});
    await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

test("desktop and phone page through older history, retain results on failure and discard superseded page responses", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "search-pages-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "搜索测试主机", revision: (await hub.profile.read()).revision });
  const contexts = [], releases: (() => void)[] = [];
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "历史档案", "history");
    const messages = [];
    for (let i = 0; i < 125; i++) messages.push(await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: `归档检索 · 记录 ${i}` }] }));
    const unique = await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "单独查询的结果" }] });
    const expected = messages.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1360, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block" }); contexts.push(context);
      const page = await context.newPage(); await pair(page, hub); await search(page, "归档检索");
      const results = page.locator(".search-results"), items = results.locator(":scope > button"), pager = page.getByRole("navigation", { name: "搜索翻页", exact: true });
      await expect(items).toHaveCount(50); await expect(items.first().locator("mark")).toHaveText("归档检索"); await expect(pager.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
      // Editing a field alone must not change the applied query while paging.
      await results.getByRole("textbox", { name: "搜索关键词", exact: true }).fill("单独查询的结果");
      await expect(results.getByText("筛选条件已修改，点击“应用筛选”更新结果。", { exact: true })).toBeVisible();
      let fail = true;
      await page.route((url) => url.pathname === "/api/search/page" && url.searchParams.has("cursor"), async (route) => {
        if (fail) { fail = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture_unavailable" }) }); }
        else await route.continue();
      });
      await pager.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(results.getByRole("alert")).toHaveText("搜索失败，请重试。");
      await expect(items).toHaveCount(50); await expect(pager.getByText("第 1 页", { exact: true })).toBeVisible();
      await pager.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(pager.getByText("第 2 页", { exact: true })).toBeVisible(); await expect(items).toHaveCount(50); await expect(items.first().locator("mark")).toHaveText("归档检索");
      await expect(items.first()).toContainText((expected[50]!.blocks[0] as { text: string }).text);
      await pager.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(items).toHaveCount(25); await expect(pager.getByText("第 3 页", { exact: true })).toBeVisible();
      await expect(pager.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
      await expect(items.last()).toContainText((expected[124]!.blocks[0] as { text: string }).text);
      await page.screenshot({ path: info.outputPath(`search-page-${mobile ? "phone" : "desktop"}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await pager.getByRole("button", { name: "上一页", exact: true }).click();
      await expect(pager.getByText("第 2 页", { exact: true })).toBeVisible();
      await expect(items.first()).toContainText((expected[50]!.blocks[0] as { text: string }).text);
      await pager.getByRole("button", { name: "下一页", exact: true }).click(); await expect(items).toHaveCount(25);
      await items.last().click(); await expect(page.locator(`[data-message-id="${expected[124]!.id}"].focused-message`)).toBeVisible();
      await search(page, "归档检索"); await expect(items).toHaveCount(50);
      const delayed = holdSearch(page, "归档检索", true); releases.push(delayed.release); await delayed.installed;
      await pager.getByRole("button", { name: "下一页", exact: true }).click(); await delayed.ready;
      await results.getByRole("textbox", { name: "搜索关键词", exact: true }).fill("单独查询的结果");
      await results.getByRole("button", { name: "应用筛选", exact: true }).click(); await expect(items).toHaveCount(1);
      delayed.release(); await delayed.finished; await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(items).toHaveCount(1); await expect(pager).toHaveCount(0);
      await items.first().click(); await expect(page.locator(`[data-message-id="${unique.id}"].focused-message`)).toBeVisible();
    }
  } finally { releases.forEach((release) => release()); for (const context of contexts) await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop conversation search scopes every page, supports keyboard navigation and preserves the draft", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-conversation-search-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "搜索测试主机", revision: (await hub.profile.read()).revision });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "当前项目", "current_search");
    const other = await hub.store.createConversation("owner", ["alpha"], "另一个项目", "other_search");
    let oldest = "";
    for (let i = 0; i < 135; i++) {
      const message = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: i < 55 ? `共同记录 ${i.toString().padStart(3, "0")}：当前项目的预算和进度。` : `较新的闲聊 ${i}` }] });
      await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [Date.parse("2026-10-01T08:00:00Z") + i * 1000, message.id]);
      if (!i) oldest = message.id;
    }
    await hub.store.publishBotMessage("alpha", { conversationId: other.id, blocks: [{ type: "text", text: "共同记录：其他会话独有内容" }] });
    await pair(page, hub); await showDisconnectedBots(page); await page.locator(".conversation-row").filter({ hasText: "当前项目" }).click();
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("搜索时保留这份草稿");
    const trigger = page.getByRole("button", { name: "搜索当前对话", exact: true });
    await expect(trigger).toBeVisible();
    await page.screenshot({ path: info.outputPath("conversation-search-entry.png"), animations: "disabled" });
    await trigger.click();
    const results = page.locator(".search-results"), items = results.locator(":scope > button");
    const input = results.getByRole("textbox", { name: "搜索关键词", exact: true });
    await expect(input).toBeFocused();
    await expect(page.locator(".conversation-header")).toContainText("搜索范围：搜索测试主机 · 当前项目");
    await expect(results.getByLabel("搜索 Bot", { exact: true })).toHaveCount(0);
    await input.fill("共同记录"); await input.press("Enter");
    await expect(items).toHaveCount(50); await expect(results).not.toContainText("其他会话独有内容");
    await page.getByRole("navigation", { name: "搜索翻页", exact: true }).getByRole("button", { name: "下一页", exact: true }).click();
    await expect(items).toHaveCount(5); await expect(items.first().locator("mark")).toHaveText("共同记录"); await expect(results).not.toContainText("其他会话独有内容");
    await page.screenshot({ path: info.outputPath("conversation-search-results.png"), animations: "disabled" });
    await items.last().click(); await expect(page.locator(`[data-message-id="${oldest}"].focused-message`)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("搜索时保留这份草稿");
    for (const modifier of ["Meta", "Control"]) {
      await page.getByRole("textbox", { name: "消息", exact: true }).focus(); await page.keyboard.press(`${modifier}+f`);
      await expect(page.getByRole("heading", { name: "搜索当前对话", exact: true })).toBeVisible(); await expect(input).toBeFocused();
      await input.fill("其他会话独有内容"); await input.press("Enter");
      await expect(results).toContainText("没有找到匹配的消息"); await expect(items).toHaveCount(0);
      await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("搜索时保留这份草稿");
    }
    // The sidebar always searches all chats; Cmd+F switches back to this one.
    await trigger.click(); await search(page, "其他会话独有内容");
    await expect(page.locator(".conversation-header")).toContainText("搜索范围：搜索测试主机 · 全部对话");
    await expect(items).toHaveCount(1); await expect(items.first()).toContainText("另一个项目");
    await page.keyboard.press("Meta+f");
    await expect(page.getByRole("heading", { name: "搜索当前对话", exact: true })).toBeVisible(); await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await page.locator(".conversation-row").filter({ hasText: "另一个项目" }).click();
    await trigger.click(); await input.fill("其他会话独有内容"); await input.press("Enter");
    await expect(items).toHaveCount(1); await expect(page.locator(".conversation-header")).toContainText("搜索范围：搜索测试主机 · 另一个项目");
    await results.getByRole("button", { name: "关闭搜索", exact: true }).click(); await expect(trigger).toBeFocused();
    await page.getByRole("button", { name: "打开连接设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "连接状态与线路", exact: true })).toBeVisible();
    await page.keyboard.press("Meta+f");
    await expect(page.getByRole("dialog", { name: "连接状态与线路", exact: true })).toBeVisible(); await expect(results).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("conversation search refuses unsupported host filters instead of showing other conversations", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-search-compat-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "搜索测试主机", revision: (await hub.profile.read()).revision });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "旧主机", "old_host_search");
    await pair(page, hub); await showDisconnectedBots(page); await page.locator(".conversation-row").filter({ hasText: "旧主机" }).click();
    for (const mode of ["rejected", "ignored"]) {
      await page.route("**/api/search/page?*", route => route.fulfill(mode === "rejected"
        ? { status: 400, json: { error: "invalid_request" } }
        : { json: { items: [{ id: "other_message", conversationId: "other_chat", createdAt: 1, excerpt: "不应显示的其他对话" }], nextCursor: null } }));
      await page.getByRole("button", { name: "搜索当前对话", exact: true }).click();
      await expect(page.locator(".search-results").getByRole("alert")).toHaveText("主机尚不支持当前对话搜索，请更新 TaroBird 主机后重试。");
      await expect(page.locator(".search-results")).not.toContainText("不应显示的其他对话");
      await page.keyboard.press("Escape"); await page.unroute("**/api/search/page?*");
    }
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
