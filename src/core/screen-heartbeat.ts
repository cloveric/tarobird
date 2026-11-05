import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";

/** Transport liveness only: a pong never renews control or confirms a frame. */
export const SCREEN_PING_INTERVAL_MS = 5000;
export function watchScreenSocket(ws: WebSocket, timeout: () => void): () => void {
  let pending: Buffer | undefined, missed = 0, stopped = false;
  const pong = (bytes: Buffer) => {
    if (pending?.equals(bytes)) { pending = undefined; missed = 0; }
  };
  const cleanup = () => {
    if (stopped) return;
    stopped = true; clearInterval(timer); ws.off("pong", pong); ws.off("close", cleanup);
  };
  const fail = () => { if (stopped) return; cleanup(); timeout(); };
  // Two intervals without the matching pong allow ten seconds for a response.
  // Count ticks instead of wall time so a local clock adjustment cannot expire it.
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) { cleanup(); return; }
    if (pending) { if (++missed >= 2) fail(); return; }
    pending = randomBytes(8);
    try { ws.ping(pending, undefined, error => { if (error) fail(); }); }
    catch { fail(); }
  }, SCREEN_PING_INTERVAL_MS);
  timer.unref(); ws.on("pong", pong); ws.once("close", cleanup);
  return cleanup;
}
