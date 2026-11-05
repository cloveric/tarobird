import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
export function validateVersion(value) {
  if (value?.format !== 1 || value.product !== 'TaroBird' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)
    || !['development', 'rc', 'stable'].includes(value.status)
    || !Number.isSafeInteger(value.iosBuild) || value.iosBuild < 1 || value.iosBuild > 9999
    || !Number.isSafeInteger(value.androidVersionCode) || value.androidVersionCode < 1 || value.androidVersionCode > 2100000000) throw new Error('Invalid release-version.json. See docs/versioning.md.');
  return value;
}
export function nextVersion(current, kind) {
  const parts = current.split('.').map(Number);
  if (kind === 'major') return `${parts[0] + 1}.0.0`;
  if (kind === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  if (kind === 'patch') return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  throw new Error('Choose major, minor or patch.');
}
export function versionFiles(directory, manifest, readFile) {
  validateVersion(manifest);
  const files = new Map();
  const read = readFile ?? (file => readFileSync(path.join(directory, file), 'utf8'));
  for (const file of ['package.json', 'package-lock.json', 'client/package.json', 'client/package-lock.json', 'client/src-tauri/tauri.conf.json']) {
    const value = JSON.parse(read(file)); value.version = manifest.version;
    if (value.packages?.['']) value.packages[''].version = manifest.version;
    files.set(file, JSON.stringify(value, null, 2) + '\n');
  }
  const replace = (file, pattern, replacement, count) => {
    const original = files.get(file) ?? read(file);
    const found = [...original.matchAll(pattern)].length;
    if (found !== count) throw new Error(`Version layout changed in ${file}; expected ${count} fields, found ${found}.`);
    files.set(file, original.replace(pattern, replacement));
  };
  replace('client/src-tauri/Cargo.toml', /^(version = ")[^"]+("\s*)$/gm, `$1${manifest.version}$2`, 1);
  replace('client/src-tauri/Cargo.lock', /(\[\[package\]\]\nname = "tarocub-client"\nversion = ")[^"]+("\n)/g, `$1${manifest.version}$2`, 1);
  replace('client/android/app/build.gradle', /(versionName providers\.gradleProperty\('tarobotVersionName'\)\.orElse\(')[^']+('\))/g, `$1${manifest.version}$2`, 1);
  replace('client/android/app/build.gradle', /(versionCode providers\.gradleProperty\('tarobotVersionCode'\)\.orElse\(')[^']+('\))/g, `$1${manifest.androidVersionCode}$2`, 1);
  replace('client/ios/App/App.xcodeproj/project.pbxproj', /(MARKETING_VERSION = )[^;]+;/g, `$1${manifest.version};`, 4);
  replace('client/ios/App/App.xcodeproj/project.pbxproj', /(CURRENT_PROJECT_VERSION = )[^;]+;/g, `$1${manifest.iosBuild};`, 4);
  return files;
}
export function syncVersions(directory, write = false) {
  const value = validateVersion(JSON.parse(readFileSync(path.join(directory, 'release-version.json'), 'utf8')));
  const mismatches = [];
  for (const [file, expected] of versionFiles(directory, value)) {
    if (readFileSync(path.join(directory, file), 'utf8') !== expected) {
      mismatches.push(file); if (write) writeFileSync(path.join(directory, file), expected);
    }
  }
  if (mismatches.length && !write) throw new Error(`Version drift: ${mismatches.join(', ')}. Run npm run version:sync.`);
  return value;
}
export function checkGitVersion(ref) {
  if (ref !== 'INDEX' && !/^[0-9a-f]{40,64}$/i.test(ref)) throw new Error('Version check requires INDEX or a full commit SHA.');
  const read = file => execFileSync('git', ['show', `${ref === 'INDEX' ? '' : ref}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  const value = validateVersion(JSON.parse(read('release-version.json')));
  for (const [file, expected] of versionFiles(root, value, read)) {
    if (read(file) !== expected) throw new Error(`Committed/staged version drift in ${file}. Run version:sync and stage all version files.`);
  }
  return value;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode = 'check', kind] = process.argv.slice(2);
    if (mode === 'git') {
      const value = checkGitVersion(kind);
      console.log(`Git snapshot product versions agree: ${value.version}.`);
      process.exit(0);
    }
    if (mode === 'bump') {
      const current = syncVersions(root);
      const next = { ...current, version: nextVersion(current.version, kind), status: 'development', iosBuild: 1, androidVersionCode: current.androidVersionCode + 1 };
      validateVersion(next);
      writeFileSync(path.join(root, 'release-version.json'), JSON.stringify(next, null, 2) + '\n');
    } else if (!['check', 'sync'].includes(mode) || kind) throw new Error('Usage: release-version.mjs check|sync|bump major|minor|patch');
    const value = syncVersions(root, mode !== 'check');
    console.log(`TaroBird ${value.version} (${value.status}); App/CLI versions agree; iOS build ${value.iosBuild}, Android code ${value.androidVersionCode}. No release was published.`);
  } catch (error) { console.error(error.status !== undefined ? 'Cannot read the complete Git version snapshot.' : error.message); process.exitCode = 1; }
}
