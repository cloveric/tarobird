import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { createServer } from "./fixtures/vite.js";
import { showDisconnectedBots, selectConversation } from "./fixtures/mobile.js";
import { settleReadingLayout, readingAnchor, anchorTop } from "./fixtures/reading-position.js";

test.use({ serviceWorkers: "block", viewport: { width: 430, height: 932 }, hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1" });

for (const step of [95, 450, 1000]) test(`decoded image history keeps geometry while another conversation streams: ${step}px`, async ({ page }, info) => {
  test.setTimeout(90000);
  const root = await mkdtemp(path.join(os.tmpdir(), "image-scroll-"));
  const vite = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await vite.listen(); const url = vite.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','图片助手','fixture')");
    const reader = await hub.store.createConversation("owner", ["bot"], "图片历史", "reader");
    const background = await hub.store.createConversation("owner", ["bot"], "后台输出", "background");
    const images = [];
    for (const [w, h] of [[600, 800], [540, 960], [960, 540], [800, 600]]) {
      const bytes = Buffer.from(await page.evaluate(([width, height]) => {
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d")!; context.fillStyle = "#7657b8"; context.fillRect(0, 0, width, height);
        context.fillStyle = "white"; context.font = "40px sans-serif"; context.fillText(`${width} × ${height}`, 20, 70);
        return canvas.toDataURL().split(",")[1];
      }, [w!, h!] as [number, number]), "base64");
      const id = await hub.attachments.importForBot("bot", { conversationId: reader.id, name: `${w}x${h}.png`, mime: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      images.push({ type: "image" as const, attachmentId: id, text: `${w} × ${h}` });
    }
    for (let i = 0; i < 35; i++) await hub.store.publishBotMessage("bot", { conversationId: reader.id, blocks: [
      { type: "text", text: `图片交付 ${i} · 四种尺寸` }, { type: "card", elements: images },
    ] });
    const running = await hub.store.publishBotMessage("bot", { conversationId: background.id, blocks: [{ type: "text", text: "后台开始" }], status: "streaming" });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await selectConversation(page, reader.title);
    const scroller = page.locator(".message-scroll");
    await expect(scroller.locator("img").first()).toBeVisible(); await settleReadingLayout(scroller);
    const last = scroller.locator(".message.bot").last();
    for (const image of await last.locator(".attachment-image img").all()) await image.scrollIntoViewIfNeeded();
    await expect.poll(() => last.locator(".attachment-image img").evaluateAll(images => images.length === 4 && images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await page.waitForTimeout(500); await settleReadingLayout(scroller);
    await scroller.evaluate(node => {
      const event = new Event("touchstart", { bubbles: true }); Object.defineProperty(event, "touches", { value: [{ clientY: 200 }] }); node.dispatchEvent(event);
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
      const probe = { samples: [] as unknown[], previous: new Map<string, { top: number; scroll: number; height: number; visible: boolean }>(), stop: false, disconnect: () => {} };
      Object.assign(window, { imageScrollProbe: probe });
      const measure = () => {
        const view = node.getBoundingClientRect(), current = new Map<string, { top: number; scroll: number; height: number; visible: boolean }>();
        for (const row of node.querySelectorAll<HTMLElement>("[data-message-id]")) {
          for (const [index, target] of [row, ...row.querySelectorAll<HTMLElement>("figcaption")].entries()) {
            const rect = target.getBoundingClientRect(), id = row.dataset.messageId! + ":" + index, prior = probe.previous.get(id);
            const visible = rect.top >= view.top && rect.top < view.bottom;
            if (prior?.visible && visible) probe.samples.push({ id, top: rect.top, scroll: node.scrollTop, delta: rect.top - prior.top + node.scrollTop - prior.scroll, height: rect.height, heightDelta: rect.height - prior.height, at: performance.now() });
            current.set(id, { top: rect.top, height: rect.height, scroll: node.scrollTop, visible });
          }
        }
        probe.previous = current;
      };
      const sample = () => { measure(); if (!probe.stop) requestAnimationFrame(sample); }; requestAnimationFrame(sample);
      const observer = new ResizeObserver(() => requestAnimationFrame(measure));
      const observe = () => { for (const row of node.querySelectorAll("[data-message-id]")) observer.observe(row); };
      const mutations = new MutationObserver(observe); mutations.observe(node, { childList: true, subtree: true }); observe();
      probe.disconnect = () => { observer.disconnect(); mutations.disconnect(); };
    });
    for (let i = 0; i < Math.ceil(5000 / step); i++) {
      await scroller.evaluate((node, delta) => { node.scrollTop -= delta; }, step);
      if (i % 3 === 0) await hub.store.publishBotMessage("bot", { id: running.id, conversationId: background.id, blocks: [{ type: "text", text: `后台反馈 ${i}` }], status: "streaming" });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => { const p = (window as any).imageScrollProbe; p.stop = true; p.disconnect(); return { samples: p.samples }; });
    await writeFile(info.outputPath("samples.json"), JSON.stringify(result));
    await info.attach("image-scroll-samples", { body: JSON.stringify(result), contentType: "application/json" });
    const deltas = result.samples.map((s: any) => Math.abs(s.delta));
    expect(deltas.length).toBeGreaterThan(10);
    await page.screenshot({ path: info.outputPath("image-history.png") });
    expect(Math.max(...deltas)).toBeLessThan(2);
    const anchor = await readingAnchor(scroller);
    await scroller.evaluate(node => {
      const event = new Event("touchend", { bubbles: true });
      Object.defineProperty(event, "touches", { value: [] }); node.dispatchEvent(event);
    });
    await expect.poll(() => scroller.locator(".virtual-messages").evaluate(node => node.style.transform)).toBe("");
    expect(Math.abs(await anchorTop(scroller, anchor.id) - anchor.top)).toBeLessThan(2);
    await hub.store.publishBotMessage("bot", { id: running.id, conversationId: background.id, blocks: [{ type: "text", text: "后台输出完成" }], status: "complete" });
    await selectConversation(page, background.title);
    await expect(page.locator(".message-scroll")).toContainText("后台输出完成");
  } finally { await page.close(); await hub.close(); await vite.close(); await rm(root, { recursive: true, force: true }); }
});
