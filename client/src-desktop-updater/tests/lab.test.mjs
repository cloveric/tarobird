// End-to-end lab for the `lab`-feature updater binary. Every path is a
// fresh .noindex fixture; GitHub is a local TLS fixture behind a proxy.
//   TAROBOT_UPDATER_LAB_BIN=<target>/debug/tarobot-desktop-updater \
//   TAROBOT_UPDATER_LAB_ROOT=<lab>.noindex node --test tests/lab.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopUpdateBundle } from '../../scripts/desktop-update-manifest.mjs';
import { generateKey, signBytes } from './minisign.mjs';
import { DesktopUpdates, UpdaterProcess } from '../../electron/updater.mjs';
import { DESKTOP_EVENT } from '../../electron/contract.mjs';
import { archiveApp, fakeHostRuntime, fakeInternet, labRoot, makeApp, pki, plistValue, startUpdater, stopUpdaters } from './lab/fixtures.mjs';

const BIN = process.env.TAROBOT_UPDATER_LAB_BIN;
const REPO = 'lab-owner/lab-repo', API = `https://api.github.com/repos/${REPO}`;
const TOKEN = 'gho_labtoken0001', DEVICE = 'lab_device_code_secret';
let root, net, ca, key, foreign, archives = {};

before(async () => {
  assert.ok(BIN && existsSync(BIN), 'TAROBOT_UPDATER_LAB_BIN must be the lab-feature binary');
  root = labRoot();
  const certs = pki(path.join(root, 'pki'));
  ca = certs.caDer;
  net = await fakeInternet(certs);
  key = generateKey(); foreign = generateKey();
  const build = (name, options) => {
    const dir = path.join(root, 'releases', name);
    mkdirSync(dir, { recursive: true });
    const bytes = archiveApp(makeApp(root, dir, options), path.join(dir, 'TaroBot.app.tar.gz'));
    return { file: path.join(dir, 'TaroBot.app.tar.gz'), bytes };
  };
  archives.next = build('next', { version: '1.2.4' });
  archives.foreignIdentity = build('foreign-identity', { version: '1.2.4', identifier: 'com.example.other' });
});

after(async () => {
  await stopUpdaters();
  await net?.close();
  if (root && !process.env.TAROBOT_UPDATER_LAB_KEEP) rmSync(root, { recursive: true, force: true });
});

function scenario(name, { github = true, hostMode = 'ok', vault, endpoints, spawn = true } = {}) {
  const dir = path.join(root, 'cases', name);
  const applications = path.join(dir, 'Applications');
  mkdirSync(applications, { recursive: true });
  const app = makeApp(root, applications, { version: '1.2.3' });
  const resources = path.join(dir, 'resources/host');
  fakeHostRuntime(resources);
  const appData = path.join(dir, 'app-data'), hostDir = path.join(appData, 'host');
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(path.join(hostDir, 'lab-mode.json'), JSON.stringify({ mode: hostMode }));
  const config = path.join(dir, 'update-config.json');
  writeFileSync(config, JSON.stringify({
    updater: { pubkey: key.pubkey, requireSignedVersion: true, allowDowngrades: false, endpoints: endpoints ?? [`${API}/releases`] },
    ...(github ? { 'github-updates': { repository: REPO, clientId: 'Iv1.labclient' } } : {}),
  }));
  const vaultFile = path.join(dir, 'vault.json');
  if (vault) writeFileSync(vaultFile, JSON.stringify(vault));
  const work = path.join(dir, 'work');
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: path.join(dir, 'tmp'),
    TAROBOT_UPDATER_LAB_CA: ca, TAROBOT_UPDATER_LAB_PROXY: net.proxy, TAROBOT_UPDATER_LAB_VAULT: vaultFile };
  mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  const main = { executable: BIN, configFile: config, appVersion: '1.2.3', appBundle: app, resourcesDir: resources, hostStateDir: appData, workDir: work };
  const updater = spawn ? startUpdater(BIN, ['--config', config, '--app-version', '1.2.3', '--app-bundle', app,
    '--resources-dir', resources, '--host-state-dir', appData, '--work-dir', work], env) : undefined;
  const hostLog = () => existsSync(path.join(hostDir, 'lab-events.log')) ? readFileSync(path.join(hostDir, 'lab-events.log'), 'utf8').trim().split('\n') : [];
  const leftovers = () => readdirSync(applications).filter(entry => entry !== 'TaroBot.app');
  // The cross-process install lock file stays; downloads must not.
  const scratch = () => existsSync(work) ? readdirSync(work).filter(entry => entry !== '.install.lock') : [];
  const offerEvents = offer => updater.events.filter(event => event.offerId === offer).map(event => event.data);
  return { dir, applications, app, hostDir, vaultFile, updater, hostLog, leftovers, scratch, offerEvents, main, env };
}

async function publish({ archive = archives.next, signer = key, signed = archive, declaredSize, version = '1.2.4' } = {}) {
  const dir = path.join(root, 'published', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const installer = path.join(dir, 'TaroBot.app.tar.gz');
  writeFileSync(installer, archive.bytes);
  writeFileSync(`${installer}.sig`, signBytes(key, archive.bytes, { version }));
  // The production release tool builds and verifies the manifest. It refuses
  // foreign signatures, so that case swaps the signature in afterwards.
  const bundle = await createDesktopUpdateBundle({ installer, publicKey: key.pubkey, repository: REPO, assetUrl: `${API}/releases/assets/12`,
    version, platform: 'macos', outputDir: path.join(dir, 'out'), notes: 'Lab notes' });
  const manifest = JSON.parse(readFileSync(bundle.manifestFile, 'utf8'));
  if (signer !== key || signed !== archive) manifest.platforms['darwin-aarch64'].signature = signBytes(signer, signed.bytes, { version });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  net.json('GET', `${API}/releases`, [{ tag_name: `macos-tarobot-v${version}`, draft: false, prerelease: false, assets: [
    { id: 11, name: 'macos-tarobot-latest.json', url: `${API}/releases/assets/11`, size: manifestBytes.length },
    { id: 12, name: 'TaroBot.app.tar.gz', url: `${API}/releases/assets/12`, size: declaredSize ?? archive.bytes.length },
  ] }]);
  net.route('GET', `${API}/releases/assets/11`, (_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(manifestBytes); });
  net.route('GET', `${API}/releases/assets/12`, (_req, res) => { res.writeHead(302, { location: 'https://release-assets.githubusercontent.com/lab/12?sig=short-lived' }); res.end(); });
  net.route('GET', 'https://release-assets.githubusercontent.com/lab/12', (_req, res) => { res.writeHead(200, { 'content-length': archive.bytes.length }); res.end(archive.bytes); });
  return manifest;
}

function githubLogin({ deny = false } = {}) {
  let polls = 0;
  net.json('POST', 'https://github.com/login/device/code', { device_code: DEVICE, user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
  net.json('POST', 'https://github.com/login/oauth/access_token', () => ++polls === 1 ? { error: 'authorization_pending' }
    : deny ? { error: 'access_denied' } : { access_token: TOKEN, token_type: 'bearer', scope: 'repo' });
  net.route('GET', 'https://api.github.com/user', (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ login: 'lab-user' }));
  });
}

// Each case can run independently, including a single regression by name.
beforeEach(() => githubLogin());

async function login(updater) {
  const start = await updater.call('login_start');
  assert.deepEqual(Object.keys(start).sort(), ['expiresIn', 'flowId', 'interval', 'userCode', 'verificationUri']);
  assert.equal(start.verificationUri, 'https://github.com/login/device');
  for (let attempt = 0; attempt < 10; attempt++) {
    const poll = await updater.call('login_poll', { flowId: start.flowId });
    if (poll.status === 'authorized') return start;
    await delay((poll.interval ?? 1) * 1000);
  }
  throw new Error('login did not complete');
}

const stored = { token: TOKEN, login: 'lab-user' };
const until = async (predicate, ms = 15000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('timed out'); await delay(25); } };

test('github: device login, signed check, download, Host drain, replace and read-back', async () => {
  githubLogin();
  const s = scenario('github-install');
  assert.deepEqual(await s.updater.call('info'), { configured: true, version: '1.2.3', provider: 'github', authenticated: false });
  await login(s.updater);
  assert.equal(JSON.parse(readFileSync(s.vaultFile, 'utf8')).token, TOKEN);
  assert.deepEqual(await s.updater.call('info'), { configured: true, version: '1.2.3', provider: 'github', authenticated: true, login: 'lab-user' });
  await publish();
  const before = net.requests.length;
  const offer = await s.updater.call('check');
  assert.equal(offer.version, '1.2.4'); assert.equal(offer.body, 'Lab notes'); assert.match(offer.offerId, /^[0-9a-f-]{36}$/);
  assert.equal(await s.updater.call('install', { offerId: offer.offerId }), null);
  const events = s.offerEvents(offer.offerId);
  assert.deepEqual(events[0], { event: 'Started', data: { contentLength: archives.next.bytes.length } });
  assert.deepEqual(events.filter(event => event.event !== 'Progress').map(event => event.event), ['Started', 'WaitingForHost', 'Installing', 'RestartingHost', 'Finished']);
  assert.equal(events.filter(event => event.event === 'Progress').reduce((sum, event) => sum + event.data.chunkLength, 0), archives.next.bytes.length);
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.4');
  assert.equal(readFileSync(path.join(s.app, 'Contents/Resources/marker.txt'), 'utf8'), '1.2.4');
  execFileSync('codesign', ['--verify', '--deep', '--strict', s.app]);
  assert.deepEqual(s.hostLog(), ['start desktop-update ok', 'ready', 'finish']);
  assert.deepEqual(s.leftovers(), []);
  assert.deepEqual(s.scratch(), []);
  const traffic = net.requests.slice(before);
  const cdn = traffic.find(request => request.host === 'release-assets.githubusercontent.com');
  assert.equal(cdn.authorization, null, 'the signed CDN redirect must not receive the GitHub token');
  assert.equal(traffic.find(request => request.path.endsWith('/assets/12')).authorization, `Bearer ${TOKEN}`);
  assert.ok(net.connects.every(target => target.endsWith(':443')));
  const output = s.updater.lines.join('\n');
  assert.ok(!output.includes(TOKEN) && !output.includes(DEVICE), 'credentials never reach the protocol');
  assert.equal(s.updater.stderr(), '', 'stderr carries nothing');
  assert.deepEqual(await s.updater.end(), { code: 0, signal: null });
});

test('github: a foreign signature fails before backup, staging or Host pause', async () => {
  const s = scenario('foreign-signature', { vault: stored });
  await publish({ signer: foreign });
  const offer = await s.updater.call('check');
  await assert.rejects(s.updater.call('install', { offerId: offer.offerId }), { code: 'github_update_signature' });
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.3');
  assert.deepEqual(s.hostLog(), []); assert.deepEqual(s.leftovers(), []); assert.deepEqual(s.scratch(), []);
  // The offer is consumed; a retry needs a fresh check.
  await assert.rejects(s.updater.call('install', { offerId: offer.offerId }), { code: 'github_update_invalid_offer' });
  await s.updater.end();
});

test('github: bytes that differ from what the pinned key signed fail the streamed check', async () => {
  const s = scenario('tampered-body', { vault: stored });
  await publish({ signed: archives.foreignIdentity });
  const offer = await s.updater.call('check');
  await assert.rejects(s.updater.call('install', { offerId: offer.offerId }), { code: 'github_update_signature' });
  // The whole body was downloaded and hashed before the refusal.
  assert.ok(s.offerEvents(offer.offerId).some(event => event.event === 'Started'));
  assert.ok(!s.offerEvents(offer.offerId).some(event => event.event === 'WaitingForHost'));
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.3');
  assert.deepEqual(s.hostLog(), []); assert.deepEqual(s.leftovers(), []); assert.deepEqual(s.scratch(), []);
  await s.updater.end();
});

test('github: a body that differs from the declared asset size is refused', async () => {
  const s = scenario('size-mismatch', { vault: stored });
  await publish({ declaredSize: archives.next.bytes.length + 1 });
  const offer = await s.updater.call('check');
  await assert.rejects(s.updater.call('install', { offerId: offer.offerId }), { code: 'github_update_bounds' });
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.3');
  assert.deepEqual(s.hostLog(), []); assert.deepEqual(s.leftovers(), []);
  await s.updater.end();
});

test('github: a signed archive with another bundle identity fails staged read-back before the Host pauses', async () => {
  const s = scenario('foreign-identity', { vault: stored });
  await publish({ archive: archives.foreignIdentity });
  const offer = await s.updater.call('check');
  await assert.rejects(s.updater.call('install', { offerId: offer.offerId }), { code: 'github_update_install' });
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.3');
  assert.deepEqual(s.hostLog(), []); assert.deepEqual(s.leftovers(), []); assert.deepEqual(s.scratch(), []);
  await s.updater.end();
});

test('github: a refusing Host keeps the running bundle and drops the backup', async () => {
  const s = scenario('host-refuses', { vault: stored, hostMode: 'refuse' });
  await publish();
  const offer = await s.updater.call('check');
  await assert.rejects(s.updater.call('install', { offerId: offer.offerId }), { code: 'github_update_host' });
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.3');
  assert.deepEqual(s.hostLog(), ['start desktop-update refuse']);
  assert.deepEqual(s.leftovers(), []);
  await s.updater.end();
});

test('github: cancel while waiting for the Host resumes it and keeps the bundle', async () => {
  const s = scenario('cancel-waiting', { vault: stored, hostMode: 'wait' });
  await publish();
  const offer = await s.updater.call('check');
  const install = s.updater.call('install', { offerId: offer.offerId });
  const settled = install.then(() => 'resolved', error => error.code);
  await until(() => s.hostLog().includes('start desktop-update wait'));
  assert.ok(s.offerEvents(offer.offerId).some(event => event.event === 'WaitingForHost'));
  assert.equal(await s.updater.call('close', { offerId: offer.offerId }), null);
  assert.equal(await settled, 'github_update_cancelled');
  await until(() => s.hostLog().includes('resumed'));
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.3');
  await until(() => s.leftovers().length === 0);
  assert.ok(!s.offerEvents(offer.offerId).some(event => event.event === 'Installing'));
  await s.updater.end();
});

test('github: a Host that cannot restart after replacement reports it and keeps the recovery backup', async () => {
  const s = scenario('finish-fails', { vault: stored, hostMode: 'finish-fail' });
  await publish();
  const offer = await s.updater.call('check');
  await assert.rejects(s.updater.call('install', { offerId: offer.offerId }), { code: 'github_update_installed_host_failed' });
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.4');
  const [backup] = s.leftovers();
  assert.match(backup, /^\.tarobot-update-[0-9a-f-]{36}$/);
  assert.equal(plistValue(path.join(s.applications, backup, 'previous.app'), 'CFBundleShortVersionString'), '1.2.3');
  // Bundles this updater moves or stages sit under `.noindex` parents.
  assert.deepEqual(readdirSync(path.join(s.applications, backup)).sort(), ['displaced.noindex', 'previous.app', 'staged.noindex']);
  assert.equal(plistValue(path.join(s.applications, backup, 'displaced.noindex/TaroBot.app'), 'CFBundleShortVersionString'), '1.2.3');
  assert.deepEqual(readdirSync(path.join(s.applications, backup, 'staged.noindex')), []);
  assert.ok(!existsSync(path.join(s.applications, backup, 'prepared.json')), 'a recovery backup must not be swept as abandoned');
  assert.deepEqual(s.hostLog(), ['start desktop-update finish-fail', 'ready', 'finish']);
  await s.updater.end();
});

test('github: an unwritable install location fails before the Host pauses', async () => {
  const s = scenario('read-only-location', { vault: stored });
  await publish();
  const offer = await s.updater.call('check');
  chmodSync(s.applications, 0o555);
  try {
    await assert.rejects(s.updater.call('install', { offerId: offer.offerId }), { code: 'github_update_permissions' });
  } finally { chmodSync(s.applications, 0o755); }
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.3');
  assert.deepEqual(s.hostLog(), []); assert.deepEqual(s.leftovers(), []);
  await s.updater.end();
});

test('github: closing stdin while the Host drains resumes it, keeps the bundle and exits cleanly', async () => {
  const s = scenario('eof-waiting', { vault: stored, hostMode: 'wait' });
  await publish();
  const offer = await s.updater.call('check');
  const settled = s.updater.call('install', { offerId: offer.offerId }).then(() => 'resolved', error => error.code);
  await until(() => s.hostLog().includes('start desktop-update wait'));
  assert.deepEqual(await s.updater.end(), { code: 0, signal: null });
  assert.equal(await Promise.race([settled, delay(100).then(() => 'no-reply')]), 'github_update_cancelled');
  await until(() => s.hostLog().includes('resumed'));
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.3');
  assert.deepEqual(s.leftovers(), []);
});

test('github: denial, refresh-token rotation and logout', async () => {
  githubLogin({ deny: true });
  const s = scenario('account');
  const start = await s.updater.call('login_start');
  let denied;
  for (let attempt = 0; attempt < 10 && !denied; attempt++) {
    try { const poll = await s.updater.call('login_poll', { flowId: start.flowId }); await delay((poll.interval ?? 1) * 1000); }
    catch (error) { denied = error.code; }
  }
  assert.equal(denied, 'github_update_denied');
  await assert.rejects(s.updater.call('login_poll', { flowId: start.flowId }), { code: 'github_update_cancelled' });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(s.vaultFile, JSON.stringify({ token: 'gho_expiring0001', login: 'lab-user', expires_at: now + 30, refresh_token: 'ghr_refresh00001', refresh_expires_at: now + 86400 }));
  net.json('POST', 'https://github.com/login/oauth/access_token', { access_token: 'gho_rotated00001', token_type: 'bearer', scope: 'repo', expires_in: 28800, refresh_token: 'ghr_rotated00001', refresh_token_expires_in: 15897600 });
  assert.equal((await s.updater.call('info')).authenticated, true);
  const rotated = JSON.parse(readFileSync(s.vaultFile, 'utf8'));
  assert.equal(rotated.token, 'gho_rotated00001'); assert.equal(rotated.refresh_token, 'ghr_rotated00001');
  const refresh = net.requests.filter(request => request.path === '/login/oauth/access_token').at(-1);
  assert.equal(JSON.parse(refresh.body).grant_type, 'refresh_token');
  assert.equal(await s.updater.call('logout'), null);
  assert.ok(!existsSync(s.vaultFile));
  assert.deepEqual(await s.updater.call('info'), { configured: true, version: '1.2.3', provider: 'github', authenticated: false });
  await assert.rejects(s.updater.call('check'), { code: 'github_update_login_required' });
  await s.updater.end();
});

test('default provider: public manifest, no credential, signed install; 204 means current', async () => {
  const endpoint = 'https://updates.example.test/{{target}}/{{arch}}/{{current_version}}/latest.json';
  const s = scenario('public', { github: false, endpoints: [endpoint] });
  const archive = archives.next.bytes;
  net.json('GET', 'https://updates.example.test/darwin/aarch64/1.2.3/latest.json', { version: '1.2.4', notes: 'Public notes',
    platforms: { 'darwin-aarch64': { url: 'https://objects.githubusercontent.com/lab/public.tar.gz', signature: signBytes(key, archive, { version: '1.2.4' }) } } });
  net.route('GET', 'https://objects.githubusercontent.com/lab/public.tar.gz', (_req, res) => { res.writeHead(200, { 'content-length': archive.length }); res.end(archive); });
  assert.deepEqual(await s.updater.call('info'), { configured: true, version: '1.2.3', provider: 'default', authenticated: false });
  await assert.rejects(s.updater.call('login_start'), { code: 'github_update_configuration' });
  const before = net.requests.length;
  const offer = await s.updater.call('check');
  assert.equal(offer.version, '1.2.4'); assert.equal(offer.body, 'Public notes');
  assert.equal(await s.updater.call('install', { offerId: offer.offerId }), null);
  assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.4');
  assert.ok(net.requests.slice(before).every(request => request.authorization === null));
  assert.deepEqual(s.hostLog(), ['start desktop-update ok', 'ready', 'finish']);
  net.route('GET', 'https://updates.example.test/darwin/aarch64/1.2.3/latest.json', (_req, res) => { res.writeHead(204); res.end(); });
  assert.equal(await s.updater.call('check'), null);
  await s.updater.end();
});

test('protocol: unknown methods and malformed IDs are refused without side effects', async () => {
  const s = scenario('protocol', { vault: stored });
  await assert.rejects(s.updater.call('restart_client'), { code: 'invalid_update_request' });
  await assert.rejects(s.updater.call('install', { offerId: '../../etc' }), { code: 'invalid_update_request' });
  await assert.rejects(s.updater.call('info', { extra: true }), { code: 'invalid_update_request' });
  assert.deepEqual(await s.updater.call('hello'), { protocol: 1, installSupported: true });
  await assert.rejects(s.updater.call('install', { offerId: 'not-an-offer' }), { code: 'github_update_invalid_offer' });
  s.updater.raw('x'.repeat(70 * 1024));
  assert.deepEqual(await s.updater.exited, { code: 0, signal: null });
});

test('Electron main: UpdaterProcess and DesktopUpdates drive the native updater end to end', async () => {
  const s = scenario('electron-main', { vault: stored, spawn: false });
  await publish();
  const saved = {};
  for (const [name, value] of Object.entries(s.env)) { saved[name] = process.env[name]; process.env[name] = value; }
  try {
    const updater = new UpdaterProcess(s.main);
    const sent = []; let relaunched = 0;
    const window = { isDestroyed: () => false, webContents: { send: (channel, value) => sent.push([channel, value]) } };
    const service = new DesktopUpdates(window, updater, { relaunch: () => { relaunched++; }, version: '1.2.3' });
    assert.deepEqual(await service.request('github_update_info', {}), { configured: true, version: '1.2.3', provider: 'github', authenticated: true, login: 'lab-user' });
    const offer = await service.request('github_update_check', {});
    assert.equal(offer.version, '1.2.4');
    const install = service.request('github_update_install', { offerId: offer.offerId });
    await until(() => updater.installing);
    await assert.rejects(service.request('restart_client', {}), /github_update_busy/);
    assert.equal(await install, null);
    const events = sent.filter(([channel, value]) => channel === DESKTOP_EVENT && value.name === 'github-update-progress' && value.payload.offerId === offer.offerId)
      .map(([, value]) => value.payload.event.event).filter(event => event !== 'Progress');
    assert.deepEqual(events, ['Started', 'WaitingForHost', 'Installing', 'RestartingHost', 'Finished']);
    assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.4');
    assert.equal(await service.request('restart_client', {}), null);
    assert.equal(relaunched, 1);
    updater.shutdown();
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('Electron main: verified replacement plus failed Host recovery fences helpers and exposes a restartable failure', async () => {
  const s = scenario('electron-main-host-failure', { vault: stored, hostMode: 'finish-fail', spawn: false });
  await publish();
  const saved = {};
  for (const [name, value] of Object.entries(s.env)) { saved[name] = process.env[name]; process.env[name] = value; }
  let updater;
  try {
    updater = new UpdaterProcess(s.main);
    let relaunched = 0;
    const window = { isDestroyed: () => false, webContents: { send() {} } };
    const service = new DesktopUpdates(window, updater, { relaunch: () => { relaunched++; }, version: '1.2.3' });
    const offer = await service.request('github_update_check', {});
    await assert.rejects(service.request('github_update_install', { offerId: offer.offerId }), /github_update_installed_host_failed/);
    assert.equal(plistValue(s.app, 'CFBundleShortVersionString'), '1.2.4');
    const [backup] = s.leftovers();
    assert.equal(plistValue(path.join(s.applications, backup, 'previous.app'), 'CFBundleShortVersionString'), '1.2.3');
    assert.equal(updater.restartRequired, true); assert.equal(updater.installing, false);
    assert.equal(relaunched, 0);
    await assert.rejects(service.request('github_update_check', {}), /github_update_busy/);
    await service.request('restart_client', {}); assert.equal(relaunched, 1);
  } finally {
    updater?.shutdown();
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
