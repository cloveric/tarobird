import { test, expect } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import type { ViteDevServer } from 'vite';
let server: ViteDevServer, url: string;
test.use({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: 'phone-panels', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith('/__phone-panels')) return next();
    res.setHeader('Content-Type', 'text/html');
    res.end(await vite.transformIndexHtml('/__phone-panels', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/diff-viewer.tsx"></script><script type="module">import "/src/brand-theme.css";import "/src/palette-tokens.css";import "/src/safe-area.css";import "/src/viewport.css";import "/src/delegation.css";</script></body></html>'));
  }); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); url = server.resolvedUrls!.local[0] + '__phone-panels';
});
test.afterAll(async () => { await server.close(); });
for (const width of [390, 430]) test(`phone diff uses full height and reserves safe edges at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 932 }); await page.goto(url);
  await page.evaluate(() => { const root = document.documentElement; root.style.setProperty('--safe-area-inset-top', '59px'); root.style.setProperty('--safe-area-inset-bottom', '34px'); });
  const dialog = page.locator('dialog.diff-viewer');
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(node => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })).toEqual({ top: 0, bottom: 932 });
  expect((await dialog.locator('header h2').boundingBox())!.y).toBeGreaterThanOrEqual(59);
  await expect(dialog.locator('.diff-files')).toHaveCSS('padding-bottom', '42px');
  await page.screenshot({ path: info.outputPath(`diff-safe-${width}.png`) });
  await page.getByRole('button', { name: /src\/components\/ReviewPanel/ }).click();
  await expect(dialog.locator('.diff-code-scroll')).toHaveCSS('padding-bottom', '34px');
});
test('phone collaboration header stays below status bar when keyboard opens', async ({ page }, info) => {
  await page.goto(url); await expect(page.locator('dialog.diff-viewer')).toBeVisible();
  // Isolates the production CSS cascade; delegation.spec covers real Hub actions.
  await page.evaluate(() => {
    document.querySelector('dialog')?.close();
    const root = document.documentElement; root.style.setProperty('--safe-area-inset-top', '59px'); root.style.setProperty('--safe-area-inset-bottom', '34px');
    const dialog = document.createElement('dialog'); dialog.className = 'creation-dialog delegation-dialog';
    dialog.innerHTML = '<header><h2>发起 Bot 协作</h2><button>关闭</button></header><div class="delegation-scroll"><label>协作任务<textarea></textarea></label></div><footer class="delegation-footer"><button>发送协作任务</button></footer>';
    document.body.append(dialog); dialog.showModal();
  });
  const dialog = page.locator('dialog.delegation-dialog');
  for (const height of [932, 550, 932, 550]) {
    await page.evaluate(height => { const root = document.documentElement; root.dataset.keyboardOpen = String(height < 932); root.style.setProperty('--app-height', `${height}px`); }, height);
    expect((await dialog.locator('header').boundingBox())!.y).toBeGreaterThanOrEqual(59);
    expect(await dialog.evaluate(node => node.getBoundingClientRect().bottom)).toBeCloseTo(height, 0);
  }
  await page.screenshot({ path: info.outputPath('delegation-keyboard-safe.png') });
});

test('native overlay keyboard reveals a lower form field without scrolling the document', async ({ page }) => {
  await page.goto(url); await expect(page.locator('dialog.diff-viewer')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(async () => {
    document.querySelector('dialog')?.close();
    const { installAppViewport } = await import('/src/viewport.ts');
    const controller = installAppViewport(window, document, true);
    const callbacks = new Map<string, (info: { keyboardHeight: number }) => void>();
    await controller.attachKeyboard({ addListener: async (event, callback) => { callbacks.set(event, callback); return { remove: async () => { callbacks.delete(event); } }; } });
    (window as any).formKeyboard = (height: number) => {
      callbacks.get(height ? 'keyboardWillShow' : 'keyboardWillHide')?.({ keyboardHeight: height });
      callbacks.get(height ? 'keyboardDidShow' : 'keyboardDidHide')?.({ keyboardHeight: height });
    };
    const dialog = document.createElement('dialog'); dialog.className = 'creation-dialog';
    dialog.innerHTML = '<header><h2>Long form</h2></header><div style="height:500px"></div><label>Workspace<input aria-label="Workspace" value="retained draft"></label><p style="height:60px">Footer</p>';
    document.body.append(dialog); dialog.showModal();
    const input = dialog.querySelector('input')!; input.focus({ preventScroll: true }); input.setSelectionRange(4, 4); dialog.scrollTop = 0;
  });
  const input = page.getByRole('textbox', { name: 'Workspace', exact: true });
  expect((await input.boundingBox())!.y).toBeGreaterThan(532);
  await page.evaluate(() => (window as any).formKeyboard(400));
  await expect.poll(async () => { const rect = (await input.boundingBox())!; return rect.y >= 0 && rect.y + rect.height <= 532; }).toBe(true);
  await expect(input).toHaveValue('retained draft');
  expect(await input.evaluate(node => (node as HTMLInputElement).selectionStart)).toBe(4);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  // iOS does not send a new keyboard-show notification when Next/Tab moves
  // between fields. The overlay still needs to reveal the newly focused one.
  await page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]')!;
    const spacer = document.createElement('div'); spacer.style.height = '500px';
    const next = document.createElement('input'); next.setAttribute('aria-label', 'Next field'); next.value = 'second draft';
    dialog.append(spacer, next); next.focus({ preventScroll: true });
  });
  const next = page.getByRole('textbox', { name: 'Next field', exact: true });
  await expect.poll(async () => { const rect = (await next.boundingBox())!; return rect.y >= 0 && rect.y + rect.height <= 532; }).toBe(true);
  await expect(next).toHaveValue('second draft');
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.evaluate(() => (window as any).formKeyboard(0));
  await expect(next).toBeFocused();
});

// Android reports the IME through NativeInsets' `tarobot-keyboard` event. The
// shell, composer inset and bottom sheets follow it with the OS timing; other
// resizes and the reduced-motion setting apply at once.
test('native overlay keyboard motion follows only keyboard changes and ignores the retired motion setting', async ({ page }) => {
  await page.goto(url); await expect(page.locator('dialog.diff-viewer')).toBeVisible();
  await page.evaluate(async () => {
    document.querySelector('dialog')?.close();
    const { installAppViewport, nativeKeyboardMotion } = await import('/src/viewport.ts');
    installAppViewport(window, document, nativeKeyboardMotion.android);
    const shell = document.createElement('div'); shell.className = 'app-shell';
    shell.innerHTML = '<main class="conversation-main" style="display:flex;flex-direction:column;flex:1"><div class="message-scroll" style="flex:1"></div><div class="composer-wrap"><textarea aria-label="Message"></textarea></div></main>';
    document.body.append(shell);
    (window as any).imeFrame = (height: number) => dispatchEvent(new CustomEvent('tarobot-keyboard', { detail: { height, at: Date.now() } }));
    (window as any).shellHeights = (ms: number) => new Promise<number[]>(resolve => {
      const heights: number[] = [], end = performance.now() + ms;
      const tick = () => { heights.push(Math.round(shell.getBoundingClientRect().height)); if (performance.now() < end) requestAnimationFrame(tick); else resolve(heights); };
      requestAnimationFrame(tick);
    });
  });
  const shell = page.locator('.app-shell');
  await expect.poll(() => shell.evaluate(node => node.getBoundingClientRect().height)).toBe(932);
  // Keyboard: an eased, monotonic path to the end state on the AOSP timing.
  // Start sampling before the event, inside the same browser task. Separate
  // automation round trips can miss this entire 285 ms transition.
  const { timing, opening } = await page.evaluate(async () => {
    const samples = (window as any).shellHeights(450) as Promise<number[]>;
    (window as any).imeFrame(400);
    const timing = await new Promise<string>(resolve => requestAnimationFrame(() => {
      const style = getComputedStyle(document.querySelector('.app-shell')!);
      resolve(`${style.transitionProperty} ${style.transitionDuration} ${style.transitionTimingFunction}`);
    }));
    return { timing, opening: await samples };
  });
  expect(timing).toBe('height 0.285s cubic-bezier(0.2, 0, 0, 1)');
  expect(opening.at(-1)).toBe(532);
  expect(opening.some(height => height > 540 && height < 924)).toBe(true);
  expect(opening.every((height, index) => index === 0 || height <= opening[index - 1]!)).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', 'true');
  await expect(page.locator('html')).not.toHaveAttribute('data-keyboard-motion', /.*/);
  // A rotation-style viewport change after the keyboard settles is immediate.
  await page.setViewportSize({ width: 430, height: 900 });
  await expect.poll(() => shell.evaluate(node => node.getBoundingClientRect().height)).toBe(500);
  expect(await shell.evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
  // A lower field in a bottom sheet rides up with the keyboard and is revealed
  // without a final jump once the sheet's own scroll range has grown.
  await page.evaluate(() => {
    (window as any).imeFrame(0);
    const dialog = document.createElement('dialog'); dialog.className = 'creation-dialog'; dialog.id = 'motion-sheet';
    dialog.innerHTML = '<header><h2>Long form</h2></header><div style="height:640px"></div><label>Workspace<input aria-label="Workspace"></label><p style="height:40px">Footer</p>';
    document.body.append(dialog); dialog.showModal();
  });
  await expect.poll(() => shell.evaluate(node => node.getBoundingClientRect().height)).toBe(900);
  const field = page.getByRole('textbox', { name: 'Workspace', exact: true });
  const reveal = await page.evaluate(() => new Promise<{ bottom: number; scroll: number; field: number }[]>(resolve => {
    const dialog = document.querySelector<HTMLDialogElement>('#motion-sheet')!, input = dialog.querySelector('input')!;
    input.focus({ preventScroll: true }); dialog.scrollTop = 0;
    const rows: { bottom: number; scroll: number; field: number }[] = [], end = performance.now() + 600;
    (window as any).imeFrame(400);
    const tick = () => { setTimeout(() => rows.push({ bottom: Math.round(dialog.getBoundingClientRect().bottom), scroll: Math.round(dialog.scrollTop), field: Math.round(input.getBoundingClientRect().bottom) }), 0); if (performance.now() < end) requestAnimationFrame(tick); else setTimeout(() => resolve(rows), 20); };
    requestAnimationFrame(tick);
  }));
  expect(reveal.at(-1)!.bottom).toBe(500);
  expect(reveal.some(row => row.bottom > 510 && row.bottom < 890)).toBe(true);
  expect(reveal.at(-1)!.field).toBeLessThanOrEqual(500);
  // Once the sheet has settled, the scroll position does not move again.
  const settled = reveal.findIndex(row => row.bottom === 500);
  expect(new Set(reveal.slice(settled).map(row => row.scroll)).size).toBe(1);
  await expect(field).toBeFocused();
  // A legacy marker no longer suppresses a fresh keyboard transition.
  const returning = await page.evaluate(() => {
    document.querySelector<HTMLDialogElement>('#motion-sheet')!.close();
    document.documentElement.dataset.motion = 'reduced';
    const samples = (window as any).shellHeights(450) as Promise<number[]>;
    (window as any).imeFrame(0); return samples;
  });
  expect(returning.some(height => height > 500 && height < 900)).toBe(true);
  await expect.poll(() => shell.evaluate(node => Math.round(node.getBoundingClientRect().height))).toBe(900);
});

test('native keyboard motion survives OS reduced motion and yields to viewport changes and stale events', async ({ page }) => {
  await page.goto(url); await expect(page.locator('dialog.diff-viewer')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Real production controller and CSS, with synthetic native signals. This
  // checks rendered geometry during a transition, not physical IME timing.
  const result = await page.evaluate(async () => {
    document.querySelector('dialog')?.close();
    const { installAppViewport, nativeKeyboardMotion } = await import('/src/viewport.ts');
    const { installMotion } = await import('/src/motion.ts');
    await import('/src/motion.css');
    const shell = document.createElement('div'); shell.className = 'app-shell'; document.body.append(shell);
    const stop = installMotion(), controller = installAppViewport(window, document, nativeKeyboardMotion.android);
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const settle = async () => { await frame(); await frame(); };
    const keyboard = (height: number, at = Date.now()) => window.dispatchEvent(new CustomEvent('tarobot-keyboard', { detail: { height, at } }));
    const height = () => shell.getBoundingClientRect().height;
    // innerHeight is an own accessor of window: restore it rather than delete it.
    const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')!;
    try {
      await settle();
      keyboard(300); await settle();
      const entering = height();
      // A window correction arrives inside the keyboard's 285ms transition.
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
      window.dispatchEvent(new Event('resize')); await settle();
      const resized = height();
      Object.defineProperty(window, 'innerHeight', innerHeight);
      window.dispatchEvent(new Event('resize')); await settle();
      keyboard(0, Date.now() - 5000); await settle();
      const stale = height();
      keyboard(280); await settle();
      return { entering, resized, stale, reentered: height() };
    } finally {
      Object.defineProperty(window, 'innerHeight', innerHeight);
      controller.dispose(); stop(); shell.remove();
    }
  });
  expect(result.entering).toBeGreaterThan(632); expect(result.entering).toBeLessThan(932);
  expect(result.resized).toBeCloseTo(400, 0);
  expect(result.stale).toBeCloseTo(932, 0);
  expect(result.reentered).toBeGreaterThan(652); expect(result.reentered).toBeLessThan(932);
});
