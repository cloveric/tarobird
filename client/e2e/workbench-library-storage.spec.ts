import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";

// Real IndexedDB, Web Locks and BroadcastChannel; pages in one context are same-origin windows.
const html = `<!doctype html><html><body><script type="module">
import {ClientCache} from '/src/storage.ts';
import {emptyWorkbench,emptyBoard,changeWorkbench,workbenchScope} from '/src/workbench-model.ts';
import {emptyMarkdown} from '/src/workbench-markdown.ts';
import {emptyDesign} from '/src/workbench-design.ts';
import {noteRecoveryKey,rememberNoteRecovery,readNoteRecovery} from '/src/workbench-note-recovery.ts';
import {listWorkbenchLibrary,deleteWorkbenchLibraryEntries,workbenchEditorLock,workbenchLibraryKey,designEditorLocks} from '/src/workbench-library.ts';
import {DesignSession} from '/src/workbench-design-session.ts';
import {designFrame} from '/src/design-frame.ts';
const connection=(cache,user='owner')=>({identity:{deviceId:'device',hubPublicKey:'hub'},state:{user:{id:user}},isClosed:false,isReadOnly:false,cache});
const item=(cache,scope,kind,id)=>({key:workbenchLibraryKey(cache.databaseName,scope,kind,id),scope,kind,id});
const list=(cache,user)=>listWorkbenchLibrary(connection(cache,user));
const layout=(tabs=[],closed=[],visible=[])=>({...emptyWorkbench(),tabs,closed,visible,active:visible[0]??null});
async function seed(cache,scope,{tabs,closed,visible,boards=[],notes=[],designs=[]}){
  if(tabs||closed)await cache.saveWorkbench(scope,-1,layout(tabs,closed,visible));
  for(const id of boards)await cache.saveWorkbenchBoard(scope,-1,emptyBoard(id));
  for(const id of notes)await cache.saveWorkbenchMarkdown(scope,-1,emptyMarkdown(id,'text of '+id));
  for(const id of designs)await cache.saveWorkbenchDesign(scope,-1,emptyDesign(id));
}
/** Writes rows the typed API refuses: older or corrupt data. */
async function raw(name,store,key,value){
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
}
async function rawMany(name,store,rows){
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');for(const [key,value] of rows)tx.objectStore(store).put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
}
/** Records which stores had values read, to prove listing never clones content. */
function readsDuring(){
  const reads=[],proto=IDBObjectStore.prototype,saved={get:proto.get,getAll:proto.getAll,openCursor:proto.openCursor};
  for(const name of Object.keys(saved))proto[name]=function(...args){reads.push(name+':'+this.name);return saved[name].apply(this,args);};
  return ()=>{Object.assign(proto,saved);return reads;};
}
window.fixture={ClientCache,workbenchScope,emptyWorkbench,emptyBoard,emptyMarkdown,changeWorkbench,noteRecoveryKey,rememberNoteRecovery,readNoteRecovery,listWorkbenchLibrary,deleteWorkbenchLibraryEntries,workbenchEditorLock,emptyDesign,DesignSession,designFrame,designEditorLocks,connection,item,list,seed,raw,rawMany,readsDuring};
document.body.append('ready');
</script></body></html>`;
let server: ViteDevServer, url: string;
test.use({ serviceWorkers: "block" });
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "workbench-library-storage-test", configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (req.url !== "/__workbench_library") return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__workbench_library", html));
  }); } }], server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen(); url = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => { await server?.close(); });
async function ready(page: Page) { await page.goto(url + "__workbench_library"); await expect(page.locator("body")).toContainText("ready"); }
test.beforeEach(async ({ page }) => { await ready(page); });
const database = (name: string) => `workbench-library-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("lists one owner's items as metadata, with titles, closed, orphaned and missing content", async ({ page }) => {
  const result = await page.evaluate(async (name) => {
    const f = (window as any).fixture, cache = new f.ClientCache(name), scope = f.workbenchScope("hub", "owner", "c1"), invalid = f.workbenchScope("hub", "owner", "c2");
    await f.seed(cache, scope, { tabs: [{ id: "b1", kind: "whiteboard", title: "Plan" }, { id: "chart", kind: "chart", title: "Chart", source: { messageId: "m", blockIndex: 0, version: 0 } }, { id: "lost", kind: "whiteboard", title: "Lost" }],
      closed: [{ id: "n1", kind: "markdown", title: "Notes.md" }], visible: ["b1"], boards: ["b1"], notes: ["n1"], designs: ["d1"] });
    // Another user and another Host in the same database are never listed.
    await f.seed(cache, f.workbenchScope("hub", "other", "c1"), { tabs: [{ id: "x", kind: "whiteboard", title: "Theirs" }], boards: ["x"] });
    await f.seed(cache, f.workbenchScope("hub2", "owner", "c1"), { tabs: [{ id: "y", kind: "whiteboard", title: "Other host" }], boards: ["y"] });
    await f.raw(name, "workbenchLayouts", invalid, { schema: 1, revision: 3, tabs: "corrupt" });
    await f.seed(cache, invalid, { notes: ["n2"] });
    await f.raw(name, "workbenchLayouts", '["hub","owner",7]', f.emptyWorkbench());
    await f.raw(name, "workbenchLayouts", '["hub","owner", "c3"]', f.emptyWorkbench());
    const done = f.readsDuring(), listing = await f.list(cache), reads = done();
    cache.close(); return { listing, reads: [...new Set(reads)].filter((read: string) => read.includes(":workbench")).sort(), scope, invalid };
  }, database("list"));
  const at = { scope: result.scope, conversationId: "c1", layoutRevision: 0 };
  expect(result.listing).toEqual({ truncated: false, skipped: 2, entries: [
    { ...at, id: "b1", kind: "whiteboard", title: "Plan", state: "open" },
    { ...at, id: "n1", kind: "markdown", title: "Notes.md", state: "closed" },
    { ...at, id: "lost", kind: "whiteboard", title: "Lost", state: "missing" },
    { ...at, id: "d1", kind: "design", state: "orphan" },
    { scope: result.invalid, conversationId: "c2", layoutInvalid: true, id: "n2", kind: "markdown", state: "orphan" },
  ] });
  expect(result.reads).toEqual(["openCursor:workbenchLayouts"]);
});

test("a bounded listing omits unscanned conversations instead of misreporting them", async ({ page }) => {
  const result = await page.evaluate(async (name) => {
    const f = (window as any).fixture, cache = new f.ClientCache(name);
    await f.seed(cache, f.workbenchScope("hub", "owner", "a"), { tabs: [{ id: "b1", kind: "whiteboard", title: "A" }], boards: ["b1"] });
    await f.seed(cache, f.workbenchScope("hub", "owner", "b"), { tabs: [{ id: "b2", kind: "whiteboard", title: "B" }], boards: ["b2", "b3"] });
    const scopes = await cache.listWorkbenchItems({ host: "hub", user: "owner" }, { scopes: 1 }), entries = await cache.listWorkbenchItems({ host: "hub", user: "owner" }, { entries: 2 });
    cache.close(); return { scopes, entries };
  }, database("bounded"));
  expect(result.scopes.truncated).toBe(true);
  expect(result.scopes.items.map((entry: { id: string }) => entry.id)).toEqual(["b1"]);
  expect(result.entries.truncated).toBe(true);
  expect(result.entries.items.map((entry: { id: string; state: string }) => [entry.id, entry.state])).toEqual([["b1", "open"], ["b2", "open"]]);
});

test("deletes content and its references in one commit, keeps the layout record, and retries idempotently", async ({ page }) => {
  const result = await page.evaluate(async (name) => {
    const f = (window as any).fixture, cache = new f.ClientCache(name), scope = f.workbenchScope("hub", "owner", "c1"), connection = f.connection(cache);
    await f.seed(cache, scope, { tabs: [{ id: "b1", kind: "whiteboard", title: "Plan" }, { id: "keep", kind: "whiteboard", title: "Keep" }], closed: [{ id: "n1", kind: "markdown", title: "N" }], visible: ["b1", "keep"], boards: ["b1", "keep"], notes: ["n1"] });
    const key = f.noteRecoveryKey("device", scope, "n1"); f.rememberNoteRecovery(key, { content: "draft", revision: 0 });
    const entries = [f.item(cache, scope, "whiteboard", "b1"), f.item(cache, scope, "markdown", "n1"), f.item(cache, scope, "markdown", "b1")];
    const first = await f.deleteWorkbenchLibraryEntries(connection, entries), layout = await cache.readWorkbench(scope);
    const second = await f.deleteWorkbenchLibraryEntries(connection, entries.slice(0, 2)), again = await cache.readWorkbench(scope);
    const remaining = { board: !!await cache.readWorkbenchBoard(scope, "b1"), note: !!await cache.readWorkbenchMarkdown(scope, "n1"), keep: !!await cache.readWorkbenchBoard(scope, "keep") };
    const scopes = await cache.workbenchBrowserScopes("hub"), recovery = f.readNoteRecovery(key); cache.close();
    return { first: first.map((value: any) => value.status), second: second.map((value: any) => value.status), layout, again: again.revision, remaining, scopes, recovery };
  }, database("delete"));
  // The mismatched kind runs in the same commit but never touches the whiteboard tab of that ID.
  expect(result.first).toEqual(["deleted", "deleted", "kind_mismatch"]);
  expect(result.layout).toMatchObject({ revision: 1, tabs: [{ id: "keep" }], closed: [], visible: ["keep"], active: "keep" });
  expect(result.second).toEqual(["already_deleted", "already_deleted"]);
  expect(result.again).toBe(1);
  expect(result.remaining).toEqual({ board: false, note: false, keep: true });
  expect(result.scopes).toEqual([{ host: "hub", user: "owner", conversation: "c1" }]);
  expect(result.recovery).toBeUndefined();
});

test("an item held by an editor in another window is busy; the rest commit and that window is told only IDs", async ({ page, context }) => {
  const name = database("windows");
  await page.evaluate(async (name) => {
    const f = (window as any).fixture, cache = new f.ClientCache(name), scope = f.workbenchScope("hub", "owner", "c1");
    await f.seed(cache, scope, { tabs: [{ id: "n1", kind: "markdown", title: "Open" }], closed: [{ id: "b1", kind: "whiteboard", title: "Closed" }], visible: ["n1"], boards: ["b1"], notes: ["n1"] });
    cache.close();
  }, name);
  const other = await context.newPage(); await ready(other);
  await other.evaluate(async (name) => {
    const f = (window as any).fixture, cache = new f.ClientCache(name), scope = f.workbenchScope("hub", "owner", "c1");
    (window as any).heard = []; cache.subscribeWorkbenchChanges(scope, (ids: string[]) => (window as any).heard.push(ids));
    (window as any).board = await cache.readWorkbenchBoard(scope, "b1"); (window as any).layout = await cache.readWorkbench(scope); (window as any).cache = cache;
    await new Promise<void>(granted => { void navigator.locks.request(f.workbenchEditorLock("markdown", scope, "n1"), () => { granted(); return new Promise(() => undefined); }); });
  }, name);
  const results = await page.evaluate(async (name) => {
    const f = (window as any).fixture, cache = new f.ClientCache(name), scope = f.workbenchScope("hub", "owner", "c1");
    // The UI deletes what it listed; listing itself grants nothing.
    const listed = (await f.list(cache)).entries.filter((value: any) => value.scope === scope);
    const results = await f.deleteWorkbenchLibraryEntries(f.connection(cache), listed);
    cache.close(); return results.map((value: any) => [value.status, value.error]);
  }, name);
  expect(results).toEqual([["busy", "workbench_item_busy"], ["deleted", undefined]]);
  await expect.poll(() => other.evaluate(() => (window as any).heard)).toEqual([["b1"]]);
  // The stale window cannot write the deleted board or its old layout back.
  const stale = await other.evaluate(async () => {
    const w = window as any, scope = w.fixture.workbenchScope("hub", "owner", "c1"), errors: string[] = [];
    for (const write of [() => w.cache.saveWorkbenchBoard(scope, 0, { ...w.board, revision: 1 }), () => w.cache.saveWorkbench(scope, 0, { ...w.layout, revision: 1 })])
      try { await write(); } catch (error) { errors.push((error as Error).message); }
    return { errors, board: await w.cache.readWorkbenchBoard(scope, "b1"), note: !!await w.cache.readWorkbenchMarkdown(scope, "n1") };
  });
  expect(stale).toEqual({ errors: ["whiteboard_revision_conflict", "workbench_revision_conflict"], board: undefined, note: true });
});

test("a local reset in progress fences library deletion", async ({ page }) => {
  const result = await page.evaluate(async (name) => {
    const f = (window as any).fixture, cache = new f.ClientCache(name), scope = f.workbenchScope("hub", "owner", "c1");
    await f.seed(cache, scope, { tabs: [{ id: "b1", kind: "whiteboard", title: "Plan" }], boards: ["b1"] });
    await cache.beginReset();
    const results = await f.deleteWorkbenchLibraryEntries(f.connection(cache), [f.item(cache, scope, "whiteboard", "b1")]);
    const board = !!await cache.readWorkbenchBoard(scope, "b1"); cache.close(); return { results, board };
  }, database("reset"));
  expect(result.results.map((value: any) => [value.status, value.error])).toEqual([["reset_in_progress", "local_reset_in_progress"]]);
  expect(result.board).toBe(true);
});

test("designs with an open or closed Tab but no editor are deleted with their references; late autosaves cannot write them back", async ({ page }) => {
  const result = await page.evaluate(async (name) => {
    const f = (window as any).fixture, cache = new f.ClientCache(name), scope = f.workbenchScope("hub", "owner", "c1"), connection = f.connection(cache);
    await f.seed(cache, scope, { tabs: [{ id: "open", kind: "design", title: "Open" }], closed: [{ id: "shut", kind: "design", title: "Shut" }, { id: "note", kind: "markdown", title: "N" }], visible: ["open"], designs: ["open", "shut"], notes: ["note"] });
    // A stale editor read these before deletion and keeps autosaving afterwards.
    const design = await cache.readWorkbenchDesign(scope, "shut"), note = await cache.readWorkbenchMarkdown(scope, "note");
    const results = await f.deleteWorkbenchLibraryEntries(connection, [f.item(cache, scope, "design", "open"), f.item(cache, scope, "design", "shut"), f.item(cache, scope, "markdown", "note")]);
    const errors: string[] = [];
    for (const write of [() => cache.saveWorkbenchDesign(scope, 0, { ...design, revision: 1 }), () => cache.saveWorkbenchMarkdown(scope, 0, { ...note, revision: 1, content: "late autosave" })])
      try { await write(); } catch (error) { errors.push((error as Error).message); }
    const layout = await cache.readWorkbench(scope), left = { open: !!await cache.readWorkbenchDesign(scope, "open"), shut: !!await cache.readWorkbenchDesign(scope, "shut"), note: !!await cache.readWorkbenchMarkdown(scope, "note") };
    cache.close(); return { results: results.map((value: any) => [value.id, value.status, value.error]), errors, layout, left };
  }, database("design"));
  // Only a mounted editor's lock makes a design busy (covered below); an inactive conversation's Tab does not.
  expect(result.results).toEqual([["open", "deleted", undefined], ["shut", "deleted", undefined], ["note", "deleted", undefined]]);
  expect(result.errors).toEqual(["design_revision_conflict", "markdown_revision_conflict"]);
  expect(result.layout).toMatchObject({ revision: 1, tabs: [], closed: [], visible: [], active: null });
  expect(result.left).toEqual({ open: false, shut: false, note: false });
});

/** A design editor frame over an in-memory session; `stored` is what the session reloads. */
async function designHarness(page: Page) {
  await page.evaluate(() => {
    const w = window as any, f = w.fixture, scope = f.workbenchScope("hub", "owner", "c1"), name = f.workbenchEditorLock("design", scope, "d");
    w.stored = f.emptyDesign("d"); w.errors = [];
    const session = new f.DesignSession(w.stored, async () => w.stored, async (_expected: number, next: unknown) => { w.stored = next; }, () => undefined);
    f.designEditorLocks.set(session, name); w.session = session; w.lockName = name;
    w.place = document.createElement("div"); w.place.style.cssText = "width:480px;height:320px"; document.body.append(w.place);
    w.frameShown = () => !!document.querySelector("iframe.workbench-design-frame");
    w.lockState = async () => { const state = await navigator.locks.query(); return { held: (state.held ?? []).filter(lock => lock.name === name).map(lock => lock.mode), pending: (state.pending ?? []).filter(lock => lock.name === name).map(lock => lock.mode) }; };
    // A library deletion in flight holds the design lock exclusively.
    return new Promise<void>(granted => { void navigator.locks.request(name, () => { granted(); return new Promise<void>(release => { w.releaseLibrary = release; }); }); });
  });
}

test("a design editor loads only after it holds the shared lock, which then makes library deletion busy", async ({ page }) => {
  await designHarness(page);
  const waiting = await page.evaluate(async () => {
    const w = window as any; w.fixture.designFrame(w.session).attach(w.place, (error?: string) => { if (error) w.errors.push(error); }, () => undefined);
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { shown: w.frameShown(), locks: await w.lockState() };
  });
  // Nothing can write while the deletion holds the lock: no editor frame exists yet.
  expect(waiting).toEqual({ shown: false, locks: { held: ["exclusive"], pending: ["shared"] } });
  await page.evaluate(() => (window as any).releaseLibrary());
  await expect.poll(() => page.evaluate(() => (window as any).frameShown()), { timeout: 30_000 }).toBe(true);
  const result = await page.evaluate(async (name) => {
    const w = window as any, f = w.fixture, cache = new f.ClientCache(name), scope = f.workbenchScope("hub", "owner", "c1");
    await f.seed(cache, scope, { tabs: [{ id: "b", kind: "whiteboard", title: "B" }], closed: [{ id: "d", kind: "design", title: "D" }], visible: ["b"], boards: ["b"], designs: ["d"] });
    const locks = await w.lockState(), busy = await f.deleteWorkbenchLibraryEntries(f.connection(cache), [f.item(cache, scope, "design", "d")]);
    // A Web Lock is released asynchronously after its holder's promise settles.
    w.session.discard();
    for (let tries = 0; tries < 100 && (await w.lockState()).held.length; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    const released = await w.lockState(), deleted = await f.deleteWorkbenchLibraryEntries(f.connection(cache), [f.item(cache, scope, "design", "d")]);
    cache.close(); return { locks, busy: busy.map((value: any) => [value.status, value.error]), released, deleted: deleted.map((value: any) => value.status), errors: w.errors };
  }, database("design-lock"));
  expect(result).toEqual({ locks: { held: ["shared"], pending: [] }, busy: [["busy", "workbench_item_busy"]], released: { held: [], pending: [] }, deleted: ["deleted"], errors: [] });
});

test("a design editor destroyed while waiting never holds the lock, and one whose design was deleted meanwhile never loads", async ({ page }) => {
  await designHarness(page);
  const destroyed = await page.evaluate(async () => {
    const w = window as any; w.fixture.designFrame(w.session).attach(w.place, () => undefined, () => undefined);
    await new Promise(resolve => setTimeout(resolve, 300)); w.session.discard(); w.releaseLibrary();
    await new Promise(resolve => setTimeout(resolve, 800));
    return { shown: w.frameShown(), locks: await w.lockState() };
  });
  expect(destroyed).toEqual({ shown: false, locks: { held: [], pending: [] } });
  await ready(page); await designHarness(page);
  const deleted = await page.evaluate(async () => {
    const w = window as any; w.fixture.designFrame(w.session).attach(w.place, (error?: string) => { if (error) w.errors.push(error); }, () => undefined);
    await new Promise(resolve => setTimeout(resolve, 300)); w.stored = undefined; w.releaseLibrary();
    await new Promise(resolve => setTimeout(resolve, 3000));
    return { shown: w.frameShown(), errors: w.errors };
  });
  expect(deleted).toEqual({ shown: false, errors: ["design_not_found"] });
});

test("empty and browser-only historical layouts never starve later conversations' files", async ({ page }) => {
  const result = await page.evaluate(async (name) => {
    const f = (window as any).fixture, cache = new f.ClientCache(name), late = f.workbenchScope("hub", "owner", "zz-late");
    await f.seed(cache, late, { closed: [{ id: "n1", kind: "markdown", title: "Late.md" }], notes: ["n1"] });
    await f.seed(cache, f.workbenchScope("hub", "owner", "zz-missing"), { closed: [{ id: "m1", kind: "whiteboard", title: "Gone" }] });
    // Library deletion retains layout records, so these accumulate and sort before the live conversations.
    const browser = { ...f.emptyWorkbench(), tabs: [{ id: "web", kind: "browser", title: "Site", url: "https://example.com/" }], visible: ["web"], active: "web" };
    await f.rawMany(name, "workbenchLayouts", Array.from({ length: 1005 }, (_, index) => [f.workbenchScope("hub", "owner", `a${String(index).padStart(4, "0")}`), index < 1001 ? f.emptyWorkbench() : browser]));
    const listing = await f.list(cache), scanned = await cache.listWorkbenchItems({ host: "hub", user: "owner" }, { layouts: 10 });
    cache.close(); return { listing, scanned };
  }, database("starvation"));
  const shape = (entries: any[]) => entries.map(entry => [entry.conversationId, entry.id, entry.title, entry.state]);
  expect(result.listing.truncated).toBe(false);
  expect(shape(result.listing.entries)).toEqual([["zz-late", "n1", "Late.md", "closed"], ["zz-missing", "m1", "Gone", "missing"]]);
  // Even past an exhausted layout scan, stored content is always reachable with its exact Tab state;
  // only a reference without content beyond the scan is omitted (never misreported) and flagged.
  expect(result.scanned.truncated).toBe(true);
  expect(shape(result.scanned.items)).toEqual([["zz-late", "n1", "Late.md", "closed"]]);
});

test("a design still edited in window A stays busy after window B closed its Tab, until A's editor is gone", async ({ page, context }) => {
  const name = database("design-windows");
  await designHarness(page);
  await page.evaluate(async (name) => {
    const w = window as any, f = w.fixture, cache = new f.ClientCache(name), scope = f.workbenchScope("hub", "owner", "c1");
    // The committed layout already says "closed": window B closed the Tab, and A never adopted it.
    await f.seed(cache, scope, { closed: [{ id: "d", kind: "design", title: "D" }], designs: ["d"] }); cache.close();
    w.fixture.designFrame(w.session).attach(w.place, () => undefined, () => undefined); w.releaseLibrary();
  }, name);
  await expect.poll(() => page.evaluate(() => (window as any).frameShown()), { timeout: 30_000 }).toBe(true);
  const other = await context.newPage(); await ready(other);
  const remove = () => other.evaluate(async (name) => {
    const f = (window as any).fixture, cache = new f.ClientCache(name), scope = f.workbenchScope("hub", "owner", "c1");
    const [result] = await f.deleteWorkbenchLibraryEntries(f.connection(cache), (await f.list(cache)).entries);
    const kept = !!await cache.readWorkbenchDesign(scope, "d"); cache.close(); return { status: result.status, error: result.error, kept };
  }, name);
  expect(await remove()).toEqual({ status: "busy", error: "workbench_item_busy", kept: true });
  await page.evaluate(() => (window as any).session.discard());
  await expect.poll(() => page.evaluate(async () => (await (window as any).lockState()).held.length)).toBe(0);
  expect(await remove()).toEqual({ status: "deleted", error: undefined, kept: false });
});
