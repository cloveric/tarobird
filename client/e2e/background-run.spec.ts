import { test, expect } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createServer } from './fixtures/vite.js';
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.goto(server.resolvedUrls!.local[0] + 'e2e/fixtures/background-run.html'); });
for (const width of [320, 390, 1360]) test(`background reports stay compact and preserve the full report and source at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const card = page.locator('[data-test=background]'), foreground = page.locator('[data-test=foreground]');
  await expect(card.locator('.native-run')).toBeVisible();
  await page.screenshot({ path: info.outputPath(`initial-${width}.png`) });
  await expect(card.getByRole('button', { name: '查看完整回复', exact: true })).toBeVisible();
  expect((await card.boundingBox())!.height).toBeLessThan(270);
  expect((await foreground.boundingBox())!.height).toBeGreaterThan(600);
  await expect(card.getByRole('button', { name: '查看关联请求', exact: true })).toBeVisible();
  await expect(card).not.toContainText('这是关联请求的后续通知');
  await expect(foreground).toContainText('最后一段：成片与四个封面已交付。');
  expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`compact-${width}.png`), fullPage: false });
  await card.getByRole('button', { name: '查看完整回复', exact: true }).click();
  const report = page.getByRole('dialog', { name: '后台任务结果', exact: true });
  await expect(report).toContainText('第 1 段'); await expect(report).toContainText('最后一段：成片与四个封面已交付。');
  expect(await page.evaluate(() => (window as any).backgroundRun.urls)).toEqual([]);
  await report.getByRole('button', { name: '关闭完整回复', exact: true }).click();
  await expect(card.getByRole('button', { name: '查看完整回复', exact: true })).toBeFocused();
  await card.getByRole('button', { name: '查看运行过程', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '运行过程', exact: true })).toContainText('Bot 说明');
  await page.getByRole('button', { name: '关闭运行过程', exact: true }).click();
  await card.getByRole('button', { name: '查看关联请求', exact: true }).click();
  expect(await page.evaluate(() => (window as any).backgroundRun.located)).toBe(1);
});

test('artifact delivery remains visibly unconfirmed in both scoped and static report readers', async ({ page }) => {
  const card = page.locator('[data-test=background]');
  for (const legacy of [false, true]) {
    await page.evaluate(legacy => { const fixture = (window as any).backgroundRun; fixture.setStatic(legacy); fixture.setDeliveryFailed(true); fixture.setPhase('partial'); }, legacy);
    await expect(card).toContainText('交付未确认');
    await card.getByRole('button', { name: '查看完整回复', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '后台任务结果', exact: true })).toContainText('交付未确认');
    await page.getByRole('button', { name: '关闭完整回复', exact: true }).click();
  }
});

test('failed, waiting and disconnected background states stay visible without gaining a foreground stop', async ({ page }) => {
  const card = page.locator('[data-test=background]');
  for (const [phase, label] of [['error', '运行失败'], ['partial', '最终状态未确认'], ['waiting_answer', '等待回答'], ['waiting_approval', '等待授权'], ['interrupted', '运行已中断']]) {
    await page.evaluate(phase => (window as any).backgroundRun.setPhase(phase), phase);
    await expect(card.locator('.native-run-status')).toContainText(label);
    await expect(card.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    expect((await card.boundingBox())!.height).toBeLessThan(270);
  }
  await page.evaluate(() => { (window as any).backgroundRun.setPhase('working'); (window as any).backgroundRun.offline(); });
  await expect(card).toContainText('连接中断，当前状态待确认');
  await expect(card.locator('.spin')).toHaveCount(0);
  await card.getByRole('button', { name: '查看完整回复', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '后台任务结果', exact: true })).toContainText('最后一段');
  expect(await page.evaluate(() => (window as any).backgroundRun.sent)).toEqual([]);
});

test('unknown, deleted and foreign source requests never become clickable; unsupported Hub retains the report', async ({ page }) => {
  const card = page.locator('[data-test=background]');
  await page.evaluate(() => (window as any).backgroundRun.wrongSource());
  await expect(card.getByRole('button', { name: '查看关联请求', exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).backgroundRun.deleteSource());
  await expect(card).toContainText('原消息已删除或当前不可访问');
  await page.evaluate(() => (window as any).backgroundRun.setOrigin('unattributed'));
  await expect(card).toContainText('来源待确认');
  await page.evaluate(() => { (window as any).backgroundRun.setPhase('working'); (window as any).backgroundRun.rollback(); });
  await expect(card).toContainText('最后状态待确认'); await expect(card.locator('.spin')).toHaveCount(0);
  await expect(card.getByRole('button', { name: '查看运行过程', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: '查看完整回复', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '后台任务结果', exact: true })).toContainText('最后一段');
});

test('live report updates keep the card geometry stable and dialogs stay owned by their host', async ({ page }) => {
  const card = page.locator('[data-test=background]');
  await page.evaluate(() => (window as any).backgroundRun.setPhase('working'));
  const before = (await card.boundingBox())!.height;
  await page.evaluate(() => (window as any).backgroundRun.setBody('新的公开进展。'.repeat(500)));
  expect(Math.abs((await card.boundingBox())!.height - before)).toBeLessThanOrEqual(1);
  await card.getByRole('button', { name: '查看完整回复', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('新的公开进展');
  await page.evaluate(() => (window as any).backgroundRun.setHost(1));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card).toContainText('另一台主机的完整报告');
  await page.evaluate(() => (window as any).backgroundRun.setHost(0));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => (window as any).backgroundRun.setHost(1));
  await card.getByRole('button', { name: '查看完整回复', exact: true }).click();
  await page.evaluate(() => (window as any).backgroundRun.setActive(false));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const width of [320, 1360]) test(`quiet background work keeps its card stable and reports freshness only in details at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => (window as any).backgroundRun.setPhase('working'));
  const card = page.locator('[data-test=background]');
  const height = (await card.boundingBox())!.height;
  await page.clock.setFixedTime(Date.now() + 141000);
  await expect(card.locator('.native-run-status time')).toHaveText(/4m \d+s/);
  await expect(card).not.toContainText('未收到新进展');
  expect(Math.abs((await card.boundingBox())!.height - height)).toBeLessThanOrEqual(1);
  await card.getByRole('button', { name: '查看运行过程', exact: true }).click();
  const report = page.locator('.run-update-time');
  await expect(report.locator('.run-update-relative')).toHaveText('2分钟前');
  await expect(report).toContainText('最后更新：');
  const eventAt = await report.locator('time').getAttribute('datetime');
  await page.clock.setFixedTime(Date.now() + 201000);
  await expect(report.locator('.run-update-relative')).toHaveText('3分钟前');
  await expect(report.locator('time')).toHaveAttribute('datetime', eventAt!);
  await page.evaluate(() => (window as any).backgroundRun.setBody('后台返回了新的公开进度。'));
  await expect(report.locator('.run-update-relative')).toHaveText('刚刚');
  await expect(card).toContainText('后台返回了新的公开进度。');
  await page.evaluate(() => (window as any).backgroundRun.setLocale('en'));
  await expect(report).toContainText('Last updated:');
  await expect(report.locator('.run-update-relative')).toHaveText('Just now');
  await expect(page.locator('.run-update-explanation')).toContainText('a gap between reports does not necessarily mean work has stopped');
  await page.evaluate(() => (window as any).backgroundRun.setLocale('zh'));
  await page.evaluate(() => (window as any).backgroundRun.setPhase('done'));
  await expect(page.locator('.run-update-explanation')).toHaveCount(0);
  await expect(card).toContainText('已完成');
  await expect(report).not.toContainText('刚刚');
  await expect(report.locator('.run-update-relative')).toHaveCount(0);
  await expect(report.locator('time')).toBeVisible();
});

for (const locale of ['zh', 'en']) test(`narrow ${locale} process timestamps keep their geometry at minute, hour and day boundaries`, async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const now = Date.now();
  await page.clock.setFixedTime(now);
  await page.evaluate(locale => { const f = (window as any).backgroundRun; f.setPhase('working'); f.setLocale(locale); }, locale);
  const card = page.locator('[data-test=background]');
  await card.locator('.run-process-trigger').click();
  const report = page.locator('.run-update-time'), step = page.locator('.run-step').first();
  await expect(step).toBeVisible();
  const height = (await report.boundingBox())!.height, top = (await step.boundingBox())!.y;
  const exact = await report.locator('time').getAttribute('datetime');
  for (const [age, zh, en] of [[59999, '刚刚', 'Just now'], [60000, '1分钟前', '1 minute ago'], [3540000, '59分钟前', '59 minutes ago'], [82800000, '23小时前', '23 hours ago'], [172800000, '2天前', '2 days ago']] as const) {
    await page.clock.setFixedTime(now + age);
    await expect(report.locator('.run-update-relative')).toHaveText(locale === 'zh' ? zh : en);
    expect((await report.boundingBox())!.height).toBe(height);
    expect((await step.boundingBox())!.y).toBe(top);
    expect(await report.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(report.locator('time')).toHaveAttribute('datetime', exact!);
  }
  await page.screenshot({ path: info.outputPath(`narrow-progress-${locale}.png`) });
  await page.evaluate(() => (window as any).backgroundRun.setPhase('done'));
  await expect(report.locator('.run-update-relative')).toHaveCount(0);
  expect((await report.boundingBox())!.height).toBe(height);
  await expect(report.locator('time')).toBeVisible();
});

test('process timestamps survive view changes and use the host clock without implying activity', async ({ page }) => {
  const now = Date.now(), eventAt = now - 141000;
  await page.clock.setFixedTime(now);
  await page.evaluate(eventAt => { const f = (window as any).backgroundRun; f.setPhase('working'); f.setStamp(eventAt); }, eventAt);
  await page.locator('[data-test=background]').getByRole('button', { name: '查看运行过程', exact: true }).click();
  const report = page.locator('.run-update-time'), exact = report.locator('time');
  await expect(report).toContainText('最后更新：');
  await expect(report.locator('.run-update-relative')).toHaveText('2分钟前');
  await expect(exact).toHaveAttribute('datetime', new Date(eventAt).toISOString());
  await expect(exact).not.toHaveText('');
  await expect(exact).toContainText('主机记录：');
  const recordedText = await exact.innerText();
  for (const [offset, expected] of [[3600000, '1小时前'], [86400000, '1天前'], [-300000, '刚刚']] as const) {
    await page.evaluate(offset => (window as any).backgroundRun.setConnection({ serverTimeOffset: offset }), offset);
    await expect(report.locator('.run-update-relative')).toHaveText(expected);
    await expect(exact).toHaveAttribute('datetime', new Date(eventAt).toISOString());
    await expect(exact).toHaveText(recordedText);
  }
  await page.evaluate(() => { const f = (window as any).backgroundRun; f.setConnection({ serverTimeOffset: 3600000 }); f.setLocale('en'); });
  await expect(report).toContainText('Last updated:');
  await expect(report.locator('.run-update-relative')).toHaveText('1 hour ago');
  await expect(exact).toHaveAttribute('datetime', new Date(eventAt).toISOString());
  const text = await exact.innerText();
  await page.getByRole('button', { name: 'Close run details', exact: true }).click();
  await page.locator('[data-test=background] .run-process-trigger').click();
  await expect(exact).toHaveAttribute('datetime', new Date(eventAt).toISOString());
  await expect(exact).toHaveText(text);
  await expect(report.locator('.run-update-relative')).toHaveText('1 hour ago');
});

test('large text preserves narrow English timestamp access without horizontal overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => { const f = (window as any).backgroundRun; f.setPhase('working'); f.setLocale('en'); });
  await page.clock.setFixedTime(Date.now() + 59 * 60000);
  await page.locator('[data-test=background] .run-process-trigger').click();
  // Exercise the rendered region at 200% text size; this is not native Android
  // WebView textZoom acceptance or a change to the user's font preference.
  await page.addStyleTag({ content: '.run-update-time { font-size:22px !important }' });
  const report = page.locator('.run-update-time');
  await expect(report.locator('.run-update-relative')).toHaveText('59 minutes ago');
  expect(await report.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(report.locator('time')).toBeVisible();
  expect(await report.locator('time').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('large-progress-en.png') });
});

test('process state agrees with interruption, connection loss and local stop confirmation', async ({ page }) => {
  const card = page.locator('[data-test=foreground]');
  await page.evaluate(() => (window as any).backgroundRun.setPhase('working'));
  await card.getByRole('button', { name: '查看运行过程', exact: true }).click();
  const meta = page.locator('.run-details-meta');
  for (const [phase, label] of [['waiting_answer', '等待回答'], ['waiting_approval', '等待授权'], ['stopping', '正在停止'], ['error', '运行失败'], ['interrupted', '运行已中断'], ['done', '已完成']]) {
    await page.evaluate(phase => (window as any).backgroundRun.setPhase(phase), phase);
    await expect(meta).toContainText(label);
    await expect(page.locator('.run-update-explanation')).toHaveCount(0);
    await expect(page.locator('.run-update-time')).toContainText('最后更新：');
    if (['error', 'interrupted', 'done'].includes(phase)) await expect(page.locator('.run-update-relative')).toHaveCount(0);
  }
  await page.evaluate(() => { const f = (window as any).backgroundRun; f.setPhase('working'); f.setStatus('error'); });
  await expect(meta).toContainText('运行已中断');
  await expect(page.locator('.run-update-relative')).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).backgroundRun; f.setStatus('complete'); f.offline(); });
  await expect(meta).toContainText('连接中断，当前状态待确认');
  await expect(page.locator('.run-update-relative')).toHaveCount(0);
  await page.evaluate(() => (window as any).backgroundRun.setConnection({ status: 'online' }));
  await page.getByRole('button', { name: '关闭运行过程', exact: true }).click();
  await card.getByRole('button', { name: '停止', exact: true }).click();
  await expect(card).toContainText('等待停止确认');
  await card.getByRole('button', { name: '查看运行过程', exact: true }).click();
  await expect(meta).toContainText('正在停止');
  await expect(page.locator('.run-update-explanation')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).backgroundRun.sent)).toEqual([{ v: 1, type: 'turn.stop', conversationId: 'chat', botId: 'alpha' }]);
});

test('short reports remain fully visible and legacy reports retain their complete text without a journal', async ({ page }) => {
  const card = page.locator('[data-test=background]');
  await page.evaluate(() => (window as any).backgroundRun.setBody('核对完毕。'));
  await expect(card).toContainText('核对完毕。');
  await expect(card.getByRole('button', { name: '查看完整回复', exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).backgroundRun.setStatic(true); (window as any).backgroundRun.setBody('## 完整回报\n\n' + '原文不丢失。'.repeat(200) + '\n\n最后一段。'); });
  await expect(card.locator('.background-report')).toBeVisible();
  await expect(card.getByRole('button', { name: '查看关联请求', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '查看运行过程', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: '查看完整回复', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '后台任务结果', exact: true })).toContainText('最后一段。');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedReport = text; } } }));
  await page.getByRole('button', { name: '复制回复', exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedReport)).toBe('## 完整回报\n\n' + '原文不丢失。'.repeat(200) + '\n\n最后一段。');
  expect(await page.evaluate(() => (window as any).backgroundRun.urls)).toEqual([]);
  await page.getByRole('button', { name: '关闭完整回复', exact: true }).click();
  await expect(card.getByRole('button', { name: '查看完整回复', exact: true })).toBeFocused();
});

test('finishing with a short result while its reader is open still restores keyboard focus', async ({ page }) => {
  const card = page.locator('[data-test=background]');
  await page.evaluate(() => (window as any).backgroundRun.setPhase('working'));
  await card.getByRole('button', { name: '查看完整回复', exact: true }).click();
  await page.evaluate(() => { (window as any).backgroundRun.setBody('核对完毕。'); (window as any).backgroundRun.setPhase('done'); });
  await expect(page.getByRole('dialog', { name: '后台任务结果', exact: true })).toContainText('核对完毕。');
  await page.getByRole('button', { name: '关闭完整回复', exact: true }).click();
  expect(await card.evaluate(node => node.contains(document.activeElement))).toBe(true);
});

test('long current actions cannot grow an active card and an unavailable process does not reopen itself', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const card = page.locator('[data-test=background]');
  await page.evaluate(() => (window as any).backgroundRun.setPhase('working'));
  const before = (await card.boundingBox())!.height;
  await page.evaluate(() => (window as any).backgroundRun.setCurrent({ seq: 1, revision: 1, at: 1, kind: 'tool', status: 'running', name: 'Bash', input: JSON.stringify({ command: 'a-very-long-command-'.repeat(100) }) }));
  expect(Math.abs((await card.boundingBox())!.height - before)).toBeLessThanOrEqual(1);
  await card.getByRole('button', { name: '查看运行过程', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => (window as any).backgroundRun.rollback());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => (window as any).backgroundRun.restore());
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const staticReport of [false, true]) test(`${staticReport ? 'legacy' : 'scoped'} short links, images and formulas remain reachable`, async ({ page }) => {
  const card = page.locator('[data-test=background]');
  for (const text of ['[查看成片](https://example.com/final.mp4)', 'https://example.com/final.mp4', '![封面](https://example.com/cover.png)', '$x^2$']) {
    await page.evaluate(([text, legacy]) => { (window as any).backgroundRun.setStatic(legacy); (window as any).backgroundRun.setBody(text); }, [text, staticReport] as const);
    if (staticReport) await card.getByRole('button', { name: '查看完整回复', exact: true }).click();
    else await expect(card.getByRole('button', { name: '查看完整回复', exact: true })).toHaveCount(0);
    const reader = staticReport ? page.getByRole('dialog', { name: '后台任务结果', exact: true }) : card.locator('.native-run-prose');
    if (text.includes('final.mp4')) await expect(reader.locator('a[href="https://example.com/final.mp4"]')).toHaveCount(1);
    else if (text.startsWith('!')) await expect(reader.locator('a.markdown-image-link[href="https://example.com/cover.png"]')).toHaveCount(1);
    else await expect(reader.locator('.katex')).toHaveCount(1);
    if (staticReport) await reader.getByRole('button', { name: '关闭完整回复', exact: true }).click();
  }
});

test('unknown final state remains neutral in both the report card and its process reader', async ({ page }) => {
  await page.evaluate(() => (window as any).backgroundRun.setPhase('partial'));
  const card = page.locator('[data-test=background]');
  await expect(card.locator('.native-run-status')).toContainText('最终状态未确认');
  await card.getByRole('button', { name: '查看运行过程', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '运行过程', exact: true });
  await expect(dialog.locator('.run-details-meta')).toContainText('最终状态未确认');
  await expect(dialog.locator('.run-details-meta')).not.toContainText('部分完成');
});

const taskDescription = [
  's0、s1、s7 已写完，检查通过，静音看过三轮，`qa/check.png` 已删除。时间轴按新配音重查过。',
  '**有两件事需要你决定或转告：**',
  '- **口播存在版本问题。** 原素材描述的是早期模型，不能直接用于新版反馈，建议修改口播并补充脚注。',
  '- **两张图的文件名和内容对不上。** `media/finance.png` 实际是产品评价；基准图还是英文版，需重新核对。',
  '保留这段说明的段落、列表和代码样式，完整内容仍可查看；不要把整段报告当作任务名称。'.repeat(3),
].join('\n\n').slice(0, 500);

for (const width of [390, 1360]) for (const theme of ['light', 'dark'] as const) test(`long task descriptions use compact regular type and readable disclosure at ${width}px ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  await page.evaluate(text => {
    const fixture = (window as any).backgroundRun;
    fixture.setTaskLabel(text); fixture.setPhase('working');
    fixture.setBody('正在继续处理，可在过程详情查看公开步骤。');
  }, taskDescription);
  const card = page.locator('[data-test=background]');
  const label = card.locator('.scoped-task-label, .scoped-task-description');
  await expect(label).toBeVisible();
  const paint = await card.locator('.native-run').evaluate(node => getComputedStyle(node).backgroundColor);
  const brightness = paint.match(/\d+/g)!.slice(0, 3).reduce((sum, value) => sum + Number(value), 0) / 3;
  expect(theme === 'dark' ? brightness < 90 : brightness > 180).toBe(true);
  // This reproduces the reported defect on the pre-fix renderer (550 and a
  // card taller than a phone), independently of the new disclosure markup.
  expect(Number(await label.evaluate(node => getComputedStyle(node).fontWeight))).toBeLessThanOrEqual(400);
  expect((await card.boundingBox())!.height).toBeLessThan(340);
  expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(label).not.toContainText('**');
  await card.screenshot({ path: info.outputPath(`${width}-${theme}-compact.png`) });
  await card.getByRole('button', { name: '展开任务说明', exact: true }).click();
  const content = card.locator('.scoped-task-description .markdown');
  await expect(content.locator('li')).toHaveCount(2);
  await expect(content.locator('code').first()).toHaveText('qa/check.png');
  await expect(content.locator('p').first()).toContainText('s0、s1、s7');
  expect(Number(await content.locator('p').first().evaluate(node => getComputedStyle(node).fontWeight))).toBe(400);
  await expect(content.locator('strong').first()).toHaveText('有两件事需要你决定或转告：');
  await card.screenshot({ path: info.outputPath(`${width}-${theme}-expanded.png`) });
  // Safari does not focus buttons on pointer clicks. Check retained keyboard
  // focus through keyboard activation, rather than imposing Chromium behavior.
  await card.getByRole('button', { name: '收起任务说明', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', { name: '展开任务说明', exact: true })).toBeFocused();
  await expect(card.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: '查看运行过程', exact: true }).click();
  await page.getByRole('dialog', { name: '运行过程', exact: true }).locator('.run-step summary').click();
  await expect(page.getByRole('dialog', { name: '运行过程', exact: true })).toContainText('保留的公开过程');
  expect(await page.evaluate(() => (window as any).backgroundRun.sent)).toEqual([]);
});

test('task description disclosure follows overflow and resets for a different stored label', async ({ page }) => {
  const card = page.locator('[data-test=background]');
  const description = card.locator('.scoped-task-description');
  for (const label of ['修复预览问题', 'Fix #123', 'review foo_bar.ts', 'A & B', '**Review PR**']) {
    await page.evaluate(label => (window as any).backgroundRun.setTaskLabel(label), label);
    await expect(description).toBeVisible();
    await expect(description.getByRole('button')).toHaveCount(0);
    await expect(description).not.toContainText('**');
  }
  // The same unformatted label fits on desktop but needs disclosure on a phone.
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.evaluate(() => (window as any).backgroundRun.setTaskLabel('核对这份报告里的表格和引用，保留原始内容及来源，查看全部结果后再确认。'.repeat(2)));
  await expect(description.getByRole('button')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 900 });
  const expand = description.getByRole('button', { name: '展开任务说明', exact: true });
  await expect(expand).toBeVisible();
  await expand.focus(); await page.keyboard.press('Enter');
  await expect(description.getByRole('button', { name: '收起任务说明', exact: true })).toBeFocused();
  await expect(description.locator('.markdown')).toBeVisible();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.keyboard.press('Enter');
  await expect(expand).toBeFocused();
  await page.evaluate(() => (window as any).backgroundRun.setTaskLabel('新的短名称'));
  await expect(description).toHaveText('新的短名称');
  await expect(description.locator('.markdown')).toHaveCount(0);
  // Long unbroken tokens cannot widen the page; truncated Markdown remains safe.
  await page.evaluate(() => (window as any).backgroundRun.setTaskLabel('https://example.com/' + 'abcdef'.repeat(75)));
  await expect(description.getByRole('button', { name: '展开任务说明', exact: true })).toBeVisible();
  expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.evaluate(() => (window as any).backgroundRun.setTaskLabel('## 检查说明\n\n```text\n' + '保留的说明 '.repeat(50)));
  await description.getByRole('button', { name: '展开任务说明', exact: true }).click();
  await expect(description.locator('h2')).toHaveText('检查说明');
  expect(await description.locator('h2').evaluate(node => getComputedStyle(node).fontSize)).toBe('13px');
  await expect(description.locator('code')).toContainText('保留的说明');
  expect(await page.evaluate(() => (window as any).backgroundRun.sent)).toEqual([]);
});

for (const palette of ['white', 'cli', 'tty', 'paper', 'agent']) for (const adhd of [false, true]) test(`task metadata reading size stays stable in ${palette}${adhd ? ' ADHD' : ''}`, async ({ page }) => {
  await page.evaluate(({ palette, adhd, text }) => {
    document.documentElement.dataset.palette = palette;
    document.documentElement.dataset.theme = 'dark';
    if (adhd) {
      document.querySelector('main')!.classList.add('adhd-card');
      document.querySelector('main')!.style.setProperty('--font-size', '20px');
    }
    const fixture = (window as any).backgroundRun;
    fixture.setTaskLabel(text); fixture.setPhase('working');
  }, { palette, adhd, text: taskDescription });
  const description = page.locator('[data-test=background] .scoped-task-description');
  const previewSize = await description.locator('.scoped-task-excerpt').evaluate(node => getComputedStyle(node).fontSize);
  await description.getByRole('button', { name: '展开任务说明', exact: true }).click();
  const paragraph = description.locator('.markdown p').first();
  await expect(paragraph).toContainText('s0、s1、s7');
  expect(await paragraph.evaluate(node => getComputedStyle(node).fontSize)).toBe(previewSize);
  expect(Number(await paragraph.evaluate(node => getComputedStyle(node).fontWeight))).toBe(400);
  // The unrelated actual reply still follows the existing ADHD reading setting.
  if (adhd && (palette === 'white' || palette === 'cli')) {
    expect(await page.locator('[data-test=foreground] .native-run-prose .markdown').first().evaluate(node => getComputedStyle(node).fontSize)).toBe('20px');
  }
});
