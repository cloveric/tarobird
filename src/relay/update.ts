import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, chown, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";

const httpsUrl = z.string().url().refine((value) => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; }, "HTTPS URL without credentials required");
export const relayUpdateConfigSchema = z.object({
  url: httpsUrl, publicKey: z.string().max(4096).regex(/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/), minRelease: z.number().int().positive(),
  artifactOrigins: z.array(httpsUrl.refine((value) => new URL(value).origin === value)).max(8).default([]),
}).strict().superRefine((value, ctx) => { try { if (createPublicKey(value.publicKey).asymmetricKeyType !== "ed25519") throw new Error(); } catch { ctx.addIssue({ code: "custom", message: "An Ed25519 release verification public key is required" }); } });
export const relayUpdateManifestSchema = z.object({
  v: z.literal(1), release: z.number().int().positive(), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  artifact: z.object({ url: httpsUrl, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(10 * 1024 * 1024) }).strict(),
}).strict();
const envelopeSchema = z.object({ payload: z.string().regex(/^[A-Za-z0-9_-]+$/).max(32_768), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type RelayUpdateConfig = z.infer<typeof relayUpdateConfigSchema>;
export function verifyRelayUpdate(input: unknown, config: RelayUpdateConfig, now = Date.now()): z.infer<typeof relayUpdateManifestSchema> {
  const envelope = envelopeSchema.parse(input); const payload = Buffer.from(envelope.payload, "base64url");
  if (!verify(null, payload, createPublicKey(config.publicKey), Buffer.from(envelope.signature, "base64url"))) throw new Error("relay_update_signature_invalid");
  const manifest = relayUpdateManifestSchema.parse(JSON.parse(payload.toString("utf8")));
  const created = Date.parse(manifest.createdAt), expires = Date.parse(manifest.expiresAt);
  if (created > now + 300_000 || expires <= now || expires <= created || expires - created > 31 * 86400_000) throw new Error("relay_update_expired_or_invalid_time");
  if (manifest.release < config.minRelease) throw new Error("relay_update_below_release_floor");
  if (![new URL(config.url).origin, ...config.artifactOrigins].includes(new URL(manifest.artifact.url).origin)) throw new Error("relay_update_origin_not_allowed");
  return manifest;
}
async function boundedDownload(url: string, maxBytes: number, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error("relay_update_download_failed");
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) throw new Error("relay_update_download_too_large"); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks, size);
}
const stateSchema = z.object({ release: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), version: z.string() }).strict();
const exec = promisify(execFile);
export type RelayUpdateHooks = { fetcher?: typeof fetch; checkBundle?: (node: string, bundle: string) => Promise<void>; restart?: () => Promise<void>; healthy?: () => Promise<boolean> };
/** Caller holds the same OS flock as the SSH deployer. Hooks only replace platform
 * side effects in tests; installed CLI always uses the fixed /opt root. */
export async function updateRelay(root: string, configInput: unknown, hooks: RelayUpdateHooks = {}): Promise<{ updated: boolean; release: number; version: string }> {
  const config = relayUpdateConfigSchema.parse(configInput); const fetcher = hooks.fetcher ?? fetch;
  const manifest = verifyRelayUpdate(JSON.parse((await boundedDownload(config.url, 64 * 1024, fetcher)).toString("utf8")), config);
  const statePath = path.join(root, "update-state.json"); let oldState: z.infer<typeof stateSchema> | undefined;
  try { oldState = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (oldState && manifest.release <= oldState.release) {
    if (manifest.release === oldState.release && manifest.artifact.sha256 !== oldState.sha256) throw new Error("relay_update_release_conflict");
    return { updated: false, release: oldState.release, version: oldState.version };
  }
  const releases = await realpath(path.join(root, "releases")); const previous = await realpath(path.join(root, "current"));
  if (path.dirname(previous) !== releases) throw new Error("relay_update_current_path_invalid");
  const metadata = await lstat(previous); const originalLink = await readlink(path.join(root, "current"));
  const bundle = await boundedDownload(manifest.artifact.url, manifest.artifact.size, fetcher);
  if (bundle.length !== manifest.artifact.size || createHash("sha256").update(bundle).digest("hex") !== manifest.artifact.sha256) throw new Error("relay_update_hash_mismatch");
  const destination = path.join(releases, `update-${manifest.release}-${manifest.artifact.sha256.slice(0, 24)}`);
  // A prior failed attempt may have left an inspectable release. Stage a fresh
  // sibling so the currently active program is never overwritten in place.
  const staging = `${destination}-${process.pid}-${Date.now()}`;
  await mkdir(staging, { mode: 0o750 });
  let switched = false; let committed = false;
  const restart = hooks.restart ?? (async () => { await exec("systemctl", ["restart", "tarocub-relay.service"], { timeout: 30_000 }); });
  const swap = async (target: string) => { const link = path.join(root, "update-next"); await rm(link, { force: true }); await symlink(target, link); await rename(link, path.join(root, "current")); };
  try {
    await chmod(staging, 0o750); await chown(staging, metadata.uid, metadata.gid);
    for (const name of ["node", "relay.json", "ca.pem", "server.pem", "server.key", "ntfy", "ntfy.json", "ntfy-cert.pem", "ntfy-key.pem", "tailscale", "tailscaled", "peer-relay.json", "companion-health.json"]) {
      const source = path.join(previous, name); const stat = await lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" && !["node", "relay.json", "ca.pem", "server.pem", "server.key"].includes(name)) return undefined; throw error; });
      if (!stat) continue;
      if (!stat.isFile()) throw new Error("relay_update_source_not_regular");
      await copyFile(source, path.join(staging, name)); await chmod(path.join(staging, name), ["node", "ntfy", "tailscale", "tailscaled"].includes(name) ? 0o750 : 0o640); await chown(path.join(staging, name), metadata.uid, metadata.gid);
    }
    await writeFile(path.join(staging, "relay.mjs"), bundle, { mode: 0o640, flush: true }); await chmod(path.join(staging, "relay.mjs"), 0o640); await chown(path.join(staging, "relay.mjs"), metadata.uid, metadata.gid);
    await (hooks.checkBundle ?? (async (node, bundle) => { await exec(node, ["--check", bundle], { timeout: 20_000 }); }))(path.join(staging, "node"), path.join(staging, "relay.mjs"));
    const relayConfig = z.object({ healthPort: z.number().int().min(1).max(65535) }).parse(JSON.parse(await readFile(path.join(staging, "relay.json"), "utf8")));
    const healthy = hooks.healthy ?? (async () => {
      try { await exec("systemctl", ["is-active", "--quiet", "tarocub-relay.service"], { timeout: 5000 });
        const response = await fetch(`http://127.0.0.1:${relayConfig.healthPort}/health`, { redirect: "error", signal: AbortSignal.timeout(2000) });
        return response.ok && z.object({ service: z.literal("tarocub-relay"), connected: z.boolean() }).safeParse(await response.json()).success;
      } catch { return false; }
    });
    await writeFile(path.join(staging, ".complete"), "", { mode: 0o600, flush: true });
    for (const name of await readdir(staging)) { const handle = await open(path.join(staging, name), "r"); try { await handle.sync(); } finally { await handle.close(); } }
    await swap(staging); switched = true; await restart();
    let ok = false; for (let attempt = 0; attempt < 10; attempt++) { if (await healthy()) { ok = true; break; } if (!hooks.healthy) await new Promise((resolve) => setTimeout(resolve, 1000)); }
    if (!ok) throw new Error("relay_update_health_failed");
    const state = { release: manifest.release, sha256: manifest.artifact.sha256, version: manifest.version };
    await writeFile(`${statePath}.tmp`, JSON.stringify(state) + "\n", { mode: 0o600, flush: true }); await rename(`${statePath}.tmp`, statePath); committed = true;
    // Keep the active and immediately previous signed updates. Explicit SSH
    // deployment revisions are outside this namespace and are never collected.
    for (const entry of await readdir(releases, { withFileTypes: true }).catch(() => [])) {
      const candidate = path.join(releases, entry.name);
      if (entry.isDirectory() && /^update-\d+-[a-f0-9]{24}-\d+-\d+$/.test(entry.name) && candidate !== staging && candidate !== previous) await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
    }
    return { updated: true, release: manifest.release, version: manifest.version };
  } catch (error) {
    if (switched) { try { await swap(originalLink); await restart(); } catch (rollbackError) { throw new AggregateError([error, rollbackError], "relay_update_rollback_failed"); } }
    throw error;
  } finally {
    // If even the rollback link failed, keep the live release intact for repair.
    const active = await realpath(path.join(root, "current")).catch(() => staging);
    if (!committed && active !== staging) await rm(staging, { recursive: true, force: true });
  }
}

export async function runRelayUpdate(configFile: string, lockHeld = false): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Relay automatic updates require the installed Linux root systemd service");
  if (!lockHeld) {
    // Both the timer and a manual root invocation take the deployment lock.
    // The internal flag is only used by the child inheriting flock's lifetime.
    try {
      const result = await exec("flock", ["-n", "-E", "75", "/opt/tarocub-relay/deploy.lock", process.execPath, ...process.argv.slice(1), "--lock-held"], { timeout: 180_000, maxBuffer: 64 * 1024 });
      process.stdout.write(result.stdout);
    } catch (error) {
      if ((error as { code?: string | number }).code !== 75) throw error;
      console.log(JSON.stringify({ updated: false, reason: "another_relay_operation_is_running" }));
    }
    return;
  }
  const result = await updateRelay("/opt/tarocub-relay", JSON.parse(await readFile(configFile, "utf8"))); console.log(JSON.stringify(result));
}
