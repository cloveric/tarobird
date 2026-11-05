import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { relayUpdateManifestSchema } from "./update.js";

/** Offline release preparation. This writes a local signed feed; it never publishes. */
export async function signRelayRelease(input: { bundle: string; keyFile: string; out: string; url: string; release: number; version: string }): Promise<{ publicKey: string; sha256: string; size: number }> {
  const [metadata, bundleMetadata] = await Promise.all([stat(input.keyFile), stat(input.bundle)]);
  if (!bundleMetadata.isFile() || bundleMetadata.size < 1 || bundleMetadata.size > 10 * 1024 * 1024) throw new Error("Relay bundle missing or too large");
  const bundle = await readFile(input.bundle);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 4096) throw new Error("Release signing key must be a private file (0600)");
  const key = createPrivateKey(await readFile(input.keyFile)); if (key.asymmetricKeyType !== "ed25519") throw new Error("Release signing key must use Ed25519");
  const sha256 = createHash("sha256").update(bundle).digest("hex"), now = Date.now();
  const manifest = relayUpdateManifestSchema.parse({ v: 1, release: input.release, version: input.version, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 7 * 86400_000).toISOString(), artifact: { url: input.url, sha256, size: bundle.length } });
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(input.out, JSON.stringify({ payload: bytes.toString("base64url"), signature: sign(null, bytes, key).toString("base64url") }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { publicKey: createPublicKey(key).export({ type: "spki", format: "pem" }).toString(), sha256, size: bundle.length };
}
export async function runRelayReleaseCli(argv: string[]): Promise<void> {
  const args = parseArgs({ args: argv, options: { bundle: { type: "string" }, "key-file": { type: "string" }, out: { type: "string" }, url: { type: "string" }, release: { type: "string" }, version: { type: "string" }, help: { type: "boolean", short: "h" } } });
  const { bundle, out, url, version, release } = args.values, keyFile = args.values["key-file"];
  if (args.values.help || !bundle || !out || !url || !version || !release || !keyFile) { console.log("tarobot relay release --bundle <relay-runtime.mjs> --key-file <0600 Ed25519 private key> --out <new-feed.json> --url <HTTPS bundle URL> --release <increasing integer> --version <x.y.z>\nPrepares an expiring signed feed locally. Does not publish or deploy."); return; }
  console.log(JSON.stringify(await signRelayRelease({ bundle, keyFile, out, url, version, release: Number(release) }), null, 2));
}
