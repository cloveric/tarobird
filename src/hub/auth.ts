import { botPassportProof, botChallengeProof, botReplyProof, type BotPassport } from "../client-protocol/bot-messages.js";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, sign, verify, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { pairingSchema } from "../client-protocol/index.js";
import { authDeniedProof, authDeniedSchema, type AuthDenied } from "../client-protocol/auth-status.js";
import { tlsIdentityNonceSchema, tlsIdentityProof, type TlsIdentity, type TlsIdentityUnsigned } from "../client-protocol/tls-identity.js";
import { JsonStore } from "../state/json-store.js";
import { withFileMutex } from "../state/file-mutex.js";
import { isLoopback } from "./network.js";
import { sourceAddress } from "../relay/sources.js";
import { HubError, HubStore, type Device } from "./store.js";
import { deviceActionSchema, deviceActionStatementSchema, deviceActionProofText, type DeviceAction, type DeviceActionStatement, type DeviceActionProof } from "../client-protocol/device-actions.js";
import { networkManifestProof, networkProposalProof, networkPeerProof, type NetworkManifest, type NetworkProposal, type NetworkPeerRequest } from "../client-protocol/private-network.js";
import { desktopControllerChallengeSchema, desktopControllerProofSchema, desktopControllerProofText, localDesktopControllersInTransaction, type DesktopControllerChallenge } from "./local-controller.js";
import { pairRequestSchema, pairingInviteCreateSchema, pairingInviteRevokeSchema, type PairResponse, type PairingInviteIssued, type PairingInviteList, type PairingInviteStatus } from "../client-protocol/pairing-invites.js";
import { PairingInviteRegistry, pairingFingerprint, type InviteRecord } from "./pairing-invites.js";

const PAIRING_MS = 5 * 60_000;
const INVITE_ERA_KEY = "pairing-invites:v1";
const TOKEN_MS = 15 * 60_000;
const CHALLENGE_MS = 30_000;
const identitySchema = z.object({ publicKey: z.string(), privateKey: z.string() });
export const hashSecret = (value: string): string => createHash("sha256").update(value).digest("hex");
export const deviceProof = (deviceId: string, nonce: string, clientNonce: string): Buffer => Buffer.from(`tarocub/device/v1\0${deviceId}\0${nonce}\0${clientNonce}`);
export const serverProof = (deviceId: string, nonce: string, clientNonce: string): Buffer => Buffer.from(`tarocub/server/v1\0${deviceId}\0${nonce}\0${clientNonce}`);
export function parsePublicKey(value: string): KeyObject {
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong_key_type");
    return key;
  } catch { throw new HubError("invalid_device_key"); }
}
export type AuthSession = { deviceId: string; userId: string; expiresAt: number };
type Challenge = { deviceId: string; nonce: string; clientNonce: string; expiresAt: number; source: string };
type PairingRow = { device_id: string; name: string; platform: string; public_key: string; expires_at: number; status: string };
/** Rate-limit key for a caller; never an authorization input. Addresses are
 * canonicalized like relay sources (dotted or hex IPv4-mapped forms become
 * IPv4); one IPv6 /64, which a single host usually controls, is one source.
 * Relay namespaces (`relay:<id>:<address>`) are kept; other labels are as-is. */
export function rateSource(source: string): string {
  const relay = /^(relay:[A-Za-z0-9_-]{1,128}:)(.+)$/.exec(source);
  const prefix = relay?.[1] ?? "";
  let address: string;
  try { address = sourceAddress(relay?.[2] ?? source); } catch { return source; }
  if (isIP(address) === 4) return prefix + address;
  const [head = "", tail = ""] = address.split("::"), left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${prefix}${groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

export class HubAuth {
  readonly publicKey: string;
  private readonly privateKey: KeyObject;
  private challenges = new Map<string, Challenge>();
  private tokens = new Map<string, AuthSession>();
  private actions = new Map<string, { session: AuthSession; statement: DeviceActionStatement }>();
  private desktopControllers = new Map<string, DesktopControllerChallenge>();
  private limits = new Map<string, { count: number; until: number }>();
  private knownLimits = new Map<string, { count: number; until: number }>();
  private trustedLimits = new Map<string, { count: number; until: number }>();
  private revocationListeners = new Set<(deviceId: string) => void>();
  private readonly invites: PairingInviteRegistry;
  private constructor(readonly store: HubStore, identity: z.infer<typeof identitySchema>, private readonly now: () => number, monotonic: () => number) {
    this.publicKey = identity.publicKey;
    this.privateKey = createPrivateKey(identity.privateKey);
    if (this.privateKey.asymmetricKeyType !== "ed25519" || createPublicKey(this.privateKey).export({ type: "spki", format: "der" }).toString("base64") !== identity.publicKey) throw new Error("invalid_hub_identity");
    this.invites = new PairingInviteRegistry(now, monotonic);
  }
  static async open(store: HubStore, directory: string, now = Date.now, monotonic: () => number = () => performance.now()): Promise<HubAuth> {
    const file = path.join(directory, "identity.json");
    const identity = await withFileMutex(file, async () => {
      const state = new JsonStore<z.infer<typeof identitySchema> | null>(file, (value) => identitySchema.parse(value));
      let value = await state.read(null);
      if (!value) {
        const keys = generateKeyPairSync("ed25519");
        value = { publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
        await state.write(value);
      }
      return value;
    });
    return new HubAuth(store, identity, now, monotonic);
  }
  signBotPassport(p: BotPassport): string { return sign(null, Buffer.from(botPassportProof(p)), this.privateKey).toString("base64"); }
  signBotChallenge(nonce: string): string { return sign(null, Buffer.from(botChallengeProof(this.publicKey, nonce)), this.privateKey).toString("base64"); }
  signBotReply(nonce: string, result: unknown): string { return sign(null, Buffer.from(botReplyProof(nonce, result)), this.privateKey).toString("base64"); }
  private prune(): void {
    const now = this.now();
    for (const [id, c] of this.challenges) if (c.expiresAt < now) this.challenges.delete(id);
    for (const [id, t] of this.tokens) if (t.expiresAt < now) this.tokens.delete(id);
    for (const limits of [this.limits, this.knownLimits, this.trustedLimits]) for (const [id, l] of limits) if (l.until < now) limits.delete(id);
    for (const [id, a] of this.actions) if (a.statement.expiresAt <= now || a.session.expiresAt <= now) this.actions.delete(id);
    for (const [nonce, challenge] of this.desktopControllers) if (challenge.expiresAt <= now) this.desktopControllers.delete(nonce);
  }
  private rate(key: string, maximum: number, table: "anonymous" | "device" | "trusted" = "anonymous"): void {
    this.prune();
    // Source-aware tunnels can introduce many distinct public addresses. Never
    // allocate unbounded buckets or evict an existing caller to admit a new one.
    // Remote callers citing an enrolled device get their own table; owner
    // approvals and actual local callers use one remote input can never fill.
    // Relay metadata is namespaced and can never claim to be a local socket.
    const limits = table === "trusted" ? this.trustedLimits : table === "device" ? this.knownLimits : this.limits;
    if (!limits.has(key) && limits.size >= 4096) throw new HubError("rate_limited", 429);
    const old = limits.get(key) ?? { count: 0, until: this.now() + PAIRING_MS };
    old.count = Math.min(old.count + 1, maximum + 1); limits.set(key, old);
    if (old.count > maximum) throw new HubError("rate_limited", 429);
  }
  /** TRUSTED IN-PROCESS HELPER ONLY (tests and fixture bootstrap). It admits
   * a pending request without an invite, so production HTTP and every public
   * or relayed caller must use `pairInvited`; no configuration, environment
   * or source address may route public input here. */
  async pair(raw: unknown, source: string): Promise<{ code: string; expiresAt: number; hubPublicKey: string }> {
    this.rate(`pair:${rateSource(source)}`, 10, isLoopback(source) ? "trusted" : "anonymous");
    const input = pairingSchema.parse(raw);
    parsePublicKey(input.publicKey);
    const code = randomInt(10_000_000, 100_000_000).toString();
    const expiresAt = await this.store.db.transaction(() => this.insertPendingInTransaction(input, code));
    await this.store.audit("pairing.requested", input.deviceId);
    return { code, expiresAt, hubPublicKey: this.publicKey };
  }
  /** Caller holds the DB transaction. Returns the request's expiry. */
  private async insertPendingInTransaction(input: { deviceId: string; name: string; platform: string; publicKey: string }, code: string): Promise<number> {
    // Never allow a pairing request to replace an enrolled or revoked key.
    if (await this.store.db.get("SELECT 1 FROM devices WHERE id=?", [input.deviceId])) throw new HubError("device_already_registered", 409);
    const existing = await this.store.db.get<PairingRow>("SELECT * FROM pairing_requests WHERE device_id=?", [input.deviceId]);
    if (existing && existing.expires_at > this.now()) throw new HubError("pairing_already_pending", 409);
    const expiresAt = this.now() + PAIRING_MS;
    await this.store.db.run("DELETE FROM pairing_requests WHERE device_id=? OR expires_at<=?", [input.deviceId, this.now()]);
    await this.store.db.run("INSERT INTO pairing_requests(code_hash,device_id,name,platform,public_key,expires_at) VALUES(?,?,?,?,?,?)", [hashSecret(code), input.deviceId, input.name, input.platform, input.publicKey, expiresAt]);
    return expiresAt;
  }
  /** The only public first-registration entry (HTTP `/api/pair`). A valid
   * invite admits one pending request, never a device: the owner still has
   * to approve its 8-digit code with a signed device action. The first
   * committed request binds the invite to all of its device fields and its
   * requestId. Repeating exactly that body returns the same code while the
   * request lives, with or without the token (the App keeps its requestId,
   * not the token); anything else is refused. Retrieval never admits. Limits
   * are per invite, so missing or invalid tokens allocate nothing in the
   * shared per-source buckets. `source` is accepted for parity with `pair`. */
  async pairInvited(raw: unknown, _source: string): Promise<PairResponse> {
    const input = pairRequestSchema.parse(raw);
    if (!input.requestId) throw new HubError(input.invite ? "pairing_request_id_required" : "pairing_invite_required", input.invite ? 400 : 403);
    const device = { deviceId: input.deviceId, name: input.name, platform: input.platform, publicKey: input.publicKey };
    const fingerprint = pairingFingerprint({ ...device, requestId: input.requestId });
    const admitted = this.invites.admitted(fingerprint);
    if (admitted) return this.invites.locked(admitted, () => this.retrieveAdmitted(admitted, fingerprint));
    if (!input.invite) throw new HubError("pairing_invite_required", 403);
    const record = this.invites.lookup(input.invite);
    if (!record) throw new HubError("pairing_invite_invalid", 403);
    return this.invites.locked(record, async () => {
      if (record.binding) return this.retrieveAdmitted(record, fingerprint);
      const refused = this.invites.admissionError(record);
      if (refused) throw refused;
      this.invites.countClaim(record);
      parsePublicKey(input.publicKey);
      const code = randomInt(10_000_000, 100_000_000).toString();
      // The invite is bound only after this commits; a rollback leaves it unused.
      const expiresAt = await this.store.db.transaction(async () => {
        const creator = await this.store.db.get<{ public_key: string; revoked: number; role: string }>("SELECT d.public_key,d.revoked,u.role FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=?", [record.creator.deviceId]);
        if (!creator || creator.revoked || creator.public_key !== record.creator.publicKey || creator.role !== "owner") {
          this.invites.closeCreator(record.creator.deviceId);
          throw new HubError("pairing_invite_invalid", 403);
        }
        // Waiting for the database queue takes time; recheck the deadline.
        const late = this.invites.admissionError(record);
        if (late) throw late;
        return this.insertPendingInTransaction(device, code);
      });
      this.invites.bind(record, { fingerprint, deviceId: device.deviceId, name: device.name, platform: device.platform, code }, PAIRING_MS);
      await this.store.audit("pairing.requested", device.deviceId, { invite: record.id });
      return { code, expiresAt, hubPublicKey: this.publicKey };
    });
  }
  /** Caller holds the invite lock. Returns the bound request's code to its
   * exact body only; a different body cannot use or learn anything. */
  private async retrieveAdmitted(record: InviteRecord, fingerprint: string): Promise<PairResponse> {
    const binding = record.binding;
    if (!binding || binding.fingerprint !== fingerprint) throw new HubError("pairing_invite_used", 409);
    this.invites.countReplay(record);
    return this.store.db.serial(async () => {
      if (await this.store.db.get("SELECT 1 FROM devices WHERE id=?", [binding.deviceId])) throw new HubError("device_already_registered", 409);
      const row = await this.store.db.get<PairingRow>("SELECT * FROM pairing_requests WHERE device_id=? AND code_hash=? AND status='pending'", [binding.deviceId, hashSecret(binding.code)]);
      if (!row || row.expires_at <= this.now() || this.invites.bindingExpired(record)) throw new HubError("pairing_invite_expired", 403);
      return { code: binding.code, expiresAt: row.expires_at, hubPublicKey: this.publicKey };
    });
  }
  /** Owner session only. Issuing never touches listeners, routes or keys. */
  async issuePairingInvite(session: AuthSession, raw: unknown): Promise<PairingInviteIssued> {
    const input = pairingInviteCreateSchema.parse(raw);
    const issued = await this.store.db.serial(async () => {
      const device = await this.validateSessionInTransaction(session);
      await this.store.requireOwner(session.userId);
      const { record, token } = this.invites.issue({ deviceId: device.id, publicKey: device.public_key }, input.requestId, input.replaces);
      return { id: record.id, invite: token, expiresAt: record.expires.wall, serverTime: this.now() };
    });
    await this.store.audit("pairing.invite.issued", session.deviceId, { invite: issued.id });
    return issued;
  }
  /** The caller's own invites; never includes a token. */
  async listPairingInvites(session: AuthSession): Promise<PairingInviteList> {
    return this.store.db.serial(async () => {
      await this.validateSessionInTransaction(session);
      await this.store.requireOwner(session.userId);
      return { invites: this.invites.list(session.deviceId).map(record => this.invites.status(record)), serverTime: this.now() };
    });
  }
  /** Closes one of the caller's own invites to new admissions. A request it
   * already admitted keeps its approval window; this does not delete it. */
  async revokePairingInvite(session: AuthSession, raw: unknown): Promise<PairingInviteStatus> {
    const { id } = pairingInviteRevokeSchema.parse(raw);
    const status = await this.store.db.serial(async () => {
      await this.validateSessionInTransaction(session);
      await this.store.requireOwner(session.userId);
      return this.invites.status(this.invites.close(session.deviceId, id));
    });
    await this.store.audit("pairing.invite.revoked", session.deviceId, { invite: id });
    return status;
  }
  /** One-time upgrade step before the public listener opens: pending
   * requests created without an invite are removed once, then a marker
   * prevents repeats. Later restarts keep requests that were admitted. */
  async retireLegacyPendingPairings(): Promise<number> {
    return this.store.db.transaction(async () => {
      if (await this.store.db.get("SELECT 1 FROM meta WHERE key=?", [INVITE_ERA_KEY])) return 0;
      const removed = await this.store.db.run("DELETE FROM pairing_requests WHERE status='pending'");
      await this.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [INVITE_ERA_KEY, JSON.stringify({ since: this.now() })]);
      return removed.changes ?? 0;
    });
  }
  // `local-owner` is available only to the CLI, never selected from HTTP input.
  async approve(code: string, approver: string | "local-owner", userId = "owner", session?: AuthSession, proof?: DeviceActionProof): Promise<string> {
    return this.approvePairing(code, approver, userId, session, proof, false);
  }
  /** Native desktop IPC only: caller owns the local Hub process. */
  async approveLocalDesktop(code: string): Promise<string> {
    return this.approvePairing(code, "local-owner", "owner", undefined, undefined, true);
  }
  private async approvePairing(code: string, approver: string, userId: string, session: AuthSession | undefined, proof: DeviceActionProof | undefined, localDesktop: boolean): Promise<string> {
    try {
      const id = await this.store.db.transaction(async () => {
        if (session) {
          if (session.userId !== approver) throw new HubError("device_revoked", 401);
          await this.validateSessionInTransaction(session);
        }
        if (session || approver !== "local-owner") {
          await this.store.requireOwner(approver);
          await this.consumeDeviceAction(session, { operation: "approve", target: code }, proof,
            () => this.rate(`approve:${session?.deviceId ?? approver}`, 5, "trusted"));
        } else this.rate(`approve:${approver}`, 5, "trusted");
        const row = await this.store.db.get<PairingRow>("SELECT * FROM pairing_requests WHERE code_hash=? AND status='pending'", [hashSecret(code)]);
        if (!row || row.expires_at <= this.now()) throw new HubError("pairing_expired_or_invalid", 403);
        if (!await this.store.db.get("SELECT 1 FROM users WHERE id=?", [userId])) throw new HubError("user_not_found", 404);
        await this.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES(?,?,?,?,?,?,?)", [row.device_id, userId, row.name, row.platform, row.public_key, this.now(), this.now()]);
        await this.store.db.run("UPDATE pairing_requests SET status='approved' WHERE code_hash=?", [hashSecret(code)]);
        if (localDesktop) await this.writeLocalDesktopMarker(row.device_id, row.public_key);
        else await this.writeNetworkDeviceMarker(row.device_id, row.public_key);
        return row.device_id;
      });
      this.invites.approved(id);
      await this.store.audit("pairing.approved", session?.deviceId ?? approver, { deviceId: id }); return id;
    } catch (error) { await this.store.audit("pairing.rejected", session?.deviceId ?? approver); throw error; }
  }
  private async writeLocalDesktopMarker(id: string, publicKey: string): Promise<void> {
    await this.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`desktop-controller:v1:${hashSecret(id)}`, JSON.stringify({ id, publicKey })]);
  }
  private async writeNetworkDeviceMarker(id: string, publicKey: string): Promise<void> {
    await this.store.db.run("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)", [`network-device:v1:${hashSecret(id)}`, JSON.stringify({ id, publicKey })]);
  }
  /** Legacy identities stay unclassified until native migration or verified
   * device authentication. New approval writes its classification atomically. */
  async originalDeviceScopesInTransaction(): Promise<Map<string, "host" | "network">> {
    const trusted = await this.localDesktopControllersInTransaction(), scopes = new Map<string, "host" | "network">([...trusted.keys()].map(id => [id, "host"]));
    const markers = await this.store.db.all<{ value: string }>("SELECT value FROM meta WHERE key>='network-device:v1:' AND key<'network-device:v1;'");
    for (const { value } of markers) {
      try {
        const marker = JSON.parse(value);
        const row = await this.store.db.get<Device>("SELECT * FROM devices WHERE id=?", [marker.id]);
        if (row && !row.revoked && row.public_key === marker.publicKey && !scopes.has(row.id)) scopes.set(row.id, "network");
      } catch { /* Malformed local markers grant no classification. */ }
    }
    return scopes;
  }
  /** Native IPC migration. Never inferred from a device's claimed platform. */
  prepareDesktopController(raw: unknown): DesktopControllerChallenge {
    const device = pairingSchema.parse(raw); parsePublicKey(device.publicKey); this.prune();
    if (this.desktopControllers.size >= 32) throw new HubError("rate_limited", 429);
    const challenge = desktopControllerChallengeSchema.parse({ v: 1, hubPublicKey: this.publicKey, deviceId: device.deviceId, publicKey: device.publicKey,
      nonce: randomBytes(32).toString("base64url"), expiresAt: this.now() + CHALLENGE_MS });
    this.desktopControllers.set(challenge.nonce, challenge);
    return structuredClone(challenge);
  }
  /** The token-only native enrollment path consumes proof inside its DB transaction. */
  consumeDesktopController(raw: unknown, device: z.infer<typeof pairingSchema>): void {
    const proof = desktopControllerProofSchema.parse(raw), challenge = this.desktopControllers.get(proof.challenge.nonce);
    this.desktopControllers.delete(proof.challenge.nonce); // Failed proofs cannot be retried.
    if (!challenge || challenge.expiresAt <= this.now()) throw new HubError("desktop_controller_proof_expired", 403);
    if (challenge.deviceId !== device.deviceId || challenge.publicKey !== device.publicKey || desktopControllerProofText(challenge) !== desktopControllerProofText(proof.challenge)) throw new HubError("desktop_controller_proof_invalid", 403);
    if (!verify(null, Buffer.from(desktopControllerProofText(challenge)), parsePublicKey(device.publicKey), Buffer.from(proof.signature, "base64"))) throw new HubError("desktop_controller_proof_invalid", 403);
  }
  async markLocalDesktopController(raw: unknown): Promise<boolean> {
    const input = pairingSchema.parse(raw); parsePublicKey(input.publicKey);
    return this.store.db.transaction(async () => {
      const row = await this.store.db.get<Device & { role: string }>("SELECT d.*,u.role FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=?", [input.deviceId]);
      if (!row) return false;
      if (row.revoked || row.public_key !== input.publicKey || row.role !== "owner") throw new HubError("desktop_controller_identity_invalid", 403);
      const network = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'");
      if (network) {
        const bindings = JSON.parse(network.value)?.membership?.manifest?.devices;
        if (Array.isArray(bindings) && bindings.some((binding: { host?: string; id?: string; scope?: string; revoked?: boolean }) => binding.host === this.publicKey && binding.id === row.id && binding.scope === "network" && !binding.revoked)) throw new HubError("desktop_controller_scope_conflict", 409);
      }
      await this.writeLocalDesktopMarker(row.id, row.public_key);
      return true;
    });
  }
  /** Caller holds the DB queue; marker and current owner/key must both match. */
  localDesktopControllersInTransaction(hostNameOnly = false): Promise<Map<string, string>> {
    return localDesktopControllersInTransaction(this.store.db, hostNameOnly);
  }
  /** Caller holds the DB queue so the subject cannot change during verification. */
  private async actionTargetDigest(action: DeviceAction): Promise<string> {
    if (action.operation === "network" || action.operation === "bot-message-grant" || action.operation === "screen-grant") return action.target;
    if (action.operation === "approve") {
      const row = await this.store.db.get<PairingRow>("SELECT * FROM pairing_requests WHERE code_hash=? AND status='pending'", [hashSecret(action.target)]);
      if (!row || row.expires_at <= this.now()) throw new HubError("pairing_expired_or_invalid", 403);
      return hashSecret(JSON.stringify([row.device_id, row.public_key, row.expires_at]));
    }
    const row = await this.store.db.get<Device>("SELECT * FROM devices WHERE id=?", [action.target]);
    if (!row) throw new HubError("device_not_found", 404);
    return hashSecret(JSON.stringify([row.id, row.user_id, row.public_key, row.created_at, row.revoked]));
  }
  async prepareDeviceAction(raw: unknown, token: string, session: AuthSession): Promise<DeviceActionStatement> {
    const action = deviceActionSchema.parse(raw), sessionHash = hashSecret(token);
    return this.store.db.serial(async () => {
      this.prune();
      if (this.tokens.get(sessionHash) !== session) throw new HubError("session_expired", 401);
      await this.validateSessionInTransaction(session); await this.store.requireOwner(session.userId);
      if (this.actions.size >= 256 || [...this.actions.values()].filter((a) => a.session.deviceId === session.deviceId).length >= 8) throw new HubError("rate_limited", 429);
      const targetDigest = await this.actionTargetDigest(action);
      const statement = deviceActionStatementSchema.parse({ hubPublicKey: this.publicKey, deviceId: session.deviceId,
        sessionHash, action, targetDigest, nonce: randomBytes(32).toString("base64url"), expiresAt: Math.min(session.expiresAt, this.now() + CHALLENGE_MS) });
      this.actions.set(statement.nonce, { session, statement });
      return structuredClone(statement);
    });
  }
  /** Caller holds the membership mutation transaction. The target is the SHA256
   * of its canonical command body, computed independently by client and Hub. */
  async consumeNetworkAction(session: AuthSession, target: string, proof?: DeviceActionProof): Promise<DeviceActionStatement> {
    const action = deviceActionSchema.parse({ operation: "network", target });
    await this.validateSessionInTransaction(session);
    await this.store.requireOwner(session.userId);
    return this.consumeDeviceAction(session, action, proof);
  }
  async consumeBotMessageGrant(session: AuthSession, target: string, proof?: DeviceActionProof): Promise<void> {
    await this.validateSessionInTransaction(session); await this.store.requireOwner(session.userId);
    await this.consumeDeviceAction(session, { operation: "bot-message-grant", target }, proof);
  }
  /** Screen configuration has its own signed domain; pairing is not consent. */
  async consumeScreenGrant(session: AuthSession, target: string, proof?: DeviceActionProof): Promise<void> {
    await this.validateSessionInTransaction(session); await this.store.requireOwner(session.userId);
    if (!(await this.localDesktopControllersInTransaction()).has(session.deviceId)) throw new HubError("local_controller_required", 403);
    await this.consumeDeviceAction(session, { operation: "screen-grant", target }, proof);
  }
  /** Called only inside the mutation transaction, after current owner/trust checks. */
  private async consumeDeviceAction(session: AuthSession | undefined, action: DeviceAction, proof?: DeviceActionProof, admit?: () => void): Promise<DeviceActionStatement> {
    if (!session || !proof) throw new HubError("device_action_proof_required", 403);
    const permit = this.actions.get(proof.nonce);
    this.actions.delete(proof.nonce); // One use, including a failed signature or substituted target.
    if (!permit || permit.statement.expiresAt <= this.now()) throw new HubError("device_action_expired", 403);
    const s = permit.statement;
    if (permit.session !== session || this.tokens.get(s.sessionHash) !== session || s.action.operation !== action.operation || s.action.target !== action.target) throw new HubError("device_action_invalid", 403);
    if (s.targetDigest !== await this.actionTargetDigest(action)) throw new HubError("device_action_target_changed", 409);
    const device = await this.validateSessionInTransaction(session);
    let valid = false;
    try { valid = verify(null, Buffer.from(deviceActionProofText(s)), parsePublicKey(device.public_key), Buffer.from(proof.signature, "base64")); } catch { /* Fail closed for malformed keys/signatures. */ }
    if (!valid) throw new HubError("device_action_invalid", 403);
    if (s.expiresAt <= this.now()) throw new HubError("device_action_expired", 403);
    try { admit?.(); }
    catch (error) {
      // Only a fully validated proof survives quota rejection. Unsigned or
      // substituted attempts neither consume owner quota nor regain a proof.
      if (error instanceof HubError && error.code === "rate_limited") this.actions.set(proof.nonce, permit);
      throw error;
    }
    return structuredClone(s);
  }
  tlsIdentity(nonce: string, certificate: Buffer, source: string): TlsIdentity {
    this.rate(`tls-identity:${rateSource(source)}`, 60, isLoopback(source) ? "trusted" : "anonymous");
    tlsIdentityNonceSchema.parse(nonce);
    if (!certificate.length) throw new HubError("tls_identity_unavailable", 503);
    const proof: TlsIdentityUnsigned = { v: 1, type: "tls.identity", publicKey: this.publicKey, nonce,
      certificateSha256: createHash("sha256").update(certificate).digest("hex") };
    return { ...proof, signature: sign(null, Buffer.from(tlsIdentityProof(proof)), this.privateKey).toString("base64") };
  }
  async challenge(connectionId: string, deviceId: string, clientNonce: string, source: string): Promise<{ nonce: string; signature: string; publicKey: string }> {
    const device = await this.store.device(deviceId);
    if (!device || device.revoked) {
      this.rate(`challenge-unknown:${rateSource(source)}`, 60, isLoopback(source) ? "trusted" : "anonymous");
      await this.store.audit("auth.rejected", deviceId, { reason: "untrusted_device", source }); throw new HubError("untrusted_device", 401);
    }
    this.rate(`challenge-known:${JSON.stringify([rateSource(source), deviceId])}`, 60, isLoopback(source) ? "trusted" : "device");
    if (!this.challenges.has(connectionId) && this.challenges.size >= 2048) throw new HubError("rate_limited", 429);
    const nonce = randomBytes(32).toString("base64url");
    this.challenges.set(connectionId, { nonce, deviceId, clientNonce, expiresAt: this.now() + CHALLENGE_MS, source });
    return { nonce, publicKey: this.publicKey, signature: sign(null, serverProof(deviceId, nonce, clientNonce), this.privateKey).toString("base64") };
  }
  async authenticate(connectionId: string, signature: string): Promise<AuthSession & { token: string }> {
    const challenge = this.challenges.get(connectionId);
    this.challenges.delete(connectionId); // Consume even on a failed signature.
    if (!challenge || challenge.expiresAt <= this.now()) { await this.store.audit("auth.rejected", challenge?.deviceId ?? null, { reason: "challenge_expired" }); throw new HubError("challenge_expired", 401); }
    const { deviceId, source, nonce, clientNonce } = challenge;
    const device = await this.store.device(deviceId);
    let valid = false;
    try { valid = !!device && !device.revoked && verify(null, deviceProof(deviceId, nonce, clientNonce), parsePublicKey(device.public_key), Buffer.from(signature, "base64")); } catch { /* Invalid signatures are authentication failures. */ }
    if (!valid || !device) { this.rate(`auth-failed:${JSON.stringify([rateSource(source), deviceId])}`, 5, isLoopback(source) ? "trusted" : "device"); await this.store.audit("auth.rejected", deviceId, { reason: "signature_invalid", source }); throw new HubError("signature_invalid", 401); }
    // A correct proof must not be locked out by another caller's bad signatures.
    const token = randomBytes(32).toString("base64url");
    const session = { deviceId, userId: device.user_id, expiresAt: this.now() + TOKEN_MS };
    await this.store.db.transaction(async () => {
      await this.validateSessionInTransaction(session);
      await this.store.db.run("UPDATE devices SET last_seen=? WHERE id=?", [this.now(), deviceId]);
      await this.writeNetworkDeviceMarker(deviceId, device.public_key);
    });
    this.tokens.set(hashSecret(token), session);
    await this.store.audit("auth.accepted", deviceId);
    return { ...session, token };
  }
  /** Called after rejection within the rate-checked handshake path, never to
   * bypass a rate-limit error. No session token,
   * profile or other private data is included, and unknown devices are not
   * labelled permanently revoked. The fresh client nonce prevents replay. */
  async revocationDenial(deviceId: string, clientNonce: string): Promise<AuthDenied | undefined> {
    const device = await this.store.device(deviceId);
    if (!device?.revoked) return undefined;
    return authDeniedSchema.parse({ v: 1, type: "auth.denied", code: "device_revoked", deviceId, clientNonce, publicKey: this.publicKey,
      signature: sign(null, Buffer.from(authDeniedProof(deviceId, clientNonce)), this.privateKey).toString("base64") });
  }
  async authorize(token: string | undefined, source = "unknown"): Promise<AuthSession> {
    this.prune();
    const session = token ? this.tokens.get(hashSecret(token)) : undefined;
    if (!session || session.expiresAt <= this.now()) { await this.store.audit("http.rejected", null, { reason: "token_expired_or_invalid", source }); throw new HubError("token_expired_or_invalid", 401); }
    const device = await this.store.device(session.deviceId);
    if (!device || device.revoked) { this.tokens.delete(hashSecret(token!)); throw new HubError("device_revoked", 401); }
    return session;
  }
  async validateSession(session: AuthSession): Promise<Device> {
    return this.store.db.serial(() => this.validateSessionInTransaction(session));
  }
  /** Caller already owns the database queue/transaction; never enqueue recursively. */
  async validateSessionInTransaction(session: AuthSession): Promise<Device> {
    if (session.expiresAt <= this.now()) throw new HubError("session_expired", 401);
    const device = await this.store.db.get<Device>("SELECT * FROM devices WHERE id=?", [session.deviceId]);
    if (!device || device.revoked || device.user_id !== session.userId) throw new HubError("device_revoked", 401);
    if (session.expiresAt <= this.now()) throw new HubError("session_expired", 401);
    return device;
  }
  onRevoke(listener: (deviceId: string) => void): () => void { this.revocationListeners.add(listener); return () => this.revocationListeners.delete(listener); }
  signNetworkManifest(value: NetworkManifest): string {
    if (value.authorityKey !== this.publicKey) throw new HubError("network_not_authority", 403);
    return sign(null, Buffer.from(networkManifestProof(value)), this.privateKey).toString("base64");
  }
  signNetworkProposal(value: NetworkProposal): string {
    if (value.host.publicKey !== this.publicKey) throw new HubError("network_host_mismatch", 403);
    return sign(null, Buffer.from(networkProposalProof(value)), this.privateKey).toString("base64");
  }
  signNetworkPeer(value: NetworkPeerRequest): string {
    if (value.publicKey !== this.publicKey || value.host.publicKey !== this.publicKey) throw new HubError("network_host_mismatch", 403);
    return sign(null, Buffer.from(networkPeerProof(value)), this.privateKey).toString("base64");
  }
  /** Membership callers have already revoked device rows in one transaction.
   * Notify only after commit, so sockets and bearer tokens observe durable state. */
  notifyRevokedDevices(deviceIds: string[]): void {
    for (const deviceId of new Set(deviceIds)) {
      this.invites.closeCreator(deviceId);
      for (const [hash, session] of this.tokens) if (session.deviceId === deviceId) this.tokens.delete(hash);
      for (const [id, c] of this.challenges) if (c.deviceId === deviceId) this.challenges.delete(id);
      for (const [id, a] of this.actions) if (a.session.deviceId === deviceId) this.actions.delete(id);
      for (const listener of this.revocationListeners) { try { listener(deviceId); } catch { /* A listener cannot undo committed revocation. */ } }
    }
  }
  async revoke(deviceId: string, approver: string, session?: AuthSession, proof?: DeviceActionProof): Promise<void> {
    await this.store.db.transaction(async () => {
      if (session) {
        if (session.userId !== approver) throw new HubError("device_revoked", 401);
        await this.validateSessionInTransaction(session);
      }
      if (session || approver !== "local-owner") {
        await this.store.requireOwner(approver);
        await this.consumeDeviceAction(session, { operation: "revoke", target: deviceId }, proof);
      }
      const result = await this.store.db.run("UPDATE devices SET revoked=1,push_json=NULL WHERE id=?", [deviceId]);
      if (!result.changes) throw new HubError("device_not_found", 404);
      await this.store.db.run("DELETE FROM push_bindings WHERE device_id=?", [deviceId]);
      await this.store.db.run("UPDATE push_outbox SET status='cancelled' WHERE device_id=? AND status='pending'", [deviceId]);
    });
    this.notifyRevokedDevices([deviceId]);
    await this.store.audit("device.revoked", session?.deviceId ?? approver, { deviceId });
  }
  forgetConnection(id: string): void { this.challenges.delete(id); }
}
