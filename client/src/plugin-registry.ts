import "./plugin-crypto.js";
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
  INFINITE_CANVAS_BUNDLE_HTML,
  QUICK_SCRATCHPAD_BUNDLE_HTML,
} from "./plugin-bundles.js";
import { pluginStorageBucketKey } from "./plugin-sandbox-runtime.js";

export const PLUGIN_STORE_KEY = "tarobird.plugins.v1";

/** Ed25519 SPKI public key (base64) used to verify official TaroBird plugin manifests. */
export const OFFICIAL_PLUGIN_PUBLIC_KEY = "MCowBQYDK2VwAyEA7/nusIR2Ti+6dCmyfncq80Vgcxmlx4Cp751ViG3P7vk=";

export type PluginCatalogEntry = {
  manifest: PluginManifest;
  bundleHtml: string;
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
        signature: "CrOt5mvsni3FJga92WxqhQN1Sz8/qBVw5x5+TgqSPuTYADuVZYE3/3jCgPJDtSsg8MoCOf97elk4f7wgnzcxDQ==",
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
        signature: "re5J5vCLSFvJQ4RaRViNYqYcDq9F3TjbvIsxBuWG9OHtbAPeGGNXy5+acNplgr3SK/inA2ZjAsjlCDEM3l8yCQ==",
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
};

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
  };
}

export class PluginRegistry {
  private readonly storage: PluginStorageAdapter;
  private readonly officialPublicKey: string;
  private readonly catalog: PluginCatalogEntry[];
  private state: PluginStoreState;
  private listeners = new Set<() => void>();

  constructor(options?: {
    storage?: PluginStorageAdapter;
    officialPublicKey?: string;
    catalog?: readonly PluginCatalogEntry[];
  }) {
    this.storage = options?.storage ?? defaultStorage();
    this.officialPublicKey = options?.officialPublicKey ?? OFFICIAL_PLUGIN_PUBLIC_KEY;
    this.catalog = [...(options?.catalog ?? [...OFFICIAL_PLUGIN_CATALOG, ...THIRD_PARTY_PLUGIN_CATALOG])];
    this.state = this.load();
  }

  private load(): PluginStoreState {
    const raw = this.storage.getItem(PLUGIN_STORE_KEY);
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
    this.storage.setItem(PLUGIN_STORE_KEY, JSON.stringify(this.state));
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

  async install(entry: PluginCatalogEntry): Promise<InstalledPluginRecord> {
    const manifest = pluginManifestSchema.parse(entry.manifest);
    if (!manifest.official && !this.state.allowThirdParty) {
      throw new Error("plugin_third_party_disabled");
    }
    const actualSizeBytes = new TextEncoder().encode(entry.bundleHtml).byteLength;
    if (actualSizeBytes !== manifest.artifact.sizeBytes) {
      throw new Error("plugin_size_mismatch");
    }
    const hashOk = await verifyPluginArtifactHash(entry.bundleHtml, manifest.artifact.sha256);
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
    const record: InstalledPluginRecord = {
      manifest,
      bundleHtml: entry.bundleHtml,
      enabled: true,
      installedAt: Math.max(Date.now(), (previous?.installedAt ?? 0) + 1),
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

  uninstall(pluginId: string): void {
    if (!this.state.installed[pluginId]) return;
    const next = { ...this.state.installed };
    delete next[pluginId];
    this.state = { ...this.state, installed: next };
    this.storage.removeItem(pluginStorageBucketKey(pluginId));
    this.save();
  }

  getPlugin(pluginId: string): InstalledPluginRecord | undefined {
    return this.state.installed[pluginId];
  }
}

export const pluginRegistry = new PluginRegistry();
