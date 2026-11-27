import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
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
  PluginRegistry,
  THIRD_PARTY_PLUGIN_CATALOG,
  type PluginStorageAdapter,
} from "../client/src/plugin-registry.js";
import {
  MAX_PLUGIN_STORAGE_BYTES,
  MAX_PLUGIN_STORAGE_KEYS,
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
import { FOCUS_TIMER_BUNDLE_HTML, INFINITE_CANVAS_BUNDLE_HTML } from "../client/src/plugin-bundles.js";

function memoryStorage(): PluginStorageAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

describe("Plugin manifest, integrity and registry (#101)", () => {
  it("lists Infinite Canvas as an official desktop-only plugin and hides it on phone", () => {
    const registry = new PluginRegistry({ storage: memoryStorage() });
    const desktopIds = registry.catalogForPlatform("desktop").map((item) => item.manifest.id);
    const phoneIds = registry.catalogForPlatform("phone").map((item) => item.manifest.id);

    expect(desktopIds).toContain("tarobird.infinite-canvas");
    expect(desktopIds).toContain("tarobird.quick-scratchpad");
    expect(phoneIds).not.toContain("tarobird.infinite-canvas");
    expect(phoneIds).toContain("tarobird.quick-scratchpad");
  });

  it("installs, enables, disables, updates and uninstalls Infinite Canvas end-to-end with verified hash & signature", async () => {
    const store = memoryStorage();
    const registry = new PluginRegistry({ storage: store });
    const infiniteCanvas = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!;

    expect(await verifyPluginArtifactHash(infiniteCanvas.bundleHtml, infiniteCanvas.manifest.artifact.sha256)).toBe(true);
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

    // Uninstall removes plugin and deletes its isolated storage bucket
    reloaded.uninstall("tarobird.infinite-canvas");
    expect(reloaded.getPlugin("tarobird.infinite-canvas")).toBeUndefined();
    expect(reloaded.enabledContributions("desktop", "workbench-item")).toEqual([]);
    expect(store.data.has(pluginStorageBucketKey("tarobird.infinite-canvas"))).toBe(false);
  });

  it("verifies all catalog bundles including exact UTF-8 sizeBytes and full signed manifest metadata", async () => {
    const registry = new PluginRegistry({ storage: memoryStorage() });
    registry.setAllowThirdParty(true);
    for (const entry of [...OFFICIAL_PLUGIN_CATALOG, ...THIRD_PARTY_PLUGIN_CATALOG]) {
      expect(new TextEncoder().encode(entry.bundleHtml).byteLength).toBe(entry.manifest.artifact.sizeBytes);
      expect(await verifyPluginArtifactHash(entry.bundleHtml, entry.manifest.artifact.sha256)).toBe(true);
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
    const sameLenTampered = `<!--x-->${infiniteCanvas.bundleHtml.slice(8)}`;
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
      expect(await verifyPluginArtifactHash(infiniteCanvas.bundleHtml, infiniteCanvas.manifest.artifact.sha256)).toBe(true);
      expect(await verifyOfficialPluginSignature(infiniteCanvas.manifest, OFFICIAL_PLUGIN_PUBLIC_KEY)).toBe(true);
      const registry = new PluginRegistry({ storage: memoryStorage() });
      const installed = await registry.install(infiniteCanvas);
      expect(installed.sourceKind).toBe("official");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
      else Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true, writable: true });
    }
  });

  it("keeps third-party plugins disabled by default and allows installation only after opt-in", async () => {
    const registry = new PluginRegistry({ storage: memoryStorage() });
    const thirdParty = THIRD_PARTY_PLUGIN_CATALOG[0]!;

    expect(registry.getSnapshot().allowThirdParty).toBe(false);
    await expect(registry.install(thirdParty)).rejects.toThrow("plugin_third_party_disabled");

    registry.setAllowThirdParty(true);
    const installed = await registry.install(thirdParty);
    expect(installed.sourceKind).toBe("third-party");
    expect(registry.enabledContributions("phone", "side-panel").map((c) => c.plugin.manifest.id)).toContain(thirdParty.manifest.id);
  });

  it("supports developer mode local-folder loading, rejects mismatched hashes and reserved official IDs, and bumps installedAt on reload", async () => {
    const registry = new PluginRegistry({ storage: memoryStorage() });
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
      domains: [],
      capabilities: ["theme.read"],
      requiresHost: false,
      official: false,
    });

    await expect(registry.installLocalDev(manifestJson, html)).rejects.toThrow("plugin_developer_mode_disabled");
    registry.setDeveloperMode(true);
    const first = await registry.installLocalDev(manifestJson, html);
    expect(first.sourceKind).toBe("local-dev");
    expect(first.manifest.artifact.sha256).toBe(await sha256Hex(html));

    // Reloading same version bumps installedAt so PluginSandboxFrame remounts cleanly
    const second = await registry.installLocalDev(manifestJson, `${html}<!-- v2 -->`);
    expect(second.installedAt).toBeGreaterThan(first.installedAt);

    // Reject if a declared SHA-256 in local manifest doesn't match the bundle
    const badManifest = JSON.stringify({ ...JSON.parse(manifestJson), artifact: { sha256: "0".repeat(64), sizeBytes: 10 } });
    await expect(registry.installLocalDev(badManifest, html)).rejects.toThrow("plugin_hash_mismatch");

    // Reject official / reserved tarobird.* plugin IDs in local-dev
    const hijackManifest = JSON.stringify({ ...JSON.parse(manifestJson), id: "tarobird.infinite-canvas" });
    await expect(registry.installLocalDev(hijackManifest, html)).rejects.toThrow("plugin_official_id_reserved");
    const reservedPrefixManifest = JSON.stringify({ ...JSON.parse(manifestJson), id: "tarobird.custom-spoof" });
    await expect(registry.installLocalDev(reservedPrefixManifest, html)).rejects.toThrow("plugin_official_id_reserved");
  });

  it("detects newer catalog versions and supports semver comparison", () => {
    expect(comparePluginVersions("1.1.0", "1.0.0")).toBe(1);
    expect(comparePluginVersions("1.0.0", "1.0.0")).toBe(0);
    expect(comparePluginVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(canonicalPluginSignaturePayload(OFFICIAL_PLUGIN_CATALOG[0]!.manifest)).toContain("tarobird/plugin-manifest/v1");
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
      pluginId: "community.focus-timer",
      grantedCapabilities: ["theme.read"] as const,
      theme: "dark" as const,
      locale: "zh",
      storage: store,
    };

    const hello = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "1", method: "host.hello" }, baseCtx);
    expect(hello).toMatchObject({ ok: true, result: { pluginId: "community.focus-timer", theme: "dark", locale: "zh" } });
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
    expect(store.data.get(pluginStorageBucketKey("community.focus-timer"))).toBe(JSON.stringify({ note: "hello" }));
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
      pluginId: "community.quota-test",
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

describe("Plugin CSP wrapping, domain filtering and theme resolution (#101)", () => {
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
    expect(csp).toContain("connect-src https://api.example.com wss://api.example.com;");
    expect(csp).not.toContain("127.0.0.1");
    expect(csp).not.toContain("localhost");
    expect(csp).not.toContain("192.168.1.10");
  });

  it("injects host CSP into real <head> even with leading HTML comments, pre-head scripts, or plugin-supplied CSP metas", () => {
    const commented = "<!-- <head> --><html><head><title>X</title></head><body>hi</body></html>";
    const wrappedCommented = wrapSandboxedDocument(commented, ["api.example.com"]);
    expect(wrappedCommented).not.toContain("<!-- <head> --><meta");
    expect(wrappedCommented).toMatch(/<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="[^"]*connect-src https:\/\/api\.example\.com wss:\/\/api\.example\.com/);

    const preHeadScript = "<script>fetch('https://evil.example')</script><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"></head><body>x</body>";
    const wrappedScript = wrapSandboxedDocument(preHeadScript, []);
    const cspIdx = wrappedScript.indexOf('http-equiv="Content-Security-Policy"');
    const scriptIdx = wrappedScript.indexOf("<script>");
    expect(cspIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeGreaterThan(cspIdx);
    expect(wrappedScript).not.toContain("default-src *");
    expect(wrappedScript).toContain("connect-src 'none'");
  });

  it("keeps outer plugin-sandbox.html meta CSP aligned with granted-domain connect-src", async () => {
    const shell = await readFile("client/public/plugin-sandbox.html", "utf8");
    expect(shell).toContain("connect-src https: wss:");
    expect(shell).toContain('sandbox="allow-scripts"');
    expect(shell).not.toContain("allow-same-origin");
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
  it("classifies official workbench, productivity and community plugins and matches search queries", () => {
    const canvas = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!.manifest;
    const notes = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.quick-scratchpad")!.manifest;
    const community = THIRD_PARTY_PLUGIN_CATALOG[0]!.manifest;

    expect(pluginMarketplaceCategory(canvas)).toBe("workbench");
    expect(pluginMarketplaceCategory(notes)).toBe("productivity");
    expect(pluginMarketplaceCategory(community)).toBe("community");

    expect(pluginPublisherLabel(canvas)).toBe("TaroBird");
    expect(pluginPublisherLabel(community)).toBe("tarobird-community");
    expect(pluginPublisherLabel(canvas, "local-dev")).not.toBe("TaroBird");

    expect(matchesPluginMarketplaceQuery(canvas, "无限画布")).toBe(true);
    expect(matchesPluginMarketplaceQuery(canvas, "tarobird")).toBe(true);
    expect(matchesPluginMarketplaceQuery(canvas, "pomodoro")).toBe(false);
    expect(matchesPluginMarketplaceQuery(community, "番茄钟")).toBe(true);
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

  it("includes localized zh labels and zero-stop cleanup in Focus Timer and pointer capture in Infinite Canvas", () => {
    expect(FOCUS_TIMER_BUNDLE_HTML).toContain("开始");
    expect(FOCUS_TIMER_BUNDLE_HTML).toContain("暂停");
    expect(FOCUS_TIMER_BUNDLE_HTML).toContain("重置");
    expect(FOCUS_TIMER_BUNDLE_HTML).toContain("if (seconds <= 0) stopTimer()");
    expect(INFINITE_CANVAS_BUNDLE_HTML).toContain("setPointerCapture");
    expect(INFINITE_CANVAS_BUNDLE_HTML).toContain("pointercancel");
  });
});
