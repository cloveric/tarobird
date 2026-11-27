import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import { DESIGN_PREPARE_SCRIPT } from "../electron/design-quit.mjs";

// Real editor/session/storage without authentication fixtures: this also lets
// WebKit exercise the editor independently of browser CryptoKey persistence.
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="mount" style="height:760px;width:100%"></div><script type="module">
import {ClientCache} from '/src/storage.ts';
import {DesignSession} from '/src/workbench-design-session.ts';
import {designFrame} from '/src/design-frame.ts';
import {emptyDesignDocument,decodeDesignFile} from '/src/workbench-design.ts';
const format='slides';
const cache=new ClientCache('upstream-editor-test');
let doc=await cache.readWorkbenchDesign('fixture',format);
if(!doc){doc=emptyDesignDocument(format,'中文 Editor upgrade',format);await cache.saveWorkbenchDesign('fixture',-1,doc);}
let comments;
const session=new DesignSession(doc,()=>cache.readWorkbenchDesign('fixture',format),(expected,next,sidecar)=>cache.saveWorkbenchDesign('fixture',expected,next,sidecar),()=>{}, {
 user:()=>({id:'owner',name:'Example'}), sendToBot:async()=> 'opened',
 comments:{load:async()=>structuredClone(comments),save:async(expected,next)=>{if((comments?.revision??0)!==expected)throw Error('design_comments_conflict');comments=structuredClone(next);}}
});
window.fixture={cache,session,frame:designFrame(session),text:()=>new TextDecoder().decode(decodeDesignFile(session.document.files[format==='slides'?'project/slides/cover.html':'project/Main.dc.html']))};
designFrame(session).attach(document.querySelector('#mount'),error=>{window.fixtureError=error;},()=>{},{title:'中文 Editor upgrade'});
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

for (const format of ["slides"]) test(`${format} persists active bilingual editing with the actual editor`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(url + "__upstream?format=" + format);
  const editor = page.frameLocator('.workbench-design-frame');
  const title = editor.getByRole('heading', { level: 1 }).first();
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

for (const format of ['slides']) test(`${format} comments keep unsupported standalone batch sending out of the App`, async ({ page }) => {
  await page.goto(url + '__upstream?format=' + format);
  const editor = page.frameLocator('.workbench-design-frame');
  const title = format === 'canvas' ? editor.frameLocator('iframe').locator('h1') : editor.getByRole('heading', { level: 1 }).first();
  await expect(title).toHaveText('中文 Editor upgrade', { timeout: 30_000 });
  expect(await page.evaluate(async () => (await (window as any).fixture.session.request('comments.create', {
    anchor:'fixture-pin', label:'Upgrade review', text:'Comment fixture',
  })).status)).toBe(201);
  if (format === 'canvas') {
    await editor.getByRole('button', { name: 'Comment options', exact: true }).click();
    await editor.getByRole('menuitem', { name: /Show all comments/ }).click();
  } else {
    await editor.getByRole('button', { name: 'Comments', exact: true }).click();
  }
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

test('slides regressions: DS assets, retryable comment drafts, comment move, delete-conflict retry, live title, declined export, and 25-shape editability', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + '__upstream?format=slides');
  const editor = page.frameLocator('.workbench-design-frame');
  await expect(editor.getByRole('heading', { level: 1 }).first()).toHaveText('中文 Editor upgrade', { timeout: 30_000 });

  // Bug 3: 25-shape slide split across position:relative layers stays editable (not held read-only)
  // Bug 7: project/ds/.../assets/... without leading slash renders with naturalWidth > 0 and saves canonically
  const assetInfo = await page.evaluate(async () => {
    const session = (window as any).fixture.session;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2563eb"/></svg>';
    const bytes = new TextEncoder().encode(svg);
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(hashBuf), b => b.toString(16).padStart(2, '0')).join('');
    const assetId = hex.slice(0, 32);
    const dsPath = `project/ds/system-brand/assets/${assetId}`;
    const shapesLayer1 = Array.from({ length: 24 }, (_, i) => `    <p style="position:absolute;left:${(i % 6) * 200}px;top:${Math.floor(i / 6) * 100}px;width:180px;height:40px;font-size:24px;margin:0">S${i + 1}</p>`).join('\n');
    const shapesLayer2 = `    <p style="position:absolute;left:40px;top:520px;width:300px;height:60px;font-size:32px;margin:0">Shape 25</p>\n    <img src="${dsPath}" alt="Slides DS logo" style="position:absolute;left:40px;top:620px;width:32px;height:32px;object-fit:contain">`;
    const slideHtml = `<section id="cover" style="background:#ffffff;color:#1a1a1a">\n  <div style="position:relative">\n${shapesLayer1}\n  </div>\n  <div style="position:relative">\n${shapesLayer2}\n  </div>\n</section>\n`;
    const deck = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(session.document.files['project/deck.json'].base64), c => c.charCodeAt(0))));
    deck.order = ['cover', 'extra'];
    await session.publish('regressions-setup', session.document.revision, {
      files: {
        [dsPath]: { content: svg, contentType: 'image/svg+xml' },
        'project/slides/cover.html': { content: slideHtml, contentType: 'text/html' },
        'project/slides/extra.html': { content: '<section id="extra"><h1>Extra</h1></section>', contentType: 'text/html' },
        'project/deck.json': { content: JSON.stringify(deck), contentType: 'application/json' },
      },
    }, () => {});
    return { dsPath };
  });
  await expect(editor.getByText('Shape 25', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(editor.getByText(/This slide's file has errors, so it's read-only here/i)).toHaveCount(0);
  await expect(editor.locator('img[alt="Slides DS logo"]').first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => editor.locator('img[alt="Slides DS logo"]').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const guest = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;

  // Bug 6 & Bug 15: sendToAgent does NOT fabricate delivered status (remains retryable), and comments.move persists anchor
  const commentCheck = await guest.evaluate(async () => {
    const comments = await (window as any).openartifact.use('comments');
    const created = await comments.create({ anchor: JSON.stringify({ slide: 'cover', x: 10, y: 10 }), label: 'Slide 1', text: 'Move and draft me' });
    const afterDraft = await comments.sendToAgent(created.id);
    const secondDraft = await comments.sendToAgent(created.id);
    const movedAnchor = JSON.stringify({ slide: 'extra', x: 320, y: 240 });
    const moved = await comments.move(created.id, movedAnchor, { label: 'Slide 2' });
    const listed = await comments.list();
    return {
      afterDraftAgent: afterDraft.agent ?? null,
      secondDraftAgent: secondDraft.agent ?? null,
      movedAnchor: moved.anchor,
      persistedAnchor: listed.find((t: any) => t.id === created.id)?.anchor,
    };
  });
  expect(commentCheck.afterDraftAgent).toBeNull();
  expect(commentCheck.secondDraftAgent).toBeNull();
  expect(commentCheck.movedAnchor).toBe(JSON.stringify({ slide: 'extra', x: 320, y: 240 }));
  expect(commentCheck.persistedAnchor).toBe(commentCheck.movedAnchor);

  // Bug 8: publish() 409 conflict refreshes lastKnownHashes so conflicting slide delete retry succeeds without extra list()
  const initialList = await guest.evaluate(async () => {
    const artifact = await (window as any).openartifact.use('artifact');
    return artifact.list();
  });
  expect(initialList['project/slides/extra.html']).toBeDefined();
  // Mutate stored extra.html directly in cache (bypassing external-change) so lastKnownHashes is genuinely stale.
  await page.evaluate(async () => {
    const { cache, session } = (window as any).fixture;
    const stored = await cache.readWorkbenchDesign('fixture', 'slides');
    const html = '<section id="extra"><h1>Extra remote edit</h1></section>';
    const bytes = new TextEncoder().encode(html);
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(hashBuf), b => b.toString(16).padStart(2, '0')).join('');
    const next = {
      ...stored,
      revision: stored.revision + 1,
      files: {
        ...stored.files,
        'project/slides/extra.html': { base64: btoa(html), contentType: 'text/html', size: bytes.length, sha256 },
      },
    };
    await cache.saveWorkbenchDesign('fixture', stored.revision, next);
    await session.refresh();
  });
  const deleteOutcome = await guest.evaluate(async deckSha => {
    const artifact = await (window as any).openartifact.use('artifact');
    const deckText = await artifact.readText('project/deck.json');
    const deck = JSON.parse(deckText);
    deck.order = ['cover'];
    const batch = {
      'project/slides/extra.html': null,
      'project/deck.json': { content: JSON.stringify(deck), ifMatch: deckSha },
    };
    let conflictSeen = false;
    try {
      await artifact.publish(batch);
    } catch (err: any) {
      conflictSeen = err?.code === 'conflict';
    }
    // Immediate retry WITHOUT calling artifact.list() must succeed because 409 refreshed lastKnownHashes.
    const res = await artifact.publish(batch);
    return { conflictSeen, deletedHash: res.hashes['project/slides/extra.html'] };
  }, initialList['project/deck.json'].sha256);
  expect(deleteOutcome).toEqual({ conflictSeen: true, deletedHash: null });

  // Bug 12: setTitle updates running editor title without reloading or tearing down frame
  await guest.evaluate(() => { (window as any).__frameMarker = 'still-alive'; });
  await page.evaluate(() => { (window as any).fixture.frame.setTitle('Renamed Live Deck'); });
  await expect.poll(() => guest.evaluate(async () => ({
    marker: (window as any).__frameMarker,
    docTitle: document.title,
    capTitle: await (await (window as any).openartifact.use('artifact')).title(),
  }))).toEqual({ marker: 'still-alive', docTitle: 'Renamed Live Deck', capTitle: 'Renamed Live Deck' });

  // Bug 10: Cancelling an export prompt rejects with Error (never [object Object]) and shows no "Download failed" modal
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: false, hasBeenActive: true }, configurable: true });
  });
  await guest.evaluate(() => {
    (window as any).__declinedSave = null;
    (window as any).__tarobotDesignSave({ filename: 'test.pptx', data: new Blob(['x']) }).then(
      () => { (window as any).__declinedSave = { ok: true }; },
      (err: any) => { (window as any).__declinedSave = { isError: err instanceof Error, code: err?.code, message: err?.message, text: String(err) }; },
    );
  });
  const promptDialog = page.locator('dialog.design-export-prompt');
  await expect(promptDialog).toBeVisible({ timeout: 10_000 });
  // Bug 12 check: renaming while export prompt is open must NOT cancel the prompt!
  await page.evaluate(() => { (window as any).fixture.frame.setTitle('Renamed While Exporting'); });
  await expect(promptDialog).toBeVisible();
  await promptDialog.getByRole('button', { name: /^(?:Cancel|取消)$/ }).click();
  await expect(promptDialog).toHaveCount(0);
  await expect.poll(() => guest.evaluate(() => (window as any).__declinedSave)).toEqual({
    isError: true,
    code: 'declined',
    message: 'Export cancelled',
    text: 'ArtifactError: Export cancelled',
  });
  // Also exercise the real slides editor Export menu + Cancel prompt -> no "Download failed" / "[object Object]" modal.
  await editor.getByRole('button', { name: 'Export', exact: true }).click();
  await editor.getByRole('menuitem', { name: /PowerPoint \(basic fonts\)/ }).click();
  await expect(promptDialog).toBeVisible({ timeout: 20_000 });
  // Verify live-renamed title flows through to the exported filename!
  await expect(promptDialog).toContainText('Renamed While Exporting.pptx');
  await promptDialog.getByRole('button', { name: /^(?:Cancel|取消)$/ }).click();
  await expect(promptDialog).toHaveCount(0);
  await expect(editor.getByText('[object Object]')).toHaveCount(0);
  await expect(editor.getByText('Download failed')).toHaveCount(0);
  expect(assetInfo.dsPath).toMatch(/^project\/ds\/system-brand\/assets\/[a-f0-9]{32}$/);
  expect(errors).toEqual([]);
});
