import { createPluginSensitiveActionGate } from "../client/src/plugin-sensitive-action.js";
import { describe, expect, it, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
  PLUGIN_HOST_PROTOCOL,
  pluginManifestSchema,
  sha256Hex,
} from "../src/client-protocol/plugins.js";
import {
  CANVAS_AGENT_PROTOCOL_VERSION,
  CANVAS_TOOL_NAMES,
  canvasOpSchema,
} from "../src/client-protocol/infinite-canvas.js";
import {
  OFFICIAL_PLUGIN_CATALOG,
  PLUGIN_STORE_KEY,
  clearLegacyCanvasCredentials,
  PluginRegistry,
  createDefaultPluginStorage,
  getPluginRegistry,
  pluginScopeId,
  resolvePluginScopeId,
  type PluginCredentialVault,
  type PluginStorageAdapter,
} from "../client/src/plugin-registry.js";
import {
  buildPluginCsp,
  handlePluginHostMessage,
} from "../client/src/plugin-sandbox-runtime.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { createAppPlatformTools } from "../src/gateway/app-tools.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";

function memoryStorage(): PluginStorageAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

function memoryCredentialVault(): PluginCredentialVault & { secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  return {
    secrets,
    getSecret: async (scopeId, pluginId, key) => secrets.get(`${scopeId}:${pluginId}:${key}`) ?? null,
    setSecret: async (scopeId, pluginId, key, value) => { secrets.set(`${scopeId}:${pluginId}:${key}`, value); },
    removeSecret: async (scopeId, pluginId, key) => { secrets.delete(`${scopeId}:${pluginId}:${key}`); },
    clearPluginSecrets: async (scopeId, pluginId) => {
      const prefix = `${scopeId}:${pluginId}:`;
      for (const k of [...secrets.keys()]) {
        if (k.startsWith(prefix)) secrets.delete(k);
      }
    },
  };
}

const tempDirs: string[] = [];
const hubs: HubServer[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const canvasBuildDir = path.resolve(process.env.TAROBIRD_CANVAS_TEST_BUILD_DIR ?? "dist/plugins/tarobird.infinite-canvas/1.0.0");
const lifecycleFixture = new URL("./fixtures/infinite-canvas-extension.html", import.meta.url);
const canvasBuildHtml = path.join(canvasBuildDir, "bundle.html");
const canvasBuildManifest = path.join(canvasBuildDir, "manifest.json");
const officialCanvasEntry = OFFICIAL_PLUGIN_CATALOG.find(({ manifest }) => manifest.id === "tarobird.infinite-canvas")!;
const fixtureHtml = "<!doctype html><body>Canvas fixture</body>";

function canvasFixture(html: string, version = officialCanvasEntry.manifest.version) {
  return {
    manifest: pluginManifestSchema.parse({
      ...officialCanvasEntry.manifest,
      version,
      artifact: { sha256: createHash("sha256").update(html).digest("hex"), sizeBytes: Buffer.byteLength(html) },
    }),
  };
}

describe("Infinite Canvas extension manifest, on-demand install & lifecycle (#81)", () => {
  it("declares tarobird.infinite-canvas as desktop-only, on-demand (not inline), with MIT attribution", () => {
    const entry = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas");
    expect(entry).toBeDefined();
    expect(entry!.bundleHtml).toBeUndefined();
    expect(entry!.manifest.artifact).not.toHaveProperty("url");
    expect(entry!.manifest.artifact).not.toHaveProperty("signature");
    expect(entry!.manifest.platforms).toEqual(["desktop"]);
    expect(entry!.manifest.requiresHost).toBe(true);
    expect(entry!.manifest.capabilities).toContain("canvas.agent");
    expect(entry!.manifest.capabilities).toContain("storage.device");
    expect(entry!.manifest.source.repository).toBe("basketikun/infinite-canvas");
    expect(entry!.manifest.attribution).toMatchObject({
      author: "basketikun",
      license: "MIT",
    });

    const parsed = pluginManifestSchema.parse(entry!.manifest);
    expect(parsed.id).toBe("tarobird.infinite-canvas");
  });

  it("rejects tampered downloads on sizeBytes mismatch and same-length SHA-256 mismatch", async () => {
    const store = memoryStorage();
    const entry = canvasFixture(fixtureHtml);
    const wrongSizeRegistry = new PluginRegistry({ storage: store, catalog: [entry] });
    await expect(wrongSizeRegistry.install(entry, { loadCanvasBundle: async () => "truncated" })).rejects.toThrow("plugin_size_mismatch");
    expect(wrongSizeRegistry.getPlugin("tarobird.infinite-canvas")).toBeUndefined();

    const sameLengthTampered = fixtureHtml.replace("Canvas", "canvas");
    const wrongHashRegistry = new PluginRegistry({ storage: store, catalog: [entry] });
    await expect(wrongHashRegistry.install(entry, { loadCanvasBundle: async () => sameLengthTampered })).rejects.toThrow("plugin_hash_mismatch");
    expect(wrongHashRegistry.getPlugin("tarobird.infinite-canvas")).toBeUndefined();
  });

  it("installs on demand, updates, and supports uninstall with keepData vs wipe scoped by device+host+user", async () => {
    const entry = canvasFixture(fixtureHtml);
    const store = memoryStorage();
    const vault = memoryCredentialVault();
    const scopeA = pluginScopeId("host_alpha", "user_1", "dev_1");
    const scopeB = pluginScopeId("host_beta", "user_1", "dev_1");

    let fetchCount = 0;
    let registry = new PluginRegistry({
      storage: store,
      catalog: [entry],
      credentialVault: vault,
      scopeId: scopeA,
    });
    const loadCanvasBundle = async () => { fetchCount++; return fixtureHtml; };
    const installed = await registry.install(entry, { loadCanvasBundle });
    expect(installed.manifest.id).toBe("tarobird.infinite-canvas");
    expect(fetchCount).toBe(1);

    // Offline execution: bundle is cached locally and isolated per scope
    expect(registry.getPlugin("tarobird.infinite-canvas")?.bundleHtml).toBe(fixtureHtml);
    registry.setScope(scopeB);
    expect(registry.getPlugin("tarobird.infinite-canvas")).toBeUndefined();
    registry.setScope(scopeA);

    // Save canvas data & isolated API key (never in localStorage/store)
    await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "s1", method: "storage.set", key: "projects", value: JSON.stringify([{ id: "p1", title: "My Canvas" }]) },
      {
        pluginId: "tarobird.infinite-canvas",
        scopeId: scopeA,
        officialBundledCanvas: true,
        grantedCapabilities: ["storage.device", "canvas.agent", "credentials.device", "files.export", "network.domains"],
        theme: "light",
        locale: "en",
        storage: store,
        credentialVault: vault,
      },
    );
    await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "c1", method: "credentials.set", key: "channel:default:apiKey", value: "sk-synthetic-demo-key" },
      {
        pluginId: "tarobird.infinite-canvas",
        scopeId: scopeA,
        officialBundledCanvas: true,
        grantedCapabilities: ["storage.device", "canvas.agent", "credentials.device", "files.export", "network.domains"],
        theme: "light",
        locale: "en",
        storage: store,
        credentialVault: vault,
      },
    );
    // Secret must NEVER appear in plugin/local storage!
    for (const value of store.data.values()) {
      expect(value).not.toContain("sk-synthetic-demo-key");
    }

    // Uninstall keeping local data
    await registry.uninstall("tarobird.infinite-canvas", { keepData: true });
    expect(registry.getPlugin("tarobird.infinite-canvas")).toBeUndefined();
    expect(await vault.getSecret(scopeA, "tarobird.infinite-canvas", "channel:default:apiKey")).toBe("sk-synthetic-demo-key");

    // Reinstall restores access to kept data
    await registry.install(entry, { loadCanvasBundle });
    const reloadedProjects = await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "s2", method: "storage.get", key: "projects" },
      {
        pluginId: "tarobird.infinite-canvas",
        scopeId: scopeA,
        grantedCapabilities: ["storage.device"],
        theme: "light",
        locale: "en",
        storage: store,
        credentialVault: vault,
      },
    );
    expect(reloadedProjects?.result).toContain("My Canvas");

    const updatedHtml = "<!doctype html><body>Updated Canvas fixture</body>";
    const update = canvasFixture(updatedHtml, "1.0.1");
    registry = new PluginRegistry({ storage: store, catalog: [update], credentialVault: vault, scopeId: scopeA });
    expect((await registry.install(update, { loadCanvasBundle: async () => updatedHtml })).manifest.version).toBe("1.0.1");
    expect(registry.getPlugin("tarobird.infinite-canvas")?.bundleHtml).toBe(updatedHtml);
    expect(await vault.getSecret(scopeA, "tarobird.infinite-canvas", "channel:default:apiKey")).toBe("sk-synthetic-demo-key");

    // Uninstall deleting local data wipes both storage keys and isolated credentials
    await registry.uninstall("tarobird.infinite-canvas", { keepData: false });
    expect(await vault.getSecret(scopeA, "tarobird.infinite-canvas", "channel:default:apiKey")).toBeNull();
    const afterWipe = await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "s3", method: "storage.get", key: "projects" },
      {
        pluginId: "tarobird.infinite-canvas",
        scopeId: scopeA,
        grantedCapabilities: ["storage.device"],
        theme: "light",
        locale: "en",
        storage: store,
        credentialVault: vault,
      },
    );
    expect(afterWipe?.result).toBeNull();
  });

  it("retains reviewed grants and verifies the bundle after toggling during rehydration", async () => {
    const scopeId = pluginScopeId("fixture_host", "owner", "fixture_device");
    const storage = memoryStorage();
    const html = await readFile(lifecycleFixture, "utf8");
    const entry = canvasFixture(html);
    const id = entry.manifest.id;
    storage.setItem(`${PLUGIN_STORE_KEY}.${scopeId}`, JSON.stringify({ installed: {
      [id]: { manifest: entry.manifest, sourceKind: "official", enabled: true, installedAt: 1, bundleStoredInIdb: true,
        grantedCapabilities: ["storage.device"], grantedDomains: [] },
    } }));
    let release!: (value: string) => void;
    const pending = new Promise<string>(resolve => { release = resolve; });
    const kv = { get: async () => null, set: async () => {}, remove: async () => {}, list: async () => ({}), clear: async () => {} };
    const bundleStore = {
      putBundle: async () => true, deleteBundle: async () => {}, kv,
    };
    const registry = new PluginRegistry({ storage, scopeId, catalog: [entry], bundleStore: {
      ...bundleStore, getBundle: () => pending,
    } });
    expect(registry.getPlugin(id)?.bundleHtml).toBe("");
    registry.setEnabled(id, false);
    registry.setEnabled(id, true);
    release(html);
    await expect.poll(() => registry.getPlugin(id)?.bundleHtml).toBe(html);
    expect(registry.getPlugin(id)).toMatchObject({ bundleHtml: html, enabled: true, grantedCapabilities: ["storage.device"] });
    registry.setEnabled(id, false);
    expect(registry.getPlugin(id)).toMatchObject({ bundleHtml: html, enabled: false });
    registry.setEnabled(id, true);
    expect(registry.getPlugin(id)).toMatchObject({ bundleHtml: html, enabled: true });
  });

  it("fences uninstall admission and drains binary, credential and KV writes before wiping", async () => {
    const scopeId = pluginScopeId("fixture_host", "owner", "fixture_device");
    const html = await readFile(lifecycleFixture, "utf8");
    const entry = canvasFixture(html);
    const id = entry.manifest.id;
    const scopes = { binary: new Set(), credential: new Set(), kv: new Set() };
    const cleared: string[] = [];
    const clear = async (name: keyof typeof scopes, scope: string, plugin: string) => {
      expect([scope, plugin]).toEqual([scopeId, id]);
      scopes[name].clear();
      cleared.push(name);
    };
    const registry = new PluginRegistry({
      storage: memoryStorage(), scopeId, catalog: [entry],
      canvasStore: { clear: (scope, plugin) => clear("binary", scope, plugin) },
      credentialVault: { ...memoryCredentialVault(), clearPluginSecrets: (scope, plugin) => clear("credential", scope, plugin) },
      kvStore: { get: async () => null, set: async () => {}, remove: async () => {}, list: async () => ({}), clear: (scope, plugin) => clear("kv", scope, plugin) },
    });
    const record = await registry.install(entry, {
      loadCanvasBundle: async () => html,
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const writes = Object.entries(scopes).map(([name, data]) => registry.runStorageOperation(record, async () => {
      data.add("before");
      await held;
      data.add("late-" + name);
    }));
    await expect.poll(() => Object.values(scopes).every(data => data.has("before"))).toBe(true);
    const uninstalling = registry.uninstall(id);
    expect(registry.isActive(record)).toBe(false);
    await expect(registry.runStorageOperation(record, async () => { throw new Error("should not run"); })).rejects.toThrow("plugin_storage_inactive");
    expect(cleared).toEqual([]);
    release();
    await Promise.all(writes);
    await uninstalling;
    expect(cleared).toEqual(["binary", "credential", "kv"]);
    expect(Object.values(scopes).map(data => data.size)).toEqual([0, 0, 0]);
    expect(registry.getPlugin(id)).toBeUndefined();
  });

  it("clears the preview credential database by name, without opening or reading it", async () => {
    const calls: string[] = [];
    const request: { onerror?: () => void; onsuccess?: () => void } = {};
    const factory = {
      deleteDatabase(name: string) { calls.push(name); return request; },
      open() { throw new Error("must never open the preview vault"); },
    } as unknown as IDBFactory;
    const first = clearLegacyCanvasCredentials(factory);
    expect(clearLegacyCanvasCredentials(factory)).toBe(first);
    expect(calls).toEqual(["tarobird.plugin.credentials.v1"]);
    request.onsuccess?.();
    await first;
    await clearLegacyCanvasCredentials(factory);
    expect(calls).toHaveLength(1);
  });

  it.runIf(existsSync(canvasBuildHtml) || existsSync(canvasBuildManifest))("matches the built bundle and release manifest to the compiled official catalog", async () => {
    const bundle = await readFile(canvasBuildHtml);
    const releaseManifest = pluginManifestSchema.parse(JSON.parse(await readFile(canvasBuildManifest, "utf8")));
    expect(releaseManifest).toEqual(officialCanvasEntry.manifest);
    expect(bundle.byteLength).toBe(releaseManifest.artifact.sizeBytes);
    const html = bundle.toString("utf8");
    expect(await sha256Hex(html)).toBe(releaseManifest.artifact.sha256);
    const license = await readFile(path.join(canvasBuildDir, "LICENSE"), "utf8");
    const notices = await readFile(path.join(canvasBuildDir, "THIRD_PARTY_NOTICES.txt"), "utf8");
    expect(notices).toBe(await readFile("integrations/infinite-canvas/notices/BUNDLED_DEPENDENCIES.txt", "utf8"));
    const encodedNotice = /<template id="tarobird-canvas-acknowledgements">([\s\S]+?)<\/template>/.exec(html)?.[1];
    expect(encodedNotice?.replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&")).toBe(license.trimEnd() + "\n\n" + notices);
  });

  it("isolates concurrent per-host registries without mutating shared global state and avoids synthetic 'user' scope pre-hydration", () => {
    expect(resolvePluginScopeId("host_alpha", undefined, "dev_1")).toBeNull();
    expect(resolvePluginScopeId("host_alpha", "", "dev_1")).toBeNull();
    expect(resolvePluginScopeId(undefined, undefined, undefined)).toBe("default");
    const scopeA = resolvePluginScopeId("host_alpha_1234567890", "user_a", "dev_1")!;
    const scopeB = resolvePluginScopeId("host_beta_1234567890", "user_b", "dev_1")!;
    expect(scopeA).not.toBe(scopeB);

    const regA = getPluginRegistry(scopeA);
    const regB = getPluginRegistry(scopeB);
    expect(regA).not.toBe(regB);
    expect(regA.getScopeId()).toBe(scopeA);
    expect(regB.getScopeId()).toBe(scopeB);
    regA.setAllowThirdParty(true);
    expect(regA.getSnapshot().allowThirdParty).toBe(true);
    expect(regB.getSnapshot().allowThirdParty).toBe(false);
    regA.setAllowThirdParty(false);
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

  it("wraps host API rejections into structured ok:false responses and supports custom domain requests + CSP img-src", async () => {
    expect(buildPluginCsp(["api.openai.com"])).toContain("img-src data: blob:;");
    expect(buildPluginCsp(["api.openai.com"])).toContain("frame-src 'none'");
    expect(buildPluginCsp([])).toContain("img-src data: blob:;");

    const store = memoryStorage();
    const sensitiveConsent = createPluginSensitiveActionGate((_plugin, _action, run) => ({ result: run(), cancel: () => {} }));
    const exportWorkspace = vi.fn(async () => { throw new Error("disk_readonly"); });
    const baseCtx = {
      pluginId: "tarobird.infinite-canvas",
      scopeId: "dev:host:u1",
      officialBundledCanvas: true,
        grantedCapabilities: ["storage.device", "canvas.agent", "credentials.device", "files.export", "network.domains"] as const,
      declaredDomains: ["api.openai.com", "api.custom-provider.example"],
      grantedDomains: ["api.openai.com"],
      theme: "light" as const,
      locale: "en",
      storage: store,
      credentialVault: {
        getSecret: async () => { throw new Error("idb_failed"); },
        setSecret: async () => { throw new Error("idb_failed"); },
        removeSecret: async () => { throw new Error("idb_failed"); },
        clearPluginSecrets: async () => {},
      },
      exportWorkspace,
      runSensitiveAction: (action: Parameters<typeof sensitiveConsent.run>[1], run: () => Promise<boolean>) => sensitiveConsent.run("Fixture canvas", action, run, () => true),
      requestDomain: async (domain: string) => ({ granted: true, domain, grantedDomains: ["api.openai.com", domain] }),
      canvasAgent: {
        connect: async () => { throw new Error("canvas_agent_offline"); },
        disconnect: async () => { throw new Error("disconnect_failed"); },
        sendState: async () => { throw new Error("state_failed"); },
        activate: async () => { throw new Error("activate_failed"); },
        sendResult: async () => { throw new Error("result_failed"); },
      },
    };

    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "e1", method: "canvas.agent.connect", clientId: "c1" }, baseCtx))
      .toMatchObject({ ok: false, error: "canvas_agent_offline" });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "e2", method: "canvas.agent.state", clientId: "c1", snapshot: null }, baseCtx))
      .toMatchObject({ ok: false, error: "state_failed" });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "e3", method: "canvas.agent.activate", clientId: "c1" }, baseCtx))
      .toMatchObject({ ok: false, error: "activate_failed" });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "e4", method: "canvas.agent.result", clientId: "c1", requestId: "r1", result: {} }, baseCtx))
      .toMatchObject({ ok: false, error: "result_failed" });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "e5", method: "credentials.get", key: "k" }, baseCtx))
      .toMatchObject({ ok: false, error: "idb_failed" });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "e6", method: "workspace.export", filename: "a.json", content: "{}" }, baseCtx))
      .toMatchObject({ ok: false, error: "disk_readonly" });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "e6", method: "workspace.export", filename: "a.json", content: "{}" }, baseCtx))
      .toMatchObject({ ok: true, result: { saved: false } });
    expect(exportWorkspace).toHaveBeenCalledTimes(1);

    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "hidden", method: "credentials.get", key: "k" },
      { ...baseCtx, grantedCapabilities: ["storage.device"] })).toMatchObject({ ok: false, error: "capability_denied" });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "file", method: "workspace.export", filename: "a", content: "{}" },
      { ...baseCtx, grantedCapabilities: ["storage.device"] })).toMatchObject({ ok: false, error: "capability_denied" });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "off-list", method: "domains.request", domain: "not-declared.example" },
      baseCtx)).toMatchObject({ ok: false, error: "invalid_domain" });
    // Local/private domains rejected; public HTTPS domain granted via host callback
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "d1", method: "domains.request", domain: "127.0.0.1:8080" }, baseCtx))
      .toMatchObject({ ok: false, error: "invalid_domain" });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "d2", method: "domains.request", domain: "api.custom-provider.example" }, baseCtx))
      .toMatchObject({ ok: true, result: { granted: true, domain: "api.custom-provider.example" } });
  });
});

describe("Host Canvas Agent bridge handshake, auth, security & Bot tool wiring (#81)", () => {
  const secret = "fixture-canvas-bot-0123456789abcdef";
  const sockets: WebSocket[] = [];
  afterEach(() => { for (const socket of sockets.splice(0)) socket.terminate(); });

  async function peer(url: string) {
    const socket = new WebSocket(url);
    sockets.push(socket);
    const frames: Array<Record<string, any>> = [];
    socket.on("message", raw => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    return {
      socket,
      send: (frame: unknown) => socket.send(JSON.stringify({ v: 1, ...(frame as object) })),
      async next(type: string, where: (frame: any) => boolean = () => true) {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const index = frames.findIndex(frame => frame.type === type && where(frame));
          if (index >= 0) return frames.splice(index, 1)[0]!;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for ${type}; buffered ${frames.map(frame => frame.type).join(", ")}`);
      },
    };
  }

  async function app(hub: HubServer, deviceId: string, member = false) {
    const keys = generateKeyPairSync("ed25519");
    await hub.enrollLocalController({
      deviceId, name: "Canvas test App", platform: "macos",
      publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    });
    if (member) {
      await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('canvas_member','Canvas member','member')");
      await hub.store.db.run("UPDATE devices SET user_id='canvas_member' WHERE id=?", [deviceId]);
    }
    const socket = await peer(hub.url.replace(/^http/, "ws") + "/ws");
    const nonce = randomBytes(32).toString("base64url");
    socket.send({ type: "hello", deviceId, nonce, protocolVersions: [1], capabilities: ["cards.v1", "management.v1"], cursors: {} });
    const challenge = await socket.next("challenge");
    socket.send({ type: "auth", signature: sign(null, deviceProof(deviceId, challenge.nonce, nonce), keys.privateKey).toString("base64") });
    const { sessionToken } = await socket.next("ready");
    await socket.next("sync.complete");
    return {
      ...socket, deviceId, sessionToken: sessionToken as string,
      request: (route: string, body?: unknown, origin?: string) => fetch(hub.url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${sessionToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(origin ? { Origin: origin } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    };
  }

  function canvasPost(hub: HubServer, command: string, grant: { clientId: string; token: string }, body: unknown = {}, origin?: string) {
    return fetch(`${hub.url}/api/canvas-agent/${command}?clientId=${grant.clientId}`, {
      method: "POST",
      headers: { Authorization: `CanvasAgent ${grant.token}`, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });
  }

  async function grant(hub: HubServer, owner: Awaited<ReturnType<typeof app>>, conversationId: string, windowId: string, tabId: string, clientId: string, projectId: string, renewToken?: string) {
    const response = await owner.request("/api/canvas-agent/token", { conversationId, windowId, tabId, clientId, ...(renewToken ? { renewToken } : {}) });
    expect(response.status).toBe(200);
    const issued = await response.json() as { token: string; clientId: string; windowId: string; tabId: string; protocolVersion: number };
    expect(issued).toMatchObject({ clientId, windowId, tabId, protocolVersion: CANVAS_AGENT_PROTOCOL_VERSION });
    owner.send({ type: "canvas.agent.attach", token: issued.token, clientId });
    await owner.next("canvas.agent.event", frame => frame.event === "hello" && frame.clientId === clientId);
    expect((await canvasPost(hub, "state", issued, { snapshot: { projectId, title: projectId } })).status).toBe(200);
    expect((await canvasPost(hub, "activate", issued)).status).toBe(200);
    return issued;
  }

  async function startHub(options: Partial<Parameters<typeof HubServer.start>[0]> = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "canvas-auth-"));
    tempDirs.push(dir);
    const hub = await HubServer.start({ stateDir: dir, ...options });
    hubs.push(hub);
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash) VALUES('canvas_bot','Canvas Bot','codex',?)", [createHash("sha256").update(secret).digest("hex")]);
    const chat = await hub.store.createConversation("owner", ["canvas_bot"], "Canvas Chat", "canvas_chat");
    return { hub, dir, chat };
  }

  async function bot(hub: HubServer, capabilities: string[] = []) {
    const socket = await peer(hub.instanceUrl.replace(/^http/, "ws") + "/instance");
    socket.send({ type: "instance.hello", botId: "canvas_bot", secret, engine: "codex", model: "", effort: "", capabilities });
    await socket.next("instance.ready");
    let nextId = 0;
    return { ...socket, async request(method: string, params: unknown) {
      const id = `rpc_${++nextId}`;
      socket.send({ type: "instance.request", id, method, params });
      return socket.next("instance.result", frame => frame.id === id);
    } };
  }

  function mcp(hub: HubServer, conversationId: string, messageId: string | undefined, body?: unknown, key = secret) {
    return fetch(hub.instanceUrl + "/api/canvas-agent/mcp", {
      method: "POST",
      headers: {
        Authorization: `Instance canvas_bot:${key}`, "Content-Type": "application/json",
        "x-tarobird-conversation-id": conversationId, ...(messageId ? { "x-tarobird-context-message": messageId } : {}),
      },
      body: JSON.stringify(body ?? { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  }

  it("serves the fixed bundled artifact only to a paired owner device, while blocking null origins and query-token sockets", async () => {
    expect(CANVAS_TOOL_NAMES).toContain("canvas_get_state");
    expect(canvasOpSchema.safeParse({ type: "add_node", nodeType: "text", title: "Idea" }).success).toBe(true);
    const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "canvas-artifacts-"));
    tempDirs.push(artifactsDir);
    const bundle = path.join(artifactsDir, "tarobird.infinite-canvas", "1.0.0");
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, "bundle.html"), "<!doctype html><body>fixture</body>");
    const { hub, chat } = await startHub({ pluginArtifactsDir: artifactsDir });
    const owner = await app(hub, "owner_fixture");
    const route = "/api/plugins/artifacts/tarobird.infinite-canvas/1.0.0/bundle.html";
    expect((await fetch(hub.url + route)).status).toBe(401);
    const member = await app(hub, "member_fixture", true);
    expect((await member.request(route)).status).toBe(403);
    const preflight = await fetch(hub.url + "/api/canvas-agent/state", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase().split(/,\s*/)).not.toContain("x-tarobird-conversation-id");
    const artifact = await owner.request(route);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("content-type")).toContain("text/plain");
    expect(artifact.headers.get("content-disposition")).toContain("attachment");
    expect(artifact.headers.get("content-security-policy")).toContain("sandbox");
    expect(await artifact.text()).toContain("fixture");
    expect((await owner.request(route.replace("bundle.html", "secret.txt"))).status).toBe(404);

    const canvas = await grant(hub, owner, chat.id, "workbench", "canvas_tab", "canvas_client", "project_fixture");
    expect((await owner.request("/api/canvas-agent/token", { conversationId: chat.id, windowId: "workbench", tabId: "canvas_tab", clientId: "blocked" }, "null")).status).toBe(403);
    for (const [operation, body] of [["state", { snapshot: null }], ["activate", {}], ["result", { requestId: "fixture" }]] as const) {
      expect((await canvasPost(hub, operation, canvas, body, "null")).status).toBe(403);
    }
    await expect(peer(hub.url.replace(/^http/, "ws") + `/api/canvas-agent/events?clientId=${canvas.clientId}&token=${canvas.token}`)).rejects.toThrow();
    expect((await fetch(hub.url + "/api/host-profile", { headers: { Authorization: `Bearer ${canvas.token}` } })).status).toBe(401);
  });

  it("announces the canvas agent methods to Bots in instance.ready", async () => {
    const { hub } = await startHub();
    const socket = await peer(hub.instanceUrl.replace(/^http/, "ws") + "/instance");
    socket.send({ type: "instance.hello", botId: "canvas_bot", secret, engine: "codex", model: "", effort: "", capabilities: [] });
    expect((await socket.next("instance.ready")).capabilities).toContain("canvas.agent.v1");
  });

  it("counts only rejected canvas bridge requests per source and then refuses that source before reading the token", async () => {
    const { hub, chat } = await startHub();
    const owner = await app(hub, "rate_owner");
    const canvas = await grant(hub, owner, chat.id, "window_r", "tab_r", "client_r", "project_r");
    const wrong = { clientId: canvas.clientId, token: "wrong-token" };
    // Accepted requests are never counted: far more than the rejection budget go through.
    for (let i = 0; i < 150; i++) expect((await canvasPost(hub, "activate", canvas)).status).toBe(200);
    // Rejections are counted: 60 are answered 401, after that the source is refused.
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) statuses.push((await canvasPost(hub, i % 2 ? "activate" : "result", wrong, { requestId: "fixture" })).status);
    const limited = statuses.indexOf(429);
    expect(limited).toBeGreaterThanOrEqual(60);
    expect(limited).toBeLessThanOrEqual(61);
    expect(statuses.slice(0, limited).every(status => status === 401)).toBe(true);
    expect(statuses.slice(limited).every(status => status === 429)).toBe(true);
    // The refusal is per source and comes before the token is read, so the valid token is refused too.
    expect((await canvasPost(hub, "activate", canvas)).status).toBe(429);
  });

  it("carries the live canvas hint on the existing delivery only for its connected conversation", async () => {
    const { hub, chat } = await startHub();
    const owner = await app(hub, "hint_owner");
    const worker = await bot(hub, ["canvas.agent.v1"]);
    let sequence = 0;
    const deliver = async (conversationId: string) => {
      const turn = await hub.store.sendMessage("owner", { conversationId, clientMsgId: `hint_${++sequence}`, text: "Fixture", attachments: [] });
      const frame = await worker.next("instance.message", value => value.message.id === turn.message.id);
      await hub.store.acknowledgeDelivery("canvas_bot", turn.message.id);
      return frame;
    };
    expect(await deliver(chat.id)).not.toHaveProperty("canvasConnected");
    const canvas = await grant(hub, owner, chat.id, "workbench", "canvas_tab", "hint_client", "fixture");
    expect(await deliver(chat.id)).toMatchObject({ canvasConnected: true });
    const other = await hub.store.createConversation("owner", ["canvas_bot"], "Other", "hint_other");
    expect(await deliver(other.id)).not.toHaveProperty("canvasConnected");
    await owner.request("/api/canvas-agent/revoke", { conversationId: chat.id, clientId: canvas.clientId, token: canvas.token });
    expect(await deliver(chat.id)).not.toHaveProperty("canvasConnected");
  });

  it("requires a live direct owner turn for HTTP listing and every instance Canvas method", async () => {
    const { hub, chat } = await startHub();
    const otherChat = await hub.store.createConversation("owner", ["canvas_bot"], "Wrong Chat", "wrong_chat");
    const worker = await bot(hub);
    const owner = await app(hub, "owner_fixture");
    const canvas = await grant(hub, owner, chat.id, "workbench", "canvas_tab", "canvas_client", "project_fixture");
    const turn = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "owner_turn", text: "Read my canvas", attachments: [] });
    await worker.next("instance.message", frame => frame.message.id === turn.message.id);
    const tags = { conversationId: chat.id, contextMessageId: turn.message.id };
    expect((await mcp(hub, chat.id, undefined)).status).toBe(400);
    expect((await mcp(hub, chat.id, turn.message.id, undefined, "short")).status).toBe(401);
    expect((await mcp(hub, otherChat.id, turn.message.id)).status).toBe(403);
    expect((await mcp(hub, chat.id, "missing_turn")).status).toBe(404);
    const listed = await mcp(hub, chat.id, turn.message.id);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { result: { tools: Array<{ name: string }> } }).result.tools.some(tool => tool.name === "canvas_apply_ops")).toBe(true);
    expect(await worker.request("canvas.agent.status", tags)).toMatchObject({ result: { connected: true, projectId: "project_fixture" } });
    expect(await worker.request("canvas.agent.status", { conversationId: chat.id })).toMatchObject({ error: "invalid_request" });
    expect(await worker.request("canvas.agent.tools", { ...tags, conversationId: otherChat.id })).toMatchObject({ error: "workbench_context_forbidden" });
    const rejected = await worker.request("canvas.agent.call", { ...tags, name: "canvas_get_state", projectId: "other_project" });
    expect(rejected).toMatchObject({ error: "canvas_project_mismatch" });
    const pending = worker.request("canvas.agent.call", { ...tags, name: "canvas_get_state" });
    const event = await owner.next("canvas.agent.event", frame => frame.event === "tool_call");
    await hub.store.acknowledgeDelivery("canvas_bot", turn.message.id);
    expect((await canvasPost(hub, "result", canvas, { requestId: event.data.requestId, result: { title: "private" } })).status).toBe(200);
    expect(await pending).toMatchObject({ error: "workbench_turn_ended" });
    expect((await mcp(hub, chat.id, turn.message.id)).status).toBe(409);
    for (const method of ["canvas.agent.status", "canvas.agent.tools", "canvas.agent.call"]) {
      expect(await worker.request(method, { ...tags, ...(method.endsWith(".call") ? { name: "canvas_get_state" } : {}) })).toMatchObject({ error: "workbench_turn_ended" });
    }
  });

  it("blocks deferred and non-owner inputs, and selects only the frozen device, window and tab", async () => {
    const { hub, chat } = await startHub();
    const worker = await bot(hub);
    const owner = await app(hub, "owner_fixture");
    const second = await app(hub, "second_fixture");
    const first = await grant(hub, owner, chat.id, "window_a", "tab_a", "client_a", "project_a");
    await grant(hub, owner, chat.id, "window_b", "tab_a", "client_b", "project_b");
    await grant(hub, owner, chat.id, "window_a", "tab_b", "client_c", "project_c");
    await grant(hub, second, chat.id, "window_a", "tab_a", "client_a", "project_d");
    second.send({ type: "canvas.agent.attach", token: first.token, clientId: first.clientId });
    expect(await second.next("error")).toMatchObject({ code: "canvas_agent_forbidden" });

    const direct = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "chosen_target", text: "Read this window", attachments: [] });
    await worker.next("instance.message", frame => frame.message.id === direct.message.id);
    const params = { conversationId: chat.id, contextMessageId: direct.message.id };
    expect(await worker.request("canvas.agent.status", params)).toMatchObject({ result: { connected: false } });
    const freeze = (deviceId: string, windowId: string, tabId: string) => hub.store.db.run(
      "INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",
      [`workbench-context:${direct.message.id}`, JSON.stringify({ target: { deviceId, windowId, tabId } })],
    );
    await freeze(owner.deviceId, "window_a", "tab_a");
    expect(await worker.request("canvas.agent.status", params)).toMatchObject({ result: { connected: true, projectId: "project_a" } });
    await freeze(owner.deviceId, "window_missing", "tab_a");
    expect(await worker.request("canvas.agent.status", params)).toMatchObject({ result: { connected: false } });

    // Agent Bus starts with ordinary owner-authored delivery data, even though
    // it did not originate as an active direct user message to the Bot.
    await hub.store.db.run("INSERT INTO agent_bus_runs(id,workspace_id,owner_id,coordinator_id,conversation_id,message_id,snapshot_json,text,status,created_at) VALUES('bus','work','owner','canvas_bot',?,?,'{}','fixture','running',0)", [chat.id, direct.message.id]);
    expect(await worker.request("canvas.agent.status", params)).toMatchObject({ error: "workbench_context_forbidden" });
    expect((await mcp(hub, chat.id, direct.message.id)).status).toBe(403);
    await hub.store.acknowledgeDelivery("canvas_bot", direct.message.id);
    await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('guest','Fixture guest','member')");
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [chat.id]);
    const guest = await hub.store.sendMessage("guest", { conversationId: chat.id, clientMsgId: "guest_turn", text: "Read another canvas", attachments: [] });
    // Delivery was admitted under the fixture's same conversation membership.
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id='canvas_bot'", [guest.message.id]);
    expect(await worker.request("canvas.agent.status", { conversationId: chat.id, contextMessageId: guest.message.id })).toMatchObject({ error: "owner_required" });
  });

  it("rejects stale tokens after replacement during a streamed body or an outdated detach or revoke", async () => {
    const { hub, chat } = await startHub();
    const owner = await app(hub, "owner_fixture");
    const first = await grant(hub, owner, chat.id, "window_a", "tab_a", "client_a", "project_a");
    const { request: httpRequest } = await import("node:http");
    const body = JSON.stringify({ snapshot: { projectId: "stale_project", title: "Stale" } });
    let sent!: () => void;
    const started = new Promise<void>(resolve => { sent = resolve; });
    let releaseBody!: () => void;
    const staleResponse = new Promise<number>((resolve, reject) => {
      const request = httpRequest(hub.url + "/api/canvas-agent/state?clientId=client_a", {
        method: "POST", headers: { Authorization: `CanvasAgent ${first.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, result => { result.resume(); resolve(result.statusCode ?? 0); });
      request.once("error", reject);
      request.write(body.slice(0, 8), sent);
      releaseBody = () => request.end(body.slice(8));
    });
    await started;
    const scope = { conversationId: chat.id, windowId: "window_a", tabId: "tab_a", clientId: first.clientId };
    expect((await owner.request("/api/canvas-agent/token", scope)).status).toBe(409);
    const replacement = await owner.request("/api/canvas-agent/token", { ...scope, renewToken: first.token });
    expect(replacement.status).toBe(200);
    const second = await replacement.json() as typeof first;
    owner.send({ type: "canvas.agent.attach", token: second.token, clientId: second.clientId });
    await owner.next("canvas.agent.event", event => event.event === "hello" && event.clientId === second.clientId);
    // The replacement is already scoped to the live tab's activity snapshot.
    const worker = await bot(hub);
    const turn = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "renewal_turn", text: "Read my canvas", attachments: [] });
    await worker.next("instance.message", frame => frame.message.id === turn.message.id);
    expect(await worker.request("canvas.agent.status", { conversationId: chat.id, contextMessageId: turn.message.id })).toMatchObject({
      result: { projectId: "project_a" },
    });
    expect(second.token).not.toBe(first.token);
    const renewedStale = await owner.request("/api/canvas-agent/token", {
      conversationId: chat.id, windowId: "window_a", tabId: "tab_a", clientId: first.clientId, renewToken: first.token,
    });
    expect(renewedStale.status).toBe(401);
    releaseBody();
    expect(await staleResponse).toBe(401);
    owner.send({ type: "canvas.agent.detach", clientId: first.clientId, token: first.token });
    expect((await owner.request("/api/canvas-agent/revoke", { conversationId: chat.id, clientId: first.clientId, token: first.token })).status).toBe(200);
    expect((await canvasPost(hub, "activate", second)).status).toBe(200);
    expect((await canvasPost(hub, "result", first, { requestId: "fixture" })).status).toBe(401);
    await hub.auth.revoke(owner.deviceId, "local-owner");
    expect((await canvasPost(hub, "activate", second)).status).toBe(401);
  });

  it("runs an authorized Canvas call through the real Gateway tool and parent result transport", async () => {
    const { hub, dir, chat } = await startHub();
    const owner = await app(hub, "owner_fixture");
    const canvas = await grant(hub, owner, chat.id, "window_a", "tab_a", "client_a", "project_fixture");
    const stateDir = path.join(dir, "bot_fixture");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
    let resolveTurn!: (value: unknown) => void;
    let rejectTurn!: (error: unknown) => void;
    const turnDone = new Promise<unknown>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    void turnDone.catch(() => undefined);
    const gateway = await attachGateway({
      stateDir, url: hub.instanceUrl.replace(/^http/, "ws") + "/instance", botId: "canvas_bot", secret, engine: "codex",
      runtime: createCoreServiceRuntime(),
      bridge: {
        handleAuthorizedMessage: async input => {
          try {
            const tools = input.appPlatformTools;
            const signal = new AbortController().signal;
            const listed = await tools?.call({ callId: "list", sessionId: "fixture", name: "app_canvas_agent", arguments: { tool: "canvas_list_tools" }, abortSignal: signal });
            const state = await tools?.call({ callId: "state", sessionId: "fixture", name: "app_canvas_agent", arguments: { tool: "canvas_get_state", arguments: {} }, abortSignal: signal });
            const muted = createAppPlatformTools({ channel: gateway, stateDir, conversationId: chat.id, receipts: new GatewayReceipts(stateDir), signal, suppressDelivery: true });
            const blocked = await muted.call({ callId: "muted", sessionId: "fixture", name: "app_canvas_agent", arguments: { tool: "canvas_get_state", arguments: {} }, abortSignal: signal });
            resolveTurn({ names: tools?.definitions.map(tool => tool.name), listed: listed?.text, state: state?.text, blocked: blocked.isError });
          } catch (error) { rejectTurn(error); }
          return { text: "Canvas checked" };
        },
      },
    });
    try {
      await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "gateway_canvas_turn", text: "Read my canvas", attachments: [] });
      const frame = await owner.next("canvas.agent.event", incoming => incoming.event === "tool_call");
      expect(frame).toMatchObject({ clientId: canvas.clientId, data: { name: "canvas_get_state", projectId: "project_fixture" } });
      expect((await canvasPost(hub, "result", canvas, { requestId: frame.data.requestId, result: { projectId: "project_fixture", nodes: [] } })).status).toBe(200);
      expect(await turnDone).toMatchObject({
        names: expect.arrayContaining(["app_canvas_agent"]), listed: expect.stringContaining("canvas_apply_ops"),
        state: expect.stringContaining("project_fixture"), blocked: true,
      });
    } finally { await gateway.disconnect(); }
  });

  it("keeps authenticated MCP on the instance listener and sends the current turn from the CLI", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "canvas-tls-"));
    tempDirs.push(dir);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "hub.key", "-out", "hub.crt", "-days", "1", "-subj", "/CN=localhost"], { cwd: dir, stdio: "ignore" });
    const tls = { key: await readFile(path.join(dir, "hub.key")), cert: await readFile(path.join(dir, "hub.crt")) };
    const { hub, dir: hubDir, chat } = await startHub({ tls });
    const worker = await bot(hub);
    const turn = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "tls_turn", text: "Read canvas", attachments: [] });
    await worker.next("instance.message", frame => frame.message.id === turn.message.id);
    const tlsUrl = new URL(hub.url);
    const tlsStatus = await new Promise<number>((resolve, reject) => {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const request = httpsRequest({
        hostname: "127.0.0.1", port: Number(tlsUrl.port), path: "/api/canvas-agent/mcp", method: "POST", rejectUnauthorized: false,
        headers: { Authorization: `Instance canvas_bot:${secret}`, "x-tarobird-conversation-id": chat.id, "x-tarobird-context-message": turn.message.id, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, response => { response.resume(); resolve(response.statusCode ?? 0); });
      request.once("error", reject); request.end(payload);
    });
    expect(tlsStatus).toBe(401);
    expect((await mcp(hub, chat.id, turn.message.id)).status).toBe(200);

    const { startHubControl } = await import("../src/hub/service.js");
    const { runWorkbenchCommand } = await import("../src/host-cli/workbench.js");
    const stateDir = path.join(hubDir, "bots", "canvas_bot");
    const inputFile = path.join(hubDir, "request.json");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
    await writeFile(inputFile, JSON.stringify({ method: "tools/list" }));
    const close = await startHubControl(hubDir, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {});
    const env = { bot: process.env.TAROBOT_ACTIVE_INSTANCE, state: process.env.TAROBOT_ACTIVE_STATE_DIR };
    process.env.TAROBOT_ACTIVE_INSTANCE = "canvas_bot";
    process.env.TAROBOT_ACTIVE_STATE_DIR = stateDir;
    try {
      await expect(runWorkbenchCommand(hubDir, "canvas-agent", chat.id, { from: inputFile, contextMessageId: turn.message.id }))
        .resolves.toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: "canvas_get_state" })]) } });
      await hub.store.acknowledgeDelivery("canvas_bot", turn.message.id);
      await expect(runWorkbenchCommand(hubDir, "canvas-agent", chat.id, { from: inputFile, contextMessageId: turn.message.id })).rejects.toThrow("workbench_turn_ended");
    } finally {
      if (env.bot === undefined) delete process.env.TAROBOT_ACTIVE_INSTANCE; else process.env.TAROBOT_ACTIVE_INSTANCE = env.bot;
      if (env.state === undefined) delete process.env.TAROBOT_ACTIVE_STATE_DIR; else process.env.TAROBOT_ACTIVE_STATE_DIR = env.state;
      await close();
    }
  });
});
