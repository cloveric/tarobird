import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

for (const width of [900, 1360]) test(`desktop reply indicators and streaming cards release their action bar after mouse leave (${width})`, async ({ page, browserName }, info) => {
  const tab = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  await page.setViewportSize({ width, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "message-hover-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','GG1','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["alpha"], "悬停工具栏", "chat");
    const prompt = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "prompt", text: "请检查这份报告", attachments: [] })).message;
    const startedAt = Date.now();
    const publish = (revision: number) => hub.store.publishBotMessage("alpha", { id: "reply", conversationId: chat.id, replyTo: prompt.id, status: "streaming", blocks: [{ type: "card", elements: [{ type: "markdown", text: "运行状态" }, { type: "markdown", text: `正在检查报告，第 ${revision} 步。` }], extra: { nativeRun: { id: "run", version: 1, revision, phase: "working", startedAt, updatedAt: Date.now(), count: revision, completed: 0, failed: 0, truncated: false } } }] });
    await publish(1);
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    await page.evaluate(width => {
      document.documentElement.dataset.palette = width === 900 ? "mono" : "white-purple";
      document.documentElement.dataset.theme = width === 900 ? "dark" : "light";
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => undefined } });
    }, width);
    const user = page.locator(`[data-message-id="${prompt.id}"]`), bot = page.locator('[data-message-id="reply"]');
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    const opacity = (row: Locator) => row.locator(".message-actions").evaluate(node => getComputedStyle(node).opacity);
    const hoverSpinner = async (spinner: Locator) => {
      const box = (await spinner.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    };
    await expect(user.locator("[data-reply-state=replying]")).toHaveText("回复中");
    await expect(bot.locator(".native-run-status .spin")).toBeVisible();
    await composer.hover();
    await expect.poll(() => opacity(user)).toBe("0"); await expect.poll(() => opacity(bot)).toBe("0");
    for (let revision = 2; revision <= 4; revision++) {
      await hoverSpinner(user.locator(".reply-status-spinner")); await expect.poll(() => opacity(user)).toBe("1");
      await hoverSpinner(bot.locator(".native-run-status .spin"));
      await expect.poll(() => opacity(user)).toBe("0"); await expect.poll(() => opacity(bot)).toBe("1");
      await publish(revision);
      await composer.hover();
      await expect.poll(() => opacity(user)).toBe("0"); await expect.poll(() => opacity(bot)).toBe("0");
    }
    // A mouse click can focus the message or the run's tabIndex=-1 surface.
    // That restored pointer focus must not pin a second toolbar on screen.
    await user.locator(".message-blocks").click();
    await bot.locator(".native-run-status").hover();
    await expect.poll(() => opacity(user)).toBe("0");
    await bot.locator(".native-run-prose").click(); await composer.hover();
    await expect.poll(() => opacity(bot)).toBe("0");
    await page.screenshot({ path: info.outputPath("desktop-mouse-away.png") });

    // Clicking Copy may leave its button focused (Chromium); no forced blur,
    // row unmount or scrolling should be needed to hide the toolbar again.
    await bot.hover(); await bot.getByRole("button", { name: "复制消息", exact: true }).click();
    await composer.hover(); await expect.poll(() => opacity(bot)).toBe("0");
    // The same controls remain discoverable and operable from the keyboard.
    // Start from the control, since WebKit can remember the last descendant
    // in its sequential navigation cursor even after focusing the article.
    await bot.getByRole("button", { name: "复制消息", exact: true }).focus();
    await page.keyboard.press(tab);
    await expect(bot.getByRole("button", { name: "引用回复", exact: true })).toBeFocused();
    await expect.poll(() => opacity(bot)).toBe("1");
    // Switching back to the mouse without clicking must retire the keyboard
    // toolbar too; otherwise both the old focus and the new hover remain lit.
    await user.locator(".message-blocks").hover();
    await expect.poll(() => opacity(user)).toBe("1");
    await expect.poll(() => opacity(bot)).toBe("0");
    await composer.hover();
    await expect.poll(() => opacity(user)).toBe("0");
    await expect.poll(() => opacity(bot)).toBe("0");
    // Restore real keyboard navigation to continue the quote action.
    await bot.getByRole("button", { name: "复制消息", exact: true }).focus();
    await page.keyboard.press(tab);
    await page.keyboard.press("Enter");
    await expect(composer).toBeFocused();
    await expect(page.locator(".reply-preview")).toContainText("正在检查报告");
    await expect.poll(() => opacity(bot)).toBe("0");
    await page.getByRole("button", { name: "取消引用", exact: true }).click();
    // A process dialog restores the original trigger. Pointer-return focus
    // keeps the control usable but must not leave its outer toolbar visible.
    await bot.getByRole("button", { name: "查看运行过程", exact: true }).click();
    const process = page.getByRole("dialog"); await expect(process).toBeVisible();
    await process.getByRole("button", { name: /关闭/ }).first().click();
    await expect(process).toBeHidden(); await composer.hover();
    await expect(bot.getByRole("button", { name: "查看运行过程", exact: true })).toBeFocused();
    await expect.poll(() => opacity(bot)).toBe("0");
    await bot.hover(); await expect.poll(() => opacity(bot)).toBe("1");
    await page.screenshot({ path: info.outputPath("desktop-mouse-over.png") });
    expect(errors).toEqual([]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("image messages have one pointer toolbar through preview return, disabled actions, streaming and scroll", async ({ page }, info) => {
  await page.setViewportSize({ width: 1360, height: 1100 });
  const root = await mkdtemp(path.join(os.tmpdir(), "image-message-hover-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','图片助手','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["alpha"], "图片消息操作", "chat");
    await page.goto(hub.url);
    const bytes = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 260;
      const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#a8b9b2"; ctx.fillRect(0, 0, 800, 260);
      ctx.fillStyle = "#fff"; ctx.font = "42px sans-serif"; ctx.fillText("Message toolbar preview", 40, 140);
      return canvas.toDataURL("image/png").split(",")[1]!;
    }), "base64");
    const attachmentId = await hub.attachments.importForBot("alpha", { conversationId: chat.id, name: "image.png", mime: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) ids.push((await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `image-${i}`, text: `第 ${i} 条图片消息`, attachments: [attachmentId] })).message.id);
    const publish = (n: number) => hub.store.publishBotMessage("alpha", { id: "reply", conversationId: chat.id, status: "streaming", blocks: [{ type: "text", text: `正在检查图片，第 ${n} 步。` }] });
    await publish(1);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    const visible = () => page.locator("article.message").evaluateAll(rows => rows.filter(row => {
      const actions = row.querySelector(".message-actions"); return actions && Number(getComputedStyle(actions).opacity) > 0;
    }).map(row => row.getAttribute("data-message-id")));
    const row = (id: string) => page.locator(`[data-message-id="${id}"]`);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = theme; }, theme);
      for (const [i, id] of ids.entries()) {
        await row(id).locator(".attachment-image").hover(); await expect.poll(visible).toEqual([id]);
        await publish(i + 2); await expect(row("reply")).toContainText(`第 ${i + 2} 步`);
        await expect.poll(visible).toEqual([id]);
      }
      await row(ids[0]!).locator(".attachment-image").click();
      const viewer = page.getByRole("dialog", { name: "图片预览", exact: true }); await expect(viewer).toBeVisible();
      await viewer.getByRole("button", { name: "关闭", exact: true }).click(); await expect(viewer).toHaveCount(0);
      await row(ids[1]!).locator(".attachment-image").hover(); await expect.poll(visible).toEqual([ids[1]]);
      await page.screenshot({ path: info.outputPath(`one-image-toolbar-${theme}.png`) });
      // Disabled controls and image dialogs must not keep the previous owner.
      const disabled = row("reply").getByRole("button", { name: "转发消息", exact: true });
      await expect(disabled).toBeDisabled(); await row("reply").hover();
      const b = (await disabled.boundingBox())!; await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await expect.poll(visible).toEqual(["reply"]);
      await row(ids[2]!).locator(".attachment-image").hover(); await expect.poll(visible).toEqual([ids[2]]);
      await page.getByRole("textbox", { name: "消息", exact: true }).hover(); await expect.poll(visible).toEqual([]);
      await row(ids[0]!).hover(); await expect.poll(visible).toEqual([ids[0]]);
      await page.mouse.move(-10, -10); await expect.poll(visible).toEqual([]);
      await row(ids[0]!).hover(); await expect.poll(visible).toEqual([ids[0]]);
      await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await expect.poll(visible).toEqual([]);
      await row(ids[0]!).locator(".attachment-image").hover(); await expect.poll(visible).toEqual([ids[0]]);
      await page.locator(".message-scroll").evaluate(node => node.dispatchEvent(new Event("scroll"))); await expect.poll(visible).toEqual([]);
    }
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
