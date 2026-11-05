import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { connect as tcpConnect, createServer as createTcpServer, isIP, type Server as TcpServer, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer, type TlsOptions, type TLSSocket } from "node:tls";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { localTlsRouteSchema } from "./config.js";
import { coupleSockets } from "./socket-lifecycle.js";
import { ClientHelloReader, CONTROL_ALPN, SOURCE_CONTROL_ALPN, DATA_ALPN, dataHelloSchema, readFrames, sendFrame } from "./protocol.js";
import { sourceAddress } from "./sources.js";

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
  maxConnections?: number; onWarning?: (code: string) => void;
  /** Absolute accept-to-ClientHello bound and per-source cap on such sockets. */
  helloTimeoutMs?: number; maxHandshakesPerSource?: number;
  healthPort?: number;
  localTls?: { serverName: string; targetPort: number };
}
type Pending = { socket: Socket; token: string; timer: ReturnType<typeof setTimeout>; hello: Buffer };
export class RelayServer {
  private publicServer: TcpServer;
  private tunnelServer: TlsServer;
  private control?: TLSSocket;
  private pending = new Map<string, Pending>();
  private sockets = new Set<Socket>();
  private handshakes = new Map<string, number>();
  private handshaking = 0;
  private timer?: ReturnType<typeof setInterval>;
  private lastPong = 0;
  private healthServer?: HttpServer;
  private constructor(readonly options: RelayServerOptions) {
    if (!/^[a-z0-9.-]+$/i.test(options.serverName)) throw new Error("invalid_server_name");
    if (!/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/i.test(options.clientFingerprint256)) throw new Error("client_certificate_fingerprint_required");
    if (options.localTls) { localTlsRouteSchema.parse(options.localTls); if (options.localTls.serverName.toLowerCase() === options.serverName.toLowerCase() || [options.publicPort, options.tunnelPort, options.healthPort].includes(options.localTls.targetPort)) throw new Error("invalid_local_tls_route"); }
    this.publicServer = createTcpServer((socket) => this.acceptPublic(socket));
    // Bound unauthenticated handshakes at the TLS layer. A timeout on the raw
    // parent socket survives the handshake and kills otherwise healthy idle
    // streams even after their TLSSocket receives its longer data timeout.
    this.tunnelServer = createTlsServer({ ...options.tls, handshakeTimeout: 15_000, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3", ALPNProtocols: [SOURCE_CONTROL_ALPN, CONTROL_ALPN, DATA_ALPN] }, (socket) => this.acceptTunnel(socket));
    this.tunnelServer.on("connection", (socket) => { if (this.sockets.size >= (options.maxConnections ?? 256) * 2) { socket.destroy(); return; } this.track(socket); });
    this.tunnelServer.on("tlsClientError", (_error, socket) => { socket.destroy(); options.onWarning?.("tunnel_authentication_failed"); });
  }
  static async start(options: RelayServerOptions): Promise<RelayServer> {
    const relay = new RelayServer(options);
    try {
      await relay.listen(relay.tunnelServer, options.tunnelPort ?? 7443, options.tunnelHost ?? "0.0.0.0");
      await relay.listen(relay.publicServer, options.publicPort ?? 443, options.publicHost ?? "0.0.0.0");
      if (options.healthPort !== undefined) {
        relay.healthServer = createHttpServer((req, res) => {
          if (req.method !== "GET" || req.url !== "/health") { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ service: "tarocub-relay", ...relay.status }));
        });
        relay.healthServer.requestTimeout = 5000; relay.healthServer.headersTimeout = 5000;
        await relay.listen(relay.healthServer, options.healthPort, "127.0.0.1");
      }
      relay.timer = setInterval(() => { if (!relay.control) return; if (Date.now() - relay.lastPong > 45_000) relay.control.destroy(); else sendFrame(relay.control, { type: "ping" }); }, 15_000); relay.timer.unref(); return relay;
    } catch (error) { await relay.close(); throw error; }
  }
  private listen(server: TcpServer, port: number, host: string): Promise<void> { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(); }); }); }
  private track(socket: Socket): void { this.sockets.add(socket); socket.on("error", () => undefined); socket.once("close", () => this.sockets.delete(socket)); }
  private acceptPublic(socket: Socket): void {
    const maximum = this.options.maxConnections ?? 256;
    if (this.sockets.size >= maximum) { socket.destroy(); return; }
    // Before a complete ClientHello a socket is unauthenticated. Bound it by an
    // absolute deadline (each byte resets the inactivity timer), a per-source
    // cap and half of all slots, so one slow sender cannot hold the capacity
    // other clients and established streams need. Distributed floods remain
    // the documented boundary.
    const source = handshakeSource(socket.remoteAddress);
    if (this.handshaking >= Math.max(1, Math.floor(maximum / 2)) || (this.handshakes.get(source) ?? 0) >= (this.options.maxHandshakesPerSource ?? 16)) { socket.destroy(); return; }
    this.handshaking++; this.handshakes.set(source, (this.handshakes.get(source) ?? 0) + 1);
    let handshaking = true;
    const deadline = setTimeout(() => socket.destroy(), this.options.helloTimeoutMs ?? 10_000); deadline.unref();
    const handshakeDone = () => {
      if (!handshaking) return; handshaking = false; clearTimeout(deadline); this.handshaking--;
      const count = (this.handshakes.get(source) ?? 1) - 1; if (count > 0) this.handshakes.set(source, count); else this.handshakes.delete(source);
    };
    socket.once("close", handshakeDone);
    this.track(socket); socket.setTimeout(10_000, () => socket.destroy());
    const ipEndpoint = isIP(this.options.serverName) !== 0;
    const reader = new ClientHelloReader(ipEndpoint);
    const receive = (chunk: Buffer) => {
      try {
        const name = reader.push(chunk); if (name === undefined) return;
        handshakeDone();
        const hello = reader.bytes();
        if (name === this.options.localTls?.serverName.toLowerCase()) { socket.pause(); socket.off("data", receive); this.forwardLocal(socket, hello, this.options.localTls.targetPort); return; }
        if (!(name === this.options.serverName.toLowerCase() || ipEndpoint && name === "") || !this.control) { socket.destroy(); return; }
        socket.pause(); socket.off("data", receive);
        const id = randomUUID(); const token = randomBytes(32).toString("base64url");
        const timer = setTimeout(() => { this.pending.delete(id); socket.destroy(); }, 10_000); timer.unref();
        this.pending.set(id, { socket, token, timer, hello });
        socket.once("close", () => { clearTimeout(timer); this.pending.delete(id); });
        sendFrame(this.control, { type: "open", id, token, ...(this.control.alpnProtocol === SOURCE_CONTROL_ALPN ? { source: sourceAddress(socket.remoteAddress ?? "") } : {}) });
      } catch { socket.destroy(); }
    };
    socket.on("data", receive);
  }
  /** Only the configured sibling service may terminate its own TLS on the VPS.
   * The Hub route always uses the authenticated Mac tunnel, including outages. */
  private forwardLocal(socket: Socket, hello: Buffer, port: number): void {
    const upstream = tcpConnect({ host: "127.0.0.1", port }); this.track(upstream);
    upstream.setTimeout(10_000, () => upstream.destroy());
    coupleSockets(socket, upstream);
    upstream.once("connect", () => {
      socket.setTimeout(600_000, () => socket.destroy()); upstream.setTimeout(600_000, () => upstream.destroy());
      upstream.write(hello); socket.pipe(upstream); upstream.pipe(socket); socket.resume();
    });
  }
  private acceptTunnel(socket: TLSSocket): void {
    socket.on("error", () => undefined);
    const fingerprint = socket.getPeerCertificate().fingerprint256;
    if (!socket.authorized || fingerprint?.toUpperCase() !== this.options.clientFingerprint256.toUpperCase()) { socket.destroy(); return; }
    socket.setTimeout(0);
    if (socket.alpnProtocol === CONTROL_ALPN || socket.alpnProtocol === SOURCE_CONTROL_ALPN) {
      if (this.control && !this.control.destroyed) { socket.destroy(); return; }
      this.control = socket; this.lastPong = Date.now();
      readFrames(socket, (frame) => { if (frame.type === "pong") this.lastPong = Date.now(); else if (frame.type === "ping") sendFrame(socket, { type: "pong" }); else socket.destroy(); });
      socket.once("close", () => { if (this.control !== socket) return; this.control = undefined; for (const p of this.pending.values()) { clearTimeout(p.timer); p.socket.destroy(); } this.pending.clear(); });
      sendFrame(socket, { type: "ready" }); return;
    }
    if (socket.alpnProtocol !== DATA_ALPN || !this.control) { socket.destroy(); return; }
    socket.setTimeout(10_000, () => socket.destroy()); let buffer = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]); const end = buffer.indexOf(10);
      if (end < 0) { if (buffer.length > 1024) socket.destroy(); return; }
      if (end > 1024) { socket.destroy(); return; }
      try {
        const hello = dataHelloSchema.parse(JSON.parse(buffer.subarray(0, end).toString("utf8"))); const p = this.pending.get(hello.id);
        if (!p || !timingSafeEqual(Buffer.from(hello.token), Buffer.from(p.token))) { socket.destroy(); return; }
        clearTimeout(p.timer); this.pending.delete(hello.id); socket.off("data", receive);
        socket.setTimeout(600_000, () => socket.destroy()); p.socket.setTimeout(600_000, () => p.socket.destroy());
        coupleSockets(socket, p.socket);
        if (buffer.length > end + 1) p.socket.write(buffer.subarray(end + 1));
        socket.write(p.hello); p.socket.pipe(socket); socket.pipe(p.socket); p.socket.resume();
      } catch { socket.destroy(); }
    };
    socket.on("data", receive);
  }
  get status(): { connected: boolean; pending: number; connections: number; publicPort: number; tunnelPort: number; healthPort?: number } {
    const port = (server: TcpServer) => { const addr = server.address(); return addr && typeof addr !== "string" ? addr.port : 0; };
    return { connected: !!this.control && !this.control.destroyed, pending: this.pending.size, connections: this.sockets.size, publicPort: port(this.publicServer), tunnelPort: port(this.tunnelServer), ...(this.healthServer ? { healthPort: port(this.healthServer) } : {}) };
  }
  async close(): Promise<void> { if (this.timer) clearInterval(this.timer); for (const p of this.pending.values()) clearTimeout(p.timer); this.pending.clear(); for (const socket of this.sockets) socket.destroy(); this.control?.destroy(); this.healthServer?.closeAllConnections(); await Promise.all([this.publicServer, this.tunnelServer, this.healthServer].map((server) => new Promise<void>((resolve) => { if (!server?.listening) resolve(); else server.close(() => resolve()); }))); }
}
