import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, type ChildProcess, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import tls from "node:tls";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import WebSocket from "ws";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret, parsePublicKey } from "../src/hub/auth.js";
import { HubCloudflareTunnel } from "../src/hub/cloudflare-tunnel.js";
import { resolveEdgePort } from "../src/hub/cli.js";
import { startHubControl } from "../src/hub/service.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { signedDeviceAction } from "./helpers/device-actions.js";
import { deviceFields, enrollTrusted, loginFor, testDevice } from "./helpers/pairing-invite.js";
import { forgetPeerPin, peerPin } from "../src/hub/peer-tls.js";
import { exchangeNetworkPeer } from "../src/hub/network-peer.js";
import { exchangeBotMessage } from "../src/hub/bot-message-transport.js";
import { messageHostId } from "../src/hub/bot-messages.js";
import {
  deploymentMatchesRoutes,
  isDirectRoute,
  isEdgeTlsRoute,
  isRelayRoute,
  legacyV1Routes,
  localRoutesSchema,
  orderedRoutes,
  routeSchema,
  routesSchema,
} from "../src/client-protocol/routes.js";
import {
  networkGenesisText,
  networkHostDescriptorSchema,
  networkHostRoutes,
  networkManifestSchema,
  sharedRoutesSchema,
  type NetworkHost,
  type NetworkManifest,
  type SignedNetworkManifest,
  type SignedNetworkPeerRequest,
} from "../src/client-protocol/private-network.js";
import { edgeOriginSchema, verifyEdgeIdentity } from "../src/client-protocol/tls-identity.js";
import {
  cloudflareCommands,
  cloudflareQuickActionProofText,
  cloudflareUpdateProofText,
  HOST_CLOUDFLARE_PATH,
  HOST_CLOUDFLARE_QUICK_PATH,
} from "../src/client-protocol/cloudflare.js";
import type { BotPassport } from "../src/client-protocol/bot-messages.js";
import { rememberRouteTrust, routeTrust } from "../client/src/route-trust.js";
import { connectionPairingPayload } from "../client/src/pairing-link.js";

const dirs: string[] = [];
const hubs: HubServer[] = [];
const httpsServers: HttpsServer[] = [];
const defaultCaCertificates = tls.getCACertificates("default");

afterEach(async () => {
  tls.setDefaultCACertificates(defaultCaCertificates);
  await Promise.all(httpsServers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  while (hubs.length) await hubs.pop()!.close();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function startHub() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cf-103-"));
  dirs.push(dir);
  const hub = await HubServer.start({ stateDir: dir });
  hubs.push(hub);
  return hub;
}

const verifySignature = (publicKey: string, signature: string, message: Uint8Array) =>
  verify(null, message, parsePublicKey(publicKey), Buffer.from(signature, "base64"));

function tryOpenWs(url: string, headers: Record<string, string> = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 2000 });
    let done = false;
    const finish = (opened: boolean) => {
      if (done) return;
      done = true;
      try { ws.terminate(); } catch { /* ignore */ }
      resolve(opened);
    };
    ws.once("open", () => finish(true));
    ws.once("error", () => finish(false));
    ws.once("unexpected-response", () => finish(false));
    ws.once("close", () => finish(false));
  });
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  signals: Array<NodeJS.Signals | number | undefined> = [];
  constructor(private readonly ignoreSigterm = false) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.killed = true;
    if (this.exitCode !== null || this.signalCode !== null) return false;
    if (signal === "SIGTERM" && this.ignoreSigterm) return true;
    queueMicrotask(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = (typeof signal === "string" ? signal : "SIGTERM") as NodeJS.Signals;
      this.emit("exit", null, this.signalCode);
      this.emit("close", null, this.signalCode);
    });
    return true;
  }
}

describe("DIY Cloudflare route schema & backward compatibility (#103)", () => {
  it("allows LAN + Tailscale + VPS + Cloudflare coexistence, orders direct before VPS before Cloudflare, and preserves v1.6.0 manifest compat", () => {
    const routes = localRoutesSchema.parse([
      { name: "Cloudflare", url: "https://hub.example.com/" },
      { name: "VPS", url: "https://relay.example.com/" },
      { name: "Tailscale", url: "https://192.0.2.10:8788/" },
      { name: "Direct", url: "https://192.168.1.20:8788/" },
    ]);
    expect(routes.map((r) => r.name)).toEqual(["Cloudflare", "VPS", "Tailscale", "Direct"]);
    expect(orderedRoutes(routes).map((r) => r.name)).toEqual(["Tailscale", "Direct", "VPS", "Cloudflare"]);
    expect(legacyV1Routes(routes).map((r) => r.name)).toEqual(["VPS", "Tailscale", "Direct"]);

    expect(isDirectRoute(routes[2]!)).toBe(true);
    expect(isRelayRoute(routes[0]!)).toBe(true);
    expect(isEdgeTlsRoute(routes[0]!)).toBe(true);
    expect(isEdgeTlsRoute(routes[1]!)).toBe(false);
    expect(deploymentMatchesRoutes("vps-relay", [{ name: "Cloudflare", url: "https://hub.example.com" }])).toBe(true);
    expect(deploymentMatchesRoutes("vps-direct", [{ name: "Cloudflare", url: "https://hub.example.com" }])).toBe(false);

    const v1SingleDirect = routesSchema.parse([
      { name: "Tailscale", url: "https://192.0.2.10:8788" },
      { name: "VPS", url: "https://relay.example.com" },
      { name: "Cloudflare", url: "https://hub.example.com" },
    ]);
    expect(v1SingleDirect).toHaveLength(3);

    // v1.6.0 sharedRoutesSchema stays strictly Direct/Tailscale/VPS so v1.6.0 peers never reject manifests.
    expect(sharedRoutesSchema.safeParse(v1SingleDirect).success).toBe(false);
    expect(sharedRoutesSchema.parse(legacyV1Routes(v1SingleDirect))).toHaveLength(2);

    // Additive edgeRoutes on networkHostDescriptorSchema carries Cloudflare routes on v2+ hosts and is forbidden on v1 manifests.
    const hostKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const hostDesc = networkHostDescriptorSchema.parse({
      publicKey: hostKey,
      name: "Host",
      routes: [{ name: "VPS", url: "https://relay.example.com" }],
      edgeRoutes: [{ name: "Cloudflare", url: "https://hub.example.com" }],
    });
    expect(networkHostRoutes(hostDesc).map((r) => r.name)).toEqual(["VPS", "Cloudflare"]);
    const genesis = randomBytes(32).toString("base64url");
    const netId = `net_${createHash("sha256").update(networkGenesisText(hostKey, genesis)).digest("hex")}`;
    expect(networkManifestSchema.safeParse({
      v: 1,
      id: netId,
      name: "Net",
      authorityKey: hostKey,
      genesisNonce: genesis,
      revision: 1,
      hosts: [{ ...hostDesc, state: "active", revoked: false }],
      devices: [],
      revokedMembers: [],
      blockedBindings: [],
    }).success).toBe(false);

    // Relay activeUrl ordering in pairing payloads differentiates VPS vs Cloudflare selection.
    const cfFirst = connectionPairingPayload(
      hostKey,
      [
        { name: "VPS", url: "https://relay.example.com" },
        { name: "Cloudflare", url: "https://hub.example.com" },
      ],
      undefined,
      "https://hub.example.com",
    );
    expect(cfFirst.routes.map((r) => r.name)).toEqual(["Cloudflare", "VPS"]);
  });

  it("rejects custom CA, HTTP, and all loopback/unspecified/localhost forms on Cloudflare and edge origins", () => {
    for (const bad of [
      "http://127.0.0.1:8788",
      "https://127.0.0.1:8788",
      "https://127.0.0.2:8788",
      "https://0.0.0.0:8788",
      "https://[::]:8788",
      "https://[::1]:8788",
      "https://[::ffff:127.0.0.1]:8788",
      "https://[::ffff:0.0.0.0]:8788",
      "https://localhost:8788",
      "https://foo.localhost:8788",
    ]) {
      expect(edgeOriginSchema.safeParse(bad).success, `edgeOriginSchema should reject ${bad}`).toBe(false);
      expect(routeSchema.safeParse({ name: "Cloudflare", url: bad }).success, `routeSchema should reject ${bad}`).toBe(false);
    }
    expect(routeSchema.safeParse({
      name: "Cloudflare",
      url: "https://hub.example.com",
      certificateAuthority: "A".repeat(120),
    }).success).toBe(false);
  });

  it("maps Cloudflare routes to edgeTls without custom CA in routeTrust while preserving CA pinning on Direct/VPS", () => {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 1)]).toString("base64");
    const ca = "B".repeat(128);
    rememberRouteTrust([
      { name: "Direct", url: "https://192.168.1.20:8788", certificateAuthority: ca },
      { name: "Cloudflare", url: "https://hub.example.com" },
    ], spki);
    expect(routeTrust("https://192.168.1.20:8788", spki)).toEqual({ certificateAuthority: ca });
    expect(routeTrust("https://hub.example.com", spki)).toEqual({ edgeTls: true });
  });

  it("generates loopback-only cloudflared commands for both http2 and quic in quick and named modes", () => {
    const cmds = cloudflareCommands("http://127.0.0.1:8788");
    expect(cmds.quickHttp2).toBe("cloudflared tunnel --protocol http2 --url http://127.0.0.1:8788");
    expect(cmds.quickQuic).toBe("cloudflared tunnel --url http://127.0.0.1:8788");
    expect(cmds.namedHttp2).toContain("--protocol http2");
    expect(cmds.namedHttp2).toContain("http://127.0.0.1:8788");
    expect(cmds.namedQuic).not.toContain("--protocol http2");
    expect(cmds.namedQuic).toContain("http://127.0.0.1:8788");
  });
});

describe("Edge-terminated Hub Ed25519 identity proof, dedicated edge-proxy listener & DoS isolation (#103 / #98)", () => {
  it("serves /api/edge-identity only on the dedicated non-privileged edge-proxy listener for authorized origins", async () => {
    const hub = await startHub();
    const otherHub = await startHub();
    const nonce = randomBytes(32).toString("base64url");
    const targetOrigin = "https://my-hub.example.com";

    // Dedicated edge-proxy listener is separate from hub.url / hub.instanceUrl and excluded from hub.urls.
    expect(hub.edgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(hub.edgeUrl).not.toBe(hub.url);
    expect(hub.edgeUrl).not.toBe(hub.instanceUrl);
    expect(hub.urls).not.toContain(hub.edgeUrl);

    // Unauthorized origin is rejected on edgeUrl.
    const denied = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${nonce}&origin=${encodeURIComponent(targetOrigin)}`);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "edge_origin_not_allowed" });

    // Authorize origin in Hub Cloudflare config.
    await hub.cloudflare.update({ mode: "named", protocol: "http2", origins: [targetOrigin] });

    // Main loopback listener MUST refuse /api/edge-identity (fail-closed listener boundary).
    const onMain = await fetch(`${hub.url}/api/edge-identity?nonce=${nonce}&origin=${encodeURIComponent(targetOrigin)}`);
    expect(onMain.status).toBe(403);
    expect(await onMain.json()).toEqual({ error: "edge_identity_loopback_only" });

    // Dedicated edge-proxy listener issues valid origin-bound proof.
    const ok = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${nonce}&origin=${encodeURIComponent(targetOrigin)}`);
    expect(ok.status).toBe(200);
    const proof = await ok.json();

    // Valid verification succeeds.
    const verified = verifyEdgeIdentity(proof, { publicKey: hub.auth.publicKey, nonce, origin: targetOrigin }, verifySignature);
    expect(verified.origin).toBe(targetOrigin);

    // Negative tests: wrong hub key, wrong origin (proxy forwarding), wrong nonce, tampered signature.
    expect(() => verifyEdgeIdentity(proof, { publicKey: otherHub.auth.publicKey, nonce, origin: targetOrigin }, verifySignature)).toThrow("tls_identity_mismatch");
    expect(() => verifyEdgeIdentity(proof, { publicKey: hub.auth.publicKey, nonce, origin: "https://evil-proxy.example.com" }, verifySignature)).toThrow("tls_identity_mismatch");
    expect(() => verifyEdgeIdentity(proof, { publicKey: hub.auth.publicKey, nonce: randomBytes(32).toString("base64url"), origin: targetOrigin }, verifySignature)).toThrow("tls_identity_mismatch");
    expect(() => verifyEdgeIdentity({ ...proof, signature: "A".repeat(86) + "==" }, { publicKey: hub.auth.publicKey, nonce, origin: targetOrigin }, verifySignature)).toThrow("tls_identity_mismatch");
  });

  it("starts the Host without the edge-proxy listener when its port is busy, and reports the tunnel route unavailable", async () => {
    const blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", () => resolve()));
    try {
      const busyPort = (blocker.address() as net.AddressInfo).port;
      const dir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cf-busy-"));
      dirs.push(dir);
      const warnings: string[] = [];
      const hub = await HubServer.start({ stateDir: dir, edgePort: busyPort, onWarning: code => warnings.push(code) });
      hubs.push(hub);
      // The Host serves normally; only the edge listener is missing.
      expect(hub.http.listening).toBe(true);
      expect(hub.edgeHttp.listening).toBe(false);
      expect(hub.edgeListenerError).toContain(`127.0.0.1:${busyPort}`);
      expect(warnings.some(code => code.startsWith("edge_listener_unavailable"))).toBe(true);
      const view = await hub.cloudflare.view();
      expect(view.lastError).toContain("edge_listener_unavailable");
      expect(view.loopbackTarget).toBe(`http://127.0.0.1:${busyPort}`);
      await expect(hub.cloudflare.startQuickTunnel("http2")).rejects.toThrow("edge_listener_unavailable");
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });

  it("keeps a busy saved edge-proxy port instead of silently picking another", async () => {
    const blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", () => resolve()));
    try {
      const busyPort = (blocker.address() as net.AddressInfo).port;
      const dir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cf-saved-"));
      dirs.push(dir);
      await writeFile(path.join(dir, "edge-proxy-port.json"), JSON.stringify(busyPort));
      expect(await resolveEdgePort(dir, { instancePort: 1, tlsListeners: [] }, 2)).toBe(busyPort);
      expect(JSON.parse(await readFile(path.join(dir, "edge-proxy-port.json"), "utf8"))).toBe(busyPort);
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });

  it("serves new edge-identity callers untracked when the edge table is full, but the anonymous table still rejects", async () => {
    const hub = await startHub();
    const origin = "https://full-table.example.com";
    await hub.cloudflare.update({ mode: "named", protocol: "http2", origins: [origin] });
    const nonce = () => randomBytes(32).toString("base64url");
    // A source tracked before the table fills keeps its own per-source limit.
    const tracked = "edge-proxy:198.51.100.7";
    for (let i = 0; i < 60; i++) hub.auth.edgeIdentity(nonce(), origin, tracked);
    for (let i = 0; i < 4095; i++) hub.auth.edgeIdentity(nonce(), origin, `edge-proxy:2001:db8:${i.toString(16)}::1`);
    // Table is now full (4,096 keys): a new source still gets a valid proof.
    const proof = hub.auth.edgeIdentity(nonce(), origin, "edge-proxy:192.0.2.77");
    expect(proof.origin).toBe(origin);
    expect(hub.auth.edgeIdentity(nonce(), origin, "edge-proxy:192.0.2.78").signature).toBeTruthy();
    // The already-tracked source over its limit is still refused.
    expect(() => hub.auth.edgeIdentity(nonce(), origin, tracked)).toThrow("rate_limited");
    // The same fill on the anonymous table still rejects new keys.
    for (let i = 0; i < 4096; i++) hub.auth.tlsIdentity(nonce(), Buffer.from("leaf"), `2001:db8:${i.toString(16)}::1`);
    expect(() => hub.auth.tlsIdentity(nonce(), Buffer.from("leaf"), "192.0.2.79")).toThrow("rate_limited");
  });

  it("isolates /api/edge-identity rate limits per client IP and reserves known/authenticated device capacity against external DoS", async () => {
    const hub = await startHub();
    const targetOrigin = "https://rate-test.example.com";
    await hub.cloudflare.update({ mode: "named", protocol: "http2", origins: [targetOrigin] });

    const known = testDevice("cf_known_client");
    await enrollTrusted(hub.auth, known);
    const session = await loginFor(hub.auth, known);
    const revoked = testDevice("cf_revoked_client");
    await enrollTrusted(hub.auth, revoked);
    await hub.auth.revoke(revoked.deviceId, "local-owner");

    // 1. External attacker at 198.51.100.9 exhausts its own 60/5min bucket; spoofing X-Forwarded-For does not bypass it.
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${randomBytes(32).toString("base64url")}&origin=${encodeURIComponent(targetOrigin)}`, {
        headers: {
          "CF-Connecting-IP": "198.51.100.9",
          "X-Forwarded-For": `203.0.113.${(i % 200) + 1}`,
        },
      });
      expect(res.status).toBe(200);
    }
    const attackerBlocked = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${randomBytes(32).toString("base64url")}&origin=${encodeURIComponent(targetOrigin)}`, {
      headers: { "CF-Connecting-IP": "198.51.100.9", "X-Forwarded-For": "192.0.2.99" },
    });
    expect(attackerBlocked.status).toBe(429);

    // 2. Legitimate native client on a different IP (203.0.113.42) is completely unaffected.
    const otherClient = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${randomBytes(32).toString("base64url")}&origin=${encodeURIComponent(targetOrigin)}`, {
      headers: { "CF-Connecting-IP": "203.0.113.42" },
    });
    expect(otherClient.status).toBe(200);

    // 3. Even on the EXACT same NAT IP as the attacker (or shared no-header bucket), a known/authenticated device still succeeds via reserved capacity.
    const authOnSameIp = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${randomBytes(32).toString("base64url")}&origin=${encodeURIComponent(targetOrigin)}`, {
      headers: { "CF-Connecting-IP": "198.51.100.9", Authorization: `Bearer ${session.token}` },
    });
    expect(authOnSameIp.status).toBe(200);

    const knownIdOnSameIp = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${randomBytes(32).toString("base64url")}&origin=${encodeURIComponent(targetOrigin)}&deviceId=${encodeURIComponent(known.deviceId)}`, {
      headers: { "CF-Connecting-IP": "198.51.100.9" },
    });
    expect(knownIdOnSameIp.status).toBe(200);

    // 4. Unknown or revoked deviceId cannot escape the exhausted anonymous bucket.
    const revokedOnSameIp = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${randomBytes(32).toString("base64url")}&origin=${encodeURIComponent(targetOrigin)}&deviceId=${encodeURIComponent(revoked.deviceId)}`, {
      headers: { "CF-Connecting-IP": "198.51.100.9" },
    });
    expect(revokedOnSameIp.status).toBe(429);
    const unknownOnSameIp = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${randomBytes(32).toString("base64url")}&origin=${encodeURIComponent(targetOrigin)}&deviceId=device_does_not_exist`, {
      headers: { "CF-Connecting-IP": "198.51.100.9" },
    });
    expect(unknownOnSameIp.status).toBe(429);

    // 5. Filling the entire 4,096-entry anonymous edge table does NOT starve new anonymous callers (served untracked),
    // known devices, direct anonymous TLS proofs, or loopback trusted operations.
    for (let i = 0; i < 4200; i++) {
      hub.auth.edgeIdentity(randomBytes(32).toString("base64url"), targetOrigin, `edge-proxy:2001:db8:${i.toString(16)}::1`);
    }
    const newAnon = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${randomBytes(32).toString("base64url")}&origin=${encodeURIComponent(targetOrigin)}`, {
      headers: { "CF-Connecting-IP": "192.0.2.250" },
    });
    expect(newAnon.status).toBe(200);
    const knownDuringFlood = await fetch(`${hub.edgeUrl}/api/edge-identity?nonce=${randomBytes(32).toString("base64url")}&origin=${encodeURIComponent(targetOrigin)}&deviceId=${encodeURIComponent(known.deviceId)}`, {
      headers: { "CF-Connecting-IP": "192.0.2.250" },
    });
    expect(knownDuringFlood.status).toBe(200);
    expect(hub.auth.tlsIdentity(randomBytes(32).toString("base64url"), Buffer.from("direct-leaf"), "198.51.100.88")).toBeDefined();
    expect(hub.auth.tlsIdentity(randomBytes(32).toString("base64url"), Buffer.from("local-leaf"), "127.0.0.1")).toBeDefined();

    // 6. CF-Connecting-IP: 127.0.0.1 on edgeUrl stays in edge-proxy namespace (audit source is edge-proxy:127.0.0.1, never 127.0.0.1).
    const unauthEdge = await fetch(`${hub.edgeUrl}/api/devices`, { headers: { Authorization: "Bearer bad-edge-token", "CF-Connecting-IP": "127.0.0.1" } });
    expect(unauthEdge.status).toBe(401);
    const unauthEdgeShared = await fetch(`${hub.edgeUrl}/api/devices`, { headers: { Authorization: "Bearer bad-edge-token-2" } });
    expect(unauthEdgeShared.status).toBe(401);
    await hub.store.flushAudit();
    const auditRows = await hub.store.db.all<{ detail_json: string }>("SELECT detail_json FROM audit_log WHERE kind='http.rejected' ORDER BY id");
    const sources = auditRows.map((row) => JSON.parse(row.detail_json).source);
    expect(sources).toContain("edge-proxy:127.0.0.1");
    expect(sources).toContain("edge-proxy:shared");
    expect(sources).not.toContain("127.0.0.1");
  }, 20_000);

  it("fences all six loopback-only privileged endpoints off the dedicated edge-proxy listener by listener boundary, never by headers", async () => {
    const hub = await startHub();
    const mainWs = hub.url.replace(/^http/, "ws");
    const edgeWs = hub.edgeUrl.replace(/^http/, "ws");

    // Direct loopback on the main/instance listener opens local privileged WS channels.
    expect(await tryOpenWs(`${mainWs}/screen/v1/target`)).toBe(true);
    expect(await tryOpenWs(`${mainWs}/screen/v1/target-media`)).toBe(true);
    expect(await tryOpenWs(`${mainWs}/instance`)).toBe(true);

    // On the dedicated edge-proxy listener, ALL 6 privileged endpoints are refused EVEN WITH clean loopback Host and ZERO proxy headers.
    expect(await tryOpenWs(`${edgeWs}/screen/v1/target`)).toBe(false);
    expect(await tryOpenWs(`${edgeWs}/screen/v1/target-media`)).toBe(false);
    expect(await tryOpenWs(`${edgeWs}/instance`)).toBe(false);

    const inst = await fetch(`${hub.edgeUrl}/api/instance/nonexistent`);
    expect(inst.status).toBe(401);
    expect(await inst.json()).toEqual({ error: "instance_unauthorized" });

    const grant = await fetch(`${hub.edgeUrl}/api/bot-messages/grant`, { method: "POST", body: "{}" });
    expect(grant.status).toBe(403);
    expect(await grant.json()).toEqual({ error: "local_controller_required" });

    const local = await fetch(`${hub.edgeUrl}/api/bot-messages/local`, { method: "POST", body: "{}" });
    expect(local.status).toBe(403);
    expect(await local.json()).toEqual({ error: "local_controller_required" });
  });

  it("requires enrolled local owner controller and fresh one-use signed device action for Cloudflare settings and Quick Tunnel", async () => {
    const hub = await startHub();
    const view = await hub.cloudflare.view();
    expect(view.mode).toBe("named");
    expect(view.protocol).toBe("http2");
    expect(view.commands.quickHttp2).toContain("--protocol http2");
    expect(view.commands.namedQuic).toContain(hub.edgeUrl);
    expect(view.loopbackTarget).toBe(hub.edgeUrl);

    // Unauthenticated HTTP requests fail with 401.
    expect((await fetch(`${hub.url}${HOST_CLOUDFLARE_PATH}`)).status).toBe(401);
    expect((await fetch(`${hub.url}${HOST_CLOUDFLARE_PATH}`, { method: "PUT", body: "{}" })).status).toBe(401);
    expect((await fetch(`${hub.url}${HOST_CLOUDFLARE_QUICK_PATH}`, { method: "POST", body: "{}" })).status).toBe(401);

    // Enroll a local desktop controller AND a remote paired owner device.
    const localOwner = testDevice("cf_local_ctrl");
    await hub.enrollLocalController(deviceFields(localOwner));
    const localSession = await loginFor(hub.auth, localOwner);

    const remoteOwner = testDevice("cf_remote_owner");
    await enrollTrusted(hub.auth, remoteOwner);
    const remoteSession = await loginFor(hub.auth, remoteOwner);

    const updateCommand = { mode: "named" as const, protocol: "http2" as const, origins: ["https://signed.example.com"] };
    const updateTarget = hashSecret(cloudflareUpdateProofText(updateCommand));
    const quickCommand = { action: "stop" as const };
    const quickTarget = hashSecret(cloudflareQuickActionProofText(quickCommand));

    // 1. Remote paired owner device CANNOT mutate Cloudflare origins or Quick Tunnel even with a valid device signature.
    const remoteUpdateProof = (await signedDeviceAction(hub.url, remoteSession.token, remoteOwner.privateKey, { operation: "cloudflare-tunnel", target: updateTarget })).proof;
    const remoteUpdateRes = await fetch(`${hub.url}${HOST_CLOUDFLARE_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${remoteSession.token}` },
      body: JSON.stringify({ command: updateCommand, proof: remoteUpdateProof }),
    });
    expect(remoteUpdateRes.status).toBe(403);
    expect(await remoteUpdateRes.json()).toEqual({ error: "local_controller_required" });
    expect(hub.cloudflare.isOriginAllowed("https://signed.example.com")).toBe(false);

    const remoteQuickProof = (await signedDeviceAction(hub.url, remoteSession.token, remoteOwner.privateKey, { operation: "cloudflare-tunnel", target: quickTarget })).proof;
    const remoteQuickRes = await fetch(`${hub.url}${HOST_CLOUDFLARE_QUICK_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${remoteSession.token}` },
      body: JSON.stringify({ command: quickCommand, proof: remoteQuickProof }),
    });
    expect(remoteQuickRes.status).toBe(403);
    expect(await remoteQuickRes.json()).toEqual({ error: "local_controller_required" });

    // 2. Local controller WITHOUT proof is rejected (stolen bearer token alone cannot mutate).
    const unsignedUpdate = await fetch(`${hub.url}${HOST_CLOUDFLARE_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${localSession.token}` },
      body: JSON.stringify({ command: updateCommand }),
    });
    expect(unsignedUpdate.status).toBe(403);
    expect(await unsignedUpdate.json()).toEqual({ error: "device_action_proof_required" });

    const unsignedQuick = await fetch(`${hub.url}${HOST_CLOUDFLARE_QUICK_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${localSession.token}` },
      body: JSON.stringify({ command: quickCommand }),
    });
    expect(unsignedQuick.status).toBe(403);
    expect(await unsignedQuick.json()).toEqual({ error: "device_action_proof_required" });

    // 3. Local controller arriving via edgeUrl (tunnel) is rejected even with valid proof.
    const edgeProof = (await signedDeviceAction(hub.url, localSession.token, localOwner.privateKey, { operation: "cloudflare-tunnel", target: updateTarget })).proof;
    const viaEdge = await fetch(`${hub.edgeUrl}${HOST_CLOUDFLARE_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${localSession.token}` },
      body: JSON.stringify({ command: updateCommand, proof: edgeProof }),
    });
    expect(viaEdge.status).toBe(403);
    expect(await viaEdge.json()).toEqual({ error: "local_controller_required" });

    // 4. Substituted command fails and consumes the one-use proof.
    const substitutedRes = await fetch(`${hub.url}${HOST_CLOUDFLARE_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${localSession.token}` },
      body: JSON.stringify({ command: { ...updateCommand, origins: ["https://evil.example.com"] }, proof: edgeProof }),
    });
    expect(substitutedRes.status).toBe(403);
    expect(await substitutedRes.json()).toEqual({ error: "device_action_invalid" });
    expect(hub.cloudflare.isOriginAllowed("https://evil.example.com")).toBe(false);

    // 5. Wrong device-action operation ("network") cannot authorize cloudflare-tunnel.
    const wrongOpProof = (await signedDeviceAction(hub.url, localSession.token, localOwner.privateKey, { operation: "network", target: updateTarget })).proof;
    const wrongOpRes = await fetch(`${hub.url}${HOST_CLOUDFLARE_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${localSession.token}` },
      body: JSON.stringify({ command: updateCommand, proof: wrongOpProof }),
    });
    expect(wrongOpRes.status).toBe(403);
    expect(await wrongOpRes.json()).toEqual({ error: "device_action_invalid" });

    // 6. Fresh signed proof from local owner controller succeeds once, records audit, and rejects replay.
    const validProof = (await signedDeviceAction(hub.url, localSession.token, localOwner.privateKey, { operation: "cloudflare-tunnel", target: updateTarget })).proof;
    const okUpdate = await fetch(`${hub.url}${HOST_CLOUDFLARE_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${localSession.token}` },
      body: JSON.stringify({ command: updateCommand, proof: validProof }),
    });
    expect(okUpdate.status).toBe(200);
    expect((await okUpdate.json()).origins).toEqual(["https://signed.example.com"]);
    expect(hub.cloudflare.isOriginAllowed("https://signed.example.com")).toBe(true);

    const replayUpdate = await fetch(`${hub.url}${HOST_CLOUDFLARE_PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${localSession.token}` },
      body: JSON.stringify({ command: updateCommand, proof: validProof }),
    });
    expect(replayUpdate.status).toBe(403);
    expect(await replayUpdate.json()).toEqual({ error: "device_action_expired" });

    const validQuickProof = (await signedDeviceAction(hub.url, localSession.token, localOwner.privateKey, { operation: "cloudflare-tunnel", target: quickTarget })).proof;
    const okQuick = await fetch(`${hub.url}${HOST_CLOUDFLARE_QUICK_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${localSession.token}` },
      body: JSON.stringify({ command: quickCommand, proof: validQuickProof }),
    });
    expect(okQuick.status).toBe(200);
    expect((await okQuick.json()).running).toBe(false);

    const audits = await hub.store.db.all<{ kind: string; actor: string }>("SELECT kind, actor FROM audit_log WHERE kind LIKE 'cloudflare.%' ORDER BY id");
    expect(audits).toEqual([
      { kind: "cloudflare.updated", actor: localOwner.deviceId },
      { kind: "cloudflare.quick_stopped", actor: localOwner.deviceId },
    ]);
  });

  it("manages Cloudflare settings and Cloudflare pairing links end-to-end via Host CLI", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cf-cli-"));
    dirs.push(dir);
    const printed: unknown[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value) => { printed.push(value); });
    await runHostCli(["init", "--name", "macmini", "--state-dir", dir, "--json"]);
    const hub = await HubServer.start({ stateDir: dir });
    hubs.push(hub);
    const closeControl = await startHubControl(
      dir,
      { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey },
      () => {},
      { enrollController: (controller) => hub.enrollLocalController(controller) },
    );
    try {
      await runHostCli(["enroll", "--state-dir", dir, "--json"]);

      // 1. status reads dedicated edgeUrl loopbackTarget
      await runHostCli(["cloudflare", "status", "--state-dir", dir, "--json"]);
      expect(JSON.parse(String(printed.at(-1)))).toMatchObject({
        mode: "named",
        protocol: "http2",
        origins: [],
        loopbackTarget: hub.edgeUrl,
      });

      // 2. Mutations require explicit --yes
      await expect(runHostCli(["cloudflare", "allow", "https://cli-hub.example.com", "--state-dir", dir, "--json"])).rejects.toThrow("--yes");
      await expect(runHostCli(["cloudflare", "quick", "start", "--state-dir", dir, "--json"])).rejects.toThrow("--yes");

      // 3. allow / set / revoke sign real cloudflare-tunnel device actions and persist changes
      await runHostCli(["cloudflare", "allow", "https://cli-hub.example.com", "--yes", "--state-dir", dir, "--json"]);
      expect(JSON.parse(String(printed.at(-1))).origins).toEqual(["https://cli-hub.example.com"]);
      expect(hub.cloudflare.isOriginAllowed("https://cli-hub.example.com")).toBe(true);

      await runHostCli([
        "cloudflare", "set", "--mode", "named", "--protocol", "quic",
        "--origins", "https://a.example.com,https://b.example.com", "--yes", "--state-dir", dir, "--json",
      ]);
      expect(JSON.parse(String(printed.at(-1)))).toMatchObject({
        mode: "named",
        protocol: "quic",
        origins: ["https://a.example.com", "https://b.example.com"],
      });

      await runHostCli(["cloudflare", "revoke", "https://a.example.com", "--yes", "--state-dir", dir, "--json"]);
      expect(JSON.parse(String(printed.at(-1))).origins).toEqual(["https://b.example.com"]);

      // 4. pair --cloudflare emits a valid invite link containing the authorized Cloudflare route
      await runHostCli(["pair", "--cloudflare", "--state-dir", dir, "--json"]);
      const pairOut = JSON.parse(String(printed.at(-1))) as { link: string; routes: Array<{ name: string; url: string }> };
      expect(pairOut.routes).toEqual([{ name: "Cloudflare", url: "https://b.example.com" }]);
      expect(pairOut.link).toMatch(/^tarocub:\/\/pair\?data=/);

      // 5. quick stop and --clear-origins work cleanly
      await runHostCli(["cloudflare", "quick", "stop", "--yes", "--state-dir", dir, "--json"]);
      expect(JSON.parse(String(printed.at(-1))).running).toBe(false);

      await runHostCli(["cloudflare", "set", "--clear-origins", "--yes", "--state-dir", dir, "--json"]);
      expect(JSON.parse(String(printed.at(-1))).origins).toEqual([]);
      expect(hub.cloudflare.isOriginAllowed("https://b.example.com")).toBe(false);
    } finally {
      logSpy.mockRestore();
      await closeControl();
    }
  }, 20_000);
});

describe("Host-to-Host PrivateNetwork & Bot messaging over Cloudflare edgeRoutes (#103)", () => {
  it("verifies peerPin via /api/edge-identity and completes exchangeNetworkPeer + exchangeBotMessage over WebPKI HTTPS without leaf pins", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cf-peer-"));
    dirs.push(dir);
    const address = Object.values(os.networkInterfaces()).flat().find(item => item?.family === "IPv4" && !item.internal)!.address;

    const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=Cloudflare Edge Fixture CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
    await writeFile(path.join(dir, "edge.ext"), `subjectAltName=IP:${address}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "edge.key", "-out", "edge.csr", "-subj", "/CN=edge.test"]);
    openssl(["x509", "-req", "-in", "edge.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "edge.crt", "-days", "1", "-extfile", "edge.ext"]);
    const caPem = await readFile(path.join(dir, "ca.crt"), "utf8");
    const edgeTls = { key: await readFile(path.join(dir, "edge.key")), cert: await readFile(path.join(dir, "edge.crt")) };
    // Simulate Cloudflare's WebPKI cert being trusted by the OS root store (no custom route.certificateAuthority).
    tls.setDefaultCACertificates([...defaultCaCertificates, caPem]);

    const peerHub = await startHub();
    const callerHub = await startHub();
    let edgeUrl = "";
    let spoofOrigin: string | undefined;
    let peerPosts = 0;
    let botPosts = 0;

    const server = createHttpsServer(edgeTls, (req, res) => {
      const parsed = new URL(req.url!, edgeUrl);
      if (req.method === "GET" && parsed.pathname === "/api/edge-identity") {
        const nonce = parsed.searchParams.get("nonce")!;
        const origin = spoofOrigin ?? parsed.searchParams.get("origin")!;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(peerHub.auth.edgeIdentity(nonce, origin, "127.0.0.1")));
        return;
      }
      if (req.method === "POST" && parsed.pathname === "/api/network/peer") {
        peerPosts++;
        req.resume();
        req.on("end", () => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(signedManifest));
        });
        return;
      }
      if (req.method === "POST" && parsed.pathname === "/api/bot-messages/conversations") {
        botPosts++;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const header = JSON.parse(Buffer.from(String(req.headers["x-tarobot-message-passport"]), "base64url").toString("utf8")) as { passport: BotPassport };
          const result = { conversationId: "conv_cf_1" };
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ result, signature: peerHub.auth.signBotReply(header.passport.nonce, result) }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    httpsServers.push(server);
    await new Promise<void>(resolve => server.listen(0, address, resolve));
    edgeUrl = `https://${address}:${(server.address() as { port: number }).port}`;

    const genesisNonce = randomBytes(32).toString("base64url");
    const netId = `net_${createHash("sha256").update(networkGenesisText(peerHub.auth.publicKey, genesisNonce)).digest("hex")}`;
    const cfHost: NetworkHost = {
      publicKey: peerHub.auth.publicKey,
      name: "EdgePeer",
      routes: [],
      edgeRoutes: [{ name: "Cloudflare", url: edgeUrl }],
      protocol: 2,
      state: "active",
      revoked: false,
    };
    const manifest: NetworkManifest = {
      v: 2,
      id: netId,
      name: "Edge Network",
      authorityKey: peerHub.auth.publicKey,
      genesisNonce,
      revision: 1,
      hosts: [cfHost],
      devices: [],
      revokedMembers: [],
      blockedBindings: [],
    };
    const signedManifest: SignedNetworkManifest = {
      manifest,
      signature: peerHub.auth.signNetworkManifest(manifest),
    };
    const peerReqValue = {
      v: 1 as const,
      networkId: netId,
      publicKey: callerHub.auth.publicKey,
      nonce: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 30_000,
      host: { publicKey: callerHub.auth.publicKey, name: "Caller", routes: [] },
      devices: [],
      revoked: [],
    };
    const signedPeerReq: SignedNetworkPeerRequest = {
      request: peerReqValue,
      signature: callerHub.auth.signNetworkPeer(peerReqValue),
    };

    // 1. Direct peerPin check over Cloudflare route returns pin: undefined and caches.
    const route = { name: "Cloudflare" as const, url: edgeUrl };
    forgetPeerPin(peerHub.auth.publicKey, route);
    const first = await peerPin(peerHub.auth.publicKey, route, async (probePath) => {
      const q = new URL(probePath, edgeUrl);
      return peerHub.auth.edgeIdentity(q.searchParams.get("nonce")!, q.searchParams.get("origin")!, "127.0.0.1");
    });
    expect(first).toEqual({ pin: undefined, cached: false });
    const second = await peerPin(peerHub.auth.publicKey, route, async () => { throw new Error("should_use_cache"); });
    expect(second).toEqual({ pin: undefined, cached: true });
    forgetPeerPin(peerHub.auth.publicKey, route);

    // 2. Host-to-Host PrivateNetwork sync succeeds over edgeRoutes Cloudflare URL.
    expect(await exchangeNetworkPeer(cfHost, signedPeerReq)).toEqual(signedManifest);
    expect(peerPosts).toBe(1);

    // 3. Cross-host Bot messaging succeeds over edgeRoutes Cloudflare URL.
    const body = Buffer.from(JSON.stringify({ hello: "cf" }));
    const passport: BotPassport = {
      v: 1,
      sourceKey: callerHub.auth.publicKey,
      targetKey: peerHub.auth.publicKey,
      source: {
        hostId: messageHostId(callerHub.auth.publicKey),
        hostName: "Caller",
        botId: "sender",
        botName: "Sender",
        hops: 1,
        requestId: randomUUID(),
      },
      targetBot: "receiver",
      method: "POST",
      path: "/api/bot-messages/conversations",
      digest: createHash("sha256").update(body).digest("hex"),
      expiresAt: Date.now() + 60_000,
      nonce: randomUUID(),
    };
    expect(await exchangeBotMessage(cfHost, { passport, signature: callerHub.auth.signBotPassport(passport) }, body))
      .toEqual({ conversationId: "conv_cf_1" });
    expect(botPosts).toBe(1);

    // 4. Negative: spoofed origin in /api/edge-identity fails BEFORE sending POST payload.
    forgetPeerPin(peerHub.auth.publicKey, route);
    spoofOrigin = "https://wrong.example.com";
    await expect(exchangeNetworkPeer(cfHost, signedPeerReq)).rejects.toThrow("network_peer_response_invalid");
    await expect(exchangeBotMessage(cfHost, { passport, signature: callerHub.auth.signBotPassport(passport) }, body))
      .rejects.toThrow("unavailable_or_upgrade_required");
    expect(peerPosts).toBe(1);
    expect(botPosts).toBe(1);

    // 5. Negative: Cloudflare route with custom CA is rejected by peerPin.
    await expect(peerPin(peerHub.auth.publicKey, { name: "Cloudflare", url: edgeUrl, certificateAuthority: "A".repeat(120) }, async () => ({})))
      .rejects.toThrow("network_peer_certificate_invalid");
  }, 20_000);
});

describe("HubCloudflareTunnel process lifecycle hardening (#103)", () => {
  it("serializes concurrent starts, parses split chunks, aborts cleanly on stop, and escalates SIGKILL on close", async () => {
    const hub = await startHub();
    const spawned: FakeChild[] = [];
    let ignoreSigterm = false;
    const tunnel = new HubCloudflareTunnel({
      store: hub.store,
      loopbackTarget: () => hub.url,
      detect: async () => ({ installed: true, path: "/usr/bin/cloudflared", version: "2026.1.0" }),
      spawnProcess: (() => {
        const child = new FakeChild(ignoreSigterm);
        spawned.push(child);
        return child as unknown as ChildProcess;
      }) as unknown as typeof spawn,
      startTimeoutMs: 2000,
      stopTimeoutMs: 60,
    });

    // 1. Concurrent startQuickTunnel calls spawn only ONE process and parse a URL split across chunks.
    const p1 = tunnel.startQuickTunnel("http2");
    const p2 = tunnel.startQuickTunnel("http2");
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    spawned[0]!.stderr.write("INF |  https://split-");
    spawned[0]!.stderr.write("chunk-test.trycloudflare.com  |\n");
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(spawned).toHaveLength(1);
    expect(v1.activeUrl).toBe("https://split-chunk-test.trycloudflare.com");
    expect(v2.activeUrl).toBe("https://split-chunk-test.trycloudflare.com");
    expect(tunnel.isOriginAllowed("https://split-chunk-test.trycloudflare.com")).toBe(true);

    // 2. stopQuickTunnel during a slow start aborts startup, kills the child, and never authorizes a phantom URL.
    await tunnel.stopQuickTunnel();
    expect(tunnel.isOriginAllowed("https://split-chunk-test.trycloudflare.com")).toBe(false);
    const slowStart = tunnel.startQuickTunnel("quic");
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    const stopped = tunnel.stopQuickTunnel();
    await expect(slowStart).rejects.toThrow("cloudflared_stopped");
    const afterStop = await stopped;
    expect(afterStop.running).toBe(false);
    expect(afterStop.activeUrl).toBeUndefined();
    spawned[1]!.stderr.write("https://phantom-after-stop.trycloudflare.com\n");
    expect(tunnel.isOriginAllowed("https://phantom-after-stop.trycloudflare.com")).toBe(false);

    // 3. close() awaits child exit and escalates SIGTERM -> SIGKILL if the child ignores SIGTERM.
    ignoreSigterm = true;
    const p3 = tunnel.startQuickTunnel("http2");
    await vi.waitFor(() => expect(spawned).toHaveLength(3));
    spawned[2]!.stdout.write("https://sigkill-test.trycloudflare.com\n");
    await p3;
    await tunnel.close();
    expect(spawned[2]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(spawned[2]!.signalCode).toBe("SIGKILL");
    await expect(tunnel.startQuickTunnel("http2")).rejects.toThrow("hub_stopping");
  });
});
