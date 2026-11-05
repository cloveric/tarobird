import { pairFixtureHost } from "./fixtures/pair-registered-host.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { HubServer } from "../../src/hub/server.js";

test.use({ trace: "off", serviceWorkers: "block" });
for (const phone of [false, true]) test(`repeated ${phone ? "phone" : "desktop"} image readers release URLs and consumers after warmup`, async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "Inspector heap samples cover Chromium only, not native memory");
  test.setTimeout(120_000);
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "image-memory-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const inspector = await page.context().newCDPSession(page);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), urls = new Set<string>();
      URL.createObjectURL = value => { const url = create(value); urls.add(url); return url; };
      URL.revokeObjectURL = url => { urls.delete(url); revoke(url); };
      Object.assign(window, { retainedObjectURLs: urls });
    });
    await page.goto(url + "e2e/fixtures/stability-attachments.html");
    await page.waitForFunction(() => !!(window as any).attachmentStability);
    const paired = await pairFixtureHost(page, hub, "Memory fixture");
    await hub.auth.approve(paired.code, "local-owner");
    await page.evaluate(id => (window as any).multipleHosts.start(id), paired.host.id);
    await expect.poll(() => page.evaluate(id => (window as any).multipleHosts.connections.get(id).state.status, paired.host.id)).toBe("online");
    // A real cached PNG and real component/lease lifecycle; no synthetic network
    // memory claim. The cache intentionally retains this original throughout.
    const imageBytes = await page.evaluate(async host => {
      const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1200;
      const ctx = canvas.getContext("2d")!, data = ctx.createImageData(1600, 1200);
      let seed = 17;
      for (let i = 0; i < data.data.length; i += 4) { seed = (seed * 1664525 + 1013904223) >>> 0; data.data[i] = seed & 255; data.data[i + 1] = seed >>> 8 & 255; data.data[i + 2] = seed >>> 16 & 255; data.data[i + 3] = 255; }
      ctx.putImageData(data, 0, 0);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), "image/png"));
      await (window as any).multipleHosts.connections.get(host).cache.saveAttachment("memory-image", blob);
      return blob.size;
    }, paired.host.id);
    await inspector.send("HeapProfiler.enable"); await inspector.send("Performance.enable");
    const cycle = async () => {
      await page.evaluate(host => (window as any).attachmentStability.render(host, ["memory-image"]), paired.host.id);
      await expect(page.locator(".attachment-image img")).toBeVisible();
      await page.getByRole("button", { name: "Image 1", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "图片预览", exact: true });
      await expect(dialog.locator("img")).toBeVisible();
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await page.evaluate(host => (window as any).attachmentStability.render(host, []), paired.host.id);
      await expect.poll(() => page.evaluate(() => (window as any).retainedObjectURLs.size)).toBe(0);
    };
    const samples = [];
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 5; i++) await cycle();
      await inspector.send("HeapProfiler.collectGarbage");
      const heap = await inspector.send("Runtime.getHeapUsage");
      const metrics = (await inspector.send("Performance.getMetrics")).metrics;
      const readers = await page.evaluate(host => ({ urls: (window as any).retainedObjectURLs.size, leases: Reflect.get((window as any).multipleHosts.connections.get(host), "passiveAttachments").entries.size, dialogs: document.querySelectorAll("dialog").length }), paired.host.id);
      expect(readers).toEqual({ urls: 0, leases: 0, dialogs: 0 });
      samples.push({ cycles: (batch + 1) * 5, heap, readers, nodes: metrics.find(m => m.name === "Nodes")!.value, listeners: metrics.find(m => m.name === "JSEventListeners")!.value });
    }
    // Warmup includes lazy modules and React's delegated event installation.
    expect(samples[3]!.nodes).toBeLessThanOrEqual(samples[0]!.nodes + 20);
    expect(samples[3]!.listeners).toBeLessThanOrEqual(samples[0]!.listeners + 5);
    const result = { phone, imageBytes, samples, scope: "Chromium renderer after GC; excludes decoded surfaces, worker and OS memory" };
    console.log("Image lifecycle memory", JSON.stringify(result));
    await info.attach("image-lifecycle-memory", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(errors).toEqual([]);
  } finally { await inspector.detach(); await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
