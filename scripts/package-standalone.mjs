import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyIntegrationAssets, integrationAssets } from './integration-assets.mjs';
import { verifyHostLauncher } from './verify-host-launcher.mjs';
const output = path.resolve('dist/standalone-package');
await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
const graph = JSON.parse(await readFile('dist/standalone-graph.json', 'utf8'));
for (const source of Object.keys(graph.inputs)) {
 const compiled = source.replace(/\.ts$/, '.js');
 const from = path.join('dist', compiled), to = path.join(output, 'dist', compiled);
 await mkdir(path.dirname(to), { recursive: true }); await cp(from, to);
}
await cp('dist/relay-runtime.mjs', path.join(output, 'dist/relay-runtime.mjs'));
await cp('dist/standalone-graph.json', path.join(output, 'standalone-graph.json'));
await cp('client/dist', path.join(output, 'client/dist'), { recursive: true });
await cp('bin', path.join(output, 'bin'), { recursive: true });
// cargo-xwin builds the same x64 GUI launcher on macOS/Linux. Failure must stop
// packaging; a platform-independent npm archive may be installed on Windows.
execFileSync(process.execPath, ['scripts/build-host-launcher.mjs', '--output', path.join(output, 'bin')], { stdio: 'inherit' });
await verifyHostLauncher(output);
for (const name of ['README.md', 'README.zh-CN.md', 'LICENSE', 'LICENSING.md', 'deepseek-harness-plugin/LICENSE', 'docs/host-cli.md', 'docs/host-cli-update.md']) { await mkdir(path.dirname(path.join(output, name)), { recursive: true }); await cp(name, path.join(output, name)); }
await copyIntegrationAssets(process.cwd(), output);
await cp('scripts/verify-host-launcher.mjs', path.join(output, 'scripts/verify-host-launcher.mjs'));
const source = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = { name: source.name, version: source.version, license: source.license, private: true, type: 'module', bin: source.bin, tarobotHostUpdate: source.tarobotHostUpdate, tarobotHubSchema: source.tarobotHubSchema, tarobotHostCapabilities: source.tarobotHostCapabilities, engines: source.engines, description: source.description, dependencies: source.dependencies, overrides: Object.fromEntries(Object.entries(source.overrides ?? {}).filter(([key]) => key !== 'vite')), files: ['bin', 'dist', 'client/dist', 'standalone-graph.json', 'npm-shrinkwrap.json', 'README.zh-CN.md', 'LICENSING.md', 'deepseek-harness-plugin/LICENSE', 'docs/host-cli.md', 'docs/host-cli-update.md', 'scripts/verify-host-launcher.mjs', ...integrationAssets], scripts: { start: 'node dist/src/index.js', prepack: 'node scripts/verify-host-launcher.mjs' } };
await writeFile(path.join(output, 'package.json'), JSON.stringify(manifest, null, 2)+'\n');
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
lock.name = manifest.name;
lock.packages[''] = { name: manifest.name, version: manifest.version, license: manifest.license, dependencies: manifest.dependencies, engines: manifest.engines, bin: manifest.bin };
await writeFile(path.join(output, 'npm-shrinkwrap.json'), JSON.stringify(lock, null, 2)+'\n');
console.log(`Standalone release directory: ${output}`);
