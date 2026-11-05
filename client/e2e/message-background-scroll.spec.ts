import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { showDisconnectedBots, selectConversation, openMobileHome } from "./fixtures/mobile.js";
import { settleReadingLayout, readingAnchor, anchorTop } from "./fixtures/reading-position.js";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block", viewport: { width: 430, height: 932 }, hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1" });

for (const scenario of ["measuring", "settled", "touchend", "touchcancel", "hide", "error", "height-idle", "height-touch"] as const) test(`background conversation output preserves reading position: ${scenario}`, async ({ page }, info) => {
  const settled = scenario === "settled" || scenario === "error", touching = scenario.startsWith("touch") || scenario === "hide" || scenario === "height-touch";
  const root = await mkdtemp(path.join(os.tmpdir(), "background-scroll-"));
  const vite = await createServer({ plugins: [{ name: "scroll-render-observation", enforce: "pre", transform(code, id) {
    if (id.endsWith("/src/App.tsx")) return code.replace("const visible = pane?.visible", "if ((window as any).scrollProbe) (window as any).scrollProbe.workspace++; const visible = pane?.visible");
    if (id.endsWith("/src/RunPresentation.tsx")) return code.replace("const requestStop = useContext", "if ((window as any).scrollProbe) (window as any).scrollProbe.runs++; const requestStop = useContext");
    if (id.endsWith("/src/Content.tsx")) return code.replace("const groupedBlocks = new Set<number>();", "if ((window as any).scrollProbe) (window as any).scrollProbe.contents++; const groupedBlocks = new Set<number>();");
  } }], server: { port: 0, host: "127.0.0.1" } });
  await vite.listen(); const url = vite.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','阅读助手','fixture')");
    const reader = await hub.store.createConversation("owner", ["bot"], "正在阅读的历史", "reader");
    const background = await hub.store.createConversation("owner", ["bot"], "后台输出的对话", "background");
    for (let i = 0; i < 65; i++) {
      const text = `历史 ${i}\n\n# 保持阅读位置\n\n${"这段聊天记录保持不变。".repeat(20)}`;
      const original = await hub.store.publishBotMessage("bot", { conversationId: reader.id, blocks: !settled ? [{ type: "text", text }] : [{ type: "card", elements: [{ type: "markdown", text }], extra: { nativeRun: {
        version: 1, id: `history_${i}`, revision: 1, phase: "done", startedAt: Date.now(), updatedAt: Date.now(), count: 0, completed: 0, failed: 0, truncated: false,
      } } }] });
      if (scenario === "settled") await hub.store.sendMessage("owner", { conversationId: reader.id, clientMsgId: `quote_${i}`, text: `引用回复 ${i}`, attachments: [], replyTo: original.id });
    }
    const running = await hub.store.publishBotMessage("bot", { conversationId: background.id, blocks: [{ type: "text", text: "后台开始" }], status: "streaming" });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await selectConversation(page, reader.title);
    const scroller = page.locator(".message-scroll");
    await expect(scroller.locator("[data-message-id]").first()).toBeVisible(); await settleReadingLayout(scroller);
    if (touching) await scroller.evaluate(node => { const event = new Event("touchstart", { bubbles: true }); Object.defineProperty(event, "touches", { value: [{ clientY: 200 }] }); node.dispatchEvent(event); });
    await scroller.evaluate(node => { node.dispatchEvent(new WheelEvent("wheel", { deltaY: -1000, bubbles: true })); node.scrollTop -= 1000; });
    await settleReadingLayout(scroller);
    if (settled || scenario.startsWith("height")) { await page.waitForTimeout(450); await settleReadingLayout(scroller); }
    const anchor = await readingAnchor(scroller);
    const viewport = await scroller.boundingBox();
    if (touching) await expect.poll(() => scroller.locator(".virtual-messages").evaluate(node => node.style.transform)).not.toBe("");
    await scroller.evaluate(node => {
      const probe = { workspace: 0, runs: 0, contents: 0, writes: [] as unknown[], mutations: 0 };
      Object.assign(window, { scrollProbe: probe });
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
      Object.defineProperty(node, "scrollTop", { get() { return descriptor.get!.call(this); }, set(value) { probe.writes.push({ kind: "scrollTop", value }); descriptor.set!.call(this, value); }, configurable: true });
      const original = node.scrollTo.bind(node);
      node.scrollTo = ((...args: unknown[]) => { probe.writes.push({ kind: "scrollTo", args, stack: new Error().stack }); Reflect.apply(original, node, args); }) as typeof node.scrollTo;
      new MutationObserver(records => { probe.mutations += records.length; }).observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    if (scenario.startsWith("height")) {
      const samples = await scroller.evaluate(async node => {
        const view = node.getBoundingClientRect(), rows = [...node.querySelectorAll<HTMLElement>("[data-message-id]")];
        const anchor = rows.find(row => row.getBoundingClientRect().top >= view.top)!;
        const above = rows.filter(row => row.getBoundingClientRect().bottom < view.top).at(-1)!;
        const top = anchor.getBoundingClientRect().top, deviations: number[] = [];
        // Sample after the virtualizer's ResizeObserver measurement rAF, as
        // well as at frame start: a start-only sampler misses one-frame jumps.
        const observer = new ResizeObserver(() => requestAnimationFrame(() => deviations.push(anchor.getBoundingClientRect().top - top)));
        rows.forEach(row => observer.observe(row));
        await new Promise<void>(resolve => requestAnimationFrame(() => {
          const padding = document.createElement("div"); padding.style.height = "300px";
          above.querySelector(".message-body")!.appendChild(padding); resolve();
        }));
        for (let frame = 0; frame < 35; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => { deviations.push(anchor.getBoundingClientRect().top - top); resolve(); }));
        observer.disconnect(); return deviations;
      });
      expect(Math.max(...samples.map(Math.abs))).toBeLessThan(2);
    }
    for (let i = 0; i < 16; i++) {
      await hub.store.publishBotMessage("bot", { id: running.id, conversationId: background.id, blocks: [{ type: "text", text: `后台反馈 ${i}\n\n${"持续输出。".repeat(i + 1)}` }], status: "streaming" });
      await page.waitForTimeout(100);
    }
    if (scenario === "error") {
      await hub.store.appendBotEvent("bot", background.id, "turn.state", { actionId: "background-failure", result: { ok: false } });
      await expect(page.locator(".error-banner")).toBeVisible();
      expect(await scroller.boundingBox()).toEqual(viewport);
      expect(Math.abs((await anchorTop(scroller, anchor.id)) - anchor.top)).toBeLessThan(2);
      await page.getByRole("button", { name: "关闭提示", exact: true }).click();
      await expect(page.locator(".error-banner")).toHaveCount(0);
    }
    await settleReadingLayout(scroller);
    const observed = await page.evaluate(() => (window as any).scrollProbe);
    await info.attach("background-scroll-observation", { body: JSON.stringify({ ...observed, anchorDelta: (await anchorTop(scroller, anchor.id)) - anchor.top }), contentType: "application/json" });
    expect(Math.abs((await anchorTop(scroller, anchor.id)) - anchor.top)).toBeLessThan(2);
    if (scenario !== "error") expect(observed.runs).toBe(0);
    expect(observed.contents).toBe(0);
    if (scenario === "settled") expect(observed.workspace).toBeLessThanOrEqual(40);
    if (settled || touching) expect(observed.writes).toEqual([]);
    if (touching) {
      if (scenario === "hide") {
        await openMobileHome(page);
        await selectConversation(page, reader.title);
      } else await scroller.evaluate((node, eventName) => { const event = new Event(eventName, { bubbles: true }); Object.defineProperty(event, "touches", { value: [] }); node.dispatchEvent(event); }, scenario === "height-touch" ? "touchend" : scenario);
      await expect.poll(() => scroller.locator(".virtual-messages").evaluate(node => node.style.transform)).toBe("");
      expect(Math.abs((await anchorTop(scroller, anchor.id)) - anchor.top)).toBeLessThan(2);
    }
    await selectConversation(page, background.title);
    await expect(page.locator(".message-scroll")).toContainText("后台反馈 15");
  } finally { await page.close(); await hub.close(); await vite.close(); await rm(root, { recursive: true, force: true }); }
});
