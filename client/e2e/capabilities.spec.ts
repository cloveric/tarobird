import { preparePairing } from "./fixtures/pairing-invite.js";
import { expectOneDisclosure } from "./fixtures/disclosure-assertions.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { openSettings } from "./fixtures/settings.js";
import { openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";
import { createServer } from "./fixtures/vite.js";
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}
async function save(file: string, data: string) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data); }
test("paired desktop and phone inspect per-Bot Skills/MCP, refresh, filter, paginate and fail truthfully offline", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-capabilities-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const channels: Awaited<ReturnType<typeof attachGateway>>[] = [];
  const contexts = await Promise.all([browser.newContext({ serviceWorkers: "block", viewport: { width: 1360, height: 900 } }), browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })]);
  const pages = await Promise.all(contexts.map((context) => context.newPage())), errors: string[] = [];
  pages.forEach((page) => page.on("pageerror", (error) => errors.push(error.message)));
  try {
    for (const [id, name, engine, folder, mcp] of [["alpha", "研究助手", "claude", ".claude", ".mcp.json"], ["beta", "代码助手", "kimi", ".agents", ".kimi-code/mcp.json"]]) {
      const stateDir = path.join(root, id!), secret = randomBytes(32).toString("base64url");
      await save(path.join(stateDir, "config.json"), JSON.stringify({ engine }));
      for (let n = 0; n < (id === "alpha" ? 35 : 1); n++) await save(path.join(stateDir, "workspace", folder!, `skills/task-${n}/SKILL.md`), `---\nname: ${id === "alpha" ? "研究资料" : "代码审查"}-${n}\ndescription: 整理资料、核对来源，形成可复用的工作流程。\n---\nDo not send this body.`);
      await save(path.join(stateDir, "workspace", mcp!), JSON.stringify({ mcpServers: { [id === "alpha" ? "知识库检索" : "项目工具"]: { command: "node", args: ["fixture-secret-argument"], env: { KEY: "fixture-secret-key" }, disabled: id === "beta" } } }));
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id!, name!, hashSecret(secret)]);
      channels.push(await attachGateway({ stateDir, botId: id!, secret, engine: engine as "claude" | "kimi", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } }));
    }
    for (const [index, page] of pages.entries()) {
      await pair(page, hub); await openWorkspacePage(page, "Skills 与 MCP"); await page.getByLabel("选择 Bot", { exact: true }).selectOption("alpha");
      await expect(page.getByText("部分清单 · 未验证", { exact: true })).toBeVisible();
      await expect(page.getByText("部分配置清单 · 运行状态未确认", { exact: true })).toBeHidden();
      await page.locator(".capabilities-overview > summary").click();
      await expectOneDisclosure(page.locator(".capabilities-overview > summary"));
      await expect(page.getByText("部分配置清单 · 运行状态未确认", { exact: true })).toBeVisible();
      await page.locator(".capabilities-overview > summary").click();
      await page.getByLabel("能力来源", { exact: true }).selectOption("workspace"); await expect(page.locator(".capability-card")).toHaveCount(30);
      await page.getByRole("button", { name: "下一页", exact: true }).click(); await expect(page.locator(".capability-card")).toHaveCount(5);
      await page.getByLabel("搜索能力", { exact: true }).fill("研究资料-34"); await expect(page.locator(".capability-card")).toHaveCount(1);
      await page.getByLabel("搜索能力", { exact: true }).fill("绝无此项"); await expect(page.getByText("没有匹配的条目，试试调整筛选条件。", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: /^MCP/ }).click(); await page.getByLabel("能力来源", { exact: true }).selectOption("workspace");
      await expect(page.locator(".capability-card")).toContainText("知识库检索"); await expect(page.locator(".capability-card")).toContainText("已配置"); await expect(page.locator(".capabilities-panel")).not.toContainText("fixture-secret");
      await page.getByLabel("选择 Bot", { exact: true }).selectOption("beta"); await expect(page.locator(".capability-card")).toHaveCount(1); await expect(page.locator(".capability-card")).toContainText("项目工具"); await expect(page.locator(".capability-card")).toContainText("配置已禁用"); await expect(page.locator(".capabilities-panel")).not.toContainText("知识库检索");
      await page.locator(".capabilities-tabs").getByRole("button", { name: /^Skills/ }).click(); await page.getByLabel("能力来源", { exact: true }).selectOption("workspace"); await expect(page.locator(".capability-card")).toHaveCount(1); await expect(page.locator(".capability-card")).toContainText("代码审查-0");
      expect(await page.locator(".capabilities-panel").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (index === 1) {
        // A capability directory needs enough reading space after its fixed header.
        await expect.poll(() => page.locator(".capabilities-panel").evaluate(element => element.getBoundingClientRect().height / innerHeight)).toBeGreaterThan(0.93);
        expect(await page.locator(".capabilities-body").evaluate(element => element.clientHeight)).toBeGreaterThan(450);
      }
      await page.screenshot({ path: info.outputPath(`capabilities-${index ? "phone" : "desktop"}.png`) });
    }
    await save(path.join(root, "beta/workspace/.agents/skills/new/SKILL.md"), "---\nname: 新技能\ndescription: 新增后刷新读取\n---\n");
    for (const page of pages) { await page.getByRole("button", { name: "刷新清单", exact: true }).click(); await expect(page.locator(".capability-card")).toHaveCount(2); }
    const desktop = pages[0]!;
    let unblock!: () => void, routed!: () => void; const gate = new Promise<void>((resolve) => { unblock = resolve; }), intercepted = new Promise<void>((resolve) => { routed = resolve; });
    await desktop.route("**/api/bots/alpha/capabilities", async (route) => { routed(); const response = await route.fetch(); await gate; await route.fulfill({ response }); });
    await desktop.getByLabel("选择 Bot", { exact: true }).selectOption("alpha"); await intercepted; await desktop.getByLabel("选择 Bot", { exact: true }).selectOption("beta"); await expect(desktop.locator(".capability-card")).toHaveCount(2); unblock(); await desktop.unrouteAll({ behavior: "wait" }); await expect(desktop.locator(".capabilities-panel")).not.toContainText("研究资料-");
    await desktop.getByRole("button", { name: "关闭能力页面", exact: true }).click(); await openSettings(desktop, "general"); await desktop.getByLabel("主题", { exact: true }).selectOption("dark"); await desktop.getByLabel("语言", { exact: true }).selectOption("en"); await desktop.getByRole("button", { name: "Close settings", exact: true }).click();
    await openWorkspacePage(desktop, "Skills & MCP"); await desktop.getByLabel("Select Bot", { exact: true }).selectOption("beta"); await expect(desktop.getByText("Partial · unverified", { exact: true })).toBeVisible(); await desktop.screenshot({ path: info.outputPath("capabilities-dark-en.png") });
    await save(path.join(root, "beta/config.json"), "{broken");
    await pages[1]!.getByRole("button", { name: "刷新清单", exact: true }).click();
    await expect(pages[1]!.getByText("Bot 配置无法读取，无法确定其能力清单。", { exact: true })).toBeVisible();
    await expect(pages[1]!.locator(".capability-card")).toHaveCount(0);
    await expect(pages[1]!.locator(".capabilities-empty")).toHaveCount(0);
    await save(path.join(root, "beta/config.json"), '{"engine":"kimi"}');
    await pages[1]!.route("**/api/bots/beta/capabilities", (route) => route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' }));
    await pages[1]!.getByRole("button", { name: "刷新清单", exact: true }).click();
    await expect(pages[1]!.getByText("此主机版本尚不支持 Skills 与 MCP 页面，请更新主机。", { exact: true })).toBeVisible();
    await pages[1]!.unrouteAll({ behavior: "wait" });
    await channels[1]!.disconnect(); await pages[1]!.getByRole("button", { name: "刷新清单", exact: true }).click(); await expect(pages[1]!.locator(".capabilities-panel [role=alert]")).toContainText("无法读取能力清单"); await expect(pages[1]!.locator(".capability-card")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { for (const context of contexts) await context.close(); for (const channel of channels) await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

const layoutHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module">
import React from 'react'; import { createRoot } from 'react-dom/client';
import { CapabilitiesPanel } from '/src/CapabilitiesPanel.tsx';
import '/src/styles.css'; import '/src/brand-theme.css'; import '/src/palette-tokens.css';
import '/src/mobile-im.css'; import '/src/mobile-shell.css'; import '/src/viewport.css';
const f = window.capabilitiesLayout = { requests: [], closed: 0 };
const data = { generatedAt: new Date().toISOString(), engine: 'claude', workspace: '/test/workspace', runtime: 'unverified', coverage: 'partial',
  entries: Array.from({length:8}, (_,index) => ({id:'tool-'+index,kind:'mcp',name:'知识库检索-'+index,description:'读取资料并核对来源。',scope:'workspace',source:'workspace/.mcp.json',status:index===7?'disabled':'configured',transport:'stdio'})),
  sources: [], warnings:['runtime_unverified','partial_catalog'] };
createRoot(document.getElementById('root')).render(React.createElement(CapabilitiesPanel, {
  connection: {identity:{hubPublicKey:'test-host'},state:{status:'online'},subscribe:()=>()=>{},http:async()=>data},
  bots:[{id:'alpha',name:'研究助手',engine:'claude',model:'',effort:'',online:1}], initialBot:'alpha', close:()=>f.closed++, help:request=>f.requests.push(request)
}));
</script></body></html>`;

for (const screen of [
  { name: 'landscape touch phone', width: 844, height: 390, touch: true },
  { name: 'short desktop window', width: 640, height: 400, touch: false },
  { name: 'portrait touch phone', width: 390, height: 844, touch: true },
  { name: 'narrow touch phone', width: 320, height: 700, touch: true },
  { name: 'regular desktop window', width: 1360, height: 900, touch: false },
]) test(`source capability layout keeps entries and Bot checks reachable in ${screen.name}`, async ({ browser }, info) => {
  const vite = await createServer({ plugins: [{ name: 'capability-layout-fixture', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/__capability-layout') return next();
      response.setHeader('Content-Type', 'text/html'); response.end(await server.transformIndexHtml('/__capability-layout', layoutHtml));
    });
  } }], server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false } });
  await vite.listen();
  const context = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, isMobile: screen.touch, hasTouch: screen.touch, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(vite.resolvedUrls!.local[0]! + '__capability-layout');
    await page.getByRole('button', { name: /^MCP/ }).click();
    await expect(page.locator('.capability-card')).toHaveCount(8);
    const layout = await page.locator('.capabilities-panel').evaluate(panel => {
      const body = panel.querySelector('.capabilities-body')!, toolbar = panel.querySelector('.capabilities-toolbar')!;
      const bounds = panel.getBoundingClientRect(), sticky = getComputedStyle(toolbar).position === 'sticky';
      return { top: bounds.top, bottom: bounds.bottom, height: bounds.height, viewportHeight: innerHeight,
        coarse: matchMedia('(pointer: coarse)').matches, sticky, bodyHeight: body.clientHeight,
        readingHeight: body.clientHeight - (sticky ? toolbar.getBoundingClientRect().height : 0),
        firstEntryTop: panel.querySelector(".capability-card")!.getBoundingClientRect().top,
        overflow: panel.scrollWidth > panel.clientWidth || document.documentElement.scrollWidth > innerWidth };
    });
    await page.screenshot({ path: info.outputPath('capability-initial.png') });
    await info.attach('capability-layout.json', { body: JSON.stringify(layout, null, 2), contentType: 'application/json' });
    expect(layout.coarse).toBe(screen.touch); expect(layout.overflow).toBe(false);
    expect(layout.top).toBeGreaterThanOrEqual(0); expect(layout.bottom).toBeLessThanOrEqual(screen.height);
    expect(layout.readingHeight).toBeGreaterThan(44);
    if (screen.height <= 400) { expect(layout.height / screen.height).toBeGreaterThan(0.93); expect(layout.sticky).toBe(false); }
    else expect(layout.sticky).toBe(true);
    // The default phone view shows useful entries immediately, not a screen of explanations.
    if (screen.width <= 390) {
      expect(layout.firstEntryTop).toBeLessThan(450);
      await expect(page.locator('.capability-card').nth(1)).toBeInViewport({ ratio: 1 });
      // A larger chat font must not turn the inventory controls into oversized
      // fields or push the first useful entry out of the phone's upper half.
      await page.evaluate(() => document.documentElement.style.setProperty('--font-size', '20px'));
      const controls = await page.locator('.capabilities-panel').evaluate(panel => {
        const rect = (selector: string) => panel.querySelector(selector)!.getBoundingClientRect();
        return {
          botFont: parseFloat(getComputedStyle(panel.querySelector('.capabilities-context select')!).fontSize),
          sourceFont: parseFloat(getComputedStyle(panel.querySelector('.capabilities-filters select')!).fontSize),
          searchHeight: rect('.capabilities-search').height,
          firstEntryTop: rect('.capability-card').top,
          overflow: panel.scrollWidth > panel.clientWidth,
          iosZoomFloor: CSS.supports('-webkit-touch-callout', 'none'),
        };
      });
      await page.screenshot({ path: info.outputPath('capability-large-chat-font.png') });
      await info.attach('capability-controls.json', { body: JSON.stringify(controls, null, 2), contentType: 'application/json' });
      expect(controls.botFont).toBeLessThanOrEqual(controls.iosZoomFloor ? 16 : 14);
      expect(controls.sourceFont).toBeLessThanOrEqual(controls.iosZoomFloor ? 16 : 14);
      expect(controls.searchHeight).toBeLessThanOrEqual(44);
      expect(controls.firstEntryTop).toBeLessThan(360);
      expect(controls.overflow).toBe(false);
      for (const control of await page.locator('.capabilities-context select, .capabilities-refresh, .capabilities-tabs button, .capabilities-tabbar>.capabilities-action, .capabilities-filters select').all()) {
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await page.evaluate(() => document.documentElement.style.removeProperty('--font-size'));
    }
    const overview = page.locator('.capabilities-overview > summary');
    await overview.click();
    await expect(page.getByText('部分配置清单 · 运行状态未确认', { exact: true })).toBeVisible();
    const scopeToggle = page.locator('.capabilities-scope > summary');
    await scopeToggle.click();
    await expect(page.getByText('/test/workspace', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.capabilities-scope')).not.toHaveAttribute('open', '');
    await expect(page.locator('.capabilities-overview')).toHaveAttribute('open', '');
    await page.keyboard.press('Escape');
    await expect(page.locator('.capabilities-overview')).not.toHaveAttribute('open', '');
    await expect(overview).toBeFocused();
    // Closing the parent leaves native child details open but hidden; they must not consume Back.
    await overview.click(); await scopeToggle.click(); await overview.click();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as any).capabilitiesLayout.closed)).toBe(1);
    await overview.click(); await scopeToggle.click(); await overview.click();
    const states = page.getByRole('group', { name: '配置状态', exact: true });
    await states.getByRole('button', { name: /^已禁用/ }).click();
    await expect(page.locator('.capability-card')).toHaveCount(1);
    await expect(page.locator('.capability-card')).toContainText('知识库检索-7');
    await states.getByRole('button', { name: /^已发现\/配置/ }).click();
    await expect(page.locator('.capability-card')).toHaveCount(7);
    await states.getByRole('button', { name: /^全部/ }).click();
    await expect(page.locator('.capability-card')).toHaveCount(8);
    if (screen.touch) for (const button of await states.getByRole('button').all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const search = page.getByLabel('搜索能力', { exact: true });
    const source = page.getByLabel('能力来源', { exact: true });
    const searchField = page.locator('.capabilities-search');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await source.focus();
      const idleBorder = await searchField.evaluate(node => getComputedStyle(node).borderColor);
      await search.scrollIntoViewIfNeeded();
      if (screen.touch) await search.tap(); else await search.click();
      await search.fill('知识库');
      await expect(search).toHaveCSS('box-shadow', 'none');
      await expect(search).toHaveCSS('outline-style', 'none');
      await expect(search).toHaveCSS('border-width', '0px');
      await expect(page.locator('.capability-card')).toHaveCount(8);
      // Tab navigation still identifies the entire field, not an inner rectangle.
      await search.press('Tab'); await expect(source).toBeFocused();
      await page.keyboard.press('Shift+Tab'); await expect(search).toBeFocused();
      await expect.poll(() => searchField.evaluate(node => getComputedStyle(node).borderColor)).not.toBe(idleBorder);
      await expect(search).toHaveCSS('box-shadow', 'none');
      // WebKit follows the OS preference that can skip buttons during Tab navigation.
      await states.getByRole('button').first().focus();
      await expect(states.getByRole('button').first()).toBeFocused();
      await expect(states.getByRole('button').first()).toHaveCSS('outline-offset', '-2px');
      await search.focus();
      await searchField.screenshot({ path: info.outputPath(`search-focus-${theme}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    const summary = page.locator('.capability-summary').first();
    // An unrelated open explanation must not steal Back or focus from the expanded entry.
    await overview.click();
    await summary.scrollIntoViewIfNeeded(); await summary.click();
    await page.keyboard.press('Escape');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(summary).toBeFocused();
    await expect(page.locator('.capabilities-overview')).toHaveAttribute('open', '');
    await overview.click();
    await summary.scrollIntoViewIfNeeded(); await summary.click();
    const check = page.getByRole('button', { name: '让 Bot 检查', exact: true });
    await check.scrollIntoViewIfNeeded();
    expect(await check.evaluate(element => {
      const bounds = element.getBoundingClientRect(), hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return !!hit && element.contains(hit);
    })).toBe(true);
    if (screen.touch) expect((await check.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await check.click();
    expect(await page.evaluate(() => (window as any).capabilitiesLayout.requests)).toEqual([{ botId: 'alpha', kind: 'mcp', name: '知识库检索-0', source: 'workspace/.mcp.json', intent: 'check' }]);
    await page.screenshot({ path: info.outputPath('capability-check-reachable.png') });
    expect(errors).toEqual([]);
  } finally { await context.close(); await vite.close(); }
});
