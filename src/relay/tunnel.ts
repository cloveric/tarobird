import { randomBytes, randomUUID } from "node:crypto";
import { connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { isLoopback } from "../hub/network.js";
import { CONTROL_ALPN, SOURCE_CONTROL_ALPN, SCREEN_UDP_CONTROL_ALPN, DATA_ALPN, hasRelaySource, readFrames, sendFrame } from "./protocol.js";
import { coupleSockets } from "./socket-lifecycle.js";

import type { ScreenRelayPeer } from "./screen-udp.js";

export type ScreenUdpLease = { address: string; port: number; sender: ScreenRelayPeer; viewer: ScreenRelayPeer; close: () => void };

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
  private udpEndpoint?: { address: string; port: number };
  private udpRequests = new Map<string, (accepted: boolean) => void>();
  private udpLeases = new Set<() => void>();
  constructor(readonly options: RelayTunnelOptions) {
    if (!isLoopback(options.targetHost)) throw new Error("relay_target_must_be_loopback");
    if (!options.servername || !options.tls.ca || !options.tls.cert || !options.tls.key) throw new Error("mutual_tls_configuration_required");
  }
  get screenUdpEndpoint() { return this.udpEndpoint; }
  async screenUdpLease(): Promise<ScreenUdpLease | undefined> {
    const socket = this.control, endpoint = this.udpEndpoint;
    if (!socket || socket.destroyed || !endpoint || this.udpRequests.size + this.udpLeases.size >= 4) return;
    const generate = () => ({ username: randomBytes(18).toString("base64url"), credential: randomBytes(24).toString("base64url") });
    const id = randomUUID(), sender = generate(), viewer = generate();
    const accepted = await new Promise<boolean>(resolve => {
      const finish = (value: boolean) => { clearTimeout(timer); this.udpRequests.delete(id); resolve(value); };
      const timer = setTimeout(() => finish(false), 2000);
      timer.unref();
      this.udpRequests.set(id, finish);
      sendFrame(socket, { type: "screen-udp-allocate", id, sender, viewer });
    });
    if (!accepted || this.control !== socket || socket.destroyed) {
      if (!socket.destroyed) sendFrame(socket, { type: "screen-udp-release", id });
      return;
    }
    const keep = setInterval(() => sendFrame(socket, { type: "screen-udp-keep", id }), 25_000);
    keep.unref();
    const close = () => {
      if (!this.udpLeases.delete(close)) return;
      clearInterval(keep);
      sendFrame(socket, { type: "screen-udp-release", id });
    };
    this.udpLeases.add(close);
    return { ...endpoint, sender, viewer, close };
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
    const socket = this.socket([SCREEN_UDP_CONTROL_ALPN, SOURCE_CONTROL_ALPN, CONTROL_ALPN]); this.control = socket;
    socket.once("secureConnect", () => {
      if (!hasRelaySource(socket.alpnProtocol) && socket.alpnProtocol !== CONTROL_ALPN) socket.destroy();
      else if (socket.alpnProtocol === CONTROL_ALPN) this.options.onWarning?.("relay_source_unavailable_upgrade_relay");
    });
    readFrames(socket, (frame) => {
      if (frame.type === "ready") { this.attempt = 0; this.lastPong = Date.now(); this.setStatus(true); socket.setTimeout(0); }
      else if (frame.type === "ping") { this.lastPong = Date.now(); sendFrame(socket, { type: "pong" }); }
      else if (frame.type === "pong") this.lastPong = Date.now();
      else if (frame.type === "screen-udp-ready" && this.connected && socket.alpnProtocol === SCREEN_UDP_CONTROL_ALPN) {
        // A TCP port mapping can expose a different external port. Its
        // control/data path is valid even when this UDP endpoint is unusable.
        this.udpEndpoint = frame.port === this.options.port ? { address: frame.address, port: frame.port } : undefined;
      }
      else if (frame.type === "screen-udp-reply" && socket.alpnProtocol === SCREEN_UDP_CONTROL_ALPN) this.udpRequests.get(frame.id)?.(frame.accepted);
      else if (frame.type === "open" && this.connected) {
        if (hasRelaySource(socket.alpnProtocol) && frame.source === undefined) { socket.destroy(); return; }
        this.openData(frame.id, frame.token, hasRelaySource(socket.alpnProtocol) ? frame.source : undefined);
      }
      else socket.destroy();
    });
    this.heartbeat = setInterval(() => { if (Date.now() - this.lastPong > 45_000) socket.destroy(); else sendFrame(socket, { type: "ping" }); }, 15_000); this.heartbeat.unref();
    socket.once("close", () => {
      if (this.control !== socket) return;
      this.udpEndpoint = undefined;
      for (const finish of this.udpRequests.values()) finish(false);
      for (const close of this.udpLeases) close();
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
