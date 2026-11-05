import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateVersion, nextVersion, versionFiles, syncVersions } from './release-version.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
test('semantic increments reset subordinate fields', () => {
  assert.equal(nextVersion('1.2.9', 'patch'), '1.2.10');
  assert.equal(nextVersion('1.2.9', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.9', 'major'), '2.0.0');
  assert.throws(() => nextVersion('1.2.9', 'random'));
});
test('one manifest synchronizes every platform and detects drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'version-policy-'));
  try {
    const value = JSON.parse(readFileSync(join(source, 'release-version.json')));
    for (const file of ['release-version.json', ...versionFiles(source, value).keys()]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true }); cpSync(join(source, file), join(dir, file));
    }
    syncVersions(dir, true);
    const packageFile = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(packageFile)); pkg.version = '0.1.999';
    writeFileSync(packageFile, JSON.stringify(pkg));
    assert.throws(() => syncVersions(dir), /Version drift/);
    syncVersions(dir, true); assert.equal(syncVersions(dir).version, value.version);
    const android = join(dir, 'client/android/app/build.gradle');
    writeFileSync(android, readFileSync(android, 'utf8').replace('versionName providers', 'missingField providers'));
    assert.throws(() => syncVersions(dir, true), /Version layout changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('version and platform build values cannot be malformed or overflow stores', () => {
  const value = JSON.parse(readFileSync(join(source, 'release-version.json')));
  for (const change of [{ version: '1.01.0' }, { version: '1.1.0-rc.1' }, { iosBuild: 0 }, { iosBuild: 10000 }, { androidVersionCode: 2100000001 }, { status: 'published-maybe' }]) assert.throws(() => validateVersion({ ...value, ...change }));
});
