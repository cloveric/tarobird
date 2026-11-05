// Real persistent WebView profile -> exporter -> Electron. Every process uses a
// unique acceptance identity; production data is untouched.
//   macOS:   persistent WKWebView seed; the bare reader runs inside a clone of
//            the packaged Electron App; packaged-migration.smoke.mjs imports it.
//   Windows: persistent WebView2 seed; a development Electron package launches
//            and its main process starts the exporter, because the exporter's
//            SourceGuard accepts only an Electron main `tarocub-client.exe` as
//            parent. The import is then checked for content in that window.
//   node scripts/desktop-persisted-migration-audit.mjs <fresh .noindex lab> <packaged App: TaroBot.app | Electron package directory>
import { build } from 'esbuild';
import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isolatedRoot } from '../electron/isolation.mjs';
import { LegacyReader } from '../electron/legacy-reader.mjs';
import { MigrationStore } from '../electron/migration.mjs';
import { runAuditChild } from './native-audit-runner.mjs';
const client = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';
if (!['darwin', 'win32'].includes(process.platform) || !process.argv[2] || !process.argv[3]) throw new Error('macOS or Windows, explicit lab and packaged Electron App required');
const root = await isolatedRoot(process.argv[2]), target = await isolatedRoot(process.env.CARGO_TARGET_DIR);
const bundleId = `com.tarobot.migration.acceptance.p${randomUUID().replaceAll('-', '')}`;
await writeFile(path.join(root, 'identity.json'), JSON.stringify({ bundleId, productionDataAccess: false }));
const dist = path.resolve(client, '../.migration-audit-dist'); await mkdir(dist, { recursive: true });
await build({ entryPoints: [path.join(client, 'e2e/fixtures/desktop-migration-native.ts')], bundle: true, outfile: path.join(dist, 'migration.js'),
  format: 'esm', platform: 'browser', target: 'safari17', define: { 'import.meta.env': '{"PROD":true,"DEV":false,"MODE":"test"}' } });
await writeFile(path.join(dist, 'index.html'), '<!doctype html><meta charset="utf-8"><title>TaroBot Migration Acceptance</title><script type="module" src="/migration.js"></script><p>正在写入隔离的旧版数据…</p>');
const env = { ...process.env, TAURI_CONFIG: JSON.stringify({ identifier: bundleId, bundle: { resources: null } }), TAROBOT_MIGRATION_AUDIT_ROOT: root, TAROBOT_MIGRATION_AUDIT_PERSIST: '1' };
const run = (file, args, name, timeout = 300000) => runAuditChild(file, args, { cwd: path.join(client, 'src-tauri'), env, logPath: path.join(root, name), timeout });
// A disposable Windows runner starts with an empty cargo cache.
const cargo = (features, bin, name) => run('cargo', ['build', ...(windows ? [] : ['--offline']), '--locked', '--features', features, '--bin', bin], name, windows ? 1800000 : 300000);
await cargo('native-transport-audit', 'migration-audit', 'seed-build.log');
let seedExe;
if (windows) seedExe = path.join(target, 'debug', 'migration-audit.exe'); // WebView2 identity is the compiled identifier
else {
  const seed = path.join(root, 'TaroBot Legacy Seed.app'); seedExe = path.join(seed, 'Contents/MacOS/migration-audit');
  await mkdir(path.dirname(seedExe), { recursive: true }); await cp(path.join(target, 'debug/migration-audit'), seedExe);
  await writeFile(path.join(seed, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>migration-audit</string><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>TaroBot Legacy Seed</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', seed], 'seed-sign.log', 30000);
}
await run(seedExe, [], 'seed-runtime.log', 75000);
const receipt = JSON.parse(await readFile(path.join(root, 'tauri-export.json'), 'utf8'));
// Tauri 2 serves the App from tauri://localhost on macOS and http://tauri.localhost on Windows.
if (!receipt.passed || !receipt.seeded || receipt.origin !== (windows ? 'http://tauri.localhost' : 'tauri://localhost')) throw new Error('persistent_source_failed');
if (windows) await run(process.execPath, [path.join(client, 'scripts/build-migration-exporter.mjs')], 'reader-assets.log', 120000);
await cargo('native-transport-audit,desktop-migration-exporter', 'tarobot-migration-exporter', 'reader-build.log');

if (!windows) {
  const bundle = path.join(root, 'TaroBot.app');
  await run('/bin/cp', ['-cR', process.argv[3], bundle], 'electron-clone.log');
  await run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId, path.join(bundle, 'Contents/Info.plist')], 'electron-identity.log', 30000);
  const readerPath = path.join(bundle, 'Contents/MacOS/tarobot-migration-exporter');
  await cp(path.join(target, 'debug/tarobot-migration-exporter'), readerPath);
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], 'electron-sign.log', 60000);
  const reader = new LegacyReader(readerPath, { checkOldDesktop: async () => false, environment: () => env });
  const exportId = await reader.run();
  const manifest = await new MigrationStore(path.join(root, 'native-state')).verify(exportId);
  await writeFile(path.join(root, 'verification.json'), JSON.stringify({ passed: true, bundleId, bundle, source: receipt, exportId, records: manifest.totals.records, bytes: manifest.totals.bytes, sourceCommit: process.env.TAROBOT_SOURCE_COMMIT ?? 'working-tree' }, null, 2));
  // Existing packaged import test consumes this established receipt format.
  await writeFile(path.join(root, 'tauri-export.json'), JSON.stringify({ ...receipt, result: { state: 'exported', exportId } }));
  console.log(JSON.stringify({ passed: true, bundleId, exportId, records: manifest.totals.records, root }));
} else {
  const { windowsElectronImport } = await import('../electron/tests/windows-persisted-import.mjs');
  const result = await windowsElectronImport({ root, bundleId, receipt, source: path.resolve(process.argv[3]), exporter: path.join(target, 'debug', 'tarobot-migration-exporter.exe') });
  await writeFile(path.join(root, 'verification.json'), JSON.stringify({ ...result, sourceCommit: process.env.TAROBOT_SOURCE_COMMIT ?? 'working-tree' }, null, 2));
  console.log(JSON.stringify({ passed: true, bundleId, exportId: result.exportId, records: result.records, root }));
}
