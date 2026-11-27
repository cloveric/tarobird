import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_PLUGIN_PUBLIC_KEY as PROTOCOL_OFFICIAL_PUBLIC_KEY,
  PLUGIN_HOST_PROTOCOL,
  canonicalPluginSignaturePayload,
  comparePluginVersions,
  pluginManifestSchema,
  sha256Hex,
  verifyOfficialPluginSignature,
  verifyPluginArtifactHash,
} from "../src/client-protocol/plugins.js";
import {
  OFFICIAL_PLUGIN_CATALOG,
  OFFICIAL_PLUGIN_PUBLIC_KEY,
  PLUGIN_STORE_KEY,
  PluginRegistry,
  THIRD_PARTY_PLUGIN_CATALOG,
  createDefaultPluginStorage,
  getPluginRegistry,
  pluginScopeId,
  resolvePluginScopeId,
  type PluginBundleStore,
  type PluginCatalogEntry,
  type PluginStorageAdapter,
} from "../client/src/plugin-registry.js";
import {
  MAX_PLUGIN_STORAGE_BYTES,
  MAX_PLUGIN_STORAGE_KEYS,
  PLUGIN_SANDBOX_BOOTSTRAP_SCRIPT,
  PLUGIN_SANDBOX_WEBRTC_GLOBALS,
  buildPluginCsp,
  handlePluginHostMessage,
  pluginStorageBucketKey,
  resolvePluginTheme,
  sanitizePluginDomain,
  wrapSandboxedDocument,
} from "../client/src/plugin-sandbox-runtime.js";
import {
  matchesPluginMarketplaceQuery,
  pluginMarketplaceCategory,
  pluginPublisherLabel,
  selectLocalEntryFile,
  selectLocalManifestFile,
} from "../client/src/plugin-marketplace.js";
import { INFINITE_CANVAS_BUNDLE_HTML } from "../client/src/plugin-bundles.js";

function memoryStorage(): PluginStorageAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
    keys: () => [...data.keys()],
  };
}

function memoryBundleStore(): PluginBundleStore & {
  bundles: Map<string, string>;
  kvData: Map<string, string>;
} {
  const bundles = new Map<string, string>();
  const kvData = new Map<string, string>();
  return {
    bundles,
    kvData,
    async getBundle(scopeId, pluginId) {
      return bundles.get(`${scopeId}\0${pluginId}`) ?? null;
    },
    async putBundle(scopeId, pluginId, html) {
      bundles.set(`${scopeId}\0${pluginId}`, html);
      return true;
    },
    async deleteBundle(scopeId, pluginId) {
      bundles.delete(`${scopeId}\0${pluginId}`);
    },
    kv: {
      async get(scopeId, pluginId, key) {
        return kvData.get(`${scopeId}\0${pluginId}\0${key}`) ?? null;
      },
      async set(scopeId, pluginId, key, value) {
        kvData.set(`${scopeId}\0${pluginId}\0${key}`, value);
      },
      async remove(scopeId, pluginId, key) {
        kvData.delete(`${scopeId}\0${pluginId}\0${key}`);
      },
      async list(scopeId, pluginId) {
        const prefix = `${scopeId}\0${pluginId}\0`;
        const out: Record<string, string> = {};
        for (const [k, v] of kvData.entries()) {
          if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
        }
        return out;
      },
      async clear(scopeId, pluginId) {
        const prefix = `${scopeId}\0${pluginId}\0`;
        for (const k of [...kvData.keys()]) {
          if (k.startsWith(prefix)) kvData.delete(k);
        }
      },
    },
  };
}

/** Explicit test-only third-party catalog fixture (never shipped in production THIRD_PARTY_PLUGIN_CATALOG). */
async function createTestThirdPartyFixture(): Promise<PluginCatalogEntry> {
  const bundleHtml = "<!doctype html><html><body><h1>Test Community Widget</h1></body></html>";
  return {
    manifest: pluginManifestSchema.parse({
      schemaVersion: 1,
      id: "test.third-party-fixture",
      name: "Test Community Widget",
      nameZh: "测试社区组件",
      version: "1.0.0",
      description: "Test-only third-party plugin fixture for unit tests.",
      descriptionZh: "仅用于单元测试的第三方插件示例。",
      icon: "puzzle",
      source: { repository: "example/test-third-party-fixture", commit: "0123456" },
      artifact: {
        sha256: await sha256Hex(bundleHtml),
        sizeBytes: new TextEncoder().encode(bundleHtml).byteLength,
      },
      entry: "dist/index.html",
      platforms: ["desktop", "phone"],
      contributions: [
        { kind: "side-panel", id: "test-fixture", title: "Test Fixture", titleZh: "测试组件", icon: "puzzle" },
      ],
      domains: ["api.example.com"],
      capabilities: ["theme.read"],
      requiresHost: false,
      official: false,
    }),
    bundleHtml,
  };
}

describe("Plugin manifest, integrity and registry (#101)", () => {
  it("lists Infinite Canvas as an official desktop-only plugin, hides it on phone, and keeps third-party catalog clean", () => {
    expect(THIRD_PARTY_PLUGIN_CATALOG).toEqual([]);
    expect(OFFICIAL_PLUGIN_CATALOG.some((item) => item.manifest.id === "community.focus-timer")).toBe(false);
    expect(OFFICIAL_PLUGIN_PUBLIC_KEY).toBe(PROTOCOL_OFFICIAL_PUBLIC_KEY);

    const registry = new PluginRegistry({ storage: memoryStorage() });
    const desktopIds = registry.catalogForPlatform("desktop").map((item) => item.manifest.id);
    const phoneIds = registry.catalogForPlatform("phone").map((item) => item.manifest.id);

    expect(desktopIds).toContain("tarobird.infinite-canvas");
    expect(desktopIds).toContain("tarobird.quick-scratchpad");
    expect(desktopIds).not.toContain("community.focus-timer");
    expect(phoneIds).not.toContain("tarobird.infinite-canvas");
    expect(phoneIds).toContain("tarobird.quick-scratchpad");
  });

  it("installs, enables, disables, updates and uninstalls Infinite Canvas end-to-end with verified hash & signature", async () => {
    const store = memoryStorage();
    const registry = new PluginRegistry({ storage: store });
    const infiniteCanvas = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!;

    expect(await verifyPluginArtifactHash(infiniteCanvas.bundleHtml!, infiniteCanvas.manifest.artifact.sha256)).toBe(true);
    expect(await verifyOfficialPluginSignature(infiniteCanvas.manifest, OFFICIAL_PLUGIN_PUBLIC_KEY)).toBe(true);

    const installed = await registry.install(infiniteCanvas);
    expect(installed.enabled).toBe(true);
    expect(registry.enabledContributions("desktop", "workbench-item").map((item) => item.plugin.manifest.id)).toEqual(["tarobird.infinite-canvas"]);

    // Store plugin KV data and verify uninstall cleans it up
    await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "s1", method: "storage.set", key: "canvas-v1", value: "SECRET_CANVAS" },
      { pluginId: "tarobird.infinite-canvas", grantedCapabilities: ["storage.device"], theme: "light", locale: "en", storage: store },
    );
    expect(store.data.has(pluginStorageBucketKey("tarobird.infinite-canvas"))).toBe(true);

    // Disable removes it from Workbench contributions without losing installation
    registry.setEnabled("tarobird.infinite-canvas", false);
    expect(registry.enabledContributions("desktop", "workbench-item")).toEqual([]);
    expect(registry.getPlugin("tarobird.infinite-canvas")?.enabled).toBe(false);

    // Re-enable restores it
    registry.setEnabled("tarobird.infinite-canvas", true);
    expect(registry.enabledContributions("desktop", "workbench-item")).toHaveLength(1);

    // Persists across device reload
    const reloaded = new PluginRegistry({ storage: store });
    expect(reloaded.getPlugin("tarobird.infinite-canvas")?.enabled).toBe(true);

    // Uninstall keeping data preserves isolated storage bucket
    await reloaded.uninstall("tarobird.infinite-canvas", { keepData: true });
    expect(reloaded.getPlugin("tarobird.infinite-canvas")).toBeUndefined();
    expect(store.data.has(pluginStorageBucketKey("tarobird.infinite-canvas"))).toBe(true);

    // Reinstall and uninstall without keeping data deletes isolated storage bucket
    await reloaded.install(infiniteCanvas);
    await reloaded.uninstall("tarobird.infinite-canvas");
    expect(reloaded.getPlugin("tarobird.infinite-canvas")).toBeUndefined();
    expect(reloaded.enabledContributions("desktop", "workbench-item")).toEqual([]);
    expect(store.data.has(pluginStorageBucketKey("tarobird.infinite-canvas"))).toBe(false);
  });

  it("verifies all catalog bundles including exact UTF-8 sizeBytes and full signed manifest metadata", async () => {
    const registry = new PluginRegistry({ storage: memoryStorage() });
    registry.setAllowThirdParty(true);
    for (const entry of [...OFFICIAL_PLUGIN_CATALOG, ...THIRD_PARTY_PLUGIN_CATALOG]) {
      expect(entry.bundleHtml).toBeDefined();
      expect(new TextEncoder().encode(entry.bundleHtml!).byteLength).toBe(entry.manifest.artifact.sizeBytes);
      expect(await verifyPluginArtifactHash(entry.bundleHtml!, entry.manifest.artifact.sha256)).toBe(true);
      if (entry.manifest.official) {
        expect(await verifyOfficialPluginSignature(entry.manifest, OFFICIAL_PLUGIN_PUBLIC_KEY)).toBe(true);
      }
      await expect(registry.install(entry)).resolves.toMatchObject({ enabled: true });
    }
  });

  it("blocks installation when sizeBytes, SHA-256 hash, or any signed official manifest field is tampered", async () => {
    const registry = new PluginRegistry({ storage: memoryStorage() });
    const infiniteCanvas = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!;

    // Wrong declared sizeBytes -> blocked before install!
    await expect(registry.install({
      manifest: {
        ...infiniteCanvas.manifest,
        artifact: {
          ...infiniteCanvas.manifest.artifact,
          sizeBytes: infiniteCanvas.manifest.artifact.sizeBytes + 1,
        },
      },
      bundleHtml: infiniteCanvas.bundleHtml,
    })).rejects.toThrow("plugin_size_mismatch");

    // Same byte length but tampered bundle payload -> hash mismatch blocked!
    const sameLenTampered = `<!--x-->${infiniteCanvas.bundleHtml!.slice(8)}`;
    expect(new TextEncoder().encode(sameLenTampered).byteLength).toBe(infiniteCanvas.manifest.artifact.sizeBytes);
    await expect(registry.install({
      manifest: infiniteCanvas.manifest,
      bundleHtml: sameLenTampered,
    })).rejects.toThrow("plugin_hash_mismatch");

    // Valid hash & sizeBytes but forged/tampered official signature -> signature invalid blocked!
    const alteredHtml = "<!doctype html><html><body>forged official</body></html>";
    const alteredHash = await sha256Hex(alteredHtml);
    await expect(registry.install({
      manifest: {
        ...infiniteCanvas.manifest,
        artifact: {
          sha256: alteredHash,
          sizeBytes: new TextEncoder().encode(alteredHtml).byteLength,
          signature: infiniteCanvas.manifest.artifact.signature,
        },
      },
      bundleHtml: alteredHtml,
    })).rejects.toThrow("plugin_signature_invalid");

    // Tampering with name, description, icon, or contributions MUST invalidate the Ed25519 signature!
    const tamperedManifests = [
      { ...infiniteCanvas.manifest, name: "Spoofed Canvas" },
      { ...infiniteCanvas.manifest, nameZh: "伪造画布" },
      { ...infiniteCanvas.manifest, description: "Tampered description" },
      { ...infiniteCanvas.manifest, descriptionZh: "伪造说明" },
      { ...infiniteCanvas.manifest, icon: "code" as const },
      {
        ...infiniteCanvas.manifest,
        contributions: [{ kind: "side-panel" as const, id: "infinite-canvas", title: "Spoofed Panel" }],
      },
    ];
    for (const tampered of tamperedManifests) {
      expect(await verifyOfficialPluginSignature(tampered, OFFICIAL_PLUGIN_PUBLIC_KEY)).toBe(false);
      await expect(registry.install({ manifest: tampered, bundleHtml: infiniteCanvas.bundleHtml })).rejects.toThrow("plugin_signature_invalid");
    }
  });

  it("verifies SHA-256 and Ed25519 without globalThis.crypto.subtle (plain-HTTP LAN / legacy WebViews)", async () => {
    const infiniteCanvas = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const originalCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true, writable: true });
      expect(globalThis.crypto.subtle).toBeUndefined();
      expect(await verifyPluginArtifactHash(infiniteCanvas.bundleHtml!, infiniteCanvas.manifest.artifact.sha256)).toBe(true);
      expect(await verifyOfficialPluginSignature(infiniteCanvas.manifest, OFFICIAL_PLUGIN_PUBLIC_KEY)).toBe(true);
      const registry = new PluginRegistry({ storage: memoryStorage() });
      const installed = await registry.install(infiniteCanvas);
      expect(installed.sourceKind).toBe("official");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
      else Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true, writable: true });
    }
  });

  it("keeps third-party plugins disabled by default and allows test-fixture installation only after opt-in", async () => {
    const thirdParty = await createTestThirdPartyFixture();
    const registry = new PluginRegistry({
      storage: memoryStorage(),
      catalog: [...OFFICIAL_PLUGIN_CATALOG, thirdParty],
    });

    expect(registry.getSnapshot().allowThirdParty).toBe(false);
    await expect(registry.install(thirdParty)).rejects.toThrow("plugin_third_party_disabled");

    registry.setAllowThirdParty(true);
    const installed = await registry.install(thirdParty);
    expect(installed.sourceKind).toBe("third-party");
    expect(installed.grantedDomains).toEqual(["api.example.com"]);
    expect(registry.enabledContributions("phone", "side-panel").map((c) => c.plugin.manifest.id)).toContain(thirdParty.manifest.id);
  });

  it("requires two-step prepareLocalDev review before install and grants only reviewed capabilities and sanitized public domains", async () => {
    const store = memoryStorage();
    const registry = new PluginRegistry({ storage: store });
    const html = "<!doctype html><html><body>Dev Plugin</body></html>";
    const manifestJson = JSON.stringify({
      schemaVersion: 1,
      id: "dev.local-demo",
      name: "Local Demo",
      version: "0.1.0",
      description: "Local dev plugin",
      icon: "code",
      source: { repository: "local/demo", commit: "1234567" },
      entry: "index.html",
      platforms: ["desktop"],
      contributions: [{ kind: "side-panel", id: "demo", title: "Demo" }],
      domains: ["api.example.com", "127.0.0.1", "localhost", "192.168.1.5"],
      capabilities: ["theme.read", "storage.device"],
      requiresHost: false,
      official: false,
    });

    await expect(registry.prepareLocalDev(manifestJson, html)).rejects.toThrow("plugin_developer_mode_disabled");
    await expect(registry.installLocalDev(manifestJson, html)).rejects.toThrow("plugin_developer_mode_disabled");

    registry.setDeveloperMode(true);

    // Step 1: prepareLocalDev validates without installing or mutating storage (simulating user opening review & clicking Cancel)
    const prepared = await registry.prepareLocalDev(manifestJson, html);
    expect(prepared.manifest.id).toBe("dev.local-demo");
    expect(prepared.manifest.artifact.sha256).toBe(await sha256Hex(html));
    expect(prepared.sanitizedDomains).toEqual(["api.example.com"]);
    expect(prepared.blockedDomains).toEqual(["127.0.0.1", "localhost", "192.168.1.5"]);
    expect(registry.getPlugin("dev.local-demo")).toBeUndefined();
    expect(JSON.parse(store.getItem(PLUGIN_STORE_KEY)!).installed).toEqual({});

    // Disabling developer mode before confirming blocks installation
    registry.setDeveloperMode(false);
    await expect(registry.installPreparedLocalDev(prepared)).rejects.toThrow("plugin_developer_mode_disabled");
    expect(registry.getPlugin("dev.local-demo")).toBeUndefined();
    registry.setDeveloperMode(true);

    // Tampering with bundleHtml between review and confirm is rejected
    await expect(registry.installPreparedLocalDev({ ...prepared, bundleHtml: `${html}<!-- tampered -->` })).rejects.toThrow("plugin_size_mismatch");
    expect(registry.getPlugin("dev.local-demo")).toBeUndefined();

    // Step 2: Confirm grants ONLY reviewed capabilities (intersected with manifest) & valid public domains
    const first = await registry.installPreparedLocalDev(prepared, {
      grantedCapabilities: ["theme.read", "clipboard.write"],
      grantedDomains: ["api.example.com", "127.0.0.1", "unlisted.example.com"],
    });
    expect(first.sourceKind).toBe("local-dev");
    expect(first.grantedCapabilities).toEqual(["theme.read"]);
    expect(first.grantedDomains).toEqual(["api.example.com"]);
    expect(first.manifest.artifact.sha256).toBe(await sha256Hex(html));

    // Reloading same version bumps installedAt so PluginSandboxFrame remounts cleanly
    const second = await registry.installLocalDev(manifestJson, `${html}<!-- v2 -->`);
    expect(second.installedAt).toBeGreaterThan(first.installedAt);
    expect(second.grantedDomains).toEqual(["api.example.com"]);

    // Reject if a declared SHA-256 in local manifest doesn't match the bundle
    const badManifest = JSON.stringify({ ...JSON.parse(manifestJson), artifact: { sha256: "0".repeat(64), sizeBytes: 10 } });
    await expect(registry.prepareLocalDev(badManifest, html)).rejects.toThrow("plugin_hash_mismatch");

    // Reject official / reserved tarobird.* plugin IDs in local-dev
    const hijackManifest = JSON.stringify({ ...JSON.parse(manifestJson), id: "tarobird.infinite-canvas" });
    await expect(registry.prepareLocalDev(hijackManifest, html)).rejects.toThrow("plugin_official_id_reserved");
    const reservedPrefixManifest = JSON.stringify({ ...JSON.parse(manifestJson), id: "tarobird.custom-spoof" });
    await expect(registry.prepareLocalDev(reservedPrefixManifest, html)).rejects.toThrow("plugin_official_id_reserved");
  });

  it("scopes registry & KV storage per (device, host, user), migrates legacy unscoped installs and inline bundles without loss", async () => {
    expect(resolvePluginScopeId("host_alpha", undefined, "dev_1")).toBeNull();
    expect(resolvePluginScopeId("host_alpha", "", "dev_1")).toBeNull();
    expect(resolvePluginScopeId(undefined, undefined, undefined)).toBe("default");
    const scopeA = resolvePluginScopeId("host_alpha_1234567890", "user_a", "dev_1")!;
    const scopeB = resolvePluginScopeId("host_beta_1234567890", "user_b", "dev_1")!;
    expect(scopeA).toBe(pluginScopeId("host_alpha_1234567890", "user_a", "dev_1"));
    expect(scopeA).not.toBe(scopeB);

    // Seed a legacy unscoped #141 install + legacy unscoped KV bucket
    const store = memoryStorage();
    const scratchpad = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.quick-scratchpad")!;
    const legacyRegistry = new PluginRegistry({ storage: store });
    await legacyRegistry.install(scratchpad);
    await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "m1", method: "storage.set", key: "text", value: "LEGACY_NOTE" },
      { pluginId: "tarobird.quick-scratchpad", grantedCapabilities: ["storage.device"], theme: "light", locale: "en", storage: store },
    );
    expect(store.data.has(PLUGIN_STORE_KEY)).toBe(true);
    expect(store.data.has(pluginStorageBucketKey("tarobird.quick-scratchpad"))).toBe(true);

    // Opening scoped registry for scopeA migrates legacy install + KV cleanly, then removes legacy key
    const bundleStore = memoryBundleStore();
    const migratedA = new PluginRegistry({ storage: store, bundleStore, scopeId: scopeA });
    expect(migratedA.getPlugin("tarobird.quick-scratchpad")?.enabled).toBe(true);
    expect(migratedA.getPlugin("tarobird.quick-scratchpad")?.bundleHtml).toBe(scratchpad.bundleHtml);
    expect(store.data.has(PLUGIN_STORE_KEY)).toBe(false);
    expect(store.data.has(`${PLUGIN_STORE_KEY}.${scopeA}`)).toBe(true);
    expect(store.data.has(pluginStorageBucketKey("tarobird.quick-scratchpad", scopeA))).toBe(true);
    expect(store.data.has(pluginStorageBucketKey("tarobird.quick-scratchpad"))).toBe(false);

    // Wait for async inline -> IDB compaction
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bundleStore.bundles.get(`${scopeA}\0tarobird.quick-scratchpad`)).toBe(scratchpad.bundleHtml);
    const compacted = JSON.parse(store.getItem(`${PLUGIN_STORE_KEY}.${scopeA}`)!);
    expect(compacted.installed["tarobird.quick-scratchpad"].bundleStoredInIdb).toBe(true);
    expect(compacted.installed["tarobird.quick-scratchpad"].bundleHtml).toBe("");

    // Reloading scoped registry hydrates bundleHtml from IDB and still reads migrated KV note
    const reloadedA = new PluginRegistry({ storage: store, bundleStore, scopeId: scopeA });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reloadedA.getPlugin("tarobird.quick-scratchpad")?.bundleHtml).toBe(scratchpad.bundleHtml);
    const kvRead = await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "m2", method: "storage.get", key: "text" },
      { pluginId: "tarobird.quick-scratchpad", scopeId: scopeA, grantedCapabilities: ["storage.device"], theme: "light", locale: "en", storage: store, kvStore: bundleStore.kv },
    );
    expect(kvRead).toMatchObject({ ok: true, result: "LEGACY_NOTE" });

    // Second scopeB remains completely isolated (no leakage of migrated legacy installs)
    const regB = new PluginRegistry({ storage: store, bundleStore, scopeId: scopeB });
    expect(regB.getPlugin("tarobird.quick-scratchpad")).toBeUndefined();

    // Concurrent cached scoped registries via getPluginRegistry stay isolated
    const cachedA = getPluginRegistry(scopeA);
    const cachedB = getPluginRegistry(scopeB);
    expect(cachedA).not.toBe(cachedB);
    cachedA.setAllowThirdParty(true);
    expect(cachedB.getSnapshot().allowThirdParty).toBe(false);
    cachedA.setAllowThirdParty(false);
  });

  it("propagates QuotaExceededError instead of silently masking failed persistence", () => {
    const throwingStorage: PluginStorageAdapter = {
      getItem: () => null,
      setItem: () => {
        const err = new Error("quota exceeded");
        err.name = "QuotaExceededError";
        throw err;
      },
      removeItem: () => {},
    };
    const registry = new PluginRegistry({ storage: throwingStorage });
    expect(() => registry.setAllowThirdParty(true)).toThrow("quota exceeded");
    expect(registry.getSnapshot().allowThirdParty).toBe(false);

    const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: () => null,
          setItem: () => { const e = new Error("disk full"); e.name = "QuotaExceededError"; throw e; },
          removeItem: () => {},
          length: 0,
          key: () => null,
        },
      });
      const def = createDefaultPluginStorage();
      expect(() => def.setItem("k", "v")).toThrow("disk full");
      expect(def.getItem("k")).toBeNull();
    } finally {
      if (origDescriptor) Object.defineProperty(globalThis, "localStorage", origDescriptor);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("detects newer catalog versions and same-version official artifact digest upgrades", async () => {
    expect(comparePluginVersions("1.1.0", "1.0.0")).toBe(1);
    expect(comparePluginVersions("1.0.0", "1.0.0")).toBe(0);
    expect(comparePluginVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(canonicalPluginSignaturePayload(OFFICIAL_PLUGIN_CATALOG[0]!.manifest)).toContain("tarobird/plugin-manifest/v1");

    const store = memoryStorage();
    const initial = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!;
    const regV1 = new PluginRegistry({ storage: store, catalog: [initial] });
    await regV1.install(initial);

    // Simulate #176 replacing the same-version 1.0.0 official Infinite Canvas artifact with a new digest
    const upgradedCatalogEntry: PluginCatalogEntry = {
      manifest: {
        ...initial.manifest,
        artifact: {
          ...initial.manifest.artifact,
          sha256: "a".repeat(64),
          url: "/api/plugins/artifacts/tarobird.infinite-canvas/1.0.0/bundle.html",
        },
      },
    };
    const regUpgraded = new PluginRegistry({ storage: store, catalog: [upgradedCatalogEntry] });
    expect(regUpgraded.hasUpdate("tarobird.infinite-canvas")?.manifest.artifact.sha256).toBe("a".repeat(64));
  });

  it("rejects path traversal entries in manifest validation", () => {
    expect(() => pluginManifestSchema.parse({
      ...OFFICIAL_PLUGIN_CATALOG[0]!.manifest,
      entry: "../escape.html",
    })).toThrow();
  });
});

describe("Plugin sandbox Host API capability gating, storage isolation and error safety (#101)", () => {
  it("allows only granted capabilities and blocks unauthorized storage/clipboard/Hub API calls", async () => {
    const store = memoryStorage();
    const baseCtx = {
      pluginId: "test.third-party-fixture",
      grantedCapabilities: ["theme.read"] as const,
      theme: "dark" as const,
      locale: "zh",
      storage: store,
    };

    const hello = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "1", method: "host.hello" }, baseCtx);
    expect(hello).toMatchObject({ ok: true, result: { pluginId: "test.third-party-fixture", theme: "dark", locale: "zh" } });
    const theme = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "2", method: "theme.get" }, baseCtx);
    expect(theme).toMatchObject({ ok: true, result: { theme: "dark" } });

    const deniedStorage = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "3", method: "storage.set", key: "k", value: "v" }, baseCtx);
    expect(deniedStorage).toMatchObject({ ok: false, error: "capability_denied" });
    const deniedClip = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "4", method: "clipboard.write", text: "hi" }, baseCtx);
    expect(deniedClip).toMatchObject({ ok: false, error: "capability_denied" });

    const deniedHub = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "5", method: "hub.fetch", path: "/api/devices" }, baseCtx);
    expect(deniedHub).toMatchObject({ ok: false, error: "method_not_allowed" });

    // Granted storage writes into unambiguous per-plugin bucket
    const grantedStorage = await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "6", method: "storage.set", key: "note", value: "hello" },
      { ...baseCtx, grantedCapabilities: ["storage.device"] },
    );
    expect(grantedStorage).toMatchObject({ ok: true });
    expect(store.data.get(pluginStorageBucketKey("test.third-party-fixture"))).toBe(JSON.stringify({ note: "hello" }));
  });

  it("prevents cross-plugin storage prefix collisions and prototype key escapes", async () => {
    const store = memoryStorage();
    const officialCtx = {
      pluginId: "tarobird.infinite-canvas",
      grantedCapabilities: ["storage.device"] as const,
      theme: "light" as const,
      locale: "en",
      storage: store,
    };
    const attackerCtx = {
      pluginId: "tarobird",
      grantedCapabilities: ["storage.device"] as const,
      theme: "light" as const,
      locale: "en",
      storage: store,
    };

    await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "w1", method: "storage.set", key: "canvas-v1", value: "SECRET_CANVAS_DATA" }, officialCtx);

    // Prefix-collision attack must return null and cannot overwrite or delete official data
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "r1", method: "storage.get", key: "infinite-canvas.canvas-v1" }, attackerCtx))
      .toMatchObject({ ok: true, result: null });
    await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "w2", method: "storage.set", key: "infinite-canvas.canvas-v1", value: "POISONED" }, attackerCtx);
    await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "d1", method: "storage.remove", key: "infinite-canvas.canvas-v1" }, attackerCtx);

    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "r2", method: "storage.get", key: "canvas-v1" }, officialCtx))
      .toMatchObject({ ok: true, result: "SECRET_CANVAS_DATA" });

    // Prototype keys never return Object.prototype properties
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "p1", method: "storage.get", key: "toString" }, officialCtx))
      .toMatchObject({ ok: true, result: null });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "p2", method: "storage.get", key: "__proto__" }, officialCtx))
      .toMatchObject({ ok: true, result: null });
  });

  it("enforces per-plugin key/byte quotas and returns structured errors on storage/clipboard failures", async () => {
    const store = memoryStorage();
    const ctx = {
      pluginId: "test.quota-fixture",
      grantedCapabilities: ["storage.device", "clipboard.write"] as const,
      theme: "light" as const,
      locale: "en",
      storage: store,
    };

    // Exceed key count limit
    for (let i = 0; i < MAX_PLUGIN_STORAGE_KEYS; i++) {
      const res = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: `k${i}`, method: "storage.set", key: `k${i}`, value: "v" }, ctx);
      expect(res?.ok).toBe(true);
    }
    const overKeyLimit = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "k_over", method: "storage.set", key: "overflow", value: "v" }, ctx);
    expect(overKeyLimit).toMatchObject({ ok: false, error: "storage_quota_exceeded" });

    // Exceed total byte limit
    const bigStore = memoryStorage();
    const bigCtx = { ...ctx, storage: bigStore };
    const chunk = "a".repeat(200 * 1024);
    expect((await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "b1", method: "storage.set", key: "a", value: chunk }, bigCtx))?.ok).toBe(true);
    expect((await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "b2", method: "storage.set", key: "b", value: chunk }, bigCtx))?.ok).toBe(true);
    const overByteLimit = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "b3", method: "storage.set", key: "c", value: chunk }, bigCtx);
    expect(overByteLimit).toMatchObject({ ok: false, error: "storage_quota_exceeded" });
    expect(MAX_PLUGIN_STORAGE_BYTES).toBe(512 * 1024);

    // Underlying storage QuotaExceededError returns ok: false instead of throwing
    const throwingStorage: PluginStorageAdapter = {
      getItem: () => null,
      setItem: () => { const err = new Error("quota"); err.name = "QuotaExceededError"; throw err; },
      removeItem: () => {},
    };
    const quotaResp = await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "q1", method: "storage.set", key: "a", value: "1" },
      { ...ctx, storage: throwingStorage },
    );
    expect(quotaResp).toMatchObject({ ok: false, error: "storage_quota_exceeded" });

    // Clipboard rejection returns ok: false instead of unhandled rejection
    const clipResp = await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "c1", method: "clipboard.write", text: "hi" },
      { ...ctx, writeClipboard: async () => { throw new Error("NotAllowedError"); } },
    );
    expect(clipResp).toMatchObject({ ok: false, error: "clipboard_write_failed" });
  });
});

describe("Plugin CSP wrapping, WebRTC hardening, domain filtering and theme resolution (#101)", () => {
  it("rejects loopback, private LAN, CGNAT, link-local, and local hostnames while allowing public HTTPS domains", () => {
    for (const bad of [
      "localhost",
      "localhost:8787",
      "sub.localhost",
      "127.0.0.1",
      "127.0.0.1:8787",
      "127.1",
      "0177.0.0.1",
      "2130706433",
      "192.168.1.5",
      "10.0.0.1",
      "172.16.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "macmini",
      "device.local",
      "service.internal",
      "box.lan",
      "host.home.arpa",
      "*.example.com",
      "https://example.com",
      "user@example.com",
    ]) {
      expect(sanitizePluginDomain(bad), bad).toBeNull();
    }
    expect(sanitizePluginDomain("api.example.com")).toBe("api.example.com");
    expect(sanitizePluginDomain("cdn.example.org:8443")).toBe("cdn.example.org:8443");
    const csp = buildPluginCsp(["127.0.0.1", "localhost", "192.168.1.10", "api.example.com"]);
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("connect-src https://api.example.com wss://api.example.com;");
    expect(csp).not.toContain("127.0.0.1");
    expect(csp).not.toContain("localhost");
    expect(csp).not.toContain("192.168.1.10");
  });

  it("injects host CSP and WebRTC-disabling bootstrap into real <head> before any plugin script", () => {
    expect(PLUGIN_SANDBOX_WEBRTC_GLOBALS).toContain("RTCPeerConnection");
    expect(PLUGIN_SANDBOX_WEBRTC_GLOBALS).toContain("webkitRTCPeerConnection");
    expect(PLUGIN_SANDBOX_WEBRTC_GLOBALS).toContain("RTCDataChannel");
    expect(PLUGIN_SANDBOX_BOOTSTRAP_SCRIPT).toContain("writable:false,configurable:false");

    const commented = "<!-- <head> --><html><head><title>X</title></head><body>hi</body></html>";
    const wrappedCommented = wrapSandboxedDocument(commented, ["api.example.com"]);
    expect(wrappedCommented).not.toContain("<!-- <head> --><meta");
    expect(wrappedCommented).toMatch(
      /<head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="[^"]*connect-src https:\/\/api\.example\.com wss:\/\/api\.example\.com[^"]*"><script>/,
    );

    const preHeadScript = "<script>window.__pluginRan=1;fetch('https://evil.example')</script><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"></head><body>x</body>";
    const wrappedScript = wrapSandboxedDocument(preHeadScript, []);
    const cspIdx = wrappedScript.indexOf('http-equiv="Content-Security-Policy"');
    const bootstrapIdx = wrappedScript.indexOf("RTCPeerConnection");
    const pluginScriptIdx = wrappedScript.indexOf("window.__pluginRan=1");
    expect(cspIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeGreaterThan(cspIdx);
    expect(pluginScriptIdx).toBeGreaterThan(bootstrapIdx);
    expect(wrappedScript).not.toContain("default-src *");
    expect(wrappedScript).toContain("connect-src 'none'");
    expect(wrappedScript).toContain("worker-src 'none'");
  });

  it("keeps outer plugin-sandbox.html meta CSP and WebRTC bootstrap lockdown aligned", async () => {
    const shell = await readFile("client/public/plugin-sandbox.html", "utf8");
    expect(shell).toContain("connect-src https: wss:");
    expect(shell).toContain("worker-src 'none'");
    expect(shell).toContain('sandbox="allow-scripts"');
    expect(shell).not.toContain("allow-same-origin");
    expect(shell).toContain("RTCPeerConnection");
    expect(shell).toContain("webkitRTCPeerConnection");
    expect(shell).toContain("RTCDataChannel");
  });

  it("does not let OS dark mode override explicit Light theme", () => {
    const makeRoot = (theme: string | undefined) => ({
      dataset: theme === undefined ? {} : { theme },
      classList: { contains: () => false },
    }) as unknown as HTMLElement;
    expect(resolvePluginTheme(makeRoot("light"), true)).toBe("light");
    expect(resolvePluginTheme(makeRoot("dark"), false)).toBe("dark");
    expect(resolvePluginTheme(makeRoot("system"), true)).toBe("dark");
    expect(resolvePluginTheme(makeRoot("system"), false)).toBe("light");
  });
});

describe("Plugin Marketplace categorization, filtering and local folder selection (#101)", () => {
  it("classifies official workbench, productivity and third-party plugins and matches search queries", async () => {
    const canvas = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!.manifest;
    const notes = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.quick-scratchpad")!.manifest;
    const community = (await createTestThirdPartyFixture()).manifest;

    expect(pluginMarketplaceCategory(canvas)).toBe("workbench");
    expect(pluginMarketplaceCategory(notes)).toBe("productivity");
    expect(pluginMarketplaceCategory(community)).toBe("community");

    expect(pluginPublisherLabel(canvas)).toBe("TaroBird");
    expect(pluginPublisherLabel(community)).toBe("example");
    expect(pluginPublisherLabel(canvas, "local-dev")).not.toBe("TaroBird");

    expect(matchesPluginMarketplaceQuery(canvas, "无限画布")).toBe(true);
    expect(matchesPluginMarketplaceQuery(canvas, "tarobird")).toBe(true);
    expect(matchesPluginMarketplaceQuery(canvas, "test community")).toBe(false);
    expect(matchesPluginMarketplaceQuery(community, "测试社区组件")).toBe(true);
  });

  it("selects top-level manifest.json and exact relative entry HTML when loading a local folder", () => {
    const files = [
      { name: "manifest.json", webkitRelativePath: "my-plugin/node_modules/dep/manifest.json" },
      { name: "index.html", webkitRelativePath: "my-plugin/index.html" },
      { name: "manifest.json", webkitRelativePath: "my-plugin/manifest.json" },
      { name: "index.html", webkitRelativePath: "my-plugin/dist/index.html" },
    ];
    const manifest = selectLocalManifestFile(files);
    expect(manifest?.webkitRelativePath).toBe("my-plugin/manifest.json");
    const entry = selectLocalEntryFile(files, manifest!, "dist/index.html");
    expect(entry.file?.webkitRelativePath).toBe("my-plugin/dist/index.html");

    // When dist/index.html is missing, never fall back to root index.html
    const missingDist = files.filter((f) => f.webkitRelativePath !== "my-plugin/dist/index.html");
    expect(selectLocalEntryFile(missingDist, manifest!, "dist/index.html").file).toBeUndefined();

    // Nested manifest.json alone is not selected
    expect(selectLocalManifestFile([files[0]!])).toBeUndefined();
  });

  it("preserves pointer capture and cancel handling in Infinite Canvas bundle", () => {
    expect(INFINITE_CANVAS_BUNDLE_HTML).toContain("setPointerCapture");
    expect(INFINITE_CANVAS_BUNDLE_HTML).toContain("pointercancel");
  });
});
