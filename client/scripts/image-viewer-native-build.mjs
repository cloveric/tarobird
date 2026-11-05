import { noIndexDirectory, macosBuildEnvironment } from '../../scripts/macos-artifact-paths.mjs';
// Build a disposable native fixture from the shared viewer. Open the returned
// .app through normal UI; no production Host or application state is used.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, cp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runAuditChild } from './native-audit-runner.mjs';
if (process.platform !== 'darwin') throw new Error('Native fixture currently packages a macOS app');
const client = fileURLToPath(new URL('../', import.meta.url));
const output = noIndexDirectory(process.argv[2] ?? (() => { throw new Error('External artifact directory required'); })());
const dist = path.resolve(client, '../.image-viewer-audit-dist');
await mkdir(output, { recursive: true });
await build({ configFile: false, root: client, base: '/', plugins: [react()], build: { outDir: dist, emptyOutDir: true,
  rollupOptions: { input: path.join(client, 'e2e/fixtures/image-viewer-native.html') } } });
await cp(path.join(dist, 'e2e/fixtures/image-viewer-native.html'), path.join(dist, 'index.html'));
const env = { ...macosBuildEnvironment(path.resolve(client, '..')), TAURI_CONFIG: JSON.stringify({ bundle: { resources: null } }) };
await runAuditChild('cargo', ['build', '--offline', '--locked', '--features', 'native-transport-audit', '--bin', 'image-viewer-audit'], {
  cwd: path.join(client, 'src-tauri'), env, logPath: path.join(output, 'build.log'), timeout: 300000,
});
const bundle = path.join(output, 'TaroBot Image Viewer Acceptance.app');
const executable = path.join(bundle, 'Contents/MacOS/image-viewer-audit');
await mkdir(path.dirname(executable), { recursive: true });
await cp(path.join(env.CARGO_TARGET_DIR, 'debug/image-viewer-audit'), executable);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>image-viewer-audit</string>
<key>CFBundleIdentifier</key><string>com.tarocub.image-viewer-audit</string>
<key>CFBundleName</key><string>TaroBot Image Viewer Acceptance</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSEnvironment</key><dict>
<key>TAROBOT_IMAGE_AUDIT_RESULT</key><string>${escape(path.join(output, 'interactions.ndjson'))}</string></dict></dict></plist>`);
await runAuditChild('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { cwd: output, env, logPath: path.join(output, 'sign.log'), timeout: 30000 });
console.log(bundle);
