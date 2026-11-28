import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { mobileHome, openWorkspacePage } from "./fixtures/mobile.js";
import { openSettings } from "./fixtures/settings.js";

async function switchPluginTestLocale(page: Page, locale: "zh" | "ja") {
  if (locale === "ja") await openSettings(page, "general");
  else {
    await openWorkspacePage(page, "設定");
    await page.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: /^一般/ }).click();
  }
  await page.locator("#language").selectOption(locale);
  await expect(page.locator("html")).toHaveAttribute("lang", locale === "zh" ? "zh-CN" : "ja");
  const back = page.getByRole("button", { name: locale === "ja" ? "設定カテゴリに戻る" : "返回设置分类", exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: locale === "ja" ? "設定を閉じる" : "关闭设置", exact: true }).click();
}

test.describe("Plugin System E2E Regressions (#101)", () => {
  test("desktop welcome screen: Escape step-back, clean third-party section, and localized prompt when opening workbench plugin without active conversation", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-welcome-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), pluginArtifactsDir: path.resolve("../dist/plugins") });
    try {
      await page.goto(hub.url);
      await preparePairing(page, hub);
      await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await expect(page.locator(".connection-pill.online")).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "欢迎回来", level: 1 })).toBeVisible();

      // Open Marketplace and verify no fabricated community.focus-timer exists, and third-party category stays clean
      await openWorkspacePage(page, "插件市场");
      const modal = page.locator("dialog.plugins-modal-dialog[open]");
      await expect(modal).toBeVisible();
      await expect(modal.locator('[data-plugin-id="community.focus-timer"]')).toHaveCount(0);

      await modal.getByRole("button", { name: "第三方社区", exact: true }).click();
      await expect(modal.locator(".plugins-off-banner")).toBeVisible();
      await expect(modal.locator(".plugins-empty-card")).toContainText("当前目录暂无已上架的第三方插件");
      await modal.getByRole("button", { name: "全部", exact: true }).click();

      // Verify Escape steps back detail -> list -> closed
      await modal.getByRole("button", { name: /查看插件详情：无限画布/ }).first().click();
      await expect(modal.locator(".plugin-detail-page")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(modal.locator(".plugin-detail-page")).toHaveCount(0);
      await expect(modal).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);

      // Install Infinite Canvas on Welcome screen and click Open -> clean localized prompt (never raw error code)
      await openWorkspacePage(page, "插件市场");
      await expect(modal).toBeVisible();
      const canvasCard = modal.locator('[data-plugin-id="tarobird.infinite-canvas"]').first();
      await canvasCard.getByRole("button", { name: "下载并安装" }).click();
      await modal.locator(".plugin-consent-box").getByRole("button", { name: "确认并安装" }).click();
      await expect(canvasCard.getByRole("button", { name: "打开" })).toBeVisible();
      await canvasCard.getByRole("button", { name: "打开" }).click();
      await expect(modal).toHaveCount(0);

      const banner = page.locator(".error-banner").first();
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("请先选择一个活跃对话");
      await expect(banner).not.toContainText("workbench_identity_unavailable");
    } finally {
      await page.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("folder HTML remains unavailable in developer mode", async ({ page }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-local-dev-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    try {
      await hub.profile.update({ name: "插件验收主机", revision: 0 });
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('fixture','插件验收 Bot','fixture',1)");
      await hub.store.createConversation("owner", ["fixture"], "插件验收对话", "fixture_chat");
      await page.goto(hub.url);
      await preparePairing(page, hub);
      await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await expect(page.getByRole("heading", { name: "插件验收对话", level: 1 })).toBeVisible();
      await openWorkspacePage(page, "插件市场");
      const modal = page.locator("dialog.plugins-modal-dialog[open]");
      await modal.getByRole("tab", { name: "开发者" }).click();
      await modal.getByRole("checkbox", { name: "启用开发者模式" }).check();
      await expect(modal.getByRole("button", { name: "从本地文件夹加载插件" })).toBeDisabled();
      await expect(modal.locator("input[webkitdirectory]")).toBeDisabled();
      await expect(modal.getByText("此版本暂不运行未经审核的 HTML 插件。").first()).toBeVisible();
      await expect(page.locator(".plugin-sandbox-frame")).toHaveCount(0);
    } finally {
      await page.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("desktop active chat: header trigger geometry, Light mode under OS dark, Workspace toggle, and disable cleanup", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1280, height: 800 });
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-desktop-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), pluginArtifactsDir: path.resolve("../dist/plugins") });
    try {
      await hub.profile.update({ name: "速记演示主机", revision: 0 });
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
      await hub.store.createConversation("owner", ["alpha"], "插件测试对话", "plugins-chat");

      await page.goto(hub.url);
      await preparePairing(page, hub);
      await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await expect(page.locator(".connection-pill.online")).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "插件测试对话", level: 1 })).toBeVisible();

      // Explicit Light mode while OS colorScheme is dark
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

      // Install Quick Scratchpad from the marketplace (footer 工作台 menu) and verify the header panel trigger geometry (no 32px icon-button clipping)
      await openWorkspacePage(page, "插件市场");
      const modal = page.locator("dialog.plugins-modal-dialog[open]");
      await expect(modal).toBeVisible();
      const scratchCard = modal.locator('[data-plugin-id="tarobird.quick-scratchpad"]').first();
      await scratchCard.getByRole("button", { name: "安装" }).click();
      await modal.locator(".plugin-consent-box").getByRole("button", { name: "确认并安装" }).click();
      await expect(scratchCard.getByRole("button", { name: "打开" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);

      // The first installed side-panel plugin is pinned by default: an icon-only header button named after it.
      const trigger = page.locator(".conversation-header .plugin-panel-trigger").first();
      await expect(trigger).toBeVisible();
      // Icon-only, like the other header icons; the name is in aria-label and title.
      const triggerBox = await trigger.boundingBox();
      expect(triggerBox!.width).toBeLessThanOrEqual(34);
      expect(triggerBox!.height).toBeLessThanOrEqual(34);
      await expect(trigger).toHaveText("");
      await expect(trigger).toHaveAttribute("aria-label", "速记面板");
      await expect(trigger).toHaveAttribute("title", "速记面板");
      await expect(trigger.locator("span")).toHaveCount(0);

      // Open Quick Scratchpad side panel
      await trigger.click();
      const sidePanel = page.locator("aside.conversation-side-panel.plugin-side-panel");
      await expect(sidePanel).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");

      // Verify guest iframe loaded in Light mode despite OS colorScheme: dark
      await expect.poll(async () => {
        const guest = page.frames().find((f) => f.url() === "about:srcdoc");
        if (!guest) return null;
        return guest.evaluate(() => ({
          copy: document.getElementById("copy-btn")?.textContent ?? "",
          innerHeading: document.getElementById("heading") !== null,
          theme: document.body.dataset.theme ?? "light",
        })).catch(() => null);
      }, { timeout: 10000 }).toEqual({ copy: "复制", innerHeading: false, theme: "light" });

      // The panel header is the conversation header's height, so their bottom borders line up;
      // the plugin's name is shown once, by the App header, not again inside the plugin.
      const headerBottoms = await page.evaluate(() => [".conversation-header", ".plugin-side-panel-header"]
        .map(selector => Math.round(document.querySelector(selector)!.getBoundingClientRect().bottom)));
      expect(headerBottoms[1]).toBe(headerBottoms[0]);

      const scratchpad = page.frameLocator(".plugin-sandbox-frame").frameLocator("iframe");
      await scratchpad.locator("#pad").fill("验收用速记");
      await scratchpad.locator("#copy-btn").click();
      const copyOnce = page.getByRole("dialog", { name: "允许「速记面板」写入剪贴板？" });
      await expect(copyOnce).toContainText("验收用速记");
      await copyOnce.getByRole("button", { name: "取消", exact: true }).click();
      await expect(copyOnce).toHaveCount(0);

      // Clicking Workspace button while plugin side panel is open must switch to Workspace and restore on close
      const wsButton = page.getByRole("button", { name: "会话工作区", exact: true });
      await wsButton.click();
      await expect(wsButton).toHaveAttribute("aria-expanded", "true");
      await expect(sidePanel).toHaveCount(0);
      await wsButton.click();
      await expect(wsButton).toHaveAttribute("aria-expanded", "false");
      await expect(sidePanel).toBeVisible();

      // The side panel narrows the conversation header and hides the pin.
      // The plugin stays reachable in the menu, and the sidebar has its own close action.
      await expect(trigger).toBeHidden();
      const pluginsMenu = page.locator(".conversation-header .plugin-menu-trigger");
      await expect(pluginsMenu).toBeVisible();
      await pluginsMenu.click();
      await expect(page.getByRole("group", { name: "插件", exact: true }).getByRole("button", { name: "速记面板", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await sidePanel.getByRole("button", { name: "关闭侧边面板", exact: true }).click();
      await expect(sidePanel).toHaveCount(0);
      await switchPluginTestLocale(page, "ja");
      await trigger.click();
      const japaneseCopy = scratchpad.getByRole("button", { name: "コピー", exact: true });
      await expect(japaneseCopy).toBeVisible();
      await expect(scratchpad.locator("#pad")).toHaveValue("验收用速记");
      await japaneseCopy.click();
      const japaneseConsent = page.getByRole("dialog", { name: /クリップボードに書き込むことを許可しますか/ });
      await expect(japaneseConsent).toContainText("验收用速记");
      await expect(japaneseConsent.getByRole("button", { name: "今回だけコピー", exact: true })).toBeVisible();
      await japaneseConsent.getByRole("button", { name: "キャンセル", exact: true }).click();
      await expect(japaneseConsent).toHaveCount(0);
      await switchPluginTestLocale(page, "zh");

      // Disabling Quick Scratchpad cleanly closes the active side panel
      await openWorkspacePage(page, "插件市场");
      await modal.getByRole("button", { name: /查看插件详情：速记面板/ }).first().click();
      await modal.locator(".plugin-detail-actions").getByRole("button", { name: "停用" }).click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(sidePanel).toHaveCount(0);
    } finally {
      await page.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("supported narrow browser: safe-area insets, simulated Back, and opening a side-panel plugin in MobilePluginSheet", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-phone-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), pluginArtifactsDir: path.resolve("../dist/plugins") });
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
      await hub.store.createConversation("owner", ["alpha"], "移动端插件测试", "phone-plugins");

      await page.goto(hub.url);
      await preparePairing(page, hub);
      await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });

      // Inject simulated iOS safe-area insets
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--app-safe-top", "47px");
        document.documentElement.style.setProperty("--app-safe-bottom", "34px");
      });

      // Open Me tab -> Plugin Marketplace
      await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "我的", exact: true }).click();
      await mobileHome(page).getByRole("button", { name: /插件市场/ }).click();
      const modal = page.locator("dialog.plugins-modal-dialog[open]");
      await expect(modal).toBeVisible();

      // Safe-area insets must be applied to header and body
      const insets = await modal.evaluate((el) => {
        const header = el.querySelector(".plugins-modal-header")!;
        const body = el.querySelector(".plugins-modal-body")!;
        return {
          headerTop: parseFloat(getComputedStyle(header).paddingTop),
          bodyBottom: parseFloat(getComputedStyle(body).paddingBottom),
        };
      });
      expect(insets.headerTop).toBeGreaterThanOrEqual(55);
      expect(insets.bodyBottom).toBeGreaterThanOrEqual(50);

      // Android native Back consumes event and closes PluginsModal
      const consumedByModal = await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
      expect(consumedByModal).toBe(true);
      await expect(modal).toHaveCount(0);

      // Re-open, install Quick Scratchpad, and click Open -> opens full-screen MobilePluginSheet with live sandbox iframe
      await mobileHome(page).getByRole("button", { name: /插件市场/ }).click();
      await expect(modal).toBeVisible();
      const scratchCard = modal.locator('[data-plugin-id="tarobird.quick-scratchpad"]').first();
      await scratchCard.getByRole("button", { name: "安装" }).click();
      await modal.locator(".plugin-consent-box").getByRole("button", { name: "确认并安装" }).click();
      await expect(scratchCard.getByRole("button", { name: "打开" })).toBeVisible();
      await scratchCard.getByRole("button", { name: "打开" }).click();

      await expect(modal).toHaveCount(0);
      const sheet = page.locator("dialog.plugin-mobile-sheet[open]");
      await expect(sheet).toBeVisible();
      await expect(sheet.locator("iframe.plugin-sandbox-frame")).toHaveCount(1);

      const sheetHeaderTop = await sheet.locator(".plugin-mobile-sheet-header").evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
      expect(sheetHeaderTop).toBeGreaterThanOrEqual(55);

      await expect.poll(async () => {
        const guest = page.frames().find((f) => f.url() === "about:srcdoc");
        if (!guest) return "";
        return guest.evaluate(() => document.getElementById("copy-btn")?.textContent ?? "").catch(() => "");
      }, { timeout: 10000 }).toBe("复制");

      // Native Back closes MobilePluginSheet cleanly
      const consumedBySheet = await page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
      expect(consumedBySheet).toBe(true);
      await expect(sheet).toHaveCount(0);

      // MobileHome Me tab now offers a direct launch entry for the installed side-panel plugin
      await mobileHome(page).getByRole("button", { name: /速记面板/ }).click();
      await expect(sheet).toBeVisible();
    } finally {
      await context.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unsupported native phone keeps existing Scratchpad records visible and removable without offering to launch", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    const page = await context.newPage();
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-native-entry-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    try {
      await page.goto(hub.url);
      await preparePairing(page, hub);
      await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });

      const home = mobileHome(page);
      await home.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "我的", exact: true }).click();
      const market = home.getByRole("button", { name: /插件市场/ });
      const shortcut = home.getByRole("button", { name: /^速记面板/ });
      const modal = page.locator("dialog.plugins-modal-dialog[open]");
      const scratchCard = modal.locator('[data-plugin-id="tarobird.quick-scratchpad"]').first();
      await market.click();
      await scratchCard.getByRole("button", { name: "安装", exact: true }).click();
      await modal.locator(".plugin-consent-box").getByRole("button", { name: "确认并安装", exact: true }).click();
      await expect(scratchCard.getByRole("button", { name: "打开", exact: true })).toBeEnabled();
      await modal.getByRole("button", { name: "关闭插件页", exact: true }).click();
      await expect(shortcut).toBeVisible();

      // A native WebView can still have the saved install record. Simulate
      // only capability detection while leaving the plugin sandbox untouched.
      await page.evaluate(() => {
        const { Capacitor } = window as unknown as { Capacitor: { isNativePlatform: () => boolean } };
        Capacitor.isNativePlatform = () => true;
      });
      await market.click();
      await expect(modal.getByText("此设备暂不支持插件运行。", { exact: true })).toBeVisible();
      await expect(scratchCard.getByRole("button", { name: "打开", exact: true })).toBeDisabled();
      await expect(page.locator(".plugin-sandbox-frame")).toHaveCount(0);
      await modal.getByRole("button", { name: "关闭插件页", exact: true }).click();
      await expect(shortcut).toHaveCount(0);

      await market.click();
      await modal.getByRole("button", { name: /查看插件详情：速记面板/ }).first().click();
      const actions = modal.locator(".plugin-detail-actions");
      await expect(actions.getByRole("button", { name: "打开", exact: true })).toBeDisabled();
      await actions.getByRole("button", { name: "卸载", exact: true }).click();
      await modal.getByRole("button", { name: "仅卸载，保留数据", exact: true }).click();
      await expect(actions.getByRole("button", { name: "安装", exact: true })).toBeDisabled();
      await expect(page.locator("dialog.plugin-mobile-sheet[open], .plugin-sandbox-frame")).toHaveCount(0);
    } finally {
      await context.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("producer denies static nested frames and inert workers with no WebRTC globals or DNS hints", async ({ page }) => {
    const shell = await readFile(path.resolve("public/plugin-sandbox.html"), "utf8");
    const fixture = await build({ entryPoints: ["e2e/fixtures/plugin-policy.ts"], bundle: true, write: false, platform: "browser", logLevel: "error", define: { "process.env.NODE_ENV": '"test"' } });
    const policyMessages: string[] = [];
    page.on("console", message => {
      if (/webrtc/i.test(message.text())) policyMessages.push(message.text());
    });
    await page.route("https://app.test/**", route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: fixture.outputFiles[0]!.text });
      if (pathname === "/plugin-sandbox.html") return route.fulfill({
        contentType: "text/html", body: shell, headers: { "X-DNS-Prefetch-Control": "off" },
      });
      return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": "webrtc 'block'", "Permissions-Policy": "webrtc=()" }, body: '<output id="result"></output><iframe id="shell" sandbox="allow-scripts" data-source="/plugin-sandbox.html"></iframe><script src="/fixture.js"></script>' });
    });
    await page.goto("https://app.test/");
    const result = page.locator("#result");
    await expect(result).not.toBeEmpty();
    const data = JSON.parse((await result.textContent())!);
    expect(data).toMatchObject({ childFrames: 0, hints: 0, dns: "off",
      rtc: ["undefined", "undefined", "undefined"], workerStarted: false,
    });
    for (const name of ["child-src", "frame-src", "worker-src"]) expect(data.csp).toContain(`${name} 'none'`);
    expect(data.violations).toContain("worker-src");
    expect(data.violations).toContain("frame-src");
    const frames = page.frames().map(frame => frame.url());
    expect(frames.some(url => url.startsWith("data:text/html,"))).toBe(false);
    const features = await page.evaluate(() => (document as Document & { featurePolicy?: { features(): string[] } }).featurePolicy?.features());
    expect(features).not.toContain("webrtc");
    expect(policyMessages.some(message => /unrecognized content-security-policy directive.*webrtc/i.test(message))).toBe(true);
    console.log("Plugin policy fixture", JSON.stringify({ chromium: page.context().browser()?.version(), policyMessages, frames, ...data }));

  });

  test("trusted App actions are required separately for plugin copy and export", async ({ page }) => {
    const fixture = await build({ entryPoints: ["e2e/fixtures/plugin-sensitive-action.ts"], bundle: true, write: false, platform: "browser", logLevel: "error", define: { "process.env.NODE_ENV": '"test"' } });
    await page.route("https://app.test/**", route => new URL(route.request().url()).pathname === "/fixture.js"
      ? route.fulfill({ contentType: "text/javascript", body: fixture.outputFiles[0]!.text })
      : route.fulfill({ contentType: "text/html", body: '<script src="/fixture.js"></script>' }));
    await page.goto("https://app.test/");
    const submit = (id: string, kind: "clipboard" | "export") => page.evaluate(([id, kind]) => (window as any).fixture.submit(id, kind), [id, kind]);
    const summary = () => page.evaluate(() => (window as any).fixture.summary());
    const dialog = page.getByRole("dialog");

    await submit("copy", "clipboard");
    await expect(dialog).toContainText("Fixture clipboard");
    const acceptCopy = dialog.locator("button").last();
    await acceptCopy.evaluate(button => (button as HTMLButtonElement).click());
    await expect(dialog).toBeVisible();
    expect((await summary()).effects).toEqual([]);
    await submit("concurrent", "export");
    await expect.poll(async () => (await summary()).results).toEqual(expect.arrayContaining([["concurrent", expect.objectContaining({ result: { saved: false } })]]));
    await acceptCopy.click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await summary()).effects).toEqual(["Fixture clipboard/true"]);

    await submit("copy", "clipboard");
    await expect.poll(async () => (await summary()).results).toEqual(expect.arrayContaining([["copy", expect.objectContaining({ error: "user_consent_required" })]]));
    await expect(dialog).toHaveCount(0);

    await submit("export", "export");
    await expect(dialog).toContainText("fixture.txt");
    await dialog.locator("button").last().click();
    await expect.poll(async () => (await summary()).effects).toEqual(["Fixture clipboard/true", "fixture.txt/true"]);
    await submit("expired", "clipboard");
    await expect(dialog).toBeVisible();
    await page.evaluate(() => (window as any).fixture.expire());
    await dialog.locator("button").last().click();
    await expect(dialog).toHaveCount(0);
    expect((await summary()).effects).toEqual(["Fixture clipboard/true", "fixture.txt/true"]);
  });

  test("Infinite Canvas E2E (#81): installs the release artifact and edits a native project through a live Bot turn", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-ic-e2e-"));
    const hub = await HubServer.start({
      stateDir: root,
      clientDir: path.resolve("dist"),
      pluginArtifactsDir: path.resolve("../dist/plugins"),
    });
    const botSecret = "canvas_e2e_fixture".repeat(3);
    let worker: WebSocket | undefined;
    try {
      await hub.store.db.run(
        "INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('alpha','画布助手','codex',?,1)",
        [createHash("sha256").update(botSecret).digest("hex")],
      );
      const conversation = await hub.store.createConversation("owner", ["alpha"], "无限画布联调", "ic-e2e-chat");
      const conversationId = conversation.id;

      await page.goto(hub.url);
      await preparePairing(page, hub);
      await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await expect(page.locator(".connection-pill.online")).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "无限画布联调", level: 1 })).toBeVisible();

      // Install Infinite Canvas on demand from Hub artifacts and open it in Workbench
      await openWorkspacePage(page, "插件市场");
      const modal = page.locator("dialog.plugins-modal-dialog[open]");
      await expect(modal).toBeVisible();
      const canvasCard = modal.locator('[data-plugin-id="tarobird.infinite-canvas"]').first();
      await canvasCard.getByRole("button", { name: "下载并安装" }).click();
      await modal.locator(".plugin-consent-box").getByRole("button", { name: "确认并安装" }).click();
      await expect(canvasCard.getByRole("button", { name: "打开" })).toBeVisible();
      await canvasCard.getByRole("button", { name: "打开" }).click();
      await expect(modal).toHaveCount(0);

      const guest = page.frameLocator(".plugin-sandbox-frame").frameLocator("iframe");
      await expect(guest.locator("#root")).not.toBeEmpty({ timeout: 15_000 });
      const startup = await guest.locator("#root").innerText();
      if (startup.includes("无法打开无限画布")) throw new Error(startup.slice(0, 180));
      await guest.getByRole("button", { name: "画布", exact: true }).click();
      await guest.getByRole("button", { name: "新建画布", exact: true }).first().click({ timeout: 25_000 });
      await guest.getByRole("button", { name: "Agent", exact: true }).click();
      await guest.getByText("MCP", { exact: true }).click();
      await guest.getByRole("button", { name: "连接", exact: true }).click();
      await expect(guest.getByText("Agent 连接已就绪", { exact: true })).toBeVisible();
      worker = new WebSocket(hub.instanceUrl.replace(/^http/, "ws") + "/instance");
      await new Promise<void>((resolve, reject) => {
        worker!.once("open", () => worker!.send(JSON.stringify({ v: 1, type: "instance.hello", botId: "alpha", secret: botSecret, engine: "codex", model: "", effort: "", capabilities: [] })));
        worker!.on("message", value => { if (JSON.parse(String(value)).type === "instance.ready") resolve(); });
        worker!.once("error", reject);
      });
      const received = new Promise<string>(resolve => {
        worker!.on("message", value => {
          const frame = JSON.parse(String(value));
          if (frame.type === "instance.message") resolve(frame.message.id);
        });
      });
      const turn = await hub.store.sendMessage("owner", { conversationId, clientMsgId: "canvas_editor_task", text: "Add a text node", attachments: [] });
      // Wait for the actual worker socket delivery and the Host's current-turn fence.
      await expect(received).resolves.toBe(turn.message.id);
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await fetch(hub.instanceUrl + "/api/canvas-agent/mcp", {
          method: "POST", headers: { Authorization: `Instance alpha:${botSecret}`, "x-tarobird-conversation-id": conversationId,
            "x-tarobird-context-message": turn.message.id, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        });
        expect(response.ok).toBe(true);
        const result = await response.json();
        expect(result.result?.isError, JSON.stringify(result)).not.toBe(true);
        return result.result.content[0].text as string;
      };
      await call("canvas_apply_ops", { ops: [{ type: "add_node", id: "e2e_text", nodeType: "text", title: "Native canvas note", x: 60, y: 80 }] });
      expect(await call("canvas_get_state", {})).toContain("Native canvas note");
    } finally {
      worker?.terminate();
      await page.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Infinite Canvas third-party nodes require consent and run the selected input in isolation", async ({ page }) => {
    test.setTimeout(105_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    const shotDirectory = process.env.TAROBOT_CANVAS_SHOT_DIR;
    if (shotDirectory) await mkdir(shotDirectory, { recursive: true });
    const shot = async (name: string) => {
      if (shotDirectory && (!process.env.TAROBOT_CANVAS_SHOT_ONLY || process.env.TAROBOT_CANVAS_SHOT_ONLY === name)) await page.screenshot({ path: path.join(shotDirectory, name), animations: "disabled" });
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-canvas-nodes-"));
    const hub = await HubServer.start({
      stateDir: root,
      clientDir: path.resolve("dist"),
      pluginArtifactsDir: path.resolve("../dist/plugins"),
    });
    const url = `https://raw.githubusercontent.com/example/canvas-fixture/${"a".repeat(40)}/upper.js`;
    const source = 'export default function render(node) { return { text: "Fixture rendered: " + node.text.toUpperCase(), color: "#335577" }; }\n';
    const digest = createHash("sha256").update(source).digest("hex");
    let sourceRequests = 0;
    try {
      await hub.profile.update({ name: "设计演示主机", revision: 0 });
      await page.route(url, route => {
        sourceRequests++;
        return route.fulfill({ contentType: "text/plain; charset=utf-8", body: source });
      });
      await hub.store.db.run(
        "INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('alpha','画布助手','codex',?,1)",
        [createHash("sha256").update("canvas_node_e2e_fixture").digest("hex")],
      );
      await hub.store.createConversation("owner", ["alpha"], "第三方画布节点联调", "ic-node-e2e");
      await page.goto(hub.url);
      await preparePairing(page, hub);
      await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await expect(page.getByRole("heading", { name: "第三方画布节点联调", level: 1 })).toBeVisible();

      if (shotDirectory) {
        await page.getByRole("button", { name: "工作台", exact: true }).click();
        const toInstall = page.locator('.workbench-start [data-workbench-plugin-download="tarobird.infinite-canvas"]');
        await expect(toInstall).toBeVisible();
        await shot("01-workbench-entry-uninstalled.png");
        await toInstall.click();
      } else {
        await openWorkspacePage(page, "插件市场");
      }
      const marketplace = page.locator("dialog.plugins-modal-dialog[open]");
      const card = marketplace.locator('[data-plugin-id="tarobird.infinite-canvas"]').first();
      if (!shotDirectory) await card.getByRole("button", { name: "下载并安装" }).click();
      const consent = marketplace.locator(".plugin-consent-box");
      await expect(consent).toBeVisible();
      await shot("03-install-confirmation.png");
      await consent.getByRole("button", { name: "确认并安装" }).click();
      await expect(card.getByRole("button", { name: "打开" })).toBeVisible();
      if (shotDirectory) {
        await page.keyboard.press("Escape");
        await expect(marketplace).toHaveCount(0);
        const installedEntry = page.locator('.workbench-start [data-workbench-plugin="tarobird.infinite-canvas"]');
        await expect(installedEntry).toBeVisible();
        await shot("02-workbench-entry-installed.png");
        await installedEntry.click();
      } else {
        await card.getByRole("button", { name: "打开" }).click();
      }
      await expect(marketplace).toHaveCount(0);

      const guest = page.frameLocator(".plugin-sandbox-frame").frameLocator("iframe");
      const openSettings = async () => {
        await guest.getByRole("button", { name: "配置", exact: true }).click();
        const settings = guest.getByRole("dialog", { name: "设置", exact: true });
        await settings.getByRole("tab", { name: "插件", exact: true }).click();
        return settings;
      };
      let settings = await openSettings();
      const licenses = settings.getByText("开源许可 · Open-source licenses · オープンソースライセンス", { exact: true });
      await licenses.click();
      await expect(settings.locator("pre").filter({ hasText: "tw-animate-css@1.4.0" })).toBeVisible();
      await licenses.click();
      const allow = guest.getByRole("checkbox", { name: "允许安装第三方节点" });
      await expect(allow).not.toBeChecked();
      await expect(guest.getByRole("textbox", { name: "源文件 URL" })).toHaveCount(0);
      await allow.click();
      const guestReview = guest.getByRole("alertdialog", { name: "确认第三方节点操作" });
      await expect(guestReview).toContainText("独立运行环境");
      await guestReview.getByRole("button", { name: "取消", exact: true }).click();
      await expect(allow).not.toBeChecked();
      await allow.click();
      await guestReview.getByRole("button", { name: "继续", exact: true }).click();
      const allowDialog = page.getByRole("alertdialog", { name: "允许第三方画布节点" });
      await expect(allowDialog).toBeVisible();
      await shot("04-third-party-node-enable.png");
      await allowDialog.getByRole("button", { name: "允许", exact: true }).click();
      await expect(allow).toBeChecked();

      await guest.getByRole("textbox", { name: "源文件 URL" }).fill(url);
      await guest.getByRole("button", { name: "检查并安装", exact: true }).click();
      await expect(guestReview).toContainText(url);
      expect(sourceRequests).toBe(0);
      await guestReview.getByRole("button", { name: "继续", exact: true }).click();
      const installDialog = page.getByRole("alertdialog", { name: "安装第三方画布节点" });
      await expect(installDialog).toContainText(url);
      await expect(installDialog).toContainText(digest);
      await shot("05-third-party-node-source-and-sha256.png");
      await installDialog.getByRole("button", { name: "确认安装", exact: true }).click();
      const installed = settings.getByRole("listitem").filter({ hasText: digest });
      await expect(installed).toContainText("Third-party");
      expect(sourceRequests).toBe(1);
      await settings.getByRole("button", { name: "关闭", exact: true }).click();

      await guest.getByRole("button", { name: "画布", exact: true }).click();
      await guest.getByRole("button", { name: "新建画布", exact: true }).first().click();
      await guest.getByRole("button", { name: "扩展节点与工具", exact: true }).click();
      await guest.getByRole("button", { name: /^第三方节点/ }).click();
      const node = guest.locator("[data-node-id]").filter({ hasText: "第三方节点" });
      await node.dblclick();
      const panel = guest.locator("[data-node-panel]");
      await panel.getByRole("combobox", { name: "第三方插件" }).selectOption({ index: 1 });
      await panel.getByRole("textbox", { name: "节点文本" }).fill("only this node");
      await panel.getByRole("button", { name: "完成", exact: true }).click();
      await node.getByRole("button", { name: "运行节点", exact: true }).click();
      await expect(node.getByText("Fixture rendered: ONLY THIS NODE", { exact: true })).toBeVisible();
      expect(sourceRequests).toBe(1);
      if (shotDirectory) {
        await page.getByRole("button", { name: "展开到主区", exact: true }).click();
        await expect(page.locator("aside.workbench-wide")).toBeVisible();
        await expect(node.getByText("Fixture rendered: ONLY THIS NODE", { exact: true })).toBeVisible();
        const bounds = await page.locator("aside.workbench-wide").boundingBox();
        expect(bounds!.width).toBeGreaterThan(900);
        await shot("06-open-canvas.png");
      }

      settings = await openSettings();
      await allow.click();
      await expect(allow).not.toBeChecked();
      await expect(settings.getByRole("listitem").filter({ hasText: digest })).toBeVisible();
      await settings.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(node.getByText("第三方节点已停用", { exact: true })).toBeVisible();
      await expect(node.getByRole("button", { name: "运行节点", exact: true })).toHaveCount(0);
      await expect(node.getByText("Fixture rendered: ONLY THIS NODE", { exact: true })).toHaveCount(0);

      await switchPluginTestLocale(page, "ja");
      settings = await openSettings();
      const japaneseAllow = settings.getByRole("checkbox", { name: "サードパーティノードのインストールを許可" });
      await expect(japaneseAllow).not.toBeChecked();
      await expect(settings.getByText("サードパーティノードは無効です。インストール済みのプラグインは保持されます。", { exact: true })).toBeVisible();
      await japaneseAllow.click();
      const japaneseReview = guest.getByRole("alertdialog", { name: "サードパーティノードの操作を確認" });
      await expect(japaneseReview).toBeVisible();
      await japaneseReview.getByRole("button", { name: "キャンセル", exact: true }).click();
      await expect(japaneseAllow).not.toBeChecked();
      await settings.getByRole("button", { name: "关闭", exact: true }).click();
      await guest.getByRole("button", { name: "Agent", exact: true }).click();
      await guest.getByText("MCP", { exact: true }).click();
      await expect(guest.getByText("この会話の TaroBird Bot を接続すると、現在のキャンバスを操作できるようになります。", { exact: true })).toBeVisible();
      await expect(guest.getByRole("button", { name: "接続する", exact: true })).toBeVisible();

    } finally {
      await page.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });

});

/** The device's saved pins, read from the host registry like other "save, then reload" journeys do. */
async function savedPluginPins(page: Page): Promise<string[] | null> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("tarocub-hosts-v1"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      return await new Promise<string[] | null>((resolve, reject) => { const request = db.transaction("meta").objectStore("meta").get("preferences"); request.onsuccess = () => {
        const preferences = request.result ? JSON.parse(request.result) : {};
        const [scopePins] = Object.values(preferences.pinnedPluginsByScope ?? {}) as string[][];
        resolve(scopePins ?? preferences.pinnedPlugins ?? null);
      }; request.onerror = () => reject(request.error); });
    } finally { db.close(); }
  });
}

test("desktop header: one 插件 menu lists installed plugins, pins persist across reload, and opens the market", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const root = await mkdtemp(path.join(os.tmpdir(), "plugins-menu-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), pluginArtifactsDir: path.resolve("../dist/plugins") });
  try {
    await hub.profile.update({ name: "插件菜单主机", revision: 0 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    await hub.store.createConversation("owner", ["alpha"], "插件菜单对话", "plugins-menu-chat");
    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(page.getByRole("heading", { name: "插件菜单对话", level: 1 })).toBeVisible();
    const header = page.locator(".conversation-header");
    const menuButton = header.getByRole("button", { name: "插件", exact: true });
    // Nothing installed: no plugin menu in the header.
    await expect(menuButton).toHaveCount(0);

    await openWorkspacePage(page, "插件市场");
    const modal = page.locator("dialog.plugins-modal-dialog[open]");
    const scratchCard = modal.locator('[data-plugin-id="tarobird.quick-scratchpad"]').first();
    await scratchCard.getByRole("button", { name: "安装" }).click();
    await modal.locator(".plugin-consent-box").getByRole("button", { name: "确认并安装" }).click();
    await expect(scratchCard.getByRole("button", { name: "打开" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);

    const pinned = header.locator(".plugin-panel-trigger.is-pinned");
    await expect(pinned).toHaveCount(1);
    await expect(menuButton).toBeVisible();
    await menuButton.click();
    const menu = page.getByRole("menu", { name: "插件" }).or(page.locator(".desktop-menu.plugin-menu"));
    await expect(menu).toContainText("已装插件");
    await expect(menu).toContainText("速记面板");
    const pin = menu.getByRole("button", { name: "取消固定「速记面板」", exact: true });
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(pin).toHaveText("已固定");
    await pin.click();
    await expect(pinned).toHaveCount(0);
    await expect.poll(() => savedPluginPins(page)).toEqual([]);

    // The unpinned choice survives a reload; the plugin is still one click away in the menu.
    await page.reload(); await expect(page.locator(".connection-pill.online")).toHaveCount(1);
    await expect(pinned).toHaveCount(0);
    await menuButton.click();
    await menu.getByRole("button", { name: "速记面板", exact: true }).click();
    const sidePanel = page.locator("aside.conversation-side-panel.plugin-side-panel");
    await expect(sidePanel).toBeVisible();
    await menuButton.click();
    await menu.getByRole("button", { name: "固定「速记面板」到顶栏", exact: true }).click();
    await expect(pinned).toHaveCount(1);
    await expect.poll(() => savedPluginPins(page)).toEqual(["tarobird.quick-scratchpad:scratchpad"]);
    await page.keyboard.press("Escape");
    await page.reload(); await expect(page.locator(".connection-pill.online")).toHaveCount(1);
    await expect(pinned).toHaveCount(1);

    // The market is the last item.
    await menuButton.click();
    await menu.getByRole("button", { name: "插件市场…", exact: true }).click();
    await expect(page.locator("dialog.plugins-modal-dialog[open]")).toBeVisible();
  } finally {
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
