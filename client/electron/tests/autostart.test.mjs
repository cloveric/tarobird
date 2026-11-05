import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  // The App moved: the old agent no longer starts it. Report off, allow repair.
  await writeFile(f.agent, tauriAgent('/Applications/Old Location/TaroBot.app/Contents/MacOS/tarocub-client'));
  assert.equal(await f.autostart.get(), false);
  await f.autostart.set(true);
  assert.equal(await f.autostart.get(), true);
  await writeFile(f.agent, tauriAgent('/elsewhere/tarocub-client'));
  await f.autostart.set(false);
  await assert.rejects(readFile(f.agent), { code: 'ENOENT' });
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
