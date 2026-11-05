import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { GatewayTransport } from "../../src/gateway/transport.js";
import { GatewayChannel } from "../../src/gateway/channel.js";
import { mobileHome, openMobileHome, selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";

test("model logos follow real Gateway configuration updates on desktop and phone, then survive offline reload", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "model-brands-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const dc = await browser.newContext(), pc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await dc.newPage(), phone = await pc.newPage();
  const configDir = path.join(root, "agy"), secret = randomBytes(32).toString("base64url");
  const transport = new GatewayTransport({ stateDir: configDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "agy", secret, engine: "antigravity" });
  const channel = new GatewayChannel(transport);
  const saveModel = (model: string) => writeFile(path.join(configDir, "config.json"), JSON.stringify({ engine: "antigravity", model }));
  const cases = [["gpt", "GG1", "codex", "gpt-6-astra", "openai"], ["claude", "CC1", "claude", "claude-opus-5-5", "claude"], ["fable", "FABLE5", "claude", "fable", "claude"], ["agy", "Aa1", "antigravity", "gemini-3.7-pro", "gemini"], ["ds", "pp1", "deepseek", "deepseek-chat", "deepseek"], ["kimi", "kk1", "kimi", "kimi-code/k3", "kimi"], ["alias", "自定义模型助手", "claude", "private-alias", ""]];
  try {
    await mkdir(configDir); await saveModel("gemini-3.7-pro");
    for (const [id, name, engine, model] of cases) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model) VALUES(?,?,?,?,?)", [id!, name!, hashSecret(secret), engine!, model!]);
      await hub.store.createConversation("owner", [id!], `${name} 的日常对话`, `chat_${id}`);
    }
    await hub.store.createConversation("owner", ["gpt", "claude"], "一起讨论", "group", { type: "group" });
    channel.on("message", async message => { if (message.content.startsWith("/model ")) { await saveModel(message.content.slice(7)); await channel.send(message.chatId, { text: "模型设置已更新" }); } });
    await channel.connect();
    for (const page of [desktop, phone]) {
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
      // Only AGY has a live Gateway; the other brands are cached Bot fixtures.
      await showDisconnectedBots(page);
    }
    for (const [id, , , , brand] of cases) for (const page of [desktop, phone]) {
      const name = page.locator(`[data-bot-name="${id}"]`).filter({ visible: true }).first();
      if (brand) await expect(name).toHaveAttribute("data-model-brand", brand); else await expect(name.locator(".bot-brand-icon")).toHaveCount(0);
      if (brand) {
        const label = (await name.locator('.bot-name-label').boundingBox())!, mark = (await name.locator('.bot-brand-icon').boundingBox())!;
        expect(mark.x - label.x - label.width).toBeGreaterThanOrEqual(5);
      }
    }
    await expect(mobileHome(phone).locator('.mh-row').filter({ hasText: "一起讨论" }).locator('.bot-brand-icon')).toHaveCount(0);
    // A very long Bot name must preserve a readable mark and ellipsize its label.
    await hub.store.db.run("UPDATE bots SET name=? WHERE id='gpt'", ["研究与项目进度跟踪的 OpenAI 长名称助手"]);
    await phone.reload(); await waitForClientOnline(phone);
    await desktop.screenshot({ path: info.outputPath("brands-desktop.png"), animations: "disabled" });
    await phone.screenshot({ path: info.outputPath("brands-phone.png"), animations: "disabled" });
    await selectConversation(desktop, "Aa1 的日常对话"); await selectConversation(phone, "Aa1 的日常对话");
    await expect(phone.locator('.header-bot-name')).toHaveCount(0);
    // The hidden inbox intentionally pauses rendering; observe model updates
    // on the visible phone list now that the chat header has no model mark.
    await openMobileHome(phone);
    for (const [model, brand] of [["claude-opus-5-5", "claude"], ["openai/gpt-6-astra", "openai"], ["sol", "openai"], ["luna", "openai"], ["sonnet", "claude"], ["haiku", "claude"], ["private-alias", ""], ["gemini-3.7-pro", "gemini"], ["Fable5", "claude"]]) {
      await desktop.getByRole("textbox", { name: "消息", exact: true }).fill(`/model ${model}`);
      await desktop.getByRole("button", { name: "发送消息", exact: true }).click();
      for (const page of [desktop, phone]) {
        const name = page === phone ? mobileHome(phone).locator('[data-bot-name="agy"]').first() : desktop.locator('.header-bot-name [data-bot-name="agy"]');
        if (brand) await expect(name).toHaveAttribute("data-model-brand", brand); else await expect(name.locator(".bot-brand-icon")).toHaveCount(0);
      }
      const sidebarName = desktop.locator('.bot-tree[data-bot-id="agy"] [data-bot-name="agy"]');
      if (brand) await expect(sidebarName).toHaveAttribute('data-model-brand', brand); else await expect(sidebarName.locator('.bot-brand-icon')).toHaveCount(0);
    }
    await selectConversation(phone, 'Aa1 的日常对话');
    await expect(phone.locator('.header-bot-name')).toHaveCount(0);
    await expect(phone.locator('.message-meta .bot-brand-icon')).toHaveCount(0);
    await phone.screenshot({ path: info.outputPath('brands-chat-header.png'), animations: 'disabled' });
    // The display option belongs to this device, survives reload and collapses
    // the mark's slot. A second device keeps its own preference.
    await openSettings(phone);
    const toggle = phone.getByRole('switch', { name: '显示模型图标', exact: true });
    await expect(toggle).toBeChecked(); await toggle.click(); await expect(toggle).not.toBeChecked();
    expect((await toggle.locator('.model-brand-toggle-track').boundingBox())!.width).toBe(36);
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toggle.scrollIntoViewIfNeeded();
    await phone.screenshot({ path: info.outputPath('brands-setting-phone.png'), animations: 'disabled' });
    await closeSettings(phone); await selectConversation(phone, 'Aa1 的日常对话');
    await expect(phone.locator('.header-bot-name')).toHaveCount(0);
    await openMobileHome(phone);
    await expect(mobileHome(phone).locator('[data-bot-name="agy"]').first()).toHaveCSS('gap', '0px');
    await expect(desktop.locator('.header-bot-name .bot-brand-icon')).toBeVisible();
    await phone.reload(); await waitForClientOnline(phone);
    await expect(phone.locator('.bot-brand-icon:visible')).toHaveCount(0);
    await openSettings(phone); await expect(toggle).not.toBeChecked(); await toggle.click(); await closeSettings(phone);
    await openSettings(desktop);
    const desktopToggle = desktop.getByRole('switch', { name: '显示模型图标', exact: true });
    await desktopToggle.focus(); await desktopToggle.press('Space'); await expect(desktopToggle).not.toBeChecked();
    await closeSettings(desktop); await desktop.reload(); await waitForClientOnline(desktop);
    await expect(desktop.locator('.bot-brand-icon:visible')).toHaveCount(0);
    await openSettings(desktop); await expect(desktopToggle).not.toBeChecked(); await desktopToggle.click(); await closeSettings(desktop);
    await openMobileHome(phone);
    await mobileHome(phone).getByRole('navigation', { name: '主导航' }).getByRole('button', { name: 'Bot', exact: true }).click();
    const botMark = mobileHome(phone).locator('.mh-bot-row [data-bot-name="gpt"] .bot-brand-icon');
    // The existing porcelain theme normalizes model marks to 12px.
    await expect(botMark).toBeVisible(); await expect(botMark).toHaveCSS('width', '12px');
    await phone.screenshot({ path: info.outputPath('brands-bot-directory.png'), animations: 'disabled' });
    await mobileHome(phone).getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^消息/ }).click();
    await expect(mobileHome(phone).locator('.mh-bot-row')).toHaveCount(0);
    // Narrow layouts across every requested visual style, both appearances.
    await phone.setViewportSize({ width: 320, height: 740 });
    for (const palette of ["white-green", "mono", "cli"]) for (const theme of ["light", "dark"]) {
      await phone.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const mark = mobileHome(phone).locator('.bot-brand-icon').first();
      await expect(mark).toBeVisible(); expect((await mark.boundingBox())!.width).toBe(12);
      const longName = mobileHome(phone).locator('[data-bot-name="gpt"]');
      expect((await longName.locator('.bot-brand-icon').boundingBox())!.width).toBe(12);
      expect(await longName.locator('.bot-name-label').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      const labelBox = (await longName.locator('.bot-name-label').boundingBox())!, markBox = (await longName.locator('.bot-brand-icon').boundingBox())!;
      expect(markBox.x - labelBox.x - labelBox.width).toBeGreaterThanOrEqual(5);
      await expect(longName.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await phone.screenshot({ path: info.outputPath(`brands-${palette}-${theme}-320.png`), animations: "disabled" });
    }
    await phone.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => phone.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await channel.disconnect(); await hub.close(); await phone.reload({ waitUntil: "domcontentloaded" });
    await expect(mobileHome(phone).locator('[data-bot-name="agy"]')).toHaveAttribute("data-model-brand", "claude");
  } finally { await dc.close(); await pc.close(); await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
