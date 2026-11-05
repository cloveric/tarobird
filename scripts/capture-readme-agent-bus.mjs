// Documentation captures only: disposable Hub, synthetic run, no model invocation.
import { chromium } from '../client/node_modules/playwright/index.mjs';
import { HubServer } from '../dist/src/hub/server.js';
import { ConversationFolders } from '../dist/src/hub/conversation-folders.js';
import { BOT_AVATAR_DEFAULT_PREFIX } from '../dist/src/hub/bot-avatar-default.js';
import assert from 'node:assert/strict';
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
const copy = {
  zh: {
    host: '工作室', folder: '产品工作', name: '产品简报',
    titles: ['交付总览', '用户洞察', '简报写作', '代码审查', '视觉探索'],
    goal: '把用户访谈整理成一份可执行的产品简报。',
    tasks: ['提炼三个高频需求，为每项保留访谈证据。', '根据上一步的发现，写出一页简报与行动建议。'],
    prompts: ['把用户访谈整理成一份可执行的产品简报。', '提炼三个高频需求，为每项保留访谈证据。', '根据研究结果，写出一页产品简报。'],
    replies: [
      '**协作正在进行**\n\nKimi 已完成用户洞察，Claude 正在整理简报。\n\n1. 提炼需求与证据\n2. 撰写简报与行动建议\n\n最终结果将回到这条发起对话。',
      '**三个值得优先解决的需求**\n\n| 需求 | 访谈中的信号 |\n| :--- | :--- |\n| 少切换 | 希望同时看到多条对话 |\n| 看进展 | 想知道哪个环节需要自己 |\n| 保留思路 | 切换后仍能接着写草稿 |\n\n**建议**\n\n以多对话工作台为入口，把分工、过程和结果放在一起。\n\n这份发现已交给下一环节。',
      '**产品简报 · 初稿**\n\n### 让协作看得见\n\n用户需要的不只是更多 Bot，还需要知道谁在做什么、下一步交给谁。\n\n**行动建议**\n\n- 把常用协作保存为一个 Bus。\n- 每个环节写清任务和交付物。\n- 在对话面板里跟进各自的进度。\n\n正在整理验收标准…',
    ],
  },
  en: {
    host: 'Studio', folder: 'Product work', name: 'Product brief',
    titles: ['Delivery overview', 'User insights', 'Brief writing', 'Code review', 'Visual exploration'],
    goal: 'Turn user interviews into an actionable product brief.',
    tasks: ['Find three recurring needs and retain interview evidence for each.', 'Use those findings to write a one-page brief with next actions.'],
    prompts: ['Turn user interviews into an actionable product brief.', 'Find three recurring needs and retain evidence for each.', 'Use the research to write a one-page product brief.'],
    replies: [
      '**Collaboration in progress**\n\nKimi has finished the research. Claude is drafting the brief.\n\n1. Find needs and evidence\n2. Write the brief and next actions\n\nThe final result returns to this initiating conversation.',
      '**Three needs to prioritize**\n\n| Need | Interview signal |\n| :--- | :--- |\n| Less switching | See several conversations at once |\n| Clear progress | Know which step needs attention |\n| Keep the thread | Return to an unfinished draft |\n\n**Recommendation**\n\nBring tasks, progress and results together in the multi-conversation workspace.\n\nThese findings have moved to the next step.',
      '**Product brief · Draft**\n\n### Make collaboration visible\n\nPeople need more than additional Bots. They need to know who is doing what, and where the work goes next.\n\n**Next actions**\n\n- Save a recurring workflow as a Bus.\n- Give every step a clear task and output.\n- Follow each participant in its conversation pane.\n\nRefining the acceptance criteria…',
    ],
  },
};
const bots = [['codex', 'Codex', 'gpt-6-astra'], ['kimi', 'Kimi', 'kimi-code/k3'], ['claude', 'Claude', 'claude-opus-5-5'], ['deepseek', 'DeepSeek', 'deepseek-flash'], ['agy', 'Antigravity', 'gemini-4-argon']];
// README_MOTION_ONLY=1 records only agent-bus-demo-*.gif and keeps the
// reviewed static screenshots and their manifest entries byte-for-byte.
const motionOnly = process.env.README_MOTION_ONLY === '1';
const manifestPath = path.join(output, 'agent-bus-capture.json');
const previous = motionOnly ? JSON.parse(await readFile(manifestPath, 'utf8')) : undefined;
const tabs = { zh: ['配置', '运行'], en: ['Configuration', 'Run'] };
const browser = await chromium.launch({ headless: true });
const images = [], animations = [];
try {
  await mkdir(output, { recursive: true });
  for (const locale of ['en', 'zh']) {
    const data = copy[locale], stateDir = await mkdtemp(path.join(os.tmpdir(), 'tarobot-readme-bus-'));
    const hub = await HubServer.start({ stateDir, clientDir: path.join(root, 'client/dist') });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1040 }, deviceScaleFactor: 2, locale: locale === 'zh' ? 'zh-CN' : 'en-GB', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    const errors = [], fixtureProbes = {};
    try {
      await hub.profile.update({ name: data.host, revision: (await hub.profile.read()).revision });
      const folders = new ConversationFolders(hub.store.db);
      await folders.change('owner', { type: 'create', revision: 0, id: 'product', name: data.folder });
      const chats = [];
      for (const [i, [engine, name, model]] of bots.entries()) {
        const id = `demo-bus-${engine}`;
        await hub.store.db.run('INSERT INTO bots(id,name,secret_hash,engine,model,online) VALUES(?,?,?,?,?,1)', [id, name, 'demo-only', engine, model]);
        await hub.store.db.run('INSERT INTO managed_bots VALUES(?,?,?,?)', [id, 'owner', id, '{}']);
        await hub.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [BOT_AVATAR_DEFAULT_PREFIX + id, readmeAvatars[engine]]);
        const chat = await hub.store.createConversation('owner', [id], data.titles[i], `demo-bus-chat-${i}`);
        chats.push(chat);
        if (i < 3) {
          const sent = await hub.store.sendMessage('owner', { conversationId: chat.id, clientMsgId: `prompt-${i}`, text: data.prompts[i], attachments: [] });
          await hub.store.publishBotMessage(id, { conversationId: chat.id, replyTo: sent.message.id, status: i === 1 ? 'complete' : 'streaming', blocks: [{ type: 'text', text: data.replies[i] }] });
        }
        await folders.change('owner', { type: 'move', revision: i + 1, conversationId: chat.id, folderId: 'product' });
      }
      const config = { name: data.name, mode: 'chain', coordinator: { botId: 'demo-bus-codex', conversationId: chats[0].id }, members: [1, 2].map(i => ({ botId: `demo-bus-${bots[i][0]}`, conversationId: chats[i].id, instruction: data.tasks[i - 1] })), maxResearchQuestions: 5, maxRevisionRounds: 1 };
      const workspace = await hub.agentBuses.create('owner', { requestId: 'demo-workflow', config });
      const now = Date.now(), run = { id: 'demo-run', workspaceId: workspace.id, messageId: 'demo-message', status: 'running', createdAt: now - 60000, startedAt: now - 59000, text: data.goal, snapshot: config, stages: config.members.map((member, i) => ({ id: `s${i + 1}`, ...member, status: i ? 'running' : 'completed', startedAt: now - (i ? 15000 : 59000), ...(i ? {} : { finishedAt: now - 15000 }) })) };
      const displayed = { ...workspace, latestRun: { ...run, snapshot: undefined, stages: undefined, text: undefined } };
      // Same visible pairing, saved preferences and read-only run for still and motion.
      const openBus = async target => {
      const page = await target.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() !== 'error') return;
        const at = new URL(message.location().url || hub.url).pathname, text = message.text();
        // Fixture Bots have no connected runtime and the disposable Hub has no
        // Bot manager, so task/steer probes answer 409/503 and the coordinator's
        // collaboration-settings read answers 403. Count them; any other error fails.
        const probe = (/^Failed to load resource: .* (409|503) /.test(text) && /^\/api\/conversations\/[^/]+\/(tasks|steer)$/.test(at)) || (/^Failed to load resource: .* 403 /.test(text) && /^\/api\/bots\/[^/]+\/collaboration$/.test(at)) ? `${text.match(/(403|409|503)/)[1]} ${at.split('/').at(-1)}` : '';
        if (probe) fixtureProbes[probe] = (fixtureProbes[probe] ?? 0) + 1; else errors.push(`${text} @ ${at}`);
      });
      // Only the displayed run is synthetic. Saved definitions, pairing and chats
      // use the real Hub. Block mutations so a capture can never invoke a model.
      await page.route(`${hub.url}/api/agent-buses**`, async route => {
        assert.equal(route.request().method(), 'GET');
        await route.fulfill({ json: new URL(route.request().url()).pathname === '/api/agent-buses' ? { items: [displayed] } : { workspace: displayed, runs: [run] } });
      });
      await page.goto(hub.url);
      await page.getByLabel('主机名称', { exact: true }).fill(data.host);
      await prepareReadmePairing(page, hub);
      await page.getByRole('button', { name: '配对此设备', exact: true }).click();
      await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
      await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
      await page.locator('.host-workspace:not([hidden]) .connection-pill.online').waitFor();
      await readmePreferences(page, locale, 'conversations');
      await page.reload();
      await page.locator('.host-workspace:not([hidden]) .agent-bus-saved').click();
      await page.locator('.agent-bus-flow-node').last().waitFor();
      await page.locator('.adhd-display-control select').nth(0).selectOption('3');
      await page.locator('.adhd-display-control select').nth(1).selectOption('13');
      await page.waitForFunction(() => document.querySelectorAll('.adhd-card').length === 3);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(img => img.getClientRects().length).map(img => img.decode())); });
      return page;
      };
      if (!motionOnly) {
      const page = await openBus(context);
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.activeElement?.blur());
      // Verify the real saved monochrome / warm-gray appearance and the leading fox.
      const foxBot = `demo-bus-${bots[0][0]}`;
      await page.locator(`[data-avatar="bot:${foxBot}"][data-preset="pastel-fox"] img[src*="pastel-fox-"]`).filter({ visible: true }).first().waitFor();
      const palette = await page.locator('html').getAttribute('data-palette');
      assert.equal(palette, 'mono');
      const presets = await page.locator('[data-avatar^="bot:"][data-preset]').evaluateAll(nodes => nodes.map(node => [node.dataset.avatar, node.dataset.preset]));
      assert.deepEqual(presets.filter(([avatar, preset]) => (avatar === `bot:${foxBot}`) !== (preset === 'pastel-fox')), []);
      const capture = async (kind, selector) => {
        const file = `agent-bus${kind ? '-' + kind : ''}-${locale}.png`;
        const target = selector ? page.locator(selector) : page;
        await target.screenshot({ path: path.join(output, file), animations: 'disabled' });
        images.push({ file, locale, viewport: page.viewportSize(), scale: 2, kind: kind || 'workspace', ...await readmeAppearance(page), visibleAvatars: await visibleReadmeAvatars(page), firstBotAvatar: { botId: foxBot, avatar: 'pastel-fox' }, sha256: createHash('sha256').update(await readFile(path.join(output, file))).digest('hex') });
        console.log(`Captured ${file}`);
      };
      assert.equal(await page.locator('.agent-bus-flow-node').count(), 3);
      assert.equal(await page.locator('.agent-bus-flow-node.is-completed').count(), 1);
      assert.equal(await page.locator('.agent-bus-flow-node.is-running').count(), 1);
      const bounds = await page.locator('.agent-bus-flow').boundingBox();
      assert.ok(bounds && bounds.y + bounds.height < 1040, 'Entire topology must be visible');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await capture('');
      await page.getByRole('tab', { name: locale === 'zh' ? '配置' : 'Configuration', exact: true }).click();
      await page.locator('.agent-bus-slots').waitFor();
      await capture('setup', '.agent-bus-panel');
      assert.deepEqual(errors, []);
      }
      // Motion: loaded flow and three member panes -> Configuration (member
      // tasks) -> Run (flow and member results). Read-only synthetic run.
      const motionContext = await browser.newContext({ viewport: { width: 1760, height: 990 }, deviceScaleFactor: 1.5, locale: locale === 'zh' ? 'zh-CN' : 'en-GB', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
      try {
        const page = await openBus(motionContext);
        await page.bringToFront();
        await page.locator('.adhd-card .message-blocks').nth(5).waitFor();
        await page.waitForFunction(() => !document.querySelector('.adhd-unread, [data-agent-state="done"], .adhd-unavailable'));
        assert.equal(await page.locator('.agent-bus-flow-node').count(), 3);
        assert.equal(await page.locator('.agent-bus-flow-node.is-completed').count(), 1);
        assert.equal(await page.locator('.agent-bus-flow-node.is-running').count(), 1);
        const flow = await page.locator('.agent-bus-flow').boundingBox();
        assert.ok(flow && flow.y + flow.height < 990, 'Entire topology must be visible');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await page.locator('.adhd-grid').evaluate(grid => grid.scrollWidth > grid.clientWidth + 1), false);
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.activeElement?.blur());
        const tab = name => page.getByRole('tab', { name, exact: true });
        const motion = await recordReadmeMotion(page, path.join(stateDir, 'motion'), path.join(output, `agent-bus-demo-${locale}.gif`), async () => {
          await page.waitForTimeout(1800);
          await tab(tabs[locale][0]).click(); await page.mouse.move(0, 0);
          await page.locator('.agent-bus-slots').waitFor();
          await page.waitForTimeout(2600);
          await tab(tabs[locale][1]).click(); await page.mouse.move(0, 0);
          await page.locator('.agent-bus-flow-node').nth(2).waitFor();
          await page.waitForTimeout(2200);
        });
        assert.equal(await page.locator('.agent-bus-flow-node').count(), 3);
        assert.equal(await page.locator('.adhd-unread, [data-agent-state="done"], .adhd-unavailable').count(), 0);
        assert.deepEqual(errors, []);
        animations.push({ ...motion, locale, viewport: page.viewportSize(), scale: 1.5, listMode: 'conversations', panes: 3, columns: 3, fontSize: 13, runState: 'synthetic read-only GET responses; no model execution', consoleErrors: errors.length, fixtureCapabilityProbes: fixtureProbes, actions: [`${tabs[locale][0]} tab (member tasks)`, `${tabs[locale][1]} tab (flow and member results)`], ...await readmeAppearance(page) });
        console.log(`Captured ${motion.file} (${(motion.bytes / 1048576).toFixed(2)} MiB, ${motion.duration.toFixed(1)} s, ${motion.frames} frames)`);
      } finally { await motionContext.close(); }
    } finally { await context.close(); await hub.close(); await rm(stateDir, { recursive: true, force: true }); }
  }
  const animationRecord = { animationClientVersion: version, animationProvenance: provenance, animationsCaptured: new Date().toISOString(), animationSource: 'Real built shared desktop client driven by Playwright tab clicks; disposable loopback Hub with a real saved Bus and conversations; the displayed run status and replies are synthetic read-only GET responses. No model invoked; not native acceptance.', animations };
  await writeFile(manifestPath, JSON.stringify(motionOnly ? { ...previous, ...animationRecord } : { clientVersion: version, ...provenance, captured: new Date().toISOString(), source: 'Built shared desktop client, disposable loopback Hub, real saved Bus and conversations, synthetic read-only run status/replies. No model invoked; not native acceptance.', images, ...animationRecord }, null, 2) + '\n');
} finally { await browser.close(); }
