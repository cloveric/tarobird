import { macosBuildEnvironment } from '../../scripts/macos-artifact-paths.mjs';
// Run the actual desktop WebView, Channel and Rust stack against disposable
// TLS peers. Installs no certificates, touches no fleet or installed app.
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { runAuditChild } from "./native-audit-runner.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const client = fileURLToPath(new URL("../", import.meta.url)), repo = path.dirname(client.slice(0, -1));
const output = path.resolve(process.argv[2] ?? await mkdtemp(path.join(os.tmpdir(), "tarocub-native-receipt-")));
await mkdir(output, { recursive: true });
console.error(`audit logs: ${output}`);
const scratch = await mkdtemp(path.join(os.tmpdir(), "tarocub-webview-run-"));
const env = { ...macosBuildEnvironment(repo), TMPDIR: scratch, TAROCUB_AUDIT_RESULT: path.join(output, "native-runtime-result.json") };
const run = (command, args, name, timeout) => runAuditChild(command, args, {
  cwd: repo, env, logPath: path.join(output, name), timeout,
});

try {
  await mkdir(path.join(client, ".native-audit-dist"), { recursive: true });
  await build({ entryPoints: [path.join(client, "e2e/fixtures/native-runtime.ts")], bundle: true, format: "esm", outfile: path.join(client, ".native-audit-dist/audit.js"), platform: "browser", target: "es2022" });
  await writeFile(path.join(client, ".native-audit-dist/index.html"), '<!doctype html><html><head><meta charset="utf-8"><title>Isolated transport acceptance</title><script type="module" src="/audit.js"></script></head><body>Isolated transport acceptance</body></html>');
  await run("cargo", ["build", "--manifest-path", path.join(client, "src-tauri/Cargo.toml"), "--features", "native-transport-audit", "--bin", "transport-audit"], "native-runtime-build.log", 300_000);
  const target = env.CARGO_TARGET_DIR ?? path.join(client, "src-tauri/target");
  await run(path.join(target, "debug/transport-audit"), [], "native-runtime.log", process.env.TAROCUB_AUDIT_ALLOW_SUSPEND ? 60_000 : 210_000);
  const result = JSON.parse(await readFile(env.TAROCUB_AUDIT_RESULT, "utf8"));
  if (!result.ok || result.proxy?.sensitive !== 0) throw new Error("native transport acceptance failed");
  console.log(JSON.stringify(result, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
