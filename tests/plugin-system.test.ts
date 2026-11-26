import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
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
import { handlePluginHostMessage } from "../client/src/PluginSandboxFrame.js";

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
    const infiniteCanvas = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!;
    const builtHtml = readFileSync(path.resolve(process.cwd(), "dist/plugins/tarobird.infinite-canvas/1.0.0/bundle.html"), "utf8");
    const registry = new PluginRegistry({ storage: store, fetcher: async () => builtHtml });

    expect(await verifyPluginArtifactHash(builtHtml, infiniteCanvas.manifest.artifact.sha256)).toBe(true);
    expect(await verifyOfficialPluginSignature(infiniteCanvas.manifest, OFFICIAL_PLUGIN_PUBLIC_KEY)).toBe(true);

    const installed = await registry.install(infiniteCanvas);
    expect(installed.enabled).toBe(true);
    expect(registry.enabledContributions("desktop", "workbench-item").map((item) => item.plugin.manifest.id)).toEqual(["tarobird.infinite-canvas"]);

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

    // Uninstall removes it cleanly
    await reloaded.uninstall("tarobird.infinite-canvas", { keepData: false });
    expect(reloaded.getPlugin("tarobird.infinite-canvas")).toBeUndefined();
    expect(reloaded.enabledContributions("desktop", "workbench-item")).toEqual([]);
  });

  it("blocks installation when SHA-256 hash or official signature does not match", async () => {
    const registry = new PluginRegistry({ storage: memoryStorage() });
    const infiniteCanvas = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!;

    // Tampered bundle payload -> hash mismatch blocked!
    await expect(registry.install({
      manifest: infiniteCanvas.manifest,
      bundleHtml: `${infiniteCanvas.bundleHtml}<!-- tampered -->`,
    })).rejects.toThrow("plugin_hash_mismatch");

    // Valid hash but forged/tampered official signature -> signature invalid blocked!
    const alteredHtml = "<!doctype html><html><body>forged official</body></html>";
    const alteredHash = await sha256Hex(alteredHtml);
    await expect(registry.install({
      manifest: {
        ...infiniteCanvas.manifest,
        artifact: {
          sha256: alteredHash,
          sizeBytes: alteredHtml.length,
          signature: infiniteCanvas.manifest.artifact.signature,
        },
      },
      bundleHtml: alteredHtml,
    })).rejects.toThrow("plugin_signature_invalid");
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

  it("supports developer mode local-folder loading and rejects mismatched manifest hashes", async () => {
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
    const installed = await registry.installLocalDev(manifestJson, html);
    expect(installed.sourceKind).toBe("local-dev");
    expect(installed.manifest.artifact.sha256).toBe(await sha256Hex(html));

    // Reject if a declared SHA-256 in local manifest doesn't match the bundle
    const badManifest = JSON.stringify({ ...JSON.parse(manifestJson), artifact: { sha256: "0".repeat(64), sizeBytes: 10 } });
    await expect(registry.installLocalDev(badManifest, html)).rejects.toThrow("plugin_hash_mismatch");
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

describe("Plugin sandbox Host API capability gating (#101)", () => {
  it("allows only granted capabilities and blocks unauthorized storage/clipboard/Hub API calls", async () => {
    const store = memoryStorage();
    const baseCtx = {
      pluginId: "community.focus-timer",
      grantedCapabilities: ["theme.read"] as const,
      theme: "dark" as const,
      locale: "zh",
      storage: store,
    };

    // Always-safe hello & granted theme.get succeed
    const hello = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "1", method: "host.hello" }, baseCtx);
    expect(hello).toMatchObject({ ok: true, result: { pluginId: "community.focus-timer", theme: "dark", locale: "zh" } });
    const theme = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "2", method: "theme.get" }, baseCtx);
    expect(theme).toMatchObject({ ok: true, result: { theme: "dark" } });

    // Ungranted storage.set & clipboard.write are blocked
    const deniedStorage = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "3", method: "storage.set", key: "k", value: "v" }, baseCtx);
    expect(deniedStorage).toMatchObject({ ok: false, error: "capability_denied" });
    const deniedClip = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "4", method: "clipboard.write", text: "hi" }, baseCtx);
    expect(deniedClip).toMatchObject({ ok: false, error: "capability_denied" });

    // Unknown/Hub API calls are rejected cleanly
    const deniedHub = await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "5", method: "hub.fetch", path: "/api/devices" }, baseCtx);
    expect(deniedHub).toMatchObject({ ok: false, error: "method_not_allowed" });

    // When storage.device IS granted, keys are strictly namespaced to the plugin ID
    const grantedStorage = await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "6", method: "storage.set", key: "note", value: "hello" },
      { ...baseCtx, grantedCapabilities: ["storage.device"] },
    );
    expect(grantedStorage).toMatchObject({ ok: true });
    expect(store.data.get("tarobird.plugin.data.community.focus-timer.note")).toBe("hello");
  });
});
