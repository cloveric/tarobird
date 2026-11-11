import { test, expect } from '@playwright/test';
import { codexSendChoiceFixture } from './fixtures/codex-send-choice.js';
import { preparePairing } from './fixtures/pairing-invite.js';
import { selectConversation } from './fixtures/mobile.js';
import { openSettings, closeSettings } from './fixtures/settings.js';

test.use({ serviceWorkers: 'block' });

test('desktop Codex queue and mode stay readable and independently operable while resizing', async ({ page }, info) => {
  const f = await codexSendChoiceFixture();
  try {
    await f.hub.profile.update({ name: '演示主机', revision: (await f.hub.profile.read()).revision });
    await page.goto(f.hub.url); await preparePairing(page, f.hub);
    await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await f.hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
    await selectConversation(page, f.chats[0]!.title);
    const input = page.locator('.composer textarea'), send = page.locator('.send-button');
    const choice = page.locator('.claude-send-choice'), queue = page.locator('.prompt-queue-trigger');
    await input.fill('先检查当前版本'); await send.click(); await expect.poll(() => f.turns.length).toBe(1);
    await expect(choice.locator('[data-mode=next]')).toBeChecked();
    await input.fill('请检查不同桌面窗口宽度，以及一段很长的中英文队列预览 Windows macOS desktop layout');
    await send.click(); await expect(queue).toBeVisible();
    await input.fill('保留未发送的草稿');
    for (const english of [false, true]) {
      if (english) {
        await page.setViewportSize({ width: 1360, height: 900 });
        await openSettings(page); await page.getByLabel('语言', { exact: true }).selectOption('en'); await closeSettings(page, true);
        await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toHaveCount(0);
      }
      for (const width of [1360, 1000, 820]) {
        await page.setViewportSize({ width, height: 900 });
        await input.click({ trial: true });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        // Measure all controls in the same frame after the viewport settles.
        const geometry = await page.locator('.composer-wrap').evaluate(root => {
          const bounds = (selector: string) => { const r = root.querySelector(selector)!.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
          return { queue: bounds('.prompt-queue-trigger'), choice: bounds('.claude-send-choice'), send: bounds('.send-button'), composer: bounds('.composer'), overflow: root.scrollWidth > root.clientWidth + 1 };
        });
        expect(geometry.overflow).toBe(false);
        expect(Math.abs((geometry.queue.top + geometry.queue.bottom) / 2 - (geometry.choice.top + geometry.choice.bottom) / 2)).toBeLessThanOrEqual(2);
        expect(geometry.queue.right).toBeLessThanOrEqual(geometry.choice.left);
        expect(geometry.send.width).toBeGreaterThanOrEqual(32);
        expect(geometry.send.right).toBeLessThanOrEqual(geometry.composer.right);
        await expect(input).toHaveValue('保留未发送的草稿');
        await page.screenshot({ path: info.outputPath(`codex-desktop-${english ? 'en' : 'zh'}-${width}.png`), animations: 'disabled' });
      }
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    // A workbench constrains the chat by its container, independently of window width.
    await page.getByRole('button', { name: 'Workbench', exact: true }).click();
    const workbench = page.getByRole('complementary', { name: 'Workbench', exact: true });
    await expect(workbench).toBeVisible();
    for (const width of [1360, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await input.click({ trial: true });
      for (const control of [queue, choice, send]) {
        const bounds = (await control.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      expect(await page.locator('.composer-wrap').evaluate(root => root.scrollWidth > root.clientWidth + 1)).toBe(false);
      await expect(input).toHaveValue('保留未发送的草稿');
      await page.screenshot({ path: info.outputPath(`codex-with-workbench-${width}.png`), animations: 'disabled' });
    }
    await workbench.getByRole('button', { name: 'Return to chat', exact: true }).click();
    await page.setViewportSize({ width: 1360, height: 900 });
    // Opening the queue and help must preserve both the unsent draft and its route.
    await queue.click(); await expect(page.locator('.prompt-queue-panel')).toBeVisible();
    await page.getByRole('button', { name: 'Close pending messages', exact: true }).click();
    await expect(page.locator('.prompt-queue-panel')).toHaveCount(0);
    await choice.locator('.send-choice-help').click(); await expect(page.locator('.send-choice-explanation')).toBeVisible();
    await page.getByRole('button', { name: 'Close send mode help', exact: true }).click();
    await expect(input).toHaveValue('保留未发送的草稿');
    await expect(choice.locator('[data-mode=next]')).toBeChecked();
    expect(f.inputs).toEqual([]); expect(f.turns).toHaveLength(1);
  } finally { await page.close(); await f.close(); }
});
