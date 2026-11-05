import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, it } from "vitest";
import { RelaySources, sourceAddress } from "../src/relay/sources.js";
import { relayFrameSchema } from "../src/relay/protocol.js";

function upstream(port = 40001) {
  return Object.assign(new EventEmitter(), { localAddress: "127.0.0.1", localPort: port, remoteAddress: "127.0.0.1", remotePort: 9443, destroyed: false }) as Socket;
}
function inbound(port = 40001, target = 9443) {
  return { localAddress: "::ffff:127.0.0.1", localPort: target, remoteAddress: "127.0.0.1", remotePort: port } as Socket;
}
it("binds relay metadata to the exact live local connection and removes it on close", () => {
  const sources = new RelaySources(), socket = upstream();
  sources.register(socket, "primary", "203.0.113.7");
  expect(sources.source(inbound())).toBe("relay:primary:203.0.113.7");
  expect(sources.source(inbound(40002))).toBe("127.0.0.1");
  expect(sources.source(inbound(40001, 9444))).toBe("127.0.0.1");
  expect(() => sources.register(socket, "primary", "198.51.100.9")).toThrow("relay_source_capacity");
  socket.emit("close"); expect(sources.source(inbound())).toBe("127.0.0.1");
  const replacement = upstream(); sources.register(replacement, "backup", "198.51.100.9");
  socket.emit("close"); expect(sources.source(inbound())).toBe("relay:backup:198.51.100.9");
  Object.assign(replacement, { destroyed: true }); expect(sources.source(inbound())).toBe("127.0.0.1");
});
it("bounds metadata and preserves active entries when capacity is reached", () => {
  const sources = new RelaySources(), sockets = Array.from({ length: 2048 }, (_, i) => upstream(40000 + i));
  sockets.forEach(s => sources.register(s, "primary", "203.0.113.7"));
  expect(() => sources.register(upstream(44000), "primary", "203.0.113.9")).toThrow("relay_source_capacity");
  expect(sources.source(inbound(40000))).toBe("relay:primary:203.0.113.7");
  sockets[0]!.emit("close"); sources.register(upstream(44000), "primary", "203.0.113.9");
  expect(sources.source(inbound(44000))).toBe("relay:primary:203.0.113.9");
});
it("separates legacy relay sources from the desktop and normalizes equivalent IP spellings", () => {
  const sources = new RelaySources(); sources.register(upstream(), "legacy");
  expect(sources.source(inbound())).toBe("relay:legacy:legacy");
  expect(sourceAddress("::ffff:cb00:7107")).toBe("203.0.113.7");
  expect(sourceAddress("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
  for (const value of ["unknown", "host.test", "203.0.113.7:443", "127.0.0.1, 203.0.113.7", "fe80::1%lo0"]) expect(() => sourceAddress(value)).toThrow();
  const frame = { type: "open", id: "00000000-0000-4000-8000-000000000001", token: "a".repeat(43) };
  expect(relayFrameSchema.safeParse({ ...frame, source: "203.0.113.7" }).success).toBe(true);
  expect(relayFrameSchema.safeParse({ ...frame, source: "spoof.test" }).success).toBe(false);
  expect(() => sources.register(Object.assign(upstream(40002), { remoteAddress: "203.0.113.7" }), "primary", "203.0.113.7")).toThrow("invalid_relay_connection");
});
