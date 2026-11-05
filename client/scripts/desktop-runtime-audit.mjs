// Exercise the production build gate without rebuilding Tauri or replacing host/.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../src-tauri/build/desktop_runtime.rs', import.meta.url));
const [root, target, ...extra] = process.argv.slice(2);
if (extra.length || (!!root !== !!target)) throw new Error('Usage: desktop-runtime-audit.mjs [host-directory target-triple]');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'tb-runtime-audit-'));
try {
  const manifest = path.join(scratch, 'Cargo.toml');
  await writeFile(manifest, `[package]\nname = "tarobot-runtime-audit"\nversion = "0.0.0"\nedition = "2021"\n[lib]\npath = ${JSON.stringify(source)}\n[[bin]]\nname = "check-runtime"\npath = "main.rs"\n[dependencies]\nserde_json = "1"\n`);
  await writeFile(path.join(scratch, 'main.rs'), 'fn main() { let args: Vec<_> = std::env::args().collect(); tarobot_runtime_audit::validate(std::path::Path::new(&args[1]), &args[2]).unwrap(); println!("Bundled runtime matches {}", args[2]); }\n');
  const options = {
    env: { ...process.env, CARGO_TARGET_DIR: path.join(scratch, 'target') }, timeout: 60_000, maxBuffer: 1024 * 1024,
  };
  const result = await exec('cargo', ['test', '--offline', '--manifest-path', manifest], options);
  process.stdout.write(result.stdout + result.stderr);
  if (root && target) {
    const checked = await exec('cargo', ['run', '--offline', '--quiet', '--manifest-path', manifest, '--bin', 'check-runtime', '--', path.resolve(root), target], options);
    process.stdout.write(checked.stdout + checked.stderr);
  }
} catch (error) {
  process.stderr.write((error.stdout ?? '') + (error.stderr ?? ''));
  throw error;
} finally { await rm(scratch, { recursive: true, force: true }); }
