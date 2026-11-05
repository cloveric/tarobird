import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

test("rendered Markdown releases its serialized transport copies", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "Heap snapshots use Chromium's inspector, not a native RSS measurement");
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const inspector = await page.context().newCDPSession(page);
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    await expect(page.locator(".markdown p")).toHaveText("start");
    const text = Array.from({ length: 5000 }, (_, i) => `MEMORY_PARAGRAPH_${i} ${"完整内容保持可读。".repeat(5)}\n\n`).join("");
    await page.evaluate(value => (window as any).setMarkdown(value), text);
    await expect(page.locator(".markdown p")).toHaveCount(5000);
    await expect(page.locator(".markdown p").last()).toContainText("MEMORY_PARAGRAPH_4999");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await inspector.send("HeapProfiler.enable");
    await inspector.send("HeapProfiler.collectGarbage");
    const heap = await inspector.send("Runtime.getHeapUsage");
    const parts: string[] = [];
    inspector.on("HeapProfiler.addHeapSnapshotChunk", event => parts.push(event.chunk));
    await inspector.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    const snapshot = JSON.parse(parts.join(""));
    const fields: string[] = snapshot.snapshot.meta.node_fields;
    const stride = fields.length, name = fields.indexOf("name"), size = fields.indexOf("self_size");
    let transportCopies = 0, transportSelfBytes = 0;
    for (let at = 0; at < snapshot.nodes.length; at += stride) {
      const value: string = snapshot.strings[snapshot.nodes[at + name]];
      // Whole HAST JSON is a transient worker payload. The parsed tree and DOM
      // must stay; their serialized twin is not needed after rendering.
      if (value.startsWith('{"type":"root","children":') && value.includes("MEMORY_PARAGRAPH_")) {
        transportCopies++; transportSelfBytes += snapshot.nodes[at + size];
      }
    }
    const result = { paragraphs: 5000, sourceCharacters: text.length, transportCopies, transportSelfBytes, heap, scope: "Chromium renderer after inspector GC; excludes worker and native processes" };
    console.log("Markdown retained memory", JSON.stringify(result));
    await info.attach("markdown-retained-memory", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(transportCopies).toBe(0);
  } finally { await inspector.detach(); await page.close(); await server.close(); }
});
