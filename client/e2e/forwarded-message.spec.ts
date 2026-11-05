import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { showDisconnectedBots, selectConversation, waitForClientOnline } from './fixtures/mobile.js';

const cases = [
  { width: 1360, kind: 'image', text: '为什么', adhd: false },
  { width: 390, kind: 'image', text: '为什么', adhd: false },
  { width: 320, kind: 'image', text: '', adhd: false },
  { width: 390, kind: 'file', text: '请看这份文件', adhd: false },
  { width: 1700, kind: 'image', text: '为什么', adhd: true },
];

for (const config of cases) test(`forward source and content share one bubble (${config.width} ${config.kind} ${config.adhd ? 'ADHD' : 'chat'} ${config.text ? 'caption' : 'only'})`, async ({ page }, info) => {
  await page.setViewportSize({ width: config.width, height: 940 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'forward-bubble-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await hub.profile.update({ name: '测试主机', revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const source = await hub.store.createConversation('owner', ['alpha'], '资料来源与讨论', 'source');
    const target = await hub.store.createConversation('owner', ['alpha'], '转发讨论', 'target');
    const others = [];
    if (config.adhd) for (let i = 0; i < 3; i++) others.push(await hub.store.createConversation('owner', ['alpha'], `其他讨论 ${i}`, `other-${i}`));
    const bytes = config.kind === 'image' ? await readFile('src/assets/bot-avatars/hamster.webp') : Buffer.from('文件原文，转发后仍然可以预览。');
    const name = config.kind === 'image' ? '图片.webp' : '说明.txt', mime = config.kind === 'image' ? 'image/webp' : 'text/plain';
    const upload = await hub.attachments.create('owner', { conversationId: source.id, name, mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await hub.attachments.putChunk('owner', upload.id, 0, bytes); await hub.attachments.complete('owner', upload.id);
    const { message: original } = await hub.store.sendMessage('owner', { conversationId: source.id, clientMsgId: 'original', text: config.text, attachments: [upload.id] });
    const { message: copy } = await hub.attachments.forward('owner', { v: 1, type: 'message.forward', conversationId: target.id, sourceMessageId: original.id, clientMsgId: 'forward' });
    expect(copy.forwardedFrom?.messageId).toBe(original.id);
    const media = copy.blocks.find(block => block.type === config.kind)!;
    if (!('attachmentId' in media)) throw new Error('Missing forwarded attachment');
    expect(media.attachmentId).not.toBe(upload.id);
    expect(await readFile((await hub.attachments.download({ userId: 'owner' }, media.attachmentId)).path)).toEqual(bytes);
    await page.goto(hub.url);
    await page.getByLabel('主机名称', { exact: true }).fill('测试主机');
    await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
    await waitForClientOnline(page); await showDisconnectedBots(page);
    if (config.adhd) {
      await page.getByRole('button', { name: '打开 ADHD 模式', exact: true }).click();
      for (const chat of [target, ...others]) await page.getByRole('checkbox', { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
      await page.getByLabel('ADHD 每行窗口数').selectOption('4');
      await page.getByLabel('ADHD 窗口字号').selectOption('12');
    } else await selectConversation(page, target.title);
    const row = page.locator(`[data-message-id="${copy.id}"]`).filter({ visible: true });
    const bubble = row.locator('.message-blocks'), reference = bubble.locator(':scope > .forwarded-message');
    await expect(reference).toContainText('转发自 Owner');
    await expect(reference).toContainText(source.title);
    await expect(row.locator('.message-body > .message-reference')).toHaveCount(0);
    if (config.text) await expect(bubble.locator(':scope > .markdown')).toHaveText(config.text);
    if (config.kind === 'image') await expect(bubble.locator('.attachment-image img')).toBeVisible();
    for (const [palette, theme] of [['white-violet', 'light'], ['white-violet', 'dark'], ['mono', 'light'], ['cli', 'light'], ['pixel', 'dark'], ['tty', 'light'], ['paper', 'light'], ['agent', 'dark']]) {
      await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      // Theme buttons transition their inherited text color; measure the settled palette.
      await expect(async () => {
        const geometry = await bubble.evaluate(element => {
          const r = element.getBoundingClientRect(), source = element.querySelector('.forwarded-message')!, q = source.getBoundingClientRect();
          const body = source.nextElementSibling!.getBoundingClientRect();
          const luminance = (value: string) => { const rgb = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
          // Porcelain shows attachments beside the caption: the caption carries the bubble colour and the source line sits on the page.
          const own = getComputedStyle(element).backgroundColor, caption = element.querySelector(':scope > .markdown');
          const split = own === 'rgba(0, 0, 0, 0)' && !!caption && !!element.querySelector(':scope > :is(.attachment-image, .image-grid, .file-card)');
          const painted = (node: Element | null): string => { for (; node; node = node.parentElement) { const value = getComputedStyle(node).backgroundColor; if (value !== 'rgba(0, 0, 0, 0)') return value; } return 'rgb(255, 255, 255)'; };
          const color = split ? getComputedStyle(caption!).backgroundColor : own, text = getComputedStyle(source.querySelector('strong')!).color;
          const a = luminance(split ? painted(element.parentElement) : color), b = luminance(text);
          return { inside: q.left >= r.left && q.right <= r.right + 1 && q.top >= r.top && body.top >= q.bottom && body.bottom <= r.bottom + 1,
            overflow: element.scrollWidth > element.clientWidth + 1, viewport: r.left >= 0 && r.right <= innerWidth + 1,
            contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), background: color, split, sourceBackground: getComputedStyle(source).backgroundColor,
            buttonBackground: getComputedStyle(source.querySelector('button')!).backgroundColor };
        });
        expect(geometry.inside, `${palette} ${theme}`).toBe(true);
        expect(geometry.overflow, `${palette} ${theme}`).toBe(false);
        expect(geometry.viewport).toBe(true);
        expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(geometry.split, `${palette} ${theme}`).toBe(['white-violet', 'mono'].includes(palette) && !!config.text);
        expect(geometry.sourceBackground).toBe('rgba(0, 0, 0, 0)');
        expect(geometry.buttonBackground).toBe('rgba(0, 0, 0, 0)');
        expect(geometry.contrast, `${palette} ${theme}`).toBeGreaterThanOrEqual(4.5);
      }).toPass({ timeout: 5000 });
      if (palette === 'white-violet') await row.screenshot({ path: info.outputPath(`bubble-${theme}.png`), animations: 'disabled' });
    }
    if (config.kind === 'image') {
      await bubble.locator('.attachment-image button').first().click();
      await expect(page.getByRole('dialog', { name: '图片预览', exact: true })).toBeVisible();
    } else {
      await bubble.getByRole('button', { name: /^预览(?: |$)/ }).click();
      await expect(page.getByRole('dialog', { name: '文件预览', exact: true }).locator('pre')).toHaveText(bytes.toString());
    }
    await page.keyboard.press('Escape');
    await reference.getByRole('button', { name: '查看转发来源', exact: true }).click();
    await expect(page.locator(`[data-message-id="${original.id}"]`).filter({ visible: true })).toHaveClass(/focused-message/);
    expect((await hub.store.snapshot('owner', target.id)).messages).toEqual([copy]);
    expect(errors).toEqual([]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
