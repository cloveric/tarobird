import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { ModelSettings } from "../../src/client-protocol/model.js";
import { fixtureInvitation } from "./fixtures/pairing-invite.js";
import { pairingLink } from "../src/pairing-link.js";
import en from "../src/locales/en.json" with { type: "json" };

// Synthetic catalog responses exercise the built App and signed Hub connection.
// Native discovery/acceptance are covered by Host tests, never a model call here.
const choices: ModelSettings["choices"] = [
  // A ready Host attaches the resolved DSH default's identity to follow-default (real DSH 0.2.2-rc.5 shape).
  { id: "", label: "alpha / Shared model", provider: "alpha", modelId: "org/shared", efforts: ["", "off", "medium", "high"] },
  { id: "alpha/org/shared", provider: "alpha", modelId: "org/shared", label: "Shared model", efforts: ["", "off", "medium", "high"] },
  { id: "beta/org/shared", provider: "beta", modelId: "org/shared", label: "Shared model", efforts: [""] },
  // The encoding is deliberately opaque to the App, including slash/percent.
  { id: "fixture:provider%2Fteam/model%25with%2Fslash", provider: "provider/team", modelId: "model%with/slash", label: "Other model", efforts: ["", "off", "low"] },
];
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(page: Page, english: boolean, initialModel = "alpha/org/shared") {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-deepseek-model-ui-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir);
  const config = { engine: "deepseek", model: initialModel, effort: "high", locale: "zh" };
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify(config)); await writeFile(path.join(stateDir, "session.json"), "preserved-session");
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: process.env.TAROBIRD_MODEL_TEST_CLIENT_DIR || path.resolve("dist") });
  await hub.profile.update({ name: "Model fixture Host", revision: (await hub.profile.read()).revision });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["deepseek_fixture", "DeepSeek fixture", hashSecret(secret)]);
  let engineCalls = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "deepseek_fixture", engine: "deepseek", model: config.model, effort: config.effort, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { engineCalls++; throw new Error("fixture_model_call_forbidden"); } } });
  const f = {
    settings: { scope: "bot", revision: "a".repeat(64), engine: "deepseek", model: config.model, effort: "high", choices, customEfforts: [""], activeTurns: 0, catalogStatus: "ready" } as ModelSettings,
    reads: 0, catalogRequests: [] as string[], writes: [] as Record<string, unknown>[], creates: [] as Record<string, unknown>[], failure: false, writeFailure: "",
    hold: undefined as Promise<void> | undefined,
    text: (key: string) => english ? (en as Record<string, string>)[key] || key : key,
    async close() {
      expect(engineCalls).toBe(0); expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"))).toEqual(config);
      expect(await readFile(path.join(stateDir, "session.json"), "utf8")).toBe("preserved-session");
      expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
      await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true });
    },
  };
  await page.route("**/api/bots/deepseek_fixture/model", async route => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON(); f.writes.push(input);
      if (f.writeFailure) return route.fulfill({ status: 409, json: { error: f.writeFailure } });
      f.settings = { ...f.settings, model: input.model, effort: input.effort, revision: "b".repeat(64) };
    } else { f.reads++; await f.hold; }
    await route.fulfill(f.failure ? { status: 503, json: { error: "model_catalog_unavailable" } } : { json: f.settings });
  });
  await page.route("**/api/bots/catalog*", async route => { f.catalogRequests.push(route.request().url()); await f.hold; await route.fulfill(f.failure ? { status: 503, json: { error: "unavailable" } } : { json: { engines: [{ id: "deepseek", available: true, models: f.settings.choices, defaultModel: "", defaultEffort: "", catalogStatus: f.settings.catalogStatus }] } }); });
  await page.route("**/api/bots", async route => {
    if (route.request().method() !== "POST") return route.continue();
    f.creates.push(route.request().postDataJSON());
    // Definite refusal permits checking the exact request without any worker.
    await route.fulfill({ status: 422, json: { error: "model_unavailable" } });
  });
  await hub.store.createConversation("owner", ["deepseek_fixture"], "DeepSeek model fixture", "fixture");
  await page.goto(hub.url);
  const invitation = await fixtureInvitation(hub);
  await page.getByRole("button", { name: f.text("粘贴连接信息"), exact: true }).click();
  await page.getByLabel(f.text("配对信息"), { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
  await page.getByRole("button", { name: f.text("使用配对信息"), exact: true }).click();
  await page.getByRole("button", { name: f.text("配对此设备"), exact: true }).click();
  await hub.auth.approve(await page.getByLabel(f.text("配对码"), { exact: true }).innerText(), "local-owner");
  await page.getByLabel(f.text("配对码"), { exact: true }).waitFor({ state: "hidden" });
  await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeAttached();
  return f;
}
async function openModel(page: Page, f: Fixture) {
  const phone = page.viewportSize()!.width <= 760;
  await page.locator(phone ? ".mobile-home:visible .mh-row" : ".conversation-row").filter({ has: page.getByText("DeepSeek model fixture", { exact: true }) }).click();
  await page.getByRole("button", { name: f.text("查看对话详情"), exact: true }).click();
  await page.getByRole("button", { name: f.text("Bot 设置"), exact: true }).click();
  await page.getByRole("button", { name: f.text("调整 Bot 模型"), exact: true }).click();
}
async function newBot(page: Page, f: Fixture) {
  await page.getByRole("button", { name: f.text("新建"), exact: true }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: f.text("新建 Bot"), exact: true }).or(page.getByRole("button", { name: f.text("新建 Bot"), exact: true })).filter({ visible: true }).click();
}

test.use({ actionTimeout: 10_000 });
test("retains a complete long DeepSeek model in the offline Bot directory", async ({ page }) => {
  const model = "dsh-model:provider%2Froute/" + "model".repeat(40), f = await fixture(page, false, model);
  try {
    await expect.poll(() => page.evaluate(async model => {
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(info.name!); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try {
          if (!db.objectStoreNames.contains("settings")) continue;
          const raw = await new Promise<unknown>((resolve, reject) => { const request = db.transaction("settings").objectStore("settings").get("botNames"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          if (typeof raw === "string" && JSON.parse(raw).some((bot: { id: string; model?: string }) => bot.id === "deepseek_fixture" && bot.model === model)) return true;
        } finally { db.close(); }
      }
      return false;
    }, model)).toBe(true);
    await openModel(page, f);
    await expect(page.getByLabel("选择模型", { exact: true })).toHaveValue(model);
  } finally { await f.close(); }
});
for (const width of [1360, 390, 320]) for (const english of [false, true]) test(`DeepSeek exact provider/model and per-model effort · ${width} · ${english ? "en" : "zh"}`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: english ? "en-US" : "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), f = await fixture(page, english), errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  try {
    await newBot(page, f);
    const model = page.getByLabel(f.text("模型"), { exact: true }), effort = page.getByLabel(f.text("推理强度（effort）"), { exact: true });
    await expect(model.locator('option[value="alpha/org/shared"]')).toHaveText("alpha / Shared model (org/shared)");
    await expect(model.locator('option[value="beta/org/shared"]')).toHaveText("beta / Shared model (org/shared)");
    await model.selectOption(choices[1]!.id); await effort.selectOption("high");
    await model.selectOption(choices[2]!.id); await expect(effort).toHaveValue(""); await expect(effort.locator("option")).toHaveCount(1);
    await model.selectOption(choices[3]!.id); await effort.selectOption("off");
    await expect(effort.locator('option[value="off"]')).toHaveText(f.text("关闭推理（off）"));
    await page.getByRole("button", { name: f.text("重新读取模型"), exact: true }).click();
    await expect(model).toHaveValue(choices[3]!.id); await expect(effort).toHaveValue("off");
    await page.getByLabel(f.text("Bot 名称"), { exact: true }).fill("Synthetic model Bot");
    await expect(page.getByRole("button", { name: f.text("创建 Bot"), exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("deepseek-create.png"), fullPage: true });
    await page.getByRole("button", { name: f.text("创建 Bot"), exact: true }).click();
    await expect.poll(() => f.creates.length).toBe(1); expect(f.creates[0]).toMatchObject({ engine: "deepseek", model: choices[3]!.id, effort: "off" });
    await expect(page.getByRole("alert").filter({ hasText: f.text("所选模型已不在主机目录中。请重新读取并选择可用模型；已保存的设置不会被清除。") })).toBeVisible();
    await page.getByRole("button", { name: f.text("关闭新建对话"), exact: true }).click();
    await openModel(page, f);
    const existing = page.getByLabel(f.text("选择模型"), { exact: true }), levels = page.getByLabel(f.text("模型思考强度"), { exact: true });
    await expect(existing).toHaveValue("alpha/org/shared"); await expect(levels).toHaveValue("high");
    await existing.selectOption(choices[3]!.id); await levels.selectOption("off");
    await page.getByRole("button", { name: f.text("保存到此 Bot"), exact: true }).click();
    await expect.poll(() => f.writes.length).toBe(1); expect(f.writes[0]).toEqual({ revision: "a".repeat(64), model: choices[3]!.id, effort: "off" });
    await expect(page.getByRole("button", { name: f.text("保存到此 Bot"), exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".effort-settings .dashboard-notice").evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    await page.screenshot({ path: info.outputPath("deepseek-settings.png"), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.close(); await context.close(); }
});

test("DeepSeek creation retains selection on failed and empty refresh without allowing creation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 }); const f = await fixture(page, false);
  try {
    await newBot(page, f); await page.getByLabel("Bot 名称", { exact: true }).fill("Synthetic draft");
    const model = page.getByLabel("模型", { exact: true }), effort = page.getByLabel("推理强度（effort）", { exact: true }), create = page.getByRole("button", { name: "创建 Bot", exact: true });
    await model.selectOption(choices[3]!.id); await effort.selectOption("off"); await expect(create).toBeEnabled();
    await page.getByText("高级设置", { exact: true }).click();
    await page.getByLabel("工作区（可选）", { exact: true }).fill("/fixture/workspace");
    await page.getByLabel("工作区（可选）", { exact: true }).blur();
    await expect.poll(() => new URL(f.catalogRequests.at(-1)!).searchParams.get("workspace")).toBe("/fixture/workspace");
    // Moving to another workspace is a look, not the owner's reread.
    expect(new URL(f.catalogRequests.at(-1)!).searchParams.get("refresh")).toBeNull();
    await expect(create).toBeEnabled(); await expect(model).toHaveValue(choices[3]!.id); await expect(effort).toHaveValue("off");
    let release!: () => void; f.hold = new Promise<void>(resolve => { release = resolve; });
    await page.getByRole("button", { name: "重新读取模型", exact: true }).click();
    // The button asks the Hub for a new read, which an unanswered read in its retry window would otherwise answer.
    await expect.poll(() => new URL(f.catalogRequests.at(-1)!).searchParams.get("refresh")).toBe("deepseek");
    await expect(model).toHaveValue(choices[3]!.id); await expect(effort).toHaveValue("off"); await expect(create).toBeDisabled();
    f.failure = true; release(); f.hold = undefined;
    await expect(page.getByRole("alert")).toContainText("暂时无法读取可用引擎"); await expect(model).toHaveValue(choices[3]!.id); await expect(create).toBeDisabled();
    f.failure = false; f.settings = { ...f.settings, catalogStatus: "no-models", choices: [{ id: "", efforts: [""] }] };
    await page.getByRole("button", { name: "重新读取模型", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "未提供可用模型" })).toBeVisible(); await expect(model).toHaveValue(choices[3]!.id); await expect(effort).toHaveValue("off"); await expect(create).toBeDisabled();
    f.settings = { ...f.settings, catalogStatus: "ready", choices };
    await page.getByRole("button", { name: "重新读取模型", exact: true }).click(); await expect(create).toBeEnabled();
    expect(f.creates).toEqual([]);
  } finally { await f.close(); }
});

test("DeepSeek quick menus block incomplete catalogs and preserve opaque IDs", async ({ page }, info) => {
  const f = await fixture(page, false);
  try {
    await page.locator(".conversation-row").filter({ has: page.getByText("DeepSeek model fixture", { exact: true }) }).click();
    f.settings = { ...f.settings, catalogStatus: "unavailable" };
    const controls = page.locator(".host-workspace:not([hidden]) .composer-model-controls");
    await controls.getByRole("button", { name: /^模型设置：/ }).click();
    const menu = page.getByRole("group", { name: "快捷选择模型", exact: true });
    await expect(menu.getByRole("status")).toContainText("暂未完整读取 DeepSeek 模型目录");
    await expect(menu.getByRole("button", { name: /beta \/ Shared model/ })).toBeDisabled();
    f.settings = { ...f.settings, catalogStatus: "ready" };
    await menu.getByRole("button", { name: "重新读取", exact: true }).click();
    await menu.getByRole("button", { name: /provider\/team \/ Other model/ }).click();
    await expect.poll(() => f.writes.length).toBe(1); expect(f.writes[0]).toMatchObject({ model: choices[3]!.id, effort: "" });
    await controls.getByRole("button", { name: /^思考强度：/ }).click();
    const levels = page.getByRole("group", { name: "快捷选择思考强度", exact: true });
    await expect(levels.getByRole("button", { name: "关闭推理（off）", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("deepseek-quick-effort.png") });
    await levels.getByRole("button", { name: "关闭推理（off）", exact: true }).click();
    await expect.poll(() => f.writes.length).toBe(2); expect(f.writes[1]).toMatchObject({ model: choices[3]!.id, effort: "off" });
  } finally { await f.close(); }
});

// DSH has concrete models but no usable default (removed or never set): "follow default" is refused by the Host.
const withoutDefault: ModelSettings["choices"] = [{ id: "", efforts: [""] }, ...choices.slice(1)];
for (const english of [false, true]) test(`DeepSeek without a usable default asks for a concrete model in creation and recovers · ${english ? "en" : "zh"}`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: english ? "en-US" : "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), f = await fixture(page, english);
  try {
    f.settings = { ...f.settings, choices: withoutDefault };
    await newBot(page, f); await page.getByLabel(f.text("Bot 名称"), { exact: true }).fill("Synthetic draft");
    const model = page.getByLabel(f.text("模型"), { exact: true }), create = page.getByRole("button", { name: f.text("创建 Bot"), exact: true });
    const notice = page.getByRole("status").filter({ hasText: f.text("主机上的 DeepSeek Harness 未设置可用的默认模型，无法跟随默认。请选择具体模型；不会自动替你选择。") });
    // The draft stays on follow-default; nothing is chosen for the user, and the refused request cannot be sent.
    await expect(notice).toBeVisible(); await expect(model).toHaveValue("");
    await expect(model.locator('option[value=""]')).toBeDisabled(); await expect(model.locator('option[value=""]')).toHaveText(f.text("跟随引擎默认模型（未设置）"));
    await expect(create).toBeDisabled(); await expect(page.getByText(f.text("此前选择的模型或推理强度已不可用，请重新选择。"))).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("deepseek-default-missing.png"), fullPage: true });
    await model.selectOption(choices[1]!.id); await expect(create).toBeEnabled(); await expect(notice).toBeVisible();
    // The default returns: the explicit choice is kept and follow-default is offered again.
    f.settings = { ...f.settings, choices };
    await page.getByRole("button", { name: f.text("重新读取模型"), exact: true }).click();
    await expect(notice).toHaveCount(0); await expect(model).toHaveValue(choices[1]!.id); await expect(create).toBeEnabled();
    await model.selectOption(""); await expect(model).toHaveValue(""); await expect(create).toBeEnabled();
    expect(f.creates).toEqual([]);
  } finally { await f.close(); await context.close(); }
});

test("DeepSeek without a usable default lets an existing Bot be corrected in quick menus and settings", async ({ page }) => {
  const f = await fixture(page, false);
  try {
    f.settings = { ...f.settings, model: "", effort: "high", choices: withoutDefault };
    // Quick menus offer only the concrete models while the Bot still follows the missing default.
    await page.locator(".conversation-row").filter({ has: page.getByText("DeepSeek model fixture", { exact: true }) }).click();
    const controls = page.locator(".host-workspace:not([hidden]) .composer-model-controls");
    await controls.getByRole("button", { name: /^思考强度：/ }).click();
    const levels = page.getByRole("group", { name: "快捷选择思考强度", exact: true });
    await expect(levels.getByRole("status")).toContainText("未设置可用的默认模型");
    await expect(levels.getByRole("button", { name: "跟随默认", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await levels.waitFor({ state: "hidden" });
    await controls.getByRole("button", { name: /^模型设置：/ }).click();
    const menu = page.getByRole("group", { name: "快捷选择模型", exact: true });
    await expect(menu.getByRole("status")).toContainText("未设置可用的默认模型");
    await expect(menu.getByRole("button", { name: /^引擎默认模型（未设置）/ })).toBeDisabled();
    await menu.getByRole("button", { name: /beta \/ Shared model/ }).click();
    await expect.poll(() => f.writes.length).toBe(1); expect(f.writes[0]).toMatchObject({ model: choices[2]!.id, effort: "" });
    // Settings: the follow-default draft is shown but cannot be saved; a concrete model corrects it.
    f.settings = { ...f.settings, model: "", effort: "high", revision: "c".repeat(64) };
    await openModel(page, f);
    const existing = page.getByLabel("选择模型", { exact: true }), save = page.getByRole("button", { name: "保存到此 Bot", exact: true });
    await expect(page.getByRole("status").filter({ hasText: "未设置可用的默认模型" })).toBeVisible();
    await expect(existing).toHaveValue(""); await expect(existing.locator('option[value=""]')).toBeDisabled(); await expect(save).toBeDisabled();
    await existing.selectOption(choices[3]!.id); await expect(save).toBeEnabled(); await save.click();
    await expect.poll(() => f.writes.length).toBe(2); expect(f.writes[1]).toEqual({ revision: "c".repeat(64), model: choices[3]!.id, effort: "" });
  } finally { await f.close(); }
});

test("DeepSeek older Hosts keep follow-default selectable without a catalog status", async ({ page }) => {
  const f = await fixture(page, false);
  try {
    f.settings = { ...f.settings, catalogStatus: undefined, choices: [{ id: "", efforts: ["", "low", "high", "max"] }, { id: "legacy/model", efforts: ["", "low", "high", "max"] }] };
    await newBot(page, f); await page.getByLabel("Bot 名称", { exact: true }).fill("Legacy draft");
    const model = page.getByLabel("模型", { exact: true });
    await expect(model).toHaveValue(""); await expect(model.locator('option[value=""]')).toBeEnabled();
    await expect(page.getByText("未设置可用的默认模型")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "创建 Bot", exact: true })).toBeEnabled();
  } finally { await f.close(); }
});

test("DeepSeek older Hosts retain manual options without advertising new effort levels", async ({ page }) => {
  const f = await fixture(page, false);
  try {
    f.settings = { ...f.settings, catalogStatus: undefined, choices: [{ id: "", efforts: ["", "low", "high", "max"] }, { id: f.settings.model, efforts: ["", "low", "high", "max"] }], customEfforts: ["", "low", "high", "max"] };
    await openModel(page, f);
    await expect(page.getByRole("status").filter({ hasText: "此主机未提供 DeepSeek 模型目录" })).toBeVisible();
    await expect(page.getByLabel("模型思考强度", { exact: true }).locator('option[value="off"]')).toHaveCount(0);
    await page.getByLabel("选择模型", { exact: true }).selectOption("__custom__");
    await page.getByLabel("模型 ID", { exact: true }).fill("legacy/manual-model");
    await page.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect.poll(() => f.writes.length).toBe(1); expect(f.writes[0]).toMatchObject({ model: "legacy/manual-model", effort: "high" });
  } finally { await f.close(); }
});

test("DeepSeek effort shortcut explain catalog failure and retain an unsubmitted choice", async ({ page }) => {
  const f = await fixture(page, false);
  try {
    await openModel(page, f); await page.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    f.settings = { ...f.settings, catalogStatus: "unavailable" };
    await page.getByRole("button", { name: "调整 Bot 思考强度", exact: true }).click();
    const effort = page.getByLabel("模型思考强度", { exact: true }), save = page.getByRole("button", { name: "保存到此 Bot", exact: true });
    await expect(page.getByRole("status").filter({ hasText: "暂未完整读取 DeepSeek 模型目录" })).toBeVisible();
    await effort.selectOption("off"); await expect(save).toBeDisabled();
    f.settings = { ...f.settings, catalogStatus: "ready" };
    await page.getByRole("button", { name: "重新读取", exact: true }).click(); await expect(effort).toHaveValue("off"); await expect(save).toBeEnabled();
    f.writeFailure = "model_unavailable"; await save.click();
    await expect(page.getByRole("alert")).toContainText("所选模型已不在主机目录中"); await expect(save).toBeDisabled();
    expect(f.writes).toHaveLength(1); expect(f.writes[0]).toMatchObject({ model: f.settings.model, effort: "off" });
    f.writeFailure = ""; await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(effort).toHaveValue("off"); expect(f.writes).toHaveLength(1);
  } finally { await f.close(); }
});

test("DeepSeek refresh keeps manual draft through loading, failure and an empty catalog", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 }); const f = await fixture(page, false);
  try {
    await openModel(page, f); await page.getByLabel("选择模型", { exact: true }).selectOption("__custom__");
    const input = page.getByLabel("模型 ID", { exact: true }), save = page.getByRole("button", { name: "保存到此 Bot", exact: true });
    const manual = "manual-provider/" + "model".repeat(40); await input.fill(manual); await expect(input).toHaveValue(manual);
    let release!: () => void; f.hold = new Promise<void>(resolve => { release = resolve; });
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(input).toHaveValue(manual); await expect(input).toBeDisabled(); await expect(save).toBeDisabled();
    f.failure = true; release(); f.hold = undefined;
    await expect(page.getByRole("alert")).toContainText("暂未完整读取 DeepSeek 模型目录");
    await expect(input).toHaveValue(manual); await expect(save).toBeDisabled();
    f.failure = false; f.settings = { ...f.settings, catalogStatus: "no-models", choices: [{ id: "", efforts: [""] }, { id: f.settings.model, efforts: [""] }] };
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "未提供可用模型" })).toBeVisible(); await expect(input).toHaveValue(manual); await expect(save).toBeDisabled();
    await page.screenshot({ path: info.outputPath("deepseek-empty-draft.png"), fullPage: true });
    f.settings = { ...f.settings, catalogStatus: "ready", choices };
    await page.getByRole("button", { name: "重新读取", exact: true }).click(); await expect(input).toHaveValue(manual); await expect(save).toBeEnabled();
    expect(f.writes).toEqual([]);
  } finally { await f.close(); }
});
