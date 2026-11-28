import { screenStreamSchema, screenViewerCommandSchema, screenViewerEventSchema, type ScreenJoin } from "../../src/client-protocol/remote-screen.js";
import { readScreenFrame, SCREEN_PACKET_LIMIT } from "../../src/client-protocol/screen-wire.js";
import type { ScreenViewerPort, ScreenViewerTransport } from "./screen-viewer-transport.js";

export type ScreenAllocation = { id: string; document: string; signal: AbortSignal };
export type ScreenNativeBridge = {
  allocate(): Promise<ScreenAllocation>;
  /** The most packets of one stream generation native holds for the page. Absent or undefined: three. */
  window?(): Promise<number | undefined>;
  invoke<T = unknown>(command: string, args: Record<string, unknown>): Promise<T>;
};
export const SCREEN_BRIDGE_CHUNK_BYTES = 256 * 1024;
/** Native ends a session by queuing its close event, then retiring the slot. A
 * page call running at that moment is rejected with one of these codes, and the
 * rejection reaches the page before that close event. The code only says the
 * call lost to the end; the close event says why. Wait for it, bounded: without
 * it, the session ended locally and says no more than that. */
const NATIVE_SESSION_ENDED: ReadonlyMap<string, string> = new Map([
  ["native_request_cancelled", "screen_disconnected"], ["native_document_retired", "screen_disconnected"], ["screen_inactive", "screen_inactive"],
]);
export const SCREEN_NATIVE_CLOSE_GRACE_MS = 1000;
/** Native refuses a renew or input that reaches it after it has seen control end:
 * the state that ended control is already queued for this page. Nothing was sent
 * and the viewing session goes on. */
const CONTROL_ENDED = "screen_control_ended";
const CONTROL_BYTES = 16 * 1024, JSON_BYTES = 64 * 1024;
/** Native's packet bound: the target's flight window per stream generation (three,
 * or what native reports); packets of a superseded generation still being read
 * count only in the total, twice the window. Pending commands and JSON deliveries
 * are bounded five beyond the window: a receipt and a frame-ready per frame, plus
 * input and state (eight, as always, at three). */
const BINARY_WINDOW = 3, PENDING_SLACK = 5;
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Bounded, document-owned adapter. It never opens a WebView socket, obtains a
 * new document claim, reconnects, or retains input for a replacement session. */
export function createMobileScreenViewerTransport(bridge: ScreenNativeBridge): ScreenViewerTransport {
  return (join: ScreenJoin) => {
    let allocation: ScreenAllocation | undefined, closed = false, opening = false, focused = false, focusGeneration = 0;
    let receive: ((value: unknown) => void) | undefined, terminal: string | undefined, ending: ReturnType<typeof setTimeout> | undefined, settled: (() => void) | undefined;
    let sequence = 0, jsonCount = 0, jsonBytes = 0, binaryCount = 0, binaryBytes = 0, commands = 0, commandBytes = 0;
    // Stream configs counted as they arrive: native delivers each before its generation's packets.
    let streams = 0, streamBinaries = 0, capacity = BINARY_WINDOW;
    let incoming = Promise.resolve(), outgoing = Promise.resolve();
    const receipts = new Map<number, { deliverySequence: number; bytes: number; stream: number }>();
    const close = (reason?: string) => {
      if (closed) return;
      closed = true; focused = false; receipts.clear(); clearTimeout(ending); settled?.();
      allocation?.signal.removeEventListener("abort", retired);
      if (allocation) void bridge.invoke("net_screen_close", { id: allocation.id }).catch(() => undefined);
      if (reason) { terminal = reason; receive?.({ type: "closed", reason }); }
    };
    const retired = () => close("screen_connection_changed");
    const fail = (error: unknown) => {
      const reason = error instanceof Error && error.name !== "ZodError" ? error.message : "screen_protocol_invalid";
      const local = NATIVE_SESSION_ENDED.get(reason);
      if (!local) { close(reason); return; }
      if (!closed && ending === undefined) ending = setTimeout(() => close(local), SCREEN_NATIVE_CLOSE_GRACE_MS);
    };
    // Once native has said the session ended, nothing more is sent for it.
    const live = () => !closed && ending === undefined && !!allocation;
    const ack = async (deliverySequence: number) => {
      if (live()) await bridge.invoke("net_screen_ack", { id: allocation!.id, deliverySequence });
    };
    const port: ScreenViewerPort = {
      start(deliver) { if (receive) return; receive = deliver; if (terminal) deliver({ type: "closed", reason: terminal }); },
      close: () => close(),
      postMessage(message) {
        if (!live()) return;
        try {
          if (message.type === "received") {
            const receipt = receipts.get(message.sequence as number);
            if (!receipt) throw new Error("screen_protocol_invalid");
            receipts.delete(message.sequence as number);
            void ack(receipt.deliverySequence).then(() => { binaryCount--; binaryBytes -= receipt.bytes; if (receipt.stream === streams) streamBinaries--; }, fail);
            return;
          }
          if (message.sessionId !== join.session.id || message.generation !== join.session.generation) throw new Error("screen_session_changed");
          if (message.type === "input-focus") { if (typeof message.enabled !== "boolean") throw new Error("screen_protocol_invalid"); focused = message.enabled; focusGeneration++; }
          // Native consumes focus locally; it never forwards it to either Hub socket.
          const command = message.type === "input-focus" ? { type: "input-focus" as const, sessionId: join.session.id, generation: join.session.generation, enabled: focused } : screenViewerCommandSchema.parse(message);
          if ((command.type === "input" || command.type === "renew") && !focused) return;
          const bytes = size(command);
          const admittedFocus = focusGeneration;
          if (++commands > capacity + PENDING_SLACK || (commandBytes += bytes) > CONTROL_BYTES) throw new Error("screen_congested");
          outgoing = outgoing.then(async () => {
            if ((command.type === "input" || command.type === "renew") && (!focused || admittedFocus !== focusGeneration)) return;
            if (live()) await bridge.invoke("net_screen_send", { id: allocation!.id, command }).catch(error => {
              if ((command.type === "input" || command.type === "renew") && error instanceof Error && error.message === CONTROL_ENDED) return;
              throw error;
            });
          }).catch(fail).finally(() => { commands--; commandBytes -= bytes; });
        } catch (error) { fail(error); }
      },
    };
    const event = (raw: unknown) => {
      if (closed || !allocation || !raw || typeof raw !== "object") return;
      const value = raw as Record<string, unknown>;
      if (value.id !== allocation.id || value.document !== allocation.document) return;
      if (value.kind === "close") { close(typeof value.reason === "string" ? value.reason : "screen_disconnected"); return; }
      if (ending !== undefined) return;
      try {
        const deliverySequence = value.deliverySequence as number;
        if (!Number.isSafeInteger(deliverySequence) || deliverySequence <= sequence) throw new Error("screen_protocol_invalid");
        sequence = deliverySequence;
        if (value.kind === "screen") {
          const bytes = size(value.value);
          if (bytes > CONTROL_BYTES || ++jsonCount > capacity + PENDING_SLACK || (jsonBytes += bytes) > JSON_BYTES) throw new Error("screen_congested");
          const data = (value.value as { type?: unknown })?.type === "stream" ? screenStreamSchema.parse(value.value) : screenViewerEventSchema.parse(value.value);
          if ("sessionId" in data && data.sessionId !== join.session.id || "session" in data && (data.session.id !== join.session.id || data.session.generation !== join.session.generation) || "generation" in data && data.generation !== join.session.generation) throw new Error("screen_session_changed");
          if (data.type === "stream") { streams++; streamBinaries = 0; }
          incoming = incoming.then(async () => {
            if (closed) return;
            if (!receive) throw new Error("screen_protocol_invalid");
            receive(data); await ack(deliverySequence);
          }).catch(fail).finally(() => { jsonCount--; jsonBytes -= bytes; });
        } else if (value.kind === "binary") {
          const bytes = value.byteLength as number;
          if (!Number.isSafeInteger(bytes) || bytes <= 32 || bytes > SCREEN_PACKET_LIMIT) throw new Error("screen_congested");
          if (++streamBinaries > capacity || ++binaryCount > 2 * capacity || (binaryBytes += bytes) > 2 * capacity * SCREEN_PACKET_LIMIT) throw new Error("screen_congested");
          const stream = streams;
          incoming = incoming.then(async () => {
            if (!live()) return;
            const buffer = new Uint8Array(bytes);
            for (let offset = 0; offset < bytes;) {
              const maxBytes = Math.min(SCREEN_BRIDGE_CHUNK_BYTES, bytes - offset);
              const chunk = await bridge.invoke<ArrayBuffer>("net_screen_read", { id: allocation!.id, deliverySequence, offset, maxBytes });
              if (!live()) return;
              if (!(chunk instanceof ArrayBuffer) || !chunk.byteLength || chunk.byteLength > maxBytes) throw new Error("screen_protocol_invalid");
              buffer.set(new Uint8Array(chunk), offset); offset += chunk.byteLength;
            }
            const header = readScreenFrame(buffer);
            if (!receive || receipts.has(header.sequence)) throw new Error("screen_protocol_invalid");
            receipts.set(header.sequence, { deliverySequence, bytes, stream });
            receive(buffer.buffer);
          }).catch(fail);
        } else throw new Error("screen_protocol_invalid");
      } catch (error) { fail(error); }
    };
    return {
      async open(network, events) {
        if (opening || closed) throw new Error("screen_connection_changed"); opening = true;
        try {
          if (bridge.window) capacity = Math.max(BINARY_WINDOW, Math.floor(await bridge.window() ?? BINARY_WINDOW) || BINARY_WINDOW);
          const lease = await bridge.allocate(); allocation = lease;
          if (closed) { void bridge.invoke("net_screen_close", { id: lease.id }).catch(() => undefined); return; }
          if (lease.signal.aborted) { close(); throw new Error("screen_connection_changed"); }
          lease.signal.addEventListener("abort", retired, { once: true });
          events.attach(port);
          const { rtc: _rtc, ...nativeJoin } = join;
          if (!closed) await bridge.invoke("net_screen_open", { id: lease.id, network, join: nativeJoin, events: { onmessage: event } });
        // A session native already ended keeps its own reason over the open call's.
        // Its close event may also still be on the way (Android sends the open
        // call's rejection first): wait for it, bounded, as for any other call.
        } catch (error) {
          if (!closed && allocation && error instanceof Error && NATIVE_SESSION_ENDED.has(error.message)) {
            await new Promise<void>(resolve => { settled = resolve; ending = setTimeout(resolve, SCREEN_NATIVE_CLOSE_GRACE_MS); });
          }
          close(); throw terminal ? new Error(terminal) : error;
        }
      },
      close: () => close(),
    };
  };
}
