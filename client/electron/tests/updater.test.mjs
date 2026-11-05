import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { DESKTOP_EVENT } from '../contract.mjs';
import { JsonLines } from '../helper-rpc.mjs';
import { DesktopUpdates, UPDATE_COMMANDS, UPDATE_EVENT, UpdaterProcess, updaterArguments } from '../updater.mjs';

const config = { executable: '/isolated/updater', configFile: '/isolated/update-config.json', appVersion: '1.2.3', appBundle: '/isolated/TaroBot.app',
  resourcesDir: '/isolated/host', hostStateDir: '/isolated/com.tarobot.client', workDir: '/isolated/updates' };

function fixture({ timeouts } = {}) {
  const children = [], requests = [];
  const spawnProcess = (file, args, options) => {
    assert.equal(file, config.executable); assert.deepEqual(args, updaterArguments(config));
    assert.equal(options.shell, false); assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
    assert.ok(!('NODE_OPTIONS' in options.env) && !('ELECTRON_RUN_AS_NODE' in options.env));
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), killed: false, kill() { this.killed = true; } });
    const input = new JsonLines(value => requests.push(value));
    child.stdin.on('data', data => input.push(data));
    children.push(child);
    return child;
  };
  const updater = new UpdaterProcess(config, { spawnProcess, exists: () => true, ...(timeouts ? { timeouts } : {}) });
  const sent = [];
  const window = { isDestroyed: () => false, webContents: { send: (channel, value) => sent.push([channel, value]) } };
  let relaunched = 0, quits = 0;
  const service = new DesktopUpdates(window, updater, { relaunch: () => { relaunched++; }, quit: () => { quits++; }, version: '1.2.3' });
  const reply = (value, child = children.at(-1)) => child.stdout.write(`${JSON.stringify(value)}\n`);
  return { updater, service, children, requests, sent, reply, relaunched: () => relaunched, quits: () => quits };
}
const settle = () => delay(5);

test('commands keep the Tauri names and map to fixed native methods with only opaque IDs', async () => {
  const f = fixture();
  assert.deepEqual([...UPDATE_COMMANDS].sort(), ['github_update_check', 'github_update_close', 'github_update_info', 'github_update_install',
    'github_update_login_cancel', 'github_update_login_poll', 'github_update_login_start', 'github_update_logout', 'restart_client']);
  const poll = f.service.request('github_update_login_poll', { flowId: 'flow-1' });
  await settle();
  assert.deepEqual(f.requests.at(-1), { id: 1, method: 'login_poll', params: { flowId: 'flow-1' } });
  f.reply({ id: 1, result: { status: 'pending', interval: 5 } });
  assert.deepEqual(await poll, { status: 'pending', interval: 5 });
  for (const [command, input] of [['github_update_install', { offerId: '../x' }], ['github_update_install', {}], ['github_update_check', { force: true }],
    ['github_update_login_poll', { flowId: 'a'.repeat(65) }], ['github_update_unknown', {}]]) {
    await assert.rejects(f.service.request(command, input), /invalid_update_request/);
  }
  assert.equal(f.children.length, 1, 'one updater process per App');
});

test('install progress reaches only the starting document, and malformed native output closes the updater', async () => {
  const f = fixture();
  let active = true;
  const install = f.service.request('github_update_install', { offerId: 'offer-1' }, () => active);
  await settle();
  f.reply({ event: 'progress', offerId: 'offer-1', data: { event: 'Started', data: { contentLength: 10 } } });
  f.reply({ event: 'progress', offerId: 'offer-2', data: { event: 'Finished' } });
  f.reply({ event: 'progress', offerId: 'offer-1', data: { event: 'Progress', data: { chunkLength: 10 } } });
  await settle();
  active = false;
  f.reply({ event: 'progress', offerId: 'offer-1', data: { event: 'WaitingForHost' } });
  await settle();
  assert.deepEqual(f.sent, [
    [DESKTOP_EVENT, { name: UPDATE_EVENT, payload: { offerId: 'offer-1', event: { event: 'Started', data: { contentLength: 10 } } } }],
    [DESKTOP_EVENT, { name: UPDATE_EVENT, payload: { offerId: 'offer-1', event: { event: 'Progress', data: { chunkLength: 10 } } } }],
  ]);
  // Restart is refused while the bundle may be mid-replacement.
  await assert.rejects(f.service.request('restart_client', {}), /github_update_busy/);
  assert.equal(f.relaunched(), 0);
  f.reply({ event: 'progress', offerId: 'offer-1', data: { event: 'Progress', data: { chunkLength: -1 } } });
  await assert.rejects(install, /github_update_recovery/);
  // A process exit does not prove rollback. Retain the no-restart fence.
  assert.equal(f.children[0].killed, false);
  assert.equal(f.updater.installing, true);
  await assert.rejects(f.service.request('restart_client', {}), /github_update_recovery/);
  await assert.rejects(f.service.request('github_update_check', {}), /github_update_recovery/);
  assert.equal(f.children.length, 1);
  f.children[0].emit('close', 0);
  assert.equal(f.updater.installing, false);
  await assert.rejects(f.service.request('restart_client', {}), /github_update_recovery/);
  await assert.rejects(f.service.request('github_update_info', {}), /github_update_recovery/);
  assert.equal(f.relaunched(), 0); assert.equal(f.children.length, 1);
});

test('calls are bounded: queue limit, pipe limit and timeouts that never kill', async () => {
  const f = fixture({ timeouts: { check: 20, info: 1000 } });
  const calls = Array.from({ length: 16 }, () => f.updater.call('info').catch(error => error.message));
  await assert.rejects(f.updater.call('info'), /github_update_busy/);
  await settle();
  for (const request of f.requests) f.reply({ id: request.id, result: null });
  assert.deepEqual(await Promise.all(calls), Array(16).fill(null));
  // A timed-out call fails explicitly; its late reply is consumed.
  const slow = f.updater.call('check');
  await assert.rejects(slow, /github_update_failed/);
  f.reply({ id: f.requests.at(-1).id, result: { offerId: 'late', version: '9.9.9' } });
  await settle();
  assert.equal(f.children[0].killed, false);
  assert.equal((await Promise.all([f.updater.call('info'), (async () => { await settle(); f.reply({ id: f.requests.at(-1).id, result: 'ok' }); })()]))[0], 'ok');
  // Install has no main-side timeout, whatever the configured bounds.
  const installer = fixture();
  const install = installer.updater.install('offer-1', () => {});
  await delay(40);
  installer.reply({ id: installer.requests.at(-1).id, result: null });
  assert.equal(await install, null);
  // Too many unanswered calls: stop trusting the process, without killing it.
  const stuck = Array.from({ length: 16 }, () => f.updater.call('check').catch(error => error.message));
  assert.deepEqual(await Promise.all(stuck), Array(16).fill('github_update_failed'));
  await assert.rejects(f.updater.call('check'), /github_update_failed/);
  await settle();
  assert.equal(f.children[0].killed, false);
  await assert.rejects(f.updater.call('info'), /github_update_busy/);
  f.children[0].emit('close', 0);
  const pipe = fixture();
  pipe.updater.call('info').catch(() => {});
  await settle();
  Object.defineProperty(pipe.children[0].stdin, 'writableLength', { value: 64 * 1024 });
  await assert.rejects(pipe.updater.call('info'), /github_update_busy/);
});

test('native error codes pass through; anything else becomes a generic failure', async () => {
  const f = fixture();
  const first = f.service.request('github_update_check', {});
  const second = f.service.request('github_update_logout', {});
  await settle();
  f.reply({ id: 2, error: 'github_update_keychain' });
  f.reply({ id: 1, error: 'Keychain item /Users/x failed: secret=abc' });
  await assert.rejects(second, error => error.message === 'github_update_keychain');
  await assert.rejects(first, error => error.message === 'github_update_failed');
});

test('a crashed updater fails pending calls and the next call starts a fresh one', async () => {
  const f = fixture();
  const pending = f.service.request('github_update_info', {});
  await settle();
  f.children[0].emit('close', 1);
  await assert.rejects(pending, /github_update_failed/);
  const next = f.service.request('github_update_info', {});
  await settle();
  assert.equal(f.children.length, 2);
  f.reply({ id: 2, result: { configured: true, version: '1.2.3', provider: 'github', authenticated: false } });
  assert.equal((await next).provider, 'github');
});

test('shutdown only closes stdin: the native updater finishes or cancels on its own', async () => {
  const f = fixture();
  const install = f.service.request('github_update_install', { offerId: 'offer-1' });
  await settle();
  let ended = false; f.children[0].stdin.on('finish', () => { ended = true; });
  f.updater.shutdown();
  await assert.rejects(install, /github_update_recovery/);
  await settle();
  assert.equal(ended, true); assert.equal(f.children[0].killed, false);
});

test('development builds without the binary or config report an unconfigured updater', async () => {
  const updater = new UpdaterProcess(config, { exists: path => path !== config.configFile, spawnProcess: () => assert.fail('must not spawn') });
  const service = new DesktopUpdates({ isDestroyed: () => false, webContents: { send() {} } }, updater, { relaunch() {}, version: '1.2.3' });
  assert.deepEqual(await service.request('github_update_info', {}), { configured: false, version: '1.2.3', provider: 'default', authenticated: false });
  await assert.rejects(service.request('github_update_check', {}), /github_update_configuration/);
  assert.throws(() => updaterArguments({ ...config, appVersion: '1.2.3-beta' }), /invalid_updater_configuration/);
  assert.throws(() => updaterArguments({ ...config, workDir: 'relative' }), /invalid_updater_configuration/);
});

test('a retired document cannot start update work', async () => {
  const f = fixture();
  await assert.rejects(f.service.request('github_update_check', {}, () => false), /native_document_retired/);
  assert.equal(f.children.length, 0);
});

test('Windows handoff: install quits the App for the installer and restart never relaunches over it', async () => {
  const f = fixture();
  const install = f.service.request('github_update_install', { offerId: 'offer-1' });
  await settle();
  f.reply({ id: 1, result: { quit: true } });
  assert.equal(await install, null, 'the renderer keeps the Tauri-shaped reply');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.quits(), 1);
  assert.equal(f.updater.handoff, true);
  await f.service.request('restart_client', {});
  assert.equal(f.relaunched(), 0); assert.equal(f.quits(), 2);
  // Any other install result shape is a protocol failure, not a handoff.
  const other = fixture();
  const bad = other.service.request('github_update_install', { offerId: 'offer-2' });
  await settle();
  other.reply({ id: 1, result: { quit: 'yes' } });
  await assert.rejects(bad, /github_update_recovery/);
  assert.equal(other.updater.handoff, false); assert.equal(other.quits(), 0);
});


test('a failed read-only updater never blocks quitting, but cannot be replaced until it exits', async () => {
  const f = fixture();
  const pending = f.service.request('github_update_check', {});
  await settle(); f.children[0].stdout.write('invalid json\n');
  await assert.rejects(pending, /github_update_failed/);
  assert.equal(f.updater.installing, false);
  await f.service.request('restart_client', {}); assert.equal(f.relaunched(), 1);
  await assert.rejects(f.service.request('github_update_info', {}), /github_update_busy/);
  assert.equal(f.children.length, 1); assert.equal(f.children[0].killed, false);
});

test('Mac replacement automatically requests restart and never starts a second updater against the new bundle', async () => {
  const f = fixture();
  const install = f.service.request('github_update_install', { offerId: 'offer-1' });
  await settle(); f.reply({ id: 1, result: null });
  assert.equal(await install, null); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.relaunched(), 1); assert.equal(f.quits(), 0);
  assert.equal(f.updater.restartRequired, true); assert.equal(f.updater.installing, false);
  f.children[0].emit('close', 0);
  await assert.rejects(f.service.request('github_update_check', {}), /github_update_busy/);
  assert.equal(f.children.length, 1);
});


test('a replaced Mac bundle whose Host recovery fails requires restart without retrying or silently relaunching', async () => {
  const f = fixture();
  const install = f.service.request('github_update_install', { offerId: 'offer-1' });
  await settle(); f.reply({ id: 1, error: 'github_update_installed_host_failed' });
  await assert.rejects(install, /github_update_installed_host_failed/);
  assert.equal(f.updater.restartRequired, true); assert.equal(f.updater.installing, false);
  assert.equal(f.relaunched(), 0, 'surface the Host recovery failure before restarting');
  f.children[0].emit('close', 0);
  await assert.rejects(f.service.request('github_update_check', {}), /github_update_busy/);
  assert.equal(f.children.length, 1, 'old main cannot launch a new updater from the replaced bundle');
  await f.service.request('restart_client', {}); assert.equal(f.relaunched(), 1);
});


test('failed restoration blocks retry, relaunch and new native helpers for the rest of this App process', async () => {
  const f = fixture();
  const install = f.service.request('github_update_install', { offerId: 'offer-1' });
  await settle(); f.reply({ id: 1, error: 'github_update_recovery' });
  await assert.rejects(install, /github_update_recovery/);
  assert.equal(f.updater.recoveryRequired, true);
  assert.equal(f.updater.restartRequired, false);
  for (const command of ['github_update_info', 'github_update_check', 'github_update_logout', 'restart_client'])
    await assert.rejects(f.service.request(command, {}), /github_update_recovery/);
  assert.throws(() => f.updater.guardRuntime(() => assert.fail('must not relaunch')), /github_update_recovery/);
  f.children[0].emit('close', 0);
  await assert.rejects(f.service.request('github_update_check', {}), /github_update_recovery/);
  assert.equal(f.children.length, 1); assert.equal(f.relaunched(), 0);
});

for (const lost of ['exit', 'protocol', 'stdout', 'invalid-error']) test(`lost install result (${lost}) stays fenced after the updater exits`, { timeout: 1500 }, async () => {
  const f = fixture();
  const install = f.service.request('github_update_install', { offerId: 'offer-1' });
  await settle();
  f.reply({ event: 'progress', offerId: 'offer-1', data: { event: 'Installing' } });
  if (lost === 'exit') f.children[0].emit('close', 1);
  if (lost === 'protocol') f.children[0].stdout.write('invalid JSON\n');
  if (lost === 'stdout') f.children[0].stdout.end();
  if (lost === 'invalid-error') f.reply({ id: 1, error: { message: 'unknown result' } });
  await assert.rejects(install, /github_update_recovery/);
  f.children[0].emit('close', 1);
  assert.equal(f.updater.recoveryRequired, true);
  assert.equal(f.updater.installing, false);
  await assert.rejects(f.service.request('restart_client', {}), /github_update_recovery/);
  await assert.rejects(f.service.request('github_update_check', {}), /github_update_recovery/);
  assert.throws(() => f.updater.guardRuntime(() => assert.fail('must not relaunch')), /github_update_recovery/);
  assert.equal(f.children[0].killed, false); assert.equal(f.children.length, 1);
});

test('new helpers cannot start during replacement or pending Windows handoff', async () => {
  const f = fixture();
  const install = f.service.request('github_update_install', { offerId: 'offer-1' });
  await settle();
  assert.throws(() => f.updater.guardRuntime(), /github_update_busy/);
  f.reply({ id: 1, result: { quit: true } }); await install;
  assert.throws(() => f.updater.guardRuntime(), /github_update_busy/);
  await assert.rejects(f.service.request('github_update_check', {}), /github_update_busy/);
});

test('an active install rejects competing work but preserves native cancellation', async () => {
  const f = fixture();
  const install = f.updater.install('offer-1', () => {});
  await settle();
  for (const method of ['info', 'check', 'logout', 'install']) await assert.rejects(f.updater.call(method), /github_update_busy/);
  const close = f.updater.call('close', { offerId: 'offer-1' });
  await settle();
  assert.deepEqual(f.requests.map(request => request.method), ['install', 'close']);
  f.reply({ id: 2, result: null }); await close;
  f.reply({ id: 1, error: 'github_update_cancelled' });
  await assert.rejects(install, /github_update_cancelled/);
  assert.equal(f.updater.recoveryRequired, false);
});

test('passive Host recovery can refuse a replaced runtime without requesting an App restart', async () => {
  const f = fixture();
  const install = f.updater.install('offer-1', () => {});
  await settle(); f.reply({ id: 1, error: 'github_update_installed_host_failed' });
  await assert.rejects(install, /github_update_installed_host_failed/);
  assert.throws(() => f.updater.guardRuntime(), /desktop_restart_required/);
  assert.equal(f.relaunched(), 0);
  await f.service.request('restart_client', {});
  assert.equal(f.relaunched(), 1);
});


for (const error of ['github_update_cancelled', 'github_update_signature', 'github_update_install']) test(`explicit native ${error} followed by exit remains safely retryable`, async () => {
  const f = fixture();
  const install = f.service.request('github_update_install', { offerId: 'offer-1' });
  await settle(); f.reply({ id: 1, error }); f.children[0].emit('close', 0);
  await assert.rejects(install, new RegExp(error));
  assert.equal(f.updater.recoveryRequired, false);
  assert.equal(f.updater.restartRequired, false);
  const retry = f.service.request('github_update_info', {});
  await settle(); f.reply({ id: 2, result: { configured: true } });
  assert.equal((await retry).configured, true); assert.equal(f.children.length, 2);
});

test('only a valid active install stops screen resources before the updater can replace files', async () => {
  const calls = [], updater = { available: true, call: async () => null, install: async () => { calls.push('install'); throw new Error('cancelled'); } };
  const service = new DesktopUpdates({ isDestroyed: () => false }, updater, { version: '1', beforeInstall: () => calls.push('stop-screen') });
  await service.request('github_update_info', {});
  await assert.rejects(service.request('github_update_install', {}), /invalid_update_request/);
  await assert.rejects(service.request('github_update_install', { offerId: 'offer-1' }, () => false), /native_document_retired/);
  assert.deepEqual(calls, []);
  await assert.rejects(service.request('github_update_install', { offerId: 'offer-1' }), /cancelled/);
  assert.deepEqual(calls, ['stop-screen', 'install']);
});

test('install awaits editor preparation, blocks concurrent work, and cancels before replacement', async () => {
  let ready, installs = 0; const finished = [];
  const updater = { call: async () => null, install: async () => { installs++; return null; } };
  const service = new DesktopUpdates({ isDestroyed: () => false }, updater, {
    version: '1', beforeInstall: () => new Promise(resolve => { ready = resolve; }), afterInstall: value => finished.push(value), relaunch: () => {},
  });
  const install = service.request('github_update_install', { offerId: 'one' });
  assert.equal(service.preparing, true); assert.equal(installs, 0);
  await assert.rejects(service.request('restart_client', {}), /github_update_busy/);
  await assert.rejects(service.request('github_update_install', { offerId: 'two' }), /github_update_busy/);
  await service.request('github_update_close', { offerId: 'one' }); ready();
  await assert.rejects(install, /github_update_cancelled/);
  assert.equal(installs, 0); assert.equal(service.preparing, false); assert.deepEqual(finished, [false]);
  const retry = service.request('github_update_install', { offerId: 'two' }); ready(); await retry;
  assert.equal(installs, 1); assert.deepEqual(finished, [false, true]); await settle();
});
test('failed editor preparation or a retired document has no installer side effects', async () => {
  let finish, active = true; const calls = [];
  const service = new DesktopUpdates({ isDestroyed: () => false }, { install: async () => calls.push('install') }, {
    version: '1', beforeInstall: async () => { throw Error('design_not_saved'); }, afterInstall: value => calls.push(value),
  });
  await assert.rejects(service.request('github_update_install', { offerId: 'one' }), /design_not_saved/);assert.deepEqual(calls, [false]);
  service.beforeInstall = () => new Promise(resolve => { finish = resolve; });
  const pending = service.request('github_update_install', { offerId: 'two' }, () => active);active = false;finish();
  await assert.rejects(pending, /native_document_retired/);assert.deepEqual(calls, [false, false]);
});
