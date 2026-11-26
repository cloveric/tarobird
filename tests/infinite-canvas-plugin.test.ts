import { describe, expect, it, afterEach } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
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
  pluginScopeId,
  type PluginCredentialVault,
  type PluginStorageAdapter,
} from "../client/src/plugin-registry.js";
import { handlePluginHostMessage } from "../client/src/PluginSandboxFrame.js";
import {
  BUNDLED_OFFICIAL_NODE_PLUGINS,
  NodePluginManager,
} from "../integrations/infinite-canvas/src/node-plugins-state.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof } from "../src/hub/auth.js";

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

  it("rejects tampered download on SHA-256 mismatch and verifies real built artifact", async () => {
    const store = memoryStorage();
    const entry = OFFICIAL_PLUGIN_CATALOG.find((item) => item.manifest.id === "tarobird.infinite-canvas")!;
    const registry = new PluginRegistry({
      storage: store,
      fetcher: async () => "<!doctype html><html><body>tampered payload</body></html>",
    });

    await expect(registry.install(entry)).rejects.toThrow("plugin_hash_mismatch");
    expect(registry.getPlugin("tarobird.infinite-canvas")).toBeUndefined();
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
});

describe("Host Canvas Agent bridge handshake, auth & Bot permission scoping (#81)", () => {
  it("issues tab-scoped short-lived tokens, bridges WS tool calls, and enforces conversation + Bot permissions", async () => {
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

    // Verify artifact serving works without exposing anything outside artifactsDir
    const artRes = await fetch(`${hub.url}/api/plugins/artifacts/tarobird.infinite-canvas/1.0.0/bundle.html`);
    expect(artRes.status).toBe(200);
    expect(await artRes.text()).toContain("ok");
    const badArtRes = await fetch(`${hub.url}/api/plugins/artifacts/tarobird.infinite-canvas/1.0.0/secret.txt`);
    expect(badArtRes.status).toBe(404);

    // Pair owner device & authenticate via real WS challenge/response to obtain session token
    const keypair = generateKeyPairSync("ed25519");
    const ctrlKey = keypair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    await hub.enrollLocalController({ deviceId: "dev_owner_81", name: "macmini", platform: "macos", publicKey: ctrlKey });
    const sessionToken = await new Promise<string>((resolve, reject) => {
      const authWs = new WebSocket(`${hub.url.replace(/^http/, "ws")}/ws`);
      const clientNonce = randomBytes(32).toString("base64url");
      authWs.once("error", reject);
      authWs.once("open", () => {
        authWs.send(JSON.stringify({ v: 1, type: "hello", deviceId: "dev_owner_81", nonce: clientNonce, protocolVersions: [1], capabilities: ["cards.v1", "management.v1"], cursors: {} }));
      });
      authWs.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; nonce?: string; sessionToken?: string };
        if (msg.type === "challenge" && msg.nonce) {
          const sig = sign(null, deviceProof("dev_owner_81", msg.nonce, clientNonce), keypair.privateKey).toString("base64");
          authWs.send(JSON.stringify({ v: 1, type: "auth", signature: sig }));
        } else if (msg.type === "ready" && msg.sessionToken) {
          authWs.close();
          resolve(msg.sessionToken);
        }
      });
    });
    const session = { token: sessionToken };
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_allowed','Canvas Bot','codex',?,1)", [
      createHash("sha256").update("bot-secret-allowed").digest("hex"),
    ]);
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_other','Other Bot','codex',?,1)", [
      createHash("sha256").update("bot-secret-other").digest("hex"),
    ]);
    const convA = await hub.store.createConversation("owner", ["bot_allowed"], "Canvas Chat A", "conv_a", "direct");
    const convB = await hub.store.createConversation("owner", ["bot_other"], "Other Chat B", "conv_b", "direct");

    // Mint short-lived Canvas Agent token for convA.id
    const tokenRes = await fetch(`${hub.url}/api/canvas-agent/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: convA.id, tabId: "tab_ic_1", clientId: "client_ic_1" }),
    });
    expect(tokenRes.status).toBe(200);
    const issued = await tokenRes.json() as { token: string; protocolVersion: number; clientId: string; conversationId: string };
    expect(issued.protocolVersion).toBe(12);
    expect(issued.clientId).toBe("client_ic_1");
    expect(issued.conversationId).toBe(convA.id);

    // Canvas Agent token MUST NOT grant access to regular Hub endpoints
    const forbiddenHubCall = await fetch(`${hub.url}/api/host-profile`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(forbiddenHubCall.status).toBe(401);

    // Connect Canvas Agent WS with valid token + matching clientId
    const wsUrl = `${hub.url.replace(/^http/, "ws")}/api/canvas-agent/events?clientId=client_ic_1&token=${encodeURIComponent(issued.token)}`;
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
    expect(hello.data.clientId).toBe("client_ic_1");

    // Publish canvas snapshot state
    const stateRes = await fetch(`${hub.url}/api/canvas-agent/state?clientId=client_ic_1`, {
      method: "POST",
      headers: { Authorization: `CanvasAgent ${issued.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot: { projectId: "proj_1", title: "Architecture Board" } }),
    });
    expect(stateRes.status).toBe(200);

    // Wire WS tool_call responder
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "tool_call") {
        void fetch(`${hub.url}/api/canvas-agent/result?clientId=client_ic_1`, {
          method: "POST",
          headers: { Authorization: `CanvasAgent ${issued.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: msg.data.requestId,
            result: { projectId: "proj_1", nodes: [{ id: "n1", type: "text", title: "Hello" }] },
          }),
        });
      }
    });

    // Authorized Bot (bot_allowed in convA) calls MCP canvas_get_state -> succeeds
    const mcpOk = await fetch(`${hub.url}/api/canvas-agent/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Instance bot_allowed:bot-secret-allowed",
        "x-tarobird-conversation-id": convA.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "canvas_get_state", arguments: {} } }),
    });
    expect(mcpOk.status).toBe(200);
    const mcpBody = await mcpOk.json() as { result: { content: Array<{ text: string }> } };
    expect(mcpBody.result.content[0]!.text).toContain("proj_1");

    // Unauthorized Bot (bot_other NOT in convA) is rejected!
    const mcpForbidden = await fetch(`${hub.url}/api/canvas-agent/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Instance bot_other:bot-secret-other",
        "x-tarobird-conversation-id": convA.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "canvas_get_state", arguments: {} } }),
    });
    expect(mcpForbidden.status).toBe(403);
    expect(convB.id).not.toBe(convA.id);

    // Revoking token disconnects / rejects further Canvas Agent requests
    const revokeRes = await fetch(`${hub.url}/api/canvas-agent/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: convA.id, clientId: "client_ic_1" }),
    });
    expect(revokeRes.status).toBe(200);
    const afterRevoke = await fetch(`${hub.url}/api/canvas-agent/health?clientId=client_ic_1`, {
      headers: { Authorization: `CanvasAgent ${issued.token}` },
    });
    expect(afterRevoke.status).toBe(401);
    ws.close();
  });
});
