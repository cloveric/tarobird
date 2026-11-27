import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { mobileHome } from "./fixtures/mobile.js";
import { wrapSandboxedDocument } from "../src/plugin-sandbox-runtime.js";

test.describe("Plugin System E2E Regressions (#101)", () => {
  test("desktop welcome screen: Escape step-back and localized prompt when opening workbench plugin without active conversation", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-welcome-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    try {
      await page.goto(hub.url);
      await preparePairing(page, hub);
      await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await expect(page.locator(".connection-pill.online")).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "欢迎回来", level: 1 })).toBeVisible();

      // Open Marketplace and verify Escape steps back detail -> list -> closed
      await page.locator(".conversation-header .plugins-trigger").click();
      const modal = page.locator("dialog.plugins-modal-dialog[open]");
      await expect(modal).toBeVisible();

      await modal.getByRole("button", { name: /查看插件详情：无限画布/ }).first().click();
      await expect(modal.locator(".plugin-detail-page")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(modal.locator(".plugin-detail-page")).toHaveCount(0);
      await expect(modal).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);

      // Install Infinite Canvas on Welcome screen and click Open -> clean localized prompt (never raw error code)
      await page.locator(".conversation-header .plugins-trigger").click();
      await expect(modal).toBeVisible();
      const canvasCard = modal.locator('[data-plugin-id="tarobird.infinite-canvas"]').first();
      await canvasCard.getByRole("button", { name: "安装" }).click();
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

  test("desktop active chat: header trigger geometry, Light mode under OS dark, Workspace toggle, and disable cleanup", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1280, height: 800 });
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-desktop-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
    try {
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

      // Install Quick Scratchpad and verify header trigger button geometry (no 32px icon-button clipping)
      await page.locator(".conversation-header .plugins-trigger").click();
      const modal = page.locator("dialog.plugins-modal-dialog[open]");
      await expect(modal).toBeVisible();
      const scratchCard = modal.locator('[data-plugin-id="tarobird.quick-scratchpad"]').first();
      await scratchCard.getByRole("button", { name: "安装" }).click();
      await modal.locator(".plugin-consent-box").getByRole("button", { name: "确认并安装" }).click();
      await expect(scratchCard.getByRole("button", { name: "打开" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);

      const trigger = page.locator(".conversation-header .plugin-panel-trigger").first();
      await expect(trigger).toBeVisible();
      const triggerBox = await trigger.boundingBox();
      const labelBox = await trigger.locator("span").boundingBox();
      expect(triggerBox!.width).toBeGreaterThan(60);
      expect(triggerBox!.height).toBeLessThanOrEqual(36);
      expect(labelBox!.height).toBeLessThan(30);
      expect(labelBox!.y).toBeGreaterThanOrEqual(0);

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
          heading: document.getElementById("heading")?.textContent ?? "",
          theme: document.body.dataset.theme ?? "light",
        })).catch(() => null);
      }, { timeout: 10000 }).toEqual({ heading: "速记面板", theme: "light" });

      // Clicking Workspace button while plugin side panel is open must switch to Workspace and restore on close
      const wsButton = page.locator(".workspace-rail-trigger");
      await wsButton.click();
      await expect(wsButton).toHaveAttribute("aria-expanded", "true");
      await expect(sidePanel).toHaveCount(0);
      await wsButton.click();
      await expect(wsButton).toHaveAttribute("aria-expanded", "false");
      await expect(sidePanel).toBeVisible();

      // Disabling Quick Scratchpad cleanly closes the active side panel
      await page.locator(".conversation-header .plugins-trigger").click();
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

  test("phone: safe-area insets, Android native Back, and opening side-panel plugin in MobilePluginSheet", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-phone-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
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
        return guest.evaluate(() => document.getElementById("heading")?.textContent ?? "").catch(() => "");
      }, { timeout: 10000 }).toBe("速记面板");

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

  test("sandbox CSP: comment-head attack cannot bypass guest CSP and outer plugin-sandbox.html allows explicitly granted domains", async ({ page }) => {
    const shellHtml = await readFile(path.resolve("public/plugin-sandbox.html"), "utf8");
    await page.route("https://app.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/plugin-sandbox.html") {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: {
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src https: wss:; frame-src about:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts",
          },
          body: shellHtml,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><iframe id="p" sandbox="allow-scripts" src="/plugin-sandbox.html"></iframe></body></html>`,
      });
    });
    await page.route("https://api.example.com/ok", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/plain",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: "GRANTED_OK",
      });
    });
    await page.route("https://blocked.example/no", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/plain",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: "SHOULD_BE_BLOCKED",
      });
    });

    await page.goto("https://app.test/");
    // Craft an adversarial plugin bundle with leading `<!-- <head> -->` and spoofed permissive CSP meta
    const adversarialBundle = `<!-- <head> --><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><script>
      (async () => {
        const metas = [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')].map(m => m.content);
        let granted = "err";
        try { granted = await (await fetch("https://api.example.com/ok")).text(); } catch (e) { granted = "blocked:" + e.name; }
        let ungranted = "err";
        try { ungranted = await (await fetch("https://blocked.example/no")).text(); } catch (e) { ungranted = "blocked:" + e.name; }
        window.parent.postMessage({ protocol: "tarobird.plugin.v1", id: "probe", metas, granted, ungranted }, "*");
      })();
    </script></body></html>`;

    const wrapped = wrapSandboxedDocument(adversarialBundle, ["api.example.com", "127.0.0.1", "localhost"]);
    const result = await page.evaluate((docHtml) => new Promise<{ metas: string[]; granted: string; ungranted: string }>((resolve) => {
      const iframe = document.getElementById("p") as HTMLIFrameElement;
      const sendInit = () => iframe.contentWindow?.postMessage({ type: "tarobird-plugin-init", title: "Probe", document: docHtml }, "*");
      window.addEventListener("message", (event) => {
        if (event.data?.type === "tarobird-plugin-shell-ready") sendInit();
        if (event.data?.protocol === "tarobird.plugin.v1" && event.data?.id === "probe") resolve(event.data);
      });
      sendInit();
    }), wrapped);

    expect(result.metas).toHaveLength(1);
    expect(result.metas[0]).toContain("connect-src https://api.example.com wss://api.example.com;");
    expect(result.metas[0]).not.toContain("127.0.0.1");
    expect(result.metas[0]).not.toContain("localhost");
    expect(result.granted).toBe("GRANTED_OK");
    expect(result.ungranted).toMatch(/^blocked:/);
  });
});
