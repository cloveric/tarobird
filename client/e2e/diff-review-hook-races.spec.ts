import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";

const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {ClientCache} from '/src/storage.ts';import {useDiffReview} from '/src/use-diff-review.ts';
const identity={deviceId:'device',hubPublicKey:'hub',publicKey:'key',name:'test',routes:[]},scope={conversationId:'conversation',botId:'bot'};
const cache=new ClientCache('diff-review-hook');await cache.initializeIdentity(identity);
const note={id:'one',path:'src/example.ts',head:'a'.repeat(40),side:'new',start:1,end:1,excerpt:'const x = 1;',comment:'original comment'};
await cache.saveDiffReviewDraft(scope,identity,[note]);
const listeners=new Set(),f=window.reviewHookFixture={cache,identity,scope};
f.holdSend=()=>{f.sendGate=new Promise(resolve=>f.releaseSend=resolve)};
f.holdRead=()=>{const original=cache.diffReviewDraft.bind(cache);let once=true;f.readGate=new Promise(resolve=>f.releaseRead=resolve);cache.diffReviewDraft=async(...args)=>{const result=await original(...args);if(once){once=false;f.readCaptured=true;await f.readGate;f.readReleased=true}return result}};
f.holdSave=(before)=>{const original=cache.saveDiffReviewDraft.bind(cache);let once=true;f.saveGate=new Promise(resolve=>f.releaseSave=resolve);cache.saveDiffReviewDraft=async(...args)=>{const hold=once;once=false;if(hold&&before){f.saveCaptured=true;await f.saveGate}const result=await original(...args);if(hold&&!before){f.saveCaptured=true;await f.saveGate}return result}};
f.refresh=()=>window.dispatchEvent(new Event('focus'));
f.connectionUpdate=()=>listeners.forEach(fn=>fn());
const connection={cache,identity,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},async queueDiffReview(scope,revision){const result=await cache.enqueueDiffReview(scope,identity,revision);f.queueCommitted=true;if(f.sendGate)await f.sendGate;return result},async retryDiffReview(scope,id){return cache.retryDiffReview(scope,identity,id)},async abandonDiffReview(scope,id){return cache.abandonDiffReview(scope,identity,id)}};
function App(){const [enabled,setEnabled]=React.useState(true);f.setEnabled=setEnabled;const review=useDiffReview(connection,scope,enabled);f.review=review;return React.createElement('div',null,React.createElement('output',null,JSON.stringify({enabled,ready:review.ready,saving:review.saving,error:review.error,pending:!!review.draft.pending})),React.createElement('textarea',{value:review.draft.notes[0]?.comment??'',onChange:event=>review.change(review.draft.notes.map(note=>({...note,comment:event.target.value})))}))}
const root=createRoot(document.getElementById('root'));let mount=0;
f.remount=()=>root.render(React.createElement(App,{key:++mount}));f.unmount=()=>root.unmount();f.remount();
</script></body></html>`;
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "diff-review-hook-harness", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => { if (req.url !== "/__review_hook") return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__review_hook", html)); });
  } }], server: { port: 0, host: "127.0.0.1" } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "__review_hook";
});
test.afterAll(async () => { await server.close(); });
test.beforeEach(async ({ page }) => { await page.goto(url); await expect(page.locator("output")).toContainText('"ready":true'); });

test("send completion cannot replace a newer local comment with its queued snapshot", async ({ page }) => {
  await page.evaluate(() => { const f = (window as any).reviewHookFixture; f.holdSend(); void f.review.send().finally(() => { f.sendFinished = true; }); });
  await expect.poll(() => page.evaluate(() => (window as any).reviewHookFixture.queueCommitted)).toBe(true);
  await page.locator("textarea").fill("newer local comment");
  await expect(page.locator("textarea")).toHaveValue("newer local comment");
  await page.evaluate(() => (window as any).reviewHookFixture.releaseSend());
  await expect.poll(() => page.evaluate(() => (window as any).reviewHookFixture.sendFinished)).toBe(true);
  await expect(page.locator("textarea")).toHaveValue("newer local comment");
});

test("a refresh begun before send cannot replace the pending receipt after send", async ({ page }) => {
  await page.evaluate(() => { const f = (window as any).reviewHookFixture; f.holdRead(); f.refresh(); });
  await expect.poll(() => page.evaluate(() => (window as any).reviewHookFixture.readCaptured)).toBe(true);
  await page.evaluate(async () => { await (window as any).reviewHookFixture.review.send(); });
  await expect(page.locator("output")).toContainText('"pending":true');
  await page.evaluate(() => (window as any).reviewHookFixture.releaseRead());
  await expect.poll(() => page.evaluate(() => (window as any).reviewHookFixture.readReleased)).toBe(true);
  await expect(page.locator("output")).toContainText('"pending":true');
});

test("an ACK arriving during a stale pending read requests another read after it settles", async ({ page }) => {
  await page.evaluate(async () => { const f = (window as any).reviewHookFixture; await f.review.send(); f.holdRead(); f.refresh(); });
  await expect.poll(() => page.evaluate(() => (window as any).reviewHookFixture.readCaptured)).toBe(true);
  await page.evaluate(async () => { const f = (window as any).reviewHookFixture; await f.cache.acknowledge(f.review.draft.pending.clientMsgId, true); f.releaseRead(); });
  await expect(page.locator("output")).toContainText('"pending":false');
  await expect(page.locator("textarea")).toHaveValue("");
});

test("ACK during a delayed save response keeps the edit and refreshes its settled receipt", async ({ page }) => {
  await page.evaluate(async () => { const f = (window as any).reviewHookFixture; await f.review.send(); f.holdSave(false); });
  await page.locator("textarea").fill("edited while pending");
  await expect.poll(() => page.evaluate(() => (window as any).reviewHookFixture.saveCaptured)).toBe(true);
  await page.evaluate(async () => { const f = (window as any).reviewHookFixture; await f.cache.acknowledge(f.review.draft.pending.clientMsgId, true); f.releaseSave(); });
  await expect(page.locator("output")).toContainText('"saving":false');
  await expect(page.locator("output")).toContainText('"pending":false');
  await expect(page.locator("output")).toContainText('"error":""');
  await expect(page.locator("textarea")).toHaveValue("edited while pending");
});

test("ACK before a pending save conflicts without discarding the visible unsaved edit", async ({ page }) => {
  await page.evaluate(async () => { const f = (window as any).reviewHookFixture; await f.review.send(); f.holdSave(true); });
  await page.locator("textarea").fill("keep this unsaved edit");
  await expect.poll(() => page.evaluate(() => (window as any).reviewHookFixture.saveCaptured)).toBe(true);
  await page.evaluate(async () => { const f = (window as any).reviewHookFixture; await f.cache.acknowledge(f.review.draft.pending.clientMsgId, true); f.releaseSave(); });
  await expect(page.locator("output")).toContainText('"error":"save"');
  await expect(page.locator("textarea")).toHaveValue("keep this unsaved edit");
  expect(await page.evaluate(async () => { const f = (window as any).reviewHookFixture; return (await f.cache.diffReviewDraft(f.scope, f.identity)).notes; })).toEqual([]);
});

test("continuous review receipt updates cannot starve a slow successful draft read", async ({ page }) => {
  await page.evaluate(async () => {
    const f = (window as any).reviewHookFixture;
    const queued = await f.review.send(), original = f.cache.diffReviewDraft.bind(f.cache);
    f.cache.diffReviewDraft = async (...args: unknown[]) => { const value = await original(...args); await new Promise(resolve => setTimeout(resolve, 20)); return value; };
    const latest = await original(f.scope, f.identity);
    let tick = 0;
    f.hotUpdates = setInterval(() => { void f.cache.fail(queued.frame.clientMsgId, 'retry-' + ++tick); }, 5);
    await f.cache.saveDiffReviewDraft(f.scope, f.identity, latest.notes.map((note: any) => ({ ...note, comment: "updated in another window" })), latest.revision);
    f.remount();
  });
  try {
    await expect(page.locator("output")).toContainText('"ready":true', { timeout: 1000 });
    await expect(page.locator("textarea")).toHaveValue("updated in another window", { timeout: 1000 });
  }
  finally { await page.evaluate(() => clearInterval((window as any).reviewHookFixture.hotUpdates)); }
});

test("only matching review changes read storage, and notification bursts stay bounded", async ({ page }) => {
  await page.evaluate(async () => { const f = (window as any).reviewHookFixture; await f.review.send(); });
  await page.waitForTimeout(250);
  await page.evaluate(async () => {
    const f = (window as any).reviewHookFixture, original = f.cache.diffReviewDraft.bind(f.cache);
    f.reads = 0; f.cache.diffReviewDraft = async (...args: unknown[]) => { f.reads++; return original(...args); };
    for (let i = 0; i < 100; i++) f.connectionUpdate();
    await f.cache.saveDraft(f.scope.conversationId, "ordinary draft");
    await f.cache.saveDiffReviewDraft({ ...f.scope, botId: "other-bot" }, f.identity, []);
    await f.cache.saveDiffReviewDraft({ ...f.scope, conversationId: "other-conversation" }, f.identity, []);
  });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as any).reviewHookFixture.reads)).toBe(0);
  await page.evaluate(async () => {
    const f = (window as any).reviewHookFixture, id = f.review.draft.pending.clientMsgId;
    for (let i = 0; i < 40; i++) await f.cache.fail(id, "failure-" + i);
  });
  await expect.poll(() => page.evaluate(() => (window as any).reviewHookFixture.review.draft.pendingError)).toBe("failure-39");
  expect(await page.evaluate(() => (window as any).reviewHookFixture.reads)).toBeLessThanOrEqual(2);
  await page.evaluate(async () => {
    const f = (window as any).reviewHookFixture;
    await f.cache.fail(f.review.draft.pending.clientMsgId, "after-close");
    f.unmount(); f.readsAtClose = f.reads;
  });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => { const f = (window as any).reviewHookFixture; return f.reads - f.readsAtClose; })).toBe(0);
});

test("disabled desktop review retains unsaved-work unload guards without guarding a read error", async ({ page }) => {
  const guarded = () => page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  await page.evaluate(() => (window as any).reviewHookFixture.holdSave(true));
  await page.locator("textarea").fill("save before leaving");
  await expect.poll(() => page.evaluate(() => (window as any).reviewHookFixture.saveCaptured)).toBe(true);
  await page.evaluate(() => (window as any).reviewHookFixture.setEnabled(false));
  await expect(page.locator("output")).toContainText('"enabled":false');
  expect(await guarded()).toBe(true);
  await page.evaluate(() => (window as any).reviewHookFixture.releaseSave());
  await expect(page.locator("output")).toContainText('"saving":false');
  expect(await guarded()).toBe(false);

  await page.evaluate(() => {
    const f = (window as any).reviewHookFixture; f.setEnabled(true);
    f.cache.saveDiffReviewDraft = async () => { throw new Error("forced save failure"); };
  });
  await page.locator("textarea").fill("preserve this unsaved edit");
  await expect(page.locator("output")).toContainText('"error":"save"');
  await page.evaluate(() => (window as any).reviewHookFixture.setEnabled(false));
  await expect(page.locator("output")).toContainText('"enabled":false');
  expect(await guarded()).toBe(true);
  await expect(page.locator("textarea")).toHaveValue("preserve this unsaved edit");

  await page.evaluate(() => {
    const f = (window as any).reviewHookFixture;
    f.cache.diffReviewDraft = async () => { throw new Error("forced read failure"); }; f.remount();
  });
  await expect(page.locator("output")).toContainText('"error":"read"');
  expect(await guarded()).toBe(false);
});
