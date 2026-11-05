import { test, expect, type Page } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import type { ViteDevServer } from 'vite';

// Actual ShareInbox + ClientCache. The native inbox is persisted separately,
// just as the Android/iOS source files survive WebView/process reconstruction.
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ShareInbox} from '/src/ShareInbox.tsx'; import {ClientCache} from '/src/storage.ts';
import '/src/styles.css'; import '/src/brand-theme.css';
const id='884b9026-9029-4a6b-ad36-cd40b6f9a241';
if(!localStorage.getItem('native-shares')) localStorage.setItem('native-shares',JSON.stringify([{id,createdAt:Date.now(),text:'系统分享原文',files:[]}]));
const read=()=>JSON.parse(localStorage.getItem('native-shares')),write=items=>localStorage.setItem('native-shares',JSON.stringify(items));
const identities=['a','b'].map(host=>({deviceId:'device_'+host,hubPublicKey:'hub_'+host,publicKey:'key_'+host,name:host,routes:[]}));
const caches=identities.map((identity,index)=>new ClientCache('share-drafts-'+index));
await Promise.all(caches.map((cache,index)=>cache.initializeIdentity(identities[index])));
const f=window.shareDrafts={id,caches,identities,read,calls:[],prepares:[],saveHeld:false,failSave:false,ClientCache};
const native={setMaxFileBytes:async()=>{},list:async()=>({items:read()}),prepare:async({id,delivery})=>{f.prepares.push(delivery);const items=read(),item=items.find(x=>x.id===id);if(!item)throw Error('share_missing');item.delivery??=structuredClone(delivery);write(items);return structuredClone(item);},remove:async({id})=>write(read().filter(x=>x.id!==id)),clear:async()=>write([]),readChunk:async()=>{throw Error('no_file')}};
const bots=[{id:'alpha',name:'Alpha'},{id:'beta',name:'Beta'}];
const connections=caches.map((cache,index)=>({cache,identity:identities[index],state:{status:'online',bots},send:async frame=>{f.calls.push({host:index,frame});}}));
const conversations=[{id:'direct',type:'direct',title:'私聊',ownerId:'owner',botIds:['alpha'],createdAt:1,archived:false},{id:'group',type:'group',title:'项目群',ownerId:'owner',botIds:['alpha','beta'],createdAt:1,archived:false},{id:'topic',parentId:'group',type:'group',title:'分析话题',ownerId:'owner',botIds:['alpha','beta'],createdAt:1,archived:false}];
caches.forEach((cache,host)=>{const save=cache.saveShareDraft.bind(cache);cache.saveShareDraft=async(...args)=>{if(f.holdHost===host){f.holdHost=undefined;f.saveHeld=true;await new Promise(resolve=>f.releaseSave=resolve);}if(f.failSave)throw Error('fixture_disk_full');return save(...args);};});
function App(){const[host,setHost]=React.useState(Number(localStorage.getItem('host')??0)),[version,setVersion]=React.useState(0),[rows,setRows]=React.useState(conversations);f.host=host;f.switchHost=value=>{localStorage.setItem('host',String(value));setHost(value)};f.remount=()=>setVersion(value=>value+1);f.archive=()=>setRows(rows=>rows.map(row=>row.id==='group'?{...row,archived:true}:row));f.dropBot=()=>setRows(rows=>rows.map(row=>({...row,botIds:['alpha']})));f.replaceIdentity=async()=>{const identity={...identities[host],deviceId:'replacement_'+host,publicKey:'replacement-key'};await caches[host].saveIdentity(identity);identities[host]=identity;connections[host].identity=identity;setVersion(value=>value+1);};return React.createElement(ShareInbox,{key:host+':'+version,connection:connections[host],conversations:rows,native});}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: 'share-drafts-fixture', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => { if (request.url !== '/__share-drafts') return next(); response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml('/__share-drafts', html)); });
  } }], server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false } });
  await server.listen(); url = server.resolvedUrls!.local[0]! + '__share-drafts';
});
test.afterAll(async () => { await server.close(); });
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url); });
const pending = (page: Page) => page.getByRole('button', { name: '待发送分享 (1)', exact: true });
const text = (page: Page) => page.getByLabel('分享内容', { exact: true });
const target = (page: Page) => page.getByLabel('分享目标会话', { exact: true });
const open = async (page: Page) => { await pending(page).click(); await expect(text(page)).toBeEnabled(); };
const saved = async (page: Page) => { await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿已保存'); };
const stored = (page: Page, host = 0) => page.evaluate(async host => { const f = (window as any).shareDrafts; return f.caches[host].shareDraft(f.id, f.identities[host]); }, host);

test('unsubmitted share text, topic and Bot survive page reconstruction; target changes persist without sending', async ({ page, context }) => {
  await open(page); await target(page).selectOption('topic'); await page.getByRole('checkbox', { name: 'Beta', exact: true }).click();
  await text(page).fill('只核对红色批注，暂不修改文档'); await saved(page);
  expect(await page.evaluate(() => { const f = (window as any).shareDrafts; return { native: f.read()[0], calls: f.calls, prepares: f.prepares }; })).toMatchObject({ native: { text: '系统分享原文' }, calls: [], prepares: [] });
  await page.close(); const reopened = await context.newPage();
  try {
    await reopened.goto(url); await open(reopened); await expect(text(reopened)).toHaveValue('只核对红色批注，暂不修改文档');
    await expect(target(reopened)).toHaveValue('topic'); await expect(reopened.getByRole('checkbox', { name: 'Beta', exact: true })).toBeChecked();
    await target(reopened).selectOption('direct'); await saved(reopened); await reopened.reload(); await open(reopened);
    await expect(target(reopened)).toHaveValue('direct'); await expect(reopened.getByRole('checkbox')).toHaveCount(0);
    expect((await stored(reopened)).draft).toEqual({ text: '只核对红色批注，暂不修改文档', recipient: 'direct', mentions: [] });
    expect(await reopened.evaluate(() => { const f = (window as any).shareDrafts; return { calls: f.calls, prepares: f.prepares }; })).toEqual({ calls: [], prepares: [] });
  } finally { await reopened.close(); }
});

test('same native item and conversation IDs keep different host drafts; replacing a pairing never redirects a saved target', async ({ page }) => {
  await open(page); await target(page).selectOption('topic'); await page.getByRole('checkbox', { name: 'Beta', exact: true }).click(); await text(page).fill('A 主机的私密修改'); await saved(page);
  await page.evaluate(() => (window as any).shareDrafts.switchHost(1)); await open(page);
  await expect(text(page)).toHaveValue('系统分享原文'); await expect(target(page)).toHaveValue('');
  await target(page).selectOption('direct'); await text(page).fill('B 主机的独立修改'); await saved(page);
  await page.evaluate(() => (window as any).shareDrafts.switchHost(0)); await open(page);
  await expect(text(page)).toHaveValue('A 主机的私密修改'); await expect(target(page)).toHaveValue('topic'); await expect(page.getByRole('checkbox', { name: 'Beta', exact: true })).toBeChecked();
  await page.evaluate(async () => { const f = (window as any).shareDrafts; f.oldIdentity = { ...f.identities[0] }; f.oldDraft = await f.caches[0].shareDraft(f.id, f.oldIdentity); await f.replaceIdentity(); });
  await open(page); await expect(text(page)).toHaveValue('系统分享原文'); await expect(target(page)).toHaveValue(''); await expect(page.getByRole('button', { name: '发送分享', exact: true })).toBeDisabled();
  expect(await page.evaluate(async () => { const f = (window as any).shareDrafts; try { await f.caches[0].saveShareDraft(f.id, f.oldDraft.draft, f.oldIdentity, f.oldDraft.revision); return 'unexpected'; } catch (error) { return (error as Error).message; } })).toBe('draft_identity_changed');
  expect((await stored(page, 1)).draft.text).toBe('B 主机的独立修改');
  expect(await page.evaluate(() => (window as any).shareDrafts.calls)).toEqual([]);
});

test('successful send removes the editable payload and fences a delayed old save without changing the native delivery snapshot', async ({ page }) => {
  await open(page); await target(page).selectOption('topic'); await page.getByRole('checkbox', { name: 'Beta', exact: true }).click(); await text(page).fill('明确确认发送的内容'); await saved(page);
  const before = await stored(page);
  await page.getByRole('button', { name: '发送分享', exact: true }).click(); await expect(pending(page)).toHaveCount(0);
  const after = await stored(page); expect(after.retired).toBe(true); expect(after.draft).toBeUndefined();
  expect(await page.evaluate(async before => { const f = (window as any).shareDrafts; try { await f.caches[0].saveShareDraft(f.id, before.draft, f.identities[0], before.revision); return 'unexpected'; } catch (error) { return (error as Error).message; } }, before)).toBe('share_draft_retired');
  expect(await page.evaluate(() => { const f = (window as any).shareDrafts; return { native: f.read(), prepares: f.prepares, calls: f.calls }; })).toEqual({ native: [], prepares: [{ hubKey: 'hub_a', deviceId: 'device_a', conversationId: 'topic', text: '明确确认发送的内容', mentions: ['beta'] }], calls: [{ host: 0, frame: { v: 1, type: 'message.send', clientMsgId: 'share_884b9026-9029-4a6b-ad36-cd40b6f9a241', conversationId: 'topic', text: '明确确认发送的内容', attachments: [], mentions: ['beta'] } }] });
  await page.reload(); await expect(pending(page)).toHaveCount(0);
});

test('discard retires the review while a save is still waiting, and stale CAS or removed-host writes cannot resurrect it', async ({ page }) => {
  await open(page); await text(page).fill('待丢弃的旧稿'); await saved(page);
  await page.evaluate(() => { (window as any).shareDrafts.holdHost = 0; }); await text(page).fill('迟到的修改');
  await expect.poll(() => page.evaluate(() => (window as any).shareDrafts.saveHeld)).toBe(true);
  await page.getByRole('button', { name: '丢弃分享', exact: true }).click(); await expect(pending(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).shareDrafts.releaseSave());
  await expect.poll(async () => (await stored(page)).retired).toBe(true); expect((await stored(page)).draft).toBeUndefined();
  const checks = await page.evaluate(async () => {
    const f = (window as any).shareDrafts, cache = f.caches[0], identity = f.identities[0], draft = { text: '隔离验证', recipient: 'direct', mentions: [] };
    const revision = await cache.saveShareDraft('cas-test', draft, identity);
    await cache.saveShareDraft('cas-test', { ...draft, text: '更新' }, identity, revision);
    const rejection = async (work: Promise<unknown>) => { try { await work; return 'unexpected'; } catch (error) { return (error as Error).message; } };
    const stale = await rejection(cache.saveShareDraft('cas-test', draft, identity, revision));
    await cache.beginReset(); const removed = await rejection(cache.saveShareDraft('removed-host', draft, identity));
    return { stale, removed, native: f.read(), sends: f.calls };
  });
  expect(checks).toEqual({ stale: 'draft_changed_elsewhere', removed: 'local_reset_in_progress', native: [], sends: [] });
});

test('failed saves preserve edits and expose retry; missing target and Bot remain explicit instead of being redirected', async ({ page }) => {
  await open(page); await target(page).selectOption('topic'); await page.getByRole('checkbox', { name: 'Beta', exact: true }).click(); await saved(page);
  await page.evaluate(() => { (window as any).shareDrafts.failSave = true; }); await text(page).fill('磁盘失败仍要保留的修改');
  await expect(page.getByLabel('草稿状态', { exact: true })).toHaveText('草稿未保存'); await expect(page.getByRole('alert')).toContainText('完整草稿未保存');
  await expect(text(page)).toHaveValue('磁盘失败仍要保留的修改'); await expect(page.getByRole('button', { name: '发送分享', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).shareDrafts.failSave = false; }); await page.getByRole('button', { name: '重试', exact: true }).click(); await saved(page);
  await page.evaluate(() => (window as any).shareDrafts.dropBot()); await expect(page.getByRole('alert')).toContainText('所选 Bot 已不可用'); await expect(page.getByRole('button', { name: '发送分享', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).shareDrafts.archive()); await expect(page.getByRole('alert')).toContainText('原目标会话已不可用');
  await expect(target(page)).toHaveValue(''); expect((await stored(page)).draft).toEqual({ text: '磁盘失败仍要保留的修改', recipient: 'topic', mentions: ['beta'] });
  expect(await page.evaluate(() => { const f = (window as any).shareDrafts; return { calls: f.calls, prepares: f.prepares }; })).toEqual({ calls: [], prepares: [] });
});

test('an unchanged old editor cannot pin and send over another window\'s newer saved content', async ({ page }) => {
  await open(page); await target(page).selectOption('direct'); await text(page).fill('旧窗口内容'); await saved(page);
  await page.evaluate(async () => {
    const f = (window as any).shareDrafts;
    const other = new f.ClientCache('share-drafts-0');
    try {
      const old = await other.shareDraft(f.id, f.identities[0]);
      await other.saveShareDraft(f.id, { ...old.draft, text: '另一窗口已保存的新内容' }, f.identities[0], old.revision);
    } finally { other.close(); }
  });
  await page.getByRole('button', { name: '发送分享', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('另一窗口');
  await expect(page.getByRole('alert')).toHaveCount(1);
  expect(await page.evaluate(() => { const f = (window as any).shareDrafts; return { calls: f.calls, prepares: f.prepares }; })).toEqual({ calls: [], prepares: [] });
  expect((await stored(page)).draft.text).toBe('另一窗口已保存的新内容');
});

test('share edits expire with the native item; host removal counts only unexpired unsent reviews', async ({ page }) => {
  const checks = await page.evaluate(async () => {
    const f = (window as any).shareDrafts, cache = f.caches[0], identity = f.identities[0];
    const draft = { text: '分享的私密批注', recipient: 'direct', mentions: [] }, now = Date.now();
    const expiry = now + 60_000;
    const revision = await cache.saveShareDraft('expiring', draft, identity, undefined, expiry);
    await cache.saveShareDraft('retired', draft, identity, undefined, expiry);
    await cache.retireShareDraft('retired', identity);
    await cache.saveShareDraft('keep', draft, identity, undefined, now + 120_000);
    const before = await cache.draftCount();
    const clock = Date.now;
    const rejection = async (work: Promise<unknown>) => { try { await work; return 'unexpected'; } catch (error) { return (error as Error).message; } };
    try {
      Date.now = () => expiry + 1;
      const expiredRead = await rejection(cache.shareDraft('expiring', identity));
      const after = await cache.draftCount();
      await cache.pruneExpiredShareDrafts(identity);
      const removed = await cache.shareDraft('expiring', identity), tombstone = await cache.shareDraft('retired', identity);
      const lateSave = await rejection(cache.saveShareDraft('expiring', draft, identity, revision, expiry));
      return { before, after, expiredRead, removed, tombstone, lateSave, keep: (await cache.shareDraft('keep', identity)).draft, native: f.read().length, calls: f.calls };
    } finally { Date.now = clock; }
  });
  expect(checks).toEqual({ before: 2, after: 1, expiredRead: 'share_draft_expired', removed: { retired: false }, tombstone: { retired: false }, lateSave: 'share_draft_expired', keep: { text: '分享的私密批注', recipient: 'direct', mentions: [] }, native: 1, calls: [] });
});

test('opening an unvisited host cache cleans expired edits without mounting its share inbox', async ({ page }) => {
  await page.evaluate(async () => {
    const f = (window as any).shareDrafts, now = Date.now(), draft = { text: '未访问主机的旧分享', recipient: 'direct', mentions: [] };
    await f.caches[1].saveShareDraft('expired-in-background', draft, f.identities[1], undefined, now + 60_000);
    await f.caches[1].saveShareDraft('still-pending', draft, f.identities[1], undefined, now + 120_000);
    f.realNow = Date.now; Date.now = () => now + 60_001;
    f.reopened = new f.ClientCache('share-drafts-1');
  });
  try {
    await expect.poll(() => page.evaluate(async () => {
      const f = (window as any).shareDrafts;
      try { return await f.reopened.shareDraft('expired-in-background', f.identities[1]); }
      catch (error) { return (error as Error).message; }
    })).toEqual({ retired: false });
    expect(await page.evaluate(async () => {
      const f = (window as any).shareDrafts;
      return { activeHost: f.host, pending: (await f.reopened.shareDraft('still-pending', f.identities[1])).draft.text, native: f.read().length, calls: f.calls };
    })).toEqual({ activeHost: 0, pending: '未访问主机的旧分享', native: 1, calls: [] });
  } finally { await page.evaluate(() => { const f = (window as any).shareDrafts; Date.now = f.realNow; f.reopened.close(); }); }
});
