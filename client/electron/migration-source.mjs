import { lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** WKWebView's storage process may flush after the exporter exits. Never bind
 * a resumable snapshot to that transient state. Ongoing writes require retry. */
export async function stableLegacySnapshot(snapshot, { wait = delay, intervalMs = 1000, attempts = 10 } = {}) {
  let previous = await snapshot();
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait(intervalMs);
    const current = await snapshot();
    if (current.fingerprint === previous.fingerprint) return current;
    previous = current;
  }
  throw new Error('migration_source_busy');
}

/** Detect a restored/used legacy profile without reading message contents.
 * The exporter has exited before the baseline is captured. Directory mtimes
 * and Finder metadata are excluded; relative path, size and write time bind
 * the snapshot to the actual source files. Never follow a redirected tree. */
export async function legacySourceSnapshot(roots) {
  const entries = []; let count = 0;
  async function walk(file, relative) {
    if (++count > 200000) throw new Error('migration_source_unavailable');
    let stat;
    try { stat = await lstat(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') { entries.push([relative, 'absent']); return; } throw error; }
    if (stat.isSymbolicLink()) throw new Error('migration_source_redirected');
    if (stat.isDirectory()) {
      entries.push([relative, 'directory']);
      for (const name of (await readdir(file)).sort()) if (name !== '.DS_Store') await walk(path.join(file, name), `${relative}/${name}`);
    } else if (stat.isFile()) entries.push([relative, String(stat.size), String(stat.mtimeNs)]);
    else throw new Error('migration_source_unavailable');
  }
  for (const [index, root] of roots.entries()) await walk(root, String(index));
  const files = entries.filter(entry => entry.length === 3 && /\/(?:indexeddb|local ?storage)\//i.test(entry[0]) && !entry[0].endsWith('-shm'));
  return { fingerprint: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), files,
    missing: entries.length === roots.length && entries.every(entry => entry[1] === 'absent') };
}
export async function legacySourceFingerprint(roots) { return (await legacySourceSnapshot(roots)).fingerprint; }

/** Removal of the old source is harmless once Chromium owns the data. Only
 * writes/new persistent files warrant a notice; restored inode/device numbers
 * and non-data cache files never lock the migrated user out. */
export function legacyDataWritten(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current)) return false;
  const before = new Map(previous.map(entry => [entry[0], entry]));
  return current.some(entry => Number(entry[1]) > 0 && JSON.stringify(before.get(entry[0])) !== JSON.stringify(entry));
}
