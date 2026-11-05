// Documentation captures: actual built UI, isolated Hub, synthetic data, no model.
import { chromium, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { HubServer } from '../dist/src/hub/server.js';
import { HubVoiceSettings } from '../dist/src/hub/voice-settings.js';
import { QwenAsrSetup } from '../dist/src/runtime/qwen-asr-setup.js';
import { widgetBlock } from '../dist/src/client-protocol/widget.js';
import { parseRecordedPatch } from '../dist/src/core/recorded-diff.js';
import { BOT_AVATAR_DEFAULT_PREFIX } from '../dist/src/hub/bot-avatar-default.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureProvenance } from './readme-provenance.mjs';
import { prepareReadmePairing } from './readme-pairing.mjs';
import { readmeAvatars, readmePreferences, readmeAppearance, visibleReadmeAvatars } from './readme-appearance.mjs';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'assets/product');
const translations = JSON.parse(await readFile(path.join(root, 'client/src/locales/en.json'), 'utf8'));
const { version } = JSON.parse(await readFile(path.join(root, 'client/package.json'), 'utf8'));
const provenance = await captureProvenance(root);
const copy = {
  zh: { host: '示例工作室', group: '产品评议组', visual: '本周交付', review: '审阅筛选器',
    question: '下一版先做什么？请从实现、体验和研究三个角度给出建议。',
    replies: ['**先把核心流程做顺。**\n\n建议先完善筛选与空状态，再补充新入口。改动小，也更容易验证。', '**让用户一眼看懂状态。**\n\n保留一个主要操作，用清晰文字解释当前结果；筛选后仍能看到已选条件。', '**把验收写进方案。**\n\n用三种场景检查：首次打开、筛选无结果、返回后继续。每项都能独立验证。'],
    reportTitle: '交付节奏与每日明细', reportSummary: '示例数据：6 天共 29 项，10 月 20 日交付最多。',
    note: '这里加一个空值处理，避免筛选条件缺失时报错。',
  },
  en: { host: 'Example studio', group: 'Product review', visual: 'Weekly delivery', review: 'Review the filter',
    question: 'What should we build next? Review the plan from engineering, design and research perspectives.',
    replies: ['**Make the core flow work well first.**\n\nStart with filters and empty states before adding another entry point. The scope is small and easy to verify.', '**Make the current state obvious.**\n\nKeep one primary action and explain the result clearly. Selected filters should stay visible.', '**Include acceptance in the plan.**\n\nCheck first use, an empty result and returning to continue. Each case can be verified independently.'],
    reportTitle: 'Delivery trends and daily details', reportSummary: 'Example data: 29 items over six days; October 20 had the most deliveries.',
    note: 'Handle a missing value here so an empty filter cannot throw.',
  },
};

function reportHTML(zh) {
  const data = [3, 4, 6, 3, 8, 5];
  return `<section><style>.days{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.days button{padding:6px 10px;font:inherit;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)}.days button[aria-pressed=true]{border-color:var(--accent);background:var(--accent-soft)}.days button:focus-visible{outline:2px solid var(--accent)}svg{display:block;width:100%;height:auto}svg text{font:13px var(--font-body);fill:var(--muted)}#detail{margin:0;padding:12px;background:var(--card);border-radius:8px}</style>
  <p style="margin:0 0 5px">${zh ? '20 日交付最多，后半周比前半周增长 23%。' : 'Delivery peaked on Oct 20; the second half grew 23%.'}</p>
  <p class="muted" style="margin:0 0 12px;font-size:.9rem">${zh ? '10 月 16–21 日 · 29 项 · 示例数据' : 'Oct 16–21 · 29 items · Example data'}</p>
  <svg viewBox="0 0 620 190" role="img" aria-label="${zh ? '每日交付数量' : 'Daily deliveries'}"><line x1="30" x2="600" y1="155" y2="155" stroke="var(--border)"/>${data.map((value, i) => `<rect x="${45 + i * 94}" y="${155 - value * 15}" width="50" height="${value * 15}" rx="4" fill="${i === 4 ? 'var(--accent)' : 'var(--accent-soft)'}"/><text x="${70 + i * 94}" y="${145 - value * 15}" text-anchor="middle" style="fill:var(--text)">${value}</text><text x="${70 + i * 94}" y="180" text-anchor="middle">${i + 16}${zh ? '日' : ''}</text>`).join('')}</svg>
  <p class="muted" style="font-size:.9rem;margin:10px 0 0">${zh ? '选择日期，查看两类交付明细。' : 'Choose a day to see the delivery breakdown.'}</p>
  <div class="days">${data.map((_, i) => `<button data-day="${i}" aria-pressed="${i === 4}">${i === 4 ? '✓ ' : ''}${i + 16}${zh ? '日' : ''}</button>`).join('')}</div><p id="detail"></p>
  <script>(()=>{const e=[2,1,4,2,3,2],r=[1,3,2,1,5,3];function select(i){document.querySelectorAll('[data-day]').forEach((b,j)=>{b.setAttribute('aria-pressed',String(j===i));b.textContent=(j===i?'✓ ':'')+(j+16)+${JSON.stringify(zh ? '日' : '')}});document.getElementById('detail').textContent=${JSON.stringify(zh ? '10月' : 'Oct ')}+(i+16)+${JSON.stringify(zh ? '日：体验 ' : ': Experience ')}+e[i]+${JSON.stringify(zh ? ' 项 · 可靠性 ' : ' · Reliability ')}+r[i]+${JSON.stringify(zh ? ' 项 · 合计 ' : ' · Total ')}+(e[i]+r[i]);}document.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>select(Number(b.dataset.day)));select(4)})();</script></section>`;
}

const preferences = (page, locale) => readmePreferences(page, locale, 'conversations');

const browser = await chromium.launch({ headless: true });
const images = [];
try {
  await mkdir(output, { recursive: true });
  for (const locale of ['en', 'zh']) {
    const data = copy[locale], zh = locale === 'zh', t = text => zh ? text : translations[text] ?? text;
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'tarobot-readme-features-'));
    const home = path.join(temporary, 'home'), stateDir = path.join(temporary, 'host'), adapter = path.join(home, '.tarocub-secrets/tingwu_asr');
    await mkdir(path.join(adapter, '.venv/bin'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(adapter, 'tingwu_transcribe.py'), '# Documentation fixture, never executed.');
    await writeFile(path.join(adapter, '.venv/bin/python'), 'fixture', { mode: 0o700 });
    await writeFile(path.join(adapter, '.env.local'), 'DEMO_ONLY=not-a-credential', { mode: 0o600 });
    const voiceSettings = new HubVoiceSettings(stateDir, home, {});
    const initial = await voiceSettings.status();
    await voiceSettings.update({ requestId: 'demo-voice-policy', revision: initial.revision, adapterId: initial.adapterId, mode: 'auto', thresholdSeconds: 900, cloudConsent: true }, 'owner', async () => {});
    const asrSetup = new QwenAsrSetup(home, async () => JSON.stringify({ platform: 'darwin', supported: true, installed: true, pythonPresent: true, modelPresent: true, running: true, managed: true, legacyService: false, activeRequests: 0, watchdog: { enabled: true, available: true, memoryBytes: 2e9, limitBytes: 5.5e9, intervalSeconds: 300, reason: 'explicit' }, autostart: 'login' }));
    const hub = await HubServer.start({ stateDir, voiceSettings, asrSetup, clientDir: path.join(root, 'client/dist') });
    const context = await browser.newContext({ viewport: { width: 1240, height: 860 }, deviceScaleFactor: 2, locale: zh ? 'zh-CN' : 'en-GB', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await hub.profile.update({ name: data.host, revision: (await hub.profile.read()).revision });
      const botIds = ['demo-codex', 'demo-claude', 'demo-kimi'];
      for (const [i, [engine, name, model]] of [['codex', 'Codex', 'gpt-6.1-sol'], ['claude', 'Claude', 'claude-opus-5-5'], ['kimi', 'Kimi', 'kimi-code/k3']].entries()) {
        await hub.store.db.run('INSERT INTO bots(id,name,secret_hash,engine,model,online) VALUES(?,?,?,?,?,1)', [botIds[i], name, 'demo-only', engine, model]);
        await hub.store.db.run('INSERT INTO managed_bots VALUES(?,?,?,?)', [botIds[i], 'owner', botIds[i], '{}']);
      }
      for (const [i, role] of ['codex','claude','kimi'].entries()) await hub.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [BOT_AVATAR_DEFAULT_PREFIX + botIds[i], readmeAvatars[role]]);
      const group = await hub.store.createConversation('owner', botIds, data.group, 'demo-group');
      const settings = await hub.store.groupSettings('owner', group.id);
      await hub.store.updateGroup('owner', group.id, { title: group.title, expectedTitle: group.title, botIds, expectedBotIds: botIds, expectedRevision: settings.revision, policy: { mode: 'sequential', botOrder: botIds, maxRounds: 2 } });
      const ask = async (conversationId, text, id) => (await hub.store.sendMessage('owner', { conversationId, clientMsgId: id, text, attachments: [] })).message;
      const question = await ask(group.id, data.question, 'group-question');
      for (const [i, text] of data.replies.entries()) await hub.store.publishBotMessage(botIds[i], { conversationId: group.id, status: 'complete', blocks: [{ type: 'text', text }] });
      const visual = await hub.store.createConversation('owner', [botIds[0]], data.visual, 'demo-visual');
      await hub.store.publishBotMessage(botIds[0], { conversationId: visual.id, status: 'complete', blocks: [widgetBlock({ title: data.reportTitle, summary: data.reportSummary, html: reportHTML(zh) })] });
      const review = await hub.store.createConversation('owner', [botIds[0]], data.review, 'demo-review');
      const runId = 'demo-filter-run', now = 1792620000000;
      const message = await hub.store.publishBotMessage(botIds[0], { conversationId: review.id, status: 'complete', blocks: [{ type: 'text', text: zh ? '已补上筛选条件和空状态，可逐行查看并批注。' : 'Added filtering and an empty state. Review the saved changes and leave a note.' }, { type: 'card', elements: [], extra: { nativeRun: { version: 1, id: runId, revision: 1, phase: 'done', startedAt: now, updatedAt: now + 60000, endedAt: now + 60000, count: 2, completed: 2, failed: 0, truncated: false }, runChanges: { v: 1, runId, revision: 1, files: 2, edits: 2, additions: 9, deletions: 3, unavailable: 0, partial: false, childEdits: 0 } } }] });
      const common = { scope: 'recorded_run', messageId: message.id, conversationId: review.id, botId: botIds[0], runId, revision: 'a'.repeat(64), state: 'recorded', partial: false, unavailable: 0, childEdits: 0 };
      const files = [{ key: '1'.repeat(64), path: 'src/FilterPanel.tsx', additions: 7, deletions: 2, edits: 1, generated: false, protected: false, partial: false }, { key: '2'.repeat(64), path: 'src/filter.css', additions: 2, deletions: 1, edits: 1, generated: false, protected: false, partial: false }];
      await page.route(`${hub.url}/api/messages/*/changes**`, async route => {
        assert.equal(route.request().method(), 'GET');
        const url = new URL(route.request().url());
        if (!url.pathname.endsWith('/file')) return route.fulfill({ json: { ...common, items: files, truncated: false } });
        const file = files.find(file => file.key === url.searchParams.get('key')); assert.ok(file);
        const source = file === files[0] ? '@@ -1,6 +1,11 @@\n export function FilterPanel({ items, query }) {\n-  const visible = items;\n+  const visible = items.filter(item =>\n+    item.label.includes(query.trim())\n+  );\n   return (\n-    <List items={items} />\n+    <section className="results">\n+      <ResultCount value={visible.length} />\n+      <List items={visible} empty="No results" />\n+    </section>\n   );\n }' : '@@ -1 +1,2 @@\n-.results { padding: 8px; }\n+.results { padding: 12px; }\n+.results:empty { min-height: 80px; }';
        const parsed = parseRecordedPatch(source, 1000), operation = { id: '1-0', seq: 1, at: now, additions: file.additions, deletions: file.deletions, format: 'unified', partial: false };
        await route.fulfill({ json: { ...common, file, operation, operations: [operation], operationsTruncated: false, hunks: parsed.hunks, reason: null, preview: false, truncated: false } });
      });
      await page.goto(hub.url);
      await prepareReadmePairing(page, hub);
      await page.getByRole('button', { name: '配对此设备', exact: true }).click();
      await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
      await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
      await page.locator('.host-workspace:not([hidden]) .connection-pill.online').waitFor();
      await preferences(page, locale); await page.reload();
      const select = async title => { await page.locator('.conversation-row').filter({ has: page.getByText(title, { exact: true }) }).click(); await page.getByRole('heading', { name: title, exact: true, level: 1 }).waitFor(); };
      const capture = async (name, selector) => {
        await page.waitForFunction(async selector => {
          await document.fonts.ready;
          const target = document.querySelector(selector);
          if (!target) return false;
          try { await Promise.all([...target.querySelectorAll('img')].filter(image => image.getClientRects().length).map(image => image.decode())); return true; }
          catch { return false; } // A policy read may replace avatar nodes during decoding.
        }, selector);
        await page.evaluate(() => document.activeElement?.blur());
        await page.mouse.move(0, 0);
        const target = page.locator(selector).filter({ visible: true });
        const bounds = await target.boundingBox(); assert.ok(bounds && bounds.width > 200);
        const file = `feature-${name}-${locale}.png`;
        await target.screenshot({ path: path.join(output, file), animations: 'disabled' });
        const palette = await page.locator('html').getAttribute('data-palette');
        assert.equal(palette, 'mono');
        images.push({ file, locale, viewport: page.viewportSize(), scale: 2, crop: selector, bounds, ...await readmeAppearance(page), visibleAvatars: await visibleReadmeAvatars(page), firstBotAvatar: { botId: botIds[0], avatar: 'pastel-fox' }, sha256: createHash('sha256').update(await readFile(path.join(output, file))).digest('hex') });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        console.log(`Captured ${file}`);
      };
      await page.setViewportSize({ width: 1240, height: 740 });
      await select(data.group);
      await page.getByRole('region', { name: t('群聊方式与讨论状态') }).waitFor();
      await page.getByText(data.replies[2].split('\n')[0].replaceAll('**', ''), { exact: true }).waitFor();
      // Verify the real saved monochrome / warm-gray appearance and the leading fox.
      await page.locator(`.conversation-main [data-avatar="bot:${botIds[0]}"][data-preset="pastel-fox"] img[src*="pastel-fox-"]`).filter({ visible: true }).first().waitFor();
      const presets = await page.locator('[data-avatar^="bot:"][data-preset]').evaluateAll(nodes => nodes.map(node => [node.dataset.avatar, node.dataset.preset]));
      assert.deepEqual(presets.filter(([avatar, preset]) => (avatar === `bot:${botIds[0]}`) !== (preset === 'pastel-fox')), []);
      await capture('groups', '.conversation-main');
      await page.getByRole('button', { name: t('设置群聊方式'), exact: true }).click();
      assert.deepEqual(await page.locator('input[name=group-discussion-mode]').evaluateAll(inputs => inputs.map(input => input.value)), ['mentions', 'parallel', 'sequential', 'independent']);
      await capture('group-modes', '.group-discussion-options');
      await page.keyboard.press('Escape');
      await select(data.visual);
      const guest = page.frameLocator('.inline-widget iframe').frameLocator('iframe');
      await guest.locator('#detail').waitFor();
      await guest.locator('[data-day="0"]').click();
      await expect(guest.locator('#detail')).toHaveText(zh ? '10月16日：体验 2 项 · 可靠性 1 项 · 合计 3' : 'Oct 16: Experience 2 · Reliability 1 · Total 3');
      await guest.locator('[data-day="4"]').click();
      await expect(guest.locator('#detail')).toHaveText(zh ? '10月20日：体验 3 项 · 可靠性 5 项 · 合计 8' : 'Oct 20: Experience 3 · Reliability 5 · Total 8');
      await capture('visual', '.inline-widget');
      await page.setViewportSize({ width: 1240, height: 700 });
      await select(data.review);
      await page.getByRole('button', { name: /\+9 −3/ }).click();
      await page.getByRole('button', { name: 'src/FilterPanel.tsx', exact: true }).click();
      await page.getByTestId('diff-code').waitFor();
      await page.getByRole('button', { name: t('批注第 {0} 行（{1}）').replace('{0}', '3').replace('{1}', t('新')), exact: true }).click();
      await page.getByRole('textbox', { name: t('批注意见'), exact: true }).fill(data.note);
      await page.getByText(t('正在保存批注…'), { exact: true }).waitFor({ state: 'hidden' });
      await capture('changes', '.diff-viewer');
      await page.getByRole('button', { name: t('关闭改动查看器'), exact: true }).click();
      await page.setViewportSize({ width: 1240, height: 940 });
      const settingsButton = page.getByRole('button', { name: t('设置'), exact: true }).filter({ visible: true });
      if (!await settingsButton.count()) await page.getByRole('button', { name: t('更多聊天操作'), exact: true }).filter({ visible: true }).click();
      await settingsButton.click();
      await page.getByRole('navigation', { name: t('设置分类') }).getByRole('button', { name: new RegExp('^' + t('语音转写')) }).click();
      // The real tablet layout gives this longer bilingual section enough
      // height. The desktop preference dialog caps at 640px and clips a crop.
      await page.setViewportSize({ width: 740, height: 1040 });
      await page.locator('#voice-threshold').waitFor();
      assert.equal(await page.locator('#voice-threshold').inputValue(), '15');
      assert.equal(await page.locator('.voice-modes input:checked').inputValue(), 'auto');
      await capture('voice', '.voice-cloud');
      assert.deepEqual(errors, []);
    } catch (error) {
      await page.screenshot({ path: path.join(os.tmpdir(), `tarobot-readme-features-failure-${locale}.png`) }).catch(() => {});
      console.error((await page.locator('body').innerText()).slice(-10000)); throw error;
    } finally { await context.close(); await hub.close(); await rm(temporary, { recursive: true, force: true }); }
  }
  await writeFile(path.join(output, 'features-capture.json'), JSON.stringify({ clientVersion: version, ...provenance, captured: new Date().toISOString(), source: 'Built shared client; disposable Hub; synthetic conversations, report, recorded-diff HTTP responses and ASR readiness. Actual group settings and temporary voice policy. No model or cloud call. Not native-device acceptance.', images }, null, 2) + '\n');
} finally { await browser.close(); }
