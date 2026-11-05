import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

type Fault = "once-error" | "once-timeout" | "always-error" | "always-constructor" | "poison-timeout" | "controlled";
async function instrument(page: Page, fault: Fault) {
  await page.addInitScript(mode => {
    const api = window as any, NativeWorker = window.Worker;
    Object.assign(api, { markdownAttempts: 0, markdownWorkers: [], markdownRequests: [], markdownRequestFrames: [], allowMarkdown: false, markdownHeld: [], markdownWorkerRejections: [] });
    const setTimeoutNative = window.setTimeout.bind(window);
    // Accelerate only the deliberately held parse, never module loading or a
    // healthy queued document. A slow cold Worker is not our injected fault.
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: any[]) => {
      const request = api.markdownRequestFrames.at(-1);
      const held = mode === "once-timeout" && api.markdownAttempts === 1 && request?.text.includes("BROKEN")
        || mode === "poison-timeout" && request?.text.includes("SLOW");
      return setTimeoutNative(fn, held && ms === 15_000 ? 350 : ms, ...args);
    }) as typeof window.setTimeout;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        const markdown = String(url).includes("markdown.worker");
        if (markdown) { api.markdownAttempts++; if (mode === "always-constructor" && !api.allowMarkdown) throw new Error("test_worker_blocked"); }
        super(url, options);
        if (markdown) {
          api.markdownWorkers.push(this);
          this.addEventListener("error", () => queueMicrotask(() => api.retryOnWorkerError?.()));
          this.addEventListener("message", event => {
            if (event.data.testHeld) api.markdownHeld.push(event.data.testHeld);
            if (event.data.testUnhandled) api.markdownWorkerRejections.push(event.data.testUnhandled);
          });
          const post = this.postMessage.bind(this);
          this.postMessage = ((data: any) => { if (data.text !== undefined) { api.markdownRequests.push(data.text); api.markdownRequestFrames.push(data); } post(data); }) as typeof this.postMessage;
        }
      }
    };
  }, fault);
  let generation = 0;
  await page.route(/\/src\/markdown\.worker\.ts\?.*worker_file/, async route => {
    const response = await route.fetch(); const workerNumber = ++generation;
    const prefix = `
      const fault = ${JSON.stringify(fault)}, generation = ${workerNumber};
      const post = self.postMessage.bind(self); let heldMessages = [];
      self.addEventListener("unhandledrejection", event => post({ testUnhandled: String(event.reason) }));
      self.addEventListener("message", event => {
        const data = event.data;
        if (data.testControl) {
          event.stopImmediatePropagation();
          if (data.testControl === "error") setTimeout(() => { throw new Error("test_worker_failure"); }, 0);
          if (data.testControl === "release") heldMessages.splice(0).forEach(data => self.onmessage({ data }));
          return;
        }
        const fail = fault === "poison-timeout" && data.text.includes("SLOW") || fault === "always-error" || generation === 1 && (fault === "once-error" || fault === "once-timeout") && data.text.includes("BROKEN");
        if (fail) {
          event.stopImmediatePropagation();
          if (fault === "poison-timeout") post({ testHeld: data.text });
          if (fault !== "once-timeout" && fault !== "poison-timeout") setTimeout(() => { throw new Error("test_worker_failure"); }, 0);
          return;
        }
        if (fault === "controlled" && data.text.includes("HOLD")) {
          event.stopImmediatePropagation(); heldMessages.push(data); post({ testHeld: data.text });
        }
      });
    `;
    await route.fulfill({ response, body: prefix + await response.text() });
  });
}

for (const fault of ["once-error", "once-timeout"] as const) test(`one ${fault} restores unchanged messages without navigation or a new send`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, fault);
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    // Mount the first owner before inducing failure; development StrictMode's
    // initial effect replay must not turn the failed job into a disposed owner.
    await page.evaluate(() => (window as any).setMarkdownRows([{ id: "bad", text: "**WARM**" }]));
    await expect(page.locator('[data-message="bad"] strong')).toHaveText("WARM");
    await page.evaluate(() => (window as any).setMarkdownRows([{ id: "bad", text: "**BROKEN_ONCE**" }, { id: "next", text: "**NEXT_MESSAGE**" }, { id: "last", text: "**LAST_MESSAGE**" }]));
    await expect(page.locator('[data-message="next"] strong')).toHaveText("NEXT_MESSAGE");
    await expect(page.locator('[data-message="last"] strong')).toHaveText("LAST_MESSAGE");
    await expect(page.locator('[data-message="bad"] strong')).toHaveText("BROKEN_ONCE");
    expect(await page.evaluate(() => (window as any).markdownAttempts)).toBe(2);
    const requests: string[] = await page.evaluate(() => (window as any).markdownRequests);
    expect(requests.slice(-3)).toEqual(["**NEXT_MESSAGE**", "**LAST_MESSAGE**", "**BROKEN_ONCE**"]);
    expect(await page.evaluate(() => (window as any).markdownWorkerRejections)).toEqual([]);
  } finally { await page.close(); await server.close(); }
});

test("asynchronous platform failure stops after two workers despite continued streaming updates", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, "always-error");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(() => (window as any).setMarkdownRows(Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: `**Initial ${i}**` }))));
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(20);
    for (let revision = 0; revision < 3; revision++) {
      await page.evaluate(revision => (window as any).setMarkdownRows(Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: `**Revision ${revision} ${i}**` }))), revision);
      await expect(page.locator('[data-message="0"] .markdown-pending')).toContainText(`Revision ${revision} 0`);
    }
    expect(await page.evaluate(() => (window as any).markdownAttempts)).toBe(2);
  } finally { await page.close(); await server.close(); }
});

test("superseded work and old worker events cannot corrupt the replacement queue", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, "controlled");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(async () => {
      const { createMarkdownJob } = await import("/src/markdown-jobs.ts"); const api = window as any;
      api.results = []; api.jobs = [createMarkdownJob(), createMarkdownJob(), createMarkdownJob()];
      api.deliver = (who: string) => (chunks: any) => api.results.push({ who, text: chunks?.map((chunk: any) => chunk.serialized).join("") });
      api.jobs[0].update("HOLD_OBSOLETE", api.deliver("a"));
      api.jobs[1].update("HOLD_HEALTHY", api.deliver("b"));
      api.jobs[2].update("DISPOSED", api.deliver("c"));
    });
    await expect.poll(() => page.evaluate(() => (window as any).markdownHeld)).toEqual(["HOLD_OBSOLETE"]);
    await page.evaluate(() => {
      const api = window as any, old = api.markdownWorkers[0];
      api.oldCallbacks = { message: old.onmessage, error: old.onerror, decode: old.onmessageerror };
      api.jobs[0].update("LATEST_A", api.deliver("a")); api.jobs[2].dispose(); old.postMessage({ testControl: "error" });
    });
    await expect.poll(() => page.evaluate(() => (window as any).markdownHeld)).toEqual(["HOLD_OBSOLETE", "HOLD_HEALTHY"]);
    await page.evaluate(() => {
      const api = window as any, id = api.markdownRequestFrames.at(-1).id;
      api.oldCallbacks.error(new Event("error", { cancelable: true }));
      api.oldCallbacks.decode(new MessageEvent("messageerror"));
      api.oldCallbacks.message(new MessageEvent("message", { data: { id, chunks: [] } }));
    });
    expect(await page.evaluate(() => (window as any).results)).toEqual([]);
    expect(await page.evaluate(() => (window as any).markdownAttempts)).toBe(2);
    await page.evaluate(() => (window as any).markdownWorkers[1].postMessage({ testControl: "release" }));
    await expect.poll(() => page.evaluate(() => (window as any).results.map((item: any) => item.who))).toEqual(["b", "a"]);
    const result = await page.evaluate(() => (window as any).results);
    expect(result[0].text).toContain("HOLD_HEALTHY"); expect(result[1].text).toContain("LATEST_A");
    expect(await page.evaluate(() => (window as any).markdownRequests)).toEqual(["HOLD_OBSOLETE", "HOLD_HEALTHY", "LATEST_A"]);
    await page.evaluate(() => (window as any).jobs.forEach((job: any) => job.dispose()));
  } finally { await page.close(); await server.close(); }
});

test("manual retries during automatic recovery do not replenish the revision budget", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, "once-error");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(async () => {
      const { createMarkdownJob } = await import("/src/markdown-jobs.ts"); const api = window as any;
      api.results = []; api.job = createMarkdownJob(); api.retryClicks = 0;
      api.retryOnWorkerError = () => { for (let i = 0; i < 20; i++) { api.job.retry(); api.retryClicks++; } };
      api.job.update("BROKEN_RECOVERY", (chunks: any) => api.results.push(chunks?.map((chunk: any) => chunk.serialized).join("")));
    });
    await expect.poll(() => page.evaluate(() => (window as any).results.length)).toBe(1);
    expect(await page.evaluate(() => (window as any).results[0])).toContain("BROKEN_RECOVERY");
    expect(await page.evaluate(() => (window as any).retryClicks)).toBe(20);
    expect(await page.evaluate(() => (window as any).markdownRequests)).toEqual(["BROKEN_RECOVERY", "BROKEN_RECOVERY"]);
    expect(await page.evaluate(() => (window as any).markdownAttempts)).toBe(2);
    await page.evaluate(() => (window as any).job.dispose());
  } finally { await page.close(); await server.close(); }
});

test("two parser rejections do not break transport or prevent later healthy messages", async ({ page }, info) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, "controlled");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    const started = Date.now();
    await page.evaluate(() => (window as any).setMarkdownRows([{ id: "first", text: "x".repeat(1024 * 1024 + 1) }, { id: "second", text: "y".repeat(1024 * 1024 + 1) }, { id: "healthy", text: "**HEALTHY_AFTER_REJECTION**" }]));
    await expect(page.locator('[data-message="healthy"] strong')).toHaveText("HEALTHY_AFTER_REJECTION");
    const healthyMs = Date.now() - started;
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(2);
    expect(await page.evaluate(() => (window as any).markdownAttempts)).toBe(1);
    // Check completeness outside the recovery interval, including characters
    // at the end of both rejected documents. No truncation or parser bypass.
    const sizes = await page.locator(".markdown-pending").evaluateAll(nodes => nodes.map(node => node.textContent?.length));
    expect(sizes).toEqual([1024 * 1024 + 1, 1024 * 1024 + 1]);
    const report = { healthyMs, rejectedCharacters: sizes };
    console.log("Markdown oversized recovery", JSON.stringify(report));
    await info.attach("oversized-recovery", { body: JSON.stringify(report), contentType: "application/json" });
  } finally { await page.close(); await server.close(); }
});

test("permanently blocked workers stay bounded across updates and restore mounted history after an explicit formatting retry", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, "always-constructor");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(() => (window as any).setMarkdownRows(Array.from({ length: 50 }, (_, i) => ({ id: String(i), text: `**Message ${i}** <img src=x onerror=alert(1)>` }))));
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(50);
    expect(await page.evaluate(() => (window as any).markdownAttempts)).toBe(2);
    await page.evaluate(() => (window as any).setMarkdownRows(Array.from({ length: 50 }, (_, i) => ({ id: String(i + 50), text: `**New ${i}** <img src=x onerror=alert(1)>` }))));
    await expect(page.locator('[data-message="50"] .markdown-pending')).toContainText("New 0");
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(50);
    expect(await page.evaluate(() => (window as any).markdownAttempts)).toBe(2);
    await expect(page.locator(".markdown img")).toHaveCount(0);
    await page.evaluate(() => { (window as any).allowMarkdown = true; });
    await page.locator('[data-message="50"]').getByRole("button", { name: "恢复排版", exact: true }).click();
    await expect(page.locator('[data-message="50"] strong')).toHaveText("New 0");
    expect(await page.evaluate(() => (window as any).markdownAttempts)).toBe(3);
    await expect(page.locator(".markdown strong")).toHaveCount(50);
    await expect(page.locator('[data-message="51"] strong')).toHaveText("New 1");
    await expect(page.getByRole("button", { name: "恢复排版", exact: true })).toHaveCount(0);
    await expect(page.locator('[data-message="50"] .markdown')).toBeFocused();
  } finally { await page.close(); await server.close(); }
});

for (const width of [1360, 390]) test(`formatting retry preserves the latest readable text, focus and touch target (${width}px)`, async ({ page }, info) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.setViewportSize({ width, height: 844 }); await instrument(page, "controlled");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    if (width === 390) await page.evaluate(async () => { const { setLocale } = await import("/src/i18n.ts"); setLocale("en"); document.documentElement.dataset.theme = "dark"; });
    await page.evaluate(() => (window as any).setMarkdownRows([{ id: "row", text: "**OLD_VISIBLE**" }]));
    await expect(page.locator(".markdown strong")).toHaveText("OLD_VISIBLE");
    await expect(page.locator(".markdown")).not.toHaveAttribute("tabindex");
    await page.evaluate(() => (window as any).setMarkdownRows([{ id: "row", text: "x".repeat(1024 * 1024 + 1) }]));
    const retry = page.getByRole("button", { name: width === 390 ? "Restore formatting" : "恢复排版", exact: true });
    await expect(retry).toBeVisible();
    await page.evaluate(() => (window as any).setMarkdownRows([{ id: "row", text: "**HOLD_LATEST**" }]));
    await expect.poll(() => page.evaluate(() => (window as any).markdownHeld)).toContain("**HOLD_LATEST**");
    await expect(page.locator(".markdown-pending")).toHaveText("**HOLD_LATEST**");
    const bounds = await retry.boundingBox(); expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`formatting-retry-${width}.png`) });
    const requests = await page.evaluate(() => (window as any).markdownRequests.length);
    await retry.click();
    await expect(page.locator(".markdown-pending")).toHaveText("**HOLD_LATEST**");
    await expect(page.locator(".markdown strong")).toHaveCount(0);
    await expect(page.locator(".markdown")).toBeFocused();
    expect(await page.evaluate(() => (window as any).markdownRequests.length)).toBe(requests);
    await page.evaluate(() => (window as any).markdownWorkers.at(-1).postMessage({ testControl: "release" }));
    await expect(page.locator(".markdown strong")).toHaveText("HOLD_LATEST");
    await expect(page.locator(".markdown")).toBeFocused();
    await page.locator(".markdown").evaluate((root: HTMLElement) => root.blur());
    await expect(page.locator(".markdown")).not.toHaveAttribute("tabindex");
  } finally { await page.close(); await server.close(); }
});


test("one stalled streaming owner is isolated while healthy messages continue", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, "poison-timeout");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(async () => {
      const { createMarkdownJob } = await import("/src/markdown-jobs.ts"); const api = window as any;
      api.results = []; api.poison = createMarkdownJob(); api.healthy = createMarkdownJob();
      api.deliver = (who: string) => (chunks: any) => api.results.push({ who, text: chunks?.map((chunk: any) => chunk.serialized).join("") });
      api.poison.update("SLOW_1", api.deliver("p1")); api.healthy.update("HEALTHY_1", api.deliver("h1"));
    });
    await expect.poll(() => page.evaluate(() => (window as any).results.some((r: any) => r.who === "h1" && r.text.includes("HEALTHY_1")))).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).markdownHeld.length)).toBe(2);
    await page.evaluate(() => {
      const api = window as any; api.healthy.update("HEALTHY_2", api.deliver("h2")); api.poison.update("SLOW_2", api.deliver("p2"));
    });
    await expect.poll(() => page.evaluate(() => (window as any).results.some((r: any) => r.who === "h2" && r.text?.includes("HEALTHY_2")))).toBe(true);
    for (let i = 3; i < 7; i++) {
      await page.evaluate(i => { const api = window as any; api.poison.update(`SLOW_${i}`, api.deliver(`p${i}`)); api.healthy.update(`HEALTHY_${i}`, api.deliver(`h${i}`)); }, i);
      await expect.poll(() => page.evaluate(i => (window as any).results.some((r: any) => r.who === `h${i}` && r.text?.includes(`HEALTHY_${i}`)), i)).toBe(true);
    }
    expect(await page.evaluate(() => (window as any).markdownRequests.filter((s: string) => s.includes("SLOW")))).toEqual(["SLOW_1", "SLOW_1"]);
    expect(await page.evaluate(() => (window as any).results.find((r: any) => r.who === "p6"))).toEqual({ who: "p6", text: undefined });
    await page.evaluate(() => { const api = window as any; api.poison.update("RECOVERED_LATEST", api.deliver("recovered")); api.poison.retry(); });
    await expect.poll(() => page.evaluate(() => (window as any).results.some((r: any) => r.who === "recovered" && r.text?.includes("RECOVERED_LATEST")))).toBe(true);
    await page.evaluate(() => { (window as any).poison.dispose(); (window as any).healthy.dispose(); });
  } finally { await page.close(); await server.close(); }
});

test("circuit recovery keeps only mounted latest jobs and does not retry rejected documents", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, "always-constructor");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(async () => {
      const { createMarkdownJob } = await import("/src/markdown-jobs.ts"); const api = window as any;
      api.allowMarkdown = true; api.results = []; api.jobs = Array.from({ length: 4 }, () => createMarkdownJob());
      api.deliver = (who: string) => (chunks: any) => api.results.push({ who, text: chunks?.map((chunk: any) => chunk.serialized).join("") });
      api.jobs[0].update("x".repeat(1024 * 1024 + 1), api.deliver("rejected")); api.jobs[1].update("WARM", api.deliver("warm"));
    });
    await expect.poll(() => page.evaluate(() => (window as any).results.some((r: any) => r.who === "warm" && r.text))).toBeTruthy();
    await page.evaluate(() => { const api = window as any; api.allowMarkdown = false; api.markdownWorkers[0].postMessage({ testControl: "error" }); });
    await expect.poll(() => page.evaluate(() => (window as any).markdownWorkers[0].onmessage)).toBeNull();
    await page.evaluate(() => {
      const api = window as any;
      api.jobs[1].update("DROPPED", api.deliver("dropped")); api.jobs[2].update("OLD_CIRCUIT", api.deliver("old")); api.jobs[3].update("RECOVERY_PROBE", api.deliver("probe"));
      api.jobs[2].update("LATEST_CIRCUIT", api.deliver("latest"));
    });
    await expect.poll(() => page.evaluate(() => (window as any).results.some((r: any) => r.who === "latest" && !r.text))).toBe(true);
    await page.evaluate(() => {
      const api = window as any; api.jobs[1].dispose(); api.allowMarkdown = true; api.jobs[3].retry();
    });
    await expect.poll(() => page.evaluate(() => (window as any).results.some((r: any) => r.who === "latest" && r.text?.includes("LATEST_CIRCUIT")))).toBe(true);
    const requests: string[] = await page.evaluate(() => (window as any).markdownRequests);
    expect(requests.slice(1)).toEqual(["WARM", "RECOVERY_PROBE", "LATEST_CIRCUIT"]);
    expect(await page.evaluate(() => (window as any).results.filter((r: any) => r.who === "rejected"))).toHaveLength(1);
    await page.evaluate(() => (window as any).jobs.forEach((job: any) => job.dispose()));
  } finally { await page.close(); await server.close(); }
});

test("an isolated stalled owner does not open the circuit for fresh healthy messages", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, "poison-timeout");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(async () => {
      const { createMarkdownJob } = await import("/src/markdown-jobs.ts"); const api = window as any;
      api.results = []; api.poison = createMarkdownJob(); api.healthy = createMarkdownJob();
      api.deliver = (who: string) => (chunks: any) => api.results.push({ who, text: chunks?.map((chunk: any) => chunk.serialized).join("") });
      api.poison.update("SLOW_ALONE", api.deliver("poison"));
    });
    await expect.poll(() => page.evaluate(() => (window as any).results.length)).toBe(1);
    await page.evaluate(() => { const api = window as any; api.healthy.update("HEALTHY_NEW", api.deliver("healthy")); });
    await expect.poll(() => page.evaluate(() => (window as any).results.some((r: any) => r.who === "healthy" && r.text?.includes("HEALTHY_NEW")))).toBe(true);
    expect(await page.evaluate(() => (window as any).markdownRequests)).toEqual(["SLOW_ALONE", "SLOW_ALONE", "HEALTHY_NEW"]);
    await page.evaluate(() => { (window as any).poison.dispose(); (window as any).healthy.dispose(); });
  } finally { await page.close(); await server.close(); }
});

test("disposing a currently stalled owner immediately releases the healthy queue", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, "controlled");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown-recovery.html");
    await page.evaluate(async () => {
      const { createMarkdownJob } = await import("/src/markdown-jobs.ts"); const api = window as any;
      api.results = []; api.jobs = [createMarkdownJob(), createMarkdownJob()];
      api.jobs[0].update("HOLD_DISPOSED", () => api.results.push("disposed"));
      api.jobs[1].update("HEALTHY_QUEUED", (chunks: any) => api.results.push(chunks?.map((chunk: any) => chunk.serialized).join("")));
    });
    await expect.poll(() => page.evaluate(() => (window as any).markdownHeld)).toEqual(["HOLD_DISPOSED"]);
    await page.evaluate(() => (window as any).jobs[0].dispose());
    await expect.poll(() => page.evaluate(() => (window as any).results[0]), { timeout: 2_000 }).toContain("HEALTHY_QUEUED");
    expect(await page.evaluate(() => (window as any).results.length)).toBe(1);
    await page.evaluate(() => (window as any).jobs[1].dispose());
  } finally { await page.close(); await server.close(); }
});
