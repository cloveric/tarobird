import "./plugin-crypto.js";
import { openDB, type IDBPDatabase } from "idb";
import {
  comparePluginVersions,
  pluginManifestSchema,
  sha256Hex,
  verifyOfficialPluginSignature,
  verifyPluginArtifactHash,
  type PluginCapability,
  type PluginContribution,
  type PluginManifest,
  type PluginPlatform,
} from "../../src/client-protocol/plugins.js";
import {
  FOCUS_TIMER_BUNDLE_HTML,
  QUICK_SCRATCHPAD_BUNDLE_HTML,
} from "./plugin-bundles.js";
import {
  pluginStorageBucketKey,
  sanitizePluginDomain,
  type PluginCredentialVault,
  type PluginKvStore,
} from "./plugin-sandbox-runtime.js";

export type { PluginCredentialVault, PluginKvStore } from "./plugin-sandbox-runtime.js";

export const PLUGIN_STORE_KEY = "tarobird.plugins.v1";

/** Ed25519 SPKI public key (base64) used to verify official TaroBird plugin manifests. */
export const OFFICIAL_PLUGIN_PUBLIC_KEY = "MCowBQYDK2VwAyEAotkoRWkrqqQU1eLiYvFwm8A2EbBip1Ma5DMq5gd9wOA=";

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
      description: "Full Infinite Canvas workbench (canvas, image/video create, prompts, assets, bundled node plugins, and TaroBird Bot Canvas Agent).",
      descriptionZh: "完整无限画布工作台（画布编排、生图/生视频、提示词库、素材库、内置官方节点插件与对话 Bot Agent 联动）。",
      icon: "canvas",
      source: { repository: "basketikun/infinite-canvas", commit: "4c67f1e" },
      artifact: {
        sha256: "bc742274dab93c72c757f2d853da97b83bb831b6fd764afc2e82f3a5193cf748",
        sizeBytes: 293860,
        url: "/api/plugins/artifacts/tarobird.infinite-canvas/1.0.0/bundle.html",
        signature: "nxxo4Vhs7B/k63XDkPhG6ihjxechHEbD8mekKoeZsmeAmXIsXcaXMihz9E25ySqMt1+quIUGDis/ul6l0V3JDA==",
      },
      attribution: {
        author: "basketikun",
        license: "MIT",
        homepage: "https://github.com/basketikun/infinite-canvas",
        notice: "MIT License — Copyright (c) 2026 basketikun",
      },
      entry: "dist/index.html",
      platforms: ["desktop"],
      contributions: [
        { kind: "workbench-item", id: "infinite-canvas", title: "Infinite Canvas", titleZh: "无限画布", icon: "canvas" },
      ],
      domains: ["api.openai.com", "generativelanguage.googleapis.com", "raw.githubusercontent.com"],
      capabilities: ["theme.read", "storage.device", "clipboard.write", "workbench.canvas", "canvas.agent"],
      requiresHost: true,
      official: true,
    }),
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
        signature: "o3If/tS0i7u4vt2m1o5MN05cCli32qWBEnAL0eGBGaSJoOmppUWofyfzhkikflB07N2NBqQ3cJM/emkD7sJTBg==",
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

export const THIRD_PARTY_PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [
  {
    manifest: pluginManifestSchema.parse({
      schemaVersion: 1,
      id: "community.focus-timer",
      name: "Focus Timer",
      nameZh: "专注计时器",
      version: "1.0.0",
      description: "Simple 25-minute Pomodoro timer in an isolated side panel.",
      descriptionZh: "运行在独立沙箱侧边栏里的 25 分钟番茄钟计时器。",
      icon: "clock",
      source: { repository: "tarobird-community/focus-timer", commit: "a1b2c3d" },
      artifact: {
        sha256: "300e7f06445862b1bfe55812011380221b71c0fd7bc750ff27ff6b989f19307f",
        sizeBytes: 2821,
      },
      entry: "dist/index.html",
      platforms: ["desktop", "phone"],
      contributions: [
        { kind: "side-panel", id: "focus-timer", title: "Focus Timer", titleZh: "专注计时器", icon: "clock" },
      ],
      domains: [],
      capabilities: ["theme.read"],
      requiresHost: false,
      official: false,
    }),
    bundleHtml: FOCUS_TIMER_BUNDLE_HTML,
  },
];

export type InstalledPluginRecord = {
  manifest: PluginManifest;
  bundleHtml: string;
  enabled: boolean;
  installedAt: number;
  sourceKind: "official" | "third-party" | "local-dev";
  grantedCapabilities: PluginCapability[];
  grantedDomains: string[];
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

export type PluginArtifactFetcher = (url: string) => Promise<string>;

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

type PluginBundleStore = {
  getBundle(scopeId: string, pluginId: string): Promise<string | null>;
  putBundle(scopeId: string, pluginId: string, html: string): Promise<void>;
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
      if (!db) return;
      await db.put("bundles", html, bundleKey(scopeId, pluginId));
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

/** Isolated credential vault stored in IndexedDB (never localStorage, never Hub, never synced). */
function defaultCredentialVault(): PluginCredentialVault {
  const mem = new Map<string, string>();
  let dbPromise: Promise<IDBPDatabase | null> | null = null;
  const getDb = async (): Promise<IDBPDatabase | null> => {
    if (typeof indexedDB === "undefined") return null;
    if (!dbPromise) {
      dbPromise = openDB("tarobird.plugin.credentials.v1", 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains("secrets")) db.createObjectStore("secrets");
        },
      }).catch(() => null);
    }
    return dbPromise;
  };
  const compound = (scopeId: string, pluginId: string, key: string) => `${scopeId}\0${pluginId}\0${key}`;
  return {
    async getSecret(scopeId, pluginId, key) {
      const k = compound(scopeId, pluginId, key);
      const db = await getDb();
      if (db) {
        const val = await db.get("secrets", k);
        if (typeof val === "string") {
          mem.set(k, val);
          return val;
        }
      }
      return mem.get(k) ?? null;
    },
    async setSecret(scopeId, pluginId, key, value) {
      const k = compound(scopeId, pluginId, key);
      mem.set(k, value);
      const db = await getDb();
      if (db) await db.put("secrets", value, k);
    },
    async removeSecret(scopeId, pluginId, key) {
      const k = compound(scopeId, pluginId, key);
      mem.delete(k);
      const db = await getDb();
      if (db) await db.delete("secrets", k);
    },
    async clearPluginSecrets(scopeId, pluginId) {
      const prefix = `${scopeId}\0${pluginId}\0`;
      for (const k of [...mem.keys()]) {
        if (k.startsWith(prefix)) mem.delete(k);
      }
      const db = await getDb();
      if (db) {
        const allKeys = await db.getAllKeys("secrets");
        for (const k of allKeys) {
          if (typeof k === "string" && k.startsWith(prefix)) await db.delete("secrets", k);
        }
      }
    },
  };
}

async function defaultArtifactFetcher(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new Error("plugin_download_failed");
  return res.text();
}

type PersistedInstalledPluginRecord = InstalledPluginRecord & {
  bundleStoredInIdb?: boolean;
};

export class PluginRegistry {
  readonly storage: PluginStorageAdapter;
  readonly credentialVault: PluginCredentialVault;
  readonly kvStore?: PluginKvStore;
  private readonly bundleStore?: PluginBundleStore;
  private readonly officialPublicKey: string;
  private readonly catalog: PluginCatalogEntry[];
  private readonly fetcher: PluginArtifactFetcher;
  private scopeId: string;
  private state: PluginStoreState;
  private listeners = new Set<() => void>();

  constructor(options?: {
    storage?: PluginStorageAdapter;
    credentialVault?: PluginCredentialVault;
    kvStore?: PluginKvStore;
    scopeId?: string;
    officialPublicKey?: string;
    catalog?: readonly PluginCatalogEntry[];
    fetcher?: PluginArtifactFetcher;
  }) {
    const usesBrowserIdb = !options?.storage && typeof indexedDB !== "undefined";
    this.storage = options?.storage ?? createDefaultPluginStorage();
    this.credentialVault = options?.credentialVault ?? defaultCredentialVault();
    if (usesBrowserIdb) {
      this.bundleStore = createIdbPluginBundleStore();
      this.kvStore = options?.kvStore ?? this.bundleStore.kv;
    } else {
      this.kvStore = options?.kvStore;
    }
    this.scopeId = options?.scopeId?.trim() || "default";
    this.officialPublicKey = options?.officialPublicKey ?? OFFICIAL_PLUGIN_PUBLIC_KEY;
    this.catalog = [...(options?.catalog ?? [...OFFICIAL_PLUGIN_CATALOG, ...THIRD_PARTY_PLUGIN_CATALOG])];
    this.fetcher = options?.fetcher ?? defaultArtifactFetcher;
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
    const missingIds = Object.values(this.state.installed)
      .filter((record) => !record.bundleHtml)
      .map((record) => record.manifest.id);
    if (!missingIds.length) return;
    let changed = false;
    const nextInstalled = { ...this.state.installed };
    for (const id of missingIds) {
      const current = nextInstalled[id];
      if (!current || current.bundleHtml) continue;
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
    if (changed && this.scopeId === scope) {
      this.state = { ...this.state, installed: nextInstalled };
      for (const listener of this.listeners) listener();
    }
  }

  private load(): PluginStoreState {
    const raw = this.storage.getItem(this.storeKey());
    if (!raw) return { allowThirdParty: false, developerMode: false, installed: {} };
    try {
      const parsed = JSON.parse(raw) as {
        allowThirdParty?: unknown;
        developerMode?: unknown;
        installed?: Record<string, Partial<PersistedInstalledPluginRecord>>;
      };
      const installed: Record<string, InstalledPluginRecord> = {};
      if (parsed.installed && typeof parsed.installed === "object") {
        for (const [id, item] of Object.entries(parsed.installed)) {
          const manifest = pluginManifestSchema.safeParse(item?.manifest);
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
        allowThirdParty: parsed.allowThirdParty === true,
        developerMode: parsed.developerMode === true,
        installed,
      };
    } catch {
      return { allowThirdParty: false, developerMode: false, installed: {} };
    }
  }

  private serializeStateForStorage(state: PluginStoreState): string {
    if (!this.bundleStore) {
      return JSON.stringify(state);
    }
    const strippedInstalled: Record<string, PersistedInstalledPluginRecord> = {};
    for (const [id, record] of Object.entries(state.installed)) {
      strippedInstalled[id] = {
        ...record,
        bundleHtml: "",
        bundleStoredInIdb: true,
      };
    }
    return JSON.stringify({
      allowThirdParty: state.allowThirdParty,
      developerMode: state.developerMode,
      installed: strippedInstalled,
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
    return comparePluginVersions(entry.manifest.version, current.manifest.version) > 0 ? entry : undefined;
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

  grantDomain(pluginId: string, rawDomain: string): string | null {
    const clean = sanitizePluginDomain(rawDomain);
    if (!clean) return null;
    const existing = this.state.installed[pluginId];
    if (!existing) return null;
    if (existing.grantedDomains.includes(clean)) return clean;
    const prev = this.state;
    this.state = {
      ...this.state,
      installed: {
        ...this.state.installed,
        [pluginId]: {
          ...existing,
          grantedDomains: [...existing.grantedDomains, clean],
        },
      },
    };
    try {
      this.save();
      return clean;
    } catch (error) {
      this.state = prev;
      throw error;
    }
  }

  async install(entry: PluginCatalogEntry, options?: { fetcher?: PluginArtifactFetcher }): Promise<InstalledPluginRecord> {
    const manifest = pluginManifestSchema.parse(entry.manifest);
    if (!manifest.official && !this.state.allowThirdParty) {
      throw new Error("plugin_third_party_disabled");
    }
    let bundleHtml = entry.bundleHtml;
    if (bundleHtml === undefined) {
      if (!manifest.artifact.url) {
        throw new Error("plugin_artifact_missing");
      }
      const fetchFn = options?.fetcher ?? this.fetcher;
      try {
        bundleHtml = await fetchFn(manifest.artifact.url);
      } catch (err) {
        if (err instanceof Error && err.message === "plugin_download_failed") throw err;
        throw new Error("plugin_download_failed");
      }
    }
    const actualSizeBytes = new TextEncoder().encode(bundleHtml).byteLength;
    if (actualSizeBytes !== manifest.artifact.sizeBytes) {
      throw new Error("plugin_size_mismatch");
    }
    const hashOk = await verifyPluginArtifactHash(bundleHtml, manifest.artifact.sha256);
    if (!hashOk) {
      throw new Error("plugin_hash_mismatch");
    }
    if (manifest.official) {
      const sigOk = await verifyOfficialPluginSignature(manifest, this.officialPublicKey);
      if (!sigOk) {
        throw new Error("plugin_signature_invalid");
      }
    }
    const previous = this.state.installed[manifest.id];
    const preservedDomains = previous
      ? [...new Set([...manifest.domains, ...previous.grantedDomains.filter((d) => sanitizePluginDomain(d) !== null)])]
      : [...manifest.domains];
    const record: InstalledPluginRecord = {
      manifest,
      bundleHtml,
      enabled: true,
      installedAt: Math.max(Date.now(), (previous?.installedAt ?? 0) + 1),
      sourceKind: manifest.official ? "official" : "third-party",
      grantedCapabilities: [...manifest.capabilities],
      grantedDomains: preservedDomains,
    };
    if (this.bundleStore) {
      await this.bundleStore.putBundle(this.scopeId, manifest.id, bundleHtml);
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
      throw error;
    }
    return record;
  }

  async installLocalDev(manifestJson: string, bundleHtml: string): Promise<InstalledPluginRecord> {
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
    if (
      manifest.id.startsWith("tarobird.")
      || this.catalog.some((item) => item.manifest.official && item.manifest.id === manifest.id)
      || this.state.installed[manifest.id]?.sourceKind === "official"
    ) {
      throw new Error("plugin_official_id_reserved");
    }
    const previous = this.state.installed[manifest.id];
    const record: InstalledPluginRecord = {
      manifest,
      bundleHtml,
      enabled: true,
      installedAt: Math.max(Date.now(), (previous?.installedAt ?? 0) + 1),
      sourceKind: "local-dev",
      grantedCapabilities: [...manifest.capabilities],
      grantedDomains: [...manifest.domains],
    };
    if (this.bundleStore) {
      await this.bundleStore.putBundle(this.scopeId, manifest.id, bundleHtml);
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
      throw error;
    }
    return record;
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
      this.save();
    }
    const shouldWipe = options?.keepData !== true;
    if (shouldWipe) {
      // Remove scoped isolated KV bucket synchronously so both sync and async callers observe immediate cleanup.
      this.storage.removeItem(pluginStorageBucketKey(pluginId, this.scopeId));
      if (this.scopeId === "default") {
        this.storage.removeItem(pluginStorageBucketKey(pluginId));
      }
      // Clean up any legacy flat-prefix keys as well.
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
    if (shouldWipe) {
      if (this.kvStore) {
        await this.kvStore.clear(this.scopeId, pluginId).catch(() => undefined);
      }
      await this.credentialVault.clearPluginSecrets(this.scopeId, pluginId);
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
