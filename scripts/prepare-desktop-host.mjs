import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import AdmZip from 'adm-zip';
import { preparationEnvironment } from './build-environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const { values } = parseArgs({ options: { platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: process.arch } } });
const platform = values.platform, arch = values.arch;
if (!['darwin-arm64', 'win32-x64'].includes(`${platform}-${arch}`)) throw new Error('Verified host targets: darwin-arm64, win32-x64 (also usable under Windows ARM64 x64 emulation)');
const windows = platform === 'win32';
const version = 'v24.22.2', basename = `node-${version}-${windows ? 'win' : platform}-${arch}`, archive = basename + (windows ? '.zip' : '.tar.gz');
const cache = process.env.TAROBOT_NODE_CACHE || path.join(root, '.desktop-runtime-cache');
await mkdir(cache, { recursive: true });
async function download(url, file, expected) {
  let bytes = await readFile(file).catch(() => undefined);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Runtime archive integrity failed');
    await writeFile(file, bytes);
  }
  return bytes;
}
// Pinned from https://nodejs.org/dist/v24.22.2/SHASUMS256.txt. A compromised
// download endpoint must not be able to replace both archive and checksum.
const expected = {
  'node-v24.22.2-darwin-arm64.tar.gz': 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
  'node-v24.22.2-win-x64.zip': 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2',
}[archive];
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Node archive checksum unavailable');
const archiveFile = path.join(cache, archive);
const bytes = await download(`https://nodejs.org/dist/${version}/${archive}`, archiveFile, expected);
if (windows) new AdmZip(bytes).extractAllTo(cache, true);
else execFileSync('tar', ['-xzf', archiveFile, '-C', cache]);
const extracted = path.join(cache, basename), node = path.join(extracted, windows ? 'node.exe' : 'bin/node');
execFileSync(process.execPath, ['scripts/package-standalone.mjs'], { stdio: 'inherit' });
const output = path.join(root, 'client/src-tauri/host');
await rm(output, { recursive: true, force: true });
await cp('dist/standalone-package', output, { recursive: true });
// Use npm's JS entrypoint, including on Windows: no cmd.exe interpolation and
// no builder-host install scripts allowed to produce the wrong native addon.
const npm = path.join(extracted, windows ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
const env = { ...preparationEnvironment(), PATH: path.dirname(node) + path.delimiter + process.env.PATH };
execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund', ...(windows ? ['--ignore-scripts', '--os=win32', '--cpu=x64'] : [])], { cwd: output, stdio: 'inherit', env });
if (windows) {
  // N-API binary published by node-sqlite3 6.0.1. Fail closed on a changed
  // upstream asset; never silently fall back to compiling for the Mac builder.
  const sqliteArchive = 'sqlite3-v6.0.1-napi-v6-win32-x64.tar.gz';
  const sqliteHash = 'e0bbbb6e43b45378e6d6e2c5cc096e61e4c8932dbc2d2c9c08b8e3aaa80c9adf';
  const sqlite = path.join(output, 'node_modules/sqlite3');
  if (JSON.parse(await readFile(path.join(sqlite, 'package.json'), 'utf8')).version !== '6.0.1') throw new Error('Update the verified SQLite binary with its dependency');
  await download(`https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1/${sqliteArchive}`, path.join(cache, sqliteArchive), sqliteHash);
  execFileSync('tar', ['-xzf', path.join(cache, sqliteArchive), '-C', sqlite]);
  async function checkNative(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await checkNative(file);
      else if (entry.name.endsWith('.node') || entry.name.endsWith('.dll')) {
        const data = await readFile(file), pe = data.length > 64 ? data.readUInt32LE(60) : 0;
        if (!pe || pe + 6 > data.length || data.toString('ascii', pe, pe + 4) !== 'PE\0\0' || data.readUInt16LE(pe + 4) !== 0x8664) throw new Error(`Wrong Windows x64 addon: ${file}`);
      }
    }
  }
  await checkNative(path.join(output, 'node_modules'));
}
await cp(node, path.join(output, windows ? 'node.exe' : 'node'));
if (!windows) await chmod(path.join(output, 'node'), 0o755);
let hostLauncher;
if (windows) {
  execFileSync(process.execPath, ['scripts/build-host-launcher.mjs', '--output', path.join(output, 'bin')], { cwd: root, stdio: 'inherit' });
  hostLauncher = { file: 'bin/tarobot-host-launcher.exe', sha256: createHash('sha256').update(await readFile(path.join(output, 'bin/tarobot-host-launcher.exe'))).digest('hex'), platform, arch };
}
await cp(path.join(extracted, 'LICENSE'), path.join(output, 'NODE-LICENSE'));
if (platform === process.platform && arch === process.arch) {
  execFileSync(node, ['--input-type=module', '-e', 'await import("sqlite3"); await import("./dist/src/hub/desktop.js"); console.log("Bundled host dependencies load successfully")'], { cwd: output, stdio: 'inherit', env });
} else console.log('Cross-built host: native execution is required on the target OS.');
await writeFile(path.join(output, 'runtime-receipt.json'), JSON.stringify({ node: version, archive, sha256: expected, platform, arch, sdk: 'standalone-no-feishu', ...(hostLauncher ? { hostLauncher } : {}) }, null, 2));
console.log(`Desktop host resource bundle ready (${platform}-${arch}).`);
