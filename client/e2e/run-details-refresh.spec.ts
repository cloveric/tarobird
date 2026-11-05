import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import { expectOneDisclosure } from "./fixtures/disclosure-assertions.js";
import type { ColorPalette } from "../src/palettes.js";
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });

for (const viewport of [
  { width: 320, height: 568, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 844, height: 390, touch: true },
  { width: 478, height: 429, touch: false },
  { width: 1360, height: 900, touch: false },
]) test(`empty process reader remains usable through search and live entries at ${viewport.width}px`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport, hasTouch: viewport.touch, isMobile: viewport.touch });
  const page = await context.newPage();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-details-refresh.html?empty=1");
    await page.evaluate(() => (window as any).runRefreshFixture.tick());
    await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "运行过程", exact: true });
    const search = panel.getByRole("textbox", { name: "搜索过程记录" });
    await expect(panel.getByText("尚无过程记录", { exact: true })).toBeVisible();
    await expect(panel.getByText("收到过程记录后会自动显示。", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "上一页", exact: true })).toHaveCount(0);
    await expect(panel.locator(".run-update-time time")).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = theme; }, theme);
      const box = (await panel.boundingBox())!;
      for (const control of [search, panel.getByRole("button", { name: "搜索", exact: true }), panel.getByRole("button", { name: "刷新过程记录" }), panel.getByRole("button", { name: "导出过程记录" })]) {
        const rect = (await control.boundingBox())!;
        expect(rect.x).toBeGreaterThanOrEqual(box.x + 16);
        expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width - 15);
        expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
        if (viewport.touch && control !== search) expect(rect.height).toBeGreaterThanOrEqual(44);
      }
      expect(await panel.evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(box.width);
      await panel.screenshot({ path: info.outputPath(`empty-${viewport.width}-${theme}.png`), animations: "disabled" });
    }
    const about = panel.locator(".run-record-info");
    await expect(about).not.toHaveAttribute("open");
    await expectOneDisclosure(about.locator("summary"));
    await about.locator("summary").click();
    await expect(about.locator(".run-retention")).toBeVisible();
    await about.locator("summary").press("Enter");
    await expect(about).not.toHaveAttribute("open");
    await search.fill("missing"); await search.press("Enter");
    await expect(panel.getByText("没有匹配的过程记录", { exact: true })).toBeVisible();
    await search.fill(""); await search.press("Enter");
    await expect(panel.getByText("尚无过程记录", { exact: true })).toBeVisible();
    await search.fill("保留草稿");
    await page.evaluate(() => (window as any).showRunEntries());
    await expect(panel.locator(".run-step")).toHaveCount(1);
    await expect(panel.locator(".run-details-empty")).toHaveCount(0);
    await expect(search).toHaveValue("保留草稿"); await expect(search).toBeFocused();
    await panel.locator(".run-step summary").first().click();
    await expect(panel.locator(".run-step-detail")).toBeVisible();
    await panel.getByRole("button", { name: "关闭运行过程", exact: true }).click();
    await expect(panel).toHaveCount(0);
  } finally { await context.close(); }
});

for (const width of [390, 1360]) test(`process disclosure has exactly one indicator across theme families at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-details-refresh.html");
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  const row = page.locator(".run-step").first(), summary = row.locator("details > summary").first();
  await expect(row).toBeVisible();
  for (const palette of ["mono", "white-violet", "white-orange", "ocean", "cli"] satisfies ColorPalette[]) for (const theme of ["light", "dark"]) {
    await page.evaluate(({palette,theme}) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, {palette,theme});
    await expectOneDisclosure(summary);
    await summary.click(); await expect(row.locator("details").first()).toHaveAttribute("open", "");
    await expectOneDisclosure(summary);
    const raw = row.locator(".run-raw > summary");
    await expect(raw).toHaveCount(1); await expectOneDisclosure(raw);
    await summary.press("Enter"); await expect(row.locator("details").first()).not.toHaveAttribute("open");
    await summary.press("Space"); await expect(row.locator("details").first()).toHaveAttribute("open", "");
    await summary.press("Space"); await expect(row.locator("details").first()).not.toHaveAttribute("open");
    if (palette === "mono") await page.screenshot({ path: info.outputPath(`process-arrow-${width}-${theme}.png`) });
  }
});
test("live events do not starve slower process-detail requests", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-details-refresh.html");
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await page.evaluate(() => { (window as any).runRefreshTimer = setInterval(() => (window as any).runRefreshFixture.tick(), 400); });
  try {
    await expect(page.locator(".run-step")).toHaveCount(1, { timeout: 4000 });
    const counts = await page.evaluate(() => (window as any).runRefreshFixture.counts());
    expect(counts.completed).toBeGreaterThan(0);
    expect(counts.aborted).toBe(0);
  } finally { await page.evaluate(() => clearInterval((window as any).runRefreshTimer)); }
});

async function openThinkingRace(page: import("@playwright/test").Page, suffix = "") {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-details-refresh.html?thinking-race=1" + suffix);
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await page.clock.runFor(40);
  await expect(page.locator(".run-step")).toHaveCount(1);
  await page.locator(".run-step summary").click();
  await expect(page.locator(".run-step-detail")).toContainText("PUBLIC_THOUGHT_1");
}
const thinkingCounts = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).runRefreshFixture.counts() as { requests: number; completed: number; aborted: number });

test("public thinking tail catches up after journal commit without another live event", async ({ page }) => {
  await openThinkingRace(page);
  await page.evaluate(() => (window as any).runRefreshFixture.commitThinking());
  // Clock-controlled protocol ordering, not a real-time performance threshold:
  // journal commit follows the first read, and no new summary is published.
  await page.clock.runFor(260);
  expect(await thinkingCounts(page)).toEqual({ requests: 2, completed: 2, aborted: 0 });
  await expect(page.locator(".run-step-detail")).toContainText("PUBLIC_THOUGHT_2");
  await page.clock.runFor(600);
  expect((await thinkingCounts(page)).requests).toBe(2);
});

test("public thinking trailing read is bounded per summary revision and retains the slow-host fallback", async ({ page }) => {
  await openThinkingRace(page);
  await page.clock.runFor(860);
  expect((await thinkingCounts(page)).requests).toBe(2);
  // A still-stale response must not start an 180 ms retry loop. The unchanged
  // one-second fallback remains available to a genuinely slower old Host.
  await page.clock.runFor(1000);
  expect((await thinkingCounts(page)).requests).toBe(3);
  await page.evaluate(() => (window as any).runRefreshFixture.commitThinking());
  await page.clock.runFor(1000);
  expect((await thinkingCounts(page)).requests).toBe(4);
  await expect(page.locator(".run-step-detail")).toContainText("PUBLIC_THOUGHT_2");
});

test("newer public thinking summaries coalesce behind an in-flight read", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-details-refresh.html?thinking-race=1&slow=1");
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await page.clock.runFor(320);
  await page.evaluate(() => (window as any).runRefreshFixture.tick());
  await expect.poll(async () => (await thinkingCounts(page)).requests).toBe(2);
  await page.clock.runFor(100);
  await page.evaluate(() => { const fixture = (window as any).runRefreshFixture; fixture.tick(); fixture.commitThinking(4); });
  await page.clock.runFor(220);
  expect((await thinkingCounts(page)).requests).toBe(3);
  await page.clock.runFor(320);
  expect(await thinkingCounts(page)).toEqual({ requests: 3, completed: 3, aborted: 0 });
  expect(await page.evaluate(() => (window as any).runRefreshFixture.maxActiveRequests())).toBe(1);
  await page.locator(".run-step summary").click();
  await expect(page.locator(".run-step-detail")).toContainText("PUBLIC_THOUGHT_4");
});

for (const scope of ["closed", "search", "history"] as const) test(`public thinking trailing read is cancelled or excluded for ${scope}`, async ({ page }) => {
  await openThinkingRace(page, scope === "history" ? "&history=1" : "");
  if (scope === "closed") await page.getByRole("button", { name: "关闭运行过程", exact: true }).click();
  if (scope === "search") {
    await page.getByRole("textbox", { name: "搜索过程记录", exact: true }).fill("public");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
  }
  await page.clock.runFor(500);
  expect((await thinkingCounts(page)).requests).toBe(scope === "search" ? 2 : 1);
});

test("search changes cancel the previous query and closing cancels the reader", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-details-refresh.html");
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索过程记录" }).fill("different query");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".run-step")).toContainText("搜索资料 · different query");
  expect((await page.evaluate(() => (window as any).runRefreshFixture.counts())).aborted).toBe(1);
  await page.evaluate(() => (window as any).runRefreshFixture.tick());
  await expect.poll(() => page.evaluate(() => (window as any).runRefreshFixture.counts().requests)).toBe(3);
  await page.getByRole("button", { name: "关闭运行过程" }).click();
  const closed = await page.evaluate(() => (window as any).runRefreshFixture.counts());
  expect(closed.aborted).toBe(2);
  await page.evaluate(() => (window as any).runRefreshFixture.tick());
  expect((await page.evaluate(() => (window as any).runRefreshFixture.counts())).requests).toBe(closed.requests);
});

test("repeating a process search, including an empty query, keeps the results readable", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-details-refresh.html");
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await expect(page.locator(".run-step")).toHaveCount(1);
  for (const query of ["", "same query", "same query", " same query "]) {
    const before = await page.evaluate(() => (window as any).runRefreshFixture.counts().completed);
    await page.getByRole("textbox", { name: "搜索过程记录" }).fill(query);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).runRefreshFixture.counts().completed)).toBe(before + 1);
    await expect(page.locator(".run-step")).toHaveCount(1);
    if (query.trim()) await expect(page.locator(".run-step")).toContainText(query.trim());
  }
});

test("phone process refreshes leave both scroll directions under the reader's control", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-details-refresh.html?long=1");
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await expect(page.locator(".run-step")).toHaveCount(30);
  const body = page.locator(".run-details-body");
  await body.evaluate(async node => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    node.scrollTop = 350;
  });
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(350);
  await body.evaluate(node => {
    const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    const writes: number[] = [];
    Object.assign(window, { detailScrollWrites: writes });
    Object.defineProperty(node, "scrollTop", { configurable: true, get() { return native.get!.call(this); }, set(value: number) { writes.push(value); native.set!.call(this, value); } });
  });
  for (const top of [550, 150]) {
    await body.evaluate((node, value) => { node.scrollTop = value; (window as any).detailScrollWrites.length = 0; }, top);
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(top);
    const count = await page.evaluate(() => { const f = (window as any).runRefreshFixture; f.tick(); return f.counts().completed; });
    await expect.poll(() => page.evaluate(() => (window as any).runRefreshFixture.counts().completed)).toBe(count + 1);
    await body.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => (window as any).detailScrollWrites)).toEqual([]);
    expect(await body.evaluate(node => node.scrollTop)).toBe(top);
  }
  await page.getByRole("button", { name: "关闭运行过程" }).click();
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await expect(page.locator(".run-step")).toHaveCount(30);
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(150);
});


test("terminal phase refreshes already-open details even when the entry revision is unchanged", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-details-refresh.html");
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await expect(page.locator(".run-step.is-running")).toHaveCount(1);
  const before = await page.evaluate(() => { const fixture = (window as any).runRefreshFixture; const count = fixture.counts().completed; fixture.finish(); return count; });
  await expect(page.locator(".run-step.is-done")).toHaveCount(1);
  expect((await page.evaluate(() => (window as any).runRefreshFixture.counts())).completed).toBeGreaterThan(before);
});

test("reporting gaps and fresh events never move a phone reader's scroll or focused search", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-details-refresh.html?long=1");
  const now = Date.now();
  await page.clock.setFixedTime(now);
  await page.evaluate(() => (window as any).runRefreshFixture.tick());
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await expect(page.locator(".run-step")).toHaveCount(30);
  const search = page.getByRole("textbox", { name: "搜索过程记录" }), body = page.locator(".run-details-body"), row = page.locator(".run-step").nth(8);
  await search.fill("保留搜索草稿");
  await body.evaluate(node => { node.scrollTop = 350; });
  const y = (await row.boundingBox())!.y;
  for (const age of [59999, 60000, 3600000, 172800000]) {
    await page.clock.setFixedTime(now + age);
    await expect(page.locator(".run-update-relative")).toHaveText(age < 60000 ? "刚刚" : age < 3600000 ? "1分钟前" : age < 172800000 ? "1小时前" : "2天前");
    expect(await body.evaluate(node => node.scrollTop)).toBe(350);
    expect((await row.boundingBox())!.y).toBe(y);
    await expect(search).toBeFocused();
  }
  const completed = await page.evaluate(() => { const f = (window as any).runRefreshFixture; const count = f.counts().completed; f.tick(); return count; });
  await expect.poll(() => page.evaluate(() => (window as any).runRefreshFixture.counts().completed)).toBeGreaterThan(completed);
  await expect(page.locator(".run-update-relative")).toHaveText("刚刚");
  expect(await body.evaluate(node => node.scrollTop)).toBe(350);
  expect((await row.boundingBox())!.y).toBe(y);
  await expect(search).toHaveValue("保留搜索草稿");
  await expect(search).toBeFocused();
});
