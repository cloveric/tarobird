import { createHash, randomBytes, verify } from "node:crypto";
import { z } from "zod";
import {
  networkCanonical, networkCommandSchema, networkPublishedEnrollmentSchema, networkManifestProof, networkManifestSchema, networkGenesisText, networkMemberText, networkBindingKey, networkDeviceRetiredByHosts,
  networkPeerProof, networkProposalProof, sharedRoutesSchema, signedNetworkManifestSchema, signedNetworkPeerRequestSchema,
  signedNetworkProposalSchema, type NetworkCommandResult, type NetworkDevice, type NetworkEnrollment, type NetworkPublishedEnrollment, type NetworkHost,
  type NetworkManifest, type NetworkPeerRequest, type NetworkView, type NetworkHostDescriptor, type SignedNetworkManifest, type SignedNetworkPeerRequest,
  type SignedNetworkProposal,
} from "../client-protocol/private-network.js";
import { deviceActionProofText, type DeviceActionProof } from "../client-protocol/device-actions.js";
import type { Route } from "../client-protocol/routes.js";
import { hashSecret, HubAuth, parsePublicKey, type AuthSession } from "./auth.js";
import { HubError, type Device, type HubStore } from "./store.js";
import type { HostProfile } from "./host-profile.js";
import { syncImportedDeviceName } from "./network-device-name.js";

const STATE_KEY = "private-network:v1";
const REQUEST_MS = 5 * 60_000;
const memoSchema = z.object({ nonce: z.string(), digest: z.string(), expiresAt: z.number() }).strict();
const stateSchema = z.object({
  v: z.literal(1), routes: sharedRoutesSchema, membership: signedNetworkManifestSchema.optional(), proposal: signedNetworkProposalSchema.optional(),
  accepted: z.object({ nonce: z.string(), networkId: z.string(), authorityKey: z.string() }).strict().optional(),
  imported: z.record(z.string(), z.object({ publicKey: z.string(), memberId: z.string(), networkId: z.string() }).strict()),
  revokedMembers: z.array(z.string()), revokedHosts: z.array(z.string()), retiredNetworks: z.array(z.string()), retiredAccessNetworks: z.array(z.string()).default([]), upgradedHosts: z.array(z.string()).default([]),
  admissions: z.array(memoSchema), peers: z.array(memoSchema), proofs: z.array(memoSchema), lastSyncedAt: z.number(), waiting: z.boolean(),
  intents: z.record(z.string(), z.object({ networkId: z.string(), authorityKey: z.string(), deviceId: z.string(), devicePublicKey: z.string(), memberId: z.string(), commandHash: z.string(), expiresAt: z.number() }).strict()),
}).strict();
type NetworkState = z.infer<typeof stateSchema>;
export type NetworkExchange = (host: NetworkHost, request: SignedNetworkPeerRequest) => Promise<SignedNetworkManifest>;
export type PrivateNetworkOptions = { exchange?: NetworkExchange; now?: () => number };
export const networkMemberId = (host: string, deviceId: string): string => `pm_${createHash("sha256").update(networkMemberText(host, deviceId)).digest("base64url")}`;
export const networkId = (authority: string, nonce: string): string => `net_${hashSecret(networkGenesisText(authority, nonce))}`;
const same = (a: unknown, b: unknown) => networkCanonical(a) === networkCanonical(b);

/** A signed member's original enrollment owns its name. A relay binding, host
 * label, platform, or a matching human-readable name is never identity proof. */
function originNames(manifest: NetworkManifest): Map<string, NetworkDevice> {
  const activeHosts = new Set(manifest.hosts.filter(h => h.state === "active" && !h.revoked).map(h => h.publicKey));
  const revoked = new Set(manifest.revokedMembers), blocked = new Set(manifest.blockedBindings.map(b => networkBindingKey(b.host, b.id)));
  const blockedKeys = new Set(manifest.blockedKeys ?? []);
  return new Map(manifest.devices.filter(d => !d.revoked && !revoked.has(d.memberId) && activeHosts.has(d.host)
    && !blocked.has(networkBindingKey(d.host, d.id)) && !blockedKeys.has(hashSecret(d.publicKey))
    && d.originHost === d.host && d.attestedBy === d.host && d.memberId === networkMemberId(d.host, d.id)).map(d => [d.memberId, d]));
}

/** Pure two-phase union: additions survive restores, revocations never reverse,
 * and a conflicting binding slot becomes permanently blocked. */
export function mergeNetworkManifests(a: NetworkManifest, b: NetworkManifest): NetworkManifest {
  if (a.id !== b.id || a.authorityKey !== b.authorityKey || a.genesisNonce !== b.genesisNonce) throw new HubError("network_identity_mismatch", 403);
  const pick = <T>(x: T, y: T): T => structuredClone(networkCanonical(x) < networkCanonical(y) ? x : y);
  const merged = structuredClone(a); merged.v = a.v === 2 || b.v === 2 ? 2 : 1; merged.revision = Math.max(a.revision, b.revision); merged.name = a.name < b.name ? a.name : b.name;
  const hosts = new Map(a.hosts.map(host => [host.publicKey, structuredClone(host)]));
  for (const host of b.hosts) {
    const old = hosts.get(host.publicKey);
    if (!old) { hosts.set(host.publicKey, structuredClone(host)); continue; }
    const descriptor = pick({ name: old.name, routes: old.routes }, { name: host.name, routes: host.routes });
    const base = { publicKey: host.publicKey, ...descriptor, ...(old.protocol === 2 || host.protocol === 2 ? { protocol: 2 as const } : {}), revoked: old.revoked || host.revoked };
    if (old.state === "active" || host.state === "active") hosts.set(host.publicKey, { ...base, state: "active" });
    else if (old.proposalNonce === host.proposalNonce) hosts.set(host.publicKey, { ...base, state: "pending", proposalNonce: host.proposalNonce!, expiresAt: Math.min(old.expiresAt!, host.expiresAt!) });
    else { const pending = (old.expiresAt! > host.expiresAt! || old.expiresAt === host.expiresAt && old.proposalNonce! > host.proposalNonce!) ? old : host; hosts.set(host.publicKey, { ...base, state: "pending", proposalNonce: pending.proposalNonce!, expiresAt: pending.expiresAt! }); }
  }
  const pending = new Map<string, { host: string; nonce: string; expiresAt: number }>();
  const cancelled = new Map([...a.cancelledProposals ?? [], ...b.cancelledProposals ?? []].map(proposal => [networkBindingKey(proposal.host, proposal.nonce), proposal]));
  for (const manifest of [a, b]) {
    const history = [...manifest.pendingProposals ?? []];
    // Existing signed snapshots without the new fields remain verifiable.
    // Their current pending descriptor is the initial history entry.
    for (const host of manifest.hosts) if (host.state === "pending" && !history.some(p => p.host === host.publicKey && p.nonce === host.proposalNonce)) history.push({ host: host.publicKey, nonce: host.proposalNonce!, expiresAt: host.expiresAt! });
    for (const proposal of history) {
      const slot = networkBindingKey(proposal.host, proposal.nonce), old = pending.get(slot);
      if (old && old.expiresAt !== proposal.expiresAt || proposal.expiresAt === 1) cancelled.set(slot, { host: proposal.host, nonce: proposal.nonce });
      pending.set(slot, { ...proposal, expiresAt: Math.max(old?.expiresAt ?? 0, proposal.expiresAt) });
    }
  }
  for (const host of hosts.values()) if (host.state === "pending") {
    const all = [...pending.values()].filter(proposal => proposal.host === host.publicKey).sort((x, y) => y.expiresAt - x.expiresAt || (x.nonce < y.nonce ? 1 : -1));
    const usable = all.find(proposal => !cancelled.has(networkBindingKey(proposal.host, proposal.nonce))), selected = usable ?? all[0]!;
    host.proposalNonce = selected.nonce; host.expiresAt = usable ? selected.expiresAt : 1;
  }
  merged.pendingProposals = [...pending.values()].sort((x, y) => networkBindingKey(x.host, x.nonce).localeCompare(networkBindingKey(y.host, y.nonce)));
  merged.cancelledProposals = [...cancelled.values()].sort((x, y) => networkBindingKey(x.host, x.nonce).localeCompare(networkBindingKey(y.host, y.nonce)));
  const blocked = new Map([...a.blockedBindings, ...b.blockedBindings].map(binding => [networkBindingKey(binding.host, binding.id), binding]));
  const conflictMembers = new Set<string>(), blockedKeys = new Set([...(a.blockedKeys ?? []), ...(b.blockedKeys ?? [])]);
  const devices = new Map(a.devices.map(device => [networkBindingKey(device.host, device.id), structuredClone(device)]));
  for (const device of b.devices) {
    const slot = networkBindingKey(device.host, device.id), old = devices.get(slot);
    if (!old) { devices.set(slot, structuredClone(device)); continue; }
    const conflict = old.publicKey !== device.publicKey || old.memberId !== device.memberId || old.originHost !== device.originHost || old.attestedBy !== device.attestedBy;
    if (conflict) { blocked.set(slot, { host: device.host, id: device.id }); conflictMembers.add(old.memberId); conflictMembers.add(device.memberId); blockedKeys.add(hashSecret(old.publicKey)); blockedKeys.add(hashSecret(device.publicKey)); }
    const preferred = pick({ ...old, scope: undefined, revoked: false }, { ...device, scope: undefined, revoked: false });
    devices.set(slot, { ...preferred, revoked: old.revoked || device.revoked || conflict });
  }
  const scopes = new Map<string, Set<"host" | "network">>();
  for (const device of [...a.devices, ...b.devices]) if (device.scope) {
    const values = scopes.get(device.memberId) ?? new Set(); values.add(device.scope); scopes.set(device.memberId, values);
  }
  for (const device of devices.values()) {
    const values = scopes.get(device.memberId);
    if (values?.size) device.scope = values.has("host") ? "host" : "network";
    if (values?.size === 2) conflictMembers.add(device.memberId);
  }
  const keys = new Map<string, NetworkDevice[]>();
  for (const device of devices.values()) { const list = keys.get(device.publicKey) ?? []; list.push(device); keys.set(device.publicKey, list); }
  for (const [key, bindings] of keys) if (hosts.has(key) || bindings.length > 1 || blockedKeys.has(hashSecret(key))) for (const binding of bindings) { blockedKeys.add(hashSecret(key)); binding.revoked = true; blocked.set(networkBindingKey(binding.host, binding.id), { host: binding.host, id: binding.id }); }
  merged.blockedKeys = [...blockedKeys].sort();
  merged.hosts = [...hosts.values()].sort((x, y) => x.publicKey.localeCompare(y.publicKey));
  merged.devices = [...devices.values()].sort((x, y) => networkBindingKey(x.host, x.id).localeCompare(networkBindingKey(y.host, y.id)));
  merged.revokedMembers = [...new Set([...a.revokedMembers, ...b.revokedMembers, ...conflictMembers])].sort();
  merged.blockedBindings = [...blocked.values()].sort((x, y) => networkBindingKey(x.host, x.id).localeCompare(networkBindingKey(y.host, y.id)));
  const removed = new Set(merged.hosts.filter(host => host.revoked).map(host => host.publicKey));
  for (const binding of merged.devices) if (binding.scope !== "network" && removed.has(binding.originHost)) merged.revokedMembers.push(binding.memberId);
  merged.revokedMembers = [...new Set(merged.revokedMembers)].sort();
  const revokedMembers = new Set(merged.revokedMembers);
  for (const binding of merged.devices) if (networkDeviceRetiredByHosts(binding, removed) || revokedMembers.has(binding.memberId) || blocked.has(networkBindingKey(binding.host, binding.id))) binding.revoked = true;
  return networkManifestSchema.parse(merged);
}

/** A signed directory is shared, while each Hub continues to own its runtime,
 * database and private key. Only the creating Hub signs directory revisions. */
export class PrivateNetwork {
  private readonly now: () => number;
  private closed = false;
  private ticking?: Promise<void>;
  private commandTail: Promise<unknown> = Promise.resolve();
  private commandsPending = 0;
  private pendingExchanges = 0;
  constructor(private readonly store: HubStore, private readonly auth: HubAuth, private readonly profile: HostProfile, private readonly options: PrivateNetworkOptions = {}) {
    this.now = options.now ?? Date.now;
  }
  private checkOpen() { if (this.closed) throw new HubError("network_closed", 503); }
  private async load(): Promise<NetworkState> {
    const row = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [STATE_KEY]);
    return row ? stateSchema.parse(JSON.parse(row.value)) : { v: 1, routes: [], imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], retiredAccessNetworks: [], upgradedHosts: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: 0, waiting: false };
  }
  private async save(state: NetworkState) {
    this.checkOpen();
    await this.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [STATE_KEY, JSON.stringify(stateSchema.parse(state))]);
  }
  private descriptor(state: NetworkState, name: string): NetworkHostDescriptor { return { publicKey: this.auth.publicKey, name, routes: state.routes, protocol: 2 }; }
  private host(state: NetworkState, name: string): NetworkHost { return { ...this.descriptor(state, name), state: "active", revoked: false }; }
  private asView(state: NetworkState, name: string): NetworkView {
    const own = state.membership?.manifest.hosts.find(host => host.publicKey === this.auth.publicKey);
    return { host: own ? { ...own, name, routes: state.routes } : this.host(state, name), ...(state.membership ? { membership: state.membership } : {}),
      sync: !state.membership ? "standalone" : own?.revoked ? "removed" : state.waiting || own?.state === "pending" ? "waiting" : "current", lastSyncedAt: state.lastSyncedAt };
  }
  async view(validate?: () => Promise<unknown>): Promise<NetworkView> {
    this.checkOpen();
    const { name } = await this.profile.read();
    return this.store.db.serial(async () => { this.checkOpen(); await validate?.(); return this.asView(await this.load(), name); });
  }
  /** This host's signed single-direct descriptor routes, for its own views. */
  async sharedRoutes(validate?: () => Promise<unknown>): Promise<Route[]> {
    this.checkOpen();
    return this.store.db.serial(async () => { this.checkOpen(); await validate?.(); return structuredClone((await this.load()).routes); });
  }
  /** Host-internal maintenance of its own descriptor: no device proof, because
   * no other identity's data changes. Compare-and-swap in the same transaction
   * as owner `routes` commands, so a concurrent owner choice always wins. No
   * network I/O: an authority signs one revision, a peer publishes on tick. */
  async replaceManagedRoutes(expected: readonly Route[], next: readonly Route[]): Promise<boolean> {
    this.checkOpen();
    const routes = sharedRoutesSchema.parse(next), { name } = await this.profile.read(), revoked: string[] = [];
    const changed = await this.store.db.transaction(async () => {
      this.checkOpen();
      const state = await this.load(), own = state.membership?.manifest.hosts.find(host => host.publicKey === this.auth.publicKey);
      if (!same(state.routes, expected) || same(state.routes, routes) || state.membership && (!own || own.revoked)) return false;
      state.routes = routes;
      if (state.membership?.manifest.authorityKey === this.auth.publicKey) await this.refreshAuthority(state, name, revoked);
      else if (own?.state === "active") state.waiting = true;
      await this.save(state);
      return true;
    });
    this.auth.notifyRevokedDevices(revoked);
    return changed;
  }
  /** Caller holds the database writer/serial guard; never nests db.serial. */
  async requireMessagePeerInTransaction(publicKey: string): Promise<void> {
    if (publicKey === this.auth.publicKey) return;
    const state = await this.load(), manifest = this.active(state);
    if (state.retiredNetworks.includes(manifest.id) || !manifest.hosts.some(h => h.publicKey === publicKey && h.state === "active" && !h.revoked)
      || state.revokedHosts.includes(`${manifest.id}:${publicKey}`)) throw new HubError("bot_message_peer_revoked", 403);
  }
  private active(state: NetworkState, allowPending = false): NetworkManifest {
    const manifest = state.membership?.manifest;
    if (!manifest) throw new HubError("network_not_joined", 409);
    if (!manifest.hosts.some(host => host.publicKey === this.auth.publicKey && !host.revoked && (allowPending || host.state === "active"))) throw new HubError("network_host_removed", 403);
    return manifest;
  }
  private authority(state: NetworkState): NetworkManifest {
    const manifest = this.active(state);
    if (manifest.authorityKey !== this.auth.publicKey) throw new HubError("network_not_authority", 403);
    return manifest;
  }
  private verifyMembership(raw: unknown): SignedNetworkManifest {
    const signed = signedNetworkManifestSchema.parse(raw), manifest = signed.manifest;
    if (!same(signed, raw)) throw new HubError("network_noncanonical", 400);
    if (manifest.id !== networkId(manifest.authorityKey, manifest.genesisNonce)) throw new HubError("network_identity_mismatch", 403);
    if (!verify(null, Buffer.from(networkManifestProof(manifest)), parsePublicKey(manifest.authorityKey), Buffer.from(signed.signature, "base64"))) throw new HubError("network_signature_invalid", 403);
    const blockedKeys = new Set(manifest.blockedKeys ?? []);
    const origins = new Map(manifest.devices.filter(device => device.memberId === networkMemberId(device.host, device.id) && device.originHost === device.host && device.attestedBy === device.host).map(device => [device.memberId, device.host]));
    for (const host of manifest.hosts) parsePublicKey(host.publicKey);
    for (const device of manifest.devices) {
      parsePublicKey(device.publicKey);
      if (!device.revoked && (origins.get(device.memberId) !== device.originHost || blockedKeys.has(hashSecret(device.publicKey)))) throw new HubError("network_membership_invalid", 403);
    }
    return signed;
  }
  private sign(manifest: NetworkManifest): SignedNetworkManifest {
    const parsed = networkManifestSchema.parse(manifest);
    return { manifest: parsed, signature: this.auth.signNetworkManifest(parsed) };
  }
  private next(state: NetworkState, manifest: NetworkManifest, force = false): void {
    const names = originNames(manifest);
    for (const binding of manifest.devices) {
      const source = names.get(binding.memberId);
      if (!binding.revoked && source?.host === binding.originHost) binding.name = source.name;
    }
    const current = state.membership?.manifest;
    if (!force && current && same(current, manifest)) return;
    const revision = Math.max(current?.revision ?? -1, manifest.revision);
    if (revision >= Number.MAX_SAFE_INTEGER) throw new HubError("network_revision_exhausted", 409);
    state.membership = this.sign({ ...manifest, revision: revision + 1 });
    state.lastSyncedAt = this.now(); state.waiting = false;
  }
  /** Recovery still unions additions and irreversible tombstones. Mutable
   * descriptors follow the newer signed directory, with the authority's
   * trusted current state winning a same-revision fork. Direct signed peer
   * publications remain the normal descriptor update path. This policy belongs
   * at the authority boundary, not in the commutative membership CRDT. */
  private reconcile(current: NetworkManifest, incoming: NetworkManifest): NetworkManifest {
    const merged = mergeNetworkManifests(current, incoming);
    const preferred = incoming.revision > current.revision ? incoming : current;
    const descriptors = new Map(preferred.hosts.filter(host => host.state === "active").map(host => [host.publicKey, host]));
    for (const host of merged.hosts) {
      const descriptor = descriptors.get(host.publicKey);
      if (descriptor) { host.name = descriptor.name; host.routes = structuredClone(descriptor.routes); }
    }
    const devices = new Map(preferred.devices.map(device => [networkBindingKey(device.host, device.id), device]));
    for (const device of merged.devices) {
      const descriptor = devices.get(networkBindingKey(device.host, device.id));
      if (descriptor && !device.revoked && descriptor.publicKey === device.publicKey && descriptor.memberId === device.memberId
        && descriptor.originHost === device.originHost && descriptor.attestedBy === device.attestedBy) {
        device.name = descriptor.name; device.platform = descriptor.platform;
      }
    }
    return merged;
  }
  private async originals(state: NetworkState, manifest = state.membership?.manifest): Promise<NetworkPublishedEnrollment[]> {
    const rows = await this.store.db.all<Device>("SELECT d.* FROM devices d JOIN users u ON u.id=d.user_id WHERE u.role='owner' ORDER BY d.id");
    const scopes = await this.auth.originalDeviceScopesInTransaction();
    return rows.filter(device => !device.revoked && !state.imported[device.id] && !state.revokedMembers.includes(networkMemberId(this.auth.publicKey, device.id))
      && !manifest?.devices.some(binding => binding.host === this.auth.publicKey && binding.id === device.id && (binding.memberId !== networkMemberId(this.auth.publicKey, device.id) || binding.revoked)))
      .map(device => networkPublishedEnrollmentSchema.parse({ id: device.id, publicKey: device.public_key, host: this.auth.publicKey, name: device.name, platform: device.platform, ...(scopes.has(device.id) ? { scope: scopes.get(device.id) } : {}) }));
  }
  private async localRevocations(state: NetworkState): Promise<string[]> {
    const bindings = state.membership?.manifest.devices.filter(device => device.host === this.auth.publicKey) ?? [];
    const revoked = new Set(state.revokedMembers);
    for (const binding of bindings) {
      const row = await this.store.db.get<Device>("SELECT * FROM devices WHERE id=?", [binding.id]);
      // A manifest may retire an old target key while the member remains active.
      // Only a newly revoked, previously active local binding revokes the member.
      if (!binding.revoked && row?.revoked && row.public_key === binding.publicKey) revoked.add(binding.memberId);
    }
    state.revokedMembers = [...revoked];
    return bindings.filter(binding => revoked.has(binding.memberId)).map(binding => binding.id);
  }
  private rememberTombstones(state: NetworkState, manifest: NetworkManifest): void {
    state.revokedMembers = [...new Set([...state.revokedMembers, ...manifest.revokedMembers])];
    state.revokedHosts = [...new Set([...state.revokedHosts, ...manifest.hosts.filter(host => host.revoked).map(host => `${manifest.id}:${host.publicKey}`)])];
  }
  private applyTombstones(state: NetworkState, manifest: NetworkManifest): void {
    const revokedHosts = new Set(state.revokedHosts);
    for (const host of manifest.hosts) if (revokedHosts.has(`${manifest.id}:${host.publicKey}`)) host.revoked = true;
    const removed = new Set(manifest.hosts.filter(host => host.revoked).map(host => host.publicKey));
    const revoked = new Set([...state.revokedMembers, ...manifest.revokedMembers, ...manifest.devices.filter(device => device.scope !== "network" && removed.has(device.originHost)).map(device => device.memberId)]);
    const blocked = new Set(manifest.blockedBindings.map(binding => networkBindingKey(binding.host, binding.id))), blockedKeys = new Set(manifest.blockedKeys ?? []);
    manifest.revokedMembers = [...revoked].sort();
    for (const device of manifest.devices) if (networkDeviceRetiredByHosts(device, removed) || revoked.has(device.memberId) || blocked.has(networkBindingKey(device.host, device.id)) || blockedKeys.has(hashSecret(device.publicKey))) device.revoked = true;
    this.rememberTombstones(state, manifest);
  }
  private publish(manifest: NetworkManifest, host: NetworkHostDescriptor, devices: NetworkPublishedEnrollment[]): void {
    const target = manifest.hosts.find(item => item.publicKey === host.publicKey);
    if (!target || target.revoked || target.state !== "active") throw new HubError("network_host_removed", 403);
    Object.assign(target, manifest.v === 2 ? host : { publicKey: host.publicKey, name: host.name, routes: host.routes });
    if (new Set(devices.map(device => device.id)).size !== devices.length) throw new HubError("network_device_conflict", 409);
    for (const published of devices) {
      const { scope, ...legacy } = published;
      const device: NetworkPublishedEnrollment = manifest.v === 2 ? published : legacy;
      if (device.host !== host.publicKey) throw new HubError("network_device_origin_invalid", 403);
      parsePublicKey(device.publicKey);
      if (manifest.blockedKeys?.includes(hashSecret(device.publicKey))) throw new HubError("network_device_key_blocked", 409);
      const memberId = networkMemberId(host.publicKey, device.id), existing = manifest.devices.find(item => item.id === device.id && item.host === device.host);
      if (existing) {
        if (existing.publicKey !== device.publicKey || existing.memberId !== memberId || existing.originHost !== host.publicKey || existing.attestedBy !== host.publicKey) throw new HubError("network_device_conflict", 409);
        if (device.scope) {
          const member = manifest.devices.filter(binding => binding.memberId === memberId);
          if (member.some(binding => binding.scope && binding.scope !== device.scope)) throw new HubError("network_device_scope_conflict", 409);
          for (const binding of member) binding.scope = device.scope;
        }
        existing.name = device.name; existing.platform = device.platform;
      } else {
        if (manifest.hosts.some(item => item.publicKey === device.publicKey) || manifest.devices.some(item => item.publicKey === device.publicKey)) throw new HubError("network_device_key_reused", 409);
        manifest.devices.push({ ...device, memberId, originHost: host.publicKey, attestedBy: host.publicKey, revoked: manifest.revokedMembers.includes(memberId) || manifest.blockedBindings.some(binding => binding.host === device.host && binding.id === device.id) });
      }
    }
    networkManifestSchema.parse(manifest);
  }
  private attest(manifest: NetworkManifest, sourceHost: string, sourceDeviceId: string, device: NetworkEnrollment): void {
    const source = manifest.devices.find(binding => binding.id === sourceDeviceId && binding.host === sourceHost && !binding.revoked && !manifest.revokedMembers.includes(binding.memberId));
    if (!source || !manifest.hosts.some(host => host.publicKey === sourceHost && !host.revoked && host.state === "active")) throw new HubError("network_source_device_invalid", 403);
    if (!manifest.hosts.some(host => host.publicKey === device.host && !host.revoked && host.state === "active")) throw new HubError("network_target_host_invalid", 403);
    parsePublicKey(device.publicKey);
    if (manifest.blockedKeys?.includes(hashSecret(device.publicKey))) throw new HubError("network_device_key_blocked", 409);
    if (manifest.blockedBindings.some(binding => binding.host === device.host && binding.id === device.id)) throw new HubError("network_device_conflict", 409);
    const existing = manifest.devices.find(binding => binding.id === device.id && binding.host === device.host);
    if (existing) {
      if (existing.revoked || existing.host !== device.host || existing.publicKey !== device.publicKey || existing.memberId !== source.memberId) throw new HubError("network_device_conflict", 409);
      return;
    }
    const byKey = manifest.devices.find(binding => binding.publicKey === device.publicKey);
    if (byKey && byKey.memberId === source.memberId && byKey.host === device.host && !byKey.revoked) return;
    if (byKey || manifest.hosts.some(host => host.publicKey === device.publicKey)) throw new HubError("network_device_key_reused", 409);
    for (const binding of manifest.devices) if (binding.host === device.host && binding.memberId === source.memberId && !binding.revoked) binding.revoked = true;
    manifest.devices.push({ ...device, memberId: source.memberId, originHost: source.originHost, attestedBy: sourceHost, ...(source.scope ? { scope: source.scope } : {}), revoked: false });
    networkManifestSchema.parse(manifest);
  }
  private async revokeRow(id: string, revoked: string[]): Promise<void> {
    const result = await this.store.db.run("UPDATE devices SET revoked=1,push_json=NULL WHERE id=? AND revoked=0", [id]);
    await this.store.db.run("DELETE FROM push_bindings WHERE device_id=?", [id]);
    await this.store.db.run("UPDATE push_outbox SET status='cancelled' WHERE device_id=? AND status='pending'", [id]);
    if (result.changes) revoked.push(id);
  }
  private async materialize(state: NetworkState, revoked: string[]): Promise<void> {
    const manifest = state.membership!.manifest;
    const names = originNames(manifest);
    const self = manifest.hosts.find(host => host.publicKey === this.auth.publicKey);
    if (!self) throw new HubError("network_host_missing", 403);
    if (self.revoked) { await this.retireLocalAccess(state, manifest.id, revoked); return; }
    const nativeNames = await this.auth.localDesktopControllersInTransaction(true);
    for (const binding of manifest.devices.filter(device => device.host === this.auth.publicKey)) {
      const row = await this.store.db.get<Device & { role: string }>("SELECT d.*,u.role FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=?", [binding.id]);
      const origin = state.imported[binding.id];
      if (manifest.blockedBindings.some(slot => slot.host === binding.host && slot.id === binding.id)) {
        // A recovered fork cannot replace either identity occupying this slot.
        // Disable its old local row and preserve the key for an explicit repair.
        await this.revokeRow(binding.id, revoked);
        continue;
      }
      if (row && (row.public_key !== binding.publicKey || row.role !== "owner" || (origin ? origin.publicKey !== binding.publicKey || origin.memberId !== binding.memberId || origin.networkId !== manifest.id : binding.memberId !== networkMemberId(this.auth.publicKey, binding.id)))) throw new HubError("network_device_conflict", 409);
      const pending = await this.store.db.get<{ public_key: string }>("SELECT public_key FROM pairing_requests WHERE device_id=? AND status='pending' AND expires_at>?", [binding.id, this.now()]);
      if (pending && pending.public_key !== binding.publicKey) throw new HubError("network_device_conflict", 409);
      if (!row && !binding.revoked && !self.revoked && self.state === "active" && !state.revokedMembers.includes(binding.memberId)) {
        await this.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES(?,'owner',?,?,?,?,?)", [binding.id, binding.name, binding.platform, binding.publicKey, this.now(), this.now()]);
        state.imported[binding.id] = { publicKey: binding.publicKey, memberId: binding.memberId, networkId: manifest.id };
      }
      const source = names.get(binding.memberId), imported = state.imported[binding.id];
      if (imported && imported.networkId === manifest.id && imported.memberId === binding.memberId && imported.publicKey === binding.publicKey
        && self.state === "active" && !binding.revoked && !row?.revoked && !nativeNames.has(binding.id) && !state.revokedMembers.includes(binding.memberId)
        && source?.host === binding.originHost) {
        await syncImportedDeviceName(this.store.db, row ?? { id: binding.id, name: binding.name, public_key: binding.publicKey },
          { networkId: manifest.id, memberId: binding.memberId, name: source.name }, !row);
      }
      if (binding.revoked || self.revoked || state.revokedMembers.includes(binding.memberId)) await this.revokeRow(binding.id, revoked);
    }
  }
  private async importMembership(state: NetworkState, signed: SignedNetworkManifest, revoked: string[]): Promise<void> {
    const prior = state.membership?.manifest, manifest = signed.manifest;
    if (!prior || prior.id !== manifest.id || prior.authorityKey !== manifest.authorityKey) throw new HubError("network_identity_mismatch", 403);
    if (prior.v === 2 && manifest.v !== 2) throw new HubError("network_revocation_rollback", 409);
    if (manifest.revision < prior.revision) throw new HubError("network_manifest_stale", 409);
    if (manifest.revision === prior.revision && !same(manifest, prior)) throw new HubError("network_manifest_conflict", 409);
    for (const old of prior.hosts) if (!manifest.hosts.some(host => host.publicKey === old.publicKey && (!old.revoked || host.revoked) && (old.state !== "active" || host.state === "active"))) throw new HubError("network_revocation_rollback", 409);
    for (const old of prior.devices) if (!manifest.devices.some(device => device.id === old.id && device.host === old.host && (!old.revoked || device.revoked) && (device.publicKey === old.publicKey && device.memberId === old.memberId && device.originHost === old.originHost && (device.attestedBy === old.attestedBy && (!old.scope || device.scope === old.scope || manifest.revokedMembers.includes(old.memberId))) || manifest.blockedBindings.some(binding => binding.host === old.host && binding.id === old.id)))) throw new HubError("network_revocation_rollback", 409);
    if ((prior.cancelledProposals ?? []).some(old => !manifest.cancelledProposals?.some(item => item.host === old.host && item.nonce === old.nonce))
      || (prior.pendingProposals ?? []).some(old => !manifest.pendingProposals?.some(item => item.host === old.host && item.nonce === old.nonce && item.expiresAt >= old.expiresAt))) throw new HubError("network_revocation_rollback", 409);
    if ((prior.blockedKeys ?? []).some(key => !manifest.blockedKeys?.includes(key))) throw new HubError("network_revocation_rollback", 409);
    if (prior.revokedMembers.some(memberId => !manifest.revokedMembers.includes(memberId)) || prior.blockedBindings.some(old => !manifest.blockedBindings.some(binding => binding.host === old.host && binding.id === old.id))) throw new HubError("network_revocation_rollback", 409);
    state.membership = signed;
    this.rememberTombstones(state, manifest);
    await this.materialize(state, revoked);
    state.lastSyncedAt = this.now(); state.waiting = false;
  }
  private upgradeProtocol(state: NetworkState, manifest: NetworkManifest, peer?: NetworkHostDescriptor): void {
    state.upgradedHosts = [...new Set([...state.upgradedHosts, `${manifest.id}:${this.auth.publicKey}`, ...(peer?.protocol === 2 ? [`${manifest.id}:${peer.publicKey}`] : [])])];
    if (manifest.v === 2) return;
    const confirmed = new Set(state.upgradedHosts);
    if (manifest.hosts.some(host => !host.revoked && host.state === "active" && !confirmed.has(`${manifest.id}:${host.publicKey}`))) return;
    manifest.v = 2;
    for (const host of manifest.hosts) if (!host.revoked && host.state === "active") host.protocol = 2;
  }
  private async refreshAuthority(state: NetworkState, name: string, revoked: string[]): Promise<void> {
    const manifest = structuredClone(this.authority(state));
    this.upgradeProtocol(state, manifest);
    await this.localRevocations(state);
    this.publish(manifest, this.descriptor(state, name), await this.originals(state));
    this.applyTombstones(state, manifest);
    this.next(state, manifest);
    await this.materialize(state, revoked);
  }
  private async request(state: NetworkState, name: string, attest?: NetworkPeerRequest["attest"], action?: "cancel" | "retire"): Promise<SignedNetworkPeerRequest> {
    const manifest = this.active(state, true), self = manifest.hosts.find(host => host.publicKey === this.auth.publicKey)!;
    if (self.state === "pending" && (!state.accepted || state.accepted.nonce !== self.proposalNonce)) throw new HubError("network_proposal_missing", 409);
    // The first commit confirms exactly what the authority admitted. Local
    // route/name changes made while an exchange was offline publish on the
    // next active sync; they cannot silently rewrite the approved descriptor.
    const descriptor = self.state === "pending"
      ? { publicKey: self.publicKey, name: self.name, routes: self.routes, ...(self.protocol ? { protocol: self.protocol } : {}) }
      : this.descriptor(state, name);
    const request: NetworkPeerRequest = { v: 1, networkId: manifest.id, publicKey: this.auth.publicKey,
      nonce: randomBytes(32).toString("base64url"), expiresAt: this.now() + REQUEST_MS, host: descriptor, devices: await this.originals(state),
      revoked: [...new Set(await this.localRevocations(state))], known: state.membership!, ...(attest ? { attest } : {}), ...(action === "retire" ? { retire: true as const } : self.state === "pending" ? action === "cancel" ? { cancel: self.proposalNonce! } : { commit: self.proposalNonce! } : {}) };
    return { request, signature: this.auth.signNetworkPeer(request) };
  }
  private async exchange(state: NetworkState, request: SignedNetworkPeerRequest): Promise<SignedNetworkManifest> {
    this.checkOpen();
    const manifest = this.active(state, true), authority = manifest.hosts.find(host => host.publicKey === manifest.authorityKey)!;
    if (!this.options.exchange) throw new HubError("network_authority_unavailable", 503);
    if (request.request.commit) this.pendingExchanges++;
    try { const returned = await this.options.exchange(authority, request); this.checkOpen(); return this.verifyMembership(returned); }
    finally { if (request.request.commit) this.pendingExchanges--; }
  }
  command(raw: unknown, session: AuthSession, proof?: DeviceActionProof): Promise<NetworkCommandResult> {
    // A sync must not import a command's receipt first: joining could then see
    // a stale revision, and departure could revoke the requesting phone before
    // its own authorized operation returns. Keep network I/O outside the DB
    // lock and leave all session/proof checks in the command transactions.
    this.commandsPending++;
    const work = this.commandTail.then(async () => {
      await this.ticking?.catch(() => undefined);
      return this.applyCommand(raw, session, proof);
    });
    this.commandTail = work.catch(() => undefined);
    return work.finally(() => { this.commandsPending--; });
  }
  private async applyCommand(raw: unknown, session: AuthSession, proof?: DeviceActionProof): Promise<NetworkCommandResult> {
    this.checkOpen();
    const command = networkCommandSchema.parse(raw), { name } = await this.profile.read(), revoked: string[] = [];
    if (!same(command, raw)) throw new HubError("network_noncanonical", 400);
    let outgoing: { state: NetworkState; request: SignedNetworkPeerRequest } | undefined, intentNonce: string | undefined;
    const result = await this.store.db.transaction(async (): Promise<NetworkCommandResult> => {
      this.checkOpen();
      const commandHash = hashSecret(networkCanonical(command));
      const statement = await this.auth.consumeNetworkAction(session, commandHash, proof);
      const state = await this.load();
      if (["routes", "attest", "remove", "leave"].includes(command.operation) && "networkId" in command && command.networkId !== (state.membership?.manifest.id ?? "")) throw new HubError("network_identity_mismatch", 403);
      let proposal: SignedNetworkProposal | undefined, departure: SignedNetworkManifest | undefined;
      if (command.operation === "create") {
        if (state.membership) throw new HubError("network_already_joined", 409);
        const genesisNonce = randomBytes(32).toString("base64url");
        const manifest: NetworkManifest = { v: 2, id: networkId(this.auth.publicKey, genesisNonce), name: command.name, authorityKey: this.auth.publicKey, genesisNonce, revision: 0,
          hosts: [this.host(state, name)], devices: (await this.originals(state)).map(device => ({ ...device, memberId: networkMemberId(this.auth.publicKey, device.id), originHost: this.auth.publicKey, attestedBy: this.auth.publicKey, revoked: false })), revokedMembers: [], blockedBindings: [], blockedKeys: [], pendingProposals: [], cancelledProposals: [] };
        state.membership = this.sign(manifest); state.lastSyncedAt = this.now(); state.waiting = false;
        delete state.proposal; delete state.accepted;
      } else if (command.operation === "routes") {
        state.routes = command.routes;
        if (state.membership?.manifest.authorityKey === this.auth.publicKey) await this.refreshAuthority(state, name, revoked);
        else if (state.membership) state.waiting = true;
      } else if (command.operation === "propose") {
        if (state.imported[session.deviceId]) throw new HubError("network_local_owner_required", 403);
        if (command.authorityKey === this.auth.publicKey) throw new HubError("network_invalid_destination", 409);
        if (state.membership && (state.membership.manifest.authorityKey !== this.auth.publicKey || state.membership.manifest.hosts.some(host => host.publicKey !== this.auth.publicKey && !host.revoked && (host.state === "active" || host.expiresAt! > this.now())))) throw new HubError("network_already_joined", 409);
        if (state.retiredNetworks.includes(command.networkId)) throw new HubError("network_retired", 403);
        parsePublicKey(command.authorityKey);
        const unsigned = { v: 1 as const, host: this.descriptor(state, name), devices: await this.originals(state), networkId: command.networkId,
          authorityKey: command.authorityKey, seenManifestHash: command.seenManifestHash, nonce: randomBytes(32).toString("base64url"), expiresAt: this.now() + REQUEST_MS };
        proposal = { proposal: unsigned, signature: this.auth.signNetworkProposal(unsigned) }; state.proposal = proposal;
      } else if (command.operation === "admit") {
        const manifest = structuredClone(this.authority(state)), signed = command.proposal, proposed = signed.proposal;
        if (manifest.v !== 2 || proposed.host.protocol !== 2) throw new HubError("network_upgrade_required", 409);
        if (proposed.networkId !== manifest.id || proposed.authorityKey !== this.auth.publicKey || proposed.host.publicKey === this.auth.publicKey) throw new HubError("network_identity_mismatch", 403);
        this.validDeadline(proposed.expiresAt);
        if (!verify(null, Buffer.from(networkProposalProof(proposed)), parsePublicKey(proposed.host.publicKey), Buffer.from(signed.signature, "base64"))) throw new HubError("network_signature_invalid", 403);
        const digest = hashSecret(networkCanonical(signed)), prior = state.admissions.find(item => item.nonce === proposed.nonce);
        if (prior && prior.digest !== digest) throw new HubError("network_request_replayed", 403);
        if (!prior) {
          if (proposed.seenManifestHash !== hashSecret(networkCanonical(manifest))) throw new HubError("network_review_changed", 409);
          if (manifest.cancelledProposals?.some(item => item.host === proposed.host.publicKey && item.nonce === proposed.nonce)) throw new HubError("network_proposal_cancelled", 409);
          const existing = manifest.hosts.find(host => host.publicKey === proposed.host.publicKey);
          if (existing?.revoked || state.revokedHosts.includes(`${manifest.id}:${proposed.host.publicKey}`)) throw new HubError("network_host_removed", 403);
          if (existing?.state === "active") throw new HubError("network_host_already_joined", 409);
          if (manifest.hosts.filter(host => host.state === "pending" && !host.revoked && host.expiresAt! > this.now() && host.publicKey !== proposed.host.publicKey).length >= 16) throw new HubError("network_pending_limit", 409);
          this.rememberPending(manifest, proposed.host.publicKey, proposed.nonce, proposed.expiresAt);
          if (existing?.state === "pending" && existing.proposalNonce !== proposed.nonce) {
            this.rememberPending(manifest, existing.publicKey, existing.proposalNonce!, existing.expiresAt!);
            this.cancelPending(manifest, existing.publicKey, existing.proposalNonce!);
          }
          const pending: NetworkHost = { ...proposed.host, state: "pending", revoked: false, proposalNonce: proposed.nonce, expiresAt: proposed.expiresAt };
          if (existing) Object.assign(existing, pending); else manifest.hosts.push(pending);
          // Validate the reviewed devices now, without making a pending host or
          // any of its devices usable before the host's signed commit arrives.
          const checked = structuredClone(manifest), checkedHost = checked.hosts.find(host => host.publicKey === pending.publicKey)!;
          checkedHost.state = "active"; delete checkedHost.proposalNonce; delete checkedHost.expiresAt;
          this.publish(checked, proposed.host, proposed.devices);
          this.applyTombstones(state, manifest); this.next(state, manifest);
          state.admissions = this.memo(state.admissions, { nonce: proposed.nonce, digest, expiresAt: proposed.expiresAt });
        }
      } else if (command.operation === "join") {
        if (state.imported[session.deviceId]) throw new HubError("network_local_owner_required", 403);
        const signed = this.verifyMembership(command.membership), manifest = signed.manifest;
        const proposed = state.proposal?.proposal;
        if (!proposed) {
          if (!state.accepted || state.accepted.nonce !== command.nonce || state.accepted.networkId !== manifest.id || state.accepted.authorityKey !== manifest.authorityKey || state.membership?.manifest.id !== manifest.id) throw new HubError("network_proposal_missing", 409);
        } else {
          this.validDeadline(proposed.expiresAt);
          if (proposed.nonce !== command.nonce || proposed.networkId !== manifest.id || proposed.authorityKey !== manifest.authorityKey) throw new HubError("network_proposal_mismatch", 403);
          const own = manifest.hosts.find(host => host.publicKey === this.auth.publicKey);
          if (!own || own.revoked || own.state !== "pending" || own.proposalNonce !== proposed.nonce || own.expiresAt !== proposed.expiresAt || !same({ publicKey: own.publicKey, name: own.name, routes: own.routes, ...(own.protocol ? { protocol: own.protocol } : {}) }, proposed.host)) throw new HubError("network_proposal_mismatch", 403);
          if (state.retiredNetworks.includes(manifest.id)) throw new HubError("network_retired", 403);
          state.revokedMembers = [];
          state.membership = signed; state.accepted = { nonce: command.nonce, networkId: manifest.id, authorityKey: manifest.authorityKey };
          delete state.proposal; state.lastSyncedAt = this.now(); state.waiting = true;
          this.rememberTombstones(state, manifest);
        }
        if (state.membership!.manifest.hosts.find(host => host.publicKey === this.auth.publicKey)?.state === "pending") outgoing = { state: structuredClone(state), request: await this.request(state, name) };
      } else if (command.operation === "attest") {
        const manifest = this.active(state);
        if (manifest.authorityKey === this.auth.publicKey) {
          await this.refreshAuthority(state, name, revoked);
          const next = structuredClone(this.authority(state));
          this.attest(next, this.auth.publicKey, session.deviceId, command.device); this.applyTombstones(state, next); this.next(state, next);
          await this.materialize(state, revoked);
        } else outgoing = { state: structuredClone(state), request: await this.request(state, name, { sourceDeviceId: session.deviceId, device: command.device, statement, proof: proof! }) };
      } else if (command.operation === "remove") {
        const manifest = structuredClone(this.authority(state));
        if (command.publicKey === this.auth.publicKey) throw new HubError("network_cannot_remove_authority", 409);
        const host = manifest.hosts.find(item => item.publicKey === command.publicKey);
        if (!host) throw new HubError("network_host_missing", 404);
        if (manifest.v !== 2) throw new HubError("network_upgrade_required", 409);
        if (host.state !== command.expectedState) throw new HubError("network_host_state_changed", 409);
        if (host.state === "pending") throw new HubError("network_pending_requires_local_cancel", 409);
        host.revoked = true; this.applyTombstones(state, manifest); this.next(state, manifest); await this.cacheRemoval(state.membership!, host.publicKey); await this.materialize(state, revoked);
      } else {
        const own = state.membership?.manifest.hosts.find(host => host.publicKey === this.auth.publicKey);
        if (state.membership && state.membership.manifest.v !== 2) throw new HubError("network_upgrade_required", 409);
        if ((own?.state ?? "standalone") !== command.expectedState) throw new HubError("network_host_state_changed", 409);
        if (own?.state === "pending" && this.pendingExchanges) throw new HubError("network_join_in_progress", 409);
        if (state.imported[session.deviceId]) throw new HubError("network_local_owner_required", 403);
        if (state.membership?.manifest.authorityKey === this.auth.publicKey && state.membership.manifest.hosts.some(host => host.publicKey !== this.auth.publicKey && !host.revoked && (host.state === "active" || host.expiresAt! > this.now()))) throw new HubError("network_authority_has_peers", 409);
        if (own?.state === "active" && state.membership!.manifest.authorityKey === this.auth.publicKey && !(await this.auth.localDesktopControllersInTransaction()).has(session.deviceId)) throw new HubError("network_local_desktop_required", 409);
        if (own?.state === "pending") outgoing = { state: structuredClone(state), request: await this.request(state, name, undefined, "cancel") };
        else if (own?.state === "active" && !own.revoked && state.membership!.manifest.authorityKey !== this.auth.publicKey) outgoing = { state: structuredClone(state), request: await this.request(state, name, undefined, "retire") };
        else { departure = own?.revoked ? state.membership : undefined; await this.leave(state, revoked); }

      }
      if (outgoing) {
        const row = await this.auth.validateSessionInTransaction(session), manifest = state.membership!.manifest;
        state.intents = Object.fromEntries(Object.entries(state.intents).filter(([, value]) => value.expiresAt > this.now()));
        if (Object.keys(state.intents).length >= 64) throw new HubError("network_request_limit", 429);
        intentNonce = statement.nonce;
        state.intents[intentNonce] = { networkId: manifest.id, authorityKey: manifest.authorityKey, deviceId: session.deviceId, devicePublicKey: row.public_key,
          memberId: manifest.devices.find(binding => binding.host === this.auth.publicKey && binding.id === session.deviceId)?.memberId ?? networkMemberId(this.auth.publicKey, session.deviceId), commandHash, expiresAt: statement.expiresAt };
      }
      await this.save(state);
      return { view: this.asView(state, name), ...(proposal ? { proposal } : {}), ...(state.membership || departure ? { membership: state.membership ?? departure } : {}) };
    });
    this.auth.notifyRevokedDevices(revoked);
    if (!outgoing) return result;
    const returned = await this.exchange(outgoing.state, outgoing.request);
    const afterRevoked: string[] = []; let denied = false;
    const final = await this.store.db.transaction(async () => {
      this.checkOpen(); const row = await this.auth.validateSessionInTransaction(session); await this.store.requireOwner(session.userId);
      const state = await this.load(), manifest = command.operation === "leave" ? state.membership?.manifest : this.active(state, true), intent = state.intents[intentNonce!];
      if (!manifest) throw new HubError("network_not_joined", 409);
      if (!intent || intent.expiresAt <= this.now() || intent.deviceId !== session.deviceId || intent.devicePublicKey !== row.public_key || intent.networkId !== manifest.id || intent.authorityKey !== manifest.authorityKey || intent.commandHash !== hashSecret(networkCanonical(command))) throw new HubError("network_intent_expired", 403);
      if (command.operation === "leave") {
        const own = returned.manifest.hosts.find(host => host.publicKey === this.auth.publicKey);
        const cancelled = command.expectedState === "pending" && own?.state === "pending" && own.proposalNonce === outgoing!.request.request.cancel
          && own.expiresAt === 1 && returned.manifest.cancelledProposals?.some(item => item.host === own.publicKey && item.nonce === own.proposalNonce);
        const retired = command.expectedState === "active" && own?.revoked;
        if (!(cancelled || retired) || returned.manifest.id !== manifest.id || returned.manifest.authorityKey !== manifest.authorityKey) throw new HubError("network_host_state_changed", 409);
        await this.leave(state, afterRevoked);
      } else {
        await this.importMembership(state, returned, afterRevoked);
        const binding = state.membership!.manifest.devices.find(device => device.host === this.auth.publicKey && device.id === session.deviceId);
        denied = !binding || binding.revoked || binding.memberId !== intent.memberId || !!(await this.store.db.get<Device>("SELECT * FROM devices WHERE id=?", [session.deviceId]))?.revoked;
      }
      delete state.intents[intentNonce!];
      await this.save(state);
      return { view: this.asView(state, name), ...(state.membership ? { membership: state.membership } : command.operation === "leave" && command.expectedState === "active" ? { membership: returned } : {}) };
    });
    this.auth.notifyRevokedDevices(afterRevoked);
    if (denied) throw new HubError("device_revoked", 401);
    return final;
  }
  /** A removal is applied once. A later local pairing is a new grant and must
   * survive re-reading the same receipt or clearing the removed network. */
  private async retireLocalAccess(state: NetworkState, network: string, revoked: string[]): Promise<void> {
    if (state.retiredAccessNetworks.includes(network)) return;
    const trusted = await this.auth.localDesktopControllersInTransaction();
    const rows = await this.store.db.all<Device>("SELECT * FROM devices WHERE revoked=0");
    for (const row of rows) if (trusted.get(row.id) !== row.public_key) await this.revokeRow(row.id, revoked);
    await this.store.db.run("DELETE FROM pairing_requests WHERE status='pending'");
    state.retiredAccessNetworks.push(network);
  }
  private requireDepartureReady(manifest: NetworkManifest, departing: string): void {
    const remaining = new Set(manifest.hosts.filter(host => host.publicKey !== departing && host.state === "active" && !host.revoked).map(host => host.publicKey));
    if (!remaining.size) return; // Explicitly dissolving a singleton network.
    const continued = new Set(manifest.devices.filter(device => !device.revoked && remaining.has(device.host)).map(device => device.memberId));
    for (const device of manifest.devices) if (device.host === departing && !device.revoked && (device.scope === undefined || device.scope === "network" && !continued.has(device.memberId))) throw new HubError("network_devices_not_ready", 409);
  }
  private async leave(state: NetworkState, revoked: string[]): Promise<void> {
    if (state.membership && state.membership.manifest.hosts.find(host => host.publicKey === this.auth.publicKey)?.state === "active") {
      await this.retireLocalAccess(state, state.membership.manifest.id, revoked);
      state.retiredNetworks = [...new Set([...state.retiredNetworks, state.membership.manifest.id])];
    }
    delete state.membership; delete state.proposal; delete state.accepted; state.revokedMembers = []; state.admissions = []; state.peers = []; state.proofs = []; state.intents = {}; state.lastSyncedAt = 0; state.waiting = false;
  }
  private rememberPending(manifest: NetworkManifest, host: string, nonce: string, expiresAt: number): void {
    manifest.pendingProposals ??= [];
    const prior = manifest.pendingProposals.find(item => item.host === host && item.nonce === nonce);
    if (!prior) manifest.pendingProposals.push({ host, nonce, expiresAt });
    else if (expiresAt !== 1 && prior.expiresAt !== expiresAt) throw new HubError("network_proposal_mismatch", 409);
  }
  private cancelPending(manifest: NetworkManifest, host: string, nonce: string): void {
    manifest.cancelledProposals ??= [];
    if (!manifest.cancelledProposals.some(item => item.host === host && item.nonce === nonce)) manifest.cancelledProposals.push({ host, nonce });
  }
  private validDeadline(expiresAt: number) {
    if (expiresAt <= this.now() || expiresAt > this.now() + REQUEST_MS + 60_000) throw new HubError("network_request_expired", 403);
  }
  private memo(items: NetworkState["peers"], item: NetworkState["peers"][number]) {
    const next = items.filter(value => value.expiresAt > this.now());
    // 32 hosts polling every five seconds need nearly 2,000 live peer nonces.
    if (next.length >= 4096) throw new HubError("network_request_limit", 429);
    return [...next, item];
  }
  private removalKey(network: string, host: string): string { return `private-network:removed:${network}:${hashSecret(host)}`; }
  private async cacheRemoval(signed: SignedNetworkManifest, host: string): Promise<void> {
    await this.store.db.run("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)", [this.removalKey(signed.manifest.id, host), JSON.stringify(signed)]);
  }
  private async removedResponse(current: SignedNetworkManifest, host: string, known?: SignedNetworkManifest): Promise<SignedNetworkManifest> {
    const row = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [this.removalKey(current.manifest.id, host)]);
    const cached = row ? this.verifyMembership(JSON.parse(row.value)) : undefined;
    if (cached && cached.manifest.revision >= (known?.manifest.revision ?? 0)) return cached;
    if (!known || !known.manifest.hosts.some(item => item.publicKey === host)) throw new HubError("network_host_removed", 403);
    // After restoring a root, the historical receipt may be missing or older
    // than the peer's branch. Only reveal rows this peer already demonstrably
    // knew, plus their current revocations. Never reveal newly joined members.
    const safe = structuredClone(known.manifest), present = current.manifest;
    if (present.v === 2) { safe.v = 2; for (const item of safe.hosts) if (!item.revoked && item.state === "active") item.protocol = 2; }
    const hostMap = new Map(present.hosts.map(item => [item.publicKey, item]));
    const deviceMap = new Map(present.devices.map(item => [networkBindingKey(item.host, item.id), item]));
    const members = new Set(safe.devices.map(item => item.memberId)), keys = new Set(safe.devices.map(item => hashSecret(item.publicKey)));
    const slots = new Set(safe.devices.map(item => networkBindingKey(item.host, item.id)));
    safe.revokedMembers = [...new Set([...safe.revokedMembers, ...present.revokedMembers.filter(id => members.has(id))])].sort();
    safe.blockedKeys = [...new Set([...(safe.blockedKeys ?? []), ...(present.blockedKeys ?? []).filter(key => keys.has(key))])].sort();
    const blocked = new Map([...safe.blockedBindings, ...present.blockedBindings.filter(item => slots.has(networkBindingKey(item.host, item.id)))].map(item => [networkBindingKey(item.host, item.id), item]));
    safe.blockedBindings = [...blocked.values()];
    for (const item of safe.hosts) if (hostMap.get(item.publicKey)?.revoked) item.revoked = true;
    const removed = new Set(safe.hosts.filter(item => item.revoked).map(item => item.publicKey)), revokedMembers = new Set(safe.revokedMembers), blockedKeys = new Set(safe.blockedKeys);
    for (const item of safe.devices) { const currentScope = deviceMap.get(networkBindingKey(item.host, item.id))?.scope; if (!item.scope && currentScope) item.scope = currentScope; }
    for (const item of safe.devices) if (deviceMap.get(networkBindingKey(item.host, item.id))?.revoked || revokedMembers.has(item.memberId)
      || networkDeviceRetiredByHosts(item, removed) || blocked.has(networkBindingKey(item.host, item.id)) || blockedKeys.has(hashSecret(item.publicKey))) item.revoked = true;
    safe.revision = Math.max(safe.revision, present.revision);
    return this.sign(safe);
  }
  private forwardedProof(state: NetworkState, manifest: NetworkManifest, request: NetworkPeerRequest): void {
    const { sourceDeviceId, device, statement, proof } = request.attest!;
    const source = manifest.devices.find(binding => binding.host === request.publicKey && binding.id === sourceDeviceId && !binding.revoked);
    const target = hashSecret(networkCanonical({ operation: "attest", networkId: manifest.id, device }));
    if (!source || statement.hubPublicKey !== request.publicKey || statement.deviceId !== sourceDeviceId || statement.action.operation !== "network"
      || statement.action.target !== target || statement.targetDigest !== target || proof.nonce !== statement.nonce
      || statement.hubPublicKey.length !== 60 || statement.sessionHash.length !== 64 || statement.nonce.length !== 43 || proof.signature.length !== 88
      || statement.expiresAt <= this.now() || statement.expiresAt > this.now() + 90_000
      || !verify(null, Buffer.from(deviceActionProofText(statement)), parsePublicKey(source.publicKey), Buffer.from(proof.signature, "base64"))) throw new HubError("network_source_proof_invalid", 403);
    const nonce = networkBindingKey(request.publicKey, statement.nonce);
    if (state.proofs.some(item => item.nonce === nonce)) throw new HubError("network_request_replayed", 403);
    state.proofs = this.memo(state.proofs, { nonce, digest: hashSecret(networkCanonical(request.attest)), expiresAt: statement.expiresAt });
  }
  async peer(raw: unknown, _source: string): Promise<SignedNetworkManifest> {
    this.checkOpen();
    const signed = signedNetworkPeerRequestSchema.parse(raw), request = signed.request, { name } = await this.profile.read(), revoked: string[] = [];
    if (!same(signed, raw)) throw new HubError("network_noncanonical", 400);
    this.validDeadline(request.expiresAt);
    if (request.host.publicKey !== request.publicKey || !verify(null, Buffer.from(networkPeerProof(request)), parsePublicKey(request.publicKey), Buffer.from(signed.signature, "base64"))) throw new HubError("network_signature_invalid", 403);
    const result = await this.store.db.transaction(async () => {
      this.checkOpen(); this.validDeadline(request.expiresAt);
      const state = await this.load(); let manifest = structuredClone(this.authority(state)), sameRevisionFork = false;
      let known: SignedNetworkManifest | undefined;
      if (request.networkId !== manifest.id) throw new HubError("network_identity_mismatch", 403);
      if (request.known) {
        known = this.verifyMembership(request.known);
        if (known.manifest.id !== manifest.id || known.manifest.authorityKey !== this.auth.publicKey) throw new HubError("network_identity_mismatch", 403);
        sameRevisionFork = known.manifest.revision === manifest.revision && !same(known.manifest, manifest);
        if (!same(known.manifest, manifest)) manifest = this.reconcile(manifest, known.manifest);
      }
      this.applyTombstones(state, manifest);
      const issuer = manifest.hosts.find(host => host.publicKey === request.publicKey);
      if (!issuer) throw new HubError("network_host_removed", 403);
      if (issuer.revoked) {
        this.next(state, manifest, sameRevisionFork); await this.materialize(state, revoked); await this.save(state);
        return this.removedResponse(state.membership!, issuer.publicKey, known);
      }
      if (manifest.v === 2 && request.host.protocol !== 2) throw new HubError("network_upgrade_required", 409);
      const digest = hashSecret(networkCanonical(signed)), replayKey = networkBindingKey(request.publicKey, request.nonce), prior = state.peers.find(item => item.nonce === replayKey);
      if (prior) {
        if (prior.digest !== digest) throw new HubError("network_request_replayed", 403);
        return state.membership!;
      }
      // Device IDs are scoped to the signing Hub. Revoked bindings cannot be
      // presented as a new origin or used to revive their member.
      for (const id of request.revoked) {
        const binding = manifest.devices.find(device => device.host === request.publicKey && device.id === id);
        if (!binding) throw new HubError("network_revocation_invalid", 403);
        state.revokedMembers = [...new Set([...state.revokedMembers, binding.memberId])];
      }
      this.upgradeProtocol(state, manifest, request.host);
      if (request.retire) {
        if (manifest.v !== 2 || request.host.protocol !== 2) throw new HubError("network_upgrade_required", 409);
        if (issuer.publicKey === manifest.authorityKey || issuer.state !== "active") throw new HubError("network_host_state_changed", 409);
        this.publish(manifest, request.host, request.devices);
        this.applyTombstones(state, manifest);
        this.requireDepartureReady(manifest, issuer.publicKey);
        issuer.revoked = true; this.applyTombstones(state, manifest); this.next(state, manifest, sameRevisionFork);
        await this.cacheRemoval(state.membership!, issuer.publicKey); await this.materialize(state, revoked);
        state.peers = this.memo(state.peers, { nonce: replayKey, digest, expiresAt: request.expiresAt });
        await this.save(state); return state.membership!;
      }
      if (request.cancel) {
        if (issuer.state !== "pending" || issuer.proposalNonce !== request.cancel) throw new HubError("network_host_state_changed", 409);
        this.rememberPending(manifest, issuer.publicKey, issuer.proposalNonce!, issuer.expiresAt!);
        this.cancelPending(manifest, issuer.publicKey, issuer.proposalNonce!); issuer.expiresAt = 1;
        this.next(state, manifest, sameRevisionFork);
        state.peers = this.memo(state.peers, { nonce: replayKey, digest, expiresAt: request.expiresAt });
        await this.save(state); return state.membership!;
      }
      if (issuer.state === "pending") {
        if (!request.commit || request.commit !== issuer.proposalNonce || issuer.expiresAt! <= this.now() || manifest.cancelledProposals?.some(item => item.host === issuer.publicKey && item.nonce === request.commit) || request.attest
          || !same(request.host, { publicKey: issuer.publicKey, name: issuer.name, routes: issuer.routes, ...(issuer.protocol ? { protocol: issuer.protocol } : {}) })) throw new HubError("network_commit_invalid", 403);
        this.rememberPending(manifest, issuer.publicKey, issuer.proposalNonce!, issuer.expiresAt!);
        issuer.state = "active"; delete issuer.proposalNonce; delete issuer.expiresAt;
      }
      this.publish(manifest, request.host, request.devices);
      await this.localRevocations(state);
      this.publish(manifest, this.descriptor(state, name), await this.originals(state, manifest));
      this.applyTombstones(state, manifest);
      if (request.attest) { this.forwardedProof(state, manifest, request); this.attest(manifest, request.publicKey, request.attest.sourceDeviceId, request.attest.device); }
      this.next(state, manifest, sameRevisionFork); await this.materialize(state, revoked);
      state.peers = this.memo(state.peers, { nonce: replayKey, digest, expiresAt: request.expiresAt });
      await this.save(state); return state.membership!;
    });
    this.auth.notifyRevokedDevices(revoked); return result;
  }
  async enroll(raw: unknown): Promise<NetworkView> {
    this.checkOpen(); const signed = this.verifyMembership(raw), { name } = await this.profile.read(), revoked: string[] = [];
    const result = await this.store.db.transaction(async () => {
      this.checkOpen(); const state = await this.load(), current = state.membership?.manifest;
      if (!current || current.id !== signed.manifest.id || current.authorityKey !== signed.manifest.authorityKey) throw new HubError("network_identity_mismatch", 403);
      if (current.authorityKey === this.auth.publicKey) {
        // Public, root-signed backups may repair a restored authority, but may
        // never erase a tombstone or addition already recorded locally.
        if (!same(current, signed.manifest)) {
          const merged = this.reconcile(current, signed.manifest);
          this.applyTombstones(state, merged); this.next(state, merged, signed.manifest.revision === current.revision);
          await this.materialize(state, revoked);
        }
      } else await this.importMembership(state, signed, revoked);
      await this.save(state);
      // This public endpoint acknowledges the submitted signed directory. It
      // must not reveal members learned since that snapshot. Current host
      // status still fences replacement of a removed target; authorized view
      // and signed peer synchronization expose the complete current directory.
      return { ...this.asView(state, name), membership: signed };
    });
    this.auth.notifyRevokedDevices(revoked); return result;
  }
  tick(): Promise<void> {
    if (this.closed || this.commandsPending) return Promise.resolve();
    if (!this.ticking) this.ticking = this.synchronize().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async synchronize(): Promise<void> {
    const { name } = await this.profile.read(), revoked: string[] = [];
    let outgoing: { state: NetworkState; request: SignedNetworkPeerRequest } | undefined;
    try {
      await this.store.db.transaction(async () => {
        this.checkOpen(); const state = await this.load();
        if (!state.membership || state.membership.manifest.hosts.find(host => host.publicKey === this.auth.publicKey)?.revoked) return;
        if (state.membership.manifest.authorityKey === this.auth.publicKey) await this.refreshAuthority(state, name, revoked);
        else outgoing = { state: structuredClone(state), request: await this.request(state, name) };
        await this.save(state);
      });
      this.auth.notifyRevokedDevices(revoked);
      if (!outgoing) return;
      const signed = await this.exchange(outgoing.state, outgoing.request), incomingRevoked: string[] = [];
      await this.store.db.transaction(async () => {
        this.checkOpen(); const state = await this.load();
        if (!state.membership || state.membership.manifest.id !== outgoing!.state.membership!.manifest.id) return;
        await this.importMembership(state, signed, incomingRevoked); await this.save(state);
      });
      this.auth.notifyRevokedDevices(incomingRevoked);
    } catch (error) {
      if (this.closed) return;
      await this.store.db.transaction(async () => {
        const state = await this.load();
        if (state.membership && (!outgoing || state.membership.manifest.id === outgoing.state.membership!.manifest.id)) { state.waiting = true; await this.save(state); }
      });
    }
  }
  close(): void { this.closed = true; }
}
