import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
let server: ViteDevServer;
test.beforeAll(async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="settings-content"><div id="root"></div></main><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Capacitor,registerPlugin} from '@capacitor/core';
    import '/src/styles.css'; import '/src/brand-theme.css';
    Capacitor.isNativePlatform=()=>true; Capacitor.getPlatform=()=> 'android';
    const f=window.updateFixture={calls:[],state:{phase:'initial',configured:true,version:'1.0.88',authenticated:false},listeners:new Set(),fail:''};
    f.emit=()=>f.listeners.forEach(cb=>cb({...f.state}));
    registerPlugin('TaroBotAndroidUpdater',{web:async()=>({
      status:async()=>({...f.state}),addListener:async(name,cb)=>{f.listeners.add(cb);return{remove:async()=>f.listeners.delete(cb)}},openLogin:async()=>f.calls.push('openLogin'),cancel:async()=>{},
      invoke:async({command})=>{f.calls.push(command);
        if(command==='github_update_login_start')return{flowId:'flow',userCode:'ABCD-EFGH',verificationUri:'https://github.com/login/device',expiresIn:600,interval:5};
        if(command==='github_update_login_poll'){f.state.authenticated=true;f.state.login='demo';return{status:'authorized'}}
        if(command==='github_update_login_cancel')return{};
        if(command==='check'){f.state={...f.state,phase:'available',nextVersion:'1.0.89',notes:'Android app updates'};return{...f.state}}
        if(command==='download'){if(f.fail)throw new Error(f.fail);f.state={...f.state,phase:'ready',downloaded:true};f.emit();return{...f.state}}
        if(command==='install'){f.state={...f.state,phase:'install-pending'};f.emit();return new Promise(resolve=>{f.cancelInstall=()=>{f.state={...f.state,phase:'ready'};f.emit();resolve({...f.state})}})}
        if(command==='github_update_logout'){f.state={phase:'initial',configured:true,version:'1.0.88',authenticated:false};f.emit();return{...f.state}}
      }
    })});
    const {AndroidUpdates}=await import('/src/AndroidUpdates.tsx');
    const root=createRoot(document.getElementById('root'));f.mount=()=>root.render(React.createElement(AndroidUpdates));f.unmount=()=>root.render(null);f.mount();
  </script></body></html>`;
  server = await createServer({ plugins: [{ name: "android-update-fixture", configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (req.url !== "/__android-updates") return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__android-updates", html)); }); } }], server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); await page.goto(server.resolvedUrls!.local[0] + "__android-updates"); await expect(page.getByRole("heading", { name: "应用更新" })).toBeVisible(); await page.clock.install(); });
async function login(page: import('@playwright/test').Page) {
  await page.getByRole("button", { name: "登录 GitHub", exact: true }).click();
  await expect(page.getByLabel("GitHub 验证码")).toHaveText("ABCD-EFGH"); await page.clock.fastForward(5000);
  await expect(page.getByRole("button", { name: "下载并安装", exact: true })).toBeVisible();
}
test("Android phone update confirms, cancels in the installer and retains the verified APK across Settings navigation", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await login(page); await page.getByRole("button", { name: "下载并安装", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("由 Android 确认安装");
  await page.getByRole("button", { name: "稍后再说", exact: true }).click();
  expect(await page.evaluate(() => (window as any).updateFixture.calls.includes('download'))).toBe(false);
  await page.getByRole("button", { name: "下载并安装", exact: true }).click(); await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("请在系统页面确认安装");
  await expect(page.getByText("更新已安装，重新启动后生效。", { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).updateFixture.cancelInstall());
  await page.evaluate(() => (window as any).updateFixture.unmount()); await page.evaluate(() => (window as any).updateFixture.mount());
  await expect(page.getByRole("button", { name: "继续安装", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续安装", exact: true }).click(); await page.getByRole("button", { name: "开始更新", exact: true }).click();
  expect(await page.evaluate(() => (window as any).updateFixture.calls.filter((v: string) => v === 'download').length)).toBe(1);
  await page.evaluate(() => (window as any).updateFixture.cancelInstall());
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("android-update-ready.png") }); expect(errors).toEqual([]);
});
test("Android verification failure blocks installation and retains an explicit retry", async ({ page }) => {
  await login(page); await page.evaluate(() => { (window as any).updateFixture.fail = 'github_update_signature'; });
  await page.getByRole("button", { name: "下载并安装", exact: true }).click(); await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("签名验证失败");
  expect(await page.evaluate(() => (window as any).updateFixture.calls.includes('install'))).toBe(false);
  await expect(page.getByRole("button", { name: "下载并安装", exact: true })).toBeVisible();
});
