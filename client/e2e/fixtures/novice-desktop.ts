// Test-only native shell. Host authentication and network membership use real
// disposable Hubs; OS credential storage and TLS IPC are not native acceptance.
import { mockIPC } from "@tauri-apps/api/mocks";
const config = await fetch("/__novice/config").then(response => response.json()) as { origins: string[] };
const realFetch = window.fetch.bind(window), RealSocket = window.WebSocket;
const proxy = (url: string) => {
  const parsed = new URL(url);
  const origin = parsed.origin.replace(/^ws/, "http");
  const index = config.origins.indexOf(origin);
  if (index < 0) throw new Error("fixture_unknown_host");
  return `/__novice/proxy/${index}${parsed.pathname}${parsed.search}`;
};
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return realFetch(config.origins.some(origin => url.startsWith(origin + "/")) ? proxy(url) : input, init);
};
window.WebSocket = class extends RealSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const value = String(url), mapped = config.origins.some(origin => value.startsWith(origin.replace(/^http/, "ws") + "/"));
    super(mapped ? location.origin.replace(/^http/, "ws") + proxy(value) : value, protocols);
  }
};
if (!new URL(location.href).searchParams.has("phone")) {
  Object.assign(globalThis, { isTauri: true });
  const streams = new Map<string, Uint8Array>(), sockets = new Map<string, WebSocket>();
  mockIPC(async (command, args: any) => {
    // This retained Tauri fixture is a fresh, non-transition desktop profile.
    if (command === "desktop_migration_mode") return { transition: false, appVersion: "0.0.0" };
    if (command === "desktop_migration_status") return { exports: [], imported: [], partials: [] };
    if (command === "net_document") return "novice-document";
    if (command === "net_allocate") return crypto.randomUUID();
    if (command === "net_http_open") {
      const input = args.input, response = await fetch(input.origin + input.path, { method: input.method, headers: input.headers,
        ...(input.body ? { body: Uint8Array.from(atob(input.body), value => value.charCodeAt(0)) } : {}) });
      streams.set(args.id, new Uint8Array(await response.arrayBuffer()));
      return { status: response.status, headers: [...response.headers] };
    }
    if (command === "net_http_read") { const bytes = streams.get(args.id) ?? new Uint8Array(); streams.delete(args.id); return bytes.buffer; }
    if (command === "net_socket_open") {
      const socket = new WebSocket(args.origin.replace(/^http/, "ws") + "/ws"); sockets.set(args.id, socket); let sequence = 0;
      socket.onopen = () => args.events.onmessage({ kind: "open" });
      socket.onmessage = event => args.events.onmessage({ kind: "message", data: event.data, sequence: ++sequence });
      socket.onerror = () => args.events.onmessage({ kind: "error", error: "fixture_socket_error" });
      socket.onclose = event => args.events.onmessage({ kind: "close", code: event.code, reason: event.reason, clean: event.wasClean });
      return;
    }
    if (command === "net_socket_send") { sockets.get(args.id)!.send(args.text); return; }
    if (command === "net_socket_ack") return;
    if (command === "net_socket_close" || command === "net_cancel") { sockets.get(args.id)?.close(); streams.delete(args.id); return true; }
    if (command === "desktop_host" || command.startsWith("device_")) {
      const response = await realFetch("/__novice/native", { method: "POST", body: JSON.stringify({ command, args }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
    }
    if (command === "plugin:event|listen") return 1;
    if (command === "plugin:deep-link|get_current") return null;
    if (command === "plugin:updater|check") return null;
    return undefined;
  });
}
await import("../../src/main.js");
