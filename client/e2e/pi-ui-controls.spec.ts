import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { preparePairing, fixtureInvitation } from "./fixtures/pairing-invite.js";
import { pairingLink } from "../src/pairing-link.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { openBotSettings } from "./fixtures/bot-settings.js";
import type { PiSessionSnapshot, PiSessionChange } from "../../src/client-protocol/pi-session.js";
import type { ModelSettings } from "../../src/client-protocol/model.js";

test.use({ actionTimeout: 15_000, serviceWorkers: "block" });

async function pairClient(page: Page, hub: HubServer, en: boolean) {
  await page.goto(hub.url);
  if (en) {
    const invitation = await fixtureInvitation(hub);
    await page.getByRole("button", { name: "Paste connection details", exact: true }).click();
    await page.getByLabel("Pairing information", { exact: true }).fill(
      pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }),
    );
    await page.getByRole("button", { name: "Use pairing information", exact: true }).click();
  } else {
    await preparePairing(page, hub);
  }
  await page.getByRole("button", { name: en ? "Pair this device" : "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel(en ? "Pairing code" : "配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel(en ? "Pairing code" : "配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}

async function openChat(page: Page, title: string, width: number, en: boolean) {
  if (en && width <= 760) {
    const home = page.locator(".host-workspace:not([hidden]) .mobile-home");
    await home.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Message/ }).click();
    await home.locator(".mh-row").filter({ has: page.getByText(title, { exact: true }) }).click();
  } else {
    await selectConversation(page, title);
  }
}

for (const width of [390, 1360]) for (const en of [false, true]) {
  test(`Pi session controls: cross-provider search, defaultLabel, and accepted resync · ${width} · ${en ? "en" : "zh"}`, async ({ browser }, info) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-ui-controls-"));
    const stateDir = path.join(root, "bot");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", locale: en ? "en" : "zh" }));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
    await hub.profile.update({ name: "Demo Host", revision: (await hub.profile.read()).revision });
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_ui','Pi',?)", [hashSecret(secret)]);
    const gateway = await attachGateway({
      stateDir,
      url: hub.instanceUrl.replace("http", "ws") + "/instance",
      botId: "pi_ui",
      secret,
      engine: "pi",
      runtime: createCoreServiceRuntime(),
      bridge: { handleAuthorizedMessage: async () => ({ text: "Pi" }) },
    });
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: en ? "en-US" : "zh-CN", serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = [];
    const changes: PiSessionChange[] = [];
    page.on("pageerror", error => errors.push(error.message));

    const snapshot: PiSessionSnapshot = {
      supported: true,
      session: {
        token: "worker_v1",
        model: "anthropic/claude-sonnet",
        modelSource: "native",
        thinking: "high",
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        choices: [
          { id: "anthropic/claude-sonnet", provider: "anthropic", modelId: "claude-sonnet", label: "Claude Sonnet · anthropic", efforts: ["", "low", "medium", "high"] },
          { id: "openai/gpt-6.2-sol", provider: "openai", modelId: "gpt-6.2-sol", label: "GPT-6.2 Sol · openai", efforts: ["", "low", "medium", "high", "xhigh", "max"] },
          { id: "azure/gpt-6.2-sol", provider: "azure", modelId: "gpt-6.2-sol", label: "GPT-6.2 Sol · azure", efforts: ["", "low", "medium", "high", "xhigh", "max"] },
        ],
        busy: false,
        bridge: "connected",
        ui: { status: {}, widgets: {} },
      },
    };

    try {
      await hub.store.createConversation("owner", ["pi_ui"], "Pi UI fixture", "pi_ui_fixture");
      await page.route("**/api/conversations/*/pi-session*", async route => {
        if (route.request().method() === "GET") return route.fulfill({ json: snapshot });
        const command = route.request().postDataJSON() as PiSessionChange;
        changes.push(command);
        if (command.action === "model") {
          if (command.value === null) {
            // Bot default resolves to the same model currently running: value stays unchanged!
            snapshot.session!.modelSource = "bot-default";
          } else {
            snapshot.session!.model = command.value;
            snapshot.session!.modelSource = "session";
          }
        }
        // For thinking: null with no Bot effort, server keeps current thinking ("high") unchanged.
        return route.fulfill({ json: { outcome: "accepted" } });
      });

      await pairClient(page, hub, en);
      await openChat(page, "Pi UI fixture", width, en);

      const trigger = page.getByRole("button", { name: en ? "Pi conversation settings" : "Pi 对话设置", exact: true });
      await trigger.click();

      const search = page.getByLabel(en ? "Search models" : "搜索模型", { exact: true });
      const modelSelect = page.getByLabel(en ? "Model" : "模型", { exact: true });
      const applyModel = page.getByRole("button", { name: en ? "Apply model" : "应用模型", exact: true });
      const thinkingSelect = page.getByLabel(en ? "Pi conversation thinking level" : "Pi 对话思考强度", { exact: true });
      const applyThinking = page.getByRole("button", { name: en ? "Apply thinking level" : "应用思考强度", exact: true });
      const defaultLabel = en ? "Use Bot default" : "跟随 Bot 默认";

      // 1. Cross-provider search: while on anthropic, searching "gpt-6.2" must show BOTH openai & azure hits directly.
      await expect(modelSelect).toHaveValue("anthropic/claude-sonnet");
      await search.fill("gpt-6.2");
      const matchedTexts = await modelSelect.locator("option:not([disabled])").allTextContents();
      expect(matchedTexts).toEqual(["GPT-6.2 Sol · openai", "GPT-6.2 Sol · azure"]);

      // Also verify empty search result shows "No matching models" / "没有匹配的模型".
      await search.fill("nonexistent-model-xyz");
      await expect(page.getByText(en ? "No matching models" : "没有匹配的模型", { exact: true })).toBeVisible();

      // Search again, pick openai/gpt-6.2-sol, apply, and verify it succeeds.
      await search.fill("gpt-6.2");
      await modelSelect.selectOption("openai/gpt-6.2-sol");
      await expect(applyModel).toBeEnabled();
      await applyModel.click();
      await expect.poll(() => changes.length).toBe(1);
      expect(changes[0]).toMatchObject({ action: "model", value: "openai/gpt-6.2-sol" });
      await expect(page.getByText(en ? "Applied to this Pi conversation." : "已应用到当前 Pi 对话。", { exact: true })).toBeVisible();

      // Clear search -> returns to provider + model selects showing openai / openai/gpt-6.2-sol.
      await search.fill("");
      const providerSelect = page.getByLabel(en ? "Model provider" : "模型提供商", { exact: true });
      await expect(providerSelect).toHaveValue("openai");
      await expect(modelSelect).toHaveValue("openai/gpt-6.2-sol");

      // 2. Selecting "Use Bot default" / "跟随 Bot 默认" must NOT render a blank model option.
      await providerSelect.selectOption("");
      await expect(modelSelect).toBeDisabled();
      await expect(modelSelect).toHaveValue("");
      await expect(modelSelect.locator("option")).toHaveText([defaultLabel]);

      // Apply model = null where server resolves back to the SAME model ("openai/gpt-6.2-sol"):
      // draft must resync back to "openai/gpt-6.2-sol" instead of staying stuck at "".
      await expect(applyModel).toBeEnabled();
      await applyModel.click();
      await expect.poll(() => changes.length).toBe(2);
      expect(changes[1]).toMatchObject({ action: "model", value: null });
      await expect(providerSelect).toHaveValue("openai");
      await expect(modelSelect).toHaveValue("openai/gpt-6.2-sol");
      await expect(applyModel).toBeDisabled();

      // 3. Accepted thinking = null (Bot has no default effort, server keeps "high") must resync thinking back to "high"
      //    WITHOUT clobbering an unsaved model edit on the other control.
      await providerSelect.selectOption("azure");
      await expect(modelSelect).toHaveValue("azure/gpt-6.2-sol");
      await thinkingSelect.selectOption("");
      await expect(applyThinking).toBeEnabled();
      await applyThinking.click();
      await expect.poll(() => changes.length).toBe(3);
      expect(changes[2]).toMatchObject({ action: "thinking", value: null });
      await expect(thinkingSelect).toHaveValue("high");
      await expect(applyThinking).toBeDisabled();
      // Unsaved model edit must still be preserved!
      await expect(providerSelect).toHaveValue("azure");
      await expect(modelSelect).toHaveValue("azure/gpt-6.2-sol");

      // 4. Symmetric check: unsaved thinking edit must NOT be clobbered when applying a model change that changes session.model.
      await thinkingSelect.selectOption("low");
      await expect(applyModel).toBeEnabled();
      await applyModel.click();
      await expect.poll(() => changes.length).toBe(4);
      expect(changes[3]).toMatchObject({ action: "model", value: "azure/gpt-6.2-sol" });
      await expect(modelSelect).toHaveValue("azure/gpt-6.2-sol");
      await expect(applyModel).toBeDisabled();
      await expect(thinkingSelect).toHaveValue("low");

      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`pi-ui-controls-${width}-${en ? "en" : "zh"}.png`), fullPage: true });
    } finally {
      await context.close();
      await gateway.disconnect();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const en of [false, true]) {
  test(`Pi ComposerModelControls exposes refresh on no-models and unavailable · ${en ? "en" : "zh"}`, async ({ browser }, info) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-composer-refresh-"));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
    await hub.profile.update({ name: "Demo Host", revision: (await hub.profile.read()).revision });
    const gateways = [];
    for (const [id, engine] of [["pi_bot", "pi"], ["other_bot", "claude"]] as const) {
      const stateDir = path.join(root, id);
      const secret = randomBytes(32).toString("base64url");
      await mkdir(stateDir);
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale: en ? "en" : "zh" }));
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, hashSecret(secret)]);
      gateways.push(await attachGateway({
        stateDir,
        url: hub.instanceUrl.replace("http", "ws") + "/instance",
        botId: id,
        secret,
        engine,
        runtime: createCoreServiceRuntime(),
        bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) },
      }));
    }
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: en ? "en-US" : "zh-CN", serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));

    let reads = 0;
    let savedPayload: unknown;
    const rev = (n: number) => String(n).repeat(64);
    const responses: ModelSettings[] = [
      {
        scope: "bot", revision: rev(1), engine: "pi", model: "", effort: "",
        choices: [{ id: "", efforts: [""] }], customEfforts: [""], activeTurns: 0, catalogStatus: "no-models",
      },
      {
        scope: "bot", revision: rev(2), engine: "pi", model: "", effort: "",
        choices: [{ id: "", efforts: [""] }], customEfforts: [""], activeTurns: 0, catalogStatus: "unavailable",
      },
      {
        scope: "bot", revision: rev(3), engine: "pi", model: "", effort: "",
        choices: [
          { id: "", label: "GPT-6.2 Sol · openai", efforts: ["", "low", "medium", "high", "xhigh", "max"] },
          { id: "openai/gpt-6.2-sol", provider: "openai", modelId: "gpt-6.2-sol", label: "GPT-6.2 Sol · openai", efforts: ["", "low", "medium", "high", "xhigh", "max"] },
          { id: "anthropic/claude-sonnet", provider: "anthropic", modelId: "claude-sonnet", label: "Claude Sonnet · anthropic", efforts: ["", "low", "medium", "high"] },
        ],
        customEfforts: [""], activeTurns: 0, catalogStatus: "ready",
      },
    ];

    try {
      // Group chat targeting pi_bot renders ComposerModelControls for Pi on desktop.
      await hub.store.createConversation("owner", ["pi_bot", "other_bot"], "Pi group quick menu", "pi_group_quick", { type: "group" });
      await page.route("**/api/bots/pi_bot/model", async route => {
        if (route.request().method() === "GET") {
          const payload = responses[Math.min(reads, responses.length - 1)]!;
          reads++;
          return route.fulfill({ json: payload });
        }
        savedPayload = route.request().postDataJSON();
        const latest = responses[responses.length - 1]!;
        return route.fulfill({ json: { ...latest, revision: rev(4), model: (savedPayload as { model: string }).model, effort: (savedPayload as { effort: string }).effort } });
      });

      await pairClient(page, hub, en);
      await selectConversation(page, "Pi group quick menu");

      // Select pi_bot as recipient so ComposerModelControls targets pi_bot.
      await page.locator(".host-workspace:not([hidden]) .composer-recipients").click();
      await page.getByRole("group", { name: en ? "Bots to reply" : "回复的 Bot", exact: true }).getByRole("checkbox", { name: "pi_bot", exact: true }).click();
      await page.locator(".host-workspace:not([hidden]) .composer-recipients").click();

      const group = page.locator(".host-workspace:not([hidden]) .composer-model-controls");
      const modelTrigger = group.getByRole("button", { name: en ? /^Model settings:/ : /^模型设置：/ });
      await modelTrigger.click();

      const menu = page.getByRole("group", { name: en ? "Quick model selection" : "快捷选择模型", exact: true });
      const refreshBtn = menu.getByRole("button", { name: en ? "Refresh setting" : "重新读取", exact: true });

      // 1. catalogStatus: "no-models" -> shows pi auth login notice AND refresh button.
      await expect(menu.getByRole("status").filter({ hasText: "pi auth login" })).toBeVisible();
      await expect(refreshBtn).toBeVisible();
      await expect(refreshBtn).toBeEnabled();

      // 2. Click refresh -> catalogStatus: "unavailable" -> shows unavailable notice AND refresh button remains available.
      await refreshBtn.click();
      await expect.poll(() => reads).toBe(2);
      await expect(menu.getByRole("status").filter({ hasText: en ? "Pi models could not be loaded" : "暂未读取到 Pi 模型列表" })).toBeVisible();
      await expect(refreshBtn).toBeVisible();
      await expect(refreshBtn).toBeEnabled();

      // 3. Click refresh -> catalogStatus: "ready" -> notice & refresh button disappear, models appear and can be selected.
      await refreshBtn.click();
      await expect.poll(() => reads).toBe(3);
      await expect(refreshBtn).toHaveCount(0);
      await menu.getByRole("button", { name: /^GPT-6\.2 Sol · openai / }).click();
      await expect(menu).toHaveCount(0);
      expect(savedPayload).toMatchObject({ revision: rev(3), model: "openai/gpt-6.2-sol", effort: "" });

      // 4. Effort quick menu also exposes refresh when catalogStatus is "unavailable" and recovers levels on click.
      reads = 1; // responses[1] is "unavailable", responses[2] is "ready"
      const effortTrigger = group.getByRole("button", { name: en ? /^Reasoning effort:/ : /^思考强度：/ });
      await effortTrigger.click();
      const effortMenu = page.getByRole("group", { name: en ? "Quick reasoning effort" : "快捷选择思考强度", exact: true });
      const effortRefresh = effortMenu.getByRole("button", { name: en ? "Refresh setting" : "重新读取", exact: true });
      await expect(effortRefresh).toBeVisible();
      await effortRefresh.click();
      await expect.poll(() => reads).toBe(3);
      await expect(effortRefresh).toHaveCount(0);
      await expect(effortMenu.getByRole("button", { name: "high", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(effortMenu).toHaveCount(0);

      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`pi-composer-refresh-${en ? "en" : "zh"}.png`), fullPage: true });
    } finally {
      await context.close();
      for (const gw of gateways) await gw.disconnect();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const width of [390, 1360]) for (const en of [false, true]) {
  test(`Pi session controls: null default rejected/invalid shows clear copy and stays recoverable · ${width} · ${en ? "en" : "zh"}`, async ({ browser }, info) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-null-reject-"));
    const stateDir = path.join(root, "bot");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", effort: "off", locale: en ? "en" : "zh" }));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
    await hub.profile.update({ name: "Demo Host", revision: (await hub.profile.read()).revision });
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_null','Pi',?)", [hashSecret(secret)]);
    const gateway = await attachGateway({
      stateDir,
      url: hub.instanceUrl.replace("http", "ws") + "/instance",
      botId: "pi_null",
      secret,
      engine: "pi",
      effort: "off",
      runtime: createCoreServiceRuntime(),
      bridge: { handleAuthorizedMessage: async () => ({ text: "Pi" }) },
    });
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: en ? "en-US" : "zh-CN", serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = [];
    const changes: PiSessionChange[] = [];
    page.on("pageerror", error => errors.push(error.message));

    const snapshot: PiSessionSnapshot = {
      supported: true,
      session: {
        token: "worker_160",
        model: "openai/gpt-6.2-sol",
        modelSource: "session",
        thinking: "high",
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        choices: [
          { id: "openai/gpt-6.2-sol", provider: "openai", modelId: "gpt-6.2-sol", label: "GPT-6.2 Sol · openai", efforts: ["", "low", "medium", "high", "xhigh", "max"] },
          { id: "azure/gpt-6.2-sol", provider: "azure", modelId: "gpt-6.2-sol", label: "GPT-6.2 Sol · azure", efforts: ["", "low", "medium", "high", "xhigh", "max"] },
        ],
        busy: false,
        bridge: "connected",
        ui: { status: {}, widgets: {} },
      },
    };
    let rejectNullThinking = true;
    let rejectNullModel = true;

    try {
      await hub.store.createConversation("owner", ["pi_null"], "Pi null reject fixture", "pi_null_reject");
      await page.route("**/api/conversations/*/pi-session*", async route => {
        if (route.request().method() === "GET") return route.fulfill({ json: snapshot });
        const command = route.request().postDataJSON() as PiSessionChange;
        changes.push(command);
        if (command.action === "thinking" && command.value === null && rejectNullThinking) {
          return route.fulfill({ json: { outcome: "rejected", reason: "invalid" } });
        }
        if (command.action === "model" && command.value === null && rejectNullModel) {
          return route.fulfill({ json: { outcome: "rejected", reason: "invalid" } });
        }
        if (command.action === "thinking") {
          snapshot.session!.thinking = command.value ?? "medium";
        } else if (command.action === "model") {
          snapshot.session!.model = command.value ?? "azure/gpt-6.2-sol";
          snapshot.session!.modelSource = command.value ? "session" : "bot-default";
        }
        return route.fulfill({ json: { outcome: "accepted" } });
      });

      await pairClient(page, hub, en);
      await openChat(page, "Pi null reject fixture", width, en);

      const trigger = page.getByRole("button", { name: en ? "Pi conversation settings" : "Pi 对话设置", exact: true });
      await trigger.click();

      const providerSelect = page.getByLabel(en ? "Model provider" : "模型提供商", { exact: true });
      const modelSelect = page.getByLabel(en ? "Model" : "模型", { exact: true });
      const applyModel = page.getByRole("button", { name: en ? "Apply model" : "应用模型", exact: true });
      const thinkingSelect = page.getByLabel(en ? "Pi conversation thinking level" : "Pi 对话思考强度", { exact: true });
      const applyThinking = page.getByRole("button", { name: en ? "Apply thinking level" : "应用思考强度", exact: true });
      const checkBtn = page.getByRole("button", { name: en ? "Check change result" : "核对修改结果", exact: true });
      const alert = page.locator(".pi-session-panel [role=alert]");

      // 1. Thinking -> Use Bot default (null) rejected/invalid (e.g. Bot effort "off" unsupported on gpt-6.2-sol).
      await thinkingSelect.selectOption("");
      await applyThinking.click();
      await expect.poll(() => changes.length).toBe(1);
      expect(changes[0]).toMatchObject({ action: "thinking", value: null });
      await expect(alert).toHaveText(
        en
          ? "The Bot default thinking level is not supported by the current model. Choose an available level, or update the Bot default and retry."
          : "Bot 默认思考强度不适用于当前对话模型。请选择可用档位，或调整 Bot 默认设置后重试。",
      );
      await expect(checkBtn).toHaveCount(0);
      await expect(thinkingSelect).toBeEnabled();
      await expect(applyThinking).toBeEnabled();

      // User can immediately pick another valid thinking level, or retry default once fixed.
      await thinkingSelect.selectOption("low");
      await applyThinking.click();
      await expect.poll(() => changes.length).toBe(2);
      await expect(alert).toHaveCount(0);
      await expect(thinkingSelect).toHaveValue("low");

      rejectNullThinking = false;
      await thinkingSelect.selectOption("");
      await applyThinking.click();
      await expect.poll(() => changes.length).toBe(3);
      await expect(thinkingSelect).toHaveValue("medium");
      await expect(applyThinking).toBeDisabled();

      // 2. Model -> Use Bot default (null) rejected/invalid (e.g. Bot default model retired/unavailable).
      await providerSelect.selectOption("");
      await applyModel.click();
      await expect.poll(() => changes.length).toBe(4);
      expect(changes[3]).toMatchObject({ action: "model", value: null });
      await expect(alert).toHaveText(
        en
          ? "The Bot or Pi default model is unavailable right now. Choose an available model, or check provider sign-in and Bot defaults and retry."
          : "Bot 默认模型或 Pi 默认模型当前不可用。请选择可用模型，或检查提供商登录与 Bot 默认设置后重试。",
      );
      await expect(checkBtn).toHaveCount(0);
      await expect(providerSelect).toBeEnabled();
      await expect(applyModel).toBeEnabled();

      // User can retry default once Bot default becomes available and controls resync cleanly.
      rejectNullModel = false;
      await applyModel.click();
      await expect.poll(() => changes.length).toBe(5);
      await expect(alert).toHaveCount(0);
      await expect(providerSelect).toHaveValue("azure");
      await expect(modelSelect).toHaveValue("azure/gpt-6.2-sol");
      await expect(applyModel).toBeDisabled();

      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`pi-null-reject-${width}-${en ? "en" : "zh"}.png`), fullPage: true });
    } finally {
      await context.close();
      await gateway.disconnect();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const en of [false, true]) {
  test(`Pi session controls: a refusal says why when the Host names the reason, and keeps the old copy when it does not · ${en ? "en" : "zh"}`, async ({ browser }, info) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-reject-reason-"));
    const stateDir = path.join(root, "bot");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", effort: "high", locale: en ? "en" : "zh" }));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
    await hub.profile.update({ name: "Demo Host", revision: (await hub.profile.read()).revision });
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_reason','Pi',?)", [hashSecret(secret)]);
    const gateway = await attachGateway({
      stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "pi_reason", secret, engine: "pi", effort: "high",
      runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "Pi" }) },
    });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: en ? "en-US" : "zh-CN", serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = [], posts: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const snapshot: PiSessionSnapshot = { supported: true, session: {
      token: "worker_reason", model: "deepseek/deepseek-v4-pro", modelSource: "session", thinking: "high", thinkingLevels: ["off", "high", "max"],
      choices: [
        { id: "deepseek/deepseek-v4-pro", provider: "deepseek", modelId: "deepseek-v4-pro", label: "DeepSeek V4 Pro · deepseek", efforts: ["", "off", "high", "max"] },
        { id: "deepseek/deepseek-v4-flash", provider: "deepseek", modelId: "deepseek-v4-flash", label: "DeepSeek V4 Flash · deepseek", efforts: ["", "off", "high", "max"] },
      ],
      busy: false, bridge: "connected", ui: { status: {}, widgets: {} },
    } };
    // What the Host answers next: the reason a current Host gives, then the bare answer of an older one.
    const answers = [
      { outcome: "rejected", reason: "invalid", detail: { kind: "thinking_unsupported", allowed: ["off", "high", "max"] } },
      { outcome: "rejected", reason: "invalid", detail: { kind: "model_not_found" } },
      { outcome: "rejected", reason: "invalid" },
    ];
    try {
      await hub.store.createConversation("owner", ["pi_reason"], "Pi reason fixture", "pi_reason_fixture");
      await page.route("**/api/conversations/*/pi-session*", async route => {
        if (route.request().method() === "GET") return route.fulfill({ json: snapshot });
        posts.push(route.request().url());
        return route.fulfill({ json: answers.shift() ?? { outcome: "accepted" } });
      });
      await pairClient(page, hub, en);
      await openChat(page, "Pi reason fixture", 1360, en);
      await page.getByRole("button", { name: en ? "Pi conversation settings" : "Pi 对话设置", exact: true }).click();
      const thinkingSelect = page.getByLabel(en ? "Pi conversation thinking level" : "Pi 对话思考强度", { exact: true });
      const applyThinking = page.getByRole("button", { name: en ? "Apply thinking level" : "应用思考强度", exact: true });
      const modelSelect = page.getByLabel(en ? "Model" : "模型", { exact: true });
      const applyModel = page.getByRole("button", { name: en ? "Apply model" : "应用模型", exact: true });
      const alert = page.locator(".pi-session-panel [role=alert]");

      await thinkingSelect.selectOption("off");
      await applyThinking.click();
      await expect(alert).toHaveText(en ? "The current model does not offer this thinking level. Available: off, high, max." : "当前模型不支持这个思考强度。可选：off、high、max。");
      expect(posts.at(-1)).toContain("detail=1");

      await modelSelect.selectOption("deepseek/deepseek-v4-flash");
      await applyModel.click();
      await expect(alert).toHaveText(en
        ? "Provider deepseek is signed in but has no model deepseek/deepseek-v4-flash. Reload and choose again."
        : "提供商 deepseek 已登录，但没有 deepseek/deepseek-v4-flash 这个模型。请重新读取后选择。");

      await thinkingSelect.selectOption("max");
      await applyThinking.click();
      await expect(alert).toHaveText(en ? "This choice is unavailable for the current model. Refresh to check." : "当前模型不支持这个选择，请重新读取。");
      expect(errors).toEqual([]);
      await page.screenshot({ path: info.outputPath(`pi-reject-reason-${en ? "en" : "zh"}.png`), fullPage: true });
    } finally {
      await context.close();
      await gateway.disconnect();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Pi Bot default dialogs: a refusal keeps naming what was refused after the form changes · zh", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-default-refusal-"));
  const stateDir = path.join(root, "bot");
  await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "Demo Host", revision: (await hub.profile.read()).revision });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_default','Pi',?)", [hashSecret(secret)]);
  const gateway = await attachGateway({
    stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "pi_default", secret, engine: "pi",
    runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "Pi" }) },
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const revision = "1".repeat(64);
  const model: ModelSettings = {
    scope: "bot", revision, engine: "pi", model: "", effort: "", customEfforts: [""], activeTurns: 0, catalogStatus: "ready",
    choices: [
      { id: "", efforts: [""] },
      { id: "anthropic/claude-sonnet", provider: "anthropic", modelId: "claude-sonnet", label: "Claude Sonnet · anthropic", efforts: ["", "low", "high"] },
      { id: "deepseek/deepseek-v4-pro", provider: "deepseek", modelId: "deepseek-v4-pro", label: "DeepSeek V4 Pro · deepseek", efforts: ["", "off", "high"] },
    ],
  };
  let effortEntry = false;
  try {
    await hub.store.createConversation("owner", ["pi_default"], "Pi default refusal", "pi_default_refusal");
    await page.route("**/api/bots/pi_default/model", route => route.request().method() === "GET"
      ? route.fulfill({ json: effortEntry ? { ...model, model: "anthropic/claude-sonnet" } : model })
      : route.fulfill({ status: 409, json: { error: effortEntry ? "model_effort_incompatible" : "model_unavailable" } }));
    await pairClient(page, hub, false);
    await openChat(page, "Pi default refusal", 1360, false);
    await openBotSettings(page);

    await page.getByRole("button", { name: "调整 Bot 模型", exact: true }).click();
    await page.getByRole("button", { name: "自定义模型…", exact: true }).click();
    await page.getByLabel("模型 ID", { exact: true }).fill("deepseek/deepseek-v9");
    await page.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    const refusedModel = "提供商 deepseek 已登录，但 Pi 的模型目录里没有 deepseek/deepseek-v9。请从列表选择，或检查模型 ID。";
    const alert = page.locator(".effort-settings [role=alert]");
    await expect(alert).toHaveText(refusedModel);
    // The owner picks a listed model without saving: the alert still names the refused one.
    await page.getByRole("button", { name: "从列表选择模型", exact: true }).click();
    await page.getByLabel("模型提供商", { exact: true }).selectOption("anthropic");
    await expect(page.getByLabel("模型", { exact: true })).toHaveValue("anthropic/claude-sonnet");
    await expect(alert).toHaveText(refusedModel);
    await page.getByRole("button", { name: "关闭模型设置", exact: true }).click();

    effortEntry = true;
    await page.getByRole("button", { name: "调整 Bot 思考强度", exact: true }).click();
    const level = page.getByLabel("模型思考强度", { exact: true });
    await level.selectOption("high");
    await page.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    // The refused level is not offered back as available.
    const refusedLevel = "当前模型不支持思考强度 high。可选：low，或跟随默认。";
    await expect(alert).toHaveText(refusedLevel);
    await level.selectOption("low");
    await expect(alert).toHaveText(refusedLevel);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("pi-default-refusal-zh.png"), fullPage: true });
  } finally {
    await context.close();
    await gateway.disconnect();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
