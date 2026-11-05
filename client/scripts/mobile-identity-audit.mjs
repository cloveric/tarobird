// Exercises real native signing/migration cores with synthetic in-memory stores.
// Never reads the operator's Keychain/Keystore or changes OS trust. Not an APK
// or physical-device receipt. Required JVM jars use the existing pinned cache.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const output = path.resolve(process.argv[2] ?? await mkdtemp(path.join(os.tmpdir(), "tarobot-identity-receipt-")));
const scratch = await mkdtemp(path.join(os.tmpdir(), "tarobot-identity-audit-"));
const cache = process.env.TAROCUB_JVM_CACHE ?? path.join(os.homedir(), ".cache/tarocub-mobile-tls");
const java = name => process.env.TAROCUB_JAVA_HOME ? path.join(process.env.TAROCUB_JAVA_HOME, "bin", name) : name;
await mkdir(output, { recursive: true });
async function run(command, args, name) {
  try {
    const result = await exec(command, args, { cwd: repo, env: { ...process.env, TMPDIR: scratch }, timeout: 90_000, maxBuffer: 1024 * 1024 });
    await writeFile(path.join(output, name + ".log"), result.stdout + result.stderr); return result.stdout;
  } catch (error) { await writeFile(path.join(output, name + ".log"), (error.stdout ?? "") + (error.stderr ?? "") + String(error)); throw error; }
}
try {
  // Use the exact production generator, not a hand-written native-only nonce.
  // This caught a format mismatch that made every approved phone stay offline.
  const generator = path.join(scratch, "client-identity.mjs");
  await build({ entryPoints: [path.join(repo, "client/src/identity.ts")], bundle: true, platform: "node", format: "esm", outfile: generator });
  const { randomNonce } = await import(generator);
  const challenges = path.join(scratch, "client-challenges.json");
  await writeFile(challenges, JSON.stringify(Array.from({ length: 16 }, () => randomNonce())));
  let android = null;
  const vector = "tests/fixtures/device-action-vector.json";
  if (process.env.TAROCUB_IDENTITY_PLATFORM !== "ios") {
    const pinned = JSON.parse(await readFile(path.join(repo, "client/android/audit/dependencies.json"), "utf8"));
    const jars = [];
    for (const item of pinned.filter(item => item.artifact.startsWith("org.bouncycastle:bcprov-") || item.artifact.startsWith("org.json:json:"))) {
      const file = path.join(cache, path.basename(new URL(item.source).pathname));
      if (createHash("sha256").update(await readFile(file)).digest("hex") !== item.sha256) throw new Error("native_identity_dependency_hash_mismatch");
      jars.push(file);
    }
    const classes = path.join(scratch, "classes"); await mkdir(classes);
    await run(java("javac"), ["--release", "11", "-cp", jars.join(path.delimiter), "-d", classes,
      "client/android/app/src/main/java/com/tarobot/client/DeviceIdentity.java", "client/android/app/src/test/java/com/tarobot/client/DeviceIdentityChecks.java"], "android-compile");
    android = JSON.parse(await run(java("java"), ["-cp", [classes, ...jars].join(path.delimiter), "com.tarobot.client.DeviceIdentityChecks", vector, challenges], "android-checks"));
  }
  const core = ["client/ios/App/App/DeviceIdentity.swift", "client/ios/App/App/DeviceKeyStore.swift"];
  const binary = path.join(scratch, "DeviceIdentityChecks");
  await run("swiftc", ["-swift-version", "5", ...core, "client/ios/tests/DeviceIdentityChecks.swift", "-o", binary], "ios-compile");
  const ios = JSON.parse(await run(binary, [vector, challenges], "ios-checks"));
  for (const proof of ios.proofs) {
    const key = createPublicKey({ key: Buffer.from(proof.publicKey, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(proof.message), key, Buffer.from(proof.signature, "base64"))) throw new Error("ios_node_signature_rejected");
    if (verify(null, Buffer.from(proof.message + "changed"), key, Buffer.from(proof.signature, "base64"))) throw new Error("ios_mutated_signature_accepted");
  }
  const headers = path.join(repo, "client/node_modules/@capacitor/ios/Capacitor/Capacitor");
  const module = path.join(scratch, "Capacitor"); await mkdir(module);
  await writeFile(path.join(module, "BridgeHeaders.h"), `#import <Foundation/Foundation.h>\n@class UIViewController;\n#import "${headers}/CAPBridgedPlugin.h"\n`);
  await writeFile(path.join(module, "module.modulemap"), 'module Capacitor { header "BridgeHeaders.h" export * }\n');
  await run("swiftc", ["-swift-version", "5", "-typecheck", "-I", scratch, "client/ios/tests/CapacitorCompileOverlay.swift", ...core, "client/ios/App/App/DeviceIdentityPlugin.swift"], "ios-plugin-typecheck");
  const receipt = { android, ios: { platform: ios.platform, checks: ios.checks, status: ios.status }, nodeCrossVerification: ios.proofs.length, iosPluginTypecheck: "passed", scope: "native cores with synthetic stores; not phone or OS-vault acceptance" };
  await writeFile(path.join(output, "result.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify(receipt));
} finally { await rm(scratch, { recursive: true, force: true }); }
