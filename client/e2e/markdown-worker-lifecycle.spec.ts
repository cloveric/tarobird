import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "./fixtures/vite.js";

type Mode = "native" | "missing" | "reject" | "controlled";
async function instrument(page: Page, mode: Mode) {
  let intercepted = 0;
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    Object.assign(window, { markdownWorkerRejections: [] });
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes("markdown.worker")) {
          Object.assign(window, { latestMarkdownWorker: this, heldDigestTexts: [] });
          this.addEventListener("message", event => {
            if (event.data.digestHeld) (window as any).heldDigestTexts.push(event.data.digestHeld);
            if (event.data.digestUnhandled) (window as any).markdownWorkerRejections.push(event.data.digestUnhandled);
          });
        }
      }
    };
  });
  await page.route(/\/src\/markdown\.worker\.ts\?.*worker_file/, async route => {
    const response = await route.fetch(); intercepted++;
    const prefix = `
      const digestMode = ${JSON.stringify(mode)};
      const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
      let held = false, pendingDigests = [], digestCalls = 0, activeDigests = 0, maxDigests = 0;
      self.addEventListener("message", event => {
        if (!event.data.digestControl) return;
        event.stopImmediatePropagation();
        if (event.data.digestControl === "hold") held = true;
        else if (event.data.digestControl === "release-one") pendingDigests.shift()?.();
        else { held = false; pendingDigests.splice(0).forEach(resolve => resolve()); }
      });
      Object.defineProperty(globalThis, "crypto", { value: digestMode === "missing" ? undefined : { subtle: { digest: async (...args) => {
        digestCalls++; activeDigests++; maxDigests = Math.max(maxDigests, activeDigests);
        try {
          if (held) {
            originalPost({ digestHeld: new TextDecoder().decode(args[1]) });
            await new Promise(resolve => pendingDigests.push(resolve));
          }
          await new Promise(resolve => setTimeout(resolve, 2));
          if (digestMode === "reject") throw new Error("test_provider_rejected");
          return await nativeDigest(...args);
        } finally { activeDigests--; }
      } } }, configurable: true });
      const originalPost = self.postMessage.bind(self);
      self.addEventListener("unhandledrejection", event => originalPost({ digestUnhandled: String(event.reason) }));
      self.postMessage = data => {
        if (digestMode === "controlled" && data.chunks?.some(chunk => chunk.serialized.includes("FAIL_POST"))) throw new Error("test_reply_failed");
        originalPost({ ...data, digestMetrics: { digestCalls, maxDigests } });
      };
    `;
    await route.fulfill({ response, body: prefix + await response.text() });
  });
  return () => intercepted;
}

for (const mode of ["native", "missing", "reject"] as const) test(`Unicode output fingerprints remain exact with ${mode} WebCrypto`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    const intercepted = await instrument(page, mode);
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    const result = await page.evaluate(async () => {
      const { default: Parser } = await import("/src/markdown.worker.ts?worker");
      const parser: Worker = new Parser();
      try {
        return await new Promise<any>((resolve, reject) => {
          parser.onmessage = event => resolve(event.data); parser.onerror = () => reject(new Error("Worker failed"));
          parser.postMessage({ id: 17, text: Array.from({ length: 1000 }, (_, i) => `😺 中文 e\u0301 ${i} [链接][reference]\n\n`).join("") + "[reference]: https://example.test/🦁\n" });
        });
      } finally { parser.terminate(); }
    });
    expect(intercepted()).toBeGreaterThan(0); expect(result.id).toBe(17); expect(result.error).toBeUndefined();
    expect(result.chunks.length).toBeGreaterThan(8);
    for (const chunk of result.chunks) expect(chunk.fingerprint).toBe(createHash("sha256").update(chunk.serialized, "utf8").digest("hex"));
    expect(result.digestMetrics.maxDigests).toBeLessThanOrEqual(8);
    if (mode === "missing") expect(result.digestMetrics.digestCalls).toBe(0);
    else { expect(result.digestMetrics.digestCalls).toBe(result.chunks.length); expect(result.digestMetrics.maxDigests).toBeGreaterThan(1); }
  } finally { await page.close(); await server.close(); }
});

test("delayed digest cannot restore a disposed Markdown owner", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    const intercepted = await instrument(page, "controlled");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    await page.evaluate(() => { const api = window as any; api.latestMarkdownWorker.postMessage({ digestControl: "hold" }); api.setMarkdown("OBSOLETE_DIGEST"); });
    // An actual worker receipt confirms the old request is awaiting its digest.
    await expect.poll(() => page.evaluate(() => (window as any).heldDigestTexts.some((text: string) => text.includes("OBSOLETE_DIGEST")))).toBe(true);
    await page.evaluate(() => { const api = window as any; api.setMarkdown("OBSOLETE_REVISION"); api.remountMarkdown("LATEST_OWNER"); });
    // Disposing now cancels its Worker immediately; the latest owner may
    // already be formatted by this point, so do not require a transient state.
    await page.evaluate(() => (window as any).latestMarkdownWorker.postMessage({ digestControl: "release" }));
    await expect(page.locator(".markdown p")).toHaveText("LATEST_OWNER");
    expect(intercepted()).toBeGreaterThan(0); expect(await page.locator(".markdown").innerText()).not.toContain("OBSOLETE");
  } finally { await page.close(); await server.close(); }
});

for (const replacement of [false, true]) test(`completed streaming prefix remains visible while the next digest is held (replacement=${replacement})`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await instrument(page, "controlled");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    await page.evaluate(async () => {
      const { createMarkdownJob } = await import("/src/markdown-jobs.ts");
      const api = window as any; api.probeJob = createMarkdownJob(); api.probeResults = [];
      api.probeDeliver = (chunks: any) => api.probeResults.push(chunks?.map((chunk: any) => chunk.serialized).join(""));
      api.latestMarkdownWorker.postMessage({ digestControl: "hold" });
      api.probeJob.update("STREAM_PREFIX", api.probeDeliver);
    });
    await expect.poll(() => page.evaluate(() => (window as any).heldDigestTexts.some((text: string) => text.includes("STREAM_PREFIX")))).toBe(true);
    await page.evaluate(replace => {
      const api = window as any;
      if (replace) api.probeJob.update("REPLACEMENT", api.probeDeliver);
      api.probeJob.update("STREAM_PREFIX\n\nNEW_TAIL", api.probeDeliver);
      api.latestMarkdownWorker.postMessage({ digestControl: "release-one" });
    }, replacement);
    await expect.poll(() => page.evaluate(() => (window as any).heldDigestTexts.some((text: string) => text.includes("NEW_TAIL")))).toBe(true);
    const pending = await page.evaluate(() => (window as any).probeResults);
    if (replacement) expect(pending).toEqual([]);
    else { expect(pending).toHaveLength(1); expect(pending[0]).toContain("STREAM_PREFIX"); expect(pending[0]).not.toContain("NEW_TAIL"); }
    await page.evaluate(() => (window as any).latestMarkdownWorker.postMessage({ digestControl: "release" }));
    await expect.poll(() => page.evaluate(() => (window as any).probeResults.at(-1)?.includes("NEW_TAIL"))).toBe(true);
    await page.evaluate(() => (window as any).probeJob.dispose());
  } finally { await page.close(); await server.close(); }
});

test("held digest preserves the latest revision without disposing its owner", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    const intercepted = await instrument(page, "controlled");
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    await page.evaluate(async () => {
      const { createMarkdownJob } = await import("/src/markdown-jobs.ts");
      const api = window as any; api.probeJob = createMarkdownJob(); api.probeResults = [];
      api.probeDeliver = (chunks: any) => api.probeResults.push(chunks?.map((chunk: any) => chunk.serialized).join(""));
      api.latestMarkdownWorker.postMessage({ digestControl: "hold" });
      api.probeJob.update("OBSOLETE_REVISION", api.probeDeliver);
    });
    await expect.poll(() => page.evaluate(() => (window as any).heldDigestTexts.some((text: string) => text.includes("OBSOLETE_REVISION")))).toBe(true);
    await page.evaluate(() => {
      const api = window as any;
      // This synchronously changes the real scheduler revision on the same job.
      api.probeJob.update("LATEST_REVISION", api.probeDeliver);
      api.latestMarkdownWorker.postMessage({ digestControl: "release-one" });
    });
    await expect.poll(() => page.evaluate(() => (window as any).heldDigestTexts.some((text: string) => text.includes("LATEST_REVISION")))).toBe(true);
    // The old result has arrived (the worker has started the next request), but
    // the latest result is still held. No stale callback may have been invoked.
    expect(await page.evaluate(() => (window as any).probeResults)).toEqual([]);
    await page.evaluate(() => (window as any).latestMarkdownWorker.postMessage({ digestControl: "release" }));
    await expect.poll(() => page.evaluate(() => (window as any).probeResults.length)).toBe(1);
    expect(await page.evaluate(() => (window as any).probeResults[0])).toContain("LATEST_REVISION");
    await page.evaluate(() => (window as any).probeJob.dispose());
    expect(intercepted()).toBeGreaterThan(0);
  } finally { await page.close(); await server.close(); }
});

for (const failure of ["timeout", "reply"] as const) test(`digest ${failure} recovers safely within the automatic or explicit retry boundary`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    const intercepted = await instrument(page, "controlled"); const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    await page.evaluate(mode => {
      const api = window as any;
      if (mode === "timeout") {
        const original = window.setTimeout.bind(window); let shortened = false;
        window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: any[]) => {
          const duration = ms === 15_000 && !shortened ? (shortened = true, 250) : ms;
          return original(handler, duration, ...args);
        }) as typeof window.setTimeout;
        api.latestMarkdownWorker.postMessage({ digestControl: "hold" });
      }
      api.setMarkdown((mode === "reply" ? "FAIL_POST " : "DIGEST_TIMEOUT ") + "<img src=x onerror=alert(1)> **safe fallback**");
    }, failure);
    if (failure === "timeout") await expect(page.locator(".markdown strong")).toHaveText("safe fallback");
    else await expect(page.locator(".markdown-pending")).toContainText("<img src=x onerror=alert(1)>");
    await expect(page.locator(".markdown img")).toHaveCount(0);
    await page.evaluate(() => (window as any).setMarkdown("**RECOVERED_DIGEST**"));
    if (failure === "reply") {
      await expect(page.locator(".markdown-pending")).toHaveText("**RECOVERED_DIGEST**");
      await page.getByRole("button", { name: "恢复排版", exact: true }).click();
    }
    await expect(page.locator(".markdown strong")).toHaveText("RECOVERED_DIGEST");
    expect(intercepted()).toBeGreaterThanOrEqual(2); expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as any).markdownWorkerRejections)).toEqual([]);
  } finally { await page.close(); await server.close(); }
});
