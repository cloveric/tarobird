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

export const PLUGIN_STORE_KEY = "tarobird.plugins.v1";

/** Ed25519 SPKI public key (base64) used to verify official TaroBird plugin manifests. */
export const OFFICIAL_PLUGIN_PUBLIC_KEY = "MCowBQYDK2VwAyEA020xOc64IjhAdWFcOtnXaqkDHImZxepj6cDZ2mD1Kzw=";

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
        sha256: "614c0ac66c1fd6fcdc11a2bb7e6a670f10003204e4a1107d43a4a31deccbf7af",
        sizeBytes: 278542,
        url: "/api/plugins/artifacts/tarobird.infinite-canvas/1.0.0/bundle.html",
        signature: "C7w3VC5PsGFo1CmUv5pXeaw/7ADiGzAPovAa3MOlrPV5Kinyoh2jC4iYkageB0QheQ4/EOPNDViPVn0YspxYCw==",
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
        signature: "NDX3TY7laYLQvdyvG8kFvEDQMZoZkwa2vhyiHQPUjJ/sUypOOw5YF9G6HGB1xJeaCKJrDgjoJUVISQ6MlE1XDQ==",
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
        sha256: "68ff0c7b518adcd2ae573fbb353e2002ed233cec26308a7f5b43d47f3f489b2a",
        sizeBytes: 2375,
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

export type PluginCredentialVault = {
  getSecret(scopeId: string, pluginId: string, key: string): Promise<string | null>;
  setSecret(scopeId: string, pluginId: string, key: string, value: string): Promise<void>;
  removeSecret(scopeId: string, pluginId: string, key: string): Promise<void>;
  clearPluginSecrets(scopeId: string, pluginId: string): Promise<void>;
};

export type PluginArtifactFetcher = (url: string) => Promise<string>;

export function pluginScopeId(hostPublicKey?: string | null, userId?: string | null, deviceId?: string | null): string {
  const h = (hostPublicKey ?? "").trim();
  const u = (userId ?? "").trim();
  const d = (deviceId ?? "").trim();
  if (!h && !u && !d) return "default";
  return [d || "device", h.slice(0, 16) || "host", u || "user"].join(":");
}

export function pluginDataPrefix(scopeId: string, pluginId: string): string {
  return scopeId === "default"
    ? `tarobird.plugin.data.${pluginId}.`
    : `tarobird.plugin.data.${scopeId}.${pluginId}.`;
}

function defaultStorage(): PluginStorageAdapter {
  const mem = new Map<string, string>();
  return {
    getItem(key) {
      try { return globalThis.localStorage?.getItem(key) ?? mem.get(key) ?? null; } catch { return mem.get(key) ?? null; }
    },
    setItem(key, value) {
      mem.set(key, value);
      try { globalThis.localStorage?.setItem(key, value); } catch { /* ignore */ }
    },
    removeItem(key) {
      mem.delete(key);
      try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ }
    },
    keys() {
      try {
        if (globalThis.localStorage) {
          const out: string[] = [];
          for (let i = 0; i < globalThis.localStorage.length; i++) {
            const k = globalThis.localStorage.key(i);
            if (k) out.push(k);
          }
          return out;
        }
      } catch { /* ignore */ }
      return [...mem.keys()];
    },
  };
}

/** Isolated credential vault stored in IndexedDB (never localStorage, never Hub, never synced). */
function defaultCredentialVault(): PluginCredentialVault {
  const mem = new Map<string, string>();
  let dbPromise: Promise<IDBPDatabase> | null = null;
  const getDb = async (): Promise<IDBPDatabase | null> => {
    if (typeof indexedDB === "undefined") return null;
    if (!dbPromise) {
      dbPromise = openDB("tarobird.plugin.credentials.v1", 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains("secrets")) db.createObjectStore("secrets");
        },
      }).catch(() => null as unknown as IDBPDatabase);
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

export class PluginRegistry {
  readonly storage: PluginStorageAdapter;
  readonly credentialVault: PluginCredentialVault;
  private readonly officialPublicKey: string;
  private readonly catalog: PluginCatalogEntry[];
  private readonly fetcher: PluginArtifactFetcher;
  private scopeId: string;
  private state: PluginStoreState;
  private listeners = new Set<() => void>();

  constructor(options?: {
    storage?: PluginStorageAdapter;
    credentialVault?: PluginCredentialVault;
    scopeId?: string;
    officialPublicKey?: string;
    catalog?: readonly PluginCatalogEntry[];
    fetcher?: PluginArtifactFetcher;
  }) {
    this.storage = options?.storage ?? defaultStorage();
    this.credentialVault = options?.credentialVault ?? defaultCredentialVault();
    this.scopeId = options?.scopeId ?? "default";
    this.officialPublicKey = options?.officialPublicKey ?? OFFICIAL_PLUGIN_PUBLIC_KEY;
    this.catalog = [...(options?.catalog ?? [...OFFICIAL_PLUGIN_CATALOG, ...THIRD_PARTY_PLUGIN_CATALOG])];
    this.fetcher = options?.fetcher ?? defaultArtifactFetcher;
    this.state = this.load();
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
  }

  private load(): PluginStoreState {
    const raw = this.storage.getItem(this.storeKey());
    if (!raw) return { allowThirdParty: false, developerMode: false, installed: {} };
    try {
      const parsed = JSON.parse(raw) as Partial<PluginStoreState>;
      const installed: Record<string, InstalledPluginRecord> = {};
      if (parsed.installed && typeof parsed.installed === "object") {
        for (const [id, item] of Object.entries(parsed.installed)) {
          const manifest = pluginManifestSchema.safeParse(item?.manifest);
          if (!manifest.success || manifest.data.id !== id || typeof item?.bundleHtml !== "string") continue;
          installed[id] = {
            manifest: manifest.data,
            bundleHtml: item.bundleHtml,
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

  private save(): void {
    this.storage.setItem(this.storeKey(), JSON.stringify(this.state));
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
    this.state = { ...this.state, allowThirdParty: allow };
    this.save();
  }

  setDeveloperMode(enabled: boolean): void {
    if (this.state.developerMode === enabled) return;
    this.state = { ...this.state, developerMode: enabled };
    this.save();
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
    const record: InstalledPluginRecord = {
      manifest,
      bundleHtml,
      enabled: true,
      installedAt: Date.now(),
      sourceKind: manifest.official ? "official" : "third-party",
      grantedCapabilities: [...manifest.capabilities],
      grantedDomains: [...manifest.domains],
    };
    this.state = {
      ...this.state,
      installed: { ...this.state.installed, [manifest.id]: record },
    };
    this.save();
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
    const record: InstalledPluginRecord = {
      manifest,
      bundleHtml,
      enabled: true,
      installedAt: Date.now(),
      sourceKind: "local-dev",
      grantedCapabilities: [...manifest.capabilities],
      grantedDomains: [...manifest.domains],
    };
    this.state = {
      ...this.state,
      installed: { ...this.state.installed, [manifest.id]: record },
    };
    this.save();
    return record;
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    const existing = this.state.installed[pluginId];
    if (!existing || existing.enabled === enabled) return;
    this.state = {
      ...this.state,
      installed: { ...this.state.installed, [pluginId]: { ...existing, enabled } },
    };
    this.save();
  }

  async uninstall(pluginId: string, options?: { keepData?: boolean }): Promise<void> {
    if (this.state.installed[pluginId]) {
      const next = { ...this.state.installed };
      delete next[pluginId];
      this.state = { ...this.state, installed: next };
      this.save();
    }
    if (options?.keepData === false) {
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
      await this.credentialVault.clearPluginSecrets(this.scopeId, pluginId);
    }
  }

  getPlugin(pluginId: string): InstalledPluginRecord | undefined {
    return this.state.installed[pluginId];
  }
}

export const pluginRegistry = new PluginRegistry();
