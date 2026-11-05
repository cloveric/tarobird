import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';

// Unpacking the person's chosen extension package into an App-owned staging
// copy. Every name and size is checked before anything is decompressed or
// written; the staged copy (not the source) is what is reviewed and loaded.
// Bounds admit the real AdBlock 6.51 package (71.7 MB, 442 files, 312 MB, largest 18.2 MB).
export const ARCHIVE_LIMITS = Object.freeze({ packageBytes: 128 * 1024 * 1024, bytes: 512 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, files: 20000 });
const inflate = promisify(inflateRaw);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Relative package path → safe POSIX parts, or throws. No absolute, parent,
 * drive, backslash, control or Windows-invalid names can leave the package. */
export function packagePath(name) {
  const parts = String(name).split('/');
  if (!name || name.length > 1024 || /[\\\0-\x1f<>:"|?*\x7f]/.test(name)
    || parts.some(part => !part || part === '.' || part === '..' || part.length > 255 || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part))) throw new Error('package_path_invalid');
  return parts;
}
/** A case-insensitive or Unicode-normalizing file system must not let one name
 * replace another (e.g. MANIFEST.json over the reviewed manifest.json), and a
 * file cannot also be a directory. */
export function checkNames(names) {
  const files = new Set(), directories = new Set();
  const fold = value => value.normalize('NFC').toLowerCase();
  for (const name of names) {
    const parts = packagePath(name), key = fold(name);
    if (files.has(key) || directories.has(key)) throw new Error('package_path_collision');
    files.add(key);
    for (let index = 1; index < parts.length; index++) directories.add(fold(parts.slice(0, index).join('/')));
  }
  for (const directory of directories) if (files.has(directory)) throw new Error('package_path_collision');
}

/** ZIP central directory → entries. Encrypted, ZIP64, multi-disk, linked or
 * unknown-method entries are refused; nothing is inflated here. */
export function zipEntries(bytes) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length > ARCHIVE_LIMITS.packageBytes) throw new Error('package_too_large');
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 65535); at--) if (data.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new Error('package_format_unsupported');
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), offset = data.readUInt32LE(end + 16);
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || count !== data.readUInt16LE(end + 8) || count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('package_format_unsupported');
  if (count > ARCHIVE_LIMITS.files) throw new Error('package_too_large');
  if (offset + size > end) throw new Error('package_format_unsupported');
  const entries = [], decoder = new TextDecoder('utf-8', { fatal: true });
  let at = offset, total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) throw new Error('package_format_unsupported');
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), crc = data.readUInt32LE(at + 16), compressed = data.readUInt32LE(at + 20), length = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32), mode = data.readUInt32LE(at + 38) >>> 16, local = data.readUInt32LE(at + 42);
    if (at + 46 + nameLength > end) throw new Error('package_format_unsupported');
    let name;
    try { name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength)); } catch { throw new Error('package_path_invalid'); }
    at += 46 + nameLength + extra + comment;
    if (flags & 1) throw new Error('package_encrypted');
    if (compressed === 0xffffffff || length === 0xffffffff || local === 0xffffffff) throw new Error('package_format_unsupported');
    if ((mode & 0o170000) === 0o120000) throw new Error('package_symlink');
    if (name.endsWith('/')) { if (length) throw new Error('package_format_unsupported'); continue; }
    if (method !== 0 && method !== 8) throw new Error('package_format_unsupported');
    if (length > ARCHIVE_LIMITS.fileBytes || (total += length) > ARCHIVE_LIMITS.bytes) throw new Error('package_too_large');
    entries.push({ name, method, crc, compressed, length, local });
  }
  checkNames(entries.map(entry => entry.name));
  return { data, entries };
}
async function inflateEntry(data, entry) {
  const at = entry.local;
  if (at + 30 > data.length || data.readUInt32LE(at) !== 0x04034b50) throw new Error('package_format_unsupported');
  const start = at + 30 + data.readUInt16LE(at + 26) + data.readUInt16LE(at + 28);
  if (start + entry.compressed > data.length) throw new Error('package_format_unsupported');
  const raw = data.subarray(start, start + entry.compressed);
  // Inflation runs on the thread pool, bounded by the declared size.
  const output = entry.method === 0 ? Buffer.from(raw) : await inflate(raw, { maxOutputLength: Math.max(1, entry.length) }).catch(() => { throw new Error('package_format_unsupported'); });
  if (output.length !== entry.length || crc32(output) !== entry.crc) throw new Error('package_format_unsupported');
  return output;
}
async function writeStaged(staging, name, bytes) {
  const target = path.join(staging, ...packagePath(name));
  if (path.relative(staging, target).startsWith('..')) throw new Error('package_path_invalid');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  // `wx`: the staging directory is new, so an existing file means a name alias.
  await writeFile(target, bytes, { mode: 0o600, flag: 'wx' }).catch(error => { throw new Error(error?.code === 'EEXIST' ? 'package_path_collision' : 'extension_write_failed'); });
}

/** Archives often wrap the extension in one folder: the shallowest manifest wins. */
function root(names) {
  const manifest = names.filter(name => name === 'manifest.json' || name.endsWith('/manifest.json')).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!manifest) throw new Error('manifest_missing');
  return manifest.slice(0, -'manifest.json'.length);
}
/** Unzip a validated archive into `staging` (which must not exist yet). */
export async function stageZip(bytes, staging) {
  const { data, entries } = zipEntries(bytes), prefix = root(entries.map(entry => entry.name));
  await mkdir(staging, { recursive: false, mode: 0o700 });
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    await writeStaged(staging, entry.name.slice(prefix.length), await inflateEntry(data, entry));
  }
}

/** Copy a chosen folder without following links. The tree is snapshotted
 * first (each directory canonically inside the chosen root); each file is then
 * opened with O_NOFOLLOW, must be the same inode the snapshot saw, and is read
 * with bounded size, so a swapped link, directory or growing file is refused. */
export async function stageFolder(source, staging) {
  const status = await lstat(source);
  if (!status.isDirectory()) throw new Error('package_unreadable');
  const base = await realpath(source), inside = async target => { const real = await realpath(target); if (real !== base && !real.startsWith(`${base}${path.sep}`)) throw new Error('package_symlink'); };
  const files = [];
  let total = 0;
  const walk = async (directory, relative) => {
    await inside(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name, file = path.join(directory, entry.name), info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('package_symlink');
      if (info.isDirectory()) { await walk(file, name); continue; }
      if (!info.isFile()) continue;
      packagePath(name);
      if (files.length >= ARCHIVE_LIMITS.files || info.size > ARCHIVE_LIMITS.fileBytes || (total += info.size) > ARCHIVE_LIMITS.bytes) throw new Error('package_too_large');
      files.push({ name, file, dev: info.dev, ino: info.ino });
    }
  };
  await walk(source, '');
  checkNames(files.map(item => item.name));
  if (!files.some(item => item.name === 'manifest.json')) throw new Error('manifest_missing');
  await mkdir(staging, { recursive: false, mode: 0o700 });
  let copied = 0;
  for (const { name, file, dev, ino } of files) {
    await inside(path.dirname(file));
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => { throw new Error(error?.code === 'ELOOP' ? 'package_symlink' : 'package_unreadable'); });
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== dev || info.ino !== ino) throw new Error('package_changed');
      // Read at most one byte past the limit: a file that grew is refused, not truncated.
      const buffer = Buffer.alloc(Math.min(ARCHIVE_LIMITS.fileBytes, info.size) + 1);
      let length = 0;
      for (;;) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; if (length === buffer.length) break; }
      if (length > Math.min(ARCHIVE_LIMITS.fileBytes, info.size)) throw new Error(length > ARCHIVE_LIMITS.fileBytes ? 'package_too_large' : 'package_changed');
      if ((copied += length) > ARCHIVE_LIMITS.bytes) throw new Error('package_too_large');
      await writeStaged(staging, name, buffer.subarray(0, length));
    } finally { await handle.close(); }
  }
}
