import { test, expect, type Page } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import type { ViteDevServer } from 'vite';

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); url = server.resolvedUrls!.local[0] + 'e2e/fixtures/side-window-native.html';
});
test.afterAll(async () => { await server.close(); });

async function nativeFixture(page: Page, mode: 'expand' | 'maximized' | 'failed' | 'stall-size' | 'stall-close' | 'fail-close' = 'expand', surface = 'side', width = 1000) {
  await page.setViewportSize({ width, height: 700 });
  await page.addInitScript(mode => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let releaseSize!: () => void, heldSize = false;
    const sizeGate = new Promise<void>(resolve => { releaseSize = resolve; });
    const state = { width: innerWidth, height: 700, x: 30, y: 40, target: 0, maximized: mode === 'maximized', fullscreen: false };
    Object.assign(window, { isTauri: true, sideNative: { state, release, releaseSize }, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' } },
      invoke: async (command: string, args: any) => {
        await gate;
        if (mode === 'failed') throw Error('isolated native read failure');
        switch (command) {
          case 'plugin:window|outer_position': return { x: state.x, y: state.y };
          case 'plugin:window|inner_size': case 'plugin:window|outer_size': return { width: state.width, height: state.height };
          case 'plugin:window|scale_factor': return 1;
          case 'plugin:window|is_maximized': return state.maximized;
          case 'plugin:window|is_fullscreen': return state.fullscreen;
          case 'plugin:window|is_resizable': return true;
          case 'plugin:window|current_monitor': return { name: 'fixture', scaleFactor: 1, position: { x: 0, y: 0 }, size: { width: 2000, height: 1000 }, workArea: { position: { x: 0, y: 0 }, size: { width: 2000, height: 1000 } } };
          // Native frame acknowledgement can precede the WebView resize.
          case 'plugin:window|set_size':
            if (args.value.size.width === 1000 && mode === 'stall-close') await sizeGate;
            if (args.value.size.width === 1000 && mode === 'fail-close') throw Error('isolated close failure');
            state.width = state.target = args.value.size.width;
            if (mode === 'stall-size' && !heldSize) { heldSize = true; await sizeGate; }
            return;
          case 'plugin:window|set_position': state.x = args.value.position.x; state.y = args.value.position.y; return;
          default: throw Error(`Unexpected native command: ${command}`);
        }
      },
    } });
  }, mode);
  await page.goto(`${url}?surface=${surface}`);
  await expect(page.getByRole('button', { name: '侧边对话', exact: true })).toBeVisible();
}
const frames = async (page: Page) => {
  // Four real display frames can exceed the two-second fallback deadline in
  // background WebKit. Control the presentation clock for this normal-opening
  // scenario; the separate deadline scenarios below still use real timers.
  await page.evaluate(() => {
    const result: any[] = [];
    (window as any).sideFrameSamples = result;
    const sample = () => {
      const main = document.querySelector('.conversation-main')!, side = document.querySelector('.conversation-side-panel')!;
      const style = getComputedStyle(side), box = side.getBoundingClientRect();
      result.push({ viewport: innerWidth, layout: document.querySelector('.app-shell')?.getAttribute('data-side-window'), main: main.getBoundingClientRect().width,
        titleLeft: main.querySelector('.conversation-header > strong')!.getBoundingClientRect().left, left: box.left, right: box.right, visibility: style.visibility, opacity: style.opacity, animation: style.animationName });
      if (result.length < 4) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.clock.runFor(80);
  const result = await page.evaluate(() => (window as any).sideFrameSamples as Array<{viewport: number; layout: string; main: number; titleLeft: number; left: number; right: number; visibility: string; opacity: string; animation: string}>);
  expect(result).toHaveLength(4);
  return result;
};

for (const surface of ['side', 'workbench']) for (const width of [1000, 1200, 1500]) test(`${surface} at ${width}px opening waits for native geometry and starts its animation at the final right edge`, async ({ page }, info) => {
  await nativeFixture(page, 'expand', surface, width);
  const baseline = await page.locator('.conversation-main').evaluate(main => ({ width: main.getBoundingClientRect().width, titleLeft: main.querySelector('.conversation-header > strong')!.getBoundingClientRect().left }));
  const target = width + (width >= 1500 ? 440 : 400);
  const time = new Date('2026-10-29T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  const shell = page.locator('.app-shell'), side = page.locator('.conversation-side-panel');
  await expect(shell).toHaveAttribute('data-side-window', 'pending');
  const pending = await frames(page);
  await info.attach('before-native-read', { body: JSON.stringify(pending, null, 2), contentType: 'application/json' });
  expect.soft(pending.every(frame => frame.visibility === 'hidden')).toBe(true);
  expect.soft(pending.every(frame => frame.animation === 'none')).toBe(true);
  await page.evaluate(() => (window as any).sideNative.release());
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.target)).toBe(target);
  const acknowledged = await frames(page);
  await info.attach('native-ack-before-webview-resize', { body: JSON.stringify(acknowledged, null, 2), contentType: 'application/json' });
  expect.soft(acknowledged.every(frame => frame.layout === 'pending' && frame.visibility === 'hidden')).toBe(true);
  await page.setViewportSize({ width: width + 200, height: 700 });
  const intermediate = await frames(page);
  await info.attach('intermediate-resize', { body: JSON.stringify(intermediate, null, 2), contentType: 'application/json' });
  expect.soft(intermediate.every(frame => frame.layout === 'pending' && frame.visibility === 'hidden' && Math.abs(frame.main - baseline.width) < 2)).toBe(true);
  await page.setViewportSize({ width: target, height: 700 });
  await expect(shell).toHaveAttribute('data-side-window', 'expanded');
  await expect(side).toBeVisible();
  const settled = await frames(page);
  expect(settled.every(frame => frame.left >= width - 1 && Math.abs(frame.main - baseline.width) < 2 && frame.animation === 'details-enter')).toBe(true);
  for (const phase of [pending, acknowledged, intermediate, settled]) for (const frame of phase) expect.soft(frame.titleLeft, JSON.stringify(frame)).toBeCloseTo(baseline.titleLeft, 0);
  await page.screenshot({ path: info.outputPath('side-final-right-edge.png') });
  await page.getByRole('button', { name: '关闭侧边', exact: true }).click();
  await expect(side).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(width);
  await page.setViewportSize({ width, height: 700 });
  await expect.poll(() => page.locator('.conversation-header > strong').evaluate(title => title.getBoundingClientRect().left)).toBeCloseTo(baseline.titleLeft, 0);
});

for (const mode of ['maximized', 'failed'] as const) test(`${mode} resolves to a visible split without leaving the panel hidden`, async ({ page }) => {
  await nativeFixture(page, mode);
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  await page.evaluate(() => (window as any).sideNative.release());
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'split');
  await expect(page.locator('.conversation-side-panel')).toBeVisible();
  expect(await page.locator('.conversation-side-panel').evaluate(node => getComputedStyle(node).animationName)).toBe('details-enter');
});

test('missing WebView resize shows the panel without undoing an acknowledged native expansion', async ({ page }) => {
  await nativeFixture(page);
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  await page.evaluate(() => (window as any).sideNative.release());
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.target)).toBe(1400);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'split');
  await expect(page.locator('.conversation-side-panel')).toBeVisible();
  // The frame was acknowledged: the visibility deadline must not shrink it.
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1400);
  await page.setViewportSize({ width: 1400, height: 700 });
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'expanded');
  await page.getByRole('button', { name: '关闭侧边', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1000);
});

test('closing during native opening cannot reveal a stale panel after the delay', async ({ page }) => {
  await nativeFixture(page);
  const toggle = page.getByRole('button', { name: '侧边对话', exact: true });
  await toggle.click();
  await page.evaluate(() => (window as any).sideNative.release());
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.target)).toBe(1400);
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.target)).toBe(1000);
  await page.waitForTimeout(2_100); // Cross the cancelled reveal timer.
  await expect(page.locator('.conversation-side-panel')).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('data-side-window');
});


test('unanswered native geometry falls back and a late read cannot expand the window', async ({ page }) => {
  await nativeFixture(page);
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  // The native IPC remains pending: no geometry, rejection or resize arrives.
  await expect(page.locator('.conversation-side-panel')).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'split');
  await page.evaluate(() => (window as any).sideNative.release());
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as any).sideNative.state.width)).toBe(1000);
  expect(await page.evaluate(() => (window as any).sideNative.state.target)).toBe(0);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'split');
  await page.getByRole('button', { name: '关闭侧边', exact: true }).click();
  await expect(page.locator('.conversation-side-panel')).toHaveCount(0);
});


test('a resize applied before a delayed receipt is restored after the opening deadline', async ({ page }) => {
  await nativeFixture(page, 'stall-size');
  await page.evaluate(() => (window as any).sideNative.release());
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1400);
  await expect(page.locator('.conversation-side-panel')).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'split');
  await page.evaluate(() => (window as any).sideNative.releaseSize());
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1000);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'split');
});

test('closing before an unanswered read settles cancels the presentation deadline', async ({ page }) => {
  await nativeFixture(page);
  const toggle = page.getByRole('button', { name: '侧边对话', exact: true });
  await toggle.click(); await toggle.click();
  await page.waitForTimeout(2_100);
  await page.evaluate(() => (window as any).sideNative.release());
  await page.waitForTimeout(250);
  await expect(page.locator('.conversation-side-panel')).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('data-side-window');
  expect(await page.evaluate(() => (window as any).sideNative.state.target)).toBe(0);
});


test('workbench native page waits for the entry animation and receives settled bounds', async ({ page }) => {
  await nativeFixture(page, 'maximized', 'workbench');
  await page.evaluate(() => (window as any).sideNative.release());
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'split');
  await page.evaluate(async () => {
    const panel = document.querySelector<HTMLElement>('.workbench')!;
    await Promise.all(panel.getAnimations().map(animation => animation.finished));
    const layouts: any[] = []; (window as any).browserLayouts = layouts;
    Object.assign(window, { tarobotDesktop: { version: 1, engine: 'electron', platform: 'darwin', openSocket: async () => {}, on: () => () => {}, invoke: async (command: string, args: any) => { if (command === 'workbench_browser_layout') layouts.push(args); } } });
    const modulePath = '/src/workbench-browser.ts';
    const { registerBrowserSurface, scheduleBrowserLayout } = await import(modulePath);
    const viewport = document.createElement('div'); viewport.id = 'native-page'; viewport.style.cssText = 'height:200px;min-height:200px;width:100%'; panel.append(viewport);
    registerBrowserSurface('native-tab', viewport, () => true);
    // The actual Workbench schedules the same layout on its own animation end.
    panel.addEventListener('animationend', scheduleBrowserLayout);
    panel.style.animation = 'none'; panel.getBoundingClientRect();
    panel.style.animation = 'details-enter 500ms linear both'; scheduleBrowserLayout();
  });
  await expect.poll(() => page.evaluate(() => (window as any).browserLayouts[0]?.views)).toEqual([]);
  await expect.poll(() => page.evaluate(() => (window as any).browserLayouts.at(-1)?.views.length)).toBe(1);
  const result = await page.evaluate(() => { const rect = document.getElementById('native-page')!.getBoundingClientRect(); return { actual: (window as any).browserLayouts.at(-1).views[0], expected: { tab: 'native-tab', x: rect.x, y: rect.y, width: rect.width, height: rect.height } }; });
  expect(result.actual).toEqual(result.expected);
});

for (const surface of ['side', 'workbench']) test(`${surface} expansion keeps group navigation and message insets stable across 1500px`, async ({ page }) => {
  await nativeFixture(page, 'expand', surface, 1200);
  // The same group navigation/message containers as Chat, isolated from Hub data.
  await page.evaluate(() => {
    const header = document.querySelector('.conversation-header')!;
    const navigation = document.createElement('section'); navigation.className = 'group-topic-navigation';
    navigation.innerHTML = '<div class="topic-bar"><button class="group-breadcrumb"><span>审计讨论</span></button><nav class="topic-tabs"><button>默认讨论</button></nav></div>';
    header.after(navigation);
    const content = navigation.nextElementSibling as HTMLElement;
    content.className = 'message-scroll'; content.style.padding = '';
  });
  const measure = () => page.evaluate(() => {
    const topic = document.querySelector('.group-breadcrumb')!.getBoundingClientRect();
    const content = document.querySelector('.message-scroll')!;
    const style = getComputedStyle(content);
    return { topicLeft: topic.left, paddingTop: style.paddingTop, paddingLeft: style.paddingLeft };
  });
  const before = await measure();
  await page.evaluate(() => (window as any).sideNative.release());
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.target)).toBe(1600);
  await page.setViewportSize({ width: 1600, height: 700 });
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'expanded');
  expect(await measure()).toEqual(before);
  await page.getByRole('button', { name: '关闭侧边', exact: true }).click();
  await page.setViewportSize({ width: 1200, height: 700 });
  expect(await measure()).toEqual(before);
});

for (const surface of ['side', 'workbench']) test(`${surface} closing waits for the viewport to shrink before releasing the main width`, async ({ page }) => {
  await nativeFixture(page, 'expand', surface);
  const shell = page.locator('.app-shell'), main = page.locator('.conversation-main');
  const before = (await main.boundingBox())!.width;
  await page.evaluate(() => (window as any).sideNative.release());
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1400);
  await page.setViewportSize({ width: 1400, height: 700 });
  await expect(shell).toHaveAttribute('data-side-window', 'expanded');
  await page.getByRole('button', { name: '关闭侧边', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1000);
  // A native acknowledgement can precede the renderer resize. Keep the main
  // chat pinned until that resize, not just until the IPC promise resolves.
  await expect(shell).toHaveAttribute('data-side-window', 'restoring', { timeout: 500 });
  expect((await main.boundingBox())!.width).toBeCloseTo(before, 0);
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect(shell).not.toHaveAttribute('data-side-window');
  expect((await main.boundingBox())!.width).toBeCloseTo(before, 0);
});

for (const mode of ['stall-close', 'fail-close'] as const) test(`${mode} cannot leave a permanent blank column after closing`, async ({ page }) => {
  await nativeFixture(page, mode);
  await page.evaluate(() => (window as any).sideNative.release());
  await page.getByRole('button', { name: '侧边对话', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1400);
  await page.setViewportSize({ width: 1400, height: 700 });
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'expanded');
  await page.getByRole('button', { name: '关闭侧边', exact: true }).click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('data-side-window');
  expect(await page.locator('.app-shell').evaluate(node => node.getBoundingClientRect().width)).toBe(1400);
  if (mode === 'stall-close') {
    await page.evaluate(() => (window as any).sideNative.releaseSize());
    await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1000);
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect(page.locator('.app-shell')).not.toHaveAttribute('data-side-window');
  }
});

test('reopening before the close viewport event cannot clear the new panel geometry', async ({ page }) => {
  await nativeFixture(page);
  await page.evaluate(() => (window as any).sideNative.release());
  const toggle = page.getByRole('button', { name: '侧边对话', exact: true });
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1400);
  await page.setViewportSize({ width: 1400, height: 700 });
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'expanded');
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1000);
  // Reopen with Chromium still reporting the old wide viewport.
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1400);
  await page.setViewportSize({ width: 1400, height: 700 });
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'expanded');
  await page.waitForTimeout(2_100); // Outlive the old close deadline.
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'expanded');
  await expect(page.locator('.conversation-side-panel')).toBeVisible();
});

for (const surface of ['side','workbench']) test(`${surface} right window edge changes only the right panel width`, async ({page})=>{
  await nativeFixture(page,'expand',surface);
  const main=page.locator('.conversation-main'),panel=page.locator('.conversation-side-panel');
  const baseline=(await main.boundingBox())!.width;
  await page.evaluate(()=>(window as any).sideNative.release());
  await page.getByRole('button',{name:'侧边对话',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).sideNative.state.width)).toBe(1400);
  await page.setViewportSize({width:1400,height:700});
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window','expanded');
  for(const width of [1580,1320,1460]){
    await page.evaluate(width=>{(window as any).sideNative.state.width=width;},width);
    await page.setViewportSize({width,height:700});
    await expect.poll(async()=>(await main.boundingBox())!.width).toBeCloseTo(baseline,0);
    await expect.poll(async()=>(await panel.boundingBox())!.width).toBeCloseTo(width-1000,0);
  }
  await page.getByRole('button',{name:'关闭侧边',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).sideNative.state.width)).toBe(1000);
  await page.setViewportSize({width:1000,height:700});
  await expect.poll(async()=>(await main.boundingBox())!.width).toBeCloseTo(baseline,0);
});

test('an internal divider still changes allocation before subsequent right-edge resizing',async({page})=>{
 await nativeFixture(page);await page.evaluate(()=>(window as any).sideNative.release());
 await page.getByRole('button',{name:'侧边对话',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).sideNative.state.width)).toBe(1400);
 await page.setViewportSize({width:1400,height:700});await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window','expanded');
 const main=page.locator('.conversation-main'),separator=page.getByRole('separator',{name:'调整右侧栏宽度',exact:true});
 const original=(await main.boundingBox())!.width;await separator.focus();await separator.press('ArrowLeft');
 await expect.poll(async()=>(await main.boundingBox())!.width).toBeCloseTo(original-8,0);
 await page.evaluate(()=>(window as any).sideNative.state.width=1480);await page.setViewportSize({width:1480,height:700});
 await expect.poll(async()=>(await main.boundingBox())!.width).toBeCloseTo(original-8,0);
 await expect.poll(async()=>(await page.locator('.conversation-side-panel').boundingBox())!.width).toBeCloseTo(488,0);
});

for (const mode of ['maximized', 'fullscreen'] as const) for (const surface of ['side', 'workbench']) test(`${surface} ${mode} transition does not persist the viewport delta as panel width`, async ({page}) => {
  await nativeFixture(page, 'expand', surface);
  await page.evaluate(() => (window as any).sideNative.release());
  const toggle = page.getByRole('button', {name: '侧边对话', exact: true});
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1400);
  await page.setViewportSize({width: 1400, height: 700});
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'expanded');
  const choice = await page.evaluate(() => document.documentElement.style.getPropertyValue('--side-panel-width'));
  await page.evaluate(mode => { const state=(window as any).sideNative.state; state[mode]=true;state.width=1900; }, mode);
  await page.setViewportSize({width: 1900, height: 700});
  await expect.poll(() => page.locator('.conversation-side-panel').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(400);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--side-panel-width'))).toBe(choice);
  await toggle.click();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('data-side-window');
  await page.evaluate(mode => { const state=(window as any).sideNative.state;state[mode]=false;state.width=1400; }, mode);
  await page.setViewportSize({width: 1400, height: 700});
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window as any).sideNative.state.width)).toBe(1800);
  await page.setViewportSize({width: 1800, height: 700});
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window', 'expanded');
  await expect.poll(() => page.locator('.conversation-side-panel').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(400);
});

for (const surface of ['side', 'workbench']) test(`${surface} keeps chat width during delayed native resize mode readback`, async ({page},info) => {
  await nativeFixture(page,'expand',surface);
  await page.evaluate(()=>(window as any).sideNative.release());
  const main=page.locator('.conversation-main'), panel=page.locator('.conversation-side-panel');
  const original=(await main.boundingBox())!.width;
  await page.getByRole('button',{name:'侧边对话',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).sideNative.state.width)).toBe(1400);
  await page.setViewportSize({width:1400,height:700});
  await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window','expanded');
  await expect.poll(async()=>(await main.boundingBox())!.width).toBeCloseTo(original,0);
  await page.evaluate(()=>{
    const api=(window as any).__TAURI_INTERNALS__,native=(window as any).sideNative,invoke=api.invoke;
    const gate=new Promise<void>(resolve=>{native.releaseMode=resolve;});
    api.invoke=async(command:string,args:any)=>{if(command==='plugin:window|is_maximized') {native.readingMode=true;await gate;}return invoke(command,args);};
    native.state.width=1580;
  });
  await page.setViewportSize({width:1580,height:700});
  await expect.poll(()=>page.evaluate(()=>(window as any).sideNative.readingMode)).toBe(true);
  const waiting=(await main.boundingBox())!.width;
  await info.attach('mode-readback-width',{body:JSON.stringify({original,waiting,surface}),contentType:'application/json'});
  expect.soft(waiting).toBeCloseTo(original,0);
  await page.evaluate(()=>(window as any).sideNative.releaseMode());
  await expect.poll(async()=>(await main.boundingBox())!.width).toBeCloseTo(original,0);
  await expect.poll(async()=>(await panel.boundingBox())!.width).toBeCloseTo(580,0);
});

for (const closeEarly of [false,true]) test(`resize hold is released after ${closeEarly ? 'closing before readback' : 'an unanswered mode read'}`, async ({page}) => {
  await nativeFixture(page);
  await page.evaluate(()=>(window as any).sideNative.release());
  const toggle=page.getByRole('button',{name:'侧边对话',exact:true}),shell=page.locator('.app-shell');
  await toggle.click();
  await expect.poll(()=>page.evaluate(()=>(window as any).sideNative.state.width)).toBe(1400);
  await page.setViewportSize({width:1400,height:700});await expect(shell).toHaveAttribute('data-side-window','expanded');
  await page.evaluate(()=>{
    const api=(window as any).__TAURI_INTERNALS__,native=(window as any).sideNative,invoke=api.invoke;
    const gate=new Promise<void>(resolve=>{native.releaseMode=resolve;});let first=true;
    api.invoke=async(command:string,args:any)=>{if(command==='plugin:window|is_maximized'&&first){first=false;await gate;}return invoke(command,args);};
    native.state.width=1580;
  });
  const chosen=await page.evaluate(()=>document.documentElement.style.getPropertyValue('--side-panel-width'));
  await page.setViewportSize({width:1580,height:700});await expect(shell).toHaveAttribute('data-side-window-resizing','true');
  if(closeEarly) await toggle.click();
  await expect(shell).not.toHaveAttribute('data-side-window-resizing');
  expect(await shell.evaluate(el=>(el as HTMLElement).style.getPropertyValue('--side-window-resize-base-width'))).toBe('');
  await page.evaluate(()=>(window as any).sideNative.releaseMode());
  expect(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--side-panel-width'))).toBe(chosen);
  if(!closeEarly) await toggle.click();
  await expect.poll(()=>page.evaluate(()=>(window as any).sideNative.state.width)).toBe(1000);
  await page.setViewportSize({width:1000,height:700});await expect(shell).not.toHaveAttribute('data-side-window');
});

test('a cached hidden panel cannot steal observation from the visible dock',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await nativeFixture(page,'expand','workbench');await page.evaluate(()=>(window as any).sideNative.release());
  await page.getByRole('button',{name:'侧边对话',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).sideNative.state.width)).toBe(1400);
  await page.setViewportSize({width:1400,height:700});await expect(page.locator('.app-shell')).toHaveAttribute('data-side-window','expanded');
  await page.evaluate(()=>{
    const active=document.querySelector('.conversation-side-panel')!,hidden=document.createElement('aside');
    hidden.className='conversation-side-panel workbench';hidden.hidden=true;active.before(hidden);
  });
  const main=page.locator('.conversation-main');
  const separator=page.getByRole('separator',{name:'调整右侧栏宽度',exact:true});await separator.focus();await separator.press('ArrowLeft');
  await expect.poll(async()=>(await main.boundingBox())!.width).toBeCloseTo(720,0);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await page.evaluate(()=>{
    const api=(window as any).__TAURI_INTERNALS__,native=(window as any).sideNative,invoke=api.invoke;
    const gate=new Promise<void>(resolve=>{native.releaseMode=resolve;});
    api.invoke=async(command:string,args:any)=>{if(command==='plugin:window|is_maximized'){native.readingMode=true;await gate;}return invoke(command,args);};
    native.state.width=1580;
  });
  await page.setViewportSize({width:1580,height:700});await expect.poll(()=>page.evaluate(()=>(window as any).sideNative.readingMode)).toBe(true);
  expect((await main.boundingBox())!.width).toBeCloseTo(720,0);
  await page.evaluate(()=>(window as any).sideNative.releaseMode());
  await expect.poll(async()=>(await main.boundingBox())!.width).toBeCloseTo(720,0);
  expect(errors).toEqual([]);
});
