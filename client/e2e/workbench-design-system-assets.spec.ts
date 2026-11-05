import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { readFile } from "node:fs/promises";
import { createServer } from "./fixtures/vite.js";

// Production DesignFrame + pinned canvas editor + IndexedDB. Source identity
// and image bytes are disposable fixtures; this does not certify installed Apps.
const html = `<!doctype html><html><body style="margin:0"><div id="mount" style="width:1200px;height:800px"></div><script type="module">
import {ClientCache} from '/src/storage.ts';
import {DesignSession} from '/src/workbench-design-session.ts';
import {designFrame} from '/src/design-frame.ts';
import {emptyDesign,designTextFile,applyDesignFiles,decodeDesignFile} from '/src/workbench-design.ts';
import {designSystemInstall} from '/src/workbench-design-system.ts';
const scope='local-private-source-scope',cache=new ClientCache('ds-assets-test');
const text=f=>new TextDecoder().decode(decodeDesignFile(f));
let document=await cache.readWorkbenchDesign(scope,'target');
if(!document){
 const asset=designTextFile('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#e02020"/></svg>','image/svg+xml'),id=asset.sha256.slice(0,32);
 const source={schema:1,id:'brand',format:'design-system',revision:0,receipts:[],files:{
  'project/tokens.json':designTextFile('{}','application/json'),
  ['project/assets/'+id]:asset,
  'project/Preview.dc.html':designTextFile(text(emptyDesign('brand','DS image preview').files['project/Main.dc.html']).replace('</head>','<style>#ds-background{width:40px;height:40px;background-image:url(/_blob/'+id+')}</style></head>').replace('</h1>','</h1><img alt="Installed DS logo" width="32" height="32" src="/_blob/'+id+'"><div id="ds-background"></div>'),'text/html')
 }};
 const target=emptyDesign('target','DS image preview');
 document=applyDesignFiles(target,designSystemInstall(target,source,{scope:'private-hub-user-conversation',id:'brand',title:'Brand'}));
 document=applyDesignFiles(document,{'project/Main.dc.html':{base64:document.files['project/ds/system-brand/Preview.dc.html'].base64,contentType:'text/html',ifMatch:document.files['project/Main.dc.html'].sha256}});
 document={...document,revision:0};await cache.saveWorkbenchDesign(scope,-1,document);
}
const session=new DesignSession(document,()=>cache.readWorkbenchDesign(scope,'target'),(expected,next,sidecar)=>cache.saveWorkbenchDesign(scope,expected,next,sidecar),()=>{}, {user:()=>({id:'owner',name:'Owner'})});
const reads=[],originalRequest=session.request.bind(session);session.request=(op,payload)=>{reads.push(op);return originalRequest(op,payload);};
window.fixture={session,text,reads,async remoteImage(){
 const asset=designTextFile('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2050e0"/></svg>','image/svg+xml'),id=asset.sha256.slice(0,32);
 const current=session.document,main=current.files['project/Main.dc.html'];
 const html=designTextFile(text(main).replace('</h1>','</h1><img alt="Remote image" width="32" height="32" src="/_blob/'+id+'">'),'text/html');
 const entry=(file,ifMatch)=>({sha256:file.sha256,size:file.size,contentType:file.contentType,ifMatch});
 await session.requestForShare({kind:'commit',from:{userId:'guest',name:'Guest',role:'editor',requestId:'remote-image'},admit:async()=>{},pull:async sha=>[asset,html].find(file=>file.sha256===sha),payload:{baseRevision:current.revision,files:{['project/assets/'+id]:entry(asset,null),'project/Main.dc.html':entry(html,main.sha256)}}});
}};
designFrame(session).attach(window.document.querySelector('#mount'),error=>{window.fixtureError=error;},()=>{});
</script></body></html>`;
let server: ViteDevServer, url: string;
test.use({ serviceWorkers: "block" });
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "ds-asset-fixture", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__ds_assets") return next();
      res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__ds_assets", html));
    });
  } }], server: { port: 0, strictPort: false, host: "127.0.0.1", hmr: false, watch: null } });
  await server.listen(); url = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => { await server?.close(); });

test("an ordinary DB edit delivers its event without reloading the document's assets", async ({ page }) => {
  await page.goto(url + "__ds_assets");
  const runtime = page.frameLocator('.workbench-design-frame');
  await expect(runtime.frameLocator('iframe').getByAltText('Installed DS logo')).toBeVisible({ timeout: 30_000 });
  await runtime.locator('body').evaluate(node => {
    const w = node.ownerDocument.defaultView as any;
    w.dbChangesSeen = 0; w.dbEvents = new w.EventSource('/_api/events');
    w.dbEvents.addEventListener('change', () => { w.dbChangesSeen++; });
  });
  await page.evaluate(async () => { const f = (window as any).fixture; f.reads.length = 0; await f.session.request('db.write', { op: 'set', path: 'items/plain', data: { label: '普通数据' } }); });
  await expect.poll(() => runtime.locator('body').evaluate(node => (node.ownerDocument.defaultView as any).dbChangesSeen)).toBe(1);
  expect(await page.evaluate(() => (window as any).fixture.reads.filter((op: string) => op === 'assets' || op === 'list'))).toEqual([]);
});

test("an image received through a shared edit renders without reopening the editor", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(url + "__ds_assets");
  const artboard = page.frameLocator('.workbench-design-frame').frameLocator('iframe');
  await expect(artboard.getByAltText('Installed DS logo')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => (window as any).fixture.remoteImage());
  await expect(artboard.getByAltText('Remote image')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => artboard.getByAltText('Remote image').evaluate(node => (node as HTMLImageElement).naturalWidth), { timeout: 5_000 }).toBe(32);
  await expect(artboard.getByAltText('Remote image')).toHaveAttribute('src', /^blob:/);
});

test("the real frame returns the export receipt and permits trusted fullscreen", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(url + "__ds_assets");
  await expect(page.frameLocator('.workbench-design-frame').frameLocator('iframe').getByAltText('Installed DS logo')).toBeVisible({ timeout: 30_000 });
  const editor = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
  // Exercise the actual runtime/parent bridge from a trusted browser click.
  // The parent performs the download and only then acknowledges the filename.
  await editor.evaluate(() => {
    const button = document.createElement('button'); button.textContent = 'Fixture export';
    button.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647';
    button.onclick = () => { void (window as any).__baoyuSave(new Blob(['portable export'], { type: 'text/plain' }), 'design-export.txt')
      .then((result: unknown) => { (window as any).exportReceipt = result; }, (error: unknown) => { (window as any).exportError = error; });
    };
    document.body.append(button);
  });
  expect(await editor.evaluate(() => (window as any).exportReceipt)).toBeUndefined();
  const download = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Fixture export', exact: true }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toBe('design-export.txt');
  expect(await readFile((await exported.path())!, 'utf8')).toBe('portable export');
  await expect.poll(() => editor.evaluate(() => (window as any).exportReceipt)).toEqual({ shown: 'design-export.txt' });
  expect(await editor.evaluate(() => (window as any).exportError)).toBeUndefined();

  await editor.evaluate(() => {
    const button = document.createElement('button'); button.textContent = 'Fixture fullscreen';
    button.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647';
    button.onclick = () => { void document.documentElement.requestFullscreen().catch(error => { (window as any).fullscreenError = String(error); }); };
    document.body.append(button);
  });
  await editor.getByRole('button', { name: 'Fixture fullscreen', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('IFRAME');
  expect(await editor.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  expect(await editor.evaluate(() => (window as any).fullscreenError)).toBeUndefined();
  await page.evaluate(() => document.exitFullscreen());
});

test("installed DS assets render and remain portable after editing, saving and reloading", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(url + "__ds_assets");
  const check = async () => {
    await expect.poll(async () => {
      for (const frame of page.frames()) {
        const image = frame.getByAltText("Installed DS logo", { exact: true });
        if (await image.count()) return image.evaluate(node => ({ complete: (node as HTMLImageElement).complete, width: (node as HTMLImageElement).naturalWidth }));
      }
      return null;
    }, { timeout: 30_000 }).toEqual({ complete: true, width: 32 });
    const frame = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
    expect(await frame.locator("#ds-background").evaluate(node => getComputedStyle(node).backgroundImage)).toContain("blob:");
    const stored = await page.evaluate(() => {
      const f = (window as any).fixture;
      return { html: f.text(f.session.document.files["project/ds/system-brand/Preview.dc.html"]), meta: f.text(f.session.document.files["project/ds/system-brand/tarobot-source.json"]) };
    });
    expect(stored.html).toContain("/project/ds/system-brand/assets/"); expect(stored.html).not.toContain("blob:");
    expect(stored.meta).not.toContain("private-hub-user-conversation");
  };
  try {
    await check();
    const artboard = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
    const heading = artboard.locator("h1"), box = await heading.boundingBox();
    await heading.click({ position: { x: 10, y: box!.height / 2 } });
    await expect(heading).toHaveAttribute("data-dc-editor-selected", "");
    await heading.dblclick({ position: { x: 10, y: box!.height / 2 } });
    await expect(heading).toHaveAttribute("contenteditable", "true");
    await page.keyboard.press("Meta+A"); await page.keyboard.type("Saved DS image preview"); await page.keyboard.press("Escape");
    await expect(heading).toHaveText("Saved DS image preview");
    await page.evaluate(() => (window as any).fixture.session.flush());
    const saved = await page.evaluate(() => {
      const f = (window as any).fixture;
      return { revision: f.session.document.revision, html: f.text(f.session.document.files["project/Main.dc.html"]) };
    });
    expect(saved.revision).toBeGreaterThan(0); expect(saved.html).toContain("Saved DS image preview");
    expect(saved.html).toContain("/project/ds/system-brand/assets/"); expect(saved.html).not.toContain("blob:");
    await page.reload(); await check();
    const reloaded = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())!;
    await expect(reloaded.locator("h1")).toHaveText("Saved DS image preview");
    expect(errors).toEqual([]);
  }
  catch (error) {
    console.log("DS_ASSET_STATE", await page.evaluate(() => ({ fixture: !!(window as any).fixture, error: (window as any).fixtureError })), errors);
    for (const frame of page.frames()) console.log("DS_ASSET_FRAME", frame.url().slice(0, 100), (await frame.locator("body").innerText().catch(() => "")).slice(0, 1500));
    throw error;
  }
});
