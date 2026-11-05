import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { openBotSettings } from "./fixtures/bot-settings.js";
import { kimiModelConfig } from "../../tests/fixtures/kimi-model-config.js";

test("Kimi native catalog and default effort work on desktop and phone", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-kimi-model-ui-")), stateDir = path.join(root, "bot");
  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = root;
  await mkdir(stateDir); await writeFile(path.join(root, "config.toml"), kimiModelConfig);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "kimi", effort: "max", locale: "zh" }));
  await writeFile(path.join(stateDir, "session.json"), "preserved-session");
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["alpha", "Kimi", hashSecret(secret)]);
  let calls = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "kimi", effort: "max", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { calls++; return { text: "unused" }; } } });
  const contexts = [], errors: string[] = [];
  try {
    await hub.store.createConversation("owner", ["alpha"], "Kimi 模型设置", "study");
    for (const width of [1360, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" }); contexts.push(context);
      const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(page); await selectConversation(page, "Kimi 模型设置");
      if (width === 1360) {
        await page.locator(".host-workspace:not([hidden]) .composer-model-controls").getByRole("button", { name: /^模型设置：/ }).click();
        const menu = page.getByRole("group", { name: "快捷选择模型", exact: true });
        await expect(menu.getByRole("button", { name: /^引擎默认模型 · K3.1 Pro/ })).toBeVisible();
        await expect(menu.getByRole("button", { name: /^K3.1 Pro / })).toBeVisible();
        await page.screenshot({ path: info.outputPath("kimi-desktop-quick-models.png"), animations: "disabled" });
        await page.keyboard.press("Escape");
      }
      await openBotSettings(page); await page.getByRole("button", { name: "调整 Bot 模型", exact: true }).click();
      const model = page.getByLabel("选择模型", { exact: true }), effort = page.getByLabel("模型思考强度", { exact: true });
      await expect(model.locator("option")).toHaveText(["引擎默认模型 · K3.1 Pro", "K3", "K3.1 Pro", "K2.7 Code Highspeed", "自定义模型…"]);
      await model.selectOption("kimi-code/k3.1-pro");
      await expect(effort).toHaveValue(width === 1360 ? "max" : "");
      await model.selectOption("kimi-code/kimi-for-coding-highspeed");
      await expect(effort.locator("option")).toHaveCount(1); await expect(effort).toHaveValue("");
      await model.selectOption("");
      await expect(effort.locator("option")).toHaveText(["跟随默认（不强制指定）", "low", "high", "max"]);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const save = page.getByRole("button", { name: "保存到此 Bot", exact: true });
        await expect.poll(async () => { const rect = await save.boundingBox(); return rect ? rect.y + rect.height : Infinity; }).toBeLessThanOrEqual(900);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`kimi-${width}-${theme}.png`), animations: "disabled" });
      }
      if (width === 1360) {
        await page.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "已保存为 引擎默认模型" })).toBeVisible();
      }
    }
    const saved = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"));
    expect(saved.effort).toBeUndefined(); expect(saved.model).toBeUndefined();
    expect(await readFile(path.join(stateDir, "session.json"), "utf8")).toBe("preserved-session");
    expect(calls).toBe(0); expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = previousHome;
  }
});

test("existing Bot model saves across phone and desktop without messages or session resets", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-model-ui-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const stateDir = path.join(root, "bot"); await mkdir(stateDir);
  const config = { engine: "codex", model: "gpt-5.6-sol", effort: "ultra", locale: "zh", workspacePath: "/preserved/workspace" };
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify(config));
  await writeFile(path.join(stateDir, "session.json"), "preserved-session");
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["alpha", "测试", hashSecret(secret)]);
  let engineCalls = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", model: config.model, effort: config.effort, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { engineCalls++; return { text: "unused" }; } } });
  const contexts = await Promise.all([1360, 390].map(width => browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" })));
  const [desktop, phone] = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = [];
  try {
    await hub.store.createConversation("owner", ["alpha"], "测试会话", "study");
    for (const page of [desktop!, phone!]) {
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(page); await selectConversation(page, "测试会话"); await openBotSettings(page);
      await expect(page.getByRole("button", { name: "调整 Bot 模型", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "调整 Bot 模型", exact: true }).click();
      await expect(page.getByLabel("选择模型", { exact: true })).toHaveValue("gpt-5.6-sol");
    }
    await phone!.getByLabel("选择模型", { exact: true }).selectOption("gpt-6-luna");
    await expect(phone!.getByText("新模型不支持原思考强度，已选为跟随默认。你也可以选择其他可用档位。", { exact: true })).toBeVisible();
    await expect(phone!.getByLabel("模型思考强度", { exact: true })).toHaveValue("");
    await phone!.getByLabel("模型思考强度", { exact: true }).selectOption("max");
    await phone!.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(phone!.getByRole("status")).toContainText("已保存为 gpt-6-luna");
    await desktop!.getByLabel("选择模型", { exact: true }).selectOption("gpt-6.1-sol");
    await desktop!.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(desktop!.getByRole("alert")).toContainText("其他设备或本机已修改设置");
    await desktop!.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(desktop!.getByLabel("选择模型", { exact: true })).toHaveValue("gpt-6-luna");
    await expect(desktop!.getByLabel("模型思考强度", { exact: true })).toHaveValue("max");
    await phone!.screenshot({ path: info.outputPath("model-phone.png"), animations: "disabled" });
    for (const page of [desktop!, phone!]) {
      await page.getByRole("button", { name: "关闭模型设置", exact: true }).click();
      await expect(page.getByRole("button", { name: "调整 Bot 模型", exact: true })).toContainText("gpt-6-luna");
      await expect(page.getByRole("button", { name: "调整 Bot 思考强度", exact: true })).toContainText("max");
    }
    await phone!.screenshot({ path: info.outputPath("bot-settings-phone.png"), animations: "disabled" });
    expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"))).toMatchObject({ ...config, model: "gpt-6-luna", effort: "max" });
    expect(await readFile(path.join(stateDir, "session.json"), "utf8")).toBe("preserved-session");
    expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
    expect(engineCalls).toBe(0); expect(errors).toEqual([]);

    // The new Sol preset persists its exact ID and extended effort across reopening.
    await phone!.getByRole("button", { name: "调整 Bot 模型", exact: true }).click();
    await phone!.getByLabel("选择模型", { exact: true }).selectOption("gpt-6.1-sol");
    await phone!.getByLabel("模型思考强度", { exact: true }).selectOption("ultra");
    await phone!.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(phone!.getByRole("status")).toContainText("已保存为 gpt-6.1-sol");
    await phone!.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    await phone!.getByRole("button", { name: "调整 Bot 模型", exact: true }).click();
    await expect(phone!.getByLabel("选择模型", { exact: true })).toHaveValue("gpt-6.1-sol");
    await expect(phone!.getByLabel("模型思考强度", { exact: true })).toHaveValue("ultra");
    await phone!.screenshot({ path: info.outputPath("codex61-model-phone.png"), animations: "disabled" });
    expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"))).toMatchObject({ ...config, model: "gpt-6.1-sol", effort: "ultra" });
    expect(await readFile(path.join(stateDir, "session.json"), "utf8")).toBe("preserved-session");
    expect(engineCalls).toBe(0);
    await phone!.getByRole("button", { name: "关闭模型设置", exact: true }).click();

    // Unknown/custom IDs remain editable and persisted, with safe effort checks.
    await phone!.getByRole("button", { name: "调整 Bot 模型", exact: true }).click();
    await phone!.getByLabel("选择模型", { exact: true }).selectOption("__custom__");
    const save = phone!.getByRole("button", { name: "保存到此 Bot", exact: true });
    await expect(save).toBeDisabled();
    await phone!.getByLabel("模型 ID", { exact: true }).fill("provider/custom-model");
    await save.click(); await expect(phone!.getByRole("status")).toContainText("已保存为 provider/custom-model");
    await phone!.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    await phone!.getByRole("button", { name: "调整 Bot 模型", exact: true }).click();
    await expect(phone!.getByLabel("选择模型", { exact: true })).toHaveValue("provider/custom-model");
    await phone!.getByRole("button", { name: "关闭模型设置", exact: true }).click();

    await phone!.route("**/api/bots/alpha/model", route => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) }));
    await phone!.getByRole("button", { name: "调整 Bot 模型", exact: true }).click();
    await expect(phone!.getByRole("alert")).toContainText("请更新主机版本");
    await expect(phone!.getByRole("button", { name: "保存到此 Bot", exact: true })).toHaveCount(0);
    await phone!.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    await phone!.unroute("**/api/bots/alpha/model");
    await gateway.disconnect();
    await phone!.getByRole("button", { name: "调整 Bot 模型", exact: true }).click();
    await expect(phone!.getByRole("alert")).toContainText("Bot 当前离线");
  } finally { for (const context of contexts) await context.close().catch(() => undefined); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("Antigravity separates model families and their supported effort on phone and desktop", async ({ browser }, info) => {
  const previousAgy = process.env.ANTIGRAVITY_EXECUTABLE;
  process.env.ANTIGRAVITY_EXECUTABLE = path.resolve("../tests/fixtures/agy-models.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-agy-model-ui-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir);
  const config = { engine: "antigravity", model: "gemini-3.8-flash-high", locale: "zh", workspacePath: "/preserved/workspace" };
  const file = path.join(stateDir, "config.json");
  await writeFile(file, JSON.stringify(config)); await writeFile(path.join(stateDir, "session.json"), "preserved-session");
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["alpha", "测试", hashSecret(secret)]);
  let engineCalls = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "antigravity", model: config.model, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { engineCalls++; return { text: "unused" }; } } });
  const contexts = await Promise.all([1360, 390].map(width => browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" })));
  const [desktop, phone] = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = [];
  try {
    await hub.store.createConversation("owner", ["alpha"], "测试会话", "study");
    for (const page of [desktop!, phone!]) {
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(page); await selectConversation(page, "测试会话"); await openBotSettings(page);
      await page.getByRole("button", { name: "调整 Bot 模型", exact: true }).click();
      await expect(page.getByLabel("选择模型", { exact: true }).locator("option:checked")).toHaveText("Gemini 3.8 Flash");
      await expect(page.getByLabel("模型思考强度", { exact: true })).toHaveValue("high");
      await expect(page.getByLabel("模型思考强度", { exact: true }).locator("option")).toHaveText(["low", "medium", "high"]);
      await expect(page.getByRole("button", { name: "保存到此 Bot", exact: true })).toBeDisabled();
    }
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(config); // Opening never writes an override.
    await phone!.getByLabel("模型思考强度", { exact: true }).selectOption("low");
    await phone!.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(phone!.getByRole("status")).toContainText("已保存为");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ ...config, model: "gemini-3.8-flash-low", effort: "low" });
    await desktop!.getByLabel("模型思考强度", { exact: true }).selectOption("medium");
    await desktop!.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(desktop!.getByRole("alert")).toContainText("其他设备或本机已修改设置");
    await desktop!.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(desktop!.getByLabel("模型思考强度", { exact: true })).toHaveValue("low");
    for (const page of [desktop!, phone!]) {
      await page.getByLabel("选择模型", { exact: true }).selectOption("gemini-3.1-pro-high");
      await expect(page.getByLabel("模型思考强度", { exact: true }).locator("option")).toHaveText(["low", "high"]);
      await expect(page.getByLabel("模型思考强度", { exact: true })).toHaveValue("low");
      await page.getByLabel("选择模型", { exact: true }).selectOption("gpt-oss-120b-medium");
      await expect(page.getByLabel("模型思考强度", { exact: true }).locator("option")).toHaveText(["medium"]);
      await expect(page.getByText("已调整为此模型支持的思考强度，请确认。", { exact: true })).toBeVisible();
      await page.getByLabel("选择模型", { exact: true }).selectOption("gemini-4-argon-medium");
      await expect(page.getByLabel("模型思考强度", { exact: true })).toHaveValue("medium");
    }
    await phone!.screenshot({ path: info.outputPath("agy-model-effort-phone.png"), animations: "disabled" });
    await phone!.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(phone!.getByRole("status")).toContainText("已保存为");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ ...config, model: "gemini-4-argon-medium", effort: "medium" });

    // Preserve a legacy conflicting value for correction, never silently lower it.
    await writeFile(file, JSON.stringify({ ...config, effort: "xhigh" }));
    await phone!.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(phone!.getByLabel("模型思考强度", { exact: true })).toHaveValue("xhigh");
    await expect(phone!.getByLabel("模型思考强度", { exact: true }).locator('option[value="xhigh"]')).toHaveJSProperty("disabled", true);
    await expect(phone!.getByRole("button", { name: "保存到此 Bot", exact: true })).toBeDisabled();
    await phone!.getByLabel("模型思考强度", { exact: true }).selectOption("high");
    await phone!.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(phone!.getByRole("status")).toContainText("已保存为");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ ...config, effort: "high" });
    await phone!.getByLabel("选择模型", { exact: true }).selectOption("__custom__");
    await phone!.getByLabel("模型 ID", { exact: true }).fill("provider/custom-high");
    await expect(phone!.getByLabel("模型思考强度", { exact: true }).locator("option")).toHaveText(["跟随默认（不强制指定）"]);
    await phone!.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ ...config, effort: "high" });
    expect(await readFile(path.join(stateDir, "session.json"), "utf8")).toBe("preserved-session");
    expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
    expect(engineCalls).toBe(0); expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true });
    if (previousAgy === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE; else process.env.ANTIGRAVITY_EXECUTABLE = previousAgy;
  }
});
