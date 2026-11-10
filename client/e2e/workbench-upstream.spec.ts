import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { readFile } from "node:fs/promises";
import { createServer } from "./fixtures/vite.js";
import { DESIGN_PREPARE_SCRIPT } from "../electron/design-quit.mjs";

// Real editor/session/storage without authentication fixtures: this also lets
// WebKit exercise the editor independently of browser CryptoKey persistence.
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="mount" style="height:760px;width:100%"></div><script type="module">
import {ClientCache} from '/src/storage.ts';
import {DesignSession} from '/src/workbench-design-session.ts';
import {designFrame} from '/src/design-frame.ts';
import {emptyDesignDocument,decodeDesignFile} from '/src/workbench-design.ts';
const format=new URL(location.href).searchParams.get('format')==='slides'?'slides':'canvas';
const cache=new ClientCache('upstream-editor-test');
let doc=await cache.readWorkbenchDesign('fixture',format);
if(!doc){doc=emptyDesignDocument(format,'中文 Editor upgrade',format);await cache.saveWorkbenchDesign('fixture',-1,doc);}
let comments;
const session=new DesignSession(doc,()=>cache.readWorkbenchDesign('fixture',format),(expected,next,sidecar)=>cache.saveWorkbenchDesign('fixture',expected,next,sidecar),()=>{}, {
 user:()=>({id:'owner',name:'Example'}), sendToBot:async()=> 'opened',
 comments:{load:async()=>structuredClone(comments),save:async(expected,next)=>{if((comments?.revision??0)!==expected)throw Error('design_comments_conflict');comments=structuredClone(next);}}
});
window.fixture={session,text:()=>new TextDecoder().decode(decodeDesignFile(session.document.files[format==='slides'?'project/slides/cover.html':'project/Main.dc.html']))};
designFrame(session).attach(document.querySelector('#mount'),error=>{window.fixtureError=error;},()=>{});
</script></body></html>`;
let server: ViteDevServer, url: string;
test.use({ serviceWorkers: "block" });
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "upstream-editor-fixture", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/__upstream")) return next();
      res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__upstream", html));
    });
  } }], server: { port: 0, strictPort: false, host: "127.0.0.1", hmr: false, watch: null } });
  await server.listen(); url = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => { await server?.close(); });

for (const format of ["canvas", "slides"]) test(`${format} persists active bilingual editing with the actual editor`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(url + "__upstream?format=" + format);
  const editor = page.frameLocator('.workbench-design-frame');
  const title = format === 'canvas' ? editor.frameLocator('iframe').locator('h1') : editor.getByRole('heading', { level: 1 }).first();
  await expect(title).toHaveText('中文 Editor upgrade', { timeout: 30_000 });
  await title.dblclick(); await page.keyboard.press('Meta+A'); await page.keyboard.insertText('更新后 中文 English');
  expect(await page.evaluate(DESIGN_PREPARE_SCRIPT)).toBe(true);
  await page.reload();
  await expect(title).toHaveText('更新后 中文 English', { timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).fixture.text())).toContain('更新后 中文 English');
  const frame = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
  expect(await frame.evaluate(() => { try { return parent.document.title; } catch { return 'isolated'; } })).toBe('isolated');
  expect(errors).toEqual([]);
});

test('canvas exports rendered HTML for Figma without frames or scripts', async ({ page }, info) => {
  await page.goto(url + "__upstream");
  const editor = page.frameLocator('.workbench-design-frame');
  await expect(editor.frameLocator('iframe').locator('h1')).toHaveText('中文 Editor upgrade', { timeout: 30_000 });
  try {
    await editor.getByRole('button', { name: 'Export', exact: true }).click();
    const download = page.waitForEvent('download');
    await editor.getByRole('menuitem', { name: /HTML for Figma/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.figma\.html$/);
    const contents = await readFile((await file.path())!, 'utf8');
    expect(contents).toContain('中文 Editor upgrade');
    expect(contents).not.toMatch(/<(?:iframe|script)\b/i);
  } catch (error) {
    await info.attach('editor-state', { body: await editor.locator('body').ariaSnapshot(), contentType: 'text/plain' });
    throw error;
  }
});

for (const format of ['canvas', 'slides']) test(`${format} comments keep unsupported standalone batch sending out of the App`, async ({ page }) => {
  await page.goto(url + '__upstream?format=' + format);
  const editor = page.frameLocator('.workbench-design-frame');
  const title = format === 'canvas' ? editor.frameLocator('iframe').locator('h1') : editor.getByRole('heading', { level: 1 }).first();
  await expect(title).toHaveText('中文 Editor upgrade', { timeout: 30_000 });
  expect(await page.evaluate(async () => (await (window as any).fixture.session.request('comments.create', {
    anchor:'fixture-pin', label:'Upgrade review', text:'Comment fixture',
  })).status)).toBe(201);
  await editor.getByRole('button', { name: 'Comment options', exact: true }).click();
  await editor.getByRole('menuitem', { name: /Show all comments/ }).click();
  const panel = editor.getByRole('region', { name: 'All comments', exact: true });
  await expect(panel.getByText('Comment fixture', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Send all/ })).toHaveCount(0);
});

test.describe('phone PPT', () => {
  test.use({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });
  test('nine slides keep their order, navigation and saved content after reopening', async ({ page }) => {
    await page.goto(url + '__upstream?format=slides');
    const editor = page.frameLocator('.workbench-design-frame');
    await expect(editor.getByRole('heading', { level: 1 }).first()).toHaveText('中文 Editor upgrade', { timeout: 30_000 });
    const order = Array.from({ length: 9 }, (_, i) => `slide${i + 1}`);
    await page.evaluate(async order => {
      const session = (window as any).fixture.session;
      const index = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(session.document.files['project/deck.json'].base64), c => c.charCodeAt(0))));
      index.order = order; index.cover = order[0];
      const files = Object.fromEntries(order.map((id, i) => [`project/slides/${id}.html`, {
        content: `<section id="${id}" style="background:#fff;padding:100px"><h1 style="font-size:90px">第 ${i + 1} 页</h1></section>`, contentType: 'text/html',
      }]));
      await session.publish('nine-slides', session.document.revision, { files: {
        ...files, 'project/slides/cover.html': null,
        'project/deck.json': { content: JSON.stringify(index), contentType: 'application/json' },
      } }, () => {});
    }, order);
    for (let i = 1; i <= 9; i++) {
      await expect(editor.getByRole('heading', { name: `第 ${i} 页`, exact: true })).toBeVisible();
      if (i < 9) await editor.getByRole('button', { name: 'Next slide', exact: true }).tap();
    }
    await expect(editor.getByRole('button', { name: 'Next slide', exact: true })).toBeDisabled();
    await page.reload();
    await expect(editor.getByRole('heading', { name: '第 1 页', exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => {
      const doc = (window as any).fixture.session.document;
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(doc.files['project/deck.json'].base64), c => c.charCodeAt(0)))).order;
    })).toEqual(order);
  });
});
