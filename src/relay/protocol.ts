import type { TLSSocket } from "node:tls";
import { z } from "zod";
import { sourceAddress } from "./sources.js";

export const CONTROL_ALPN = "tarocub-relay-control-v1";
export const SOURCE_CONTROL_ALPN = "tarocub-relay-control-v2";
export const DATA_ALPN = "tarocub-relay-data-v1";
export const relayFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
  z.object({ type: z.literal("pong") }).strict(),
  z.object({ type: z.literal("open"), id: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), source: z.string().max(45).refine((value) => { try { sourceAddress(value); return true; } catch { return false; } }).optional() }).strict(),
]);
export const dataHelloSchema = z.object({ id: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type RelayFrame = z.infer<typeof relayFrameSchema>;
export function sendFrame(socket: TLSSocket, frame: RelayFrame): void { if (!socket.destroyed) socket.write(JSON.stringify(frame) + "\n"); }
export function readFrames(socket: TLSSocket, receive: (frame: RelayFrame) => void): void {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) { if (buffer.length > 8192) socket.destroy(); break; }
      if (end > 8192) { socket.destroy(); return; }
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { receive(relayFrameSchema.parse(JSON.parse(line))); } catch { socket.destroy(); return; }
    }
  });
}
// Inspect only ClientHello SNI. All bytes, including this hello, are forwarded
// unchanged; the relay has neither the Hub certificate key nor TLS plaintext.
// A completed hello without SNI returns "" only for a dedicated IP endpoint.
// undefined always means more bytes are required, never a routing decision.
/** Incremental, bounded ClientHello reader. Each TLS record is copied once,
 * even when a peer sends the header one byte at a time. */
export class ClientHelloReader {
  private readonly wire = Buffer.allocUnsafe(40_000);
  private readonly hello = Buffer.allocUnsafe(32_772);
  private wireLength = 0;
  private offset = 0;
  private helloLength = 0;
  private expectedLength?: number;
  private name?: string;

  constructor(private readonly allowNoServerName = false) {}

  push(chunk: Buffer): string | undefined {
    if (this.wireLength + chunk.length > this.wire.length) throw new Error("tls_hello_too_large");
    chunk.copy(this.wire, this.wireLength); this.wireLength += chunk.length;
    if (this.name !== undefined) return this.name;
    while (this.offset + 5 <= this.wireLength) {
      if (this.wire[this.offset] !== 22) throw new Error("tls_client_hello_required");
      const size = this.wire.readUInt16BE(this.offset + 3);
      // Handshake records must not be empty (RFC 8446 5.1).
      if (size === 0) throw new Error("empty_tls_handshake_record");
      if (size > 18_432) throw new Error("tls_record_too_large");
      if (this.offset + 5 + size > this.wireLength) return;
      // A record can also contain later handshake messages. Keep only the
      // first ClientHello, while forwarding every original wire byte intact.
      const payload = this.wire.subarray(this.offset + 5, this.offset + 5 + size);
      let consumed = 0;
      if (this.helloLength < 4) {
        consumed = Math.min(4 - this.helloLength, payload.length);
        payload.copy(this.hello, this.helloLength, 0, consumed); this.helloLength += consumed;
        if (this.helloLength === 4) {
          if (this.hello[0] !== 1) throw new Error("tls_client_hello_required");
          this.expectedLength = this.hello.readUIntBE(1, 3) + 4;
          if (this.expectedLength > this.hello.length) throw new Error("tls_hello_too_large");
        }
      }
      if (this.expectedLength !== undefined) {
        const count = Math.min(this.expectedLength - this.helloLength, payload.length - consumed);
        payload.copy(this.hello, this.helloLength, consumed, consumed + count); this.helloLength += count;
      }
      this.offset += 5 + size;
      if (this.expectedLength !== undefined && this.helloLength === this.expectedLength) {
        this.name = parseHelloName(this.hello.subarray(0, this.helloLength), this.allowNoServerName);
        return this.name;
      }
    }
    return undefined;
  }

  /** Includes TLS bytes coalesced after ClientHello in the same TCP chunk. */
  bytes(): Buffer { return this.wire.subarray(0, this.wireLength); }
}

export function clientHelloName(wire: Buffer, allowNoServerName = false): string | undefined {
  return new ClientHelloReader(allowNoServerName).push(wire);
}

function parseHelloName(hello: Buffer, allowNoServerName: boolean): string {
  const body = hello.subarray(4); let i = 34;
  const need = (n: number) => { if (i + n > body.length) throw new Error("invalid_client_hello"); };
  need(1); const session = body[i++]!; need(session); i += session;
  need(2); const ciphers = body.readUInt16BE(i); i += 2; need(ciphers); i += ciphers;
  need(1); const compression = body[i++]!; need(compression); i += compression;
  if (i === body.length && allowNoServerName) return "";
  need(2); const extensions = body.readUInt16BE(i); i += 2; need(extensions); const end = i + extensions;
  while (i + 4 <= end) {
    const type = body.readUInt16BE(i); const size = body.readUInt16BE(i + 2); i += 4;
    if (i + size > end) throw new Error("invalid_tls_extension");
    if (type === 0) {
      if (size < 5 || body.readUInt16BE(i) !== size - 2) throw new Error("invalid_server_name");
      let j = i + 2;
      while (j + 3 <= i + size) { const kind = body[j++]!; const n = body.readUInt16BE(j); j += 2; if (j + n > i + size) throw new Error("invalid_server_name"); if (kind === 0) { const name = body.subarray(j, j + n).toString("ascii").toLowerCase(); if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name)) throw new Error("invalid_server_name"); return name; } j += n; }
      throw new Error("server_name_required");
    }
    i += size;
  }
  if (i !== end || end !== body.length) throw new Error("invalid_tls_extension");
  if (allowNoServerName) return "";
  throw new Error("server_name_required");
}
