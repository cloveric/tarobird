import { createHash, randomBytes } from "node:crypto";
import { MAX_PAIRING_INVITES, MAX_PAIRING_INVITES_PER_CREATOR, PAIRING_INVITE_TTL_MS, type PairingInviteStatus } from "../client-protocol/pairing-invites.js";
import { HubError } from "./errors.js";

/** Failed or rejected admission attempts per invite before it answers 429.
 * Kept per invite (bounded by invite capacity), never in the shared
 * per-source buckets that also guard TLS identity bootstrap. */
const MAX_CLAIM_ATTEMPTS = 16;
/** Identical-body retries by the bound device. Mismatched bodies do not
 * consume this budget, so a token leaked after binding cannot starve them. */
const MAX_REPLAYS = 32;
/** Concurrent operations queued on one invite. */
const MAX_WAITING = 16;
/** Closed/expired unclaimed records stay listable this long, then disappear. */
const DEAD_RETENTION_MS = 60_000;
export const MAX_DEAD_RECORDS = 64;

type Deadline = { wall: number; mono: number };
export type InviteCreator = { deviceId: string; publicKey: string };
export type InviteBinding = { fingerprint: string; deviceId: string; name: string; platform: string; code: string; expires: Deadline; approved?: Deadline };
export type InviteRecord = {
  readonly id: string; readonly hash: string; readonly creator: InviteCreator; readonly requestId: string;
  readonly createdAt: number; readonly expires: Deadline; closedAt?: number;
  /** Set only after the pending request committed. Holds the plaintext code
   * in memory until the request expires so an identical retry gets it again;
   * the database keeps only its hash. */
  binding?: InviteBinding;
  claimAttempts: number; replays: number; waiting: number; tail: Promise<void>;
};

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
/** All device-supplied fields: a retry may not rename or retarget the request. */
export function pairingFingerprint(input: { deviceId: string; name: string; platform: string; publicKey: string; requestId: string }): string {
  return createHash("sha256").update(JSON.stringify(["tarocub/pairing-request/v1", input.deviceId, input.name, input.platform, input.publicKey, input.requestId])).digest("hex");
}

/** In-memory only: a Hub restart invalidates every invite, never a pending
 * request already admitted. Raw tokens are hashed and never retained. Every
 * deadline needs both clocks: wall time survives sleep, monotonic time
 * survives a wall-clock step backwards. */
export class PairingInviteRegistry {
  private byHash = new Map<string, InviteRecord>();
  private byId = new Map<string, InviteRecord>();
  /** Admitted request fingerprint -> its invite, for token-free retrieval. */
  private byRequest = new Map<string, InviteRecord>();
  constructor(private readonly wall: () => number, private readonly mono: () => number) {}

  private passed(deadline: Deadline): boolean { return this.wall() >= deadline.wall || this.mono() >= deadline.mono; }
  private deadline(ms: number): Deadline { return { wall: this.wall() + ms, mono: this.mono() + ms }; }
  private claimed(record: InviteRecord): boolean { return !!record.binding && !this.passed(record.binding.expires); }
  /** Counts against capacity: may still admit, or holds an unapproved request. */
  private open(record: InviteRecord): boolean { return this.available(record) || this.claimed(record) && !record.binding!.approved; }
  /** Can admit a device right now. */
  private available(record: InviteRecord): boolean { return !record.binding && record.closedAt === undefined && !this.passed(record.expires); }

  /** Hard bound. `issue` caps open records (MAX_PAIRING_INVITES); every other
   * record (closed, expired, or approved) is a tombstone kept only for clearer
   * retry answers: at most MAX_DEAD_RECORDS, oldest dropped first. Dropping
   * one never affects a pending request or an enrolled device. A record with
   * an operation in flight is never dropped, but it still counts. */
  private prune(): void {
    const dead: InviteRecord[] = [];
    for (const record of this.byId.values()) {
      if (this.open(record)) continue;
      const end = this.end(record);
      if (!record.waiting && (this.wall() >= end.wall + DEAD_RETENTION_MS || this.mono() >= end.mono + DEAD_RETENTION_MS)) this.drop(record); else dead.push(record);
    }
    dead.sort((a, b) => this.end(a).wall - this.end(b).wall);
    let excess = dead.length - MAX_DEAD_RECORDS;
    for (const record of dead) {
      if (excess <= 0) break;
      if (!record.waiting) { this.drop(record); excess--; }
    }
  }
  /** When a record stopped being open (bounded by its monotonic deadline). */
  private end(record: InviteRecord): Deadline {
    if (record.binding) return record.binding.approved ?? record.binding.expires;
    return { wall: record.closedAt ?? record.expires.wall, mono: record.expires.mono };
  }
  private drop(record: InviteRecord): void {
    this.byId.delete(record.id); this.byHash.delete(record.hash);
    if (record.binding && this.byRequest.get(record.binding.fingerprint) === record) this.byRequest.delete(record.binding.fingerprint);
  }

  /** Capacity counts invites that can still admit or hold an admitted,
   * unapproved request; owner approval frees the slot. Nothing is closed
   * unless the new invite is issued. */
  issue(creator: InviteCreator, requestId: string, replaces?: string): { record: InviteRecord; token: string } {
    this.prune();
    const replaced = replaces === undefined ? undefined : this.byId.get(replaces);
    if (replaces !== undefined && (!replaced || replaced.creator.deviceId !== creator.deviceId)) throw new HubError("pairing_invite_not_found", 404);
    const retried = [...this.byId.values()].filter(record => record.creator.deviceId === creator.deviceId && record.requestId === requestId && this.available(record));
    // Only an unclaimed invite stops counting when closed; a claimed one keeps
    // its admitted request alive and therefore keeps its slot.
    const closing = new Set([...retried, ...(replaced && this.available(replaced) ? [replaced] : [])]);
    const live = [...this.byId.values()].filter(record => this.open(record));
    const mine = live.filter(record => record.creator.deviceId === creator.deviceId);
    if (mine.length - closing.size + 1 > MAX_PAIRING_INVITES_PER_CREATOR || live.length - closing.size + 1 > MAX_PAIRING_INVITES) throw new HubError("pairing_invites_full", 429);
    const now = this.wall();
    for (const record of closing) record.closedAt = now;
    if (replaced && replaced.closedAt === undefined) replaced.closedAt = now;
    const token = randomBytes(32).toString("base64url");
    const record: InviteRecord = { id: randomBytes(16).toString("base64url"), hash: hashToken(token), creator: { ...creator }, requestId,
      createdAt: now, expires: this.deadline(PAIRING_INVITE_TTL_MS), claimAttempts: 0, replays: 0, waiting: 0, tail: Promise.resolve() };
    this.byId.set(record.id, record); this.byHash.set(record.hash, record);
    return { record, token };
  }
  lookup(token: string): InviteRecord | undefined { this.prune(); return this.byHash.get(hashToken(token)); }
  /** The invite that admitted exactly this request body, if still retained.
   * Its 256-bit requestId is known only to the requesting device. */
  admitted(fingerprint: string): InviteRecord | undefined { this.prune(); return this.byRequest.get(fingerprint); }
  /** Stops new admissions only. An admitted pending request keeps its own
   * approval window, and its device may still retrieve the same code. */
  close(creatorDeviceId: string, id: string): InviteRecord {
    this.prune();
    const record = this.byId.get(id);
    if (!record || record.creator.deviceId !== creatorDeviceId) throw new HubError("pairing_invite_not_found", 404);
    if (record.closedAt === undefined) record.closedAt = this.wall();
    return record;
  }
  /** After the owner's approval commits: the record leaves capacity and
   * becomes a bounded tombstone. While retained, a retry is answered from the
   * DB (`device_already_registered`); once dropped, the enrolled device simply
   * connects with its own key. */
  approved(deviceId: string): void {
    for (const record of this.byId.values()) if (record.binding?.deviceId === deviceId && !record.binding.approved) record.binding.approved = { wall: this.wall(), mono: this.mono() };
    this.prune();
  }
  closeCreator(deviceId: string): void {
    for (const record of this.byId.values()) if (record.creator.deviceId === deviceId && record.closedAt === undefined) record.closedAt = this.wall();
  }
  list(creatorDeviceId: string): InviteRecord[] {
    this.prune();
    return [...this.byId.values()].filter(record => record.creator.deviceId === creatorDeviceId).sort((a, b) => a.createdAt - b.createdAt);
  }
  status(record: InviteRecord): PairingInviteStatus {
    const base = { id: record.id, createdAt: record.createdAt, expiresAt: record.expires.wall };
    if (record.binding) return { ...base, state: this.claimed(record) ? "claimed" : "expired", requestExpiresAt: record.binding.expires.wall,
      device: { deviceId: record.binding.deviceId, name: record.binding.name, platform: record.binding.platform } };
    return { ...base, state: record.closedAt !== undefined ? "closed" : this.passed(record.expires) ? "expired" : "available" };
  }
  /** Why this unclaimed record cannot admit a device, or undefined if it can. */
  admissionError(record: InviteRecord): HubError | undefined {
    if (record.closedAt !== undefined) return new HubError("pairing_invite_invalid", 403);
    if (this.passed(record.expires)) return new HubError("pairing_invite_expired", 403);
    return undefined;
  }
  bindingExpired(record: InviteRecord): boolean { return !!record.binding && this.passed(record.binding.expires); }
  countClaim(record: InviteRecord): void { if (++record.claimAttempts > MAX_CLAIM_ATTEMPTS) throw new HubError("rate_limited", 429); }
  countReplay(record: InviteRecord): void { if (++record.replays > MAX_REPLAYS) throw new HubError("rate_limited", 429); }
  bind(record: InviteRecord, binding: Omit<InviteBinding, "expires">, requestTtlMs: number): void {
    record.binding = { ...binding, expires: this.deadline(requestTtlMs) };
    this.byRequest.set(binding.fingerprint, record);
  }
  /** Serializes every admission/retry of one invite, including its database
   * transaction, so a rollback leaves the invite exactly as it was. */
  locked<T>(record: InviteRecord, work: () => Promise<T>): Promise<T> {
    if (record.waiting >= MAX_WAITING) return Promise.reject(new HubError("rate_limited", 429));
    record.waiting++;
    const run = record.tail.then(work);
    record.tail = run.then(() => undefined, () => undefined);
    return run.finally(() => { record.waiting--; });
  }
}
