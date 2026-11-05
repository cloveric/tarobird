// Real Electron acceptance for the person's page tools. Usage:
//   node electron/tests/browser-user-tools.smoke.mjs <Electron binary below .noindex> <output dir below .noindex>
// Same isolated App stand-in as browser.smoke.mjs (real preload, NativeOwner,
// DesktopServices); save dialogs answer with paths below the output directory.
// The system print dialog is not opened by the automatic run: it needs a person.
//   ... <binary> <output> --manual-print [--wait-ms=180000]
// opens only the real system print dialog for a fixture page in the isolated
// window, waits for a person (or CUA) to cancel it and records the receipt in
// <output>/manual-print.json. Never silent; cancel it rather than printing.
import { _electron } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedRoot } from '../isolation.mjs';

process.on('unhandledRejection', error => { if (!String(error?.message).includes('handleJavaScriptDialog')) { console.error(error); process.exitCode = 1; } });
const [binary, output, ...flags] = process.argv.slice(2);
const manualPrint = flags.includes('--manual-print'), waitMs = Number(flags.find(flag => flag.startsWith('--wait-ms='))?.slice('--wait-ms='.length) ?? 180000);
if (flags.some(flag => flag !== '--manual-print' && !flag.startsWith('--wait-ms=')) || !(waitMs >= 1000 && waitMs <= 3600000)) throw new Error('usage: <binary> <output> [--manual-print] [--wait-ms=1000..3600000]');
if (!binary?.includes('.noindex/')) throw new Error('isolated Electron binary required');
const root = await isolatedRoot(output), client = fileURLToPath(new URL('../..', import.meta.url));
const assets = path.join(root, 'assets'), preload = path.join(root, 'preload.cjs'), config = path.join(root, 'acceptance.json'), saved = path.join(root, 'saved');
await mkdir(assets, { recursive: true }); await mkdir(saved, { recursive: true });
await writeFile(path.join(assets, 'index.html'), `<!doctype html><meta charset="utf-8"><title>TaroBot</title>
<body style="margin:0;font:14px -apple-system,sans-serif;display:flex;height:100vh"><main style="width:400px;border-right:1px solid #ddd"><textarea id="draft"></textarea></main>
<section id="workbench" style="flex:1;background:#f1f1f1"></section></body>`);
await build({ entryPoints: [path.join(client, 'electron/preload.mjs')], outfile: preload, bundle: true, format: 'cjs', platform: 'node', target: 'node22', external: ['electron'], logLevel: 'silent' });
const helper = path.join(root, 'fake-helper.mjs');
await writeFile(helper, `#!/usr/bin/env node
let buffer = '', documents = 0;
process.stdin.on('data', chunk => { buffer += chunk; for (let index; (index = buffer.indexOf('\\n')) >= 0;) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue;
  const { id, command } = JSON.parse(line); process.stdout.write(JSON.stringify({ id, result: command === 'helper_info' ? { protocol: 1 } : command === 'net_document' ? 'doc-' + (++documents) : null }) + '\\n'); } });
process.stdin.on('end', () => process.exit(0));
`);
await chmod(helper, 0o755);

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="margin:0;background:#22aa66;font:16px sans-serif">${body}</body>`;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  const html = value => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(value); };
  if (url.pathname === '/find') return html(page(`Find ${url.searchParams.get('v') ?? ''}`, `<p style="padding:8px">${'needle hay '.repeat(5)} NEEDLE</p>
    <button id="hit" style="position:absolute;left:40px;top:300px;width:120px;height:60px">Hit</button>
    <p id="width" style="position:absolute;top:400px;left:8px"></p>
    <script>window.__hits = []; document.getElementById('hit').addEventListener('click', event => window.__hits.push([event.clientX, event.clientY, event.isTrusted]));
    const show = () => document.getElementById('width').textContent = 'w=' + innerWidth; addEventListener('resize', show); show();</script>`));
  if (url.pathname === '/token') return html(page('Token', 'signed'));
  if (url.pathname === '/plain') return html(page(`Plain ${url.searchParams.get('n') ?? ''}`, `<h1>Plain ${url.searchParams.get('n') ?? ''}</h1>`));
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port, site = `http://site.test:${port}`;
await writeFile(config, JSON.stringify({ assets, preload, helper, secureOrigins: [site] }));
const A = { host: 'host-public-key-A', user: 'user-1', conversation: 'conv-A' }, B = { ...A, conversation: 'conv-B' }, H = { ...A, host: 'host-public-key-H' };
const results = [];
let request = 0;
async function check(name, fn) {
  const started = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - started, ...(detail === undefined ? {} : { detail }) }); }
  catch (error) { results.push({ name, ok: false, ms: Date.now() - started, error: error?.stack?.split('\n').slice(0, 12).join(' | ').slice(0, 3000) ?? String(error) }); }
}
function expect(condition, message, detail) { if (!condition) throw new Error(`${message}${detail === undefined ? '' : ` ${JSON.stringify(detail).slice(0, 1500)}`}`); }

async function launch() {
  const app = await _electron.launch({ executablePath: binary, args: [path.join(client, 'electron/tests/browser-runtime-main.mjs'), `--tarobot-browser-acceptance=${config}`], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
  const ui = await app.firstWindow();
  await ui.waitForFunction(() => window.tarobotDesktop?.engine === 'electron');
  await app.evaluate(async () => { for (let i = 0; i < 100 && !globalThis.__acceptance.window; i++) await new Promise(resolve => setTimeout(resolve, 50)); });
  const exec = code => app.evaluate((_electron, script) => globalThis.__acceptance.window.webContents.executeJavaScript(script), code);
  await exec(`window.__events = []; window.tarobotDesktop.on('workbench-browser', event => window.__events.push(event)); 1`);
  const invoke = args => exec(`window.tarobotDesktop.invoke('workbench_browser', ${JSON.stringify(args)})`);
  const user = args => invoke({ requestId: `u-${++request}`, source: 'user', ...args });
  const bot = args => invoke({ requestId: `b-${++request}`, ...args });
  let seq = 0;
  const layout = (views, extra = {}) => exec(`window.tarobotDesktop.invoke('workbench_browser_layout', ${JSON.stringify({ seq: ++seq, views, ...extra })})`);
  const events = () => exec('window.__events.splice(0)');
  const contentsOf = fragment => app.evaluate(({ webContents }, value) => webContents.getAllWebContents().find(item => !item.isDestroyed() && item.getURL().includes(value))?.id ?? null, fragment);
  const inPage = (id, code) => app.evaluate(({ webContents }, [value, script]) => webContents.fromId(value).executeJavaScript(script), [id, code]);
  const zoomOf = id => app.evaluate(({ webContents }, value) => webContents.fromId(value).getZoomFactor(), id);
  const views = () => app.evaluate(() => globalThis.__acceptance.window.contentView.children.map(view => ({ bounds: view.getBounds(), visible: view.getVisible(), url: view.webContents?.getURL?.() })));
  const answerSave = file => app.evaluate((_electron, value) => { globalThis.__acceptance.saves.answers.push(value ? { canceled: false, filePath: value } : { canceled: true, filePath: '' }); }, file);
  const pixel = file => app.evaluate(({ nativeImage }, value) => {
    const image = nativeImage.createFromPath(value), size = image.getSize(), bitmap = image.toBitmap(), at = (x, y) => { const i = (y * size.width + x) * 4; return [bitmap[i + 2], bitmap[i + 1], bitmap[i]]; };
    return { size, center: at(Math.floor(size.width / 2), Math.floor(size.height / 2)), corner: at(2, 2) };
  }, file);
  const profile = () => app.evaluate(() => globalThis.__acceptance.paths.profile);
  const sendKey = (id, keyCode, modifiers) => app.evaluate(({ webContents }, [value, key, mods]) => { const contents = webContents.fromId(value); contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods }); contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods }); }, [id, keyCode, modifiers]);
  return { app, exec, invoke, user, bot, layout, events, contentsOf, inPage, zoomOf, views, answerSave, pixel, profile, sendKey };
}
const greenish = ([r, g, b]) => g > 140 && r < 90 && b < 140;
const pane = { x: 420, y: 40, width: 500, height: 640 };

let t = await launch();
if (manualPrint) {
  try {
    await t.user({ action: 'open', scope: A, tab: 'print', url: `${site}/find?v=print` });
    await t.layout([{ tab: 'print', ...pane }]);
    await delay(500);
    console.log(JSON.stringify({ event: 'print_dialog_requested', window: 'TaroBot Browser Acceptance', instruction: 'Cancel the system print dialog. Do not print.' }));
    const started = Date.now();
    const receipt = await Promise.race([t.user({ action: 'print', scope: A, tab: 'print' }), delay(waitMs).then(() => ({ status: 'timeout' }))]);
    const result = { mode: 'manual-print', waitedMs: Date.now() - started, receipt: { status: receipt.status, error: receipt.error, detail: receipt.detail, print: receipt.print } };
    await writeFile(path.join(root, 'manual-print.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { await t.app.close().catch(() => {}); server.close(); }
  process.exit(0);
}
try {
  await check('capabilities list the page tools; a Bot request for them is refused before any work', async () => {
    const caps = await t.user({ action: 'capabilities', scope: A });
    const tools = ['find', 'stop_find', 'zoom', 'device', 'print', 'save_screenshot', 'history', 'clear_history', 'settings', 'settings_set'];
    expect(tools.every(action => caps.actions.includes(action)), 'missing tool', caps.actions);
    const refusals = [];
    for (const args of [{ action: 'history', scope: A }, { action: 'settings_set', scope: A, settings: { searchEngine: 'bing', defaultZoom: 1, recordHistory: false } }])
      refusals.push(await t.bot(args).then(() => 'accepted', error => /browser_user_action_required/.test(error.message) ? 'refused' : error.message));
    expect(refusals.every(value => value === 'refused'), 'Bot not refused', refusals);
    return { tools: tools.length, refusals };
  });

  await check('zoom is isolated per page (same origin, same conversation) and survives navigation', async () => {
    await t.user({ action: 'open', scope: A, tab: 'z1', url: `${site}/plain?n=1` });
    await t.user({ action: 'open', scope: A, tab: 'z2', url: `${site}/plain?n=2` });
    await t.layout([{ tab: 'z1', x: 420, y: 40, width: 380, height: 600 }, { tab: 'z2', x: 810, y: 40, width: 380, height: 600 }]);
    const [z1, z2] = [await t.contentsOf('/plain?n=1'), await t.contentsOf('/plain?n=2')];
    const zoomed = await t.user({ action: 'zoom', scope: A, tab: 'z1', factor: 1.5 });
    await delay(200);
    const after = { receipt: zoomed.zoomFactor, z1: await t.zoomOf(z1), z2: await t.zoomOf(z2) };
    expect(after.receipt === 1.5 && after.z1 === 1.5 && after.z2 === 1, 'zoom leaked or missing', after);
    await t.user({ action: 'navigate', scope: A, tab: 'z1', url: `${site}/plain?n=3` });
    await t.user({ action: 'navigate', scope: A, tab: 'z1', url: `http://other.test:${port}/plain?n=4` });
    const kept = await t.zoomOf(await t.contentsOf('/plain?n=4'));
    expect(kept === 1.5, 'zoom lost on navigation', kept);
    await t.user({ action: 'zoom', scope: A, tab: 'z1', factor: 1 });
    return { ...after, afterCrossOriginNavigation: kept };
  });

  await check('page shortcuts: ⌘F/⌘P reach the App, ⌘= zooms only that page, ⌘G/⇧⌘G only during find, Esc reported but kept by the page', async () => {
    const z1 = await t.contentsOf('/plain?n=4'), z2 = await t.contentsOf('/plain?n=2');
    await t.events();
    await t.sendKey(z1, 'F', ['meta']); await t.sendKey(z1, 'P', ['meta']); await t.sendKey(z1, '=', ['meta']);
    await delay(400);
    const events = (await t.events()).filter(event => ['shortcut', 'state'].includes(event.kind) && event.tab === 'z1');
    const shortcuts = events.filter(event => event.kind === 'shortcut').map(event => event.command);
    const zooms = { z1: await t.zoomOf(z1), z2: await t.zoomOf(z2) };
    expect(shortcuts.includes('find') && shortcuts.includes('print') && zooms.z1 === 1.1 && zooms.z2 === 1, 'shortcut wiring', { shortcuts, zooms });
    await t.user({ action: 'zoom', scope: A, tab: 'z1', factor: 1 });
    // ⌘G / ⇧⌘G / Escape belong to the page except during a find session.
    await t.inPage(z1, "window.__keys = []; addEventListener('keydown', event => window.__keys.push(event.key)); 1");
    await t.sendKey(z1, 'Escape', []); await t.sendKey(z1, 'G', ['meta']);
    const finding = await t.user({ action: 'find', scope: A, tab: 'z1', text: 'Plain', findNext: true });
    await t.events();
    await t.sendKey(z1, 'G', ['meta']); await t.sendKey(z1, 'G', ['meta', 'shift']); await t.sendKey(z1, 'Escape', []);
    await delay(300);
    const during = (await t.events()).filter(event => event.kind === 'shortcut' && event.tab === 'z1').map(event => event.command);
    await t.user({ action: 'stop_find', scope: A, tab: 'z1' });
    await t.sendKey(z1, 'Escape', []); await delay(200);
    const keys = await t.inPage(z1, 'window.__keys');
    // ⌘G/⇧⌘G are taken by the find bar; Escape is reported and still reaches the page.
    expect(finding.find?.matches >= 1 && JSON.stringify(during) === JSON.stringify(['find_next', 'find_prev', 'escape']) && JSON.stringify(keys) === JSON.stringify(['Escape', 'g', 'Escape', 'Escape']), 'find keys', { during, keys, finding: finding.find });
    // Synthetic sendInputEvent keys pass before-input-event: the Bot-side
    // contract refusal of ⌘/Ctrl+F/G/P/0 is therefore required, not cosmetic.
    return { shortcuts, zooms, duringFind: during, pageKeysOutsideFind: keys, syntheticKeysReachBeforeInputEvent: shortcuts.length > 0 };
  });

  await check('find: native ids, final counts, next/previous, case, supersession, stop and refresh after navigation', async () => {
    await t.user({ action: 'open', scope: A, tab: 'f', url: `${site}/find?v=1` });
    await t.layout([{ tab: 'f', ...pane }]);
    await t.events();
    const first = await t.user({ action: 'find', scope: A, tab: 'f', text: 'needle', findNext: true });
    expect(first.status === 'ok' && typeof first.findRequestId === 'number' && first.find?.matches === 6 && first.find.finalUpdate, 'first find', first);
    const next = await t.user({ action: 'find', scope: A, tab: 'f', text: 'needle', findNext: false, forward: true });
    const prev = await t.user({ action: 'find', scope: A, tab: 'f', text: 'needle', findNext: false, forward: false });
    const cased = await t.user({ action: 'find', scope: A, tab: 'f', text: 'NEEDLE', findNext: true, matchCase: true });
    expect(next.find?.activeMatchOrdinal === 2 && prev.find?.activeMatchOrdinal === 1 && cased.find?.matches === 1, 'next/prev/case', { next: next.find, prev: prev.find, cased: cased.find });
    const burst = await t.exec(`Promise.all(['n', 'ne', 'nee'].map((text, i) => window.tarobotDesktop.invoke('workbench_browser', { action: 'find', scope: ${JSON.stringify(A)}, tab: 'f', text, findNext: true, source: 'user', requestId: 'burst-' + i })))`);
    expect(burst.slice(0, 2).every(item => item.superseded === true) && burst[2].find?.matches >= 6 && !burst[2].superseded, 'supersession', burst.map(item => ({ id: item.findRequestId, superseded: item.superseded, find: item.find })));
    const events = (await t.events()).filter(event => event.kind === 'find');
    expect(!events.some(event => burst.slice(0, 2).some(item => item.findRequestId === event.requestId)), 'superseded results forwarded', events);
    const current = burst[2].findRequestId;
    await t.user({ action: 'navigate', scope: A, tab: 'f', url: `${site}/find?v=2` });
    await delay(500);
    const refreshed = (await t.events()).filter(event => event.kind === 'find' && event.requestId === current);
    await t.user({ action: 'stop_find', scope: A, tab: 'f' });
    await t.inPage(await t.contentsOf('/find?v=2'), 'document.body.append(" needle needle")'); await delay(300);
    const afterStop = (await t.events()).filter(event => event.kind === 'find');
    expect(afterStop.length === 0, 'events after stop', afterStop);
    return { firstId: first.findRequestId, matches: first.find.matches, nextActive: next.find.activeMatchOrdinal, prevActive: prev.find.activeMatchOrdinal, burst: burst.map(item => [item.findRequestId, !!item.superseded]), afterNavigation: refreshed.map(event => [event.navigation, event.matches, event.finalUpdate]) };
  });

  await check('device preview: letterboxed view, CSS viewport = preset at 100% and preset ÷ page zoom otherwise, Bot observe/click/screenshot stay on target', async () => {
    const id = await t.contentsOf('/find?v=2');
    const preview = await t.user({ action: 'device', scope: A, tab: 'f', preset: 'phone' });
    await delay(400);
    const view = (await t.views()).find(item => item.url?.includes('/find?v=2'));
    const width = await t.inPage(id, 'innerWidth');
    expect(preview.devicePreview?.preset === 'phone' && width === 390 && view.bounds.width < pane.width && view.bounds.height <= pane.height, 'preview geometry', { preview: preview.devicePreview, width, bounds: view.bounds });
    const observed = await t.bot({ action: 'observe', scope: A, tab: 'f' });
    const hit = observed.observation.elements.find(element => element.name === 'Hit');
    const clicked = await t.bot({ action: 'click', scope: A, tab: 'f', ref: hit.ref });
    const hits = await t.inPage(id, 'window.__hits');
    expect(clicked.status === 'ok' && hits.length === 1 && hits[0][2] === true && hits[0][0] >= 40 && hits[0][0] <= 160 && hits[0][1] >= 300 && hits[0][1] <= 360, 'Bot click off target', { clicked: clicked.status, hits });
    // Page zoom still applies inside a preview: 125% gives a 390 ÷ 1.25 = 312 CSS px viewport.
    await t.user({ action: 'zoom', scope: A, tab: 'f', factor: 1.25 }); await delay(300);
    const zoomedWidth = await t.inPage(id, 'innerWidth');
    await t.user({ action: 'zoom', scope: A, tab: 'f', factor: 1 }); await delay(300);
    expect(zoomedWidth === 312 && await t.inPage(id, 'innerWidth') === 390, 'preview with page zoom', { zoomedWidth });
    const shot = await t.bot({ action: 'screenshot', scope: A, tab: 'f' });
    const ratio = shot.image.width / shot.viewport.width, ratioY = shot.image.height / shot.viewport.height;
    expect(shot.viewport.width === 390 && Math.abs(ratio - ratioY) < 0.02, 'screenshot/viewport mismatch', { image: [shot.image.width, shot.image.height], viewport: shot.viewport });
    const tablet = await t.user({ action: 'device', scope: A, tab: 'f', preset: 'tablet', landscape: true }); await delay(300);
    const tabletWidth = await t.inPage(id, 'innerWidth');
    const off = await t.user({ action: 'device', scope: A, tab: 'f', preset: 'desktop' }); await delay(300);
    const desktopWidth = await t.inPage(id, 'innerWidth'), restored = (await t.views()).find(item => item.url?.includes('/find?v=2'));
    expect(tabletWidth === 1024 && off.devicePreview.preset === 'desktop' && restored.bounds.width === pane.width && desktopWidth === pane.width, 'tablet/desktop', { tabletWidth, desktopWidth, bounds: restored.bounds });
    return { phone: { scale: preview.devicePreview.scale, bounds: view.bounds, innerWidth: width, innerWidthAt125: zoomedWidth }, botClick: hits[0], screenshot: { image: [shot.image.width, shot.image.height], viewport: shot.viewport }, tabletLandscapeWidth: tabletWidth, desktopWidth };
  });

  await check('save screenshot: frozen PNG of the visible viewport, after a one-frame hidden layout; cancel is cancelled', async () => {
    const file = path.join(saved, 'viewport.png');
    await t.layout([{ tab: 'f', ...pane }], { hidden: true });
    await t.answerSave(file);
    const pending = t.user({ action: 'save_screenshot', scope: A, tab: 'f', english: true });
    await delay(80); await t.layout([{ tab: 'f', ...pane }]);
    const receipt = await pending;
    const bytes = await readFile(file), image = await t.pixel(file);
    expect(receipt.status === 'ok' && receipt.saved === true && receipt.name === 'viewport.png' && bytes.subarray(1, 4).toString() === 'PNG' && greenish(image.center), 'screenshot', { receipt, image });
    expect(!JSON.stringify(receipt).includes(root), 'local path leaked in receipt');
    const cancelled = await t.user({ action: 'save_screenshot', scope: A, tab: 'f' });
    expect(cancelled.status === 'cancelled' && cancelled.saved === false, 'cancel', cancelled);
    return { size: image.size, center: image.center, receiptWidth: receipt.width, bytes: bytes.length };
  });

  await check('print as PDF writes a real PDF where the person chose', async () => {
    const file = path.join(saved, 'page.pdf');
    await t.answerSave(file);
    const receipt = await t.user({ action: 'print', scope: A, tab: 'f', mode: 'pdf' });
    const bytes = await readFile(file);
    expect(receipt.status === 'ok' && receipt.saved === true && bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 1000, 'pdf', { receipt, bytes: bytes.length });
    return { bytes: bytes.length, name: receipt.name };
  });

  await check('history: committed visits of this conversation only, no fragments or token URLs; settings validated and per scope', async () => {
    await t.user({ action: 'open', scope: A, tab: 'h', url: `${site}/plain?n=10#frag` });
    await t.user({ action: 'navigate', scope: A, tab: 'h', url: `${site}/token?access_token=abc` });
    await t.user({ action: 'navigate', scope: A, tab: 'h', url: `${site}/missing` });
    await t.user({ action: 'navigate', scope: A, tab: 'h', url: `${site}/plain?n=11` });
    await t.user({ action: 'open', scope: B, tab: 'hb', url: `${site}/plain?n=20` });
    await t.user({ action: 'open', scope: H, tab: 'hh', url: `${site}/plain?n=30` });
    await delay(300);
    const history = await t.user({ action: 'history', scope: A, limit: 500 });
    const urls = history.entries.map(entry => entry.url);
    expect(urls.includes(`${site}/plain?n=10`) && urls.includes(`${site}/plain?n=11`) && !urls.some(url => url.includes('token') || url.includes('#') || url.includes('missing') || url.includes('n=20')), 'history contents', urls);
    expect(history.entries.find(entry => entry.url.endsWith('n=11'))?.title === 'Plain 11', 'title', history.entries);
    const other = await t.user({ action: 'history', scope: B });
    expect(other.entries.length === 1 && other.entries[0].url.endsWith('n=20'), 'scope B', other.entries);
    const set = await t.user({ action: 'settings_set', scope: A, settings: { searchEngine: 'duckduckgo', defaultZoom: 1.25, recordHistory: true } });
    const invalid = await t.user({ action: 'settings_set', scope: A, settings: { searchEngine: 'duckduckgo' } }).then(() => 'accepted', error => error.message);
    const settingsB = await t.user({ action: 'settings', scope: B });
    expect(set.settings.searchEngine === 'duckduckgo' && /invalid_browser_args/.test(invalid) && settingsB.settings.searchEngine === 'google', 'settings', { set: set.settings, invalid, settingsB: settingsB.settings });
    await t.user({ action: 'open', scope: A, tab: 'hz', url: `${site}/plain?n=12` });
    const zoom = await t.zoomOf(await t.contentsOf('/plain?n=12'));
    expect(zoom === 1.25, 'default zoom for a new page', zoom);
    await delay(1500); // debounce; the real App also flushes in prepareQuit
    return { urls, settings: set.settings, newPageZoom: zoom };
  });
} finally { await t.app.close().catch(() => {}); }

// Second launch on the same isolated profile: persisted history/settings, then clear and Host reset.
t = await launch();
try {
  await check('after relaunch: history and settings persisted; clear_history and Host reset remove only their own metadata', async () => {
    const history = await t.user({ action: 'history', scope: A, limit: 500 }), settings = await t.user({ action: 'settings', scope: A });
    expect(history.entries.length >= 3 && settings.settings.searchEngine === 'duckduckgo' && settings.settings.defaultZoom === 1.25, 'not persisted', { history: history.entries.length, settings: settings.settings });
    const store = path.join(await t.profile(), 'workbench-browser-user', 'v1'), before = await readdir(store);
    const cleared = await t.user({ action: 'clear_history', scope: A });
    const afterClear = { A: (await t.user({ action: 'history', scope: A })).entries.length, B: (await t.user({ action: 'history', scope: B })).entries.length, settings: (await t.user({ action: 'settings', scope: A })).settings.searchEngine };
    expect(cleared.removed === history.entries.length && afterClear.A === 0 && afterClear.B === 1 && afterClear.settings === 'duckduckgo', 'clear scope', { cleared, afterClear });
    const reset = await t.exec(`window.tarobotDesktop.invoke('workbench_browser_reset', ${JSON.stringify({ host: A.host, scopes: [A, B] })})`);
    const after = await readdir(store);
    const kept = (await t.user({ action: 'history', scope: H })).entries.length, gone = (await t.user({ action: 'history', scope: B })).entries.length;
    expect(!reset.failed.includes('history') && before.length === 2 && after.length === 1 && kept === 1 && gone === 0, 'reset', { reset, before, after, kept, gone });
    const files = await readdir(path.join(store, after[0]));
    return { removed: cleared.removed, hostDirsBefore: before.length, hostDirsAfter: after.length, otherHostFiles: files.length, reset };
  });
} finally { await t.app.close().catch(() => {}); server.close(); }

const summary = { binary: path.basename(path.dirname(path.dirname(path.dirname(binary)))), passed: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length, results,
  notCovered: ['system print dialog (needs a person)', 'real trackpad/wheel zoom-changed', 'App renderer UI (owned by the React layer)'] };
await writeFile(path.join(root, 'page-tools-smoke.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ passed: summary.passed, failed: summary.failed, failures: results.filter(item => !item.ok).map(item => ({ name: item.name, error: item.error })) }, null, 2));
if (summary.failed) process.exitCode = 1;
