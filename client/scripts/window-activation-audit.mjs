import { macosScratch, macosBuildEnvironment } from '../../scripts/macos-artifact-paths.mjs';
// Real macOS lifecycle acceptance against the shared production window module.
// Disposable source copy avoids altering a prepared Windows host/ payload.
import { cp, mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { runAuditChild } from './native-audit-runner.mjs';

if (process.platform !== 'darwin') throw new Error('This acceptance requires macOS');
const source = fileURLToPath(new URL('../src-tauri/', import.meta.url));
const output = path.resolve(process.argv[2] ?? await mkdtemp(path.join(os.tmpdir(), 'tarobot-window-receipt-')));
await mkdir(output, { recursive: true });
const scratch = await macosScratch('tarobot-window-audit-');
const native = path.join(scratch, 'client/src-tauri');
const bundle = path.join(scratch, 'TaroBot Window Acceptance.app');
const receipt = path.join(output, 'result.json');
const env = { ...macosBuildEnvironment(scratch), TAROBOT_WINDOW_AUDIT_BUNDLE: bundle, TAROBOT_WINDOW_AUDIT_RESULT: receipt,
  TAURI_CONFIG: JSON.stringify({ bundle: { resources: null } }) };
const run = (command, args, name, timeout) => runAuditChild(command, args, {
  cwd: native, env, logPath: path.join(output, name), timeout,
});
console.log(`Window acceptance logs: ${output}`);
try {
  await mkdir(native, { recursive: true });
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs', 'build', 'src', 'audit', 'capabilities',
    'icons', 'Info.plist', 'host-launcher', 'fixtures', 'tests', 'tauri.conf.json', 'tauri.windows.conf.json', 'windows']) {
    await cp(path.join(source, name), path.join(native, name), { recursive: true });
  }
  await mkdir(path.join(scratch, 'tests/fixtures'), { recursive: true });
  for (const name of ['device-action-vector.json', 'device-network-action-vector.json']) {
    await cp(path.resolve(source, '../../tests/fixtures', name), path.join(scratch, 'tests/fixtures', name));
  }
  // No application data/assets needed for compile checks; the audit embeds its
  // own page and uses an incognito WebView with a distinct application identity.
  await mkdir(path.join(scratch, 'client/dist'));
  await writeFile(path.join(scratch, 'client/dist/index.html'), '<!doctype html><title>Compile check only</title>');
  await run('cargo', ['check', '--offline', '--locked', '--bin', 'tarocub-client'], 'production-check.log', 300_000);
  await run('cargo', ['test', '--offline', '--locked', '--bin', 'tarocub-client'], 'native-tests.log', 300_000);
  await run('cargo', ['build', '--offline', '--locked', '--features', 'native-transport-audit', '--bin', 'window-audit'], 'audit-build.log', 300_000);
  const target = env.CARGO_TARGET_DIR;
  const executable = path.join(bundle, 'Contents/MacOS/window-audit');
  await mkdir(path.dirname(executable), { recursive: true });
  await cp(path.join(target, 'debug/window-audit'), executable);
  await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>window-audit</string>
<key>CFBundleIdentifier</key><string>com.tarocub.window-audit</string>
<key>CFBundleName</key><string>TaroBot Window Acceptance</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', bundle], 'audit-sign.log', 30_000);
  await run(executable, [], 'audit-runtime.log', 90_000);
  const result = JSON.parse(await readFile(receipt, 'utf8'));
  if (!result.ok || !result.baseline_hidden_reproduced || result.checks.length !== 11) {
    throw new Error('Window lifecycle acceptance failed; inspect result.json');
  }
  console.log(JSON.stringify(result, null, 2));
} finally { console.log('Disposable app retained below .noindex for age/active-process guarded trash cleanup:', scratch); }
