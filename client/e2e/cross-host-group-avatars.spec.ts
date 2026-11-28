import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubAvatars } from "../../src/hub/avatars.js";
import { BOT_AVATAR_DEFAULT_PREFIX } from "../../src/hub/bot-avatar-default.js";
import { avatarDataUrl, avatarFixture } from "../../tests/helpers/avatar-fixture.js";
import { defaultBotAvatar } from "../src/bot-avatar-catalog.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { mobileHome, openMobileHome, openWorkspacePage, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

async function pairMember(page: Page, hub: HubServer, name: string) {
  await page.getByLabel("主机名称", { exact: true }).fill(name);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner", "member");
  await expect(page.getByLabel("配对码", { exact: true })).toBeHidden({ timeout: 15_000 });
  await waitForClientOnline(page);
}

async function expectPortrait(avatar: Locator, presets: (string | null)[]) {
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("data-composite", String(presets.length));
  const cells = avatar.locator(".group-avatar-members > .profile-avatar");
  await expect.poll(() => cells.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-preset")))).toEqual(presets);
  await expect.poll(() => cells.locator("img").evaluateAll((nodes, count) =>
    nodes.length === count && nodes.every(node => (node as HTMLImageElement).naturalWidth > 0), presets.length,
  )).toBe(true);
}

test("members see the mixed-host portrait on desktop and phone without a directory lookup", async ({ browser }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "cross-host-portraits-"));
  const hubs: HubServer[] = [];
  const desktopContext = await browser.newContext();
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const home = await HubServer.start({ stateDir: path.join(root, "home"), clientDir: path.resolve("dist") });
    hubs.push(home);
    const peerA = await HubServer.start({ stateDir: path.join(root, "peer_a") });
    hubs.push(peerA);
    const peerB = await HubServer.start({ stateDir: path.join(root, "peer_b"), origins: [home.url] });
    hubs.push(peerB);
    for (const [hub, name, preset] of [[home, "研究助手", "taro"], [peerA, "写作助手", "orange-cat"], [peerB, "设计助手", "pink-bunny"]] as const) {
      // All three hosts deliberately use the same Bot ID.
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('assistant',?,'fixture')", [name]);
      await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [BOT_AVATAR_DEFAULT_PREFIX + "assistant", preset]);
    }
    for (const hub of [home, peerB]) await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('member','示例成员','member')");
    await home.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('planner','计划助手','fixture')");
    await home.store.db.run("INSERT INTO bot_grants VALUES('member','assistant'),('member','planner')");
    await home.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [BOT_AVATAR_DEFAULT_PREFIX + "planner", "sky-cloud"]);
    const group = await home.store.createConversation("owner", ["assistant"], "跨主机协作群", "mixed_group", { type: "group" });
    await home.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [group.id]);
    const topic = await home.store.createConversation("owner", [], "方案讨论", "mixed_topic", { parentId: group.id });
    const localGroup = await home.store.createConversation("owner", ["assistant", "planner"], "本机协作群", "local_group", { type: "group" });
    await home.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [localGroup.id]);
    await home.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "mixed_sample", text: "三位助手一起准备示例方案。", attachments: [] });
    await home.store.sendMessage("owner", { conversationId: localGroup.id, clientMsgId: "local_sample", text: "整理本机项目的任务清单。", attachments: [] });

    const customTarget = { kind: "bot", id: "assistant" } as const;
    await new HubAvatars(peerB.store).set("owner", customTarget, { expectedRevision: 0, dataUrl: avatarDataUrl(avatarFixture(256, 256, 190)) });
    for (const [peer, hostId] of [[peerA, "peer_a"], [peerB, "peer_b"]] as const) {
      home.crossHostGroups.registerPeer({ hostId, hostName: hostId, publicKey: peer.auth.publicKey, url: peer.url });
      peer.crossHostGroups.registerPeer({ hostId: "home", hostName: "示例主机", publicKey: home.auth.publicKey, url: home.url });
      await peer.crossHostGroups.grantPeerBot(home.auth.publicKey, "assistant");
    }
    await home.crossHostGroups.addMember("owner", group.id, { hostId: "peer_a", botId: "assistant" });
    const second = await home.crossHostGroups.addMember("owner", group.id, { hostId: "peer_b", botId: "assistant" });
    expect(second.avatarSnapshot).toBe("profile:bot:assistant:v1");

    const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
    const directoryRequests: string[] = [];
    const imageRequests: string[] = [];
    for (const page of [desktop, phone]) {
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/members") && url.searchParams.get("directory") !== "0") directoryRequests.push(url.pathname);
        if (url.pathname.startsWith("/api/avatars/bot/assistant/")) imageRequests.push(url.origin);
      });
      await page.goto(home.url);
      await pairMember(page, home, "示例主机");
    }
    const row = (page: Page, id: string) => (page === phone ? mobileHome(page).locator(".mh-row") : page.locator(".sidebar .conversation-row"))
      .locator(`[data-avatar="group:${id}"]`).filter({ visible: true });
    const fallback = defaultBotAvatar(second.memberKey).id;
    for (const page of [desktop, phone]) {
      await expectPortrait(row(page, group.id), ["taro", "orange-cat", fallback]);
      await expectPortrait(row(page, localGroup.id), ["taro", "sky-cloud"]);
    }
    expect(directoryRequests).toEqual([]);
    expect(imageRequests).toEqual([]);

    await home.crossHostGroups.removeMember("owner", group.id, second.memberKey);
    for (const page of [desktop, phone]) await expectPortrait(row(page, group.id), ["taro", "orange-cat"]);
    await home.crossHostGroups.addMember("owner", group.id, { hostId: "peer_b", botId: "assistant" });
    for (const page of [desktop, phone]) await expectPortrait(row(page, group.id), ["taro", "orange-cat", fallback]);

    // The image stays private when the device is paired to the peer without access to this Bot.
    await clickAppAction(desktop, "连接另一台主机");
    await pairMember(desktop, peerB, "示例远端");
    await desktop.locator(".host-workspace:not([hidden]) .sidebar .conversation-row").filter({ hasText: group.title }).click();
    await expect(desktop.getByRole("heading", { name: group.title, exact: true, level: 1 })).toBeVisible();
    await expectPortrait(row(desktop, group.id), ["taro", "orange-cat", fallback]);
    expect(imageRequests).toEqual([]);

    await peerB.store.db.run("INSERT INTO bot_grants VALUES('member','assistant')");
    await desktop.reload();
    await openWorkspacePage(phone, "设备与网络");
    await phone.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: /^此设备连接另一台主机/ }).click();
    await pairMember(phone, peerB, "示例远端");
    await mobileHome(phone).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^消息/ }).click();
    for (const page of [desktop, phone]) {
      await expectPortrait(row(page, group.id), ["taro", "orange-cat", null]);
      const image = row(page, group.id).locator('[data-avatar="remote:peer_b:assistant"] img');
      await expect(image).toHaveAttribute("src", /^blob:/);
      // Sample the displayed image to catch coincident Bot IDs resolving to the wrong Host.
      expect(await image.evaluate(node => {
        const context = new OffscreenCanvas(1, 1).getContext("2d")!;
        context.drawImage(node as HTMLImageElement, 0, 0);
        return context.getImageData(0, 0, 1, 1).data[0];
      })).toBe(190);
    }
    expect(imageRequests).toEqual([peerB.url, peerB.url]);
    expect(directoryRequests).toEqual([]);
    await desktop.screenshot({ path: info.outputPath("cross-host-group-desktop.png"), animations: "disabled" });
    await phone.screenshot({ path: info.outputPath("cross-host-group-phone.png"), animations: "disabled" });

    await selectConversation(phone, topic.title, group.title);
    await phone.getByRole("button", { name: "查看对话详情", exact: true }).click();
    await expectPortrait(phone.locator(".details-identity").locator(`[data-avatar="group:${group.id}"]`), ["taro", "orange-cat", null]);
    await openMobileHome(phone);
    await expect.poll(() => phone.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await home.close();
    await peerB.close();
    await phone.reload({ waitUntil: "domcontentloaded" });
    await expectPortrait(row(phone, group.id), ["taro", "orange-cat", null]);
  } finally {
    await desktopContext.close();
    await phoneContext.close();
    for (const hub of hubs.reverse()) await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
