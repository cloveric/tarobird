import { preparePairing } from "./fixtures/pairing-invite.js";
import { messageAction } from './fixtures/message-actions.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { showDisconnectedBots, selectConversation, waitForClientOnline } from './fixtures/mobile.js';

for (const width of [320, 390, 1360]) test(`sent long images stay compact and open at readable width at ${width}px`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'message-images-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 760, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const receipt = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 7200;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 720, 7200);
      ctx.fillStyle = '#202020'; ctx.font = 'bold 38px sans-serif'; ctx.fillText('October receipts', 35, 70);
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = i % 2 ? '#f2f4f4' : '#fff'; ctx.fillRect(20, 130 + i * 170, 680, 170);
        ctx.fillStyle = '#303838'; ctx.font = '28px sans-serif'; ctx.fillText(`Receipt ${i + 1}                       $ ${85 + i}`, 35, 210 + i * 170);
      }
      ctx.fillStyle = '#244d41'; ctx.fillRect(0, 7060, 720, 140);
      ctx.fillStyle = '#fff'; ctx.fillText('End of receipt', 35, 7140);
      return canvas.toDataURL('image/png').split(',')[1]!;
    }), 'base64');
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','记账助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['alpha'], '十月账单', 'receipts');
    const target = await hub.store.createConversation('owner', ['alpha'], '账单归档', 'archive');
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    // Load both bundled faces before rapidly cycling themes. WebKit can leave
    // a lazily requested face pending during screenshot font-readiness waits.
    await page.evaluate(async () => {
      await document.fonts.load('12px "Sarasa Term SC"');
      await document.fonts.load('600 12px "Sarasa Term SC"');
    });
    await page.evaluate(() => { document.documentElement.dataset.palette = 'mono'; });
    const upload = async (names: string[], bytes = receipt, caption = '请整理这些账单，重复的条目只算一次。') => {
      const chooser = page.waitForEvent('filechooser');
      if (width < 760) {
        await page.getByRole('button', { name: '添加附件', exact: true }).click();
        await page.getByRole('dialog', { name: '添加附件', exact: true }).getByRole('button', { name: '附加图片', exact: true }).click();
      } else await page.getByRole('button', { name: '添加文件', exact: true }).click();
      await (await chooser).setFiles(names.map(name => ({ name, mimeType: 'image/png', buffer: bytes })));
      await page.getByRole('textbox', { name: '消息', exact: true }).fill(caption);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
    };
    await upload(['十月消费长图.png']);
    const row = page.locator('.message.user').last(), image = row.locator('.attachment-image img');
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalHeight)).toBe(7200);
    const thumbnail = await image.boundingBox();
    expect(thumbnail!.height).toBeLessThanOrEqual(200); expect(thumbnail!.width).toBeGreaterThan(150);
    expect(thumbnail!.width).toBeLessThanOrEqual(180);
    await expect(row.locator('figcaption')).toBeHidden();
    await expect(row).toContainText('长图 · 点击查看');
    expect((await row.locator('.message-blocks').boundingBox())!.height).toBeLessThan(320);
    await page.screenshot({ path: info.outputPath(`long-image-${width}.png`), animations: 'disabled' });
    const opener = row.getByRole('button', { name: '十月消费长图.png', exact: true }); await opener.click();
    const viewer = page.getByRole('dialog', { name: '图片预览', exact: true }); await expect(viewer).toBeVisible();
    await expect(viewer.locator('.image-preview-title')).toBeFocused();
    await page.screenshot({ path: info.outputPath(`image-preview-open-${width}.png`), animations: 'disabled' });
    const downloading = page.waitForEvent('download');
    await viewer.getByRole('button', { name: '另存为', exact: true }).click();
    const downloaded = await downloading;
    expect(downloaded.suggestedFilename()).toBe('十月消费长图.png');
    expect(await readFile((await downloaded.path())!)).toEqual(receipt);
    await expect(viewer.getByRole('status')).toHaveText('已交给浏览器下载');
    const original = viewer.locator('img'), scroll = viewer.locator('.image-preview-scroll');
    await expect.poll(() => original.evaluate(node => { const img = node as HTMLImageElement; return img.complete && img.naturalWidth === 720 && img.naturalHeight === 7200; })).toBe(true);
    expect((await original.boundingBox())!.width).toBeGreaterThan(Math.min(width - 40, 700));
    await original.click({ position: { x: 50, y: 50 } }); await expect(viewer).toBeVisible();
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
    expect(await scroll.evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 2)).toBe(true);
    await expect(viewer.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`long-image-end-${width}.png`), animations: 'disabled' });
    await page.evaluate(() => window.dispatchEvent(new Event('tarocub-native-back', { cancelable: true })));
    await expect(viewer).toHaveCount(0); await expect(opener).toBeFocused();
    await upload(['账单一.png', '账单二.png', '账单三.png']);
    const gallery = page.locator('.message.user').last().locator('.image-grid');
    await expect(gallery.locator('img')).toHaveCount(3);
    const boxes = await gallery.locator('.attachment-image').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height }; }));
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x); expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
    expect((await gallery.boundingBox())!.width).toBeLessThanOrEqual(280);
    expect((await gallery.boundingBox())!.height).toBeLessThan(340);
    await page.screenshot({ path: info.outputPath(`image-gallery-${width}.png`), animations: 'disabled' });
    await gallery.getByRole('button', { name: '账单三.png', exact: true }).click(); await expect(viewer).toBeVisible();
    await page.keyboard.press('Escape'); await expect(viewer).toHaveCount(0);
    // These shortcuts act on the entire source message, not one thumbnail.
    const batch = page.locator('.message.user').last();
    await expect(batch.getByRole('button', { name: /^引用(?:附件|回复)$/ })).toHaveCount(width > 760 ? 1 : 0);
    await expect(batch.getByRole('button', { name: /^转发(?:附件|消息)$/ })).toHaveCount(width > 760 ? 1 : 0);
    const sourceId = (await batch.getAttribute('data-message-id'))!;
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('继续检查账单');
    await messageAction(page, batch, '引用回复');
    await expect(composer).toHaveValue('继续检查账单'); await expect(composer).toBeFocused();
    await expect(page.locator('.reply-preview')).toContainText('请整理这些账单');
    await page.getByRole('button', { name: '取消引用', exact: true }).click();
    await messageAction(page, batch, '转发消息');
    const forward = page.getByRole('dialog', { name: '转发消息', exact: true });
    await forward.getByRole('button', { name: target.title, exact: true }).click();
    await forward.getByRole('checkbox', { name: '让 Bot 回复这条转发', exact: true }).uncheck();
    await forward.getByRole('button', { name: '确认转发', exact: true }).click(); await expect(forward).toBeHidden();
    await expect.poll(async () => (await hub.store.snapshot('owner', target.id)).messages.length).toBe(1);
    const copy = (await hub.store.snapshot('owner', target.id)).messages[0]!;
    expect(copy.forwardedFrom?.messageId).toBe(sourceId);
    expect(copy.blocks.map(block => block.type)).toEqual(['text', 'image', 'image', 'image']);
    for (const block of copy.blocks) if (block.type === 'image') {
      expect(await readFile((await hub.attachments.download({ botId: 'alpha' }, block.attachmentId)).path)).toEqual(receipt);
    }
    await selectConversation(page, chat.title);
    // Ordinary portrait/square/landscape images need the same bounds, not just
    // the special long-receipt branch. Exercise image-only and captioned sends.
    for (const [name, w, h, caption] of [
      ['手机截图.png', 720, 1280, '这张图有什么风险？'],
      ['照片.png', 900, 900, ''],
      ['横图.png', 1280, 720, '请看看这张图。'],
    ] as const) {
      const bytes = Buffer.from(await page.evaluate(([w, h]) => {
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#2468a0'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif'; ctx.fillText('Original image', 40, 80);
        ctx.fillStyle = '#90c5e0'; ctx.fillRect(40, h - 120, w - 80, 80);
        return canvas.toDataURL('image/png').split(',')[1]!;
      }, [w, h]), 'base64');
      await upload([name], bytes, caption);
      const sent = page.locator('.message.user').filter({ has: page.getByRole('button', { name, exact: true }) });
      const thumb = sent.locator('.image-thumbnail img');
      await expect(thumb).toBeVisible();
      await expect.poll(() => thumb.evaluate(node => (node as HTMLImageElement).naturalHeight)).toBe(h);
      for (const palette of ['mono', 'cli', 'pixel']) {
        await page.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
        await sent.scrollIntoViewIfNeeded();
        const box = (await thumb.boundingBox())!;
        expect(box.width).toBeLessThanOrEqual(180); expect(box.height).toBeLessThanOrEqual(200);
        expect(box.width / box.height).toBeCloseTo(w / h, 1);
        await expect(sent.locator('figcaption')).toBeHidden();
        await expect(viewer).toHaveCount(0);
        if (name === '手机截图.png') await page.screenshot({ path: info.outputPath(`portrait-${palette}-${width}.png`), animations: 'disabled' });
      }
      const open = sent.getByRole('button', { name, exact: true }); await open.click();
      await expect(viewer).toBeVisible();
      expect(await viewer.locator('img').evaluate(node => {
        const img = node as HTMLImageElement; return [img.naturalWidth, img.naturalHeight];
      })).toEqual([w, h]);
      await page.keyboard.press('Escape'); await expect(viewer).toHaveCount(0); await expect(open).toBeFocused();
      const message = (await hub.store.snapshot('owner', chat.id)).messages.find(message => message.blocks.some(block => block.type === 'image' && block.title === name))!;
      const attachment = message.blocks.find(block => block.type === 'image')!;
      // A compact preview must never resize the bytes supplied to the Bot.
      expect(await readFile((await hub.attachments.download({ botId: 'alpha' }, attachment.attachmentId)).path)).toEqual(bytes);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await hub.store.snapshot('owner', chat.id)).messages).toHaveLength(5); expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
