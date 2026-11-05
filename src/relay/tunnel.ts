import { connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { isLoopback } from "../hub/network.js";
import { CONTROL_ALPN, SOURCE_CONTROL_ALPN, DATA_ALPN, readFrames, sendFrame } from "./protocol.js";
import { coupleSockets } from "./socket-lifecycle.js";

export interface RelayTunnelOptions {
  host: string; port: number; servername: string; tls: Pick<ConnectionOptions, "ca" | "cert" | "key">;
  targetHost: string; targetPort: number; onStatus?: (online: boolean) => void; onWarning?: (code: string) => void;
  onSource?: (socket: Socket, source?: string) => void;
}
export class RelayTunnel {
  private control?: TLSSocket;
  private sockets = new Set<Socket>();
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = true;
  private attempt = 0;
  private connected = false;
  private lastPong = 0;
  constructor(readonly options: RelayTunnelOptions) {
    if (!isLoopback(options.targetHost)) throw new Error("relay_target_must_be_loopback");
    if (!options.servername || !options.tls.ca || !options.tls.cert || !options.tls.key) throw new Error("mutual_tls_configuration_required");
  }
  get online(): boolean { return this.connected; }
  start(): void { if (!this.stopped) return; this.stopped = false; this.connect(); }
  private setStatus(online: boolean): void { if (this.connected === online) return; this.connected = online; this.options.onStatus?.(online); }
  private socket(protocol: string | string[]): TLSSocket {
    const socket = tlsConnect({ ...this.options.tls, host: this.options.host, port: this.options.port, servername: this.options.servername, minVersion: "TLSv1.3", rejectUnauthorized: true, ALPNProtocols: typeof protocol === "string" ? [protocol] : protocol });
    this.sockets.add(socket); socket.setTimeout(15_000, () => socket.destroy());
    socket.on("error", () => this.options.onWarning?.("relay_connection_failed")); socket.once("close", () => this.sockets.delete(socket)); return socket;
  }
  private connect(): void {
    if (this.stopped) return;
    const socket = this.socket([SOURCE_CONTROL_ALPN, CONTROL_ALPN]); this.control = socket;
    socket.once("secureConnect", () => {
      if (socket.alpnProtocol !== SOURCE_CONTROL_ALPN && socket.alpnProtocol !== CONTROL_ALPN) socket.destroy();
      else if (socket.alpnProtocol === CONTROL_ALPN) this.options.onWarning?.("relay_source_unavailable_upgrade_relay");
    });
    readFrames(socket, (frame) => {
      if (frame.type === "ready") { this.attempt = 0; this.lastPong = Date.now(); this.setStatus(true); socket.setTimeout(0); }
      else if (frame.type === "ping") { this.lastPong = Date.now(); sendFrame(socket, { type: "pong" }); }
      else if (frame.type === "pong") this.lastPong = Date.now();
      else if (frame.type === "open" && this.connected) {
        if (socket.alpnProtocol === SOURCE_CONTROL_ALPN && frame.source === undefined) { socket.destroy(); return; }
        this.openData(frame.id, frame.token, socket.alpnProtocol === SOURCE_CONTROL_ALPN ? frame.source : undefined);
      }
      else socket.destroy();
    });
    this.heartbeat = setInterval(() => { if (Date.now() - this.lastPong > 45_000) socket.destroy(); else sendFrame(socket, { type: "ping" }); }, 15_000); this.heartbeat.unref();
    socket.once("close", () => {
      if (this.control !== socket) return;
      if (this.heartbeat) clearInterval(this.heartbeat); this.setStatus(false);
      for (const connection of this.sockets) connection.destroy();
      if (!this.stopped) { this.timer = setTimeout(() => this.connect(), Math.min(15_000, 250 * 2 ** Math.min(this.attempt++, 6))); this.timer.unref(); }
    });
  }
  private openData(id: string, token: string, source?: string): void {
    if (this.sockets.size >= 256) return;
    const remote = this.socket(DATA_ALPN);
    remote.once("secureConnect", () => {
      if (remote.alpnProtocol !== DATA_ALPN || this.stopped) { remote.destroy(); return; }
      const local = tcpConnect({ host: this.options.targetHost, port: this.options.targetPort }); this.sockets.add(local);
      coupleSockets(local, remote);
      local.on("error", () => remote.destroy()); local.once("close", () => this.sockets.delete(local));
      local.setTimeout(10_000, () => local.destroy());
      local.once("connect", () => {
        try { this.options.onSource?.(local, source); }
        catch { local.destroy(); remote.destroy(); this.options.onWarning?.("relay_source_registration_failed"); return; }
        local.setTimeout(600_000); remote.setTimeout(600_000); remote.write(JSON.stringify({ id, token }) + "\n"); local.pipe(remote); remote.pipe(local);
      });
    });
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.heartbeat) clearInterval(this.heartbeat); for (const socket of this.sockets) socket.destroy(); this.setStatus(false); }
}
