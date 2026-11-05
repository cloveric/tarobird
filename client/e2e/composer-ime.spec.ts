import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

// Replays OS event ordering through the real composer and Hub. Synthetic DOM
// events are regression coverage, not a substitute for native IME acceptance.
for (const committed of ["hello", "你好"]) test(`IME confirmation keeps ${committed} as a draft until the next Enter`, async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
  const root = await mkdtemp(path.join(os.tmpdir(), "composer-ime-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','输入测试','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "输入法回车", "ime");
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    await input.fill(committed);
    await expect(input).toBeEnabled();
    for (const modifiers of [{}, { altKey: true }, { metaKey: true }]) {
      const allowedImeDefault = await input.evaluate((element, { text, modifiers }) => {
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        const composing = element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", keyCode: 229, isComposing: true, ...modifiers }));
        // WebKit may finish composition before delivering its confirming Enter.
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
        const confirming = element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", keyCode: 229, isComposing: false, ...modifiers }));
        return { composing, confirming };
      }, { text: committed, modifiers });
      expect(allowedImeDefault).toEqual({ composing: true, confirming: true });
      await expect(input).toHaveValue(committed);
    }
    // Holding the same physical key after commit must not send either.
    await input.dispatchEvent("keydown", { key: "Enter", keyCode: 13, repeat: true });
    await expect(input).toHaveValue(committed);
    expect((await hub.store.snapshot("owner", chat.id)).messages).toHaveLength(0);
    await input.dispatchEvent("keyup", { key: "Enter", keyCode: 13 });
    await input.press("Shift+Enter");
    await input.pressSequentially("second line");
    await expect(input).toHaveValue(`${committed}\nsecond line`);
    await input.press("Enter");
    await expect.poll(async () => (await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.authorType === "user").length).toBe(1);
    const sent = (await hub.store.snapshot("owner", chat.id)).messages.find(m => m.authorType === "user")!;
    expect(sent.blocks).toContainEqual({ type: "text", text: `${committed}\nsecond line` });
    await expect(input).toHaveValue("");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const shortcut of ["Alt+Enter", "Meta+Enter"]) test(`${shortcut} inserts at the selection, supports undo and saves the draft without sending`, async ({ page }) => {
  await page.addInitScript(platform => Object.defineProperty(navigator, "platform", { get: () => platform }), shortcut === "Meta+Enter" ? "MacIntel" : "Win32");
  const root = await mkdtemp(path.join(os.tmpdir(), "composer-alt-enter-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','输入测试','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "换行快捷键", "alt-enter");
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    await input.focus();
    await expect(page.getByText(shortcut === "Meta+Enter" ? "Shift / ⌘ + Enter 换行" : "Shift / Alt + Enter 换行", { exact: true })).toBeVisible();
    await input.fill("hello world");
    // Restore a saved draft so native undo starts with the shortcut itself.
    // WebKit can otherwise group the initial typing and newline as one edit.
    await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
    await page.reload();
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    await expect(input).toHaveValue("hello world");
    await input.focus();
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 6));
    await input.press(shortcut);
    await expect(input).toHaveValue("hello\nworld");
    expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([6, 6]);
    expect((await hub.store.snapshot("owner", chat.id)).messages).toHaveLength(0);

    await input.press("ControlOrMeta+z");
    await expect(input).toHaveValue("hello world");
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 6));
    await input.press(shortcut);
    await input.pressSequentially("middle ");
    await expect(input).toHaveValue("hello\nmiddle world");

    // Exercise the existing draft persistence path, not just the DOM value.
    await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
    await page.reload();
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    await expect(input).toHaveValue("hello\nmiddle world");
    await input.focus();
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length));
    // A WebView without native insertLineBreak support still inserts and saves.
    await page.evaluate(() => { document.execCommand = () => false; });
    await input.press(shortcut);
    await input.pressSequentially("last line");
    await expect(input).toHaveValue("hello\nmiddle world\nlast line");
    expect((await hub.store.snapshot("owner", chat.id)).messages).toHaveLength(0);

    await input.press("Enter");
    await expect.poll(async () => (await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.authorType === "user").length).toBe(1);
    expect((await hub.store.snapshot("owner", chat.id)).messages.find(m => m.authorType === "user")!.blocks)
      .toContainEqual({ type: "text", text: "hello\nmiddle world\nlast line" });
    await expect(input).toHaveValue("");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
