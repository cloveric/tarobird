// Real Tauri export from a non-persistent WebView (WKWebView on macOS,
// WebView2 on Windows); output is consumed by the packaged Electron import
// smoke (electron/tests/packaged-migration.smoke.mjs). The seed and export
// run in one isolated audit process: no old App profile, exporter binary or
// SourceGuard is involved (see desktop-persisted-migration-audit.mjs).
import { build } from 'esbuild';
import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedRoot } from '../electron/isolation.mjs';
import { runAuditChild } from './native-audit-runner.mjs';
const client = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';
if (!['darwin', 'win32'].includes(process.platform) || !process.argv[2]) throw new Error('macOS or Windows and explicit lab required');
const root = await isolatedRoot(process.argv[2]);
const target = await isolatedRoot(process.env.CARGO_TARGET_DIR);
const dist = path.resolve(client, '../.migration-audit-dist'); await mkdir(dist, { recursive: true });
await build({ entryPoints: [path.join(client, 'e2e/fixtures/desktop-migration-native.ts')], bundle: true, outfile: path.join(dist, 'migration.js'),
  format: 'esm', platform: 'browser', target: 'safari17', define: { 'import.meta.env': '{"PROD":true,"DEV":false,"MODE":"test"}' } });
await writeFile(path.join(dist, 'index.html'), '<!doctype html><meta charset="utf-8"><title>TaroBot Migration Acceptance</title><script type="module" src="/migration.js"></script><p>正在验证隔离数据迁移…</p>');
const env = { ...process.env, TAURI_CONFIG: JSON.stringify({ bundle: { resources: null } }), TAROBOT_MIGRATION_AUDIT_ROOT: root };
// A disposable Windows runner starts with an empty cargo cache.
await runAuditChild('cargo', ['build', ...(windows ? [] : ['--offline']), '--locked', '--features', 'native-transport-audit', '--bin', 'migration-audit'], {
  cwd: path.join(client, 'src-tauri'), env, logPath: path.join(root, 'build.log'), timeout: windows ? 1800000 : 300000,
});
let executable;
if (windows) executable = path.join(target, 'debug', 'migration-audit.exe'); // WebView2 identity is the compiled identifier
else {
  const bundle = path.join(root, 'TaroBot Migration Acceptance.app'); executable = path.join(bundle, 'Contents/MacOS/migration-audit');
  await mkdir(path.dirname(executable), { recursive: true }); await cp(path.join(target, 'debug/migration-audit'), executable);
  await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>migration-audit</string><key>CFBundleIdentifier</key><string>com.tarobot.migration.acceptance</string><key>CFBundleName</key><string>TaroBot Migration Acceptance</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  await runAuditChild('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { cwd: root, env, logPath: path.join(root, 'sign.log'), timeout: 30000 });
}
await runAuditChild(executable, [], { cwd: root, env, logPath: path.join(root, 'runtime.log'), timeout: 75000 });
const receipt = JSON.parse(await readFile(path.join(root, 'tauri-export.json'), 'utf8'));
if (!receipt.passed) throw new Error('native_export_failed');
console.log(JSON.stringify({ root, platform: process.platform, persistent: false, ...receipt }));
