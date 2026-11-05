import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

let server: ViteDevServer;
test.beforeAll(async () => {
  const html = `<!doctype html><html><body><main class="settings-content"><div id="root"></div></main><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {DesktopUpdates,startDesktopUpdateChecks} from '/src/DesktopUpdates.tsx';
    import {setLocale} from '/src/i18n.ts'; import '/src/styles.css'; import '/src/brand-theme.css';
    const f=window.updateFixture; f.root=createRoot(document.getElementById('root')); f.locale=setLocale;
    f.unmount=()=>f.root.render(null); f.mount=()=>f.root.render(React.createElement(DesktopUpdates));
    f.mount(); f.stop=startDesktopUpdateChecks();
  </script></body></html>`;
  server = await createServer({ plugins: [{ name: "private-update-fixture", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => { if (req.url !== "/__updates") return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__updates", html)); });
  } }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const browser = window as any; browser.isTauri = true;
    const f = browser.updateFixture = { calls: [] as { command: string; args: unknown }[], authenticated: false, authorize: false, holdStart: false, holdInstall: false, failPoll: "", installed: 0, restarts: 0, dialogs: 0 };
    browser.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => undefined, invoke: async (command: string, args: any) => {
      f.calls.push({ command, args: command === "github_update_install" ? { offerId: args.offerId } : args });
      if (command === "github_update_info") return { configured: true, version: "1.0.0", provider: "github", authenticated: f.authenticated, login: f.authenticated ? "octocat" : undefined };
      if (command === "github_update_login_start") { const flow = { flowId: "flow-1", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresIn: 600, interval: 5 }; return f.holdStart ? new Promise(resolve => { f.releaseStart = () => resolve(flow); }) : flow; }
      if (command === "github_update_login_poll") { if (f.failPoll) throw f.failPoll; if (!f.authorize) return { status: "pending", interval: 5 }; f.authenticated = true; return { status: "authorized" }; }
      if (command === "github_update_logout") { f.authenticated = false; return; }
      if (command === "github_update_check") return { offerId: "offer-1", version: "1.1.0", body: "Signed private release notes" };
      if (command === "github_update_install") {
        f.installed++; args.onEvent.onmessage({ event: "Started", data: { contentLength: 100 } }); args.onEvent.onmessage({ event: "Progress", data: { chunkLength: 100 } });
        f.progress = (event: any) => args.onEvent.onmessage(event);
        if (f.holdInstall) return new Promise((resolve, reject) => { f.completeInstall = resolve; f.rejectInstall = reject; });
        return;
      }
      if (command === "github_update_close") { if (f.rejectInstall) { f.rejectInstall("github_update_cancelled"); f.rejectInstall = undefined; } return; }
      if (command === "restart_client") { f.restarts++; return; }
      if (["github_update_login_cancel", "github_update_close", "plugin:opener|open_url"].includes(command)) return;
      throw new Error("Unexpected fixture command: " + command);
    } };
  });
  await page.goto(server.resolvedUrls!.local[0] + "__updates");
  await expect(page.getByRole("heading", { name: "应用更新" })).toBeVisible();
});
test("private update UI signs in with a device code, requires install confirmation and signs out", async ({ page }) => {
  await page.clock.install();
  await expect(page.getByText("登录 GitHub 后可检查和安装私有更新。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).updateFixture.calls.some((call: any) => call.command === "github_update_check"))).toBe(false);
  await page.getByRole("button", { name: "登录 GitHub", exact: true }).click();
  await expect(page.getByLabel("GitHub 验证码", { exact: true })).toHaveText("ABCD-EFGH");
  await expect.poll(() => page.evaluate(() => (window as any).updateFixture.calls.find((call: any) => call.command === "plugin:opener|open_url")?.args.url)).toBe("https://github.com/login/device");
  await page.evaluate(() => { (window as any).updateFixture.authorize = true; }); await page.clock.fastForward(5_000);
  await expect(page.getByText("已登录 GitHub：octocat", { exact: true })).toBeVisible();
  await expect(page.getByText("新版本 1.1.0", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).updateFixture.installed)).toBe(0);
  // Check the logout boundary before installing: it removes an existing private offer.
  await page.getByRole("button", { name: "退出 GitHub 登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "登录 GitHub", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载并安装", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "登录 GitHub", exact: true }).click(); await page.clock.fastForward(5_000);
  await expect(page.getByRole("button", { name: "下载并安装", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下载并安装", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "安装 TaroBird 1.1.0" })).toBeVisible();
  await page.getByRole("button", { name: "稍后再说", exact: true }).click();
  expect(await page.evaluate(() => (window as any).updateFixture.installed)).toBe(0);
  await page.getByRole("button", { name: "下载并安装", exact: true }).click();
  await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await expect(page.getByText("更新已安装，重新启动后生效。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新启动 TaroBird", exact: true }).click();
  expect(await page.evaluate(() => (window as any).updateFixture.restarts)).toBe(1);
});
test("a pending device login is canceled when settings unmount and cannot revive after its start completes", async ({ page }) => {
  await page.evaluate(() => { (window as any).updateFixture.holdStart = true; });
  await page.getByRole("button", { name: "登录 GitHub", exact: true }).click();
  await expect(page.getByText("正在准备 GitHub 登录…", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).updateFixture.unmount());
  await expect(page.getByRole("heading", { name: "应用更新" })).toHaveCount(0);
  await page.evaluate(() => (window as any).updateFixture.releaseStart());
  await expect.poll(() => page.evaluate(() => (window as any).updateFixture.calls.filter((call: any) => call.command === "github_update_login_cancel").length)).toBe(1);
  expect(await page.evaluate(() => (window as any).updateFixture.calls.some((call: any) => call.command === "plugin:opener|open_url"))).toBe(false);
  await page.evaluate(() => (window as any).updateFixture.mount());
  await expect(page.getByRole("button", { name: "登录 GitHub", exact: true })).toBeVisible();
});
test("GitHub login failures are readable and localized in English", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => { const f = (window as any).updateFixture; f.locale("en"); f.failPoll = "github_update_denied"; });
  await page.getByRole("button", { name: "Sign in to GitHub", exact: true }).click(); await page.clock.fastForward(5_000);
  await expect(page.getByRole("alert")).toHaveText("GitHub sign-in was declined. You can try again.");
  await expect(page.getByRole("button", { name: "Sign in to GitHub", exact: true })).toBeVisible();
});
test("Mac waiting can be canceled and recovery must finish before the UI reports installed", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => { const f = (window as any).updateFixture; f.authorize = true; f.holdInstall = true; });
  await page.getByRole("button", { name: "登录 GitHub", exact: true }).click(); await page.clock.fastForward(5_000);
  await page.getByRole("button", { name: "下载并安装", exact: true }).click();
  await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await page.evaluate(() => (window as any).updateFixture.progress({ event: "WaitingForHost" }));
  await expect(page.getByRole("status")).toContainText("正在等待 Bot 任务结束");
  await page.getByRole("button", { name: "取消更新，继续任务", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已取消");
  await expect(page.getByRole("button", { name: "重新启动 TaroBird", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.getByRole("button", { name: "下载并安装", exact: true }).click();
  await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await page.evaluate(() => (window as any).updateFixture.progress({ event: "RestartingHost" }));
  await expect(page.getByRole("status")).toContainText("正在恢复本机主机");
  await expect(page.getByRole("button", { name: "重新启动 TaroBird", exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).updateFixture.completeInstall());
  await expect(page.getByRole("button", { name: "重新启动 TaroBird", exact: true })).toBeVisible();
});

test("private desktop update downloads can be canceled before installation without reporting success", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => { const f = (window as any).updateFixture; f.authorize = true; f.holdInstall = true; });
  await page.getByRole("button", { name: "登录 GitHub", exact: true }).click(); await page.clock.fastForward(5_000);
  await page.getByRole("button", { name: "下载并安装", exact: true }).click();
  await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("正在下载并验证签名");
  await page.getByRole("button", { name: "取消下载", exact: true }).click({ timeout: 3000 });
  await expect(page.getByRole("alert")).toContainText("已取消");
  expect(await page.evaluate(() => (window as any).updateFixture.calls.some((call: any) => call.command === "github_update_close"))).toBe(true);
  await expect(page.getByRole("button", { name: "重新启动 TaroBird", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载并安装", exact: true })).toBeEnabled();
});


test("replaced bundle with unverified Host explains recovery and only offers restart", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => { const f = (window as any).updateFixture; f.authorize = true; f.holdInstall = true; });
  await page.getByRole("button", { name: "登录 GitHub", exact: true }).click(); await page.clock.fastForward(5_000);
  await page.getByRole("button", { name: "下载并安装", exact: true }).click();
  await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await page.evaluate(() => (window as any).updateFixture.rejectInstall("github_update_installed_host_failed"));
  await expect(page.getByRole("alert")).toHaveText("应用文件已更新，但本机主机恢复尚未确认。请重新启动 TaroBird，原有数据和恢复备份已保留。");
  await expect(page.getByText("更新已安装，重新启动后生效。", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "检查更新", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "退出 GitHub 登录", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "下载并安装", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "重新启动 TaroBird", exact: true }).click();
  expect(await page.evaluate(() => (window as any).updateFixture.restarts)).toBe(1);
});


test("unconfirmed rollback explains manual recovery and blocks reinstall and restart", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => { const f = (window as any).updateFixture; f.authorize = true; f.holdInstall = true; });
  await page.getByRole("button", { name: "登录 GitHub", exact: true }).click(); await page.clock.fastForward(5_000);
  await page.getByRole("button", { name: "下载并安装", exact: true }).click();
  await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await page.evaluate(() => (window as any).updateFixture.rejectInstall("github_update_recovery"));
  await expect(page.getByRole("alert")).toHaveText("更新恢复未完成，旧版应用备份已保留。请联系支持，不要清理应用数据。");
  await expect(page.getByRole("button", { name: "检查更新", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "退出 GitHub 登录", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "下载并安装", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重新启动 TaroBird", exact: true })).toHaveCount(0);
  await expect(page.getByText("更新已安装，重新启动后生效。", { exact: true })).toHaveCount(0);
});
