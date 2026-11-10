import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

// Production frame and opaque-origin loader, with an editor that speaks the
// upstream reveal and flush messages. No native bridge or model.
const editor = `<!doctype html><body><output id="reveals">0</output><script>
let count=0;
addEventListener('message',event=>{
 if(event.source!==parent)return;
 if(event.data?.probeReady)parent.postMessage({__frame_reveal_ready:true},'*');
 if(event.data?.__frame_revealed===true)document.querySelector('output').textContent=String(++count);
 if(event.data?.type==='editor:flush')parent.postMessage({type:'editor:flushed',requestId:event.data.requestId,saved:true},'*');
});
parent.postMessage({type:'editor:ready'},'*');
</script>`;
const html = `<!doctype html><body><div class="workbench"><div id="surface" style="width:600px;height:400px"></div></div><script type="module">
import {DesignSession} from '/src/workbench-design-session.ts';
import {emptyDesign} from '/src/workbench-design.ts';
import {designFrame} from '/src/design-frame.ts';
const document=emptyDesign('fixture'),session=new DesignSession(document,async()=>document,async()=>{},()=>{});
const frame=designFrame(session), surface=window.document.getElementById('surface');
window.revealFixture={frame,surface,session,stop:frame.attach(surface,()=>{},()=>{})};
</script>`;
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "design-reveal-fixture", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__design_reveal") return next();
      res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__design_reveal", html));
    });
  } }], server: { port: 0, host: "127.0.0.1" } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "__design_reveal";
});
test.afterAll(async () => { await server.close(); });
const count = (page: Page) => page.frameLocator(".workbench-design-frame").locator("#reveals");
async function ready(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLIFrameElement>(".workbench-design-frame")!.contentWindow!.postMessage({ probeReady: true }, "*"));
}
test.beforeEach(async ({ page }) => {
  await page.route("**/design-sandbox.html", route => route.fulfill({ contentType: "text/html", body: editor }));
  await page.goto(url); await expect(count(page)).toHaveText("0");
});

test("acknowledges the current canvas once after it is actually visible", async ({ page }) => {
  await ready(page); await expect(count(page)).toHaveText("1");
  await ready(page); await ready(page);
  await page.evaluate(() => { (window as any).revealFixture.surface.hidden = true; });
  await expect(page.locator(".workbench-design-frame")).toBeHidden();
  await page.evaluate(() => { (window as any).revealFixture.surface.hidden = false; });
  await expect(page.locator(".workbench-design-frame")).toBeVisible();
  await expect(count(page)).toHaveText("1");
});

test("defers readiness behind a hidden surface or modal", async ({ page }) => {
  await page.evaluate(() => { (window as any).revealFixture.surface.hidden = true; });
  await expect(page.locator(".workbench-design-frame")).toBeHidden();
  await ready(page); await expect(count(page)).toHaveText("0");
  await page.evaluate(() => {
    const modal = document.createElement("dialog"); modal.id = "modal"; modal.textContent = "Review"; document.body.append(modal); modal.showModal();
    (window as any).revealFixture.surface.hidden = false;
  });
  await expect(page.locator(".workbench-design-frame")).toBeHidden();
  await expect(count(page)).toHaveText("0");
  await page.evaluate(() => (document.querySelector("#modal") as HTMLDialogElement).close());
  await expect(count(page)).toHaveText("1");
});

test("rejects unrelated and retired senders and resets reveal state on reload", async ({ page }) => {
  await page.evaluate(() => {
    const frame = document.createElement("iframe"); frame.id = "foreign"; frame.sandbox.add("allow-scripts");
    frame.srcdoc = '<body>foreign<script>parent.postMessage({__frame_reveal_ready:true},"*")<\/script>'; document.body.append(frame);
  });
  await expect(page.frameLocator("#foreign").locator("body")).toHaveText("foreign");
  await expect(count(page)).toHaveText("0");
  await ready(page); await expect(count(page)).toHaveText("1");
  await page.evaluate(async () => {
    (window as any).oldRevealSource = document.querySelector<HTMLIFrameElement>(".workbench-design-frame")!.contentWindow;
    await (window as any).revealFixture.frame.reload();
  });
  await expect(count(page)).toHaveText("0");
  await page.evaluate(() => {
    // WebKit's MessageEvent constructor rejects an already detached Window;
    // model a message queued before retirement without constructing that union.
    const event = new MessageEvent("message", { origin: "null", data: { __frame_reveal_ready: true } });
    Object.defineProperty(event, "source", { value: (window as any).oldRevealSource }); dispatchEvent(event);
  });
  await expect(count(page)).toHaveText("0");
  await ready(page); await expect(count(page)).toHaveText("1");
});

test("holds the acknowledgement while backgrounded or editing is locked", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".workbench-design-frame")).toBeHidden();
  await ready(page); await expect(count(page)).toHaveText("0");
  await page.evaluate(async () => {
    (window as any).resumeReveal = await (window as any).revealFixture.session.suspendEditor();
    delete (document as any).hidden; document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".workbench-design-frame")).toHaveJSProperty("inert", true);
  await expect(count(page)).toHaveText("0");
  await page.evaluate(async () => { await (window as any).resumeReveal(); });
  await expect(count(page)).toHaveText("1");
});

test("bundled canvas receives the reveal acknowledgement on open and reload", async ({ page }) => {
  // Drop the synthetic editor and its per-document runtime cache. This checks
  // the actual vendored editor independently of Host pairing and native shells.
  await page.unroute("**/design-sandbox.html"); await page.reload();
  const heading = page.frameLocator(".workbench-design-frame").frameLocator("iframe").locator("h1");
  await expect(heading).toHaveText("设计", {timeout:30_000});
  const reveals = () => page.frames().find(frame => frame.parentFrame() === page.mainFrame())!.evaluate(() => performance.getEntriesByName("design:revealed").length);
  expect(await reveals()).toBe(1);
  await page.evaluate(async () => { await (window as any).revealFixture.frame.reload(); });
  await expect(heading).toHaveText("设计", {timeout:30_000});
  expect(await reveals()).toBe(1);
});
