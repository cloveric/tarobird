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
test("Bot effort syncs across chats and devices, preserves isolation and rejects stale saves", async ({ browser }, info) => {
  const previousAgy = process.env.ANTIGRAVITY_EXECUTABLE;
  process.env.ANTIGRAVITY_EXECUTABLE = path.resolve("../tests/fixtures/agy-models.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "client-effort-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  const gateways: GatewayChannel[] = [], errors: string[] = []; let engineCalls = 0, authorization = "";
  for (const page of [desktop, phone]) page.on("pageerror", (error) => errors.push(error.message));
  desktop.on("request", (request) => { if (request.url().endsWith("/effort")) authorization = request.headers().authorization ?? authorization; });
  try {
    for (const [id, name, engine, model] of [
      ["alpha", "研究助手", "codex", "gpt-5.5"],
      ["beta", "写作助手", "kimi", "kimi-code/k3"],
      ["gamma", "执行助手", "antigravity", "gemini-3.7-flash-high"],
    ] as const) {
      const stateDir = path.join(root, id), secret = randomBytes(32).toString("base64url"); await mkdir(stateDir);
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, model, effort: "high", locale: "zh", workspacePath: "/preserved/workspace" }));
      await writeFile(path.join(stateDir, "session.json"), JSON.stringify({ chats: [] }));
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, name, hashSecret(secret)]);
      gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: id, engine, model, effort: "high", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { engineCalls++; return { text: "unused" }; } } }));
    }
    await hub.store.createConversation("owner", ["alpha"], "研究一", "study1");
    await hub.store.createConversation("owner", ["alpha"], "研究二", "study2");
    await hub.store.createConversation("owner", ["alpha", "beta", "gamma"], "项目讨论", "group1", { type: "group" });
    await hub.store.createConversation("owner", ["gamma"], "执行任务", "execution1");
    for (const page of [desktop, phone]) { await pair(page, hub); await select(page, page === desktop ? "研究一" : "研究二"); await page.getByRole("button", { name: "查看对话详情", exact: true }).click(); await page.getByRole("button", { name: "Bot 设置", exact: true }).click(); }
    const trigger = (page: Page) => page.getByRole("button", { name: "调整 Bot 思考强度", exact: true });
    const level = (page: Page) => page.getByLabel("Effort 档位", { exact: true });
    const save = (page: Page) => page.getByRole("button", { name: "保存到此 Bot", exact: true });
    const close = (page: Page) => page.getByRole("button", { name: "关闭思考强度", exact: true }).click();
    await trigger(phone).click(); await expect(level(phone)).toHaveValue("high");
    await trigger(desktop).click(); await expect(level(desktop)).toHaveValue("high");
    await expect(level(desktop).locator("option")).toHaveText(["跟随默认（不强制指定）", "low", "medium", "high", "xhigh"]);
    await expect(desktop.getByRole("dialog", { name: "思考强度", exact: true }).getByText("此 Bot 的所有对话、群聊和话题共用", { exact: true })).toBeVisible();
    await level(desktop).selectOption("xhigh"); await save(desktop).click();
    await expect(desktop.getByRole("dialog", { name: "思考强度", exact: true }).getByRole("status")).toContainText("已保存为 xhigh");
    await expect(trigger(phone)).toContainText("xhigh"); // Another chat, another device.
    await level(phone).selectOption("low"); await save(phone).click();
    await expect(phone.getByRole("alert")).toContainText("其他设备或本机已修改设置");
    await phone.getByRole("button", { name: "重新读取", exact: true }).click(); await expect(level(phone)).toHaveValue("xhigh");
    await level(phone).selectOption("low"); await save(phone).click(); await expect(phone.getByRole("dialog", { name: "思考强度", exact: true }).getByRole("status")).toContainText("已保存为 low");
    await close(desktop); await expect(trigger(desktop)).toContainText("low");
    for (const [page, device] of [[desktop, "desktop"], [phone, "phone"]] as const) await page.screenshot({ path: info.outputPath(`effort-${device}.png`), animations: "disabled" });
    await close(phone); await phone.getByRole("button", { name: "关闭 Bot 设置", exact: true }).click(); await select(phone, "项目讨论"); await phone.getByRole("button", { name: "查看对话详情", exact: true }).click(); await phone.getByRole("button", { name: "Bot 设置", exact: true }).click(); await trigger(phone).click();
    await phone.getByRole("dialog", { name: "思考强度", exact: true }).getByLabel("选择要调整的 Bot", { exact: true }).selectOption("beta");
    await expect(level(phone)).toHaveValue("high");
    await expect(level(phone).locator("option")).toHaveText(["跟随默认（不强制指定）", "low", "high", "max"]);
    await level(phone).selectOption(""); await save(phone).click(); await expect(phone.getByRole("dialog", { name: "思考强度", exact: true }).getByRole("status")).toContainText("已保存为 跟随默认");
    await desktop.getByRole("button", { name: "关闭 Bot 设置", exact: true }).click(); await select(desktop, "执行任务"); await desktop.getByRole("button", { name: "Bot 设置", exact: true }).click();
    await phone.getByRole("dialog", { name: "思考强度", exact: true }).getByLabel("选择要调整的 Bot", { exact: true }).selectOption("gamma");
    await expect(level(phone)).toHaveValue("high");
    await expect(level(phone).locator("option")).toHaveText(["沿用模型预设（high）", "high"]);
    await level(phone).selectOption(""); await save(phone).click();
    await expect(phone.getByRole("dialog", { name: "思考强度", exact: true }).getByRole("status")).toContainText("已保存为 跟随默认");
    await expect(trigger(desktop)).toContainText("默认");
    await phone.screenshot({ path: info.outputPath("effort-phone-antigravity-preset.png"), animations: "disabled" });
    await trigger(desktop).click(); await expect(level(desktop)).toHaveValue("");
    await close(desktop); await desktop.getByRole("button", { name: "关闭 Bot 设置", exact: true }).click(); await select(desktop, "研究一"); await desktop.getByRole("button", { name: "Bot 设置", exact: true }).click();
    const a = JSON.parse(await readFile(path.join(root, "alpha", "config.json"), "utf8")), b = JSON.parse(await readFile(path.join(root, "beta", "config.json"), "utf8"));
    expect(a).toMatchObject({ effort: "low", model: "gpt-5.5", workspacePath: "/preserved/workspace" }); expect(b).not.toHaveProperty("effort");
    expect(JSON.parse(await readFile(path.join(root, "gamma", "config.json"), "utf8"))).toMatchObject({ model: "gemini-3.7-flash-high", workspacePath: "/preserved/workspace" });
    expect(await readFile(path.join(root, "gamma", "session.json"), "utf8")).toBe(JSON.stringify({ chats: [] }));
    expect(await readFile(path.join(root, "alpha", "session.json"), "utf8")).toBe(JSON.stringify({ chats: [] }));
    expect((await fetch(`${hub.url}/api/bots/alpha/effort`)).status).toBe(401);
    expect((await fetch(`${hub.url}/api/bots/missing/effort`, { headers: { authorization } })).status).toBe(403);
    const gamma = await (await fetch(`${hub.url}/api/bots/gamma/effort`, { headers: { authorization } })).json();
    expect(gamma.effort).toBe("");
    const incompatibleGamma = await fetch(`${hub.url}/api/bots/gamma/effort`, { method: "PUT", headers: { authorization }, body: JSON.stringify({ revision: gamma.revision, effort: "xhigh" }) });
    expect(incompatibleGamma.status).toBe(409);
    expect(await incompatibleGamma.json()).toMatchObject({ error: "effort_incompatible" });
    expect(JSON.parse(await readFile(path.join(root, "gamma", "config.json"), "utf8"))).not.toHaveProperty("effort");
    const fresh = await (await fetch(`${hub.url}/api/bots/alpha/effort`, { headers: { authorization } })).json();
    expect((await fetch(`${hub.url}/api/bots/alpha/effort`, { method: "PUT", headers: { authorization }, body: JSON.stringify({ revision: fresh.revision, effort: "ultra" }) })).status).toBe(409);
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    try { expect((await fetch(`${hub.url}/api/bots/alpha/effort`, { method: "PUT", headers: { authorization }, body: JSON.stringify({ revision: fresh.revision, effort: "high" }) })).status).toBe(403); }
    finally { await hub.store.db.run("UPDATE users SET role='owner' WHERE id='owner'"); }
    await close(phone); await gateways[0]!.disconnect();
    await trigger(desktop).click(); await expect(desktop.getByRole("alert")).toContainText("Bot 当前离线");
    expect(await hub.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
    expect(engineCalls).toBe(0); expect(errors).toEqual([]);
  } finally {
    if (previousAgy === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE; else process.env.ANTIGRAVITY_EXECUTABLE = previousAgy;
    await desktopContext.close().catch(() => undefined); await phoneContext.close().catch(() => undefined);
    for (const gateway of gateways) await gateway.disconnect();
    await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
