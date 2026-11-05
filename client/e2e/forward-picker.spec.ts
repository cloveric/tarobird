import { preparePairing } from "./fixtures/pairing-invite.js";
import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubAvatars } from "../../src/hub/avatars.js";
import { avatarFixture } from "../../tests/helpers/avatar-fixture.js";
import { messageAction } from "./fixtures/message-actions.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

for (const width of [1360, 390, 320]) test(`forward picker shows destination avatars and preserves the latest source (${width}px)`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forward-picker-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 844 } }), page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture'),('beta','写作助手','fixture')");
    const source = await hub.store.createConversation("owner", ["alpha"], "项目进展", "source");
    const target = await hub.store.createConversation("owner", ["beta"], "整理周报", "target");
    const group = await hub.store.createConversation("owner", ["alpha", "beta"], "产品讨论", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "移动端体验", "topic", { parentId: group.id });
    const avatars = new HubAvatars(hub.store);
    for (const avatar of [{ kind: "bot" as const, id: "beta" }, { kind: "group" as const, id: group.id }]) {
      await avatars.set("owner", avatar, { expectedRevision: 0, dataUrl: `data:image/png;base64,${avatarFixture(256, 256, 120).toString("base64")}` });
    }
    const message = await hub.store.publishBotMessage("alpha", { conversationId: source.id, blocks: [{ type: "text", text: "不在选择页面展示的长篇消息".repeat(100) }] });
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, source.title);
    await messageAction(page, page.locator(`[data-message-id="${message.id}"]`), "转发消息");
    const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
    await expect(dialog.locator(".rich-message-preview, .forward-preview, .runtime-host-label")).toHaveCount(0);
    await expect(dialog).not.toContainText("不在选择页面展示的长篇消息");
    await expect(dialog.getByRole("button", { name: source.title, exact: true }).locator('[data-avatar="bot:alpha"]')).toHaveAttribute("data-preset");
    for (const [name, key] of [[target.title, "bot:beta"], [group.title, `group:${group.id}`], [`${group.title} / ${topic.title}`, `group:${group.id}`]]) {
      const avatar = dialog.getByRole("button", { name, exact: true }).locator(`[data-avatar="${key}"] img`);
      await expect(avatar).toBeVisible();
      await expect.poll(() => avatar.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(256);
    }
    // The last destination remains fully painted even after reaching the end.
    const targets = dialog.locator('.forward-targets');
    await targets.evaluate(node => { node.scrollTop = node.scrollHeight; });
    expect.soft(await targets.evaluate(node => getComputedStyle(node).maskImage)).toBe('none');
    const confirm = dialog.getByRole("button", { name: "确认转发", exact: true });
    await expect(confirm).toBeDisabled();
    await expect.poll(() => dialog.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`forward-picker-${width}.png`), animations: "disabled" });
    const search = dialog.getByRole("textbox", { name: "搜索转发目标", exact: true });
    await search.fill("写作助手");
    await expect(dialog.getByRole("button", { name: source.title, exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: target.title, exact: true }).click();
    await expect(confirm).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`forward-selected-${width}.png`), animations: "disabled" });
    await expect(confirm).toBeInViewport({ ratio: 1 });
    const layout = await dialog.evaluate(node => {
      const confirm = node.querySelector('button[type="submit"]')!.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const avatar = node.querySelector('.forward-target .profile-avatar')!.getBoundingClientRect();
      return { fits: node.scrollWidth <= node.clientWidth, confirmVisible: confirm.bottom <= Math.min(box.bottom, window.innerHeight) && confirm.top >= Math.max(box.top, 0), avatarWidth: avatar.width };
    });
    expect(layout).toEqual({ fits: true, confirmVisible: true, avatarWidth: 40 });
    // The invisible source still follows lifecycle updates; forwarding does not
    // accidentally send the stale message passed when the sheet first opened.
    await hub.store.publishBotMessage("alpha", { id: message.id, conversationId: source.id, blocks: [{ type: "text", text: "修订后的完整内容" }] });
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await hub.store.snapshot("owner", target.id)).messages.length).toBe(1);
    const forwarded = (await hub.store.snapshot("owner", target.id)).messages[0]!;
    expect(forwarded.blocks).toEqual([{ type: "text", text: "修订后的完整内容" }]);
    expect(forwarded.forwardedFrom?.messageId).toBe(message.id);
    expect(forwarded.mentions).toEqual(["beta"]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
