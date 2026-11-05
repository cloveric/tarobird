import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Chromium exercises service-worker/document-start behavior. This does not
// claim to run the Windows binary or the user's installed WebView2 runtime.
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP tauri.localhost 127.0.0.1"] } });
let server: Server, origin: string, bootstrap: string;
const oldPage = "<body>OLD_SHELL<script nonce='fixture'>window.oldShellExecuted=true</script></body>";
const newPage = "<body>NEW_SHELL<script nonce='fixture'>window.newShellExecuted=true</script></body>";
test.beforeAll(async () => {
  bootstrap = (await readFile(new URL("../src-tauri/src/native-shell.js", import.meta.url), "utf8")).replace("__TAROBOT_VERSION__", "test-version");
  server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-fixture'; style-src 'self'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data:");
    const pathname = new URL(req.url!, "http://fixture").pathname;
    if (req.url === "/?production" || pathname.startsWith("/assets/")) {
      const file = req.url === "/?production" ? "index.html" : pathname.slice(1);
      const directory = path.resolve("dist"); const target = path.resolve(directory, file);
      if (!target.startsWith(directory + path.sep)) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      try { res.end(await readFile(target)); } catch { res.writeHead(404); res.end(); }
    } else if (req.url === "/sw.js") {
      res.setHeader("Content-Type", "application/javascript");
      // A stale offline shell stays in control even though the server now has
      // a newer application. Restore it only through the native init script.
      res.end(`self.addEventListener('install',e=>e.waitUntil(caches.open('tarocub-shell-old').then(c=>c.put('/',new Response(${JSON.stringify(oldPage)},{headers:{'Content-Type':'text/html'}}))).then(()=>self.skipWaiting())));
        self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
        self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(caches.match('/'))});`);
    } else if (req.url === "/other/sw.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end("self.addEventListener('install',()=>self.skipWaiting());");
    } else { res.setHeader("Content-Type", "text/html"); res.end(newPage); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://tauri.localhost:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

test("native document start replaces a stale shell without executing it or removing user data", async ({ page, context }) => {
  await page.goto(origin + "/#conversation=keep");
  await page.evaluate(async () => {
    localStorage.setItem("paired-host", "keep-host");
    const request = indexedDB.open("native-shell-user-data", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("data");
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction("data", "readwrite"); tx.objectStore("data").put({ keyRef: "keep-key", draft: "keep-draft" }, "saved");
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    await (await caches.open("other-files")).put("/preserved", new Response("keep-file"));
    await navigator.serviceWorker.register("/other/sw.js");
    await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.reload(); await expect(page.locator("body")).toHaveText("OLD_SHELL");
  await context.addInitScript({ content: bootstrap });
  await page.reload({ waitUntil: "commit" }).catch(() => undefined);
  await expect(page.locator("body")).toHaveText("NEW_SHELL");
  expect(await page.evaluate(() => !!(window as any).oldShellExecuted)).toBe(false);
  expect(new URL(page.url()).hash).toBe("#conversation=keep");
  expect(await page.evaluate(async () => {
    const request = indexedDB.open("native-shell-user-data");
    const db = await new Promise<IDBDatabase>((resolve) => { request.onsuccess = () => resolve(request.result); });
    const row = db.transaction("data").objectStore("data").get("saved");
    const saved = await new Promise((resolve) => { row.onsuccess = () => resolve(row.result); }); db.close();
    return { saved, host: localStorage.getItem("paired-host"), controlled: !!navigator.serviceWorker.controller,
      caches: await caches.keys(), file: await (await caches.match("/preserved"))?.text(),
      registrations: (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname) };
  })).toEqual({ saved: { keyRef: "keep-key", draft: "keep-draft" }, host: "keep-host", controlled: false,
    caches: ["other-files"], file: "keep-file", registrations: ["/other/"] });
});

test("fresh native pages do not reload or wait for recovery", async ({ page, context }) => {
  await context.addInitScript({ content: bootstrap });
  await page.goto(origin);
  await expect(page.locator("body")).toHaveText("NEW_SHELL");
  expect(await page.evaluate(() => sessionStorage.getItem("tarobot-native-shell-recovery"))).toBeNull();
});

test("native recovery leaves browser PWA workers and offline pages untouched", async ({ page, context }) => {
  const web = origin.replace("tauri.localhost", "127.0.0.1");
  await page.goto(web);
  await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.addInitScript({ content: bootstrap });
  await page.reload();
  await expect(page.locator("body")).toHaveText("OLD_SHELL");
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
});

test("failed worker removal stops old scripts, redacts errors and allows an explicit retry", async ({ page, context }) => {
  // Inject the fault before the very same production initialization script.
  await context.addInitScript({ content: `
    if(location.hostname==='tauri.localhost') {
      Object.defineProperty(navigator.serviceWorker,'controller',{value:{scriptURL:location.origin+'/sw.js'}});
      navigator.serviceWorker.getRegistrations=async()=>{throw new Error('private-path-and-token')};
    }
    ${bootstrap}` });
  await page.goto(origin, { waitUntil: "commit" }).catch(() => undefined);
  await expect(page.getByRole("heading")).toHaveText("TaroBird 页面更新未完成");
  await expect(page.getByRole("status")).toHaveText("TaroBird test-version · native_shell_recovery_failed");
  expect(await page.evaluate(() => !!(window as any).newShellExecuted)).toBe(false);
  await expect(page.locator("body")).not.toContainText("private-path-and-token");
  await page.getByRole("button", { name: "重新尝试" }).click();
  await expect(page.getByRole("button", { name: "重新尝试" })).toBeEnabled();
  await page.reload({ waitUntil: "commit" }).catch(() => undefined);
  await expect(page.getByRole("status")).toHaveText("TaroBird test-version · native_shell_still_cached");
});

test("stalled cache recovery times out without reloading or running the old app", async ({ page, context }) => {
  await page.clock.install();
  await context.addInitScript({ content: `
    if(location.hostname==='tauri.localhost') {
      Object.defineProperty(navigator.serviceWorker,'controller',{value:{scriptURL:location.origin+'/sw.js'}});
      navigator.serviceWorker.getRegistrations=()=>new Promise(()=>{});
    }
    ${bootstrap}` });
  await page.goto(origin, { waitUntil: "commit" });
  await expect(page.getByRole("heading")).toHaveText("正在更新 TaroBird 页面");
  await page.clock.fastForward(10_001);
  await expect(page.getByRole("status")).toHaveText("TaroBird test-version · native_shell_timeout");
  await expect(page.getByRole("button", { name: "重新尝试" })).toBeEnabled();
  expect(await page.evaluate(() => !!(window as any).newShellExecuted)).toBe(false);
});

test("the production native entry does not register a PWA worker", async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async () => { throw "desktop_host_launch_failed|os=5"; } } });
    (window as any).workerRegistrations = [];
    navigator.serviceWorker.register = async (url) => { (window as any).workerRegistrations.push(url); throw new Error("unexpected native registration"); };
  });
  await page.goto(origin + "/?production");
  await expect(page.getByRole("heading", { name: "TaroBird 暂时无法启动" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).workerRegistrations)).toEqual([]);
});

test("the production browser entry still registers its offline worker", async ({ page, context }) => {
  await context.addInitScript(() => {
    (window as any).workerRegistrations = [];
    navigator.serviceWorker.register = async (url) => { (window as any).workerRegistrations.push(url); throw new Error("fixture only"); };
  });
  await page.goto(origin + "/?production");
  await expect.poll(() => page.evaluate(() => (window as any).workerRegistrations)).toContain("/sw.js");
});

test("a page-cache deletion failure cannot prevent the new native page from starting", async ({ page, context }) => {
  await page.goto(origin);
  await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.addInitScript({ content: `caches.delete=async()=>{throw new Error('cache locked')};\n${bootstrap}` });
  await page.reload({ waitUntil: "commit" }).catch(() => undefined);
  await expect(page.locator("body")).toHaveText("NEW_SHELL");
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(false);
});
