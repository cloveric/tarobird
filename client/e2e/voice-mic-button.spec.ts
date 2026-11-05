import { test, expect } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import type { ViteDevServer } from 'vite';

// Real shortcut component and trusted touch events; no microphone or Host.
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>.composer-wrap{padding:80px}.icon-button{width:44px;height:44px}</style><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {VoiceMicButton} from '/src/VoiceMicButton.tsx';import '/src/hold-to-talk.css';
const f=window.micShortcut={opened:0,started:0,finished:0,clicks:0};
document.addEventListener('click',e=>{if(e.target.closest('.voice-mic-shortcut'))f.clicks++},true);
function App(){const [phase,setPhase]=React.useState('idle'),[opened,setOpened]=React.useState(0),[disabled,setDisabled]=React.useState(false);f.disable=setDisabled;
const cancel=React.useCallback(()=>setPhase('idle'),[]);
const voice={phase,busy:phase!=='idle',seconds:0,cancel,finishHeld:()=>{f.finished++;setPhase('idle')}};
return React.createElement('div',{className:'composer-wrap'},React.createElement(VoiceMicButton,{voice,disabled,open:()=>{f.opened++;setOpened(f.opened)},start:()=>{f.started++;setPhase('requesting')}}),React.createElement('output',null,JSON.stringify({phase,opened})));}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script>`;
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: 'mic-shortcut-fixture', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__mic-shortcut') return next();
      res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__mic-shortcut', html));
    });
  } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); url = server.resolvedUrls!.local[0] + '__mic-shortcut';
});
test.afterAll(async () => { await server.close(); });
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });

for (const offline of [false, true]) test(`native touch click survives small finger movement (${offline ? 'offline' : 'online'})`, async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Trusted touch injection is Chromium-only.');
  await page.goto(url); const button = page.getByRole('button', { name: '录制语音', exact: true });
  await expect(page.locator('output')).toContainText('"phase":"idle"');
  const box = (await button.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
  if (offline) await context.setOffline(true);
  const touch = await context.newCDPSession(page);
  try {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 13, y }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(() => (window as any).micShortcut.clicks)).toBe(1);
    await expect(page.locator('output')).toContainText('"opened":1');
    expect(await page.evaluate(() => (window as any).micShortcut.started)).toBe(0);
    // A later interrupted gesture or drag outside the button must not use the
    // accepted click from the first gesture to open again.
    for (const cancel of [true, false]) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (cancel ? 13 : 40), y }] });
      await touch.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
      await expect(page.locator('output')).toContainText('"opened":1');
      expect(await page.evaluate(() => (window as any).micShortcut.started)).toBe(0);
    }
  } finally { await touch.detach(); }
});

test('tap and keyboard open once; long press and cancelled gestures do not also open the mode', async ({ page }) => {
  await page.goto(url); const button = page.getByRole('button', { name: '录制语音', exact: true });
  await button.click(); await expect(page.locator('output')).toContainText('"opened":1');
  await button.focus(); await page.keyboard.press('Enter'); await expect(page.locator('output')).toContainText('"opened":2');
  const box = (await button.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
  // Native mouse clicks exercise the same fallback in WebKit, where trusted
  // touch injection is unavailable in this browser runner.
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 13, y); await page.mouse.up();
  await expect(page.locator('output')).toContainText('"opened":3');
  await page.mouse.move(x, y); await page.mouse.down();
  await expect(page.locator('output')).toContainText('"phase":"requesting"');
  await page.mouse.up(); await expect(page.locator('output')).toContainText('"phase":"idle"');
  expect(await page.evaluate(() => (window as any).micShortcut.finished)).toBe(1);
  await expect(page.locator('output')).toContainText('"opened":3');
  await page.mouse.down(); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
  await expect(page.locator('output')).toContainText('"opened":3');
  await page.evaluate(() => (window as any).micShortcut.disable(true)); await expect(button).toBeDisabled();
  await page.evaluate(() => (window as any).micShortcut.disable(false)); await button.click();
  await expect(page.locator('output')).toContainText('"opened":4');
});
