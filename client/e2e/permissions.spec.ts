import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation } from "./fixtures/mobile.js";
import { waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}
async function select(page: Page, title: string, parentTitle?: string) { await selectConversation(page, title, parentTitle); }
test("Bot permissions preserve engine semantics across devices, reject stale writes and enforce owner access", async ({ browser }, info) => {
  const previousAgy = process.env.ANTIGRAVITY_EXECUTABLE;
  process.env.ANTIGRAVITY_EXECUTABLE = path.resolve("../tests/fixtures/agy-models.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "client-effort-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const gateways: GatewayChannel[] = [], errors: string[] = []; let engineCalls = 0, authorization = "";
  for (const page of [desktop, phone]) page.on("pageerror", (error) => errors.push(error.message));
  desktop.on("request", (request) => { if (request.url().endsWith("/permissions")) authorization = request.headers().authorization ?? authorization; });
  try {
    for (const [id, name, engine, model] of [
      ["alpha", "研究助手", "codex", "gpt-5.5"],
      ["beta", "写作助手", "kimi", "kimi-code/k3"],
      ["gamma", "执行助手", "antigravity", "gemini-3.7-flash-high"],
      ["delta", "写作审核", "claude", "claude-opus-5-5"],
    ] as const) {
      const stateDir = path.join(root, id), secret = randomBytes(32).toString("base64url"); await mkdir(stateDir);
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, model, effort: "high", locale: "zh", workspacePath: "/preserved/workspace" }));
      await writeFile(path.join(stateDir, "session.json"), JSON.stringify({ chats: [] }));
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, name, hashSecret(secret)]);
      gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: id, engine, model, effort: "high", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { engineCalls++; return { text: "unused" }; } } }));
    }
    await hub.store.createConversation("owner", ["alpha"], "研究一", "study1");
    await hub.store.createConversation("owner", ["alpha"], "研究二", "study2");
    await hub.store.createConversation("owner", ["alpha", "beta", "gamma", "delta"], "项目讨论", "group1", { type: "group" });
    await hub.store.createConversation("owner", ["gamma"], "执行任务", "execution1");
    for (const page of [desktop, phone]) { await pair(page, hub); await select(page, page === desktop ? "研究一" : "研究二"); await page.getByRole("button", { name: "查看对话详情", exact: true }).click(); await page.getByRole("button", { name: "Bot 设置", exact: true }).click(); }
    const trigger = (page: Page) => page.getByRole("button", { name: "调整 Bot 权限", exact: true });
    const level = (page: Page) => page.getByRole("combobox", { name: "权限与批准", exact: true });
    const save = (page: Page) => page.getByRole("button", { name: "保存到此 Bot", exact: true });
    const close = (page: Page) => page.getByRole("button", { name: "关闭权限设置", exact: true }).click();
    await trigger(phone).click(); await expect(level(phone)).toHaveValue("bypass");
    await trigger(desktop).click(); await expect(level(desktop)).toHaveValue("bypass");
    await level(desktop).selectOption("normal"); await save(desktop).click();
    await expect(desktop.getByRole("status")).toContainText("已保存为 普通审批");
    await level(phone).selectOption("full-auto"); await save(phone).click();
    await expect(phone.getByRole("alert")).toContainText("其他设备或本机已修改设置");
    await phone.getByRole("button", { name: "重新读取", exact: true }).click(); await expect(level(phone)).toHaveValue("normal");
    await phone.screenshot({ path: info.outputPath("permissions-phone.png") });
    await close(desktop); await desktop.getByRole("button", { name: "关闭 Bot 设置", exact: true }).click(); await select(desktop, "项目讨论"); await desktop.getByRole("button", { name: "Bot 设置", exact: true }).click(); await trigger(desktop).click();
    await desktop.getByRole("dialog", { name: "权限与批准", exact: true }).getByLabel("选择要调整的 Bot", { exact: true }).selectOption("delta");
    await expect(level(desktop)).toHaveValue("bypass"); await expect(level(desktop).locator("option")).toHaveCount(4);
    await level(desktop).selectOption("claude-auto"); await save(desktop).click(); await expect(desktop.getByRole("status")).toContainText("Claude Auto");
    await desktop.screenshot({ path: info.outputPath("permissions-desktop.png") });
    await desktop.getByRole("dialog", { name: "权限与批准", exact: true }).getByLabel("选择要调整的 Bot", { exact: true }).selectOption("beta");
    await expect(level(desktop)).toHaveValue("full-auto"); await expect(level(desktop).locator('option[value="full-auto"]')).toContainText("默认");
    await level(desktop).selectOption("bypass"); await expect(desktop.getByRole("note")).toContainText("Never Ask"); await save(desktop).click(); await expect(desktop.getByRole("status")).toContainText("Kimi Auto");
    await desktop.getByRole("dialog", { name: "权限与批准", exact: true }).getByLabel("选择要调整的 Bot", { exact: true }).selectOption("gamma");
    await level(desktop).selectOption("normal"); await expect(desktop.getByRole("note")).toContainText("整轮任务"); await save(desktop).click(); await expect(desktop.getByRole("status")).toContainText("每轮批准");
    const saved = async (id: string) => JSON.parse(await readFile(path.join(root, id, "config.json"), "utf8"));
    expect(await saved("alpha")).toMatchObject({ approvalMode: "normal" });
    expect(await saved("delta")).toMatchObject({ approvalMode: "normal", claudePermissionMode: "auto" });
    expect(await saved("beta")).toMatchObject({ approvalMode: "bypass", kimiAutoNeverAskAcknowledged: true });
    expect(await saved("gamma")).toMatchObject({ approvalMode: "normal" });
    for (const id of ["alpha", "beta", "gamma", "delta"]) {
      expect(await saved(id)).toMatchObject({ effort: "high", workspacePath: "/preserved/workspace" });
      expect(await readFile(path.join(root, id, "session.json"), "utf8")).toBe(JSON.stringify({ chats: [] }));
    }
    expect((await fetch(`${hub.url}/api/bots/alpha/permissions`)).status).toBe(401);
    expect((await fetch(`${hub.url}/api/bots/missing/permissions`, { headers: { authorization } })).status).toBe(403);
    const fresh = await (await fetch(`${hub.url}/api/bots/alpha/permissions`, { headers: { authorization } })).json();
    expect((await fetch(`${hub.url}/api/bots/alpha/permissions`, { method: "PUT", headers: { authorization }, body: JSON.stringify({ revision: fresh.revision, choice: "claude-auto" }) })).status).toBe(409);
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    try { expect((await fetch(`${hub.url}/api/bots/alpha/permissions`, { method: "PUT", headers: { authorization }, body: JSON.stringify({ revision: fresh.revision, choice: "bypass" }) })).status).toBe(403); }
    finally { await hub.store.db.run("UPDATE users SET role='owner' WHERE id='owner'"); }
    await close(phone); await gateways[0]!.disconnect(); await trigger(phone).click();
    await expect(phone.getByRole("alert")).toContainText("Bot 当前离线");
    expect(engineCalls).toBe(0); expect(errors).toEqual([]);
  } finally {
    if (previousAgy === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE; else process.env.ANTIGRAVITY_EXECUTABLE = previousAgy;
    await desktopContext.close().catch(() => undefined); await phoneContext.close().catch(() => undefined);
    for (const gateway of gateways) await gateway.disconnect();
    await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
