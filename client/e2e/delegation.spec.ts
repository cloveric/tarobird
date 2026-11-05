import { preparePairing } from "./fixtures/pairing-invite.js";
import { waitForClientOnline, selectConversation, openWorkspacePage, enterMobileChat, mobileHome, openMobileHome, isPhone } from "./fixtures/mobile.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { messageAction } from './fixtures/message-actions.js';
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { startGatewayBus } from "../../src/gateway/bus.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { updateInstanceConfig } from "../../src/state/instance-config.js";
import { blocksText } from "../../src/client-protocol/index.js";
import type { CoreBridgeLike } from "../../src/core/types.js";

async function select(page: Page, name: string) { await selectConversation(page, name); }

test("friendly collaboration routes duplicate names by ID and preserves exact source across both devices and offline reload", async ({ page, browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-delegation-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: "unused" } });
  let stopped = false;
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), phone = await phoneContext.newPage();
  const main = `client_${"c".repeat(24)}`, alpha = `client_${"a".repeat(24)}`, beta = `client_${"b".repeat(24)}`, ids = [main, alpha, beta];
  const channels: Awaited<ReturnType<typeof attachGateway>>[] = [], buses: NonNullable<Awaited<ReturnType<typeof startGatewayBus>>>[] = [];
  const calls: { id: string; text: string; type: string }[] = [], errors: string[] = [];
  for (const device of [page, phone]) { device.on("pageerror", (error) => errors.push(error.message)); await device.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { copied: string }).copied = value; } } }); }); }
  try {
    for (const id of ids) {
      const secret = randomBytes(32).toString("base64url"), stateDir = path.join(root, "bots", id); await mkdir(stateDir, { recursive: true });
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id === main ? "协调助手" : "研究助手", hashSecret(secret)]);
      await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", bus: { peers: ids.filter((peer) => peer !== id), secret: randomBytes(32).toString("hex"), parallel: [alpha, beta], chain: [alpha, beta], verifier: beta } }));
      const bridge: CoreBridgeLike = { handleAuthorizedMessage: async (input) => {
        calls.push({ id, text: input.text, type: input.chatType });
        return { text: input.text.includes("ASK_SOURCE") ? `ANSWER ${id}\n\n\`\`\`txt\n${id}\n\`\`\`\n\n[link ${id}](https://example.org/${id})\n\nInline \`${id}\`\n\nPath /tmp/${id}/a.json` : `RESULT_${id.slice(-6)}` };
      } };
      buses.push((await startGatewayBus(stateDir, id, bridge))!);
      channels.push(await attachGateway({ stateDir, botId: id, secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge }));
    }
    const conversation = await hub.store.createConversation("owner", ids, "协作操作验收", "source", { type: "group" });
    const targetConversation = await hub.store.createConversation("owner", [main], "资料归档", "target");
    async function pair(device: Page) {
      await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(device); await select(device, conversation.title);
    }
    await pair(page); await pair(phone);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("ASK_SOURCE exact routing");
    await page.getByRole("button", { name: "发起 Bot 协作", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "发起 Bot 协作", exact: true });
    await expect(dialog.getByRole("textbox", { name: "协作任务" })).toHaveValue("ASK_SOURCE exact routing");
    await dialog.getByRole("combobox", { name: "发起 Bot", exact: true }).selectOption({ label: "研究助手 · aaaaaa" });
    await dialog.getByRole("combobox", { name: "协作对象", exact: true }).selectOption({ label: "研究助手 · bbbbbb" });
    await expect(dialog.getByRole("combobox", { name: "协作对象", exact: true })).toHaveValue(beta);
    await dialog.getByRole("textbox", { name: "协作任务" }).fill("\u200b\u200d");
    await expect(dialog.getByRole("button", { name: "发送协作任务", exact: true })).toBeDisabled();
    await expect(dialog).not.toContainText("任务文字过长");
    await dialog.getByRole("textbox", { name: "协作任务" }).fill("ASK_SOURCE exact routing");
    await page.screenshot({ path: info.outputPath("delegation-picker-desktop.png") });
    await dialog.getByRole("button", { name: "发送协作任务", exact: true }).click();
    await expect.poll(() => calls.filter((call) => call.type === "bus").length).toBe(1); expect(calls[0]).toMatchObject({ id: beta, text: "ASK_SOURCE exact routing" });
    const snapshot = () => hub.store.snapshot("owner", conversation.id);
    await expect.poll(async () => (await snapshot()).messages.some((m) => blocksText(m.blocks).includes("ANSWER"))).toBe(true);
    const original = (await snapshot()).messages.find((m) => m.authorType === "user")!, answer = (await snapshot()).messages.find((m) => blocksText(m.blocks).includes("ANSWER"))!;
    expect(blocksText(original.blocks)).toBe(`/ask ${beta} ASK_SOURCE exact routing`); expect(original.mentions).toEqual([alpha]); expect(answer.authorId).toBe(alpha);
    for (const device of [page, phone]) {
      const article = device.locator(`[data-message-id="${answer.id}"]`);
      await expect(article.locator(".bot-reference").first()).toHaveText("研究助手 · bbbbbb");
      await expect(article.locator(".bot-reference").first()).toHaveAttribute("data-bot-id", beta);
      await expect(article.locator("pre code")).toHaveText(beta);
      await expect(article.getByRole("link", { name: `link ${beta}` })).toHaveAttribute("href", `https://example.org/${beta}`);
      await expect(article.locator("p code")).toHaveText(beta); await expect(article.locator(".markdown")).toContainText(`/tmp/${beta}/a.json`);
      // Ordinary Bot replies keep their source association internally without
      // repeating a quote; the original command still has a readable Bot name.
      await expect(article.locator(".message-reference")).toHaveCount(0);
      await expect(device.locator(`[data-message-id="${original.id}"] .bot-reference`)).toHaveText("研究助手 · bbbbbb");
      await messageAction(device, article, '复制消息');
      expect(await device.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(blocksText(answer.blocks));
      const actions = device.getByRole('dialog', {name:'消息操作', exact:true});
      if (await actions.isVisible()) await device.keyboard.press('Escape');
    }
    // A forwarded command remains source material and does not trigger a second
    // peer delegation; the picker only shows destinations with Bot avatars.
    await page.locator(`[data-message-id="${original.id}"]`).getByRole("button", { name: "转发消息", exact: true }).click();
    const forward = page.getByRole("dialog", { name: "转发消息", exact: true }); await expect(forward.locator(".forward-preview")).toHaveCount(0);
    await forward.getByRole("button", { name: targetConversation.title, exact: true }).click(); await forward.getByRole("button", { name: "确认转发", exact: true }).click();
    await expect(page.getByRole("heading", { name: targetConversation.title, exact: true })).toBeVisible();
    expect(calls.filter((call) => call.type === "bus")).toHaveLength(1);
    await expect.poll(async () => (await hub.store.snapshot("owner", targetConversation.id)).messages.length).toBe(1);
    expect(blocksText((await hub.store.snapshot("owner", targetConversation.id)).messages[0]!.blocks)).toBe(blocksText(original.blocks));
    await select(page, conversation.title);
    for (const mode of ["fan", "chain", "verify"] as const) {
      await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await phone.getByRole("dialog", { name: "聊天操作", exact: true }).getByRole("button", { name: "发起 Bot 协作", exact: true }).click(); dialog = phone.getByRole("dialog", { name: "发起 Bot 协作", exact: true });
      await dialog.getByRole("combobox", { name: "发起 Bot", exact: true }).selectOption(main); await dialog.getByRole("combobox", { name: "协作方式", exact: true }).selectOption(mode);
      await expect(dialog.locator(".delegation-route")).toContainText("研究助手 · bbbbbb");
      await dialog.getByRole("textbox", { name: "协作任务" }).fill(`TASK_${mode}`);
      if (mode === "chain") await phone.screenshot({ path: info.outputPath("delegation-picker-phone.png") });
      await dialog.getByRole("button", { name: "发送协作任务", exact: true }).click();
      await expect.poll(async () => (await snapshot()).messages.some((m) => m.authorType === "user" && blocksText(m.blocks) === `/${mode} --bots=${mode === "verify" ? beta : `${alpha},${beta}`} -- TASK_${mode}`)).toBe(true);
      await expect.poll(async () => (await hub.store.pendingForBot(main)).length).toBe(0);
    }
    await openMobileHome(phone);
    // Sent collaboration commands differ from their saved prompt. Successful
    // sends must clear that prompt too, so list previews never show a ghost draft.
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
    for (const device of [page, phone]) {
      const list = isPhone(device) ? mobileHome(device).locator('.mh-row') : device.locator('.conversation-row');
      await expect(list.filter({ has: device.getByText(conversation.title, { exact: true }) })).not.toContainText('草稿：');
    }
    for (const device of [page, phone]) await expect((isPhone(device) ? mobileHome(device).locator(".mh-row") : device.locator(".conversation-row")).filter({ has: device.getByText(conversation.title, { exact: true }) })).toContainText("研究助手 · bbbbbb");
    await enterMobileChat(phone, conversation.title);
    expect(calls.filter((call) => call.type === "bus")).toHaveLength(6);
    await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await phone.getByRole("dialog", { name: "聊天操作", exact: true }).getByRole("button", { name: "发起 Bot 协作", exact: true }).click(); dialog = phone.getByRole("dialog", { name: "发起 Bot 协作", exact: true });
    // Use an independent context without a service worker for the legacy Hub
    // response fixture; WebKit cannot route requests owned by a service worker.
    const legacyContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    try {
      const legacyPage = await legacyContext.newPage();
      await legacyPage.route(`**/api/bots/${main}/collaboration`, async route => {
        const response = await route.fetch(), body = await response.json(); delete body.taskSelection;
        await route.fulfill({ response, json: body });
      });
      await pair(legacyPage);
      await legacyPage.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await legacyPage.getByRole("dialog", { name: "聊天操作", exact: true }).getByRole("button", { name: "发起 Bot 协作", exact: true }).click();
      const legacyDialog = legacyPage.getByRole("dialog", { name: "发起 Bot 协作", exact: true });
      await legacyDialog.getByRole("combobox", { name: "发起 Bot", exact: true }).selectOption(main);
      await legacyDialog.getByRole("combobox", { name: "协作方式", exact: true }).selectOption("chain");
      await expect(legacyDialog).toContainText("当前使用已保存的流程");
      await legacyDialog.getByRole("textbox", { name: "协作任务" }).fill("UNSENT_LEGACY_PLAN");
      await updateInstanceConfig(path.join(root, "bots", main), config => { (config.bus as { chain: string[] }).chain = [beta, alpha]; });
      await legacyDialog.getByRole("button", { name: "发送协作任务", exact: true }).click();
      await expect(legacyDialog.getByRole("alert")).toContainText("协作状态已变化");
      await expect(legacyDialog.getByRole("list", { name: "执行顺序" }).locator("li").first()).toContainText("研究助手 · bbbbbb");
      expect(calls.filter(call => call.type === "bus")).toHaveLength(6);
    } finally { await legacyContext.close(); }
    await dialog.getByRole("combobox", { name: "协作对象", exact: true }).selectOption(beta);
    await dialog.getByRole("textbox", { name: "协作任务" }).fill("UNSENT_DRAFT");
    await updateInstanceConfig(path.join(root, "bots", beta), (config) => { (config.bus as { peers: string[] }).peers = [alpha]; });
    // A permission change after the picker opened must be caught by the final
    // preflight, without enqueueing a task or losing the user's text.
    await dialog.getByRole("button", { name: "发送协作任务", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("协作状态已变化");
    await expect(dialog.getByRole("textbox", { name: "协作任务" })).toHaveValue("UNSENT_DRAFT");
    expect(calls.filter((call) => call.type === "bus")).toHaveLength(6);
    await dialog.getByRole("button", { name: "刷新协作状态", exact: true }).click(); await expect(dialog.getByRole("button", { name: "发送协作任务", exact: true })).toBeDisabled();
    await expect(dialog).toContainText("尚未双向授权"); await expect(dialog.getByRole("combobox", { name: "协作对象", exact: true })).toHaveValue(beta);
    await updateInstanceConfig(path.join(root, "bots", beta), (config) => { (config.bus as { peers: string[] }).peers = [main, alpha]; });
    await updateInstanceConfig(path.join(root, "bots", main), (config) => { (config.bus as { peers: string[] }).peers = [alpha]; });
    await dialog.getByRole("button", { name: "刷新协作状态", exact: true }).click(); await expect(dialog.getByRole("button", { name: "发送协作任务", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("combobox", { name: "协作对象", exact: true }).locator(`option[value="${beta}"]`)).toHaveCount(1);
    await updateInstanceConfig(path.join(root, "bots", main), (config) => { (config.bus as { peers: string[] }).peers = [alpha, beta]; });
    await dialog.getByRole("button", { name: "编辑 协调助手 的协作设置", exact: true }).click();
    await expect(phone.getByRole("heading", { name: "协调助手 · 协作设置", exact: true })).toBeVisible();
    await phone.getByRole("button", { name: "返回协作任务", exact: true }).first().click(); await expect(phone.getByRole("textbox", { name: "协作任务" })).toHaveValue("UNSENT_DRAFT"); await phone.getByRole("button", { name: "关闭协作操作", exact: true }).click(); await expect(phone.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("UNSENT_DRAFT");
    expect(calls.filter((call) => call.type === "bus")).toHaveLength(6);
    // The phone's cached directory survives an offline restart without asserting
    // that its Bots are still online. It is removed with this Hub's local identity.
    await phone.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => phone.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const databaseName = await singleHostCacheName(phone);
    await expect.poll(() => phone.evaluate((databaseName) => new Promise<boolean>((resolve, reject) => { const open = indexedDB.open(databaseName); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, request = db.transaction("settings").objectStore("settings").get("botNames"); request.onsuccess = () => { resolve(typeof request.result === "string" && JSON.parse(request.result).length === 3); db.close(); }; }; }), databaseName)).toBe(true);
    // Stop the actual Hub: WebKit's synthetic offline flag can fail navigation
    // internally instead of exercising the cached shell (see startup.spec.ts).
    for (const channel of channels.splice(0)) await channel.disconnect();
    for (const bus of buses.splice(0)) await bus.stop();
    await hub.close(); stopped = true;
    await phone.reload({ waitUntil: "domcontentloaded" });
    await expect(mobileHome(phone).locator(".mh-row").filter({has:phone.getByText(conversation.title,{exact:true})})).toContainText("草稿：UNSENT_DRAFT");
    await enterMobileChat(phone, conversation.title);
    await expect(phone.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('UNSENT_DRAFT');
    await expect(phone.locator(".offline-banner")).toBeVisible();
    await expect(phone.locator(".bot-reference").filter({ hasText: "研究助手 · bbbbbb" }).first()).toBeVisible();
    await phone.screenshot({ path: info.outputPath("delegation-phone-offline.png") });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await openWorkspacePage(phone, "设备与网络"); await phone.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: "此设备的连接", exact: true }).click();
    const hostManager = phone.getByRole("dialog", { name: "此设备的连接", exact: true });
    const hostName = await hostManager.locator(".host-manager-row").getAttribute("aria-label");
    await hostManager.getByRole("button", { name: "从此设备移除", exact: true }).click();
    const removal = phone.getByRole("dialog", { name: `从此设备移除「${hostName}」？`, exact: true });
    await removal.getByRole("checkbox").check(); await removal.getByRole("button", { name: "确认移除", exact: true }).click();
    await expect(hostManager.locator(".host-manager-row")).toHaveCount(0); await phone.keyboard.press("Escape");
    await expect(phone.getByRole("button", { name: "配对此设备", exact: true })).toBeVisible();
    expect(await phone.evaluate(async (databaseName) => {
      if (!(await indexedDB.databases()).some((db) => db.name === databaseName)) return null;
      const db = await new Promise<IDBDatabase>((resolve,reject) => { const r=indexedDB.open(databaseName); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
      try { return await new Promise((resolve,reject) => { const r=db.transaction("settings").objectStore("settings").get("botNames"); r.onsuccess=()=>resolve(r.result ?? null); r.onerror=()=>reject(r.error); }); } finally { db.close(); }
    }, databaseName)).toBeNull();
    expect(errors).toEqual([]);
  } finally { await phoneContext.close(); await page.close(); for (const channel of channels) await channel.disconnect(); for (const bus of buses) await bus.stop(); if (!stopped) await hub.close(); await rm(root, { recursive: true, force: true }); }
});
