import { test, expect } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createServer } from './fixtures/vite.js';

// Real browser IndexedDB plus the production DesignSession. No in-memory
// persistence fixture: re-open connections to verify durable receipts/objects.
const html = `<!doctype html><body><script type="module">
import {ClientCache} from '/src/storage.ts';
import {DesignSession} from '/src/workbench-design-session.ts';
import {emptyDesign,decodeDesignFile} from '/src/workbench-design.ts';
import {emptyBoard,emptyWorkbench,changeWorkbench} from '/src/workbench-model.ts';
import {emptyMarkdown} from '/src/workbench-markdown.ts';
const scope='design-session-scope', id='design';
async function open(name){
 const cache=new ClientCache(name);
 let document=await cache.readWorkbenchDesign(scope,id);
 if(!document){document=emptyDesign(id);await cache.saveWorkbenchDesign(scope,-1,document);}
 const session=new DesignSession(document,()=>cache.readWorkbenchDesign(scope,id),
  (expected,next,sidecar)=>cache.saveWorkbenchDesign(scope,expected,next,sidecar),()=>{}, {
   user:()=>({id:'user',name:'Ann'}),
   comments:{load:()=>cache.readWorkbenchDesignMeta(scope,id,'comments'),save:(expected,next)=>cache.saveWorkbenchDesignMeta(scope,id,'comments',expected,next)},
   history:{load:()=>cache.readWorkbenchDesignMeta(scope,id,'history'),object:sha=>cache.readWorkbenchDesignObject(scope,id,sha)},
  });
 return {cache,session};
}
window.fixture={open,scope,id,DesignSession,emptyDesign,emptyBoard,emptyWorkbench,changeWorkbench,emptyMarkdown,text:file=>new TextDecoder().decode(decodeDesignFile(file)),bot:{kind:'bot',id:'assistant',name:'Helper'}};
document.body.append('ready');
</script>`;
let server: ViteDevServer, url: string;
test.use({ serviceWorkers: 'block' });
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: 'design-session-storage', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__design_session_storage') return next();
      res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__design_session_storage', html));
    });
  } }], server: { port: 0, strictPort: false, host: '127.0.0.1' } });
  await server.listen(); url = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.goto(url + '__design_session_storage'); await expect(page.locator('body')).toContainText('ready'); });

test('comments survive a new IDB connection and replay a Bot reply once without advancing design revision', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).fixture, name = 'comments-' + crypto.randomUUID();
    let { cache, session } = await f.open(name);
    const created = await session.request('comments.create', { anchor: '#title', label: 'Board · Main', text: 'Please enlarge' });
    const id = created.body.thread.id, payload = { threadId: id, text: 'Done' };
    await session.commentsReply('reply-once', payload, f.bot, () => {});
    cache.close(); ({ cache, session } = await f.open(name));
    const replay = await session.commentsReply('reply-once', payload, f.bot, () => {});
    const snapshot = await session.request('comments.snapshot', {});
    const document = await cache.readWorkbenchDesign(f.scope, f.id);
    const history = await cache.readWorkbenchDesignMeta(f.scope, f.id, 'history');
    const record = await cache.readWorkbenchDesignMeta(f.scope, f.id, 'comments');
    cache.close(); return { status: created.status, replay: replay.result.replayed, thread: snapshot.body.threads[0], revision: document.revision, history, receipts: record.receipts.length };
  });
  expect(result.status).toBe(201); expect(result.replay).toBe(true);
  expect(result.revision).toBe(0); expect(result.history).toBeUndefined(); expect(result.receipts).toBe(1);
  expect(result.thread.messages).toHaveLength(2);
  expect(result.thread.messages[0].author).toMatchObject({ principal: 'user:user', name: 'Ann' });
  expect(result.thread.messages[1].author).toMatchObject({ principal: 'bot:assistant', name: 'Helper' });
});

test('IDB history objects restore only selected files, retain request receipts, and preview refuses writes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).fixture, name = 'history-' + crypto.randomUUID();
    let { cache, session } = await f.open(name);
    const publish = (a: string, b: string) => ({ files: { 'project/a.txt': { content: a }, 'project/b.txt': { content: b } } });
    await session.publish('version-one', 0, publish('a1', 'b1'), () => {}, f.bot);
    const oldSha = session.document.files['project/a.txt'].sha256;
    await session.publish('version-two', 1, publish('a2', 'b2'), () => {}, f.bot);
    cache.close(); ({ cache, session } = await f.open(name));
    const oldObject = await cache.readWorkbenchDesignObject(f.scope, f.id, oldSha);
    const before = await session.historyList({});
    const restored = await session.restore('restore-once', 2, { version: 2, paths: ['project/a.txt'] }, f.bot, () => {});
    const preview = f.DesignSession.preview(await session.historyPreview(2));
    const refused = await preview.request('publish', { files: {} });
    const previewText = f.text(preview.document.files['project/b.txt']);
    cache.close(); ({ cache, session } = await f.open(name));
    const replay = await session.restore('restore-once', 2, { version: 2, paths: ['project/a.txt'] }, f.bot, () => {});
    const document = await cache.readWorkbenchDesign(f.scope, f.id);
    const index = await cache.readWorkbenchDesignMeta(f.scope, f.id, 'history');
    cache.close(); return { oldText: f.text(oldObject), before: before.result.rows.map((row: any) => row.n), restored, replay, previewText, refused: refused.status,
      texts: [f.text(document.files['project/a.txt']), f.text(document.files['project/b.txt'])], revision: document.revision, versions: index.versions.length, last: index.versions.at(-1) };
  });
  expect(result.oldText).toBe('a1'); expect(result.before).toEqual([3, 2, 1]);
  expect(result.restored).toMatchObject({ revision: 3, restoredFrom: 2, changed: ['project/a.txt'] });
  expect(result.replay).toMatchObject({ revision: 3, changed: [] });
  expect(result.texts).toEqual(['a1', 'b2']); expect(result.revision).toBe(3); expect(result.versions).toBe(4);
  expect(result.last).toMatchObject({ requestId: 'restore-once', restoredFrom: 2, restoredPart: true });
  expect(result.previewText).toBe('b1'); expect(result.refused).toBe(403);
});

for (const mode of ['direct', 'layout', 'library'] as const) {
  test(`${mode} board/Markdown deletion preserves same-ID Design sidecars, which retire only with the Design`, async ({ page }) => {
    const result = await page.evaluate(async (mode) => {
      const f = (window as any).fixture, { cache } = await f.open('delete-isolation-' + crypto.randomUUID());
      const scope = JSON.stringify(['hub', 'owner', 'conversation']), id = 'same-id', owner = { host: 'hub', user: 'owner' };
      const design = f.emptyDesign(id), object = design.files['project/Main.dc.html'];
      await cache.saveWorkbenchDesign(scope, -1, design);
      await cache.saveWorkbenchDesign(scope, 0, { ...design, revision: 1 }, { history: { expected: -1, next: { revision: 0 }, put: { [object.sha256]: object }, drop: [] } });
      await cache.saveWorkbenchDesignMeta(scope, id, 'comments', 0, { revision: 1, threads: [] });
      await cache.saveWorkbenchBoard(scope, -1, f.emptyBoard(id));
      await cache.saveWorkbenchMarkdown(scope, -1, f.emptyMarkdown(id, 'note'));
      const snapshot = async () => ({ design: await cache.readWorkbenchDesign(scope, id), comments: await cache.readWorkbenchDesignMeta(scope, id, 'comments'), history: await cache.readWorkbenchDesignMeta(scope, id, 'history'), object: await cache.readWorkbenchDesignObject(scope, id, object.sha256) });
      const before = await snapshot();
      if (mode === 'direct') {
        await cache.deleteWorkbenchBoard(scope, id, 0); await cache.deleteWorkbenchMarkdown(scope, id, 0);
      } else if (mode === 'layout') {
        let layout = f.changeWorkbench(f.emptyWorkbench(), { type: 'open', tab: { id, kind: 'whiteboard', title: 'Board' } });
        layout = { ...layout, revision: 0 }; await cache.saveWorkbench(scope, -1, layout);
        layout = f.changeWorkbench(layout, { type: 'delete', id }); await cache.deleteWorkbenchBoardAndLayout(scope, id, 0, 0, layout);
        layout = f.changeWorkbench(layout, { type: 'open', tab: { id, kind: 'markdown', title: 'Note' } }); await cache.saveWorkbench(scope, 1, layout);
        layout = f.changeWorkbench(layout, { type: 'delete', id }); await cache.deleteWorkbenchMarkdownAndLayout(scope, id, 0, 2, layout);
      } else {
        await cache.deleteWorkbenchItems(owner, scope, [{ kind: 'whiteboard', id }, { kind: 'markdown', id }]);
      }
      const afterOtherDeletion = await snapshot();
      const othersGone = [await cache.readWorkbenchBoard(scope, id), await cache.readWorkbenchMarkdown(scope, id)];
      const deleted = await cache.deleteWorkbenchItems(owner, scope, [{ kind: 'design', id }]);
      const afterDesignDeletion = await snapshot(); cache.close();
      return { before, afterOtherDeletion, othersGone, deleted, afterDesignDeletion };
    }, mode);
    expect(result.afterOtherDeletion).toEqual(result.before);
    expect(result.othersGone).toEqual([undefined, undefined]);
    expect(result.deleted).toEqual([{ kind: 'design', id: 'same-id', status: 'deleted' }]);
    expect(Object.values(result.afterDesignDeletion).every(value => value === undefined)).toBe(true);
  });
}
