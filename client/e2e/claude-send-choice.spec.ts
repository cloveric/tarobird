import { preparePairing } from "./fixtures/pairing-invite.js";
import { writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { sendChoiceFixture } from './fixtures/claude-send-choice.js';
import { enterMobileChat, mobileHome } from './fixtures/mobile.js';

test.use({ serviceWorkers: 'block' });
async function open(page: Page, fixture: Awaited<ReturnType<typeof sendChoiceFixture>>, phone = false) {
  await page.goto(fixture.hub.url); await preparePairing(page, fixture.hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await fixture.hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await expect(phone ? mobileHome(page) : page.locator('.connection-pill.online')).toBeVisible();
  if (phone) await enterMobileChat(page, fixture.chats[0]!.title);
  else await page.locator('.conversation-row').filter({ hasText: fixture.chats[0]!.title }).click();
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('请整理视频脚本，先核对镜头顺序。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('radio', { name: /^(补充当前|补充)$/ })).toBeChecked();
  return input;
}

for (const phone of [false, true]) test(`${phone ? 'phone' : 'desktop'}: visible choice, ordinary and queued sends, editing and cancellation`, async ({ page }, info) => {
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  const f = await sendChoiceFixture();
  try {
    const input = await open(page, f, phone), send = page.getByRole('button', { name: '发送消息', exact: true });
    const choice = page.locator('.claude-send-choice'), current = choice.getByRole('radio', { name: /^(补充当前|补充)$/ }), next = choice.getByRole('radio', { name: /^(排到下一轮|排队)$/ });
    await input.fill('我觉得时间可以延长，比 11 秒长。'); await send.click(); await expect(input).toHaveValue('');
    expect(f.inputs.map(x => x.text)).toEqual(['我觉得时间可以延长，比 11 秒长。']);
    await expect(page.locator('.native-input-receipt')).toContainText('CLI 已接收 · 待处理');
    await input.fill('这一版完成后，再做一个竖屏版本。');
    const width = (await input.boundingBox())!.width;
    await next.check(); await expect(next).toBeChecked(); expect(f.inputs).toHaveLength(1); expect(f.turns).toHaveLength(1);
    expect((await input.boundingBox())!.width).toBe(width);
    await expect(send).toHaveAttribute('title', '等待当前任务结束后再处理');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      await page.screenshot({ animations: "disabled", path: info.outputPath(`choice-${phone ? 'phone' : 'desktop'}-${theme}.png`) });
    }
    if (phone) await send.click(); else await input.press('Enter');
    await expect(input).toHaveValue(''); await expect(next).toBeChecked();
    expect(f.inputs).toHaveLength(1); expect(f.turns).toHaveLength(1);
    const pending = page.getByRole('button', { name: '管理待执行消息，共 1 条', exact: true });
    await expect(pending).toBeVisible(); await pending.click();
    const panel = page.getByRole('dialog', { name: '待执行消息', exact: true });
    await expect(panel).toContainText('这一版完成后，再做一个竖屏版本。');
    await panel.getByRole('button', { name: '编辑第 1 条消息', exact: true }).click();
    await panel.getByRole('textbox', { name: '编辑待执行消息', exact: true }).fill('下一轮只做竖屏版本。');
    await panel.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(panel).toContainText('下一轮只做竖屏版本。');
    await expect(panel.getByRole('button', { name: '取消第 1 条待执行消息', exact: true })).toBeEnabled();
    await page.screenshot({ animations: "disabled", path: info.outputPath(`queue-${phone ? 'phone' : 'desktop'}.png`) });
    await panel.getByRole('button', { name: '取消第 1 条待执行消息', exact: true }).click();
    await page.getByRole('button', { name: '确认取消排队', exact: true }).click();
    await expect(panel).not.toContainText('下一轮只做竖屏版本。');
    expect(f.turns).toHaveLength(1); expect(f.controls).toHaveLength(0);
  } finally { await page.close(); await f.close(); }
});

test('uncertain native text cannot be duplicated through next-turn choice or the old menu', async ({ page }) => {
  const f = await sendChoiceFixture();
  try {
    const input = await open(page, f), send = page.getByRole('button', { name: '发送消息', exact: true });
    f.options.loseAdmission = true;
    await input.fill('请确认这条只投递一次'); await send.click();
    await expect(page.locator('.native-input-receipt')).toContainText('发送结果待确认'); await expect(send).toBeEnabled();
    await page.getByRole('radio', { name: /^(排到下一轮|排队)$/ }).check(); await send.click();
    await expect(page.locator('.error-banner')).toContainText('本次未重复排队');
    await expect(input).toHaveValue('请确认这条只投递一次'); expect(f.inputs).toHaveLength(1); expect(f.turns).toHaveLength(1);
    await expect(page.getByRole('button', { name: /管理待执行消息/ })).toHaveCount(0);
    await page.reload(); await expect(input).toHaveValue('请确认这条只投递一次');
    await page.getByRole('button', { name: '更多聊天操作', exact: true }).click();
    await page.getByRole('button', { name: '作为下一轮发送', exact: true }).click();
    await expect(page.locator('.error-banner')).toContainText('本次未重复排队');
    expect(f.inputs).toHaveLength(1); expect(f.turns).toHaveLength(1);
  } finally { await page.close(); await f.close(); }
});

test('scope, rich input, explicit immediate shortcut and terminal receipt stay honest', async ({ page }) => {
  const f = await sendChoiceFixture();
  try {
    const input = await open(page, f), next = page.getByRole('radio', { name: /^(排到下一轮|排队)$/ }), current = page.getByRole('radio', { name: /^(补充当前|补充)$/ });
    await next.check(); await input.fill('待发送草稿');
    await page.locator('.conversation-row').filter({ hasText: f.chats[1]!.title }).click();
    await expect(page.locator('.claude-send-choice')).toHaveCount(0);
    await page.locator('.conversation-row').filter({ hasText: f.chats[0]!.title }).click();
    await expect(next).toBeChecked(); await expect(input).toHaveValue('待发送草稿'); await current.check();
    await page.locator('input.attachment-picker-input').setInputFiles({ name: '备注.txt', mimeType: 'text/plain', buffer: Buffer.from('完整附件内容') });
    await expect(next).toBeChecked(); await expect(current).toBeDisabled();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toHaveAttribute('title', '等待当前任务结束后再处理');
    await page.getByRole('button', { name: '发送消息', exact: true }).click(); await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: '管理待执行消息，共 1 条', exact: true })).toBeVisible();
    await expect(current).toBeChecked(); expect(f.inputs).toHaveLength(0);
    await next.check(); await input.fill('明确立即发送'); await input.press('Control+Enter');
    await expect(input).toHaveValue(''); await expect(next).toBeChecked();
    await expect.poll(() => f.controls).toEqual(['send-now']); expect(f.inputs.map(x => x.text)).toEqual(['明确立即发送']);
    // A delayed control reply must not leave a waiting notice after model receipt.
    await current.check(); await input.fill('回执先于控制响应'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    f.options.receivedBeforeControlReply = true;
    const receipt = page.locator('.native-input-receipt').last();
    await receipt.getByRole('button', { name: '立即发送', exact: true }).click();
    await expect(receipt).toContainText('模型已收到'); await expect(receipt).not.toContainText('等待模型回执');
    await expect(receipt.getByRole('button', { name: '撤回编辑' })).toHaveCount(0);
    expect(f.turns).toHaveLength(1);
  } finally { await page.close(); await f.close(); }
});

test('chosen queue stays safe as the current turn ends; unsupported CLI keeps existing controls', async ({ page }) => {
  const f = await sendChoiceFixture();
  try {
    const input = await open(page, f);
    await page.getByRole('radio', { name: /^(排到下一轮|排队)$/ }).check(); await input.fill('当前任务结束后的新工作');
    f.finish(); await expect(page.getByText('本轮整理完成。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => f.turns.length).toBe(2); expect(f.inputs).toHaveLength(0);
    await expect(input).toHaveValue('');
    await expect(page.getByRole('radio', { name: /^(补充当前|补充)$/ })).toBeChecked();
    // Older CLI: no native selector, no misrepresented native controls.
    f.options.native = false;
    await page.reload(); await expect(page.locator('.connection-pill.online')).toBeVisible();
    await expect(page.locator('.claude-send-choice')).toHaveCount(0);
    await input.fill('保持原有旧版发送'); await page.getByRole('button', { name: '更多聊天操作', exact: true }).click();
    await expect(page.getByRole('button', { name: '作为下一轮发送', exact: true })).toBeVisible();
  } finally { await page.close(); await f.close(); }
});

for (const platform of ['ios', 'android']) test(platform + ': narrow phone keeps width, focus and help', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const f = await sendChoiceFixture();
  try {
    const input = await open(page, f, true);
    await page.evaluate(platform => document.documentElement.setAttribute('data-platform', platform), platform);
    await input.fill('我想等这轮完成，再处理这条消息。');
    const next = page.getByRole('radio', { name: /^(排到下一轮|排队)$/ }); await next.check();
    await expect(input).toBeFocused();
    const geometry = await page.locator('.claude-send-choice').evaluate(node => {
      const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, heights: [...node.querySelectorAll('[role=radio]')].map(n => n.getBoundingClientRect().height) };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(320); expect(geometry.scroll).toBe(geometry.client);
    expect(Math.min(...geometry.heights)).toBeGreaterThanOrEqual(44); expect((await input.boundingBox())!.width).toBeGreaterThan(200);
    await page.getByRole('button', { name: '说明发送方式', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '发送方式', exact: true });
    await expect(dialog).toContainText('开始处理后不能撤回');
    await page.screenshot({ animations: "disabled", path: info.outputPath(platform + '-help-320.png') });
    await page.getByRole('button', { name: '关闭发送方式说明', exact: true }).click();
    await expect(next).toBeChecked(); await expect(input).toHaveValue('我想等这轮完成，再处理这条消息。');
    await next.focus(); await next.press('ArrowLeft');
    await expect(page.getByRole('radio', { name: /^(补充当前|补充)$/ })).toBeChecked(); expect(f.inputs).toHaveLength(0);
    await page.screenshot({ animations: "disabled", path: info.outputPath(platform + '-choice-320.png') });
  } finally { await page.close(); await f.close(); }
});

test.describe('touch pointer input', () => {
  test.use({ hasTouch: true });
  test('focused phone taps select without a synthetic click or losing the composer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await sendChoiceFixture();
    try {
      const input = await open(page, f, true);
      const next = page.getByRole('radio', { name: /^(排到下一轮|排队)$/ });
      const current = page.getByRole('radio', { name: /^(补充当前|补充)$/ });
      await input.fill('触摸选择后仍保留草稿');
      await next.tap(); await expect(next).toBeChecked(); await expect(input).toBeFocused();
      await current.tap(); await expect(current).toBeChecked(); await expect(input).toBeFocused();
      // A cancelled or scrolling touch must not become a selection.
      const box = (await next.boundingBox())!, point = { pointerId: 73, pointerType: 'touch', clientX: box.x + 10, clientY: box.y + 10 };
      await next.dispatchEvent('pointerdown', point);
      await next.dispatchEvent('pointermove', { ...point, clientY: point.clientY + 20 });
      await next.dispatchEvent('pointerup', point);
      await expect(current).toBeChecked();
      await next.dispatchEvent('pointerdown', point); await next.dispatchEvent('pointercancel', point); await next.dispatchEvent('pointerup', point);
      await expect(current).toBeChecked();
      await next.tap(); await expect(next).toBeChecked();
      expect(f.inputs).toHaveLength(0); expect(f.turns).toHaveLength(1);
      await page.getByRole('button', { name: '发送消息', exact: true }).tap();
      await expect(page.getByRole('button', { name: '管理待执行消息，共 1 条', exact: true })).toBeVisible();
      await expect(input).toHaveValue(''); expect(f.inputs).toHaveLength(0);
    } finally { await page.close(); await f.close(); }
  });
});


test('uncertain control notice clears when an authoritative model receipt arrives', async ({ page }) => {
  const f = await sendChoiceFixture();
  try {
    const input = await open(page, f);
    await input.fill('控制回执暂时丢失后继续核对');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const receipt = page.locator('.native-input-receipt');
    await expect(receipt).toContainText('CLI 已接收');
    f.options.unknownControl = true;
    await receipt.getByRole('button', { name: '立即发送', exact: true }).click();
    await expect(receipt).toContainText('操作结果待确认');
    f.inputs[0]!.observer.onProgress({ state: 'received' });
    await expect(receipt).toContainText('模型已收到');
    await expect(receipt).not.toContainText('操作结果待确认');
    await expect(receipt.getByRole('button', { name: '撤回编辑' })).toHaveCount(0);
    expect(f.inputs).toHaveLength(1);
  } finally { await page.close(); await f.close(); }
});

test('switching running conversations leaves exactly one current queue and advances its count', async ({ page }) => {
  const f = await sendChoiceFixture();
  try {
    const input = await open(page, f), next = page.getByRole('radio', { name: /^(排到下一轮|排队)$/ });
    await next.check();
    for (const text of ['A 下一轮一', 'A 下一轮二']) {
      await input.fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click(); await expect(input).toHaveValue('');
    }
    await expect(page.getByRole('button', { name: '管理待执行消息，共 2 条', exact: true })).toBeVisible();
    await page.locator('.conversation-row').filter({ hasText: f.chats[1]!.title }).click();
    await input.fill('B 当前任务'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('radio', { name: /^(补充当前|补充)$/ })).toBeChecked();
    await next.check(); await input.fill('B 下一轮'); await page.getByRole('button', { name: '发送消息', exact: true }).click(); await expect(input).toHaveValue('');
    await expect(page.locator('.prompt-queue-trigger')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '管理待执行消息，共 1 条', exact: true })).toBeVisible();
    for (let n = 0; n < 2; n++) {
      await page.locator('.conversation-row').filter({ hasText: f.chats[0]!.title }).click();
      await expect(page.locator('.prompt-queue-trigger')).toHaveCount(1);
      await expect(page.getByRole('button', { name: '管理待执行消息，共 2 条', exact: true })).toBeVisible();
      await expect(page.locator('.claude-send-choice')).toHaveCount(1); await expect(next).toBeChecked();
      await page.locator('.conversation-row').filter({ hasText: f.chats[1]!.title }).click();
      await expect(page.locator('.prompt-queue-trigger')).toHaveCount(1);
      await expect(page.getByRole('button', { name: '管理待执行消息，共 1 条', exact: true })).toBeVisible();
    }
    await page.locator('.conversation-row').filter({ hasText: f.chats[0]!.title }).click();
    f.finish(0);
    await expect.poll(() => f.turns).toContain('A 下一轮一');
    await expect(page.locator('.prompt-queue-trigger')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '管理待执行消息，共 1 条', exact: true })).toBeVisible();
    await expect(page.locator('.prompt-queue-trigger')).toContainText('A 下一轮二');
  } finally { await page.close(); await f.close(); }
});


for (const { width, board } of [{ width:1360, board:false }, { width:900, board:false }, { width:1360, board:true }]) test(`desktop ${width}${board ? ' ADHD' : ''}: task entry and short send choices share one row`, async ({ page }, info) => {
  await page.setViewportSize({ width, height:900 });
  const f = await sendChoiceFixture();
  await f.hub.profile.update({ name:'演示主机', revision:(await f.hub.profile.read()).revision });
  const finished = width === 1360 && !board;
  f.options.tasks = [{ id:'working', label:'核对视频脚本', kind:'subagent', mode:'background', status:finished ? 'done' : 'running', canStop:!finished, updatedAt:Date.now() }];
  try {
    if (board) f.chats.push(await f.hub.store.createConversation('owner',['bot'],'第三项工作','toolbar-third'));
    await open(page, f);
    if (board) {
      await page.getByRole('button',{name:'打开 ADHD 模式',exact:true}).click();
      for (const chat of f.chats) await page.getByRole('checkbox',{name:`加入面板：演示主机 · ${chat.title}`,exact:true}).check();
      await page.getByLabel('ADHD 每行窗口数',{exact:true}).selectOption('3');
    }
    const scope = board ? page.locator(`.adhd-card[data-pane-conversation="${f.chats[0]!.id}"]`) : page.locator('.host-workspace:not([hidden])');
    const wrap = scope.locator('.composer-wrap'), input = wrap.locator('textarea');
    const tasks = wrap.getByRole('button',{name:'子代理与后台任务',exact:true}), choice = wrap.locator('.claude-send-choice');
    if (board) expect((await wrap.boundingBox())!.width).toBeLessThan(400);
    await expect(tasks).toHaveText(finished ? '任务' : '1 运行中');
    await expect(choice.getByRole('radio',{name:'补充',exact:true})).toBeChecked();
    await expect(choice.getByRole('radio',{name:'排队',exact:true})).toBeVisible();
    const geometry = await wrap.evaluate(node => {
      const rect = (selector:string) => { const r=node.querySelector(selector)!.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,height:r.height}; };
      return {task:rect('.engine-tasks-trigger'),choice:rect('.claude-send-choice'),input:rect('.composer'),overflow:node.scrollWidth>node.clientWidth};
    });
    expect(Math.abs(geometry.task.y-geometry.choice.y)).toBeLessThan(2);
    expect(geometry.task.right).toBeLessThanOrEqual(geometry.choice.x);
    expect(geometry.choice.bottom).toBeLessThanOrEqual(geometry.input.y);
    expect(geometry.overflow).toBe(false);
    expect(await tasks.locator(':scope > span').evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);
    await tasks.click(); await expect(page.getByRole('dialog',{name:'子代理与后台任务',exact:true})).toContainText('核对视频脚本');
    await page.getByRole('button',{name:'关闭任务列表',exact:true}).click();
    await input.fill('这一条等当前任务结束再处理');
    await choice.getByRole('radio',{name:'排队',exact:true}).check(); await expect(input).toBeFocused();
    for (const theme of ['light','dark']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await wrap.screenshot({path:info.outputPath(`desktop-${width}${board ? '-adhd' : ''}-${theme}-detail.png`)});
      await page.screenshot({path:info.outputPath(`desktop-${width}${board ? '-adhd' : ''}-${theme}.png`)});
    }
    await input.press('Enter'); await expect(input).toHaveValue('');
    const pending=wrap.getByRole('button',{name:'管理待执行消息，共 1 条',exact:true}); await expect(pending).toBeVisible();
    expect((await pending.boundingBox())!.y).toBeLessThan((await choice.boundingBox())!.y);
    await choice.getByRole('button',{name:'说明发送方式',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'发送方式',exact:true})).toContainText('等待当前任务结束后再处理');
    await page.getByRole('button',{name:'关闭发送方式说明',exact:true}).click();
    expect(f.inputs).toHaveLength(0);expect(f.turns).toHaveLength(1);
  } finally { await page.close();await f.close(); }
});

for (const platform of ['android', 'ios']) for (const width of [390, 320]) test(`phone ${platform} ${width}: task entry and send choice share a compact row`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const f = await sendChoiceFixture();
  f.options.tasks = [{ id: 'working', label: '核对视频脚本', kind: 'subagent', mode: 'background', status: 'running', canStop: true, updatedAt: Date.now() }];
  try {
    const input = await open(page, f, true);
    await page.evaluate(platform => document.documentElement.dataset.platform = platform, platform);
    await expect(input).toHaveValue('');
    const tasks = page.getByRole('button', { name: '子代理与后台任务', exact: true });
    await expect(tasks).toBeVisible();
    const choice = page.locator('.claude-send-choice');
    const geometry = await page.locator('.composer-wrap').evaluate(node => {
      const rect = (selector: string) => { const r = node.querySelector(selector)!.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
      return { footer:node.getBoundingClientRect().height, task:rect('.engine-tasks-trigger'),choice:rect('.claude-send-choice'),input:rect('.composer-input-row'),overflow:document.documentElement.scrollWidth>innerWidth };
    });
    await info.attach('composer-geometry', { body:JSON.stringify(geometry), contentType:'application/json' });
    await writeFile(info.outputPath('composer-geometry.json'), JSON.stringify(geometry,null,2));
    await page.locator('.composer-wrap').screenshot({path:info.outputPath(`toolbar-${width}-detail.png`)});
    await page.screenshot({path:info.outputPath(`toolbar-${width}-light.png`)});
    expect(Math.abs(geometry.task.y-geometry.choice.y)).toBeLessThan(2);
    expect(geometry.footer).toBeLessThanOrEqual(116);
    expect(geometry.task.right).toBeLessThanOrEqual(geometry.choice.x);
    expect(geometry.task.height).toBeGreaterThanOrEqual(44);
    expect(geometry.overflow).toBe(false);
    await tasks.click(); await expect(page.getByRole('dialog',{name:'子代理与后台任务',exact:true})).toContainText('核对视频脚本');
    await page.getByRole('button',{name:'关闭任务列表',exact:true}).click();
    await input.fill('下一轮再处理这条消息');
    await choice.getByRole('radio',{name:'排队',exact:true}).check(); await expect(input).toBeFocused();
    await page.getByRole('button',{name:'发送消息',exact:true}).click(); await expect(input).toHaveValue('');
    const pending=page.getByRole('button',{name:'管理待执行消息，共 1 条',exact:true});await expect(pending).toBeVisible();
    const queueBox=(await pending.boundingBox())!,choiceBox=(await choice.boundingBox())!;
    // Keep two distinct rows and the next-message preview, with no added gutter.
    expect(queueBox.height).toBeGreaterThanOrEqual(32);
    expect(queueBox.y+queueBox.height).toBeLessThanOrEqual(choiceBox.y);
    expect(choiceBox.y-queueBox.y-queueBox.height).toBeLessThanOrEqual(1);
    expect((await page.locator('.composer-wrap').boundingBox())!.height-geometry.footer).toBeLessThanOrEqual(32);
    await expect(pending.locator('.prompt-queue-next')).toBeVisible();
    await page.screenshot({path:info.outputPath(`toolbar-${width}-light-queued.png`)});
    await pending.click();await expect(page.getByRole('dialog',{name:/待执行/})).toContainText('下一轮再处理这条消息');
    await page.getByRole('button',{name:'关闭待执行消息',exact:true}).click();
    await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
    await page.screenshot({path:info.outputPath(`toolbar-${width}-dark-queued.png`)});
    await page.setViewportSize({width,height:480});
    await input.focus();await expect(tasks).toBeVisible();await expect(choice).toBeVisible();
    expect((await page.locator('.composer-input-row').boundingBox())!.y+(await page.locator('.composer-input-row').boundingBox())!.height).toBeLessThanOrEqual(480);
    await page.screenshot({path:info.outputPath(`toolbar-${width}-short-viewport.png`)});
    expect(f.inputs).toHaveLength(0);expect(f.turns).toHaveLength(1);
  } finally { await page.close();await f.close(); }
});


for (const platform of ['android', 'ios']) test(`phone ${platform}: background progress and send choice form a compact readable toolbar`, async ({ page }, info) => {
  await page.setViewportSize({width:390,height:844});
  const f=await sendChoiceFixture(); f.options.backgroundGroups=true;f.options.stopScope='subagents';
  f.options.tasks=[0,1,2].map(i=>({id:`layout-task-${i}`,label:`核对素材 ${i+1}`,kind:'subagent',mode:'background',status:i===2?'done':'running',canStop:i!==2,updatedAt:Date.now()}));
  try {
    await f.appendHistory();
    const input=await open(page,f,true);
    await page.evaluate(platform=>{document.documentElement.dataset.platform=platform;document.documentElement.dataset.palette='mono';document.documentElement.dataset.monoAccent='warm-gray';},platform);
    const dock=page.getByRole('button',{name:'定位后台任务组',exact:true}),tasks=page.getByRole('button',{name:'子代理与后台任务',exact:true});
    await expect(page.locator('.background-task-group')).toBeInViewport();
    await expect.poll(() => page.locator('.message-scroll').evaluate(n => new Promise<boolean>(resolve => { const top=n.scrollTop;requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(n.scrollTop===top && n.scrollTop+n.clientHeight>=n.scrollHeight-2))); }))).toBe(true);
    await page.locator('.message-scroll').hover();await page.mouse.wheel(0,-10000);
    await expect(dock).toBeVisible();await expect(dock).toContainText('2 运行中');await expect(dock).toContainText('1 完成');
    await expect(page.locator('.engine-tasks-stop-impact')).toHaveCount(0);
    const bar=await page.locator('.conversation-task-bar').boundingBox(),choice=await page.locator('.claude-send-choice').boundingBox();
    expect(Math.abs(bar!.y-choice!.y)).toBeLessThan(2);
    expect(bar!.x+bar!.width).toBeLessThanOrEqual(choice!.x);
    expect(await dock.locator(':scope > span').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    for (const button of [dock,tasks,page.getByRole('radio',{name:'补充',exact:true}),page.getByRole('radio',{name:'排队',exact:true}),page.getByRole('button',{name:'说明发送方式',exact:true})]) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.locator('.composer-wrap').evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);
    await input.fill('保留这条草稿');
    await page.getByRole('radio',{name:'排队',exact:true}).click();await expect(input).toBeFocused();
    await expect(page.getByRole('radio',{name:'排队',exact:true})).toBeChecked();
    expect(f.inputs).toHaveLength(0);expect(f.turns).toHaveLength(1);
    await page.screenshot({path:info.outputPath('phone-active-background.png')});
    await page.locator('.composer-wrap').screenshot({path:info.outputPath('phone-toolbar-detail.png')});
    await tasks.click();await expect(page.getByRole('dialog',{name:'子代理与后台任务',exact:true}).getByRole('article')).toHaveCount(3);
    await page.getByRole('button',{name:'关闭任务列表',exact:true}).click();
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    const pending=page.getByRole('button',{name:'管理待执行消息，共 1 条',exact:true});await expect(pending).toBeVisible();
    const pendingBox=(await pending.boundingBox())!,taskBox=(await tasks.boundingBox())!;
    expect(pendingBox.y+pendingBox.height).toBeLessThanOrEqual(taskBox.y);
    expect(f.inputs).toHaveLength(0);expect(f.turns).toHaveLength(1);
    await input.fill('保留这条草稿');
    await page.setViewportSize({width:320,height:844});
    await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
    expect(await dock.locator(':scope > span').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    const narrowBar=(await page.locator('.conversation-task-bar').boundingBox())!,narrowChoice=(await page.locator('.claude-send-choice').boundingBox())!;
    expect(narrowBar.y+narrowBar.height).toBeLessThanOrEqual(narrowChoice.y);
    expect(await page.locator('.composer-wrap').evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);
    await expect(input).toHaveValue('保留这条草稿');
    await page.screenshot({path:info.outputPath('phone-active-background-320-dark.png')});
    await dock.click();await expect(page.locator('.background-task-group')).toBeInViewport();await expect(dock).toHaveCount(0);
    await expect(page.getByRole('radiogroup',{name:'发送方式',exact:true})).toBeVisible();
  } finally {await page.close();await f.close();}
});

for (const phone of [false,true]) test(`${phone ? 'phone' : 'desktop'}: native background task impact is confirmed only when stopping`, async ({page},info)=>{
  await page.setViewportSize(phone?{width:390,height:844}:{width:1360,height:900});
  const f=await sendChoiceFixture();f.options.stopScope='subagents';
  f.options.tasks=[
    {id:'audit',label:'核对发布清单',kind:'subagent',mode:'background',status:'running',canStop:true,updatedAt:Date.now()},
    {id:'layout',label:'检查手机布局',kind:'subagent',mode:'background',status:'running',canStop:true,updatedAt:Date.now()},
    {id:'shell',label:'独立后台命令',kind:'shell',mode:'background',status:'running',canStop:true,updatedAt:Date.now()},
    {id:'done',label:'已完成的检查',kind:'subagent',mode:'background',status:'done',canStop:false,updatedAt:Date.now()},
  ];
  try {
    await open(page,f,phone);
    // Native tasks need no saved scoped card to require an impact confirmation.
    await expect(page.locator('.native-run.is-scoped')).toHaveCount(0);
    await page.locator('.composer-stop').click();
    const dialog=page.getByRole('dialog',{name:'停止当前消息？',exact:true});
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('核对发布清单');await expect(dialog).toContainText('检查手机布局');
    await expect(dialog).not.toContainText('独立后台命令');await expect(dialog).not.toContainText('已完成的检查');
    await expect(page.locator('.engine-tasks-stop-impact')).toHaveCount(0);
    await expect(page.locator('.claude-send-choice')).toBeVisible();
    await page.screenshot({path:info.outputPath('stop-impact-confirmation.png')});
    await dialog.getByRole('button',{name:'继续运行',exact:true}).click();
    await expect(dialog).toHaveCount(0);await expect(page.locator('.composer-stop')).toBeVisible();
    // A failed fresh lookup cannot silently turn into "no background work".
    await page.route(/\/api\/conversations\/[^/]+\/tasks/,route=>route.fulfill({status:503,body:'unavailable'}));
    await page.locator('.composer-stop').click();await expect(dialog).toContainText('后台任务列表暂时无法核对');
    await dialog.getByRole('button',{name:'继续运行',exact:true}).click();
    await page.unroute(/\/api\/conversations\/[^/]+\/tasks/);
    await page.locator('.composer-stop').click();await expect(dialog).toContainText('核对发布清单');
    await dialog.getByRole('button',{name:'确认停止',exact:true}).click();
    await expect(dialog).toHaveCount(0);await expect(page.locator('.composer-stop')).toHaveCount(0);
  } finally {await page.close();await f.close();}
});
