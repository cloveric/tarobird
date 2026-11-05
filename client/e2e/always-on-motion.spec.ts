import { test, expect } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import type { ViteDevServer } from 'vite';

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: 'always-on-motion', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__always-on-motion')) return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml('/__always-on-motion', `<!doctype html><html data-theme="light" data-palette="mono"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
        <div class="header-activity"><i class="activity-dot"></i><span>正在回复</span></div>
        <div class="message-avatar bot is-working"></div>
        <div class="side-thinking"><i></i></div>
        <div class="native-run"><svg class="spin"></svg></div>
        <div id="scene" style="width:200px;height:40px">页面切换</div>
        <dialog class="creation-dialog"><header>弹窗</header></dialog>
        <script type="module">
          import '/src/styles.css'; import '/src/brand-theme.css'; import '/src/palette-tokens.css';
          import '/src/mobile-im.css'; import '/src/motion.css'; import '/src/porcelain-details.css';
          import '/src/ios-adaptive.css'; import '/src/side-conversation.css'; import '/src/run-presentation.css';
          import { installMotion } from '/src/motion.ts'; installMotion();
          document.documentElement.dataset.ready = 'true';
        </script></body></html>`));
    });
  } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); url = server.resolvedUrls!.local[0] + '__always-on-motion';
});
test.afterAll(async () => { await server.close(); });

for (const platform of ['web', 'android', 'ios']) test(`${platform} keeps reply indicators, dialogs and page motion with OS reduction enabled`, async ({ page }) => {
  await page.setViewportSize({ width: platform === 'web' ? 1360 : 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(platform => { document.documentElement.dataset.platform = platform; }, platform);
  const read = () => page.evaluate(() => {
    const style = (selector: string, pseudo?: string) => getComputedStyle(document.querySelector(selector)!, pseudo).animationName;
    return { header: style('.activity-dot', '::after'), avatar: style('.message-avatar', '::before'), side: style('.side-thinking i'), spinner: style('.native-run .spin') };
  });
  const expected = { header: 'tc-breathe', avatar: 'tc-reply-dots', side: 'side-pulse', spinner: 'spin' };
  await expect.poll(read).toEqual(expected);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  const scene = await page.evaluate(async () => {
    const { animateScene } = await import('/src/motion.ts');
    const node = document.querySelector<HTMLElement>('#scene')!;
    const stop = animateScene(node);
    const animation = node.getAnimations()[0];
    if (!animation) return null;
    animation.pause(); animation.currentTime = 90;
    const result = { opacity: Number(getComputedStyle(node).opacity), transform: getComputedStyle(node).transform };
    stop(); return result;
  });
  expect(scene).not.toBeNull(); expect(scene!.opacity).toBeLessThan(1); expect(scene!.transform).not.toBe('none');
  await page.evaluate(() => document.querySelector('dialog')!.showModal());
  expect(await page.locator('dialog').evaluate(node => getComputedStyle(node).animationName)).not.toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(read).toEqual(expected);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(read).toEqual(expected);
});

for (const type of ['radio', 'checkbox', 'text'] as const) test(`focusing a ${type} during pointer press preserves the animated hit target until click`, async ({ page, browserName }) => {
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(async type => {
    const scene = document.querySelector<HTMLElement>('#scene')!;
    scene.innerHTML = `<input id="motion-input" type="${type}" style="width:18px;height:18px;padding:0">`;
    const { animateScene } = await import('/src/motion.ts');
    animateScene(scene);
    const animation = scene.getAnimations()[0]; animation.pause(); animation.currentTime = 0;
  }, type);
  const input = page.locator('#motion-input'), scene = page.locator('#scene');
  const before = (await input.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  // WebKit on macOS does not focus radio/checkbox controls on mouse press.
  if (browserName === 'chromium' || type === 'text') await expect(input).toBeFocused();
  expect((await input.boundingBox())!.x).toBeCloseTo(before.x, 1);
  expect(await scene.evaluate(node => node.getAnimations()[0]?.playState)).toBe('paused');
  await page.mouse.up();
  if (type !== 'text') await expect(input).toBeChecked();
  await expect.poll(() => scene.evaluate(node => node.getAnimations().length)).toBe(0);
});
