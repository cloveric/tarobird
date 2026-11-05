import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { holdMessage } from "./fixtures/message-actions.js";

test("phone multi-select and desktop delete sync personal history, preserve drafts, and never resurrect after replay", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "message-delete-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const phone = await phoneContext.newPage(), desktop = await desktopContext.newPage(), errors: string[] = [];
  for (const page of [phone, desktop]) page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "删除验收", "chat");
    const other = await hub.store.createConversation("owner", ["bot"], "另一个对话", "other");
    const messages = [];
    for (const text of ["保留这条消息", "删除第一条", "删除第二条"]) messages.push(await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text }] }));
    const pair = async (page: Page) => {
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page); await selectConversation(page, chat.title);
    };
    await pair(phone); await pair(desktop);
    const row = (page: Page, index: number) => page.locator(`article[data-message-id="${messages[index]!.id}"]`);
    const composer = phone.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("打到一半的草稿");
    await holdMessage(phone, row(phone, 1));
    await phone.getByRole("dialog", { name: "消息操作", exact: true }).getByRole("button", { name: "多选消息", exact: true }).click();
    const bar = phone.getByRole("region", { name: "多选消息", exact: true });
    await expect(bar).toContainText("已选择 1 条"); await expect(composer).toBeHidden();
    await phone.evaluate(() => window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
    await expect(bar).toHaveCount(0); await expect(composer).toHaveValue("打到一半的草稿");
    await holdMessage(phone, row(phone, 1));
    await phone.getByRole("dialog", { name: "消息操作", exact: true }).getByRole("button", { name: "多选消息", exact: true }).click();
    await row(phone, 2).tap(); await expect(bar).toContainText("已选择 2 条");
    await phone.screenshot({ animations: "disabled", path: info.outputPath("phone-multi-select.png") });
    await bar.getByRole("button", { name: "删除（2）", exact: true }).click();
    const confirmation = phone.getByRole("dialog", { name: "删除 2 条消息？", exact: true });
    await expect(confirmation).toContainText("其他成员的记录不受影响");
    await expect(confirmation).toContainText("删除记录不会取消排队任务");
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(bar).toContainText("已选择 2 条"); await expect(row(phone, 1)).toBeVisible();
    // A failed request retains both selected messages and the draft.
    let fail = true;
    await phone.route("**/api/conversations/*/messages", async route => { if (route.request().method() === "DELETE" && fail) { fail = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }); } else await route.continue(); });
    await bar.getByRole("button", { name: "删除（2）", exact: true }).click();
    await confirmation.getByRole("button", { name: "删除", exact: true }).click();
    await expect(confirmation.getByRole("alert")).toContainText("删除未确认");
    await expect(row(phone, 1)).toBeVisible();
    await confirmation.getByRole("button", { name: "删除", exact: true }).click();
    await expect(confirmation).toHaveCount(0); await expect(bar).toHaveCount(0);
    await expect(composer).toHaveValue("打到一半的草稿");
    await expect(phone.locator(".message-scroll")).toBeFocused();
    for (const page of [phone, desktop]) { await expect(row(page, 1)).toHaveCount(0); await expect(row(page, 2)).toHaveCount(0); await expect(row(page, 0)).toBeVisible(); }
    await hub.store.publishBotMessage("bot", { id: messages[2]!.id, conversationId: chat.id, blocks: [{ type: "text", text: "后续更新也不能复活" }] });
    await desktop.reload(); await waitForClientOnline(desktop); await selectConversation(desktop, chat.title);
    await expect(row(desktop, 2)).toHaveCount(0); await expect(row(desktop, 0)).toBeVisible();
    // Desktop keyboard menu, a cancelled selection, and a later single delete.
    await row(desktop, 0).focus(); await desktop.keyboard.press("Shift+F10");
    await desktop.getByRole("menuitem", { name: "多选消息", exact: true }).click();
    await expect(desktop.getByRole("region", { name: "多选消息" })).toContainText("已选择 1 条");
    await selectConversation(desktop, other.title); await expect(desktop.getByRole("region", { name: "多选消息" })).toHaveCount(0);
    await selectConversation(desktop, chat.title);
    await row(desktop, 0).click({ button: "right" }); await desktop.getByRole("menuitem", { name: "删除消息", exact: true }).click();
    const single = desktop.getByRole("dialog", { name: "删除 1 条消息？", exact: true });
    await expect(single).toBeVisible();
    await desktop.screenshot({ animations: "disabled", path: info.outputPath("desktop-delete-confirm.png") });
    await single.getByRole("button", { name: "删除", exact: true }).click();
    await expect(row(phone, 0)).toHaveCount(0); await expect(row(desktop, 0)).toHaveCount(0);
    await expect(desktop.locator(".message-scroll")).toBeFocused();
    await expect(composer).toHaveValue("打到一半的草稿");
    expect((await hub.store.messageForBot("bot", messages[0]!.id)).status).toBe("complete");
    expect(errors).toEqual([]);
  } finally { await phoneContext.close(); await desktopContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("deletion clears sidebar and quote metadata atomically while preserving draft text and files", async ({ page }) => {
  const { createServer } = await import("./fixtures/vite.js");
  const server = await createServer({ server: { port: 0, host: "127.0.0.1", strictPort: false } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const cache = (window as any).streamCache as import("../src/storage.js").ClientCache;
      const identity = { deviceId: "device", name: "Fixture", publicKey: "key", routes: [] };
      await cache.saveIdentity(identity);
      const first: any = { id: "first", conversationId: "chat", authorId: "bot", authorType: "bot", createdAt: 1, status: "complete", version: 1, blocks: [{ type: "text", text: "first" }] };
      const second = { ...first, id: "second", createdAt: 2, blocks: [{ type: "text", text: "second" }] };
      const event = (seq: number, message: any) => cache.apply({ v: 1, type: "event", conversationId: "chat", seq, at: seq, kind: "message.updated", payload: message }, "owner");
      await event(1, first); await event(2, second);
      await cache.saveDraft("chat", "keep my typing");
      const draft = { files: [new File(["keep attachment"], "draft.txt")], reply: second, previewStyle: "card" as const };
      const revision = await cache.saveConversationDraft("chat", draft, identity);
      await event(3, { ...first, version: 2, blocks: [{ type: "text", text: "first updated later" }] });
      await event(4, { ...second, version: 2, blocks: [], status: "deleted" });
      const afterSecond = (await cache.activity()).chat;
      // A stale draft writer cannot put the removed quote back.
      await cache.saveConversationDraft("chat", draft, identity, revision);
      const rich = await cache.conversationDraft("chat", identity);
      await event(5, { ...first, version: 3, blocks: [], status: "deleted" });
      return { afterSecond, empty: (await cache.activity()).chat, text: await cache.draft("chat"), quote: rich.draft.reply, file: await rich.draft.files[0]!.text(), hidden: [...await cache.deletedMessageIds()] };
    });
    expect(result.afterSecond).toMatchObject({ preview: "first updated later", lastContentSeq: 3, unread: { first: 1 } });
    expect(result.empty).toMatchObject({ preview: "", at: 0, unread: {}, attention: {} });
    expect(result.text).toBe("keep my typing"); expect(result.file).toBe("keep attachment"); expect(result.quote).toBeUndefined(); expect(result.hidden.sort()).toEqual(["first", "second"]);
  } finally { await server.close(); }
});

test("clearing old records recomputes the preview only when its source is removed", async ({ page }) => {
  const { createServer } = await import("./fixtures/vite.js");
  const server = await createServer({ server: { port: 0, host: "127.0.0.1", strictPort: false } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const result = await page.evaluate(async () => {
      const cache = (window as any).streamCache as import("../src/storage.js").ClientCache;
      const messages = Array.from({ length: 120 }, (_, n) => ({ id: `clear_${n}`, conversationId: "clear", authorId: "bot", authorType: "bot" as const, createdAt: n + 1, status: "complete" as const, version: 1, blocks: [{ type: "text" as const, text: `Record ${n}` }] }));
      let seq = 0;
      const apply = (message: any) => cache.apply({ v: 1, type: "event", conversationId: "clear", seq: ++seq, at: seq, kind: "message.updated", payload: message }, "owner");
      for (const message of messages) await apply(message);
      await apply({ ...messages[0], version: 2, blocks: [{ type: "text", text: "An old reply edited most recently" }] });
      const getAll = IDBIndex.prototype.getAll; let conversationReads = 0;
      IDBIndex.prototype.getAll = function(...args: any[]) {
        if (this.objectStore.name === "messages" && this.name === "conversation") conversationReads++;
        return getAll.apply(this, args as any);
      };
      try {
        const previews: string[] = [];
        for (let i = 0; i < messages.length; i++) {
          await apply({ ...messages[i], version: 3, status: "deleted", blocks: [] });
          if (i === 0 || i === 60 || i === 119) previews.push((await cache.activity()).clear!.preview);
        }
        return { conversationReads, previews, activity: (await cache.activity()).clear };
      } finally { IDBIndex.prototype.getAll = getAll; }
    });
    expect(result.previews).toEqual(["Record 119", "Record 119", ""]);
    expect(result.activity).toMatchObject({ preview: "", unread: {}, attention: {}, lastContentSeq: 0 });
    expect(result.conversationReads).toBe(2);
  } finally { await server.close(); }
});

test("a legacy sidebar without content sequence cannot retain the deleted text", async ({ page }) => {
  const { createServer } = await import("./fixtures/vite.js");
  const server = await createServer({ server: { port: 0, host: "127.0.0.1", strictPort: false } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html"); await page.waitForFunction(() => "streamCache" in window);
    const preview = await page.evaluate(async () => {
      const cache = (window as any).streamCache;
      const message = { id: "legacy", conversationId: "chat", authorId: "bot", authorType: "bot", createdAt: 1, status: "complete", version: 1, blocks: [{ type: "text", text: "Must not remain" }] };
      await cache.apply({ v: 1, type: "event", conversationId: "chat", seq: 1, at: 1, kind: "message.updated", payload: message }, "owner");
      const db = await cache.db, activity = await db.get("activity", "chat"); delete activity.lastContentSeq; await db.put("activity", activity, "chat");
      await cache.apply({ v: 1, type: "event", conversationId: "chat", seq: 2, at: 2, kind: "message.updated", payload: { ...message, version: 2, status: "deleted", blocks: [] } }, "owner");
      return (await cache.activity()).chat.preview;
    });
    expect(preview).toBe("");
  } finally { await server.close(); }
});
