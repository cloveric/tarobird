import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
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
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), pluginArtifactsDir: path.resolve("../dist/plugins") });
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
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), pluginArtifactsDir: path.resolve("../dist/plugins") });
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

  test("Infinite Canvas E2E (#81): real Bot MCP tool call via plugin-sandbox.html, SVG XSS safety, host workspace export, and locale stability", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const root = await mkdtemp(path.join(os.tmpdir(), "plugins-ic-e2e-"));
    const hub = await HubServer.start({
      stateDir: root,
      clientDir: path.resolve("dist"),
      pluginArtifactsDir: path.resolve("../dist/plugins"),
    });
    const botSecret = "bot-secret-e2e-0123456789abcdef01";
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
      await page.locator(".conversation-header .plugins-trigger").click();
      const modal = page.locator("dialog.plugins-modal-dialog[open]");
      await expect(modal).toBeVisible();
      const canvasCard = modal.locator('[data-plugin-id="tarobird.infinite-canvas"]').first();
      await canvasCard.getByRole("button", { name: "安装" }).click();
      await modal.locator(".plugin-consent-box").getByRole("button", { name: "确认并安装" }).click();
      await expect(canvasCard.getByRole("button", { name: "打开" })).toBeVisible();
      await canvasCard.getByRole("button", { name: "打开" }).click();
      await expect(modal).toHaveCount(0);

      // Wait for Infinite Canvas to load inside the nested sandbox iframe AND connect Canvas Agent over /ws
      await expect.poll(async () => {
        const guest = page.frames().find((f) => f.url() === "about:srcdoc");
        if (!guest) return false;
        return guest.evaluate(() => document.body.innerText.includes("无限画布") || document.body.innerText.includes("Infinite Canvas")).catch(() => false);
      }, { timeout: 15000 }).toBe(true);

      await expect.poll(() => hub.canvasAgent.statusForConversation(conversationId).connected, { timeout: 15000 }).toBe(true);

      // Bug #1 + #5: Execute a REAL Bot MCP tool call end-to-end through HubServer -> HubConnection (/ws) -> PluginSandboxFrame -> plugin-sandbox.html -> InfiniteCanvasApp
      const applyRes = await fetch(`${hub.url}/api/canvas-agent/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Instance alpha:${botSecret}`,
          "x-tarobird-conversation-id": conversationId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "canvas_apply_ops",
            arguments: {
              ops: [
                { type: "add_node", id: "e2e_txt", nodeType: "text", title: "Bot Created Card", metadata: { content: "Live E2E roundtrip" } },
                {
                  type: "add_node",
                  id: "e2e_svg",
                  nodeType: "svg",
                  title: "Adversarial SVG",
                  metadata: {
                    content: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" onload="window.__svgXss=1"><script>window.__svgXss=2</script><rect width="80" height="40" fill="blue"/></svg>',
                  },
                },
              ],
            },
          },
        }),
      });
      expect(applyRes.status).toBe(200);
      const applyBody = await applyRes.json() as { result?: { isError?: boolean; content: Array<{ text: string }> } };
      expect(applyBody.result?.isError).not.toBe(true);
      expect(applyBody.result?.content[0]?.text).toContain("e2e_txt");

      const stateRes = await fetch(`${hub.url}/api/canvas-agent/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Instance alpha:${botSecret}`,
          "x-tarobird-conversation-id": conversationId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "canvas_get_state", arguments: {} },
        }),
      });
      expect(stateRes.status).toBe(200);
      const stateBody = await stateRes.json() as { result?: { content: Array<{ text: string }> } };
      expect(stateBody.result?.content[0]?.text).toContain("Bot Created Card");
      expect(stateBody.result?.content[0]?.text).toContain("Adversarial SVG");

      // Bug #9: Verify SVG rendered via <img src="blob:..."> with ZERO script execution
      const guest = page.frames().find((f) => f.url() === "about:srcdoc")!;
      await expect.poll(async () => guest.evaluate(() => ({
        xss: (window as unknown as Record<string, unknown>).__svgXss ?? null,
        hasBlobImg: [...document.querySelectorAll("img")].some((img) => img.src.startsWith("blob:")),
        hasInlineSvgScript: document.querySelectorAll("svg script").length > 0,
      })), { timeout: 10000 }).toEqual({ xss: null, hasBlobImg: true, hasInlineSvgScript: false });

      // Bug #13: Export Workspace works through host bridge and triggers a real browser download
      await guest.getByRole("button", { name: /设置|Settings/ }).click();
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 10000 }),
        guest.getByRole("button", { name: /导出画布备份|Export Workspace/ }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/infinite-canvas-(?:backup|workspace).*\.json$/);

      // Bug #12: Switching app UI language must NOT disconnect Canvas Agent
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.locator("#language").selectOption("en");
      await page.getByRole("button", { name: /Close settings|关闭设置/ }).click();
      expect(hub.canvasAgent.statusForConversation(conversationId).connected).toBe(true);
      const afterLocaleRes = await fetch(`${hub.url}/api/canvas-agent/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Instance alpha:${botSecret}`,
          "x-tarobird-conversation-id": conversationId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "canvas_get_state", arguments: {} },
        }),
      });
      expect(afterLocaleRes.status).toBe(200);
      const afterLocaleBody = await afterLocaleRes.json() as { result?: { content: Array<{ text: string }> } };
      expect(afterLocaleBody.result?.content[0]?.text).toContain("Bot Created Card");
    } finally {
      await page.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
