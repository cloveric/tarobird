import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { parseMarkdownChunks } from "../src/markdown-parser.js";
import { readFileSync } from "node:fs";
const parity = JSON.parse(readFileSync(new URL("./fixtures/markdown-parity.json", import.meta.url), "utf8")) as { name: string; text: string; chunks: string[] }[];

test("a late skipped request cannot consume a newer manual recovery budget", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  let attempts = 0;
  await page.addInitScript(() => {
    const api = window as any, NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes("markdown.worker")) return;
        let request: any; const post = this.postMessage.bind(this);
        this.postMessage = ((data: any) => { request = data; post(data); }) as typeof this.postMessage;
        this.addEventListener("message", event => {
          if (request?.text.includes("LATE") && request.unavailable?.includes("math") && !api.heldSkip) {
            event.stopImmediatePropagation(); api.heldSkip = { worker: this, data: event.data };
          }
        });
      }
    };
  });
  await page.route(/\/src\/markdown-math\.ts(?:\?|$)/, route => ++attempts <= 3 ? route.abort() : route.continue());
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(() => (window as any).setMarkdownRows([{ id: "first", text: "FIRST $a^2$" }]));
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(1);
    expect(attempts).toBe(2);
    await page.evaluate(() => (window as any).setMarkdownRows([{ id: "first", text: "FIRST $a^2$" }, { id: "late", text: "LATE $b^2$" }]));
    await expect.poll(() => page.evaluate(() => !!(window as any).heldSkip)).toBe(true);
    await page.locator('[data-message="first"]').getByRole("button", { name: "恢复排版", exact: true }).click();
    await page.evaluate(() => { const held = (window as any).heldSkip; held.worker.onmessage(new MessageEvent("message", { data: held.data })); });
    await expect(page.locator(".katex")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(0);
    expect(attempts).toBe(4);
  } finally { await page.close(); await server.close(); }
});

for (const failure of ["rejection", "timeout"] as const) test(`optional engine ${failure} leaves unrelated messages formatted and one retry restores affected history`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  let attempts = 0, allow = false;
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/src\/markdown-math\.ts(?:\?|$)/, async route => {
    attempts++;
    if (!allow && failure === "rejection") await route.abort();
    else { if (!allow) await held; await route.continue().catch(() => undefined); }
  });
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(() => (window as any).setMarkdownRows([
      ...Array.from({ length: 50 }, (_, i) => ({ id: `math-${i}`, text: `Formula ${i}: $x^2$` })),
      { id: "plain", text: "**Healthy ordinary message**" },
      { id: "code", text: "```js\nconst healthy = true;\n```" },
    ]));
    await expect(page.locator('[data-message="plain"] strong')).toHaveText("Healthy ordinary message", { timeout: 15_000 });
    await expect(page.locator('[data-message="code"] code.hljs')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(50);
    expect(attempts).toBe(2);
    allow = true; release(); await page.locator('[data-message="math-0"]').getByRole("button", { name: "恢复排版", exact: true }).click();
    await expect(page.locator(".katex")).toHaveCount(50);
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(0);
    expect(attempts).toBe(3);
  } finally { release(); await page.close(); await server.close(); }
});

test("restored math releases formula history even if a mixed document's highlighter fails", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  let math = false, highlight = false;
  await page.route(/\/src\/markdown-math\.ts(?:\?|$)/, route => math ? route.continue() : route.abort());
  await page.route(/\/src\/markdown-highlight\.ts(?:\?|$)/, route => highlight ? route.continue() : route.abort());
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(() => (window as any).setMarkdownRows([
      { id: "formula-a", text: "$a^2$" }, { id: "formula-b", text: "$b^2$" },
      { id: "mixed", text: "$c^2$\n\n```js\nconst answer = 42;\n```" },
    ]));
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(3);
    math = true; await page.locator('[data-message="mixed"]').getByRole("button", { name: "恢复排版", exact: true }).click();
    await expect(page.locator('[data-message="formula-a"] .katex')).toHaveCount(1);
    await expect(page.locator('[data-message="formula-b"] .katex')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(1);
    highlight = true; await page.getByRole("button", { name: "恢复排版", exact: true }).click();
    await expect(page.locator(".katex")).toHaveCount(3); await expect(page.locator("code.hljs")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});

test("conditional transforms preserve the previous complete parser output", async () => {
  // Display grouping is a paint budget, not part of the Markdown semantics.
  // Compare every sanitized node, property and ordering against the original
  // parser fixtures while allowing the same tree to span smaller groups.
  const nodes = (chunks: string[]) => chunks.flatMap(chunk => JSON.parse(chunk).children);
  for (const example of parity) expect(nodes(await parseMarkdownChunks(example.text)), example.name).toEqual(nodes(example.chunks));
});

for (const action of ["edit", "remount"] as const) test(`a held formula engine cannot publish stale output after ${action}`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  let held = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/src\/markdown-math\.ts(?:\?|$)/, async route => { held++; await gate; await route.continue().catch(() => undefined); });
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    await page.evaluate(() => (window as any).setMarkdown("STALE_FORMULA $a^2$"));
    await expect.poll(() => held).toBe(1);
    await page.evaluate(action => (window as any)[action === "edit" ? "setMarkdown" : "remountMarkdown"]("Latest plain message."), action);
    release();
    await expect(page.locator(".markdown p")).toHaveText("Latest plain message.");
    await expect(page.locator(".katex")).toHaveCount(0);
    expect(await page.locator(".markdown").innerText()).not.toContain("STALE_FORMULA");
  } finally { release(); await page.close(); await server.close(); }
});

for (const failure of ["once", "persistent"] as const) test(`${failure} rich-engine load failure has bounded recovery and preserves readable content`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  let attempts = 0, allow = false;
  await page.route(/\/src\/markdown-math\.ts(?:\?|$)/, async route => {
    attempts++;
    if (!allow && (failure === "persistent" || attempts === 1)) await route.abort(); else await route.continue();
  });
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    await page.evaluate(() => (window as any).setMarkdown("Still readable $a^2$"));
    if (failure === "persistent") {
      await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toBeVisible();
      await expect(page.locator(".markdown-pending")).toHaveText("Still readable $a^2$");
      expect(attempts).toBe(2);
      allow = true; await page.getByRole("button", { name: "恢复排版", exact: true }).click();
    }
    await expect(page.locator(".katex")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(0);
    expect(attempts).toBe(failure === "once" ? 2 : 3);
  } finally { await page.close(); await server.close(); }
});

for (const first of ["math", "code"] as const) test(`ordinary text loads neither rich engine; ${first} and the other engine load on demand`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const engines = new Set<string>();
  page.on("request", request => {
    // Match engine modules, not lightweight parser helpers with the same prefix.
    if (/\/(?:rehype[-_]katex|markdown-math)\.(?:js|ts)(?:\?|$)/.test(request.url())) engines.add("math");
    if (/\/(?:rehype[-_]highlight|markdown-highlight)\.(?:js|ts)(?:\?|$)/.test(request.url())) engines.add("code");
  });
  const set = async (text: string) => page.evaluate(text => (window as any).setMarkdown(text), text);
  const render = async (kind: "math" | "code") => {
    await set(kind === "math" ? "$a^2+b^2=c^2$" : "```js\nconst answer = 42;\n```");
    await expect(page.locator(kind === "math" ? ".katex" : "code.hljs")).toHaveCount(1);
  };
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    await set("**普通消息** with `inline code`\n\n| 项目 | 值 |\n|---|---|\n| T | 1 |\n\n- [x] Done");
    await expect(page.locator(".markdown table")).toHaveCount(1);
    await expect(page.locator(".markdown strong")).toHaveText("普通消息");
    expect([...engines]).toEqual([]);
    await set("```\nUntyped code\n```\n\n    Indented code");
    await expect(page.locator(".markdown pre code")).toHaveText(["Untyped code\n", "Indented code\n"]);
    expect([...engines]).toEqual([]);
    await render(first); expect([...engines]).toEqual([first]);
    await render(first === "math" ? "code" : "math"); expect([...engines].sort()).toEqual(["code", "math"]);
    await set("Ordinary again."); await expect(page.locator(".markdown p")).toHaveText("Ordinary again.");
    await expect(page.locator(".katex, code.hljs")).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});
