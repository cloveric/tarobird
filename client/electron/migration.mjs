import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, open, readdir, readFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Mirrors client/src-tauri/src/desktop_migration.rs. The renderer never sees a
// filesystem path: it names an export by ID and parts by index or SHA-256.
export const MIGRATION_FORMAT = 'tarobot-desktop-migration';
export const MIGRATION_VERSION = 1;
export const LIMITS = Object.freeze({
  manifest: 4 * 1024 * 1024, part: 32 * 1024 * 1024, blob: 128 * 1024 * 1024, parts: 4096, blobs: 65_536,
  total: 4 * 1024 * 1024 * 1024, skipped: 10_000, repair: 1024, receipt: 64 * 1024,
});
const MARKER = 'tarobot-client-installation-v1';
const DIRECTORY = 'desktop-migration';
const REGISTRY = 'tarocub-hosts-v1';
const REGISTRY_STORES = ['hosts', 'meta', 'networkCandidates'];
const HOST_STORES = ['settings', 'conversations', 'messages', 'activity', 'cursors', 'outbox', 'conversationDrafts', 'attachmentData', 'attachmentMeta', 'downloadMeta', 'downloadChunks', 'workbenchLayouts', 'workbenchBoards', 'workbenchMarkdown', 'workbenchDesign', 'workbenchDesignMeta', 'workbenchDesignObjects'];
const EXPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const HUB = /^hub_[0-9a-f]{64}$/;

export function hostDatabase(name) {
  return name === 'tarocub-v1' || /^tarocub-host-hub_[0-9a-f]{64}-[A-Za-z0-9-]{1,64}$/.test(name);
}
const fail = code => { throw new Error(code); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const count = value => Number.isSafeInteger(value) && value >= 0;

export function macKey(marker) {
  return createHmac('sha256', marker).update('tarobot/desktop-migration/v1').digest();
}
export function installationBinding(marker) {
  return createHash('sha256').update('tarobot/desktop-migration/installation/v1\0').update(marker).digest('hex');
}

/** Structural validation of the authoritative manifest written by Rust. */
export function validateManifest(body) {
  if (!exact(body, ['format', 'version', 'exportId', 'createdAt', 'installation', 'source', 'databases', 'localStorage', 'parts', 'blobs', 'totals', 'skipped', 'requiresRepair'])
    || body.format !== MIGRATION_FORMAT || body.version !== MIGRATION_VERSION || !EXPORT_ID.test(body.exportId) || !count(body.createdAt)
    || !SHA.test(body.installation) || !exact(body.source, ['app', 'appVersion']) || body.source.app !== 'tauri'
    || typeof body.source.appVersion !== 'string' || !/^[A-Za-z0-9.+-]{1,64}$/.test(body.source.appVersion)) fail('migration_manifest_invalid');
  let records = count(body.localStorage) ? body.localStorage : fail('migration_manifest_invalid');
  if (!Array.isArray(body.databases) || !body.databases.length || body.databases.length > 1025) fail('migration_manifest_invalid');
  const names = new Set();
  for (const database of body.databases) {
    if (!exact(database, ['name', 'version', 'stores']) || names.has(database.name) || !Number.isSafeInteger(database.version) || database.version < 1 || database.version > 1000
      || !isObject(database.stores) || !Object.keys(database.stores).length) fail('migration_manifest_invalid');
    const allowed = database.name === REGISTRY ? REGISTRY_STORES : hostDatabase(database.name) ? HOST_STORES : fail('migration_manifest_invalid');
    for (const [store, value] of Object.entries(database.stores)) {
      if (!allowed.includes(store) || !count(value) || value === 0) fail('migration_manifest_invalid');
      records += value;
    }
    names.add(database.name);
  }
  if (!names.has(REGISTRY)) fail('migration_manifest_invalid');
  if (!Array.isArray(body.parts) || !body.parts.length || body.parts.length > LIMITS.parts) fail('migration_manifest_invalid');
  let partRecords = 0, bytes = 0;
  body.parts.forEach((part, index) => {
    if (!exact(part, ['file', 'bytes', 'sha256', 'records']) || part.file !== `${String(index).padStart(6, '0')}.jsonl`
      || !count(part.bytes) || part.bytes === 0 || part.bytes > LIMITS.part || !SHA.test(part.sha256) || !count(part.records) || part.records === 0) fail('migration_manifest_invalid');
    partRecords += part.records; bytes += part.bytes;
  });
  if (!Array.isArray(body.blobs) || body.blobs.length > LIMITS.blobs) fail('migration_manifest_invalid');
  const blobs = new Set();
  for (const blob of body.blobs) {
    if (!exact(blob, ['sha256', 'bytes']) || !SHA.test(blob.sha256) || blobs.has(blob.sha256) || !count(blob.bytes) || blob.bytes > LIMITS.blob) fail('migration_manifest_invalid');
    blobs.add(blob.sha256); bytes += blob.bytes;
  }
  if (!exact(body.totals, ['records', 'bytes']) || body.totals.records !== records || records !== partRecords || body.totals.bytes !== bytes || bytes > LIMITS.total) fail('migration_manifest_mismatch');
  if (!Array.isArray(body.skipped) || body.skipped.length > LIMITS.skipped) fail('migration_manifest_invalid');
  if (!Array.isArray(body.requiresRepair) || body.requiresRepair.length > LIMITS.repair || !body.requiresRepair.every(id => typeof id === 'string' && HUB.test(id))) fail('migration_manifest_invalid');
  return body;
}

/** Every directory on the export path must be a real directory: a symlinked
 * root, exports, parts, blobs or receipts directory is refused, not followed. */
async function realDirectory(directory, missing = 'migration_export_missing') {
  const status = await lstat(directory).catch(() => fail(missing));
  if (!status.isDirectory() || status.isSymbolicLink()) fail('migration_storage_invalid');
}
async function regularFile(file, maximum) {
  const status = await lstat(file).catch(() => fail('migration_file_missing'));
  if (!status.isFile() || status.isSymbolicLink() || status.size > maximum) fail('migration_file_invalid');
  return status.size;
}
async function readBounded(file, maximum) {
  await regularFile(file, maximum);
  const bytes = await readFile(file);
  if (bytes.length > maximum) fail('migration_file_invalid');
  return bytes;
}
async function writeAtomic(file, bytes) {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } catch { /* Windows cannot fsync a directory handle. */ } finally { await directory.close(); }
}

/** One App-local data directory (the helper's --state-dir), fixed by main. */
export class MigrationStore {
  #root; #state;
  constructor(stateDir) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || stateDir.includes('\0')) fail('invalid_migration_state_dir');
    this.#state = stateDir; this.#root = path.join(stateDir, DIRECTORY);
  }
  #export(exportId) { return EXPORT_ID.test(exportId) ? path.join(this.#root, 'exports', exportId) : fail('invalid_migration_export'); }
  async #exportDirectory(exportId, subdirectory) {
    const directory = this.#export(exportId);
    await realDirectory(this.#root); await realDirectory(path.join(this.#root, 'exports')); await realDirectory(directory);
    if (subdirectory) await realDirectory(path.join(directory, subdirectory), 'migration_export_invalid');
    return subdirectory ? path.join(directory, subdirectory) : directory;
  }
  #receipt(exportId) { return EXPORT_ID.test(exportId) ? path.join(this.#root, 'receipts', `${exportId}.json`) : fail('invalid_migration_export'); }
  async #marker() {
    const marker = await readBounded(path.join(this.#state, MARKER), 32).catch(() => fail('migration_installation_unavailable'));
    return marker.length === 32 ? marker : fail('migration_installation_unavailable');
  }

  /** Full verification: MAC, installation binding, manifest bounds and the
   * exact set, size and SHA-256 of every part and blob. */
  async verify(exportId) {
    const directory = await this.#exportDirectory(exportId);
    await realDirectory(path.join(directory, 'parts'), 'migration_export_invalid');
    await realDirectory(path.join(directory, 'blobs'), 'migration_export_invalid');
    const marker = await this.#marker();
    const manifest = await readBounded(path.join(directory, 'manifest.json'), LIMITS.manifest);
    const mac = Buffer.from((await readBounded(path.join(directory, 'manifest.mac'), 64)).toString('ascii'), 'hex');
    const expected = createHmac('sha256', macKey(marker)).update(manifest).digest();
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) fail('migration_signature_invalid');
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest)); } catch { fail('migration_manifest_invalid'); }
    validateManifest(body);
    if (body.exportId !== exportId) fail('migration_manifest_mismatch');
    if (body.installation !== installationBinding(marker)) fail('migration_installation_mismatch');
    const entries = (await readdir(directory)).sort();
    if (entries.join() !== ['blobs', 'manifest.json', 'manifest.mac', 'parts'].join()) fail('migration_export_invalid');
    const parts = (await readdir(path.join(directory, 'parts'))).sort();
    if (parts.join() !== body.parts.map(part => part.file).join()) fail('migration_export_invalid');
    const blobs = (await readdir(path.join(directory, 'blobs'))).sort();
    if (blobs.join() !== body.blobs.map(blob => blob.sha256).sort().join()) fail('migration_export_invalid');
    for (const part of body.parts) await this.#checked(path.join(directory, 'parts', part.file), part.bytes, part.sha256);
    for (const blob of body.blobs) await this.#checked(path.join(directory, 'blobs', blob.sha256), blob.bytes, blob.sha256);
    return body;
  }
  async #checked(file, size, sha) {
    const bytes = await readBounded(file, size);
    if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== sha) fail('migration_content_mismatch');
    return bytes;
  }

  /** Newest committed export without a receipt, after full verification.
   * Invalid exports are reported by ID and code, never repaired or deleted. */
  async inspect() {
    let ids = [];
    try {
      await realDirectory(this.#root); await realDirectory(path.join(this.#root, 'exports'));
      ids = (await readdir(path.join(this.#root, 'exports'), { withFileTypes: true })).filter(entry => entry.isDirectory() && EXPORT_ID.test(entry.name)).map(entry => entry.name);
    } catch (error) { if (error.message !== 'migration_export_missing') throw error.message === 'migration_storage_invalid' ? error : new Error('migration_storage_failed'); }
    const valid = [], invalid = [];
    for (const id of ids) {
      try { valid.push(await this.verify(id)); } catch (error) { invalid.push({ exportId: id, error: error.message }); }
    }
    valid.sort((a, b) => b.createdAt - a.createdAt || b.exportId.localeCompare(a.exportId));
    const latest = valid[0];
    if (!latest) return { state: invalid.length ? 'invalid' : 'none', invalid };
    const receipt = await this.receipt(latest.exportId);
    return { state: receipt ? 'imported' : 'ready', manifest: latest, receipt, invalid };
  }

  /** Re-hashes on every read: what the renderer receives is what was verified. */
  async readPart(exportId, index, manifest) {
    const part = Number.isSafeInteger(index) ? manifest.parts[index] : undefined;
    if (!part || manifest.exportId !== exportId) fail('invalid_migration_part');
    const bytes = await this.#checked(path.join(await this.#exportDirectory(exportId, 'parts'), part.file), part.bytes, part.sha256);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  async readBlob(exportId, sha256, manifest) {
    const blob = typeof sha256 === 'string' && SHA.test(sha256) ? manifest.blobs.find(entry => entry.sha256 === sha256) : undefined;
    if (!blob || manifest.exportId !== exportId) fail('invalid_migration_blob');
    return this.#checked(path.join(await this.#exportDirectory(exportId, 'blobs'), sha256), blob.bytes, sha256);
  }

  async receipt(exportId) {
    const file = this.#receipt(exportId);
    try { await realDirectory(this.#root); await realDirectory(path.dirname(file)); }
    catch (error) { if (error.message === 'migration_export_missing') return undefined; throw error; }
    try { return JSON.parse((await readBounded(file, LIMITS.receipt)).toString('utf8')); }
    catch (error) { if (error.message === 'migration_file_missing') return undefined; throw new Error('migration_receipt_invalid'); }
  }
  /** Durable, idempotent receipt; a different receipt for the same export is a conflict. */
  async writeReceipt(exportId, receipt) {
    if (!isObject(receipt) || receipt.exportId !== exportId) fail('migration_receipt_invalid');
    const bytes = Buffer.from(JSON.stringify(receipt));
    if (bytes.length > LIMITS.receipt) fail('migration_receipt_invalid');
    const existing = await this.receipt(exportId);
    if (existing) { if (JSON.stringify(existing) === JSON.stringify(receipt)) return; fail('migration_receipt_conflict'); }
    await realDirectory(this.#root);
    await mkdir(path.join(this.#root, 'receipts'), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw new Error('migration_storage_failed'); });
    await realDirectory(path.join(this.#root, 'receipts'));
    await writeAtomic(this.#receipt(exportId), bytes);
  }
}
