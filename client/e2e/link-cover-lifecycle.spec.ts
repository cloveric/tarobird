import { pairFixtureHost } from "./fixtures/pair-registered-host.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block" });
test("a loaded link cover survives cache eviction and disconnect, then releases on exit", async ({ page }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "link-cover-lifecycle-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: directory, origins: [new URL(url).origin] });
  try {
    await page.addInitScript(() => {
      const original = URL.revokeObjectURL.bind(URL);
      Object.assign(window, { revokedCoverURLs: [] as string[] });
      URL.revokeObjectURL = url => { (window as any).revokedCoverURLs.push(url); original(url); };
    });
    await page.goto(url + "e2e/fixtures/stability-attachments.html");
    await page.waitForFunction(() => !!(window as any).attachmentStability);
    const paired = await pairFixtureHost(page, hub, "Link reader");
    await hub.auth.approve(paired.code, "local-owner");
    await page.evaluate(id => (window as any).multipleHosts.start(id), paired.host.id);
    await expect.poll(() => page.evaluate(id => (window as any).multipleHosts.connections.get(id).state.status, paired.host.id)).toBe("online");
    await page.evaluate(async host => {
      const connection = (window as any).multipleHosts.connections.get(host);
      const canvas = document.createElement("canvas"); canvas.width = 40; canvas.height = 30;
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), "image/png"));
      await connection.cache.saveAttachment("cover", blob);
      (window as any).attachmentStability.renderLink(host, "cover");
    }, paired.host.id);
    const image = page.locator(".link-preview-cover");
    await expect(image).toBeVisible();
    const original = await image.getAttribute("src");
    await page.evaluate(async host => {
      const connection = (window as any).multipleHosts.connections.get(host);
      // Evict only this fixture's cached original, as the bounded cache does
      // under pressure. The mounted reader still owns its authenticated bytes.
      const database = await Reflect.get(connection.cache, "db");
      const transaction = database.transaction(["attachmentData", "attachmentMeta"], "readwrite");
      await transaction.objectStore("attachmentData").delete("cover");
      await transaction.objectStore("attachmentMeta").delete("cover");
      await transaction.done;
      connection.close();
    }, paired.host.id);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(image).toHaveAttribute("src", original!);
    expect(await page.evaluate(url => (window as any).revokedCoverURLs.includes(url), original)).toBe(false);
    await page.evaluate(host => (window as any).attachmentStability.render(host, []), paired.host.id);
    await expect(image).toHaveCount(0);
    await expect.poll(() => page.evaluate(url => (window as any).revokedCoverURLs.includes(url), original)).toBe(true);
  } finally { await page.close(); await server.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
