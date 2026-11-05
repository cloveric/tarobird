// Orchestration and verdict logic of windows-acceptance.mjs against a
// simulated Windows. This proves the script's decisions, not Windows itself.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { AUMID, EXE, hostState, LOCATION_KEY, PROTOCOL_KEY, registryScript, RUN_KEY, runAcceptance, UNINSTALL_KEY, windowsSystem } from './windows-acceptance.mjs';

const W = path.win32;
const APPDATA = 'C:\\Users\\lab\\AppData\\Roaming', LOCAL = 'C:\\Users\\lab\\AppData\\Local', INSTALL = `${LOCAL}\\TaroBot`;
const START = `${APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs\\TaroBot.lnk`;
const STATE = `${LOCAL}\\com.tarobot.client`, MARKER = `${STATE}\\electron-profile\\tarobot-desktop-profile-v1.json`;
const EXPORT = '6f1c2a54-9a3e-4c1b-8f0e-2d7b5e4a9c10', HOST_STATE = `${APPDATA}\\com.tarobot.client\\host`;
const SETUP = 'C:\\in\\TaroBot_1.2.3_x64-setup.exe', NEXT = 'C:\\in\\TaroBot_1.2.4_x64-setup.exe', LEGACY = 'C:\\in\\legacy-setup.exe';

/** A small model of what the installers and the App do; `faults` breaks one behaviour. */
function windows({ faults = new Set(), existing = false, host = false, displayName = 'TaroBird' } = {}) {
  const files = new Map(), keys = new Map(), procs = new Map(), calls = [];
  let nextPid = 100;
  const put = (key, name, data) => keys.set(key, { ...keys.get(key), [name]: data });
  // A directory exists when anything was created below it, as on a real disk.
  const has = file => { const key = file.toLowerCase(); return files.has(key) || [...files.keys()].some(item => item.startsWith(`${key}\\`)); };
  const add = (file, content = '') => files.set(file.toLowerCase(), content);
  const drop = prefix => [...files.keys()].filter(file => file.startsWith(prefix.toLowerCase())).forEach(file => files.delete(file));
  const run = (image, file, parent = 0, command = file) => { const pid = nextPid++; procs.set(pid, { pid, parent, image, path: file, created: `2026-10-30T00:00:${pid}Z`, command }); return pid; };
  const exe = W.join(INSTALL, EXE);
  const startHost = (parent, runtime) => run('node.exe', W.join(runtime, 'node.exe'), parent,
    `"${W.join(runtime, 'node.exe')}" ${W.join(runtime, 'dist\\src\\index.js')} hub run --state-dir ${faults.has('host-state') && runtime.includes('resources') ? `${APPDATA}\\com.tarobot.client\\other` : HOST_STATE}`);
  const stopHosts = () => [...procs.values()].filter(item => item.image === 'node.exe').forEach(item => procs.delete(item.pid));
  const electron = version => {
    stopHosts();
    if (!faults.has('legacy-host')) drop(`${INSTALL}\\host\\`);
    for (const file of [EXE, 'tarobot-installer-helper.exe', 'uninstall.exe', 'resources\\app.asar', 'resources\\native\\tarobot-desktop-updater.exe', 'resources\\native\\tarobot-desktop-core.exe',
      'resources\\native\\tarobot-migration-exporter.exe', 'resources\\native\\tarobot-desktop-native.node', 'resources\\host\\node.exe', 'resources\\host\\dist\\src\\index.js']) add(W.join(INSTALL, file));
    put(UNINSTALL_KEY, 'DisplayName', displayName); put(UNINSTALL_KEY, 'MainBinaryName', EXE); put(UNINSTALL_KEY, 'DisplayVersion', version);
    put(UNINSTALL_KEY, 'InstallLocation', `"${INSTALL}"`); put(LOCATION_KEY, '(Default)', INSTALL);
    put(PROTOCOL_KEY, '(Default)', `"${exe}" "%1"`);
    add(START);
    if (!faults.has('receipt')) add(W.join(INSTALL, 'tarocub-notification-shortcut.json'), JSON.stringify(START));
  };
  if (existing) put(UNINSTALL_KEY, 'DisplayName', 'TaroBot');
  const sys = {
    platform: 'win32', env: { TAROBOT_WINDOWS_ACCEPTANCE: 'disposable', APPDATA, LOCALAPPDATA: LOCAL }, calls, files,
    exists: has, sleep: async () => {},
    probe: file => faults.has('unreadable') && file.startsWith(APPDATA) ? 'error' : has(file) ? 'present' : 'absent',
    readFile: async file => { if (!files.has(file.toLowerCase())) throw new Error('ENOENT'); return files.get(file.toLowerCase()); },
    launch: file => {
      calls.push(['launch', file]);
      const pid = run(EXE, file);
      if (!has(W.join(INSTALL, 'resources\\app.asar'))) {
        // The Tauri App: WebView2 data, and a configured Host when the lab has one.
        add(`${STATE}\\EBWebView\\Default\\Preferences`);
        if (host) startHost(pid, W.join(INSTALL, 'host'));
        return pid;
      }
      run(EXE, file, pid); // a Chromium child of the same executable
      if (faults.has('stuck-child')) run(EXE, file, pid);
      if (!has(MARKER)) {
        if (has(`${STATE}\\EBWebView`)) {
          add(`${STATE}\\desktop-migration\\exports\\.keep`); // prepare creates the folder even when it fails
          if (faults.has('migration')) add(MARKER, JSON.stringify({ version: 1, mode: 'fresh' }));
          else {
            add(MARKER, JSON.stringify({ version: 1, mode: 'imported', exportId: EXPORT }));
            if (!faults.has('import-receipt')) add(`${STATE}\\desktop-migration\\receipts\\${EXPORT}.json`, JSON.stringify({ version: 1, exportId: EXPORT, installation: 'i', records: 9, target: 'electron' }));
          }
        } else add(MARKER, JSON.stringify({ version: 1, mode: 'fresh' }));
      } else if (faults.has('profile-reset')) add(MARKER, JSON.stringify({ version: 1, mode: 'fresh' }));
      if (host && ![...procs.values()].some(item => item.image === 'node.exe')) startHost(pid, W.join(INSTALL, 'resources\\host'));
      return pid;
    },
    powershell: async script => {
      const reg = /Registry\]::(CurrentUser|LocalMachine)\.OpenSubKey\('([^']+)'\)/.exec(script);
      if (reg) {
        const key = `${reg[1] === 'CurrentUser' ? 'HKCU' : 'HKLM'}\\${reg[2].replaceAll("''", "'")}`;
        calls.push(['registry', key]);
        if (faults.has('registry') && key === UNINSTALL_KEY) return { code: 0, stdout: '{"state":"error"}\r\n' };
        const values = keys.get(key);
        return { code: 0, stdout: `${values ? JSON.stringify({ state: 'present', values }) : '{"state":"absent"}'}\r\n` };
      }
      const image = script.includes('Win32_Process') && /Name='([^']+)'/.exec(script)?.[1];
      if (image) {
        if (faults.has('processes')) return { code: 0, stdout: 'ERROR\r\n' };
        return { code: 0, stdout: `${JSON.stringify([...procs.values()].filter(item => item.image === image).map(({ image: _, ...rest }) => rest))}\r\n` };
      }
      if (script.includes('CreateShortcut')) return { code: 0, stdout: `${exe}\r\n` };
      if (script.includes('Get-StartApps')) return { code: 0, stdout: faults.has('aumid') ? '' : `${AUMID}\r\n` };
      return { code: 1, stdout: '', stderr: 'unexpected script' };
    },
    run: async (file, args, { env } = {}) => {
      calls.push([file, ...args]);
      if (file === 'reg.exe' && args[0] === 'add') { put(args[1], args[3], args[7]); return { code: 0, stdout: '' }; }
      if (file === 'reg.exe' && args[0] === 'delete') { const { [args[3]]: _, ...rest } = keys.get(args[1]) ?? {}; keys.set(args[1], rest); return { code: 0, stdout: '' }; }
      if (file === 'taskkill.exe') {
        assert.equal(args[0], '/PID', 'never by image name');
        const pid = Number(args[1]);
        procs.delete(pid);
        // Chromium children exit with their main process; the Host does not.
        if (!faults.has('stuck-child')) [...procs.values()].filter(item => item.parent === pid && item.image === EXE).forEach(item => procs.delete(item.pid));
        else faults.delete('stuck-child');
        return { code: 0, stdout: '' };
      }
      if (file === LEGACY) {
        if (faults.has('foreign')) run(EXE, 'C:\\Other\\TaroBot\\tarocub-client.exe');
        for (const item of [EXE, 'uninstall.exe', 'host\\node.exe', 'host\\dist\\src\\index.js']) add(W.join(INSTALL, item));
        put(UNINSTALL_KEY, 'DisplayName', 'TaroBot'); put(UNINSTALL_KEY, 'MainBinaryName', EXE); put(UNINSTALL_KEY, 'DisplayVersion', '1.0.98'); put(LOCATION_KEY, '(Default)', INSTALL);
        return { code: 0, stdout: '' };
      }
      if (file.endsWith('_x64-setup.exe')) { electron(/_(\d+\.\d+\.\d+)_/.exec(file)[1]); return { code: 0, stdout: '' }; }
      if (file.endsWith('uninstall.exe')) {
        drop(`${INSTALL}\\`); files.delete(START.toLowerCase()); keys.delete(UNINSTALL_KEY); keys.delete(PROTOCOL_KEY); keys.delete(LOCATION_KEY);
        // The template removes a login item only when it starts this installation.
        const item = keys.get(RUN_KEY)?.TaroBot?.trim().replace(/^"(.*)"$/, '$1');
        if (!faults.has('login-item-left') && (faults.has('login-item-any') || item?.toLowerCase() === exe.toLowerCase())) { const { TaroBot: _, ...rest } = keys.get(RUN_KEY); keys.set(RUN_KEY, rest); }
        return { code: faults.has('uninstall') ? 2 : 0, stdout: '' };
      }
      if (file === 'cmdkey.exe') {
        const stored = host && (has(W.join(INSTALL, 'host')) || has(W.join(INSTALL, 'resources')));
        const lost = faults.has('credentials') && has(W.join(INSTALL, 'resources\\app.asar'));
        return { code: 0, stdout: stored && !lost ? '\r\n    Target: LegacyGeneric:target=device_abc.com.tarobot.client.device\r\n    Type: Generic\r\n    Target: LegacyGeneric:target=unrelated\r\n' : '' };
      }
      if (file === 'cargo') {
        sys.cargoEnv = env;
        if (faults.has('crt-skipped') || env?.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS !== '-C target-feature=+crt-static' || env?.RUSTFLAGS !== undefined) {
          return { code: 0, stdout: 'test result: ok. 3 passed; 0 failed\ntest result: ok. 2 passed; 0 failed\ntest result: ok. 3 passed; 0 failed\n', stderr: 'skipped: this test build was not compiled with +crt-static\n' };
        }
      }
      if (file === 'cargo') return { code: 0, stdout: faults.has('compiled-out')
        ? 'test result: ok. 0 passed; 0 failed\ntest result: ok. 0 passed; 0 failed\ntest result: ok. 0 passed; 0 failed\n'
        : 'test staged_helper ... ok\ntest result: ok. 3 passed; 0 failed\ntest result: ok. 2 passed; 0 failed\ntest result: ok. 2 passed; 0 failed\n' };
      return { code: 1, stdout: '', stderr: `unexpected ${file}` };
    },
  };
  sys.state = { files, keys, procs };
  return sys;
}
const statuses = report => Object.fromEntries(report.checks.map(check => [`${check.phase}/${check.id}`, check.status]));
const detail = (report, id) => report.checks.find(check => `${check.phase}/${check.id}` === id)?.detail;
const full = sys => ({ installer: SETUP, legacyInstaller: LEGACY, nextInstaller: NEXT, version: '1.2.3', nextVersion: '1.2.4', nativeTests: 'C:\\src\\updater', confirmed: true });
const withCargo = sys => ({ ...sys, exists: file => file.endsWith('Cargo.toml') || sys.exists(file) });

test('the registry query reads one key through .NET and quotes it for PowerShell', () => {
  const script = registryScript("HKCU\\Software\\it's");
  assert.match(script, /\[Microsoft\.Win32\.Registry\]::CurrentUser\.OpenSubKey\('Software\\it''s'\)/);
  assert.match(script, /if \(\$null -eq \$key\) \{ '\{"state":"absent"\}'/);
  assert.match(script, /catch \{ '\{"state":"error"\}'/);
  assert.throws(() => registryScript('HKEY_USERS\\x'));
  assert.equal(hostState('"C:\\h\\node.exe" C:\\h\\dist\\src\\index.js hub run --state-dir "C:\\Users\\A B\\AppData\\Roaming\\com.tarobot.client\\host"'), 'c:\\users\\a b\\appdata\\roaming\\com.tarobot.client\\host');
  assert.equal(hostState('node index.js desktop-host start C:\\x'), undefined);
});

test('refuses anything but a confirmed, empty, readable disposable profile — and never installs then', async () => {
  for (const [sys, confirmed, reason] of [[{ ...windows(), platform: 'darwin' }, true, /Windows is required/], [windows(), false, /TAROBOT_WINDOWS_ACCEPTANCE/],
    [windows({ existing: true }), true, /an installation exists/], [windows({ faults: new Set(['registry']) }), true, /cannot read HKCU.*Uninstall/],
    [windows({ faults: new Set(['processes']) }), true, /cannot list tarocub-client\.exe/], [windows({ faults: new Set(['unreadable']) }), true, /cannot inspect/]]) {
    const { report } = await runAcceptance({ installer: SETUP, confirmed }, sys);
    assert.equal(report.outcome, 'fail');
    assert.match(report.checks.filter(check => check.status === 'fail').map(check => check.detail).join('\n'), reason);
    assert.ok(!sys.calls.some(call => String(call[0]).endsWith('setup.exe')), 'no installer may run');
  }
});

test('a fresh install passes only its own scope; unexercised paths make the default run incomplete', async () => {
  const scoped = windows();
  const { report } = await runAcceptance({ installer: SETUP, version: '1.2.3', confirmed: true, scopes: ['install'] }, scoped);
  assert.equal(report.outcome, 'pass', JSON.stringify(report.checks.filter(c => c.status === 'fail')));
  const status = statuses(report);
  for (const id of ['install/uninstall-key', 'install/notification-receipt', 'install/notification-aumid', 'install/deep-link', 'install/host-runtime',
    'first-launch/app-running', 'first-launch/profile-marker', 'first-launch/stop-own-processes', 'uninstall/program-removed', 'uninstall/uninstall-key-removed', 'uninstall/data-retained']) {
    assert.equal(status[id], 'pass', id);
  }
  assert.match(detail(report, 'first-launch/profile-marker'), /"mode":"fresh"/);
  assert.equal(status['uninstall/login-item-foreign-kept'], 'pass');
  assert.equal(status['uninstall/foreign-login-item-cleanup'], 'pass');
  assert.equal(scoped.state.keys.get(RUN_KEY)?.TaroBot, undefined, 'the suite removed the value it wrote');
  assert.ok(scoped.calls.some(call => call[0] === SETUP && call[1] === '/S'));

  const { report: all, meta } = await runAcceptance({ installer: SETUP, version: '1.2.3', confirmed: true }, windows());
  assert.equal(all.outcome, 'incomplete');
  for (const id of ['legacy/tauri-layout', 'first-launch/legacy-import', 'update/installer-exit', 'native/controljob-guard-helper-handoff', 'first-launch/host-running-same-state', 'first-launch/credentials-retained']) {
    assert.ok(all.missing.includes(id), id);
  }
  assert.match(all.markdown(meta), /Outcome: \*\*incomplete\*\*[\s\S]*Not executed \(required by the judged scopes\): .*legacy\/tauri-layout/);
  assert.match(all.markdown(meta), /⏭ skip \| no --legacy-installer/);
});

test('Tauri → Electron upgrade, update and uninstall pass end to end with a configured Host', async () => {
  const sys = windows({ host: true });
  const { report } = await runAcceptance(full(), withCargo(sys));
  assert.equal(report.outcome, 'pass', JSON.stringify({ failed: report.checks.filter(c => c.status === 'fail'), missing: report.missing }));
  assert.deepEqual(report.missing, []);
  assert.match(detail(report, 'first-launch/legacy-import'), new RegExp(`"exportId":"${EXPORT}","records":9`));
  assert.match(detail(report, 'first-launch/host-running-same-state'), /Original process replaced \(survival of the original process is not claimed\)/);
  assert.match(detail(report, 'update-launch/profile-kept'), /"mode":"imported"/);
  assert.equal(statuses(report)['uninstall/login-item-removed'], 'pass');
  assert.deepEqual(sys.calls.find(call => call[0] === SETUP).slice(1), ['/P', '/UPDATE']);
  const cargo = sys.calls.find(call => call[0] === 'cargo');
  assert.deepEqual(cargo.slice(cargo.indexOf('--target'), cargo.indexOf('--target') + 2), ['--target', 'x86_64-pc-windows-msvc']);
  assert.deepEqual(cargo.slice(cargo.indexOf('--')), ['--', '--test-threads=1', '--nocapture']);
  assert.ok(sys.calls.some(call => call[0] === 'reg.exe' && call[1] === 'add' && call[2] === RUN_KEY && call[4] === 'TaroBot' && call[9] === '/f'));
});

test('regressions: each former false positive now fails or is reported as not verified', async () => {
  const run = async (faults, options = {}) => {
    const sys = windows({ faults: new Set(faults), host: options.host });
    return { sys, ...await runAcceptance({ ...full(), nativeTests: undefined, nextInstaller: undefined, ...options.input }, sys) };
  };
  // 1. A leftover Tauri <install>\host fails even though app.asar exists.
  let { report } = await run(['legacy-host']);
  assert.equal(statuses(report)['install/legacy-host-removed'], 'fail');
  assert.match(detail(report, 'install/legacy-host-removed'), /\\host: present$/);
  // 2. An exports folder without an imported profile is not a migration.
  ({ report } = await run(['migration']));
  assert.equal(statuses(report)['first-launch/profile-marker'], 'fail');
  assert.equal(statuses(report)['first-launch/legacy-import'], 'fail');
  ({ report } = await run(['import-receipt']));
  assert.equal(statuses(report)['first-launch/profile-marker'], 'pass');
  assert.equal(statuses(report)['first-launch/legacy-import'], 'fail');
  // 5. Only own processes are ended, main processes first, then stragglers by PID.
  let sys;
  ({ report, sys } = await run(['foreign', 'stuck-child']));
  const foreign = [...sys.state.procs.values()].find(item => item.path.startsWith('C:\\Other'));
  assert.ok(foreign, 'the foreign process still runs');
  assert.ok(!sys.calls.some(call => call[0] === 'taskkill.exe' && call[2] === String(foreign.pid)));
  assert.equal(statuses(report)['first-launch/stop-own-processes'], 'pass');
  assert.equal([...sys.state.procs.values()].filter(item => item.image === EXE && item.path.startsWith(INSTALL)).length, 0);
  // 6. A Host with another state directory is not the original Host.
  ({ report } = await run(['host-state'], { host: true }));
  assert.equal(statuses(report)['first-launch/host-running-same-state'], 'fail');
  // An Electron update that resets the profile is caught.
  ({ report } = await run(['profile-reset'], { input: { nextInstaller: NEXT, nextVersion: '1.2.4' } }));
  assert.equal(statuses(report)['update-launch/profile-kept'], 'fail');
  // W5: uninstall removes this installation's login item and keeps another one's.
  ({ report } = await run(['login-item-left']));
  assert.equal(statuses(report)['uninstall/login-item-removed'], 'fail');
  ({ report } = await runAcceptance({ installer: SETUP, confirmed: true, scopes: ['install'] }, windows({ faults: new Set(['login-item-any']) })));
  assert.equal(statuses(report)['uninstall/login-item-foreign-kept'], 'fail');
  // Native suites whose tests were compiled out prove nothing.
  sys = windows({ faults: new Set(['compiled-out']) });
  ({ report } = await runAcceptance({ installer: SETUP, nativeTests: 'C:\\src\\updater', confirmed: true, scopes: ['native'] }, withCargo(sys)));
  assert.equal(statuses(report)['native/controljob-guard-helper-handoff'], 'fail');
  // A static-CRT test that skipped itself is not a pass; an inherited RUSTFLAGS is not passed on.
  sys = windows({ faults: new Set(['crt-skipped']) });
  ({ report } = await runAcceptance({ installer: SETUP, nativeTests: 'C:\\src\\updater', confirmed: true, scopes: ['native'] }, withCargo(sys)));
  assert.match(detail(report, 'native/controljob-guard-helper-handoff'), /static CRT not compiled in/);
  sys = windows();
  sys.env.RUSTFLAGS = '-C debuginfo=0';
  ({ report } = await runAcceptance({ installer: SETUP, nativeTests: 'C:\\src\\updater', confirmed: true, scopes: ['native'] }, withCargo(sys)));
  assert.equal(statuses(report)['native/controljob-guard-helper-handoff'], 'pass');
  assert.equal(sys.cargoEnv.RUSTFLAGS, undefined);
});

test('a broken behaviour is a failure, not a skip', async () => {
  for (const [fault, id, legacy] of [['credentials', 'first-launch/credentials-retained', true], ['receipt', 'install/notification-receipt'], ['aumid', 'install/notification-aumid'], ['uninstall', 'uninstall/uninstaller-exit']]) {
    const sys = windows({ faults: new Set([fault]), host: fault === 'credentials' });
    const { report } = await runAcceptance({ installer: SETUP, legacyInstaller: legacy ? LEGACY : undefined, confirmed: true }, sys);
    assert.equal(statuses(report)[id], 'fail', fault);
    assert.equal(report.outcome, 'fail');
  }
});

test('a failed launch or an unexpected error still produces a failing receipt', async () => {
  // spawn reports ENOENT asynchronously; it must not escape as an uncaught 'error' event.
  assert.equal(windowsSystem().launch(path.join(process.cwd(), 'missing-tarocub-client.exe')), undefined);
  await new Promise(resolve => setTimeout(resolve, 50));
  const silent = windows();
  const { report } = await runAcceptance({ installer: SETUP, confirmed: true, scopes: ['install'] }, { ...silent, launch: file => { silent.calls.push(['launch', file]); return undefined; } });
  assert.equal(statuses(report)['first-launch/app-running'], 'fail');
  assert.match(detail(report, 'first-launch/app-running'), /could not be started/);
  const broken = windows();
  const { report: crashed, meta } = await runAcceptance({ installer: SETUP, confirmed: true }, { ...broken, readFile: async () => { throw new TypeError('disk vanished'); }, exists: () => { throw new TypeError('disk vanished'); } });
  assert.equal(crashed.outcome, 'fail');
  assert.match(detail(crashed, 'harness/unexpected-error'), /disk vanished/);
  assert.match(crashed.markdown(meta), /harness \| unexpected-error \| ❌ fail/);
});

test('TaroBird display name is verified independently from retained TaroBot install identifiers', async () => {
  for (const [displayName, expected] of [['TaroBird', 'pass'], ['TaroBot', 'fail'], ['Other App', 'fail']]) {
    const sys = windows({ displayName });
    const { report } = await runAcceptance({ installer: SETUP, version: '1.2.3', confirmed: true, scopes: ['install'] }, sys);
    assert.equal(statuses(report)['install/uninstall-key'], expected, displayName);
    assert.equal(statuses(report)['install/deep-link'], 'pass');
  }
});
