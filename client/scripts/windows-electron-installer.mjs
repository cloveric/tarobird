// Windows release entry for the Electron App (x64).
//   native:    build tarobot-desktop-updater.exe (for resources\native) and
//              tarobot-installer-helper.exe, release, static CRT, never `lab`:
//     node scripts/windows-electron-installer.mjs native --target-dir <dir>
//   setup-nsis: fetch the pinned nsis_tauri_utils.dll (checksum-verified) into
//              the plugin directory; a no-op when the verified file is present:
//     node scripts/windows-electron-installer.mjs setup-nsis [--plugins-dir <dir>]
//   installer: NSIS installer for the packaged App directory, with the Tauri
//              installer's identity (see client/windows-electron/installer.nsi):
//     node scripts/windows-electron-installer.mjs installer --app-dir <packaged dir> \
//       --helper <tarobot-installer-helper.exe> --version x.y.z --out <file.exe> \
//       [--plugins-dir <dir>] [--makensis <path>]
// Prerequisite: NSIS 3.x `makensis` (PATH, MAKENSIS, or the default Windows
// install folder). The plugin directory defaults to TAROBOT_NSIS_PLUGINS_DIR,
// else tauri-bundler's former cache location for this platform.
// The installer is the release asset the updater hands `/P /UPDATE /R`.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const TEMPLATE_DIR = fileURLToPath(new URL('../windows-electron/', import.meta.url));
export const TEMPLATE_FILES = ['installer.nsi', 'installer-hooks.nsh', 'utils.nsh', 'FileAssociation.nsh', 'English.nsh', 'SimpChinese.nsh'];
export const MAIN_BINARY = 'tarocub-client.exe';
export const HELPER_BINARY = 'tarobot-installer-helper.exe';
// The nsis_tauri_utils.dll that tauri-bundler 2.12.1 pins for its template
// (SemverCompare/StrReplace/RunAsUser): same URL and SHA-1 as the CLI, plus our
// SHA-256. Any other plugin is refused.
export const NSIS_TAURI_UTILS = Object.freeze({
  url: 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll',
  sha256: '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709',
  sha1: '75197fee3c6a814fe035788d1c34ead39349b860', size: 34304,
});
export const NSIS_TAURI_UTILS_SHA256 = NSIS_TAURI_UTILS.sha256;

/** TAROBOT_NSIS_PLUGINS_DIR, else tauri-bundler's cache layout
 * (`<cache>/tauri/NSIS/Plugins/x86-unicode/additional`) for this host. */
export function defaultPluginsDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.TAROBOT_NSIS_PLUGINS_DIR) return env.TAROBOT_NSIS_PLUGINS_DIR;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const cache = platform === 'darwin' ? p.join(home, 'Library', 'Caches')
    : platform === 'win32' ? env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local')
      : env.XDG_CACHE_HOME ?? p.join(home, '.cache');
  return p.join(cache, 'tauri', 'NSIS', 'Plugins', 'x86-unicode', 'additional');
}
export const DEFAULT_PLUGINS_DIR = defaultPluginsDir();

/** `makensis` from --makensis, MAKENSIS, the default Windows install folders, else PATH. */
export function findMakensis({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (env.MAKENSIS) return env.MAKENSIS;
  if (platform === 'win32') {
    for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles]) {
      const candidate = base && path.win32.join(base, 'NSIS', 'makensis.exe');
      if (candidate && exists(candidate)) return candidate;
    }
  }
  return 'makensis';
}

const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const pinned = bytes => bytes.length === NSIS_TAURI_UTILS.size && digest('sha256', bytes) === NSIS_TAURI_UTILS.sha256 && digest('sha1', bytes) === NSIS_TAURI_UTILS.sha1;

/** CI bootstrap: ensure the pinned plugin is in `pluginsDir`. Downloads at most
 * the pinned size, verifies both digests, then renames into place. */
export async function setupNsisPlugins({ pluginsDir = DEFAULT_PLUGINS_DIR, fetchImpl = globalThis.fetch } = {}) {
  if (typeof pluginsDir !== 'string' || !path.isAbsolute(pluginsDir)) throw new Error('An absolute plugins directory is required');
  const target = path.join(pluginsDir, 'nsis_tauri_utils.dll');
  const current = await lstat(target).catch(() => undefined);
  if (current?.isFile() && !current.isSymbolicLink() && pinned(await readFile(target))) return { path: target, downloaded: false };
  if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error(`Refusing to replace a non-file at ${target}`);
  const response = await fetchImpl(NSIS_TAURI_UTILS.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`nsis_tauri_utils.dll download failed: HTTP ${response.status}`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > NSIS_TAURI_UTILS.size) throw new Error('nsis_tauri_utils.dll download is larger than pinned');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > NSIS_TAURI_UTILS.size) throw new Error('nsis_tauri_utils.dll download is larger than pinned');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, length);
  if (!pinned(bytes)) throw new Error('nsis_tauri_utils.dll does not match the pinned tauri-bundler plugin');
  await mkdir(pluginsDir, { recursive: true });
  const temporary = path.join(pluginsDir, `.nsis_tauri_utils.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, bytes, { flag: 'wx' });
  try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { path: target, downloaded: true };
}
// Names the installer or the running App own inside $INSTDIR.
const RESERVED = new Set(['uninstall.exe', HELPER_BINARY, 'tarocub-notification-shortcut.json']);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function stableVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/.test(version)) {
    throw new Error('Expected a stable x.y.z version (each part < 100000 for the Windows file version)');
  }
  return version;
}

// `$` is refused too: NSIS reads it as a variable or define in both the
// compile-time source path and the runtime /oname target.
function windowsName(name) {
  if (!name || /[<>:"/\\|?*$\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || WINDOWS_RESERVED.test(name)) {
    throw new Error(`Name is not valid on Windows or in NSIS: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Every regular file below `root`, refusing links and case-only collisions. */
export async function listPackage(root) {
  const files = [], directories = [], seen = new Map();
  const walk = async relative => {
    for (const entry of (await readdir(path.join(root, ...relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const parts = [...relative, windowsName(entry.name)];
      const key = parts.join('\\').toLowerCase();
      if (seen.has(key)) throw new Error(`Case-insensitive path collision: ${parts.join('\\')}`);
      seen.set(key, true);
      const info = await lstat(path.join(root, ...parts));
      if (info.isSymbolicLink()) throw new Error(`Symbolic links are not installable: ${parts.join('\\')}`);
      if (info.isDirectory()) { directories.push(parts); await walk(parts); }
      else if (info.isFile()) files.push({ parts, size: info.size });
      else throw new Error(`Unsupported file type: ${parts.join('\\')}`);
    }
  };
  await walk([]);
  return { files, directories };
}

async function peFile(file) {
  const handle = await open(file);
  try { const magic = Buffer.alloc(2); await handle.read(magic, 0, 2, 0); return magic.toString() === 'MZ'; }
  finally { await handle.close(); }
}

async function regularFile(file, label) {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${file}`);
  return info;
}

/** Validates the packaged Electron directory and renders the NSIS includes. */
export async function planWindowsInstaller({ appDir, helper, version, outFile, pluginsDir = DEFAULT_PLUGINS_DIR, installerIcon = '', uninstallerSign = '' }) {
  stableVersion(version);
  for (const [label, value] of [['app directory', appDir], ['helper', helper], ['output', outFile], ['plugins directory', pluginsDir]]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`An absolute ${label} path is required`);
  }
  if (!outFile.toLowerCase().endsWith('.exe')) throw new Error('The installer must be an .exe release asset');
  const { files, directories } = await listPackage(appDir);
  const has = parts => files.some(file => file.parts.join('\\').toLowerCase() === parts.toLowerCase());
  if (!has(MAIN_BINARY)) throw new Error(`The Electron executable must be named ${MAIN_BINARY} (the Tauri install's main binary)`);
  // Production packages carry the updater, its config and the legacy-storage
  // exporter (old WebView2 data is exported on first launch after upgrade).
  for (const required of ['resources\\app.asar', 'resources\\native\\tarobot-desktop-updater.exe', 'resources\\native\\update-config.json',
    'resources\\native\\tarobot-migration-exporter.exe']) {
    if (!has(required)) throw new Error(`Packaged App is missing ${required}`);
  }
  const layouts = ['host', 'resources\\host'].filter(dir => has(`${dir}\\node.exe`) && has(`${dir}\\dist\\src\\index.js`));
  // After an upgrade the helper removes a Tauri `host\` once `resources\host`
  // exists, so a package carrying both would lose its own files.
  if (layouts.includes('resources\\host') && files.some(file => file.parts.length > 1 && file.parts[0].toLowerCase() === 'host')) {
    throw new Error('Packaged App must not ship a top-level host\\ beside resources\\host');
  }
  const host = layouts[0];
  if (!host) throw new Error('Packaged App has no Host runtime (host\\node.exe or resources\\host\\node.exe with dist\\src\\index.js)');
  const reserved = files.find(file => file.parts.length === 1 && RESERVED.has(file.parts[0].toLowerCase()));
  if (reserved) throw new Error(`Packaged App must not contain installer-owned ${reserved.parts[0]}`);
  await regularFile(helper, 'Installer helper');
  if (!(await peFile(helper))) throw new Error('The installer helper must be a Windows executable');
  const plugin = path.join(pluginsDir, 'nsis_tauri_utils.dll');
  await regularFile(plugin, 'nsis_tauri_utils.dll');
  if (!pinned(await readFile(plugin))) throw new Error('nsis_tauri_utils.dll does not match the pinned tauri-bundler plugin (run setup-nsis)');
  if (installerIcon) await regularFile(installerIcon, 'Installer icon');

  for (const source of [appDir, helper, pluginsDir]) if (/["$]/.test(source)) throw new Error('Build paths must not contain " or $ (NSIS syntax)');
  const resources = files.filter(file => file.parts.join('\\') !== MAIN_BINARY)
    .map(file => ({ source: path.join(appDir, ...file.parts), target: file.parts.join('\\') }));
  resources.push({ source: helper, target: HELPER_BINARY });
  const bom = '\ufeff';
  const install = bom + [
    ...directories.map(parts => `  CreateDirectory "$INSTDIR\\${parts.join('\\')}"`),
    ...resources.map(item => `  File /a "/oname=${item.target}" "${item.source}"`),
  ].join('\n') + '\n';
  const uninstall = bom + resources.map(item => `  Delete "$INSTDIR\\${item.target}"`).join('\n') + '\n';
  // Deepest first; `RMDir` without /r only removes directories left empty.
  const ancestors = bom + [...directories].sort((a, b) => b.length - a.length || b.join('\\').localeCompare(a.join('\\')))
    .map(parts => `  RMDir /REBOOTOK "$INSTDIR\\${parts.join('\\')}"`).join('\n') + '\n';
  const bytes = files.reduce((sum, file) => sum + file.size, 0) + (await lstat(helper)).size;
  return {
    host, resources, includes: { install, uninstall, ancestors },
    defines: {
      TB_VERSION: version, TB_MAIN_BINARY: path.join(appDir, MAIN_BINARY), TB_HELPER: helper, TB_OUT_FILE: outFile,
      TB_PLUGINS_DIR: pluginsDir, TB_INSTALLER_ICON: installerIcon, TB_UNINSTALLER_SIGN: uninstallerSign,
      TB_ESTIMATED_SIZE: String(Math.ceil(bytes / 1024)),
    },
  };
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    // makensis 3.13 on macOS aborts (std::bad_alloc) without a UTF-8 locale.
    const env = process.platform === 'win32' ? process.env : { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
    const child = spawn(command, args, { ...options, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-64 * 1024); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-64 * 1024); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}\n${output}`)));
  });
}

/** Renders into a private scratch directory and runs makensis there. */
export async function buildWindowsInstaller(options, { makensis = findMakensis(), workDir } = {}) {
  const plan = await planWindowsInstaller(options);
  const scratch = workDir ?? await mkdtemp(path.join(os.tmpdir(), 'tarobot-nsis-'));
  try {
    await mkdir(scratch, { recursive: true });
    for (const name of TEMPLATE_FILES) await copyFile(path.join(TEMPLATE_DIR, name), path.join(scratch, name), constants.COPYFILE_EXCL);
    const includes = { TB_RESOURCES_INSTALL: 'resources-install.nsh', TB_RESOURCES_UNINSTALL: 'resources-uninstall.nsh', TB_RESOURCES_ANCESTORS: 'resources-ancestors.nsh' };
    await writeFile(path.join(scratch, includes.TB_RESOURCES_INSTALL), plan.includes.install, { flag: 'wx' });
    await writeFile(path.join(scratch, includes.TB_RESOURCES_UNINSTALL), plan.includes.uninstall, { flag: 'wx' });
    await writeFile(path.join(scratch, includes.TB_RESOURCES_ANCESTORS), plan.includes.ancestors, { flag: 'wx' });
    await mkdir(path.dirname(options.outFile), { recursive: true });
    await rm(options.outFile, { force: true });
    const defines = { ...plan.defines, ...includes };
    const log = await run(makensis, ['-V2', '-INPUTCHARSET', 'UTF8', ...Object.entries(defines).map(([key, value]) => `-D${key}=${value}`), 'installer.nsi'], { cwd: scratch });
    if (!(await peFile(options.outFile))) throw new Error('makensis did not produce a PE installer');
    return { installer: options.outFile, host: plan.host, files: plan.resources.length + 1, log };
  } finally {
    if (!workDir) await rm(scratch, { recursive: true, force: true });
  }
}

const UPDATER_CRATE = fileURLToPath(new URL('../src-desktop-updater/Cargo.toml', import.meta.url));
const WINDOWS_TARGET = 'x86_64-pc-windows-msvc';

/** Release builds of both Windows binaries. Off Windows this uses cargo-xwin
 * (as the Tauri Windows build did). A lab-feature binary is refused. */
export async function buildNativeWindows({ targetDir, cargo = 'cargo' }) {
  if (typeof targetDir !== 'string' || !path.isAbsolute(targetDir)) throw new Error('An absolute --target-dir is required');
  const args = process.platform === 'win32'
    ? ['build', '--release', '--locked', '--target', WINDOWS_TARGET, '--bins', '--manifest-path', UPDATER_CRATE]
    : ['xwin', 'build', '--release', '--locked', '--target', WINDOWS_TARGET, '--bins', '--manifest-path', UPDATER_CRATE];
  // Run from the crate so its .cargo/config.toml applies, and state the static
  // CRT explicitly as well: the helper must run alone from $PLUGINSDIR.
  const flagsKey = 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS';
  const inherited = process.env[flagsKey] ?? '';
  const rustflags = /target-feature=\+crt-static/.test(inherited) ? inherited : `${inherited} -C target-feature=+crt-static`.trim();
  await new Promise((resolve, reject) => {
    const child = spawn(cargo, args, { cwd: path.dirname(UPDATER_CRATE), stdio: 'inherit', shell: false,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir, [flagsKey]: rustflags } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`cargo exited ${code}`)));
  });
  const release = path.join(targetDir, WINDOWS_TARGET, 'release');
  const result = { updater: path.join(release, 'tarobot-desktop-updater.exe'), helper: path.join(release, HELPER_BINARY) };
  for (const file of Object.values(result)) if (!(await peFile(file))) throw new Error(`Missing Windows executable ${file}`);
  if ((await readFile(result.updater)).includes(Buffer.from('TAROBOT_UPDATER_LAB'))) throw new Error('Refusing a lab-feature updater build');
  // A dynamic CRT names its DLLs in the import table; static builds do not.
  for (const file of Object.values(result)) {
    const lower = (await readFile(file)).toString('latin1').toLowerCase();
    if (lower.includes('vcruntime140') || lower.includes('api-ms-win-crt-')) throw new Error(`${path.basename(file)} links the C runtime dynamically`);
  }
  return result;
}

async function main() {
  const command = process.argv[2];
  if (command === 'setup-nsis') {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { 'plugins-dir': { type: 'string' } } });
    console.log(JSON.stringify(await setupNsisPlugins({ pluginsDir: values['plugins-dir'] ? path.resolve(values['plugins-dir']) : DEFAULT_PLUGINS_DIR })));
    return;
  }
  if (command === 'native') {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { 'target-dir': { type: 'string' }, cargo: { type: 'string' } } });
    console.log(JSON.stringify(await buildNativeWindows({ targetDir: values['target-dir'] && path.resolve(values['target-dir']), cargo: values.cargo ?? 'cargo' })));
    return;
  }
  if (command !== 'installer') throw new Error('Usage: windows-electron-installer.mjs setup-nsis|native|installer [options]');
  const { values } = parseArgs({ args: process.argv.slice(3), options: {
    'app-dir': { type: 'string' }, helper: { type: 'string' }, version: { type: 'string' }, out: { type: 'string' },
    'plugins-dir': { type: 'string' }, icon: { type: 'string' }, 'uninstaller-sign': { type: 'string' }, makensis: { type: 'string' },
  } });
  const resolve = value => value && path.resolve(value);
  const result = await buildWindowsInstaller({
    appDir: resolve(values['app-dir']), helper: resolve(values.helper), version: values.version, outFile: resolve(values.out),
    pluginsDir: resolve(values['plugins-dir']) ?? DEFAULT_PLUGINS_DIR, installerIcon: resolve(values.icon) ?? '', uninstallerSign: values['uninstaller-sign'] ?? '',
  }, { makensis: values.makensis ?? findMakensis() });
  console.log(JSON.stringify({ installer: result.installer, host: result.host, files: result.files }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
