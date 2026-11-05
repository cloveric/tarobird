import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { colorPalettes } from "../src/palettes.js";

let server: Awaited<ReturnType<typeof createServer>>;
test.beforeAll(async () => { server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });

async function prepareClipboard(page: Page, context: BrowserContext, browserName: string) {
  if (browserName === "chromium") return context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // Playwright WebKit cannot grant these permissions. Verify bytes and UI via
  // the clipboard API boundary here; Chromium still exercises its clipboard.
  await page.addInitScript(() => {
    let text = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value: string) => { text = value; }, readText: async () => text,
    } });
  });
}

for (const width of [390, 1360]) test(`native replies retain rich formatting and readable detail code at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-formatting.html");
  const reply = page.locator(".native-run-prose");
  await expect(reply.locator(".hljs-keyword").first()).toBeVisible();
  for (const selector of ["h2", "h3", "blockquote", "ol", "ul", ".katex", "hr", "table", "input[type=checkbox]"]) expect(await reply.locator(selector).count(), selector).toBeGreaterThan(0);
  const code = await reply.locator("pre code").innerText();
  expect(code).toContain('  return title + name;');
  await page.getByRole("button", { name: "切换为运行中", exact: true }).click();
  await expect(reply.locator("pre code")).toHaveText(code);
  await page.getByRole("button", { name: "切换为已完成", exact: true }).click();
  await expect(reply.locator("pre code")).toHaveText(code);
  if (width === 390) {
    await page.getByRole("button", { name: "展开表格", exact: true }).click();
    await expect(page.locator(".markdown-table-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await page.getByText("公开思考摘要", { exact: true }).click();
  const detail = page.locator(".run-step-detail");
  await expect(detail.locator("pre code")).toHaveText(code);
  const geometry = await detail.locator(".code-block").evaluate(el => {
    const button = el.querySelector(".code-copy")!.getBoundingClientRect();
    const code = el.querySelector("code")!.getBoundingClientRect();
    return { buttonBottom: button.bottom, codeTop: code.top, scrollWidth: document.documentElement.scrollWidth, width: innerWidth };
  });
  expect(geometry.buttonBottom, "copy control must not cover the first code line").toBeLessThanOrEqual(geometry.codeTop);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  await page.screenshot({ path: info.outputPath("details.png") });
});

test("native and legacy replies share typography and the selected theme in light and dark mode", async ({ page }) => {
  test.setTimeout(120000);
  const read = async (mode: string, palette: string, theme: string) => {
    await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/run-formatting.html?mode=${mode}&palette=${palette}&theme=${theme}`);
    await expect(page.locator(".card-text h2").first()).toBeVisible();
    return page.locator(mode === "native" ? ".native-run" : ".rich-card").evaluate(el => {
      const style = getComputedStyle(el), markdown = getComputedStyle(el.querySelector("h2")!.closest(".markdown")!);
      const marker = getComputedStyle(el.querySelector("li")!, "::marker");
      return { background: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow, lineHeight: markdown.lineHeight, fontSize: markdown.fontSize, marker: marker.color };
    });
  };
  for (const { id } of colorPalettes) for (const theme of ["light", "dark"]) {
    const old = await read("legacy", id, theme), current = await read("native", id, theme);
    expect(current, `${id}/${theme}`).toEqual(old);
    if (id.startsWith("white-") && theme === "light") expect(current.background).toBe("rgb(255, 255, 255)");
  }
});

test("code copies preserve raw text and report clipboard failures without throwing", async ({ page, context, browserName }) => {
  await prepareClipboard(page, context, browserName);
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-formatting.html");
  const code = page.locator(".native-run .code-block");
  await expect(code.locator(".code-language")).toHaveText("ts");
  const text = await code.locator("pre code").textContent();
  await code.getByRole("button", { name: "复制代码", exact: true }).click();
  await expect(code.getByRole("status")).toHaveText("已复制");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("clipboard denied"); }; });
  await code.getByRole("button", { name: "复制代码", exact: true }).click();
  await expect(code.getByRole("alert")).toHaveText("复制失败，请手动选择内容。");
});

test("raw tool parameters and output copy independently without interpreting markup", async ({ page, context, browserName }) => {
  await prepareClipboard(page, context, browserName);
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/run-formatting.html");
  await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
  await page.locator(".run-step").last().locator("summary").first().click();
  await page.getByText("原始参数", { exact: true }).click();
  const tool = page.locator(".run-step").last();
  for (const [name, selector] of [["复制原始参数", ".run-raw code"], ["复制原始输出", "section code"]]) {
    const expected = await tool.locator(selector).textContent();
    await tool.getByRole("button", { name, exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  }
  await expect(tool.locator("script,img")).toHaveCount(0);
  await expect(tool.locator("section code")).toContainText("<script>");
  const raw = tool.locator("section .run-code");
  await raw.locator("pre").evaluate(node => { node.scrollTop = 180; });
  const overlap = await raw.evaluate(node => ({ buttonBottom: node.querySelector("button")!.getBoundingClientRect().bottom, viewportTop: node.querySelector("pre")!.getBoundingClientRect().top }));
  expect(overlap.buttonBottom).toBeLessThanOrEqual(overlap.viewportTop);
});

const typographySample = `**资料已核对，仍有两项需要确认。** 这里是正文，保持原来的阅读字号。

# 本轮资料核对

## 一、主要判断：**保留重点，也保留阅读节奏**

这份回复同时包含结论、依据和下一步。**加粗只用于关键结论**，其余说明使用普通正文。

### 需要确认的两项

- **资料版本**：引用原文与当前版本应分别说明。
- **图片来源**：保留文件名和出处，避免把推测当成事实。

> 引用仍然保留层次，具体内容可以回到原始材料核对。

#### 操作提醒

检查 \`report.md\` 后再更新记录。

##### 补充说明

短说明保持与正文相同的阅读大小。

###### 资料来源

[查看原始材料](https://example.com/reference)

~~~text
  保留原始缩进。
第二行保持原样。
~~~
`;

for (const width of [390, 1360]) for (const theme of ['light', 'dark'] as const) test(`reply typography hierarchy stays restrained at ${width}px ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/run-formatting.html?theme=${theme}`);
  await expect(page.locator('.native-run-prose h2')).toBeVisible();
  await page.evaluate(text => (window as any).setFormattingReply(text), typographySample);
  const reply = page.locator('.native-run-prose');
  await expect(reply.locator('h6')).toBeVisible();
  const base = await reply.locator('p').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  await expect(reply.locator('p').first()).toHaveCSS('font-weight', '400');
  await expect(reply.locator('p strong').first()).toHaveCSS('font-weight', '600');
  for (const [tag, ratio] of [['h1', 1.12], ['h2', 1.06], ['h3', 1], ['h4', 1], ['h5', 1], ['h6', 1]] as const) {
    const heading = reply.locator(tag);
    const size = await heading.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    expect(size).toBeCloseTo(base * ratio, 1);
    await expect(heading).toHaveCSS('font-weight', '600');
  }
  await expect(reply.locator('h2 strong')).toHaveCSS('font-weight', '600');
  await expect(reply.locator('li')).toHaveCount(2);
  await expect(reply.locator('blockquote')).toContainText('引用仍然保留层次');
  await expect(reply.locator('a')).toHaveAttribute('href', 'https://example.com/reference');
  await expect(reply.locator('pre code')).toHaveText('  保留原始缩进。\n第二行保持原样。\n');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`reply-${width}-${theme}.png`) });
});

for (const width of [390, 1360]) for (const mode of ['native', 'legacy', 'plain']) test(`reply typography keeps theme and ADHD sizes for ${mode} at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/run-formatting.html?mode=${mode}`);
  await expect(page.locator('.card-text h2').first()).toBeVisible();
  await page.evaluate(text => (window as any).setFormattingReply(text), typographySample);
  const prose = page.locator(mode === 'native' ? '.native-run-prose .markdown' : '.rich-card .card-body>.card-text>.markdown').filter({ has: page.locator('h6') }).first();
  await expect(prose.locator('h6')).toBeVisible();
  if (mode === 'legacy') {
    // Process logs and producer-owned status are not authored reply prose.
    await expect(page.locator('.card-collapse .markdown p strong').first()).toHaveCSS('font-weight', '700');
    await expect(page.locator('.card-body>.card-text').first().locator('strong')).toHaveCSS('font-weight', '700');
  }
  // Retired skins normalize on startup; test only the current palette catalog.
  const cases = [...colorPalettes.map(({ id }) => [id, id === 'cli' ? 12 : 14, false] as const), ['white-violet', 20, true], ['cli', 20, true]] as const;
  for (const [palette, size, adhd] of cases) {
    await page.evaluate(({ palette, size, adhd }) => {
      document.documentElement.dataset.palette = palette;
      document.documentElement.style.fontSize = adhd ? '14px' : `${size}px`;
      const main = document.querySelector('main')!;
      main.classList.toggle('adhd-card', adhd); main.style.setProperty('--font-size', `${size}px`);
    }, { palette, size, adhd });
    await expect(prose.locator('p').first()).toHaveCSS('font-size', `${size}px`);
    await expect(prose.locator('p').first()).toHaveCSS('font-weight', '400');
    await expect(prose.locator('p strong').first()).toHaveCSS('font-weight', '600');
    const flat = palette === 'cli';
    for (const [tag, ratio] of [['h1', flat ? 1 : 1.12], ['h2', flat ? 1 : 1.06], ['h3', 1], ['h4', 1], ['h5', 1], ['h6', 1]] as const) {
      expect(await prose.locator(tag).evaluate(node => parseFloat(getComputedStyle(node).fontSize)), `${palette}/${mode}/${tag}`).toBeCloseTo(size * ratio, 1);
    }
    if (palette === 'cli') expect(await prose.locator('h2').evaluate(node => getComputedStyle(node, '::before').content)).toContain('##');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

for (const width of [390, 1360]) for (const mode of ['plain', 'user']) test(`table reader retains its reply or user typography for ${mode} at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/run-formatting.html?mode=${mode}`);
  await expect(page.locator('.message h2')).toBeVisible();
  const text = '**正文重点**和普通说明。\n\n# 资料核对\n\n| 项目 | 结果 |\n|---|---|\n' + Array.from({ length: 24 }, (_, i) => `| 第 ${i + 1} 项 | **已核对** |`).join('\n');
  await page.evaluate(text => (window as any).setFormattingReply(text), text);
  const message = page.locator('.message');
  const weight = mode === 'plain' ? '600' : '700';
  await expect(message.locator('h1')).toBeVisible();
  expect(await message.locator('h1').evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeCloseTo(mode === 'plain' ? 15.68 : 18.2, 2);
  await expect(message.locator('p strong').first()).toHaveCSS('font-weight', weight);
  await expect(message.locator('td strong').first()).toHaveCSS('font-weight', weight);
  const expand = message.getByRole('button', { name: '展开表格', exact: true });
  await expand.click();
  const reader = page.locator('.markdown-table-reader');
  await expect(reader.locator('td strong').first()).toHaveCSS('font-weight', weight);
  await expect(reader.locator('tbody tr')).toHaveCount(24);
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(expand).toBeFocused();
});
