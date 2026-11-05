// Actual Chromium click/crash regression, isolated from installed App and Host.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
import { buildPreload } from '../../scripts/electron-preload.mjs';
import { electronRuntime } from '../../scripts/electron-runtime.mjs';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';
const [lab, cache, helper] = process.argv.slice(2);
if (!lab || !cache || !helper) throw new Error('Explicit isolated lab, runtime cache and helper required');
const run = await mkdtemp(path.join(await isolatedRoot(lab), 'audit-ui-'));
const assets = path.join(run, 'assets'); await mkdir(assets);
await writeFile(path.join(assets, 'index.html'), `<!doctype html><html data-desktop-engine="electron"><head><meta charset="utf-8"><link rel="stylesheet" href="/chrome.css"></head><body>
<section data-tauri-drag-region><details><summary>Manual connection</summary><label for="host">Host address</label><input id="host"></details></section>
<a target="_blank" href="https://example.org/reference">Reference link</a><a href="file:///tmp/private">Forbidden local link</a>
<textarea aria-label="Draft"></textarea><script type="module" src="/probe.mjs"></script></body></html>`);
await writeFile(path.join(assets, 'chrome.css'), await readFile(new URL('../../src/desktop-window-chrome.css', import.meta.url)));
await writeFile(path.join(assets, 'probe.mjs'), `const draft=document.querySelector('textarea');draft.value=localStorage.getItem('draft')||'';draft.oninput=()=>localStorage.setItem('draft',draft.value);window.loaded=true;`);
const preload = await buildPreload(path.join(run, 'preload'));
const config = path.join(run, 'config.json'); await writeFile(config, JSON.stringify({ assets, preload, helper }));
let app; const checks = [];
try {
  app = await _electron.launch({ executablePath: await electronRuntime(cache), args: [fileURLToPath(new URL('./runtime-main.mjs', import.meta.url)), `--tarobot-acceptance=${config}`], env: helperEnvironment() });
  const page = await app.firstWindow(); await page.waitForFunction(() => window.loaded);
  await app.evaluate(({ shell }) => { globalThis.opened = []; shell.openExternal = async url => { globalThis.opened.push(url); }; });
  await page.getByRole('link', { name: 'Reference link' }).click();
  await assert.doesNotReject(async () => { for (let i = 0; i < 50; i++) { if ((await app.evaluate(() => globalThis.opened)).length) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('external link did not open'); });
  assert.deepEqual(await app.evaluate(() => globalThis.opened), ['https://example.org/reference']); checks.push('actual-anchor-click-opens-system-browser');
  await page.getByRole('link', { name: 'Forbidden local link' }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.opened), ['https://example.org/reference']); assert.equal(page.url(), 'tarobot://app/index.html');
  checks.push('local-navigation-and-popups-remain-denied');
  assert.equal(await page.locator('summary').evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')), 'no-drag');
  await page.locator('summary').click(); await page.locator('label').click();
  assert.equal(await page.locator('#host').evaluate(element => element === document.activeElement), true); checks.push('manual-pairing-summary-and-label-interactive');
  await page.getByLabel('Draft').fill('Saved draft survives renderer crash');
  const oldDocument = await page.evaluate(() => window.tarobotDesktop.invoke('net_document'));
  await page.evaluate(async () => { await new Promise((resolve, reject) => { const r = indexedDB.open('audit-outbox', 1); r.onupgradeneeded = () => r.result.createObjectStore('messages'); r.onerror = reject; r.onsuccess = () => { const tx = r.result.transaction('messages', 'readwrite'); tx.objectStore('messages').put({ clientMsgId: 'same-id', text: 'pending' }, 'one'); tx.oncomplete = () => { r.result.close(); resolve(); }; tx.onerror = reject; }; }); });
  const crashed = page.waitForEvent('crash');
  await app.evaluate(({ BrowserWindow }) => new Promise((resolve, reject) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const timer = setTimeout(() => reject(new Error('crash_recovery_timeout')), 15000);
    contents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    contents.forcefullyCrashRenderer();
  })); await crashed;
  // Playwright retains its crashed CDP target; inspect the recovered native
  // WebContents instead of asking that obsolete target to run JavaScript.
  const recovered = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(async()=>({
    loaded:window.loaded,draft:document.querySelector('textarea').value,
    document:await window.tarobotDesktop.invoke('net_document'),
    outbox:await new Promise((resolve,reject)=>{const r=indexedDB.open('audit-outbox');r.onerror=reject;r.onsuccess=()=>{const q=r.result.transaction('messages').objectStore('messages').getAll();q.onsuccess=()=>{r.result.close();resolve(q.result)};q.onerror=reject;};})
  }))()`));
  assert.equal(recovered.loaded, true);
  assert.equal(recovered.draft, 'Saved draft survives renderer crash'); assert.notEqual(recovered.document, oldDocument);
  assert.deepEqual(recovered.outbox, [{ clientMsgId: 'same-id', text: 'pending' }]);
  checks.push('actual-renderer-crash-auto-recovery', 'persisted-draft-and-outbox-retained-without-duplication', 'new-native-document-after-crash');
  await writeFile(path.join(run, 'verification.json'), JSON.stringify({ status: 'passed', checks, installedAppChanged: false, productionHostUsed: false }, null, 2));
  console.log(JSON.stringify({ run, checks }));
} finally { await app?.close(); }
