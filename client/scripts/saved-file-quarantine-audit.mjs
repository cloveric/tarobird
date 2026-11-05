// Compile the exact macOS quarantine helper without building or launching the
// client. Tests only write harmless temporary files and inspect their metadata.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("macos_quarantine_audit_required");
const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const source = path.join(repo, "client/src-tauri/src/saved_file_quarantine.rs");
const manifest = await readFile(path.join(repo, "client/src-tauri/Cargo.toml"), "utf8");
const dependency = manifest.match(/^objc2-foundation = .+$/m)?.[0];
if (!dependency) throw new Error("quarantine_foundation_dependency_missing");
const scratch = await mkdtemp(path.join(os.tmpdir(), "tarobot-quarantine-audit-"));
try {
  const manifestPath = path.join(scratch, "Cargo.toml");
  await writeFile(manifestPath, `[package]\nname = "tarobot-quarantine-audit"\nversion = "0.0.0"\nedition = "2021"\n[lib]\npath = ${JSON.stringify(source)}\n[dependencies]\n${dependency}\n`);
  const result = await exec("cargo", ["test", "--offline", "--manifest-path", manifestPath], {
    cwd: repo, env: { ...process.env, CARGO_TARGET_DIR: path.join(scratch, "target") },
    timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  process.stdout.write(result.stdout + result.stderr);
} catch (error) {
  process.stderr.write((error.stdout ?? "") + (error.stderr ?? ""));
  throw error;
} finally { await rm(scratch, { recursive: true, force: true }); }
