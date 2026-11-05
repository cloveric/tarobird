import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, rename, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MigrationStore, macKey, installationBinding, validateManifest } from '../migration.mjs';

const HOST = `tarocub-host-hub_${'a'.repeat(64)}-${randomUUID()}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function lab(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-migration-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
/** Minimal writer with the Rust layout, so these tests do not depend on a build. */
async function writeExport(state, { marker = Buffer.alloc(32, 7), lines, blobs = [], databases, createdAt = 1_793_300_000_000 } = {}) {
  await writeFile(path.join(state, 'tarobot-client-installation-v1'), marker);
  const exportId = randomUUID(), dir = path.join(state, 'desktop-migration', 'exports', exportId);
  await mkdir(path.join(dir, 'parts'), { recursive: true }); await mkdir(path.join(dir, 'blobs'));
  const text = lines.map(line => JSON.stringify(line) + '\n').join('');
  await writeFile(path.join(dir, 'parts', '000000.jsonl'), text);
  for (const blob of blobs) await writeFile(path.join(dir, 'blobs', sha(blob)), blob);
  const counts = {}; let local = 0;
  for (const line of lines) { if (line.d === 'localStorage') local++; else { counts[line.d] ??= {}; counts[line.d][line.s] = (counts[line.d][line.s] ?? 0) + 1; } }
  const body = { format: 'tarobot-desktop-migration', version: 1, exportId, createdAt, installation: installationBinding(marker), source: { app: 'tauri', appVersion: '1.0.120' },
    databases: databases ?? Object.keys(counts).sort().map(name => ({ name, version: name === 'tarocub-hosts-v1' ? 2 : 9, stores: counts[name] })), localStorage: local,
    parts: [{ file: '000000.jsonl', bytes: Buffer.byteLength(text), sha256: sha(text), records: lines.length }],
    blobs: blobs.map(blob => ({ sha256: sha(blob), bytes: blob.length })).sort((a, b) => a.sha256.localeCompare(b.sha256)),
    totals: { records: lines.length, bytes: Buffer.byteLength(text) + blobs.reduce((n, b) => n + b.length, 0) }, skipped: [], requiresRepair: [] };
  const manifest = Buffer.from(JSON.stringify(body));
  await writeFile(path.join(dir, 'manifest.json'), manifest);
  await writeFile(path.join(dir, 'manifest.mac'), createHmac('sha256', macKey(marker)).update(manifest).digest('hex'));
  return { exportId, dir, body, text };
}
const sample = blob => [
  { d: 'tarocub-hosts-v1', s: 'hosts', k: `hub_${'a'.repeat(64)}`, v: { id: `hub_${'a'.repeat(64)}`, databaseName: HOST } },
  { d: HOST, s: 'conversationDrafts', k: 'c1', v: { files: [{ $t: 'file', name: 'a.txt', type: 'text/plain', lastModified: 1, size: blob.length, ref: sha(blob) }] } },
  { d: 'localStorage', s: 'items', k: 'tarocub-appearance', v: '{}' },
];

test('a committed export verifies and reads back exactly what was hashed', async t => {
  const state = await lab(t), blob = Buffer.from('draft bytes'), store = new MigrationStore(state);
  const { exportId, text } = await writeExport(state, { lines: sample(blob), blobs: [blob] });
  const inspected = await store.inspect();
  assert.equal(inspected.state, 'ready'); assert.equal(inspected.manifest.exportId, exportId);
  assert.equal(await store.readPart(exportId, 0, inspected.manifest), text);
  assert.deepEqual(await store.readBlob(exportId, sha(blob), inspected.manifest), blob);
  await assert.rejects(store.readPart(exportId, 1, inspected.manifest), /invalid_migration_part/);
  await assert.rejects(store.readBlob(exportId, 'a'.repeat(64), inspected.manifest), /invalid_migration_blob/);
  await assert.rejects(store.readBlob('../x', sha(blob), inspected.manifest), /invalid_migration/);
});

test('tampering, another installation, extra files and symlinks are rejected', async t => {
  const blob = Buffer.from('bytes');
  const cases = {
    part: async ({ dir }) => appendFile(path.join(dir, 'parts', '000000.jsonl'), ' '),
    blob: async ({ dir }) => writeFile(path.join(dir, 'blobs', sha(blob)), 'other'),
    mac: async ({ dir }) => writeFile(path.join(dir, 'manifest.mac'), 'f'.repeat(64)),
    manifest: async ({ dir }) => writeFile(path.join(dir, 'manifest.json'), (await readFile(path.join(dir, 'manifest.json'), 'utf8')).replace('1.0.120', '1.0.121')),
    extra: async ({ dir }) => writeFile(path.join(dir, 'notes.txt'), 'x'),
    extraPart: async ({ dir }) => writeFile(path.join(dir, 'parts', '000001.jsonl'), 'x'),
    marker: async ({ state }) => writeFile(path.join(state, 'tarobot-client-installation-v1'), Buffer.alloc(32, 8)),
    symlink: async ({ dir, state }) => { await writeFile(path.join(state, 'outside'), blob); await rm(path.join(dir, 'blobs', sha(blob))); await symlink(path.join(state, 'outside'), path.join(dir, 'blobs', sha(blob))); },
    // Identical bytes behind a redirected directory are still refused.
    partsDirectory: async ({ dir, state }) => { await rename(path.join(dir, 'parts'), path.join(state, 'parts-copy')); await symlink(path.join(state, 'parts-copy'), path.join(dir, 'parts')); },
    blobsDirectory: async ({ dir, state }) => { await rename(path.join(dir, 'blobs'), path.join(state, 'blobs-copy')); await symlink(path.join(state, 'blobs-copy'), path.join(dir, 'blobs')); },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const state = await lab(t), written = await writeExport(state, { lines: sample(blob), blobs: [blob] });
    await tamper({ ...written, state });
    const store = new MigrationStore(state);
    await assert.rejects(store.verify(written.exportId), /migration_/, name);
    const inspected = await store.inspect();
    assert.equal(inspected.state, 'invalid', name); assert.equal(inspected.invalid[0].exportId, written.exportId);
  }
});

test('manifest structure, counts and bounds are checked independently of the MAC', () => {
  const body = { format: 'tarobot-desktop-migration', version: 1, exportId: randomUUID(), createdAt: 1, installation: 'a'.repeat(64), source: { app: 'tauri', appVersion: '1.0.120' },
    databases: [{ name: 'tarocub-hosts-v1', version: 2, stores: { hosts: 1 } }], localStorage: 0, parts: [{ file: '000000.jsonl', bytes: 10, sha256: 'b'.repeat(64), records: 1 }],
    blobs: [], totals: { records: 1, bytes: 10 }, skipped: [], requiresRepair: [] };
  assert.equal(validateManifest(structuredClone(body)).exportId, body.exportId);
  const variants = [
    b => { b.extra = 1; }, b => { b.version = 2; }, b => { b.totals.records = 2; }, b => { b.parts[0].file = '000001.jsonl'; },
    b => { b.databases[0].stores.syncMessages = 1; }, b => { b.databases.push({ name: 'other', version: 1, stores: { settings: 1 } }); },
    b => { b.databases[0].name = HOST; }, b => { b.requiresRepair = ['hub_x']; }, b => { b.blobs = [{ sha256: 'c'.repeat(64), bytes: 128 * 1024 * 1024 + 1 }]; b.totals.bytes += 128 * 1024 * 1024 + 1; },
    b => { b.source.appVersion = '../1'; }, b => { b.parts[0].bytes = 0; b.totals.bytes = 0; },
  ];
  for (const change of variants) { const copy = structuredClone(body); change(copy); assert.throws(() => validateManifest(copy), /migration_manifest/, change.toString()); }
});

test('receipts are durable, idempotent and refuse a conflicting second import', async t => {
  const state = await lab(t), blob = Buffer.from('x'), store = new MigrationStore(state);
  const { exportId } = await writeExport(state, { lines: sample(blob), blobs: [blob] });
  const receipt = { exportId, importedAt: 5, records: 3 };
  await store.writeReceipt(exportId, receipt); await store.writeReceipt(exportId, receipt);
  await assert.rejects(store.writeReceipt(exportId, { ...receipt, records: 4 }), /migration_receipt_conflict/);
  assert.deepEqual(await store.receipt(exportId), receipt);
  assert.equal((await store.inspect()).state, 'imported');
  await assert.rejects(store.writeReceipt(exportId, { exportId: randomUUID() }), /migration_receipt_invalid/);
});

test('redirected exports or receipts directories are refused, never followed', async t => {
  const blob = Buffer.from('x');
  const state = await lab(t), { exportId } = await writeExport(state, { lines: sample(blob), blobs: [blob] });
  const outside = await lab(t);
  await mkdir(path.join(outside, 'receipts'));
  await symlink(path.join(outside, 'receipts'), path.join(state, 'desktop-migration', 'receipts'));
  const store = new MigrationStore(state);
  await assert.rejects(store.writeReceipt(exportId, { exportId }), /migration_storage_invalid/);
  await assert.rejects(store.receipt(exportId), /migration_storage_invalid/);
  const moved = await lab(t), { exportId: other } = await writeExport(moved, { lines: sample(blob), blobs: [blob] });
  const redirected = await lab(t);
  await writeFile(path.join(redirected, 'tarobot-client-installation-v1'), Buffer.alloc(32, 7));
  await mkdir(path.join(redirected, 'desktop-migration'));
  await symlink(path.join(moved, 'desktop-migration', 'exports'), path.join(redirected, 'desktop-migration', 'exports'));
  const target = new MigrationStore(redirected);
  await assert.rejects(target.verify(other), /migration_storage_invalid/);
  await assert.rejects(target.inspect(), /migration_storage_invalid/);
});

test('the newest valid export wins; a missing installation marker fails closed', async t => {
  const state = await lab(t), blob = Buffer.from('x'), store = new MigrationStore(state);
  await writeExport(state, { lines: sample(blob), blobs: [blob], createdAt: 1 });
  const newer = await writeExport(state, { lines: sample(blob), blobs: [blob], createdAt: 2 });
  assert.equal((await store.inspect()).manifest.exportId, newer.exportId);
  await rename(path.join(state, 'tarobot-client-installation-v1'), path.join(state, 'moved'));
  await assert.rejects(store.verify(newer.exportId), /migration_installation_unavailable/);
  assert.throws(() => new MigrationStore('relative'), /invalid_migration_state_dir/);
  assert.deepEqual(await new MigrationStore(path.join(state, 'empty')).inspect(), { state: 'none', invalid: [] });
});
