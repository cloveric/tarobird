import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./fixtures/vite.js";
import { showDisconnectedBots, selectConversation } from "./fixtures/mobile.js";
import { settleReadingLayout } from "./fixtures/reading-position.js";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block" });
type Frame = { gap: number | null; visible: boolean; top: number; composer: number; height?: number; measuredHeight?: number };

for (const width of [1360, 390]) for (const author of ["user", "bot"] as const) test(`switching conversations shows the measured message tail without a vertical jump (${width}px, ${author})`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conversation-entry-"));
  const vite = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','阅读助手','fixture')");
    const chats = [];
    for (const tall of [false, true]) {
      const chat = await hub.store.createConversation("owner", ["bot"], tall ? "长消息" : "短消息", tall ? "tall" : "short");
      const ids: string[] = [];
      for (let i = 0; i < 18; i++) {
        const text = tall ? `条目 ${i}\n\n` + "这是一条比较长的消息。".repeat(60) : `简短消息 ${i}`;
        const message = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text }] }); ids.push(message.id);
      }
      const message = author === "bot"
        ? await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "## 最新消息位置\n\n" + "最后一条回复也需要测量高度。".repeat(50) }] })
        : (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `tail_${chat.id}`, text: "最新消息位置", attachments: [] })).message;
      ids.push(message.id);
      // Fast fixture inserts can share a millisecond and put another row after
      // the intended tail in IndexedDB. Give this reading-position scenario an
      // explicit chronology so it actually measures the latest message.
      const createdAt = Date.now() - 1000;
      for (const [index, id] of ids.entries()) {
        await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [createdAt + index, id]);
        // Cold clients replay the journal, not just the messages snapshot.
        // Both must use the same chronology or the intended tail can land in
        // the middle of the list, invalidating every tail-position assertion.
        await hub.store.db.run("UPDATE events SET payload_json=json_set(payload_json,'$.createdAt',?) WHERE conversation_id=? AND json_extract(payload_json,'$.id')=? AND kind LIKE 'message.%'", [createdAt + index, chat.id, id]);
      }
      chats.push({ ...chat, ids, tail: message.id });
    }
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await selectConversation(page, chats[0]!.title); await settleReadingLayout(page.locator(".message-scroll"));
    // The final selection reopens the same phone conversation from its inbox.
    for (const chat of [chats[1]!, chats[0]!, chats[1]!, chats[1]!]) {
      await page.evaluate(({ ids, tail }) => {
        const samples: Frame[] = [];
        let active = true;
        const measured = new WeakMap<Element, number>();
        const observer = new ResizeObserver(entries => { for (const entry of entries) measured.set(entry.target, entry.borderBoxSize[0]!.blockSize); });
        const root = document.querySelector<HTMLElement>(".message-scroll")!;
        const watchRows = () => root.querySelectorAll<HTMLElement>("[data-message-id]").forEach(row => { if (row.dataset.messageId === tail) observer.observe(row); });
        const mutations = new MutationObserver(watchRows);
        mutations.observe(root, { childList: true, subtree: true }); watchRows();
        const sample = () => setTimeout(() => {
          if (!active) return;
          const scroller = document.querySelector<HTMLElement>(".message-scroll")!;
          const box = scroller.getBoundingClientRect();
          const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")].filter(row => ids.includes(row.dataset.messageId!));
          const lastRow = rows.find(row => row.dataset.messageId === tail);
          const last = lastRow?.getBoundingClientRect();
          if (rows.length && box.height && getComputedStyle(scroller).visibility !== "hidden") samples.push({
            gap: last ? box.bottom - last.bottom : null,
            visible: !!last && last.bottom > box.top && last.top < box.bottom,
            top: box.top, composer: document.querySelector(".composer-wrap")!.getBoundingClientRect().top,
            measuredHeight: lastRow ? measured.get(lastRow) : undefined, height: last?.height,
          });
          if (active) requestAnimationFrame(sample);
        }, 0);
        Object.assign(window, { entrySamples: samples, stopEntryProbe: () => { active = false; observer.disconnect(); mutations.disconnect(); } }); requestAnimationFrame(sample);
      }, { ids: chat.ids, tail: chat.tail });
      await selectConversation(page, chat.title);
      await expect(page.locator(`[data-message-id="${chat.tail}"]`)).toBeInViewport();
      await settleReadingLayout(page.locator(".message-scroll"));
      const recorded = await page.evaluate(() => { (window as any).stopEntryProbe(); return (window as any).entrySamples as Frame[]; });
      await info.attach(`entry-${chat.title}`, { body: JSON.stringify(recorded), contentType: "application/json" });
      // A worker can update the DOM after paint but before our timer. Its new
      // height has not been displayed until ResizeObserver delivers that layout.
      // Missing/offscreen tail rows still count; never mask an actual scroll flash.
      const samples = recorded.filter(sample => sample.height === undefined || sample.measuredHeight !== undefined && Math.abs(sample.height - sample.measuredHeight) < 0.1);
      expect(samples.length).toBeGreaterThan(3);
      expect.soft(samples.filter(sample => !sample.visible), "No earlier rows should flash before the latest message").toEqual([]);
      const gaps = samples.flatMap(sample => sample.visible && sample.gap !== null ? [sample.gap] : []);
      expect.soft(Math.max(...gaps) - Math.min(...gaps), "Latest message should not jump while row heights settle").toBeLessThanOrEqual(2);
      for (const edge of ["top", "composer"] as const) {
        const positions = samples.map(sample => sample[edge]);
        expect.soft(Math.max(...positions) - Math.min(...positions), `${edge} should stay fixed during conversation entry`).toBeLessThanOrEqual(2);
      }
    }
    expect(pageErrors).toEqual([]);
  } finally { await page.close(); await vite.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
