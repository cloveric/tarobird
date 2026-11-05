import type { Route } from "../../src/client-protocol/routes.js";

export function connectionTiming(route: Route, native: boolean) {
  const host = new URL(route.url).hostname;
  // The local desktop Hub can fail over quickly. A phone/VPS path needs room
  // for cellular jitter, TLS and native IPC; 1.1 seconds is not a failure there.
  const local = !native && route.name === "Direct" && ["localhost", "127.0.0.1", "[::1]"].includes(host);
  return local ? { heartbeatMs: 350, staleMs: 1100, probeMs: 650, handshakeMs: 1800 }
    : { heartbeatMs: 3000, staleMs: 15_000, probeMs: 6000, handshakeMs: 7000 };
}
