import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopAutostart } from '../autostart.mjs';

const mac = process.platform === 'darwin';
const app = { getPath: () => { throw new Error('home must be injected'); } };
// tauri-plugin-autostart 2.7.0 → auto-launch 0.6.0 `build_launch_agent_plist`, byte for byte.
const tauriAgent = executable => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n  <key>Label</key>\n  <string>TaroBot</string>\n  <key>AssociatedBundleIdentifiers</key>\n  <array></array>\n  <key>ProgramArguments</key>\n  <array><string>${executable}</string></array>\n  <key>RunAtLoad</key>\n  <true/>\n  </dict>\n</plist>`;

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tarobot-autostart-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'TaroBot.app/Contents/MacOS'), executable = path.join(bundle, 'tarocub-client');
  await mkdir(bundle, { recursive: true }); await writeFile(executable, ''); await chmod(executable, 0o755);
  // Electron may report the launch path through a link; Tauri stored the canonical path.
  const alias = path.join(root, 'Applications-link');
  await symlink(path.join(root, 'TaroBot.app'), alias);
  const home = path.join(root, 'home'), agent = path.join(home, 'Library/LaunchAgents/TaroBot.plist');
  const autostart = new DesktopAutostart(app, { production: true, platform: 'darwin', executable: path.join(alias, 'Contents/MacOS/tarocub-client'), home });
  return { root, executable, home, agent, autostart };
}

test('development builds never touch login items', async () => {
  const autostart = new DesktopAutostart(app, { production: false, platform: 'win32', home: '/nonexistent' });
  assert.equal(await autostart.get(), false);
  await assert.rejects(autostart.set(true), /autostart_requires_installed_app/);
});

test('Windows uses the native auto-launch entry the Tauri plugin managed', async () => {
  const calls = [];
  const addon = { autostartEnabled: () => { calls.push('get'); return true; }, setAutostart: enabled => { calls.push(enabled); } };
  const autostart = new DesktopAutostart(app, { production: true, platform: 'win32', home: 'C:\\Users\\a', addon });
  assert.equal(await autostart.get(), true);
  await autostart.set(false); await autostart.set(true);
  assert.deepEqual(calls, ['get', false, true]);
  // Never fall back to Electron's login item API: another value name would duplicate the entry.
  const unwired = new DesktopAutostart({ ...app, setLoginItemSettings: () => assert.fail('wrong backend') }, { production: true, platform: 'win32', home: 'C:\\Users\\a' });
  await assert.rejects(unwired.get(), /autostart_unavailable/);
  await assert.rejects(unwired.set(true), /autostart_unavailable/);
});

test('Mac: an enabled Tauri agent is reported and can be turned off', { skip: !mac && 'plutil is macOS-only' }, async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.agent), { recursive: true });
  await writeFile(f.agent, tauriAgent(f.executable));
  assert.equal(await f.autostart.get(), true);
  await f.autostart.set(false);
  await assert.rejects(readFile(f.agent), { code: 'ENOENT' });
  assert.equal(await f.autostart.get(), false);
  await f.autostart.set(false);
});

test('Mac: enabling writes the canonical executable; a stale agent is repairable', { skip: !mac && 'plutil is macOS-only' }, async t => {
  const f = await fixture(t);
  await f.autostart.set(true);
  assert.match(await readFile(f.agent, 'utf8'), new RegExp(`<string>${f.executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
  assert.equal(await f.autostart.get(), true);
  // A missing old location is not this App's enabled entry. An existing older
  // product copy is repaired separately after installed primary-instance startup.
  await writeFile(f.agent, tauriAgent('/Applications/Old Location/TaroBot.app/Contents/MacOS/tarocub-client'));
  assert.equal(await f.autostart.get(), false);
  await f.autostart.set(true);
  assert.equal(await f.autostart.get(), true);
  await writeFile(f.agent, tauriAgent('/elsewhere/tarocub-client'));
  await f.autostart.set(false);
  await assert.rejects(readFile(f.agent), { code: 'ENOENT' });
});

async function repairFixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tarobird-login-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), installed = path.join(root, 'Applications');
  const makeBundle = async (where, version, id = 'com.tarobot.client') => {
    await mkdir(path.join(where, 'Contents/MacOS'), { recursive: true });
    await writeFile(path.join(where, 'Contents/MacOS/tarocub-client'), 'not an executable');
    await writeFile(path.join(where, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: id,
      CFBundleExecutable: 'tarocub-client', CFBundleShortVersionString: version }));
    return path.join(where, 'Contents/MacOS/tarocub-client');
  };
  const current = await makeBundle(path.join(options.temporary ? root : installed, 'TaroBird.app'), options.current ?? '1.2.1');
  const previous = await makeBundle(path.join(installed, 'TaroBot.app'), options.previous ?? '1.1.0', options.identity);
  const file = path.join(home, 'Library/LaunchAgents/TaroBot.plist');
  await mkdir(path.dirname(file), { recursive: true });
  const value = { Label: 'TaroBot', RunAtLoad: true, ProgramArguments: [previous],
    AssociatedBundleIdentifiers: [], ProcessType: 'Interactive', EnvironmentVariables: { TEST_OPTION: 'retain-me' }, ...options.agent };
  await writeFile(file, JSON.stringify(value));
  const autostart = new DesktopAutostart({ ...app, getVersion: () => options.current ?? '1.2.1' }, {
    home, production: options.production ?? true, platform: options.platform ?? 'darwin', executable: current, installationRoots: [installed] });
  const read = async () => JSON.parse((await promisify(execFile)('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file])).stdout);
  return { root, file, previous, current, value, autostart, read };
}

test('Mac: installed newer primary repairs only the old executable and preserves enabled preference', { skip: !mac }, async t => {
  const f = await repairFixture(t);
  assert.equal(await f.autostart.get(), false, 'baseline old entry does not start the current App');
  const repair = f.autostart.repairLegacy();
  assert.equal(await f.autostart.get(), true, 'settings wait for an in-flight repair');
  assert.equal(await repair, true);
  assert.deepEqual(await f.read(), { ...f.value, ProgramArguments: [f.current] });
  assert.equal(await f.autostart.get(), true);
  assert.equal(await f.autostart.repairLegacy(), false, 'idempotent');
});

for (const [name, options] of [
  ['equal version', { previous: '1.2.1' }], ['newer version', { previous: '1.10.0' }],
  ['ambiguous version', { previous: '1.1.0-beta' }], ['foreign product', { identity: 'example.other' }],
  ['user disabled', { agent: { RunAtLoad: false } }], ['launchd disabled flag', { agent: { Disabled: true } }],
  ['custom command', { agent: { Program: '/other/program' } }],
  ['arguments', { agent: { ProgramArguments: ['/old/program', '--custom'] } }],
  ['temporary app', { temporary: true }], ['development build', { production: false }], ['Windows', { platform: 'win32' }],
]) test(`Mac login repair leaves ${name} unchanged`, { skip: !mac }, async t => {
  const f = await repairFixture(t, options), before = await readFile(f.file);
  assert.equal(await f.autostart.repairLegacy(), false);
  assert.deepEqual(await readFile(f.file), before);
});

test('Mac: login repair compares version segments numerically', { skip: !mac }, async t => {
  const f = await repairFixture(t, { current: '1.10.0', previous: '1.9.9' });
  assert.equal(await f.autostart.repairLegacy(), true);
});

test('Mac: repairing an XML login item preserves native 64-bit fields exactly', { skip: !mac }, async t => {
  const f = await repairFixture(t), run = promisify(execFile);
  await run('/usr/bin/plutil', ['-convert', 'xml1', f.file]);
  await run('/usr/bin/plutil', ['-insert', 'CustomLargeInteger', '-integer', '9007199254740993', f.file]);
  assert.equal(await f.autostart.repairLegacy(), true);
  const value = (await run('/usr/bin/plutil', ['-extract', 'CustomLargeInteger', 'raw', '-o', '-', f.file])).stdout.trim();
  assert.equal(value, '9007199254740993');
});

test('Mac: removed old bundle and foreign or linked login items are never rewritten', { skip: !mac }, async t => {
  const f = await repairFixture(t), before = await readFile(f.file);
  await unlink(f.previous);
  assert.equal(await f.autostart.repairLegacy(), false);
  assert.deepEqual(await readFile(f.file), before);
  await writeFile(f.file, JSON.stringify({ ...f.value, Label: 'Other' }));
  await assert.rejects(f.autostart.repairLegacy(), /autostart_configuration_conflict/);
  await rm(f.file);
  const target = path.join(f.root, 'target.plist'); await writeFile(target, before); await symlink(target, f.file);
  await assert.rejects(f.autostart.repairLegacy(), /autostart_configuration_conflict/);
  assert.deepEqual(await readFile(target), before);
});

test('Mac: disabling during login repair wins and failed repair does not poison later settings', { skip: !mac }, async t => {
  const f = await repairFixture(t);
  const repair = f.autostart.repairLegacy(), disable = f.autostart.set(false);
  assert.equal(await repair, true); await disable;
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  assert.equal(await f.autostart.repairLegacy(), false);
  await writeFile(f.file, JSON.stringify({ ...f.value, Label: 'Other' }));
  await assert.rejects(f.autostart.repairLegacy(), /autostart_configuration_conflict/);
  await writeFile(f.file, JSON.stringify(f.value));
  await f.autostart.set(false);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
});

test('Mac: a foreign label or a link at the agent path is never read through or replaced', { skip: !mac && 'plutil is macOS-only' }, async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.agent), { recursive: true });
  const foreign = tauriAgent(f.executable).replace('<string>TaroBot</string>', '<string>com.example.other</string>');
  await writeFile(f.agent, foreign);
  await assert.rejects(f.autostart.get(), /autostart_configuration_conflict/);
  await assert.rejects(f.autostart.set(false), /autostart_configuration_conflict/);
  await assert.rejects(f.autostart.set(true), /autostart_configuration_conflict/);
  assert.equal(await readFile(f.agent, 'utf8'), foreign);
  await rm(f.agent);
  const target = path.join(f.root, 'target.plist');
  await writeFile(target, tauriAgent(f.executable)); await symlink(target, f.agent);
  await assert.rejects(f.autostart.set(false), /autostart_configuration_conflict/);
  assert.equal(await readFile(target, 'utf8'), tauriAgent(f.executable));
});
