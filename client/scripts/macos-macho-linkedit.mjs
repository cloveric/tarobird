import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

// Some macOS releases' dyld refuse an image whose LC_SYMTAB string table is
// not pointer-aligned ("mis-aligned LINKEDIT string pool", issue #15). Rust's
// Apple strip step can place it directly after an odd number of 4-byte
// indirect symbols. This reader checks every thin and universal (fat) Mach-O
// slice without depending on otool.
export const LC_SYMTAB = 0x2;
const MH_MAGIC = 0xfeedface, MH_MAGIC_64 = 0xfeedfacf, FAT_MAGIC = 0xcafebabe, FAT_MAGIC_64 = 0xcafebabf;
// Java class files share 0xcafebabe; their next word (class version) is >= 45.
const MAX_FAT_ARCHS = 32;

class MachOFormatError extends Error {}
function malformed(message) { return new MachOFormatError(`malformed Mach-O (${message})`); }

function thinSlice(read, base, size) {
  const head = read(base, 32);
  if (head.length < 4) return null;
  let little;
  if ([MH_MAGIC, MH_MAGIC_64].includes(head.readUInt32LE(0))) little = true;
  else if ([MH_MAGIC, MH_MAGIC_64].includes(head.readUInt32BE(0))) little = false;
  else return null;
  const u32 = (buffer, offset) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const bits = u32(head, 0) === MH_MAGIC_64 ? 64 : 32, headerSize = bits === 64 ? 32 : 28;
  if (head.length < headerSize) throw malformed('truncated header');
  const filetype = u32(head, 12), ncmds = u32(head, 16), sizeofcmds = u32(head, 20);
  if (headerSize + sizeofcmds > size) throw malformed('load commands exceed the image');
  const commands = read(base + headerSize, sizeofcmds);
  if (commands.length < sizeofcmds) throw malformed('truncated load commands');
  let cursor = 0, symtab = null;
  for (let index = 0; index < ncmds; index++) {
    if (cursor + 8 > sizeofcmds) throw malformed('load command table overflow');
    const cmd = u32(commands, cursor), cmdsize = u32(commands, cursor + 4);
    if (cmdsize < 8 || cursor + cmdsize > sizeofcmds) throw malformed('invalid load command size');
    if (cmd === LC_SYMTAB) {
      if (cmdsize < 24) throw malformed('short LC_SYMTAB');
      symtab = { symoff: u32(commands, cursor + 8), nsyms: u32(commands, cursor + 12), stroff: u32(commands, cursor + 16), strsize: u32(commands, cursor + 20) };
    }
    cursor += cmdsize;
  }
  // Pointer alignment: 8 bytes for 64-bit images, 4 bytes for 32-bit images.
  const alignment = bits / 8;
  return { offset: base, bits, little, cputype: u32(head, 4) | 0, cpusubtype: u32(head, 8) | 0, filetype, symtab, alignment,
    aligned: !symtab || symtab.stroff % alignment === 0 };
}

/** Returns null for non-Mach-O input, else each slice's LC_SYMTAB alignment.
 * `read(offset, length)` returns at most `length` bytes; `size` is the file size. */
export function inspectMachO(read, size) {
  const head = read(0, 8);
  if (head.length < 4) return null;
  const magic = head.readUInt32BE(0);
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    if (head.length < 8) return null;
    const count = head.readUInt32BE(4), wide = magic === FAT_MAGIC_64, entry = wide ? 32 : 20;
    if (count === 0 || count > MAX_FAT_ARCHS || 8 + count * entry > size) return null;
    const table = read(8, count * entry);
    if (table.length < count * entry) return null;
    const slices = [];
    for (let index = 0; index < count; index++) {
      const at = index * entry;
      const offset = wide ? Number(table.readBigUInt64BE(at + 8)) : table.readUInt32BE(at + 8);
      const length = wide ? Number(table.readBigUInt64BE(at + 16)) : table.readUInt32BE(at + 12);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset + length > size) throw malformed('fat slice outside the file');
      const slice = thinSlice((position, bytes) => read(position, Math.max(0, Math.min(bytes, offset + length - position))), offset, length);
      if (!slice) throw malformed('fat slice is not a Mach-O image');
      slices.push(slice);
    }
    return { format: 'fat', slices };
  }
  const slice = thinSlice(read, 0, size);
  return slice ? { format: 'thin', slices: [slice] } : null;
}

export function inspectMachOBuffer(buffer) {
  return inspectMachO((offset, length) => buffer.subarray(offset, offset + length), buffer.length);
}

export function inspectMachOFile(file) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    return inspectMachO((offset, length) => {
      const bytes = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
      const count = bytes.length ? readSync(fd, bytes, 0, bytes.length, offset) : 0;
      return bytes.subarray(0, count);
    }, size);
  } finally { closeSync(fd); }
}

export function machOStringTableViolations(report) {
  return (report?.slices ?? []).filter(slice => !slice.aligned)
    .map(slice => ({ cputype: slice.cputype, sliceOffset: slice.offset, stroff: slice.symtab.stroff, alignment: slice.alignment }));
}

/** Known third-party exceptions. Each entry matches one exact bundle-relative
 * path AND its exact misaligned stroff; a changed binary is checked again.
 * Exceptions are listed in the verification receipt, never silently passed. */
export const MACHO_STRING_TABLE_EXCEPTIONS = Object.freeze([
  Object.freeze({
    path: 'Contents/Resources/host/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node',
    stroff: 24260444,
    // TODO(#15): remove once the Host can adopt an @napi-rs/canvas release
    // with an aligned string table. 0.1.80 is pinned by pdf-parse 2.4.5.
    reason: 'Upstream @napi-rs/canvas-darwin-arm64 0.1.80 prebuilt; loaded by the Host only for PDF text extraction (issue #15)',
  }),
]);

/** Walks a directory (symlinks are not followed) and fails when any Mach-O
 * slice has a misaligned LC_SYMTAB string table, except exact listed entries. */
export async function verifyMachOStringTables(root, { exceptions = MACHO_STRING_TABLE_EXCEPTIONS } = {}) {
  const allowed = new Map(exceptions.map(entry => [entry.path, entry]));
  let checked = 0;
  const excepted = [], failures = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, file).split(path.sep).join('/');
      let report;
      try { report = inspectMachOFile(file); }
      catch (error) { if (error instanceof MachOFormatError) { failures.push(`${relative}: ${error.message}`); continue; } throw error; }
      if (!report) continue;
      checked++;
      const violations = machOStringTableViolations(report);
      if (!violations.length) continue;
      const exception = allowed.get(relative);
      if (exception && violations.every(violation => violation.stroff === exception.stroff)) excepted.push({ path: relative, stroff: exception.stroff, reason: exception.reason });
      else failures.push(`${relative}: ${violations.map(violation => `stroff=${violation.stroff} is not ${violation.alignment}-byte aligned`).join(', ')}`);
    }
  };
  await walk(root);
  if (failures.length) throw new Error(`Mach-O string table check failed: ${failures.sort().join('; ')}`);
  return { checked, excepted: excepted.sort((a, b) => a.path.localeCompare(b.path)) };
}

// Mac Rust binaries link unstripped (CARGO_PROFILE_RELEASE_STRIP=false) and are
// stripped here by Apple's strip, which keeps the string table pointer-aligned.
// `-x` keeps the global symbols a Node addon must export.
export const MAC_RUST_STRIP = Object.freeze({ command: '/usr/bin/strip', args: Object.freeze(['-x']) });

/** Strips one Mach-O in place and rejects a result dyld could refuse. */
export function stripMacBinary(file, strip = MAC_RUST_STRIP) {
  execFileSync(strip.command, [...strip.args, file], { stdio: 'pipe' });
  const report = inspectMachOFile(file);
  if (!report) throw new Error(`Stripped file is not a Mach-O image: ${path.basename(file)}`);
  const violations = machOStringTableViolations(report);
  if (violations.length) throw new Error(`${path.basename(file)} has a misaligned string table after strip (stroff=${violations[0].stroff})`);
  return report;
}
