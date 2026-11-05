import type { HubConnection } from "./connection.js";
import { HostRegistry, type RuntimeHost, type RuntimeHostHandle } from "./host-registry.js";
import type { NetworkSync } from "./network-sync.js";

export type ConnectedHost = { host: RuntimeHost; connection?: HubConnection; error?: string };
export function connectedHostName(entry: ConnectedHost): string {
  const saved = entry.host.hostProfile, live = entry.connection?.state.hostProfile;
  const profile = saved && (!live || saved.revision > live.revision) ? saved : live;
  return profile?.name ?? entry.host.name;
}
export function networkHostBlocked(entry: ConnectedHost, localHostKey = ""): boolean {
  return entry.host.publicKey !== localHostKey && (!!entry.host.networkBlocked || !!entry.connection?.isNetworkBlocked);
}
export type HostConnectionsState = { hosts: ConnectedHost[]; loading: boolean; error?: string };
type LiveHost = { handle: RuntimeHostHandle; connection: HubConnection; unsubscribe: () => void };

/** The application owns this pool. Selecting/filtering a conversation does not
 * start or close its transport. Every async callback retains its exact handle. */
export class HostConnections {
  state: HostConnectionsState = { hosts: [], loading: true };
  private readonly live = new Map<string, LiveHost>();
  private readonly listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private running = false;
  private revision = 0;
  private startup?: Promise<void>;
  private latestRefresh?: Promise<void>;
  private readonly failed = new Map<string, { registrationId: string; error: string }>();
  private network?: NetworkSync;
  localHostKey = "";
  localControllerPending = false;
  private lifetime = 0;
  constructor(readonly registry: HostRegistry) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(patch: Partial<HostConnectionsState> = {}): void {
    const next = { ...this.state, ...patch };
    this.state = { ...next, hosts: next.hosts.map(entry => {
      const name = connectedHostName(entry);
      return name === entry.host.name ? entry : { ...entry, host: { ...entry.host, name } };
    }) }; this.listeners.forEach((listener) => listener());
  }
  start(): Promise<void> {
    if (this.running) return this.startup ?? Promise.resolve();
    this.running = true; const lifetime = ++this.lifetime;
    this.unsubscribe = this.registry.subscribe(() => { void this.refresh(); });
    // Migration and native removal are explicit operations, not side effects of
    // opening a chat. Preparing/removing hosts remain visible but disconnected.
    this.startup = (async () => {
      await this.refresh(); let current: Promise<void> | undefined;
      do { current = this.latestRefresh; await current; } while (this.running && current !== this.latestRefresh);
      if (this.running) {
        const { NetworkSync } = await import("./network-sync.js");
        if (this.running && lifetime === this.lifetime) { this.network = new NetworkSync(this, this.registry); this.network.start(); }
      }
    })();
    return this.startup;
  }
  refresh(): Promise<void> { const work = this.refreshNow(); this.latestRefresh = work; return work; }
  private async refreshNow(): Promise<void> {
    if (!this.running) return;
    const revision = ++this.revision;
    try {
      const hosts = await this.registry.list(); if (!this.running || revision !== this.revision) return;
      for (const [id, live] of this.live) {
        if (!hosts.some((host) => host.id === id && host.state === "ready" && host.registrationId === live.handle.host.registrationId)
          || this.localControllerPending && live.handle.host.publicKey === this.localHostKey) {
          this.live.delete(id); live.unsubscribe(); live.connection.close(); live.handle.cache.close();
        }
        else if (hosts.some(host => host.id === id && host.networkBlocked && host.publicKey !== this.localHostKey) && !live.connection.isNetworkBlocked) live.connection.suspendNetwork();
      }
      for (const [id, failure] of this.failed) if (!hosts.some((host) => host.id === id && host.registrationId === failure.registrationId)) this.failed.delete(id);
      this.publish({ loading: false, error: undefined, hosts: hosts.map((host) => ({ host, connection: this.live.get(host.id)?.connection, error: this.failed.get(host.id)?.error })) });
      await Promise.all(hosts.filter((host) => host.state === "ready" && !this.live.has(host.id)
        && !(this.localControllerPending && host.publicKey === this.localHostKey)).map(async (host) => {
        let connection: HubConnection | undefined;
        let handle: RuntimeHostHandle | undefined;
        try {
          // Empty registries can render pairing without loading the chat
          // transport and its message/download dependencies.
          const { HubConnection } = await import("./connection.js");
          if (!this.running || revision !== this.revision) return;
          handle = await this.registry.open(host.id);
          if (!this.running || revision !== this.revision || handle.host.registrationId !== host.registrationId) { handle.cache.close(); return; }
          if (this.localControllerPending && host.publicKey === this.localHostKey) { handle.cache.close(); return; }
          connection = new HubConnection(handle.identity, handle.cache, () =>
            this.state.hosts.find(entry => entry.host.id === host.id && entry.host.registrationId === host.registrationId)?.host.name ?? host.name);
          if (host.networkId && host.networkAuthority) connection.pinNetwork(host.networkId, host.networkAuthority);
          if (host.networkBlocked && host.publicKey !== this.localHostKey) connection.suspendNetwork();
          let observedState = connection.state;
          const live = { handle, connection, unsubscribe: connection.subscribe(() => {
            const current = this.state.hosts.find(entry => entry.host.id === host.id && entry.host.registrationId === host.registrationId)?.host;
            if (connection!.isNetworkBlocked && current?.networkId && current.publicKey !== this.localHostKey) void this.registry.blockNetworkHost(host.id, current.networkId, host.registrationId).catch(() => undefined);
            const profile = connection!.state.hostProfile;
            if (profile && (!current?.hostProfile || current.hostProfile.revision < profile.revision)) void this.registry.cacheHostProfile(host.id, host.registrationId, profile).catch(() => undefined);
            // DirectoryObserver and each chat already subscribe to cache
            // revisions. Publishing the unchanged host pool as well made every
            // background token render every Workspace before its directory read.
            const next = connection!.state;
            const hostChanged = (Object.keys(next) as (keyof typeof next)[]).some(key => key !== "cacheRevision" && key !== "syncProgress" && !Object.is(next[key], observedState[key]));
            observedState = next;
            if (hostChanged) this.publish();
          }) };
          this.live.set(host.id, live);
          this.publish({ hosts: this.state.hosts.map((entry) => entry.host.id === host.id ? { ...entry, connection, error: undefined } : entry) });
          await connection.start();
          if (this.live.get(host.id)?.connection === connection) this.failed.delete(host.id);
        } catch (error) {
          const owns = connection && this.live.get(host.id)?.connection === connection;
          if (owns) { this.live.get(host.id)!.unsubscribe(); this.live.delete(host.id); connection!.close(); }
          handle?.cache.close();
          if (!this.running || !owns && revision !== this.revision || !this.state.hosts.some((entry) => entry.host.id === host.id && entry.host.registrationId === host.registrationId && entry.host.state === "ready")) return;
          const message = error instanceof Error ? error.message : "host_connection_failed";
          this.failed.set(host.id, { registrationId: host.registrationId, error: message });
          this.publish({ hosts: this.state.hosts.map((entry) => entry.host.id === host.id ? { ...entry, connection: undefined, error: message } : entry) });
        }
      }));
    } catch (error) {
      if (this.running && revision === this.revision) this.publish({ loading: false, error: error instanceof Error ? error.message : "host_directory_unavailable" });
    }
  }
  connection(id: string): HubConnection | undefined { return this.live.get(id)?.connection; }
  resume(): void { for (const { connection } of this.live.values()) connection.resume(); if (this.failed.size) void this.refresh(); }
  refreshNetwork(): Promise<void> { return this.network?.refresh() ?? Promise.resolve(); }
  close(): void {
    this.running = false; ++this.lifetime; ++this.revision; this.unsubscribe?.(); this.unsubscribe = undefined; this.startup = undefined;
    this.network?.close(); this.network = undefined;
    for (const { connection, unsubscribe, handle } of this.live.values()) { unsubscribe(); connection.close(); handle.cache.close(); }
    this.live.clear(); this.failed.clear(); this.publish({ hosts: [], loading: false });
  }
}
