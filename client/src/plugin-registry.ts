import "./plugin-crypto.js";
import { openDB, type IDBPDatabase } from "idb";
import {
  comparePluginVersions,
  pluginManifestSchema,
  sha256Hex,
  verifyPluginArtifactHash,
  type PluginCapability,
  type PluginContribution,
  type PluginManifest,
  type PluginPlatform,
} from "../../src/client-protocol/plugins.js";
import {
  INFINITE_CANVAS_BUNDLE_HTML,
  QUICK_SCRATCHPAD_BUNDLE_HTML,
} from "./plugin-bundles.js";
import {
  pluginStorageBucketKey,
  sanitizePluginDomain,
  type PluginKvStore,
} from "./plugin-sandbox-runtime.js";

export type { PluginKvStore };

export const PLUGIN_STORE_KEY = "tarobird.plugins.v1";

export type PluginCatalogEntry = {
  manifest: PluginManifest;
  bundleHtml?: string;
};

export const OFFICIAL_PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [
  {
    manifest: pluginManifestSchema.parse({
      schemaVersion: 1,
      id: "tarobird.infinite-canvas",
      name: "Infinite Canvas",
      nameZh: "无限画布",
      version: "1.0.0",
      description: "Zoomable, pannable infinite canvas workspace for architecture notes, diagrams and visual thinking.",
      descriptionZh: "支持缩放与拖拽的无限画布工作区，适合架构草图、便签与自由排版。",
      icon: "canvas",
      source: { repository: "cloveric/tarobird", commit: "636ada65833c" },
      artifact: {
        sha256: "f85bd9adcb3ebe136bdd6b5085cc515812d0a2256de439434b194c22d39361e9",
        sizeBytes: 9825,
      },
      entry: "dist/index.html",
      platforms: ["desktop"],
      contributions: [
        { kind: "workbench-item", id: "infinite-canvas", title: "Infinite Canvas", titleZh: "无限画布", icon: "canvas" },
      ],
      domains: [],
      capabilities: ["theme.read", "storage.device", "workbench.canvas"],
      requiresHost: false,
      official: true,
    }),
    bundleHtml: INFINITE_CANVAS_BUNDLE_HTML,
  },
  {
    manifest: pluginManifestSchema.parse({
      schemaVersion: 1,
      id: "tarobird.quick-scratchpad",
      name: "Quick Scratchpad",
      nameZh: "速记面板",
      version: "1.0.0",
      description: "Lightweight sandboxed scratchpad side panel with device-local storage and one-click copy.",
      descriptionZh: "轻量级沙箱速记侧边栏，支持本机隔离存储与一键复制。",
      icon: "notes",
      source: { repository: "cloveric/tarobird", commit: "636ada65833c" },
      artifact: {
        sha256: "f463130202743a3c2e9ec5cc3280069123bfd3d578e4f90c645613d05be0eaa9",
        sizeBytes: 2837,
      },
      entry: "dist/index.html",
      platforms: ["desktop", "phone"],
      contributions: [
        { kind: "side-panel", id: "scratchpad", title: "Scratchpad", titleZh: "速记面板", icon: "notes" },
      ],
      domains: [],
      capabilities: ["theme.read", "storage.device", "clipboard.write"],
      requiresHost: false,
      official: true,
    }),
    bundleHtml: QUICK_SCRATCHPAD_BUNDLE_HTML,
  },
];

/** Clean empty third-party catalog — no fabricated public community listings.
 * Tests inject explicit test-only catalog fixtures via PluginRegistry options. */
export const THIRD_PARTY_PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [];

export type InstalledPluginRecord = {
  manifest: PluginManifest;
  bundleHtml: string;
  enabled: boolean;
  installedAt: number;
  sourceKind: "official" | "third-party" | "local-dev";
  grantedCapabilities: PluginCapability[];
  grantedDomains: string[];
};

export type PreparedLocalDevPlugin = {
  manifest: PluginManifest;
  bundleHtml: string;
  sanitizedDomains: string[];
  blockedDomains: string[];
};

export type PluginInstallGrantOptions = {
  grantedCapabilities?: readonly PluginCapability[];
  grantedDomains?: readonly string[];
};

export type PluginStoreState = {
  allowThirdParty: boolean;
  developerMode: boolean;
  installed: Record<string, InstalledPluginRecord>;
};

export type PluginStorageAdapter = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys?(): string[];
};


export function pluginScopeId(hostPublicKey?: string | null, userId?: string | null, deviceId?: string | null): string {
  const h = (hostPublicKey ?? "").trim();
  const u = (userId ?? "").trim();
  const d = (deviceId ?? "").trim();
  if (!h && !u && !d) return "default";
  return [d || "device", h.slice(0, 16) || "host", u || "user"].join(":");
}

/** Returns null when host/device identity is known but `userId` has not hydrated yet,
 * so multi-host startup never reads or writes under a synthetic `"user"` scope. */
export function resolvePluginScopeId(hostPublicKey?: string | null, userId?: string | null, deviceId?: string | null): string | null {
  const h = (hostPublicKey ?? "").trim();
  const u = (userId ?? "").trim();
  const d = (deviceId ?? "").trim();
  if (!h && !u && !d) return "default";
  if (!u) return null;
  return pluginScopeId(h, u, d);
}

export function pluginDataPrefix(scopeId: string, pluginId: string): string {
  return scopeId === "default"
    ? `tarobird.plugin.data.${pluginId}.`
    : `tarobird.plugin.data.${scopeId}.${pluginId}.`;
}

export function createDefaultPluginStorage(): PluginStorageAdapter {
  const mem = new Map<string, string>();
  return {
    getItem(key) {
      if (typeof globalThis.localStorage !== "undefined") {
        try { return globalThis.localStorage.getItem(key); } catch { return mem.get(key) ?? null; }
      }
      return mem.get(key) ?? null;
    },
    setItem(key, value) {
      if (typeof globalThis.localStorage !== "undefined") {
        // Propagate QuotaExceededError / SecurityError instead of masking storage failures.
        globalThis.localStorage.setItem(key, value);
        mem.set(key, value);
        return;
      }
      mem.set(key, value);
    },
    removeItem(key) {
      mem.delete(key);
      if (typeof globalThis.localStorage !== "undefined") {
        try { globalThis.localStorage.removeItem(key); } catch { /* ignore */ }
      }
    },
    keys() {
      if (typeof globalThis.localStorage !== "undefined") {
        try {
          const out: string[] = [];
          for (let i = 0; i < globalThis.localStorage.length; i++) {
            const k = globalThis.localStorage.key(i);
            if (k) out.push(k);
          }
          return out;
        } catch { /* fall through */ }
      }
      return [...mem.keys()];
    },
  };
}

export type PluginBundleStore = {
  getBundle(scopeId: string, pluginId: string): Promise<string | null>;
  putBundle(scopeId: string, pluginId: string, html: string): Promise<boolean>;
  deleteBundle(scopeId: string, pluginId: string): Promise<void>;
  kv: PluginKvStore;
};

let sharedStoreDbPromise: Promise<IDBPDatabase | null> | null = null;
function getPluginStoreDb(): Promise<IDBPDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!sharedStoreDbPromise) {
    sharedStoreDbPromise = openDB("tarobird.plugin.store.v1", 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("bundles")) db.createObjectStore("bundles");
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      },
    }).catch(() => null);
  }
  return sharedStoreDbPromise;
}

function createIdbPluginBundleStore(): PluginBundleStore {
  const bundleKey = (scopeId: string, pluginId: string) => `${scopeId}\0${pluginId}`;
  const kvKey = (scopeId: string, pluginId: string, key: string) => `${scopeId}\0${pluginId}\0${key}`;
  const kvPrefix = (scopeId: string, pluginId: string) => `${scopeId}\0${pluginId}\0`;
  return {
    async getBundle(scopeId, pluginId) {
      const db = await getPluginStoreDb();
      if (!db) return null;
      const val = await db.get("bundles", bundleKey(scopeId, pluginId));
      return typeof val === "string" ? val : null;
    },
    async putBundle(scopeId, pluginId, html) {
      const db = await getPluginStoreDb();
      if (!db) return false;
      await db.put("bundles", html, bundleKey(scopeId, pluginId));
      return true;
    },
    async deleteBundle(scopeId, pluginId) {
      const db = await getPluginStoreDb();
      if (!db) return;
      await db.delete("bundles", bundleKey(scopeId, pluginId));
    },
    kv: {
      async get(scopeId, pluginId, key) {
        const db = await getPluginStoreDb();
        if (!db) return null;
        const val = await db.get("kv", kvKey(scopeId, pluginId, key));
        return typeof val === "string" ? val : null;
      },
      async set(scopeId, pluginId, key, value) {
        const db = await getPluginStoreDb();
        if (!db) throw new Error("storage_unavailable");
        await db.put("kv", value, kvKey(scopeId, pluginId, key));
      },
      async remove(scopeId, pluginId, key) {
        const db = await getPluginStoreDb();
        if (!db) return;
        await db.delete("kv", kvKey(scopeId, pluginId, key));
      },
      async list(scopeId, pluginId) {
        const db = await getPluginStoreDb();
        if (!db) return {};
        const prefix = kvPrefix(scopeId, pluginId);
        const tx = db.transaction("kv", "readonly");
        const store = tx.objectStore("kv");
        const keys = await store.getAllKeys();
        const out: Record<string, string> = {};
        for (const k of keys) {
          if (typeof k === "string" && k.startsWith(prefix)) {
            const val = await store.get(k);
            if (typeof val === "string") out[k.slice(prefix.length)] = val;
          }
        }
        return out;
      },
      async clear(scopeId, pluginId) {
        const db = await getPluginStoreDb();
        if (!db) return;
        const prefix = kvPrefix(scopeId, pluginId);
        const keys = await db.getAllKeys("kv");
        for (const k of keys) {
          if (typeof k === "string" && k.startsWith(prefix)) await db.delete("kv", k);
        }
      },
    },
  };
}

type PersistedInstalledPluginRecord = InstalledPluginRecord & {
  bundleStoredInIdb?: boolean;
};

function partitionDeclaredDomains(domains: readonly string[]): {
  sanitizedDomains: string[];
  blockedDomains: string[];
} {
  const sanitizedSet = new Set<string>();
  const blockedSet = new Set<string>();
  for (const raw of domains) {
    const clean = sanitizePluginDomain(raw);
    if (clean) sanitizedSet.add(clean);
    else if (raw.trim()) blockedSet.add(raw.trim());
  }
  return {
    sanitizedDomains: [...sanitizedSet],
    blockedDomains: [...blockedSet],
  };
}

function intersectReviewedCapabilities(
  manifestCapabilities: readonly PluginCapability[],
  reviewed?: readonly PluginCapability[],
): PluginCapability[] {
  const allowed = new Set(manifestCapabilities);
  const source = reviewed ?? manifestCapabilities;
  const out: PluginCapability[] = [];
  const seen = new Set<PluginCapability>();
  for (const cap of source) {
    if (allowed.has(cap) && !seen.has(cap)) {
      seen.add(cap);
      out.push(cap);
    }
  }
  return out;
}

function intersectReviewedDomains(
  manifestDomains: readonly string[],
  reviewed?: readonly string[],
): string[] {
  const allowed = new Set(partitionDeclaredDomains(manifestDomains).sanitizedDomains);
  const source = reviewed ?? [...allowed];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of source) {
    const clean = sanitizePluginDomain(raw);
    if (clean && allowed.has(clean) && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

export class PluginRegistry {
  readonly storage: PluginStorageAdapter;
  readonly kvStore?: PluginKvStore;
  private readonly bundleStore?: PluginBundleStore;
  private readonly catalog: PluginCatalogEntry[];
  private scopeId: string;
  private idbStoredIds = new Set<string>();
  private state: PluginStoreState;
  private listeners = new Set<() => void>();

  constructor(options?: {
    storage?: PluginStorageAdapter;
    kvStore?: PluginKvStore;
    bundleStore?: PluginBundleStore;
    scopeId?: string;
    catalog?: readonly PluginCatalogEntry[];
  }) {
    const usesBrowserIdb = !options?.storage && !options?.bundleStore && typeof indexedDB !== "undefined";
    this.storage = options?.storage ?? createDefaultPluginStorage();
    if (options?.bundleStore) {
      this.bundleStore = options.bundleStore;
      this.kvStore = options?.kvStore ?? options.bundleStore.kv;
    } else if (usesBrowserIdb) {
      this.bundleStore = createIdbPluginBundleStore();
      this.kvStore = options?.kvStore ?? this.bundleStore.kv;
    } else {
      this.kvStore = options?.kvStore;
    }
    this.scopeId = options?.scopeId?.trim() || "default";
    this.catalog = [...(options?.catalog ?? [...OFFICIAL_PLUGIN_CATALOG, ...THIRD_PARTY_PLUGIN_CATALOG])];
    this.state = this.load();
    if (this.bundleStore) {
      void this.hydrateBundles();
    }
  }

  private storeKey(): string {
    return this.scopeId === "default" ? PLUGIN_STORE_KEY : `${PLUGIN_STORE_KEY}.${this.scopeId}`;
  }

  getScopeId(): string {
    return this.scopeId;
  }

  setScope(scopeId: string): void {
    const clean = scopeId.trim() || "default";
    if (this.scopeId === clean) return;
    this.scopeId = clean;
    this.state = this.load();
    for (const listener of this.listeners) listener();
    if (this.bundleStore) {
      void this.hydrateBundles();
    }
  }

  private async hydrateBundles(): Promise<void> {
    if (!this.bundleStore) return;
    const scope = this.scopeId;
    const records = Object.values(this.state.installed);
    if (!records.length) return;

    let changed = false;
    let migratedToIdb = false;
    const nextInstalled = { ...this.state.installed };

    for (const current of records) {
      const id = current.manifest.id;
      if (current.bundleHtml && !this.idbStoredIds.has(id)) {
        const stored = await this.bundleStore.putBundle(scope, id, current.bundleHtml).catch(() => false);
        if (this.scopeId !== scope) return;
        if (stored && this.state.installed[id]?.installedAt === current.installedAt) {
          this.idbStoredIds.add(id);
          migratedToIdb = true;
        }
        continue;
      }
      if (!current.bundleHtml) {
        let html = await this.bundleStore.getBundle(scope, id).catch(() => null);
        if (!html) {
          const inlineCatalog = this.catalog.find((entry) => entry.manifest.id === id && entry.bundleHtml);
          if (inlineCatalog?.bundleHtml && inlineCatalog.manifest.artifact.sha256 === current.manifest.artifact.sha256) {
            html = inlineCatalog.bundleHtml;
          }
        }
        if (this.scopeId !== scope) return;
        if (html && this.state.installed[id]?.installedAt === current.installedAt) {
          nextInstalled[id] = { ...current, bundleHtml: html };
          changed = true;
        }
      }
    }

    if (this.scopeId !== scope) return;
    if (changed) {
      this.state = { ...this.state, installed: nextInstalled };
      for (const listener of this.listeners) listener();
    }
    if (migratedToIdb) {
      try {
        this.storage.setItem(this.storeKey(), this.serializeStateForStorage(this.state));
      } catch {
        // Ignore compaction errors; bundles are already safe in memory & IDB.
      }
    }
  }

  private parseStoreJson(raw: string): { state: PluginStoreState; idbIds: Set<string> } | null {
    try {
      const parsed = JSON.parse(raw) as {
        allowThirdParty?: unknown;
        developerMode?: unknown;
        installed?: Record<string, Partial<PersistedInstalledPluginRecord>>;
      };
      const installed: Record<string, InstalledPluginRecord> = {};
      const idbIds = new Set<string>();
      if (parsed.installed && typeof parsed.installed === "object") {
        for (const [id, item] of Object.entries(parsed.installed)) {
          const stored = item?.manifest;
          // Earlier local catalogs persisted a signature and optional download address.
          // Restore the installed metadata without treating either field as authority.
          const manifest = pluginManifestSchema.safeParse(stored?.artifact ? {
            ...stored, artifact: { sha256: stored.artifact.sha256, sizeBytes: stored.artifact.sizeBytes },
          } : stored);
          if (!manifest.success || manifest.data.id !== id) continue;
          const hasStoredBundle = item?.bundleStoredInIdb === true;
          if (!hasStoredBundle && typeof item?.bundleHtml !== "string") continue;
          let bundleHtml = typeof item?.bundleHtml === "string" ? item.bundleHtml : "";
          if (!bundleHtml && !this.bundleStore) {
            const inlineCatalog = this.catalog.find((entry) => entry.manifest.id === id && entry.bundleHtml);
            if (inlineCatalog?.bundleHtml && inlineCatalog.manifest.artifact.sha256 === manifest.data.artifact.sha256) {
              bundleHtml = inlineCatalog.bundleHtml;
            }
          }
          if (hasStoredBundle) idbIds.add(id);
          installed[id] = {
            manifest: manifest.data,
            bundleHtml,
            enabled: item.enabled !== false,
            installedAt: typeof item.installedAt === "number" ? item.installedAt : Date.now(),
            sourceKind: item.sourceKind === "local-dev" ? "local-dev" : manifest.data.official ? "official" : "third-party",
            grantedCapabilities: Array.isArray(item.grantedCapabilities) ? item.grantedCapabilities : [...manifest.data.capabilities],
            grantedDomains: Array.isArray(item.grantedDomains) ? item.grantedDomains : [...manifest.data.domains],
          };
        }
      }
      return {
        state: {
          allowThirdParty: parsed.allowThirdParty === true,
          developerMode: parsed.developerMode === true,
          installed,
        },
        idbIds,
      };
    } catch {
      return null;
    }
  }

  private load(): PluginStoreState {
    const key = this.storeKey();
    let raw = this.storage.getItem(key);
    let migratedFromLegacy = false;
    if (!raw && this.scopeId !== "default") {
      const legacyRaw = this.storage.getItem(PLUGIN_STORE_KEY);
      if (legacyRaw) {
        raw = legacyRaw;
        migratedFromLegacy = true;
      }
    }
    this.idbStoredIds = new Set<string>();
    if (!raw) return { allowThirdParty: false, developerMode: false, installed: {} };
    const parsed = this.parseStoreJson(raw);
    if (!parsed) return { allowThirdParty: false, developerMode: false, installed: {} };
    this.idbStoredIds = parsed.idbIds;

    if (migratedFromLegacy) {
      // Crash-safe one-way migration from legacy unscoped `tarobird.plugins.v1`
      // into this scope's key + scoped KV buckets so upgrades never lose installs
      // and never leak legacy state into a second user/host scope.
      try {
        this.storage.setItem(key, this.serializeStateForStorage(parsed.state));
        for (const id of Object.keys(parsed.state.installed)) {
          const legacyBucketKey = pluginStorageBucketKey(id);
          const scopedBucketKey = pluginStorageBucketKey(id, this.scopeId);
          if (legacyBucketKey !== scopedBucketKey) {
            const legacyBucket = this.storage.getItem(legacyBucketKey);
            if (legacyBucket !== null && this.storage.getItem(scopedBucketKey) === null) {
              this.storage.setItem(scopedBucketKey, legacyBucket);
              this.storage.removeItem(legacyBucketKey);
            }
          }
        }
        this.storage.removeItem(PLUGIN_STORE_KEY);
      } catch {
        // Keep legacy data untouched if writing the migrated key fails (e.g. quota).
      }
    }
    return parsed.state;
  }

  private serializeStateForStorage(state: PluginStoreState): string {
    if (!this.bundleStore) {
      return JSON.stringify(state);
    }
    const serializedInstalled: Record<string, PersistedInstalledPluginRecord> = {};
    for (const [id, record] of Object.entries(state.installed)) {
      if (this.idbStoredIds.has(id)) {
        serializedInstalled[id] = {
          ...record,
          bundleHtml: "",
          bundleStoredInIdb: true,
        };
      } else {
        serializedInstalled[id] = { ...record };
      }
    }
    return JSON.stringify({
      allowThirdParty: state.allowThirdParty,
      developerMode: state.developerMode,
      installed: serializedInstalled,
    });
  }

  private save(): void {
    this.storage.setItem(this.storeKey(), this.serializeStateForStorage(this.state));
    this.state = { ...this.state, installed: { ...this.state.installed } };
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): PluginStoreState => this.state;

  catalogForPlatform(platform: PluginPlatform): PluginCatalogEntry[] {
    return this.catalog.filter((entry) => entry.manifest.platforms.includes(platform));
  }

  installedForPlatform(platform: PluginPlatform): InstalledPluginRecord[] {
    return Object.values(this.state.installed).filter((record) => record.manifest.platforms.includes(platform));
  }

  enabledContributions(
    platform: PluginPlatform,
    kind: PluginContribution["kind"],
  ): Array<{ plugin: InstalledPluginRecord; contribution: PluginContribution }> {
    const out: Array<{ plugin: InstalledPluginRecord; contribution: PluginContribution }> = [];
    for (const plugin of this.installedForPlatform(platform)) {
      if (!plugin.enabled) continue;
      for (const contribution of plugin.manifest.contributions) {
        if (contribution.kind === kind) out.push({ plugin, contribution });
      }
    }
    return out;
  }

  hasUpdate(pluginId: string): PluginCatalogEntry | undefined {
    const current = this.state.installed[pluginId];
    if (!current || current.sourceKind === "local-dev") return undefined;
    const entry = this.catalog.find((item) => item.manifest.id === pluginId);
    if (!entry) return undefined;
    const cmp = comparePluginVersions(entry.manifest.version, current.manifest.version);
    if (cmp > 0) return entry;
    if (
      cmp === 0
      && entry.manifest.official
      && entry.manifest.artifact.sha256.toLowerCase() !== current.manifest.artifact.sha256.toLowerCase()
    ) {
      return entry;
    }
    return undefined;
  }

  setAllowThirdParty(allow: boolean): void {
    if (this.state.allowThirdParty === allow) return;
    const prev = this.state;
    this.state = { ...this.state, allowThirdParty: allow };
    try {
      this.save();
    } catch (error) {
      this.state = prev;
      throw error;
    }
  }

  setDeveloperMode(enabled: boolean): void {
    if (this.state.developerMode === enabled) return;
    const prev = this.state;
    this.state = { ...this.state, developerMode: enabled };
    try {
      this.save();
    } catch (error) {
      this.state = prev;
      throw error;
    }
  }

  private assertNotReservedOfficialId(pluginId: string): void {
    if (
      pluginId.startsWith("tarobird.")
      || this.catalog.some((item) => item.manifest.official && item.manifest.id === pluginId)
      || this.state.installed[pluginId]?.sourceKind === "official"
    ) {
      throw new Error("plugin_official_id_reserved");
    }
  }

  async install(
    entry: PluginCatalogEntry,
    options?: PluginInstallGrantOptions,
  ): Promise<InstalledPluginRecord> {
    const requested = pluginManifestSchema.parse(entry.manifest);
    const pinned = this.catalog.find(item => item.manifest.id === requested.id);
    if (!pinned) throw new Error("plugin_catalog_mismatch");
    const manifest = pluginManifestSchema.parse(pinned.manifest);
    if (JSON.stringify(requested) !== JSON.stringify(manifest)) throw new Error("plugin_catalog_mismatch");
    if (!manifest.official && !this.state.allowThirdParty) throw new Error("plugin_third_party_disabled");
    const bundleHtml = entry.bundleHtml;
    if (bundleHtml === undefined) throw new Error("plugin_artifact_missing");
    const actualSizeBytes = new TextEncoder().encode(bundleHtml).byteLength;
    if (actualSizeBytes !== manifest.artifact.sizeBytes) {
      throw new Error("plugin_size_mismatch");
    }
    const hashOk = await verifyPluginArtifactHash(bundleHtml, manifest.artifact.sha256);
    if (!hashOk) {
      throw new Error("plugin_hash_mismatch");
    }
    const previous = this.state.installed[manifest.id];
    const reviewedCapabilities = intersectReviewedCapabilities(manifest.capabilities, options?.grantedCapabilities);
    const reviewedDomains = intersectReviewedDomains(manifest.domains, options?.grantedDomains);
    const preservedDomains = previous
      ? [...new Set([...reviewedDomains, ...previous.grantedDomains.filter((d) => sanitizePluginDomain(d) !== null)])]
      : reviewedDomains;
    const record: InstalledPluginRecord = {
      manifest,
      bundleHtml,
      enabled: true,
      installedAt: Math.max(Date.now(), (previous?.installedAt ?? 0) + 1),
      sourceKind: manifest.official ? "official" : "third-party",
      grantedCapabilities: reviewedCapabilities,
      grantedDomains: preservedDomains,
    };
    const prevIdbStored = this.idbStoredIds.has(manifest.id);
    if (this.bundleStore) {
      const stored = await this.bundleStore.putBundle(this.scopeId, manifest.id, bundleHtml).catch(() => false);
      if (stored) this.idbStoredIds.add(manifest.id);
      else this.idbStoredIds.delete(manifest.id);
    }
    const prevState = this.state;
    this.state = {
      ...this.state,
      installed: { ...this.state.installed, [manifest.id]: record },
    };
    try {
      this.save();
    } catch (error) {
      this.state = prevState;
      if (prevIdbStored) this.idbStoredIds.add(manifest.id);
      else this.idbStoredIds.delete(manifest.id);
      throw error;
    }
    return record;
  }

  /** Validates a local development folder's manifest and bundle without installing
   * or granting any permissions/domains, so UI callers must present the pre-install
   * permission & domain confirmation modal before calling `installPreparedLocalDev`. */
  async prepareLocalDev(manifestJson: string, bundleHtml: string): Promise<PreparedLocalDevPlugin> {
    if (!this.state.developerMode) {
      throw new Error("plugin_developer_mode_disabled");
    }
    const raw = JSON.parse(manifestJson) as Record<string, unknown>;
    const actualHash = await sha256Hex(bundleHtml);
    const sizeBytes = new TextEncoder().encode(bundleHtml).byteLength;
    const declaredSha = typeof (raw.artifact as Record<string, unknown> | undefined)?.sha256 === "string"
      ? String((raw.artifact as Record<string, unknown>).sha256)
      : undefined;
    if (declaredSha && declaredSha.toLowerCase() !== actualHash.toLowerCase()) {
      throw new Error("plugin_hash_mismatch");
    }
    const manifest = pluginManifestSchema.parse({
      ...raw,
      official: false,
      artifact: {
        sha256: declaredSha ?? actualHash,
        sizeBytes: Math.max(1, sizeBytes),
      },
    });
    this.assertNotReservedOfficialId(manifest.id);
    const { sanitizedDomains, blockedDomains } = partitionDeclaredDomains(manifest.domains);
    return {
      manifest,
      bundleHtml,
      sanitizedDomains,
      blockedDomains,
    };
  }

  /** Installs a previously prepared local development plugin after explicit user review,
   * re-verifying digest/size and granting only the reviewed capabilities and valid public domains. */
  async installPreparedLocalDev(
    prepared: PreparedLocalDevPlugin,
    options?: PluginInstallGrantOptions,
  ): Promise<InstalledPluginRecord> {
    if (!this.state.developerMode) {
      throw new Error("plugin_developer_mode_disabled");
    }
    const manifest = pluginManifestSchema.parse({
      ...prepared.manifest,
      official: false,
    });
    this.assertNotReservedOfficialId(manifest.id);
    const actualSizeBytes = Math.max(1, new TextEncoder().encode(prepared.bundleHtml).byteLength);
    if (actualSizeBytes !== manifest.artifact.sizeBytes) {
      throw new Error("plugin_size_mismatch");
    }
    const hashOk = await verifyPluginArtifactHash(prepared.bundleHtml, manifest.artifact.sha256);
    if (!hashOk) {
      throw new Error("plugin_hash_mismatch");
    }
    const grantedCapabilities = intersectReviewedCapabilities(manifest.capabilities, options?.grantedCapabilities);
    const grantedDomains = intersectReviewedDomains(manifest.domains, options?.grantedDomains);
    const previous = this.state.installed[manifest.id];
    const record: InstalledPluginRecord = {
      manifest,
      bundleHtml: prepared.bundleHtml,
      enabled: true,
      installedAt: Math.max(Date.now(), (previous?.installedAt ?? 0) + 1),
      sourceKind: "local-dev",
      grantedCapabilities,
      grantedDomains,
    };
    const prevIdbStored = this.idbStoredIds.has(manifest.id);
    if (this.bundleStore) {
      const stored = await this.bundleStore.putBundle(this.scopeId, manifest.id, prepared.bundleHtml).catch(() => false);
      if (stored) this.idbStoredIds.add(manifest.id);
      else this.idbStoredIds.delete(manifest.id);
    }
    const prevState = this.state;
    this.state = {
      ...this.state,
      installed: { ...this.state.installed, [manifest.id]: record },
    };
    try {
      this.save();
    } catch (error) {
      this.state = prevState;
      if (prevIdbStored) this.idbStoredIds.add(manifest.id);
      else this.idbStoredIds.delete(manifest.id);
      throw error;
    }
    return record;
  }

  async installLocalDev(
    manifestJson: string,
    bundleHtml: string,
    options?: PluginInstallGrantOptions,
  ): Promise<InstalledPluginRecord> {
    const prepared = await this.prepareLocalDev(manifestJson, bundleHtml);
    return this.installPreparedLocalDev(prepared, options);
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    const existing = this.state.installed[pluginId];
    if (!existing || existing.enabled === enabled) return;
    const prev = this.state;
    this.state = {
      ...this.state,
      installed: { ...this.state.installed, [pluginId]: { ...existing, enabled } },
    };
    try {
      this.save();
    } catch (error) {
      this.state = prev;
      throw error;
    }
  }

  async uninstall(pluginId: string, options?: { keepData?: boolean }): Promise<void> {
    if (this.state.installed[pluginId]) {
      const next = { ...this.state.installed };
      delete next[pluginId];
      this.state = { ...this.state, installed: next };
      this.idbStoredIds.delete(pluginId);
      this.save();
    }
    const shouldWipe = options?.keepData !== true;
    if (shouldWipe) {
      this.storage.removeItem(pluginStorageBucketKey(pluginId, this.scopeId));
      if (this.scopeId === "default") {
        this.storage.removeItem(pluginStorageBucketKey(pluginId));
      }
      const prefix = pluginDataPrefix(this.scopeId, pluginId);
      const legacyPrefix = `tarobird.plugin.data.${pluginId}.`;
      const maybeData = (this.storage as unknown as { data?: Map<string, string> }).data;
      const allKeys = this.storage.keys
        ? this.storage.keys()
        : maybeData instanceof Map
          ? [...maybeData.keys()]
          : [];
      for (const key of allKeys) {
        if (key.startsWith(prefix) || (this.scopeId === "default" && key.startsWith(legacyPrefix))) {
          this.storage.removeItem(key);
        }
      }
    }
    if (this.bundleStore) {
      await this.bundleStore.deleteBundle(this.scopeId, pluginId).catch(() => undefined);
    }
    if (shouldWipe && this.kvStore) {
      await this.kvStore.clear(this.scopeId, pluginId).catch(() => undefined);
    }
  }

  getPlugin(pluginId: string): InstalledPluginRecord | undefined {
    return this.state.installed[pluginId];
  }
}

const scopedRegistries = new Map<string, PluginRegistry>();

/** Returns an isolated, cached PluginRegistry bound strictly to `scopeId` so
 * concurrent multi-host windows/panes never mutate shared global state. */
export function getPluginRegistry(scopeId?: string): PluginRegistry {
  const clean = scopeId?.trim() || "default";
  let instance = scopedRegistries.get(clean);
  if (!instance) {
    instance = new PluginRegistry({ scopeId: clean });
    scopedRegistries.set(clean, instance);
  }
  return instance;
}

export const pluginRegistry = getPluginRegistry("default");
