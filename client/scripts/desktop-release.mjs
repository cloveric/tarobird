import path from "node:path";
import { pathToFileURL } from "node:url";

export function releaseConfig(endpoint, pubkey) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("Update feed must be an HTTPS URL without credentials, query or fragment");
  const decoded = Buffer.from(pubkey, "base64").toString("utf8").trim().split(/\r?\n/);
  const bytes = Buffer.from(decoded[1] ?? "", "base64");
  if (!decoded[0]?.startsWith("untrusted comment:") || decoded.length !== 2 || bytes.length !== 42 || bytes.subarray(0, 2).toString() !== "Ed") throw new Error("Expected the base64 public key produced by tauri signer generate");
  return { bundle: { createUpdaterArtifacts: true }, plugins: { updater: { endpoints: [url.href], pubkey, requireSignedVersion: true, allowDowngrades: false } } };
}

async function main() {
  const { electronBuildCLI } = await import('./electron-build.mjs');
  await electronBuildCLI(process.argv.slice(2), { production: true });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
