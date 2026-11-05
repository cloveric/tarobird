import { expect, test, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { colorPalettes } from "../src/palettes.js";

let server: Awaited<ReturnType<typeof createServer>>;
test.beforeAll(async () => { server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });

const prose = "请先确认实际渲染组件和样式，再完成修改。".repeat(8);
const payload = `${prose}\n\n  保留两个空格的缩进，以及中间的  两个空格。  \n\t保留制表符缩进。\nhttps://example.com/${"long-path/".repeat(30)}?token=${"x".repeat(120)}\n${"UnbrokenWord".repeat(40)}\n${" ".repeat(180)}缩进后的文字\n末尾原有换行也保留。\n`;
const fence = (language: string, content = payload) => `~~~${language}\n${content}~~~`;
async function reply(page: Page, markdown: string) {
  await page.evaluate(value => (window as unknown as { setFormattingReply: (text: string) => void }).setFormattingReply(value), markdown);
}
async function open(page: Page, mode = "native") {
  await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/run-formatting.html?mode=${mode}`);
  await expect(page.locator(".card-text h2").first()).toBeVisible();
}

for (const width of [320, 430, 1360]) test(`plain text fences wrap without changing whitespace at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await open(page);
  for (const language of ["text", "txt", "plaintext", "TEXT"]) {
    await reply(page, fence(language));
    const block = page.locator(".native-run-prose .code-block");
    await expect(block.locator(".code-language")).toHaveText(language);
    // textContent is deliberately used: visual line wrapping must not edit data.
    expect(await block.locator("code").textContent()).toBe(payload);
    const geometry = await block.evaluate(el => {
      const pre = el.querySelector("pre")!, code = el.querySelector("code")!;
      const range = document.createRange(); range.selectNodeContents(code);
      pre.scrollLeft = 1000;
      return { scroll: pre.scrollWidth, width: pre.clientWidth, left: pre.scrollLeft,
        page: document.documentElement.scrollWidth, viewport: innerWidth,
        whitespace: getComputedStyle(code).whiteSpace, overflow: getComputedStyle(pre).overflowX,
        height: pre.getBoundingClientRect().height, lines: code.textContent!.split("\n").length,
        lineHeight: parseFloat(getComputedStyle(pre).lineHeight),
        buttonBottom: el.querySelector("button")!.getBoundingClientRect().bottom, textTop: range.getBoundingClientRect().top };
    });
    expect(geometry.scroll, `${language} must not need horizontal scrolling`).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.left).toBe(0);
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.whitespace).toBe("break-spaces");
    expect(geometry.overflow).toBe("auto");
    expect(geometry.height).toBeGreaterThan(geometry.lines * geometry.lineHeight);
    expect(geometry.buttonBottom).toBeLessThanOrEqual(geometry.textTop);
    if (language === "text") await page.screenshot({ path: info.outputPath(`plaintext-${width}.png`), fullPage: true });
  }
});

test("code, ASCII and ambiguous fences retain column alignment across reply updates", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 }); await open(page);
  const longCode = `const value = "${"x".repeat(200)}";\n  console.log(value);\n`;
  const diagram = `+${"-".repeat(180)}+\n| left${" ".repeat(170)}right |\n+${"-".repeat(180)}+\n`;
  for (const [language, text] of [["text", payload], ["ts", longCode], ["ascii", diagram], ["", diagram], ["unknown-format", diagram], ["txt", payload]]) {
    await reply(page, fence(language, text));
    const block = page.locator(".native-run-prose .code-block");
    await expect.poll(() => block.locator("code").textContent()).toBe(text);
    const plain = language === "text" || language === "txt";
    await expect(block.locator("code")).toHaveCSS("white-space", plain ? "break-spaces" : "pre");
    const scroll = await block.locator("pre").evaluate(el => el.scrollWidth - el.clientWidth);
    expect(scroll > 1).toBe(!plain);
    if (language === "ts") await expect(block.locator(".hljs-keyword").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("native and legacy text fences preserve theme, type size and copy toolbar", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 900 });
  for (const mode of ["native", "legacy"]) {
    await open(page, mode);
    await reply(page, fence("text", `${prose}\n`) + "\n\n" + fence("ts", "const value = 1;\n"));
    const blocks = page.locator(mode === "native" ? ".native-run-prose .code-block" : ".rich-card > .card-body > .card-text .code-block");
    await expect(blocks).toHaveCount(2);
    for (const { id } of colorPalettes) for (const theme of ["light", "dark"]) {
      await page.evaluate(({ id, theme }) => { document.documentElement.dataset.palette = id; document.documentElement.dataset.theme = theme; }, { id, theme });
      await page.evaluate(() => document.fonts.ready);
      const styles = await blocks.evaluateAll(nodes => nodes.map(node => {
        const pre = node.querySelector("pre")!, code = node.querySelector("code")!, css = getComputedStyle(pre), font = getComputedStyle(code);
        const range = document.createRange(); range.selectNodeContents(code);
        return { font: font.fontSize, family: font.fontFamily, background: css.backgroundColor,
          border: css.border, radius: css.borderRadius, whiteSpace: font.whiteSpace,
          // Terminal themes extend the touch target with transparent borders;
          // compare the visible label, not that intentionally larger hit area.
          fits: pre.scrollWidth <= pre.clientWidth + 1, toolbar: node.querySelector(".code-copy span")!.getBoundingClientRect().bottom <= range.getBoundingClientRect().top };
      }));
      const { whiteSpace, fits, toolbar, ...plainStyle } = styles[0];
      const { whiteSpace: codeWhiteSpace, fits: codeFits, toolbar: codeToolbar, ...codeStyle } = styles[1];
      expect(plainStyle, `${mode}/${id}/${theme}`).toEqual(codeStyle);
      expect(whiteSpace).toBe("break-spaces"); expect(codeWhiteSpace).toBe("pre");
      expect(fits, `${mode}/${id}/${theme}`).toBe(true);
      expect(toolbar, `${mode}/${id}/${theme} text toolbar`).toBe(true);
      expect(codeToolbar, `${mode}/${id}/${theme} code toolbar`).toBe(true);
    }
  }
});

test("copy uses the original text, never the visual wraps, and retains failure feedback", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 320, height: 900 }); await open(page);
  if (browserName !== "chromium") await page.evaluate(() => {
    navigator.clipboard.writeText = async value => { Object.assign(window, { copiedText: value }); };
  });
  for (const language of ["text", "txt", "plaintext"]) {
    await reply(page, fence(language));
    const block = page.locator(".native-run-prose .code-block");
    await expect(block.locator(".code-language")).toHaveText(language);
    await block.getByRole("button", { name: "复制代码", exact: true }).click();
    await expect(block.getByRole("status")).toHaveText("已复制");
    const copied = await page.evaluate(real => real ? navigator.clipboard.readText() : (window as unknown as { copiedText: string }).copiedText, browserName === "chromium");
    expect(copied).toBe(payload);
  }
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("clipboard denied"); }; });
  const block = page.locator(".native-run-prose .code-block");
  await block.getByRole("button", { name: "复制代码", exact: true }).click();
  await expect(block.getByRole("alert")).toHaveText("复制失败，请手动选择内容。");
});
