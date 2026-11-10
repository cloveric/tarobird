import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

// Real DOM, mutation observers and layout scheduler; only Electron IPC is a
// stand-in. Synthetic chat content never leaves this local fixture.
const html = `<!doctype html><body><main id="chat"></main><aside class="workbench"><div id="surface" style="width:400px;height:400px"></div></aside><script type="module">
const f=window.browserLayoutFixture={calls:[],scans:0};
window.tarobotDesktop={version:1,engine:'electron',platform:'darwin',openSocket:async()=>{},on:()=>()=>{},invoke:async(command,args)=>{if(command==='workbench_browser_layout')f.calls.push(args);}};
const query=document.querySelectorAll.bind(document);
document.querySelectorAll=function(selector){if(selector.includes('[data-workbench-overlay]'))f.scans++;return query(selector);};
const {registerBrowserSurface,scheduleBrowserLayout}=await import('/src/workbench-browser.ts');
f.surface=document.getElementById('surface');f.chat=document.getElementById('chat');
f.stop=registerBrowserSurface('tab',f.surface,()=>true);f.schedule=scheduleBrowserLayout;
</script>`;
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "browser-layout-fixture", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__browser_layout") return next();
      res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__browser_layout", html));
    });
  } }], server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "__browser_layout";
});
test.afterAll(async () => { await server.close(); });
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const hidden = (page: Page) => page.evaluate(() => (window as any).browserLayoutFixture.calls.at(-1)?.hidden);
test.beforeEach(async ({ page }) => {
  await page.goto(url); await expect.poll(() => hidden(page)).toBe(false);
});

test("chat streaming reuses overlay candidates and hidden pages send no overlay-only layouts", async ({ page }) => {
  const before = await page.evaluate(() => (window as any).browserLayoutFixture.scans);
  await page.evaluate(async () => {
    const f = (window as any).browserLayoutFixture;
    for (let i = 0; i < 30; i++) {
      f.chat.append(document.createTextNode(" token"));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  });
  expect(await page.evaluate(() => (window as any).browserLayoutFixture.scans) - before).toBeLessThanOrEqual(1);
  await page.evaluate(() => { (window as any).browserLayoutFixture.surface.hidden = true; }); await settle(page);
  const calls = await page.evaluate(() => (window as any).browserLayoutFixture.calls.length);
  await page.evaluate(() => { const menu = document.createElement("div"); menu.id = "menu"; menu.setAttribute("role", "menu"); menu.textContent = "Menu"; document.body.append(menu); }); await settle(page);
  await page.evaluate(() => document.querySelector("#menu")!.remove()); await settle(page);
  expect(await page.evaluate(() => (window as any).browserLayoutFixture.calls.length)).toBe(calls);
});

test("observes dynamic overlay markers, nested removal and dialog modality", async ({ page }) => {
  await page.evaluate(() => { const node = document.createElement("div"); node.id = "overlay"; node.textContent = "Overlay"; document.body.append(node); }); await settle(page);
  for (const [attribute, value] of [["role", "menu"], ["aria-modal", "true"], ["data-workbench-overlay", ""], ["class", "desktop-menu"]]) {
    await page.evaluate(([key, value]) => document.querySelector("#overlay")!.setAttribute(key, value), [attribute, value]); await settle(page); expect(await hidden(page)).toBe(true);
    await page.evaluate(key => document.querySelector("#overlay")!.removeAttribute(key), attribute); await settle(page); expect(await hidden(page)).toBe(false);
  }
  await page.evaluate(() => { const parent = document.createElement("section"); parent.id = "nest"; parent.innerHTML = '<div role="menu">Nested</div>'; document.body.append(parent); }); await settle(page); expect(await hidden(page)).toBe(true);
  await page.evaluate(() => { (document.querySelector("#nest") as HTMLElement).hidden = true; }); await settle(page); expect(await hidden(page)).toBe(false);
  await page.evaluate(() => document.querySelector("#nest")!.remove()); await settle(page);
  await page.evaluate(() => { const dialog = document.createElement("dialog"); dialog.id = "dialog"; dialog.textContent = "Dialog"; document.body.append(dialog); dialog.show(); }); await settle(page); expect(await hidden(page)).toBe(false);
  await page.evaluate(() => document.querySelector("#dialog")!.setAttribute("data-workbench-overlay", "")); await settle(page); expect(await hidden(page)).toBe(true);
  await page.evaluate(() => { const dialog = document.querySelector("#dialog") as HTMLDialogElement; dialog.removeAttribute("data-workbench-overlay"); dialog.close(); dialog.showModal(); }); await settle(page); expect(await hidden(page)).toBe(true);
  await page.evaluate(() => (document.querySelector("#dialog") as HTMLDialogElement).close()); await settle(page); expect(await hidden(page)).toBe(false);
});
