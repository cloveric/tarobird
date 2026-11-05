import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { HubServer } from "../../src/hub/server.js";
import { createServer } from "./fixtures/vite.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
for (const view of ["search", "files"] as const) for (const mode of ["duplicate", "offline"] as const)
  test(`open ${view} results prune shared-cache deletions after ${mode}`, async ({ page, context }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deletion-results-"));
    const vite = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await vite.listen();
    const url = vite.resolvedUrls!.local[0]!;
    const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
    const peer = await context.newPage();
    let online = true, closePeer = () => {}, release = () => {}, held = false, syncs = 0, receivedTombstones = 0;
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Deletion fixture','fixture')");
      const chat = await hub.store.createConversation("owner", ["bot"], "Shared deletion", "chat");
      const bytes = Buffer.from("shared deletion file"), name = "shared-witness.txt";
      const attachmentId = await hub.attachments.importForBot("bot", { conversationId: chat.id, name, mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      const message = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "SHARED_DELETION_WITNESS" }, { type: "file", attachmentId, name, mime: "text/plain", size: bytes.length }] });
      await peer.routeWebSocket(hub.url.replace(/^http/, "ws") + "/ws", socket => {
        if (!online) { socket.close({ code: 1001 }); return; }
        const remote = socket.connectToServer();
        closePeer = () => { socket.close({ code: 1001 }); remote.close({ code: 1001 }); };
        remote.onMessage(data => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "sync.complete") syncs++;
          if (frame.type === "event" && frame.payload?.status === "deleted") receivedTombstones++;
          if (mode === "duplicate" && frame.type === "event" && frame.payload?.status === "deleted") {
            held = true; release = () => socket.send(data);
          } else socket.send(data);
        });
      });
      await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
      await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
      await peer.goto(url); await waitForClientOnline(peer); await selectConversation(peer, chat.title);
      await peer.evaluate(async () => {
        const { ClientCache } = await import("/src/storage.ts"), apply = ClientCache.prototype.apply;
        (window as any).__duplicateDeletions = 0;
        ClientCache.prototype.apply = async function(...args: Parameters<typeof apply>) {
          const result = await apply.apply(this, args);
          if ((args[0].payload as any)?.status === "deleted" && result === undefined) (window as any).__duplicateDeletions++;
          return result;
        };
      });
      const rows = view === "search" ? peer.locator(".search-results > button") : peer.locator(".conversation-file-row");
      if (view === "search") {
        const input = peer.getByRole("textbox", { name: "搜索历史消息", exact: true });
        await input.fill("SHARED_DELETION_WITNESS"); await input.press("Enter");
      } else {
        await peer.getByRole("button", { name: "更多聊天操作", exact: true }).click();
        await peer.getByRole("button", { name: "文件", exact: true }).click();
      }
      await expect(rows).toHaveCount(1);
      const previousSyncs = syncs;
      if (mode === "offline") { online = false; closePeer(); await expect(peer.locator(".offline-banner")).toBeVisible(); }
      await hub.store.deleteMessages("owner", chat.id, { messageIds: [message.id] });
      // Writer's rendered removal proves its shared IndexedDB transaction committed.
      await expect(page.locator(`[data-message-id="${message.id}"]`)).toHaveCount(0);
      if (mode === "duplicate") {
        await expect.poll(() => held).toBe(true); await expect(rows).toHaveCount(1); release();
        await expect.poll(() => peer.evaluate(() => (window as any).__duplicateDeletions)).toBe(1);
      } else { online = true; await expect.poll(() => syncs, { timeout: 15_000 }).toBeGreaterThan(previousSyncs); }
      await expect(rows).toHaveCount(0);
      if (mode === "offline") expect(receivedTombstones).toBe(0);
    } finally { await peer.close(); await page.close(); await vite.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
