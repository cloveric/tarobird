import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MACHO_STRING_TABLE_EXCEPTIONS, MAC_RUST_STRIP, inspectMachOBuffer, inspectMachOFile, machOStringTableViolations, stripMacBinary,
  verifyMachOStringTables } from '../../scripts/macos-macho-linkedit.mjs';

// Synthetic thin image: header, an LC_UUID, then LC_SYMTAB with the given stroff.
function machO({ stroff, bits = 64, little = true, size = 4096 }) {
  const buffer = Buffer.alloc(size), headerSize = bits === 64 ? 32 : 28;
  const put = (value, offset) => little ? buffer.writeUInt32LE(value >>> 0, offset) : buffer.writeUInt32BE(value >>> 0, offset);
  put(bits === 64 ? 0xfeedfacf : 0xfeedface, 0); put(bits === 64 ? 0x0100000c : 7, 4); put(0, 8); put(6, 12); put(2, 16); put(48, 20);
  let at = headerSize;
  put(0x1b, at); put(24, at + 4); at += 24;
  put(0x2, at); put(24, at + 4); put(1024, at + 8); put(4, at + 12); put(stroff, at + 16); put(64, at + 20);
  return buffer;
}
function fat(slices, { wide = false } = {}) {
  const entry = wide ? 32 : 20, align = 4096, header = Buffer.alloc(8 + slices.length * entry), placed = [];
  header.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0); header.writeUInt32BE(slices.length, 4);
  let offset = align;
  slices.forEach((slice, index) => {
    const at = 8 + index * entry;
    header.writeUInt32BE(0x0100000c, at);
    if (wide) { header.writeBigUInt64BE(BigInt(offset), at + 8); header.writeBigUInt64BE(BigInt(slice.length), at + 16); header.writeUInt32BE(12, at + 24); }
    else { header.writeUInt32BE(offset, at + 8); header.writeUInt32BE(slice.length, at + 12); header.writeUInt32BE(12, at + 16); }
    placed.push([offset, slice]); offset += Math.ceil(slice.length / align) * align;
  });
  const buffer = Buffer.alloc(offset); header.copy(buffer);
  for (const [at, slice] of placed) slice.copy(buffer, at);
  return buffer;
}
// 898436 is the released 1.2.1 addon's stroff (0xDB584, 4 mod 8) from issue #15.
const ALIGNED = 898448, MISALIGNED = 898436;

test('thin 64-bit Mach-O: aligned string table passes, the released misaligned offset fails', () => {
  const good = inspectMachOBuffer(machO({ stroff: ALIGNED }));
  assert.equal(good.format, 'thin');
  assert.equal(good.slices[0].symtab.stroff, ALIGNED);
  assert.equal(good.slices[0].alignment, 8);
  assert.deepEqual(machOStringTableViolations(good), []);
  const bad = inspectMachOBuffer(machO({ stroff: MISALIGNED }));
  assert.deepEqual(machOStringTableViolations(bad), [{ cputype: 0x0100000c, sliceOffset: 0, stroff: MISALIGNED, alignment: 8 }]);
  assert.equal(MISALIGNED % 8, 4);
});

test('32-bit and big-endian images use their own byte order and pointer alignment', () => {
  assert.deepEqual(machOStringTableViolations(inspectMachOBuffer(machO({ bits: 32, stroff: 1028 }))), []);
  assert.equal(machOStringTableViolations(inspectMachOBuffer(machO({ bits: 32, stroff: 1030 })))[0].alignment, 4);
  const bigEndian = inspectMachOBuffer(machO({ stroff: MISALIGNED, little: false }));
  assert.equal(bigEndian.slices[0].little, false);
  assert.equal(machOStringTableViolations(bigEndian)[0].stroff, MISALIGNED);
});

test('universal binaries are checked slice by slice (FAT_MAGIC and FAT_MAGIC_64)', () => {
  for (const wide of [false, true]) {
    const clean = inspectMachOBuffer(fat([machO({ stroff: ALIGNED }), machO({ stroff: ALIGNED + 8 })], { wide }));
    assert.equal(clean.format, 'fat');
    assert.equal(clean.slices.length, 2);
    assert.deepEqual(machOStringTableViolations(clean), []);
    const mixed = inspectMachOBuffer(fat([machO({ stroff: ALIGNED }), machO({ stroff: MISALIGNED })], { wide }));
    assert.deepEqual(machOStringTableViolations(mixed).map(({ sliceOffset, stroff }) => ({ sliceOffset, stroff })), [{ sliceOffset: 8192, stroff: MISALIGNED }]);
  }
});

test('non-Mach-O content is ignored, including Java class files that share 0xcafebabe', () => {
  const java = Buffer.from('cafebabe0000004100', 'hex');
  for (const buffer of [Buffer.alloc(0), Buffer.from('ab'), Buffer.from('#!/bin/sh\necho ok\n'), Buffer.from('7f454c46020101', 'hex'), Buffer.from('MZ\x90\0'), java]) {
    assert.equal(inspectMachOBuffer(buffer), null);
    assert.deepEqual(machOStringTableViolations(inspectMachOBuffer(buffer)), []);
  }
});

test('malformed Mach-O load commands and fat slices are rejected, not skipped', () => {
  const zeroSize = machO({ stroff: ALIGNED }); zeroSize.writeUInt32LE(0, 32 + 4);
  assert.throws(() => inspectMachOBuffer(zeroSize), /malformed Mach-O/);
  const outside = fat([machO({ stroff: ALIGNED })]); outside.writeUInt32BE(1 << 20, 8 + 12);
  assert.throws(() => inspectMachOBuffer(outside), /fat slice outside the file/);
  const notImage = fat([Buffer.alloc(4096, 1)]);
  assert.throws(() => inspectMachOBuffer(notImage), /not a Mach-O image/);
});

test('bundle gate fails on any misaligned Mach-O, skips other files and does not follow symlinks', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'macho-gate-'));
  try {
    const app = path.join(directory, 'Fixture.app'), native = path.join(app, 'Contents/Resources/native');
    mkdirSync(native, { recursive: true });
    writeFileSync(path.join(native, 'tarobot-desktop-core'), machO({ stroff: ALIGNED }));
    writeFileSync(path.join(native, 'universal.node'), fat([machO({ stroff: ALIGNED }), machO({ stroff: ALIGNED + 16 })], { wide: true }));
    writeFileSync(path.join(native, 'update-config.json'), '{}');
    writeFileSync(path.join(directory, 'outside.node'), machO({ stroff: MISALIGNED }));
    symlinkSync(path.join(directory, 'outside.node'), path.join(native, 'linked.node'));
    assert.deepEqual(await verifyMachOStringTables(app), { checked: 2, excepted: [] });

    writeFileSync(path.join(native, 'tarobot-desktop-native.node'), machO({ stroff: MISALIGNED }));
    await assert.rejects(verifyMachOStringTables(app), /Contents\/Resources\/native\/tarobot-desktop-native\.node: stroff=898436 is not 8-byte aligned/);
    writeFileSync(path.join(native, 'tarobot-desktop-native.node'), fat([machO({ stroff: ALIGNED }), machO({ stroff: MISALIGNED })]));
    await assert.rejects(verifyMachOStringTables(app), /tarobot-desktop-native\.node: stroff=898436/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the only exception is the exact third-party skia path with its exact known offset', async () => {
  assert.equal(MACHO_STRING_TABLE_EXCEPTIONS.length, 1);
  const [skia] = MACHO_STRING_TABLE_EXCEPTIONS;
  assert.equal(skia.path, 'Contents/Resources/host/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node');
  assert.equal(skia.stroff % 8, 4);
  assert.match(skia.reason, /#15/);
  const directory = mkdtempSync(path.join(tmpdir(), 'macho-exception-'));
  try {
    const app = path.join(directory, 'Fixture.app'), file = path.join(app, skia.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, machO({ stroff: skia.stroff }));
    assert.deepEqual(await verifyMachOStringTables(app), { checked: 1, excepted: [{ path: skia.path, stroff: skia.stroff, reason: skia.reason }] });
    await assert.rejects(verifyMachOStringTables(app, { exceptions: [] }), /skia\.darwin-arm64\.node: stroff=24260444 is not 8-byte aligned/);
    // A changed upstream binary is evaluated again rather than inheriting the waiver.
    writeFileSync(file, machO({ stroff: skia.stroff + 8 * 3 }));
    await assert.rejects(verifyMachOStringTables(app), /skia\.darwin-arm64\.node: stroff=24260468/);
    // The same offset at any other path, including our own addon, is not waived.
    writeFileSync(file, machO({ stroff: ALIGNED }));
    const own = path.join(app, 'Contents/Resources/native/tarobot-desktop-native.node');
    mkdirSync(path.dirname(own), { recursive: true }); writeFileSync(own, machO({ stroff: skia.stroff }));
    await assert.rejects(verifyMachOStringTables(app), /native\/tarobot-desktop-native\.node: stroff=24260444/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Mac strip step rejects a result that is still misaligned or not a Mach-O', () => {
  assert.deepEqual(MAC_RUST_STRIP, { command: '/usr/bin/strip', args: ['-x'] });
  const directory = mkdtempSync(path.join(tmpdir(), 'macho-strip-'));
  // A no-op stand-in for strip isolates the post-strip check from Apple tools.
  const noop = { command: process.execPath, args: ['-e', ''] };
  try {
    const good = path.join(directory, 'good.node'), bad = path.join(directory, 'bad.node'), text = path.join(directory, 'text.node');
    writeFileSync(good, machO({ stroff: ALIGNED })); writeFileSync(bad, machO({ stroff: MISALIGNED })); writeFileSync(text, 'not an image');
    assert.equal(stripMacBinary(good, noop).slices[0].symtab.stroff, ALIGNED);
    assert.throws(() => stripMacBinary(bad, noop), /bad\.node has a misaligned string table after strip \(stroff=898436\)/);
    assert.throws(() => stripMacBinary(text, noop), /not a Mach-O image/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Apple strip -x keeps a dylib export and an aligned string table', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'macho-apple-strip-'));
  try {
    const source = path.join(directory, 'addon.c'), addon = path.join(directory, 'addon.node');
    writeFileSync(source, 'static int helper(int v) { return v + 1; }\nint macho_strip_fixture(int v) { return helper(v); }\n');
    execFileSync('cc', ['-dynamiclib', source, '-o', addon]);
    const report = stripMacBinary(addon);
    assert.deepEqual(machOStringTableViolations(report), []);
    assert.deepEqual(machOStringTableViolations(inspectMachOFile(addon)), []);
    assert.match(execFileSync('/usr/bin/nm', ['-gU', addon], { encoding: 'utf8' }), /_macho_strip_fixture/);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', addon], { stdio: 'pipe' });
    assert.deepEqual(machOStringTableViolations(inspectMachOFile(addon)), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
