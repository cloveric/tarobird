import { anySignal, timeoutSignal } from "./abort-signals.js";
import { MAX_NETWORK_BYTES, networkCanonical, networkViewSchema, type NetworkHost, type SignedNetworkManifest } from "../../src/client-protocol/private-network.js";
import type { HostConnections } from "./host-connections.js";
import { HostRegistry, runtimeHostId } from "./host-registry.js";
import { createIdentity } from "./identity.js";
import { verifyNetworkMembership } from "./network-identity.js";
import { hubFetch } from "./transport.js";
import { rememberRouteTrust } from "./route-trust.js";
import { orderedRoutes, type Route } from "../../src/client-protocol/routes.js";
import { HOST_ROUTES_PATH, hostRoutesOf, hostRoutesViewSchema } from "../../src/client-protocol/host-routes.js";
import type { HubConnection, RouteSyncSource } from "./connection.js";
import type { ConnectedHost } from "./host-connections.js";
import { mergeHostRoutes } from "./host-route-sync.js";

/** Self-route reads ride the existing visible-only loop: on connect, on
 * visibility, then at most every 10 minutes per registration. */
const HOST_ROUTES_REFRESH_MS = 10 * 60_000;
const HOST_ROUTES_MIN_INTERVAL_MS = 30_000;

async function readNetworkReply(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("network_replacement_unconfirmed");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_NETWORK_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("network_response_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** App-owned discovery. A hidden workspace or selected conversation cannot
 * cancel another host's enrollment; disposal still fences every continuation. */
export class NetworkSync {
  private stopped = false;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private availability = "";
  private wake = false;
  private readonly selfRoutes = new Map<string, { connection: HubConnection; at: number; online: boolean; routes: string }>();
  private readonly visible = () => { if (document.visibilityState !== "hidden") void this.refresh(); };
  private readonly shown = () => { if (document.visibilityState !== "hidden") { this.wake = true; void this.refresh(); } };
  private readonly controller = new AbortController();
  private readonly pushed = new Map<string,string>();
  constructor(private readonly pool: HostConnections, private readonly registry: HostRegistry) {}
  start(): void {
    const changed = () => {
      const signature = this.pool.state.hosts.map(entry => `${entry.host.registrationId}:${entry.connection?.state.status}:${entry.connection?.state.networkAvailable}`).join("|");
      if (signature === this.availability) return;
      this.availability = signature; void this.refresh();
    };
    this.unsubscribe = this.pool.subscribe(changed);
    document.addEventListener("visibilitychange", this.shown);
    this.timer = setInterval(this.visible, 4000); changed();
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.running ??= this.sync().catch(() => undefined).finally(() => { this.running = undefined; });
  }
  private current(connection: HubConnection): boolean {
    return !this.stopped && !connection.isClosed && this.pool.state.hosts.some(entry => entry.connection === connection && entry.host.state === "ready");
  }
  private async sync(): Promise<void> {
    const entries = [...this.pool.state.hosts];
    const registrations = new Set(entries.map(entry => entry.host.registrationId));
    for (const id of this.selfRoutes.keys()) if (!registrations.has(id)) this.selfRoutes.delete(id);
    const wake = this.wake; this.wake = false;
    // A successful leave can revoke its own controller before HTTP settles.
    // Its authority-signed receipt remains valid even when that connection is
    // now standalone/closed; apply it before any ordinary discovery requests.
    for (const entry of entries) if (entry.connection?.networkDeparture) await this.fence(entry.connection.networkDeparture);
    const hostRoutes = Promise.allSettled(entries.map(entry => this.syncHostRoutes(entry, wake)));
    try { await this.discoverNetworks(entries); } finally { await hostRoutes; }
  }
  private async discoverNetworks(entries: ConnectedHost[]): Promise<void> {
    const available: { connection: HubConnection; membership: SignedNetworkManifest }[] = [];
    await Promise.allSettled(entries.map(async entry => {
      const connection = entry.connection;
      if (!connection || !this.current(connection) || connection.state.status !== "online" || !connection.state.networkAvailable || connection.state.user?.role !== "owner") return;
      let view = connection.state.network;
      try { view = await connection.refreshNetwork(); } catch { /* Retain the last verified directory to repair a restored peer. */ }
      if (!this.current(connection)) return;
      if (!view && connection.networkKnown) view = {host:connection.networkKnown.manifest.hosts.find(h => h.publicKey === entry.host.publicKey)!,membership:connection.networkKnown,sync:"waiting",lastSyncedAt:0};
      if (!view || connection.state.networkChange) return;
      if (connection.state.hostProfile) await this.registry.cacheHostProfile(entry.host.id, entry.host.registrationId, connection.state.hostProfile);
      if (!this.current(connection)) return;
      if (!view.membership) {
        if (connection.networkDeparture) await this.fence(connection.networkDeparture);
        // A remote departure must retain its old registration's network scope
        // until revoked/removed. Clearing it here could race the leave receipt
        // and make the old direct pairing evade the revocation fence.
        if (view.sync === "standalone" && (entry.host.publicKey === this.pool.localHostKey || !entry.host.networkId)) await this.registry.clearNetworkMetadata(entry.host.id);
        return;
      }
      const m = verifyNetworkMembership(view.membership, entry.host.publicKey).manifest;
      await this.fence(view.membership);
      if (!m.hosts.some(host => host.publicKey === entry.host.publicKey && !host.revoked && host.state === "active")
        || !m.devices.some(device => device.host === entry.host.publicKey && device.id === connection.identity.deviceId && device.publicKey === connection.identity.publicKey && !device.revoked)) return;
      await this.registry.networkMetadata(entry.host.id, m.id, m.authorityKey, undefined, undefined, entry.host.registrationId);
      if (this.current(connection)) available.push({ connection, membership: view.membership });
    }));
    // Prefer the newest signed directory. An older peer must never re-introduce
    // a member revoked in the copy already delivered by another connection.
    const networks = new Map<string, { connection: HubConnection; membership: SignedNetworkManifest }>();
    for (const value of available) {
      const key = `${value.membership.manifest.authorityKey}:${value.membership.manifest.id}`, old = networks.get(key);
      if (!old || old.membership.manifest.revision < value.membership.manifest.revision) networks.set(key, value);
    }
    for (const { connection, membership } of networks.values()) {
      if (!this.current(connection)) continue;
      // Fence revoked destinations before any outbound request can stall.
      try { await this.fence(membership); } catch { continue; }
      const queue = [...membership.manifest.hosts];
      const work = async () => { for (let host = queue.shift(); host; host = queue.shift()) {
        if (!this.current(connection)) return;
        const existing = this.pool.state.hosts.find(entry => entry.host.publicKey === host.publicKey && entry.host.networkId === membership.manifest.id);
        if (existing?.connection) {
          const known = existing.connection.networkRemote;
          if (!known || known.manifest.revision < membership.manifest.revision || networkCanonical(known.manifest) !== networkCanonical(membership.manifest)) {
            await this.deliver(existing.connection, membership).catch(() => undefined);
          }
        }
        if (host.revoked) continue;
        if (host.state !== "active" || !host.routes.length || host.publicKey === connection.identity.hubPublicKey) continue;
        try { await this.discover(connection, membership, host); } catch { /* Pending identity is durable; retry when the host/authority recovers. */ }
      } };
      await Promise.allSettled(Array.from({length:Math.min(4, queue.length)}, () => work()));
    }
  }
  /** B2: a host's own extra routes reach its owner devices even when it is
   * standalone. Bound to the pinned, signed session and this registration;
   * never pairs, enrolls or attests. The desktop's local loopback host is skipped. */
  private async syncHostRoutes(entry: ConnectedHost, wake: boolean): Promise<void> {
    const connection = entry.connection, registrationId = entry.host.registrationId, now = Date.now();
    if (!connection || entry.host.publicKey === this.pool.localHostKey || typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const seen = this.selfRoutes.get(registrationId);
    if (!this.current(connection) || connection.isReadOnly || entry.host.networkBlocked || connection.state.status !== "online"
      || !connection.state.hostRoutesAvailable || connection.state.user?.role !== "owner") { if (seen) seen.online = false; return; }
    const configured = networkCanonical(connection.identity.routes);
    const due = !seen || seen.connection !== connection || !seen.online || seen.routes !== configured || wake || now - seen.at >= HOST_ROUTES_REFRESH_MS;
    if (!due || seen && seen.connection === connection && now - seen.at < HOST_ROUTES_MIN_INTERVAL_MS) return;
    const record = { connection, at: now, online: true, routes: configured };
    this.selfRoutes.set(registrationId, record);
    const current = () => this.current(connection) && !connection.isReadOnly && connection.state.status === "online" && connection.state.user?.role === "owner" && this.selfRoutes.get(registrationId) === record
      && this.pool.state.hosts.some(item => item.connection === connection && !item.host.networkBlocked && item.host.registrationId === registrationId && item.host.publicKey === connection.identity.hubPublicKey);
    try {
      const view = hostRoutesViewSchema.parse(await connection.http(HOST_ROUTES_PATH, { signal: anySignal([this.controller.signal, timeoutSignal(8000)]) }));
      if (!current()) return;
      if (view.hostPublicKey !== connection.identity.hubPublicKey || view.hostPublicKey !== entry.host.publicKey) throw new Error("host_routes_identity_mismatch");
      const theirs = hostRoutesOf(view);
      // An empty publication carries no evidence; it must not withdraw routes.
      if (!theirs.length) return;
      const host = (await this.registry.list()).find(item => item.id === entry.host.id && item.registrationId === registrationId);
      if (!host || host.state !== "ready" || !current()) return;
      const applied = await this.applyRoutes(connection, "host", host.hostRoutes?.base, theirs, current, (base, manual) => this.registry.saveHostRoutes(host.id, registrationId, base, Date.now(), manual), host.hostRoutes?.manual);
      if (applied && current()) record.routes = networkCanonical(applied);
    } catch (error) {
      // A concurrent route edit retries on the next eligible cycle; other
      // failures wait for reconnect, visibility or the slow refresh. No write is replayed.
      if (error instanceof Error && error.message === "routes_changed") record.online = false;
    }
  }
  /** Identity first (compare-and-swap against the exact array merged from),
   * then provenance. A concurrent edit wins; the next cycle merges again. */
  private async applyRoutes(connection: HubConnection, source: RouteSyncSource, base: Route[] | undefined, theirs: Route[], current: () => boolean, remember: (base: Route[], manual: string[]) => Promise<unknown>, manual?: string[]): Promise<Route[] | undefined> {
    const ours = connection.identity.routes;
    const identity = { hubPublicKey: connection.identity.hubPublicKey, deviceId: connection.identity.deviceId, publicKey: connection.identity.publicKey };
    const merge = mergeHostRoutes({ ours, base, manual, theirs, active: connection.state.route?.url, deployment: connection.identity.deployment });
    if (!current()) return;
    if (merge.changed) await connection.updateRoutes(merge.routes, { expected: ours, deployment: merge.deployment, reason: "host-sync" });
    if (!current()) return;
    if (networkCanonical(merge.base) !== networkCanonical(base ?? []) || networkCanonical(merge.manual) !== networkCanonical(manual ?? [])) await remember(merge.base, merge.manual);
    if (!current()) return;
    connection.recordRouteSyncResult(source, { ...identity, routes: merge.routes }, merge.limited);
    return merge.routes;
  }
  private async fence(value: SignedNetworkManifest): Promise<void> {
    const membership = verifyNetworkMembership(value), m = membership.manifest;
    await Promise.all(this.pool.state.hosts.map(async entry => {
      if (entry.host.publicKey === this.pool.localHostKey || entry.host.networkId !== m.id || entry.host.networkAuthority !== m.authorityKey) return;
      const destination = m.hosts.find(host => host.publicKey === entry.host.publicKey);
      const device = m.devices.find(device => device.host === entry.host.publicKey && device.id === entry.host.deviceId && (!entry.connection || device.publicKey === entry.connection.identity.publicKey));
      if (!destination?.revoked && !device?.revoked) return;
      entry.connection?.suspendNetwork();
      await this.registry.blockNetworkHost(entry.host.id, m.id, entry.host.registrationId);
      if (entry.connection) await entry.connection.cache.saveNetworkMembership(entry.connection.identity, membership).catch(() => undefined);
    }));
  }
  private async deliver(target: HubConnection, membership: SignedNetworkManifest): Promise<boolean> {
    const entry = this.pool.state.hosts.find(e => e.connection === target);
    if (!entry || this.stopped) return false;
    const stamp = networkCanonical(membership.manifest);
    if (this.pushed.get(entry.host.registrationId) === stamp && target.networkRemote && networkCanonical(target.networkRemote.manifest) === stamp) return true;
    for (const route of orderedRoutes(target.identity.routes)) {
      if (this.stopped || !this.pool.state.hosts.some(e => e.host.registrationId === entry.host.registrationId)) return false;
      try {
        const response = await hubFetch(route.url, "/api/network/enroll", target.identity.hubPublicKey, {method:"POST", body:JSON.stringify(membership), signal:anySignal([this.controller.signal, timeoutSignal(2500)])});
        if (response.ok) { this.pushed.set(entry.host.registrationId, stamp); return true; }
      } catch { /* Retain the signed directory until a route is available. */ }
    }
    return false;
  }
  private async discover(source: HubConnection, membership: SignedNetworkManifest, host: NetworkHost): Promise<void> {
    const m = membership.manifest, existing = this.pool.state.hosts.find(entry => entry.host.publicKey === host.publicKey);
    const current = () => {
      if (!this.current(source) || source.state.networkChange) return false;
      const views = [source.state.network?.membership, source.networkKnown].filter((view): view is SignedNetworkManifest => !!view);
      return views.length > 0 && views.every(view => view.manifest.id === m.id && view.manifest.authorityKey === m.authorityKey
        && view.manifest.hosts.some(member => member.publicKey === host.publicKey && member.state === "active" && !member.revoked));
    };
    if (!current() || existing?.host.state === "removing" || existing?.host.networkBlocked) return;
    // Per-route provenance: user-added or user-edited routes are kept, while
    // unmodified routes follow the signed descriptor. Extra local paths come
    // from the host's own endpoint once connected (syncHostRoutes).
    if (existing?.connection && existing.host.networkId === m.id && existing.host.state === "ready" && existing.host.publicKey !== this.pool.localHostKey) {
      const target = existing.connection, registrationId = existing.host.registrationId;
      const known = target.networkKnown, change = target.state.networkChange;
      const targetCurrent = () => current() && !target.isClosed && target.networkKnown === known && target.state.networkChange === change
        && this.pool.state.hosts.some(entry => entry.connection === target && entry.host.registrationId === registrationId
          && entry.host.networkId === m.id && entry.host.networkAuthority === m.authorityKey && !entry.host.networkBlocked);
      await this.applyRoutes(target, "network", existing.host.networkRoutes, host.routes, targetCurrent,
        (base, manual) => this.registry.networkMetadata(existing.host.id, m.id, m.authorityKey, base, manual, existing.host.registrationId), existing.host.networkManualRoutes).catch(() => undefined);
    }
    const confirmReplacement = async () => {
      rememberRouteTrust(host.routes, host.publicKey);
      for (const route of orderedRoutes(host.routes)) {
        if (!current()) throw new Error("network_enrollment_superseded");
        try {
          const response = await hubFetch(route.url, "/api/network/enroll", host.publicKey, {method:"POST",body:JSON.stringify(membership),signal:anySignal([this.controller.signal,timeoutSignal(2500)])});
          if (!response.ok) continue;
          const raw = await readNetworkReply(response) as {membership?:unknown} | null;
          // Verify the exact signed input before schema transforms normalize
          // names or routes; otherwise a noncanonical reply could be accepted.
          const confirmed = verifyNetworkMembership(raw?.membership, host.publicKey, {id:m.id,authorityKey:m.authorityKey});
          const view = networkViewSchema.parse(raw);
          if (view.host.publicKey !== host.publicKey || view.host.state !== "active" || view.host.revoked
            || !confirmed.manifest.hosts.some(member => member.publicKey === host.publicKey && member.state === "active" && !member.revoked)) continue;
          if (!current()) throw new Error("network_enrollment_superseded");
          return;
        } catch { /* Another pinned route can confirm the target's current network. */ }
      }
      throw new Error("network_replacement_unconfirmed");
    };
    const candidate = await this.registry.networkCandidate(m.id, m.authorityKey, host, async () => ({
      ...await createIdentity(source.identity.name, host.routes), hubPublicKey: host.publicKey,
    }), confirmReplacement);
    if (!candidate || !current()) return;
    let authorization = membership;
    const bound = m.devices.find(device => device.host === host.publicKey && device.id === candidate.identity.deviceId);
    if (bound && (bound.publicKey !== candidate.identity.publicKey || bound.revoked)) throw new Error("network_enrollment_conflict");
    if (!bound) {
      const result = await source.networkCommand({ operation: "attest", device: {
        id: candidate.identity.deviceId, host: host.publicKey, publicKey: candidate.identity.publicKey,
        name: candidate.identity.name, platform: candidate.identity.platform ?? "web",
      } });
      if (!current() || !result.membership) return;
      authorization = verifyNetworkMembership(result.membership, host.publicKey);
      if (authorization.manifest.id !== m.id || authorization.manifest.authorityKey !== m.authorityKey) throw new Error("network_membership_invalid");
    }
    if (!current()) return;
    const binding = authorization.manifest.devices.find(device => device.host === host.publicKey && device.id === candidate.identity.deviceId && device.publicKey === candidate.identity.publicKey && !device.revoked);
    if (!binding) throw new Error("network_enrollment_missing");
    if (!current()) return;
    // This endpoint discloses no directory and accepts only a root-signed grant
    // anchored to the target's committed network, then ordinary auth proves possession.
    rememberRouteTrust(host.routes, host.publicKey);
    let admitted = false;
    for (const route of orderedRoutes(host.routes)) {
      if (!current()) return;
      try {
        const response = await hubFetch(route.url, "/api/network/enroll", host.publicKey, { method: "POST", body: JSON.stringify(authorization), signal: anySignal([this.controller.signal, timeoutSignal(2500)]) });
        if (response.ok) { admitted = true; break; }
      } catch { /* Try the next pinned route. */ }
    }
    if (!admitted || !current()) return;
    if (!(await this.registry.list()).some(entry => entry.id === candidate.id)) {
      try { await this.registry.add(candidate.identity, host.name, { networkId: m.id, networkAuthority: m.authorityKey, networkRoutes: host.routes }); }
      catch (error) { if (!(await this.registry.list()).some(entry => entry.id === candidate.id && entry.deviceId === candidate.identity.deviceId)) throw error; }
    }
    await this.registry.finishNetworkCandidate(candidate);
    this.pool.connection(runtimeHostId(host.publicKey))?.resume(true);
  }
  close(): void { this.stopped = true; this.controller.abort(); document.removeEventListener("visibilitychange", this.shown); if (this.timer) clearInterval(this.timer); this.unsubscribe?.(); }
}
