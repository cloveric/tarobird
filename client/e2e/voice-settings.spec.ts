import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HubServer } from "../../src/hub/server.js";
import { HubVoiceSettings } from "../../src/hub/voice-settings.js";
import { QwenAsrSetup } from "../../src/runtime/qwen-asr-setup.js";
import { voicePolicyFile } from "../../src/runtime/voice-policy.js";
import { waitForClientOnline, openWorkspacePage } from "./fixtures/mobile.js";
import { closeSettings } from "./fixtures/settings.js";
import { expectOneDisclosure } from "./fixtures/disclosure-assertions.js";

test.use({ serviceWorkers: "block" });
const savedText = "已保存并核对，从下一条语音生效。";
const idle = { platform: "darwin", supported: true, installed: true, pythonPresent: true, modelPresent: true, running: true, managed: true, legacyService: false, activeRequests: 0, watchdog: { enabled: true, available: true, memoryBytes: 2e9, limitBytes: 5.5e9, intervalSeconds: 300, reason: "explicit" }, autostart: "login" };
async function fixture(page: Page, ready = true, legacyMode?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-ui-")), home = path.join(root, "home"), host = path.join(root, "host"), adapter = path.join(home, ".tarocub-secrets/tingwu_asr");
  await mkdir(adapter, { recursive: true, mode: 0o700 });
  await mkdir(path.join(adapter, ".venv/bin"), { recursive: true });
  await writeFile(path.join(adapter, "tingwu_transcribe.py"), "# isolated fixture");
  await writeFile(path.join(adapter, ".venv/bin/python"), "fixture", { mode: 0o700 });
  if (ready) await writeFile(path.join(adapter, ".env.local"), "PRIVATE_CANARY", { mode: 0o600 });
  const settings = new HubVoiceSettings(host, home, legacyMode ? { TINGWU_ASR_DIR: adapter, ASR_CLOUD_MODE: legacyMode } : {}), asrSetup = new QwenAsrSetup(home, async () => JSON.stringify(idle));
  const hub = await HubServer.start({ stateDir: host, voiceSettings: settings, asrSetup, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "语音设置测试主机", revision: (await hub.profile.read()).revision });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    const open = async () => { await openWorkspacePage(page, "设置"); await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^语音转写/ }).click(); };
    await open();
    const panel = page.locator(".voice-settings");
    return { hub, settings, open, panel, host, dispose: async () => { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (e) { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); throw e; }
}
async function enable(page: Page) {
  await page.getByRole("radio", { name: /^按时长自动选择/ }).check();
  await page.getByLabel("我同意将符合条件的语音上传云端，并了解可能产生费用。", { exact: true }).check();
}
for (const width of [1360, 390]) test(`owner sees local status, opts in, saves and reloads at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 }); const f = await fixture(page);
  try {
    await expect(f.panel.getByText("本地语音已启用", { exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^全部本地/ })).toBeChecked();
    await page.getByRole("radio", { name: /^按时长自动选择/ }).check();
    await expect(f.panel.getByText("本机配置完整；云端可用性以实际转写为准。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "保存语音设置", exact: true })).toBeDisabled();
    await page.getByLabel("我同意将符合条件的语音上传云端，并了解可能产生费用。", { exact: true }).check();
    await page.getByLabel("长语音起点", { exact: false }).fill("20");
    await page.getByLabel("我同意将符合条件的语音上传云端，并了解可能产生费用。", { exact: true }).check();
    await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByText(savedText, { exact: true })).toBeVisible();
    // Both custom-chevron disclosures live under the settings theme rule.
    for (const palette of ["mono", "white-violet", "ocean", "cli"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      await expectOneDisclosure(f.panel.locator(".voice-adapter-details > summary"));
      await expectOneDisclosure(f.panel.locator(".voice-consent-details > summary"));
    }
    await f.panel.locator(".voice-consent-details summary").press("Enter");
    await expect(f.panel.getByText("若需停止上传，请选择全部本地并保存。", { exact: true })).toBeVisible();
    await f.panel.locator(".voice-consent-details summary").press("Enter");
    await f.panel.locator(".voice-cloud footer").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`voice-saved-${width}.png`) });
    expect(await f.settings.status()).toMatchObject({ mode: "auto" as const, thresholdSeconds: 1200, cloudVerified: false });
    await page.reload(); await waitForClientOnline(page); await f.open();
    await expect(page.getByRole("radio", { name: /^按时长自动选择/ })).toBeChecked(); await expect(page.getByLabel("长语音起点", { exact: false })).toHaveValue("20");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("PRIVATE_CANARY");
    await page.screenshot({ path: info.outputPath(`voice-settings-${width}.png`), fullPage: true });
    if (width < 760) await page.getByRole("button", { name: "返回设置分类", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^通用/ }).click();
    await page.locator("#theme").selectOption("dark"); await page.locator("#language").selectOption("en");
    if (width < 760) await page.getByRole("button", { name: "Back to settings categories", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: /^Voice transcription/ }).click();
    await f.panel.locator(".voice-adapter-details summary").press("Enter");
    await expect(f.panel.getByLabel("Tongyi configuration on the host", { exact: true })).toBeVisible();
    await expect(f.panel).not.toContainText("PRIVATE_CANARY");
    await f.panel.locator(".voice-adapter-details summary").press("Enter");
    await f.panel.locator(".voice-cloud footer").scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`voice-dark-en-${width}.png`) });
    if (width < 760) await page.getByRole("button", { name: "Back to settings categories", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: /^General/ }).click();
    await page.locator("#language").selectOption("zh");
    if (width < 760) await page.getByRole("button", { name: "返回设置分类", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^语音转写/ }).click();
    await page.getByRole("radio", { name: /^全部本地/ }).check(); await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByText(savedText, { exact: true })).toBeVisible(); expect((await f.settings.status()).mode).toBe("local");
  } finally { await f.dispose(); }
});
test("missing private config cannot enable cloud and gives guided setup", async ({ page }) => {
  const f = await fixture(page, false);
  try { await enable(page); await expect(page.getByRole("button", { name: "保存语音设置", exact: true })).toBeDisabled(); await expect(f.panel).toContainText("让 Bot 协助准备配置"); expect((await f.settings.status()).mode).toBe("local"); }
  finally { await f.dispose(); }
});
test("existing whole-second thresholds remain clean and survive fixed modes", async ({ page }) => {
  const f = await fixture(page);
  try {
    const before = await f.settings.status();
    await f.settings.update({ requestId: "seconds-threshold", revision: before.revision, adapterId: before.adapterId, mode: "auto", cloudConsent: true, thresholdSeconds: 500 }, "owner", async () => {});
    await page.reload(); await waitForClientOnline(page); await f.open();
    await expect(page.getByRole("radio", { name: /^按时长自动选择/ })).toBeChecked();
    await expect(page.getByRole("button", { name: "放弃修改并重新载入", exact: true })).toHaveCount(0);
    await expect(f.panel.getByRole("alert")).toHaveCount(0);
    for (const title of [/^全部云端/, /^全部本地/, /^按时长自动选择/]) {
      await page.getByRole("radio", { name: title }).check();
      if (title.source !== "^全部本地") await page.getByLabel("我同意将符合条件的语音上传云端，并了解可能产生费用。", { exact: true }).check();
      await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
      await expect(f.panel.getByText(savedText)).toBeVisible();
      expect((await f.settings.status()).thresholdSeconds).toBe(500);
    }
    await closeSettings(page); await expect(page.getByRole("button", { name: "继续编辑", exact: true })).toHaveCount(0);
  } finally { await f.dispose(); }
});
for (const width of [1360, 390]) test(`all three modes persist and retain the automatic threshold at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 }); const f = await fixture(page);
  try {
    await enable(page); await page.getByLabel("长语音起点", { exact: false }).fill("5");
    await page.getByLabel("我同意将符合条件的语音上传云端，并了解可能产生费用。", { exact: true }).check();
    await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByText(savedText)).toBeVisible();
    await page.getByRole("radio", { name: /^全部云端/ }).check();
    await expect(page.getByLabel("长语音起点", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存语音设置", exact: true })).toBeDisabled();
    await page.getByLabel("我同意将符合条件的语音上传云端，并了解可能产生费用。", { exact: true }).check();
    await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByText(savedText)).toBeVisible();
    expect(await f.settings.status()).toMatchObject({ mode: "cloud", thresholdSeconds: 300 });
    await page.reload(); await waitForClientOnline(page); await f.open();
    await expect(page.getByRole("radio", { name: /^全部云端/ })).toBeChecked();
    await expect(f.panel).toContainText("不自动切回本地");
    await expect(f.panel.getByRole("region", { name: "本地语音转写" })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`voice-modes-cloud-${width}.png`), fullPage: true });
    await page.getByRole("radio", { name: /^按时长自动选择/ }).check();
    await expect(page.getByLabel("长语音起点", { exact: false })).toHaveValue("5");
    await page.getByRole("radio", { name: /^全部本地/ }).check();
    await expect(page.getByLabel("长语音起点", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByText(savedText)).toBeVisible();
    expect(await f.settings.status()).toMatchObject({ mode: "local", thresholdSeconds: 300 });
    await expect(f.panel.getByText("本地语音已启用", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  } finally { await f.dispose(); }
});
test("read-back failure does not show success; reload recovers exactly one receipt", async ({ page }) => {
  const f = await fixture(page); let writes = 0, block = false;
  await page.route("**/api/integrations/voice**", async route => {
    if (route.request().method() === "PUT") { writes++; const response = await route.fetch(); block = true; await route.fulfill({ response }); }
    else if (block) await route.abort(); else await route.continue();
  });
  try {
    await enable(page); await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toContainText("尚未确认"); await expect(f.panel.getByText(savedText)).toHaveCount(0);
    expect((await f.settings.status()).mode).toBe("auto"); block = false;
    await page.reload(); await waitForClientOnline(page); await f.open();
    await expect(f.panel.getByText(savedText, { exact: true })).toBeVisible(); expect(writes).toBe(1);
  } finally { await f.dispose(); }
});
test("failed transport retries the same request without reapplying or leaking a draft", async ({ page }) => {
  const f = await fixture(page); const ids: string[] = [];
  await page.route("**/api/integrations/voice", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    ids.push(route.request().postDataJSON().requestId); if (ids.length === 1) return route.abort(); return route.continue();
  });
  try {
    await enable(page); await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toContainText("尚未确认");
    await expect(f.panel.getByRole("status")).toContainText("待核对的保存请求：按时长自动选择");
    await page.getByRole("button", { name: "重试上次保存", exact: true }).click(); await expect(f.panel.getByText(savedText)).toBeVisible();
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
    expect(JSON.parse(await readFile(voicePolicyFile(f.host), "utf8")).receipts).toHaveLength(1);
  } finally { await f.dispose(); }
});
test("conflicting edit is rejected and reload shows authoritative state", async ({ page }) => {
  const f = await fixture(page);
  try {
    await enable(page); const before = await f.settings.status();
    await f.settings.update({ requestId: "other-owner", revision: before.revision, adapterId: before.adapterId, mode: "local" as const, cloudConsent: false, thresholdSeconds: 1800 }, "owner", async () => {});
    await page.getByRole("button", { name: "保存语音设置", exact: true }).click(); await expect(f.panel.getByRole("alert")).toContainText("版本已变化");
    await expect(f.panel.getByText(savedText)).toHaveCount(0);
    await page.getByRole("button", { name: "放弃修改并重新载入", exact: true }).click();
    await expect(page.getByRole("radio", { name: /^全部本地/ })).toBeChecked();
    await page.getByRole("radio", { name: /^按时长自动选择/ }).check(); await expect(page.getByLabel("长语音起点", { exact: false })).toHaveValue("30");
  } finally { await f.dispose(); }
});
test("dirty draft survives category navigation and blocks closing", async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.getByRole("radio", { name: /^按时长自动选择/ }).check();
    await page.getByLabel("长语音起点", { exact: false }).fill("25");
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^通用/ }).click();
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^语音转写/ }).click();
    await expect(page.getByLabel("长语音起点", { exact: false })).toHaveValue("25");
    await closeSettings(page); await expect(page.getByRole("button", { name: "继续编辑", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click(); await expect(page.getByLabel("长语音起点", { exact: false })).toHaveValue("25");
    expect((await f.settings.status()).thresholdSeconds).toBe(900);
  } finally { await f.dispose(); }
});
test("old host endpoint shows update guidance and never claims configured", async ({ page }) => {
  await page.route("**/api/integrations/voice**", route => route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' }));
  const f = await fixture(page);
  try { await expect(f.panel).toContainText("请更新主机后使用语音转写设置。"); await expect(f.panel.getByText(savedText)).toHaveCount(0); }
  finally { await f.dispose(); }
});

test("saved consent is explicit and expanding uploads requires renewed approval", async ({ page }) => {
  const f = await fixture(page);
  try {
    await enable(page); await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByText(savedText)).toBeVisible();
    const consent = page.getByLabel("我同意将符合条件的语音上传云端，并了解可能产生费用。", { exact: true });
    await expect(consent).toHaveCount(0); await expect(f.panel).toContainText("若需停止上传，请选择全部本地并保存");
    await page.getByLabel("长语音起点", { exact: false }).fill("10");
    await expect(consent).not.toBeChecked(); await expect(page.getByRole("button", { name: "保存语音设置", exact: true })).toBeDisabled();
    await consent.check(); await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByText(savedText)).toBeVisible();
    await page.getByLabel("长语音起点", { exact: false }).fill("20");
    await expect(consent).toHaveCount(0); await expect(page.getByRole("button", { name: "保存语音设置", exact: true })).toBeEnabled();
  } finally { await f.dispose(); }
});
test("unreadable policy permits discarding only the local pending receipt without resetting the host", async ({ page }) => {
  const f = await fixture(page); let writes = 0;
  try {
    await page.route("**/api/integrations/voice", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      writes++; await route.abort();
    });
    await enable(page); await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toContainText("尚未确认");
    await writeFile(voicePolicyFile(f.host), "broken fixture", { mode: 0o600 });
    await page.getByRole("button", { name: "重新核对", exact: true }).click();
    await expect(f.panel.getByRole("alert")).toContainText("格式无效");
    await page.getByRole("button", { name: "放弃本机核对记录", exact: true }).click();
    await expect(f.panel).toContainText("不会撤销主机上已经保存的设置");
    await closeSettings(page); await expect(page.getByRole("button", { name: "继续编辑", exact: true })).toHaveCount(0);
    expect(writes).toBe(1); expect(await readFile(voicePolicyFile(f.host), "utf8")).toBe("broken fixture");
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("tarobot.voice-settings.")))).toEqual([]);
  } finally { await f.dispose(); }
});

test("legacy auto routing is not preconsented and its first managed save is explicit", async ({ page }) => {
  const f = await fixture(page, true, "auto");
  try {
    await expect(page.getByRole("radio", { name: /^按时长自动选择/ })).toBeChecked();
    const consent = page.getByLabel("我同意将符合条件的语音上传云端，并了解可能产生费用。", { exact: true });
    await expect(consent).not.toBeChecked(); await expect(page.getByRole("button", { name: "保存语音设置", exact: true })).toBeDisabled();
    await consent.check(); await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByText(savedText)).toBeVisible();
    expect(await f.settings.status()).toMatchObject({ managed: true, mode: "auto" });
  } finally { await f.dispose(); }
});

for (const legacyMode of [undefined, "invalid-mode"]) test(`first all-local save adopts the default without a dummy edit: ${legacyMode ?? "missing"}`, async ({ page }) => {
  const f = await fixture(page, false, legacyMode);
  try {
    await expect(page.getByRole("radio", { name: /^全部本地/ })).toBeChecked();
    await page.getByRole("button", { name: "保存语音设置", exact: true }).click();
    await expect(f.panel.getByText(savedText)).toBeVisible();
    expect(await f.settings.status()).toMatchObject({ managed: true, mode: "local" });
  } finally { await f.dispose(); }
});
