import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { pairingLink } from "../src/pairing-link.js";
import { fixtureInvitation, preparePairing } from "./fixtures/pairing-invite.js";
import { permissionOptions } from "../../src/state/permission-options.js";
import type { BotCatalog } from "../../src/client-protocol/bots.js";
import { parsePiModels } from "../../src/codex/pi-models.js";
import { initializeHost } from "../../src/host-cli/setup.js";

async function pair(page: Page, hub: HubServer, english: boolean) {
  await page.goto(hub.url);
  if (english) {
    const invitation = await fixtureInvitation(hub);
    await page.getByRole("button", { name: "Paste connection details", exact: true }).click();
    await page.getByLabel("Pairing information", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
    await page.getByRole("button", { name: "Use pairing information", exact: true }).click();
  } else await preparePairing(page, hub);
  await page.getByRole("button", { name: english ? "Pair this device" : "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel(english ? "Pairing code" : "配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel(english ? "Pairing code" : "配对码", { exact: true }).waitFor({ state: "hidden" });
}
test.use({ actionTimeout: 15_000 });
const models = [
  { id: "", label: "Same model · alpha", efforts: ["", "off", "minimal", "high", "max"] },
  ...parsePiModels([
    { provider: "alpha", id: "org/model:latest", name: "Same model", reasoning: true, thinkingLevelMap: { max: "max" } },
    { provider: "alpha", id: "org/model:v2", name: "Same model", reasoning: true },
  ]),
  { id: "beta/org/model:latest", provider: "beta", modelId: "org/model:latest", label: "Same model · beta", efforts: ["", "off"] },
];
for (const width of [390, 1360]) for (const english of [false, true]) {
  test(`Pi provider selection, reasoning and ordinary-only role · ${width} · ${english ? "en" : "zh"}`, async ({ browser }, info) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-pi-ui-"));
    await initializeHost(root, "Demo Host");
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: english ? "en-US" : "zh-CN", serviceWorkers: "block" });
    const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const catalog: BotCatalog = { engines: [
      { id: "codex", available: true, models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" },
      { id: "pi", available: true, models, defaultModel: "", defaultEffort: "", catalogStatus: "ready", permissions: { defaultChoice: "bypass", choices: permissionOptions("pi") } },
    ] };
    try {
      await pair(page, hub, english);
      await page.route("**/api/bots/catalog*", route => route.fulfill({ json: catalog }));
      await page.getByRole("button", { name: english ? "New" : "新建", exact: true }).filter({ visible: true }).click();
      await page.getByRole("menuitem", { name: english ? "New Bot" : "新建 Bot", exact: true }).or(page.getByRole("button", { name: english ? "New Bot" : "新建 Bot", exact: true })).filter({ visible: true }).click();
      const engine = page.getByLabel(english ? "Engine" : "引擎", { exact: true });
      await expect(engine).toHaveValue("codex");
      const chief = page.getByRole("checkbox", { name: english ? "Make it a Superagent" : "作为幕僚长", exact: true });
      await expect(chief).toBeVisible(); await chief.check();
      await engine.selectOption("pi"); await expect(chief).toHaveCount(0);
      const provider = page.getByLabel(english ? "Model provider" : "模型提供商", { exact: true });
      const model = page.getByLabel(english ? "Model" : "模型", { exact: true });
      const effort = page.getByLabel(english ? "Reasoning effort" : "推理强度（effort）", { exact: true });
      await expect(model).toBeDisabled(); await provider.selectOption("alpha");
      await expect(model.locator("option")).toHaveText(["Same model (org/model:latest)", "Same model (org/model:v2)"]);
      await expect(model).toHaveValue("alpha/org/model:latest"); await effort.selectOption("max");
      await provider.selectOption("beta"); await expect(model).toHaveValue("beta/org/model:latest");
      await expect(effort).toHaveValue(""); await expect(effort.locator("option")).toHaveCount(2);
      await expect(model.locator("option")).toHaveText(["Same model"]);
      await effort.selectOption("off");
      await page.getByRole("button", { name: english ? "Refresh models" : "重新读取模型", exact: true }).click();
      await expect(model).toHaveValue("beta/org/model:latest"); await expect(effort).toHaveValue("off");
      // A fresh native auth/catalog read must not silently replace the user's choice.
      catalog.engines[1]!.catalogStatus = "no-models"; catalog.engines[1]!.models = [{ id: "", efforts: [""] }];
      await page.getByRole("button", { name: english ? "Refresh models" : "重新读取模型", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "pi auth login" })).toBeVisible();
      await expect(page.getByRole("button", { name: english ? "Create Bot" : "创建 Bot", exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath("pi-new-bot.png"), fullPage: true });
      await engine.selectOption("codex"); await expect(chief).not.toBeChecked();
      expect(errors).toEqual([]);
    } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
}
