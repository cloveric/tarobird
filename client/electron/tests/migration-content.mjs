// Content of e2e/fixtures/desktop-migration-native.ts after an Electron import.
// Shared by the packaged import smoke and the persisted Windows audit, so both
// assert the same records, draft, attachment, queue and reload behaviour.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';

export const gateDone = page => page.waitForFunction(() => !document.querySelector('.desktop-migration-gate') && !!document.querySelector('.host-workspace'), null, { timeout: 30000 });

/** `receipt` is the seed's tauri-export.json (hostId, databaseName). */
export async function assertImported(page, { receipt, state, exportId, marker }) {
  const after = await page.evaluate(async ({ databaseName }) => {
    const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const db = await request(indexedDB.open(databaseName));
    const tx = db.transaction(['settings', 'outbox', 'conversationDrafts']);
    const [draft, identity, outbox, rich] = await Promise.all([request(tx.objectStore('settings').get('draft:conv_migration')),
      request(tx.objectStore('settings').get('identity')), request(tx.objectStore('outbox').getAll()), request(tx.objectStore('conversationDrafts').get('conv_migration'))]);
    db.close();
    const registry = await request(indexedDB.open('tarocub-hosts-v1'));
    const [hosts, keys, values] = await Promise.all([request(registry.transaction('hosts').objectStore('hosts').getAll()),
      request(registry.transaction('meta').objectStore('meta').getAllKeys()), request(registry.transaction('meta').objectStore('meta').getAll())]); registry.close();
    const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    return { draft, keyRef: identity.keyRef, outbox, hosts, meta: Object.fromEntries(keys.map((k, i) => [k, values[i]])),
      files: await Promise.all(rich.files.map(async f => ({ name: f.name, type: f.type, lastModified: f.lastModified, size: f.bytes.byteLength, sha256: await digest(f.bytes) }))),
      local: localStorage.getItem('tarobot-migration-acceptance'), unrelated: localStorage.getItem('unrelated-acceptance') };
  }, receipt);
  assert.equal(after.draft, '来自 WKWebView 的草稿'); assert.equal(after.keyRef, 'device_migration_acceptance');
  assert.equal(after.outbox.length, 1); assert.equal(after.outbox[0].id, 'client_migration_once');
  assert.equal(after.outbox[0].frame.text, '保留队列，不重新发送');
  assert.ok(after.hosts.some(h => h.id === receipt.hostId && h.databaseName === receipt.databaseName));
  assert.deepEqual(after.files, [{ name: '迁移附件.txt', type: 'text/plain', lastModified: 1700000000000, size: 150000,
    sha256: createHash('sha256').update(new Uint8Array(150000).map((_, i) => i % 251)).digest('hex') }]);
  assert.equal(after.local, 'retain'); assert.equal(after.unrelated, null);
  const profile = JSON.parse(await readFile(path.join(state, 'electron-profile/tarobot-desktop-profile-v1.json'), 'utf8'));
  assert.equal(profile.mode, 'imported'); assert.equal(profile.exportId, exportId);
  if (marker) assert.deepEqual(await readFile(path.join(state, 'native-state/tarobot-client-installation-v1')), marker);
  return { after, profile };
}

/** A second startup must use the same imported profile, without adding queue entries. */
export async function assertReloadKeepsQueue(page, receipt) {
  await page.reload(); await gateDone(page);
  const queued = await page.evaluate(async databaseName => {
    const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const db = await request(indexedDB.open(databaseName));
    const entries = await request(db.transaction('outbox').objectStore('outbox').getAll()); db.close();
    return entries.map(entry => entry.id);
  }, receipt.databaseName);
  assert.deepEqual(queued, ['client_migration_once']);
}
