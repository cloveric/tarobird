import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { saveDispatcherSettingsInTransaction } from "../../src/hub/dispatch.js";
import type { DispatcherSettings } from "../../src/client-protocol/dispatch.js";
import { isPhone, mobileHome, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const clientDir = () => path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist");
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
}
/** Codex and Claude are installed on the Host; Kimi, DeepSeek and Antigravity are not. */
async function start(settings: DispatcherSettings) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatcher-allowlist-")), missing = path.join(root, "missing-cli");
  const hub = await HubServer.start({ stateDir: root, clientDir: clientDir(), managedBots: { entrypoint: path.resolve("../tests/fixtures/managed-bot-worker.mjs"),
    env: { ...process.env, CODEX_EXECUTABLE: process.execPath, CLAUDE_EXECUTABLE: process.execPath, KIMI_EXECUTABLE: missing, DSH_EXECUTABLE: missing, ANTIGRAVITY_EXECUTABLE: missing } } });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('disp','调度员','fixture','codex','dispatcher')");
  await saveDispatcherSettingsInTransaction(hub.store.db, "disp", settings);
  return { root, hub };
}
async function openSettings(page: Page) {
  if (isPhone(page)) {
    await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "Bot", exact: true }).click();
    await page.getByRole("button", { name: "调度员 的 Bot 设置", exact: true }).click();
  } else {
    await page.locator('.bot-tree[data-bot-id="disp"] .bot-identity').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Bot 设置", exact: true }).click();
  }
  await page.getByRole("button", { name: "设置幕僚长", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "幕僚长设置", exact: true });
  // The form appears once the Host catalog has probed every engine CLI.
  await expect(editor.getByLabel("派活方式", { exact: true })).toBeVisible({ timeout: 30_000 });
  return editor;
}
async function openEditor(page: Page, hub: HubServer) {
  await pair(page, hub); await showDisconnectedBots(page); await waitForClientOnline(page);
  return openSettings(page);
}
const save = async (editor: ReturnType<Page["getByRole"]>) => {
  await editor.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
  await expect(editor.getByText("幕僚长设置已保存。", { exact: true })).toBeVisible();
};

test("saving other dispatcher settings keeps an allowlist that names an uninstalled CLI", async ({ page }) => {
  const { root, hub } = await start({ allowedEngines: ["kimi"], mode: "ask", maxConcurrent: 2 });
  try {
    const editor = await openEditor(page, hub);
    await editor.getByLabel("派活方式", { exact: true }).selectOption("auto");
    await save(editor);
    expect((await hub.dispatch.settings("owner", "disp")).settings).toEqual({ allowedEngines: ["kimi"], mode: "auto", maxConcurrent: 2 });
    // The allowed CLI stays visible while it is missing; installed CLIs are not added.
    await expect(editor.getByRole("checkbox", { name: "Kimi（未安装）", exact: true })).toBeChecked();
    await expect(editor.getByRole("checkbox", { name: "Codex", exact: true })).not.toBeChecked();
    await expect(editor.getByRole("checkbox", { name: "Claude", exact: true })).not.toBeChecked();
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ticking every installed CLI keeps an explicit allowlist; the last CLI stays ticked", async ({ page }) => {
  const { root, hub } = await start({ allowedEngines: ["codex"], mode: "ask", maxConcurrent: 2 });
  try {
    const editor = await openEditor(page, hub);
    const codex = editor.getByRole("checkbox", { name: "Codex", exact: true }), claude = editor.getByRole("checkbox", { name: "Claude", exact: true });
    await expect(codex).toBeChecked(); await expect(claude).not.toBeChecked();
    await claude.check();
    await save(editor);
    // A CLI installed later is not allowed without the owner choosing it.
    expect((await hub.dispatch.settings("owner", "disp")).settings).toEqual({ allowedEngines: ["codex", "claude"], mode: "ask", maxConcurrent: 2 });
    await codex.uncheck();
    await claude.click();
    await expect(claude).toBeChecked();
    await save(editor);
    expect((await hub.dispatch.settings("owner", "disp")).settings).toEqual({ allowedEngines: ["claude"], mode: "ask", maxConcurrent: 2 });
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("allowing CLIs installed later is an explicit choice; leaving it lists the installed CLIs", async ({ page }) => {
  const { root, hub } = await start({ allowedEngines: ["codex"], mode: "ask", maxConcurrent: 2 });
  try {
    const editor = await openEditor(page, hub);
    const later = editor.getByRole("checkbox", { name: "也允许以后安装的 CLI", exact: true });
    await expect(later).not.toBeChecked();
    await later.check();
    await expect(editor.getByRole("checkbox", { name: "Claude", exact: true })).toBeChecked();
    await save(editor);
    expect((await hub.dispatch.settings("owner", "disp")).settings).toEqual({ mode: "ask", maxConcurrent: 2 });
    await later.uncheck();
    await save(editor);
    expect((await hub.dispatch.settings("owner", "disp")).settings).toEqual({ allowedEngines: ["codex", "claude"], mode: "ask", maxConcurrent: 2 });
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("an unreadable CLI catalog still lets the owner change other settings without touching the allowlist, then recovers", async ({ page }) => {
  const { root, hub } = await start({ allowedEngines: ["codex"], mode: "ask", maxConcurrent: 2 });
  try {
    await page.route("**/api/bots/catalog", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "bot_catalog_unavailable" }) }));
    const editor = await openEditor(page, hub);
    await expect(editor.getByText("暂时无法读取可用引擎，请重试。", { exact: true })).toBeVisible();
    await expect(editor.getByRole("checkbox")).toHaveCount(0);
    await editor.getByLabel("同时进行的工单上限", { exact: true }).selectOption("3");
    await save(editor);
    expect((await hub.dispatch.settings("owner", "disp")).settings).toEqual({ allowedEngines: ["codex"], mode: "ask", maxConcurrent: 3 });
    await page.unroute("**/api/bots/catalog");
    await editor.getByRole("button", { name: "重新读取可用的 CLI", exact: true }).click();
    await expect(editor.getByRole("checkbox", { name: "Codex", exact: true })).toBeChecked({ timeout: 30_000 });
    await expect(editor.getByRole("checkbox", { name: "Claude", exact: true })).not.toBeChecked();
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const phone of [false, true]) test(`unsaved dispatcher settings survive back and reload until explicitly discarded (${phone ? "phone" : "desktop"})`, async ({ page }) => {
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const { root, hub } = await start({ mode: "ask", maxConcurrent: 2 });
  try {
    const editor = await openEditor(page, hub);
    await editor.getByLabel("派活方式", { exact: true }).selectOption("auto");
    await editor.getByLabel("同时进行的工单上限", { exact: true }).selectOption("8");
    await editor.getByRole("button", { name: "关闭幕僚长设置", exact: true }).filter({ visible: true }).click();
    const warning = page.getByRole("dialog", { name: "有未保存的修改", exact: true });
    await expect(warning).toBeVisible();
    expect((await hub.dispatch.settings("owner", "disp")).settings).toEqual({ mode: "ask", maxConcurrent: 2 });
    await warning.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(editor.getByLabel("派活方式", { exact: true })).toHaveValue("auto");
    await expect(editor.getByLabel("同时进行的工单上限", { exact: true })).toHaveValue("8");
    await editor.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(warning).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(warning).not.toBeVisible();
    await expect(editor.getByLabel("同时进行的工单上限", { exact: true })).toHaveValue("8");
    await editor.getByRole("button", { name: "重新读取", exact: true }).click();
    await warning.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(editor.getByLabel("派活方式", { exact: true })).toHaveValue("ask");
    await expect(editor.getByLabel("同时进行的工单上限", { exact: true })).toHaveValue("2");
    await editor.getByLabel("同时进行的工单上限", { exact: true }).selectOption("3");
    if (phone) await page.evaluate(() => window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
    else await page.keyboard.press("Escape");
    await expect(warning).toBeVisible();
    await warning.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(editor).not.toBeVisible();
    await page.getByRole("button", { name: "设置幕僚长", exact: true }).click();
    await expect(editor.getByLabel("同时进行的工单上限", { exact: true })).toHaveValue("2");
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const phone of [false, true]) test(`dispatcher save persists across closing and page reload; failed save retains the draft (${phone ? "phone" : "desktop"})`, async ({ page }) => {
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const { root, hub } = await start({ mode: "ask", maxConcurrent: 2 });
  try {
    let editor = await openEditor(page, hub);
    await editor.getByLabel("派活方式", { exact: true }).selectOption("auto");
    await editor.getByLabel("同时进行的工单上限", { exact: true }).selectOption("8");
    await save(editor);
    await editor.getByRole("button", { name: "关闭幕僚长设置", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "设置幕僚长", exact: true }).click();
    editor = page.getByRole("dialog", { name: "幕僚长设置", exact: true });
    await expect(editor.getByLabel("派活方式", { exact: true })).toHaveValue("auto");
    await expect(editor.getByLabel("同时进行的工单上限", { exact: true })).toHaveValue("8");
    await expect(editor.getByText("当前显示的是主机已保存的设置。", { exact: true })).toBeVisible();
    await page.reload(); await waitForClientOnline(page); await showDisconnectedBots(page);
    await openSettings(page);
    await expect(editor.getByLabel("派活方式", { exact: true })).toHaveValue("auto");
    await expect(editor.getByLabel("同时进行的工单上限", { exact: true })).toHaveValue("8");
    await page.route("**/api/bots/disp/dispatcher", route => route.request().method() === "PUT" ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "dispatcher_settings_conflict" }) }) : route.continue());
    await editor.getByLabel("同时进行的工单上限", { exact: true }).selectOption("3");
    await editor.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("其他设备已修改幕僚长设置");
    await expect(editor.getByLabel("同时进行的工单上限", { exact: true })).toHaveValue("3");
    await expect(editor.getByText("幕僚长设置已保存。", { exact: true })).toHaveCount(0);
    expect((await hub.dispatch.settings("owner", "disp")).settings).toEqual({ mode: "auto", maxConcurrent: 8 });
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a lost save receipt is not success or rollback; reloading reconciles the Host value without another write", async ({ page }) => {
  const { root, hub } = await start({ mode: "ask", maxConcurrent: 2 });
  try {
    const editor = await openEditor(page, hub);
    let writes = 0;
    await page.route("**/api/bots/disp/dispatcher", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      writes++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await response.dispose();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "upstream_unavailable" }) });
    });
    await editor.getByLabel("派活方式", { exact: true }).selectOption("auto");
    await editor.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("未能确认设置结果");
    await expect(editor.getByText("幕僚长设置已保存。", { exact: true })).toHaveCount(0);
    expect((await hub.dispatch.settings("owner", "disp")).settings).toEqual({ mode: "auto", maxConcurrent: 2 });
    await editor.getByRole("button", { name: "重新读取", exact: true }).click();
    const warning = page.getByRole("dialog", { name: "有未保存的修改", exact: true });
    await expect(warning).toContainText("不会撤销主机可能已保存的设置");
    await warning.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(editor.getByLabel("派活方式", { exact: true })).toHaveValue("auto");
    await expect(editor.getByText("当前显示的是主机已保存的设置。", { exact: true })).toBeVisible();
    await expect(editor.getByRole("button", { name: "保存到此 Bot", exact: true })).toBeDisabled();
    expect(writes).toBe(1);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
