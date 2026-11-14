import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

test.use({ serviceWorkers: "block" });
const pane = (page: Page, id: string) => page.locator(`.adhd-card[data-pane-conversation="${id}"]`);
const trigger = (card: Locator) => card.getByRole("button", { name: "搜索当前对话", exact: true });
const input = (card: Locator) => card.getByRole("textbox", { name: "搜索关键词", exact: true });
const hits = (card: Locator) => card.locator(".search-results > button");
const ranges = (card: Locator) => card.evaluate(node => [...(CSS.highlights.get("conversation-search-match") ?? [])].filter(range => node.contains(range.startContainer)).map(range => range.toString()));

async function setup(page: Page, long = false, count = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-search-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "测试主机", revision: (await hub.profile.read()).revision });
  const stateDir = path.join(root, "bot"); await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手',?)", [hashSecret(secret)]);
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const received: string[] = [];
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async message => { received.push(message.text);
    if (message.text === "安排子代理") {
      for (const [id, label] of [["one", "核对依赖"], ["two", "检查注释"]]) {
        await message.onEngineEvent?.({ type: "scoped", origin: "bound", detached: true, scope: { id, kind: "subagent", label }, event: { type: "tool_use", toolUseId: `read_${id}`, toolName: "Read", toolInput: { file_path: "README.md" } } });
        await message.onEngineEvent?.({ type: "scoped", origin: "bound", detached: true, scope: { id, kind: "subagent", label }, event: { type: "assistant_text", text: `${label}正在进行。`, delta: true } });
      }
      return { text: "子代理已安排" };
    }
    await wait; return { text: "任务完成，搜索没有停止我" }; } } });
  const chats = [];
  for (let i = 0; i < count; i++) chats.push(await hub.store.createConversation("owner", ["alpha"], `项目 ${i + 1}`, `pane_${i}`));
  let oldest = "";
  for (let i = 0; i < (long ? 135 : 3); i++) {
    const message = await hub.store.publishBotMessage("alpha", { conversationId: chats[0]!.id, blocks: [{ type: "text", text: i < 55 ? `共同记录 ${String(i).padStart(3, "0")}：项目一预算。` : `较新的闲聊 ${i}` }], status: "complete" });
    await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [Date.parse("2026-10-01T08:00:00Z") + i * 1000, message.id]);
    if (!i) oldest = message.id;
  }
  for (const chat of chats.slice(1)) await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: `共同记录：${chat.title}独有内容。` }], status: "complete" });
  await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill("测试主机"); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
  await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
  for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
  return { hub, chats, oldest, received, release, close: async () => { release(); await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
async function search(card: Locator, text: string) { await trigger(card).click(); await input(card).fill(text); await input(card).press("Enter"); }

test("another ADHD pane following a reply does not hide the hovered message actions", async ({ page }, info) => {
  const s = await setup(page);
  try {
    const a = pane(page, s.chats[0]!.id), b = pane(page, s.chats[1]!.id);
    const row = a.locator("article.message").last(), actions = row.locator(".message-actions");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = theme; }, theme);
      await row.locator(".message-blocks").hover();
      await expect(actions).toHaveCSS("opacity", "1");
      // A genuine streamed message grows pane B and its normal auto-follow
      // scrolls. The pointer stays still in pane A throughout the update.
      await s.hub.store.publishBotMessage("alpha", { conversationId: s.chats[1]!.id, blocks: [{ type: "text", text: `${theme}\n` + "另一对话正在回复。\n".repeat(90) }], status: "streaming" });
      await expect.poll(() => b.locator(".message-scroll").evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      await expect(actions).toHaveCSS("opacity", "1");
      await page.screenshot({ animations: "disabled", path: info.outputPath(`independent-pane-actions-${theme}.png`) });
      await row.getByRole("button", { name: "引用回复", exact: true }).click();
      await expect(a.locator(".reply-preview")).toBeVisible();
      await a.getByRole("button", { name: "取消引用", exact: true }).click();
      // Scrolling the containing pane must still retire the old owner.
      await row.locator(".message-blocks").hover();
      await a.locator(".message-scroll").evaluate(node => node.dispatchEvent(new Event("scroll")));
      await expect(actions).toHaveCSS("opacity", "0");
      await row.locator(".message-blocks").hover();
      await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
      await expect(actions).toHaveCSS("opacity", "0");
    }
  } finally { await s.close(); }
});

test("ADHD pane search locates older history, scopes every page and keeps drafts and attachments", async ({ page }, info) => {
  const s = await setup(page, true);
  try {
    const a = pane(page, s.chats[0]!.id), b = pane(page, s.chats[1]!.id);
    await expect(trigger(a)).toBeVisible(); await expect(trigger(b)).toBeVisible();
    await a.locator(".composer textarea").fill("项目一草稿"); await b.locator(".composer textarea").fill("项目二草稿");
    await a.locator('input[type="file"]').setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("keep draft attachment") });
    await expect(a.getByText("keep.txt", { exact: true })).toBeVisible();
    await expect(a.locator(`[data-message-id="${s.oldest}"]`)).toHaveCount(0);
    const layout = await page.locator(".adhd-card").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-pane-key")));
    await search(a, "共同记录");
    await expect(input(a)).toBeFocused(); await expect(hits(a)).toHaveCount(50);
    await expect(a.locator(".history-search-header")).toContainText("项目 1");
    await expect(a.getByLabel("搜索 Bot", { exact: true })).toHaveCount(0);
    await expect(a.getByRole("button", { name: "放大此面板", exact: true })).toBeVisible();
    await a.locator(".search-results").evaluate(node => { node.scrollTop = 400; });
    const reader = (await a.locator(".search-results").boundingBox())!;
    const pager = (await a.getByRole("navigation", { name: "搜索翻页", exact: true }).boundingBox())!;
    const card = (await a.boundingBox())!;
    expect(reader.y + reader.height).toBeLessThanOrEqual(pager.y + 1);
    expect(pager.y + pager.height).toBeLessThanOrEqual(card.y + card.height + 1);
    await a.getByRole("button", { name: "下一页", exact: true }).click(); await expect(hits(a)).toHaveCount(5);
    await expect(a.locator(".search-results")).not.toContainText("项目 2独有内容");
    await expect(hits(a).first().locator("mark")).toHaveText("共同记录");
    await page.screenshot({ animations: "disabled", path: info.outputPath("pane-search-results-light.png") });
    await hits(a).last().click();
    const located = a.locator(`[data-message-id="${s.oldest}"].focused-message`);
    await expect(located).toBeVisible(); await expect.poll(() => ranges(a)).toContain("共同记录");
    await expect(located.locator(".message-blocks")).toHaveText("共同记录 000：项目一预算。");
    await expect(located).toHaveCSS("outline-style", "none");
    await expect(a.locator(".composer textarea")).toHaveValue("项目一草稿"); await expect(b.locator(".composer textarea")).toHaveValue("项目二草稿");
    await expect(a.getByText("keep.txt", { exact: true })).toBeVisible();
    expect(await page.locator(".adhd-card").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-pane-key")))).toEqual(layout);
    await page.screenshot({ animations: "disabled", path: info.outputPath("pane-search-location-light.png") });
    await search(b, "独有内容"); await expect(hits(b)).toHaveCount(1); await hits(b).first().click();
    await expect.poll(() => ranges(b)).toContain("独有内容"); await expect.poll(() => ranges(a)).toContain("共同记录");
    // Clearing one pane must not unregister another pane's text highlights.
    await trigger(a).click(); await expect.poll(() => ranges(a)).toEqual([]); await expect.poll(() => ranges(b)).toContain("独有内容");
    await a.getByRole("button", { name: "关闭搜索", exact: true }).click(); await expect(trigger(a)).toBeFocused();
    await expect(a.locator(".composer textarea")).toHaveValue("项目一草稿"); await expect(a.getByText("keep.txt", { exact: true })).toBeVisible();
  } finally { await s.close(); }
});

test("ADHD searches keep keyboard focus, independent filters and stale responses within their pane", async ({ page }) => {
  const s = await setup(page);
  let unblock = () => {};
  try {
    const a = pane(page, s.chats[0]!.id), b = pane(page, s.chats[1]!.id);
    await a.locator(".composer textarea").focus(); await page.keyboard.press("Meta+f"); await expect(input(a)).toBeFocused();
    await expect(b.locator(".search-results")).toHaveCount(0);
    await input(a).fill("预算"); await input(a).press("Enter"); await expect(hits(a)).toHaveCount(3);
    await b.locator(".composer textarea").focus(); await page.keyboard.press("Control+f"); await expect(input(b)).toBeFocused();
    await input(b).fill("独有内容"); await input(b).press("Enter"); await expect(hits(b)).toHaveCount(1);
    await a.locator(".pane-search-options>summary").click();
    await a.getByLabel("搜索开始日期", { exact: true }).click(); await expect(a.getByLabel("搜索开始日期", { exact: true })).toBeFocused();
    await b.getByRole("button", { name: "放大此面板", exact: true }).click(); await expect(a).toBeHidden();
    await b.getByRole("button", { name: "回到面板总览", exact: true }).click(); await expect(a).toBeVisible();
    await expect(input(a)).not.toBeFocused();
    await input(b).focus();
    await page.setViewportSize({ width: 700, height: 900 });
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(input(a)).not.toBeFocused();
    await input(b).focus(); await page.keyboard.press("Escape"); await expect(trigger(b)).toBeFocused(); await expect(trigger(b)).toHaveCSS("outline-style", "none"); await expect(trigger(b)).not.toHaveCSS("box-shadow", "none"); await expect(input(a)).toHaveValue("预算");
    let ready!: () => void; const entered = new Promise<void>(resolve => { ready = resolve; });
    const hold = new Promise<void>(resolve => { unblock = resolve; });
    await page.route("**/api/search/page?**", async route => {
      if (new URL(route.request().url()).searchParams.get("q") !== "延迟") return route.continue();
      const response = await route.fetch(); ready(); await hold; await route.fulfill({ response }).catch(() => {});
    });
    await input(a).fill("延迟"); await input(a).press("Enter"); await entered;
    await a.getByRole("button", { name: "关闭搜索", exact: true }).click();
    await search(a, "预算"); await expect(hits(a)).toHaveCount(3); unblock();
    await expect(hits(a)).toHaveCount(3); await expect(input(a)).toHaveValue("预算");
    // A host that ignores the scope must never leak a different pane's hits.
    await page.unrouteAll({ behavior: "wait" });
    await page.route("**/api/search/page?**", route => route.fulfill({ json: { items: [{ id: "wrong", conversationId: s.chats[1]!.id, excerpt: "范围错误", createdAt: Date.now() }], nextCursor: null } }));
    await input(a).press("Enter"); await expect(a.getByRole("alert")).toContainText("主机尚不支持当前对话搜索"); await expect(hits(a)).toHaveCount(0);
  } finally { unblock(); await s.close(); }
});

test("ADHD narrow search controls fit with pane tools in both themes and larger reading size", async ({ page }, info) => {
  const s = await setup(page, false, 6);
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    const a = pane(page, s.chats[0]!.id);
    await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption("3");
    await search(a, "共同记录"); await expect(hits(a)).toHaveCount(3);
    for (const columns of ["3", "6"]) for (const size of ["12", "16"]) for (const theme of ["light", "dark"]) {
      await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption(columns);
      await page.getByLabel("ADHD 窗口字号", { exact: true }).selectOption(size);
      await page.evaluate(theme => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = theme; }, theme);
      const overflow = await a.evaluate(node => [...node.querySelectorAll<HTMLElement>(".conversation-header, .search-results, .search-filters")].map(n => ({ className: n.className, extra: n.scrollWidth - n.clientWidth })));
      expect(overflow, JSON.stringify({ columns, size, theme })).toEqual(overflow.map(x => ({ ...x, extra: 0 })));
      for (const name of ["关闭搜索", "放大此面板", "在单对话中打开", "移除此面板"]) await expect(a.getByRole("button", { name, exact: true })).toBeVisible();
      await a.locator(".pane-search-options").evaluate((node: HTMLDetailsElement) => { node.open = true; });
      const bounds = await a.locator(".search-filters input:not([type=checkbox]), .search-filters button").evaluateAll(nodes => nodes.every(node => { const r = node.getBoundingClientRect(), p = node.closest(".search-results")!.getBoundingClientRect(); return r.left >= p.left && r.right <= p.right; }));
      expect(bounds).toBe(true);
      await a.locator(".pane-search-options").evaluate((node: HTMLDetailsElement) => { node.open = false; });
      const hit = await hits(a).first().boundingBox(), panel = await a.boundingBox();
      expect(hit!.y + hit!.height).toBeLessThan(panel!.y + panel!.height);
      if (size === "12") await page.screenshot({ animations: "disabled", path: info.outputPath(`search-${columns}cols-${theme}.png`) });
    }
  } finally { await s.close(); }
});

test("search and close do not cancel an active pane reply or send its draft", async ({ page }) => {
  const s = await setup(page);
  try {
    const a = pane(page, s.chats[0]!.id);
    await a.locator(".composer textarea").fill("继续执行任务"); await a.locator(".composer textarea").press("Enter");
    await expect.poll(() => s.received).toEqual(["继续执行任务"]);
    await a.locator(".composer textarea").fill("下一条草稿");
    await search(a, "预算"); await expect(hits(a)).toHaveCount(3);
    await page.keyboard.press("Escape"); await expect(a.locator(".composer textarea")).toHaveValue("下一条草稿");
    s.release(); await expect(a.locator(".message-scroll")).toContainText("任务完成，搜索没有停止我");
    expect(s.received).toEqual(["继续执行任务"]);
  } finally { await s.close(); }
});


test("located search highlights split code tokens and a member of a merged background group", async ({ page }) => {
  const s = await setup(page);
  try {
    const a = pane(page, s.chats[0]!.id);
    await s.hub.store.publishBotMessage("alpha", { conversationId: s.chats[0]!.id, blocks: [{ type: "text", text: "```javascript\nconst answer = 42;\n```" }], status: "complete" });
    await search(a, "const answer"); await expect(hits(a)).toHaveCount(1); await hits(a).first().click();
    await expect.poll(() => ranges(a)).toContain("const answer");
    await expect(a.locator(".focused-message code")).toContainText("const answer = 42;");
    await a.locator(".composer textarea").fill("安排子代理"); await a.locator(".composer textarea").press("Enter");
    await expect(a.locator(".background-task-row")).toHaveCount(2);
    await expect.poll(async () => (await s.hub.store.searchPage("owner", "检查注释", { conversationId: s.chats[0]!.id })).items.length).toBe(1);
    await search(a, "检查注释"); await expect(hits(a)).toHaveCount(1); await hits(a).first().click();
    await expect(a.locator(".focused-message .background-task-name").filter({ hasText: "检查注释" })).toBeVisible();
    await expect.poll(() => ranges(a)).toEqual(["检查注释"]);
    // This remains a read-only grouped record, not the current-run controller.
    await expect(a.locator(".background-task-group").getByRole("button", { name: /停止/ })).toHaveCount(0);
  } finally { await s.close(); }
});


test("a long search result reveals the matching word and yields to subsequent reading", async ({ page }) => {
  const s = await setup(page);
  try {
    const a = pane(page, s.chats[0]!.id);
    await s.hub.store.publishBotMessage("alpha", { conversationId: s.chats[0]!.id, blocks: [{ type: "text", text: "目标词在开头\n\n" + Array.from({ length: 120 }, (_, i) => `第 ${i} 段：这是一段用于验证历史阅读的详细说明。`).join("\n\n") }], status: "complete" });
    await search(a, "目标词在开头"); await expect(hits(a)).toHaveCount(1); await hits(a).first().click();
    await expect.poll(() => a.evaluate(node => {
      const range = [...(CSS.highlights.get("conversation-search-match") ?? [])].find(r => node.contains(r.startContainer));
      const viewport = node.querySelector(".message-scroll")!.getBoundingClientRect(), rect = range?.getBoundingClientRect();
      return !!rect && rect.top >= viewport.top && rect.bottom <= viewport.bottom;
    })).toBe(true);
    const scroll = a.locator(".message-scroll");
    await scroll.hover(); await page.mouse.wheel(0, 500);
    await expect.poll(() => scroll.evaluate(n => n.scrollTop)).toBeGreaterThan(300);
    const top = await scroll.evaluate(n => n.scrollTop);
    await s.hub.store.publishBotMessage("alpha", { conversationId: s.chats[0]!.id, blocks: [{ type: "text", text: "后续回复不应拉回搜索命中处" }], status: "complete" });
    await expect.poll(() => scroll.evaluate(n => n.scrollTop)).toBeGreaterThanOrEqual(top - 2);
  } finally { await s.close(); }
});


test("Monochrome own-message matches keep bubble text contrast without inverse dark blocks", async ({ page }, info) => {
  const s = await setup(page);
  try {
    const a = pane(page, s.chats[0]!.id);
    await s.hub.store.sendMessage("owner", { conversationId: s.chats[0]!.id, clientMsgId: "own-match", text: "自己的气泡也能查到命中词", attachments: [] });
    await search(a, "命中词"); await expect(hits(a)).toHaveCount(1); await hits(a).first().click();
    await expect.poll(() => ranges(a)).toEqual(["命中词"]);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = theme; }, theme);
      await a.screenshot({ path: info.outputPath(`own-match-${theme}.png`), animations: "disabled" });
      expect(await a.locator(".focused-message .markdown p").evaluate(node => {
        const match = getComputedStyle(node, "::highlight(conversation-search-match)");
        return match.color === getComputedStyle(node).color;
      })).toBe(true);
    }
  } finally { await s.close(); }
});
