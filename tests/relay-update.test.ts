import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { relayUpdateConfigSchema, updateRelay, verifyRelayUpdate, type RelayUpdateHooks } from "../src/relay/update.js";
import { inspectRelayCompanions } from "../src/relay/health.js";
import { signRelayRelease } from "../src/relay/release-cli.js";

const pair = generateKeyPairSync("ed25519");
const config = relayUpdateConfigSchema.parse({ url: "https://updates.example.test/relay.json", publicKey: pair.publicKey.export({ type: "spki", format: "pem" }), minRelease: 10 });
const bundle = Buffer.from("export const version = '1.0.1';\n");
const hash = createHash("sha256").update(bundle).digest("hex");
const manifest = (release = 10) => ({ v: 1, release, version: "1.0.1", createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(), artifact: { url: "https://updates.example.test/relay.mjs", sha256: hash, size: bundle.length } });
function envelope(value: unknown, key = pair.privateKey) { const payload = Buffer.from(JSON.stringify(value)); return { payload: payload.toString("base64url"), signature: sign(null, payload, key).toString("base64url") }; }
let root: string; let previous: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "relay-update-")); previous = path.join(root, "releases", "original"); await mkdir(previous, { recursive: true });
  for (const file of ["node", "relay.mjs", "ca.pem", "server.pem", "server.key"]) await writeFile(path.join(previous, file), `fixture ${file}`);
  await writeFile(path.join(previous, "relay.json"), JSON.stringify({ healthPort: 9877 })); await symlink(previous, path.join(root, "current"));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function hooks(value: unknown = manifest(), artifact = bundle): RelayUpdateHooks & { restart: ReturnType<typeof vi.fn>; checkBundle: ReturnType<typeof vi.fn> } {
  return { fetcher: vi.fn(async (url, init) => { expect(init?.redirect).toBe("error"); return new Response(url === config.url ? JSON.stringify(envelope(value)) : artifact); }) as unknown as typeof fetch,
    checkBundle: vi.fn(async () => undefined), restart: vi.fn(async () => undefined), healthy: async () => true };
}

it("installs a signed release with private credential modes and idempotent subsequent checks", async () => {
  const h = hooks(); expect(await updateRelay(root, config, h)).toEqual({ updated: true, release: 10, version: "1.0.1" });
  const current = await readlink(path.join(root, "current")); expect(current).not.toBe(previous); expect(await readFile(path.join(current, "relay.mjs"))).toEqual(bundle);
  expect(await readFile(path.join(current, "server.key"), "utf8")).toBe("fixture server.key"); expect((await stat(current)).mode & 0o777).toBe(0o750); expect((await stat(path.join(current, "server.key"))).mode & 0o777).toBe(0o640); expect((await stat(path.join(current, "relay.mjs"))).mode & 0o777).toBe(0o640);
  expect(h.checkBundle).toHaveBeenCalledTimes(1); expect(h.restart).toHaveBeenCalledTimes(1);
  expect(await updateRelay(root, config, h)).toMatchObject({ updated: false, release: 10 }); expect(h.restart).toHaveBeenCalledTimes(1);
  const conflicted = { ...manifest(), artifact: { ...manifest().artifact, sha256: "b".repeat(64) } };
  await expect(updateRelay(root, config, hooks(conflicted))).rejects.toThrow("release_conflict"); expect(await readlink(path.join(root, "current"))).toBe(current);
});
it("rejects bad signatures, expired/future metadata, disallowed origins and release floors", async () => {
  const other = generateKeyPairSync("ed25519"); expect(() => verifyRelayUpdate(envelope(manifest(), other.privateKey), config)).toThrow("signature_invalid");
  expect(() => verifyRelayUpdate(envelope({ ...manifest(), expiresAt: new Date(Date.now() - 1).toISOString() }), config)).toThrow("expired");
  expect(() => verifyRelayUpdate(envelope({ ...manifest(), createdAt: new Date(Date.now() + 3600_000).toISOString() }), config)).toThrow("invalid_time");
  expect(() => verifyRelayUpdate(envelope({ ...manifest(), artifact: { ...manifest().artifact, url: "https://untrusted.test/relay.mjs" } }), config)).toThrow("origin_not_allowed");
  expect(() => verifyRelayUpdate(envelope(manifest(9)), config)).toThrow("release_floor");
  expect(() => relayUpdateConfigSchema.parse({ ...config, publicKey: other.privateKey.export({ type: "pkcs8", format: "pem" }) })).toThrow();
  // A malformed key or a different key type cannot be configured.
  expect(() => relayUpdateConfigSchema.parse({ ...config, publicKey: "invalid" })).toThrow();
});
it("rejects body/hash mismatches before restart and fails closed on corrupted state", async () => {
  const h = hooks(manifest(), Buffer.from("bad")); await expect(updateRelay(root, config, h)).rejects.toThrow("hash_mismatch"); expect(h.restart).not.toHaveBeenCalled();
  const oversized = hooks(manifest(), Buffer.alloc(bundle.length + 1)); await expect(updateRelay(root, config, oversized)).rejects.toThrow("download_too_large");
  await writeFile(path.join(root, "update-state.json"), "not JSON"); await expect(updateRelay(root, config, hooks())).rejects.toThrow(); expect(await readlink(path.join(root, "current"))).toBe(previous);
});
it("rolls back failed health/startup without advancing the release counter", async () => {
  const h = hooks(); h.healthy = async () => false;
  await expect(updateRelay(root, config, h)).rejects.toThrow("health_failed"); expect(h.restart).toHaveBeenCalledTimes(2); expect(await readlink(path.join(root, "current"))).toBe(previous);
  await expect(readFile(path.join(root, "update-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const startup = hooks(); startup.restart.mockRejectedValueOnce(new Error("start_failed")); await expect(updateRelay(root, config, startup)).rejects.toThrow("start_failed"); expect(await readlink(path.join(root, "current"))).toBe(previous);
  const syntax = hooks(); syntax.checkBundle.mockRejectedValue(new Error("syntax_failed")); await expect(updateRelay(root, config, syntax)).rejects.toThrow("syntax_failed"); expect(syntax.restart).not.toHaveBeenCalled();
});
it("rejects arbitrary current paths and rolls back if the durable update receipt cannot be stored", async () => {
  const h = hooks(); await mkdir(path.join(root, "update-state.json.tmp")); await expect(updateRelay(root, config, h)).rejects.toThrow(); expect(await readlink(path.join(root, "current"))).toBe(previous); expect(h.restart).toHaveBeenCalledTimes(2);
  await rm(path.join(root, "current")); await symlink(root, path.join(root, "current")); await expect(updateRelay(root, config, hooks())).rejects.toThrow("current_path_invalid");
});
it("keeps only the two recent automatic releases and refuses feed downgrades", async () => {
  for (const release of [10, 11, 12]) await updateRelay(root, config, hooks(manifest(release)));
  const names = await readdir(path.join(root, "releases")); expect(names).toContain("original"); expect(names.filter((name) => name.startsWith("update-"))).toHaveLength(2); expect(names.some((name) => name.startsWith("update-10-"))).toBe(false);
  const h = hooks(manifest(11)); expect(await updateRelay(root, config, h)).toMatchObject({ updated: false, release: 12 }); expect(h.restart).not.toHaveBeenCalled();
});
it("prepares a verifiable release locally without exporting the private key or overwriting a feed", async () => {
  const keyFile = path.join(root, "signing.key"), source = path.join(root, "bundle.mjs"), out = path.join(root, "release.json");
  await writeFile(keyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }); await writeFile(source, bundle);
  const args = { keyFile, bundle: source, out, url: "https://updates.example.test/relay.mjs", version: "1.0.1", release: 10 };
  const receipt = await signRelayRelease(args); expect(receipt.publicKey).toBe(config.publicKey); expect(receipt.sha256).toBe(hash);
  const feed = await readFile(out, "utf8"); expect(feed).not.toContain("PRIVATE KEY"); expect(verifyRelayUpdate(JSON.parse(feed), config)).toMatchObject({ release: 10, version: "1.0.1" });
  await expect(signRelayRelease(args)).rejects.toMatchObject({ code: "EEXIST" });
  await chmod(keyFile, 0o644); await expect(signRelayRelease({ ...args, out: path.join(root, "unsafe.json") })).rejects.toThrow("private file");
});

it("preserves companion files through relay-only updates and redacts companion status", async () => {
  for (const name of ["ntfy", "ntfy.json", "ntfy-cert.pem", "ntfy-key.pem", "tailscale", "tailscaled", "peer-relay.json"]) await writeFile(path.join(previous, name), "fixture " + name);
  await writeFile(path.join(previous, "companion-health.json"), JSON.stringify({ ntfyPort: 2586, peerRelay: true }));
  await updateRelay(root, config, hooks()); const current = await readlink(path.join(root, "current"));
  expect(await readFile(path.join(current, "ntfy-key.pem"), "utf8")).toBe("fixture ntfy-key.pem");
  expect((await stat(path.join(current, "tailscaled"))).mode & 0o777).toBe(0o750);
  const status = await inspectRelayCompanions(root, { fetcher: async () => new Response(JSON.stringify({ healthy: true })), command: async (_file, args) => args.includes("status") ? JSON.stringify({ BackendState: "Running", sensitiveIdentity: "must-not-be-returned" }) : args.includes("prefs") ? JSON.stringify({ RelayServerPort: 443, privateKey: "must-not-be-returned" }) : "" });
  expect(status).toEqual({ ntfy: { healthy: true, running: true }, peerRelay: { running: true, backend: "Running", port: 443, policy: "verify in tailnet" } });
  expect(JSON.stringify(status)).not.toContain("must-not-be-returned");
  expect(await inspectRelayCompanions(root, { fetcher: async () => { throw new Error("offline"); }, command: async () => { throw new Error("offline"); } })).toEqual({ ntfy: { healthy: false, running: false }, peerRelay: { running: false, backend: "Unknown", port: null, policy: "verify in tailnet" } });
});
