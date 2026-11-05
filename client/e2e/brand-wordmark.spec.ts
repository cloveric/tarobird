import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { createServer } from "./fixtures/vite.js";

test.use({ serviceWorkers: "block" });

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
}

/** The sidebar name stays text-only: no colour mascot and no flat theme mask. */
async function expectTextOnly(page: Page, brand: string, fontSize: string) {
  const name = page.locator(`${brand} .wordmark`);
  await expect(name).toHaveAttribute("data-brand-context", "sidebar");
  await expect(name).toHaveText("TaroBird");
  await expect(name.locator(".wordmark-text")).toBeVisible();
  await expect(name.locator(".wordmark-text")).toHaveCSS("font-size", fontSize);
  await expect(page.locator(`${brand} :is(img,.wordmark-icon)`)).toHaveCount(0);
}

test("sidebars show only the TaroBird name in every brand style; standalone scenes keep the mascot", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "brand-wordmark-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','研究助手','fixture',1)");
    await hub.store.createConversation("owner", ["alpha"], "项目讨论", "project");
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(hub.url);
    const scene = page.locator(".pairing-card > .wordmark");
    await expect(scene).toHaveAttribute("data-brand-context", "scene");
    await expect(scene.locator("img.wordmark-icon-colour")).toBeVisible();
    expect(await scene.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await pair(page, hub);
    const sidebar = ".host-workspace:not([hidden]) .sidebar .brand";
    // Theme-specific type sizes and decorations stay as they were; only the mascot is gone.
    for (const [palette, fontSize] of [["white-violet", "15.5px"], ["cli", "15px"]] as const) {
      await page.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
      await expectTextOnly(page, sidebar, fontSize);
    }
    await page.evaluate(() => { document.documentElement.dataset.palette = "white-violet"; });
    await page.screenshot({ path: info.outputPath("sidebar.png"), clip: { x: 0, y: 0, width: 300, height: 120 } });
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(page.locator(".adhd-shell")).toBeVisible();
    await expectTextOnly(page, ".adhd-shell > .sidebar .brand", "15.5px");
    await expect(page.locator(".adhd-shell > .sidebar .brand .adhd-selection-count")).toBeVisible();
    await page.screenshot({ path: info.outputPath("adhd-sidebar.png"), clip: { x: 0, y: 0, width: 300, height: 120 } });
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("an expanded iOS window uses the text-only sidebar name with its own touch controls", async ({ page }) => {
  // Browser platform hint only; not a physical iPhone acceptance check.
  const root = await mkdtemp(path.join(os.tmpdir(), "brand-wordmark-ios-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','研究助手','fixture',1)");
    await hub.store.createConversation("owner", ["alpha"], "项目讨论", "project");
    await page.setViewportSize({ width: 1180, height: 820 }); await pair(page, hub);
    await page.addInitScript(() => {
      (window as any).CapacitorCustomPlatform = { name: "ios" };
      const capacitor = (window as any).Capacitor = {};
      Object.defineProperty(capacitor, "isNativePlatform", { get: () => () => false, set: () => {} });
    });
    await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-platform", "ios");
    const sidebar = ".host-workspace:not([hidden]) .sidebar .brand";
    await expect(page.locator(sidebar)).toBeVisible();
    await expectTextOnly(page, sidebar, "15.5px");
    const create = page.locator(`${sidebar} .sidebar-create-trigger`);
    await expect(create).toBeVisible();
    expect((await create.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const platform of ["macos", "windows"]) test(`desktop ${platform} welcome keeps the mascot beside the name`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/pairing-design.html?platform=${platform}`);
    const scene = page.locator(".desktop-welcome > .wordmark");
    await expect(scene).toHaveAttribute("data-brand-context", "scene");
    await expect(scene.locator("img.wordmark-icon-colour")).toBeVisible();
    await expect(scene.locator(".wordmark-text")).toHaveText("TaroBird");
  } finally { await server.close(); }
});
