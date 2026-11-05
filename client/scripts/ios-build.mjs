#!/usr/bin/env node
import { noIndexDirectory } from '../../scripts/macos-artifact-paths.mjs';
import { stageNamedReleaseArtifact } from '../../scripts/release-artifact-names.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { iosReleasePlan, validateIOSBundleMetadata, validateIOSEntitlements } from './ios-release-plan.mjs';
import { MOBILE_CSP } from './mobile-csp.mjs';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'simulator' }, 'build-number': { type: 'string' },
  team: { type: 'string' }, output: { type: 'string' }, doctor: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log(`TaroBird iOS build (macOS + full Xcode required)
  npm run ios:doctor
  npm run ios:build -- --mode simulator [--output /absolute/build/root]
  npm run ios:build -- --mode testflight --team TEAMID --build-number 1 [--output /absolute/build/root]
DEVELOPER_DIR selects Xcode without changing the system default. Each build gets a new output directory.
TestFlight mode requires existing signing profiles/certificates. It exports and verifies an IPA; it does not upload.`);
  process.exit(0);
}

let env = { ...process.env };
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: client, env, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})${capture ? `: ${result.stderr?.trim()}` : ''}`);
  return result.stdout?.trim();
}
function doctor() {
  if (process.platform !== 'darwin') throw new Error('iOS builds require macOS and full Xcode.');
  const xcode = run('xcrun', ['--find', 'xcodebuild'], true);
  const version = run(xcode, ['-version'], true);
  if (Number(version.match(/Xcode (\d+)/)?.[1] ?? 0) < 26) throw new Error('Capacitor 8 requires Xcode 26 or newer.');
  const sdk = run('xcrun', ['--sdk', values.mode === 'simulator' ? 'iphonesimulator' : 'iphoneos', '--show-sdk-version'], true);
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning'], true);
  console.log(JSON.stringify({ xcode: version, sdk, validSigningIdentities: Number(identities.match(/(\d+) valid identities found/)?.[1] ?? 0),
    note: 'Signing identity count does not verify membership, profiles, APNs or TestFlight access.' }, null, 2));
  return xcode;
}
function plist(file) {
  return JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', file], true));
}
async function checkBundle(app, plan) {
  const extensions = (await readdir(path.join(app, 'PlugIns'))).filter((name) => name.endsWith('.appex'));
  if (extensions.length !== 1) throw new Error('Expected exactly one embedded share extension.');
  const share = path.join(app, 'PlugIns', extensions[0]);
  validateIOSBundleMetadata(plist(path.join(app, 'Info.plist')), plist(path.join(share, 'Info.plist')), plan);
  const config = JSON.parse(await readFile(path.join(app, 'capacitor.config.json'), 'utf8'));
  if (config.server?.url) throw new Error('A development server URL must not ship.');
  const html = await readFile(path.join(app, 'public/index.html'), 'utf8');
  if (!html.includes(`content="${MOBILE_CSP}"`)) throw new Error('Bundled mobile CSP is missing or incorrect.');
  await access(path.join(app, 'PrivacyInfo.xcprivacy'));
  await access(path.join(share, 'PrivacyInfo.xcprivacy'));
  return share;
}
async function rights(bundle, output, name) {
  const xml = run('codesign', ['-d', '--entitlements', ':-', bundle], true);
  const file = path.join(output, `${name}-entitlements.plist`);
  await writeFile(file, xml, { mode: 0o600 });
  return plist(file);
}

try {
  // Validate before running any tools or building assets.
  const version = JSON.parse(await readFile(path.join(client, 'package.json'), 'utf8')).version;
  if (!['simulator', 'testflight'].includes(values.mode)) throw new Error('mode must be simulator or testflight');
  const outputRoot = noIndexDirectory(values.output ?? path.join(client, 'ios/build.noindex'));
  if (values.mode === 'testflight' && !values['build-number'] && !values.doctor) throw new Error('TestFlight requires an explicit --build-number (increase for every upload).');
  const settings = { mode: values.mode, version, buildNumber: values['build-number'] ?? '1', teamId: values.team, output: outputRoot };
  if (!values.doctor) iosReleasePlan(settings);
  const xcode = doctor();
  if (!values.doctor) {
    await mkdir(outputRoot, { recursive: true });
    const output = await mkdtemp(path.join(outputRoot, `${values.mode}-${version}-${settings.buildNumber}-`));
    const plan = iosReleasePlan({ ...settings, output });
    const temp = path.join(output, 'tmp');
    await mkdir(temp);
    env = { ...env, TMPDIR: temp + path.sep, CLANG_MODULE_CACHE_PATH: path.join(output, 'ModuleCache'),
      SWIFTPM_MODULECACHE_OVERRIDE: path.join(output, 'ModuleCache') };
    console.log(`Build output: ${output}`);
    run('npm', ['run', 'build']);
    run(process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'ios']);
    run(xcode, plan.buildArgs);
    const app = plan.mode === 'simulator'
      ? path.join(plan.derivedData, 'Build/Products/Release-iphonesimulator/App.app')
      : path.join(plan.archive, 'Products/Applications/App.app');
    await checkBundle(app, plan);
    const receipt = { mode: plan.mode, version, buildNumber: plan.buildNumber, uploaded: false, physicalDeviceVerified: false };
    if (plan.mode === 'testflight') {
      const exportPlist = path.join(output, 'ExportOptions.plist');
      await writeFile(exportPlist, JSON.stringify(plan.exportOptions), { mode: 0o600 });
      run('plutil', ['-convert', 'xml1', exportPlist]);
      const exported = path.join(output, 'export');
      run(xcode, ['-exportArchive', '-archivePath', plan.archive, '-exportPath', exported, '-exportOptionsPlist', exportPlist]);
      const ipas = (await readdir(exported)).filter((file) => file.endsWith('.ipa'));
      if (ipas.length !== 1) throw new Error('Export did not produce exactly one IPA.');
      const { file: ipa } = await stageNamedReleaseArtifact({ kind: 'ios', version, source: path.join(exported, ipas[0]), output: path.join(output, 'artifacts') });
      const unpacked = path.join(output, 'verification');
      run('ditto', ['-x', '-k', ipa, unpacked]);
      const apps = (await readdir(path.join(unpacked, 'Payload'))).filter((file) => file.endsWith('.app'));
      if (apps.length !== 1) throw new Error('IPA does not contain exactly one app.');
      const finalApp = path.join(unpacked, 'Payload', apps[0]);
      const finalShare = await checkBundle(finalApp, plan);
      for (const bundle of [finalApp, finalShare]) run('codesign', ['--verify', '--deep', '--strict', bundle]);
      validateIOSEntitlements(await rights(finalApp, output, 'app'), await rights(finalShare, output, 'share'), plan.teamId);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(ipa)) digest.update(chunk);
      receipt.ipa = path.relative(output, ipa);
      receipt.sha256 = digest.digest('hex');
      receipt.distributionEntitlementsVerified = true;
    } else receipt.app = path.relative(output, app);
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify({ ...receipt, output }, null, 2));
  }
} catch (error) {
  console.error(`iOS build stopped: ${error.message}`);
  process.exitCode = 1;
}
