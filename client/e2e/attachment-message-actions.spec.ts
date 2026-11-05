import { preparePairing } from "./fixtures/pairing-invite.js";
import { holdMessage, messageAction, messageActionScope } from './fixtures/message-actions.js';
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { showDisconnectedBots, selectConversation, waitForClientOnline, mobileChatAction, isPhone } from './fixtures/mobile.js';

test.use({ actionTimeout: 10_000 });
for (const width of [1360, 390, 320]) test(`file delivery combines caption and documents without duplicating message actions at ${width}px`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'file-delivery-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width <= 760 });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','GG1','fixture','codex')");
    const chat = await hub.store.createConversation('owner', ['alpha'], '文件交付', 'files');
    const target = await hub.store.createConversation('owner', ['alpha'], '文档归档', 'target');
    const caption = '《正念的修习》内容总结\n已整理为 Word 和 PDF，方便编辑与阅读。';
    const files = [];
    const word = await readFile('e2e/fixtures/documents/reading.docx');
    for (const [name, bytes, mime] of [
      ['济群法师正念的修习_内容总结.docx', word, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['济群法师正念的修习_内容总结.pdf', await readFile('e2e/fixtures/pdf/reading.pdf'), 'application/pdf'],
    ] as const) {
      const attachmentId = await hub.attachments.importForBot('alpha', { conversationId: chat.id, name, mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, bytes);
      files.push({ type: 'file' as const, attachmentId, name, mime, size: bytes.length });
    }
    const message = await hub.store.publishBotMessage('alpha', { conversationId: chat.id, blocks: [{ type: 'text', text: caption }, ...files] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    const article = page.locator(`[data-message-id="${message.id}"]`), delivery = article.locator('.file-delivery');
    const file = article.getByRole('region', { name: files[0]!.name, exact: true });
    await expect(delivery).toHaveCount(1); await expect(delivery.locator('.file-card')).toHaveCount(2);
    await expect(delivery.locator('.file-delivery-caption')).toHaveText(caption);
    await expect(article.locator('.rich-card')).toHaveCount(0);
    await expect(article.getByRole('button', { name: '引用回复', exact: true })).toHaveCount(isPhone(page) ? 0 : 1);
    await expect(article.getByRole('button', { name: '转发消息', exact: true })).toHaveCount(isPhone(page) ? 0 : 1);
    for (const theme of ['light', 'dark']) for (const palette of ['white-teal', 'cli', 'pixel']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
      expect(await delivery.evaluate(node => {
        const outer = node.getBoundingClientRect();
        return [...node.querySelectorAll('.file-card, .file-delivery-caption')].every(child => {
          const rect = child.getBoundingClientRect(); return rect.left >= outer.left && rect.right <= outer.right && child.scrollWidth <= child.clientWidth + 1;
        });
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const row of await delivery.locator('.file-card').all()) {
        await expect(row).toHaveCSS('background-image', 'none');
        await expect(row).toHaveCSS('box-shadow', 'none');
      }
      await article.screenshot({ path: info.outputPath(`delivery-${width}-${palette}-${theme}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dataset.palette = 'white-teal'; document.documentElement.dataset.theme = 'light'; });
    await file.getByRole('button', { name: /^预览(?: |$)/ }).click();
    const preview = page.getByRole('dialog', { name: '文件预览', exact: true });
    await expect(preview.getByRole('heading', { name: '文档阅读预览', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(preview).toBeHidden();
    const download = page.waitForEvent('download');
    await file.getByRole('button', { name: `另存为 ${files[0]!.name}`, exact: true }).click();
    const saved = await download; expect(await readFile((await saved.path())!)).toEqual(word);
    await messageAction(page, article, '引用回复');
    await expect(page.locator('.reply-preview')).toContainText('《正念的修习》内容总结');
    await page.getByRole('button', { name: '取消引用', exact: true }).click();
    await messageAction(page, article, '转发消息');
    const forward = page.getByRole('dialog', { name: '转发消息', exact: true });
    await forward.getByRole('button', { name: target.title, exact: true }).click();
    await forward.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true }).uncheck();
    await forward.getByRole('button', { name: '确认转发', exact: true }).click(); await expect(forward).toBeHidden();
    // Closing confirms local outbox enqueue; the Hub commits the forwarded copy asynchronously.
    await expect.poll(async () => (await hub.store.snapshot('owner', target.id)).messages.length).toBe(1);
    const copies = (await hub.store.snapshot('owner', target.id)).messages;
    expect(copies).toHaveLength(1);
    expect(copies[0]!.blocks.map(block => block.type)).toEqual(['text', 'file', 'file']);
    expect(copies[0]!.blocks[0]).toEqual({ type: 'text', text: caption });
    expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [1360, 390]) test(`attachment reply and forwarding deliver readable copies to another Bot at ${width}px`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'attachment-actions-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390 });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','资料助手','fixture'),('beta','审阅助手','fixture')");
    const source = await hub.store.createConversation('owner', ['alpha'], '资料来源', 'source');
    const target = await hub.store.createConversation('owner', ['beta'], '文档审阅', 'target');
    const group = await hub.store.createConversation('owner', ['alpha', 'beta'], '多人讨论', 'group', { type: 'group' });
    const name = '需要阅读的资料.txt', bytes = Buffer.from('只有文件里有的内容：编号 74893162。');
    const id = await hub.attachments.importForBot('alpha', { conversationId: source.id, name, mime: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, bytes);
    const message = await hub.store.publishBotMessage('alpha', { conversationId: source.id, blocks: [{ type: 'file', attachmentId: id, name, mime: 'text/plain', size: bytes.length }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, source.title);
    const article = page.locator(`[data-message-id="${message.id}"]`), file = article.getByRole('region', { name, exact: true });
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    if (width > 760) {
      await expect(article.getByRole('button', { name: /^引用(?:附件|回复)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
      await expect(article.getByRole('button', { name: /^转发(?:附件|消息)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
      await expect(file.getByRole('group', { name: '附件操作', exact: true })).toHaveCount(0);
    }
    await composer.fill('请阅读这个文件');
    await messageAction(page, article, '引用回复');
    await expect(composer).toBeFocused(); await expect(composer).toHaveValue('请阅读这个文件');
    await expect(page.locator('.reply-preview')).toContainText(name);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot('owner', source.id)).messages.some(item => item.authorType === 'user' && item.replyTo === message.id)).toBe(true);
    await messageAction(page, article, '转发消息');
    let dialog = page.getByRole('dialog', { name: '转发消息', exact: true });
    await dialog.getByRole('textbox', { name: '搜索转发目标', exact: true }).fill('审阅助手');
    await dialog.getByRole('button', { name: target.title, exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true })).toBeChecked();
    await expect(dialog).toContainText('附件会一并交给所选 Bot 读取');
    await dialog.getByRole('button', { name: '确认转发', exact: true }).click(); await expect(dialog).toBeHidden();
    await expect.poll(async () => (await hub.store.snapshot('owner', target.id)).messages.length).toBe(1);
    const copies = (await hub.store.snapshot('owner', target.id)).messages;
    expect(copies).toHaveLength(1); const copy = copies[0]!;
    expect(copy.mentions).toEqual(['beta']); expect((await hub.store.pendingForBot('beta')).map(item => item.id)).toContain(copy.id);
    const copiedId = copy.blocks.find(block => block.type === 'file')!.attachmentId; expect(copiedId).not.toBe(id);
    await expect(hub.attachments.download({ botId: 'beta' }, id)).rejects.toThrow('bot_forbidden');
    await hub.store.publishBotMessage('alpha', { id: message.id, conversationId: source.id, status: 'deleted', blocks: [] });
    expect(await readFile((await hub.attachments.download({ botId: 'beta' }, copiedId)).path)).toEqual(bytes);
    const copiedArticle = page.locator(`[data-message-id="${copy.id}"]`);
    const copiedFile = copiedArticle.getByRole('region', { name, exact: true });
    await messageAction(page, copiedArticle, '引用回复');
    await expect(page.locator('.reply-preview')).toContainText(name);
    await page.getByRole('button', { name: '取消引用', exact: true }).click();
    await copiedFile.getByRole('button', { name: /^预览(?: |$)/ }).click();
    await expect(page.getByRole('dialog', { name: '文件预览', exact: true }).locator('pre')).toHaveText(bytes.toString());
    await page.keyboard.press('Escape');
    await messageAction(page, copiedArticle, '转发消息');
    dialog = page.getByRole('dialog', { name: '转发消息', exact: true });
    await dialog.getByRole('button', { name: group.title, exact: true }).click();
    // Groups require an explicit decision, never silently fan out to all Bots.
    await expect(dialog.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true })).not.toBeChecked();
    await dialog.getByRole('button', { name: '确认转发', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await hub.store.snapshot('owner', group.id)).messages.length).toBe(1);
    const silent = (await hub.store.snapshot('owner', group.id)).messages[0]!;
    expect((await hub.store.pendingForBot('beta')).some(item => item.id === silent.id)).toBe(false);
    await page.screenshot({ path: info.outputPath(`attachment-actions-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [1360, 390]) test(`image batches and audio preserve modal preview and attachment actions at ${width}px`, async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'media-actions-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width === 390 });
  const page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','资料助手','fixture')");
    const source = await hub.store.createConversation('owner', ['alpha'], '图片与音频', 'source');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const imageId = await hub.attachments.importForBot('alpha', { conversationId: source.id, name: '图片.png', mime: 'image/png', size: png.length, sha256: createHash('sha256').update(png).digest('hex') }, png);
    // A single PCM sample is rejected by WebKit's decoder. Use the same real
    // audio fixture as playback acceptance, so this tests actions and rotation.
    const wav = await readFile('e2e/fixtures/media/tone.wav');
    const audioId = await hub.attachments.importForBot('alpha', { conversationId: source.id, name: '音频.wav', mime: 'audio/wav', size: wav.length, sha256: createHash('sha256').update(wav).digest('hex') }, wav);
    const image = await hub.store.publishBotMessage('alpha', { conversationId: source.id, blocks: [{ type: 'card', elements: [{ type: 'image', attachmentId: imageId, text: '第一张' }, { type: 'image', attachmentId: imageId, text: '第二张' }] }] });
    const audio = await hub.store.publishBotMessage('alpha', { conversationId: source.id, status: 'streaming', blocks: [{ type: 'audio', attachmentId: audioId }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner'); await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, source.title);
    const images = page.locator(`[data-message-id="${image.id}"]`), audioRow = page.locator(`[data-message-id="${audio.id}"]`);
    await expect(images.getByRole('button', { name: /^引用(?:附件|回复)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
    await expect(images.getByRole('button', { name: /^转发(?:附件|消息)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
    await expect(audioRow.getByRole('button', { name: /^引用(?:附件|回复)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
    await expect(audioRow.getByRole('button', { name: /^转发(?:附件|消息)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
    const opener = images.getByRole('button', { name: '第一张', exact: true }), preview = page.getByRole('dialog', { name: '图片预览', exact: true });
    await expect(page.locator('.attachment-message-actions')).toHaveCount(0);
    if (isPhone(page)) {
      const sheet = page.getByRole('dialog', { name: '消息操作', exact: true });
      await holdMessage(page, images, opener);
      await expect(sheet.getByRole('button', { name: '引用回复', exact: true })).toBeEnabled();
      await expect(preview).toHaveCount(0);
      await page.keyboard.press('Escape');
      const player = audioRow.locator('audio[controls]');
      // Native playback and seek controls must not turn a hold into a message menu.
      await player.dispatchEvent('pointerdown', { pointerId: 8, pointerType: 'touch', isPrimary: true, button: 0 });
      await page.waitForTimeout(650); await expect(sheet).toBeHidden();
      await player.dispatchEvent('pointermove', { pointerId: 8, pointerType: 'touch', clientX: 160, clientY: 220 });
      await player.dispatchEvent('pointerup', { pointerId: 8, pointerType: 'touch', isPrimary: true });
      if (browser.browserType().name() === 'chromium') {
        const time = audioRow.locator('.message-meta time');
        await time.scrollIntoViewIfNeeded(); await time.click({ trial: true });
        const rect = (await time.boundingBox())!, cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }] });
        await expect(sheet).toBeVisible();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      } else await holdMessage(page, audioRow, audioRow.locator('.message-meta time'));
      await expect(sheet.getByRole('button', { name: '引用回复', exact: true })).toBeEnabled();
      await expect(sheet.getByRole('button', { name: '转发消息', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
    }
    await opener.click(); await expect(preview).toBeVisible();
    expect(await preview.evaluate(node => node.matches(':modal'))).toBe(true);
    await expect(preview.locator('.image-preview-title')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(preview.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await preview.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape'); await expect(preview).toHaveCount(0); await expect(opener).toBeFocused();
    await opener.click(); await expect(preview).toBeVisible();
    // Native/programmatic dismissal emits close without cancel. React must
    // retire the preview state so clicking the same image can open it again.
    await preview.evaluate(node => (node as HTMLDialogElement).close());
    await expect(page.locator('dialog.image-preview-lightbox')).toHaveCount(0); await expect(opener).toBeFocused();
    await opener.click(); await expect(preview).toBeVisible();
    expect(await preview.evaluate(node => node.matches(':modal'))).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('tarocub-native-back', { cancelable: true })));
    await expect(preview).toHaveCount(0); await expect(opener).toBeFocused();
    await opener.click(); await preview.getByRole('button', { name: '关闭', exact: true }).click();
    // Mixed messages still have one owner: nested images, audio and a separate
    // document delivery must not each grow their own quote/forward footer.
    await hub.store.publishBotMessage('alpha', { id: image.id, conversationId: source.id, blocks: [
      ...image.blocks, { type: 'audio', attachmentId: audioId },
      { type: 'text', text: '附件原图' },
      { type: 'file', attachmentId: imageId, name: '图片.png', mime: 'image/png', size: png.length },
    ] });
    await expect(images.locator('.file-delivery')).toHaveCount(1);
    await expect(images.getByRole('button', { name: /^引用(?:附件|回复)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
    await expect(images.getByRole('button', { name: /^转发(?:附件|消息)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
    await expect(images.locator('.attachment-image .attachment-message-actions, .file-delivery .attachment-message-actions, .attachment-audio .attachment-message-actions')).toHaveCount(0);
    await messageAction(page, audioRow, '引用回复');
    await expect(page.locator('.reply-preview')).toBeVisible();
    // Resizing must switch the action owner without duplicating or losing actions.
    await page.setViewportSize({ width: width > 760 ? 390 : 1360, height: 844 });
    await expect(images.getByRole('button', { name: /^引用(?:附件|回复)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
    await expect(images.getByRole('button', { name: /^转发(?:附件|消息)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
    await expect(audioRow.getByRole('button', { name: /^引用(?:附件|回复)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
    await expect(audioRow.getByRole('button', { name: /^转发(?:附件|消息)$/ })).toHaveCount(isPhone(page) ? 0 : 1);
    await expect(page.locator('.reply-preview')).toBeVisible();
    await page.setViewportSize({ width, height: 844 });
    await expect(audioRow.locator('audio[controls]')).toBeVisible();
    let audioActions = await messageActionScope(page, audioRow);
    await expect(audioActions.getByRole('button', { name: '转发消息', exact: true })).toBeDisabled();
    await hub.store.publishBotMessage('alpha', { id: audio.id, conversationId: source.id, status: 'complete', blocks: audio.blocks });
    await expect(audioActions.getByRole('button', { name: '转发消息', exact: true })).toBeEnabled();
    if (isPhone(page)) await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '取消引用', exact: true }).click();
    await mobileChatAction(page, '对话设置');
    await page.getByRole('button', { name: '归档对话', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeHidden();
    // Archive closes settings after its receipt. The suspended phone detail
    // sheet then returns, so wait for it before returning to the conversation.
    await expect(page.getByRole('dialog', { name: '对话设置', exact: true })).toBeHidden();
    if (isPhone(page)) await page.getByRole('dialog', { name: '对话详情', exact: true }).getByRole('button', { name: '返回聊天', exact: true }).click();
    audioActions = await messageActionScope(page, audioRow);
    await expect(audioActions.getByRole('button', { name: '引用回复', exact: true })).toBeDisabled();
    await expect(audioActions.getByRole('button', { name: '转发消息', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
