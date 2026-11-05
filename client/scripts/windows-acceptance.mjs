// Isolated Windows acceptance for the Electron installer, run on a DISPOSABLE
// Windows machine (fresh VM snapshot, CI runner or throwaway user). It installs,
// upgrades, launches and uninstalls the App for the current user, so it refuses
// to run where any TaroBot install, data, login item or process already exists,
// or where it cannot tell. No network service, update feed, GitHub login or
// user credential is used.
//
//   set TAROBOT_WINDOWS_ACCEPTANCE=disposable
//   node scripts/windows-acceptance.mjs --confirm-disposable-windows \
//     --installer <TaroBot_x.y.z_x64-setup.exe> --report <dir containing .noindex> \
//     [--legacy-installer <old Tauri TaroBot setup.exe>]   upgrade + migration path
//     [--next-installer <newer Electron setup.exe>]        Electron -> Electron update
//     [--native-tests <client/src-desktop-updater>]        ControlJob/guard/helper/handoff (needs cargo)
//     [--scope install,upgrade,...]                        judge only these scopes (default: all)
//
// Every check is recorded as pass, fail or skip (with the reason); a skipped
// check is NOT a pass. The outcome is `pass` only when every required check of
// the judged scopes ran and passed; otherwise `fail` or `incomplete`.
import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// PRODUCT owns retained install paths and registry keys; the display label can change.
const DISPLAY_NAME = 'TaroBird';
export const PRODUCT = 'TaroBot', EXE = 'tarocub-client.exe', AUMID = 'com.tarobot.client';
export const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TaroBot';
export const LOCATION_KEY = 'HKCU\\Software\\tarocub\\TaroBot';
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\tarocub\\shell\\open\\command';
const MACHINE_KEYS = ['HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TaroBot', 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TaroBot'];
// A login item for another installation; uninstall must leave it alone.
export const FOREIGN_LOGIN_ITEM = 'C:\\TaroBot-acceptance-other\\tarocub-client.exe ';
const EXPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks each scope requires. A required check that did not run makes the
 * result `incomplete`. `paired` needs a Host and credentials that existed
 * before the upgrade, which a fresh disposable machine does not have. */
export const SCOPES = Object.freeze({
  install: ['install/installer-exit', 'install/install-location', 'install/uninstall-key', 'install/host-runtime', 'install/deep-link',
    'install/start-menu-shortcut', 'install/notification-receipt', 'install/notification-aumid', 'first-launch/app-running',
    'first-launch/profile-marker', 'first-launch/stop-own-processes', 'uninstall/uninstaller-exit', 'uninstall/program-removed',
    'uninstall/uninstall-key-removed', 'uninstall/deep-link-removed', 'uninstall/data-retained'],
  upgrade: ['legacy/installer-exit', 'legacy/tauri-layout', 'legacy/seed-login-item', 'legacy/legacy-webview2-profile', 'legacy/stop-own-processes',
    'install/legacy-host-removed', 'install/login-item-continuity', 'first-launch/legacy-import', 'uninstall/login-item-removed'],
  update: ['update/installer-exit', 'update/uninstall-key', 'update/data-retained', 'update-launch/app-running', 'update-launch/profile-kept'],
  native: ['native/controljob-guard-helper-handoff'],
  paired: ['first-launch/host-running-same-state', 'first-launch/credentials-retained'],
});
export const requiredChecks = scopes => [...new Set(scopes.flatMap(scope => SCOPES[scope]))];

const unquote = value => value?.replace(/^"(.*)"$/, '$1');

export function windowsSystem() {
  const run = (file, args, { timeout = 600_000, env } = {}) => new Promise(resolve => {
    execFile(file, args, { timeout, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
  return {
    platform: process.platform, env: process.env, run, exists: existsSync,
    // An unreadable path is `error`, never `absent`.
    probe: file => { try { statSync(file); return 'present'; } catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'absent' : 'error'; } },
    readFile: file => readFile(file, 'utf8'),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    powershell: script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`], { timeout: 120_000 }),
    // A failed launch (e.g. ENOENT) is reported asynchronously; without a listener it would crash the run.
    launch: (file, args = []) => {
      try { const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false }); child.once('error', () => {}); child.unref(); return child.pid; }
      catch { return undefined; }
    },
  };
}

/** One recorded check. `skip` always carries the reason it did not run. */
export class Report {
  constructor(scopes = Object.keys(SCOPES)) { this.checks = []; this.scopes = scopes; }
  add(phase, id, status, detail = '') { this.checks.push({ phase, id, status, detail: String(detail).slice(0, 2000) }); return status === 'pass'; }
  expect(phase, id, ok, detail) { return this.add(phase, id, ok ? 'pass' : 'fail', detail); }
  /** Required checks of the judged scopes that never passed or failed. */
  get missing() {
    const ran = new Set(this.checks.filter(check => check.status !== 'skip').map(check => `${check.phase}/${check.id}`));
    return requiredChecks(this.scopes).filter(id => !ran.has(id));
  }
  // A failure counts in any scope: a scope narrows what must run, never what may fail.
  get outcome() { return this.checks.some(check => check.status === 'fail') ? 'fail' : this.missing.length ? 'incomplete' : 'pass'; }
  markdown(meta) {
    const rows = this.checks.map(c => `| ${c.phase} | ${c.id} | ${c.status === 'pass' ? '✅ pass' : c.status === 'fail' ? '❌ fail' : '⏭ skip'} | ${c.detail.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`);
    const missing = this.missing.length ? `\nNot executed (required by the judged scopes): ${this.missing.join(', ')}.\n` : '';
    return `# Windows acceptance (${meta.startedAt})\n\nOutcome: **${this.outcome}** for scopes ${this.scopes.join(', ')}. Skips are not passes.\n${missing}\n| phase | check | status | detail |\n|---|---|---|---|\n${rows.join('\n')}\n`;
  }
}

/** Reads a key through .NET: `absent` only when the key does not exist; an
 * access or query failure is `error`, whatever the display language. */
export function registryScript(key) {
  const [, hive, sub] = /^(HKCU|HKLM)\\(.+)$/.exec(key) ?? [];
  if (!hive) throw new Error(`unsupported registry key ${key}`);
  return `$ErrorActionPreference = 'Stop'
try { $key = [Microsoft.Win32.Registry]::${hive === 'HKCU' ? 'CurrentUser' : 'LocalMachine'}.OpenSubKey('${sub.replaceAll("'", "''")}') } catch { '{"state":"error"}'; exit 0 }
if ($null -eq $key) { '{"state":"absent"}'; exit 0 }
try {
  $values = [ordered]@{}
  foreach ($name in $key.GetValueNames()) { $values[$(if ($name -eq '') { '(Default)' } else { $name })] = [string]$key.GetValue($name, $null, 'DoNotExpandEnvironmentNames') }
  ConvertTo-Json -InputObject ([ordered]@{ state = 'present'; values = $values }) -Compress -Depth 3
} catch { '{"state":"error"}' }`;
}
const registry = sys => ({
  async probe(key) {
    const result = await sys.powershell(registryScript(key));
    try { const value = JSON.parse(result.stdout.trim()); if (result.code === 0 && ['absent', 'present', 'error'].includes(value.state)) return value; } catch { /* below */ }
    return { state: 'error' };
  },
  async read(key) { const value = await this.probe(key); return value.state === 'present' ? value.values ?? {} : undefined; },
  async value(key, name) { return (await this.read(key))?.[name]; },
});

/** Processes of one image with executable path, parent and start time;
 * `undefined` when they could not be listed (never "none"). */
export async function appProcesses(sys, image) {
  const result = await sys.powershell(`$ErrorActionPreference = 'Stop'
try {
  $list = @(Get-CimInstance Win32_Process -Filter "Name='${image}'" | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; path = [string]$_.ExecutablePath; created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }); command = [string]$_.CommandLine } })
  ConvertTo-Json -InputObject $list -Compress -Depth 3
} catch { 'ERROR' }`);
  const text = result.stdout.trim();
  if (result.code !== 0 || !text || text === 'ERROR') return undefined;
  try { const value = JSON.parse(text); return Array.isArray(value) ? value : [value]; } catch { return undefined; }
}
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Refuses anything but an empty, disposable Windows profile, and any
 * environment it cannot inspect. */
export async function preflight(sys, { confirmed }) {
  const problems = [];
  if (sys.platform !== 'win32') problems.push('Windows is required');
  if (!confirmed || sys.env.TAROBOT_WINDOWS_ACCEPTANCE !== 'disposable') problems.push('set TAROBOT_WINDOWS_ACCEPTANCE=disposable and pass --confirm-disposable-windows (installs and uninstalls for this user)');
  if (problems.length) return problems;
  const reg = registry(sys);
  for (const key of [UNINSTALL_KEY, LOCATION_KEY, ...MACHINE_KEYS]) {
    const { state } = await reg.probe(key);
    if (state !== 'absent') problems.push(state === 'present' ? `an installation exists (${key})` : `cannot read ${key}; refusing an uncertain environment`);
  }
  const run = await reg.probe(RUN_KEY);
  if (run.state === 'error') problems.push(`cannot read ${RUN_KEY}; refusing an uncertain environment`);
  else if (run.state === 'present' && Object.hasOwn(run.values ?? {}, PRODUCT)) problems.push(`a login item exists (${RUN_KEY}\\${PRODUCT})`);
  for (const base of [sys.env.APPDATA, sys.env.LOCALAPPDATA]) for (const id of ['com.tarobot.client', 'com.tarocub.client']) {
    if (!base) { problems.push('APPDATA/LOCALAPPDATA are unavailable'); continue; }
    const state = sys.probe(path.win32.join(base, id));
    if (state !== 'absent') problems.push(state === 'present' ? `App data exists (${path.win32.join(base, id)})` : `cannot inspect ${path.win32.join(base, id)}; refusing an uncertain environment`);
  }
  const running = await appProcesses(sys, EXE);
  if (!running) problems.push(`cannot list ${EXE} processes; refusing an uncertain environment`);
  else if (running.length) problems.push(`${EXE} is running (${running.map(item => item.pid).join(', ')})`);
  return [...new Set(problems)];
}

async function install(sys, report, phase, installer, args) {
  const started = Date.now();
  const result = await sys.run(installer, args, { timeout: 900_000 });
  report.expect(phase, 'installer-exit', result.code === 0, `${path.win32.basename(installer)} ${args.join(' ')} → ${result.code} in ${Math.round((Date.now() - started) / 1000)} s`);
  const reg = registry(sys);
  const directory = unquote(await reg.value(LOCATION_KEY, '(Default)')) ?? unquote(await reg.value(UNINSTALL_KEY, 'InstallLocation'));
  report.expect(phase, 'install-location', !!directory && sys.exists(path.win32.join(directory, EXE)), directory ?? 'no install location registered');
  return directory;
}

/** Layout, identity and shell integration of an installed Electron App. */
async function verifyElectron(sys, report, phase, directory, version) {
  const join = (...parts) => path.win32.join(directory, ...parts);
  const reg = registry(sys);
  const uninstall = await reg.read(UNINSTALL_KEY) ?? {};
  report.expect(phase, 'uninstall-key', uninstall.DisplayName === DISPLAY_NAME && uninstall.MainBinaryName === EXE && (!version || uninstall.DisplayVersion === version),
    JSON.stringify({ name: uninstall.DisplayName, binary: uninstall.MainBinaryName, version: uninstall.DisplayVersion }));
  for (const file of [EXE, 'tarobot-installer-helper.exe', 'uninstall.exe', 'resources\\app.asar', 'resources\\native\\tarobot-desktop-updater.exe',
    'resources\\native\\tarobot-desktop-core.exe', 'resources\\native\\tarobot-migration-exporter.exe', 'resources\\native\\tarobot-desktop-native.node']) {
    report.expect(phase, `file:${file}`, sys.exists(join(file)), join(file));
  }
  const host = join('resources', 'host');
  const runtime = sys.exists(path.win32.join(host, 'node.exe')) && sys.exists(path.win32.join(host, 'dist', 'src', 'index.js'));
  report.expect(phase, 'host-runtime', runtime, runtime ? host : `no Host runtime in ${host}`);
  const command = await reg.value(PROTOCOL_KEY, '(Default)');
  report.expect(phase, 'deep-link', same(command, `"${join(EXE)}" "%1"`), command ?? 'missing');
  const startMenu = sys.env.APPDATA && path.win32.join(sys.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const shortcut = startMenu && [path.win32.join(startMenu, `${PRODUCT}.lnk`), path.win32.join(startMenu, PRODUCT, `${PRODUCT}.lnk`)].find(sys.exists);
  let target = '';
  if (shortcut) target = (await sys.powershell(`(New-Object -ComObject WScript.Shell).CreateShortcut('${shortcut.replaceAll("'", "''")}').TargetPath`)).stdout.trim();
  report.expect(phase, 'start-menu-shortcut', !!shortcut && same(target, join(EXE)), `${shortcut ?? 'missing'} → ${target}`);
  // Written only after `tarocub-client.exe --register-notification-shortcut` succeeded.
  const receipt = join('tarocub-notification-shortcut.json');
  let receiptPath;
  try { receiptPath = JSON.parse(await sys.readFile(receipt)); } catch { /* reported below */ }
  report.expect(phase, 'notification-receipt', !!shortcut && typeof receiptPath === 'string' && same(receiptPath, shortcut), `${receipt} → ${receiptPath ?? 'missing'}`);
  const apps = (await sys.powershell(`Get-StartApps | Where-Object { $_.AppID -eq '${AUMID}' } | ForEach-Object { $_.AppID }`)).stdout.trim();
  report.expect(phase, 'notification-aumid', apps.split(/\r?\n/).includes(AUMID), apps || `no Start app with AppID ${AUMID}`);
}

/** Credential Manager target names only (cmdkey never prints secrets);
 * `undefined` when cmdkey failed. */
export async function credentialTargets(sys) {
  const result = await sys.run('cmdkey.exe', ['/list']);
  if (result.code !== 0) return undefined;
  return result.stdout.split(/\r?\n/).map(line => /^\s*Target:\s*(.+)$/i.exec(line)?.[1]?.trim()).filter(target => target && /com\.taro(bot|cub)\.client/i.test(target));
}

/** Host daemons (`node <entry> hub run --state-dir <dir>`, src/hub/service.ts)
 * of this App; their state directory is the Host's identity across restarts. */
export const hostState = command => /\bhub run\b.*?--state-dir\s+(?:"([^"]+)"|(\S+))/i.exec(command ?? '')?.slice(1).find(Boolean)?.toLowerCase();
async function hosts(sys) {
  const nodes = await appProcesses(sys, 'node.exe');
  return nodes?.map(item => ({ ...item, state: hostState(item.command) })).filter(item => item.state && /com\.taro(bot|cub)\.client/i.test(item.state));
}

/** Starts the App. Processes of this executable that already ran are foreign
 * and never terminated by this suite. */
async function start(sys, executable) {
  const before = await appProcesses(sys, EXE);
  return { executable, foreign: new Set((before ?? []).map(item => item.pid)), listed: !!before, pid: sys.launch(executable) };
}
const own = (session, list) => list.filter(item => !session.foreign.has(item.pid) && same(item.path, session.executable));

/** Ends only the processes this suite started, after checking their
 * executable: main processes first (Chromium children follow), then any
 * remaining own process by PID. The Host (node.exe) is never in scope. */
async function stopApp(sys, report, phase, session) {
  if (!session.listed) return report.add(phase, 'stop-own-processes', 'fail', 'processes before the launch could not be listed; nothing terminated');
  const ended = [];
  for (let round = 0; round < 4; round += 1) {
    const list = await appProcesses(sys, EXE);
    if (!list) return report.add(phase, 'stop-own-processes', 'fail', 'cannot list processes; nothing terminated');
    const mine = own(session, list);
    if (!mine.length) return report.add(phase, 'stop-own-processes', 'pass', `ended ${ended.join(', ') || 'none (already exited)'}; ${list.length} other process(es) untouched`);
    const targets = round ? mine : mine.filter(item => !mine.some(other => other.pid === item.parent));
    for (const item of targets) { await sys.run('taskkill.exe', ['/PID', String(item.pid), '/F']); ended.push(item.pid); }
    await sys.sleep(3000);
  }
  const left = own(session, await appProcesses(sys, EXE) ?? []);
  report.add(phase, 'stop-own-processes', 'fail', `still running: ${left.map(item => item.pid).join(', ') || 'unknown'}`);
}

/** First launch: the App stays up and records its profile — `fresh` for a new
 * install; `imported` with a valid export after a Tauri upgrade, backed by
 * the receipt main writes only after the renderer committed that export. */
async function launch(sys, report, phase, directory, { expected }) {
  const state = path.win32.join(sys.env.LOCALAPPDATA ?? '', 'com.tarobot.client');
  const session = await start(sys, path.win32.join(directory, EXE));
  const markerFile = path.win32.join(state, 'electron-profile', 'tarobot-desktop-profile-v1.json');
  let marker;
  for (let waited = 0; waited < 120_000 && !marker; waited += 3000) {
    await sys.sleep(3000);
    try { marker = JSON.parse(await sys.readFile(markerFile)); } catch { marker = undefined; }
  }
  const list = await appProcesses(sys, EXE);
  const mine = list && own(session, list);
  report.expect(phase, 'app-running', session.listed && !!session.pid && !!mine?.length,
    !session.pid ? `${session.executable} could not be started` : !session.listed || !list ? 'processes could not be listed'
      : mine.length ? `${mine.map(item => item.pid).join(', ')} (launched ${session.pid})` : `launched ${session.pid}, no process of ${session.executable} left`);
  const shown = `${markerFile}: ${marker ? JSON.stringify(marker) : 'absent'}`;
  if (expected === 'fresh') report.expect(phase, 'profile-marker', marker?.version === 1 && marker.mode === 'fresh', shown);
  else if (expected === 'imported') {
    report.expect(phase, 'profile-marker', marker?.version === 1 && marker.mode === 'imported', shown);
    const exportId = marker?.mode === 'imported' && EXPORT_ID.test(marker.exportId ?? '') ? marker.exportId : undefined;
    const receiptFile = exportId && path.win32.join(state, 'desktop-migration', 'receipts', `${exportId}.json`);
    let receipt;
    try { receipt = receiptFile && JSON.parse(await sys.readFile(receiptFile)); } catch { /* reported below */ }
    report.expect(phase, 'legacy-import', !!receipt && receipt.exportId === exportId && receipt.target === 'electron' && Number.isInteger(receipt.records) && receipt.records > 0,
      !exportId ? 'the profile was not imported from a valid export' : `${receiptFile}: ${receipt ? JSON.stringify({ exportId: receipt.exportId, records: receipt.records, target: receipt.target }) : 'missing or unreadable'}`);
  } else report.expect(phase, 'profile-kept', marker?.version === 1 && marker.mode === expected.mode && marker.exportId === expected.exportId, `${shown}; before ${JSON.stringify(expected)}`);
  return { session, marker };
}

export async function runAcceptance(options, sys = windowsSystem()) {
  const scopes = options.scopes ?? Object.keys(SCOPES);
  const report = new Report(scopes), meta = { startedAt: new Date().toISOString(), scopes, options: { ...options } };
  // An unexpected error is a failure with a receipt, never a crash without one.
  try { await phases(options, sys, report); }
  catch (error) { report.add('harness', 'unexpected-error', 'fail', error instanceof Error ? error.stack ?? error.message : String(error)); }
  return { report, meta };
}

async function phases(options, sys, report) {
  const problems = await preflight(sys, { confirmed: options.confirmed });
  if (problems.length) { for (const problem of problems) report.add('preflight', 'disposable-environment', 'fail', problem); return; }
  report.add('preflight', 'disposable-environment', 'pass', 'no TaroBot install, data, login item or process');

  if (options.nativeTests && sys.exists(path.win32.join(options.nativeTests, 'Cargo.toml'))) {
    // The release flags: the static-CRT test returns early without +crt-static.
    // RUSTFLAGS would override the target flags, so it is not inherited. The
    // source-guard tests share fixed mutex names and must run one at a time.
    const env = Object.fromEntries(Object.entries(sys.env).filter(([key]) => !['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS'].includes(key.toUpperCase())));
    env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = '-C target-feature=+crt-static';
    const result = await sys.run('cargo', ['test', '--manifest-path', path.win32.join(options.nativeTests, 'Cargo.toml'), '--locked', '--target', 'x86_64-pc-windows-msvc',
      '--test', 'windows_runtime', '--test', 'windows_control_job', '--test', 'windows_source_guard', '--', '--test-threads=1', '--nocapture'], { timeout: 1_800_000, env });
    const output = `${result.stdout}\n${result.stderr}`;
    const summary = output.split(/\r?\n/).filter(line => /^test result:|^test .* (ok|FAILED|ignored)$|^skipped:/.test(line)).join('\n');
    // One result per test binary; a binary whose tests were compiled out (`0 passed`) proves nothing.
    const passed = [...result.stdout.matchAll(/^test result: ok\. (\d+) passed/gm)].map(match => Number(match[1]));
    const vacuous = /^skipped:/m.test(output);
    report.expect('native', 'controljob-guard-helper-handoff', result.code === 0 && passed.length === 3 && passed.every(count => count > 0) && !vacuous,
      `${vacuous ? 'a test skipped itself (static CRT not compiled in); ' : ''}${summary || result.stderr.slice(-1500)}`);
  } else report.add('native', 'controljob-guard-helper-handoff', 'skip', options.nativeTests ? 'Cargo.toml not found' : 'no --native-tests');

  const reg = registry(sys);
  let directory;
  if (options.legacyInstaller) {
    directory = await install(sys, report, 'legacy', options.legacyInstaller, ['/S']);
    if (directory) {
      report.expect('legacy', 'tauri-layout', sys.exists(path.win32.join(directory, 'host', 'node.exe')), 'Tauri keeps its Host runtime in <install>\\host');
      // A login item exactly as tauri-plugin-autostart 2.7.0 (auto-launch 0.6.0) writes it.
      const value = `${path.win32.join(directory, EXE)} `;
      const seeded = await sys.run('reg.exe', ['add', RUN_KEY, '/v', PRODUCT, '/t', 'REG_SZ', '/d', value, '/f']);
      report.expect('legacy', 'seed-login-item', seeded.code === 0 && await reg.value(RUN_KEY, PRODUCT) === value, `${RUN_KEY}\\${PRODUCT} = ${JSON.stringify(value)}`);
      const session = await start(sys, path.win32.join(directory, EXE)); await sys.sleep(20_000);
      report.expect('legacy', 'legacy-webview2-profile', sys.exists(path.win32.join(sys.env.LOCALAPPDATA ?? '', 'com.tarobot.client', 'EBWebView')), 'old App created its WebView2 data');
      await stopApp(sys, report, 'legacy', session);
    }
  } else report.add('legacy', 'tauri-to-electron', 'skip', 'no --legacy-installer: the Tauri → Electron upgrade was not exercised');

  const hostsBefore = await hosts(sys), credentialsBefore = await credentialTargets(sys);
  // The old updater hands the new installer `/P /UPDATE /R`; `/R` is omitted so the run stays scripted.
  directory = await install(sys, report, 'install', options.installer, options.legacyInstaller ? ['/P', '/UPDATE'] : ['/S']) ?? directory;
  if (!directory) return;
  await verifyElectron(sys, report, 'install', directory, options.version);
  if (options.legacyInstaller) {
    // The Electron runtime lives in resources\host; the whole Tauri folder must be gone.
    const old = path.win32.join(directory, 'host'), left = sys.probe(old);
    report.expect('install', 'legacy-host-removed', left === 'absent', `${old}: ${left}`);
    const run = await reg.value(RUN_KEY, PRODUCT);
    report.expect('install', 'login-item-continuity', !!run && same(unquote(run.trim()), path.win32.join(directory, EXE)), `${RUN_KEY}\\${PRODUCT} = ${run ?? 'missing'}`);
  } else report.add('install', 'login-item-continuity', 'skip', 'no legacy login item to carry over');
  const first = await launch(sys, report, 'first-launch', directory, { expected: options.legacyInstaller ? 'imported' : 'fresh' });

  // The installer stops the Host on purpose, so the original process is not
  // expected to survive; the same Host (state directory) must run again.
  const hostsAfter = await hosts(sys);
  if (hostsBefore === undefined || hostsAfter === undefined) report.add('first-launch', 'host-running-same-state', 'fail', 'Host processes could not be listed');
  else if (!hostsBefore.length) report.add('first-launch', 'host-running-same-state', 'skip', 'no Host ran before the upgrade (a fresh profile needs interactive pairing)');
  else {
    const describe = list => list.map(item => `${item.pid}@${item.created} ${item.state}`).join('; ') || 'none';
    const back = hostsBefore.every(before => hostsAfter.some(after => after.state === before.state));
    const unchanged = hostsBefore.filter(before => hostsAfter.some(after => after.pid === before.pid && after.created === before.created));
    report.expect('first-launch', 'host-running-same-state', back,
      `before: ${describe(hostsBefore)}. after: ${describe(hostsAfter)}. Original process ${unchanged.length ? 'still running' : 'replaced (survival of the original process is not claimed)'}`);
  }
  // Same keyring service and entries for the Electron helper: they must survive the upgrade.
  const credentialsAfter = await credentialTargets(sys);
  if (credentialsBefore === undefined || credentialsAfter === undefined) report.add('first-launch', 'credentials-retained', 'fail', 'cmdkey /list failed');
  else if (!credentialsBefore.length) report.add('first-launch', 'credentials-retained', 'skip', 'the old App stored no TaroBot credential (device keys appear only after pairing)');
  else report.expect('first-launch', 'credentials-retained', credentialsBefore.every(target => credentialsAfter.includes(target)), `${credentialsBefore.length} before, ${credentialsAfter.length} after`);
  await stopApp(sys, report, 'first-launch', first.session);

  if (options.nextInstaller) {
    await install(sys, report, 'update', options.nextInstaller, ['/P', '/UPDATE']);
    await verifyElectron(sys, report, 'update', directory, options.nextVersion);
    report.expect('update', 'data-retained', sys.exists(path.win32.join(sys.env.LOCALAPPDATA ?? '', 'com.tarobot.client', 'electron-profile', 'tarobot-desktop-profile-v1.json')), 'Electron profile kept across the update');
    const again = await launch(sys, report, 'update-launch', directory, { expected: { mode: first.marker?.mode, exportId: first.marker?.exportId } });
    await stopApp(sys, report, 'update-launch', again.session);
  } else report.add('update', 'electron-to-electron', 'skip', 'no --next-installer');

  // A Tauri upgrade carries this installation's login item; otherwise the
  // value names another installation, which uninstall must keep.
  if (!options.legacyInstaller) {
    const seeded = await sys.run('reg.exe', ['add', RUN_KEY, '/v', PRODUCT, '/t', 'REG_SZ', '/d', FOREIGN_LOGIN_ITEM, '/f']);
    report.expect('uninstall', 'seed-foreign-login-item', seeded.code === 0 && await reg.value(RUN_KEY, PRODUCT) === FOREIGN_LOGIN_ITEM, `${RUN_KEY}\\${PRODUCT} = ${JSON.stringify(FOREIGN_LOGIN_ITEM)}`);
  }
  const uninstaller = path.win32.join(directory, 'uninstall.exe');
  const result = await sys.run(uninstaller, ['/S'], { timeout: 600_000 });
  // NSIS hands the work to a copy of itself in %TEMP% and returns at once.
  for (let waited = 0; waited < 180_000 && (sys.exists(path.win32.join(directory, EXE)) || (await reg.probe(UNINSTALL_KEY)).state !== 'absent'); waited += 2000) await sys.sleep(2000);
  report.expect('uninstall', 'uninstaller-exit', result.code === 0, `exit ${result.code}`);
  report.expect('uninstall', 'program-removed', !sys.exists(path.win32.join(directory, EXE)), path.win32.join(directory, EXE));
  const key = (await reg.probe(UNINSTALL_KEY)).state;
  report.expect('uninstall', 'uninstall-key-removed', key === 'absent', `${UNINSTALL_KEY}: ${key}`);
  const link = await reg.probe(PROTOCOL_KEY);
  report.expect('uninstall', 'deep-link-removed', link.state === 'absent' || link.state === 'present' && link.values?.['(Default)'] === undefined, `${PROTOCOL_KEY}: ${link.state}`);
  report.expect('uninstall', 'data-retained', sys.exists(path.win32.join(sys.env.LOCALAPPDATA ?? '', 'com.tarobot.client', 'electron-profile')), 'a silent uninstall keeps user data (fresh start needs consent)');
  const run = await reg.probe(RUN_KEY), item = run.values?.[PRODUCT];
  const shown = `${RUN_KEY}\\${PRODUCT} = ${run.state === 'error' ? 'unreadable' : item === undefined ? 'absent' : JSON.stringify(item)}`;
  if (options.legacyInstaller) report.expect('uninstall', 'login-item-removed', run.state !== 'error' && item === undefined, shown);
  else {
    report.expect('uninstall', 'login-item-foreign-kept', run.state === 'present' && item === FOREIGN_LOGIN_ITEM, shown);
    // Remove only the value this suite wrote.
    if (item === FOREIGN_LOGIN_ITEM) report.expect('uninstall', 'foreign-login-item-cleanup', (await sys.run('reg.exe', ['delete', RUN_KEY, '/v', PRODUCT, '/f'])).code === 0, shown);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    installer: { type: 'string' }, 'legacy-installer': { type: 'string' }, 'next-installer': { type: 'string' },
    version: { type: 'string' }, 'next-version': { type: 'string' }, 'native-tests': { type: 'string' },
    report: { type: 'string' }, 'confirm-disposable-windows': { type: 'boolean', default: false }, scope: { type: 'string' },
  } });
  const resolve = value => value && path.resolve(value);
  if (!values.installer || !values.report) throw new Error('--installer and --report are required');
  const reportDir = path.resolve(values.report);
  if (!reportDir.split(/[\\/]/).some(part => part.endsWith('.noindex'))) throw new Error('--report must be inside a .noindex directory');
  const scopes = values.scope?.split(',').map(scope => scope.trim());
  for (const scope of scopes ?? []) if (!Object.hasOwn(SCOPES, scope)) throw new Error(`unknown scope ${scope} (${Object.keys(SCOPES).join(', ')})`);
  const version = values.version ?? /_(\d+\.\d+\.\d+)_/.exec(path.basename(values.installer))?.[1];
  const nextVersion = values['next-version'] ?? (values['next-installer'] && /_(\d+\.\d+\.\d+)_/.exec(path.basename(values['next-installer']))?.[1]);
  const { report, meta } = await runAcceptance({
    installer: resolve(values.installer), legacyInstaller: resolve(values['legacy-installer']), nextInstaller: resolve(values['next-installer']),
    version, nextVersion, nativeTests: resolve(values['native-tests']), confirmed: values['confirm-disposable-windows'], scopes,
  });
  await mkdir(reportDir, { recursive: true });
  const body = { outcome: report.outcome, missing: report.missing, ...meta, finishedAt: new Date().toISOString(), checks: report.checks };
  await writeFile(path.join(reportDir, 'windows-acceptance.json'), `${JSON.stringify(body, null, 2)}\n`);
  await writeFile(path.join(reportDir, 'windows-acceptance.md'), report.markdown(meta));
  console.log(JSON.stringify({ outcome: report.outcome, scopes: report.scopes, missing: report.missing,
    failed: report.checks.filter(c => c.status === 'fail').map(c => `${c.phase}/${c.id}`), skipped: report.checks.filter(c => c.status === 'skip').map(c => `${c.phase}/${c.id}`) }));
  process.exitCode = report.outcome === 'pass' ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
export const SCRIPT = fileURLToPath(import.meta.url);
