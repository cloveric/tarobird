import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildUpstreamEditor } from '../integrations/infinite-canvas/build-editor.mjs';
import { patchUpstream } from '../integrations/infinite-canvas/patch-upstream.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integration = path.join(repoRoot, 'integrations/infinite-canvas');
const catalog = JSON.parse(await readFile(path.join(repoRoot, 'client/src/infinite-canvas-catalog.json'), 'utf8'));
const candidateVersion = '1.0.1-preview.1';
const files = [
  'LICENSE', 'VERSION', 'CHANGELOG.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'apps/web', 'packages/workbench', 'packages/shared', 'packages/model-runtime', 'packages/plugin-sdk',
  'plugins/panorama', 'plugins/multi-format-renderer', 'plugins/template',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const command = (file, args, options) => execFileSync(file, args, { stdio: 'inherit', ...options });

export async function buildInfiniteCanvasPlugin({
  sourceRepository = process.env.TAROBIRD_INFINITE_CANVAS_SOURCE,
  candidate = false,
  outDir = path.join(repoRoot, 'dist/plugins', catalog.id, candidate ? candidateVersion : catalog.version),
  refreshNotices = false,
} = {}) {
  const upstream = JSON.parse(await readFile(path.join(integration, 'UPSTREAM.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(upstream.commit) || upstream.repository !== 'https://github.com/basketikun/infinite-canvas') throw Error('infinite_canvas_source_pin_invalid');

  if (catalog.source.commit !== upstream.commit || `https://github.com/${catalog.source.repository}` !== upstream.repository ||
      catalog.attribution.author !== upstream.author || catalog.attribution.license !== upstream.license) {
    throw Error('infinite_canvas_catalog_source_mismatch');
  }

  const stage = await mkdtemp(path.join(os.tmpdir(), 'tarobird-canvas-source-'));
  try {
    let source = sourceRepository;
    if (!source) {
      source = path.join(stage, 'repository');
      command('git', ['init', '--quiet', '--bare', source]);
      command('git', ['-C', source, '-c', 'fetch.recurseSubmodules=false', 'fetch', '--depth=1', '--no-tags', upstream.repository, upstream.commit]);
    }
    const archive = path.join(stage, 'upstream.tar');
    const extracted = path.join(stage, 'source');
    await mkdir(extracted);
    command('git', ['-C', source, 'archive', '--format=tar', '--output', archive, upstream.commit, ...files]);
    command('tar', ['-xf', archive, '-C', extracted]);
    if (sha256(await readFile(path.join(extracted, 'pnpm-lock.yaml'))) !== upstream.lockSha256) throw Error('infinite_canvas_lock_hash_mismatch');
    if (!(await readFile(path.join(extracted, 'LICENSE'))).equals(await readFile(path.join(integration, 'LICENSE')))) throw Error('infinite_canvas_license_mismatch');

    const env = { ...process.env, npm_config_registry: 'https://registry.npmjs.org' };
    const pnpmVersion = execFileSync('pnpm', ['--version'], { cwd: extracted, env, encoding: 'utf8' }).trim();
    if (`pnpm@${pnpmVersion}` !== upstream.packageManager) throw Error('infinite_canvas_pnpm_version_mismatch');
    command('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: extracted, env });
    const version = candidate ? candidateVersion : catalog.version;
    await patchUpstream(extracted, version);
    const { bytes: bundle, notices } = await buildUpstreamEditor(extracted);

    const noticeFile = path.join(integration, 'notices/BUNDLED_DEPENDENCIES.txt');
    if (refreshNotices) {
      await writeFile(noticeFile, notices);
      return { noticeFile };
    }
    if (notices !== await readFile(noticeFile, 'utf8')) throw Error('infinite_canvas_dependency_notices_out_of_date');

    const digest = sha256(bundle);
    const sizeBytes = bundle.byteLength;
    const manifest = { ...catalog, version, artifact: { sha256: digest, sizeBytes } };
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'bundle.html'), bundle);
    await writeFile(path.join(outDir, 'THIRD_PARTY_NOTICES.txt'), notices);
    await writeFile(path.join(outDir, 'LICENSE'), await readFile(path.join(extracted, 'LICENSE')));
    await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { sha256: digest, sizeBytes, outDir };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await buildInfiniteCanvasPlugin({ candidate: process.argv.includes('--candidate'), refreshNotices: process.argv.includes('--refresh-notices') })));
}
