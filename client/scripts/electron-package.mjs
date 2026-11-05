import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { sign } from '@electron/osx-sign';
import { readFile, writeFile, mkdir, cp, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedRoot } from '../electron/isolation.mjs';
import { ELECTRON_RIGHTS, electronSigningRole, credentialCodeIdentifier, electronSignable } from './electron-signing-policy.mjs';
import { entitlementsPlist } from './macos-signing.mjs';
import { verifyElectronShell } from './verify-electron-shell.mjs';

const exec = promisify(execFile), client = fileURLToPath(new URL('..', import.meta.url));
// ESM main also bundles CommonJS dependencies such as ws. Give esbuild's
// generated require shim a module-local Node require, never a renderer global.
export const desktopMainBundleOptions = Object.freeze({
  bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['electron', '*.node'],
  banner: { js: "import { createRequire as __tarobotCreateRequire } from 'node:module'; const require = __tarobotCreateRequire(import.meta.url);" },
});
export async function packageDesktop(options) {
  const root = await isolatedRoot(options.out), cache = await isolatedRoot(options.cache);
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('unsupported_desktop_target');
  if (platform === 'darwin' && process.platform !== 'darwin') throw new Error('macos_packaging_requires_macos');
  const production = options.production === true;
  const developerSigned = production || options.signedAcceptance === true;
  if (developerSigned && platform === 'darwin' && (!options.identity || options.identity === '-')) throw new Error('developer_signing_identity_required');
  if (production && (platform === 'darwin' && !options.identity || !options.sourceCommit)) throw new Error('production_signing_and_source_required');
  if (production && !options.updater) throw new Error('production_updater_required');
  if (production && !options.exporter) throw new Error('production_migration_exporter_required');
  const source = path.join(root, 'application'), native = path.join(root, 'native'), host = path.join(root, 'host');
  await mkdir(source, { recursive: false }); await mkdir(native);
  const pkg = JSON.parse(await readFile(path.join(client, 'package.json'), 'utf8'));
  const nativeConfig = JSON.parse(await readFile(path.join(client, 'src-tauri/tauri.conf.json'), 'utf8'));
  const helper = await realpath(options.helper), addon = await realpath(options.addon);
  for (const file of [helper, addon]) if (!(await stat(file)).isFile()) throw new Error('native_input_missing');
  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: client })).stdout.trim();
  const dirty = !!(await exec('git', ['status', '--porcelain'], { cwd: client })).stdout.trim();
  if (production && (options.sourceCommit !== head || dirty)) throw new Error('production_requires_clean_bound_source');
  await Promise.all([
    build({ ...desktopMainBundleOptions, entryPoints: [path.join(client, 'electron/main.mjs')], outfile: path.join(source, 'main.mjs') }),
    build({ entryPoints: [path.join(client, 'electron/preload.mjs')], outfile: path.join(source, 'preload.cjs'), bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron'] }),
    // Remote screen (#99): isolated capture renderer page and its port-only preload.
    build({ entryPoints: [path.join(client, 'electron/screen-capture-preload.mjs')], outfile: path.join(source, 'screen-capture-preload.cjs'), bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron'] }),
    build({ entryPoints: [path.join(client, 'electron/screen-capture-page.mjs')], outfile: path.join(source, 'screen-capture/capture.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome140' }),
    mkdir(path.join(source, 'screen-capture'), { recursive: true }).then(() => Promise.all([
      cp(path.join(client, 'electron/screen-capture.html'), path.join(source, 'screen-capture/capture.html')),
      cp(path.join(client, 'electron/screen-indicator.html'), path.join(source, 'screen-capture/indicator.html')),
      cp(path.join(client, 'electron/screen-indicator-page.js'), path.join(source, 'screen-capture/indicator.js'))])),
    cp(path.join(client, 'dist'), path.join(source, 'dist'), { recursive: true, dereference: true }),
    cp(path.join(client, 'src-tauri/icons/tray-macos.png'), path.join(source, 'tray-macos.png')),
    cp(path.join(client, 'src-tauri/icons/icon.png'), path.join(source, 'icon.png')),
    cp(helper, path.join(native, platform === 'win32' ? 'tarobot-desktop-core.exe' : 'tarobot-desktop-core')),
    cp(addon, path.join(native, 'tarobot-desktop-native.node')),
    cp(await realpath(options.host), host, { recursive: true, dereference: true }),
  ]);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'tarobot-desktop', productName: 'TaroBird', author: nativeConfig.bundle.publisher, version: pkg.version, main: 'main.mjs', type: 'module' }));
  await writeFile(path.join(source, 'desktop.json'), JSON.stringify({ format: 1, mode: production ? 'production' : 'development', sourceCommit: head, dirty }));
  if (options.updater) {
    const binary = await readFile(await realpath(options.updater));
    if (binary.includes(Buffer.from('TAROBOT_UPDATER_LAB'))) throw new Error('updater_lab_binary_forbidden');
    await writeFile(path.join(native, platform === 'win32' ? 'tarobot-desktop-updater.exe' : 'tarobot-desktop-updater'), binary, { mode: 0o755 });
  }
  if (options.exporter && platform === 'win32') {
    const reader = await readFile(await realpath(options.exporter));
    if (reader.includes(Buffer.from('TAROBOT_MIGRATION_AUDIT_ROOT'))) throw new Error('migration_audit_binary_forbidden');
    await writeFile(path.join(native, 'tarobot-migration-exporter.exe'), reader, { mode: 0o755 });
  }
  const updateConfig = options.updateConfig ? JSON.parse(await readFile(options.updateConfig, 'utf8')) : {};
  if (!updateConfig || typeof updateConfig !== 'object' || Array.isArray(updateConfig)) throw new Error('invalid_update_configuration');
  await writeFile(path.join(native, 'update-config.json'), JSON.stringify(updateConfig));
  const rights = path.join(root, 'signing-policy'); await mkdir(rights);
  for (const [role, names] of Object.entries(ELECTRON_RIGHTS)) await writeFile(path.join(rights, `${role}.plist`), entitlementsPlist(Object.fromEntries(names.map(name => [name, true]))));
  const identifier = production ? 'com.tarobot.client' : 'com.tarobot.electron.acceptance';
  const paths = await packager({ dir: source, name: 'TaroBot', executableName: 'tarocub-client',
    platform, arch, appBundleId: identifier, appVersion: pkg.version, buildVersion: pkg.version,
    electronVersion: pkg.devDependencies.electron, out: path.join(root, 'packages'), overwrite: false,
    tmpdir: path.join(root, 'packager.noindex'), download: { cacheRoot: cache },
    icon: path.join(client, 'src-tauri/icons', platform === 'darwin' ? 'icon.icns' : 'icon.ico'),
    asar: true, asarIntegrityDigest: true, prune: false, extraResource: [native, host],
    appCategoryType: 'public.app-category.productivity', darwinDarkModeSupport: true,
    extendInfo: { NSCameraUsageDescription: '拍照后作为消息附件发送。', NSMicrophoneUsageDescription: '录制语音消息并发送给你选择的 bot。',
      LSMinimumSystemVersion: '13.0', CFBundleURLTypes: production ? [{ CFBundleURLName: identifier, CFBundleURLSchemes: ['tarocub'] }] : [] },
  });
  const frontendChecks = [];
  for (const directory of paths) {
    const binary = platform === 'darwin' ? path.join(directory, 'TaroBot.app') : path.join(directory, 'tarocub-client.exe');
    if (platform === 'darwin') await exec('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', 'TaroBird', path.join(binary, 'Contents/Info.plist')]);
    if (platform === 'darwin' && options.exporter) {
      const reader = await readFile(await realpath(options.exporter));
      if (reader.includes(Buffer.from('TAROBOT_MIGRATION_AUDIT_ROOT'))) throw new Error('migration_audit_binary_forbidden');
      await writeFile(path.join(binary, 'Contents/MacOS/tarobot-migration-exporter'), reader, { mode: 0o755 });
    }
    await flipFuses(binary, { version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false, [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, [FuseV1Options.EnableNodeCliInspectArguments]: !production,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    });
    if (platform === 'darwin') await sign({ app: binary, identity: developerSigned ? options.identity : '-', ...(options.keychain ? { keychain: options.keychain } : {}),
      type: 'distribution', platform: 'darwin', identityValidation: developerSigned, preAutoEntitlements: false, ignore: [target => !electronSignable(target)],
      optionsForFile: target => ({ hardenedRuntime: developerSigned, entitlements: path.join(rights, `${electronSigningRole(binary, target)}.plist`),
        ...(credentialCodeIdentifier(binary, target, developerSigned) ? { additionalArguments: ['--identifier', credentialCodeIdentifier(binary, target, developerSigned)] } : {}) }) });
    frontendChecks.push(await verifyElectronShell({ resources: platform === 'darwin' ? path.join(binary, 'Contents/Resources') : path.join(directory, 'resources'),
      frontend: path.join(client, 'dist'), version: pkg.version, ...(production ? { commit: head } : {}) }));
  }
  const receipt = { format: 1, sourceCommit: head, dirty, production, developerSigned, platform, arch, version: pkg.version, paths, frontendChecks };
  await writeFile(path.join(root, 'package-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const name = process.argv[index];
    if (name === '--production') options.production = true;
    else if (name === '--signed-acceptance') options.signedAcceptance = true;
    else if (['--out', '--cache', '--helper', '--addon', '--host', '--updater', '--exporter', '--updateConfig', '--platform', '--arch', '--identity', '--keychain', '--sourceCommit'].includes(name)) options[name.slice(2)] = process.argv[++index];
    else throw new Error('invalid_packaging_option');
  }
  packageDesktop(options).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode = 1; });
}
