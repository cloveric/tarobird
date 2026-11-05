import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubStore } from "../../src/hub/store.js";
import { blocksText, type ClientFrame } from "../../src/client-protocol/index.js";
import type { GroupDiscussionPolicy } from "../../src/client-protocol/group-discussion.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

type Capabilities = "current" | "legacy" | "no-guard";
async function setup(page: Page, initial: Capabilities = "current", mode: GroupDiscussionPolicy["mode"] = "mentions") {
  const root = await mkdtemp(path.join(os.tmpdir(), "group-offline-mode-"));
  let hub: HubServer | undefined = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let capabilities = initial;
  const port = Number(new URL(hub.url).port), sent: ClientFrame[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/ws", socket => {
    const upstream = socket.connectToServer();
    socket.onMessage(data => { const frame = JSON.parse(String(data)); if (frame.type === "message.send") sent.push(frame); upstream.send(data); });
    upstream.onMessage(data => {
      const frame = JSON.parse(String(data));
      if (frame.type === "ready") frame.serverCapabilities = frame.serverCapabilities.filter((cap: string) => capabilities === "current" || (capabilities === "legacy" ? !cap.startsWith("groups.") : cap !== "groups.reply-guard.v1"));
      socket.send(JSON.stringify(frame));
    });
  });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手甲','fixture'),('beta','助手乙','fixture'),('gamma','助手丙','fixture')");
  const group = await hub.store.createConversation("owner", ["alpha", "beta"], "离线模式群", "group", { type: "group" });
  const unknown = await hub.store.createConversation("owner", ["alpha", "beta"], "从未打开的群", "unknown", { type: "group" });
  const direct = await hub.store.createConversation("owner", ["alpha"], "直聊不受影响", "direct");
  async function change(store: HubStore, value: GroupDiscussionPolicy["mode"], bots?: string[]) {
    const before = await store.groupSettings("owner", group.id);
    await store.updateGroup("owner", group.id, { title: group.title, expectedTitle: group.title, botIds: bots ?? before.group.botIds, expectedBotIds: before.group.botIds,
      policy: { ...before.policy, mode: value, botOrder: bots ?? before.policy.botOrder }, expectedRevision: before.revision });
  }
  if (mode !== "mentions") await change(hub.store, mode);
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, group.title);
  if (initial !== "legacy") await expect(page.getByRole("region", { name: "群聊方式与讨论状态" })).toContainText(mode === "parallel" ? "并行回复" : mode === "sequential" ? "轮流讨论" : "普通群聊");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  return {
    group, unknown, direct, input, sent, errors,
    get hub() { return hub!; },
    setCapabilities(value: Capabilities) { capabilities = value; },
    async offline(unconfirmed?: { id: string; damaged: boolean }) {
      await hub!.close(); hub = undefined;
      // Cold-start fixtures explicitly cover absent/corrupt mode metadata;
      // initial auto-selection is allowed to have fetched any group online.
      if (unconfirmed) await page.evaluate(async ({ id, damaged }) => {
        for (const info of await indexedDB.databases()) {
          const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open(info.name!); request.onsuccess = () => resolve(request.result); });
          try {
            if (!db.objectStoreNames.contains("settings")) continue;
            const tx = db.transaction("settings", "readwrite"), settings = tx.objectStore("settings"), key = `groupReply:group-reply-mode:${id}`;
            if (damaged) settings.put("{broken", key); else settings.delete(key);
            await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
          } finally { db.close(); }
        }
      }, unconfirmed);
      await page.reload({ waitUntil: "domcontentloaded" }); await selectConversation(page, group.title);
      await expect(page.locator(".offline-banner").filter({ visible: true })).toBeVisible();
    },
    async changeOffline(value: GroupDiscussionPolicy["mode"], bots?: string[]) { const store = await HubStore.open(root); try { await change(store, value, bots); } finally { await store.db.close(); } },
    async online() { hub = await HubServer.start({ stateDir: root, port, clientDir: path.resolve("dist") }); await waitForClientOnline(page); },
    async send(text: string) { await input.fill(text); await page.getByRole("button", { name: "发送消息", exact: true }).click(); },
    async close() { await page.close(); if (hub) await hub.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("cached parallel mode survives offline cold start and switching, then delivers once to the original full group", async ({ page }) => {
  const f = await setup(page, "current", "parallel");
  try {
    await f.offline();
    await selectConversation(page, f.unknown.title); await selectConversation(page, f.group.title);
    await expect(page.getByRole("button", { name: "让谁回复：全员回复", exact: true })).toBeVisible();
    await f.send("并行离线一次投递"); await expect(f.input).toHaveValue("");
    await expect(page.locator(".queued-message")).toHaveCount(1);
    await page.reload({ waitUntil: "domcontentloaded" }); await selectConversation(page, f.group.title);
    await expect(page.locator(".queued-message")).toHaveCount(1);
    await f.online(); await expect(page.locator(".queued-message")).toHaveCount(0);
    const messages = (await f.hub.store.snapshot("owner", f.group.id)).messages;
    expect(messages.map(message => blocksText(message.blocks))).toEqual(["并行离线一次投递"]);
    expect(messages[0]!.mentions).toEqual(["alpha", "beta"]);
    expect(f.sent).toHaveLength(1); expect(f.sent[0]).toHaveProperty("groupReplyGuard.mode", "parallel");
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const kind of ["mode", "members"] as const) test(`offline queued group input is retained without any delivery after ${kind} changes`, async ({ page }) => {
  const f = await setup(page);
  try {
    await f.offline(); await f.send("保留这条离线内容"); await expect(f.input).toHaveValue("");
    await expect(page.locator(".queued-message")).toHaveCount(1);
    await f.changeOffline(kind === "mode" ? "parallel" : "mentions", kind === "members" ? ["alpha", "gamma"] : undefined);
    await f.online(); await expect(page.locator(".queued-message")).toContainText("群聊设置或讨论状态已变化");
    await expect(page.locator(".queued-message")).toContainText("保留这条离线内容");
    await expect(page.locator(".error-banner")).toHaveCount(0);
    await selectConversation(page, f.direct.title); await expect(page.locator(".error-banner")).toHaveCount(0);
    await selectConversation(page, f.group.title); await expect(page.locator(".queued-message")).toContainText("保留这条离线内容");
    expect((await f.hub.store.snapshot("owner", f.group.id)).messages).toEqual([]);
    expect(await f.hub.store.db.get("SELECT COUNT(*) AS n FROM deliveries")).toEqual({ n: 0 });
    await page.locator(".queued-message").getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(() => f.sent.length).toBe(2);
    await expect(page.locator(".queued-message")).toContainText("群聊设置或讨论状态已变化");
    expect(f.sent[1]).toEqual(f.sent[0]);
    expect((await f.hub.store.snapshot("owner", f.group.id)).messages).toEqual([]);
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, f.group.title);
    await expect(page.locator(".queued-message")).toContainText("保留这条离线内容");
    // A rejected guard keeps the exact original request. Copying offers a way
    // to compose under the new mode without discarding the old request or files.
    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedFailedGroupText = text; } } }); });
    await page.locator(".queued-message").getByRole("button", { name: "复制文字", exact: true }).click();
    await expect(page.locator(".queued-message").getByRole("button", { name: "已复制", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).copiedFailedGroupText)).toBe("保留这条离线内容");
    await expect(page.locator(".queued-message")).toHaveCount(1);
    expect(f.sent).toHaveLength(2); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const damaged of [false, true]) test(`${damaged ? "damaged" : "missing"} cached and automatic offline group modes retain drafts without blocking direct chat`, async ({ page }) => {
  const f = await setup(page, "current", "sequential");
  try {
    await f.offline({ id: f.unknown.id, damaged }); await f.send("讨论保留为草稿");
    await expect(f.input).toHaveValue("讨论保留为草稿"); await expect(page.getByRole("alert").filter({ hasText: "讨论需要在线连接" })).toBeVisible();
    await selectConversation(page, f.unknown.title); await f.send("未知方式保留为草稿");
    await expect(f.input).toHaveValue("未知方式保留为草稿"); await expect(page.getByRole("alert").filter({ hasText: "离线时无法确认" })).toBeVisible();
    await expect(page.locator(".queued-message")).toHaveCount(0);
    // No group mode is required on direct chats, including an offline cache miss.
    await selectConversation(page, f.direct.title); await f.send("直聊离线正常排队");
    await expect(f.input).toHaveValue(""); await expect(page.locator(".queued-message")).toHaveCount(1);
    await selectConversation(page, f.unknown.title); await expect(f.input).toHaveValue("未知方式保留为草稿");
    await selectConversation(page, f.group.title); await expect(f.input).toHaveValue("讨论保留为草稿");
    expect(f.sent).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

for (const upgraded of [false, true]) test(`legacy ordinary groups queue offline and ${upgraded ? "retain input on an upgraded Host" : "send without the local marker to a confirmed legacy Host"}`, async ({ page }) => {
  const f = await setup(page, "legacy");
  try {
    await f.offline(); await f.send("旧主机离线保留"); await expect(f.input).toHaveValue("");
    await expect(page.locator(".queued-message")).toHaveCount(1);
    if (upgraded) f.setCapabilities("current");
    await f.online();
    if (upgraded) {
      await expect(page.locator(".queued-message")).toContainText("群聊设置或讨论状态已变化");
      expect((await f.hub.store.snapshot("owner", f.group.id)).messages).toEqual([]); expect(f.sent).toEqual([]);
    } else {
      await expect(page.locator(".queued-message")).toHaveCount(0);
      const messages = (await f.hub.store.snapshot("owner", f.group.id)).messages;
      expect(messages).toHaveLength(1); expect(messages[0]!.mentions).toEqual(["alpha"]);
      expect(f.sent).toHaveLength(1); expect(f.sent[0]).not.toHaveProperty("groupReplyGuard");
    }
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("older discussion Host keeps online sending but retains offline drafts without a revision guard", async ({ page }) => {
  const f = await setup(page, "no-guard");
  try {
    await f.send("旧讨论主机在线消息"); await expect(f.input).toHaveValue("");
    await expect.poll(async () => (await f.hub.store.snapshot("owner", f.group.id)).messages.length).toBe(1);
    expect(f.sent).toHaveLength(1); expect(f.sent[0]).not.toHaveProperty("groupReplyGuard");
    await f.offline(); await f.send("旧讨论主机离线草稿");
    await expect(f.input).toHaveValue("旧讨论主机离线草稿");
    await expect(page.getByRole("alert").filter({ hasText: "当前主机无法校验" })).toBeVisible();
    await expect(page.locator(".queued-message")).toHaveCount(0); expect(f.sent).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("a guarded queue cannot silently lose its guard when the Host is downgraded", async ({ page }) => {
  const f = await setup(page);
  try {
    await f.offline(); await f.send("不可丢失模式校验"); await expect(f.input).toHaveValue("");
    await expect(page.locator(".queued-message")).toHaveCount(1);
    f.setCapabilities("no-guard"); await f.online();
    await expect(page.locator(".queued-message")).toContainText("当前主机无法校验");
    expect((await f.hub.store.snapshot("owner", f.group.id)).messages).toEqual([]); expect(f.sent).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
