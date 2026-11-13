import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";
import type { ClientCache, Identity, ConversationDraft } from "../src/storage.js";

// Real IndexedDB + actual hook, no Hub/engine or user's browser profile.
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'; import { createRoot } from 'react-dom/client';
import { ClientCache } from '/src/storage.ts'; import { useConversationDrafts } from '/src/conversation-drafts.ts';
const identity={deviceId:'device',hubPublicKey:'hub',publicKey:'key',name:'test',routes:[]};
const cache=new ClientCache('persistent-drafts'); await cache.initializeIdentity(identity);
const f=window.draftsFixture={cache,ClientCache,identity};
function App(){const [id,select]=React.useState('one');const draft=useConversationDrafts(id,cache,identity);Object.assign(f,{draft,select});return React.createElement('div',null,React.createElement('output',{id:'state'},JSON.stringify({id,ready:draft.ready,saving:draft.saving,error:draft.error,files:draft.files.map(f=>f.name),reply:draft.reply?.id,choice:draft.previewChoice,style:draft.previewStyle,recipients:draft.recipients})),React.createElement('button',{id:'act',disabled:!draft.ready,onClick:()=>{f.activations=(f.activations??0)+1;f.activatedFiles=draft.files.map(file=>file.name);}},'Use draft'));}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;
type Fixture = { cache: ClientCache; ClientCache: typeof ClientCache; identity: Identity; draft: ReturnType<typeof import('../src/conversation-drafts.js').useConversationDrafts>; select: (id: string) => void; receipt?: () => void };
let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: 'drafts-harness', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => { if (req.url !== '/__drafts') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__drafts', html)); });
  } }], server: { port: 0, host: '127.0.0.1' } });
  await server.listen(); url = server.resolvedUrls!.local[0] + '__drafts';
});
test.afterAll(async () => { await server.close(); });
test.beforeEach(async ({ page }) => { await page.goto(url); await expect(page.locator('#state')).toContainText('"ready":true'); });

const settled = async (page: import('@playwright/test').Page) => { await expect(page.locator('#state')).toContainText('"saving":false'); };

test('draft preview indexes migrate existing files without changing bytes and stay host scoped', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { ClientCache: Constructor, identity } = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    // A v8 cache already contains drafts, including a non-content preview preference.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('draft-preview-v8', 8);
      request.onupgradeneeded = () => {
        const settings = request.result.createObjectStore('settings');
        settings.put(identity, 'identity'); settings.put('已有\n草稿', 'draft:one');
        const drafts = request.result.createObjectStore('conversationDrafts');
        drafts.createIndex('size', 'size'); drafts.createIndex('active', 'active');
        const owner = JSON.stringify([identity.deviceId, identity.hubPublicKey, identity.publicKey]);
        drafts.put({ files: [{ bytes: new Uint8Array([0, 1, 255]).buffer, name: 'old.bin', type: 'application/octet-stream', lastModified: 1 }], reply: { id: 'quote' }, previewStyle: 'card', revision: 'old', owner, size: 3, active: 1 }, 'one');
        drafts.put({ files: [], previewStyle: 'card', previewChoice: null, recipients: ['beta'], revision: 'preference', owner, size: 0, active: 1 }, 'preferences-only');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    const migrated = new Constructor('draft-preview-v8');
    const other = new Constructor('draft-preview-other-host');
    try {
      await other.initializeIdentity({ ...identity, hubPublicKey: 'different-host' });
      await other.saveDraft('one', '另一台主机');
      const before = await migrated.draftPreviews();
      const restored = await migrated.conversationDraft('one', identity);
      const bytes = Array.from(new Uint8Array(await restored.draft.files[0]!.arrayBuffer()));
      await migrated.saveDraft('one', '   \n');
      const filesOnly = await migrated.draftPreviews();
      await migrated.saveConversationDraft('one', { files: [], previewStyle: 'card' }, identity, restored.revision);
      return { before, bytes, filesOnly, cleared: await migrated.draftPreviews(), other: await other.draftPreviews() };
    } finally { migrated.close(); other.close(); }
  });
  expect(result).toEqual({
    before: { one: { text: '已有 草稿', files: 1, reply: true } }, bytes: [0, 1, 255],
    filesOnly: { one: { text: '', files: 1, reply: true } }, cleared: {},
    other: { one: { text: '另一台主机', files: 0, reply: false } },
  });
});

test('files, completed audio, quote and preview restore after page close and retain exact bytes', async ({ page, context }) => {
  await page.evaluate(() => {
    const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    f.draft.setFiles([new File(['document\u0000bytes'], '文档.txt', { type: 'text/plain', lastModified: 123 }), new File([new Uint8Array([0, 1, 255, 3])], 'voice.webm', { type: 'audio/webm', lastModified: 456 })]);
    f.draft.setReply({ id: 'quote', conversationId: 'one', authorType: 'bot', authorId: 'bot', blocks: [{ type: 'text', text: 'quoted body' }], createdAt: 1, status: 'complete' } as ConversationDraft['reply']);
    f.draft.setPreviewChoice(null); f.draft.setPreviewStyle('inline'); f.draft.setRecipients(['beta']);
  });
  await settled(page); await page.close();
  const reopened = await context.newPage();
  try {
    await reopened.goto(url); await expect(reopened.locator('#state')).toContainText('文档.txt');
    const result = await reopened.evaluate(async () => { const { draft } = (window as unknown as { draftsFixture: Fixture }).draftsFixture; return { files: await Promise.all(draft.files.map(async f => ({ name: f.name, type: f.type, modified: f.lastModified, bytes: Array.from(new Uint8Array(await f.arrayBuffer())) }))), reply: draft.reply?.id, choice: draft.previewChoice, style: draft.previewStyle, recipients: draft.recipients }; });
    expect(result).toEqual({ files: [{ name: '文档.txt', type: 'text/plain', modified: 123, bytes: Array.from(Buffer.from('document\u0000bytes')) }, { name: 'voice.webm', type: 'audio/webm', modified: 456, bytes: [0, 1, 255, 3] }], reply: 'quote', choice: null, style: 'inline', recipients: ['beta'] });
  } finally { await reopened.close(); }
});

test('late send receipt preserves new files, reference and preview, including another conversation', async ({ page }) => {
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; f.draft.setFiles([new File(['old'], 'old.txt')]); });
  await settled(page);
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; const sent = f.draft.clearSent; f.receipt = () => sent(true); f.draft.setFiles([new File(['new'], 'new.txt')]); f.draft.setPreviewChoice('https://example.com/new'); f.select('two'); });
  await expect(page.locator('#state')).toContainText('"id":"two"');
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; f.draft.setFiles([new File(['other'], 'other.txt')]); f.receipt!(); });
  await settled(page); await expect(page.locator('#state')).toContainText('other.txt');
  await page.evaluate(() => (window as unknown as { draftsFixture: Fixture }).draftsFixture.select('one'));
  await expect(page.locator('#state')).toContainText('new.txt'); await settled(page); await page.reload();
  await expect(page.locator('#state')).toContainText('new.txt'); await expect(page.locator('#state')).toContainText('https://example.com/new');
});

test('CAS rejects stale writes and empty-draft ABA; host identity, revocation and reset fence bytes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cache, ClientCache: Constructor, identity } = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    const draft: ConversationDraft = { files: [new File(['bytes'], 'test.txt')], previewStyle: 'card' };
    const revision = await cache.saveConversationDraft('cas', draft, identity);
    const other = new Constructor('persistent-drafts');
    const newer = await other.saveConversationDraft('cas', { ...draft, previewChoice: null }, identity, revision);
    const error = async (fn: () => Promise<unknown>) => { try { await fn(); return ''; } catch (e) { return (e as Error).message; } };
    const stale = await error(() => cache.saveConversationDraft('cas', draft, identity, revision));
    const empty = await cache.saveConversationDraft('cas', { files: [], previewStyle: 'card' }, identity, newer);
    const aba = await error(() => other.saveConversationDraft('cas', draft, identity));
    const isolated = new Constructor('other-host'); await isolated.initializeIdentity({ ...identity, hubPublicKey: 'other' });
    const foreign = await error(() => isolated.saveConversationDraft('cas', draft, identity));
    const count = await cache.draftCount();
    await cache.saveConversationDraft('cas', draft, identity, empty); await cache.saveAttachment('download', new Blob(['keep']));
    await cache.markIdentityRevoked(identity);
    const revoked = await error(() => cache.saveConversationDraft('cas', draft, identity));
    const retained = await (await cache.conversationDraft('cas', identity)).draft.files[0]!.text();
    const download = await (await cache.attachment('download'))!.text();
    await cache.beginReset(); const reset = await error(() => other.saveConversationDraft('cas', draft, identity, empty));
    const fresh = new Constructor('persistent-drafts'); await fresh.finishReset(); await fresh.initializeIdentity({ ...identity, deviceId: 'new-device' });
    const oldIdentity = await error(() => fresh.conversationDraft('cas', identity));
    const clean = (await fresh.conversationDraft('cas', { ...identity, deviceId: 'new-device' })).draft.files.length;
    other.close(); isolated.close(); fresh.close();
    return { stale, aba, foreign, count, revoked, retained, download, reset, oldIdentity, clean };
  });
  expect(result).toEqual({ stale: 'draft_changed_elsewhere', aba: 'draft_changed_elsewhere', foreign: 'draft_identity_changed', count: 0, revoked: 'draft_identity_revoked', retained: 'bytes', download: 'keep', reset: 'local_reset_in_progress', oldIdentity: 'draft_identity_changed', clean: 0 });
});

test('capacity failure preserves memory and saved draft; removing excess files retries without eviction', async ({ page }) => {
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; f.draft.setFiles([new File(['saved'], 'saved.txt')]); }); await settled(page);
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; f.draft.setFiles(Array.from({ length: 33 }, (_, n) => new File(['x'], `file-${n}.txt`))); });
  await expect(page.locator('#state')).toContainText('draft_capacity_exceeded');
  const saved = await page.evaluate(async () => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; return (await f.cache.conversationDraft('one', f.identity)).draft.files.map(f => f.name); });
  expect(saved).toEqual(['saved.txt']);
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; f.draft.setFiles(files => files.slice(0, 1)); }); await settled(page);
  await expect(page.locator('#state')).not.toContainText('draft_capacity_exceeded'); await page.reload(); await expect(page.locator('#state')).toContainText('file-0.txt');
});

test('a failed initial read does not overwrite disk; edits replay after explicit recovery', async ({ page }) => {
  await page.evaluate(async () => {
    const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    await f.cache.saveConversationDraft('two', { files: [new File(['saved'], 'restored.txt')], previewStyle: 'card' }, f.identity);
    const original = f.cache.conversationDraft.bind(f.cache); let fail = true;
    f.cache.conversationDraft = async (...args) => { if (fail) { fail = false; throw new Error('read_failed'); } return original(...args); };
    f.select('two');
  });
  await expect(page.locator('#state')).toContainText('read_failed');
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; f.draft.setFiles(files => [...files, new File(['new'], 'added.txt')]); });
  await expect(page.locator('#state')).toContainText('restored.txt'); await expect(page.locator('#state')).toContainText('added.txt'); await settled(page);
  await page.reload(); await expect(page.locator('#state')).toContainText('"ready":true');
  await page.evaluate(() => (window as unknown as { draftsFixture: Fixture }).draftsFixture.select('two'));
  await expect(page.locator('#state')).toContainText('restored.txt'); await expect(page.locator('#state')).toContainText('added.txt');
});

test('host-wide byte budget rejects overflow without evicting another unsent conversation or downloads', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cache, identity } = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    const file = new File([new Uint8Array(45 * 1024 * 1024).fill(7)], 'large.bin');
    const draft: ConversationDraft = { files: [file], previewStyle: 'card' };
    await cache.saveConversationDraft('large-one', draft, identity);
    await cache.saveConversationDraft('large-two', draft, identity);
    await cache.saveAttachment('download', new Blob(['download']));
    let failure = ''; try { await cache.saveConversationDraft('large-three', draft, identity); } catch (error) { failure = (error as Error).message; }
    const kept = await cache.conversationDraft('large-one', identity), missing = await cache.conversationDraft('large-three', identity);
    return { failure, kept: kept.draft.files[0]!.size, absent: missing.draft.files.length, count: await cache.draftCount(), download: await (await cache.attachment('download'))!.text() };
  });
  expect(result).toEqual({ failure: 'draft_capacity_exceeded', kept: 45 * 1024 * 1024, absent: 0, count: 2, download: 'download' });
});

test('storage quota failure retains visible draft and retry persists it', async ({ page }) => {
  await page.evaluate(() => {
    const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture, original = f.cache.saveConversationDraft.bind(f.cache); let fail = true;
    f.cache.saveConversationDraft = async (...args) => { if (fail) { fail = false; throw new DOMException('Quota exceeded', 'QuotaExceededError'); } return original(...args); };
    f.draft.setFiles([new File(['recoverable'], 'retry.txt')]);
  });
  await expect(page.locator('#state')).toContainText('Quota exceeded'); await expect(page.locator('#state')).toContainText('retry.txt');
  await page.evaluate(() => (window as unknown as { draftsFixture: Fixture }).draftsFixture.draft.retry());
  await settled(page); await expect(page.locator('#state')).not.toContainText('Quota exceeded');
  await page.reload(); await expect(page.locator('#state')).toContainText('retry.txt');
});

test('plain-text receipt creates no rich tombstone and oversized metadata has a distinct failure', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { draftsFixture: Fixture }).draftsFixture.draft.clearSent(true));
  await settled(page);
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    const empty = await f.cache.conversationDraft('one', f.identity);
    let failure = ''; try { await f.cache.saveConversationDraft('huge-metadata', { files: [], previewStyle: 'card', previewChoice: 'x'.repeat(1024 * 1024) }, f.identity); } catch (error) { failure = (error as Error).message; }
    return { revision: empty.revision, failure };
  });
  expect(result).toEqual({ revision: undefined, failure: 'draft_metadata_too_large' });
});

test('returning to a clean conversation waits for revalidation and adopts another window’s sent draft', async ({ page, context }) => {
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; f.draft.setFiles([new File(['old'], 'already-sent.txt')]); }); await settled(page);
  const other = await context.newPage();
  try {
    await other.goto(url); await expect(other.locator('#state')).toContainText('already-sent.txt');
    await page.evaluate(() => (window as unknown as { draftsFixture: Fixture }).draftsFixture.select('two'));
    await expect(page.locator('#state')).toContainText('"id":"two"');
    await other.evaluate(() => (window as unknown as { draftsFixture: Fixture }).draftsFixture.draft.clearSent(true)); await settled(other);
    await page.evaluate(() => {
      const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture, original = f.cache.conversationDraft.bind(f.cache);
      f.cache.conversationDraft = async (...args) => { await new Promise<void>(resolve => { (window as any).releaseDraftRead = resolve; }); return original(...args); };
      f.select('one');
    });
    await expect(page.locator('#state')).toContainText('"ready":false');
    await page.evaluate(() => (window as any).releaseDraftRead());
    await expect(page.locator('#state')).toContainText('"ready":true'); await expect(page.locator('#state')).toContainText('"files":[]');
  } finally { await other.close(); }
});

test('focus refreshes clean drafts but never replaces a failed local edit', async ({ page, context }) => {
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; f.draft.setFiles([new File(['old'], 'old.txt')]); }); await settled(page);
  const other = await context.newPage();
  try {
    await other.goto(url); await expect(other.locator('#state')).toContainText('old.txt');
    await other.evaluate(() => (window as unknown as { draftsFixture: Fixture }).draftsFixture.draft.clearSent(true)); await settled(other);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#state')).toContainText('"files":[]'); await expect(page.locator('#state')).toContainText('"ready":true');
    await page.evaluate(() => {
      const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
      f.cache.saveConversationDraft = async () => { throw new Error('quota'); };
      f.draft.setFiles([new File(['keep'], 'unsaved.txt')]);
    });
    await expect(page.locator('#state')).toContainText('quota');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#state')).toContainText('unsaved.txt'); await expect(page.locator('#state')).toContainText('quota');
  } finally { await other.close(); }
});

test('files added during focus revalidation merge with the latest disk draft once and keep their original conversation', async ({ page }) => {
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; f.draft.setFiles([new File(['sent'], 'already-sent.txt')]); });
  await settled(page);
  await page.evaluate(async () => {
    const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    // Another window has sent and cleared the old file before focus returns.
    const disk = await f.cache.conversationDraft('one', f.identity);
    await f.cache.saveConversationDraft('one', { files: [], previewStyle: 'card' }, f.identity, disk.revision);
    const read = f.cache.conversationDraft.bind(f.cache);
    f.cache.conversationDraft = async (...args) => {
      if (args[0] === 'one') { await new Promise<void>(resolve => { (window as any).releaseDraftRead = resolve; }); }
      return read(...args);
    };
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('#state')).toContainText('"ready":false');
  await page.evaluate(() => {
    const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    f.draft.setFiles(files => [...files, new File(['中文 bytes'], '中文.txt'), new File([new Uint8Array([0, 255, 9])], 'binary.bin')]);
    window.dispatchEvent(new Event('focus')); // Does not start another read.
    f.select('two');
  });
  await expect(page.locator('#state')).toContainText('"id":"two"');
  await expect(page.locator('#state')).toContainText('"ready":true');
  await page.evaluate(() => (window as any).releaseDraftRead());
  // The selected conversation is now two; wait for one's background write,
  // rather than relying on the selected draft's idle saving indicator.
  await expect.poll(() => page.evaluate(async () => {
    const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture, cache = new f.ClientCache('persistent-drafts');
    try { return (await cache.conversationDraft('one', f.identity)).draft.files.map(file => file.name); } finally { cache.close(); }
  })).toEqual(['中文.txt', 'binary.bin']);
  const disk = await page.evaluate(async () => {
    const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    const cache = new f.ClientCache('persistent-drafts');
    try {
      const one = await cache.conversationDraft('one', f.identity), two = await cache.conversationDraft('two', f.identity);
      return { one: await Promise.all(one.draft.files.map(async file => ({ name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) }))), two: two.draft.files.length };
    } finally { cache.close(); }
  });
  expect(disk).toEqual({ one: [{ name: '中文.txt', bytes: Array.from(Buffer.from('中文 bytes')) }, { name: 'binary.bin', bytes: [0, 255, 9] }], two: 0 });
});

test('files queued during a failed focus read stay visible without overwriting disk and recover once', async ({ page }) => {
  await page.evaluate(() => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; f.draft.setFiles([new File(['saved'], 'saved.txt')]); });
  await settled(page);
  await page.evaluate(() => {
    const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture, read = f.cache.conversationDraft.bind(f.cache);
    f.cache.conversationDraft = async (...args) => {
      f.cache.conversationDraft = read;
      await new Promise<void>((_, reject) => { (window as any).failDraftRead = () => reject(new Error('read_failed')); });
      return read(...args);
    };
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('#state')).toContainText('"ready":false');
  await page.evaluate(() => {
    const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    f.draft.setFiles(files => [...files, new File(['new'], 'added.txt')]);
    (window as any).failDraftRead();
  });
  await expect(page.locator('#state')).toContainText('read_failed');
  await expect(page.locator('#state')).toContainText('added.txt');
  const disk = await page.evaluate(async () => { const f = (window as unknown as { draftsFixture: Fixture }).draftsFixture; return (await f.cache.conversationDraft('one', f.identity)).draft.files.map(file => file.name); });
  expect(disk).toEqual(['saved.txt']);
  await page.evaluate(() => (window as unknown as { draftsFixture: Fixture }).draftsFixture.draft.retry());
  await expect(page.locator('#state')).toContainText('"ready":true'); await settled(page);
  await page.reload();
  await expect(page.locator('#state')).toContainText('"ready":true');
  const files = await page.evaluate(() => (window as unknown as { draftsFixture: Fixture }).draftsFixture.draft.files.map(file => file.name));
  expect(files).toEqual(['saved.txt', 'added.txt']);
});

test('a thousand empty CAS tombstones permit new drafts while a thousand active drafts enforce the limit', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cache, identity } = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    const request = indexedDB.open(cache.databaseName); const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const seed = async (active: number) => {
      const tx = db.transaction('conversationDrafts', 'readwrite'); const store = tx.objectStore('conversationDrafts'); store.clear();
      for (let i = 0; i < 1000; i++) store.put({ files: [], previewStyle: 'card', ...(active ? { previewChoice: null } : {}), active, size: 40, revision: `r${i}`, owner: JSON.stringify([identity.deviceId, identity.hubPublicKey, identity.publicKey]) }, `seed-${i}`);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    };
    const draft: ConversationDraft = { files: [new File(['new'], 'new.txt')], previewStyle: 'card' };
    await seed(0); const added = !!await cache.saveConversationDraft('new', draft, identity);
    let aba = ''; try { await cache.saveConversationDraft('seed-0', draft, identity); } catch (e) { aba = (e as Error).message; }
    await seed(1); let limit = ''; try { await cache.saveConversationDraft('new', draft, identity); } catch (e) { limit = (e as Error).message; }
    const cleared = await cache.saveConversationDraft('seed-0', { files: [], previewStyle: 'card' }, identity, 'r0');
    const reused = !!await cache.saveConversationDraft('seed-0', draft, identity, cleared);
    db.close(); return { added, aba, limit, reused };
  });
  expect(result).toEqual({ added: true, aba: 'draft_changed_elsewhere', limit: 'draft_record_limit', reused: true });
});

test('public-key rotation clears pairing-owned drafts and rejects the old key', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cache, identity } = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    await cache.saveConversationDraft('rotation', { files: [new File(['old'], 'old.txt')], previewStyle: 'card' }, identity);
    await cache.saveDraft('rotation', 'old text');
    const rotated = { ...identity, publicKey: 'rotated-key' }; await cache.saveIdentity(rotated);
    // A late revocation callback from the old key must not revoke this pairing.
    await cache.markIdentityRevoked(identity);
    let oldKey = ''; try { await cache.conversationDraft('rotation', identity); } catch (e) { oldKey = (e as Error).message; }
    const fresh = await cache.conversationDraft('rotation', rotated);
    const saved = !!await cache.saveConversationDraft('rotation', { files: [new File(['new'], 'new.txt')], previewStyle: 'card' }, rotated);
    return { oldKey, files: fresh.draft.files.length, revision: fresh.revision, text: await cache.draft('rotation'), saved, revoked: await cache.identityRevoked(rotated) };
  });
  expect(result).toEqual({ oldKey: 'draft_identity_changed', files: 0, revision: undefined, text: '', saved: true, revoked: false });
});


test('group text and edit identity are atomic, reject stale windows, and cannot clear same-text newer edits', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cache } = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    const start = { id: 'first-edit', empty: false, target: { conversationId: 'group', mode: 'sequential' as const, revision: 'v1' } };
    await cache.saveGroupComposerDraft('group', '继续', start);
    const loaded = await cache.groupComposerDraft('group');
    const note = { id: 'new-edit-same-text', empty: false, target: { ...start.target, activeRun: { id: 'run', conversationId: 'group' } } };
    await cache.saveGroupComposerDraft('group', '继续', note, loaded.intent!.id);
    let conflict = '';
    try { await cache.saveGroupComposerDraft('group', 'old window', { ...start, id: 'stale' }, start.id); } catch (error) { conflict = String(error); }
    const staleClear = await cache.clearGroupComposerDraft('group', '继续', start.id);
    const preserved = await cache.groupComposerDraft('group');
    const cleared = await cache.clearGroupComposerDraft('group', '继续', note.id);
    await cache.saveDraft('direct', '普通草稿');
    return { loaded, conflict, staleClear, preserved, cleared, after: await cache.groupComposerDraft('group'), direct: await cache.draft('direct') };
  });
  expect(result.loaded.intent?.id).toBe('first-edit'); expect(result.conflict).toContain('draft_changed_elsewhere');
  expect(result.staleClear).toBeUndefined(); expect(result.preserved.text).toBe('继续'); expect(result.preserved.intent?.target?.activeRun?.id).toBe('run');
  expect(result.after.text).toBe(''); expect(result.after.intent?.id).toBe(result.cleared?.id); expect(result.after.intent?.empty).toBe(true);
  expect(result.direct).toBe('普通草稿');
});


test('internal discussion send receipts never appear as another user draft', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cache } = (window as unknown as { draftsFixture: Fixture }).draftsFixture;
    await cache.saveDraft('discussion-composer:group', JSON.stringify({ kind: 'start', body: { requestId: 'uncertain' } }));
    await cache.updateOperationIfMatches('native-input:group:bot', '', 'uncertain input');
    await cache.updateOperationIfMatches('native-control:group:message:cancel', '', 'uncertain control');
    const alone = { count: await cache.draftCount(), previews: await cache.draftPreviews() };
    await cache.saveDraft('group', '真正的未发送文字');
    return { alone, count: await cache.draftCount(), previews: await cache.draftPreviews() };
  });
  expect(result.alone).toEqual({ count: 0, previews: {} });
  expect(result.count).toBe(1); expect(Object.keys(result.previews)).toEqual(['group']); expect(result.previews.group?.text).toBe('真正的未发送文字');
});


test.describe('embedded editor focus', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('returning to an iframe-focused tab still adopts another tab’s cleared draft', async ({ page, context }) => {
    await page.evaluate(() => {
      const f = (window as any).draftsFixture; f.draft.setFiles([new File(['old'], 'already-sent.txt')]);
      const frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts');
      frame.srcdoc = '<button>Embedded editor</button>'; document.body.append(frame);
    });
    await settled(page);
    await page.frameLocator('iframe').getByRole('button', { name: 'Embedded editor' }).tap();
    const other = await context.newPage();
    try {
      await other.goto(url); await expect(other.locator('#state')).toContainText('already-sent.txt');
      await other.evaluate(() => (window as any).draftsFixture.draft.clearSent(true)); await settled(other);
      await page.bringToFront();
      await page.locator('#act').tap();
      await expect(page.locator('#state')).toContainText('"files":[]');
      expect(await page.evaluate(() => (window as any).draftsFixture.activatedFiles ?? [])).toEqual([]);
    } finally { await other.close(); }
  });

});
