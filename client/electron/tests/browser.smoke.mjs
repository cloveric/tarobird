// Real Electron acceptance for workbench pages. Usage:
//   node electron/tests/browser.smoke.mjs <Electron binary below .noindex> <output dir below .noindex>
// Starts an isolated App window (real preload/NativeOwner/DesktopServices) and a
// local fixture server; never touches an installed App, its profile or a browser.
import { _electron } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedRoot } from '../isolation.mjs';

// Playwright auto-dismisses CDP JavaScript dialogs; Electron already resolves
// beforeunload through will-prevent-unload, so that dismissal finds no dialog.
process.on('unhandledRejection', error => { if (!String(error?.message).includes('handleJavaScriptDialog')) { console.error(error); process.exitCode = 1; } });
const [binary, output, phase = 'all'] = process.argv.slice(2);
if (!binary?.includes('.noindex/')) throw new Error('isolated Electron binary required');
const root = await isolatedRoot(output), client = fileURLToPath(new URL('../..', import.meta.url));
const assets = path.join(root, 'assets'), preload = path.join(root, 'preload.cjs'), config = path.join(root, 'acceptance.json');
await mkdir(assets, { recursive: true });
// App stand-in: a chat column with a composer, and the workbench region where
// native pages are laid out. app.js records input → next-frame latency.
await writeFile(path.join(assets, 'index.html'), `<!doctype html><meta charset="utf-8"><title>TaroBot</title>
<body style="margin:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;display:flex;height:100vh;background:#fff">
<main id="app" style="width:400px;padding:16px;box-sizing:border-box;border-right:1px solid #ddd;display:flex;flex-direction:column;gap:8px">
<h3 style="margin:0">对话（测试桩）</h3><div id="log" style="flex:1;overflow:auto;color:#333"></div>
<textarea id="draft" rows="3" placeholder="输入消息"></textarea><button id="send">发送</button></main>
<section id="workbench" style="flex:1;background:#f1f1f1;display:flex;align-items:center;justify-content:center;color:#999">工作台区域</section>
<script src="app.js"></script></body>`);
await writeFile(path.join(assets, 'app.js'), `window.__latency = [];
const frame = start => requestAnimationFrame(() => window.__latency.push({ kind: start.kind, input: start.handler - start.stamp, total: performance.now() - start.stamp }));
document.getElementById('send').addEventListener('click', event => { const start = { kind: 'click', stamp: event.timeStamp, handler: performance.now() };
  const item = document.createElement('p'); item.textContent = document.getElementById('draft').value || 'ping'; document.getElementById('log').append(item); frame(start); });
document.getElementById('draft').addEventListener('keydown', event => frame({ kind: 'key', stamp: event.timeStamp, handler: performance.now() }));
`);
await build({ entryPoints: [path.join(client, 'electron/preload.mjs')], outfile: preload, bundle: true, format: 'cjs', platform: 'node', target: 'node22', external: ['electron'], logLevel: 'silent' });
// Stand-in native helper (JSONL protocol 1) so helper loss/recovery is real.
const helper = path.join(root, 'fake-helper.mjs');
await writeFile(helper, `#!/usr/bin/env node
let buffer = '', documents = 0;
process.stdin.on('data', chunk => { buffer += chunk; for (let index; (index = buffer.indexOf('\\n')) >= 0;) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue;
  const { id, command } = JSON.parse(line); process.stdout.write(JSON.stringify({ id, result: command === 'helper_info' ? { protocol: 1 } : command === 'net_document' ? 'doc-' + (++documents) : null }) + '\\n'); } });
process.stdin.on('end', () => process.exit(0));
`);
await chmod(helper, 0o755);

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  const html = value => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(value); };
  if (url.pathname === '/form') return html(page('Workbench form', `<h1 id="title">Workbench form</h1><p id="status">idle</p>
    <label>Name <input id="name" name="name"></label> <label>Secret <input id="secret" type="password" autocomplete="current-password"></label>
    <label>Color <select id="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select></label>
    <textarea id="notes" aria-label="Notes"></textarea>
    <button id="go" onclick="document.getElementById('status').textContent='clicked:'+document.getElementById('name').value">Apply</button>
    <form action="/next" method="get"><input id="q" name="q" aria-label="Search"></form>
    <a id="newtab" href="/next?from=blank" target="_blank">New tab link</a>
    <button id="popup" onclick="window.__popup = window.open('/popup', 'login', 'width=480,height=600')">Login popup</button>
    <button id="guard" onclick="window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; }; document.getElementById('status').textContent = 'guarded'">Guard</button>
    <a id="download" href="/file.txt">Download file</a>
    <input id="file" type="file" aria-label="Attachment" onchange="this.files[0].text().then(text => document.getElementById('status').textContent = 'file:' + this.files[0].name + ':' + text)">
    <div style="height:2400px"></div><p id="bottom">Bottom of page</p>`));
  if (url.pathname === '/next') return html(page('Next', `<p id="query">${url.search.replace(/[<>&"]/g, '')}</p>`));
  if (url.pathname === '/popup') return html(page('Popup', '<p>popup</p>'));
  if (url.pathname === '/cookie-set') { response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=signed-in; Path=/; Max-Age=86400; SameSite=Lax' }); return response.end(page('Set', 'set')); }
  if (url.pathname === '/cookie-show') return html(page('Show', `<p id="cookie">cookie=${(request.headers.cookie ?? '').replace(/[<>&"]/g, '')}</p>`));
  if (url.pathname === '/heavy') return html(page(`Heavy ${url.searchParams.get('n') ?? ''}`, `<style>@keyframes spin{to{transform:rotate(360deg)}}.s{width:36px;height:36px;border:4px solid #36c;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite}</style>
    <h1>Heavy page ${url.searchParams.get('n') ?? ''}</h1><div class="s"></div><input id="q" aria-label="Query"><button>Go</button>
    <script>let frames = 0; (function tick() { frames++; requestAnimationFrame(tick); })(); window.__raf = () => { const value = frames; frames = 0; return value; };</script>
    ${Array.from({ length: 1500 }, (_, i) => `<p>Paragraph ${i} <a href="/next?i=${i}">link ${i}</a> lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>`).join('')}`));
  if (url.pathname === '/broken') { request.socket.destroy(); return; }
  if (url.pathname === '/slow') { setTimeout(() => html(page('Slow', '<p>slow page</p>')), 2500); return; }
  if (url.pathname === '/secret') { response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }); return response.end('SECRET'); }
  if (url.pathname === '/file.txt') { response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' }); return response.end('downloaded body'); }
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port, site = `http://site.test:${port}`, other = `http://other.test:${port}`;
await writeFile(config, JSON.stringify({ assets, preload, helper, secureOrigins: [site, other], lifecycle: phase === 'quit' }));
const A = { host: 'host-public-key-A', user: 'user-1', conversation: 'conv-A' }, B = { ...A, conversation: 'conv-B' };
const results = [];
let request = 0;
async function check(name, fn) {
  const started = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - started, ...(detail === undefined ? {} : { detail }) }); }
  catch (error) { results.push({ name, ok: false, ms: Date.now() - started, error: error?.stack?.split('\n').slice(0, 40).join(' | ').slice(0, 6000) ?? String(error) }); }
}
function expect(condition, message, detail) { if (!condition) throw new Error(`${message}${detail === undefined ? '' : ` ${JSON.stringify(detail).slice(0, 1500)}`}`); }

let firstScreen;
async function launch() {
  const launched = Date.now();
  const app = await _electron.launch({ executablePath: binary, args: [path.join(client, 'electron/tests/browser-runtime-main.mjs'), `--tarobot-browser-acceptance=${config}`],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
  const ui = await app.firstWindow();
  await ui.waitForFunction(() => window.tarobotDesktop?.engine === 'electron');
  firstScreen = Date.now() - launched;
  await app.evaluate(async () => { for (let i = 0; i < 100 && !globalThis.__acceptance.window; i++) await new Promise(resolve => setTimeout(resolve, 50)); });
  // Calls into the trusted App document go through main, so they keep working
  // after the App renderer is crashed and recovered by the real recovery path.
  const exec = code => app.evaluate((_electron, script) => globalThis.__acceptance.window.webContents.executeJavaScript(script), code);
  const listen = () => exec(`window.__events = []; window.tarobotDesktop.on('workbench-browser', event => window.__events.push(event)); 1`);
  await listen();
  const invoke = args => exec(`window.tarobotDesktop.invoke('workbench_browser', ${JSON.stringify(args)})`);
  const bot = args => invoke({ requestId: `req-${++request}`, ...args });
  let seq = 0;
  const layout = (views, extra = {}) => exec(`window.tarobotDesktop.invoke('workbench_browser_layout', ${JSON.stringify({ seq: ++seq, views, ...extra })})`);
  const events = () => exec('window.__events.splice(0)');
  const peek = () => exec('window.__events.slice()');
  const contentsOf = fragment => app.evaluate(({ webContents }, value) => webContents.getAllWebContents().find(item => !item.isDestroyed() && item.getURL().includes(value))?.id ?? null, fragment);
  const inPage = (id, code, gesture = false) => app.evaluate(({ webContents }, [value, script, user]) => webContents.fromId(value).executeJavaScript(script, user), [id, code, gesture]);
  const answers = values => app.evaluate((_electron, list) => { globalThis.__acceptance.dialogs.answers.push(...list); }, values);
  const dialogCalls = () => app.evaluate(() => globalThis.__acceptance.dialogs.calls.map(call => ({ ...call })));
  const views = () => app.evaluate(() => globalThis.__acceptance.window.contentView.children.map(view => ({ bounds: view.getBounds(), visible: view.getVisible(), url: view.webContents?.getURL?.() })));
  const element = (receipt, predicate) => receipt.observation.elements.find(predicate);
  return { app, ui, exec, listen, invoke, bot, layout, events, peek, contentsOf, inPage, views, element, answers, dialogCalls, resetLayout: () => { seq = 0; } };
}

const t = await launch();
const { app, ui, exec, listen, invoke, bot, layout, events, peek, contentsOf, inPage, views, element, answers, dialogCalls } = t;
  // Window-server capture needs Screen Recording permission, which this
  // harness does not have. Fall back to Electron's own capturePage() of the
  // App document and of each visible page, composed at their real bounds.
  const capture = async name => {
    const id = await app.evaluate(() => { const window = globalThis.__acceptance.window; window.show(); window.focus(); return window.getMediaSourceId(); });
    await delay(600);
    const file = path.join(root, `${name}.png`), windowId = /^window:(\d+):/.exec(id)?.[1];
    try { execFileSync('/usr/sbin/screencapture', ['-x', '-o', `-l${windowId}`, file], { timeout: 15000 }); return { file, method: 'screencapture -l (window server)' }; }
    catch (error) {
      const parts = await app.evaluate(async () => {
        const window = globalThis.__acceptance.window, app = await window.webContents.capturePage();
        const views = [];
        for (const view of window.contentView.children) if (view.getVisible()) views.push({ bounds: view.getBounds(), png: (await view.webContents.capturePage()).toPNG().toString('base64') });
        return { app: app.toPNG().toString('base64'), size: window.getContentBounds(), views };
      });
      const pieces = path.join(root, `${name}.parts`); await mkdir(pieces, { recursive: true });
      await writeFile(path.join(pieces, 'app.png'), Buffer.from(parts.app, 'base64'));
      const manifest = { size: parts.size, views: [] };
      for (const [index, view] of parts.views.entries()) { const piece = path.join(pieces, `view-${index}.png`); await writeFile(piece, Buffer.from(view.png, 'base64')); manifest.views.push({ file: piece, bounds: view.bounds }); }
      await writeFile(path.join(pieces, 'manifest.json'), JSON.stringify(manifest));
      execFileSync('python3', ['-I', '-c', `import json,sys
from PIL import Image
d=json.load(open(sys.argv[1])); base=Image.open(sys.argv[2]).convert('RGB'); s=base.width/d['size']['width']
for v in d['views']:
  b=v['bounds']; img=Image.open(v['file']).convert('RGB').resize((round(b['width']*s), round(b['height']*s))); base.paste(img,(round(b['x']*s), round(b['y']*s)))
base.save(sys.argv[3])`, path.join(pieces, 'manifest.json'), path.join(pieces, 'app.png'), file]);
      return { file, method: 'composite of Electron capturePage() (App document + each visible page at its native bounds)', screencapture: String(error.message).split('\n')[1] ?? 'failed' };
    }
  };
let form, snapshotRefs;
try {
  if (phase === 'personal') {
    const personal = { host: 'tarobot-personal-browser-v1', user: 'local', conversation: 'personal' };
    const user = (action, fields = {}) => invoke({ scope: personal, source: 'user', action, ...fields });
    let personalContents;
    const dock = { tab: 'personal', x: 400, y: 64, width: 600, height: 700 };
    await check('personal page has a separate scope and rejects Bot reads and synthetic input', async () => {
      expect((await user('open', { tab: 'personal', url: `${site}/form?personal=1` })).status === 'ok', 'open');
      await layout([dock]); await delay(200);
      personalContents = await contentsOf('/form?personal=1'); expect(!!personalContents, 'real page exists');
      const denied = await bot({ scope: personal, action: 'observe', tab: 'personal' }).catch(error => ({status:'failed',error:String(error.message)}));
      expect(denied.status !== 'ok', 'Bot observe refused', denied);
      expect((await user('observe', { tab: 'personal' }).catch(() => ({status:'failed'}))).status !== 'ok', 'even user source cannot request page DOM');
      expect((await bot({ scope: A, action: 'list' })).tabs.length === 0, 'conversation cannot list personal tabs');
      // Fixture-only direct DOM setup, not the production browser command API.
      await inPage(personalContents, `document.querySelector('#name').value = 'retained personal draft'; 1`);
      return { pageId: personalContents, denied: denied.error };
    });
    await check('hiding the personal dock retains its real page and form state', async () => {
      await layout([]); expect(!(await views()).some(view => view.visible && view.url?.includes('personal=1')), 'hidden');
      await layout([dock]); await delay(100);
      expect(await contentsOf('/form?personal=1') === personalContents, 'same WebContents after restore');
      expect(await inPage(personalContents, `document.querySelector('#name').value`) === 'retained personal draft', 'draft retained');
    });
    await check('failed navigation retains a reachable personal page which can be closed', async () => {
      const failed = await user('open', {tab:'failed-personal',url:`${site}/broken`});
      expect(failed.status !== 'ok' && failed.state === 'live', 'native failed-but-live receipt', failed);
      expect((await user('list')).tabs.some(tab => tab.tab === 'failed-personal'), 'failed record listed');
      expect((await user('close',{tab:'failed-personal'})).status === 'ok', 'failed page closes');
      expect((await user('list')).tabs.length === 1, 'no orphan remains');
      return {status:failed.status,error:failed.error,state:failed.state};
    });
    await check('four workbench pages and one personal page can display and close independently', async () => {
      const split = [{ ...dock, width: 140 }];
      for (let i = 0; i < 4; i++) {
        const tab = `work${i}`;
        const receipt = await invoke({ scope: A, source: 'user', action: 'open', tab, url: `${site}/next?pane=${i}` });
        expect(receipt.status === 'ok', 'open workbench', receipt);
        split.push({ tab, x: 540 + i * 140, y: 64, width: 140, height: 700 });
      }
      await layout(split); await delay(150);
      const visible = (await views()).filter(view => view.visible && view.url?.startsWith(site));
      expect(visible.length === 5, 'five native views', visible);
      expect((await user('close', { tab: 'personal' })).status === 'ok', 'close personal');
      expect((await bot({ scope: A, action: 'list' })).tabs.length === 4, 'conversation pages preserved');
      return { visible: visible.length };
    });
  } else if (phase === 'fsedges2') {
    // Real event order: window fullscreen vs page HTML fullscreen, with the
    // window's isFullScreen() at each moment, recorded in main.
    await app.evaluate(() => {
      const window = globalThis.__acceptance.window, log = globalThis.__fsLog = [];
      const record = (source, name) => log.push({ source, name, windowFullScreen: window.isFullScreen(), at: Date.now() });
      for (const name of ['enter-full-screen', 'leave-full-screen', 'enter-html-full-screen', 'leave-html-full-screen']) window.on(name, () => record('window', name));
      globalThis.__watchPage = id => { const contents = require('electron').webContents.fromId(id); for (const name of ['enter-html-full-screen', 'leave-html-full-screen', 'destroyed']) contents.on(name, () => record(`page:${id}`, name)); };
    }).catch(() => {});
    await app.evaluate(({ webContents }) => {
      const window = globalThis.__acceptance.window, log = globalThis.__fsLog;
      const record = (source, name) => log.push({ source, name, windowFullScreen: window.isFullScreen(), at: Date.now() });
      globalThis.__watchPage = id => { const contents = webContents.fromId(id); for (const name of ['enter-html-full-screen', 'leave-html-full-screen', 'destroyed']) contents.on(name, () => record(`page:${id}`, name)); };
    });
    const split = [{ tab: 'g1', x: 420, y: 64, width: 360, height: 600 }, { tab: 'g2', x: 790, y: 64, width: 360, height: 600 }];
    const state = () => app.evaluate(() => { const window = globalThis.__acceptance.window, browser = [...globalThis.__acceptance.owners.values()][0].services.browser;
      return { windowFullScreen: window.isFullScreen(), views: window.contentView.children.filter(view => view.getVisible()).map(view => view.getBounds()), stats: browser.stats() }; });
    const log = async () => { const value = await app.evaluate(() => globalThis.__fsLog.splice(0)); const start = value[0]?.at ?? 0; return value.map(item => `${item.source}:${item.name}:fs=${item.windowFullScreen}:+${item.at - start}ms`); };
    const watch = id => app.evaluate((_electron, value) => globalThis.__watchPage(value), id);
    const fullscreen = (id, on = true) => inPage(id, on ? `document.documentElement.requestFullscreen().then(() => 'ok', error => 'error:' + error.name)` : `document.exitFullscreen().then(() => 'ok', error => 'error:' + error.name)`, true);
    const userFullScreen = async value => { await app.evaluate((_electron, on) => globalThis.__acceptance.window.setFullScreen(on), value); await delay(2500); };
    await bot({ action: 'open', scope: A, tab: 'g1', url: `${site}/form` });
    await bot({ action: 'open', scope: A, tab: 'g2', url: `${site}/next?other=1` });
    await layout(split); await delay(300);
    await check('page closes itself (window.close) while fullscreen', async () => {
      await events(); await log();
      const seen = await bot({ action: 'observe', scope: A, tab: 'g1' });
      await bot({ action: 'click', scope: A, tab: 'g1', ref: element(seen, item => item.name === 'New tab link').ref });
      let opened; for (let i = 0; i < 40 && !opened; i++) { opened = (await peek()).find(event => event.kind === 'opened'); if (!opened) await delay(100); }
      expect(opened, 'opened tab');
      await layout([split[0], { ...split[1], tab: opened.tab }]); await delay(800);
      const id = await contentsOf('/next?from=blank'); await watch(id);
      const entered = await fullscreen(id); await delay(2500);
      const during = await state();
      const closed = await inPage(id, `window.close(), 'requested'`).catch(error => `error:${error.message}`);
      await delay(3000);
      const after = await state(), order = await log(), emitted = (await peek()).filter(event => ['fullscreen', 'closed'].includes(event.kind) && event.tab === opened.tab).map(event => `${event.kind}:${event.enabled ?? event.reason}`);
      await layout(split); await delay(300);
      const result = { entered, closed, during: { windowFullScreen: during.windowFullScreen, ownsWindow: during.stats.fullscreenOwnsWindow }, after: { windowFullScreen: after.windowFullScreen, fullscreen: after.stats.fullscreen, views: after.views }, order, emitted, ok: !after.windowFullScreen && after.stats.fullscreen === null && emitted.includes('fullscreen:false') };
      expect(result.ok, 'edge not released correctly', result); return result;
    });
    await check('user window fullscreen first, then page fullscreen and page exit: the user choice stays', async () => {
      await events(); await log();
      const id = await contentsOf(`${site}/form`); await watch(id);
      await userFullScreen(true);
      await layout(split); await delay(300);
      const entered = await fullscreen(id); await delay(2500);
      const during = await state();
      const exited = await fullscreen(id, false); await delay(2500);
      await layout(split); await delay(300);
      const after = await state(), order = await log(), emitted = (await peek()).filter(event => event.kind === 'fullscreen').map(event => event.enabled);
      const result = { entered, exited, during: { windowFullScreen: during.windowFullScreen, ownsWindow: during.stats.fullscreenOwnsWindow, views: during.views }, after: { windowFullScreen: after.windowFullScreen, fullscreen: after.stats.fullscreen, views: after.views }, order, emitted, ok: after.windowFullScreen === true && after.stats.fullscreen === null && after.views.length === 2 };
      expect(result.ok, 'edge not released correctly', result); return result;
    });
    await check('user window fullscreen first, then page fullscreen and the user closes that tab: the user choice stays', async () => {
      await events(); await log();
      const id = await contentsOf(`${site}/form`); await watch(id);
      const entered = await fullscreen(id); await delay(2500);
      const during = await state();
      await invoke({ action: 'close', scope: A, tab: 'g1', source: 'user' }); await delay(2500);
      await layout([split[1]]); await delay(300);
      const after = await state(), order = await log(), emitted = (await peek()).filter(event => ['fullscreen', 'closed'].includes(event.kind)).map(event => `${event.kind}:${event.enabled ?? event.reason}`);
      await userFullScreen(false);
      const result = { entered, during: { windowFullScreen: during.windowFullScreen, ownsWindow: during.stats.fullscreenOwnsWindow }, after: { windowFullScreen: after.windowFullScreen, fullscreen: after.stats.fullscreen, views: after.views }, order, emitted, ok: after.windowFullScreen === true && after.stats.fullscreen === null };
      expect(result.ok, 'edge not released correctly', result); return result;
    });
    await check('fullscreen page that cannot answer (hung renderer) is closed by the person: window and UI state are released', async () => {
      await bot({ action: 'open', scope: A, tab: 'g1', url: `${site}/form` }).catch(() => {});
      await layout(split); await delay(500); await events(); await log();
      const id = await contentsOf(`${site}/form`); await watch(id);
      const entered = await fullscreen(id); await delay(2500);
      const during = await state();
      await inPage(id, `setTimeout(() => { const end = Date.now() + 25000; while (Date.now() < end) {} }, 50), 'hung'`);
      await delay(300);
      const started = Date.now(), closed = await invoke({ action: 'close', scope: A, tab: 'g1', source: 'user' });
      const closeMs = Date.now() - started;
      await delay(1500);
      await layout([split[1]]); await delay(300);
      const after = await state(), order = await log(), emitted = (await peek()).filter(event => ['fullscreen', 'closed', 'gone'].includes(event.kind)).map(event => `${event.kind}:${event.enabled ?? event.reason}`);
      const result = { entered, closed: closed.status, closeMs, during: { windowFullScreen: during.windowFullScreen, ownsWindow: during.stats.fullscreenOwnsWindow }, after: { windowFullScreen: after.windowFullScreen, fullscreen: after.stats.fullscreen, views: after.views }, order, emitted, ok: !after.windowFullScreen && after.stats.fullscreen === null && emitted.includes('fullscreen:false') };
      expect(result.ok, 'edge not released correctly', result); return result;
    });
  } else if (phase === 'fsedges') {
    // HTML fullscreen, then each way a page or the App document can go away.
    const split = [{ tab: 'f1', x: 420, y: 64, width: 360, height: 600 }, { tab: 'f2', x: 790, y: 64, width: 360, height: 600 }];
    const state = () => app.evaluate(() => { const window = globalThis.__acceptance.window, browser = [...globalThis.__acceptance.owners.values()][0].services.browser;
      return { windowFullScreen: window.isFullScreen(), content: window.getContentBounds(), views: window.contentView.children.map(view => ({ url: view.webContents.isDestroyed() ? 'destroyed' : view.webContents.getURL().replace(/^http:\/\/[^/]+/, ''), visible: view.getVisible(), bounds: view.getBounds() })), fullscreenTab: browser.stats().fullscreen }; });
    const enter = async () => {
      await bot({ action: 'navigate', scope: A, tab: 'f1', url: `${site}/form` }).catch(() => {});
      await layout(split); await delay(300);
      const id = await contentsOf(`${site}/form`);
      const entered = await inPage(id, `document.documentElement.requestFullscreen().then(() => 'ok', error => 'error:' + error.name)`, true);
      await delay(2500);
      return { id, entered, during: await state() };
    };
    const settled = async () => { await delay(3000); return state(); };
    const restored = value => !value.windowFullScreen && value.fullscreenTab === null;
    const cases = {
      crash: async ({ id }) => { await app.evaluate(({ webContents }, value) => webContents.fromId(value).forcefullyCrashRenderer(), id); },
      navigate: async () => { await invoke({ action: 'navigate', scope: A, tab: 'f1', url: `${site}/next?fs=1`, source: 'user' }); },
      reload: async () => { await invoke({ action: 'reload', scope: A, tab: 'f1', source: 'user' }); },
      close: async () => { await invoke({ action: 'close', scope: A, tab: 'f1', source: 'user' }); },
      sleep: async () => { await invoke({ action: 'sleep', scope: A, tab: 'f1', source: 'user' }); },
      retire: async () => { await app.evaluate(() => globalThis.__acceptance.window.webContents.reload()); },
    };
    await bot({ action: 'open', scope: A, tab: 'f1', url: `${site}/form` });
    await bot({ action: 'open', scope: A, tab: 'f2', url: `${site}/next?other=1` });
    for (const [name, act] of Object.entries(cases)) {
      await check(`fullscreen then ${name}: window leaves fullscreen and the split layout returns`, async () => {
        // Every case starts from a live, freshly loaded f1.
        const listed = (await invoke({ action: 'list', scope: A })).tabs.find(tab => tab.tab === 'f1');
        if (!listed) await invoke({ action: 'open', scope: A, tab: 'f1', url: `${site}/form`, source: 'user' });
        else if (listed.state !== 'live') await invoke({ action: 'wake', scope: A, tab: 'f1', source: 'user' });
        else await invoke({ action: 'reload', scope: A, tab: 'f1', source: 'user' });
        const start = await enter();
        expect(start.entered === 'ok' && start.during.windowFullScreen && start.during.fullscreenTab === 'f1', 'did not enter fullscreen', start);
        await events();
        await act(start);
        let after = await settled();
        if (name === 'retire') {
          for (let i = 0; i < 50; i++) { try { if (await exec('!!window.tarobotDesktop && document.readyState === "complete"')) break; } catch { /* reloading */ } await delay(200); }
          await listen(); t.resetLayout(); await layout(split); await delay(500); after = await state();
        } else await layout(split).then(() => delay(300)).then(async () => { after = await state(); });
        const seen = (await peek()).filter(event => ['fullscreen', 'gone', 'closed', 'state'].includes(event.kind)).map(event => `${event.kind}:${event.enabled ?? event.reason ?? event.state ?? ''}`);
        const expected = name === 'close' ? 1 : 2;
        const visible = after.views.filter(view => view.visible);
        expect(restored(after) && visible.length === expected && visible.every(view => view.bounds.width === 360 && view.bounds.height === 600), 'not restored', { after, seen });
        return { after: { windowFullScreen: after.windowFullScreen, fullscreenTab: after.fullscreenTab, visible: visible.map(view => view.bounds) }, events: seen.slice(0, 8) };
      });
      // Leave a clean state for the next case even if this one failed.
      await app.evaluate(() => { const window = globalThis.__acceptance.window; if (window.isFullScreen()) window.setFullScreen(false); });
      await delay(1500);
    }
  } else if (phase === 'events') {
    const show = tabs => layout(tabs.map((tab, index) => ({ tab, x: 420 + index * 360, y: 64, width: 350, height: 600 })));
    const wait = async (test, ms = 4000) => { for (const end = Date.now() + ms; Date.now() < end; await delay(100)) { const found = (await peek()).filter(test); if (found.length) return found; } return []; };
    await check('resume is user-only end to end: Bot refused, person resumes, Bot acts again after a fresh observe', async () => {
      await bot({ action: 'open', scope: A, tab: 'e1', url: `${site}/form` }); await show(['e1']);
      const first = await bot({ action: 'observe', scope: A, tab: 'e1' });
      await invoke({ action: 'takeover', scope: A, tab: 'e1', source: 'user' });
      let refused; try { await bot({ action: 'resume', scope: A, tab: 'e1' }); } catch (error) { refused = String(error.message); }
      expect(/browser_user_action_required/.test(refused ?? ''), 'Bot resume must be refused', refused);
      const paused = await bot({ action: 'click', scope: A, tab: 'e1', ref: element(first, item => item.name === 'Apply').ref });
      expect(paused.status === 'paused' && paused.error === 'user_control', 'still under takeover', paused);
      const resumed = await invoke({ action: 'resume', scope: A, tab: 'e1', source: 'user' });
      expect(resumed.status === 'ok' && resumed.control === 'bot', 'person resume', resumed);
      const fresh = await bot({ action: 'observe', scope: A, tab: 'e1' });
      const clicked = await bot({ action: 'click', scope: A, tab: 'e1', ref: element(fresh, item => item.name === 'Apply').ref });
      expect(clicked.status === 'ok' && clicked.evidence.delivered, 'Bot control after resume', clicked);
      return { refused, clicked: clicked.evidence.delivered };
    });
    await check('popup and opened events: real payloads', async () => {
      await events();
      const seen = await bot({ action: 'observe', scope: A, tab: 'e1' });
      await bot({ action: 'click', scope: A, tab: 'e1', ref: element(seen, item => item.name === 'Login popup').ref });
      const opened = await wait(event => event.kind === 'popup' && event.state === 'opened');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window !== globalThis.__acceptance.window)?.close());
      const closed = await wait(event => event.kind === 'popup' && event.state === 'closed');
      await bot({ action: 'click', scope: A, tab: 'e1', ref: element(seen, item => item.name === 'New tab link').ref });
      const tab = await wait(event => event.kind === 'opened');
      expect(opened.length && closed.length && tab.length, 'events', { opened, closed, tab });
      return { popupOpened: opened[0], popupClosed: closed[0], opened: tab[0] };
    });
    await check('tab-request: a new-tab request over the live limit is refused with an event, not silently dropped', async () => {
      await app.evaluate(() => { const browser = [...globalThis.__acceptance.owners.values()][0].services.browser; browser.limits = { ...browser.limits, liveTabs: 2 }; });
      await events();
      const seen = await bot({ action: 'observe', scope: A, tab: 'e1' });
      await bot({ action: 'click', scope: A, tab: 'e1', ref: element(seen, item => item.name === 'New tab link').ref });
      const request = await wait(event => event.kind === 'tab-request'), blocked = await wait(event => event.kind === 'blocked' && event.reason === 'live_limit');
      expect(request.length && blocked.length, 'tab-request', { request, blocked });
      await app.evaluate(() => { const browser = [...globalThis.__acceptance.owners.values()][0].services.browser; browser.limits = { ...browser.limits, liveTabs: 6 }; });
      return { tabRequest: request[0], blocked: blocked[0] };
    });
    await check('HTML fullscreen from a page: what the native view and window actually do', async () => {
      await show(['e1']); await events();
      const id = await contentsOf('/form');
      const before = await app.evaluate(() => { const window = globalThis.__acceptance.window; return { window: window.isFullScreen(), content: window.getContentBounds(), view: window.contentView.children.filter(view => view.getVisible()).map(view => view.getBounds()) }; });
      const entered = await inPage(id, `document.documentElement.requestFullscreen().then(() => 'ok', error => 'error:' + error.name)`, true);
      await delay(2500);
      const during = await app.evaluate(() => { const window = globalThis.__acceptance.window; return { window: window.isFullScreen(), content: window.getContentBounds(), view: window.contentView.children.filter(view => view.getVisible()).map(view => view.getBounds()) }; });
      const page = await inPage(id, `({ element: !!document.fullscreenElement, width: innerWidth, height: innerHeight })`);
      await capture('events-fullscreen');
      await inPage(id, `document.exitFullscreen().then(() => 'ok', error => 'error:' + error.name)`, true);
      await delay(2500);
      const after = await app.evaluate(() => { const window = globalThis.__acceptance.window; return { window: window.isFullScreen(), content: window.getContentBounds(), view: window.contentView.children.filter(view => view.getVisible()).map(view => view.getBounds()) }; });
      const fullscreenEvents = (await peek()).filter(event => event.kind === 'fullscreen');
      const fills = during.window && during.view.length === 1 && during.view[0].width === during.content.width && during.view[0].height === during.content.height && page.width === during.content.width;
      expect(entered === 'ok' && fills, 'fullscreen page must fill the window', { during, page });
      expect(!after.window && JSON.stringify(after.view) === JSON.stringify(before.view), 'split layout restored after exit', { before, after });
      expect(fullscreenEvents.map(event => event.enabled).join() === 'true,false', 'fullscreen events', fullscreenEvents);
      return { entered, before, during, page, after, fullscreenEvents };
    });
  } else if (phase === 'baseline') {
    // Whole App process tree (main, GPU, network, App renderer, page renderers):
    // RSS and CPU time from ps, cross-checked with app.getAppMetrics().
    const mainPid = app.process().pid;
    const tree = () => {
      const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time=']).toString().trim().split('\n').map(line => line.trim().split(/\s+/));
      const children = new Map(); const info = new Map();
      for (const [pid, ppid, rss, time] of rows) {
        const parts = time.replace('-', ':').split(':').map(Number); let seconds = 0; for (const part of parts) seconds = seconds * 60 + part;
        if (time.includes('-')) seconds += 0; info.set(Number(pid), { rss: Number(rss), cpu: seconds });
        (children.get(Number(ppid)) ?? children.set(Number(ppid), []).get(Number(ppid))).push(Number(pid));
      }
      const pids = [mainPid]; for (let i = 0; i < pids.length; i++) pids.push(...(children.get(pids[i]) ?? []));
      return new Map(pids.filter(pid => info.has(pid)).map(pid => [pid, info.get(pid)]));
    };
    const percentile = (values, q) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10) / 10; };
    const appLatency = async () => {
      await exec('window.__latency = []; 1');
      for (let i = 0; i < 15; i++) { await ui.click('#send'); await delay(80); }
      await ui.focus('#draft'); await ui.keyboard.type('workbench1', { delay: 80 });
      const values = await exec('window.__latency');
      const of = kind => values.filter(value => value.kind === kind).map(value => value.total);
      return { clickP50: percentile(of('click'), 0.5), clickP95: percentile(of('click'), 0.95), keyP50: percentile(of('key'), 0.5), keyP95: percentile(of('key'), 0.95), samples: values.length };
    };
    const pageIds = async () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(item => !item.isDestroyed() && item.getURL().includes('/heavy')).map(item => item.id));
    const measure = async (label, visibleTabs, { latency: measureLatency = true } = {}) => {
      await delay(3000);
      const ids = await pageIds();
      for (const id of ids) await inPage(id, 'window.__raf && window.__raf(), 1');
      const before = tree(); await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics()); const started = Date.now();
      await delay(5000);
      const after = tree(), wall = (Date.now() - started) / 1000;
      const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map(item => ({ type: item.type, pid: item.pid, cpu: item.cpu.percentCPUUsage, workingSetKB: item.memory.workingSetSize })));
      let cpu = 0; for (const [pid, value] of after) cpu += value.cpu - (before.get(pid)?.cpu ?? 0);
      const raf = [];
      for (const id of ids) raf.push(await inPage(id, `({ fps: Math.round((window.__raf ? window.__raf() : 0) / ${wall}), state: document.visibilityState })`));
      const observe = [];
      for (const tab of visibleTabs) { const t0 = Date.now(); await bot({ action: 'observe', scope: A, tab }); observe.push(Date.now() - t0); }
      const latency = measureLatency ? await appLatency() : 'not measured while the window is hidden';
      return { label, processes: after.size, rssMB: Math.round([...after.values()].reduce((sum, value) => sum + value.rss, 0) / 1024),
        cpuPercentOfOneCore: Math.round(cpu / wall * 1000) / 10, appMetrics: { processes: metrics.length, workingSetMB: Math.round(metrics.reduce((sum, item) => sum + item.workingSetKB, 0) / 1024),
          cpuPercent: Math.round(metrics.reduce((sum, item) => sum + item.cpu, 0) * 10) / 10, byType: Object.fromEntries([...new Set(metrics.map(item => item.type))].map(type => [type, metrics.filter(item => item.type === type).length])) },
        pages: raf, botObserveMs: observe, app: latency };
    };
    const rects = [{ x: 400, y: 0, width: 400, height: 410 }, { x: 800, y: 0, width: 400, height: 410 }, { x: 400, y: 410, width: 400, height: 410 }, { x: 800, y: 410, width: 400, height: 410 }];
    const shots = [];
    await check('baseline: same-window throttling settings', async () => {
      const prefs = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(item => ({ url: item.getURL().slice(0, 40), backgroundThrottling: item.getBackgroundThrottling() })));
      expect(prefs.find(item => item.url.startsWith('tarobot://app'))?.backgroundThrottling === false, 'chat window must keep backgroundThrottling:false', prefs);
      return { prefs, firstScreenMs: firstScreen };
    });
    await check('baseline: process tree, CPU, App input latency and page timing for 0/1/2/4 pages, hidden and slept', async () => {
      const samples = [await measure('0 pages (chat only)', [])];
      shots.push(await capture('baseline-0-pages'));
      const opened = [];
      for (const [count, tabs] of [[1, ['h1']], [2, ['h1', 'h2']], [4, ['h1', 'h2', 'h3', 'h4']]]) {
        for (const tab of tabs) if (!opened.includes(tab)) {
          const t0 = Date.now(), receipt = await bot({ action: 'open', scope: A, tab, url: `${site}/heavy?n=${tab}` });
          expect(receipt.status === 'ok', 'open', receipt); opened.push(tab);
          await layout(tabs.slice(0, opened.length).map((name, index) => ({ tab: name, ...rects[index] })));
          await delay(400);
          const timing = await inPage(await app.evaluate(({ webContents }, name) => webContents.getAllWebContents().find(item => item.getURL().endsWith(`n=${name}`)).id, tab),
            `(() => { const nav = performance.getEntriesByType('navigation')[0], fcp = performance.getEntriesByName('first-contentful-paint')[0]; return { dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), fcp: fcp ? Math.round(fcp.startTime) : null }; })()`);
          samples.push({ label: `open ${tab}`, openReceiptMs: Date.now() - t0, timing });
        }
        await layout(tabs.map((tab, index) => ({ tab, ...rects[index] })));
        samples.push(await measure(`${count} visible`, tabs));
        shots.push(await capture(`baseline-${count}-visible`));
      }
      await layout([]);
      samples.push(await measure('4 live, none visible (switched away)', []));
      await app.evaluate(() => globalThis.__acceptance.window.hide());
      samples.push(await measure('4 live, window hidden to tray', [], { latency: false }));
      await app.evaluate(() => { const window = globalThis.__acceptance.window; window.show(); });
      for (const tab of ['h1', 'h2', 'h3', 'h4']) await invoke({ action: 'sleep', scope: A, tab, source: 'user' });
      samples.push(await measure('4 slept', []));
      return samples;
    });
    await check('close/reopen and sleep/wake cycles release webContents, views, routes and listeners', async () => {
      const probe = () => app.evaluate(({ webContents, session }) => {
        const window = globalThis.__acceptance.window, owner = [...globalThis.__acceptance.owners.values()][0];
        const pages = webContents.getAllWebContents().filter(item => !item.isDestroyed() && !item.getURL().startsWith('tarobot://'));
        const sessions = [...new Set(pages.map(item => item.session))];
        return { contents: webContents.getAllWebContents().filter(item => !item.isDestroyed()).length, children: window.contentView.children.length, stats: owner.services.browser.stats(),
          windowListeners: ['hide', 'minimize', 'resize', 'focus'].map(name => window.listenerCount(name)), appListeners: window.webContents.listenerCount('did-navigate') };
      });
      for (const tab of ['h1', 'h2', 'h3', 'h4']) await invoke({ action: 'close', scope: A, tab, source: 'user' });
      const before = await probe(), rssBefore = [...tree().values()].reduce((sum, value) => sum + value.rss, 0);
      for (let i = 0; i < 10; i++) {
        const opened = await bot({ action: 'open', scope: A, tab: 'cycle', url: `${site}/heavy?n=cycle${i}` });
        expect(opened.status === 'ok', 'cycle open', opened);
        await layout([{ tab: 'cycle', ...rects[0] }]);
        expect((await bot({ action: 'observe', scope: A, tab: 'cycle' })).status === 'ok', 'cycle observe');
        await layout([]);
        if (i % 2) { expect((await invoke({ action: 'sleep', scope: A, tab: 'cycle', source: 'user' })).status === 'ok', 'cycle sleep'); expect((await invoke({ action: 'wake', scope: A, tab: 'cycle', source: 'user' })).status === 'ok', 'cycle wake'); }
        expect((await invoke({ action: 'close', scope: A, tab: 'cycle', source: 'user' })).status === 'ok', 'cycle close');
      }
      await delay(1500);
      const after = await probe(), rssAfter = [...tree().values()].reduce((sum, value) => sum + value.rss, 0);
      expect(after.contents === before.contents && after.children === before.children && after.stats.tabs === before.stats.tabs && after.stats.live === before.stats.live && after.stats.routes === before.stats.routes
        && JSON.stringify(after.windowListeners) === JSON.stringify(before.windowListeners) && after.appListeners === before.appListeners && after.stats.tasks === 0, 'leaked state after cycles', { before, after });
      return { before, after, rssDriftMB: Math.round((rssAfter - rssBefore) / 1024) };
    });
    await check('real window screenshots', async () => {
      const ok = shots.filter(shot => shot.file);
      expect(shots.length === 4 && ok.length === shots.length, 'screenshots missing', shots);
      return shots;
    });
  } else if (phase === 'quit') {
    // Real lifecycle: Cmd+Q / tray Quit both go through app.quit() and before-quit.
    const alive = async () => { try { return await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(item => !item.isDestroyed()).map(item => item.getURL())); } catch { return null; } };
    const dirty = async () => {
      await bot({ action: 'open', scope: A, tab: 'q1', url: `${site}/next?clean` });
      await bot({ action: 'open', scope: A, tab: 'q2', url: `${site}/form` });
      await layout([{ tab: 'q1', x: 420, y: 64, width: 360, height: 600 }, { tab: 'q2', x: 790, y: 64, width: 360, height: 600 }]);
      const form = await bot({ action: 'observe', scope: A, tab: 'q2' });
      await bot({ action: 'click', scope: A, tab: 'q2', ref: element(form, item => item.name === 'Guard').ref });
      await bot({ action: 'type', scope: A, tab: 'q2', ref: element(form, item => item.name.startsWith('Name')).ref, text: 'unsent draft' });
    };
    await check('quit: a page with unsaved input is asked about first; keeping it cancels quit and closes nothing', async () => {
      await dirty();
      const before = await alive(), start = (await dialogCalls()).length;
      await answers([0]);
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
      await delay(2500);
      const after = await alive(), asked = (await dialogCalls()).slice(start);
      expect(after && after.length === before.length && after.every(url => before.includes(url)), 'pages after a cancelled quit', { before, after });
      expect(asked.length === 1 && asked[0].detail.includes('Workbench form') && !asked[0].detail.includes('Next'), 'one question naming only the unsaved page', asked);
      const draft = await inPage(await contentsOf('/form'), `document.getElementById('name').value`);
      expect(draft === 'unsent draft', 'draft', draft);
      const work = await bot({ action: 'observe', scope: A, tab: 'q1' });
      expect(work.status === 'ok', 'Bot work after cancelled quit', work);
      return { pages: after.length, question: asked[0].message };
    });
    await check('quit: the App\'s own unsaved-work prompt can still cancel after pages agreed; pages stay intact', async () => {
      await ui.click('#app');
      await ui.evaluate(() => { window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; }; });
      const before = await alive(), start = (await dialogCalls()).length;
      await answers([1, 0]);
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
      await delay(2500);
      const after = await alive(), asked = (await dialogCalls()).slice(start);
      expect(after && after.length === before.length, 'pages lost when the App cancelled quitting', { before, after, asked });
      expect(asked.length === 2 && asked[1].kind === 'sync', 'page question then App question', asked);
      const draft = await inPage(await contentsOf('/form'), `document.getElementById('name').value`);
      const work = await bot({ action: 'observe', scope: A, tab: 'q2' });
      expect(draft === 'unsent draft' && work.status === 'ok', 'state after App cancel', { draft, work: work.status });
      return asked.map(call => call.message);
    });
    await check('quit: confirming exits the App process', async () => {
      await ui.evaluate(() => { window.onbeforeunload = null; });
      const exited = new Promise(resolve => app.process().once('exit', code => resolve(code)));
      await answers([1]);
      await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
      const code = await Promise.race([exited, delay(15000).then(() => 'timeout')]);
      expect(code !== 'timeout', 'App did not exit after confirmation');
      return { code };
    });
  } else if (phase === 'thirdparty') {
    // Real third-party sites over the network; failures are reported, not skipped.
    const show = tab => layout([{ tab, x: 420, y: 64, width: 900, height: 700 }]);
    const settle = async (tab, test) => { for (let i = 0; i < 80; i++) { const state = (await invoke({ action: 'list', scope: A })).tabs.find(item => item.tab === tab); if (state && !state.loading && test(state.url)) return state; await delay(250); } throw new Error(`page did not settle for ${tab}`); };
    await check('third-party: example.com read, screenshot and real link navigation', async () => {
      const opened = await bot({ action: 'open', scope: A, tab: 'x1', url: 'https://example.com/' });
      expect(opened.status === 'ok', 'open example.com', opened);
      await show('x1');
      // The link sits below the multilingual text; a page-mode read lists it and
      // the click scrolls it into view before hit-testing.
      const seen = await bot({ action: 'observe', scope: A, tab: 'x1', mode: 'page' });
      expect(seen.title === 'Example Domain' && seen.observation.text.length > 20, 'read', { title: seen.title, text: seen.observation.text.slice(0, 200) });
      const shot = await bot({ action: 'screenshot', scope: A, tab: 'x1' });
      expect(shot.status === 'ok' && shot.image.mime === 'image/png', 'screenshot', { ...shot, image: undefined });
      await writeFile(path.join(root, 'example-com.png'), Buffer.from(shot.image.data, 'base64'));
      const link = seen.observation.elements.find(item => item.role === 'link');
      const clicked = await bot({ action: 'click', scope: A, tab: 'x1', ref: link.ref });
      expect(clicked.status === 'ok' && clicked.evidence.navigationStarted, 'click link', clicked);
      const state = await settle('x1', url => !url.startsWith('https://example.com'));
      return { link: link.name, landed: state.url };
    });
    await check('third-party: Wikipedia search via type and Enter in the same tab', async () => {
      const opened = await bot({ action: 'open', scope: A, tab: 'x2', url: 'https://en.wikipedia.org/wiki/Main_Page' });
      expect(opened.status === 'ok', 'open wikipedia', opened);
      await show('x2');
      let seen = await bot({ action: 'observe', scope: A, tab: 'x2', maxElements: 300 });
      const field = () => seen.observation.elements.find(item => ['searchbox', 'combobox', 'textbox'].includes(item.role) && /search/i.test(item.name));
      // At narrow widths the skin collapses search behind a link; open it first,
      // then observe again, as a Bot step would.
      if (!field()) {
        const toggle = seen.observation.elements.find(item => item.role === 'link' && item.name === 'Search');
        await bot({ action: 'click', scope: A, tab: 'x2', ref: toggle.ref }); await delay(500);
        seen = await bot({ action: 'observe', scope: A, tab: 'x2', maxElements: 300 });
      }
      const search = field();
      expect(search, 'search field', seen.observation.elements.slice(0, 40).map(item => [item.role, item.name]));
      const typed = await bot({ action: 'type', scope: A, tab: 'x2', ref: search.ref, text: 'Chromium (web browser)' });
      expect(typed.status === 'ok', 'type', typed);
      const pressed = await bot({ action: 'press', scope: A, tab: 'x2', key: 'Enter' });
      expect(pressed.status === 'ok', 'enter', pressed);
      const state = await settle('x2', url => /Chromium|search=/.test(url));
      const page = await bot({ action: 'observe', scope: A, tab: 'x2' });
      return { url: state.url, title: page.title, method: typed.evidence.method };
    });
    await check('third-party: httpbin form fill, radio/checkbox click and submit', async () => {
      const opened = await bot({ action: 'open', scope: A, tab: 'x3', url: 'https://httpbin.org/forms/post' });
      expect(opened.status === 'ok', 'open httpbin', opened);
      await show('x3');
      const seen = await bot({ action: 'observe', scope: A, tab: 'x3', maxElements: 300 });
      const find = test => { const found = seen.observation.elements.find(test); expect(found, 'field', seen.observation.elements.map(item => [item.role, item.name, item.type])); return found.ref; };
      await bot({ action: 'type', scope: A, tab: 'x3', ref: find(item => /customer name/i.test(item.name)), text: 'Ada Lovelace' });
      await bot({ action: 'type', scope: A, tab: 'x3', ref: find(item => item.type === 'email'), text: 'ada@example.org' });
      const radio = await bot({ action: 'click', scope: A, tab: 'x3', ref: find(item => item.type === 'radio' && /medium/i.test(item.name)) });
      const box = await bot({ action: 'click', scope: A, tab: 'x3', ref: find(item => item.type === 'checkbox' && /bacon/i.test(item.name)) });
      expect(radio.status === 'ok' && box.status === 'ok', 'choices', { radio, box });
      const submit = await bot({ action: 'click', scope: A, tab: 'x3', ref: find(item => item.role === 'button' && /submit/i.test(item.name)) });
      expect(submit.status === 'ok' && submit.evidence.navigationStarted, 'submit', submit);
      await settle('x3', url => url.endsWith('/post'));
      const result = await bot({ action: 'observe', scope: A, tab: 'x3', mode: 'page' });
      expect(/Ada Lovelace/.test(result.observation.text) && /"size":\s*"medium"/.test(result.observation.text) && /bacon/.test(result.observation.text), 'server echo', result.observation.text.slice(0, 800));
      return { echoed: result.observation.text.slice(0, 300) };
    });
    await check('third-party: a real HTTPS site permission prompt names that origin and is denied by default', async () => {
      await show('x1');
      const id = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(item => /iana\.org|example\.com/.test(item.getURL()))?.id);
      const start = (await dialogCalls()).length;
      const result = await inPage(id, 'Notification.requestPermission()', true);
      const asked = (await dialogCalls()).slice(start);
      expect(result === 'denied' && asked.length === 1 && /^https:\/\//.test(asked[0].message), 'prompt', { result, asked });
      return asked[0].message;
    });
  } else if (phase === 'resources') {
    // Indicative only: development Electron runtime, fixture pages, one sample per step.
    const sample = async label => {
      await delay(2500);
      const metrics = await app.evaluate(({ app: electronApp, webContents }) => ({ processes: electronApp.getAppMetrics().map(item => ({ type: item.type, kb: item.memory?.workingSetSize ?? 0, cpu: item.cpu?.percentCPUUsage ?? 0 })),
        contents: webContents.getAllWebContents().filter(item => !item.isDestroyed()).length }));
      return { label, contents: metrics.contents, processes: metrics.processes.length, workingSetMB: Math.round(metrics.processes.reduce((sum, item) => sum + item.kb, 0) / 1024),
        cpuPercent: Math.round(metrics.processes.reduce((sum, item) => sum + item.cpu, 0) * 10) / 10 };
    };
    await check('resource samples for 0/1/2/4 visible pages, hidden and slept pages', async () => {
      const samples = [await sample('app only')];
      const rects = [{ x: 420, y: 60, width: 360, height: 300 }, { x: 790, y: 60, width: 360, height: 300 }, { x: 420, y: 370, width: 360, height: 300 }, { x: 790, y: 370, width: 360, height: 300 }];
      for (const [count, tabs] of [[1, ['p1']], [2, ['p1', 'p2']], [4, ['p1', 'p2', 'p3', 'p4']]]) {
        for (const tab of tabs) await bot({ action: 'open', scope: A, tab, url: `${site}/form` });
        await layout(tabs.map((tab, index) => ({ tab, ...rects[index] })));
        samples.push(await sample(`${count} visible`));
      }
      await layout([]); samples.push(await sample('4 live, none visible'));
      for (const tab of ['p1', 'p2', 'p3', 'p4']) await bot({ action: 'sleep', scope: A, tab });
      samples.push(await sample('4 slept'));
      return samples;
    });
  } else if (phase === 'restart') {
    await check('restart: scoped persistent login survives an App restart and stays isolated', async () => {
      await bot({ action: 'open', scope: A, tab: 'ra', url: `${site}/cookie-show` });
      await bot({ action: 'open', scope: B, tab: 'rb', url: `${site}/cookie-show` });
      const a = await bot({ action: 'observe', scope: A, tab: 'ra' }), b = await bot({ action: 'observe', scope: B, tab: 'rb' });
      expect(a.observation.text.includes('cookie=sid=signed-in'), 'scope A lost its login', a.observation.text);
      expect(b.observation.text.trim() === 'cookie=', 'scope B received scope A cookie', b.observation.text);
    });
  } else {
    await check('capabilities are negotiated through the real preload/NativeOwner chain', async () => {
      const value = await invoke({ action: 'capabilities', scope: A });
      expect(value.status === 'ok' && value.version === 1 && value.actions.includes('observe') && typeof value.window === 'string', 'capabilities', value);
      return { window: value.window, actions: value.actions.length };
    });
    await check('open loads the real URL and reports the committed navigation', async () => {
      form = await bot({ action: 'open', scope: A, tab: 'a1', url: `${site}/form` });
      expect(form.status === 'ok' && form.url === `${site}/form` && form.navigation >= 1 && form.title === 'Workbench form', 'open', form);
      const state = await views();
      expect(state.length === 1 && state[0].visible === false, 'page must stay hidden until layout', state);
    });
    await check('layout maps App CSS pixels to DIP (zoom 1 and 1.25) and hides unlisted pages', async () => {
      await layout([{ tab: 'a1', x: 420, y: 64, width: 720, height: 640 }]);
      let state = await views();
      expect(state[0].visible && state[0].bounds.x === 420 && state[0].bounds.width === 720, 'zoom 1 bounds', state);
      await app.evaluate(() => globalThis.__acceptance.window.webContents.setZoomFactor(1.25));
      await layout([{ tab: 'a1', x: 320, y: 40, width: 560, height: 500 }]);
      state = await views();
      expect(state[0].bounds.x === 400 && state[0].bounds.y === 50 && state[0].bounds.width === 700 && state[0].bounds.height === 625, 'zoom 1.25 bounds', state);
      await app.evaluate(() => globalThis.__acceptance.window.webContents.setZoomFactor(1));
      await layout([{ tab: 'a1', x: 420, y: 64, width: 720, height: 640 }]);
      return state[0].bounds;
    });
    await check('page has no Node, preload bridge, App protocol, file access or loopback reach', async () => {
      const id = await contentsOf('/form');
      const probe = await inPage(id, `(async () => {
        const attempt = async url => { try { const response = await fetch(url); return 'reached:' + response.status + ':' + (await response.text()).slice(0, 20); } catch (error) { return 'blocked'; } };
        return { require: typeof require, process: typeof process, module: typeof module, bridge: typeof window.tarobotDesktop,
          app: await attempt('tarobot://app/index.html'), widget: await attempt('tarobot-widget://sandbox/widget-sandbox.html'),
          file: await attempt('file:///etc/hosts'), loopback: await attempt('http://127.0.0.1:${port}/secret'), localhost: await attempt('http://localhost:${port}/secret') };
      })()`);
      expect(probe.require === 'undefined' && probe.process === 'undefined' && probe.module === 'undefined' && probe.bridge === 'undefined', 'Node/bridge exposure', probe);
      expect(['app', 'widget', 'file', 'loopback', 'localhost'].every(key => probe[key] === 'blocked'), 'resource reach', probe);
      const prefs = await app.evaluate(({ webContents, session }, value) => {
        const contents = webContents.fromId(value), last = contents.getLastWebPreferences(), appSession = session.fromPartition('persist:desktop-v1');
        return { preload: last.preload ?? null, sandbox: last.sandbox, contextIsolation: last.contextIsolation, nodeIntegration: last.nodeIntegration, webSecurity: last.webSecurity,
          sameSession: contents.session === appSession, storage: contents.session.getStoragePath(), appStorage: appSession.getStoragePath(), agent: contents.session.getUserAgent() };
      }, id);
      expect(prefs.preload === null && prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration && prefs.webSecurity && !prefs.sameSession && prefs.storage !== prefs.appStorage, 'web preferences/session', prefs);
      expect(!/Electron|TaroBot/.test(prefs.agent), 'user agent leaks app tokens', prefs.agent);
      const handled = await app.evaluate(async ({ webContents }, value) => ({ browser: await webContents.fromId(value).session.protocol.isProtocolHandled('tarobot') }), id);
      expect(handled.browser === false, 'App protocol registered in browser session', handled);
      return { probe, storage: path.basename(prefs.storage) };
    });
    await check('page cannot navigate itself to the App origin, files or App deep links', async () => {
      const id = await contentsOf('/form');
      for (const target of ['tarobot://app/index.html', 'file:///etc/hosts', 'tarocub://conversation/x']) {
        await inPage(id, `location.href = ${JSON.stringify(target)}; 1`);
        await delay(300);
        const url = await app.evaluate(({ webContents }, value) => webContents.fromId(value).getURL(), id);
        expect(url === `${site}/form`, `navigated to ${target}`, url);
      }
      const blocked = (await events()).filter(event => event.kind === 'blocked');
      // Chromium itself refuses file: from a web origin before navigation starts.
      expect(blocked.length >= 2, 'blocked events', blocked);
      return blocked.map(event => event.reason);
    });
    await check('observe returns bounded structure with refs and no credential values', async () => {
      await inPage(await contentsOf('/form'), `document.getElementById('secret').value = 'pre-filled-secret'; 1`);
      snapshotRefs = await bot({ action: 'observe', scope: A, tab: 'a1' });
      const secret = element(snapshotRefs, item => item.type === 'password');
      expect(snapshotRefs.status === 'ok' && snapshotRefs.snapshot >= 1 && snapshotRefs.untrusted === true, 'observe', snapshotRefs);
      expect(secret?.sensitive === true && secret.filled === true && secret.value === undefined, 'password exposure', secret);
      expect(!JSON.stringify(snapshotRefs).includes('pre-filled-secret'), 'secret value in receipt');
      return { elements: snapshotRefs.observation.elements.length, text: snapshotRefs.observation.text.length };
    });
    await check('type uses the page field without taking keyboard focus from the App', async () => {
      await app.evaluate(() => { const window = globalThis.__acceptance.window; window.show(); window.focus(); window.webContents.focus(); });
      await delay(200);
      const before = await app.evaluate(() => globalThis.__acceptance.window.webContents.isFocused());
      const name = element(snapshotRefs, item => item.tag === 'input' && item.name.startsWith('Name'));
      const typed = await bot({ action: 'type', scope: A, tab: 'a1', ref: name.ref, text: 'Ada 中文' });
      const after = await app.evaluate(({ webContents }) => ({ app: globalThis.__acceptance.window.webContents.isFocused(), page: webContents.getAllWebContents().find(item => item.getURL().includes('/form'))?.isFocused() }));
      expect(typed.status === 'ok' && typed.evidence.matches && typed.evidence.value === 'Ada 中文', 'type', typed);
      expect(!after.page && (after.app || !before), 'focus moved to page', { before, after });
      const secret = element(snapshotRefs, item => item.type === 'password');
      const password = await bot({ action: 'type', scope: A, tab: 'a1', ref: secret.ref, text: 'hunter2-value' });
      expect(password.status === 'ok' && password.evidence.filled === true && !JSON.stringify(password).includes('hunter2-value'), 'password receipt', password);
      return { method: typed.evidence.method, passwordMethod: password.evidence.method, appFocusedBefore: before, after };
    });
    await check('click dispatches trusted input on the target and reports delivery evidence', async () => {
      const apply = element(snapshotRefs, item => item.tag === 'button' && item.name === 'Apply');
      const clicked = await bot({ action: 'click', scope: A, tab: 'a1', ref: apply.ref });
      expect(clicked.status === 'ok' && clicked.evidence.delivered === true, 'click', clicked);
      const status = await inPage(await contentsOf('/form'), `document.getElementById('status').textContent`);
      expect(status === 'clicked:Ada 中文', 'page effect', status);
    });
    await check('select chooses by visible label and verifies the selected value', async () => {
      const color = element(snapshotRefs, item => item.tag === 'select');
      const selected = await bot({ action: 'select', scope: A, tab: 'a1', ref: color.ref, labels: ['Green'] });
      expect(selected.status === 'ok' && selected.evidence.selected[0].value === 'g', 'select', selected);
      const missing = await bot({ action: 'select', scope: A, tab: 'a1', ref: color.ref, labels: ['Purple'] });
      expect(missing.status === 'failed' && missing.error === 'option_not_found', 'missing option', missing);
    });
    await check('scroll, selection and target-page screenshot', async () => {
      const scrolled = await bot({ action: 'scroll', scope: A, tab: 'a1', direction: 'down', amount: 'page' });
      expect(scrolled.status === 'ok' && scrolled.evidence.moved && scrolled.evidence.after.y > 0, 'scroll', scrolled);
      await bot({ action: 'scroll', scope: A, tab: 'a1', to: 'top' });
      await inPage(await contentsOf('/form'), `getSelection().selectAllChildren(document.getElementById('title')); 1`);
      const selection = await invoke({ action: 'selection', scope: A, tab: 'a1' });
      expect(selection.selection.text === 'Workbench form', 'selection', selection);
      const shot = await invoke({ action: 'screenshot', scope: A, tab: 'a1', maxWidth: 800 });
      const bytes = Buffer.from(shot.image?.data ?? '', 'base64');
      expect(shot.status === 'ok' && shot.image.mime === 'image/png' && bytes.subarray(1, 4).toString() === 'PNG' && shot.image.width <= 800 && shot.viewport.width > 0, 'screenshot', { ...shot, image: shot.image && { ...shot.image, data: bytes.length } });
      await writeFile(path.join(root, 'page-screenshot.png'), bytes);
      return { width: shot.image.width, height: shot.image.height, bytes: bytes.length, viewport: shot.viewport };
    });
    await check('coordinate click needs the latest snapshot and unchanged scroll', async () => {
      const fresh = await bot({ action: 'observe', scope: A, tab: 'a1' });
      const apply = element(fresh, item => item.name === 'Apply');
      const point = { x: apply.rect.x + apply.rect.width / 2, y: apply.rect.y + apply.rect.height / 2 };
      const stale = await bot({ action: 'click', scope: A, tab: 'a1', point, snapshot: fresh.snapshot - 1 });
      expect(stale.error === 'stale_snapshot', 'old snapshot accepted', stale);
      const clicked = await bot({ action: 'click', scope: A, tab: 'a1', point, snapshot: fresh.snapshot });
      expect(clicked.status === 'ok' && clicked.evidence.delivered, 'point click', clicked);
      snapshotRefs = fresh;
    });
    await check('Enter submits in the same tab, navigation invalidates old refs; back/forward/reload work', async () => {
      const query = element(snapshotRefs, item => item.name === 'Search');
      await bot({ action: 'type', scope: A, tab: 'a1', ref: query.ref, text: 'hello' });
      const pressed = await bot({ action: 'press', scope: A, tab: 'a1', key: 'Enter' });
      expect(pressed.status === 'ok' && (pressed.evidence.navigationStarted || pressed.evidence.delivered), 'press', pressed);
      for (let i = 0; i < 40 && !(await invoke({ action: 'list', scope: A })).tabs.find(tab => tab.tab === 'a1').url.includes('/next'); i++) await delay(100);
      const stale = await bot({ action: 'click', scope: A, tab: 'a1', ref: query.ref });
      expect(stale.error === 'stale_ref', 'stale ref accepted after navigation', stale);
      const back = await bot({ action: 'back', scope: A, tab: 'a1' });
      expect(back.status === 'ok' && back.url === `${site}/form`, 'back', back);
      const forward = await bot({ action: 'forward', scope: A, tab: 'a1' });
      expect(forward.status === 'ok' && forward.url.includes('/next?q=hello'), 'forward', forward);
      const reload = await bot({ action: 'reload', scope: A, tab: 'a1' });
      expect(reload.status === 'ok', 'reload', reload);
      const nav = await bot({ action: 'navigate', scope: A, tab: 'a1', url: `${site}/form` });
      expect(nav.status === 'ok' && nav.navigation > back.navigation, 'navigate', nav);
      const blocked = await bot({ action: 'navigate', scope: A, tab: 'a1', url: 'file:///etc/hosts' });
      expect(blocked.status === 'failed' && blocked.error === 'navigation_blocked', 'navigate file', blocked);
      const failed = await bot({ action: 'navigate', scope: A, tab: 'a1', url: 'http://does-not-exist.invalid/' });
      expect(failed.status === 'failed' && failed.error === 'navigation_failed', 'dns failure', failed);
      await bot({ action: 'navigate', scope: A, tab: 'a1', url: `${site}/form` });
      return { pressed: pressed.evidence, failed: failed.detail };
    });
    await check('target=_blank becomes a managed tab in the same scope; window.open popup keeps opener without App privileges', async () => {
      await events();
      snapshotRefs = await bot({ action: 'observe', scope: A, tab: 'a1' });
      await bot({ action: 'click', scope: A, tab: 'a1', ref: element(snapshotRefs, item => item.name === 'New tab link').ref });
      let opened;
      for (let i = 0; i < 30 && !opened; i++) { opened = (await peek()).find(event => event.kind === 'opened'); await delay(100); }
      expect(opened?.opener === 'a1', 'opened event', opened);
      const tabs = (await invoke({ action: 'list', scope: A })).tabs;
      expect(tabs.some(tab => tab.tab === opened.tab && tab.opener === 'a1'), 'list', tabs);
      const other = await invoke({ action: 'list', scope: B });
      expect(other.tabs.length === 0, 'tab leaked into other scope', other);
      await bot({ action: 'click', scope: A, tab: 'a1', ref: element(snapshotRefs, item => item.name === 'Login popup').ref });
      let popup;
      for (let i = 0; i < 30 && !popup; i++) {
        popup = await app.evaluate(({ BrowserWindow, webContents }) => {
          const opener = webContents.getAllWebContents().find(item => item.getURL().endsWith('/form'));
          const child = BrowserWindow.getAllWindows().find(window => window !== globalThis.__acceptance.window && window.webContents.getURL().includes('/popup'));
          if (!child) return null;
          const last = child.webContents.getLastWebPreferences();
          return { sameSession: child.webContents.session === opener.session, preload: last.preload ?? null, sandbox: last.sandbox, nodeIntegration: last.nodeIntegration, parent: child.getParentWindow() === globalThis.__acceptance.window, id: child.webContents.id };
        });
        if (!popup) await delay(100);
      }
      expect(popup?.sameSession && popup.preload === null && popup.sandbox && !popup.nodeIntegration && popup.parent, 'popup', popup);
      const opener = await inPage(popup.id, '!!window.opener && typeof window.opener.postMessage === "function"');
      expect(opener === true, 'popup lost opener semantics', opener);
      return { newTab: opened.tab, popup };
    });
    await check('download is attributed to the tab, reported without path and completes', async () => {
      const target = path.join(root, 'downloads'); await mkdir(target, { recursive: true });
      // Test-only stand-in for the person choosing a location in the save dialog.
      await app.evaluate(({ webContents }, directory) => {
        const contents = webContents.getAllWebContents().find(item => item.getURL().endsWith('/form'));
        contents.session.on('will-download', (_event, item) => item.setSavePath(`${directory}/${item.getFilename()}`));
      }, target);
      await events();
      await bot({ action: 'click', scope: A, tab: 'a1', ref: element(snapshotRefs, item => item.name === 'Download file').ref });
      let done;
      for (let i = 0; i < 50 && !done; i++) { done = (await peek()).find(event => event.kind === 'download' && event.state === 'completed'); await delay(100); }
      expect(done?.tab === 'a1' && done.name === 'report.txt' && !('path' in done), 'download event', done);
      expect(await readFile(path.join(target, 'report.txt'), 'utf8') === 'downloaded body', 'downloaded bytes');
      const listed = await invoke({ action: 'downloads', scope: B });
      expect(listed.downloads.length === 0, 'download visible to other scope', listed);
      return done;
    });
    await check('upload sets only App-staged bytes on the chosen file input', async () => {
      const body = Buffer.from('hello upload');
      const begun = await bot({ action: 'upload_begin', scope: A, name: 'note.txt', size: body.length });
      await bot({ action: 'upload_write', scope: A, upload: begun.upload, data: body.toString('base64') });
      const fresh = await bot({ action: 'observe', scope: A, tab: 'a1' });
      const input = element(fresh, item => item.type === 'file');
      const uploaded = await bot({ action: 'upload', scope: A, tab: 'a1', ref: input.ref, files: [begun.upload] });
      expect(uploaded.status === 'ok' && uploaded.evidence.names[0] === 'note.txt', 'upload', uploaded);
      await delay(200);
      const status = await inPage(await contentsOf('/form'), `document.getElementById('status').textContent`);
      expect(status === 'file:note.txt:hello upload', 'page read', status);
      const reuse = await bot({ action: 'upload', scope: A, tab: 'a1', ref: input.ref, files: [begun.upload] });
      expect(reuse.error === 'upload_not_found', 'staged file reused', reuse);
      snapshotRefs = fresh;
    });
    await check('takeover pauses Bot steps; resume requires a new observation; hidden window pauses native input', async () => {
      await invoke({ action: 'takeover', scope: A, tab: 'a1', source: 'user' });
      const paused = await bot({ action: 'click', scope: A, tab: 'a1', ref: element(snapshotRefs, item => item.name === 'Apply').ref });
      expect(paused.status === 'paused' && paused.error === 'user_control', 'takeover', paused);
      await invoke({ action: 'resume', scope: A, tab: 'a1', source: 'user' });
      const stale = await bot({ action: 'click', scope: A, tab: 'a1', ref: element(snapshotRefs, item => item.name === 'Apply').ref });
      expect(stale.error === 'stale_ref', 'old ref after resume', stale);
      snapshotRefs = await bot({ action: 'observe', scope: A, tab: 'a1' });
      await app.evaluate(() => globalThis.__acceptance.window.hide());
      const hidden = await bot({ action: 'click', scope: A, tab: 'a1', ref: element(snapshotRefs, item => item.name === 'Apply').ref });
      expect(hidden.status === 'paused' && hidden.error === 'window_hidden', 'hidden window', hidden);
      for (const args of [{ action: 'observe' }, { action: 'navigate', url: `${site}/next` }, { action: 'screenshot' }]) {
        const paused = await bot({ scope: A, tab: 'a1', ...args });
        expect(paused.status === 'paused' && paused.error === 'window_hidden', `${args.action} while hidden`, paused);
      }
      expect((await invoke({ action: 'list', scope: A })).status === 'ok', 'metadata while hidden');
      const revealed = await invoke({ action: 'reveal', scope: A, tab: 'a1' });
      expect(revealed.status === 'ok' && await app.evaluate(() => globalThis.__acceptance.window.isVisible()), 'reveal', revealed);
      // A Bot step waiting behind a running one is paused the moment the window hides.
      const slow = bot({ action: 'navigate', scope: A, tab: 'a1', url: `${site}/slow` });
      await delay(200);
      const queued = bot({ action: 'scroll', scope: A, tab: 'a1', direction: 'down' });
      await delay(100);
      await app.evaluate(() => globalThis.__acceptance.window.hide());
      const pausedQueued = await queued;
      expect(pausedQueued.status === 'paused' && pausedQueued.error === 'window_hidden', 'queued step after hide', pausedQueued);
      const running = await slow;
      expect(running.status === 'ok', 'dispatched navigation keeps its real result', running);
      await invoke({ action: 'reveal', scope: A, tab: 'a1' });
      await bot({ action: 'navigate', scope: A, tab: 'a1', url: `${site}/form` });
      snapshotRefs = await bot({ action: 'observe', scope: A, tab: 'a1' });
    });
    await check('beforeunload: Bot close needs the person; page keeps its state', async () => {
      await bot({ action: 'click', scope: A, tab: 'a1', ref: element(snapshotRefs, item => item.name === 'Guard').ref });
      const closed = await bot({ action: 'close', scope: A, tab: 'a1' });
      expect(closed.status === 'needs_user' && closed.error === 'page_has_unsaved_changes', 'bot close', closed);
      const alive = await contentsOf('/form');
      expect(alive !== null, 'page destroyed');
      const sleep = await bot({ action: 'sleep', scope: A, tab: 'a1' });
      expect(sleep.status !== 'ok', 'visible/edited page slept', sleep);
      await inPage(alive, 'window.onbeforeunload = null; 1');
    });
    await check('scope isolation: login cookie in A is absent in B; a second A tab shares it', async () => {
      await bot({ action: 'open', scope: A, tab: 'a2', url: `${site}/cookie-set` });
      await bot({ action: 'open', scope: B, tab: 'b1', url: `${site}/cookie-show` });
      await bot({ action: 'open', scope: A, tab: 'a3', url: `${site}/cookie-show` });
      const b = await invoke({ action: 'observe', scope: B, tab: 'b1' }), a = await invoke({ action: 'observe', scope: A, tab: 'a3' });
      expect(b.observation.text.trim() === 'cookie=' && a.observation.text.includes('sid=signed-in'), 'cookies', { a: a.observation.text, b: b.observation.text });
      const cross = await invoke({ action: 'observe', scope: B, tab: 'a3' });
      expect(cross.error === 'tab_scope_mismatch', 'cross-scope control', cross);
    });
    await check('App document replacement hides pages and cancels old authority but keeps page state', async () => {
      await bot({ action: 'navigate', scope: A, tab: 'a3', url: `${other}/form` });
      await layout([{ tab: 'a3', x: 420, y: 64, width: 720, height: 640 }]);
      const fresh = await bot({ action: 'observe', scope: A, tab: 'a3' });
      await bot({ action: 'type', scope: A, tab: 'a3', ref: element(fresh, item => item.name.startsWith('Name')).ref, text: 'keep me' });
      await ui.reload();
      await ui.waitForFunction(() => window.tarobotDesktop?.engine === 'electron');
      await listen();
      t.resetLayout();
      const state = await views();
      expect(state.every(view => view.visible === false), 'pages visible over a replaced App document', state);
      const kept = await inPage(await contentsOf(`${other}/form`), `document.getElementById('name').value`);
      expect(kept === 'keep me', 'form state lost on App reload', kept);
      const list = await invoke({ action: 'list', scope: A });
      expect(list.tabs.some(tab => tab.tab === 'a3' && tab.state === 'live'), 'tabs after reload', list);
      const replay = await invoke({ requestId: 'req-1', action: 'open', scope: A, tab: 'a1', url: `${site}/form` });
      expect(replay.action === 'open' && replay.tab === 'a1' && replay.navigation === form.navigation, 'requestId receipt not replayed after reload', replay);
      const conflict = await invoke({ requestId: 'req-1', action: 'observe', scope: A, tab: 'a3' });
      expect(conflict.error === 'request_conflict', 'reused requestId with other input', conflict);
    });
    await check('site permissions: native prompt names the site; decisions are per scope; devices denied; hidden window never prompts', async () => {
      await bot({ action: 'navigate', scope: A, tab: 'a1', url: `${site}/form` });
      await layout([{ tab: 'a1', x: 420, y: 64, width: 720, height: 640 }]);
      const a = await contentsOf(`${site}/form`), b = await contentsOf(`${site}/cookie-show`);
      const start = (await dialogCalls()).length;
      await answers([1]);
      const granted = await inPage(a, 'Notification.requestPermission()', true);
      const state = await inPage(a, `navigator.permissions.query({ name: 'notifications' }).then(result => result.state)`);
      await answers([0]);
      const otherScope = await inPage(b, 'Notification.requestPermission()', true);
      const remembered = await inPage(a, 'Notification.requestPermission()', true);
      await answers([0]);
      const location = await inPage(a, `new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve('position'), error => resolve('error:' + error.code), { timeout: 5000 }))`, true);
      const hid = await inPage(a, `navigator.hid ? navigator.hid.requestDevice({ filters: [] }).then(list => 'devices:' + list.length, error => 'rejected:' + error.name) : 'unavailable'`, true);
      const asked = (await dialogCalls()).slice(start);
      await app.evaluate(() => globalThis.__acceptance.window.hide());
      const hiddenMidi = await inPage(a, `navigator.requestMIDIAccess().then(() => 'granted', error => 'denied:' + error.name)`, true);
      const askedHidden = (await dialogCalls()).length - start - asked.length;
      await invoke({ action: 'reveal', scope: A, tab: 'a1' });
      const appState = await exec(`navigator.permissions.query({ name: 'notifications' }).then(result => result.state)`);
      expect(granted === 'granted' && state === 'granted', 'allowed notifications', { granted, state });
      expect(otherScope === 'denied' && remembered === 'granted', 'per-scope decision', { otherScope, remembered });
      expect(location === 'error:1', 'denied geolocation', location);
      expect(hid === 'devices:0' || hid.startsWith('rejected') || hid === 'unavailable', 'device access', hid);
      expect(asked.length === 3 && asked.every(call => call.message.includes(`site.test:${port}`)) && asked[0].message.includes('通知') && asked[2].message.includes('位置'), 'prompts', asked);
      expect(hiddenMidi.startsWith('denied') && askedHidden === 0, 'hidden window prompt', { hiddenMidi, askedHidden });
      expect(appState !== 'granted', 'App session inherited a site grant', appState);
      const reported = (await events()).filter(event => event.kind === 'permission');
      return { prompts: asked.map(call => call.message), hid, hiddenMidi, appState, events: reported.length };
    });
    await check('native helper loss and recovery keep pages, refs and Bot authority', async () => {
      const fresh = await bot({ action: 'observe', scope: A, tab: 'a1' });
      await exec(`window.__native = []; window.tarobotDesktop.on('native-state', state => window.__native.push(state)); 1`);
      const lease = await exec(`window.tarobotDesktop.invoke('net_document', {})`);
      expect(lease === 'doc-1', 'stub helper lease', lease);
      execFileSync('/usr/bin/pkill', ['-9', '-f', helper]);
      let failed;
      for (let i = 0; i < 40 && !failed; i++) { failed = (await exec('window.__native')).find(state => state.failed === true); if (!failed) await delay(100); }
      expect(failed, 'native-state failure event');
      const clicked = await bot({ action: 'click', scope: A, tab: 'a1', ref: element(fresh, item => item.name === 'Apply').ref });
      expect(clicked.status === 'ok' && clicked.navigation === fresh.navigation, 'Bot authority while helper is down', clicked);
      expect(await exec(`window.tarobotDesktop.invoke('desktop_recover', {})`) === null, 'recover');
      const renewed = await exec(`window.tarobotDesktop.invoke('net_document', {})`);
      const after = await bot({ action: 'click', scope: A, tab: 'a1', ref: element(fresh, item => item.name === 'Apply').ref });
      expect(typeof renewed === 'string' && after.status === 'ok' && after.navigation === fresh.navigation, 'after recovery', { renewed, after });
      return { lease, renewed };
    });
    await check('App renderer crash: old authority ends, in-flight result is kept, queued step is not replayed, pages survive', async () => {
      const fresh = await bot({ action: 'observe', scope: A, tab: 'a1' });
      await bot({ action: 'type', scope: A, tab: 'a1', ref: element(fresh, item => item.name.startsWith('Name')).ref, text: 'survives crash' });
      const slowArgs = { requestId: 'crash-nav', action: 'navigate', scope: A, tab: 'a3', url: `${site}/slow` };
      const queuedArgs = { requestId: 'crash-scroll', action: 'scroll', scope: A, tab: 'a3', direction: 'down' };
      await layout([{ tab: 'a1', x: 420, y: 64, width: 360, height: 640 }, { tab: 'a3', x: 790, y: 64, width: 360, height: 640 }]);
      const lost = [invoke(slowArgs).catch(() => 'lost'), invoke(queuedArgs).catch(() => 'lost')];
      await delay(300);
      await app.evaluate(() => globalThis.__acceptance.window.webContents.forcefullyCrashRenderer());
      await Promise.allSettled(lost);
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) { try { ready = await exec('!!window.tarobotDesktop && document.readyState === "complete"'); } catch { ready = false; } if (!ready) await delay(200); }
      expect(ready, 'App document recovered');
      await listen(); t.resetLayout();
      const state = await views();
      expect(state.every(view => !view.visible), 'pages visible over the recovered App document', state);
      const call = invoke;
      await delay(2600);
      const slow = await call(slowArgs), queued = await call(queuedArgs);
      expect(slow.status === 'ok' && slow.url.endsWith('/slow'), 'in-flight navigation result retained', slow);
      expect(queued.status === 'cancelled' && queued.error === 'native_document_retired', 'queued step replayed', queued);
      await layout([{ tab: 'a1', x: 420, y: 64, width: 720, height: 640 }]);
      const stale = await call({ requestId: 'crash-click', action: 'click', scope: A, tab: 'a1', ref: element(fresh, item => item.name === 'Apply').ref });
      expect(stale.error === 'stale_ref', 'old ref after App crash', stale);
      const draft = await inPage(await contentsOf(`${site}/form`), `document.getElementById('name').value`);
      expect(draft === 'survives crash', 'page state lost', draft);
      await layout([{ tab: 'a1', x: 420, y: 64, width: 720, height: 640 }]);
      return { slow: slow.status, queued: queued.error };
    });
    await check('targeted cancel in real Electron: stale and cross-tab targets are no-ops, only the queued dispatch is removed', async () => {
      const old = await invoke({ requestId: 'race-old', action: 'navigate', scope: A, tab: 'a1', url: `${site}/next?race=old` });
      expect(old.status === 'ok', 'old navigation', old);
      const newer = invoke({ requestId: 'race-new', action: 'navigate', scope: A, tab: 'a1', url: `${site}/slow` });
      await delay(300);
      const queued = invoke({ requestId: 'race-queued', action: 'scroll', scope: A, tab: 'a1', direction: 'down' });
      await delay(100);
      const person = invoke({ action: 'list', scope: A, source: 'user' });
      const stale = await invoke({ action: 'cancel', scope: A, tab: 'a1', source: 'user', targetRequestId: 'race-old' });
      const crossTab = await invoke({ action: 'cancel', scope: A, tab: 'a3', source: 'user', targetRequestId: 'race-new' });
      const removed = await invoke({ action: 'cancel', scope: A, tab: 'a1', source: 'user', targetRequestId: 'race-queued' });
      expect(stale.cancel.outcome === 'finished' && crossTab.cancel.outcome === 'not_current' && removed.cancel.outcome === 'cancelled', 'cancel outcomes', { stale: stale.cancel, crossTab: crossTab.cancel, removed: removed.cancel });
      const [finalNewer, finalQueued, personal] = await Promise.all([newer, queued, person]);
      expect(finalNewer.status === 'ok' && finalNewer.url.endsWith('/slow'), 'newer dispatch must finish', finalNewer);
      expect(finalQueued.status === 'cancelled', 'queued dispatch', finalQueued);
      expect(personal.status === 'ok', 'person request', personal);
      return { stale: stale.cancel, crossTab: crossTab.cancel, removed: removed.cancel };
    });
    await check('crashed page reports unavailable and can be reloaded', async () => {
      const id = await contentsOf('/cookie-set');
      await app.evaluate(({ webContents }, value) => webContents.fromId(value).forcefullyCrashRenderer(), id);
      await delay(400);
      const gone = (await peek()).find(event => event.kind === 'gone' && event.tab === 'a2');
      expect(gone, 'gone event');
      const read = await invoke({ action: 'observe', scope: A, tab: 'a2' });
      expect(read.error === 'page_unavailable', 'observe crashed', read);
      const reload = await bot({ action: 'reload', scope: A, tab: 'a2' });
      expect(reload.status === 'ok', 'reload crashed', reload);
    });
    await check('resource snapshot: App process tree with live pages', async () => {
      const metrics = await app.evaluate(({ app: electronApp, webContents }) => ({ processes: electronApp.getAppMetrics().map(item => ({ type: item.type, kb: item.memory?.workingSetSize ?? 0 })), contents: webContents.getAllWebContents().length }));
      return { contents: metrics.contents, processes: metrics.processes.length, workingSetMB: Math.round(metrics.processes.reduce((sum, item) => sum + item.kb, 0) / 1024) };
    });
    await check('quit preparation asks once, closes nothing, and a cancel keeps every page usable', async () => {
      const before = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(item => !item.isDestroyed()).map(item => item.getURL()));
      await bot({ action: 'navigate', scope: A, tab: 'a1', url: `${site}/form` });
      const fresh = await bot({ action: 'observe', scope: A, tab: 'a1' });
      await bot({ action: 'click', scope: A, tab: 'a1', ref: element(fresh, item => item.name === 'Guard').ref });
      await bot({ action: 'type', scope: A, tab: 'a1', ref: element(fresh, item => item.name.startsWith('Name')).ref, text: 'draft text' });
      const calls = (await dialogCalls()).length;
      await answers([0]);
      const kept = await app.evaluate(async () => [...globalThis.__acceptance.owners.values()][0].services.prepareQuit());
      const asked = (await dialogCalls()).slice(calls);
      expect(kept === false && asked.length === 1 && asked[0].detail.includes('Workbench form'), 'one question naming the page', asked);
      const after = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(item => !item.isDestroyed()).map(item => item.getURL()));
      expect(after.length === before.length, 'pages closed by a cancelled quit', { before, after });
      const draft = await inPage(await contentsOf(`${site}/form`), `document.getElementById('name').value`);
      expect(draft === 'draft text', 'draft lost', draft);
      const again = await bot({ action: 'observe', scope: A, tab: 'a1' });
      expect(again.status === 'ok', 'Bot work after a cancelled quit', again);
      await answers([1]);
      const ready = await app.evaluate(async () => [...globalThis.__acceptance.owners.values()][0].services.prepareQuit());
      const still = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(item => !item.isDestroyed()).length);
      expect(ready === true && still === after.length, 'confirmed quit must still wait for will-quit to close pages', { ready, still });
      const refused = await bot({ action: 'navigate', scope: A, tab: 'a1', url: `${site}/next` });
      expect(refused.status === 'cancelled' && refused.error === 'quitting', 'action during quit', refused);
      await app.evaluate(() => [...globalThis.__acceptance.owners.values()][0].services.quitCancelled());
      return { pages: after.length, question: asked[0].message };
    });
  }
} finally {
  await writeFile(path.join(root, `browser-acceptance-${phase}.json`), JSON.stringify({ electron: binary, phase, port, results }, null, 2));
  await app.close().catch(() => {});
  server.close();
}
const failed = results.filter(result => !result.ok);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : `\n     ${result.error}`}`);
console.log(`${results.length - failed.length}/${results.length} passed (${phase})`);
process.exitCode = failed.length ? 1 : 0;
