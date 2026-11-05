import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { legacySourceFingerprint, stableLegacySnapshot } from '../migration-source.mjs';
test('source stamp detects legacy writes, new files and redirected trees without reading contents', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-stamp-'));
  const source = path.join(root, 'WebKit'); await mkdir(source);
  const initial = await legacySourceFingerprint([source]);
  await writeFile(path.join(source, '.DS_Store'), 'Finder metadata');
  assert.equal(await legacySourceFingerprint([source]), initial);
  await writeFile(path.join(source, 'db.sqlite'), 'initial snapshot');
  const first = await legacySourceFingerprint([source]); assert.notEqual(first, initial);
  await writeFile(path.join(source, 'db.sqlite'), 'new draft written by restored old App');
  assert.notEqual(await legacySourceFingerprint([source]), first);
  await symlink(source, path.join(root, 'redirect'));
  await assert.rejects(legacySourceFingerprint([path.join(root, 'redirect')]), /migration_source_redirected/);
});
test('baseline waits for late WebKit writes and refuses a continuously changing source', async () => {
  const fingerprints = ['before-flush', 'after-flush', 'after-flush'];
  let waits = 0;
  const result = await stableLegacySnapshot(async () => ({ fingerprint: fingerprints.shift() }), { wait: async () => { waits++; } });
  assert.equal(result.fingerprint, 'after-flush'); assert.equal(waits, 2);
  let sequence = 0;
  await assert.rejects(stableLegacySnapshot(async () => ({ fingerprint: String(sequence++) }), { wait: async () => {}, attempts: 3 }), /migration_source_busy/);
});
