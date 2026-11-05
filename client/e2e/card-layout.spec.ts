import { expectOneDisclosure } from "./fixtures/disclosure-assertions.js";
import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cardLayoutStyle } from "../src/card-layout.js";

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/visual-fixtures.mjs", import.meta.url))], { stdio: "pipe" });
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen(); url = server.resolvedUrls!.local[0] + "e2e/fixtures/cards.html";
});
test.afterAll(async () => { await server?.close(); });

test("translated dimensions remain bounded and do not accept arbitrary CSS", () => {
  const style = cardLayoutStyle({ type: "column", layout: { padding: "url(https://example.test/track)", textColor: "red;display:none", width: "100vw", height: "9999px", borderRadius: "calc(100%)", weight: Infinity } });
  for (const value of Object.values(style)) expect(value).toBeUndefined();
  expect(cardLayoutStyle({ type: "column", layout: { weight: 1000 } }).flex).toBe("100 1 0%");
});

test("production reading cards keep loose list markers on the first line and compact block gaps", async ({ page }, info) => {
  for (const width of [900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url.replace("cards.html", "card-reading.html"));
    const items = page.locator(".card-text .markdown > .markdown-chunk > ol > li");
    await expect(items).toHaveCount(5);
    // pre-line on li used to create an empty marker line (+27px) and a
    // 35px gap between these paragraphs despite their much smaller margins.
    const geometry = await items.first().evaluate(li => {
      const paragraphs = li.querySelectorAll(":scope > p");
      return {
        markerOffset: paragraphs[0].getBoundingClientRect().top - li.getBoundingClientRect().top,
        paragraphGap: paragraphs[1].getBoundingClientRect().top - paragraphs[0].getBoundingClientRect().bottom,
      };
    });
    expect(Math.abs(geometry.markerOffset)).toBeLessThan(1);
    expect(geometry.paragraphGap).toBeGreaterThanOrEqual(0);
    expect(geometry.paragraphGap).toBeLessThanOrEqual(6);
    const nestedGap = await items.nth(2).evaluate(li => li.querySelector("ul")!.getBoundingClientRect().top - li.querySelector("p")!.getBoundingClientRect().bottom);
    expect(nestedGap).toBeLessThanOrEqual(8);
    const card = page.locator(".rich-card");
    await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(card).toHaveCSS("border-top-width", "1px");
    expect((await card.boundingBox())!.width).toBeLessThanOrEqual(Math.min(680, width));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`reading-${width}.png`), fullPage: true });
    await expect(page.locator(".collapse-body")).toBeHidden();
    await expectOneDisclosure(page.locator(".card-collapse > summary"));
    if (width <= 760) expect((await page.locator(".card-collapse summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByText("过程 · 4 步", { exact: true }).click();
    await expect(page.locator(".collapse-body")).toBeVisible();
    await expect(page.locator(".collapse-body p")).toHaveText("阅读资料\n整理要点\n检查内容\n完成回复");
    await expect(page.locator(".collapse-body p")).toHaveCSS("white-space", "pre-line");
  }
});

test("production cards retain explicit breaks and confine long code and tables in both themes", async ({ page }, info) => {
  for (const theme of ["light", "dark"]) for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(url.replace("cards.html", `card-reading.html?case=technical&theme=${theme}`));
    await expect(page.locator("pre code")).toContainText("second line");
    await expect(page.locator(".markdown li br")).toHaveCount(1);
    await expect(page.locator('.markdown input[type="checkbox"]')).toHaveCount(2);
    await expect(page.getByRole("link", { name: "产品说明" })).toHaveAttribute("href", "https://example.com/guide");
    const breaks = await page.locator(".card-text .markdown > .markdown-chunk > p").first().evaluate(p => ({ height: p.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(p).lineHeight) }));
    expect(breaks.height / breaks.lineHeight).toBeCloseTo(2, 1);
    const code = page.locator("pre");
    // This fixture tests program-code scrolling. Explicit text/txt/plaintext
    // fences wrap instead; plaintext-blocks.spec.ts checks that separate contract.
    await expect(page.locator(".code-language")).toHaveText("ts");
    await expect(code.locator("code")).toHaveCSS("white-space", "pre");
    expect(await code.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await code.evaluate(el => { el.scrollLeft = 200; });
    expect(await code.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const card = (await page.locator(".rich-card").boundingBox())!;
    const table = (await page.locator(".table-scroll").boundingBox())!;
    expect(table.x + table.width).toBeLessThanOrEqual(card.x + card.width);
    await page.screenshot({ path: info.outputPath(`technical-${theme}-${width}.png`), fullPage: true });
  }
});

test("weighted columns, card spacing and disclosures survive desktop and mobile layout", async ({ page }) => {
  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(`${url}?case=layout`);
    const body = page.locator(".card-body"), columns = page.locator(".card-column");
    await expect(body).toHaveCSS("padding", "16px"); await expect(body).toHaveCSS("row-gap", "18px");
    await expect(page.locator(".card-columns")).toHaveCSS("column-gap", "12px");
    await expect(page.locator(".card-columns")).toHaveCSS("flex-wrap", "nowrap");
    await expect(columns.first()).toHaveCSS("justify-content", "center"); await expect(columns.first()).toHaveCSS("align-items", "center");
    const wide = (await columns.nth(0).boundingBox())!, narrow = (await columns.nth(1).boundingBox())!;
    expect(wide.width / narrow.width).toBeCloseTo(2, 1);
    await expect(page.getByText("注释小字", { exact: true })).toHaveCSS("font-size", "12px");
    await expect(page.locator(".card-collapse")).toHaveCSS("border-radius", "8px");
    await expect(page.locator(".collapse-body")).toHaveCSS("row-gap", "14px");
    await page.locator("summary").click(); await expect(page.getByText("第一项", { exact: true })).toBeHidden();
  }
});

// Bound each capture group separately; 36 full-page captures in one 60 s test
// could time out after all geometry checks passed, on the final navigation.
for (const presentation of ["light", "dark", "mobile"] as const) test(`real constructor gallery has no page overflow (${presentation})`, async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const mobile = presentation === "mobile", theme = mobile ? "light" : presentation;
  const cases = mobile ? ["queue", "config", "ask_claude", "approval", "board_ready", "image_batch"]
    : ["running", "completed", "error", "goal_running", "queue", "choice", "ask_claude", "ask_kimi", "approval", "config", "board_ready", "image_batch", "archive", "long_answer", "multi_table"];
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 800, height: 1000 });
  for (const name of cases) {
    await page.goto(`${url}?case=${name}&theme=${theme}`); await expect(page.locator(".message-blocks")).not.toBeEmpty();
    await expect(page.locator(".markdown-pending").filter({ hasText: /\S/ })).toHaveCount(0);
    if (name === "image_batch") { await expect(page.locator(".image-grid img")).toHaveCount(2); await page.locator(".image-grid img").evaluateAll(imgs => Promise.all(imgs.map(image => (image as HTMLImageElement).decode()))); }
    if (name === "approval") await expect(page.locator(".card-text .markdown p").first()).toHaveCSS("white-space", "pre-line");
    if (name === "multi_table") await expect(page.locator("table")).toHaveCount(10);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}-${presentation}.png`), fullPage: true, animations: "disabled" });
  }
  if (theme === "dark") { await page.goto(`${url}?case=layout&theme=dark`); await expect(page.locator(".card-header")).toHaveCSS("background-color", "rgb(36, 52, 81)"); }
  expect(errors).toEqual([]);
});

// Older run cards still use streaming_mode rather than nativeRun. Their width
// must remain stable when the fitted-card toolbar rule is active on desktop.
test("legacy streamed replies retain their width across patches and completion", async ({ page }) => {
  for (const width of [1360, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url.replace("cards.html", "card-reading.html?case=legacy-stream"));
    const card = page.locator(".rich-card.reply-card");
    await expect(card).toContainText("检查中。");
    const initialWidth = (await card.boundingBox())!.width;
    for (const complete of [false, true]) {
      const text = complete ? "检查完成。" : "正在检查文件和引用来源，保留完整的检查结果。".repeat(10);
      await page.evaluate(detail => window.dispatchEvent(new CustomEvent("fixture:stream-patch", { detail })), { text, complete });
      await expect(card).toContainText(text);
      expect((await card.boundingBox())!.width).toBeCloseTo(initialWidth, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});
