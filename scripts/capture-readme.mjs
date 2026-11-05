// Capture real product surfaces with disposable data. Never attach a user's Hub.
// Prerequisites: npm run build && npm --prefix client run build
import { chromium, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { HubServer } from '../dist/src/hub/server.js';
import { ConversationFolders } from '../dist/src/hub/conversation-folders.js';
import { BOT_AVATAR_DEFAULT_PREFIX } from '../dist/src/hub/bot-avatar-default.js';
import { createHash } from 'node:crypto';
import { captureProvenance } from './readme-provenance.mjs';
import { prepareReadmePairing } from './readme-pairing.mjs';
import { compactReadmeBots, readmeAvatars, readmePreferences, readmeAppearance, visibleReadmeAvatars } from './readme-appearance.mjs';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'assets/product');
const { version: clientVersion } = JSON.parse(await readFile(path.join(root, 'client/package.json'), 'utf8'));
const provenance = await captureProvenance(root);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
// Keep seven distinct demo Bots; normal read receipts avoid repeated done faces.
const roles = ['codex', 'claude', 'gemini', 'kimi', 'deepseek', 'agy', 'studio'];
const ids = roles.map(role => `demo-${role}`);
const engines = ['codex', 'claude', 'antigravity', 'kimi', 'deepseek', 'antigravity', 'claude'];
const models = ['gpt-6-astra', 'claude-opus-5-5', 'gemini-3.8-flash-high', 'kimi-code/k3', 'deepseek-chat', 'gemini-4-argon', 'claude-opus-5-5'];
const names = ['Codex', 'Claude', 'Gemini', 'Kimi', 'DeepSeek', 'Antigravity', 'Claude · Studio'];
const copy = {
 en: { host: 'Studio', titles: ['Launch plan', 'Web copy', 'Design', 'Reading', 'Research', 'Visuals', 'Notes'], group: 'Product studio', topic: 'Release checklist', folders: ['Projects', 'Research'], previews: ['The release plan is ready for your review.', 'A clearer headline and three short sections.', 'Two visual directions to compare.', 'Key points and source links.', 'Five updates worth a look.', 'A fresh visual direction.', 'A short note for the team.'],
 prompt: 'Make a release plan from these notes. I’ll review it on my phone.',
 reply: '## A clear path to launch\n\nThree priorities for the next release.\n\n| Focus | Next step |\n| :--- | :--- |\n| Message | Explain one useful workflow |\n| Workspace | Choose Bots, models and a theme |\n| Access | Continue on desktop or phone |\n\n**Ready to review.** Pick up this plan on either screen.',
 next: 'Great. Keep the tone simple and friendly.', groupPreview: 'Claude: The checklist is ready. Let’s review it together.' },
 zh: { host: '我的 Mac', titles: ['发布计划', '网站文案', '视觉方向', '阅读笔记', '每周研究', '视觉探索', '工作室笔记'], group: '产品工作室', topic: '发布清单', folders: ['正在进行', '灵感与研究'], previews: ['发布计划整理好了，等你确认。', '标题更清晰了，正文精简为三个部分。', '两个方向：温和白瓷，或鲜明终端。', '要点已整理，也保留了来源链接。', '五条值得关注的更新，附上简短摘要。', '下一版视觉方向已准备好。', '给团队的一份简短记录。'],
 prompt: '把这份笔记整理成清晰的发布计划，我稍后在手机上看。',
 reply: '## 下一步，准备发布\n\n这次发布，先做好三件事。\n\n| 重点 | 下一步 |\n| :--- | :--- |\n| 讲清楚 | 展示一个实用的工作流程 |\n| 用顺手 | 选择 Bot、模型和主题 |\n| 随时跟进 | 在电脑与手机之间继续工作 |\n\n**等你确认，就可以继续。** 换一块屏幕，接着处理。',
 next: '好，语气简单、友好一点。', groupPreview: 'Claude：清单整理好了，一起来过一遍。' }
};
const receipt = [];
try {
 for (const locale of ['en', 'zh']) {
  const data = copy[locale], stateDir = await mkdtemp(path.join(os.tmpdir(), 'tarobot-readme-'));
  const hub = await HubServer.start({ stateDir, clientDir: path.join(root, 'client/dist') });
  let secondHub;
  const contexts = [], chats = [];
  try {
   // The Hub now names itself; use the demonstration name, never this machine's.
   await hub.profile.update({ name: data.host, revision: (await hub.profile.read()).revision });
   for (let i = 0; i < ids.length; i++) {
    await hub.store.db.run('INSERT INTO bots(id,name,secret_hash,engine,model,online) VALUES(?,?,?,?,?,1)', [ids[i], names[i], 'demo-only', engines[i], models[i]]);
    await hub.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [BOT_AVATAR_DEFAULT_PREFIX + ids[i], readmeAvatars[roles[i]]]);
    const chat = await hub.store.createConversation('owner', [ids[i]], data.titles[i], `chat-${i}`);
    chats.push(chat);
    if (i) await hub.store.publishBotMessage(ids[i], { conversationId: chat.id, blocks: [{ type: 'text', text: data.previews[i] }] });
   }
   const note = Buffer.from('# Launch notes\nA private workspace for agents, conversations and files.\n');
   const attachmentId = await hub.attachments.importForBot(ids[0], { conversationId: chats[0].id, name: 'launch-notes.md', mime: 'text/markdown', size: note.length, sha256: createHash('sha256').update(note).digest('hex') }, note);
   await hub.store.sendMessage('owner', { conversationId: chats[0].id, clientMsgId: 'launch-request', text: data.prompt, attachments: [attachmentId] });
   const mainResponse = await hub.store.publishBotMessage(ids[0], { conversationId: chats[0].id, blocks: [{ type: 'text', text: data.reply }] });
   // Ordinary read receipts, not screenshot CSS: the hero is an active
   // workspace, not a row of completed-but-unread celebrations and badges.
   for (const chat of chats) await hub.store.markRead('owner', chat.id, Number.MAX_SAFE_INTEGER);
   const folders = new ConversationFolders(hub.store.db); let revision = 0;
   for (let i = 0; i < 2; i++) await folders.change('owner', { type: 'create', revision: revision++, id: `folder-${i}`, name: data.folders[i] });
   for (const [conversationId, folderId] of chats.map((chat, i) => [chat.id, i < 2 ? 'folder-0' : 'folder-1'])) await folders.change('owner', { type: 'move', revision: revision++, conversationId, folderId });
   async function paired(width, height, multiHost = false) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: locale === 'en' ? 'en-GB' : 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block', hasTouch: width < 761 }); contexts.push(context);
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', error => { throw error; });
    await page.goto(hub.url);
    await page.getByLabel('主机名称', { exact: true }).fill(data.host);
    await prepareReadmePairing(page, hub);
    await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.host-workspace:not([hidden]) .app-shell').waitFor({ state: 'visible' });
    if (multiHost) {
     secondHub = await HubServer.start({ stateDir: path.join(stateDir, 'second-host'), origins: [hub.url] });
     const name = locale === 'en' ? 'Lab' : '实验室';
     await secondHub.profile.update({ name, revision: (await secondHub.profile.read()).revision });
     await page.getByRole('button', { name: /^工作台：/ }).filter({ visible: true }).click();
     await page.getByRole('button', { name: '连接另一台主机', exact: true }).click();
     await page.getByLabel('主机名称', { exact: true }).fill(name);
     await page.getByLabel('Hub 地址', { exact: true }).fill(secondHub.url);
     await prepareReadmePairing(page, secondHub);
     await page.getByRole('button', { name: '配对此设备', exact: true }).click();
     await secondHub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
     await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
     await page.locator('.host-workspace:not([hidden]) .app-shell').waitFor({ state: 'visible' });
    }
    // Seed only this disposable browser's ordinary preference store, then let
    // the unmodified App load it. No UI is restyled or hidden for the captures.
    await readmePreferences(page, locale, 'bots');
    await page.reload(); await page.locator('.host-workspace:not([hidden]) .app-shell').waitFor({ state: 'visible' });
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'mono');
    const firstBot = page.locator(`[data-avatar="bot:${ids[0]}"]`).filter({ visible: true }).first();
    await expect(firstBot).toHaveAttribute('data-preset', 'pastel-fox');
    await expect(firstBot.locator('img')).toHaveAttribute('src', /pastel-fox-/);
    return page;
   }
   async function capture(page, file) {
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(os.hostname().split('.')[0]);
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(img => img.getClientRects().length).map(img => img.decode().catch(() => {}))); });
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(output, file), animations: 'disabled' });
    receipt.push({ file, locale, viewport: page.viewportSize(), scale: 2, ...await readmeAppearance(page), visibleAvatars: await visibleReadmeAvatars(page), firstBotAvatar: { botId: ids[0], avatar: 'pastel-fox' }, sha256: createHash('sha256').update(await readFile(path.join(output, file))).digest('hex') });
   }
   const desktop = await paired(1200, 780);
   await desktop.locator(`.sidebar [data-conversation-id="${chats[0].id}"]`).click();
   await expect(desktop.locator('.message-blocks table')).toBeVisible();
   await expect(desktop.locator('.file-card .file-type-mark')).toHaveText('MD');
   await compactReadmeBots(desktop, ids[0]);
   await capture(desktop, `desktop-${locale}.png`);
   expect((await visibleReadmeAvatars(desktop)).sort()).toEqual(roles.map(role => readmeAvatars[role]).sort());
   // Add the group after the desktop hero; the other views illustrate grouping.
   const group = await hub.store.createConversation('owner', ids.slice(0, 3), data.group, 'product-group', { type: 'group' });
   const topic = await hub.store.createConversation('owner', [], data.topic, 'release-topic', { parentId: group.id });
   await hub.store.publishBotMessage(ids[1], { conversationId: topic.id, blocks: [{ type: 'text', text: data.groupPreview }] });
   await folders.change('owner', { type: 'move', revision: revision++, conversationId: group.id, folderId: 'folder-0' });
   await desktop.reload(); await desktop.locator(`.sidebar [data-conversation-id="${chats[0].id}"]`).click();
   await desktop.getByRole('button', { name: locale === 'en' ? 'Chats' : '按对话', exact: true }).click();
   await capture(desktop, `folders-${locale}.png`);
   for (const theme of ['light', 'dark']) {
    await readmePreferences(desktop, locale, 'conversations', theme);
    await desktop.reload();
    await desktop.locator(`.sidebar [data-conversation-id="${chats[0].id}"]`).click();
    await capture(desktop, `mono-${theme}-${locale}.png`);
   }
   // Group by host exists only when several hosts are paired. Record that
   // genuine state with a second disposable Hub, never by revealing hidden UI.
   const optionsPage = await paired(1200, 780, true);
   await optionsPage.locator(`.sidebar [data-conversation-id="${chats[0].id}"]`).filter({ visible: true }).click();
   await optionsPage.getByRole('button', { name: locale === 'en' ? 'Chats' : '按对话', exact: true }).filter({ visible: true }).click();
   await optionsPage.getByRole('group', { name: locale === 'en' ? 'List options' : '列表选项', exact: true }).filter({ visible: true }).press('Shift+F10');
   const menu = optionsPage.getByRole('menu', { name: locale === 'en' ? 'List options' : '列表选项', exact: true });
   await expect(menu).toBeVisible();
   await expect(menu.getByRole('checkbox', { name: locale === 'en' ? 'Group by host' : '按主机分组', exact: true })).toBeVisible();
   await expect(menu.getByRole('checkbox', { name: locale === 'en' ? 'Show disconnected Bots' : '显示未连接 Bot', exact: true })).toBeVisible();
   await expect(menu.getByRole('button', { name: locale === 'en' ? 'Manage folders' : '管理分组', exact: true })).toBeVisible();
   await capture(optionsPage, `list-options-${locale}.png`);
   await optionsPage.keyboard.press('Escape');
   await expect(menu).toBeHidden();
   const phone = await paired(390, 844);
   await phone.locator('.mobile-home').filter({ visible: true }).waitFor();
   await capture(phone, `mobile-${locale}.png`);
   await phone.locator(`.mobile-home [data-conversation-id="${chats[0].id}"]`).click();
   await hub.store.publishBotMessage(ids[0], { id: mainResponse.id, conversationId: chats[0].id, blocks: [{ type: 'text', text: locale === 'en' ? '**The first draft is ready.**\n\nThree milestones, a shorter introduction, and one place for open questions.' : '**第一版已经整理好了。**\n\n三个关键目标、更简洁的开头，以及一份待确认的问题清单。' }] });
   await hub.store.sendMessage('owner', { conversationId: chats[0].id, clientMsgId: 'friendly', text: data.next, attachments: [] });
   await hub.store.publishBotMessage(ids[0], { conversationId: chats[0].id, blocks: [{ type: 'text', text: locale === 'en' ? 'Absolutely. Clear language, short sections, and a friendly tone. You can pick this up on either screen.' : '没问题。用清晰的表达、简短的段落和友好的语气。你可以随时换到电脑接着处理。' }] });
   await expect(phone.locator('.message-blocks').filter({ hasText: locale === 'en' ? 'Absolutely.' : '没问题。' })).toBeVisible();
   await capture(phone, `mobile-chat-${locale}.png`);
  } finally { for (const context of contexts) await context.close(); if (secondHub) await secondHub.close(); await hub.close(); await rm(stateDir, { recursive: true, force: true }); }
 }
 await writeFile(path.join(output, 'capture.json'), JSON.stringify({ clientVersion, ...provenance, captured: new Date().toISOString(), source: 'built shared client, isolated loopback Hub, synthetic data', images: receipt }, null, 2) + '\n');
} finally { await browser.close(); }
