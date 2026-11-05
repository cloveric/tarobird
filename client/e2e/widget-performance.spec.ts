import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { widgetBlock } from '../../src/client-protocol/widget.js';
import { openMobileHome, selectConversation, showDisconnectedBots, waitForClientOnline } from './fixtures/mobile.js';

// DOM snapshot traces distort frame and allocation measurements.
test.use({ serviceWorkers: 'block', trace: 'off' });
const pulse = '<p>本地交互报告</p><div style="height:160px"></div><script>window.widgetTicks=0;setInterval(()=>window.widgetTicks++,20)</script>';
async function fixture(page: Page, count = 1, html = pulse) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'widget-performance-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','性能助手','fixture')");
  const report = await hub.store.createConversation('owner', ['alpha'], '交互性能', 'report');
  const plain = await hub.store.createConversation('owner', ['alpha'], '普通聊天', 'plain');
  for (let index = 0; index < count; index++) await hub.store.publishBotMessage('alpha', {
    id: `widget_${index}`, conversationId: report.id,
    blocks: [widgetBlock({ title: `报告 ${index}`, summary: `第 ${index} 份报告的文字摘要`, html })], status: 'complete',
  });
  await hub.store.publishBotMessage('alpha', { conversationId: plain.id, blocks: [{ type: 'text', text: '普通聊天仍然可用' }], status: 'complete' });
  await page.addInitScript(() => {
    const receipt = { initCount: 0, initBytes: 0, heights: 0, extraPayload: false };
    Object.assign(window, { widgetPerformanceReceipt: receipt });
    addEventListener('message', event => {
      if (event.data?.type === 'tarobot-widget-init') { receipt.initCount++; receipt.initBytes += event.data.document?.length ?? 0; }
      if (event.data?.type === 'tarobot-widget-height') { receipt.heights++; receipt.extraPayload ||= 'extra' in event.data; }
    });
  });
  await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, report.title);
  return { hub, report, plain, dispose: async () => { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
const guest = (page: Page) => page.frameLocator('.widget-panel:visible > iframe').frameLocator('iframe');

for (const trigger of ['load', 'click', 'hover']) test(`an incidental ${trigger} error keeps the report interactive`, async ({ page }) => {
  const html = `<p id="value">ready</p><button id="ok" onclick="document.getElementById('value').textContent='usable'">检查交互</button>
    <button id="error" ${trigger === 'hover' ? 'onmouseenter' : 'onclick'}="throw new Error('optional handler')">可选操作</button>
    ${trigger === 'load' ? '<script>throw new TypeError("optional setup")</script>' : ''}`;
  const f = await fixture(page, 1, html);
  try {
    await expect(guest(page).locator('#value')).toHaveText('ready');
    if (trigger === 'click') await guest(page).locator('#error').click();
    if (trigger === 'hover') await guest(page).locator('#error').hover();
    await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toBeVisible();
    await guest(page).locator('#ok').click();
    await expect(guest(page).locator('#value')).toHaveText('usable');
    await expect(page.locator('.widget-panel > iframe')).toHaveCount(1);
  } finally { await f.dispose(); }
});

test('repeated runtime failures retire the guest and retry only on request', async ({ page }) => {
  const f = await fixture(page, 1, '<button onclick="setInterval(()=>{throw new Error(\'fixture failure\')},50)">触发错误</button><script>window.widgetTicks=0;setInterval(()=>window.widgetTicks++,20)</script>');
  try {
    await expect(guest(page).getByRole('button', { name: '触发错误' })).toBeVisible();
    await guest(page).getByRole('button', { name: '触发错误' }).click();
    await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toBeVisible();
    await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
    await expect(page.locator('.widget-summary').getByText('第 0 份报告的文字摘要', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '放大交互组件' }).click();
    await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
    await page.getByRole('button', { name: '重新加载组件' }).click();
    await expect(guest(page).getByRole('button', { name: '触发错误' })).toBeVisible();
    await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toHaveCount(0);
    await guest(page).getByRole('button', { name: '触发错误' }).click();
    await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
    await f.hub.store.publishBotMessage('alpha', { id: 'widget_0', conversationId: f.report.id,
      blocks: [widgetBlock({ title: '报告 0', summary: '修正后的摘要', html: '<p>修正后的组件</p>' })], status: 'complete' });
    await expect(guest(page).getByText('修正后的组件', { exact: true })).toBeVisible();
  } finally { await f.dispose(); }
});

test('each widget document is serialized and sent only once per frame load', async ({ page }, info) => {
  // WebKit does not run Playwright's addInitScript inside this sandboxed
  // response. Add a passive observer before the unchanged relay script.
  await page.route('**/widget-sandbox.html', async route => {
    const response = await route.fetch();
    const instrument = `window.widgetPerformanceReceipt={initCount:0,initBytes:0};addEventListener('message',event=>{if(event.data?.type==='tarobot-widget-init'){window.widgetPerformanceReceipt.initCount++;window.widgetPerformanceReceipt.initBytes+=event.data.document.length}});`;
    await route.fulfill({ response, body: (await response.text()).replace('<script>', '<script>' + instrument) });
  });
  const f = await fixture(page, 1, '<p>ready</p>' + '<!--' + 'x'.repeat(120000) + '-->');
  try {
    await expect(guest(page).getByText('ready', { exact: true })).toBeVisible();
    const outer = page.frames().find(frame => frame.url().endsWith('/widget-sandbox.html'))!;
    const receipt = await outer.evaluate(() => (window as any).widgetPerformanceReceipt);
    await info.attach('initialization', { body: JSON.stringify(receipt), contentType: 'application/json' });
    expect(receipt.initCount).toBe(1);
  } finally { await f.dispose(); }
});

test('phone inbox retires guest timers and returning to chat restores the report', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  try {
    await expect(guest(page).getByText('本地交互报告', { exact: true })).toBeVisible();
    const frame = page.frames().find(frame => frame.url() === 'about:srcdoc')!;
    const before = await frame.evaluate(() => (window as any).widgetTicks);
    await openMobileHome(page);
    if (!frame.isDetached()) {
      await page.waitForTimeout(500);
      const after = frame.isDetached() ? undefined : await frame.evaluate(() => (window as any).widgetTicks);
      await info.attach('hidden-timers', { body: JSON.stringify({ before, after, ticksWhileHidden: after === undefined ? 0 : after - before }), contentType: 'application/json' });
    }
    await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
    await selectConversation(page, f.report.title);
    await expect(guest(page).getByText('本地交互报告', { exact: true })).toBeVisible();
  } finally { await f.dispose(); }
});

test('long widget history only runs frames near the visible viewport', async ({ page }, info) => {
  const f = await fixture(page, 40);
  try {
    await expect(page.locator('.inline-widget').last()).toBeVisible();
    await expect.poll(() => page.frames().filter(frame => frame.url().endsWith('/widget-sandbox.html')).length).toBeGreaterThan(0);
    // Wait for each mounted report to finish measuring its initial height.
    await expect(page.getByText('正在加载交互组件…')).toHaveCount(0);
    // Height messages can trigger scroll anchoring after the loading label
    // disappears. IntersectionObserver retires those frames on its next delivery.
    const measurements: { top: number; bottom: number; visible: boolean }[][] = [];
    try {
      await expect.poll(async () => {
        const receipt = await page.locator('.widget-panel > iframe').evaluateAll(nodes => nodes.map(node => {
          const box = node.getBoundingClientRect(), viewport = node.closest('.message-scroll')?.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, visible: !!viewport && box.bottom > viewport.top && box.top < viewport.bottom };
        }));
        measurements.push(receipt);
        return receipt.filter(frame => !frame.visible).length;
      }).toBeLessThanOrEqual(1);
    } finally { await info.attach('mounted-frames', { body: JSON.stringify(measurements), contentType: 'application/json' }); }
    await selectConversation(page, f.plain.title);
    await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
    expect(page.frames()).toHaveLength(1);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('仍然可以输入');
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('仍然可以输入');
  } finally { await f.dispose(); }
});

test('the latest observation in a visibility batch controls widget execution', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.IntersectionObserver;
    const callbacks = new Map<Element, (visible: boolean[]) => void>();
    Object.assign(window, { deliverWidgetVisibility: (visible: boolean[]) => { for (const notify of callbacks.values()) notify(visible); } });
    window.IntersectionObserver = class extends Original {
      private readonly targets = new Set<Element>();
      constructor(private readonly notify: IntersectionObserverCallback, options?: IntersectionObserverInit) { super(notify, options); }
      observe(target: Element) {
        super.observe(target);
        if (!target.matches('.inline-widget')) return;
        this.targets.add(target);
        callbacks.set(target, visible => this.notify(visible.map((value, index) => ({
          target, time: performance.now() + index, isIntersecting: value, intersectionRatio: value ? 1 : 0,
          boundingClientRect: target.getBoundingClientRect(), rootBounds: null,
          intersectionRect: value ? target.getBoundingClientRect() : new DOMRect(),
        })), this));
      }
      disconnect() { super.disconnect(); for (const target of this.targets) callbacks.delete(target); }
    };
  });
  const f = await fixture(page);
  try {
    await expect(guest(page).getByText('本地交互报告', { exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).deliverWidgetVisibility([true, false]));
    await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
    await page.evaluate(() => (window as any).deliverWidgetVisibility([false, true]));
    await expect(guest(page).getByText('本地交互报告', { exact: true })).toBeVisible();
  } finally { await f.dispose(); }
});

// IntersectionObserver reports an edge-touching target as intersecting with a
// zero-area rectangle. With only the default 0 threshold, scrolling further in
// changes neither isIntersecting nor the threshold index, so no newer
// observation arrives. Real observer, real App and Hub; only scroll positions.
for (const route of ['direct', 'edge']) test(`a report that re-enters ${route === 'edge' ? 'exactly at the scroll edge' : 'directly'} starts once visible`, async ({ page }, info) => {
  const f = await fixture(page);
  try {
    await expect(guest(page).getByText('本地交互报告', { exact: true })).toBeVisible();
    for (let index = 0; index < 6; index++) await f.hub.store.publishBotMessage('alpha', { conversationId: f.report.id, blocks: [{ type: 'text', text: `后续消息 ${index}\n` + '用于滚动的较长内容。'.repeat(40) }], status: 'complete' });
    const scroll = page.locator('.message-scroll');
    await expect(scroll.getByText('后续消息 5')).toBeVisible();
    // A reader's upward wheel stops tail following; exact positions follow.
    await scroll.hover(); await page.mouse.wheel(0, -40);
    await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible();
    const geometry = () => scroll.evaluate(node => {
      const box = node.getBoundingClientRect(), clipTop = box.top + node.clientTop, section = node.querySelector('.inline-widget')?.getBoundingClientRect();
      return { scrollTop: node.scrollTop, clipTop, clipBottom: clipTop + node.clientHeight, top: section?.top, bottom: section?.bottom };
    });
    // Place the report just above the visible area; the virtual list keeps it mounted.
    const scrollBy = (delta: number) => scroll.evaluate((node, delta) => { node.scrollTop += delta; }, delta);
    const offset = async () => { const g = await geometry(); return g.bottom! - g.clipTop; };
    await scrollBy(await offset() + 120);
    await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
    await expect(page.locator('.inline-widget')).toHaveCount(1);
    // Return exactly to the edge: the section bottom touches the clip top.
    let edge: Awaited<ReturnType<typeof geometry>> | undefined;
    if (route === 'edge') await expect.poll(async () => {
      // The virtual list can commit a pending row measurement after the first
      // scroll. Establish the real edge geometry before testing IO re-entry;
      // a missed target is not evidence that the widget failed to restart.
      await scrollBy(await offset()); edge = await geometry();
      return edge.bottom! - edge.clipTop;
    }).toBe(0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))));
    await scrollBy(await offset() - 150);
    const visible = await geometry();
    await info.attach('edge-geometry', { body: JSON.stringify({ edge, visible }), contentType: 'application/json' });
    if (edge) expect(edge.bottom).toBe(edge.clipTop);
    expect(visible.bottom! - visible.clipTop).toBeGreaterThan(100);
    await expect(guest(page).getByText('本地交互报告', { exact: true })).toBeVisible({ timeout: 4000 });
  } finally { await f.dispose(); }
});

test('repeated conversation switches release guest documents and listeners', async ({ page, browserName }, info) => {
  const f = await fixture(page);
  const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
  try {
    const snapshots: unknown[] = [];
    for (let iteration = 0; iteration <= 25; iteration++) {
      await selectConversation(page, f.report.title);
      await expect(guest(page).getByText('本地交互报告', { exact: true })).toBeVisible();
      await selectConversation(page, f.plain.title);
      await expect(page.locator('.message-blocks').getByText('普通聊天仍然可用', { exact: true })).toBeVisible();
      await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
      await expect.poll(() => page.frames().length).toBe(1);
      // Warm the ordinary App's lazy controls before comparing retained
      // listeners; do not compare a loading skeleton against a settled chat.
      if (session && [5, 15, 25].includes(iteration)) {
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await session.send('HeapProfiler.collectGarbage');
        const dom = await session.send('Memory.getDOMCounters');
        const heap = await session.send('Runtime.getHeapUsage');
        snapshots.push({ iteration, ...dom, heapUsedBytes: heap.usedSize });
      }
    }
    await info.attach('retention', { body: JSON.stringify(snapshots), contentType: 'application/json' });
    if (snapshots.length) {
      const first = snapshots[0] as { jsEventListeners: number; documents: number };
      const last = snapshots.at(-1) as typeof first;
      expect(last.documents).toBeLessThanOrEqual(first.documents + 1);
      expect(last.jsEventListeners).toBeLessThanOrEqual(first.jsEventListeners + 10);
    }
  } finally { await session?.detach(); await f.dispose(); }
});

test('ordinary chat, one static report and six ADHD reports expose measured idle cost', async ({ page, browserName, browser }, info) => {
  test.skip(browserName !== 'chromium', 'Chromium process CPU metrics; behavioral tests also run in WebKit');
  await page.setViewportSize({ width: 2400, height: 1000 });
  const f = await fixture(page, 1, await readFile(new URL('../../docs/examples/widget-release-timeline.html', import.meta.url), 'utf8'));
  const processSession = await browser.newBrowserCDPSession();
  const session = await page.context().newCDPSession(page);
  let attached = 0, detached = 0;
  page.on('frameattached', () => attached++);
  page.on('framedetached', () => detached++);
  try {
    const receipts: unknown[] = [];
    const measure = async (name: string) => {
      // Keep layout/pairing/draft setup outside the steady-state sample.
      await page.waitForTimeout(300);
      const frameStart = { attached, detached };
      const heightsBefore = await page.evaluate(() => (window as any).widgetPerformanceReceipt.heights);
      if (process.env.TAROBOT_WIDGET_PROFILE) { await session.send('Profiler.enable'); await session.send('Profiler.start'); }
      const processes = async () => (await processSession.send('SystemInfo.getProcessInfo')).processInfo;
      const before = await processes(), started = performance.now();
      const frames = await page.evaluate(() => new Promise<number[]>(resolve => {
        const frames: number[] = []; const started = performance.now(); let previous = started;
        const tick = (now: number) => { frames.push(now - previous); previous = now; if (now - started < 2000) requestAnimationFrame(tick); else resolve(frames); };
        requestAnimationFrame(tick);
      }));
      const elapsed = performance.now() - started, after = await processes();
      if (process.env.TAROBOT_WIDGET_PROFILE) {
        const { profile } = await session.send('Profiler.stop');
        await writeFile(info.outputPath(`${name}.cpuprofile`), JSON.stringify(profile));
      }
      const activity = { attached: attached - frameStart.attached, detached: detached - frameStart.detached, heights: await page.evaluate(() => (window as any).widgetPerformanceReceipt.heights) - heightsBefore };
      const cpuMs = after.reduce((sum, process) => sum + Math.max(0, process.cpuTime - (before.find(old => old.id === process.id)?.cpuTime ?? process.cpuTime)) * 1000, 0);
      frames.sort((a, b) => a - b);
      const inputs: number[] = [];
      const composer = page.locator('textarea[aria-label]:visible').last();
      for (let i = 0; i < 10; i++) { const start = performance.now(); await composer.fill(`输入响应 ${i}`); inputs.push(performance.now() - start); }
      inputs.sort((a, b) => a - b);
      await session.send('HeapProfiler.collectGarbage');
      const dom = await session.send('Memory.getDOMCounters');
      const heap = await session.send('Runtime.getHeapUsage');
      receipts.push({ name, activity, browserProcesses: after.length, cpuMs, elapsedMs: elapsed, cpuPercentOneCore: cpuMs / elapsed * 100, frames: page.frames().length, frameP95: frames[Math.floor(frames.length * .95)], inputP95: inputs[Math.floor(inputs.length * .95)], inputSamples: inputs, ...dom, heapUsedBytes: heap.usedSize });
      await writeFile(info.outputPath('widget-load.json'), JSON.stringify(receipts, null, 2));
    };
    await selectConversation(page, f.plain.title); await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
    await measure('ordinary');
    await selectConversation(page, f.report.title); await expect(guest(page).locator('#delivery')).toBeVisible();
    await measure('one-static-widget');
    const conversations = [f.report];
    for (let i = 2; i <= 6; i++) {
      const conversation = await f.hub.store.createConversation('owner', ['alpha'], `并行报告 ${i}`, `parallel_${i}`);
      conversations.push(conversation);
      await f.hub.store.publishBotMessage('alpha', { conversationId: conversation.id, blocks: [widgetBlock({ title: `报告 ${i}`, summary: '测试数据', html: await readFile(new URL('../../docs/examples/widget-release-timeline.html', import.meta.url), 'utf8') })], status: 'complete' });
    }
    // These fixtures call Store directly rather than the Hub HTTP route that
    // broadcasts conversation changes; reload to fetch the updated directory.
    await page.reload(); await waitForClientOnline(page);
    await page.getByRole('button', { name: '打开 ADHD 模式', exact: true }).click();
    await page.getByRole('checkbox', { name: /加入面板：.*交互性能/ }).check();
    for (let i = 2; i <= 6; i++) await page.getByRole('checkbox', { name: new RegExp(`加入面板：.*并行报告 ${i}`) }).check();
    await page.getByRole('combobox', { name: 'ADHD 每行窗口数' }).selectOption('6');
    await expect(page.locator('.adhd-card')).toHaveCount(6);
    await expect(page.locator('.widget-panel > iframe')).toHaveCount(6);
    await expect(page.getByText('正在加载交互组件…')).toHaveCount(0);
    await measure('six-static-widgets');
    // Compare against six ordinary panes too: one chat vs six widgets alone
    // would conflate the board's own cost with the incremental widget cost.
    for (const conversation of conversations) {
      const message = (await f.hub.store.snapshot('owner', conversation.id)).messages.find(message => message.authorType === 'bot')!;
      await f.hub.store.publishBotMessage('alpha', { id: message.id, conversationId: conversation.id, blocks: [{ type: 'text', text: '本周交付共 24 项，10 月 20 日完成 8 项。普通文字报告。' }], status: 'complete' });
    }
    await page.reload(); await waitForClientOnline(page);
    await page.getByRole('button', { name: '打开 ADHD 模式', exact: true }).click();
    await expect(page.locator('.adhd-card')).toHaveCount(6);
    await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
    await measure('six-ordinary-panes');
    await info.attach('widget-load', { body: JSON.stringify(receipts, null, 2), contentType: 'application/json' });
    console.log('Widget load', JSON.stringify(receipts));
  } finally { await session.detach().catch(() => {}); await processSession.detach().catch(() => {}); await f.dispose(); }
});

test('bounded busy guest records the renderer CPU-isolation boundary', async ({ page }, info) => {
  test.skip(!process.env.TAROBOT_WIDGET_CPU_PROBE, 'Opt-in bounded 1.2-second stress; never run in the production App');
  const f = await fixture(page, 1, '<button onclick="setTimeout(()=>{const end=performance.now()+1200;while(performance.now()<end){}},100)">限时计算</button>');
  try {
    await guest(page).getByRole('button', { name: '限时计算' }).click();
    const parentTimerMs = await page.evaluate(() => new Promise<number>(resolve => { const start = performance.now(); setTimeout(() => resolve(performance.now() - start), 250); }));
    await info.attach('cpu-isolation', { body: JSON.stringify({ guestBusyMs: 1200, parentTimerTargetMs: 250, parentTimerMs }), contentType: 'application/json' });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('限时计算结束后仍可输入');
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('限时计算结束后仍可输入');
  } finally { await f.dispose(); }
});

test('the relay bounds height bursts and does not forward arbitrary guest payloads', async ({ page }, info) => {
  const f = await fixture(page, 1, '<p>已加载报告</p>');
  try {
    await expect(guest(page).getByText('已加载报告')).toBeVisible();
    await page.evaluate(() => { (window as any).widgetPerformanceReceipt.heights = 0; });
    const frame = page.frames().find(frame => frame.url() === 'about:srcdoc')!;
    await frame.evaluate(() => {
      const key = JSON.parse(document.scripts[0]!.textContent!.match(/"key":("[^"]+")/)![1]!);
      for (let i = 0; i < 500; i++) parent.postMessage({type:'tarobot-widget-height', key, height:100+i, extra:'x'.repeat(4096)}, '*');
    });
    await expect.poll(() => page.evaluate(() => (window as any).widgetPerformanceReceipt.heights)).toBeGreaterThan(0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const receipt = await page.evaluate(() => (window as any).widgetPerformanceReceipt);
    await info.attach('relay-burst', { body: JSON.stringify(receipt), contentType: 'application/json' });
    expect(receipt.heights).toBeLessThan(8);
    expect(receipt.extraPayload).toBe(false);
  } finally { await f.dispose(); }
});

test('alternating viewport-height rules settle instead of resizing indefinitely', async ({ page }, info) => {
  const f = await fixture(page, 1, '<style id="size">body{min-height:260px}@media(max-height:400px){body{min-height:520px}}</style><p>响应式报告</p><button onclick="document.getElementById(\'size\').textContent=\'body{min-height:640px}\'">展开明细</button><script>setTimeout(()=>document.documentElement.dataset.measured="ready",1200)</script>');
  try {
    await expect(guest(page).locator('html')).toHaveAttribute('data-measured', 'ready');
    const before = await page.evaluate(() => (window as any).widgetPerformanceReceipt.heights);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => (window as any).widgetPerformanceReceipt.heights);
    await info.attach('height-cycle', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
    expect(after - before).toBeLessThanOrEqual(1);
    expect(await page.locator('.widget-panel > iframe').evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(720);
    await guest(page).getByRole('button', { name: '展开明细' }).click();
    await expect.poll(() => page.locator('.widget-panel > iframe').evaluate(node => node.getBoundingClientRect().height)).toBe(640);
  } finally { await f.dispose(); }
});
