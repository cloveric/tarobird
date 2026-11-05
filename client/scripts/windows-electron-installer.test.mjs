// Fixture checks for the Windows Electron installer. Compiling with makensis
// and listing the payload proves structure only; installing, upgrading a Tauri
// install and uninstalling need real Windows acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildWindowsInstaller, DEFAULT_PLUGINS_DIR, defaultPluginsDir, findMakensis, HELPER_BINARY, MAIN_BINARY, NSIS_TAURI_UTILS, planWindowsInstaller, setupNsisPlugins, TEMPLATE_DIR } from './windows-electron-installer.mjs';

const client = fileURLToPath(new URL('..', import.meta.url));
const tool = name => ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(dir => path.join(dir, name)).find(existsSync);
const makensis = tool('makensis'), sevenZip = tool('7zz') ?? tool('7z');
const pluginsDir = process.env.TAROBOT_NSIS_PLUGINS_DIR ?? DEFAULT_PLUGINS_DIR;
let root, helper;

async function packaged(name, { host = 'resources/host', extra = {} } = {}) {
  const dir = path.join(root, name, 'TaroBot-win32-x64');
  const files = {
    [MAIN_BINARY]: 'MZ electron', 'ffmpeg.dll': 'MZ', 'resources.pak': 'pak', 'locales/zh-CN.pak': 'pak',
    'resources/app.asar': 'asar', 'resources/native/tarobot-desktop-updater.exe': 'MZ', 'resources/native/update-config.json': '{}',
    'resources/native/tarobot-desktop-native.node': 'MZ', 'resources/native/tarobot-migration-exporter.exe': 'MZ', [`${host}/node.exe`]: 'MZ node', [`${host}/dist/src/index.js`]: '// host',
    'resources/app.asar.unpacked/a file.txt': 'x', ...extra,
  };
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body);
  }
  return dir;
}

before(async () => {
  const base = process.env.TAROBOT_UPDATER_LAB_ROOT;
  assert.ok(base?.includes('.noindex'), 'TAROBOT_UPDATER_LAB_ROOT must point inside a .noindex lab directory');
  await mkdir(base, { recursive: true });
  root = await mkdtemp(path.join(base, 'nsis-'));
  helper = process.env.TAROBOT_WINDOWS_HELPER;
  if (!helper) { helper = path.join(root, 'helper.exe'); await writeFile(helper, 'MZ fixture helper'); }
});
after(async () => { if (root && !process.env.TAROBOT_UPDATER_LAB_KEEP) await rm(root, { recursive: true, force: true }); });

test('fixed identity equals the Tauri installer that existing users have', async () => {
  const nsi = await readFile(path.join(TEMPLATE_DIR, 'installer.nsi'), 'utf8');
  const tauri = JSON.parse(await readFile(path.join(client, 'src-tauri/tauri.conf.json'), 'utf8'));
  const windows = JSON.parse(await readFile(path.join(client, 'src-tauri/tauri.windows.conf.json'), 'utf8'));
  const cargo = await readFile(path.join(client, 'src-tauri/Cargo.toml'), 'utf8');
  const define = name => nsi.match(new RegExp(`^!define ${name} "([^"]*)"`, 'm'))?.[1];
  assert.equal(define('PRODUCTNAME'), 'TaroBot', 'installation namespace remains compatible');
  assert.equal(define('DISPLAYNAME'), tauri.productName);
  assert.equal(define('MANUFACTURER'), tauri.bundle.publisher);
  assert.equal(define('BUNDLEID'), tauri.identifier);
  assert.equal(define('MAINBINARYNAME'), cargo.match(/^name = "([^"]+)"/m)[1]);
  assert.equal(`${define('MAINBINARYNAME')}.exe`, MAIN_BINARY);
  assert.equal(define('INSTALLMODE'), windows.bundle.windows.nsis.installMode);
  assert.equal(define('UNINSTKEY'), 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCTNAME}');
  assert.equal(define('MANUPRODUCTKEY'), '${MANUKEY}\\${PRODUCTNAME}');
  assert.equal(define('INSTALLWEBVIEW2MODE'), 'skip');
  assert.deepEqual(tauri.plugins['deep-link'].desktop.schemes, ['tarocub']);
  assert.match(nsi, /WriteRegStr SHCTX "Software\\Classes\\tarocub\\shell\\open\\command"/);
  // Only the runtime placeholders of the "app running" messages remain.
  const code = nsi.split('\n').filter(line => !line.trim().startsWith(';')).join('\n');
  assert.doesNotMatch(code.replaceAll('"{{product_name}}"', ''), /\{\{/);
  for (const language of tauri.bundle.windows.nsis.languages) assert.match(nsi, new RegExp(`MUI_LANGUAGE "${language}"`));
  const hooks = await readFile(path.join(TEMPLATE_DIR, 'installer-hooks.nsh'), 'utf8');
  const original = await readFile(path.join(client, 'src-tauri/windows/installer-hooks.nsh'), 'utf8');
  for (const keep of ['!macro NSIS_HOOK_PREINSTALL', '!macro NSIS_HOOK_POSTINSTALL', '!macro NSIS_HOOK_PREUNINSTALL', '!macro NSIS_HOOK_POSTUNINSTALL',
    '--register-notification-shortcut', '--clear-notification-history', '--confirm-host-stopped', '--prepare-fresh-install', 'TaroBotRememberInstallation']) {
    assert.ok(original.includes(keep) && hooks.includes(keep), keep);
  }
});

test('plan installs every packaged file once, removes exactly those, and adds the helper', async () => {
  const appDir = await packaged('plan');
  const plan = await planWindowsInstaller({ appDir, helper, version: '1.2.3', outFile: path.join(root, 'plan.exe'), pluginsDir });
  assert.equal(plan.host, 'resources\\host');
  const targets = plan.resources.map(item => item.target);
  assert.ok(!targets.includes(MAIN_BINARY), 'the main binary comes from MAINBINARYSRCPATH');
  assert.ok(targets.includes(HELPER_BINARY) && targets.includes('resources\\native\\tarobot-desktop-updater.exe'));
  assert.equal(new Set(targets).size, targets.length);
  const installs = plan.includes.install.split('\n').filter(line => line.includes('File /a'));
  const deletes = plan.includes.uninstall.split('\n').filter(line => line.includes('Delete'));
  assert.equal(installs.length, targets.length); assert.equal(deletes.length, targets.length);
  assert.ok(plan.includes.install.includes('"/oname=resources\\app.asar.unpacked\\a file.txt"'));
  const removals = plan.includes.ancestors.split('\n').filter(Boolean).map(line => line.match(/\$INSTDIR\\(.*)"/)[1]);
  assert.ok(removals.indexOf('resources\\native') < removals.indexOf('resources'), 'children before parents');
  assert.equal(plan.defines.TB_VERSION, '1.2.3');
  assert.ok(Number(plan.defines.TB_ESTIMATED_SIZE) >= 1);
});

test('plan refuses packages the Tauri upgrade path could not own', async () => {
  const outFile = path.join(root, 'refused.exe');
  const refuse = async (name, options, pattern) => {
    const appDir = await packaged(name, options);
    await assert.rejects(planWindowsInstaller({ appDir, helper, version: '1.2.3', outFile, pluginsDir }), pattern);
    return appDir;
  };
  await refuse('both-hosts', { extra: { 'host/node.exe': 'MZ node', 'host/dist/src/index.js': '// old host' } }, /must not ship a top-level host/);
  const renamed = await packaged('renamed');
  await rm(path.join(renamed, MAIN_BINARY));
  await writeFile(path.join(renamed, 'TaroBot.exe'), 'MZ');
  await assert.rejects(planWindowsInstaller({ appDir: renamed, helper, version: '1.2.3', outFile, pluginsDir }), /tarocub-client\.exe/);
  await refuse('owned-name', { extra: { [HELPER_BINARY]: 'MZ' } }, /installer-owned/);
  await refuse('receipt', { extra: { 'tarocub-notification-shortcut.json': '{}' } }, /installer-owned/);
  await refuse('reserved', { extra: { 'resources/aux.txt': 'x' } }, /not valid on Windows/);
  await refuse('dollar', { extra: { 'resources/a $x.txt': 'x' } }, /not valid on Windows or in NSIS/);
  // Case-insensitive volumes (default APFS) cannot even hold the colliding pair.
  const probe = path.join(root, 'case-probe');
  await mkdir(probe, { recursive: true }); await writeFile(path.join(probe, 'A'), 'a'); await writeFile(path.join(probe, 'a'), 'b');
  if ((await readdir(probe)).length === 2) await refuse('case', { extra: { 'resources/A.txt': 'a', 'resources/a.TXT': 'b' } }, /collision/);
  const linked = await packaged('link');
  await symlink('/etc/hosts', path.join(linked, 'resources/link'));
  await assert.rejects(planWindowsInstaller({ appDir: linked, helper, version: '1.2.3', outFile, pluginsDir }), /Symbolic links/);
  const noexporter = await packaged('noexporter');
  await rm(path.join(noexporter, 'resources/native/tarobot-migration-exporter.exe'));
  await assert.rejects(planWindowsInstaller({ appDir: noexporter, helper, version: '1.2.3', outFile, pluginsDir }), /tarobot-migration-exporter/);
  const nohost = await packaged('nohost');
  await rm(path.join(nohost, 'resources/host'), { recursive: true });
  await assert.rejects(planWindowsInstaller({ appDir: nohost, helper, version: '1.2.3', outFile, pluginsDir }), /Host runtime/);
  for (const version of ['1.2', '1.2.3-beta', '100000.0.0']) {
    await assert.rejects(planWindowsInstaller({ appDir: renamed.replace('renamed', 'plan'), helper, version, outFile, pluginsDir }), /stable/);
  }
});

test('makensis compiles the installer; the payload holds the App, helper and recovery copy', { skip: !makensis && 'makensis not installed' }, async () => {
  const appDir = await packaged('build', { host: 'host' });
  const outFile = path.join(root, 'out', 'TaroBot_1.2.3_x64-setup.exe');
  const result = await buildWindowsInstaller({ appDir, helper, version: '1.2.3', outFile, pluginsDir }, { makensis, workDir: path.join(root, 'nsis-work') });
  assert.equal(result.host, 'host');
  assert.equal((await readFile(outFile)).subarray(0, 2).toString(), 'MZ');
  if (!sevenZip) return;
  const listing = execFileSync(sevenZip, ['l', '-ba', outFile]).toString();
  for (const entry of [MAIN_BINARY, HELPER_BINARY, 'resources\\app.asar', 'resources\\native\\tarobot-desktop-updater.exe', 'host\\node.exe', 'host\\dist\\src\\index.js', 'uninstall.exe']) {
    assert.ok(listing.replaceAll('/', '\\').includes(entry), `${entry} in payload`);
  }
  assert.match(listing, /tarobot-recovery\.exe/, 'the helper is also staged for recovery');
});

test('plugin directory and makensis resolve per platform', () => {
  assert.equal(defaultPluginsDir({ platform: 'darwin', env: {}, home: '/Users/a' }), '/Users/a/Library/Caches/tauri/NSIS/Plugins/x86-unicode/additional');
  assert.equal(defaultPluginsDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home: 'C:\\Users\\a' }),
    'C:\\Users\\a\\AppData\\Local\\tauri\\NSIS\\Plugins\\x86-unicode\\additional');
  assert.equal(defaultPluginsDir({ platform: 'linux', env: {}, home: '/home/a' }), '/home/a/.cache/tauri/NSIS/Plugins/x86-unicode/additional');
  assert.equal(defaultPluginsDir({ platform: 'win32', env: { TAROBOT_NSIS_PLUGINS_DIR: 'D:\\nsis' } }), 'D:\\nsis');
  const programFiles = 'C:\\Program Files (x86)';
  assert.equal(findMakensis({ platform: 'win32', env: { 'ProgramFiles(x86)': programFiles }, exists: file => file === `${programFiles}\\NSIS\\makensis.exe` }), `${programFiles}\\NSIS\\makensis.exe`);
  assert.equal(findMakensis({ platform: 'win32', env: {}, exists: () => false }), 'makensis');
  assert.equal(findMakensis({ platform: 'darwin', env: { MAKENSIS: '/opt/nsis/makensis' } }), '/opt/nsis/makensis');
});

test('setup-nsis installs only the pinned plugin and never a mismatched or oversized download', async () => {
  const response = (bytes, length = bytes.length) => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(length) }), body: (async function* () { yield bytes; })() });
  const dir = path.join(root, 'plugins');
  let calls = 0;
  await assert.rejects(setupNsisPlugins({ pluginsDir: dir, fetchImpl: async () => { calls++; return response(Buffer.alloc(NSIS_TAURI_UTILS.size, 1)); } }), /does not match/);
  await assert.rejects(setupNsisPlugins({ pluginsDir: dir, fetchImpl: async () => response(Buffer.alloc(8), NSIS_TAURI_UTILS.size + 1) }), /larger than pinned/);
  await assert.rejects(setupNsisPlugins({ pluginsDir: dir, fetchImpl: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
  assert.ok(!existsSync(path.join(dir, 'nsis_tauri_utils.dll')));
  assert.equal(calls, 1);
  const source = path.join(pluginsDir, 'nsis_tauri_utils.dll');
  if (!existsSync(source)) return;
  const bytes = await readFile(source);
  const fetched = await setupNsisPlugins({ pluginsDir: dir, fetchImpl: async url => { assert.equal(url, NSIS_TAURI_UTILS.url); return response(bytes); } });
  assert.deepEqual(fetched, { path: path.join(dir, 'nsis_tauri_utils.dll'), downloaded: true });
  assert.deepEqual(await setupNsisPlugins({ pluginsDir: dir, fetchImpl: () => assert.fail('already verified') }), { path: fetched.path, downloaded: false });
  assert.deepEqual((await readdir(dir)).sort(), ['nsis_tauri_utils.dll']);
});

test('uninstall removes the login item only when it starts this installation', async () => {
  const nsi = await readFile(path.join(TEMPLATE_DIR, 'installer.nsi'), 'utf8');
  const uninstall = nsi.slice(nsi.indexOf('Section Uninstall'), nsi.indexOf('SectionEnd', nsi.indexOf('Section Uninstall')));
  const block = /\$\{If\} \$UpdateMode <> 1\n\s+Push \$R0\n\s+ReadRegStr \$R0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "\$\{PRODUCTNAME\}"\n((?:\s+\$\{(?:If|OrIf)\} \$R0 == .+\n)+)((?:\s+DeleteRegValue .+\n)+)\s+\$\{EndIf\}\n\s+Pop \$R0\n\s+\$\{EndIf\}/.exec(uninstall);
  assert.ok(block, 'the Run value is read and compared inside a non-update guard');
  // Every Run / StartupApproved deletion in the uninstaller is this guarded one.
  const deletions = uninstall.match(/DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\(?:Explorer\\StartupApproved\\)?Run"[^\n]*/g);
  assert.deepEqual(deletions, block[2].trim().split(/\n\s*/));
  assert.equal(deletions.length, 2);
  const nsisString = literal => literal.startsWith("'") || literal.startsWith('"') ? literal.slice(1, -1) : literal;
  const accepted = [...block[1].matchAll(/== (".*"|'.*')$/gm)].map(match => nsisString(match[1]));
  const INSTDIR = 'C:\\Users\\Lab\\AppData\\Local\\TaroBot', exe = `${INSTDIR}\\tarocub-client.exe`;
  // NSIS StrCmp (LogicLib ==) compares case-insensitively.
  const removes = value => accepted.some(pattern => pattern.replaceAll('$INSTDIR', INSTDIR).replaceAll('${MAINBINARYNAME}', 'tarocub-client').toLowerCase() === value.toLowerCase());
  for (const own of [`${exe} `, exe, `"${exe}"`, `${exe.toUpperCase()} `]) assert.ok(removes(own), `removes ${own}`);
  for (const other of ['D:\\Apps\\TaroBot\\tarocub-client.exe ', `${INSTDIR}2\\tarocub-client.exe `, `${exe} --minimized`, `${INSTDIR}\\other.exe `, '', ' ', `"${exe}" `]) {
    assert.ok(!removes(other), `keeps ${JSON.stringify(other)}`);
  }
});

test('after a Tauri upgrade the installer asks the helper, by fixed flag only, to drop the old host folder', async () => {
  const hooks = await readFile(path.join(TEMPLATE_DIR, 'installer-hooks.nsh'), 'utf8');
  const post = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL'), hooks.indexOf('!macroend', hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL')));
  const calls = [...hooks.matchAll(/--remove-legacy-host-runtime[^\n]*/g)].map(match => match[0]);
  assert.deepEqual(calls, ["--remove-legacy-host-runtime' $R0"], 'exactly one call, without any path argument');
  const call = post.indexOf('--remove-legacy-host-runtime');
  assert.ok(call > post.lastIndexOf('TaroBotRegisterNotificationShortcut'), 'after the new files and shortcut registration');
  assert.match(post, /\$\{If\} \$\{FileExists\} "\$INSTDIR\\host\\\*\.\*"\n\s+ClearErrors\n\s+ExecWait '"\$INSTDIR\\\$\{TAROBOTHELPER\}" --remove-legacy-host-runtime' \$R0/);
  // A refusal is reported, never an aborted installation.
  assert.doesNotMatch(post.slice(call), /Abort|MessageBox/);
  // No other hook deletes inside the installation directory recursively.
  assert.doesNotMatch(hooks, /RMDir \/r|RmDir \/r/i);
});
