import { expect, test } from "vitest";
import { ClientHelloReader, clientHelloName } from "../src/relay/protocol.js";

function record(payload: Buffer): Buffer {
  const header = Buffer.from([22, 3, 3, 0, 0]); header.writeUInt16BE(payload.length, 3);
  return Buffer.concat([header, payload]);
}
function hello(name?: string, padding = 0): Buffer {
  const extensions: Buffer[] = [];
  if (name !== undefined) {
    const value = Buffer.from(name), prefix = Buffer.alloc(9);
    prefix.writeUInt16BE(5 + value.length, 2); prefix.writeUInt16BE(3 + value.length, 4); prefix.writeUInt16BE(value.length, 7);
    extensions.push(prefix, value);
  }
  if (padding) { const h = Buffer.alloc(4); h.writeUInt16BE(21); h.writeUInt16BE(padding, 2); extensions.push(h, Buffer.alloc(padding)); }
  const ext = Buffer.concat(extensions), body = Buffer.alloc(43);
  body.writeUInt16BE(0x303); body.writeUInt16BE(2, 35); body.writeUInt16BE(0x1301, 37); body[39] = 1; body.writeUInt16BE(ext.length, 41);
  const header = Buffer.from([1, 0, 0, 0]); header.writeUIntBE(body.length + ext.length, 1, 3);
  return Buffer.concat([header, body, ext]);
}

test("rejects zero-length handshake records before trying to accumulate them", () => {
  const reader = new ClientHelloReader();
  expect(() => reader.push(Buffer.alloc(40_000).fill(record(Buffer.alloc(0))))).toThrow("empty_tls_handshake_record");
});
test("accepts fragmented records and bytewise TCP delivery while preserving the exact wire", () => {
  const payload = hello("hub.test", 4000);
  const wire = Buffer.concat(Array.from(payload, b => record(Buffer.from([b]))));
  const reader = new ClientHelloReader(); let result: string | undefined;
  for (let i = 0; i < wire.length; i++) {
    result = reader.push(wire.subarray(i, i + 1));
    if (i < wire.length - 1) expect(result).toBeUndefined();
  }
  expect(result).toBe("hub.test"); expect(reader.bytes()).toEqual(wire);
});
test("does not discard TLS bytes coalesced after the ClientHello", () => {
  const wire = Buffer.concat([record(hello("HUB.test")), Buffer.from([20, 3, 3, 0, 1, 1])]);
  const reader = new ClientHelloReader(); expect(reader.push(wire)).toBe("hub.test"); expect(reader.bytes()).toEqual(wire);
});
test("keeps no-SNI routing exclusive to explicitly configured IP endpoints", () => {
  const wire = record(hello());
  expect(clientHelloName(wire, true)).toBe(""); expect(() => clientHelloName(wire)).toThrow("server_name_required");
});
test("rejects oversized and wrong-type records and total input bounds", () => {
  expect(() => clientHelloName(Buffer.from([22, 3, 3, 255, 255]))).toThrow("tls_record_too_large");
  expect(() => clientHelloName(Buffer.from([23, 3, 3, 0, 1, 1]))).toThrow("tls_client_hello_required");
  expect(() => clientHelloName(record(Buffer.from([1, 1, 0, 0])))).toThrow("tls_hello_too_large");
  expect(() => clientHelloName(Buffer.alloc(40_001))).toThrow("tls_hello_too_large");
});
