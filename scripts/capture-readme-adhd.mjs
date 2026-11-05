// Real shared-client captures, with disposable data and no production Hub.
// Prerequisites: npm run build && npm --prefix client run build
import { chromium, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { HubServer } from '../dist/src/hub/server.js';
import { ConversationFolders } from '../dist/src/hub/conversation-folders.js';
import { BOT_AVATAR_DEFAULT_PREFIX } from '../dist/src/hub/bot-avatar-default.js';
import { createHash } from 'node:crypto';
import { captureProvenance } from './readme-provenance.mjs';
import { recordReadmeMotion } from './readme-motion.mjs';
import { prepareReadmePairing } from './readme-pairing.mjs';
import { readmeAvatars, readmePreferences, readmeAppearance, visibleReadmeAvatars } from './readme-appearance.mjs';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'assets/product');
const { version } = JSON.parse(await readFile(path.join(root, 'client/package.json'), 'utf8'));
const provenance = await captureProvenance(root);
const bots = [
  ['codex', 'Codex', 'gpt-6-astra'], ['claude', 'Claude', 'claude-opus-5-5'],
  ['kimi', 'Kimi', 'kimi-code/k3'], ['deepseek', 'DeepSeek', 'deepseek-flash'],
  ['agy', 'Antigravity', 'gemini-4-argon'],
  ['antigravity', 'Gemini', 'gemini-3.8-flash-high'], ['claude', 'Claude · Notes', 'claude-opus-5-5'],
];
const copy = {
  zh: {
    host: '工作室', folder: '本周项目',
    titles: ['发布计划', '首页文案', '用户研究', '代码审查', '视觉探索', '日常运维', '阅读笔记'],
    prompts: ['把这次发布拆成三个清晰的步骤。', '首页介绍再短一点，保留产品的温度。', '整理访谈中最值得关注的三个需求。', '帮我检查这次改动，优先看真实的 bug。'],
    replies: [
      '**发布计划已整理好。**\n\n| 阶段 | 重点 |\n| :--- | :--- |\n| 准备 | 核对功能与演示素材 |\n| 验证 | 走通桌面和手机流程 |\n| 发布 | 更新说明与下载入口 |\n\n接下来先确认功能清单，再逐项验收。',
      '**让你的 AI 搭档，各就各位。**\n\n把不同 Bot 的对话放进同一个工作台。一个负责代码，一个整理资料，一个打磨文案。\n\n你可以分别交代任务，也可以随时回到某个对话继续细聊。\n\n**按钮文案：** 开始第一段对话',
      '**三个反复出现的需求**\n\n- **少切换：** 同时看到几段对话，不必来回找标签页。\n- **看进展：** 快速找到需要自己确认的地方。\n- **接着写：** 切换任务后，输入框里的草稿还在。\n\n建议先把「多对话同屏」作为演示的第一步。',
      '**正在检查状态与边界。**\n\n- [x] 各对话的草稿独立保存\n- [x] 切换面板保留输入内容\n- [x] 消息来源显示正确\n- [ ] 核对断线后的恢复流程\n\n我会把可复现的问题和改进建议分开整理。',
    ],
    draft: '文案可以再轻松一点。',
  },
  en: {
    host: 'Studio', folder: 'This week',
    titles: ['Launch plan', 'Website copy', 'User research', 'Code review', 'Visual exploration', 'Daily operations', 'Reading notes'],
    prompts: ['Break this launch into three clear steps.', 'Make the homepage copy shorter and warmer.', 'Find the three recurring needs in these interviews.', 'Review this change, starting with reproducible bugs.'],
    replies: [
      '**The launch plan is ready.**\n\n| Stage | Focus |\n| :--- | :--- |\n| Prepare | Check features and demo material |\n| Verify | Walk through desktop and phone flows |\n| Publish | Update notes and downloads |\n\nConfirm the feature list, then review each step.',
      '**Give every AI partner a place to work.**\n\nBring your Bot conversations into one workspace. One writes code, another gathers research, a third refines the copy.\n\nAssign each a task and return to any conversation when it needs your attention.\n\n**Button copy:** Start a conversation',
      '**Three recurring needs**\n\n- **Less switching:** See several conversations without hunting through tabs.\n- **Clear progress:** Find the questions that need your attention.\n- **Keep writing:** Return to a task with your draft still there.\n\nLead the demo with several conversations in view.',
      '**Checking state and edge cases.**\n\n- [x] Drafts saved per conversation\n- [x] Inputs retained when switching panes\n- [x] Correct message attribution\n- [ ] Recovery after a disconnection\n\nI’ll separate reproducible bugs from suggestions.',
    ],
    draft: 'Make the tone a little more relaxed.',
  },
};
// README_MOTION_ONLY=1 records only adhd-demo-*.gif and keeps the reviewed
// static screenshots and their manifest entries byte-for-byte.
const motionOnly = process.env.README_MOTION_ONLY === '1';
const manifestPath = path.join(output, 'adhd-capture.json');
const previous = motionOnly ? JSON.parse(await readFile(manifestPath, 'utf8')) : undefined;
const expandLabel = { zh: ['放大此面板', '回到面板总览'], en: ['Expand this pane', 'Return to board overview'] };
const browser = await chromium.launch({ headless: true });
const images = [], animations = [];
try {
  await mkdir(output, { recursive: true });
  for (const locale of ['en', 'zh']) {
    const data = copy[locale];
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'tarobot-readme-adhd-'));
    const hub = await HubServer.start({ stateDir, clientDir: path.join(root, 'client/dist') });
    const context = await browser.newContext({ viewport: { width: 1920, height: 900 }, deviceScaleFactor: 2, locale: locale === 'zh' ? 'zh-CN' : 'en-GB', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    const errors = [], fixtureProbes = {};
    try {
      await hub.profile.update({ name: data.host, revision: (await hub.profile.read()).revision });
      const folders = new ConversationFolders(hub.store.db);
      await folders.change('owner', { type: 'create', revision: 0, id: 'project', name: data.folder });
      const chats = [];
      for (let i = 0; i < bots.length; i++) {
        const [engine, name, model] = bots[i], id = `demo-adhd-${engine}-${i}`;
        await hub.store.db.run('INSERT INTO bots(id,name,secret_hash,engine,model,online) VALUES(?,?,?,?,?,1)', [id, name, 'demo-only', engine, model]);
        await hub.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [BOT_AVATAR_DEFAULT_PREFIX + id, readmeAvatars[['codex','claude','kimi','deepseek','agy','gemini','studio'][i]]]);
        const chat = await hub.store.createConversation('owner', [id], data.titles[i], `demo-adhd-chat-${i}`);
        chats.push(chat);
        if (i < 4) {
          const sent = await hub.store.sendMessage('owner', { conversationId: chat.id, clientMsgId: `prompt-${i}`, text: data.prompts[i], attachments: [] });
          // Keep demonstration request/reply timestamps distinct, like real turns.
          await new Promise(resolve => setTimeout(resolve, 30));
          await hub.store.publishBotMessage(id, { conversationId: chat.id, replyTo: sent.message.id, status: i === 3 ? 'streaming' : 'complete', blocks: [{ type: 'text', text: data.replies[i] }] });
        }
        await folders.change('owner', { type: 'move', revision: i + 1, conversationId: chat.id, folderId: 'project' });
      }
      // Same visible pairing and saved-preference path for the still and the motion.
      const openBoard = async target => {
      const page = await target.newPage(); page.setDefaultTimeout(20_000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() !== 'error') return;
        const at = new URL(message.location().url || hub.url).pathname, text = message.text();
        // Fixture Bots are database rows without a connected runtime, so the
        // pane's task/steer capability probes answer 409/503. Count, never hide others.
        if (/^Failed to load resource: .* (409|503) /.test(text) && /^\/api\/conversations\/[^/]+\/(tasks|steer)$/.test(at)) fixtureProbes[`${text.match(/(409|503)/)[1]} ${at.split('/').at(-1)}`] = (fixtureProbes[`${text.match(/(409|503)/)[1]} ${at.split('/').at(-1)}`] ?? 0) + 1;
        else errors.push(`${text} @ ${at}`);
      });
      await page.goto(hub.url);
      await page.getByLabel('主机名称', { exact: true }).fill(data.host);
      await prepareReadmePairing(page, hub);
      await page.getByRole('button', { name: '配对此设备', exact: true }).click();
      await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
      await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
      await expect(page.locator('.host-workspace:not([hidden]) .connection-pill.online')).toBeVisible();
      // Seed only fresh demonstration browser preferences; never change UI styles.
      await readmePreferences(page, locale, 'conversations');
      await page.reload();
      await page.getByRole('button', { name: locale === 'zh' ? '打开 ADHD 模式' : 'Open ADHD mode', exact: true }).click();
      await expect(page.locator('.adhd-shell')).toBeVisible();
      return page;
      };
      const toggle = (page, chat) => page.locator(`.adhd-picker-list [data-conversation-id="${chat.id}"]`).locator('..').getByRole('checkbox');
      if (!motionOnly) {
      const page = await openBoard(context);
      for (const chat of chats.slice(0, 4)) await page.locator(`.adhd-picker-list [data-conversation-id="${chat.id}"]`).locator('..').getByRole('checkbox').check();
      await page.locator('.adhd-display-control select').nth(0).selectOption('4');
      await page.locator('.adhd-display-control select').nth(1).selectOption('13');
      await expect(page.locator('.adhd-card')).toHaveCount(4);
      await expect(page.locator('.adhd-picker-list input[data-pane-toggle]')).toHaveCount(7);
      await expect(page.locator('.adhd-picker-list input[data-pane-toggle]:checked')).toHaveCount(4);
      await expect(page.locator('.adhd-card .message-blocks')).toHaveCount(8);
      await page.locator(`[data-pane-conversation="${chats[1].id}"] .composer textarea`).fill(data.draft);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(img => img.getClientRects().length).map(img => img.decode())); });
      await expect.poll(async () => page.locator('.adhd-card .message-blocks table').count()).toBe(1);
      for (const card of await page.locator('.adhd-card').all()) await expect(card.locator('.composer textarea')).toBeInViewport();
      const panes = await page.locator('.adhd-card').evaluateAll(cards => cards.map(card => {
        const { x, y, width, height } = card.getBoundingClientRect();
        return { x, y, width, height };
      }));
      expect(new Set(panes.map(pane => Math.round(pane.y))).size).toBe(1);
      expect(panes.every(pane => pane.x >= 0 && pane.x + pane.width <= 1920)).toBe(true);
      await page.bringToFront();
      await expect(page.locator('.adhd-unread')).toHaveCount(0);
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      await page.mouse.move(0, 0);
      // Verify the real saved monochrome / warm-gray appearance and the leading fox.
      const foxBot = `demo-adhd-${bots[0][0]}-0`;
      await expect(page.locator('html')).toHaveAttribute('data-palette', 'mono');
      await expect(page.locator(`[data-avatar="bot:${foxBot}"][data-preset="pastel-fox"] img[src*="pastel-fox-"]`).filter({ visible: true }).first()).toBeVisible();
      const presets = await page.locator('[data-avatar^="bot:"][data-preset]').evaluateAll(nodes => nodes.map(node => [node.dataset.avatar, node.dataset.preset]));
      expect(presets.filter(([avatar, preset]) => (avatar === `bot:${foxBot}`) !== (preset === 'pastel-fox'))).toEqual([]);
      expect((await visibleReadmeAvatars(page)).sort()).toEqual(Object.values(readmeAvatars).sort());
      expect(errors).toEqual([]);
      const file = `adhd-${locale}.png`;
      await page.screenshot({ path: path.join(output, file), animations: 'disabled' });
      images.push({ file, locale, viewport: page.viewportSize(), scale: 2, ...await readmeAppearance(page), visibleAvatars: await visibleReadmeAvatars(page), firstBotAvatar: { botId: foxBot, avatar: 'pastel-fox' }, availableBots: bots.length, selectedConversations: 4, panes: 4, columns: 4, rows: 1, fontSize: 13, paneBounds: panes, sha256: createHash('sha256').update(await readFile(path.join(output, file))).digest('hex') });
      console.log(`Captured ${file}`);
      }
      // Motion: start from a loaded two-pane board, add panes 3 and 4 from the
      // conversation list, expand one pane and return to the overview.
      const motionContext = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5, locale: locale === 'zh' ? 'zh-CN' : 'en-GB', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
      try {
        const page = await openBoard(motionContext);
        // Open all four conversations once so the Hub records normal read
        // receipts, then return to the two-pane starting board.
        for (const chat of chats.slice(0, 4)) if (!await toggle(page, chat).isChecked()) await toggle(page, chat).check();
        await page.locator('.adhd-display-control select').nth(0).selectOption('4');
        await page.locator('.adhd-display-control select').nth(1).selectOption('13');
        await expect(page.locator('.adhd-card .message-blocks')).toHaveCount(8);
        await page.bringToFront();
        await expect(page.locator('.adhd-unread')).toHaveCount(0);
        await expect(page.locator('[data-agent-state="done"]')).toHaveCount(0);
        for (const chat of chats.slice(2, 4)) await toggle(page, chat).uncheck();
        await expect(page.locator('.adhd-card')).toHaveCount(2);
        await expect(page.locator('.adhd-card .message-blocks')).toHaveCount(4);
        await expect(page.locator('.adhd-unavailable')).toHaveCount(0);
        await expect(page.locator('.adhd-unread, [data-agent-state="done"]')).toHaveCount(0);
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(img => img.getClientRects().length).map(img => img.decode())); });
        await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
        await page.mouse.move(0, 0);
        const settle = async count => {
          await expect(page.locator('.adhd-card:not([hidden])')).toHaveCount(count);
          await expect(page.locator('.adhd-card:not([hidden]) .message-blocks')).toHaveCount(count * 2);
          await expect(page.locator('.adhd-unavailable')).toHaveCount(0);
          await page.mouse.move(0, 0);
        };
        const pane = page.locator(`[data-pane-conversation="${chats[0].id}"]`);
        const motion = await recordReadmeMotion(page, path.join(stateDir, 'motion'), path.join(output, `adhd-demo-${locale}.gif`), async () => {
          await page.waitForTimeout(1500);
          await toggle(page, chats[2]).check(); await settle(3);
          await page.waitForTimeout(1400);
          await toggle(page, chats[3]).check(); await settle(4);
          await page.waitForTimeout(1600);
          await pane.getByRole('button', { name: expandLabel[locale][0], exact: true }).click();
          await expect(pane).toHaveClass(/is-expanded/); await settle(1);
          await page.waitForTimeout(2000);
          await pane.getByRole('button', { name: expandLabel[locale][1], exact: true }).click();
          await settle(4);
          await page.waitForTimeout(1800);
        });
        await expect(page.locator('.adhd-picker-list input[data-pane-toggle]:checked')).toHaveCount(4);
        await expect(page.locator('.adhd-unread, [data-agent-state="done"]')).toHaveCount(0);
        expect(errors).toEqual([]);
        animations.push({ ...motion, locale, viewport: page.viewportSize(), scale: 1.5, listMode: 'conversations', startPanes: 2, endPanes: 4, columns: 4, fontSize: 13, consoleErrors: errors.length, fixtureCapabilityProbes: fixtureProbes, actions: ['Check pane 3 in the conversation list', 'Check pane 4 in the conversation list', `${expandLabel[locale][0]} (${data.titles[0]})`, expandLabel[locale][1]], ...await readmeAppearance(page) });
        console.log(`Captured ${motion.file} (${(motion.bytes / 1048576).toFixed(2)} MiB, ${motion.duration.toFixed(1)} s, ${motion.frames} frames)`);
      } finally { await motionContext.close(); }
    } finally { await context.close(); await hub.close(); await rm(stateDir, { recursive: true, force: true }); }
  }
  const animationRecord = { animationClientVersion: version, animationProvenance: provenance, animationsCaptured: new Date().toISOString(), animationSource: 'Real built shared desktop client driven by Playwright clicks in the conversation list and pane header; isolated loopback Hub; synthetic Bots and replies. No model invoked; not native-device acceptance.', animations };
  await writeFile(manifestPath, JSON.stringify(motionOnly ? { ...previous, ...animationRecord } : { clientVersion: version, ...provenance, captured: new Date().toISOString(), source: 'Built shared desktop client; isolated loopback Hub; synthetic Bots, replies, streaming state and draft. No model invoked, no native-device acceptance.', images, ...animationRecord }, null, 2) + '\n');
} finally { await browser.close(); }
