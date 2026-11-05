import { adhdLegacyBoardSchema, adhdViewSchema, adhdBoardSchema, emptyAdhdBoard, type AdhdBoardState } from "./adhd-board-state.js";
import { deleteDB, openDB, type DBSchema } from "idb";
import { runtimeHostId } from "./runtime-host-id.js";
export { runtimeHostId } from "./runtime-host-id.js";
import { ClientCache, cache as legacyCache, defaultPreferences, type Identity, type Preferences } from "./storage.js";
import { type ResetStep } from "./local-reset.js";
import type { BrowserScope } from "./workbench-browser.js";
import type { NetworkHost } from "../../src/client-protocol/private-network.js";
import type { Route } from "./storage.js";
import { DEFAULT_MONO_ACCENT, DEFAULT_PALETTE, isColorPalette, isMonoAccent } from "./palettes.js";
import { normalizeLayoutDensity } from "./layout-density.js";
import { hostProfileSchema, type HostProfileState } from "../../src/client-protocol/host-profile.js";

export type RuntimeHost = {
  id: string;
  name: string;
  /** Last name acknowledged by this host, independent of the network directory. */
  hostProfile?: HostProfileState;
  publicKey: string;
  deviceId: string;
  keyRef?: string;
  databaseName: string;
  registrationId: string;
  createdAt: number;
  state: "preparing" | "ready" | "removing";
  networkId?: string;
  networkAuthority?: string;
  /** Signed-descriptor routes last applied by network discovery (merge base). */
  networkRoutes?: Route[];
  networkManualRoutes?: string[];
  /** Host-published routes last applied by self-route sync (merge base). */
  hostRoutes?: { base: Route[]; manual?: string[]; at: number };
  networkBlocked?: boolean;
  origin?: "paired" | "network";
};
export type NetworkCandidate = { id: string; networkId: string; authorityKey: string; host: NetworkHost; identity: Identity; replacing?: { networkId: string; authorityKey: string } };
function retiredCandidateKey(id: string, networkId: string, authorityKey: string): string { return `candidate-retired:${id}:${networkId}:${encodeURIComponent(authorityKey)}`; }
function sameCandidateIdentity(candidate: NetworkCandidate, identity: Identity, networkId: string, authorityKey: string): boolean {
  return !candidate.replacing && candidate.networkId === networkId && candidate.authorityKey === authorityKey
    && candidate.identity.deviceId === identity.deviceId && candidate.identity.publicKey === identity.publicKey
    && candidate.identity.keyRef === identity.keyRef && candidate.identity.hubPublicKey === identity.hubPublicKey;
}
type StoredHost = RuntimeHost & { pendingIdentity?: Identity; cleaned?: Partial<Record<ResetStep, true>>; cacheOwned?: boolean };
interface Registry extends DBSchema {
  hosts: { key: string; value: StoredHost };
  meta: { key: string; value: string };
  networkCandidates: { key: string; value: NetworkCandidate };
}
export type RuntimeHostHandle = { host: RuntimeHost; cache: ClientCache; identity: Identity };
export type HostRemovalBackend = {
  // These MUST be host-scoped. Global push/share cleanup is not suitable here.
  shared: (host: RuntimeHost) => Promise<void>;
  push: (host: RuntimeHost) => Promise<void>;
  browser: (host: RuntimeHost, scopes: BrowserScope[]) => Promise<void>;
  key: (keyRef: string) => Promise<void>;
};
function publicRecord({ pendingIdentity: _pendingIdentity, cleaned: _cleaned, cacheOwned: _cacheOwned, ...host }: StoredHost): RuntimeHost { return host; }
function hostName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 100) throw new Error("invalid_host_name");
  return name;
}

/** Durable host directory. Cross-database changes have recoverable states and
 * run under a lock per host, including across tabs. After reservation commits,
 * its staged identity keeps recovery from losing a pairing or OS key reference.
 * No private identity is returned by list() or emitted in change events. */
export class HostRegistry {
  private readonly db;
  private readonly channel?: BroadcastChannel;
  private readonly listeners = new Set<() => void>();
  constructor(readonly databaseName = "tarocub-hosts-v1") {
    this.db = openDB<Registry>(databaseName, 2, { upgrade(db, version) { if (version < 1) { db.createObjectStore("hosts", { keyPath: "id" }); db.createObjectStore("meta"); } if (version < 2) db.createObjectStore("networkCandidates", { keyPath: "id" }); }, blocking: () => this.close() });
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(`${databaseName}:changed`);
      this.channel.onmessage = () => this.listeners.forEach((listener) => listener());
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { this.channel?.postMessage("changed"); this.listeners.forEach((listener) => listener()); }
  private locked<T>(id: string, work: () => Promise<T>, mode: "shared" | "exclusive" = "exclusive"): Promise<T> {
    if (!navigator.locks) return Promise.reject(new Error("host_registry_lock_unavailable"));
    return navigator.locks.request(`${this.databaseName}:host:${id}`, { mode }, work);
  }
  async list(): Promise<RuntimeHost[]> {
    return (await (await this.db).getAll("hosts")).map(publicRecord).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async preferences(): Promise<Preferences> {
    const saved = await (await this.db).get("meta", "preferences");
    if (!saved) return legacyCache.preferences();
    const stored = JSON.parse(saved) as Partial<Preferences> | null;
    const preferences = { ...defaultPreferences, ...stored };
    // Retired palettes fall back without resetting the other device preferences.
    // Ignore an old disabled-animation choice after removing the App switch.
    return { ...preferences, palette: isColorPalette(stored?.palette) ? stored.palette : DEFAULT_PALETTE, monoAccent: isMonoAccent(stored?.monoAccent) ? stored.monoAccent : DEFAULT_MONO_ACCENT, animations: true, animatedAvatars: stored?.animatedAvatars !== false, linkPreviewStyle: stored?.linkPreviewStyle === "inline" ? "inline" : "card", layoutDensity: normalizeLayoutDensity(stored?.layoutDensity), sidebarGroupByHost: preferences.sidebarGroupByHost === true, showDisconnectedBots: preferences.showDisconnectedBots === true, showTicketConversations: preferences.showTicketConversations === true, sidebarLayout: preferences.sidebarLayout === "conversations" ? "conversations" : "bots" };
  }
  async savePreferences(value: Preferences): Promise<void> { await (await this.db).put("meta", JSON.stringify(value), "preferences"); }
  async adhdBoard(): Promise<AdhdBoardState> {
    const tx = (await this.db).transaction("meta", "readonly");
    const [saved, display] = await Promise.all([tx.store.get("adhd-board-v1"), tx.store.get("adhd-view-v1")]);
    await tx.done;
    const layout = saved === undefined ? emptyAdhdBoard() : adhdLegacyBoardSchema.parse(JSON.parse(saved));
    let view: { columns?: AdhdBoardState["columns"]; fontSize?: number } = {};
    if (display !== undefined) {
      try { view = adhdViewSchema.parse(JSON.parse(display)); }
      catch { /* Bad display preferences must not hide an intact conversation layout. */ }
    }
    // A rolled-back 1.0.86 App can edit the legacy columns without updating the
    // new record. Honor that edit, while retaining the independent text size.
    if (saved !== undefined && view.columns !== undefined && (view.columns <= 4 ? view.columns : 0) !== layout.columns) view = { ...view, columns: layout.columns };
    return adhdBoardSchema.parse({ ...layout, ...view });
  }
  async saveAdhdBoard(value: AdhdBoardState): Promise<void> {
    const next = adhdBoardSchema.parse(value);
    const layout = adhdLegacyBoardSchema.parse({ version: 1, columns: next.columns <= 4 ? next.columns : 0, panes: next.panes });
    const view = adhdViewSchema.parse({ version: 1, columns: next.columns, fontSize: next.fontSize });
    const tx = (await this.db).transaction("meta", "readwrite");
    const writes: Promise<unknown>[] = [tx.done];
    try {
      writes.push(tx.store.put(JSON.stringify(layout), "adhd-board-v1"));
      writes.push(tx.store.put(JSON.stringify(view), "adhd-view-v1"));
      await Promise.all(writes);
    } catch (error) {
      // Also abort synchronous IndexedDB failures, before either record commits.
      try { tx.abort(); } catch { /* already aborted */ }
      // A later put can throw before Promise.all attaches handlers to earlier
      // requests. Observe their abort rejections as well as the transaction's.
      await Promise.allSettled(writes);
      throw error;
    }
  }
  async migrationRepairHosts(): Promise<string[]> {
    const raw = await (await this.db).get("meta", "desktopMigrationRepair");
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every(id => typeof id === "string" && /^hub_[0-9a-f]{64}$/.test(id))) throw new Error("migration_repair_invalid");
    return value;
  }
  async selectedHost(): Promise<string | undefined> { return (await this.db).get("meta", "selectedHost"); }
  async selectHost(id: string): Promise<void> { await (await this.db).put("meta", id, "selectedHost"); }
  async nativeLocalHost(): Promise<string | undefined> {
    const key = await (await this.db).get("meta", "nativeLocalHost");
    if (key) runtimeHostId(key);
    return key;
  }
  /** Only the native desktop bootstrap may call this with its own Hub key. */
  async rememberNativeLocalHost(publicKey: string): Promise<void> {
    runtimeHostId(publicKey);
    await (await this.db).put("meta", publicKey, "nativeLocalHost");
  }
  private async finishSetup(record: StoredHost): Promise<RuntimeHost> {
    if ((await this.migrationRepairHosts()).includes(record.id)) throw new Error("host_cache_identity_mismatch");
    if (record.state !== "preparing" || !record.pendingIdentity) throw new Error("invalid_host_setup");
    const cache = new ClientCache(record.databaseName);
    try {
      await cache.initializeIdentity(record.pendingIdentity);
      const ready: RuntimeHost = { ...publicRecord(record), state: "ready" };
      const db = await this.db, tx = db.transaction(["hosts", "meta"], "readwrite");
      void tx.done.catch(() => undefined);
      await tx.objectStore("hosts").put(ready);
      if (record.databaseName === legacyCache.databaseName) await tx.objectStore("meta").put(JSON.stringify([record.publicKey, record.deviceId]), "legacyImported");
      await tx.done; this.changed(); return ready;
    } finally { cache.close(); }
  }
  /** A rejected duplicate remains caller-owned; the pairing UI must dispose its
   * unused native key. Once stored, an interrupted setup belongs to the registry.
   * No Hub access is granted here: signed authentication and approval still apply. */
  async add(identity: Identity, name: string, network?: { networkId: string; networkAuthority: string; networkRoutes: Route[] }): Promise<RuntimeHost> {
    if (!identity.hubPublicKey) throw new Error("missing_hub_public_key");
    const id = runtimeHostId(identity.hubPublicKey), label = hostName(name);
    return this.locked(id, async () => {
      const db = await this.db, existing = await db.get("hosts", id);
      if (existing) {
        if (existing.state === "preparing" && existing.deviceId === identity.deviceId && existing.pendingIdentity?.publicKey === identity.publicKey) return this.finishSetup(existing);
        throw new Error("host_already_registered");
      }
      if (network && await db.get("meta", `dismissed:${id}`) === network.networkId) throw new Error("network_host_dismissed");
      if (network) {
        const candidate = await db.get("networkCandidates", id);
        if (!candidate || !sameCandidateIdentity(candidate, identity, network.networkId, network.networkAuthority)
          || JSON.stringify(candidate.identity.routes) !== JSON.stringify(identity.routes)
          || JSON.stringify(candidate.host.routes) !== JSON.stringify(network.networkRoutes)) throw new Error("network_enrollment_superseded");
      }
      const legacy = await legacyCache.identity();
      if (legacy && legacy.hubPublicKey === identity.hubPublicKey && await db.get("meta", "legacyImported") !== JSON.stringify([legacy.hubPublicKey, legacy.deviceId])) throw new Error("legacy_host_requires_import");
      const registrationId = crypto.randomUUID();
      const record: StoredHost = { ...network, origin: network ? "network" : "paired", id, name: label, publicKey: identity.hubPublicKey!, deviceId: identity.deviceId, keyRef: identity.keyRef,
        databaseName: `tarocub-host-${id}-${registrationId}`, registrationId, createdAt: Date.now(), state: "preparing", pendingIdentity: identity };
      await db.put("hosts", record);
      if (!network) await db.delete("meta", `dismissed:${id}`);
      this.changed();
      return this.finishSetup(record);
    });
  }
  /** Register the old database in place. Conflicts are explicit: returning a
   * different database here would silently strand the user's old drafts/queue. */
  async importLegacy(name: string): Promise<RuntimeHost | undefined> {
    const label = hostName(name);
    return this.locked("legacy-import", async () => {
      if (await legacyCache.pendingReset()) return;
      const identity = await legacyCache.identity(); if (!identity?.hubPublicKey) return;
      const id = runtimeHostId(identity.hubPublicKey);
      return this.locked(id, async () => {
        const db = await this.db, existing = await db.get("hosts", id);
        if (existing) {
          if (existing.databaseName !== legacyCache.databaseName || existing.deviceId !== identity.deviceId) throw new Error("legacy_host_conflict");
          return publicRecord(existing);
        }
        if (await db.get("meta", "legacyImported") === JSON.stringify([identity.hubPublicKey, identity.deviceId])) return;
        const record: StoredHost = { origin: "paired", id, name: label, publicKey: identity.hubPublicKey!, deviceId: identity.deviceId, keyRef: identity.keyRef, databaseName: legacyCache.databaseName,
          registrationId: crypto.randomUUID(), createdAt: Date.now(), state: "preparing", pendingIdentity: identity };
        await db.put("hosts", record); this.changed(); return this.finishSetup(record);
      });
    });
  }
  async recoverPreparations(): Promise<{ id: string; error: string }[]> {
    const failures: { id: string; error: string }[] = [];
    await Promise.all((await this.list()).filter((record) => record.state === "preparing").map(async ({ id }) => {
      try {
        await this.locked(id, async () => { const current = await (await this.db).get("hosts", id); if (current?.state === "preparing") await this.finishSetup(current); });
      } catch (error) { failures.push({ id, error: error instanceof Error ? error.message : "host_setup_failed" }); }
    }));
    return failures;
  }
  async open(id: string): Promise<RuntimeHostHandle> {
    const read = async () => {
      const db = await this.db, record = await db.get("hosts", id);
      if (!record || record.state !== "ready") throw new Error("host_not_ready");
      if ((await this.migrationRepairHosts()).includes(id)) throw new Error("host_cache_identity_mismatch");
      const cache = new ClientCache(record.databaseName);
      try {
        const identity = await cache.identity();
        if (await cache.pendingReset()) throw new Error("host_removal_in_progress");
        if (!identity || identity.deviceId !== record.deviceId || identity.hubPublicKey !== record.publicKey || runtimeHostId(identity.hubPublicKey) !== record.id) throw new Error("host_cache_identity_mismatch");
        // Also protect read-only fallback on platforms without Web Locks.
        const current = await db.get("hosts", id);
        if (current?.state !== "ready" || current.registrationId !== record.registrationId) throw new Error("host_not_ready");
        return { host: publicRecord(record), cache, identity };
      } catch (error) { cache.close(); throw error; }
    };
    return navigator.locks ? this.locked(id, read, "shared") : read();
  }
  async rename(id: string, name: string): Promise<void> {
    const label = hostName(name);
    await this.locked(id, async () => {
      const db = await this.db, record = await db.get("hosts", id); if (!record || record.state !== "ready") throw new Error("host_not_ready");
      await db.put("hosts", { ...record, name: label }); this.changed();
    });
  }
  async cacheHostProfile(id: string, registrationId: string, value: HostProfileState): Promise<void> {
    const profile = hostProfileSchema.parse(value);
    await this.locked(id, async () => {
      const db = await this.db, record = await db.get("hosts", id);
      if (!record || record.state !== "ready" || record.registrationId !== registrationId
        || record.hostProfile && record.hostProfile.revision >= profile.revision) return;
      await db.put("hosts", { ...record, name: profile.name, hostProfile: profile }); this.changed();
    });
  }
  async clearNetworkMetadata(id:string):Promise<void> {
    await this.locked(id, async () => { const db = await this.db, record = await db.get("hosts", id); if (!record || !record.networkId) return; const {networkId:_id, networkAuthority:_key, networkRoutes:_routes, networkManualRoutes:_manual, networkBlocked:_blocked, ...next} = record; await db.put("hosts",next); this.changed(); });
  }
  async blockNetworkHost(id:string, networkId:string, registrationId?:string): Promise<void> {
    await this.locked(id, async () => { const db = await this.db, record = await db.get("hosts", id); if (!record || record.networkId !== networkId || registrationId && record.registrationId !== registrationId || record.networkBlocked) return; await db.put("hosts", {...record, networkBlocked:true}); this.changed(); });
  }
  async networkMetadata(id: string, networkId: string, authorityKey: string, routes?: Route[], manual?: string[], registrationId?: string): Promise<void> {
    await this.locked(id, async () => {
      const db = await this.db, current = await db.get("hosts", id);
      if (!current || current.state !== "ready" || registrationId && current.registrationId !== registrationId) return;
      if (current.networkId === networkId && current.networkAuthority === authorityKey && (!routes || JSON.stringify(current.networkRoutes) === JSON.stringify(routes) && JSON.stringify(current.networkManualRoutes ?? []) === JSON.stringify(manual ?? []))) return;
      if (current.networkBlocked) return;
      await db.put("hosts", { ...current, networkId, networkAuthority: authorityKey, ...(routes ? { networkRoutes: routes, networkManualRoutes: manual ?? [] } : {}) }); this.changed();
    });
  }
  /** Provenance for self-route sync. Callers write identity routes first, so an
   * interruption leaves a stale-but-kept route rather than a "deleted" one. */
  async saveHostRoutes(id: string, registrationId: string, base: Route[], at: number, manual: string[] = []): Promise<boolean> {
    return this.locked(id, async () => {
      const db = await this.db, current = await db.get("hosts", id);
      if (!current || current.state !== "ready" || current.registrationId !== registrationId) return false;
      if (current.hostRoutes && JSON.stringify(current.hostRoutes.base) === JSON.stringify(base) && JSON.stringify(current.hostRoutes.manual ?? []) === JSON.stringify(manual)) return true;
      await db.put("hosts", { ...current, hostRoutes: { base: structuredClone(base), manual: [...manual], at } }); this.changed();
      return true;
    });
  }
  /** Each target gets a distinct key. Persist it BEFORE requesting any remote
   * authorization, so an interrupted enrollment resumes with the same identity.
   * The caller must already trust the supplied network membership. An unfinished
   * candidate can migrate networks only after the target confirms the new
   * membership; signed directories alone cannot order different networks.
   * Registered identities are never replaced. */
  async networkCandidate(networkId: string, authorityKey: string, host: NetworkHost, create: () => Promise<Identity>, confirmReplacement?: () => Promise<void>): Promise<NetworkCandidate | undefined> {
    const id = runtimeHostId(host.publicKey);
    return this.locked(id, async () => {
      const db = await this.db;
      // A registered host owns its identity even during setup/removal. Never
      // retire a native key simply because another network advertises that host.
      if (await db.get("hosts", id)) return;
      if (await db.get("meta", `dismissed:${id}`) === networkId || await db.get("meta", retiredCandidateKey(id, networkId, authorityKey))) return;
      const saved = await db.get("networkCandidates", id);
      if (saved) {
        if (!saved.replacing && saved.networkId === networkId && saved.authorityKey === authorityKey) {
          const value = { ...saved, host, identity: { ...saved.identity, routes: host.routes } };
          await db.put("networkCandidates", value); return value;
        }
        if (!confirmReplacement) throw new Error("network_replacement_confirmation_required");
        // Stay under the cross-tab host lock. A rejected/stale target response
        // must not delete its old key, fence a usable candidate, or write a
        // tombstone that would suppress a later legitimate retry.
        await confirmReplacement();
        if (!saved.replacing || saved.replacing.networkId !== networkId || saved.replacing.authorityKey !== authorityKey) {
          // Fence late enroll responses before invoking the OS keystore. A
          // failed delete retains this reference and can be retried safely.
          const tx = db.transaction(["networkCandidates", "meta"], "readwrite");
          void tx.done.catch(() => undefined);
          await tx.objectStore("networkCandidates").put({ ...saved, replacing: { networkId, authorityKey } });
          const retired = saved.replacing ?? saved;
          await tx.objectStore("meta").put("1", retiredCandidateKey(id, retired.networkId, retired.authorityKey));
          await tx.done;
        }
        if (saved.identity.keyRef) { const { deleteNativeIdentity } = await import("./native.js"); await deleteNativeIdentity(saved.identity.keyRef); }
      }
      const identity = await create();
      const value = { id, networkId, authorityKey, host, identity };
      try { await db.put("networkCandidates", value); }
      catch (error) { if (identity.keyRef) { const { deleteNativeIdentity } = await import("./native.js"); await deleteNativeIdentity(identity.keyRef).catch(() => undefined); } throw error; }
      return value;
    });
  }
  async finishNetworkCandidate(candidate: NetworkCandidate): Promise<void> {
    await this.locked(candidate.id, async () => {
      const db = await this.db, saved = await db.get("networkCandidates", candidate.id), host = await db.get("hosts", candidate.id);
      if (saved && sameCandidateIdentity(saved, candidate.identity, candidate.networkId, candidate.authorityKey) && host?.state === "ready" && host.deviceId === candidate.identity.deviceId && host.publicKey === candidate.identity.hubPublicKey) await db.delete("networkCandidates", candidate.id);
    });
  }
  async allowNetworkHost(id: string): Promise<void> { await (await this.db).delete("meta", `dismissed:${id}`); this.changed(); }
  private async fenceRemoval(record: StoredHost): Promise<ClientCache | undefined> {
    let cache = new ClientCache(record.databaseName);
    try {
      const identity = await cache.identity();
      // A legacy UI may have re-paired after interrupted migration. Retire the
      // old registry entry/key without touching the new pairing's database.
      if (identity && (identity.deviceId !== record.deviceId || identity.hubPublicKey !== record.publicKey)) { cache.close(); return; }
      const pending = await cache.pendingReset();
      if (!pending) {
        await cache.beginReset(); cache.close();
        cache = new ClientCache(record.databaseName);
      }
      return cache;
    } catch (error) { cache.close(); throw error; }
  }
  async beginRemoval(id: string): Promise<RuntimeHost> {
    return this.locked(id, async () => {
      const db = await this.db, record = await db.get("hosts", id);
      if (!record) throw new Error("host_not_found");
      const removing: StoredHost = { ...publicRecord(record), keyRef: record.keyRef ?? record.pendingIdentity?.keyRef, state: "removing", cleaned: record.cleaned, cacheOwned: record.cacheOwned };
      if (record.networkId) await db.put("meta", record.networkId, `dismissed:${id}`);
      await db.delete("networkCandidates", id);
      await db.put("hosts", removing); this.changed();
      if (!removing.cleaned?.cache) (await this.fenceRemoval(removing))?.close();
      return publicRecord(removing);
    });
  }
  /** Backend calls must be idempotent and must not reenter locked registry APIs
   * for this host. They receive all identifiers they need. Other hosts stay free. */
  async finishRemoval(id: string, registrationId: string, backend: HostRemovalBackend, progress: (step: ResetStep) => void = () => undefined): Promise<void> {
    let garbage: string | undefined;
    await this.locked(id, async () => {
      const db = await this.db; let record = await db.get("hosts", id); if (!record) return;
      if (record.registrationId !== registrationId || record.state !== "removing") throw new Error("host_removal_changed");
      const cache = record.cleaned?.cache ? undefined : await this.fenceRemoval(record), host = publicRecord(record);
      record = { ...record, cacheOwned: record.cleaned?.cache ? record.cacheOwned : !!cache };
      try { await db.put("hosts", record); } catch (error) { cache?.close(); throw error; }
      const step = async (name: ResetStep, work: () => Promise<void>) => {
        if (record!.cleaned?.[name]) return;
        progress(name); await work(); record = { ...record!, cleaned: { ...record!.cleaned, [name]: true } }; await db.put("hosts", record);
      };
      try {
        await step("shared", () => backend.shared(host));
        await step("push", () => backend.push(host));
        // A replaced cache belongs to another pairing. Retire only the old
        // registry/key in that case, never its replacement's website data.
        await step("browser", async () => { if (cache) await backend.browser(host, await cache.workbenchBrowserScopes(host.publicKey)); });
        await step("key", async () => {
          if (!record!.keyRef) return;
          if (!cache) {
            const current = new ClientCache(record!.databaseName);
            try { if ((await current.identity())?.keyRef === record!.keyRef) throw new Error("host_key_in_use"); } finally { current.close(); }
          }
          await backend.key(record!.keyRef);
        });
        await step("cache", async () => { await cache?.finishReset(); });
        // An empty, fenced dedicated cache can be deleted after all handles
        // close. Persist its name atomically with retiring the registry row.
        const tx = db.transaction(["hosts", "meta"], "readwrite");
        void tx.done.catch(() => undefined);
        if (record.cacheOwned && record.databaseName !== legacyCache.databaseName) {
          garbage = record.databaseName; await tx.objectStore("meta").put(garbage, `delete:${garbage}`);
        }
        if (record.databaseName === legacyCache.databaseName) await tx.objectStore("meta").put(JSON.stringify([record.publicKey, record.deviceId]), "legacyImported");
        const repair = await tx.objectStore("meta").get("desktopMigrationRepair");
        if (repair) {
          const ids: string[] = JSON.parse(repair);
          await tx.objectStore("meta").put(JSON.stringify(ids.filter(value => value !== id)), "desktopMigrationRepair");
        }
        await tx.objectStore("hosts").delete(id); await tx.done; this.changed();
      } finally { cache?.close(); }
    });
    if (garbage) await this.collectGarbage(garbage);
  }
  async collectGarbage(only?: string): Promise<void> {
    const db = await this.db;
    for (const key of await db.getAllKeys("meta")) {
      if (!key.startsWith("delete:")) continue;
      const name = await db.get("meta", key);
      if (!name || only && name !== only || !name.startsWith("tarocub-host-hub_")) continue;
      await this.locked(`garbage:${name}`, async () => {
        if ((await this.list()).some((host) => host.databaseName === name)) throw new Error("host_cache_still_active");
        await deleteDB(name); await db.delete("meta", key);
      });
    }
  }
  close(): void { this.channel?.close(); this.listeners.clear(); void this.db.then((db) => db.close(), () => undefined); }
}
