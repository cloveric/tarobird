import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Inspect normal and delayed imports, including PE32 installer helpers. */
export function windowsImports(bytes) {
  const invalid = () => { throw new Error('windows_runtime_invalid_pe'); };
  const uint = (at, size = 4) => {
    if (at < 0 || at + size > bytes.length) return invalid();
    return size === 2 ? bytes.readUInt16LE(at) : bytes.readUInt32LE(at);
  };
  if (uint(0, 2) !== 0x5a4d) invalid();
  const pe = uint(60); if (uint(pe) !== 0x4550) invalid();
  const count = uint(pe + 6, 2), optional = pe + 24, size = uint(pe + 20, 2), magic = uint(optional, 2);
  if (![0x10b, 0x20b].includes(magic) || !count || count > 96) invalid();
  const table = optional + (magic === 0x20b ? 112 : 96), directories = uint(table - 4);
  if (directories > 16 || table + directories * 8 > optional + size) invalid();
  const sections = Array.from({ length: count }, (_, index) => {
    const at = optional + size + index * 40;
    return { address: uint(at + 12), size: uint(at + 16), offset: uint(at + 20) };
  });
  const offset = (rva, length = 1) => {
    const section = sections.find(s => rva >= s.address && rva + length <= s.address + s.size);
    if (!section) return invalid();
    const at = section.offset + rva - section.address;
    if (at + length > bytes.length) invalid();
    return at;
  };
  const result = [];
  for (const [index, stride, nameAt] of [[1, 20, 12], [13, 32, 4]]) {
    if (index >= directories) continue;
    const rva = uint(table + index * 8), length = uint(table + index * 8 + 4);
    if (!rva) continue;
    if (length < stride || length > 1024 * 1024) invalid();
    const start = offset(rva, length); let terminated = false;
    for (let position = 0; position + stride <= length; position += stride) {
      const at = start + position, nameRva = uint(at + nameAt);
      if (!nameRva) { terminated = true; break; }
      if (index === 13 && uint(at) !== 1) invalid();
      const name = offset(nameRva), end = bytes.indexOf(0, name);
      if (end <= name || end - name > 512) invalid();
      offset(nameRva, end - name + 1);
      result.push(bytes.toString('ascii', name, end));
    }
    if (!terminated) invalid();
  }
  if (!result.length) invalid();
  return result;
}

export function verifyWindowsRuntime(bytes) {
  const dependencies = windowsImports(bytes);
  const external = dependencies.filter(name => /^(?:vcruntime|msvcp|msvcr|vcomp|concrt)\d+.*\.dll$/i.test(name));
  if (external.length) throw new Error(`windows_runtime_requires_vc_redist: ${external.join(', ')}`);
  return dependencies;
}

/** Every standalone package supports Windows services, regardless of its build OS. */
export async function verifyHostLauncher(packageRoot) {
  const file = path.join(packageRoot, 'bin/tarobot-host-launcher.exe');
  const info = await lstat(file).catch(error => {
    if (error.code === 'ENOENT') throw new Error('host_package_windows_launcher_missing: run node scripts/build-host-launcher.mjs --output bin before packaging (cargo-xwin is required outside Windows)');
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('host_package_windows_launcher_unsafe');
  const bytes = await readFile(file), pe = bytes.length > 64 ? bytes.readUInt32LE(60) : 0;
  if (!pe || pe + 94 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b || bytes.readUInt16LE(pe + 92) !== 2) {
    throw new Error('host_package_windows_launcher_invalid: expected a Windows x64 GUI-subsystem executable');
  }
  verifyWindowsRuntime(bytes);
  if (!bytes.includes(Buffer.from("TAROBOT_WINDOWS_STATE_PROBE_V1"))) throw new Error("host_package_windows_launcher_probe_missing: rebuild the Windows launcher before packaging");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await verifyHostLauncher(path.resolve(process.argv[2] || '.'));
  console.log('Windows x64 host launcher verified');
}
