import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { openWorkspacePage } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

async function pairClient(page: import("@playwright/test").Page, hub: HubServer) {
  await hub.store.db.run(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [HOST_PROFILE_KEY, JSON.stringify({ name: "macmini", revision: 1 })],
  );
  await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill("macmini");
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await page.locator(".host-workspace:not([hidden])").waitFor({ state: "visible" });
}

function relativeLuminance(rgb: string): number {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return 0;
  const channels = [Number(match[1]), Number(match[2]), Number(match[3])].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(rgbA: string, rgbB: string): number {
  const l1 = relativeLuminance(rgbA);
  const l2 = relativeLuminance(rgbB);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test("Settings -> About -> Acknowledgements searches items, preserves navigation/scroll/contrast, and displays full license text on desktop and phone (zh and en)", async ({ page }) => {
  test.setTimeout(90_000);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "acknowledgements-e2e-"));
  const hub = await HubServer.start({ stateDir, clientDir: path.resolve("dist") });
  try {
    await pairClient(page, hub);

    // Desktop (Chinese)
    await openWorkspacePage(page, "设置");
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings).toBeVisible();
    await settings.locator("button[data-section='about']").click();
    await expect(settings.getByText("AGPL-3.0-only")).toBeVisible();
    await settings.locator("button[data-about-action='acknowledgements']").click();

    const searchInput = settings.getByRole("searchbox", { name: "搜索致谢项目", exact: true });
    await expect(searchInput).toBeVisible();
    await expect(settings.locator(".about-ack-row").first()).toBeVisible();

    // Active category chip must retain readable high contrast when hovered in both light and dark themes.
    const activeChip = settings.locator(".about-category-chip.is-active");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await activeChip.hover();
      await page.waitForTimeout(180);
      const colors = await activeChip.evaluate((node) => {
        const style = getComputedStyle(node);
        return { color: style.color, backgroundColor: style.backgroundColor };
      });
      expect(contrastRatio(colors.color, colors.backgroundColor), `Active chip hover contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

    // Scroll deep down the list, open an item, and verify scrollTop resets so the back button and header are visible.
    const scrollContainer = settings.locator(".settings-content");
    const zodRow = settings.locator("button[data-ack-id='npm:zod']");
    await zodRow.scrollIntoViewIfNeeded();
    const scrollBefore = await scrollContainer.evaluate((node) => node.scrollTop);
    expect(scrollBefore).toBeGreaterThan(200);
    await zodRow.click();
    await expect(settings.locator("[data-license-text]")).toBeVisible();
    const detailScrollTop = await scrollContainer.evaluate((node) => node.scrollTop);
    expect(detailScrollTop).toBe(0);
    const containerBox = (await scrollContainer.boundingBox())!;
    const backBox = (await settings.getByRole("button", { name: "返回致谢列表", exact: true }).boundingBox())!;
    expect(backBox.y).toBeGreaterThanOrEqual(containerBox.y - 1);

    // Desktop Escape steps back one level (Detail -> List -> About -> Close) instead of closing immediately from Detail.
    await page.keyboard.press("Escape");
    await expect(settings).toBeVisible();
    await expect(searchInput).toBeVisible();
    const restoredScroll = await scrollContainer.evaluate((node) => node.scrollTop);
    expect(restoredScroll).toBeGreaterThan(200);

    // Verify OkHttp has Square's notice and NO SheetJS copyright notice.
    await searchInput.fill("OkHttp");
    await settings.locator("button[data-ack-id='android-okhttp']").click();
    await expect(settings.locator("[data-license-text]")).not.toContainText("SheetJS");
    await expect(settings.locator(".about-acknowledgements-detail")).toContainText("Square, Inc.");
    await settings.getByRole("button", { name: "返回致谢列表", exact: true }).click();

    // Verify normalized repository links (react-markdown, yaml) and real Excalidraw/Tauri license texts.
    await searchInput.fill("react-markdown");
    await settings.locator("button[data-ack-id='npm:react-markdown']").click();
    await expect(settings.locator("a.about-repo-link")).toHaveAttribute("href", "https://github.com/remarkjs/react-markdown");
    await settings.getByRole("button", { name: "返回致谢列表", exact: true }).click();

    await searchInput.fill("@excalidraw/excalidraw");
    await settings.locator("button[data-ack-id='npm:@excalidraw/excalidraw']").click();
    await expect(settings.locator("[data-license-text]")).toContainText("Permission is hereby granted");
    await settings.getByRole("button", { name: "返回致谢列表", exact: true }).click();

    // Filter to LobeHub model brand icons and open full license text.
    await searchInput.fill("LobeHub");
    const lobeRow = settings.locator("button[data-ack-id='lobehub-model-brand-icons']");
    await expect(lobeRow).toBeVisible();
    await lobeRow.click();
    await expect(settings.locator("[data-license-text]")).toContainText("MIT License");
    await expect(settings.locator("[data-license-text]")).toContainText("Brand trademarks belong to their respective owners");

    // Back to list and verify Desktop, vendored Lute, Android, iOS, and npm coverage.
    await settings.getByRole("button", { name: "返回致谢列表", exact: true }).click();
    await settings.getByRole("button", { name: "清空搜索", exact: true }).click();
    await settings.getByRole("tab", { name: "桌面", exact: true }).click();
    await expect(settings.locator("button[data-ack-id='desktop-electron']")).toBeVisible();
    await settings.getByRole("tab", { name: "全部", exact: true }).click();
    await searchInput.fill("Lute");
    await expect(settings.locator("button[data-ack-id='vditor-lute']")).toBeVisible();
    await searchInput.fill("Capacitor Swift");
    await expect(settings.locator("button[data-ack-id='ios-capacitor-swift-pm']")).toBeVisible();
    await searchInput.fill("react");
    await expect(settings.locator("button[data-ack-id='npm:react']")).toBeVisible();

    // Escape twice from Acknowledgements list -> About root -> Close settings (first clears search if focused; blur first).
    await settings.getByRole("button", { name: "清空搜索", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(settings.locator("button[data-about-action='acknowledgements']")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    // Reopen, switch to English inside Settings -> General and verify About -> Acknowledgements in English.
    await openWorkspacePage(page, "设置");
    await settings.locator("button[data-section='general']").click();
    await settings.getByLabel("语言", { exact: true }).selectOption("en");
    const settingsEn = page.getByRole("dialog", { name: "Settings", exact: true });
    await settingsEn.locator("button[data-section='about']").click();
    await settingsEn.locator("button[data-about-action='acknowledgements']").click();
    await expect(settingsEn.getByRole("searchbox", { name: "Search acknowledgements", exact: true })).toBeVisible();
    await settingsEn.locator("button[data-ack-id='pi-mark']").click();
    await expect(settingsEn.locator("[data-license-text]")).toContainText("https://pi.dev");
    await settingsEn.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(settingsEn).toHaveCount(0);

    // Phone viewport (390x844): verify header title, single back button, and Android native back hierarchy.
    await page.setViewportSize({ width: 390, height: 844 });
    const home = page.locator(".host-workspace:not([hidden]) .mobile-home");
    if (!(await home.isVisible().catch(() => false))) {
      await page.locator(".host-workspace:not([hidden]) button[aria-label='Open conversation list']").click();
    }
    await expect(home).toBeVisible();
    await home.getByRole("button", { name: "Me", exact: true }).click();
    await home.locator("button[data-settings-entry='settings']").click();
    await expect(settingsEn).toBeVisible();
    await settingsEn.locator("button[data-section='about']").click();
    await settingsEn.locator("button[data-about-action='acknowledgements']").click();
    await expect(settingsEn.locator(".preferences-header h2")).toHaveText("Acknowledgements");
    await expect(settingsEn.locator(".about-back-button")).toHaveCount(0);

    const phoneSearch = settingsEn.getByRole("searchbox", { name: "Search acknowledgements", exact: true });
    await phoneSearch.fill("JetBrains");
    await expect(settingsEn.locator("button[data-ack-id='jetbrains-mono']")).toBeVisible();
    await settingsEn.locator("button[data-ack-id='jetbrains-mono']").click();
    await expect(settingsEn.locator(".preferences-header h2")).toHaveText("JetBrains Mono");
    await expect(settingsEn.locator("[data-license-text]")).toContainText("SIL OPEN FONT LICENSE");

    // Android native Back: Detail -> Acknowledgements list (keeping search query) -> About -> Settings categories.
    await page.evaluate(() => window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
    await expect(phoneSearch).toBeVisible();
    await expect(phoneSearch).toHaveValue("JetBrains");
    await page.evaluate(() => window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
    await expect(settingsEn.locator("button[data-about-action='acknowledgements']")).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
    await expect(settingsEn.getByRole("navigation", { name: "Settings categories", exact: true })).toBeVisible();
  } finally {
    await hub.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
