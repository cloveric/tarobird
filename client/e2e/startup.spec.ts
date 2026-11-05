import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots } from "./fixtures/mobile.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";

test("fresh browser contexts reach pairing without loading chat or the Markdown parser", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-startup-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const samples: { readyMs: number; scriptBytes: number; scripts: string[] }[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      // Isolate first-view work from the service worker's background offline
      // precache. This is browser-context startup, not native app cold start.
      const context = await browser.newContext({ serviceWorkers: "block" });
      try {
        const page = await context.newPage();
        const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript(() => {
          const tick = () => {
            const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "配对此设备");
            if (!button || !button.getBoundingClientRect().height || button.disabled) { requestAnimationFrame(tick); return; }
            requestAnimationFrame(() => requestAnimationFrame(() => Object.assign(window, { pairingReadyMs: performance.now() })));
          };
          requestAnimationFrame(tick);
        });
        await page.goto(hub.url);
        await page.waitForFunction(() => "pairingReadyMs" in window);
        samples.push(await page.evaluate(() => {
          const scripts = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((entry) => new URL(entry.name).pathname.endsWith(".js"));
          return { readyMs: (window as unknown as { pairingReadyMs: number }).pairingReadyMs, scriptBytes: scripts.reduce((sum, entry) => sum + entry.decodedBodySize, 0), scripts: scripts.map((entry) => new URL(entry.name).pathname) };
        }));
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
    const times = samples.map((sample) => sample.readyMs).sort((a, b) => a - b);
    const report = { surface: "local browser contexts, empty HTTP cache, service worker blocked", samples, medianMs: times[2], maxMs: times[4] };
    console.log("Browser startup", JSON.stringify(report));
    await info.attach("browser-startup", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    // Timing is reported rather than conflated with the native 1.5 s budget.
    // The deterministic byte budget catches parser dependencies leaking back
    // into the first view; background offline precaching is covered separately.
    for (const sample of samples) {
      expect(sample.scriptBytes).toBeGreaterThan(0);
      expect(sample.scriptBytes).toBeLessThan(700_000);
      expect(sample.scripts.some((name) => /\/App-[^/]+\.js$/.test(name))).toBe(false);
      expect(sample.scripts.some((name) => name.includes("markdown.worker"))).toBe(false);
      expect(sample.scripts.some((name) => /PdfPreview|pdf\.worker/.test(name))).toBe(false);
    }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("an offline page starts its cached Markdown worker after the Hub is stopped", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-offline-parser-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let stopped = false;
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','离线排版助手',?)", [hashSecret("synthetic-offline-parser-secret")]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "离线阅读", "offline-parser");
    await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "**离线格式完整**\n\n| 内容 | 状态 |\n|---|---|\n| 表格 | 保留 |\n\n$E=mc^2$\n\n```js\nconst cached = true;\n```" }] });
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page);
    await expect(page.locator(".markdown table")).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    // Stop the real Hub so neither the socket nor any app/worker/font request
    // can reach it. WebKit's synthetic offline flag does not reliably model
    // this fault (live sockets or an internal navigation error in the harness).
    await hub.close(); stopped = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".markdown strong")).toHaveText("离线格式完整");
    await expect(page.locator(".markdown table")).toBeVisible();
    await expect(page.locator(".katex")).toHaveCount(1);
    await expect(page.locator(".markdown code .hljs-keyword")).toHaveText("const");
    await expect(page.locator(".markdown-pending")).toHaveCount(0);
    await expect(page.locator(".offline-banner")).toBeVisible();
    await expect(page.getByRole("button", { name: "打开 离线排版助手", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开 alpha", exact: true })).toHaveCount(0);
    await expect(page.locator(".bot-tree-heading .online")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); if (!stopped) await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a missing chat chunk has recoverable feedback and retains the approved device on retry", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-chunk-retry-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  let release: () => void = () => undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let requested = 0;
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("**/assets/App-*.js", async route => {
    requested++;
    if (requested === 1) {
      await barrier;
      // Model a transient server outage without caching the failed response.
      await route.fulfill({ status: 503, contentType: "text/plain", headers: { "Cache-Control": "no-store" }, body: "temporarily unavailable" });
    }
    else await route.continue();
  });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "恢复聊天界面", "chunk-retry");
    await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "配对没有丢失，继续阅读。" }] });
    await page.goto(hub.url);
    await expect(page.getByRole("button", { name: "配对此设备", exact: true })).toBeVisible();
    expect(requested).toBe(0);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect.poll(() => requested).toBe(1);
    await expect(page.getByRole("status")).toHaveText("正在打开 TaroBird…");
    release();
    await expect(page.getByRole("alert")).toHaveText("聊天界面未能加载，请重试。");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByRole("heading", { name: conversation.title, exact: true })).toBeVisible();
    await expect(page.locator(".message-blocks")).toContainText("配对没有丢失，继续阅读。");
    await expect(page.getByRole("button", { name: "配对此设备", exact: true })).toHaveCount(0);
    expect(((await hub.store.devices("owner")).filter(device => device.id !== "pairing_fixture_owner"))).toHaveLength(1);
    expect(requested).toBe(2); expect(errors).toEqual([]);
  } finally { release(); await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
