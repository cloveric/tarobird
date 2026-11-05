import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

test("profile real Markdown Worker revisions at the long-document boundary", async ({ page }, info) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
    const report = await page.evaluate(async () => {
      const { default: Parser } = await import("/src/markdown.worker.ts?worker");
      const parser: Worker = new Parser(); let sequence = 0;
      const render = (text: string) => new Promise<{ ms: number; chunks: number; characters: number }>((resolve, reject) => {
        const id = ++sequence, started = performance.now();
        const fail = () => { parser.removeEventListener("message", receive); reject(new Error("Parser worker failed")); };
        const receive = (event: MessageEvent) => {
          if (event.data.id !== id) return;
          parser.removeEventListener("message", receive); parser.removeEventListener("error", fail);
          if (event.data.error) { reject(new Error("Parser rejected text")); return; }
          const chunks: (string | { serialized: string })[] = event.data.chunks;
          resolve({ ms: performance.now() - started, chunks: chunks.length, characters: chunks.reduce((sum, chunk) => sum + (typeof chunk === "string" ? chunk : chunk.serialized).length, 0) });
        };
        parser.addEventListener("message", receive); parser.addEventListener("error", fail);
        parser.postMessage({ id, text });
      });
      try {
        await render("Warm up parser and imports.");
        const text = Array.from({ length: 5000 }, (_, i) => `第 ${i} 行：完整流式内容。\n\n`).join("");
        const samples = [];
        for (let revision = 0; revision < 12; revision++) samples.push(await render(text + `\n\nFinal revision ${revision}.`));
        const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
        return { sourceCharacters: text.length, paragraphs: 5001, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)], samples, scope: "Warm actual browser Worker request to response, excluding queue wait and final DOM rendering" };
      } finally { parser.terminate(); }
    });
    expect(report.samples).toHaveLength(12);
    expect(report.samples.every(sample => sample.chunks > 1 && sample.characters > report.sourceCharacters)).toBe(true);
    console.log("Markdown worker profile", JSON.stringify(report));
    await info.attach("markdown-worker-profile", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  } finally { await page.close(); await server.close(); }
});
