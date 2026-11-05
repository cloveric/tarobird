import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DesktopMigration, legacyDesktopPresent } from '../migration-service.mjs';
import { MigrationStore, macKey, installationBinding } from '../migration.mjs';
import { productionPaths } from '../startup-paths.mjs';

async function fixture(legacyRequired, store) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-migration-service-'));
  const profile = path.join(root, 'profile'); await mkdir(profile);
  const service = new DesktopMigration({ stateDir: root, profile, legacyRequired, store });
  return { service, root, profile, call: (command, args = {}) => service.request(`desktop_migration_${command}`, args) };
}
test('native roots preserve Tauri Mac and Windows namespaces without pointing into Host', () => {
  const mac = productionPaths({ platform: 'darwin', appData: '/Users/test/Library/Application Support', resources: '/App/Contents/Resources' });
  assert.equal(mac.stateDir, mac.hostStateDir);
  assert.equal(mac.stateDir, '/Users/test/Library/Application Support/com.tarobot.client');
  assert.deepEqual(mac.legacyWebviewDirs, ['/Users/test/Library/WebKit/com.tarobot.client']);
  const win = productionPaths({ platform: 'win32', appData: 'C:\\Users\\a\\AppData\\Roaming', localAppData: 'C:\\Users\\a\\AppData\\Local', resources: 'C:\\TaroBot\\resources' });
  assert.match(win.stateDir, /Local\\com.tarobot.client$/); assert.match(win.hostStateDir, /Roaming\\com.tarobot.client$/);
});
test('unpaired WKWebView preferences outside native state still require migration', async () => {
  const f = await fixture(false), webkit = path.join(f.root, 'old-webkit'); await mkdir(webkit);
  assert.equal(await legacyDesktopPresent(f.profile), false);
  assert.equal(await legacyDesktopPresent(f.profile, [webkit]), true);
});
test('an existing installation without export cannot mint a fresh profile', async () => {
  const f = await fixture(true, { inspect: async () => ({ state: 'none' }) });
  assert.deepEqual(await f.call('inspect'), { state: 'transition_required' });
  await assert.rejects(f.call('complete'), /migration_export_not_verified/);
  assert.equal(f.service.ready, false);
  assert.equal(await legacyDesktopPresent(f.root), false);
  await writeFile(path.join(f.root, 'tarobot-client-installation-v1'), Buffer.alloc(32));
  assert.equal(await legacyDesktopPresent(f.root), true);
});
test('fresh profile initialization is durable but each document must finish its gate', async () => {
  const f = await fixture(false, { inspect: async () => ({ state: 'none' }) });
  assert.equal((await f.call('inspect')).state, 'fresh'); assert.equal(f.service.ready, false);
  await f.call('complete'); assert.equal(f.service.ready, true);
  const second = new DesktopMigration({ stateDir: f.root, profile: f.profile, legacyRequired: true });
  assert.deepEqual(await second.request('desktop_migration_inspect', {}), { state: 'profile', version: 1, mode: 'fresh' });
  assert.equal(second.ready, false); await second.request('desktop_migration_complete', {}); assert.equal(second.ready, true);
});
test('automatic reader result must pass main HMAC verification before any import', async () => {
  const id = randomUUID(), manifest = { exportId: id };
  const f = await fixture(true, { inspect: async () => ({ state: 'none' }), verify: async actual => { assert.equal(actual, id); return manifest; } });
  f.service.reader = { run: async () => id };
  assert.deepEqual(await f.call('prepare'), { state: 'ready', manifest });
  assert.equal(f.service.ready, false);
  f.service.store.verify = async () => { throw new Error('migration_signature_invalid'); };
  await assert.rejects(f.call('prepare'), /migration_signature_invalid/);
});
test('import reads only the verified export with bounded chunks and writes the main-owned receipt', async () => {
  const id = randomUUID(), manifest = { exportId: id, installation: 'a'.repeat(64), totals: { records: 3 } };
  const payload = Buffer.alloc(1024 * 1024 + 9, 3), receipts = [];
  const f = await fixture(true, { inspect: async () => ({ state: 'ready', manifest }), readBlob: async () => payload,
    writeReceipt: async (...args) => receipts.push(args) });
  await f.call('inspect');
  await assert.rejects(f.call('read', { exportId: randomUUID(), kind: 'blob', sha256: 'b'.repeat(64), offset: 0 }), /migration_export_not_verified/);
  const first = await f.call('read', { exportId: id, kind: 'blob', sha256: 'b'.repeat(64), offset: 0 });
  assert.equal(first.data.byteLength, 1024 * 1024); assert.equal(first.done, false);
  const second = await f.call('read', { exportId: id, kind: 'blob', sha256: 'b'.repeat(64), offset: first.next });
  assert.equal(second.data.byteLength, 9); assert.equal(second.done, true);
  await f.call('complete', { exportId: id });
  assert.equal(receipts.length, 1); assert.equal(receipts[0][1].records, 3);
  assert.equal(JSON.parse(await readFile(f.service.marker)).exportId, id);
});

test('invalid old export can be regenerated from source without allowing a fresh profile', async () => {
  const id = randomUUID(), manifest = { exportId: id };
  const f = await fixture(true, { inspect: async () => ({ state: 'invalid' }), verify: async () => manifest });
  f.service.reader = { run: async () => id };
  assert.deepEqual(await f.call('inspect'), { state: 'invalid' });
  await assert.rejects(f.call('complete'), /migration_export_not_verified/);
  assert.deepEqual(await f.call('prepare'), { state: 'ready', manifest });
  const fresh = await fixture(false, { inspect: async () => ({ state: 'invalid' }) });
  assert.deepEqual(await fresh.call('prepare'), { state: 'invalid' });
});

test('old exports are refreshed after legacy writes; a committed profile never silently reads stale data', async () => {
  let fingerprint = 'a'.repeat(64), runs = 0;
  const first = { exportId: randomUUID(), installation: 'd'.repeat(64), totals: { records: 2 } };
  const fresh = { ...first, exportId: randomUUID() };
  let manifest = first;
  const f = await fixture(true, { inspect: async () => ({ state: 'ready', manifest }), verify: async () => fresh, writeReceipt: async () => {} });
  f.service.fingerprint = async () => fingerprint;
  f.service.reader = { run: async () => { runs++; manifest = fresh; return fresh.exportId; } };
  await f.service.writeSourceBinding({ version: 1, exportId: first.exportId, fingerprint });
  assert.equal((await f.call('inspect')).manifest.exportId, first.exportId);
  fingerprint = 'b'.repeat(64);
  assert.deepEqual(await f.call('inspect'), { state: 'transition_required' });
  assert.deepEqual(await f.call('prepare'), { state: 'ready', manifest: fresh, replacesExportId: first.exportId });
  assert.equal(runs, 1);
  const restart = new DesktopMigration({ stateDir: f.root, profile: f.profile, legacyRequired: true,
    reader: f.service.reader, store: f.service.store, sourceFingerprint: async () => fingerprint });
  assert.equal((await restart.request('desktop_migration_inspect', {})).replacesExportId, first.exportId);
  await restart.request('desktop_migration_complete', { exportId: fresh.exportId });
  assert.equal((await restart.request('desktop_migration_inspect', {})).state, 'profile');
  fingerprint = 'c'.repeat(64);
  assert.equal((await restart.request('desktop_migration_inspect', {})).state, 'profile');
  assert.equal(JSON.parse(await readFile(restart.marker)).exportId, fresh.exportId);
});

test('an old desktop starting during source binding cannot authorize the exported snapshot', async () => {
  const id = randomUUID(), manifest = { exportId: id };
  const f = await fixture(true, { inspect: async () => ({ state: 'none' }), verify: async () => manifest });
  let snapshots = 0;
  f.service.fingerprint = async () => { snapshots++; return 'a'.repeat(64); };
  f.service.reader = { run: async () => id, assertSourceIdle: async () => { assert.ok(snapshots >= 2); throw new Error('migration_close_old_app'); } };
  await assert.rejects(f.call('prepare'), /migration_close_old_app/);
  assert.equal(await f.service.sourceBinding(), undefined);
  await assert.rejects(f.call('read', { exportId: id, kind: 'part', index: 0, offset: 0 }), /migration_export_not_verified/);
  assert.equal(f.service.ready, false);
});


test('legacy data writes show an optional notice; deleting source data or dismissing it never blocks the profile', async () => {
  const id = randomUUID(), f = await fixture(true);
  await writeFile(f.service.marker, JSON.stringify({ version: 1, mode: 'imported', exportId: id }));
  const files = [['0/IndexedDB/origin/db.sqlite3', '128', '10']];
  await f.service.writeSourceBinding({ version: 1, exportId: id, fingerprint: 'a'.repeat(64), files });
  let current = { fingerprint: 'a'.repeat(64), files };
  f.service.snapshot = async () => current;
  assert.equal((await f.call('inspect')).sourceChanged, undefined);
  current = { fingerprint: 'b'.repeat(64), files: [] };
  assert.equal((await f.call('inspect')).sourceChanged, undefined);
  current = { fingerprint: 'c'.repeat(64), files: [['0/IndexedDB/origin/db.sqlite3', '256', '20']] };
  assert.equal((await f.call('inspect')).sourceChanged, true);
  await f.call('complete', { exportId: id }); assert.equal(f.service.ready, true);
  await f.call('complete', { exportId: id, acknowledgeSourceChange: true });
  assert.equal((await f.call('inspect')).sourceChanged, undefined);
  assert.equal(JSON.parse(await readFile(f.service.sourceMarker)).fingerprint, 'a'.repeat(64), 'acknowledgment must not rewrite the export baseline');
  await unlink(f.service.marker);
  f.service.store = { inspect: async () => ({ state: 'ready', manifest: { exportId: id } }) };
  f.service.fingerprint = async () => current.fingerprint; f.service.reader = {};
  assert.deepEqual(await f.call('inspect'), { state: 'transition_required' });
  await writeFile(f.service.marker, JSON.stringify({ version: 1, mode: 'imported', exportId: id }));
  f.service.snapshot = async () => { throw new Error('permission denied'); };
  assert.equal((await f.call('inspect')).state, 'profile');
});
test('a removed source can resume its verified snapshot, while unreadable or corrupted metadata cannot mask newer data', async () => {
  const id = randomUUID(), manifest = { exportId: id }, f = await fixture(true, { inspect: async () => ({ state: 'ready', manifest }) });
  f.service.reader = {}; f.service.fingerprint = async () => 'b'.repeat(64);
  f.service.snapshot = async () => ({ fingerprint: 'b'.repeat(64), files: [], missing: true });
  await f.service.writeSourceBinding({ version: 1, exportId: id, fingerprint: 'a'.repeat(64), files: [] });
  assert.equal((await f.call('inspect')).manifest.exportId, id);
  f.service.snapshot = async () => { throw new Error('permission denied'); };
  await assert.rejects(f.call('inspect'), /permission denied/);
  f.service.snapshot = async () => ({ fingerprint: 'b'.repeat(64), files: [], missing: false });
  await writeFile(f.service.sourceMarker, '{partial write');
  assert.deepEqual(await f.call('inspect'), { state: 'transition_required' });
});

/** A real HMAC-signed, installation-bound export with the Rust layout. */
async function signedExport(state, marker = Buffer.alloc(32, 7)) {
  const exportId = randomUUID(), dir = path.join(state, 'desktop-migration', 'exports', exportId);
  await mkdir(path.join(dir, 'parts'), { recursive: true }); await mkdir(path.join(dir, 'blobs'));
  const text = JSON.stringify({ d: 'tarocub-hosts-v1', s: 'meta', k: 'desktopMigrationEmpty', v: '1' }) + '\n';
  await writeFile(path.join(dir, 'parts', '000000.jsonl'), text);
  const sha = createHash('sha256').update(text).digest('hex');
  const manifest = Buffer.from(JSON.stringify({ format: 'tarobot-desktop-migration', version: 1, exportId, createdAt: Date.now(), installation: installationBinding(marker),
    source: { app: 'tauri', appVersion: '1.0.119' }, databases: [{ name: 'tarocub-hosts-v1', version: 2, stores: { meta: 1 } }], localStorage: 0,
    parts: [{ file: '000000.jsonl', bytes: Buffer.byteLength(text), sha256: sha, records: 1 }], blobs: [], totals: { records: 1, bytes: Buffer.byteLength(text) }, skipped: [], requiresRepair: [] }));
  await writeFile(path.join(dir, 'manifest.json'), manifest);
  await writeFile(path.join(dir, 'manifest.mac'), createHmac('sha256', macKey(marker)).update(manifest).digest('hex'));
  return exportId;
}
test('an import committed before its receipt finishes from that verified export; a newer snapshot never replaces it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-migration-committed-')), profile = path.join(root, 'profile'); await mkdir(profile);
  await writeFile(path.join(root, 'tarobot-client-installation-v1'), Buffer.alloc(32, 7));
  const committed = await signedExport(root), newer = await signedExport(root);
  let exports = 0, current = { fingerprint: 'c'.repeat(64), files: [['0/IndexedDB/origin/db.sqlite3', '256', '20']] };
  const start = () => { const service = new DesktopMigration({ stateDir: root, profile, legacyRequired: true, store: new MigrationStore(root), reader: { run: async () => { exports++; return newer; } } });
    service.fingerprint = async () => current.fingerprint; service.snapshot = async () => current; return service; };
  // An earlier build already re-exported the changed source and bound it to the newer export.
  let service = start();
  await service.writeSourceBinding({ version: 1, exportId: newer, fingerprint: 'b'.repeat(64), files: [['0/IndexedDB/origin/db.sqlite3', '128', '10']] });
  await assert.rejects(service.request('desktop_migration_inspect', { committedExportId: 'not-a-uuid' }), /invalid_migration_request/);
  await assert.rejects(service.request('desktop_migration_inspect', { committedExportId: committed.toUpperCase() }), /invalid_migration_export/);
  await assert.rejects(service.request('desktop_migration_inspect', { committedExportId: randomUUID() }), /migration_export_missing/);
  const inspected = await service.request('desktop_migration_inspect', { committedExportId: committed });
  assert.equal(inspected.state, 'committed'); assert.equal(inspected.manifest.exportId, committed); assert.equal(inspected.sourceChanged, true);
  await assert.rejects(service.request('desktop_migration_complete', { exportId: newer }), /migration_export_not_verified/);
  await service.request('desktop_migration_complete', { exportId: committed });
  assert.equal(exports, 0, 'no new export is taken over committed data');
  assert.deepEqual(JSON.parse(await readFile(service.marker)), { version: 1, mode: 'imported', exportId: committed });
  assert.equal((await new MigrationStore(root).receipt(committed)).exportId, committed);
  assert.equal(await new MigrationStore(root).receipt(newer), undefined);
  assert.deepEqual(await service.sourceBinding(), { version: 1, exportId: committed, fingerprint: 'c'.repeat(64), files: [] });
  // The notice persists across a restart until acknowledged, then stays quiet.
  assert.equal((await start().request('desktop_migration_inspect', {})).sourceChanged, true);
  await service.request('desktop_migration_complete', { exportId: committed, acknowledgeSourceChange: true });
  service = start(); assert.equal((await service.request('desktop_migration_inspect', { committedExportId: newer })).state, 'profile', 'an established profile ignores a renderer-supplied export');
  assert.equal((await service.request('desktop_migration_inspect', {})).sourceChanged, undefined);
});
test('a committed import keeps its own baseline and refuses forged or foreign exports', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-migration-committed-')), profile = path.join(root, 'profile'); await mkdir(profile);
  await writeFile(path.join(root, 'tarobot-client-installation-v1'), Buffer.alloc(32, 7));
  const own = await signedExport(root), tampered = await signedExport(root), foreign = await signedExport(root, Buffer.alloc(32, 9));
  const mac = path.join(root, 'desktop-migration', 'exports', tampered, 'manifest.mac');
  await writeFile(mac, (await readFile(mac, 'utf8')).replace(/^./, c => c === '0' ? '1' : '0'));
  const files = [['0/IndexedDB/origin/db.sqlite3', '128', '10']];
  const service = new DesktopMigration({ stateDir: root, profile, legacyRequired: true, store: new MigrationStore(root), reader: {} });
  service.snapshot = async () => ({ fingerprint: 'a'.repeat(64), files });
  await service.writeSourceBinding({ version: 1, exportId: own, fingerprint: 'a'.repeat(64), files });
  await assert.rejects(service.request('desktop_migration_inspect', { committedExportId: tampered }), /migration_signature_invalid/);
  await assert.rejects(service.request('desktop_migration_inspect', { committedExportId: foreign }), /migration_signature_invalid/);
  await assert.rejects(service.request('desktop_migration_complete', { exportId: tampered }), /migration_export_not_verified/);
  assert.deepEqual(await service.request('desktop_migration_inspect', { committedExportId: own }), { state: 'committed', manifest: await new MigrationStore(root).verify(own) });
  await service.request('desktop_migration_complete', { exportId: own });
  assert.deepEqual(await service.sourceBinding(), { version: 1, exportId: own, fingerprint: 'a'.repeat(64), files }, 'its own export baseline is never reset');
});
