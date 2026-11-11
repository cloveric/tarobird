import { test, expect, type Page } from '@playwright/test';
import { codexSendChoiceFixture } from './fixtures/codex-send-choice.js';
import { preparePairing } from './fixtures/pairing-invite.js';
import { selectConversation } from './fixtures/mobile.js';
import { openSettings, closeSettings } from './fixtures/settings.js';

test.use({ serviceWorkers: 'block', hasTouch: true, isMobile: true });

async function open(page: Page, f: Awaited<ReturnType<typeof codexSendChoiceFixture>>) {
  await f.hub.profile.update({ name: '演示主机', revision: (await f.hub.profile.read()).revision });
  await page.goto(f.hub.url); await preparePairing(page, f.hub);
  await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await f.hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await selectConversation(page, f.chats[0]!.title);
  const input = page.locator('.composer textarea');
  await input.fill('请检查手机布局'); await page.locator('.send-button').click();
  await expect.poll(() => f.turns.length).toBe(1);
  return input;
}

for (const platform of ['ios', 'android']) test(`${platform}: queued count and send mode share a phone row with theme accents`, async ({ page }, info) => {
  const f = await codexSendChoiceFixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const input = await open(page, f);
    await page.evaluate(platform => { document.documentElement.dataset.platform = platform; }, platform);
    const choice = page.locator('.claude-send-choice');
    await expect(choice.locator('[data-mode=next]')).toBeChecked();
    const hint = page.locator('.send-choice-summary');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('等待当前任务结束后再处理');
    await hint.click(); await expect(page.locator('.send-choice-explanation')).toBeVisible();
    await page.getByRole('button', { name: '关闭发送方式说明', exact: true }).click();
    await expect(hint).toBeFocused();
    await input.focus(); await choice.locator('[data-mode=current]').tap(); await expect(input).toBeFocused();
    await expect(hint).toHaveText('补充到当前任务，不改变待执行顺序');
    await choice.locator('[data-mode=next]').tap();
    const emptyHeight = (await page.locator('.composer-wrap').boundingBox())!.height;
    await page.screenshot({ path: info.outputPath(`${platform}-empty.png`), animations: 'disabled' });
    await input.fill('下一轮再处理这段很长的排队预览，不能挤压发送方式按钮');
    await page.locator('.send-button').click(); await expect(input).toHaveValue('');
    const queue = page.locator('.prompt-queue-trigger');
    await expect(queue).toBeVisible();
    const queueBox = (await queue.boundingBox())!, choiceBox = (await choice.boundingBox())!;
    expect(Math.abs(queueBox.y - choiceBox.y)).toBeLessThan(2);
    expect(queueBox.x + queueBox.width).toBeLessThanOrEqual(choiceBox.x);
    expect(queueBox.height).toBeGreaterThanOrEqual(44);
    expect((await page.locator('.composer-wrap').boundingBox())!.height).toBeCloseTo(emptyHeight, 0);
    await expect(hint).toBeHidden();
    for (const locale of ['zh', 'en']) {
      if (locale === 'en') {
        await openSettings(page); await page.getByLabel('语言', { exact: true }).selectOption('en'); await closeSettings(page, true);
        await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Message', exact: true }).click();
        await page.locator('.mobile-home:visible .mh-row').filter({ hasText: f.chats[0]!.title }).click();
        await page.evaluate(platform => { document.documentElement.dataset.platform = platform; }, platform);
      }
      for (const width of [320, 360, 390, 440]) {
        await page.setViewportSize({ width, height: 844 });
        await queue.waitFor({ state: 'visible' });
        await choice.waitFor({ state: 'visible' });
        // Read both controls in one animation frame: navigation slides their
        // shared ancestor, so separate protocol reads can invent an overlap.
        const [a, b] = await page.evaluate(() => ['.prompt-queue-trigger', '.claude-send-choice'].map(selector => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }));
        expect(Math.abs(a.y - b.y)).toBeLessThan(2);
        expect(a.x + a.width).toBeLessThanOrEqual(b.x);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const control of [queue, choice.locator('[data-mode=current]'), choice.locator('[data-mode=next]'), page.locator('.composer-stop')]) {
          const box = (await control.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
          expect(await control.evaluate(n => n.scrollWidth <= n.clientWidth && n.scrollHeight <= n.clientHeight)).toBe(true);
        }
        if (width === 390) await page.screenshot({ path: info.outputPath(`${platform}-${locale}-queued.png`), animations: 'disabled' });
      }
    }
    for (const [palette, accent, theme] of [['mono', 'warm-gray', 'light'], ['mono', 'sage', 'dark'], ['mono', 'none', 'light'], ['mono', 'mist', 'dark'], ['white-violet', 'warm-gray', 'light']]) {
      await page.evaluate(([palette, accent, theme]) => Object.assign(document.documentElement.dataset, { palette, monoAccent: accent, theme }), [palette, accent, theme]);
      const colors = await page.locator('.composer-wrap').evaluate(node => {
        const mono = document.documentElement.dataset.palette === 'mono';
        const badge = node.querySelector('.prompt-queue-count')!;
        const probe = document.createElement('span'); node.append(probe);
        probe.style.backgroundColor = mono ? 'var(--mono-summary-bg, #737373)' : 'var(--primary-bg)';
        const expectedBadge = getComputedStyle(probe).backgroundColor;
        probe.style.backgroundColor = mono && document.documentElement.dataset.monoAccent === 'none' ? 'var(--surface)' : 'var(--mono-control-bg, var(--primary-bg))';
        const result = { badge: getComputedStyle(badge).backgroundColor, expectedBadge, expectedStop: getComputedStyle(probe).backgroundColor };
        probe.remove(); return result;
      });
      expect(colors.badge).toBe(colors.expectedBadge);
      // Theme changes animate the existing stop control's fill.
      await expect(page.locator('.composer-stop')).toHaveCSS('background-color', colors.expectedStop);
    }
    await input.fill('Unsent draft'); await input.focus();
    await choice.locator('[data-mode=current]').tap(); await expect(input).toBeFocused();
    await expect(choice.locator('[data-mode=current]')).toBeChecked();
    expect(f.inputs).toEqual([]); expect(f.turns).toHaveLength(1);
    await queue.tap(); await expect(page.locator('.prompt-queue-panel')).toBeVisible();
    await expect(page.locator('.prompt-queue-panel')).toContainText('下一轮再处理');
    await page.getByRole('button', { name: 'Pause message 1', exact: true }).click();
    await expect(page.locator('.prompt-queue-item')).toHaveAttribute('data-paused', 'true');
    await page.getByRole('button', { name: 'Close pending messages', exact: true }).click();
    await expect(input).toHaveValue('Unsent draft');
    await page.setViewportSize({ width: 320, height: 844 });
    await expect(queue.locator('.prompt-queue-preview-compact')).toHaveText('All messages paused');
    expect(await queue.locator('.prompt-queue-next').evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await queue.tap(); await page.getByRole('button', { name: 'Start message 1', exact: true }).click();
    await expect(page.locator('.prompt-queue-item')).not.toHaveAttribute('data-paused', 'true');
    await page.getByRole('button', { name: 'Close pending messages', exact: true }).click();
    await choice.locator('[data-mode=next]').tap();
    for (let i = 2; i <= 10; i++) {
      await input.fill(`Queued task ${i}`); await page.locator('.send-button').click(); await expect(input).toHaveValue('');
    }
    await expect(queue.locator('.prompt-queue-count')).toHaveText('10');
    expect(await queue.evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true);
    await input.fill('Unsent draft');
    const largeText = await page.addStyleTag({ content: '.composer-accessories button { font-size:24px !important; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const control of [queue, choice.locator('[data-mode=current]'), choice.locator('[data-mode=next]')]) {
      expect(await control.evaluate(n => n.scrollWidth <= n.clientWidth && n.scrollHeight <= n.clientHeight)).toBe(true);
    }
    await largeText.evaluate(node => node.remove());
    // The ordinary phone layout withdraws across the wide-window breakpoint.
    await page.setViewportSize({ width: 844, height: 900 });
    const wideQueue = (await queue.boundingBox())!, wideChoice = (await choice.boundingBox())!;
    expect(wideQueue.y + wideQueue.height).toBeLessThanOrEqual(wideChoice.y);
  } finally { await page.close(); await f.close(); }
});
