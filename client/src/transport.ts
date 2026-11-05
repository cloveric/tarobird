import { routeTrust } from "./route-trust.js";
import { nativeChannel, nativeInvoke as invoke, usesNativeNetwork } from "./native-network.js";
import { isElectron } from "./desktop-bridge.js";
import { encodeDesktopBytes } from "./desktop-base64.js";

// Native Hub traffic must never fall back to the WebView's unpinned network.
const nativeDocument = usesNativeNetwork();
export const usesPinnedTransport = () => nativeDocument;
const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value));
// The native bridges serialize IOExceptions as ordinary Error/string values.
// Restore only known transient HTTP failures so the existing bounded download
// recovery can resume them. Identity, certificate and lifecycle failures stay
// terminal; this function never retries a request itself.
const httpError = (value: unknown) => {
  const error = asError(value);
  return /^(?:unexpected end of stream(?: on https?:\/\/[^\r\n]*)?|connection reset(?: by peer)?|native_response_idle_timeout)$/i.test(error.message)
    ? new TypeError(error.message, { cause: error }) : error;
};
const abortError = (signal?: AbortSignal | null) => signal?.reason ?? new DOMException("The request was aborted", "AbortError");
const cancel = (id: string) => invoke("net_cancel", { id }).catch(() => undefined);
const BODY_LIMIT = 8 * 1024 * 1024;
let documentLife = new AbortController();
let documentRetired = false;
// Claim during entry-module evaluation, never lazily during a reconnect.
// A new document claim retires every earlier claim on the native side.
let documentLease = nativeDocument ? invoke<string>("net_document") : undefined;
void documentLease?.catch(() => undefined);
window.addEventListener("pagehide", () => { if (usesPinnedTransport()) { documentRetired = true; documentLife.abort(new Error("native_document_retired")); } });
window.addEventListener("pageshow", (event) => { if (nativeDocument && event.persisted) location.reload(); });
async function allocate(kind: "http" | "socket", life = documentLife) {
  if (life.signal.aborted) throw life.signal.reason;
  // One lease per document, including reconnects. Never obtain a new lease to
  // retry a retired page: that would let queued old-page POSTs escape reset.
  if (!documentLease) throw new Error("native_document_unavailable");
  const document = await documentLease;
  if (life.signal.aborted) throw life.signal.reason;
  const id = await invoke<string>("net_allocate", { kind, document });
  if (life.signal.aborted) { await cancel(id); throw life.signal.reason; }
  return id;
}

/** Explicit same-document recovery. Abort queued old operations first, including
 * uploads waiting for a slot. Never replay them after rotating the native lease.
 * React, drafts, file selections and queue edits remain mounted. */
let recovering: Promise<void> | undefined;
export function recoverDesktopTransport(restart: () => Promise<void>): Promise<void> {
  if (recovering) return recovering;
  if (documentRetired) return Promise.reject(new Error("native_document_retired"));
  documentLife.abort(new Error("native_document_retired"));
  const pending = (async () => {
    await restart();
    if (documentRetired) throw new Error("native_document_retired");
    const lease = await invoke<string>("net_document");
    if (documentRetired) throw new Error("native_document_retired");
    documentLease = Promise.resolve(lease);
    documentLife = new AbortController();
    window.dispatchEvent(new Event("online"));
  })();
  recovering = pending;
  void pending.finally(() => { if (recovering === pending) recovering = undefined; }).catch(() => undefined);
  return pending;
}

class RequestQueue {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  get idle() { return this.active === 0 && this.waiters.length === 0; }
  async acquire(signal?: AbortSignal | null): Promise<() => void> {
    if (signal?.aborted) throw abortError(signal);
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiters = this.waiters.filter((v) => v !== start); reject(abortError(signal)); };
      const start = () => {
        signal?.removeEventListener("abort", abort); this.active++; let released = false;
        resolve(() => { if (released) return; released = true; this.active--; this.waiters.shift()?.(); });
      };
      if (this.active < this.limit) start();
      else { this.waiters.push(start); signal?.addEventListener("abort", abort, { once: true }); }
    });
  }
}
const dataQueue = new RequestQueue(12), healthQueue = new RequestQueue(12), origins = new Map<string, RequestQueue>();
async function requestSlot(origin: string, path: string, signal?: AbortSignal | null): Promise<() => void> {
  // Health probes cannot be starved by image downloads. Rust also reserves a
  // separate socket quota so HTTP saturation cannot kill chat reconnection.
  if (path === "/health") return healthQueue.acquire(signal);
  let queue = origins.get(origin); if (!queue) { queue = new RequestQueue(4); origins.set(origin, queue); }
  const releaseOrigin = await queue.acquire(signal);
  try {
    const releaseGlobal = await dataQueue.acquire(signal);
    let released = false;
    return () => { if (released) return; released = true; releaseGlobal(); releaseOrigin(); if (queue.idle && origins.get(origin) === queue) origins.delete(origin); };
  } catch (error) { releaseOrigin(); if (queue.idle) origins.delete(origin); throw error; }
}

async function encodeBody(body: BodyInit | null | undefined): Promise<string | null> {
  if (body == null) return null;
  let bytes: Uint8Array;
  if (typeof body === "string") bytes = new TextEncoder().encode(body);
  else if (body instanceof Blob) {
    if (body.size > BODY_LIMIT) throw new Error("native_body_too_large");
    bytes = new Uint8Array(await body.arrayBuffer());
  } else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  else throw new Error("unsupported_native_body");
  if (bytes.byteLength > BODY_LIMIT) throw new Error("native_body_too_large");
  if (isElectron()) return encodeDesktopBytes(bytes);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}

export async function hubFetch(origin: string, path: string, hubKey: string | undefined, init: RequestInit = {}): Promise<Response> {
  if (!usesPinnedTransport()) return fetch(origin + path, { ...init, redirect: "error" });
  const life = documentLife;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(init.signal?.aborted ? abortError(init.signal) : life.signal.reason);
  init.signal?.addEventListener("abort", relayAbort, { once: true });
  life.signal.addEventListener("abort", relayAbort, { once: true });
  const unlink = () => { init.signal?.removeEventListener("abort", relayAbort); life.signal.removeEventListener("abort", relayAbort); };
  if (init.signal?.aborted || life.signal.aborted) relayAbort();
  const signal = controller.signal;
  let release: () => void;
  try { release = await requestSlot(origin, path, signal); }
  catch (error) { unlink(); throw error; }
  let id: string | undefined, finished = false, stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const clean = () => { finished = true; clearTimeout(idle); signal.removeEventListener("abort", abort); unlink(); release(); };
  const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => { if (finished) return; if (id) void cancel(id); stream?.error(httpError("native_response_idle_timeout")); clean(); }, 30_000); };
  const abort = () => {
    if (finished) return;
    if (id) void cancel(id);
    stream?.error(abortError(signal)); clean();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const body = await encodeBody(init.body);
    if (signal?.aborted) throw abortError(signal);
    id = await allocate("http", life);
    // An abort can arrive while native allocation is in flight. Cancel its
    // receipt before starting any request, including a non-idempotent POST.
    if (signal?.aborted) throw abortError(signal);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) {
      if (typeof init.body === "string") headers.set("Content-Type", "text/plain;charset=UTF-8");
      else if (init.body instanceof Blob && init.body.type) headers.set("Content-Type", init.body.type);
    }
    const head = await invoke<{ status: number; headers: [string, string][] }>("net_http_open", {
      id, input: { origin, path, hubKey: hubKey ?? null, ...routeTrust(origin, hubKey), method, headers: [...headers], body },
    });
    if (signal?.aborted) throw abortError(signal);
    const responseInit = { status: head.status, headers: head.headers };
    if (method === "HEAD" || [204, 205, 304].includes(head.status)) {
      await cancel(id); clean(); return new Response(null, responseInit);
    }
    const operation = id;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) { stream = controller; armIdle(); },
      async pull(controller) {
        clearTimeout(idle);
        try {
          const value = await invoke<ArrayBuffer | number[]>("net_http_read", { id: operation });
          if (finished) return;
          const bytes = new Uint8Array(value);
          if (bytes.byteLength === 0) { clean(); controller.close(); }
          else { controller.enqueue(bytes); armIdle(); }
        } catch (error) { if (!finished) { clean(); controller.error(httpError(error)); } await cancel(operation); }
      },
      async cancel() { clean(); await cancel(operation); },
    }, { highWaterMark: 0 });
    return new Response(responseBody, responseInit);
  } catch (error) {
    clean(); if (id) await cancel(id); throw signal?.aborted ? abortError(signal) : httpError(error);
  }
}

export type HubSocket = Pick<WebSocket, "readyState" | "onopen" | "onmessage" | "onerror" | "onclose" | "close"> & { send(data: string): void };
type SocketEvent = { kind: "open" } | { kind: "message"; data: string; sequence: number } | { kind: "error"; error: string } | { kind: "close"; code: number; reason: string; clean: boolean };
function dispatch<T extends Event>(owner: NativeSocket, handler: ((this: WebSocket, event: T) => unknown) | null, event: T) {
  try { handler?.call(owner as unknown as WebSocket, event); }
  catch (error) { queueMicrotask(() => { throw error; }); } // Like EventTarget: report, without breaking Channel delivery.
}
class NativeSocket implements HubSocket {
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;
  private id?: string;
  private readonly life = documentLife;
  private outgoing = Promise.resolve();
  private pending = 0;
  private closeFallback?: ReturnType<typeof setTimeout>;
  private retire = () => this.fail();
  constructor(origin: string, hubKey: string | undefined) {
    this.life.signal.addEventListener("abort", this.retire, { once: true });
    void allocate("socket", this.life).then(async (id) => {
      this.id = id;
      if (this.readyState !== WebSocket.CONNECTING) { await cancel(id); return; }
      // Allocate the Channel only when Rust will receive and eventually drop it.
      const events = nativeChannel<SocketEvent>();
      events.onmessage = (event) => {
      if (this.readyState === WebSocket.CLOSED) return;
      if (event.kind === "close") { this.finish(event.code, event.reason, event.clean); return; }
      if (this.readyState === WebSocket.CLOSING) { if (event.kind === "message" && this.id) void invoke("net_socket_ack", { id: this.id, sequence: event.sequence }).catch(() => undefined); return; }
      if (event.kind === "open") { this.readyState = WebSocket.OPEN; dispatch(this, this.onopen, new Event("open")); }
      else if (event.kind === "error") this.fail(event.error);
      else {
        try { dispatch(this, this.onmessage, new MessageEvent("message", { data: event.data })); }
        // A Close event may already be en route after Rust retires the slot.
        // A late ack rejection must not replace that close or discard its frames.
        finally { if (this.id) void invoke("net_socket_ack", { id: this.id, sequence: event.sequence }).catch(() => undefined); }
      }
      };
      await invoke("net_socket_open", { id, origin, hubKey: hubKey ?? null, ...routeTrust(origin, hubKey), events });
    }).catch((error: unknown) => this.fail(asError(error).message));
  }
  private finish(code: number, reason: string, clean = false) {
    if (this.readyState === WebSocket.CLOSED) return;
    clearTimeout(this.closeFallback); this.closeFallback = undefined;
    this.life.signal.removeEventListener("abort", this.retire);
    this.readyState = WebSocket.CLOSED;
    dispatch(this, this.onclose, new CloseEvent("close", { code, reason, wasClean: clean }));
  }
  private fail(error = "native_socket_failed") {
    if (this.readyState === WebSocket.CLOSED) return;
    const report = this.readyState < WebSocket.CLOSING; this.readyState = WebSocket.CLOSING;
    if (this.id) void cancel(this.id);
    if (report) dispatch(this, this.onerror, new ErrorEvent("error", { message: error }));
    this.finish(1006, "");
  }
  send(data: string) {
    if (this.readyState === WebSocket.CONNECTING) throw new DOMException("Socket is not open", "InvalidStateError");
    if (this.readyState !== WebSocket.OPEN) return;
    if (new TextEncoder().encode(data).byteLength > 1024 * 1024 || this.pending >= 16) { this.fail(); throw new Error("native_socket_backpressure"); }
    this.pending++;
    this.outgoing = this.outgoing.then(async () => {
      if (this.readyState !== WebSocket.CLOSED) await invoke("net_socket_send", { id: this.id, text: data });
    }).catch(() => {
      // Channel Close and an invoke rejection are independently delivered.
      // Give the real close a bounded chance to arrive before synthesizing one.
      if (this.readyState < WebSocket.CLOSING && !this.closeFallback) this.closeFallback = setTimeout(() => this.fail(), 1500);
    }).finally(() => { this.pending--; });
  }
  close(code = 1000, reason = "") {
    if (code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("Invalid close code", "InvalidAccessError");
    if (new TextEncoder().encode(reason).byteLength > 123) throw new DOMException("Close reason too long", "SyntaxError");
    if (this.readyState >= WebSocket.CLOSING) return;
    const connecting = this.readyState === WebSocket.CONNECTING;
    this.readyState = WebSocket.CLOSING;
    clearTimeout(this.closeFallback); this.closeFallback = undefined;
    if (connecting) { if (this.id) void cancel(this.id); queueMicrotask(() => this.finish(1006, "")); }
    else {
      const wait = (delay: number) => { if (this.readyState !== WebSocket.CLOSED) { clearTimeout(this.closeFallback); this.closeFallback = setTimeout(() => this.fail(), delay); } };
      wait(12_000);
      void this.outgoing.then(() => invoke<boolean>("net_socket_close", { id: this.id, code, reason })).then((queued) => wait(queued ? 6000 : 1500), () => wait(1500));
    }
  }
}
export function hubSocket(origin: string, hubKey?: string): HubSocket {
  return usesPinnedTransport() ? new NativeSocket(origin, hubKey) : new WebSocket(origin.replace(/^http/, "ws") + "/ws");
}
