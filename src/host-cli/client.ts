import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { lstat, readFile, rename } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { botRoleSchema } from "../client-protocol/dispatch.js";
import { CHUNK_BYTES, idSchema, MAX_FRAME_BYTES, pairingSchema } from "../client-protocol/index.js";
import { nodeFrameReader } from "../client-protocol/fragments-node.js";
import { BOT_LOCAL_REQUEST_TIMEOUT_MS } from "../client-protocol/bot-messages.js";
import { boundDeviceActionStatement, deviceActionProofText, type DeviceAction, type DeviceActionProof } from "../client-protocol/device-actions.js";
import { deviceProof, hashSecret, parsePublicKey, serverProof } from "../hub/auth.js";
import { HubDatabase } from "../hub/database.js";
import { isLoopback } from "../hub/network.js";
import { inspectHubService } from "../hub/service.js";
import type { Bot } from "../hub/store.js";
import { JsonStore } from "../state/json-store.js";
import { withFileMutex } from "../state/file-mutex.js";

const MAX_REPLY_BYTES = 8 * 1024 * 1024;
// History pages normally stay below 6 MiB, but one complete logical message
// may occupy its own page. Keep this exception limited to authenticated GET.
const MAX_MESSAGE_PAGE_REPLY_BYTES = 33 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const identitySchema = z.object({ deviceId: idSchema, publicKey: z.string(), privateKey: z.string(), hubPublicKey: z.string() });
type Identity = z.infer<typeof identitySchema>;
const readySchema = z.object({ type: z.literal("ready"), sessionToken: z.string().min(1), expiresAt: z.number(), serverCapabilities: z.array(z.string()), bots: z.array(z.object({ id: idSchema, name: z.string(), engine: z.string(), model: z.string(), effort: z.string(), online: z.number(), managed: z.number().optional(), deletedAt: z.number().optional(), defaultAvatar: z.string().max(64).optional(), role: botRoleSchema.optional().catch(undefined) })) });
type AuthenticatedReady = z.infer<typeof readySchema>;
export type HostReady = Omit<AuthenticatedReady, "sessionToken">;

export class HostCliError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); this.name = "HostCliError"; }
}

/** Only explicit enrollment can generate a new controller. A read cannot create a Hub. */
async function controllerIdentity(directory: string, hubPublicKey: string, enroll: boolean, enrollmentSupported: boolean): Promise<Identity> {
  const file = path.join(directory, "cli", "identity.json");
  const pendingFile = path.join(directory, "cli", "identity.pending.json");
  const read = async (target = file) => {
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new HostCliError("cli_identity_unsafe_file");
    if (info && process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid?.())) throw new HostCliError("cli_identity_permissions");
    return new JsonStore<Identity | null>(target, value => identitySchema.parse(value)).read(null);
  };
  let identity = await read();
  if (!identity && !enroll) throw new HostCliError("cli_controller_missing_run_host_enroll");
  if (enroll) identity = await withFileMutex(path.join(directory, "cli-controller"), async () => {
    let value = await read(), pending = false;
    if (!value) { value = await read(pendingFile); pending = !!value; }
    if (value) validateIdentity(value, hubPublicKey);
    const registered = await enrollmentState(directory, value);
    if (registered) { if (pending) await rename(pendingFile, file); return value!; }
    if (!enrollmentSupported) throw new HostCliError("host_update_required_enroll_controller");
    if (!value) {
      const keys = generateKeyPairSync("ed25519");
      value = { deviceId: `cli_${randomUUID().replaceAll("-", "")}`, hubPublicKey,
        publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
      await new JsonStore<Identity>(pendingFile).write(value); pending = true;
    }
    validateIdentity(value, hubPublicKey);
    const controller = pairingSchema.parse({ deviceId: value.deviceId, publicKey: value.publicKey, name: "TaroBird CLI", platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "web" });
    // Enrollment runs in the existing process, never through a second writable
    // database connection that could migrate an older live Hub underneath it.
    const result = await inspectHubService(directory, "enroll-controller", { controller, expectedPublicKey: hubPublicKey });
    if (!result.running) throw new HostCliError("host_update_required_enroll_controller");
    if (result.publicKey !== hubPublicKey) throw new HostCliError("cli_host_identity_changed");
    if (result.controlError) throw new HostCliError(result.controlError);
    if (pending) await rename(pendingFile, file);
    return value;
  });
  validateIdentity(identity!, hubPublicKey);
  return identity!;
}

async function enrollmentState(directory: string, identity: Identity | null): Promise<boolean> {
  const db = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
  try {
    if (identity) {
      const row = await db.get<{ public_key: string; revoked: number; role: string }>("SELECT d.public_key,d.revoked,u.role FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=?", [identity.deviceId]);
      if (row && (row.public_key !== identity.publicKey || row.revoked || row.role !== "owner")) throw new HostCliError("desktop_controller_identity_invalid");
      const marker = await db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [`desktop-controller:v1:${hashSecret(identity.deviceId)}`]);
      if (row && marker) {
        const parsed = JSON.parse(marker.value);
        if (parsed?.id === identity.deviceId && parsed.publicKey === identity.publicKey) return true;
      }
      if (row) throw new HostCliError("desktop_controller_identity_invalid");
    }
    // A normal backup deliberately excludes local CLI keys. Do not accumulate
    // privileged orphan controllers or retire a desktop identity by guessing.
    const orphaned: { id: string }[] = [];
    const controllers = await db.all<{ id: string; public_key: string }>("SELECT id,public_key FROM devices WHERE id GLOB 'cli_*' AND revoked=0");
    for (const row of controllers) {
      const saved = await db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [`desktop-controller:v1:${hashSecret(row.id)}`]);
      if (!saved) continue;
      try { const marker = JSON.parse(saved.value); if (marker.id === row.id && marker.publicKey === row.public_key && row.id !== identity?.deviceId) orphaned.push({ id: row.id }); } catch { /* Invalid markers confer no local trust. */ }
    }
    if (orphaned.length) throw new HostCliError(`cli_controller_orphaned_revoke_explicitly:${orphaned.map(row => row.id).join(",")}`);
    return false;
  } finally { await db.close(); }
}

function validateIdentity(identity: Identity, hubPublicKey: string): KeyObject {
  if (identity.hubPublicKey !== hubPublicKey) throw new HostCliError("cli_host_identity_changed");
  const privateKey = createPrivateKey(identity.privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519" || createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64") !== identity.publicKey) throw new HostCliError("cli_identity_invalid");
  return privateKey;
}

/** Explicit recovery only. Revoked credentials stay revoked; active controllers
 * must be deliberately revoked first so a reset never abandons an owner key. */
export async function resetCliController(directory: string): Promise<{ retiredDeviceId: string }> {
  const status = await inspectHubService(directory);
  if (!status.running) throw new HostCliError("host_not_running");
  return withFileMutex(path.join(directory, "cli-controller"), async () => {
    let file = path.join(directory, "cli/identity.json");
    const info = await lstat(file).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      file = path.join(directory, "cli/identity.pending.json");
      return lstat(file).catch((pendingError: NodeJS.ErrnoException) => {
        if (pendingError.code === "ENOENT") throw new HostCliError("cli_controller_missing_run_host_enroll");
        throw pendingError;
      });
    });
    if (!info.isFile() || info.isSymbolicLink()) throw new HostCliError("cli_identity_unsafe_file");
    if (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid?.())) throw new HostCliError("cli_identity_permissions");
    const identity = identitySchema.parse(JSON.parse(await readFile(file, "utf8")));
    validateIdentity(identity, status.publicKey);
    const db = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
    try {
      const device = await db.get<{ public_key: string; revoked: number }>("SELECT public_key,revoked FROM devices WHERE id=?", [identity.deviceId]);
      if (device && device.public_key !== identity.publicKey) throw new HostCliError("cli_identity_invalid");
      if (device && !device.revoked) throw new HostCliError("cli_controller_active_revoke_before_reset");
    } finally { await db.close(); }
    await rename(file, path.join(directory, "cli", `identity.retired-${randomUUID()}.json`));
    return { retiredDeviceId: identity.deviceId };
  });
}

/** This bootstrap trusts only the running service in the selected local state
 * directory. It never takes an arbitrary remote URL or a host private key. */
export class LocalHostClient {
  private closed = false;
  readonly ready: HostReady;
  readonly #token: string;
  readonly #key: KeyObject;
  private constructor(readonly directory: string, readonly url: string, readonly publicKey: string,
    readonly deviceId: string, authenticated: AuthenticatedReady, key: KeyObject) {
    const { sessionToken, ...ready } = authenticated;
    this.ready = ready; this.#token = sessionToken; this.#key = key;
  }

  static async connect(directory: string, options: { enroll?: boolean } = {}): Promise<LocalHostClient> {
    const status = await inspectHubService(directory);
    if (!status.running) throw new HostCliError("host_not_running");
    // The dedicated instance listener also serves authenticated /api and /ws.
    // Use its local HTTP endpoint when the primary listener is public HTTPS.
    // Server identity is still proven before sending any device signature.
    const url = [status.url, status.instanceUrl].flatMap(value => {
      if (!value) return [];
      try { const parsed = new URL(value), host = parsed.hostname.replace(/^\[|\]$/g, "");
        return parsed.protocol === "http:" && isLoopback(host) && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash ? [parsed] : [];
      } catch { return []; }
    })[0];
    if (!url) throw new HostCliError("cli_control_requires_loopback_listener");
    // Read only the public part; never use the Hub's private key as a client key.
    const saved = z.object({ publicKey: z.string() }).parse(JSON.parse(await readFile(path.join(directory, "identity.json"), "utf8")));
    if (saved.publicKey !== status.publicKey) throw new HostCliError("cli_host_identity_changed");
    parsePublicKey(saved.publicKey);
    const identity = await controllerIdentity(directory, status.publicKey, options.enroll === true, status.controlCapabilities?.includes("enroll-controller") === true);
    const key = validateIdentity(identity, status.publicKey);
    const ready = await authenticate(url.origin, identity.deviceId, status.publicKey, key);
    return new LocalHostClient(directory, url.origin, status.publicKey, identity.deviceId, ready, key);
  }

  supports(capability: string): boolean { return this.ready.serverCapabilities.includes(capability); }
  get bots(): Bot[] { return this.ready.bots.filter(bot => !bot.deletedAt) as Bot[]; }
  close(): void { this.closed = true; }
  async request<T = unknown>(route: string, method = "GET", body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload) > (route === "/api/bot-messages/local" ? 12 * 1024 * 1024 : MAX_REPLY_BYTES)) throw new HostCliError("cli_request_too_large");
    return this.exchange<T>(route, method, payload === undefined ? undefined : Buffer.from(payload), "application/json");
  }
  /** One upload chunk to the same authenticated upload API the App uses. */
  async putChunk<T = unknown>(route: string, bytes: Buffer): Promise<T> {
    if (!/^\/api\/uploads\/[A-Za-z0-9_-]+\/\d+$/.test(route) || bytes.length > CHUNK_BYTES) throw new HostCliError("cli_request_too_large");
    return this.exchange<T>(route, "PUT", bytes, "application/octet-stream");
  }
  private async exchange<T>(route: string, method: string, payload: Buffer | undefined, contentType: string): Promise<T> {
    if (this.closed) throw new HostCliError("cli_client_closed");
    if (Date.now() >= this.ready.expiresAt) throw new HostCliError("session_expired");
    if (!/^\/api\/[A-Za-z0-9_/?=&.%+-]+$/.test(route) || route.includes("..")) throw new HostCliError("cli_invalid_api_path");
    const replyLimit = method === "GET" && /^\/api\/conversations\/[A-Za-z0-9_-]+\/messages(?:\?|$)/.test(route) ? MAX_MESSAGE_PAGE_REPLY_BYTES : MAX_REPLY_BYTES;
    return new Promise<T>((resolve, reject) => {
      const request = httpRequest(this.url + route, {
        method, headers: { Authorization: `Bearer ${this.#token}`, ...(payload ? { "Content-Type": contentType, "Content-Length": payload.length } : {}) },
      }, response => {
        let bytes = 0; const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > replyLimit) request.destroy(new HostCliError("cli_response_too_large")); else chunks.push(chunk); });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) throw new HostCliError(typeof value?.error === "string" ? value.error : "cli_http_error", response.statusCode);
            resolve(value as T);
          } catch (error) { reject(error); }
        });
      });
      const timer = setTimeout(() => request.destroy(new HostCliError("cli_request_timeout")), route === "/api/bot-messages/local" ? BOT_LOCAL_REQUEST_TIMEOUT_MS : TIMEOUT_MS);
      request.on("close", () => clearTimeout(timer)); request.on("error", reject); request.end(payload);
    });
  }

  async deviceAction(action: DeviceAction): Promise<DeviceActionProof> {
    const raw = await this.request("/api/devices/challenge", "POST", action);
    const statement = boundDeviceActionStatement(raw, { hubPublicKey: this.publicKey, deviceId: this.deviceId, sessionHash: hashSecret(this.#token), action });
    if (statement.expiresAt <= Date.now() || statement.expiresAt > Math.min(this.ready.expiresAt, Date.now() + 31_000)
      || (action.operation === "network" || action.operation === "bot-message-grant" || action.operation === "screen-grant") && statement.targetDigest !== action.target) throw new HostCliError("device_action_invalid");
    return { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), this.#key).toString("base64") };
  }
}

function authenticate(url: string, deviceId: string, publicKey: string, key: KeyObject): Promise<AuthenticatedReady> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace(/^http/, "ws") + "/ws", { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: TIMEOUT_MS });
    const reader = nodeFrameReader(), nonce = randomBytes(32).toString("base64url");
    let verified = false, settled = false, received = 0;
    const finish = (error?: Error, ready?: AuthenticatedReady) => {
      if (settled) return; settled = true; clearTimeout(timer); reader.clear(); socket.terminate();
      if (error) reject(error); else resolve(ready!);
    };
    const timer = setTimeout(() => finish(new HostCliError("cli_auth_timeout")), TIMEOUT_MS);
    socket.on("error", error => finish(error));
    socket.on("close", () => { if (!settled) finish(new HostCliError("cli_auth_disconnected")); });
    socket.on("open", () => socket.send(JSON.stringify({ v: 1, type: "hello", deviceId, nonce, protocolVersions: [1], capabilities: ["fragments.v1", "management.v1"], cursors: {} })));
    socket.on("message", (raw, binary) => {
      if (settled) return;
      try {
        received += Buffer.byteLength(raw.toString());
        if (binary || received > MAX_REPLY_BYTES) throw new HostCliError("cli_auth_response_too_large");
        const frame = reader.read(raw.toString()) as Record<string, unknown> | undefined;
        if (!frame) return;
        if (frame.type === "error") throw new HostCliError(typeof frame.code === "string" ? frame.code : "cli_auth_failed");
        if (frame.type === "challenge") {
          const challenge = z.object({ nonce: z.string().min(32).max(128), signature: z.string().max(256), publicKey: z.string() }).parse(frame);
          if (verified || challenge.publicKey !== publicKey || !verify(null, serverProof(deviceId, challenge.nonce, nonce), parsePublicKey(publicKey), Buffer.from(challenge.signature, "base64"))) throw new HostCliError("cli_host_signature_invalid");
          verified = true;
          socket.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof(deviceId, challenge.nonce, nonce), key).toString("base64") }));
        } else if (frame.type === "ready") {
          if (!verified) throw new HostCliError("cli_host_signature_required");
          finish(undefined, readySchema.parse(frame));
        }
      } catch (error) { finish(error instanceof Error ? error : new HostCliError("cli_auth_invalid")); }
    });
  });
}
