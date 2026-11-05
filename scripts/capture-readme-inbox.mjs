// README opening: the same conversations on desktop and phone.
// Desktop starts in Chats, switches to Bots and back; the phone opens the same
// conversation, sends a continuation, and the desktop shows it arrive.
// Real shared-client UI in two paired browser contexts on an isolated loopback
// Hub. Bot content is synthetic; the one reply is a scripted gateway bridge.
// No model, approval, repository operation or production Hub is involved.
// Prerequisites: npm run build && npm --prefix client run build, and ffmpeg.
// Usage: node scripts/capture-readme-inbox.mjs [zh|en ...]
//        node scripts/capture-readme-inbox.mjs --from <DEMO_KEEP dir> [zh|en ...]
import { chromium, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { HubServer } from '../dist/src/hub/server.js';
import { hashSecret } from '../dist/src/hub/auth.js';
import { BOT_AVATAR_DEFAULT_PREFIX } from '../dist/src/hub/bot-avatar-default.js';
import { attachGateway } from '../dist/src/gateway/service.js';
import { createCoreServiceRuntime } from '../dist/src/core/runtime.js';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { captureProvenance } from './readme-provenance.mjs';
import { prepareReadmePairing } from './readme-pairing.mjs';
import { compactReadmeBots, readmeAvatars, readmePreferences, readmeAppearance, visibleReadmeAvatars } from './readme-appearance.mjs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'assets/product');
const { version } = JSON.parse(await readFile(path.join(root, 'client/package.json'), 'utf8'));
const provenance = await captureProvenance(root);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const DESKTOP = { width: 1200, height: 720 }, PHONE = { width: 390, height: 844 };
// Proportional composition on the warm-gray documentation stage (output px).
const W = 1280, H = 650, FPS = 10, LABEL_BAND = 60;
const D = { x: 28, y: LABEL_BAND, w: 928, h: 557 }, P = { x: 992, y: LABEL_BAND, w: 257, h: 557 };

const copy = {
  zh: {
    host: '工作室', desktop: '工作室 Mac', phone: '演示手机', label: 'TAROBIRD / 桌面与手机',
    titles: ['发布计划', '首页文案', '视觉方向', '用户研究', '代码审查', '素材整理', '工作室笔记'],
    previews: ['', '标题更短了，正文分成三段。', '两个方向：温和白瓷，或鲜明终端。', '三条高频需求，附访谈原话。', '两处边界情况，已列出复现步骤。', '图标与截图已按尺寸归档。', '本周的决定都记在这里。'],
    prompt: '把这份笔记整理成三步发布计划。',
    reply: '**发布计划已整理好。**\n\n1. 核对功能与演示素材\n2. 走通桌面和手机流程\n3. 更新说明与下载入口',
    next: '第二步我在路上继续看。', answer: '好的，第二步的检查清单放在这里，回到电脑上也能接着看。',
  },
  en: {
    host: 'Studio', desktop: 'Studio Mac', phone: 'Demo phone', label: 'TAROBIRD / DESKTOP AND PHONE',
    titles: ['Launch plan', 'Website copy', 'Visual direction', 'User research', 'Code review', 'Asset library', 'Studio notes'],
    previews: ['', 'A shorter headline and three clear sections.', 'Two directions: soft porcelain or bold terminal.', 'Three recurring needs, with interview quotes.', 'Two edge cases, each with steps to reproduce.', 'Icons and screenshots filed by size.', 'This week’s decisions, all in one place.'],
    prompt: 'Turn these notes into a three-step launch plan.',
    reply: '**The launch plan is ready.**\n\n1. Check features and demo material\n2. Walk through desktop and phone\n3. Update notes and downloads',
    next: 'I’ll pick up step two on the go.', answer: 'Sure. Step two’s checklist is here, and you can continue on the computer too.',
  },
};
// [id, name, engine, model, avatar role]; seven Bots, seven different mascots.
const bots = [
  ['codex', 'Codex', 'codex', 'gpt-6-astra', 'codex'],
  ['claude', 'Claude', 'claude', 'claude-opus-5-5', 'claude'],
  ['gemini', 'Gemini', 'antigravity', 'gemini-3.8-flash-high', 'gemini'],
  ['kimi', 'Kimi', 'kimi', 'kimi-code/k3', 'kimi'],
  ['deepseek', 'DeepSeek', 'deepseek', 'deepseek-flash', 'deepseek'],
  ['agy', 'Antigravity', 'antigravity', 'gemini-4-argon', 'agy'],
  ['studio', 'Claude · Studio', 'claude', 'claude-opus-5-5', 'studio'],
];

/** Verify the saved monochrome / warm-gray appearance and the leading fox. */
async function brandCheck(page) {
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'mono');
  await expect(page.locator('[data-avatar="bot:codex"][data-preset="pastel-fox"] img[src*="pastel-fox-"]').filter({ visible: true }).first()).toBeVisible();
  const presets = await page.locator('[data-avatar^="bot:"][data-preset]').evaluateAll(nodes => nodes.map(node => [node.dataset.avatar.slice(4), node.dataset.preset]));
  for (const [id, preset] of presets) expect(preset).toBe(readmeAvatars[bots.find(bot => bot[0] === id)[4]]);
  return readmeAppearance(page);
}

/** The visible list must show seven different Bots in ordinary read state. */
async function listCheck(page, label) {
  const avatars = await visibleReadmeAvatars(page);
  expect(avatars.sort(), `${label} avatars`).toEqual(Object.values(readmeAvatars).sort());
  const busy = await page.locator('[data-agent-state="done"], [data-agent-state="failed"], [data-agent-state="ask"], .unread-badge').filter({ visible: true })
    .evaluateAll(nodes => nodes.map(node => `${node.className} ${node.dataset.agentState ?? ''} ${node.closest('[data-conversation-id],[data-bot-id]')?.outerHTML.slice(0, 160) ?? ''}`));
  expect(busy, `${label} done/unread badges`).toEqual([]);
  return avatars;
}

/** A full-page flash before the recorded window marks one shared instant in
 * both raw videos; the composition starts after it, so it is never shown. */
async function syncFlash(page) {
  return page.evaluate(() => new Promise(resolve => {
    const flash = document.createElement('div');
    flash.style.cssText = 'position:fixed;inset:0;background:#f0f;z-index:2147483647;pointer-events:none';
    document.body.appendChild(flash);
    requestAnimationFrame(() => requestAnimationFrame(() => { const at = Date.now(); setTimeout(() => { flash.remove(); resolve(at); }, 400); }));
  }));
}
function syncOffset(video, flashedAt, start) {
  const [num, den] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', video], { encoding: 'utf8' }).trim().split('/').map(Number);
  const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-vf', 'crop=16:16:(iw-16)/2:(ih-16)/2,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 26 });
  const flashed = [];
  for (let i = 0; i < pixels.length / 3; i++) if (pixels[i * 3] > 200 && pixels[i * 3 + 1] < 80 && pixels[i * 3 + 2] > 200) flashed.push(i);
  if (!flashed.length) throw new Error(`Sync flash not found in ${video}`);
  const offset = flashed[0] * den / num + (start - flashedAt) / 1000;
  if ((flashed.at(-1) + 1) * den / num > offset) throw new Error(`Sync flash overlaps the recorded window in ${video}`);
  return offset;
}

async function stage(browser, file, locale) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const rect = (r, radius, attrs) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${radius}" ${attrs}/>`;
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
    header{position:absolute;left:${D.x + 4}px;top:22px;font:13px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;letter-spacing:1.6px;color:#81776f}
    svg{position:absolute;left:0;top:0}
  </style></head><body><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><mask id="m"><rect width="${W}" height="${H}" fill="white"/>${rect(D, 12, 'fill="black"')}${rect(P, 30, 'fill="black"')}</mask></defs>
    <rect width="${W}" height="${H}" fill="#f3f2f0" mask="url(#m)"/>
    ${rect({ x: D.x - 0.5, y: D.y - 0.5, w: D.w + 1, h: D.h + 1 }, 12.5, 'fill="none" stroke="#ddd9d4" stroke-width="1"')}
    ${rect({ x: P.x - 4.5, y: P.y - 4.5, w: P.w + 9, h: P.h + 9 }, 34, 'fill="none" stroke="#292929" stroke-width="9"')}
  </svg><header></header></body></html>`);
  await page.locator('header').evaluate((node, value) => { node.textContent = value; }, copy[locale].label);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
}

/** Stage → palette → GIF; the same staged frames also give the private MP4. */
async function compose(browser, work, raw, desktopVideo, phoneVideo) {
  const { locale, duration } = raw, d = duration.toFixed(2);
  const overlay = path.join(work, `stage-${locale}.png`); await stage(browser, overlay, locale);
  const graph = [
    `color=c=#f3f2f0:s=${W}x${H}:r=${FPS}:d=${d}[base]`,
    `[0:v]fps=${FPS},scale=${D.w}:${D.h}:flags=lanczos[d]`,
    `[1:v]fps=${FPS},scale=${P.w}:${P.h}:flags=lanczos[p]`,
    `[base][d]overlay=${D.x}:${D.y}:eof_action=repeat[a]`, `[a][p]overlay=${P.x}:${P.y}:eof_action=repeat[b]`,
    '[b][2:v]overlay=0:0',
  ].join(';');
  const staged = path.join(work, `stage-${locale}.mkv`), palette = path.join(work, `palette-${locale}.png`);
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-ss', raw.desktopOffset.toFixed(3), '-t', d, '-i', desktopVideo, '-ss', raw.phoneOffset.toFixed(3), '-t', d, '-i', phoneVideo,
    '-loop', '1', '-framerate', String(FPS), '-t', d, '-i', overlay,
    '-filter_complex', graph, '-t', d, '-c:v', 'ffv1', '-pix_fmt', 'bgr0', staged]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', staged, '-vf', 'palettegen=max_colors=192:stats_mode=diff', palette]);
  const file = `inbox-demo-${locale}.gif`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', staged, '-i', palette, '-lavfi', 'paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', path.join(output, file)]);
  if (process.env.DEMO_KEEP) execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', staged, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(process.env.DEMO_KEEP, `inbox-demo-${locale}.mp4`)]);
  const bytes = await readFile(path.join(output, file));
  return { file, locale, ...raw.appearance, visibleAvatars: raw.visibleAvatars, duration: Number(duration.toFixed(2)), fps: FPS, size: { width: W, height: H },
    labelBand: LABEL_BAND, desktopRect: D, phoneRect: P, desktopViewport: DESKTOP, phoneViewport: PHONE,
    scenes: raw.scenes, consoleErrors: raw.consoleErrors, fixtureCapabilityProbes: raw.fixtureProbes,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function capture(browser, locale, work) {
  const data = copy[locale], t = (en, zh) => (locale === 'zh' ? zh : en);
  const hub = await HubServer.start({ stateDir: path.join(work, 'hub'), clientDir: path.join(root, 'client/dist') });
  const gateways = [], contexts = [], marks = {}, errors = [], fixtureProbes = {};
  try {
    await hub.profile.update({ name: data.host, revision: (await hub.profile.read()).revision });
    const chats = [];
    for (const [i, [id, name, engine, model, role]] of bots.entries()) {
      if (id !== 'codex') await hub.store.db.run('INSERT INTO bots(id,name,secret_hash,engine,model,online) VALUES(?,?,?,?,?,1)', [id, name, 'demo-only', engine, model]);
      else {
        // The continued conversation's Bot answers through a scripted bridge.
        const stateDir = path.join(work, id); await mkdir(stateDir);
        await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine, model, locale }));
        const secret = randomBytes(32).toString('base64url');
        await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', [id, name, hashSecret(secret)]);
        // It answers the seeded request on connect, then the phone continuation.
        const bridge = { handleAuthorizedMessage: async input => {
          const continued = input.text.includes(data.next);
          await sleep(continued ? 900 : 50);
          return { text: continued ? data.answer : data.reply };
        } };
        gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace('http', 'ws') + '/instance', secret, botId: id, engine, model, runtime: createCoreServiceRuntime(), bridge }));
      }
      await hub.store.db.run('INSERT INTO managed_bots VALUES(?,?,?,?)', [id, 'owner', id, '{}']);
      await hub.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [BOT_AVATAR_DEFAULT_PREFIX + id, readmeAvatars[role]]);
      const chat = await hub.store.createConversation('owner', [id], data.titles[i], `demo-inbox-${id}`);
      chats.push(chat);
      if (i) await hub.store.publishBotMessage(id, { conversationId: chat.id, blocks: [{ type: 'text', text: data.previews[i] }] });
      else await hub.store.sendMessage('owner', { conversationId: chat.id, clientMsgId: 'plan-request', text: data.prompt, attachments: [] });
      await sleep(30);
    }
    // Wait for the scripted bridge to complete the seeded request before any
    // read receipt, so no finished-but-unread state remains.
    for (let tries = 0; ; tries++) {
      const { messages } = await hub.store.listMessages('owner', chats[0].id);
      if (messages.some(message => message.authorType === 'bot' && message.status === 'complete')) break;
      if (tries > 100) throw new Error('Seeded launch-plan reply did not complete');
      await sleep(100);
    }
    // Ordinary read receipts: an active workspace, not a wall of finished badges.
    for (const chat of chats) await hub.store.markRead('owner', chat.id, Number.MAX_SAFE_INTEGER);
    const launch = chats[0];

    const videoDir = path.join(work, 'video');
    const options = { locale: locale === 'zh' ? 'zh-CN' : 'en-GB', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' };
    const desktopContext = await browser.newContext({ ...options, viewport: DESKTOP, recordVideo: { dir: path.join(videoDir, 'desktop'), size: DESKTOP } });
    const phoneContext = await browser.newContext({ ...options, viewport: PHONE, isMobile: true, hasTouch: true, recordVideo: { dir: path.join(videoDir, 'phone'), size: PHONE } });
    contexts.push(desktopContext, phoneContext);
    const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
    for (const page of [desktop, phone]) {
      page.setDefaultTimeout(20_000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() !== 'error') return;
        const at = new URL(message.location().url || hub.url).pathname, text = message.text();
        // Database-only demo Bots have no runtime and the disposable Hub has no
        // Bot manager: task/steer/collaboration probes answer 409/503/403.
        const probe = (/ (409|503) /.test(text) && /^\/api\/conversations\/[^/]+\/(tasks|steer)$/.test(at)) || (/ 403 /.test(text) && /^\/api\/bots\/[^/]+\/collaboration$/.test(at)) ? `${text.match(/(403|409|503)/)[1]} ${at.split('/').at(-1)}` : '';
        if (probe) fixtureProbes[probe] = (fixtureProbes[probe] ?? 0) + 1; else errors.push(`${text} @ ${at}`);
      });
    }
    let appearance;
    for (const [page, name] of [[desktop, data.desktop], [phone, data.phone]]) {
      await page.goto(hub.url);
      const field = page.getByLabel('设备名称', { exact: true }); if (await field.count()) await field.fill(name);
      await prepareReadmePairing(page, hub);
      await page.getByRole('button', { name: '配对此设备', exact: true }).click();
      await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
      await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
      await expect(page.locator('.host-workspace:not([hidden]) .app-shell')).toBeVisible();
      // Seed only this disposable browser's ordinary preference store.
      await readmePreferences(page, locale, 'bots'); await page.reload();
      await expect(page.locator('.host-workspace:not([hidden]) .app-shell')).toBeVisible();
      appearance = await brandCheck(page);
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(os.hostname().split('.')[0]);
    }
    const layout = name => desktop.locator('.sidebar-layout-switch').filter({ visible: true }).getByRole('button', { name, exact: true });
    const botsButton = layout(t('Bots', '按 Bot')), chatsButton = layout(t('Chats', '按对话'));
    // Fold the other Bots once through their real disclosure controls, so the
    // By Bot view later fits all seven; then start in Chats.
    await desktop.locator(`.sidebar [data-conversation-id="${launch.id}"]`).filter({ visible: true }).first().click();
    await compactReadmeBots(desktop, 'codex');
    const desktopBotsAvatars = await listCheck(desktop, 'desktop By Bot');
    await chatsButton.click();
    await expect(chatsButton).toHaveAttribute('aria-pressed', 'true');
    await expect(desktop.locator('.message-blocks').filter({ hasText: t('The launch plan is ready.', '发布计划已整理好。') })).toBeVisible();
    const desktopChatsAvatars = await listCheck(desktop, 'desktop Chats');
    await phone.locator('.mobile-home').filter({ visible: true }).waitFor();
    const phoneAvatars = await listCheck(phone, 'phone list');
    for (const page of [desktop, phone]) {
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(img => img.getClientRects().length).map(img => img.decode().catch(() => {}))); });
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    }
    await desktop.mouse.move(0, 0);
    const flashedAt = await Promise.all([desktop, phone].map(syncFlash));
    await sleep(900);

    const at = () => (Date.now() - marks.start) / 1000, scenes = [];
    marks.start = Date.now();
    scenes.push({ at: 0, action: 'Both devices show the conversation list (desktop Chats, phone Message)' });
    await sleep(2200);
    scenes.push({ at: at(), action: `Desktop: ${t('Bots', '按 Bot')}` });
    await botsButton.click(); await desktop.mouse.move(0, 0);
    await expect(botsButton).toHaveAttribute('aria-pressed', 'true');
    await sleep(2400);
    scenes.push({ at: at(), action: `Desktop: ${t('Chats', '按对话')}` });
    await chatsButton.click(); await desktop.mouse.move(0, 0);
    await expect(chatsButton).toHaveAttribute('aria-pressed', 'true');
    await sleep(1300);
    scenes.push({ at: at(), action: `Phone: open ${data.titles[0]}` });
    await phone.locator(`.mobile-home [data-conversation-id="${launch.id}"]`).tap();
    await expect(phone.getByRole('heading', { name: data.titles[0], level: 1 })).toBeVisible();
    await expect(phone.locator('.message-blocks').filter({ hasText: t('The launch plan is ready.', '发布计划已整理好。') })).toBeVisible();
    await sleep(1300);
    scenes.push({ at: at(), action: 'Phone: type and send a continuation' });
    const composer = phone.getByRole('textbox', { name: t('Message', '消息'), exact: true });
    await composer.tap(); await composer.pressSequentially(data.next, { delay: locale === 'zh' ? 55 : 28 });
    await sleep(350);
    // Mobile Enter inserts a line break; send with the real button.
    await phone.getByRole('button', { name: t('Send message', "发送消息"), exact: true }).tap();
    await expect(desktop.locator('.message').filter({ hasText: data.next }).last()).toBeVisible();
    scenes.push({ at: at(), action: 'Desktop: the phone message arrives in the open conversation' });
    await expect(desktop.locator('.message-blocks').filter({ hasText: data.answer.slice(0, 8) }).last()).toBeVisible({ timeout: 10_000 });
    await expect(phone.locator('.message-blocks').filter({ hasText: data.answer.slice(0, 8) }).last()).toBeVisible({ timeout: 10_000 });
    scenes.push({ at: at(), action: 'Scripted Bot reply shown on both devices' });
    await phone.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await sleep(2600);
    marks.end = Date.now();
    await expect(desktop.locator('[data-agent-state="done"], .unread-badge').filter({ visible: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    const desktopVideo = await desktop.video().path(), phoneVideo = await phone.video().path();
    await desktopContext.close(); await phoneContext.close(); contexts.length = 0;
    const raw = { locale, appearance, visibleAvatars: { desktopChats: desktopChatsAvatars, desktopBots: desktopBotsAvatars, phone: phoneAvatars },
      desktopOffset: syncOffset(desktopVideo, flashedAt[0], marks.start), phoneOffset: syncOffset(phoneVideo, flashedAt[1], marks.start),
      scenes: scenes.map(scene => ({ ...scene, at: Number(scene.at.toFixed(2)) })), duration: (marks.end - marks.start) / 1000,
      consoleErrors: errors.length, fixtureProbes };
    if (process.env.DEMO_KEEP) {
      const keep = path.join(process.env.DEMO_KEEP, `inbox-${locale}`); await mkdir(keep, { recursive: true });
      await copyFile(desktopVideo, path.join(keep, 'desktop.webm')); await copyFile(phoneVideo, path.join(keep, 'phone.webm'));
      await writeFile(path.join(keep, 'marks.json'), JSON.stringify(raw, null, 2));
    }
    return await compose(browser, work, raw, desktopVideo, phoneVideo);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    for (const gateway of gateways) await gateway.disconnect().catch(() => {});
    await hub.close();
  }
}

const args = process.argv.slice(2), from = args[0] === '--from' ? args.splice(0, 2)[1] : undefined;
const locales = args.length ? args : ['zh', 'en'];
const browser = await chromium.launch({ headless: true });
const records = [];
try {
  for (const locale of locales) {
    const work = await mkdtemp(path.join(os.tmpdir(), `tarobird-readme-inbox-${locale}-`));
    try {
      const record = from
        ? await compose(browser, work, JSON.parse(await readFile(path.join(from, `inbox-${locale}`, 'marks.json'), 'utf8')), path.join(from, `inbox-${locale}`, 'desktop.webm'), path.join(from, `inbox-${locale}`, 'phone.webm'))
        : await capture(browser, locale, work);
      records.push(record);
      console.log(`${from ? 'Composed' : 'Captured'} ${record.file} (${(record.bytes / 1048576).toFixed(2)} MiB, ${record.duration} s)`);
    } finally { await rm(work, { recursive: true, force: true }); }
  }
  const metaFile = path.join(output, 'inbox-capture.json');
  let previous = [];
  try { previous = JSON.parse(await readFile(metaFile, 'utf8')).animations ?? []; } catch {}
  const animations = [...previous.filter(item => !records.some(record => record.file === item.file)), ...records].sort((a, b) => a.file.localeCompare(b.file));
  await writeFile(metaFile, JSON.stringify({ clientVersion: version, ...provenance, captured: new Date().toISOString(),
    source: 'Built shared client in two browser contexts (desktop and phone) paired with an isolated loopback Hub. Conversations are synthetic; the phone message is typed in the real composer and the single Bot reply comes from a scripted gateway bridge. No model call, approval, repository operation or native-device acceptance.',
    animations }, null, 2) + '\n');
} finally { await browser.close(); }
