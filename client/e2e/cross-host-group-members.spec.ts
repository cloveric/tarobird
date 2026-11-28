import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots } from "./fixtures/mobile.js";

for (const phone of [false, true]) {
  test.describe(phone ? "phone viewport" : "desktop", () => {
    test.use({ serviceWorkers: "block", ...(phone ? { viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true } : {}) });
    test("selects a cross-host member through both composer entry points and lists the full roster", async ({ page }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "group-member-picker-"));
      const hub = await HubServer.start({ stateDir: path.join(root, "group"), clientDir: path.resolve("dist") });
      const peer = await HubServer.start({ stateDir: path.join(root, "peer") });
      try {
        const groupBots = Array.from({ length: 10 }, (_, i) => i === 0 ? "shared_bot" : `local_${i}`);
        for (const id of groupBots) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id === "shared_bot" ? "同名助手" : id, "fixture"]);
        await peer.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('shared_bot','同名助手','fixture',1)");
        const profile = await peer.profile.read();
        await peer.profile.update({ name: "示例远端", revision: profile.revision });
        hub.crossHostGroups.registerPeer({ hostId: "example_peer", hostName: "示例远端", publicKey: peer.auth.publicKey, url: peer.url });
        peer.crossHostGroups.registerPeer({ hostId: "example_owner", hostName: "示例主机", publicKey: hub.auth.publicKey, url: hub.url });
        await peer.crossHostGroups.grantPeerBot(hub.auth.publicKey, "shared_bot");
        const group = await hub.store.createConversation("owner", groupBots, "成员选择示例群", "example_group", { type: "group" });
        const member = await hub.crossHostGroups.addMember("owner", group.id, { hostId: "example_peer", botId: "shared_bot" });

        await page.goto(hub.url);
        await preparePairing(page, hub);
        await page.getByRole("button", { name: "配对此设备", exact: true }).click();
        await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
        await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
        await showDisconnectedBots(page);
        await selectConversation(page, group.title);

        const composer = page.getByRole("textbox", { name: "消息", exact: true });
        const remoteLabel = /同名助手.*示例远端/;
        await composer.fill("@同名助手");
        const suggestions = page.getByRole("group", { name: "选择 Bot", exact: true });
        await expect(suggestions.getByRole("button", { name: remoteLabel })).toBeVisible({ timeout: 6000 });
        await composer.fill("@同名助手 Example ambiguous question");
        await page.getByRole("button", { name: "发送消息", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("对应多个 Bot");
        expect((await hub.crossHostGroups.getState("owner", group.id, false)).questions).toHaveLength(0);
        await composer.fill("@同名助手");
        await suggestions.getByRole("button", { name: remoteLabel }).click();
        const send = async (total: number) => {
          await page.getByRole("button", { name: "发送消息", exact: true }).click();
          await expect.poll(async () => (await hub.crossHostGroups.getState("owner", group.id, false)).questions
            .map(question => [question.memberKey, question.sessionId, question.status])).toEqual(
            Array.from({ length: total }, () => [member.memberKey, member.sessionId, "delivered"]),
          );
        };
        await expect(composer).toHaveValue(`@${member.memberKey} `);
        await composer.press("End");
        await page.keyboard.insertText("Example via mention");
        await send(1);
        const first = (await hub.store.snapshot("owner", group.id)).messages[0];
        expect(first?.blocks).toEqual([{ type: "text", text: `@${member.memberKey} Example via mention` }]);
        expect(first?.groupRecipientKeys).toEqual([member.memberKey]);

        await page.getByRole("button", { name: /^让谁回复/ }).click();
        const picker = page.getByRole(phone ? "dialog" : "menu", { name: "回复的 Bot", exact: true });
        await expect(picker.getByRole("checkbox")).toHaveCount(11);
        const remote = picker.getByRole("checkbox", { name: remoteLabel });
        if (await remote.getAttribute("aria-checked") === "true") await remote.click();
        await remote.click();
        await (phone ? picker.getByRole("button", { name: "完成", exact: true }).click() : page.keyboard.press("Escape"));
        await composer.fill("Example via reply picker");
        await send(2);
        expect(await hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)", [group.id])).toEqual([]);

        if (phone) {
          await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
          await page.getByRole("button", { name: "对话详情", exact: true }).click();
        } else {
          await page.getByRole("button", { name: "查看对话详情", exact: true }).click();
        }
        await expect(page.getByText("11 个 Bot", { exact: true })).toBeVisible();
        const roster = page.getByRole("list", { name: "群组成员", exact: true });
        await expect(roster.getByRole("listitem")).toHaveCount(11);
        await expect(roster.getByText("示例远端", { exact: true })).toBeVisible();

        await page.getByRole("button", { name: "群组设置", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "群组设置", exact: true });
        await settings.locator(".group-session-row").filter({ hasText: "示例远端" }).getByRole("button", { name: "移出", exact: true }).click();
        await expect(settings.getByText("已移出成员并回收访问权限，原会话历史保留。")).toBeVisible();
        await settings.getByRole("button", { name: "关闭群组设置", exact: true }).click();
        await expect(roster.getByRole("listitem")).toHaveCount(10);
        await expect(page.getByText("10 个 Bot", { exact: true })).toBeVisible();
      } finally {
        await page.close();
        await hub.close();
        await peer.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
