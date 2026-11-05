import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { SCREEN_MAX_CONTROL_BYTES, screenHelloSchema, screenServiceHelloSchema, screenServiceEventSchema } from "../client-protocol/remote-screen.js";
import { readScreenFrame, SCREEN_PACKET_LIMIT } from "../client-protocol/screen-wire.js";
import { HubRemoteScreen, type ScreenControlSink, type ScreenMediaSink } from "./remote-screen.js";
import { HubError } from "./store.js";
import { watchScreenSocket } from "../core/screen-heartbeat.js";

const routes = new Set(["/screen/v1/target", "/screen/v1/target-media", "/screen/v1/control", "/screen/v1/media"]);
// The authority has already released the lease and notified the viewer for
// these refusals. A stale input must not destroy the still-authorized video.
const controlRefusals = new Set(["screen_frame_stale", "screen_lease_expired", "screen_renew_expired", "screen_input_stale", "screen_control_not_authorized", "screen_accessibility_denied"]);
const dataBytes = (raw: RawData) => Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
/** Independent bounded transports; no frame goes through chat WS or DB queues. */
export class RemoteScreenSockets {
  private media = new WebSocketServer({ noServer: true, maxPayload: SCREEN_PACKET_LIMIT, perMessageDeflate: false });
  private control = new WebSocketServer({ noServer: true, maxPayload: SCREEN_MAX_CONTROL_BYTES, perMessageDeflate: false });
  private connections = new Set<WebSocket>();
  private targetConnections = new Set<WebSocket>();
  private sessionSockets = new Map<string, Set<WebSocket>>();
  private totalBudget = 2 * SCREEN_PACKET_LIMIT;
  private budgetAt = Date.now();
  constructor(private authority: HubRemoteScreen) {}
  handles(route: string): boolean { return routes.has(route); }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, instance: boolean): void {
    const route = req.url!;
    // Instance listener is separate plain loopback; TLS relay peers also arrive
    // on loopback and must never be able to register a target service.
    const target = route.startsWith("/screen/v1/target");
    // Unauthenticated remote viewers must not exhaust the local service's
    // registration/media slots. Both pools stay bounded; target routes still
    // require the instance listener and their one-use owner/service tickets.
    if (!routes.has(route) || target && (!instance || this.targetConnections.size >= 4)
      || !target && this.connections.size - this.targetConnections.size >= 16) { socket.destroy(); return; }
    (route.endsWith("media") ? this.media : this.control).handleUpgrade(req, socket, head, ws => this.accept(ws, route));
  }
  private closeGroup(sessionId: string, reason: string): void {
    const group = this.sessionSockets.get(sessionId); this.sessionSockets.delete(sessionId);
    for (const ws of group ?? []) { if (ws.readyState === WebSocket.OPEN) ws.close(4000, reason.slice(0,100)); else ws.terminate(); }
  }
  private accept(ws: WebSocket, route: string): void {
    this.connections.add(ws);
    if (route.startsWith("/screen/v1/target")) this.targetConnections.add(ws);
    let ready = false, authenticating = false, epoch = "", sessionId = "", generation = "", localBudget = SCREEN_PACKET_LIMIT, localAt = Date.now();
    const stop = (reason = "screen_channel_closed") => { if (sessionId) { this.authority.closeSession(sessionId, reason); this.closeGroup(sessionId, reason); } else if (epoch) this.authority.serviceLost(epoch, reason); };
    watchScreenSocket(ws, () => { stop("screen_network_timeout"); ws.terminate(); });
    const timer = setTimeout(() => ws.terminate(), 3000); timer.unref();
    const send = (value: unknown, binary = false): boolean => {
      const payload = binary ? value as Uint8Array : JSON.stringify(value);
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + (typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength) > (route.endsWith("media") ? SCREEN_PACKET_LIMIT : SCREEN_MAX_CONTROL_BYTES)) return false;
      try { ws.send(payload, { binary }, error => { if (error) ws.terminate(); }); return true; } catch { ws.terminate(); return false; }
    };
    const close = (reason: string) => { if (sessionId) this.closeGroup(sessionId, reason); else ws.close(4000, reason.slice(0,100)); };
    const controlSink: ScreenControlSink = { send: value => send(value), close };
    const mediaSink: ScreenMediaSink = { send: bytes => send(bytes, true), configure: value => send(value), close };
    ws.on("error", () => ws.terminate());
    ws.once("close", () => { clearTimeout(timer); this.connections.delete(ws); this.targetConnections.delete(ws); this.sessionSockets.get(sessionId)?.delete(ws); stop(); });
    ws.on("message", (raw, binary) => {
      if (authenticating) { ws.terminate(); return; }
      const work = async () => {
        const bytes = dataBytes(raw);
        if (!ready) {
          if (binary || bytes.byteLength > SCREEN_MAX_CONTROL_BYTES) throw new HubError("screen_hello_invalid", 400);
          const data: unknown = JSON.parse(bytes.toString("utf8")); authenticating = true;
          if (route === "/screen/v1/target") {
            const hello = screenServiceHelloSchema.parse(data), registered = this.authority.registerService(hello.ticket, hello.desktop, controlSink, hello.features); epoch = registered.epoch;
            send({ type: "registered", epoch, serverTime: Date.now() });
          } else {
            const hello = screenHelloSchema.parse(data);
            if (route === "/screen/v1/target-media") ({ epoch, sessionId, generation } = this.authority.serviceMedia(hello.ticket));
            else sessionId = await this.authority.attachViewer(hello.ticket, route.endsWith("media") ? "media" : "control", route.endsWith("media") ? mediaSink : controlSink);
            const group = this.sessionSockets.get(sessionId) ?? new Set<WebSocket>(); group.add(ws); this.sessionSockets.set(sessionId, group);
            if (ws.readyState !== WebSocket.OPEN) { stop(); return; }
            send({ type: "attached", sessionId });
          }
          ready = true; authenticating = false; clearTimeout(timer); return;
        }
        if (binary) {
          if (route !== "/screen/v1/target-media") throw new HubError("screen_binary_direction", 400);
          const now = Date.now();
          localBudget = Math.min(SCREEN_PACKET_LIMIT, localBudget + Math.max(0, now - localAt) * 500); localAt = now;
          this.totalBudget = Math.min(2 * SCREEN_PACKET_LIMIT, this.totalBudget + Math.max(0, now - this.budgetAt) * 1000); this.budgetAt = now;
          localBudget -= bytes.byteLength; this.totalBudget -= bytes.byteLength;
          if (localBudget < 0 || this.totalBudget < 0) throw new HubError("screen_bandwidth_exceeded", 429);
          if (!this.authority.frame(epoch, sessionId, generation, readScreenFrame(bytes), bytes)) throw new HubError("screen_frame_rejected", 409);
          return;
        }
        if (bytes.byteLength > SCREEN_MAX_CONTROL_BYTES) throw new HubError("screen_control_size", 400);
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (route === "/screen/v1/target-media") {
          if (!this.authority.stream(epoch, sessionId, generation, value)) throw new HubError("screen_stream_rejected", 409);
        } else if (route === "/screen/v1/target") {
          const event = screenServiceEventSchema.parse(value);
          if (event.type === "status") this.authority.serviceStatus(epoch, event.desktop);
          else if (event.type === "lease-ready") this.authority.serviceLeaseReady(epoch, event.sessionId, event.leaseId);
          else if (event.type === "lease-denied") this.authority.serviceLeaseDenied(epoch, event.sessionId, event.leaseId, event.reason);
          else if (event.type === "frame-confirmed") this.authority.serviceFrameConfirmed(epoch, event.sessionId, event.frameSequence, event.captureMs, event.streamGeneration);
          else this.authority.serviceStop(epoch, event.sessionId, event.reason);
        } else if (route === "/screen/v1/control") this.authority.viewerCommand(sessionId, value);
        else throw new HubError("screen_media_direction", 400);
      };
      void work().catch(error => {
        if (ready && route === "/screen/v1/control" && error instanceof HubError && controlRefusals.has(error.code)) return;
        const reason = error instanceof HubError ? error.code : "screen_protocol_invalid";
        stop(reason); if (ws.readyState === WebSocket.OPEN) ws.close(4000, reason); else ws.terminate();
      });
    });
  }
  dispose(): void { for (const ws of this.connections) ws.terminate(); this.connections.clear(); this.sessionSockets.clear(); this.media.close(); this.control.close(); }
}
