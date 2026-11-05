import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isolatedRoot } from '../electron/isolation.mjs';
import { packageDesktop } from './electron-package.mjs';
import { macosArtifacts } from './electron-macos-artifacts.mjs';
import { buildWindowsInstaller, setupNsisPlugins } from './windows-electron-installer.mjs';
import { macosBuildPlan } from './macos-build-plan.mjs';
import { windowsBuildPlan } from './windows-build-plan.mjs';
import { verifyDesktopUpdateArtifact } from './desktop-update-manifest.mjs';
import { preparationEnvironment } from '../../scripts/build-environment.mjs';
import { releaseConfig } from './desktop-release.mjs';
import { normalizeMacAddonIdentity } from './macos-addon-identity.mjs';
const client = fileURLToPath(new URL('..', import.meta.url)), repository = path.dirname(client);

async function run(command, args, cwd, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)));
  });
}
export function electronBuildPlan(options, env = process.env) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? (platform === 'win32' ? 'x64' : 'arm64');
  if (platform === 'darwin' && arch !== 'arm64' || platform === 'win32' && arch !== 'x64' || !['darwin', 'win32'].includes(platform)) throw new Error('Supported desktop builds are macOS arm64 and Windows x64');
  const production = options.production === true;
  const target = platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-pc-windows-msvc';
  const signedUpdates = options.signedUpdates === true || production && platform === 'darwin';
  const publicEndpoint = env.TAROBOT_UPDATE_URL ?? env.TAROCUB_UPDATE_URL;
  if (production && platform === 'darwin' && publicEndpoint) throw new Error('Production Mac releases require the pinned GitHub update channel; unset TAROBOT_UPDATE_URL and TAROCUB_UPDATE_URL');
  if (signedUpdates && !env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw new Error('TAURI_SIGNING_PRIVATE_KEY is required for signed update artifacts');
  const updateConfig = !signedUpdates ? {} : publicEndpoint ? releaseConfig(publicEndpoint, env.TAROBOT_UPDATE_PUBLIC_KEY ?? env.TAROCUB_UPDATE_PUBLIC_KEY ?? '').plugins
    : (platform === 'darwin' ? macosBuildPlan({ arch }, env) : windowsBuildPlan({ arch, signedUpdates: true }, env)).updateConfig.plugins;
  if (production && platform === 'darwin' && (!env.APPLE_SIGNING_IDENTITY || env.APPLE_SIGNING_IDENTITY === '-' || !env.TAROBOT_APPLE_TEAM_ID || !env.TAROBOT_NOTARY_PROFILE)) throw new Error('Production Mac builds require Developer ID, Team ID and a notarytool keychain profile');
  for (const name of ['out', 'cache', 'targetDir']) if (!options[name] || !path.isAbsolute(options[name])) throw new Error(`An absolute --${name} path below .noindex is required`);
  if (production && !options.sourceCommit) throw new Error('--sourceCommit is required for production');
  return { platform, arch, target, production, updateConfig, updateProvider: updateConfig['github-updates'] ? 'github' : updateConfig.updater ? 'default' : 'none' };
}
export async function buildElectronDesktop(options, env = process.env) {
  const plan = electronBuildPlan(options, env);
  if (plan.platform === 'darwin' && process.platform !== 'darwin') throw new Error('Mac packaging requires macOS');
  const out = await isolatedRoot(options.out), cache = await isolatedRoot(options.cache), targetDir = await isolatedRoot(options.targetDir);
  const buildEnv = preparationEnvironment(env);
  const npm = env.npm_execpath;
  if (!npm) throw new Error('Run through npm run desktop:build, desktop:macos or desktop:windows');
  await run(process.execPath, ['scripts/build-standalone.mjs'], repository, buildEnv);
  await run(process.execPath, [npm, 'run', 'build'], client, buildEnv);
  await run(process.execPath, ['scripts/prepare-desktop-host.mjs', '--platform', plan.platform, '--arch', plan.arch], repository, buildEnv);
  await run(process.execPath, ['scripts/build-migration-exporter.mjs'], client, buildEnv);
  const pkg = JSON.parse(await readFile(path.join(client, 'package.json')));
  const crates = [
    ['core', 'src-desktop-core', ['--bin', 'tarobot-desktop-core']],
    ['native', 'src-desktop-native', ['--lib']],
    ['updater', 'src-desktop-updater', ['--bins']],
    ['exporter', 'src-tauri', ['--features', 'desktop-migration-exporter', '--bin', 'tarobot-migration-exporter']],
  ];
  const binaries = {};
  for (const [kind, directory, args] of crates) {
    const target = path.join(targetDir, `${kind}.noindex`); await mkdir(target, { recursive: true });
    await run('cargo', [...(plan.platform === 'win32' && process.platform !== 'win32' ? ['xwin'] : []), 'build', '--release', '--locked', '--target', plan.target, ...args], path.join(client, directory), {
      ...buildEnv, CARGO_TARGET_DIR: target,
      ...(plan.platform === 'win32' ? { CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: '-C target-feature=+crt-static' } : {}),
      ...(kind === 'exporter' ? { TAURI_CONFIG: JSON.stringify({ version: pkg.version, build: { windows: { staticVCRuntime: false } }, bundle: { resources: null } }) } : {}),
    });
    binaries[kind] = path.join(target, plan.target, 'release');
  }
  const suffix = plan.platform === 'win32' ? '.exe' : '';
  const addon = path.join(out, 'tarobot-desktop-native.node');
  await cp(path.join(binaries.native, plan.platform === 'win32' ? 'tarobot_desktop_native.dll' : 'libtarobot_desktop_native.dylib'), addon);
  if (plan.platform === 'darwin') normalizeMacAddonIdentity(addon);
  const updateConfig = path.join(out, 'update-config.json'); await writeFile(updateConfig, JSON.stringify(plan.updateConfig));
  const packaged = await packageDesktop({ ...options, platform: plan.platform, arch: plan.arch, production: plan.production,
    out: path.join(out, 'package.noindex'), cache, identity: env.APPLE_SIGNING_IDENTITY, keychain: env.TAROBOT_SIGNING_KEYCHAIN,
    helper: path.join(binaries.core, `tarobot-desktop-core${suffix}`), addon,
    updater: path.join(binaries.updater, `tarobot-desktop-updater${suffix}`), exporter: path.join(binaries.exporter, `tarobot-migration-exporter${suffix}`),
    host: path.join(client, 'src-tauri/host'), updateConfig });
  let artifacts;
  if (options.packageOnly) artifacts = { packageOnly: true };
  else if (plan.platform === 'darwin') artifacts = await macosArtifacts({ app: path.join(packaged.paths[0], 'TaroBot.app'), out: path.join(out, 'artifacts.noindex'), version: pkg.version,
    production: plan.production, team: env.TAROBOT_APPLE_TEAM_ID, notaryProfile: env.TAROBOT_NOTARY_PROFILE, publicKey: env.TAROBOT_UPDATE_PUBLIC_KEY ?? env.TAROCUB_UPDATE_PUBLIC_KEY, env });
  else {
    const installer = path.join(out, `TaroBot_${pkg.version}_x64-setup.exe`);
    await setupNsisPlugins(env.TAROBOT_NSIS_PLUGINS ? { pluginsDir: env.TAROBOT_NSIS_PLUGINS } : {});
    artifacts = await buildWindowsInstaller({ appDir: packaged.paths[0], helper: path.join(binaries.updater, 'tarobot-installer-helper.exe'), version: pkg.version, outFile: installer,
      ...(env.TAROBOT_NSIS_PLUGINS ? { pluginsDir: env.TAROBOT_NSIS_PLUGINS } : {}), installerIcon: path.join(client, 'src-tauri/icons/icon.ico') }, { workDir: path.join(out, 'nsis.noindex') });
    if (options.signedUpdates) {
      await run(process.execPath, [path.join(client, 'node_modules/@tauri-apps/cli/tauri.js'), 'signer', 'sign', '--app-version', pkg.version, installer], client, env);
      await verifyDesktopUpdateArtifact({ platform: 'windows', installer, publicKey: env.TAROBOT_UPDATE_PUBLIC_KEY ?? env.TAROCUB_UPDATE_PUBLIC_KEY, version: pkg.version });
    }
  }
  const result = { sourceCommit: packaged.sourceCommit, production: plan.production, platform: plan.platform, version: pkg.version, updateProvider: plan.updateProvider, packaged, artifacts };
  await writeFile(path.join(out, 'desktop-build.json'), JSON.stringify(result, null, 2));
  return result;
}
export async function electronBuildCLI(args = process.argv.slice(2), defaults = {}) {
  const { values } = parseArgs({ args, options: {
    platform: { type: 'string' }, arch: { type: 'string' }, production: { type: 'boolean' }, development: { type: 'boolean' },
    'unsigned-development': { type: 'boolean' }, 'signed-updates': { type: 'boolean' }, out: { type: 'string' }, cache: { type: 'string' },
    targetDir: { type: 'string' }, sourceCommit: { type: 'string' }, 'package-only': { type: 'boolean' }, 'signed-acceptance': { type: 'boolean' },
  } });
  const options = { ...defaults, ...values, production: values.production ?? (!(values.development || values['unsigned-development']) && defaults.production === true),
    signedUpdates: values['signed-updates'] === true, packageOnly: values['package-only'] ?? defaults.packageOnly, signedAcceptance: values['signed-acceptance'] === true,
    out: values.out ?? process.env.TAROBOT_DESKTOP_OUTPUT, cache: values.cache ?? process.env.TAROBOT_ELECTRON_CACHE,
    targetDir: values.targetDir ?? process.env.TAROBOT_DESKTOP_TARGET, sourceCommit: values.sourceCommit ?? process.env.TAROBOT_SOURCE_COMMIT };
  const result = await buildElectronDesktop(options); console.log(JSON.stringify({ sourceCommit: result.sourceCommit, production: result.production, platform: result.platform, out: options.out }));
  return result;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) electronBuildCLI().catch(error => { console.error(error.message); process.exitCode = 1; });
