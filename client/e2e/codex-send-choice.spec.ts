import { test, expect, type Page } from '@playwright/test';
import { preparePairing } from './fixtures/pairing-invite.js';
import { selectConversation } from './fixtures/mobile.js';
import { codexSendChoiceFixture } from './fixtures/codex-send-choice.js';
import { openSettings, closeSettings } from './fixtures/settings.js';

test.use({ serviceWorkers: 'block' });
async function open(page: Page, f: Awaited<ReturnType<typeof codexSendChoiceFixture>>) {
  await page.goto(f.hub.url); await preparePairing(page, f.hub);
  await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await f.hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await selectConversation(page, f.chats[0]!.title);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('先核对方案'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => f.turns.length).toBe(1);
  return input;
}

for (const phone of [false, true]) test(`${phone ? 'phone' : 'desktop'}: Codex defaults to queue and only an explicit supplement steers`, async ({ page }, info) => {
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  const f = await codexSendChoiceFixture();
  try {
    const input = await open(page, f), send = page.getByRole('button', { name: '发送消息', exact: true });
    const next = page.getByRole('radio', { name: /^(排到下一轮|排队)$/ });
    const current = page.getByRole('radio', { name: /^(补充当前|补充)$/ });
    await expect(next).toBeChecked();
    await input.fill('这一轮结束后再整理摘要'); await send.click();
    await expect(page.getByRole('button', { name: '管理待执行消息，共 1 条', exact: true })).toBeVisible();
    expect(f.inputs).toEqual([]); expect(f.turns).toHaveLength(1);
    await current.click(); await input.fill('先只看手机布局');
    if (phone) await send.click(); else await input.press('Enter');
    await expect.poll(() => f.inputs).toEqual(['先只看手机布局']);
    await expect(input).toHaveValue(''); await expect(current).toBeChecked();
    await expect(page.getByRole('button', { name: '管理待执行消息，共 1 条', exact: true })).toBeVisible();
    await input.fill('保留未发送的草稿');
    await page.screenshot({ path: info.outputPath('send-choice.png'), animations: 'disabled' });
    f.finish(); await expect.poll(() => f.turns.length).toBe(2);
    await expect(next).toBeChecked({ timeout: 10_000 });
    await expect(input).toHaveValue('保留未发送的草稿');
  } finally { await page.close(); await f.close(); }
});

test('selection stays in its conversation; attachments force queue and commands keep their route', async ({ page }) => {
  const f = await codexSendChoiceFixture();
  try {
    const input = await open(page, f), current = page.getByRole('radio', { name: /^(补充当前|补充)$/ }), next = page.getByRole('radio', { name: /^(排到下一轮|排队)$/ });
    await current.check(); await input.fill('保留这段草稿');
    await selectConversation(page, f.chats[1]!.title); await expect(page.locator('.claude-send-choice')).toHaveCount(0);
    await selectConversation(page, f.chats[0]!.title); await expect(current).toBeChecked(); await expect(input).toHaveValue('保留这段草稿');
    await page.locator('input.attachment-picker-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('next task attachment') });
    await expect(next).toBeChecked(); await expect(current).toBeDisabled();
    await page.getByRole('button', { name: '发送消息', exact: true }).click(); await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: '管理待执行消息，共 1 条', exact: true })).toBeVisible();
    expect(f.inputs).toEqual([]); await expect(current).toBeChecked();
    await input.fill('/help'); await expect(page.locator('.claude-send-choice')).toHaveCount(0);
    await page.getByRole('button', { name: '发送消息', exact: true }).click(); await expect(input).toHaveValue('');
    expect(f.inputs).toEqual([]);
  } finally { await page.close(); await f.close(); }
});

test('uncertain supplement cannot become a duplicate queue message, including after reload and task completion', async ({ page }) => {
  const f = await codexSendChoiceFixture();
  try {
    const input = await open(page, f), send = page.getByRole('button', { name: '发送消息', exact: true });
    await page.getByRole('radio', { name: /^(补充当前|补充)$/ }).check(); f.options.loseAdmission = true;
    await input.fill('这条补充只发送一次'); await send.click();
    await expect(page.locator('.steering-receipt')).toContainText('待确认'); await expect(send).toBeEnabled();
    await page.getByRole('radio', { name: /^(排到下一轮|排队)$/ }).check(); await send.click();
    await expect(page.locator('.error-banner')).toContainText('本次未重复排队');
    await page.reload(); await expect(input).toHaveValue('这条补充只发送一次');
    f.finish(); await expect(page.getByText('本轮已完成。', { exact: true })).toBeVisible();
    await send.click(); await expect(page.locator('.error-banner')).toContainText('本次未重复排队');
    expect(f.inputs).toEqual(['这条补充只发送一次']); expect(f.turns).toHaveLength(1);
    await expect(page.getByRole('button', { name: /管理待执行消息/ })).toHaveCount(0);
    await expect(input).toHaveValue('这条补充只发送一次');
  } finally { await page.close(); await f.close(); }
});

test('a task transition during preflight never steers the next task or silently queues the text', async ({ page }) => {
  const f = await codexSendChoiceFixture();
  let release = () => {};
  try {
    const input = await open(page, f), send = page.getByRole('button', { name: '发送消息', exact: true });
    await input.fill('预先排队的第二个任务'); await send.click(); await expect(input).toHaveValue('');
    await page.getByRole('radio', { name: /^(补充当前|补充)$/ }).check(); await input.fill('只补充第一个任务');
    let entered = false; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/steer?botId=bot', async route => { entered = true; await gate; await route.continue(); });
    await send.click(); await expect.poll(() => entered).toBe(true);
    f.finish(); await expect.poll(() => f.turns.length).toBe(2); release();
    await expect(page.locator('.error-banner')).toBeVisible(); await expect(send).toBeEnabled();
    expect(f.inputs).toEqual([]); await expect(input).toHaveValue('只补充第一个任务');
    await expect(page.getByRole('button', { name: /管理待执行消息/ })).toHaveCount(0);
  } finally { release(); await page.close(); await f.close(); }
});

test('failed supplement preflight keeps the draft; unsupported engines retain ordinary sending', async ({ page }) => {
  const f = await codexSendChoiceFixture();
  try {
    const input = await open(page, f), send = page.getByRole('button', { name: '发送消息', exact: true });
    await page.getByRole('radio', { name: /^(补充当前|补充)$/ }).check(); await input.fill('连接恢复后核对');
    await page.route('**/steer?botId=bot', route => route.fulfill({ status: 503, body: 'offline' }));
    await send.click(); await expect(page.locator('.error-banner')).toBeVisible(); await expect(send).toBeEnabled();
    await expect(input).toHaveValue('连接恢复后核对'); expect(f.inputs).toEqual([]); expect(f.turns).toHaveLength(1);
    await expect(page.getByRole('button', { name: /管理待执行消息/ })).toHaveCount(0);
    await page.unroute('**/steer?botId=bot'); f.options.supported = false;
    await page.reload(); await expect(input).toHaveValue('连接恢复后核对');
    await expect(page.locator('.claude-send-choice')).toHaveCount(0); await send.click(); await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: '管理待执行消息，共 1 条', exact: true })).toBeVisible(); expect(f.inputs).toEqual([]);
  } finally { await page.close(); await f.close(); }
});

test('Chinese and English choices fit narrow phone and expanded layouts without shrinking send', async ({ page }, info) => {
  const f = await codexSendChoiceFixture();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const input = await open(page, f); await input.fill('Keep this draft while resizing');
    for (const locale of ['zh', 'en']) {
      if (locale === 'en') {
        await page.setViewportSize({ width: 1360, height: 900 });
        await openSettings(page); await page.getByLabel('语言', { exact: true }).selectOption('en'); await closeSettings(page, true);
      }
      for (const [platform, width] of [['ios', 320], ['ios', 390], ['android', 360], ['ios', 844]] as const) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(platform => document.documentElement.setAttribute('data-platform', platform), platform);
        const choice = page.locator('.claude-send-choice'), next = choice.locator('[data-mode="next"]'), current = choice.locator('[data-mode="current"]');
        await next.check(); const send = page.locator('.send-button'); const before = (await send.boundingBox())!.width;
        await current.check(); await expect(current).toBeChecked(); expect((await send.boundingBox())!.width).toBe(before);
        const geometry = await choice.evaluate(node => ({ right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, heights: [...node.querySelectorAll('[role=radio]')].map(n => n.getBoundingClientRect().height) }));
        expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(width); expect(geometry.scroll).toBe(geometry.client);
        if (width < 760) expect(Math.min(...geometry.heights)).toBeGreaterThanOrEqual(44);
        await expect(page.locator('.composer textarea')).toHaveValue('Keep this draft while resizing');
        if (width === 390) await page.screenshot({ path: info.outputPath(`phone-${locale}.png`), animations: 'disabled' });
      }
    }
    expect(errors).toEqual([]); expect(f.inputs).toEqual([]);
  } finally { await page.close(); await f.close(); }
});

test('a temporary capability failure cannot change an already selected supplement into queue', async ({ page }) => {
  const f = await codexSendChoiceFixture();
  try {
    const input = await open(page, f), current = page.getByRole('radio', { name: /^(补充当前|补充)$/ });
    await current.check(); await input.fill('保留补充意图');
    await page.route('**/steer?botId=bot&review=1', route => route.fulfill({ json: { supported: false, reason: 'not_ready' } }));
    await page.waitForResponse(response => response.url().endsWith('/steer?botId=bot&review=1'));
    // Wait for the delivered poll to paint its capability update.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await current.click(); await expect(current).toBeChecked();
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => f.inputs).toEqual(['保留补充意图']); await expect(input).toHaveValue('');
    expect(f.turns).toHaveLength(1); await expect(page.getByRole('button', { name: /管理待执行消息/ })).toHaveCount(0);
  } finally { await page.close(); await f.close(); }
});

test('lost before reaching the Hub recovers the original ID after idle and permits the requested queued send', async ({ page }) => {
  const f = await codexSendChoiceFixture();
  try {
    const input = await open(page, f), send = page.getByRole('button', { name: '发送消息', exact: true });
    await page.getByRole('radio', { name: /^(补充当前|补充)$/ }).check(); await input.fill('这条未到达主机');
    await page.route('**/steer', route => route.abort()); await send.click();
    await expect(page.locator('.error-banner')).toBeVisible(); await expect(send).toBeEnabled(); expect(f.inputs).toEqual([]);
    await page.unroute('**/steer'); f.finish(); await expect(page.getByText('本轮已完成。', { exact: true })).toBeVisible();
    await expect(page.locator('.claude-send-choice')).toHaveCount(0, { timeout: 10_000 });
    await send.click(); await expect(input).toHaveValue(''); await expect.poll(() => f.turns.length).toBe(2);
    expect(f.inputs).toEqual([]); expect(f.turns[1]).toContain('这条未到达主机');
  } finally { await page.close(); await f.close(); }
});

test('an accepted old receipt never silently clears a supplement intended for the new task', async ({ page }) => {
  const f = await codexSendChoiceFixture();
  try {
    const input = await open(page, f), send = page.getByRole('button', { name: '发送消息', exact: true });
    await input.fill('第二个任务'); await send.click(); await expect(input).toHaveValue('');
    await page.getByRole('radio', { name: /^(补充当前|补充)$/ }).check(); await input.fill('任务中的补充');
    await page.route('**/steer', async route => { await route.fetch(); await route.abort(); }); await send.click();
    await expect(page.locator('.error-banner')).toBeVisible(); await expect(send).toBeEnabled();
    await expect.poll(() => f.inputs).toEqual(['任务中的补充']); await page.unroute('**/steer');
    f.finish(); await expect.poll(() => f.turns.length).toBe(2);
    await expect(page.getByRole('radio', { name: /^(排到下一轮|排队)$/ })).toBeChecked({ timeout: 10_000 });
    await page.getByRole('radio', { name: /^(补充当前|补充)$/ }).check(); await send.click();
    await expect(page.locator('.error-banner')).toContainText('已补充到之前的任务');
    await expect(input).toHaveValue('任务中的补充'); expect(f.inputs).toHaveLength(1);
    await input.fill('当前任务的新补充'); await send.click(); await expect(input).toHaveValue('');
    expect(f.inputs).toEqual(['任务中的补充', '当前任务的新补充']);
  } finally { await page.close(); await f.close(); }
});

test('receipt recovery owns submission so repeated Enter cannot create duplicate queued messages', async ({ page }) => {
  const f = await codexSendChoiceFixture(); let release = () => {};
  try {
    const input = await open(page, f), send = page.getByRole('button', { name: '发送消息', exact: true });
    await page.getByRole('radio', { name: /^(补充当前|补充)$/ }).check(); await input.fill('恢复后只排队一次');
    await page.route('**/steer', route => route.abort()); await send.click();
    await expect(page.locator('.error-banner')).toBeVisible(); await expect(send).toBeEnabled();
    await page.unroute('**/steer'); f.finish(); await expect(page.locator('.claude-send-choice')).toHaveCount(0, { timeout: 10_000 });
    let preflights = 0; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/steer?botId=bot', async route => { preflights++; await gate; await route.continue(); });
    await send.click(); await expect.poll(() => preflights).toBe(1); await expect(send).toBeDisabled();
    await input.press('Enter'); await input.press('Enter');
    release(); await expect(input).toHaveValue(''); await expect.poll(() => f.turns.length).toBe(2);
    expect(preflights).toBe(1); expect(f.inputs).toEqual([]);
    await expect(page.getByRole('button', { name: /管理待执行消息/ })).toHaveCount(0);
  } finally { release(); await page.close(); await f.close(); }
});
