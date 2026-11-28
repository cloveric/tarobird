import { RelayTunnels } from "../src/relay/tunnels.js";
import { hubConfigSchema } from "../src/hub/config.js";
import { execFileSync } from "node:child_process";
import { X509Certificate, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { Agent, request, createServer as createHttpsServer } from "node:https";
import { createServer, connect as tcpConnect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { connect, createServer as createTlsServer } from "node:tls";
import { afterAll, beforeAll, expect, test } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { RelayServer } from "../src/relay/server.js";
import { RelayTunnel } from "../src/relay/tunnel.js";
import { CONTROL_ALPN, SOURCE_CONTROL_ALPN, DATA_ALPN, sendFrame } from "../src/relay/protocol.js";
import { RelaySources } from "../src/relay/sources.js";
import { WebSocket } from "ws";
import { installerHarness } from "./helpers/relay-installer-harness.js";
import { loadHubTls } from "../src/hub/tls.js";
import { enrollTrusted, issueInvite, pairingRequestId, testDevice } from "./helpers/pairing-invite.js";
import { deployRelay, inspectRemoteRelay, prepareRelayDeployment, resolveRelayRuntime, validateSshHost } from "../src/relay/deploy.js";
import { relayHosts, relayServerSchema } from "../src/relay/config.js";

let root: string; let ca: Buffer; let hubPair: { cert: Buffer; key: Buffer }; let relayPair: typeof hubPair; let clientPair: typeof hubPair; let otherClientPair: typeof hubPair;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "relay-test-"));
  const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=TaroCub ephemeral test CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  const pair = async (name: string, dns: string, usage: string) => {
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${dns}`]);
    await writeFile(path.join(root, `${name}.ext`), `subjectAltName=DNS:${dns}${name === "hub" ? ",IP:127.0.0.1" : ""}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n`);
    openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "1", "-extfile", `${name}.ext`]);
    return { cert: await readFile(path.join(root, `${name}.pem`)), key: await readFile(path.join(root, `${name}.key`)) };
  };
  ca = await readFile(path.join(root, "ca.pem")); hubPair = await pair("hub", "hub.test", "serverAuth"); relayPair = await pair("relay", "relay.test", "serverAuth"); clientPair = await pair("client", "mac.test", "clientAuth"); otherClientPair = await pair("other-client", "other-mac.test", "clientAuth");
}, 20_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
function get(port: number, route: string, servername = "hub.test", origin?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => { const req = request({ hostname: "127.0.0.1", port, servername, ca, path: route, headers: origin ? { Origin: origin } : {}, timeout: 3000 }, (res) => { let body = ""; res.on("data", (chunk) => { body += String(chunk); }); res.on("end", () => resolve({ status: res.statusCode!, body })); }); req.on("error", reject); req.on("timeout", () => req.destroy(new Error("test_request_timeout"))); req.end(); });
}
function port(url: string): number { return Number(new URL(url).port); }

test("authenticated relay sources isolate proof quotas, and pairing needs an invite from every source", async () => {
  const sources = new RelaySources();
  const hub = await HubServer.start({ stateDir: path.join(root, "source-isolation"), tls: hubPair, relaySources: sources });
  const relay = await RelayServer.start({ publicHost: "::", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0,
    serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ...relayPair, ca } });
  const fleet = await RelayTunnels.load(hubConfigSchema.parse({ host: "127.0.0.1", port: port(hub.url), tls: { cert: "fixture.pem", key: "fixture.key" },
    relays: [{ id: "primary", host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", targetPort: port(hub.url),
      tls: { ca: path.join(root, "ca.pem"), cert: path.join(root, "client.pem"), key: path.join(root, "client.key") } }] }), undefined, sources);
  function call(hostname: string, target: number, route: string, body?: unknown, spoof = "203.0.113.99") {
    return new Promise<number>((resolve, reject) => {
      const req = request({ hostname, port: target, servername: "hub.test", ca, agent: false, timeout: 3000, path: route, method: body ? "POST" : "GET",
        headers: { "X-Forwarded-For": spoof, "Forwarded": `for=${spoof}`, "X-Real-IP": spoof } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject); req.on("timeout", () => req.destroy(new Error("test_timeout"))); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const proof = () => `/api/tls-identity?nonce=${randomBytes(32).toString("base64url")}`;
  fleet.start();
  try {
    await expect.poll(() => fleet.status.allOnline).toBe(true);
    for (let i = 0; i < 60; i++) expect(await call("127.0.0.1", relay.status.publicPort, proof(), undefined, `203.0.113.${i + 1}`)).toBe(200);
    expect(await call("127.0.0.1", relay.status.publicPort, proof())).toBe(429);
    expect(await call("::1", relay.status.publicPort, proof())).toBe(200);
    expect(await call("127.0.0.1", port(hub.url), proof())).toBe(200);
    // Pairing limits are per owner-issued invite. Malformed or tokenless
    // requests allocate no per-source quota and are refused from every source,
    // relayed or local; an invite admits from any of them.
    const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const device = (deviceId: string) => ({ deviceId, name: deviceId, platform: "web", publicKey: key });
    for (let i = 0; i < 12; i++) expect(await call("127.0.0.1", relay.status.publicPort, "/api/pair", {})).toBe(400);
    for (let i = 0; i < 12; i++) expect(await call("127.0.0.1", relay.status.publicPort, "/api/pair", device(`tokenless_${i}`))).toBe(403);
    expect(await call("127.0.0.1", port(hub.url), "/api/pair", device("desktop"))).toBe(403);
    const owner = await enrollTrusted(hub.auth, testDevice("owner_desktop"));
    const relayed = await issueInvite(hub.auth, owner), local = await issueInvite(hub.auth, owner);
    expect(await call("127.0.0.1", relay.status.publicPort, "/api/pair", { ...device("other_ip"), invite: relayed.invite, requestId: pairingRequestId() })).toBe(201);
    expect(await call("127.0.0.1", port(hub.url), "/api/pair", { ...device("desktop"), invite: local.invite, requestId: pairingRequestId() })).toBe(201);
    // Upgrade requests retain the same source mapping, independent of headers.
    for (const hostname of ["127.0.0.1", "[::1]"]) {
      const tlsOptions = { ca, servername: "hub.test", headers: { "X-Forwarded-For": "spoof" } };
      const ws = new WebSocket(`wss://${hostname}:${relay.status.publicPort}/ws`, tlsOptions);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ws.terminate(); reject(new Error("test_ws_timeout")); }, 3000);
        ws.on("error", reject); ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "hello", deviceId: "missing", nonce: randomBytes(32).toString("base64url"), protocolVersions: [1], capabilities: [], cursors: {} })));
        ws.on("message", () => { clearTimeout(timer); ws.close(); resolve(); });
      });
    }
    const audit = JSON.stringify(await hub.store.db.all("SELECT detail_json FROM audit_log WHERE kind='auth.rejected'"));
    expect(audit).toContain("relay:primary:127.0.0.1"); expect(audit).toContain("relay:primary:::1"); expect(audit).not.toContain("spoof");
  } finally { fleet.stop(); await relay.close(); await hub.close(); }
}, 20_000);

test("an old TCP tunnel and a UDP-capable tunnel share one relay port", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "udp-mixed-hub"), tls: hubPair });
  const clientFingerprint256 = new X509Certificate(clientPair.cert).fingerprint256;
  const pilotFingerprint = new X509Certificate(otherClientPair.cert).fingerprint256;
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0,
    serverName: "hub.test", clientFingerprint256, tls: { ...relayPair, ca },
    additionalHosts: [{ publicPort: 0, clientFingerprint256: pilotFingerprint }],
    screenUdp: { address: "127.0.0.1", hosts: [clientFingerprint256, pilotFingerprint] } });
  const pilot = new RelayTunnel({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test",
    tls: { ...otherClientPair, ca }, targetHost: "127.0.0.1", targetPort: port(hub.url) });
  pilot.start();
  const control = connect({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", ca, ...clientPair, ALPNProtocols: [CONTROL_ALPN] });
  control.on("error", () => undefined);
  let downstream: ReturnType<typeof connect> | undefined;
  const frameTypes: string[] = [];
  try {
    const open = new Promise<Record<string, unknown>>((resolve, reject) => {
      let input = ""; const timer = setTimeout(() => reject(new Error("test_control_timeout")), 3000);
      control.on("data", chunk => {
        input += chunk.toString();
        for (;;) { const end = input.indexOf("\n"); if (end < 0) break; const frame = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
          frameTypes.push(frame.type);
          if (frame.type === "ready") { downstream = connect({ host: "127.0.0.1", port: relay.status.publicPort, servername: "hub.test", ca }); downstream.on("error", () => undefined); }
          if (frame.type === "open") { clearTimeout(timer); resolve(frame); }
        }
      });
    });
    expect(Object.keys(await open).sort()).toEqual(["id", "token", "type"]);
    expect(frameTypes).toEqual(["ready", "open"]);
    await expect.poll(() => pilot.screenUdpEndpoint?.port).toBe(relay.status.tunnelPort);
    const lease = await pilot.screenUdpLease();
    expect(lease?.port).toBe(relay.status.tunnelPort);
    lease?.close();
    expect((await get(relay.status.hosts![1].publicPort, "/health", "hub.test")).status).toBe(200);
    expect(relay.status.hosts?.map(host => host.connected)).toEqual([true, true]);
  } finally { downstream?.destroy(); control.destroy(); pilot.stop(); await relay.close(); await hub.close(); }
});

test("a mapped TCP port forwards traffic when the UDP advertisement names the internal port", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "udp-tcp-mapped"), tls: hubPair });
  const clientFingerprint256 = new X509Certificate(clientPair.cert).fingerprint256;
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0,
    serverName: "hub.test", clientFingerprint256, tls: { ...relayPair, ca },
    screenUdp: { address: "127.0.0.1", hosts: [clientFingerprint256] } });
  const connections = new Set<Socket>();
  const mapping = createServer(external => {
    const internal = tcpConnect({ host: "127.0.0.1", port: relay.status.tunnelPort });
    for (const [socket, peer] of [[external, internal], [internal, external]]) {
      connections.add(socket);
      socket.on("error", () => peer.destroy());
      socket.once("close", () => { connections.delete(socket); peer.destroy(); });
      socket.pipe(peer);
    }
  });
  await new Promise<void>(resolve => mapping.listen(0, "127.0.0.1", resolve));
  const tunnel = new RelayTunnel({ host: "127.0.0.1", port: (mapping.address() as { port: number }).port, servername: "relay.test",
    tls: { ...clientPair, ca }, targetHost: "127.0.0.1", targetPort: port(hub.url) });
  tunnel.start();
  try {
    expect(relay.status.screenUdp?.listening).toBe(true);
    await expect.poll(() => tunnel.online).toBe(true);
    expect((await get(relay.status.publicPort, "/health", "hub.test")).status).toBe(200);
    expect(tunnel.online).toBe(true);
    expect(tunnel.screenUdpEndpoint).toBeUndefined();
    expect(await tunnel.screenUdpLease()).toBeUndefined();
  } finally {
    tunnel.stop();
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => mapping.close(() => resolve()));
    await relay.close();
    await hub.close();
  }
});

test.each([CONTROL_ALPN, SOURCE_CONTROL_ALPN])("new tunnel handles missing source metadata explicitly on %s", async protocol => {
  const sockets = new Set<Socket>(), warnings: string[] = []; let registrations = 0;
  const target = createServer(socket => { sockets.add(socket); socket.on("error", () => undefined); });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const stub = createTlsServer({ ...relayPair, ca, requestCert: true, rejectUnauthorized: true, ALPNProtocols: [protocol, DATA_ALPN] }, socket => {
    sockets.add(socket); socket.on("error", () => undefined);
    if (socket.alpnProtocol !== DATA_ALPN) {
      sendFrame(socket, { type: "ready" });
      sendFrame(socket, { type: "open", id: "00000000-0000-4000-8000-000000000001", token: "a".repeat(43) });
    }
  });
  await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
  const tunnel = new RelayTunnel({ host: "127.0.0.1", port: (stub.address() as { port: number }).port, servername: "relay.test", tls: { ...clientPair, ca },
    targetHost: "127.0.0.1", targetPort: (target.address() as { port: number }).port, onWarning: code => warnings.push(code), onSource: (_socket, source) => { expect(source).toBeUndefined(); registrations++; } });
  tunnel.start();
  try {
    if (protocol === CONTROL_ALPN) { await expect.poll(() => registrations).toBe(1); expect(warnings).toContain("relay_source_unavailable_upgrade_relay"); }
    else { await expect.poll(() => sockets.size).toBeGreaterThan(0); await expect.poll(() => [...sockets].some(s => s.destroyed)).toBe(true); expect(registrations).toBe(0); }
  } finally { tunnel.stop(); for (const socket of sockets) socket.destroy(); await Promise.all([stub, target].map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
});

test("explicit public HTTPS serves the Hub without Tailscale and keeps worker APIs private", async () => {
  await expect(HubServer.start({ stateDir: path.join(root, "public-plain"), host: "0.0.0.0", exposure: "public" })).rejects.toThrow("TLS");
  await expect(HubServer.start({ stateDir: path.join(root, "public-implicit"), host: "0.0.0.0", tls: hubPair })).rejects.toThrow();
  const hub = await HubServer.start({ stateDir: path.join(root, "public-host"), host: "0.0.0.0", exposure: "public", tls: hubPair, origins: ["https://hub.test"] });
  try {
    expect((await get(port(hub.url), "/health", "hub.test", "https://hub.test")).status).toBe(200);
    expect((await get(port(hub.url), "/api/devices")).status).toBe(401);
    expect((await get(port(hub.url), "/api/instance/uploads")).status).toBe(401);
    expect((await get(port(hub.url), "/health", "hub.test", "https://evil.test")).status).toBe(403);
    expect(hub.instanceUrl).toMatch(/^http:\/\/127.0.0.1:/);
    await expect(new Promise<void>((resolve, reject) => {
      const socketOptions = { ca, servername: "hub.test", handshakeTimeout: 2000 };
      const socket = new WebSocket(`wss://127.0.0.1:${port(hub.url)}/instance`, socketOptions);
      socket.once("open", () => { socket.terminate(); resolve(); }); socket.once("error", reject);
    })).rejects.toThrow();
  } finally { await hub.close(); }
  // Public exposure applies to exactly the selected listener, including extras.
  const extra = await HubServer.start({ stateDir: path.join(root, "public-extra"), tlsListeners: [{ host: "0.0.0.0", port: 0, exposure: "public", tls: hubPair }] });
  try { expect((await get(port(extra.urls.find((url) => url.startsWith("https:"))!), "/api/instance/uploads")).status).toBe(401); }
  finally { await extra.close(); }
});

test("TLS listeners accept native origins but reject instance access even from a loopback relay", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "isolation"), tls: hubPair });
  try {
    expect(hub.instanceUrl).toMatch(/^http:\/\/127.0.0.1:/);
    expect((await get(port(hub.url), "/health", "hub.test", "tauri://localhost")).status).toBe(200);
    expect((await get(port(hub.url), "/health", "hub.test", "https://evil.test")).status).toBe(403);
    expect((await get(port(hub.url), "/api/instance/uploads")).status).toBe(401);
    expect((await fetch(hub.instanceUrl + "/health")).status).toBe(200);
  } finally { await hub.close(); }
});

test("outbound mutual TLS relay passes encrypted Hub traffic, enforces SNI and reconnects", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "roundtrip"), tls: hubPair });
  const captured: Buffer[] = []; const sockets = new Set<Socket>();
  const tap = createServer((socket) => { const upstream = tcpConnect({ host: "127.0.0.1", port: port(hub.url) }); for (const s of [socket, upstream]) { sockets.add(s); s.on("error", () => undefined); s.on("close", () => sockets.delete(s)); } socket.on("data", (chunk: Buffer) => captured.push(Buffer.from(chunk))); upstream.on("data", (chunk: Buffer) => captured.push(Buffer.from(chunk))); socket.pipe(upstream).pipe(socket); socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy()); });
  await new Promise<void>((resolve) => tap.listen(0, "127.0.0.1", resolve)); const tapAddress = tap.address(); if (!tapAddress || typeof tapAddress === "string") throw new Error("tap_not_listening");
  const options = { publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ...relayPair, ca } };
  let relay = await RelayServer.start(options); const publicPort = relay.status.publicPort; const tunnelPort = relay.status.tunnelPort;
  const tunnel = new RelayTunnel({ host: "127.0.0.1", port: tunnelPort, servername: "relay.test", tls: { ...clientPair, ca }, targetHost: "127.0.0.1", targetPort: tapAddress.port });
  tunnel.start();
  try {
    await expect.poll(() => tunnel.online).toBe(true);
    const result = await get(publicPort, "/health"); expect(result.status).toBe(200); expect(JSON.parse(result.body).publicKey).toBe(hub.auth.publicKey);
    expect(Buffer.concat(captured).includes(Buffer.from("GET /health"))).toBe(false); expect(Buffer.concat(captured).includes(Buffer.from(hub.auth.publicKey))).toBe(false);
    await expect(get(publicPort, "/health", "other.test")).rejects.toThrow();
    await relay.close(); await expect.poll(() => tunnel.online).toBe(false);
    relay = await RelayServer.start({ ...options, publicPort, tunnelPort });
    await expect.poll(() => tunnel.online, { timeout: 5000 }).toBe(true); expect((await get(publicPort, "/health")).status).toBe(200);
  } finally { tunnel.stop(); await relay.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => tap.close(() => resolve())); await hub.close(); }
}, 15_000);

test.each(["request-close", "server-idle", "client-fin"] as const)("completed HTTPS requests release relay capacity for later clients (%s)", async (closeMode) => {
  const serverIdle = closeMode === "server-idle";
  const target = createHttpsServer(hubPair, (_req, res) => res.end("complete"));
  if (serverIdle) target.keepAliveTimeout = 25;
  const agent = closeMode !== "request-close" ? new Agent({ keepAlive: true, maxSockets: 1 }) : false;
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0,
    serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256,
    tls: { ...relayPair, ca }, maxConnections: 8 });
  const tunnel = new RelayTunnel({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test",
    tls: { ...clientPair, ca }, targetHost: "127.0.0.1", targetPort: (target.address() as { port: number }).port });
  tunnel.start();
  try {
    await expect.poll(() => tunnel.online).toBe(true);
    const baseline = relay.status.connections;
    const tunnelConnections = () => (tunnel as unknown as { sockets: Set<Socket> }).sockets.size;
    const tunnelBaseline = tunnelConnections();
    // Cover explicit client close and keep-alive connections closed by the
    // server's idle timer. Neither may retain quota for ten minutes. The
    // explicit-close case also exercises more fresh connections than the quota.
    for (let i = 0; i < (serverIdle ? 4 : 24); i++) {
      const body = await new Promise<string>((resolve, reject) => {
        let clientSocket: Socket | undefined;
        const req = request({ host: "127.0.0.1", port: relay.status.publicPort, servername: "hub.test", ca, agent }, res => {
          let value = ""; res.on("data", chunk => { value += String(chunk); });
          res.on("end", () => { if (closeMode === "client-fin") clientSocket?.end(); resolve(value); }); res.on("error", reject);
        });
        req.on("socket", socket => { clientSocket = socket; });
        req.on("error", reject); req.setTimeout(2000, () => req.destroy(new Error("relay_capacity_timeout"))); req.end();
      });
      expect(body).toBe("complete");
      await expect.poll(() => relay.status.connections, { timeout: serverIdle ? 2500 : 1000 }).toBe(baseline);
      await expect.poll(tunnelConnections, { timeout: 1000 }).toBe(tunnelBaseline);
    }
    expect(tunnel.online).toBe(true);
  } finally { if (agent) agent.destroy(); tunnel.stop(); await relay.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
}, 15_000);

test.each(["127.0.0.1", "hub.test"])("only dedicated IP relay %s accepts a complete TLS hello without SNI", async serverName => {
  const hub = await HubServer.start({ stateDir: path.join(root, `no-sni-${serverName}`), tls: hubPair });
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0,
    serverName, clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ...relayPair, ca } });
  const tunnel = new RelayTunnel({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test",
    tls: { ...clientPair, ca }, targetHost: "127.0.0.1", targetPort: port(hub.url) });
  tunnel.start();
  try {
    await expect.poll(() => tunnel.online).toBe(true);
    if (serverName === "127.0.0.1") {
      // Empty servername sends no SNI; certificate trust and IP SAN checking stay enabled.
      const health = await get(relay.status.publicPort, "/health", "");
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body).publicKey).toBe(hub.auth.publicKey);
      expect((await get(relay.status.publicPort, "/api/instance/uploads", "")).status).toBe(401);
      await expect(get(relay.status.publicPort, "/health", "hub.test")).rejects.toThrow();
    } else {
      await expect(get(relay.status.publicPort, "/health", "")).rejects.toThrow();
      expect((await get(relay.status.publicPort, "/health")).status).toBe(200);
    }
    await expect(get(relay.status.publicPort, "/health", "other.test")).rejects.toThrow();
  } finally { tunnel.stop(); await relay.close(); await hub.close(); }
});

test("two warm TLS tunnels share one Hub and a failed primary cannot close the backup", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "multi-relay"), tls: hubPair });
  const options = { publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ...relayPair, ca } };
  let primary = await RelayServer.start(options); const backup = await RelayServer.start(options);
  const publicPort = primary.status.publicPort, tunnelPort = primary.status.tunnelPort;
  const fleet = await RelayTunnels.load(hubConfigSchema.parse({ host: "127.0.0.1", port: port(hub.url), tls: { cert: "fixture.pem", key: "fixture.key" }, relays: [primary, backup].map((server, i) => ({ id: i ? "backup" : "primary", label: i ? "备 VPS" : "主 VPS", host: "127.0.0.1", port: server.status.tunnelPort, servername: "relay.test", targetPort: port(hub.url), tls: { ca: path.join(root, "ca.pem"), cert: path.join(root, "client.pem"), key: path.join(root, "client.key") } })) }));
  fleet.start();
  try {
    await expect.poll(() => fleet.status.allOnline).toBe(true);
    for (const server of [primary, backup]) expect(JSON.parse((await get(server.status.publicPort, "/health")).body).publicKey).toBe(hub.auth.publicKey);
    await primary.close(); await expect.poll(() => fleet.status.servers[0]?.online).toBe(false);
    expect(fleet.status).toMatchObject({ configured: true, online: true, allOnline: false });
    expect(JSON.parse((await get(backup.status.publicPort, "/health")).body).publicKey).toBe(hub.auth.publicKey);
    primary = await RelayServer.start({ ...options, publicPort, tunnelPort }); await expect.poll(() => fleet.status.allOnline, { timeout: 5000 }).toBe(true);
    expect((await get(publicPort, "/health")).status).toBe(200);
    fleet.stop(); expect(fleet.status.online).toBe(false);
  } finally { fleet.stop(); await primary.close(); await backup.close(); await hub.close(); }
}, 15_000);

test("one relay serves two computers on one tunnel port, each through its own public port", async () => {
  const computer = async (name: string) => { const server = createHttpsServer(hubPair, (_req, res) => res.end(name)); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return server; };
  const first = await computer("first"), second = await computer("second");
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "hub.test",
    clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, additionalHosts: [{ publicPort: 0, clientFingerprint256: new X509Certificate(otherClientPair.cert).fingerprint256 }], tls: { ...relayPair, ca } });
  const tunnel = (pair: typeof clientPair, target: typeof first) => new RelayTunnel({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", tls: { ...pair, ca }, targetHost: "127.0.0.1", targetPort: (target.address() as { port: number }).port });
  const one = tunnel(clientPair, first); let two = tunnel(otherClientPair, second);
  one.start(); two.start();
  try {
    await expect.poll(() => one.online && two.online).toBe(true);
    const [portOne, portTwo] = relay.status.hosts!.map(host => host.publicPort);
    expect(new Set([portOne, portTwo, relay.status.tunnelPort]).size).toBe(3);
    expect(relay.status).toMatchObject({ connected: true, publicPort: portOne, hosts: [{ publicPort: portOne, connected: true }, { publicPort: portTwo, connected: true }] });
    // Each public port reaches its own computer and never the other.
    for (let round = 0; round < 3; round++) expect([(await get(portOne, "/")).body, (await get(portTwo, "/")).body]).toEqual(["first", "second"]);
    // One computer going away closes nothing of the other's, and its own port answers nobody meanwhile.
    two.stop();
    await expect.poll(() => relay.status.hosts![1].connected).toBe(false);
    expect(relay.status.connected).toBe(true);
    expect((await get(portOne, "/")).body).toBe("first");
    await expect(get(portTwo, "/")).rejects.toThrow();
    // It comes back on the same tunnel port without the first one noticing.
    two = tunnel(otherClientPair, second); two.start();
    await expect.poll(() => relay.status.hosts![1].connected).toBe(true);
    expect([(await get(portOne, "/")).body, (await get(portTwo, "/")).body]).toEqual(["first", "second"]);
    expect(one.online).toBe(true);
  } finally { one.stop(); two.stop(); await relay.close(); await Promise.all([first, second].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); }
}, 15_000);

test("a computer's data stream cannot join a connection that arrived for another computer", async () => {
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "hub.test",
    clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, additionalHosts: [{ publicPort: 0, clientFingerprint256: new X509Certificate(otherClientPair.cert).fingerprint256 }], tls: { ...relayPair, ca } });
  const sockets: { destroy(): void }[] = [];
  const dial = (pair: typeof clientPair, protocol: string) => { const socket = connect({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", ca, ...pair, ALPNProtocols: [protocol] }); socket.on("error", () => undefined); sockets.push(socket); return socket; };
  /** A control channel that reports when it is ready and hands over each `open` it is sent. */
  const control = (pair: typeof clientPair) => {
    const socket = dial(pair, CONTROL_ALPN), opens: { id: string; token: string }[] = []; let ready = false, input = "";
    socket.on("data", chunk => { input += chunk.toString(); for (;;) { const end = input.indexOf("\n"); if (end < 0) break; const frame = JSON.parse(input.slice(0, end)); input = input.slice(end + 1); if (frame.type === "ready") ready = true; if (frame.type === "open") opens.push(frame); } });
    return { opens, ready: () => ready, close: () => socket.destroy() };
  };
  /** Claims a pending connection as `pair`; resolves with what the relay then sends, or "closed". */
  const claim = (pair: typeof clientPair, open: { id: string; token: string }) => new Promise<string>(resolve => {
    const socket = dial(pair, DATA_ALPN);
    socket.once("secureConnect", () => socket.write(JSON.stringify({ id: open.id, token: open.token }) + "\n"));
    socket.once("data", chunk => resolve(`bytes:${chunk.length}`)); socket.once("close", () => resolve("closed"));
  });
  try {
    const first = control(clientPair), second = control(otherClientPair);
    await expect.poll(() => first.ready() && second.ready()).toBe(true);
    const [portOne, portTwo] = relay.status.hosts!.map(host => host.publicPort);
    // A device arrives for the first computer: only the first computer is told.
    const device = connect({ host: "127.0.0.1", port: portOne, servername: "hub.test", ca }); device.on("error", () => undefined); sockets.push(device);
    await expect.poll(() => first.opens.length).toBe(1);
    expect(second.opens).toEqual([]);
    // The second computer presents the first one's id and token: refused, and the connection is still there for its owner.
    expect(await claim(otherClientPair, first.opens[0])).toBe("closed");
    expect(await claim(clientPair, first.opens[0])).toMatch(/^bytes:\d+$/);   // the device's ClientHello, forwarded untouched
    // And the other way round.
    const other = connect({ host: "127.0.0.1", port: portTwo, servername: "hub.test", ca }); other.on("error", () => undefined); sockets.push(other);
    await expect.poll(() => second.opens.length).toBe(1);
    expect(first.opens).toHaveLength(1);
    expect(await claim(clientPair, second.opens[0])).toBe("closed");
    expect(await claim(otherClientPair, second.opens[0])).toMatch(/^bytes:\d+$/);
    // One computer's control channel closing ends its own waiting connection and leaves the other computer's to be claimed.
    for (const target of [portOne, portTwo]) { const waiting = connect({ host: "127.0.0.1", port: target, servername: "hub.test", ca }); waiting.on("error", () => undefined); sockets.push(waiting); }
    await expect.poll(() => first.opens.length === 2 && second.opens.length === 2).toBe(true);
    first.close();
    await expect.poll(() => relay.status.hosts![0].connected).toBe(false);
    expect(relay.status.pending).toBe(1);
    expect(await claim(clientPair, first.opens[1])).toBe("closed");
    expect(await claim(otherClientPair, second.opens[1])).toMatch(/^bytes:\d+$/);
  } finally { for (const socket of sockets) socket.destroy(); await relay.close(); }
});

test("each computer has its own connection budget: one that is crowded or stalled leaves the other its capacity", async () => {
  const computer = async (name: string) => { const server = createHttpsServer(hubPair, (_req, res) => res.end(name)); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return server; };
  const first = await computer("first"), second = await computer("second");
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "hub.test", maxConnections: 4,
    clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, additionalHosts: [{ publicPort: 0, clientFingerprint256: new X509Certificate(otherClientPair.cert).fingerprint256 }], tls: { ...relayPair, ca } });
  const tunnel = (pair: typeof clientPair, target: typeof first) => new RelayTunnel({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", tls: { ...pair, ca }, targetHost: "127.0.0.1", targetPort: (target.address() as { port: number }).port });
  const one = tunnel(clientPair, first), two = tunnel(otherClientPair, second); const held: { destroy(): void }[] = [];
  one.start(); two.start();
  try {
    await expect.poll(() => one.online && two.online).toBe(true);
    const [portOne, portTwo] = relay.status.hosts!.map(host => host.publicPort);
    // Devices arrive at the second computer's port and say nothing, more of them than one computer may hold.
    for (let i = 0; i < 10; i++) { const socket = tcpConnect({ host: "127.0.0.1", port: portTwo }); socket.on("error", () => undefined); held.push(socket); }
    // The second computer itself, with its own valid certificate, opens data streams that never claim a connection.
    const streams = Array.from({ length: 10 }, () => { const socket = connect({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", ca, ...otherClientPair, ALPNProtocols: [DATA_ALPN] }); socket.on("error", () => undefined); held.push(socket); return socket; });
    // It is held to its own limit: the streams past it are closed.
    await expect.poll(() => streams.filter(socket => socket.destroyed).length).toBeGreaterThan(0);
    // The first computer is served as if the second were idle, and the second computer's own port is the one that is full.
    for (let round = 0; round < 3; round++) expect((await get(portOne, "/")).body).toBe("first");
    await expect(get(portTwo, "/")).rejects.toThrow();
    expect(one.online).toBe(true);
  } finally { for (const socket of held) socket.destroy(); one.stop(); two.stop(); await relay.close(); await Promise.all([first, second].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); }
}, 15_000);

test("a relay for several computers refuses a certificate it does not list, and two computers cannot share one", async () => {
  const listed = new X509Certificate(clientPair.cert).fingerprint256;
  const start = (second: string) => RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "hub.test", clientFingerprint256: listed, additionalHosts: [{ publicPort: 0, clientFingerprint256: second }], tls: { ...relayPair, ca } });
  await expect(start(listed.toLowerCase())).rejects.toThrow("invalid_relay_hosts");
  const relay = await start(Array.from({ length: 32 }, () => "AB").join(":"));
  try {
    // Issued by the authority the relay trusts, but not one of the certificates it lists: no control channel for either computer.
    const outcome = await new Promise<string>(resolve => {
      const socket = connect({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", ca, ...otherClientPair, ALPNProtocols: [CONTROL_ALPN] });
      socket.on("error", () => resolve("closed")); socket.once("data", chunk => resolve(`sent:${chunk.toString()}`)); socket.once("close", () => resolve("closed"));
    });
    expect(outcome).toBe("closed");
    expect(relay.status.hosts!.map(host => host.connected)).toEqual([false, false]);
  } finally { await relay.close(); }
});

test("a relay configuration lists further computers beside the first; the single-computer form is unchanged", () => {
  const fingerprint = (seed: string) => Array.from({ length: 32 }, () => seed).join(":");
  const base = { serverName: "192.0.2.10", publicPort: 8443, tunnelPort: 7443, healthPort: 19878, clientFingerprint256: fingerprint("aa"), tls: { ca: "ca.pem", cert: "server.pem", key: "server.key" } };
  const parse = (extra: Record<string, unknown>) => relayServerSchema.safeParse({ ...base, ...extra });
  // As written today: nothing new appears in what it parses to.
  expect(parse({})).toMatchObject({ success: true });
  expect("additionalHosts" in (parse({}).data as object)).toBe(false);
  expect(relayHosts(parse({}).data!)).toEqual([{ publicPort: 8443, clientFingerprint256: fingerprint("aa") }]);
  const two = parse({ additionalHosts: [{ publicPort: 8444, clientFingerprint256: fingerprint("bb") }] });
  expect(two.success).toBe(true);
  expect(relayHosts(two.data!).map(host => host.publicPort)).toEqual([8443, 8444]);
  // Each computer needs its own public port and its own certificate, and no added port may be the tunnel or health port.
  for (const added of [{ publicPort: 8443, clientFingerprint256: fingerprint("bb") }, { publicPort: 7443, clientFingerprint256: fingerprint("bb") }, { publicPort: 19878, clientFingerprint256: fingerprint("bb") },
    { publicPort: 8444, clientFingerprint256: fingerprint("AA") }, { publicPort: 8444 }, { publicPort: 8444, clientFingerprint256: fingerprint("bb"), name: "x" }]) expect(parse({ additionalHosts: [added] }).success).toBe(false);
  expect(parse({ additionalHosts: [] }).success).toBe(false);
  const local = { localTls: { serverName: "push.example.com", targetPort: 9443 } };
  expect(parse({ ...local, additionalHosts: [{ publicPort: 8444, clientFingerprint256: fingerprint("bb") }] }).success).toBe(true);
  expect(parse({ ...local, additionalHosts: [{ publicPort: 9443, clientFingerprint256: fingerprint("bb") }] }).success).toBe(false);
  expect(parse({ additionalHosts: [{ publicPort: 8444, clientFingerprint256: fingerprint("bb") }, { publicPort: 8444, clientFingerprint256: fingerprint("cc") }] }).success).toBe(false);
});

test("the tunnel rejects absent credentials and a different client certificate", async () => {
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ...relayPair, ca } });
  try {
    await new Promise<void>((resolve, reject) => { const socket = connect({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", ca, ALPNProtocols: [CONTROL_ALPN] }); socket.on("error", () => undefined); socket.on("data", () => reject(new Error("unauthenticated_tunnel_accepted"))); socket.once("close", resolve); socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("authentication_not_rejected")); }); });
    // Wrong fingerprint is rejected even when the certificate chains to the CA.
    const wrong = new RelayTunnel({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", tls: { ...otherClientPair, ca }, targetHost: "127.0.0.1", targetPort: 1 }); wrong.start(); await new Promise((r) => setTimeout(r, 300)); expect(wrong.online).toBe(false); wrong.stop();
  } finally { await relay.close(); }
});

test("the handshake deadline closes silent peers but does not expire an established idle tunnel", async () => {
  const echoSockets = new Set<Socket>();
  const echo = createTlsServer(hubPair, (socket) => { echoSockets.add(socket); socket.on("error", () => undefined); socket.once("close", () => echoSockets.delete(socket)); socket.pipe(socket); });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const address = echo.address(); if (!address || typeof address === "string") throw new Error("echo_not_listening");
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ...relayPair, ca } });
  const tunnel = new RelayTunnel({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", tls: { ...clientPair, ca }, targetHost: "127.0.0.1", targetPort: address.port });
  const silent = tcpConnect({ host: "127.0.0.1", port: relay.status.tunnelPort }); silent.on("error", () => undefined);
  let client: ReturnType<typeof connect> | undefined;
  tunnel.start();
  try {
    await expect.poll(() => tunnel.online).toBe(true);
    client = connect({ host: "127.0.0.1", port: relay.status.publicPort, servername: "hub.test", ca }); client.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => { client!.once("secureConnect", resolve); client!.once("error", reject); });
    const exchange = (text: string) => new Promise<string>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("idle_tunnel_did_not_echo")), 2000); client!.once("data", (data) => { clearTimeout(timeout); resolve(String(data)); }); client!.write(text); });
    expect(await exchange("before idle")).toBe("before idle");
    await new Promise((resolve) => setTimeout(resolve, 16_000));
    expect(silent.destroyed).toBe(true);
    expect(client.destroyed).toBe(false);
    expect(tunnel.online).toBe(true);
    expect(await exchange("after idle")).toBe("after idle");
  } finally { client?.destroy(); silent.destroy(); tunnel.stop(); await relay.close(); for (const socket of echoSockets) socket.destroy(); await new Promise<void>((resolve) => echo.close(() => resolve())); }
}, 25_000);

test.each(["tunnel", "local"] as const)("%s routing drains a large closing response to a slow receiver", async (route) => {
  const payload = Buffer.alloc(16 * 1024 * 1024, 91);
  const origin = createHttpsServer(route === "tunnel" ? hubPair : relayPair, (_req, res) => { res.writeHead(200, { "Content-Length": payload.length, Connection: "close" }); res.end(payload); });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const address = origin.address(); if (!address || typeof address === "string") throw new Error("origin_not_listening");
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ...relayPair, ca }, ...(route === "local" ? { localTls: { serverName: "relay.test", targetPort: address.port } } : {}) });
  // Constrain the encrypted uplink too: fast loopback can drain all writes
  // before the origin closes and conceal the truncation seen on a real VPS.
  const tapSockets = new Set<Socket>();
  const tap = createServer({ allowHalfOpen: true }, (socket) => {
    const upstream = tcpConnect({ host: "127.0.0.1", port: relay.status.tunnelPort, allowHalfOpen: true });
    const slow = new Transform({ transform(chunk, _encoding, callback) { setTimeout(() => callback(null, chunk), 20); } });
    for (const s of [socket, upstream]) { tapSockets.add(s); s.on("error", () => { socket.destroy(); upstream.destroy(); }); s.once("close", () => tapSockets.delete(s)); }
    socket.pipe(slow).pipe(upstream); upstream.pipe(socket);
  });
  await new Promise<void>((resolve) => tap.listen(0, "127.0.0.1", resolve));
  const tapAddress = tap.address(); if (!tapAddress || typeof tapAddress === "string") throw new Error("tap_not_listening");
  const tunnel = new RelayTunnel({ host: "127.0.0.1", port: tapAddress.port, servername: "relay.test", tls: { ...clientPair, ca }, targetHost: "127.0.0.1", targetPort: address.port });
  try {
    if (route === "tunnel") { tunnel.start(); await expect.poll(() => tunnel.online).toBe(true); }
    const received = await new Promise<Buffer>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: relay.status.publicPort, servername: route === "tunnel" ? "hub.test" : "relay.test", ca, agent: false }, (res) => {
        const parts: Buffer[] = []; res.on("error", reject);
        res.on("data", (data: Buffer) => { parts.push(data); res.pause(); setTimeout(() => res.resume(), 5); });
        res.on("end", () => resolve(Buffer.concat(parts)));
      });
      req.on("error", reject); req.setTimeout(20_000, () => req.destroy(new Error("slow_download_timeout"))); req.end();
    });
    expect(received.equals(payload)).toBe(true);
  } finally { tunnel.stop(); for (const socket of tapSockets) socket.destroy(); await new Promise<void>((resolve) => tap.close(() => resolve())); await relay.close(); origin.closeAllConnections(); await new Promise<void>((resolve) => origin.close(() => resolve())); }
}, 30_000);

test("a sibling TLS service shares the public listener without receiving Hub traffic", async () => {
  const received: string[] = [];
  const sibling = createHttpsServer(relayPair, (req, res) => { received.push(req.url!); res.end("private notification service"); });
  await new Promise<void>((resolve) => sibling.listen(0, "127.0.0.1", resolve));
  const address = sibling.address(); if (!address || typeof address === "string") throw new Error("missing_listener");
  const hub = await HubServer.start({ stateDir: path.join(root, "sibling"), tls: hubPair });
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ...relayPair, ca }, localTls: { serverName: "relay.test", targetPort: address.port } });
  const tunnel = new RelayTunnel({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test", tls: { ...clientPair, ca }, targetHost: "127.0.0.1", targetPort: port(hub.url) });
  try {
    expect((await get(relay.status.publicPort, "/v1/health", "relay.test")).body).toBe("private notification service");
    await expect(get(relay.status.publicPort, "/hub-secret", "hub.test")).rejects.toThrow();
    await expect(get(relay.status.publicPort, "/unknown", "other.test")).rejects.toThrow();
    tunnel.start(); await expect.poll(() => tunnel.online).toBe(true);
    expect(JSON.parse((await get(relay.status.publicPort, "/health")).body).publicKey).toBe(hub.auth.publicKey);
    expect(received).toEqual(["/v1/health"]);
    tunnel.stop(); await expect.poll(() => relay.status.connected).toBe(false);
    expect((await get(relay.status.publicPort, "/still-online", "relay.test")).status).toBe(200);
    await expect(RelayServer.start({ ...relay.options, localTls: { serverName: "hub.test", targetPort: address.port } })).rejects.toThrow("invalid_local_tls_route");
  } finally { tunnel.stop(); await relay.close(); sibling.closeAllConnections(); await new Promise<void>((resolve) => sibling.close(() => resolve())); await hub.close(); }
});

test("Hub chooses the configured SNI certificate and refuses unknown names", async () => {
  const tls = await loadHubTls({ cert: path.join(root, "hub.pem"), key: path.join(root, "hub.key"), sni: { "hub.test": { cert: path.join(root, "hub.pem"), key: path.join(root, "hub.key") }, "relay.test": { cert: path.join(root, "relay.pem"), key: path.join(root, "relay.key") } } });
  const hub = await HubServer.start({ stateDir: path.join(root, "sni"), tls });
  try { expect((await get(port(hub.url), "/health", "hub.test")).status).toBe(200); expect((await get(port(hub.url), "/health", "relay.test")).status).toBe(200); await expect(get(port(hub.url), "/health", "unknown.test")).rejects.toThrow(); }
  finally { await hub.close(); }
});

test("relay deployment is deterministic, protects tunnel secrets and requires a verified SSH receipt", async () => {
  const configFile = path.join(root, "deployment.json"); const bundleFile = path.join(root, "relay.mjs");
  const config = { relay: { serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ca: "ca.pem", cert: "relay.pem", key: "relay.key" } }, runtime: { version: "24.0.0", x64: "a".repeat(64), arm64: "b".repeat(64) } };
  await writeFile(configFile, JSON.stringify(config)); await writeFile(bundleFile, "console.log('fixture');");
  const plan = await prepareRelayDeployment(configFile, bundleFile, () => { throw new Error("pinned runtime must not fetch"); });
  expect(await prepareRelayDeployment(configFile, bundleFile)).toEqual(plan);
  // One computer: the firewall opens its public port and the tunnel port, as before. Further computers add their own public ports, and nothing else.
  expect(plan.script).toContain("tcp dport { $ssh_port, 443, 7443 } accept");
  expect("additionalPublic" in (plan.summary.ports as object)).toBe(false);
  const shared = path.join(root, "deployment-shared.json");
  await writeFile(shared, JSON.stringify({ ...config, relay: { ...config.relay, additionalHosts: [{ publicPort: 8444, clientFingerprint256: new X509Certificate(otherClientPair.cert).fingerprint256 }] } }));
  const sharedPlan = await prepareRelayDeployment(shared, bundleFile);
  expect(sharedPlan.script).toContain("tcp dport { $ssh_port, 443, 8444, 7443 } accept");
  expect(sharedPlan.summary.ports).toMatchObject({ public: 443, additionalPublic: [8444], tunnel: 7443 });
  await writeFile(shared, JSON.stringify({ ...config, relay: { ...config.relay, additionalHosts: [{ publicPort: 9877, clientFingerprint256: new X509Certificate(otherClientPair.cert).fingerprint256 }] } }));
  await expect(prepareRelayDeployment(shared, bundleFile)).rejects.toThrow("Relay ports must be distinct");   // 9877 is the default health port
  // The CA file holds one authority per computer, in any order; it must include the one that issued the relay's certificate.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "second-ca.key", "-out", "second-ca.pem", "-days", "1", "-subj", "/CN=TaroCub second test CA", "-addext", "basicConstraints=critical,CA:TRUE"], { cwd: root, stdio: "ignore" });
  const secondAuthority = await readFile(path.join(root, "second-ca.pem")), bundled = (file: string) => JSON.stringify({ ...config, relay: { ...config.relay, tls: { ...config.relay.tls, ca: file } } });
  for (const order of [[ca, secondAuthority], [secondAuthority, ca]]) { await writeFile(path.join(root, "ca-bundle.pem"), Buffer.concat(order)); await writeFile(shared, bundled("ca-bundle.pem")); expect((await prepareRelayDeployment(shared, bundleFile)).summary.ports).toMatchObject({ public: 443 }); }
  await writeFile(shared, bundled("second-ca.pem"));
  await expect(prepareRelayDeployment(shared, bundleFile)).rejects.toThrow("Invalid, expired or mismatched tunnel credentials");
  expect(JSON.stringify(plan.summary)).not.toContain("PRIVATE KEY");
  expect(plan.script).not.toContain(hubPair.key.toString("base64"));
  expect(plan.script).not.toContain(clientPair.key.toString("base64"));
  expect(plan.script).toContain(relayPair.key.toString("base64"));
  expect(plan.script).not.toContain("flush ruleset");
  execFileSync("bash", ["-n"], { input: plan.script });
  let calls = 0;
  const receipt = `TAROCUB_DEPLOYED revision=${String(plan.summary.revision)} changed=0 firewallChanged=0\n${JSON.stringify({ service: "tarocub-relay", connected: false, pending: 0, connections: 0, publicPort: 443, tunnelPort: 7443 })}`;
  expect(await deployRelay("owner@vps.test", plan, async (host, command, input) => { calls++; expect(host).toBe("owner@vps.test"); expect(command).toContain("sudo -n"); expect(command).toContain("$SSH_CONNECTION"); expect(input).toBe(plan.script); return receipt; })).toBe(receipt);
  expect(calls).toBe(1);
  await expect(deployRelay("vps.test", plan, async () => "queued")).rejects.toThrow("receipt");
  for (const host of ["-oProxyCommand=whoami", "host;touch /tmp/injected", "vps\nother", "a$(id)"]) expect(() => validateSshHost(host)).toThrow();
  expect(validateSshHost("my_vps-alias")).toBe("my_vps-alias");
  const updates = { url: "https://updates.example.test/relay.json", publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }), minRelease: 100 };
  await writeFile(configFile, JSON.stringify({ ...config, updates })); const auto = await prepareRelayDeployment(configFile, bundleFile);
  expect(auto.summary.updates).toMatchObject({ relay: "daily signed release feed", minRelease: 100 }); expect(auto.script).toContain("enable --now tarocub-relay-update.timer");
  expect(auto.script).not.toContain("BEGIN PRIVATE KEY"); await writeFile(path.join(root, "update-deploy.sh"), auto.script); execFileSync("bash", ["-n", path.join(root, "update-deploy.sh")]);
  await writeFile(configFile, JSON.stringify({ ...config, relay: { ...config.relay, tls: { ...config.relay.tls, key: "hub.key" } } }));
  await expect(prepareRelayDeployment(configFile, bundleFile)).rejects.toThrow("credentials");
});

test("relay exposes only a bounded loopback process health endpoint", async () => {
  const relay = await RelayServer.start({ publicHost: "127.0.0.1", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0, healthPort: 0, serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ...relayPair, ca } });
  try {
    const url = `http://127.0.0.1:${relay.status.healthPort}`;
    const response = await fetch(url + "/health"); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ service: "tarocub-relay", connected: false, publicPort: relay.status.publicPort });
    expect(Object.keys(body).sort()).toEqual(["connected", "connections", "healthPort", "pending", "publicPort", "service", "tunnelPort"]);   // one computer: no `hosts`
    expect((await fetch(url + "/config")).status).toBe(404); expect((await fetch(url + "/health", { method: "POST" })).status).toBe(404);
  } finally { await relay.close(); }
});

test("runtime resolution pins official LTS checksums and remote status uses the configured loopback health endpoint", async () => {
  const calls: string[] = [];
  const runtime = await resolveRelayRuntime(async (input, init) => { calls.push(String(input)); expect(init?.redirect).toBe("error"); return new Response(calls.length === 1 ? JSON.stringify([{ version: "v26.0.0", lts: false }, { version: "v24.10.0", lts: "fixture" }]) : `${"a".repeat(64)}  node-v24.10.0-linux-x64.tar.xz\n${"b".repeat(64)}  node-v24.10.0-linux-arm64.tar.xz\n`); });
  expect(runtime.version).toBe("24.10.0"); expect(calls[1]).toBe("https://nodejs.org/dist/v24.10.0/SHASUMS256.txt");
  const status = { service: "tarocub-relay", connected: true, pending: 0, connections: 1, publicPort: 443, tunnelPort: 7443 };
  const observed: string[] = [];
  expect(await inspectRemoteRelay("vps.test", async (_host, command) => { observed.push(command); return JSON.stringify(observed.length === 1 ? { serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, healthPort: 9877, tls: { ca: "ca.pem", cert: "server.pem", key: "server.key" } } : observed.length === 2 ? status : {}); })).toEqual(status);
  expect(observed[1]).toContain("http://127.0.0.1:9877/health");
  // With several computers the status lists each of them.
  const several = { ...status, hosts: [{ publicPort: 443, connected: true }, { publicPort: 8444, connected: false }] }; let step = 0;
  expect(await inspectRemoteRelay("vps.test", async () => JSON.stringify(++step === 1 ? { serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, healthPort: 9877, tls: { ca: "ca.pem", cert: "server.pem", key: "server.key" } } : step === 2 ? several : {}))).toEqual(several);
});


test("companion deployment installs once, preserves credentials and restores failed changes", async () => {
  const archive = { version: "2.28.0", x64: "a".repeat(64), arm64: "b".repeat(64) };
  const config = { relay: { serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256, tls: { ca: "ca.pem", cert: "relay.pem", key: "relay.key" } }, runtime: { ...archive, version: "24.0.0" },
    ntfy: { serverName: "relay.test", tls: { cert: "relay.pem", key: "relay.key" }, username: "phone", passwordHash: "$2a$10$" + "a".repeat(53), archive },
    peerRelay: { port: 443, staticEndpoints: ["192.0.2.1:443"], hostname: "tarocub-relay", authKeyFile: "fixture-tail.key", archive: { ...archive, version: "1.86.0" } },
  };
  const configFile = path.join(root, "companions-deploy.json"), bundleFile = path.join(root, "companion-relay.mjs");
  await writeFile(path.join(root, "fixture-tail.key"), "tskey-auth-fixture-only-not-real-1234567890", { mode: 0o600 });
  await writeFile(configFile, JSON.stringify(config)); await writeFile(bundleFile, "console.log('companion fixture');");
  const plan = await prepareRelayDeployment(configFile, bundleFile);
  expect(JSON.stringify(plan.summary)).not.toContain("$2a$"); expect(JSON.stringify(plan.summary)).not.toContain("tskey-auth-");
  expect(plan.script).toContain("udp dport 443 accept"); expect(plan.script).not.toContain(config.ntfy.passwordHash);
  execFileSync("bash", ["-n"], { input: plan.script });
  const harness = await installerHarness(await mkdtemp(path.join(root, "installer-")));
  const first = await harness.run(plan.script); expect(first.stdout).toContain("TAROCUB_DEPLOYED");
  const original = await readlink(path.join(harness.root, "current"));
  const ntfy = JSON.parse(await readFile(path.join(original, "ntfy.json"), "utf8"));
  expect(ntfy).toMatchObject({ "auth-default-access": "deny-all", "behind-proxy": false, "listen-https": "127.0.0.1:8443", "auth-access": ["*:up*:write-only", "phone:up*:read-write"] });
  expect((await stat(path.join(original, "ntfy-key.pem"))).mode & 0o777).toBe(0o640);
  const beforeCommands = await harness.commands();
  const again = await harness.run(plan.script); expect(again.stdout).toContain("changed=0");
  expect((await harness.commands()).slice(beforeCommands.length).filter((c) => c.tool === "systemctl" && c.args[0] === "restart")).toEqual([]);
  // Fail after writing a changed unit/config file: restore actual previous bytes.
  const healthBefore = await readFile(path.join(harness.root, "check-health"), "utf8");
  const revised = { ...config, ntfy: { ...config.ntfy, healthPort: 2587 }, peerRelay: { ...config.peerRelay, port: 444, staticEndpoints: ["192.0.2.1:444"] } };
  await writeFile(configFile, JSON.stringify(revised)); const changed = await prepareRelayDeployment(configFile, bundleFile);
  await writeFile(path.join(harness.box, "fail-restart-tarocub-relay.service"), "once");
  // A restarted daemon can be active before its local API accepts preferences.
  await writeFile(path.join(harness.box, "delay-tail-start"), "once");
  await expect(harness.run(changed.script)).rejects.toThrow();
  expect(await readFile(path.join(harness.box, "tail-set-not-ready"), "utf8")).toBe("0");
  expect(await readlink(path.join(harness.root, "current"))).toBe(original);
  expect(await readFile(path.join(harness.root, "check-health"), "utf8")).toBe(healthBefore);
  expect(JSON.parse(await readFile(path.join(harness.box, "prefs.json"), "utf8"))).toMatchObject({ RelayServerPort: 443, RelayServerStaticEndpoints: ["192.0.2.1:443"] });
  const services = JSON.parse(await readFile(path.join(harness.box, "services.json"), "utf8"));
  expect(services["tarocub-relay.service"]).toEqual({ active: true, enabled: true });
  expect(services["tarocub-ntfy.service"]).toEqual({ active: true, enabled: true });
  // Removing a running sibling service is explicit decommissioning, never an
  // accidental consequence of leaving it out of an otherwise valid config.
  await writeFile(configFile, JSON.stringify({ relay: config.relay, runtime: config.runtime }));
  const omitted = await prepareRelayDeployment(configFile, bundleFile); await expect(harness.run(omitted.script)).rejects.toThrow("decommission");
  expect(await readlink(path.join(harness.root, "current"))).toBe(original);
  await writeFile(configFile, JSON.stringify({ ...config, ntfy: { ...config.ntfy, serverName: "hub.test" } }));
  await expect(prepareRelayDeployment(configFile, bundleFile)).rejects.toThrow();
  // A further computer's public port may not be one of ntfy's loopback ports (8443 and 2586 by default).
  const another = (publicPort: number) => JSON.stringify({ ...config, relay: { ...config.relay, additionalHosts: [{ publicPort, clientFingerprint256: new X509Certificate(otherClientPair.cert).fingerprint256 }] } });
  for (const taken of [8443, 2586]) { await writeFile(configFile, another(taken)); await expect(prepareRelayDeployment(configFile, bundleFile)).rejects.toThrow("ntfy requires"); }
  await writeFile(configFile, another(8444)); expect((await prepareRelayDeployment(configFile, bundleFile)).summary.ports).toMatchObject({ public: 443, additionalPublic: [8444] });
  await writeFile(configFile, JSON.stringify({ ...config, peerRelay: { ...config.peerRelay, staticEndpoints: ["host;bad:443"] } }));
  await expect(prepareRelayDeployment(configFile, bundleFile)).rejects.toThrow();
}, 120_000); // Four installer executions; the harness still bounds each child at 30 s.

test("a source trickling ClientHello bytes cannot hold relay capacity past an absolute deadline", async () => {
  const target = createHttpsServer(hubPair, (_req, res) => res.end("complete"));
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const relay = await RelayServer.start({ publicHost: "::", publicPort: 0, tunnelHost: "127.0.0.1", tunnelPort: 0,
    serverName: "hub.test", clientFingerprint256: new X509Certificate(clientPair.cert).fingerprint256,
    tls: { ...relayPair, ca }, maxConnections: 8, helloTimeoutMs: 600, maxHandshakesPerSource: 2 });
  const tunnel = new RelayTunnel({ host: "127.0.0.1", port: relay.status.tunnelPort, servername: "relay.test",
    tls: { ...clientPair, ca }, targetHost: "127.0.0.1", targetPort: (target.address() as { port: number }).port });
  tunnel.start();
  const attackers: Socket[] = [];
  let trickle: ReturnType<typeof setInterval> | undefined;
  try {
    await expect.poll(() => tunnel.online).toBe(true);
    // A TLS handshake record header, then one byte at a time: each byte resets
    // an inactivity timer, so only an absolute deadline ends these sockets.
    for (let i = 0; i < 4; i++) {
      const socket = tcpConnect({ host: "127.0.0.1", port: relay.status.publicPort }); socket.on("error", () => undefined);
      await new Promise<void>(resolve => socket.once("connect", resolve)); socket.write(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00])); attackers.push(socket);
    }
    trickle = setInterval(() => { for (const socket of attackers) if (!socket.destroyed) socket.write(Buffer.from([0x01])); }, 100);
    // Only two unauthenticated handshakes per source are admitted.
    await expect.poll(() => attackers.filter(socket => !socket.destroyed && !socket.closed).length, { timeout: 1000 }).toBe(2);
    // Another source is still served while those two are pending.
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "::1", port: relay.status.publicPort, servername: "hub.test", ca, agent: false }, res => {
        let value = ""; res.on("data", chunk => { value += String(chunk); }); res.on("end", () => resolve(value)); res.on("error", reject);
      });
      req.on("error", reject); req.setTimeout(3000, () => req.destroy(new Error("relay_capacity_timeout"))); req.end();
    });
    expect(body).toBe("complete");
    // Trickling does not extend the handshake past its deadline.
    await expect.poll(() => attackers.every(socket => socket.destroyed || socket.closed), { timeout: 2000 }).toBe(true);
  } finally { if (trickle) clearInterval(trickle); for (const socket of attackers) socket.destroy(); tunnel.stop(); await relay.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
}, 15_000);
