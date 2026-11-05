import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedRoot } from '../electron/isolation.mjs';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('electron/package.json'));

/** Download the pinned, checksum-verified runtime directly to a physical
 * .noindex cache. Never run electron/install.js: it extracts into node_modules. */
export async function electronRuntime(cacheDirectory) {
  const root = await isolatedRoot(cacheDirectory);
  const { version } = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const executable = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron';
  const target = path.join(root, `${version}-${process.platform}-${process.arch}`);
  const binary = path.join(target, executable);
  try {
    await access(binary);
    if ((await readFile(path.join(target, 'version'), 'utf8')).trim().replace(/^v/, '') !== version) throw new Error('electron_cache_version_mismatch');
    return binary;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.join(root, 'downloads'), { recursive: true });
  const electronRequire = createRequire(path.join(packageRoot, 'package.json'));
  const { downloadArtifact } = electronRequire('@electron/get');
  const { extract } = electronRequire('@electron-internal/extract-zip');
  const checksums = JSON.parse(await readFile(path.join(packageRoot, 'checksums.json'), 'utf8'));
  const zip = await downloadArtifact({ version, artifactName: 'electron', platform: process.platform, arch: process.arch,
    checksums, cacheRoot: path.join(root, 'downloads'), tempDirectory: root,
    mirrorOptions: { mirror: 'https://github.com/electron/electron/releases/download/', customDir: `v${version}` },
  });
  const staging = await mkdtemp(path.join(root, 'extract-'));
  await extract(zip, { dir: staging });
  await access(path.join(staging, executable));
  if ((await readFile(path.join(staging, 'version'), 'utf8')).trim().replace(/^v/, '') !== version) throw new Error('electron_extracted_version_mismatch');
  await rename(staging, target);
  return binary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--cache-root') throw new Error('usage: node scripts/electron-runtime.mjs --cache-root <absolute .noindex directory>');
  console.log(JSON.stringify({ executable: await electronRuntime(args[1]) }));
}
