// README demo: one task, approval on the phone, and the completed result.
// Detailed workflows remain in their own README sections.
// Real shared-client UI on an isolated loopback Hub. Bots use scripted bridges
// or published demonstration messages; no model, no production Hub and no real
// repository operation is involved.
// Prerequisites: npm run build && npm --prefix client run build, and ffmpeg.
// Usage: node scripts/capture-readme-demo.mjs [zh|en ...]
//        node scripts/capture-readme-demo.mjs --from <DEMO_KEEP dir> [zh|en ...]
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
// Composition geometry (output pixels). Holes in the overlay reveal the videos.
const W = 1280, H = 720, FPS = 10;
const D = { x: 48, y: 108, w: 900, h: 540 }, P = { x: 982, y: 108, w: 250, h: 540 };
// Retain a solo layout for future scenes beyond the three-device story.
const SOLO = { x: 140, y: 100, w: 1000, h: 600 }, SOLO_FROM = 3;

const copy = {
  zh: {
    host:'工作室', desktop:'工作室 Mac', phone:'演示手机', allow:'允许一次', release:'发布说明',
    task:'整理更新说明，推送到仓库。', progress:'正在写入 release-notes.md。',
    done:'**更新说明已推送。**\n\n- 6 项更新已整理\n- 已推送到 `main`',
    steps:['在电脑上派任务','在手机上批准','回到电脑，查看结果'],
  },
  en: {
    host:'Studio', desktop:'Studio Mac', phone:'Demo phone', allow:'Allow once', release:'Release notes',
    task:'Write the release notes and push them.', progress:'Writing release-notes.md.',
    done:'**Release notes pushed.**\n\n- Six changes documented\n- Pushed to `main`',
    steps:['Assign a task on your computer','Approve from your phone','Return to the completed result'],
  },
};
// [id, name, engine, model, gateway]
const bots = [['codex', 'Codex', 'codex', 'gpt-6-astra', true], ['claude', 'Claude', 'claude', 'claude-opus-5-5', false], ['kimi', 'Kimi', 'kimi', 'kimi-code/k3', false], ['deepseek', 'DeepSeek', 'deepseek', 'deepseek-flash', false], ['gemini', 'Gemini', 'antigravity', 'gemini-3.8-flash-high', false], ['agy', 'Antigravity', 'antigravity', 'gemini-4-argon', false], ['studio', 'Claude · Studio', 'claude', 'claude-opus-5-5', false]];

const seedPreferences = (page, locale) => readmePreferences(page, locale, 'bots');

/** Verify the real saved monochrome / warm-gray appearance and the leading fox. */
async function brandCheck(page, botId) {
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'mono');
  await expect(page.locator(`[data-avatar="bot:${botId}"][data-preset="pastel-fox"] img[src*="pastel-fox-"]`).filter({ visible: true }).first()).toBeVisible();
  const presets = await page.locator('[data-avatar^="bot:"][data-preset]').evaluateAll(nodes => nodes.map(node => [node.dataset.avatar, node.dataset.preset]));
  expect(presets.filter(([avatar, preset]) => (avatar === `bot:${botId}`) !== (preset === 'pastel-fox'))).toEqual([]);
  return { ...await readmeAppearance(page), visibleAvatars: await visibleReadmeAvatars(page), firstBotAvatar: { botId, avatar: 'pastel-fox' } };
}

/** Playwright starts each video at its first delivered frame, which for a
 * background page can arrive seconds after the page opened. A brief full-page
 * flash before the recorded window marks one known instant in both raw videos;
 * the composition starts after it, so it never appears in the GIF. */
async function syncFlash(page) {
  return page.evaluate(() => new Promise(resolve => {
    const flash = document.createElement('div');
    flash.style.cssText = 'position:fixed;inset:0;background:#f0f;z-index:2147483647;pointer-events:none';
    document.body.appendChild(flash);
    requestAnimationFrame(() => requestAnimationFrame(() => { const at = Date.now(); setTimeout(() => { flash.remove(); resolve(at); }, 400); }));
  }));
}
/** Seconds into a raw recording at which wall time `start` occurs, located by the sync flash. */
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

/** A brief touch ring, because headless recordings do not show taps or clicks. */
async function pointer(page, box) {
  await page.evaluate(({ x, y }) => {
    const dot = document.createElement('div');
    dot.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:50%;background:rgba(163,155,145,.28);border:2px solid rgba(163,155,145,.85);pointer-events:none;z-index:2147483647;transition:transform .45s ease-out,opacity .45s ease-out`;
    document.body.appendChild(dot);
    requestAnimationFrame(() => requestAnimationFrame(() => { dot.style.transform = 'scale(1.5)'; dot.style.opacity = '0'; }));
    setTimeout(() => dot.remove(), 700);
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await sleep(200);
}
async function tap(page, locator) { await pointer(page, await locator.boundingBox()); await locator.tap(); }
async function press(page, locator) { await pointer(page, await locator.boundingBox()); await locator.click(); }

async function overlay(browser, file, step, total, label, locale, solo) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const rect = (r, radius, attrs) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${radius}" ${attrs}/>`;
  // One mask keeps both device openings transparent.
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
    .cap{position:absolute;left:${(solo ? SOLO : D).x}px;top:${solo ? 34 : 38}px;font-family:"Helvetica Neue","PingFang SC",Helvetica,sans-serif;color:#292929;display:flex;align-items:baseline;gap:16px}
    .num{font:600 15px "SF Mono",Menlo,monospace;color:#8f877d;letter-spacing:.5px}
    .txt{font-size:27px;font-weight:700;letter-spacing:${locale === 'zh' ? '1px' : '-.3px'}}
    .brand{position:absolute;right:${solo ? W - SOLO.x - SOLO.w : W - P.x - P.w}px;top:${solo ? 40 : 44}px;font:600 15px "Helvetica Neue",Helvetica,sans-serif;color:#6b6b6b;letter-spacing:.4px}
    svg{position:absolute;left:0;top:0}
  </style></head><body><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><mask id="m"><rect width="${W}" height="${H}" fill="white"/>${solo ? rect(SOLO, 14, 'fill="black"') : rect(D, 12, 'fill="black"') + rect(P, 31, 'fill="black"')}</mask></defs>
    <rect width="${W}" height="${H}" fill="#f3f2f0" mask="url(#m)"/>
    ${solo ? rect({ x: SOLO.x - 0.5, y: SOLO.y - 0.5, w: SOLO.w + 1, h: SOLO.h + 1 }, 14.5, 'fill="none" stroke="#ddd9d4" stroke-width="1"')
      : rect({ x: D.x - 0.5, y: D.y - 0.5, w: D.w + 1, h: D.h + 1 }, 12.5, 'fill="none" stroke="#ddd9d4" stroke-width="1"') + rect({ x: P.x - 4.5, y: P.y - 4.5, w: P.w + 9, h: P.h + 9 }, 35, 'fill="none" stroke="#292929" stroke-width="9"')}
  </svg><div class="cap"><span class="num">0${step} / 0${total}</span><span class="txt">${label}</span></div><div class="brand">TaroBird</div></body></html>`);
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
}

/** Stage → palette → GIF in separate passes, so no pass holds every frame. */
async function compose(browser, work, raw, desktopVideo, phoneVideo) {
  const { locale, steps, duration } = raw, data = copy[locale], d = duration.toFixed(2), n = steps.length;
  const overlays = [];
  for (let i = 0; i < n; i++) { const file = path.join(work, `overlay-${i}.png`); await overlay(browser, file, i + 1, n, data.steps[i], locale, i >= SOLO_FROM); overlays.push(file); }
  const cut = (steps[SOLO_FROM] ?? duration).toFixed(2);
  const enable = i => `between(t,${steps[i].toFixed(2)},${(i < n - 1 ? steps[i + 1] : duration + 1).toFixed(2)})`;
  const graph = [
    `color=c=#f3f2f0:s=${W}x${H}:r=${FPS}:d=${d}[base]`,
    `[0:v]fps=${FPS},split[d0][d1]`, `[d0]scale=${D.w}:${D.h}:flags=lanczos[d]`, `[d1]scale=${SOLO.w}:${SOLO.h}:flags=lanczos[ds]`,
    `[1:v]fps=${FPS},scale=${P.w}:${P.h}:flags=lanczos[p]`,
    `[base][d]overlay=${D.x}:${D.y}:eof_action=repeat:enable='lt(t,${cut})'[a]`, `[a][p]overlay=${P.x}:${P.y}:eof_action=repeat:enable='lt(t,${cut})'[a1]`,
    `[a1][ds]overlay=${SOLO.x}:${SOLO.y}:eof_action=repeat:enable='gte(t,${cut})'[c]`,
    ...overlays.map((_, i) => `[${i ? `c${i - 1}` : 'c'}][${i + 2}:v]overlay=0:0:enable='${enable(i)}'${i < n - 1 ? `[c${i}]` : ''}`),
  ].join(';');
  const stage = path.join(work, `stage-${locale}.mkv`), palette = path.join(work, `palette-${locale}.png`);
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-ss', raw.desktopOffset.toFixed(2), '-t', d, '-i', desktopVideo, '-ss', raw.phoneOffset.toFixed(2), '-t', d, '-i', phoneVideo,
    ...overlays.flatMap(o => ['-loop', '1', '-framerate', String(FPS), '-t', d, '-i', o]),
    '-filter_complex', graph, '-t', d, '-c:v', 'ffv1', '-pix_fmt', 'bgr0', stage]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', stage, '-vf', 'palettegen=max_colors=192:stats_mode=diff', palette]);
  const file = `approval-demo-${locale}.gif`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', stage, '-i', palette, '-lavfi', 'paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', path.join(output, file)]);
  if (process.env.DEMO_KEEP) execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', stage, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(process.env.DEMO_KEEP, `approval-demo-${locale}.mp4`)]);
  const bytes = await readFile(path.join(output, file));
  return { file, locale, palette: raw.palette, monoAccent: raw.monoAccent, visibleAvatars: raw.visibleAvatars, firstBotAvatar: raw.firstBotAvatar, duration: Number(duration.toFixed(2)), fps: FPS, size: { width: W, height: H }, desktopViewport: DESKTOP, phoneViewport: PHONE, scenes: data.steps.map((label, i) => ({ label, start: Number(steps[i].toFixed(2)) })), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function capture(browser, locale, work) {
  const data = copy[locale], t = (en, zh) => (locale === 'zh' ? zh : en);
  const hub = await HubServer.start({ stateDir: path.join(work, 'hub'), clientDir: path.join(root, 'client/dist') });
  const gateways = [], contexts = [], marks = {}, errors = [];
  let brand;
  try {
    await hub.profile.update({ name: data.host, revision: (await hub.profile.read()).revision });
    for (const [id, name, engine, model, gateway] of bots) {
      if (!gateway) { await hub.store.db.run('INSERT INTO bots(id,name,secret_hash,engine,model,online) VALUES(?,?,?,?,?,1)', [id, name, 'demo-only', engine, model]); }
      else {
        const stateDir = path.join(work, id); await mkdir(stateDir);
        await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine, model, locale }));
        const secret = randomBytes(32).toString('base64url');
        await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', [id, name, hashSecret(secret)]);
        const bridge = { handleAuthorizedMessage: async input => {
          const ev = event => input.onEngineEvent?.(event);
          await sleep(450); await ev({ type: 'tool_use', toolName: 'Read', toolUseId: 'r1', toolInput: { file_path: 'CHANGELOG.md' } });
          await sleep(400); await ev({ type: 'tool_result', toolUseId: 'r1', output: '12 entries' });
          await ev({ type: 'assistant_text', text: data.progress });
          await sleep(450); await ev({ type: 'tool_use', toolName: 'Edit', toolUseId: 'e1', toolInput: { file_path: 'release-notes.md' } });
          await sleep(400); await ev({ type: 'tool_result', toolUseId: 'e1', output: 'ok' });
          const decision = await input.onApprovalRequest?.({ engine: 'codex', toolName: 'Bash', toolInput: { command: 'git push origin main' }, approvalScopes: { once: 'once' } });
          if (decision?.behavior !== 'allow') return { text: '—' };
          await ev({ type: 'tool_use', toolName: 'Bash', toolUseId: 'b1', toolInput: { command: 'git push origin main' } });
          await sleep(650); await ev({ type: 'tool_result', toolUseId: 'b1', output: 'main -> main' });
          await sleep(200);
          return { text: data.done };
        } };
        gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace('http', 'ws') + '/instance', secret, botId: id, engine, model, runtime: createCoreServiceRuntime(), bridge }));
      }
      await hub.store.db.run('INSERT INTO managed_bots VALUES(?,?,?,?)', [id, 'owner', id, '{}']);
      await hub.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [BOT_AVATAR_DEFAULT_PREFIX + id, readmeAvatars[id]]);
      if (id !== 'codex') {
        const chat = await hub.store.createConversation('owner', [id], name, `demo-extra-${id}`);
        await hub.store.publishBotMessage(id, { conversationId:chat.id, blocks:[{type:'text',text:locale === 'zh' ? '草稿已归档，随时继续。' : 'Draft saved. Ready when you are.'}] });
        await hub.store.markRead('owner',chat.id,Number.MAX_SAFE_INTEGER);
      }
    }
    const release = await hub.store.createConversation('owner', ['codex'], data.release, 'demo-release');
    const videoDir = path.join(work, 'video');
    const options = { locale: locale === 'zh' ? 'zh-CN' : 'en-GB', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' };
    const desktopContext = await browser.newContext({ ...options, viewport: DESKTOP, recordVideo: { dir: path.join(videoDir, 'desktop'), size: DESKTOP } });
    const phoneContext = await browser.newContext({ ...options, viewport: PHONE, isMobile: true, hasTouch: true, recordVideo: { dir: path.join(videoDir, 'phone'), size: PHONE } });
    contexts.push(desktopContext, phoneContext);
    const desktop = await desktopContext.newPage();
    const phone = await phoneContext.newPage();
    for (const page of [desktop, phone]) { page.setDefaultTimeout(20_000); page.on('pageerror', error => errors.push(error.message)); }
    for (const [page, name] of [[desktop, data.desktop], [phone, data.phone]]) {
      await page.goto(hub.url);
      const field = page.getByLabel('设备名称', { exact: true }); if (await field.count()) await field.fill(name);
      await prepareReadmePairing(page, hub);
      await page.getByRole('button', { name: '配对此设备', exact: true }).click();
      await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
      await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
      await expect(page.locator('.host-workspace:not([hidden]) .app-shell')).toBeVisible();
      await seedPreferences(page, locale); await page.reload();
      await expect(page.locator('.host-workspace:not([hidden]) .app-shell')).toBeVisible();
      brand = await brandCheck(page, 'codex');
    }
    await desktop.locator('.conversation-row').filter({ has: desktop.getByText(data.release, { exact: true }) }).click();
    await phone.locator('.host-workspace:not([hidden]) .mobile-home').getByRole('button').filter({ has: phone.getByText(data.release, { exact: true }) }).click();
    await expect(phone.getByRole('heading', { name: data.release, level: 1 })).toBeVisible();
    await compactReadmeBots(desktop, 'codex');
    expect((await visibleReadmeAvatars(desktop)).sort()).toEqual(bots.map(([id]) => readmeAvatars[id]).sort());
    brand = await brandCheck(desktop, 'codex');
    await desktop.evaluate(async () => { await document.fonts.ready; }); await desktop.mouse.move(0, 0);
    const flashedAt = await Promise.all([desktop, phone].map(syncFlash));
    await sleep(900);

    // 01 Assign the task on the desktop.
    marks.start = Date.now();
    const composer = desktop.getByRole('textbox', { name: t('Message', '消息'), exact: true });
    await composer.click(); await composer.pressSequentially(data.task, { delay: locale === 'zh' ? 35 : 20 });
    await sleep(300); await composer.press('Enter');
    // 02 The approval reaches the phone.
    const allow = phone.getByRole('button', { name: data.allow, exact: true });
    await expect(allow).toBeVisible();
    marks.approval = Date.now();
    await phone.locator('.message').last().scrollIntoViewIfNeeded();
    await sleep(2200);
    await tap(phone, allow);
    marks.approved = Date.now();
    // 03 The desktop run continues and completes.
    await expect(desktop.locator('.native-run-status').first()).toContainText(t('Completed', '已完成'), { timeout: 20_000 });
    await sleep(3700);
    marks.end = Date.now();
    await expect(desktop.locator('html')).toHaveAttribute('data-palette', brand.palette);
    expect(errors).toEqual([]);
    const desktopVideo = await desktop.video().path(), phoneVideo = await phone.video().path();
    await desktopContext.close(); await phoneContext.close(); contexts.length = 0;
    const raw = { locale, ...brand, desktopOffset: syncOffset(desktopVideo, flashedAt[0], marks.start), phoneOffset: syncOffset(phoneVideo, flashedAt[1], marks.start),
      steps: [marks.start, marks.approval, marks.approved + 400].map(v => (v - marks.start) / 1000), duration: (marks.end - marks.start) / 1000 };
    if (process.env.DEMO_KEEP) {
      const keep = path.join(process.env.DEMO_KEEP, locale); await mkdir(keep, { recursive: true });
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
    const work = await mkdtemp(path.join(os.tmpdir(), `tarobot-readme-demo-${locale}-`));
    try {
      const record = from
        ? await compose(browser, work, JSON.parse(await readFile(path.join(from, locale, 'marks.json'), 'utf8')), path.join(from, locale, 'desktop.webm'), path.join(from, locale, 'phone.webm'))
        : await capture(browser, locale, work);
      records.push(record);
      console.log(`${from ? 'Composed' : 'Captured'} ${record.file} (${(record.bytes / 1048576).toFixed(1)} MiB, ${record.duration} s)`);
    } finally { await rm(work, { recursive: true, force: true }); }
  }
  const metaFile = path.join(output, 'approval-capture.json');
  let previous = [];
  try { previous = JSON.parse(await readFile(metaFile, 'utf8')).images ?? []; } catch {}
  const images = [...previous.filter(image => !records.some(record => record.file === image.file)), ...records].sort((a, b) => a.file.localeCompare(b.file));
  await writeFile(metaFile, JSON.stringify({ clientVersion: version, ...provenance, captured: new Date().toISOString(), source: 'Built shared client in two browser contexts (desktop and phone) paired with an isolated loopback Hub. The approval and completion are driven by a scripted bridge: no model call, no real repository push, no native-device acceptance.', images }, null, 2) + '\n');
} finally { await browser.close(); }
