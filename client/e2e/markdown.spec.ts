import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { parseMarkdownChunks } from "../src/markdown-parser.js";

const long = Array.from({ length: 1000 }, (_, i) => `Paragraph ${i}.\n\n`).join("");
const rich = `[reference][source]\n\n${long}\n| Item | Value |\n|---|---|\n| Complete | 10 |\n\n$E=mc^2$\n\n\`\`\`js\nconst safe = "<script>";\n\`\`\`\n\n[source]: https://example.test/reference\n\nDone.`;

const cjkConclusion = "因此，16日报备到18日报备，确实有约2个工作日的排程缓冲。";
const cjkReply = `**${cjkConclusion}**这是后续正文。\n\n所以，**11月9日作为内部控制底线有依据；后段有缓冲。**这样既能保住26日。`;

test("CJK URL boundaries survive worker updates and question-card clicks on phone and desktop", async ({ page, context }, info) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const url = "https://example.test/login/device";
  // Only synthetic pages: observe the actual click destination without opening
  // a live authorization flow or sending any user data to an external service.
  await context.route("https://example.test/**", route => route.fulfill({ body: "Link destination fixture" }));
  try {
    for (const width of [390, 1360]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
      for (const suffix of ["", "，", "，输入新代码", "，输入新代码 `DEMO-CODE` 并完成授权。"]) {
        await page.evaluate(text => (window as unknown as { setMarkdown(text: string): void }).setMarkdown(text), "请再打开 " + url + suffix);
        const link = page.getByRole("link", { name: url, exact: true });
        await expect(link).toHaveAttribute("href", url);
        await expect(page.locator(".markdown")).toHaveText("请再打开 " + url + suffix.replaceAll("`", ""));
      }
      await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/question-focus.html");
      await page.addStyleTag({ content: "body{margin:0;padding:16px;font:16px/1.7 sans-serif}*{box-sizing:border-box}.native-question{max-width:650px}" });
      const question = page.getByRole("region", { name: "回答问题", exact: true });
      const link = question.getByRole("link", { name: url, exact: true });
      await expect(link).toHaveAttribute("href", url);
      await expect(question.locator(".markdown")).toHaveText("请再打开 " + url + "，输入新代码 DEMO-CODE 并完成授权。");
      await expect(question.locator("code")).toHaveText("DEMO-CODE");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`question-link-${width}.png`), animations: "disabled" });
      const popupPromise = page.waitForEvent("popup");
      await link.click();
      const popup = await popupPromise;
      await expect(popup).toHaveURL(url);
      await popup.close();
    }
  } finally { await page.close(); await server.close(); }
});

test("CJK punctuation beside strong markers preserves formatting and literal boundaries", async () => {
  const parse = async (text: string) => (await parseMarkdownChunks(text)).map(value => JSON.parse(value));
  const elements = (nodes: any[], tag: string): any[] => nodes.flatMap(node => [...(node.tagName === tag ? [node] : []), ...elements(node.children ?? [], tag)]);
  const prose = (nodes: any[]): string => nodes.map(node => node.type === "text" ? node.value : prose(node.children ?? [])).join("");
  for (const [source, strong] of [
    [`**${cjkConclusion}**这是后续正文。`, cjkConclusion],
    ["前文**“重点”**后文", "“重点”"],
    ["前文**(重点)**后文", "(重点)"],
    ["**中文 *重点*。**后续", "中文 重点。"],
    ["前文**[链接](https://example.test/)。**后文", "链接。"],
    ["前文**`x**y`。**后文", "x**y。"],
    ["前文**重点。**后文**补充。**结束", "重点。|补充。"],
    ["**结论：**TaroBird 已修复", "结论："],
    ["**注意：**1.0.117 版本", "注意："],
    ["**结论：**😀好", "结论："],
    ["TaroBird**（已修复）**可用", "（已修复）"],
  ]) {
    const tree = await parse(source);
    expect(elements(tree, "strong").map(node => prose(node.children)).join("|")).toBe(strong);
  }
  for (const source of ["**尚未完成。", "中文** 空白 **后文", "**English.**text", "中文__“原样”__后文", "中文*“原样”*后文"]) {
    const tree = await parse(source);
    expect(elements(tree, "strong")).toHaveLength(0); expect(prose(tree)).toBe(source);
  }
  const literal = await parse('\\*\\*中文。\\*\\*后文\n\n`**中文。**后文`\n\n```text\n**中文。**后文\n```');
  expect(elements(literal, "strong")).toHaveLength(0);
  expect(elements(literal, "code").map(node => prose(node.children))).toEqual(["**中文。**后文", "**中文。**后文\n"]);
  const rich = await parse('**中文 $x^2$。**后续\n\n**[链接](https://example.test/)。**后文');
  expect(elements(rich, "strong")).toHaveLength(2);
  expect(elements(rich, "a")[0].properties.href).toBe("https://example.test/");
  expect(JSON.stringify(rich)).toContain("katex");
});

test("CJK strong markers render through streaming worker updates on phone and desktop", async ({ page }, info) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await page.addStyleTag({ content: "#root{padding:20px;max-width:900px}.markdown{font-size:16px;line-height:1.8}" });
    const set = (text: string) => page.evaluate(text => (window as unknown as { setMarkdown(text: string): void }).setMarkdown(text), text);
    for (const width of [390, 1360]) {
      await page.setViewportSize({ width, height: 700 });
      await set(`**${cjkConclusion}`);
      await expect(page.locator(".markdown")).toHaveText(`**${cjkConclusion}`);
      await set(cjkReply);
      await expect(page.locator(".markdown strong")).toHaveText([cjkConclusion, "11月9日作为内部控制底线有依据；后段有缓冲。"]);
      await expect(page.locator(".markdown")).not.toContainText("**");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`cjk-strong-${width}.png`), animations: "disabled" });
      await set("**结论：**TaroBird 已修复\n\n**注意：**1.0.117 版本\n\n**结论：**😀好");
      await expect(page.locator(".markdown strong")).toHaveText(["结论：", "注意：", "结论："]);
      await expect(page.locator(".markdown")).not.toContainText("**");
      await set("`**原样。**后文` 与 \\*\\*原样。\\*\\*后文");
      await expect(page.locator(".markdown strong")).toHaveCount(0);
      await expect(page.locator(".markdown code")).toHaveText("**原样。**后文");
    }
  } finally { await page.close(); await server.close(); }
});

for (const width of [320, 430]) test(`phone ${width} keeps long display formulas readable with horizontal scrolling`, async ({ page }, info) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await page.addStyleTag({ content: "#root { width:100%; min-width:0; padding:16px; } .markdown { min-width:0; }" });
    await page.evaluate(text => (window as unknown as { setMarkdown(text: string): void }).setMarkdown(text), `$$\n${Array.from({ length: 24 }, (_, i) => `x_{${i}}`).join(" + ")} = 42\n$$`);
    const formula = page.locator(".katex-display");
    await expect(formula).toBeVisible();
    await expect(formula).toHaveCSS("overflow-x", "auto");
    const bounds = await formula.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, documentWidth: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(bounds.scrollWidth).toBeGreaterThan(bounds.width);
    expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewport);
    await formula.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    expect(await formula.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath(`formula-end-${width}.png`) });
  } finally { await page.close(); await server.close(); }
});

test("currency keeps prose typography through worker updates while real formulas still render", async ({ page }, info) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const text = "- **k6**：一道光扫向右边，Opus 5 珊瑚色点弹出，标「七成出头」；落线后 $10 刻度亮起，出「≈ $10」。「差了好几十倍」时，$0.2 到 $10 之间画出带箭头的标尺，写「相差几十倍」，鲸鱼喷水。\n  - 担心点：标尺画完到换页只有约 1.1 秒，刚够「停 1 秒」。";
  const setText = (value: string) => page.evaluate(text => (window as unknown as { setMarkdown(text: string): void }).setMarkdown(text), value);
  try {
    await page.setViewportSize({ width: 320, height: 600 });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await page.addStyleTag({ content: ".markdown { font-size:14px; line-height:1.65; padding:8px; }" });
    for (const value of ["$10", "$10 到 $", "$10 到 $20", text]) {
      await setText(value);
      await expect(page.locator(".markdown")).toContainText(value === text ? "$0.2 到 $10 之间" : value);
      await expect(page.locator(".katex,.katex-error")).toHaveCount(0);
      await expect(page.locator(".markdown-pending")).toHaveCount(0);
    }
    const fontSizes = await page.locator(".markdown").evaluate(node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), sizes = new Set<string>();
      while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) sizes.add(getComputedStyle(walker.currentNode.parentElement!).fontSize);
      return [...sizes];
    });
    expect(fontSizes).toEqual(["14px"]);
    await page.screenshot({ path: info.outputPath("currency-prose.png") });
    await setText(text + "\n\n公式 $E=mc^2$；数值 $10$；分式 $\\frac{1}{2}$。\n\n$$\nx^2+y^2=z^2\n$$");
    await expect(page.locator(".katex")).toHaveCount(4);
    await expect(page.locator(".markdown li").first()).toContainText("$0.2 到 $10 之间");
    await expect(page.locator(".markdown li .katex")).toHaveCount(0);
    await setText(text); await expect(page.locator(".katex")).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});

test("whole-document parsing retains distant references and refuses executable markdown", async () => {
  const rendered = (await parseMarkdownChunks(rich)).join("");
  expect(rendered).toContain("https://example.test/reference"); expect(rendered).toContain('"tagName":"table"'); expect(rendered).toContain("katex"); expect(rendered).toContain("hljs"); expect(rendered).not.toContain('"position"');
  const unsafe = (await parseMarkdownChunks('[click](javascript:alert%281%29)\n\n![image](data:text/html,unsafe)\n\n<script>window.bad=true</script>\n\n$\\href{javascript:alert(1)}{x}$')).join("");
  expect(unsafe).not.toContain('"tagName":"script"'); expect(unsafe).not.toContain('"href":"javascript:'); expect(unsafe).not.toContain('"src":"data:');
  await expect(parseMarkdownChunks("x".repeat(1024 * 1024 + 1))).rejects.toThrow("too_large");
});

for (const [length, padding] of [["short", ""], ["long", long]] as const) {
test(`${length} worker rendering preserves formatting, newest edits and remount isolation`, async ({ page }) => {
  const server = await createServer({ optimizeDeps: { force: true }, server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await page.evaluate((text) => (window as unknown as { setMarkdown(text: string): void }).setMarkdown(text), rich.replace(long, padding));
    await expect(page.locator(".markdown table")).toHaveCount(1); await expect(page.locator(".katex")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "reference", exact: true })).toHaveAttribute("href", "https://example.test/reference");
    await expect(page.locator(".code-copy")).toHaveCount(1); await expect(page.locator(".markdown pre code")).toContainText('const safe = "<script>";');
    // A distant definition changes already-rendered output near the beginning.
    // Chunk reuse must compare the cleaned output, not just unchanged source.
    await page.evaluate((text) => (window as any).setMarkdown(text), rich.replace(long, padding).replace("https://example.test/reference", "https://example.test/updated"));
    await expect(page.getByRole("link", { name: "reference", exact: true })).toHaveAttribute("href", "https://example.test/updated");
    await page.evaluate((text) => { const api = window as unknown as { setMarkdown(text: string): void; remountMarkdown(text: string): void }; for (let i = 0; i < 30; i++) api.setMarkdown(text + "obsolete " + i); api.remountMarkdown(text + "Newest revision."); }, padding);
    await expect(page.locator(".markdown p").last()).toHaveText("Newest revision.");
    expect(await page.locator(".markdown").innerText()).not.toContain("obsolete");
    await expect(page.locator(".markdown table")).toHaveCount(0);
    await page.evaluate((text) => (window as unknown as { setMarkdown(text: string): void }).setMarkdown(text), padding + '[unsafe](javascript:alert%281%29) [relative](notes.md) [anchor](#notes) [empty]()\n\n<script>window.bad=true</script>\n\nSecurity check complete.');
    await expect(page.locator(".markdown p").last()).toHaveText("Security check complete.");
    for (const label of ["unsafe", "relative", "anchor", "empty"]) {
      await expect(page.getByRole("link", { name: label, exact: true })).toHaveCount(0);
      await expect(page.locator(".markdown").getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.locator(".markdown script")).toHaveCount(0);
    expect(await page.evaluate(() => "bad" in window)).toBe(false);
  } finally { await server.close(); }
});

test(`${length} messages stay readable without interpreting raw HTML when workers are unavailable`, async ({ page }) => {
  const server = await createServer({ optimizeDeps: { force: true }, server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.addInitScript(() => { window.Worker = class { constructor() { throw new Error("unsupported"); } } as unknown as typeof Worker; });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await page.evaluate((text) => (window as unknown as { setMarkdown(text: string): void }).setMarkdown(text), padding + "<img src=x onerror=alert(1)>");
    await expect(page.locator(".markdown-pending")).toContainText("<img src=x onerror=alert(1)>"); expect(await page.locator(".markdown img").count()).toBe(0);
  } finally { await server.close(); }
});
}
