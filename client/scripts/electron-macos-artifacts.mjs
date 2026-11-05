// Electron has different executable entitlements from Tauri. Never pass an
// Electron package through the old Tauri re-signing routine.
import { extractFile } from '@electron/asar';
import { spawnSync } from 'node:child_process';
import { readdir, lstat, mkdir, cp, symlink, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { preparationEnvironment } from '../../scripts/build-environment.mjs';
import { isolatedRoot } from '../electron/isolation.mjs';
import { ELECTRON_RIGHTS, electronSignable, electronSigningRole } from './electron-signing-policy.mjs';
import { inspectSignature, verifyForeignAddon } from './macos-signing.mjs';
import { verifyDesktopUpdateArtifact } from './desktop-update-manifest.mjs';
import { notarizeElectron } from './electron-notarization.mjs';
const client = fileURLToPath(new URL('..', import.meta.url));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? 'spawn'}): ${(result.stderr ?? '').slice(-1000)}`);
  return result.stdout;
}
export function createMacUpdateArchive({ stage, archive, env = process.env }) {
  run('/usr/bin/tar', ['--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'wheel', '-czf', archive, '-C', stage, 'TaroBot.app'], { env: { ...env, COPYFILE_DISABLE: '1' } });
}
export async function verifyElectronMac(app, { team, production = false, scratch }) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const targets = [app];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (electronSignable(file)) targets.push(file); await walk(file); }
      else if (electronSignable(file)) targets.push(file);
    }
  };
  await walk(app);
  const records = targets.map(file => ({ path: path.relative(app, file), role: electronSigningRole(app, file), ...inspectSignature(file) }));
  for (const record of records) {
    const actual = Object.entries(record.entitlements).filter(([, value]) => value === true).map(([key]) => key).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...ELECTRON_RIGHTS[record.role]].sort()) || Object.keys(record.entitlements).length !== actual.length) throw new Error(`Unexpected Electron entitlements: ${record.path}`);
    if (production && (record.adhoc || !record.runtime || !record.timestamp || !team || record.team !== team)) throw new Error(`Incomplete Developer ID signature: ${record.path}`);
  }
  const foreign = scratch ? verifyForeignAddon(path.join(app, 'Contents/Resources/host/node'), await isolatedRoot(scratch)) : undefined;
  return { app, production, records, foreign };
}

export async function macosArtifacts({ app, out, version, production = false, team, notaryProfile, publicKey, env = process.env }) {
  if (process.platform !== 'darwin') throw new Error('macOS artifacts require macOS');
  const root = await isolatedRoot(out);
  if (!(await lstat(app)).isDirectory() || !app.endsWith('.app')) throw new Error('A packaged App is required');
  if (production && (!notaryProfile || !team || !publicKey || !env.TAURI_SIGNING_PRIVATE_KEY)) throw new Error('Developer ID, notarization and update signing settings are required');
  const metadata = JSON.parse(extractFile(path.join(app, 'Contents/Resources/app.asar'), 'desktop.json'));
  if (metadata.format !== 1 || !/^[a-f0-9]{40}$/.test(metadata.sourceCommit) || production && (metadata.mode !== 'production' || metadata.dirty)) throw new Error('Release archive requires clean source-bound production metadata');
  const actualVersion = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]).trim();
  if (actualVersion !== version) throw new Error('Artifact version differs from packaged App');
  const original = await verifyElectronMac(app, { production, team, scratch: path.join(root, 'foreign-addon.noindex') });
  if (production) {
    const zip = path.join(root, 'notarization.zip');
    const signature = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], { encoding: 'utf8', timeout: 10000 });
    const cdhash = /^CDHash=([a-f0-9]+)$/m.exec(signature.stderr ?? '')?.[1];
    if (signature.status !== 0 || !cdhash) throw new Error('Signed App identity unavailable');
    await notarizeElectron({ archive: zip, receiptFile: path.join(root, 'notarization.json'),
      binding: { sourceCommit: metadata.sourceCommit, version, team, cdhash }, profile: notaryProfile, keychain: env.TAROBOT_SIGNING_KEYCHAIN,
      createArchive: () => run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]),
      run: args => {
        const result = spawnSync('/usr/bin/xcrun', ['notarytool', ...args], { encoding: 'utf8', timeout: 900000, maxBuffer: 1024 * 1024 });
        // A terminal rejection may use a non-zero exit code. Save that JSON
        // status against the submission before reporting failure.
        if (!result.error) { try { const json = JSON.parse(result.stdout); if (json.id) return result.stdout; } catch { /* command failed before a response */ } }
        throw new Error(`Notarization command interrupted; retained receipt can resume (${result.status ?? 'timeout'})`);
      },
    });
    run('/usr/bin/xcrun', ['stapler', 'staple', app]);
    run('/usr/bin/xcrun', ['stapler', 'validate', app]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  }
  const stage = path.join(root, `dmg-stage-${randomUUID()}.noindex`); await mkdir(stage);
  await cp(app, path.join(stage, 'TaroBot.app'), { recursive: true, dereference: false, verbatimSymlinks: true });
  await symlink('/Applications', path.join(stage, 'Applications'));
  const dmg = path.join(root, `TaroBot_${version}_aarch64.dmg`), archive = path.join(root, 'TaroBot.app.tar.gz');
  run('/usr/bin/hdiutil', ['create', '-volname', 'TaroBot', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg]);
  // BSD tar otherwise emits AppleDouble members that the Rust updaters
  // treat as real files, invalidating the sealed bundle.
  createMacUpdateArchive({ stage, archive, env });
  // Read the final image, not just the source directory used to create it.
  // macOS refuses a disk-image mount nested below some external volumes.
  // A unique .noindex mount point directly in /Volumes keeps its temporary App
  // outside Spotlight without moving the release artifacts off their disk.
  const mountPoint = path.join('/Volumes', `TaroBot-${randomUUID()}.noindex`);
  try { await lstat(mountPoint); throw new Error('Disk image mount point already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const attached = run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, '-plist', dmg]);
  const entities = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: attached }))['system-entities'];
  const mount = entities.find(entity => entity['mount-point'])?.['mount-point'];
  if (mount !== mountPoint) throw new Error('Disk image did not mount at its isolated .noindex path');
  let mounted;
  try { mounted = await verifyElectronMac(path.join(mount, 'TaroBot.app'), { production, team }); }
  finally { run('/usr/bin/hdiutil', ['detach', mount]); }
  const extracted = path.join(root, `archive-readback-${randomUUID()}.noindex`);
  // The installed Tauri updater and the new Rust updater must both accept
  // these bytes. bsdtar read-back alone hides AppleDouble defects.
  run('cargo', ['test', '--locked', '--manifest-path', path.join(client, 'src-desktop-updater/Cargo.toml'), '--test', 'real_archive', '--', '--nocapture'], { timeout: 900000, env: { ...preparationEnvironment(env),
    CARGO_TARGET_DIR: await isolatedRoot(env.TAROBOT_ARCHIVE_VERIFY_TARGET ?? path.join(root, 'archive-verifier-target.noindex')),
    TAROBOT_UPDATER_REAL_ARCHIVE: archive, TAROBOT_UPDATER_REAL_OUTPUT: extracted,
    TAROBOT_UPDATER_REAL_VERSION: version, TAROBOT_UPDATER_REAL_IDENTIFIER: run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')]).trim(),
  } });
  const readback = await verifyElectronMac(path.join(extracted, 'desktop-updater/staged.noindex/TaroBot.app'), { production, team });
  if (production) {
    run(process.execPath, [path.join(client, 'node_modules/@tauri-apps/cli/tauri.js'), 'signer', 'sign', '--app-version', version, archive], { env });
    await verifyDesktopUpdateArtifact({ platform: 'macos', installer: archive, publicKey, version });
  }
  const artifacts = await Promise.all([dmg, archive, ...(production ? [`${archive}.sig`] : [])].map(async file => ({ file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') })));
  const result = { version, sourceCommit: metadata.sourceCommit, dirty: metadata.dirty, production, notarized: production, updaterReadback: ['installed-tauri', 'electron-rust'], artifacts, source: original, mounted, archive: readback };
  await writeFile(path.join(root, 'macos-artifacts.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(root, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${path.basename(item.file)}\n`).join(''));
  return result;
}
