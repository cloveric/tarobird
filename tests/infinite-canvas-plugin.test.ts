import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
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
import {
  BUNDLED_OFFICIAL_NODE_PLUGINS,
  NodePluginManager,
} from "../integrations/infinite-canvas/src/node-plugins-state.js";
import {
  DEFAULT_PROMPTS,
  createStarterProject,
  executeCanvasAgentTool,
  type CanvasAsset,
  type GenerationRecord,
} from "../integrations/infinite-canvas/src/canvas-engine.js";
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

async function authenticateOwnerDevice(hub: HubServer, deviceId = "dev_owner_81"): Promise<string> {
  const keypair = generateKeyPairSync("ed25519");
  const ctrlKey = keypair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  await hub.enrollLocalController({ deviceId, name: "macmini", platform: "macos", publicKey: ctrlKey });
  return new Promise<string>((resolve, reject) => {
    const authWs = new WebSocket(`${hub.url.replace(/^http/, "ws")}/ws`);
    const clientNonce = randomBytes(32).toString("base64url");
    authWs.once("error", reject);
    authWs.once("open", () => {
      authWs.send(JSON.stringify({ v: 1, type: "hello", deviceId, nonce: clientNonce, protocolVersions: [1], capabilities: ["cards.v1", "management.v1"], cursors: {} }));
    });
    authWs.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; nonce?: string; sessionToken?: string };
      if (msg.type === "challenge" && msg.nonce) {
        const sig = sign(null, deviceProof(deviceId, msg.nonce, clientNonce), keypair.privateKey).toString("base64");
        authWs.send(JSON.stringify({ v: 1, type: "auth", signature: sig }));
      } else if (msg.type === "ready" && msg.sessionToken) {
        authWs.close();
        resolve(msg.sessionToken);
      }
    });
  });
}

describe("Infinite Canvas extension manifest, on-demand install & lifecycle (#81)", () => {
  it("declares tarobird.infinite-canvas as desktop-only, on-demand (not inline), with MIT attribution", () => {
    const entry = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas");
    expect(entry).toBeDefined();
    expect(entry!.bundleHtml).toBeUndefined();
    expect(entry!.manifest.artifact.url).toBeTruthy();
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
    const builtPath = path.resolve(process.cwd(), "dist/plugins/tarobird.infinite-canvas/1.0.0/bundle.html");
    const builtHtml = await readFile(builtPath, "utf8");
    const store = memoryStorage();
    const entry = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!;

    const wrongSizeRegistry = new PluginRegistry({
      storage: store,
      fetcher: async () => "<!doctype html><html><body>tampered payload</body></html>",
    });
    await expect(wrongSizeRegistry.install(entry)).rejects.toThrow("plugin_size_mismatch");
    expect(wrongSizeRegistry.getPlugin("tarobird.infinite-canvas")).toBeUndefined();

    const sameLengthTampered = `<!--x-->${builtHtml.slice(8)}`;
    const wrongHashRegistry = new PluginRegistry({
      storage: store,
      fetcher: async () => sameLengthTampered,
    });
    await expect(wrongHashRegistry.install(entry)).rejects.toThrow("plugin_hash_mismatch");
    expect(wrongHashRegistry.getPlugin("tarobird.infinite-canvas")).toBeUndefined();
  });

  it("installs on demand, updates, and supports uninstall with keepData vs wipe scoped by device+host+user", async () => {
    const builtPath = path.resolve(process.cwd(), "dist/plugins/tarobird.infinite-canvas/1.0.0/bundle.html");
    const builtHtml = await readFile(builtPath, "utf8");
    const entry = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!;
    expect(await sha256Hex(builtHtml)).toBe(entry.manifest.artifact.sha256);

    const store = memoryStorage();
    const vault = memoryCredentialVault();
    const scopeA = pluginScopeId("host_alpha", "user_1", "dev_1");
    const scopeB = pluginScopeId("host_beta", "user_1", "dev_1");

    let fetchCount = 0;
    const registry = new PluginRegistry({
      storage: store,
      credentialVault: vault,
      scopeId: scopeA,
      fetcher: async (url) => {
        expect(url).toBe(entry.manifest.artifact.url);
        fetchCount++;
        return builtHtml;
      },
    });

    const installed = await registry.install(entry);
    expect(installed.manifest.id).toBe("tarobird.infinite-canvas");
    expect(fetchCount).toBe(1);

    // Offline execution: bundle is cached locally and isolated per scope
    expect(registry.getPlugin("tarobird.infinite-canvas")?.bundleHtml).toBe(builtHtml);
    registry.setScope(scopeB);
    expect(registry.getPlugin("tarobird.infinite-canvas")).toBeUndefined();
    registry.setScope(scopeA);

    // Save canvas data & isolated API key (never in localStorage/store)
    await handlePluginHostMessage(
      { protocol: PLUGIN_HOST_PROTOCOL, id: "s1", method: "storage.set", key: "projects", value: JSON.stringify([{ id: "p1", title: "My Canvas" }]) },
      {
        pluginId: "tarobird.infinite-canvas",
        scopeId: scopeA,
        grantedCapabilities: ["storage.device", "canvas.agent"],
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
        grantedCapabilities: ["storage.device", "canvas.agent"],
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
    await registry.install(entry);
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
    expect(buildPluginCsp(["api.openai.com"])).toContain("img-src data: blob: https:");
    expect(buildPluginCsp(["api.openai.com"])).toContain("frame-src about:");
    expect(buildPluginCsp([])).toContain("img-src data: blob:;");

    const store = memoryStorage();
    const baseCtx = {
      pluginId: "tarobird.infinite-canvas",
      scopeId: "dev:host:u1",
      grantedCapabilities: ["storage.device", "canvas.agent"] as const,
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
      exportWorkspace: async () => { throw new Error("disk_readonly"); },
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

    // Local/private domains rejected; public HTTPS domain granted via host callback
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "d1", method: "domains.request", domain: "127.0.0.1:8080" }, baseCtx))
      .toMatchObject({ ok: false, error: "invalid_domain" });
    expect(await handlePluginHostMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: "d2", method: "domains.request", domain: "api.custom-provider.example" }, baseCtx))
      .toMatchObject({ ok: true, result: { granted: true, domain: "api.custom-provider.example" } });
  });
});

describe("Infinite Canvas bundled official & third-party node plugins (#81)", () => {
  it("bundles all 6 official node plugins offline and keeps third-party plugins off by default with warning + URL gate", () => {
    expect(BUNDLED_OFFICIAL_NODE_PLUGINS.map((p) => p.id).sort()).toEqual([
      "html",
      "markdown",
      "panorama",
      "sticky-note",
      "svg",
      "template",
    ]);

    const mgr = new NodePluginManager({ scopeId: "dev1:host1:user1" });
    expect(mgr.getState().allowThirdParty).toBe(false);
    expect(mgr.getState().officialEnabled).toEqual(["html", "markdown", "panorama", "sticky-note", "svg", "template"]);

    // Must not allow enabling third-party without explicit warning confirmation
    expect(() => mgr.enableThirdParty(false)).toThrow("third_party_warning_not_confirmed");
    expect(mgr.getState().allowThirdParty).toBe(false);

    // Must not allow installing third-party plugin while switch is off
    expect(() => mgr.installThirdParty({ id: "tp.custom", name: "Custom", url: "https://example.com/plugin.js", confirmedUrl: true }))
      .toThrow("third_party_disabled");

    // Confirm warning -> switch turns on
    mgr.enableThirdParty(true);
    expect(mgr.getState().allowThirdParty).toBe(true);

    // Installing third-party requires confirming the exact source URL
    expect(() => mgr.installThirdParty({ id: "tp.custom", name: "Custom", url: "https://example.com/plugin.js", confirmedUrl: false }))
      .toThrow("third_party_url_not_confirmed");

    mgr.installThirdParty({ id: "tp.custom", name: "Custom", url: "https://example.com/plugin.js", confirmedUrl: true });
    expect(mgr.getState().thirdParty).toHaveLength(1);
    expect(mgr.getState().thirdParty[0]!.enabled).toBe(true);

    // Turning switch OFF disables third-party plugins WITHOUT deleting them
    mgr.disableThirdParty();
    expect(mgr.getState().allowThirdParty).toBe(false);
    expect(mgr.getState().thirdParty).toHaveLength(1);
    expect(mgr.getState().thirdParty[0]!.enabled).toBe(false);
  });

  it("executes batched add_node+run_generation, set_group_members, audio node mapping, and filter/pagination args accurately", async () => {
    let project = createStarterProject();
    const assets: CanvasAsset[] = [];
    const generations: GenerationRecord[] = [];
    const generatedNodeIds: string[] = [];
    const env = {
      getProject: () => project,
      updateProject: (updater: (current: typeof project) => typeof project) => {
        project = updater(project);
      },
      getChannel: () => ({
        name: "Default",
        baseUrl: "https://api.openai.com/v1",
        imageModel: "gpt-image-1",
        videoModel: "sora-2",
        textModel: "gpt-4o-mini",
      }),
      getAssets: () => assets,
      addAsset: (asset: Omit<CanvasAsset, "id" | "createdAt">) => {
        const created: CanvasAsset = { ...asset, id: `asset_${assets.length + 1}`, createdAt: Date.now() };
        assets.push(created);
        return created;
      },
      getPrompts: () => DEFAULT_PROMPTS,
      getGenerations: () => generations,
      triggerGeneration: async (nodeId: string, promptOverride?: string, mode?: "image" | "video" | "text" | "audio"): Promise<GenerationRecord> => {
        const rec: GenerationRecord = {
          id: `job_${nodeId}`,
          mode: mode ?? "image",
          prompt: promptOverride ?? "",
          model: "gpt-image-1",
          status: "succeeded",
          outputUrl: "data:image/png;base64,iVBORw0KGgo=",
          nodeId,
          createdAt: Date.now(),
        };
        generations.push(rec);
        generatedNodeIds.push(`${nodeId}:${rec.mode}:${rec.prompt}`);
        return rec;
      },
    };

    // Batched add_node + group_nodes + set_group_members + run_generation in ONE canvas_apply_ops call
    const applied = await executeCanvasAgentTool("canvas_apply_ops", {
      ops: [
        { type: "add_node", id: "n_gen", nodeType: "image", title: "Poster", metadata: { prompt: "Neon skyline" } },
        { type: "add_node", id: "n_aud", nodeType: "audio", title: "Voice", metadata: { prompt: "Narration" } },
        { type: "group_nodes", id: "g_1", title: "Campaign", ids: ["n_gen"] },
        { type: "set_group_members", groupId: "g_1", nodeIds: ["n_gen", "n_aud"] },
        { type: "run_generation", nodeId: "n_gen" },
      ],
    }, env) as { applied: boolean; createdIds: string[]; submittedNodeIds: string[] };
    expect(applied.applied).toBe(true);
    expect(applied.createdIds).toContain("n_gen");
    expect(applied.submittedNodeIds).toEqual(["n_gen"]);
    expect(generatedNodeIds).toEqual(["n_gen:image:Neon skyline"]);

    const filteredState = await executeCanvasAgentTool("canvas_get_state", { groupId: "g_1", offset: 1 }, env) as {
      total: number;
      nodes: Array<{ id: string }>;
    };
    expect(filteredState.total).toBe(3); // group node g_1 + n_gen + n_aud
    expect(filteredState.nodes.length).toBe(2);
    expect(project.nodes.find((n) => n.id === "n_gen")?.groupId).toBe("g_1");
    expect(project.nodes.find((n) => n.id === "n_aud")?.groupId).toBe("g_1");

    // Audio mode in canvas_create_generation_flow maps to node type "audio" (not "video")
    const audioFlow = await executeCanvasAgentTool("canvas_create_generation_flow", {
      prompt: "Ambient loop",
      mode: "audio",
      autoRun: false,
    }, env) as { createdNodeIds: string[] };
    const audioNode = project.nodes.find((n) => n.id === audioFlow.createdNodeIds[0]);
    expect(audioNode?.type).toBe("audio");

    // canvas_list_models honors capability and keyword filters
    const imgModels = await executeCanvasAgentTool("canvas_list_models", { capability: "image", keyword: "gpt" }, env) as {
      models: Array<{ id: string }>;
    };
    expect(imgModels.models.length).toBeGreaterThan(0);
    expect(imgModels.models.every((m) => m.id.toLowerCase().includes("gpt"))).toBe(true);
  });
});

describe("Host Canvas Agent bridge handshake, auth, security & Bot tool wiring (#81)", () => {
  it("issues tab-scoped short-lived tokens, hardens artifact serving, bridges WS + Gateway app_canvas_agent tool, and enforces revocation/isolation", async () => {
    expect(CANVAS_AGENT_PROTOCOL_VERSION).toBe(12);
    expect(CANVAS_TOOL_NAMES).toContain("canvas_get_state");
    expect(CANVAS_TOOL_NAMES).toContain("canvas_apply_ops");
    expect(canvasOpSchema.safeParse({ type: "add_node", nodeType: "text", title: "Idea" }).success).toBe(true);

    const dir = await mkdtemp(path.join(os.tmpdir(), "tarobird-canvas-agent-"));
    tempDirs.push(dir);
    const artifactsDir = path.join(dir, "plugins");
    await mkdir(path.join(artifactsDir, "tarobird.infinite-canvas", "1.0.0"), { recursive: true });
    await writeFile(path.join(artifactsDir, "tarobird.infinite-canvas", "1.0.0", "bundle.html"), "<!doctype html><html><body>ok</body></html>");

    const hub = await HubServer.start({ stateDir: dir, pluginArtifactsDir: artifactsDir });
    hubs.push(hub);

    // Bug #3: Verify artifact serving uses non-executable download headers (no same-origin HTML XSS)
    const artRes = await fetch(`${hub.url}/api/plugins/artifacts/tarobird.infinite-canvas/1.0.0/bundle.html`);
    expect(artRes.status).toBe(200);
    expect(artRes.headers.get("content-type")).toContain("text/plain");
    expect(artRes.headers.get("content-disposition")).toContain("attachment");
    expect(artRes.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await artRes.text()).toContain("ok");
    const badArtRes = await fetch(`${hub.url}/api/plugins/artifacts/tarobird.infinite-canvas/1.0.0/secret.txt`);
    expect(badArtRes.status).toBe(404);

    // Bug #18: Exact WS path check rejects suffix-matched paths like /api/canvas-agent/events-extra
    await new Promise<void>((resolve) => {
      const badWs = new WebSocket(`${hub.url.replace(/^http/, "ws")}/api/canvas-agent/events-extra`);
      badWs.once("error", () => resolve());
      badWs.once("close", () => resolve());
    });

    const sessionToken = await authenticateOwnerDevice(hub, "dev_owner_81");
    const secondDeviceToken = await authenticateOwnerDevice(hub, "dev_second_81");
    const allowedSecret = "bot-secret-allowed-0123456789abcdef";
    const otherSecret = "bot-secret-other-0123456789abcdef01";

    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_allowed','Canvas Bot','codex',?,1)", [
      createHash("sha256").update(allowedSecret).digest("hex"),
    ]);
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_other','Other Bot','codex',?,1)", [
      createHash("sha256").update(otherSecret).digest("hex"),
    ]);
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_badhash','Bad Hash Bot','codex','not-a-valid-hex-hash',1)");

    const convA = await hub.store.createConversation("owner", ["bot_allowed"], "Canvas Chat A", "conv_a", { type: "direct" });
    const convB = await hub.store.createConversation("owner", ["bot_other"], "Other Chat B", "conv_b", { type: "direct" });

    // Bug #6: Reject short secrets (<32 chars) and malformed stored secret_hash without RangeError crash
    const shortSecretRes = await fetch(`${hub.url}/api/canvas-agent/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Instance bot_allowed:short-secret",
        "x-tarobird-conversation-id": convA.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(shortSecretRes.status).toBe(401);

    const badHashRes = await fetch(`${hub.url}/api/canvas-agent/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Instance bot_badhash:0123456789abcdef0123456789abcdef",
        "x-tarobird-conversation-id": convA.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(badHashRes.status).toBe(401);

    // Mint short-lived Canvas Agent token for convA.id
    const tokenRes = await fetch(`${hub.url}/api/canvas-agent/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: convA.id, tabId: "tab_ic_1", clientId: "client_shared_id" }),
    });
    expect(tokenRes.status).toBe(200);
    const issued = await tokenRes.json() as { token: string; protocolVersion: number; clientId: string; conversationId: string };
    expect(issued.protocolVersion).toBe(12);
    expect(issued.clientId).toBe("client_shared_id");
    expect(issued.conversationId).toBe(convA.id);

    // Canvas Agent token MUST NOT grant access to regular Hub endpoints
    const forbiddenHubCall = await fetch(`${hub.url}/api/host-profile`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(forbiddenHubCall.status).toBe(401);

    // Connect Canvas Agent WS for dev_owner_81 / convA with clientId="client_shared_id"
    const wsUrl = `${hub.url.replace(/^http/, "ws")}/api/canvas-agent/events?clientId=client_shared_id&token=${encodeURIComponent(issued.token)}`;
    const ws = new WebSocket(wsUrl);
    const helloPromise = new Promise<{ type: string; data: { protocolVersion: number; clientId: string } }>((resolve, reject) => {
      ws.once("error", reject);
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "hello") resolve(msg);
      });
    });
    const hello = await helloPromise;
    expect(hello.data.protocolVersion).toBe(12);
    expect(hello.data.clientId).toBe("client_shared_id");

    // Bug #8: Another device/conversation using the SAME clientId must NOT hijack or close the first session!
    const tokenRes2 = await fetch(`${hub.url}/api/canvas-agent/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secondDeviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: convB.id, tabId: "tab_ic_2", clientId: "client_shared_id" }),
    });
    expect(tokenRes2.status).toBe(200);
    const issued2 = await tokenRes2.json() as { token: string };
    const ws2 = new WebSocket(`${hub.url.replace(/^http/, "ws")}/api/canvas-agent/events?clientId=client_shared_id&token=${encodeURIComponent(issued2.token)}`);
    await new Promise<void>((resolve, reject) => {
      ws2.once("error", reject);
      ws2.on("message", (raw) => { if (JSON.parse(String(raw)).type === "hello") resolve(); });
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Publish canvas snapshot state
    const stateRes = await fetch(`${hub.url}/api/canvas-agent/state?clientId=client_shared_id`, {
      method: "POST",
      headers: { Authorization: `CanvasAgent ${issued.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot: { projectId: "proj_1", title: "Architecture Board" } }),
    });
    expect(stateRes.status).toBe(200);

    // Wire WS tool_call responder
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "tool_call") {
        void fetch(`${hub.url}/api/canvas-agent/result?clientId=client_shared_id`, {
          method: "POST",
          headers: { Authorization: `CanvasAgent ${issued.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: msg.data.requestId,
            result: { projectId: "proj_1", tool: msg.data.name, nodes: [{ id: "n1", type: "text", title: "Hello" }] },
          }),
        });
      }
    });

    // Authorized Bot (bot_allowed in convA) calls MCP canvas_get_state -> succeeds
    const mcpOk = await fetch(`${hub.url}/api/canvas-agent/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Instance bot_allowed:${allowedSecret}`,
        "x-tarobird-conversation-id": convA.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "canvas_get_state", arguments: {} } }),
    });
    expect(mcpOk.status).toBe(200);
    const mcpBody = await mcpOk.json() as { result: { content: Array<{ text: string }> } };
    expect(mcpBody.result.content[0]!.text).toContain("proj_1");

    // Bug #2: Real Bot runtime tool wiring (attachGateway -> createAppPlatformTools `app_canvas_agent` -> Hub -> Canvas Agent WS)
    const botStateDir = path.join(dir, "bot_allowed_state");
    await mkdir(botStateDir, { recursive: true });
    await writeFile(path.join(botStateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
    let toolOutcome: { hasTool?: boolean; listText?: string; stateText?: string; mutedIsError?: boolean; hasGuide?: boolean } = {};
    let resolveTurn!: () => void;
    const turnDone = new Promise<void>((resolve) => { resolveTurn = resolve; });
    let attachedChannel: Awaited<ReturnType<typeof attachGateway>> | undefined;
    attachedChannel = await attachGateway({
      stateDir: botStateDir,
      url: hub.url.replace(/^http/, "ws") + "/instance",
      botId: "bot_allowed",
      secret: allowedSecret,
      engine: "codex",
      runtime: createCoreServiceRuntime(),
      bridge: {
        handleAuthorizedMessage: async (input) => {
          const tools = input.appPlatformTools;
          const abortSignal = new AbortController().signal;
          const listRes = await tools?.call({ callId: "c1", sessionId: "s1", name: "app_canvas_agent", arguments: { tool: "canvas_list_tools" }, abortSignal });
          const stateToolRes = await tools?.call({ callId: "c2", sessionId: "s1", name: "app_canvas_agent", arguments: { tool: "canvas_get_state", arguments: {} }, abortSignal });
          const mutedTools = createAppPlatformTools({
            channel: attachedChannel!,
            stateDir: botStateDir,
            conversationId: convA.id,
            receipts: new GatewayReceipts(botStateDir),
            signal: abortSignal,
            suppressDelivery: true,
          });
          const mutedRes = await mutedTools.call({ callId: "c3", sessionId: "s1", name: "app_canvas_agent", arguments: { tool: "canvas_get_state", arguments: {} }, abortSignal });
          toolOutcome = {
            hasTool: tools?.definitions.some((d) => d.name === "app_canvas_agent"),
            listText: listRes?.text,
            stateText: stateToolRes?.text,
            mutedIsError: mutedRes.isError,
            hasGuide: input.appPlatformTools?.turnInstructions?.includes("app_canvas_agent"),
          };
          resolveTurn();
          return { text: "Checked canvas" };
        },
      },
    });
    try {
      await hub.store.sendMessage("owner", { conversationId: convA.id, clientMsgId: "msg_canvas_turn", text: "Check my canvas", attachments: [] });
      await turnDone;
      expect(toolOutcome.hasTool).toBe(true);
      expect(toolOutcome.hasGuide).toBe(true);
      expect(toolOutcome.listText).toContain("canvas_apply_ops");
      expect(toolOutcome.stateText).toContain("proj_1");
      expect(toolOutcome.mutedIsError).toBe(true);
    } finally {
      await attachedChannel.disconnect();
    }

    // Unauthorized Bot (bot_other NOT in convA) is rejected!
    const mcpForbidden = await fetch(`${hub.url}/api/canvas-agent/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Instance bot_other:${otherSecret}`,
        "x-tarobird-conversation-id": convA.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "canvas_get_state", arguments: {} } }),
    });
    expect(mcpForbidden.status).toBe(403);

    // Bug #7: Device revocation immediately closes active Canvas Agent WS and rejects further HTTP calls
    const ws2Closed = new Promise<void>((resolve) => ws2.once("close", () => resolve()));
    await hub.auth.revoke("dev_second_81", "local-owner");
    await ws2Closed;
    const afterDeviceRevoke = await fetch(`${hub.url}/api/canvas-agent/health?clientId=client_shared_id`, {
      headers: { Authorization: `CanvasAgent ${issued2.token}` },
    });
    expect(afterDeviceRevoke.status).toBe(401);

    // Revoking token disconnects / rejects further Canvas Agent requests on device 1 too
    const revokeRes = await fetch(`${hub.url}/api/canvas-agent/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: convA.id, clientId: "client_shared_id" }),
    });
    expect(revokeRes.status).toBe(200);
    const afterRevoke = await fetch(`${hub.url}/api/canvas-agent/health?clientId=client_shared_id`, {
      headers: { Authorization: `CanvasAgent ${issued.token}` },
    });
    expect(afterRevoke.status).toBe(401);
    ws.close();
  });

  it("rejects /api/canvas-agent/mcp on non-instance TLS Hub listeners while allowing loopback instance listener (Bug #6)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tarobird-canvas-noninstance-"));
    tempDirs.push(dir);
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "hub.key", "-out", "hub.crt", "-days", "1",
      "-subj", "/CN=localhost",
    ], { cwd: dir, stdio: "ignore" });
    const tls = {
      key: await readFile(path.join(dir, "hub.key")),
      cert: await readFile(path.join(dir, "hub.crt")),
    };

    const hub = await HubServer.start({ stateDir: path.join(dir, "hub"), tls });
    hubs.push(hub);

    const secret = "bot-secret-noninstance-0123456789ab";
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_ni','Bot','codex',?,1)", [
      createHash("sha256").update(secret).digest("hex"),
    ]);
    const conv = await hub.store.createConversation("owner", ["bot_ni"], "Chat", "conv_ni", { type: "direct" });

    // Non-instance TLS listener MUST reject /api/canvas-agent/mcp with 401
    const tlsUrl = new URL(hub.url);
    const tlsStatus = await new Promise<number>((resolve, reject) => {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const req = httpsRequest({
        hostname: "127.0.0.1",
        port: Number(tlsUrl.port),
        path: "/api/canvas-agent/mcp",
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          Authorization: `Instance bot_ni:${secret}`,
          "x-tarobird-conversation-id": conv.id,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(payload);
    });
    expect(tlsStatus).toBe(401);

    // Loopback instance listener still accepts the authenticated Bot MCP call
    const instanceRes = await fetch(`${hub.instanceUrl}/api/canvas-agent/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Instance bot_ni:${secret}`,
        "x-tarobird-conversation-id": conv.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(instanceRes.status).toBe(200);
  });
});
