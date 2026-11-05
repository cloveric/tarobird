import { isIP, type Socket } from "node:net";
import { isLoopback } from "../hub/network.js";

/** Canonicalize rate-limit keys; never use these addresses for authorization. */
export function sourceAddress(value: string): string {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6 || value.includes("%")) throw new Error("invalid_relay_source");
  const address = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mapped) { const a = parseInt(mapped[1]!, 16), b = parseInt(mapped[2]!, 16); return [a >> 8, a & 255, b >> 8, b & 255].join("."); }
  return address;
}
const tuple = (a: string, ap: number, b: string, bp: number) => JSON.stringify([sourceAddress(a), ap, sourceAddress(b), bp]);

/** Host-process side channel for the exact TCP connection carrying opaque TLS.
 * Registration is local code only, after the relay's authenticated control frame
 * and before forwarding ClientHello. No HTTP header can create an entry. */
export class RelaySources {
  private entries = new Map<string, { socket: Socket; source: string }>();
  register(socket: Socket, relayId: string, peer?: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(relayId) || !socket.localAddress || !socket.localPort || !socket.remoteAddress || !socket.remotePort
      || !isLoopback(socket.localAddress) || !isLoopback(socket.remoteAddress) || socket.destroyed) throw new Error("invalid_relay_connection");
    const key = tuple(socket.remoteAddress, socket.remotePort, socket.localAddress, socket.localPort);
    if (this.entries.has(key) || this.entries.size >= 2048) throw new Error("relay_source_capacity");
    const entry = { socket, source: `relay:${relayId}:${peer === undefined ? "legacy" : sourceAddress(peer)}` };
    this.entries.set(key, entry);
    socket.once("close", () => { if (this.entries.get(key) === entry) this.entries.delete(key); });
  }
  source(socket: Socket): string {
    if (socket.localAddress && socket.localPort && socket.remoteAddress && socket.remotePort) {
      const entry = this.entries.get(tuple(socket.localAddress, socket.localPort, socket.remoteAddress, socket.remotePort));
      if (entry && !entry.socket.destroyed) return entry.source;
    }
    try { return sourceAddress(socket.remoteAddress ?? ""); } catch { return "unknown"; }
  }
}
