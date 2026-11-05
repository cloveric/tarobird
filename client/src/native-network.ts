import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isDesktop, isElectron, electronBridge } from "./desktop-bridge.js";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface NativeEventChannel<T> { onmessage: (event: T) => void }
interface MobileTransport {
  document(args?: Record<string, unknown>): Promise<{ value: string }>;
  allocate(args: Record<string, unknown>): Promise<{ value: string }>;
  cancel(args: Record<string, unknown>): Promise<void>;
  httpOpen(args: Record<string, unknown>): Promise<unknown>;
  httpRead(args: Record<string, unknown>): Promise<{ data: string }>;
  socketOpen(args: Record<string, unknown>): Promise<void>;
  socketSend(args: Record<string, unknown>): Promise<void>;
  socketAck(args: Record<string, unknown>): Promise<void>;
  socketClose(args: Record<string, unknown>): Promise<{ value: boolean }>;
  addListener(name: string, callback: (event: { id: string; kind: string }) => void): Promise<PluginListenerHandle>;
}

// Fixed at document startup. Native apps must fail closed if their transport
// plugin is unavailable; they never fall back to unpinned WebView networking.
const desktop = isDesktop(), platform = Capacitor.getPlatform(), mobile = !desktop && ["android", "ios"].includes(platform);
export const usesNativeNetwork = () => desktop || mobile;
const pageToken = mobile && platform === "ios"
  ? [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("") : undefined;
if (pageToken) Object.defineProperty(window, "__TAROCUB_NATIVE_PAGE_TOKEN__", { value: pageToken });

/** Kept independent of Capacitor globals so bridge contract tests exercise the
 * same adapter with delayed listener registration, cancellation and receipts. */
export function mobileNetwork(plugin: MobileTransport, pageToken?: string) {
  const channels = new Map<string, NativeEventChannel<unknown>>();
  let listener: Promise<PluginListenerHandle> | undefined;
  const listen = () => {
    if (!listener) {
      let live = true;
      let pending: Promise<PluginListenerHandle>;
      try {
        pending = plugin.addListener(pageToken ? `socket:${pageToken}` : "socket", (event) => {
          if (!live) return;
          const channel = channels.get(event.id);
          if (event.kind === "close") channels.delete(event.id);
          channel?.onmessage(event);
        });
      } catch (error) { live = false; throw error; }
      listener = pending;
      // Share registration across hosts, but let a later reconnect recover from
      // a rejected bridge call. The current attempts still fail before opening
      // any socket; they never fall back to WebView networking.
      // If registration partly succeeded before rejecting, its stale callback
      // must not dispatch messages or delete a newer socket's channel.
      void pending.catch(() => { live = false; if (listener === pending) listener = undefined; });
    }
    return listener;
  };
  return async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (pageToken) args = { ...args, pageToken };
    switch (command) {
      case "net_document": return (await plugin.document(pageToken ? { pageToken } : undefined)).value;
      case "net_allocate": return (await plugin.allocate(args)).value;
      case "net_cancel": channels.delete(String(args.id)); return plugin.cancel(args);
      case "net_http_open": return plugin.httpOpen(args);
      case "net_http_read": {
        const { data } = await plugin.httpRead(args);
        if (typeof data !== "string" || data.length > 349528) throw new Error("invalid_native_chunk");
        const decoded = atob(data);
        if (decoded.length > 256 * 1024) throw new Error("invalid_native_chunk");
        // Avoid a per-character iterator/callback and intermediate sequence on
        // every 256 KiB native download chunk on the WebView's main thread.
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
        return bytes.buffer;
      }
      case "net_socket_open": {
        await listen();
        const id = String(args.id), channel = args.events as NativeEventChannel<unknown>;
        channels.set(id, channel);
        try { return await plugin.socketOpen({ id, origin: args.origin, hubKey: args.hubKey,
          ...(args.certificateAuthority ? { certificateAuthority: args.certificateAuthority } : {}),
          ...(pageToken ? { pageToken } : {}) }); }
        catch (error) { channels.delete(id); throw error; }
      }
      case "net_socket_send": return plugin.socketSend(args);
      case "net_socket_ack": return plugin.socketAck(args);
      case "net_socket_close": return (await plugin.socketClose(args)).value;
      default: throw new Error("unknown_native_transport_command");
    }
  };
}
const mobileInvoke = mobile ? mobileNetwork(registerPlugin<MobileTransport>("TaroCubHubTransport"), pageToken) : undefined;
export async function nativeInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isElectron()) {
    const bridge = electronBridge();
    if (command === "net_socket_open") {
      const { events, ...input } = args;
      const channel = events as NativeEventChannel<unknown>;
      return await bridge.openSocket(input, event => channel.onmessage(event)) as T;
    }
    const result = await bridge.invoke<unknown>(command, args);
    if (command === "net_http_read") {
      const data = (result as { data?: unknown })?.data;
      if (typeof data !== "string" || data.length > 349528) throw new Error("invalid_native_chunk");
      const decoded = atob(data);
      if (decoded.length > 256 * 1024) throw new Error("invalid_native_chunk");
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      return bytes.buffer as T;
    }
    return result as T;
  }
  if (desktop) return tauriInvoke<T>(command, args);
  if (mobileInvoke) return await mobileInvoke(command, args) as T;
  throw new Error("native_transport_unavailable");
}
export function nativeChannel<T>(): NativeEventChannel<T> {
  if (desktop && !isElectron()) return new Channel<T>();
  return { onmessage: () => undefined };
}
