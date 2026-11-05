import { pairFixtureHost } from "./fixtures/pair-registered-host.js";
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { HubServer } from "../../src/hub/server.js";
test.use({ serviceWorkers: "block" });
test("phone passive images bound real downloads, cancel on exit and retain shared visible readers", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "attachment-stability-"));
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const release: (() => void)[] = []; let hold = true;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Images','fixture')");
    const conversation = await hub.store.createConversation("owner", ["bot"], "Images", "images");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const bytes = Buffer.concat([png, Buffer.from(String(i))]);
      ids.push(await hub.attachments.importForBot("bot", { conversationId: conversation.id, name: `image-${i}.png`, mime: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes));
    }
    await hub.store.publishBotMessage("bot", { conversationId: conversation.id, blocks: ids.map(attachmentId => ({ type: "image", attachmentId })) });
    await page.goto(url + "e2e/fixtures/stability-attachments.html");
    await page.waitForFunction(() => !!(window as any).attachmentStability);
    const paired = await pairFixtureHost(page, hub, "Images");
    await hub.auth.approve(paired.code, "local-owner");
    await page.evaluate(id => (window as any).multipleHosts.start(id), paired.host.id);
    await expect.poll(() => page.evaluate(id => (window as any).multipleHosts.connections.get(id).state.status, paired.host.id)).toBe("online");
    await page.route("**/api/attachments/**", async route => {
      if (hold) await new Promise<void>(resolve => release.push(resolve));
      await route.continue().catch(() => undefined);
    });
    await page.evaluate(({ host, ids }) => { const f = (window as any).attachmentStability; f.observe(host); f.render(host, ids); }, { host: paired.host.id, ids });
    await expect.poll(() => page.evaluate(() => (window as any).attachmentStability.evidence.active)).toBe(3);
    await page.evaluate(host => (window as any).attachmentStability.render(host, []), paired.host.id);
    await expect.poll(() => page.evaluate(() => (window as any).attachmentStability.evidence.active)).toBe(0);
    const cancelled = await page.evaluate(() => ({ ...(window as any).attachmentStability.evidence }));
    expect(cancelled).toEqual({ active: 0, peak: 3, started: 3, finished: 3 });
    // Keep two consumers of one original, then remove only one. It stays alive.
    await page.evaluate(({ host, id }) => (window as any).attachmentStability.render(host, [id, id]), { host: paired.host.id, id: ids[0] });
    await expect.poll(() => page.evaluate(() => (window as any).attachmentStability.evidence.active)).toBe(1);
    await page.evaluate(({ host, id }) => (window as any).attachmentStability.render(host, [id]), { host: paired.host.id, id: ids[0] });
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as any).attachmentStability.evidence.active)).toBe(1);
    hold = false; release.splice(0).forEach(resolve => resolve());
    await expect(page.locator(".attachment-image img")).toBeVisible();
    await page.getByRole("button", { name: "Image 1", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "图片预览", exact: true });
    await expect(dialog.locator("img")).toBeVisible();
    const download = page.waitForEvent("download"); await dialog.getByRole("button", { name: "另存为", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("Image 1.png");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    // A mounted reader must not swallow a terminal connection close as though
    // the user had navigated away, even if status was already offline.
    hold = true;
    await page.evaluate(({ host, id }) => (window as any).attachmentStability.render(host, [id]), { host: paired.host.id, id: ids[2] });
    await expect.poll(() => page.evaluate(() => (window as any).attachmentStability.evidence.active)).toBe(1);
    await page.evaluate(host => {
      const connection = (window as any).multipleHosts.connections.get(host);
      Reflect.get(connection, "update").call(connection, { status: "offline" });
    }, paired.host.id);
    await page.waitForTimeout(100);
    await page.evaluate(host => (window as any).multipleHosts.connections.get(host).close(), paired.host.id);
    await expect(page.getByRole("alert")).toContainText("图片加载失败");
    await expect(page.getByRole("button", { name: "重新加载图片" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).attachmentStability.evidence.active)).toBe(0);
    await info.attach("attachment-concurrency", { body: JSON.stringify({ cancelled, final: await page.evaluate(() => (window as any).attachmentStability.evidence) }), contentType: "application/json" });
    expect(errors).toEqual([]);
  } finally { hold = false; release.splice(0).forEach(resolve => resolve()); await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
