import { macosBuildEnvironment } from './macos-artifact-paths.mjs';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw new Error('Usage: node scripts/build-host-launcher.mjs --output PATH_TO_BIN_DIRECTORY');
const target = 'x86_64-pc-windows-msvc';
const cargo = process.env.CARGO || 'cargo';
// Scope static CRT linkage to this executable. A fresh Windows installation
// must not need the separately installed Visual C++ redistributable to host Bots.
const args = [...(process.platform === 'win32' ? [] : ['xwin']), 'rustc', '--manifest-path', path.join(root, 'client/src-tauri/Cargo.toml'), '-p', 'tarobot-host-launcher', '--target', target, '--release', '--locked', '--', '-C', 'target-feature=+crt-static'];
const buildEnv = macosBuildEnvironment(root);
execFileSync(cargo, args, { cwd: root, stdio: 'inherit', shell: false, env: buildEnv });
const targetDirectory = buildEnv.CARGO_TARGET_DIR ? path.resolve(root, buildEnv.CARGO_TARGET_DIR) : path.join(root, 'client/src-tauri/target');
const binary = path.join(targetDirectory, target, 'release/tarobot-host-launcher.exe');
const bytes = await readFile(binary), pe = bytes.length > 64 ? bytes.readUInt32LE(60) : 0;
if (!pe || pe + 94 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b || bytes.readUInt16LE(pe + 92) !== 2) {
  throw new Error('Host launcher must be a Windows x64 GUI-subsystem executable');
}
const output = path.resolve(values.output); await mkdir(output, { recursive: true });
await cp(binary, path.join(output, 'tarobot-host-launcher.exe'));
console.log(`Windows host launcher copied to ${output}`);
