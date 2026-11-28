import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { connect as tcpConnect, createServer as createTcpServer, isIP, type Server as TcpServer, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer, type TlsOptions, type TLSSocket } from "node:tls";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { localTlsRouteSchema, relayHosts, RELAY_MAX_HOSTS, relayScreenUdpSchema } from "./config.js";
import { coupleSockets } from "./socket-lifecycle.js";
import { ClientHelloReader, CONTROL_ALPN, SOURCE_CONTROL_ALPN, SCREEN_UDP_CONTROL_ALPN, DATA_ALPN, dataHelloSchema, hasRelaySource, readFrames, sendFrame } from "./protocol.js";
import { sourceAddress } from "./sources.js";
import { ScreenUdpRelay } from "./screen-udp.js";
import type { z } from "zod";

/** Handshake quota key: an IPv4 address or an IPv6 /64, which one host controls. */
function handshakeSource(address: string | undefined): string {
  try {
    const value = sourceAddress(address ?? "");
    if (isIP(value) === 4) return value;
    const [head = "", tail = ""] = value.split("::"), left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
    const groups = value.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
    return `${groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(":")}::/64`;
  } catch { return "unknown"; }
}

export interface RelayServerOptions {
  publicHost?: string; publicPort?: number; tunnelHost?: string; tunnelPort?: number;
  serverName: string; clientFingerprint256: string; tls: TlsOptions;
  /** More computers on this relay: each has its own public port, and its tunnel
   * is recognised on the shared tunnel port by its certificate. */
  additionalHosts?: { publicPort?: number; clientFingerprint256: string }[];
  maxConnections?: number; onWarning?: (code: string) => void;
  /** Absolute accept-to-ClientHello bound and per-source cap on such sockets. */
  helloTimeoutMs?: number; maxHandshakesPerSource?: number;
  healthPort?: number;
  localTls?: { serverName: string; targetPort: number };
  screenUdp?: z.infer<typeof relayScreenUdpSchema>;
}
/** One computer: where its devices arrive, the certificate its tunnel shows, and that tunnel's control channel.
 * `sockets` are its device connections and the tunnel connections that showed its certificate; the limits
 * apply to each computer on its own, so a busy or stalled one leaves the others their capacity. */
type Host = { port: number; fingerprint: string; server: TcpServer; control?: TLSSocket; lastPong: number; sockets: Set<Socket>; handshakes: Map<string, number>; handshaking: number };
type Pending = { host: Host; socket: Socket; token: string; timer: ReturnType<typeof setTimeout>; hello: Buffer };
export class RelayServer {
  private hosts: Host[];
  private tunnelServer: TlsServer;
  private pending = new Map<string, Pending>();
  private sockets = new Set<Socket>();
  /** Connections to the tunnel port, whether or not they have shown a certificate yet. */
  private tunnels = new Set<Socket>();
  private timer?: ReturnType<typeof setInterval>;
  private healthServer?: HttpServer;
  private screenUdp?: ScreenUdpRelay;
  private constructor(readonly options: RelayServerOptions) {
    if (!/^[a-z0-9.-]+$/i.test(options.serverName)) throw new Error("invalid_server_name");
    const hosts = relayHosts(options);
    if (hosts.some(host => !/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/i.test(host.clientFingerprint256))) throw new Error("client_certificate_fingerprint_required");
    if (hosts.length > RELAY_MAX_HOSTS || new Set(hosts.map(host => host.clientFingerprint256.toUpperCase())).size !== hosts.length) throw new Error("invalid_relay_hosts");
    if (options.localTls) { localTlsRouteSchema.parse(options.localTls); if (options.localTls.serverName.toLowerCase() === options.serverName.toLowerCase() || [options.publicPort, options.tunnelPort, options.healthPort].includes(options.localTls.targetPort)) throw new Error("invalid_local_tls_route"); }
    if (options.screenUdp) relayScreenUdpSchema.parse(options.screenUdp);
    this.hosts = hosts.map(({ publicPort, clientFingerprint256 }, index) => {
      const host: Host = { port: index === 0 ? options.publicPort ?? 443 : publicPort, fingerprint: clientFingerprint256.toUpperCase(), lastPong: 0, sockets: new Set(), handshakes: new Map(), handshaking: 0, server: createTcpServer((socket) => this.acceptPublic(socket, host)) };
      return host;
    });
    // Bound unauthenticated handshakes at the TLS layer. A timeout on the raw
    // parent socket survives the handshake and kills otherwise healthy idle
    // streams even after their TLSSocket receives its longer data timeout.
    this.tunnelServer = createTlsServer({ ...options.tls, handshakeTimeout: 15_000, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3", ALPNProtocols: [SCREEN_UDP_CONTROL_ALPN, SOURCE_CONTROL_ALPN, CONTROL_ALPN, DATA_ALPN] }, (socket) => this.acceptTunnel(socket));
    this.tunnelServer.on("connection", (socket) => { if (this.tunnels.size >= (options.maxConnections ?? 256) * 2 * this.hosts.length) { socket.destroy(); return; } this.track(socket, this.tunnels); });
    this.tunnelServer.on("tlsClientError", (_error, socket) => { socket.destroy(); options.onWarning?.("tunnel_authentication_failed"); });
  }
  static async start(options: RelayServerOptions): Promise<RelayServer> {
    const relay = new RelayServer(options);
    try {
      await relay.listen(relay.tunnelServer, options.tunnelPort ?? 7443, options.tunnelHost ?? "0.0.0.0");
      if (options.screenUdp) {
        const { port } = relay.tunnelServer.address() as { port: number };
        try {
          relay.screenUdp = await ScreenUdpRelay.listen(options.tunnelHost ?? "0.0.0.0", port, options.screenUdp.address, () => options.onWarning?.("screen_udp_socket_failed"));
        } catch { options.onWarning?.("screen_udp_listen_failed"); }
      }
      for (const host of relay.hosts) await relay.listen(host.server, host.port, options.publicHost ?? "0.0.0.0");
      if (options.healthPort !== undefined) {
        relay.healthServer = createHttpServer((req, res) => {
          if (req.method !== "GET" || req.url !== "/health") { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ service: "tarocub-relay", ...relay.status }));
        });
        relay.healthServer.requestTimeout = 5000; relay.healthServer.headersTimeout = 5000;
        await relay.listen(relay.healthServer, options.healthPort, "127.0.0.1");
      }
      relay.timer = setInterval(() => { for (const host of relay.hosts) { if (!host.control) continue; if (Date.now() - host.lastPong > 45_000) host.control.destroy(); else sendFrame(host.control, { type: "ping" }); } }, 15_000); relay.timer.unref(); return relay;
    } catch (error) { await relay.close(); throw error; }
  }
  private listen(server: TcpServer, port: number, host: string): Promise<void> { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(); }); }); }
  private track(socket: Socket, owner: Set<Socket>): void { this.sockets.add(socket); owner.add(socket); socket.on("error", () => undefined); socket.once("close", () => { this.sockets.delete(socket); owner.delete(socket); }); }
  private acceptPublic(socket: Socket, host: Host): void {
    const maximum = this.options.maxConnections ?? 256;
    if (host.sockets.size >= maximum) { socket.destroy(); return; }
    // Before a complete ClientHello a socket is unauthenticated. Bound it by an
    // absolute deadline (each byte resets the inactivity timer), a per-source
    // cap and half of this computer's slots, so one slow sender cannot hold the
    // capacity other clients and established streams need. Distributed floods
    // remain the documented boundary.
    const source = handshakeSource(socket.remoteAddress);
    if (host.handshaking >= Math.max(1, Math.floor(maximum / 2)) || (host.handshakes.get(source) ?? 0) >= (this.options.maxHandshakesPerSource ?? 16)) { socket.destroy(); return; }
    host.handshaking++; host.handshakes.set(source, (host.handshakes.get(source) ?? 0) + 1);
    let handshaking = true;
    const deadline = setTimeout(() => socket.destroy(), this.options.helloTimeoutMs ?? 10_000); deadline.unref();
    const handshakeDone = () => {
      if (!handshaking) return; handshaking = false; clearTimeout(deadline); host.handshaking--;
      const count = (host.handshakes.get(source) ?? 1) - 1; if (count > 0) host.handshakes.set(source, count); else host.handshakes.delete(source);
    };
    socket.once("close", handshakeDone);
    this.track(socket, host.sockets); socket.setTimeout(10_000, () => socket.destroy());
    const ipEndpoint = isIP(this.options.serverName) !== 0;
    const reader = new ClientHelloReader(ipEndpoint);
    const receive = (chunk: Buffer) => {
      try {
        const name = reader.push(chunk); if (name === undefined) return;
        handshakeDone();
        const hello = reader.bytes();
        if (name === this.options.localTls?.serverName.toLowerCase()) { socket.pause(); socket.off("data", receive); this.forwardLocal(socket, hello, this.options.localTls.targetPort, host); return; }
        const control = host.control;
        if (!(name === this.options.serverName.toLowerCase() || ipEndpoint && name === "") || !control) { socket.destroy(); return; }
        socket.pause(); socket.off("data", receive);
        const id = randomUUID(); const token = randomBytes(32).toString("base64url");
        const timer = setTimeout(() => { this.pending.delete(id); socket.destroy(); }, 10_000); timer.unref();
        this.pending.set(id, { host, socket, token, timer, hello });
        socket.once("close", () => { clearTimeout(timer); this.pending.delete(id); });
        sendFrame(control, { type: "open", id, token, ...(hasRelaySource(control.alpnProtocol) ? { source: sourceAddress(socket.remoteAddress ?? "") } : {}) });
      } catch { socket.destroy(); }
    };
    socket.on("data", receive);
  }
  /** Only the configured sibling service may terminate its own TLS on the VPS.
   * The Hub route always uses the authenticated Mac tunnel, including outages. */
  private forwardLocal(socket: Socket, hello: Buffer, port: number, host: Host): void {
    const upstream = tcpConnect({ host: "127.0.0.1", port }); this.track(upstream, host.sockets);
    upstream.setTimeout(10_000, () => upstream.destroy());
    coupleSockets(socket, upstream);
    upstream.once("connect", () => {
      socket.setTimeout(600_000, () => socket.destroy()); upstream.setTimeout(600_000, () => upstream.destroy());
      upstream.write(hello); socket.pipe(upstream); upstream.pipe(socket); socket.resume();
    });
  }
  private acceptTunnel(socket: TLSSocket): void {
    socket.on("error", () => undefined);
    // The certificate says which computer this is. Everything it may do from here on is that computer's alone.
    const fingerprint = socket.getPeerCertificate().fingerprint256?.toUpperCase();
    const host = socket.authorized && fingerprint ? this.hosts.find(candidate => candidate.fingerprint === fingerprint) : undefined;
    if (!host || host.sockets.size >= (this.options.maxConnections ?? 256) * 2) { socket.destroy(); return; }
    host.sockets.add(socket); socket.once("close", () => host.sockets.delete(socket));
    socket.setTimeout(0);
    if (socket.alpnProtocol === CONTROL_ALPN || hasRelaySource(socket.alpnProtocol)) {
      if (host.control && !host.control.destroyed) { socket.destroy(); return; }
      host.control = socket; host.lastPong = Date.now();
      const allowed = this.options.screenUdp?.hosts;
      const udp = socket.alpnProtocol === SCREEN_UDP_CONTROL_ALPN
        && (!allowed || allowed.some(id => id.toUpperCase() === host.fingerprint)) ? this.screenUdp : undefined;
      readFrames(socket, frame => {
        if (frame.type === "pong") host.lastPong = Date.now();
        else if (frame.type === "ping") sendFrame(socket, { type: "pong" });
        else if (udp && frame.type === "screen-udp-allocate") {
          let accepted = false;
          try { udp.authorize(host.fingerprint, { id: frame.id, sender: frame.sender, viewer: frame.viewer }); accepted = true; }
          catch { /* Capacity or duplicate. Leave the TCP tunnel open. */ }
          sendFrame(socket, { type: "screen-udp-reply", id: frame.id, accepted });
        } else if (udp && frame.type === "screen-udp-keep") udp.keep(host.fingerprint, frame.id);
        else if (udp && frame.type === "screen-udp-release") udp.revoke(host.fingerprint, frame.id);
        else socket.destroy();
      });
      socket.once("close", () => { if (host.control !== socket) return; host.control = undefined; udp?.disconnect(host.fingerprint); for (const [id, p] of this.pending) if (p.host === host) { clearTimeout(p.timer); p.socket.destroy(); this.pending.delete(id); } });
      sendFrame(socket, { type: "ready" });
      if (udp) sendFrame(socket, { type: "screen-udp-ready", address: this.options.screenUdp!.address, port: udp.port });
      return;
    }
    if (socket.alpnProtocol !== DATA_ALPN || !host.control) { socket.destroy(); return; }
    socket.setTimeout(10_000, () => socket.destroy()); let buffer = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]); const end = buffer.indexOf(10);
      if (end < 0) { if (buffer.length > 1024) socket.destroy(); return; }
      if (end > 1024) { socket.destroy(); return; }
      try {
        const hello = dataHelloSchema.parse(JSON.parse(buffer.subarray(0, end).toString("utf8"))); const p = this.pending.get(hello.id);
        // A data stream joins only a connection that arrived for its own computer.
        if (!p || p.host !== host || hello.token.length !== p.token.length || !timingSafeEqual(Buffer.from(hello.token), Buffer.from(p.token))) { socket.destroy(); return; }
        clearTimeout(p.timer); this.pending.delete(hello.id); socket.off("data", receive);
        socket.setTimeout(600_000, () => socket.destroy()); p.socket.setTimeout(600_000, () => p.socket.destroy());
        coupleSockets(socket, p.socket);
        if (buffer.length > end + 1) p.socket.write(buffer.subarray(end + 1));
        socket.write(p.hello); p.socket.pipe(socket); socket.pipe(p.socket); p.socket.resume();
      } catch { socket.destroy(); }
    };
    socket.on("data", receive);
  }
  /** `connected` and `publicPort` describe the first computer, as they always did. `hosts` lists every computer when there is more than one. */
  get status(): { connected: boolean; pending: number; connections: number; publicPort: number; tunnelPort: number; healthPort?: number; screenUdp?: { listening: boolean; hosts: { publicPort: number; bytesForwarded: number; droppedPackets: number; pairs: number }[] }; hosts?: { publicPort: number; connected: boolean }[] } {
    const port = (server: TcpServer) => { const addr = server.address(); return addr && typeof addr !== "string" ? addr.port : 0; };
    const hosts = this.hosts.map(host => ({ publicPort: port(host.server), connected: !!host.control && !host.control.destroyed }));
    return { connected: hosts[0].connected, pending: this.pending.size, connections: this.sockets.size, publicPort: hosts[0].publicPort, tunnelPort: port(this.tunnelServer), ...(this.options.screenUdp ? { screenUdp: { listening: !!this.screenUdp, hosts: this.hosts.map(host => ({ publicPort: port(host.server),
      ...(this.screenUdp?.usage(host.fingerprint) ?? { bytesForwarded: 0, droppedPackets: 0, pairs: 0 }) })) } } : {}),
      ...(this.healthServer ? { healthPort: port(this.healthServer) } : {}), ...(hosts.length > 1 ? { hosts } : {}) };
  }
  async close(): Promise<void> { this.screenUdp?.close(); this.screenUdp = undefined; if (this.timer) clearInterval(this.timer); for (const p of this.pending.values()) clearTimeout(p.timer); this.pending.clear(); for (const socket of this.sockets) socket.destroy(); for (const host of this.hosts) host.control?.destroy(); this.healthServer?.closeAllConnections(); await Promise.all([...this.hosts.map(host => host.server), this.tunnelServer, this.healthServer].map((server) => new Promise<void>((resolve) => { if (!server?.listening) resolve(); else server.close(() => resolve()); }))); }
}
