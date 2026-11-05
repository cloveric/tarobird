import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { showDisconnectedBots, selectConversation } from "./fixtures/mobile.js";
import { settleReadingLayout, anchorTop } from "./fixtures/reading-position.js";
import { HubServer } from "../../src/hub/server.js";
import type { Block } from "../../src/client-protocol/index.js";

test.use({ serviceWorkers: "block" });

for (const profile of ["desktop", "phone", "ios-touch"] as const) test.describe(profile, () => {
  const width = profile === "desktop" ? 1360 : 390;
  if (profile === "ios-touch") test.use({ hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
  test(`delayed Markdown above the viewport preserves the visible reading anchor (${width}px)`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "message-reading-"));
  const vite = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','阅读助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "历史阅读", "reading");
    const texts = new Map<string, string>();
    const createdAt = Date.now() - 1000;
    for (let i = 0; i < 70; i++) {
      const text = `HISTORY_${i}\n\n# 一个小标题\n\n` + "历史内容。".repeat(45);
      const message = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text }] });
      // Rapid fixture inserts can share a millisecond. IndexedDB then orders
      // them by random message ID, so HISTORY_69 need not be the visible tail.
      // Match snapshot and replay chronology before asserting reading anchors.
      await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [createdAt + i, message.id]);
      await hub.store.db.run("UPDATE events SET payload_json=json_set(payload_json,'$.createdAt',?) WHERE conversation_id=? AND json_extract(payload_json,'$.id')=? AND kind LIKE 'message.%'", [createdAt + i, chat.id, message.id]);
      texts.set(message.id, text);
    }
    // Delay actual parser output, not a replacement renderer. A newly mounted
    // row above the reading position first measures its readable fallback.
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      const gate = { held: false, waiting: [] as (() => void)[], release() { this.held = false; this.waiting.splice(0).forEach(deliver => deliver()); } };
      Object.assign(window, { readingWorker: gate });
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (String(url).includes("markdown.worker")) this.addEventListener("message", event => {
            if (!gate.held) return;
            event.stopImmediatePropagation();
            gate.waiting.push(() => this.dispatchEvent(new MessageEvent("message", { data: event.data })));
          });
        }
      };
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    if (width <= 760) await selectConversation(page, "历史阅读");
    await expect(page.locator(".message-blocks").filter({ hasText: "HISTORY_69" })).toBeInViewport({ timeout: 20000 });
    const scroller = page.locator(".message-scroll");
    await settleReadingLayout(scroller);
    await page.evaluate(() => (window as any).readingWorker.held = true);
    await scroller.evaluate(node => { node.dispatchEvent(new WheelEvent("wheel", { deltaY: -1200, bubbles: true })); node.scrollTop -= 1200; });
    await expect.poll(() => page.evaluate(() => (window as any).readingWorker.waiting.length)).toBeGreaterThan(0);
    await settleReadingLayout(scroller, false);
    // A held worker result can belong to a row that virtualization has already
    // unmounted. Move past the previously parsed overscan until the tested
    // viewport actually retains a delayed row, rather than using queue length
    // as evidence about the current DOM.
    for (let step = 0; step < 4 && await scroller.locator(".markdown-pending").count() === 0; step++) {
      await scroller.evaluate(node => { node.dispatchEvent(new WheelEvent("wheel", { deltaY: -1600, bubbles: true })); node.scrollTop -= Math.max(1600, node.clientHeight * 2); });
      await settleReadingLayout(scroller, false);
    }
    // A pixel offset does not select the same rows across font/platform
    // metrics. Put an actual held row fully above the reader before testing
    // compensation; the gesture and exact anchor assertions remain unchanged.
    await scroller.evaluate(node => {
      const top = node.getBoundingClientRect().top;
      const held = [...node.querySelectorAll<HTMLElement>("[data-message-id]")].filter(row => row.querySelector(".markdown-pending"));
      if (!held.some(row => row.getBoundingClientRect().bottom < top - 2)) {
        const row = held[0];
        if (!row) throw new Error("Fixture needs a mounted delayed Markdown row");
        node.scrollTop += row.getBoundingClientRect().bottom - top + 8;
      }
    });
    await settleReadingLayout(scroller, false);
    if (profile === "ios-touch") await scroller.evaluate(node => {
      const original = node.scrollTo.bind(node); const writes: unknown[] = [];
      Object.assign(window, { readingScrollWrites: writes });
      node.scrollTo = ((...args: unknown[]) => { writes.push(args); Reflect.apply(original, node, args); }) as typeof node.scrollTo;
      const offset = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
      Object.defineProperty(node, "scrollTop", { get() { return offset.get!.call(this); }, set(value) { writes.push(value); offset.set!.call(this, value); }, configurable: true });
      const event = new Event("touchstart", { bubbles: true }); Object.defineProperty(event, "touches", { value: [{ clientY: 200 }] }); node.dispatchEvent(event);
    });
    const before = await scroller.evaluate(async node => {
      // Keep the library's backward-scroll state active as a user continues
      // reading. Release in the next frame, before its scroll-end debounce.
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true })); node.scrollTop -= 1;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const viewport = node.getBoundingClientRect();
      const rows = [...node.querySelectorAll<HTMLElement>("[data-message-id]")];
      const row = rows.find(item => item.getBoundingClientRect().bottom > viewport.top && item.getBoundingClientRect().top < viewport.bottom)!;
      const above = rows.filter(item => item.getBoundingClientRect().bottom <= viewport.top && item.querySelector(".markdown-pending"));
      if (!row || !above.length) throw new Error("Fixture needs a visible anchor and delayed Markdown above it");
      const result = { id: row.dataset.messageId!, top: row.getBoundingClientRect().top - viewport.top, scrollTop: node.scrollTop, above: above.map(item => ({ id: item.dataset.messageId, height: item.getBoundingClientRect().height })) };
      if ((window as any).readingScrollWrites) {
        const frames = { running: true, maxDelta: 0 }; Object.assign(window, { readingAnchorFrames: frames });
        const sample = () => {
          if (!frames.running) return;
          frames.maxDelta = Math.max(frames.maxDelta, Math.abs(row.getBoundingClientRect().top - node.getBoundingClientRect().top - result.top));
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }
      (window as any).readingWorker.release();
      if ((window as any).readingScrollWrites) (window as any).readingScrollWrites.length = 0;
      return result;
    });
    if (profile === "ios-touch") {
      await expect(scroller.locator(".markdown-pending")).toHaveCount(0);
      await settleReadingLayout(scroller);
      expect(await page.evaluate(() => (window as any).readingScrollWrites)).toEqual([]);
      expect(await anchorTop(scroller, before.id)).toBeCloseTo(before.top, 0);
      await scroller.evaluate(node => { const event = new Event("touchend", { bubbles: true }); Object.defineProperty(event, "touches", { value: [] }); node.dispatchEvent(event); });
      // The list origin hands its compensation back to the scroll offset after
      // settling without moving the visible anchor, including while touching.
      await expect.poll(() => page.evaluate(() => (window as any).readingScrollWrites.length)).toBeGreaterThan(0);
    }
    await settleReadingLayout(scroller);
    const after = await anchorTop(scroller, before.id);
    if (profile === "ios-touch") {
      const maxDelta = await page.evaluate(() => { const frames = (window as any).readingAnchorFrames; frames.running = false; return frames.maxDelta; });
      expect(maxDelta).toBeLessThan(2);
    }
    await info.attach("reading-anchor", { body: JSON.stringify({ before, after }, null, 2), contentType: "application/json" });
    expect(after).toBeCloseTo(before.top, 0);

    // The row spanning the top may stream more content below what the user is
    // reading. Its own growth must not drag that visible anchor downward.
    const anchorRow = scroller.locator(`[data-message-id="${before.id}"]`);
    const height = await anchorRow.evaluate(node => node.getBoundingClientRect().height);
    await hub.store.publishBotMessage("bot", { id: before.id, conversationId: chat.id, blocks: [{ type: "text", text: texts.get(before.id)! + "\n\n" + "追加到当前可见消息底部。".repeat(70) }] });
    await expect.poll(() => anchorRow.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(height);
    await settleReadingLayout(scroller);
    expect(await anchorTop(scroller, before.id)).toBeCloseTo(before.top, 0);

    // Shrinking a fully offscreen row uses the same signed compensation.
    const aboveId = await scroller.evaluate(node => {
      const top = node.getBoundingClientRect().top;
      return [...node.querySelectorAll<HTMLElement>("[data-message-id]")].filter(row => row.getBoundingClientRect().bottom <= top).at(-1)?.dataset.messageId;
    });
    expect(aboveId).toBeTruthy();
    const offset = await scroller.evaluate(node => node.scrollTop);
    await hub.store.publishBotMessage("bot", { id: aboveId!, conversationId: chat.id, blocks: [{ type: "text", text: "SHORTENED_ABOVE_ROW" }] });
    await expect(scroller.locator(`[data-message-id="${aboveId}"] .markdown`)).toHaveText("SHORTENED_ABOVE_ROW");
    await settleReadingLayout(scroller);
    expect(await anchorTop(scroller, before.id)).toBeCloseTo(before.top, 0);
    // iOS keeps the visual anchor while handing signed compensation back only
    // after the idle/frame guard, including when an offscreen row shrinks.
    await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeLessThan(offset);
    expect(await anchorTop(scroller, before.id)).toBeCloseTo(before.top, 0);
  } finally {
    await page.close(); await vite.close(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

});

for (const presentation of ["native", "legacy"] as const) test(`phone can pull away from a streaming ${presentation} run near the bottom`, async ({ page, browserName }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stream-touch-reading-"));
  const vite = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','思考助手','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["bot"], "思考时阅读", "touch-reading");
    let id: string | undefined, revision = 0;
    let text = Array.from({ length: 32 }, (_, i) => `第 ${i + 1} 段，正在检查资料和核对结果。`).join("\n\n");
    const publish = async () => {
      const block: Block = { type: "card", elements: [{ type: "markdown", text: "任务处理中…" }, { type: "markdown", text }], ...(presentation === "native" ? { extra: { nativeRun: {
        version: 1, id: "touch_reading", revision: ++revision, phase: "thinking", startedAt: Date.now(), updatedAt: Date.now(), count: 0, completed: 0, failed: 0, truncated: false,
      } } } : { title: "任务处理中…" }) };
      id = (await hub.store.publishBotMessage("bot", { ...(id ? { id } : {}), conversationId: chat.id, blocks: [block], status: "streaming" })).id;
    };
    await publish();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await selectConversation(page, chat.title);
    const scroller = page.locator(".message-scroll"), latest = page.getByRole("button", { name: "回到最新消息", exact: true });
    await expect(scroller).toContainText("第 32 段");
    await settleReadingLayout(scroller);
    await expect.poll(() => scroller.evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop)).toBeLessThan(2);
    if (presentation === "native") {
      // Portal readers belong to their own scroll surface, including keyboard
      // navigation and touch events that React bubbles through the chat tree.
      await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
      const search = page.getByRole("textbox", { name: "搜索过程记录" });
      await search.press("ArrowUp");
      await search.evaluate(node => {
        node.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -80 }));
        for (const [type, y] of [["touchstart", 200], ["touchmove", 240], ["touchend", 240]] as const) {
          const event = new Event(type, { bubbles: true }); Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientY: y }] }); node.dispatchEvent(event);
        }
      });
      await page.getByRole("button", { name: "关闭运行过程", exact: true }).click();
      await expect(latest).toHaveCount(0);
    }
    // Model the first small movement of a slow pull, still inside the old 80px
    // catch zone. Deliver streaming growth before the gesture finishes.
    await scroller.evaluate(node => {
      const touch = (type: string, y: number) => { const event = new Event(type, { bubbles: true }); Object.defineProperty(event, "touches", { value: [{ clientY: y }] }); node.dispatchEvent(event); };
      touch("touchstart", 300); touch("touchmove", 320); node.scrollTop -= 20;
    });
    await expect(latest).toBeVisible();
    await settleReadingLayout(scroller);
    const before = await scroller.evaluate(n => n.scrollTop);
    text += "\n\n" + "新的思考进展。".repeat(50); await publish();
    await expect(scroller).toContainText("新的思考进展。"); await settleReadingLayout(scroller);
    expect(await scroller.evaluate(n => n.scrollTop)).toBeCloseTo(before, 0);
    await scroller.evaluate(node => { const event = new Event("touchend", { bubbles: true }); Object.defineProperty(event, "touches", { value: [] }); node.dispatchEvent(event); });
    text += "\n\n松手后继续更新。"; await publish(); await expect(scroller).toContainText("松手后继续更新。");
    await settleReadingLayout(scroller); expect(await scroller.evaluate(n => n.scrollTop)).toBeCloseTo(before, 0);
    await page.screenshot({ path: info.outputPath(`phone-${presentation}-reading.png`) });
    await latest.click(); await settleReadingLayout(scroller);
    await expect.poll(() => scroller.evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop)).toBeLessThan(2);
    text += "\n\n回到底部后继续跟随。".repeat(8); await publish(); await expect(scroller).toContainText("回到底部后继续跟随。");
    await settleReadingLayout(scroller);
    await expect.poll(() => scroller.evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop)).toBeLessThan(2);
    if (browserName === "chromium") {
      // Also exercise a trusted swipe; synthetic events above isolate the
      // small-movement race, but do not prove that the browser can pan.
      const touch = await page.context().newCDPSession(page);
      const box = (await scroller.boundingBox())!, x = box.x + box.width / 2, y = box.y + 100;
      const bottom = await scroller.evaluate(n => n.scrollTop);
      try {
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (let i = 1; i <= 8; i++) {
          await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + i * 20 }] });
          text += `\n\n拖动时仍在输出 ${i}。`; await publish();
        }
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(() => scroller.evaluate(n => n.scrollTop)).toBeLessThan(bottom - 40);
        const older = await scroller.evaluate(n => n.scrollTop), reverseY = box.y + box.height - 100;
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: reverseY }] });
        for (let i = 1; i <= 8; i++) {
          await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: reverseY - i * 20 }] });
          text += `\n\n反向滑动时仍在输出 ${i}。`; await publish();
        }
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(() => scroller.evaluate(n => n.scrollTop)).toBeGreaterThan(older + 40);
      } finally { await touch.detach(); }
    }
    // Manually returning all the way down also opts back in (no button needed).
    await scroller.evaluate(node => {
      for (const [type, y] of [["touchstart", 320], ["touchmove", 280]] as const) {
        const event = new Event(type, { bubbles: true }); Object.defineProperty(event, "touches", { value: [{ clientY: y }] }); node.dispatchEvent(event);
      }
      node.scrollTop = node.scrollHeight;
    });
    await expect(latest).toHaveCount(0);
    await scroller.evaluate(node => { const event = new Event("touchend", { bubbles: true }); Object.defineProperty(event, "touches", { value: [] }); node.dispatchEvent(event); });
    text += "\n\n手动回到底部后继续跟随。".repeat(8); await publish();
    await expect(scroller).toContainText("手动回到底部后继续跟随。"); await settleReadingLayout(scroller);
    await expect.poll(() => scroller.evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop)).toBeLessThan(2);
  } finally { await page.close(); await vite.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
