import { isTauri, invoke as tauriInvoke, Channel as TauriChannel } from "@tauri-apps/api/core";

export type DesktopEvent = "focus" | "window-state" | "deep-link" | "native-state" | "tarocub-notification-action" | "github-update-progress" | "workbench-browser";
type ElectronBridge = {
  version: 1; engine: "electron"; platform: "darwin" | "win32" | "linux";
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  openSocket(args: Record<string, unknown>, receive: (event: unknown) => void): Promise<void>;
  on(event: DesktopEvent, receive: (payload: unknown) => void): () => void;
};
declare global { interface Window { tarobotDesktop?: ElectronBridge } }

/** The native origin stays native even if preload is broken. Never silently
 * downgrade identity or pinned transport to browser APIs after a bridge error. */
export function isElectron(): boolean {
  return typeof window !== "undefined" && (Object.hasOwn(window, "tarobotDesktop")
    || window.location?.protocol === "tarobot:" && window.location?.hostname === "app");
}
export function isDesktop(): boolean { return isElectron() || isTauri(); }
export function electronBridge(): ElectronBridge {
  const bridge = window.tarobotDesktop;
  if (bridge?.version !== 1 || bridge.engine !== "electron" || typeof bridge.invoke !== "function"
    || typeof bridge.openSocket !== "function" || typeof bridge.on !== "function") throw new Error("native_bridge_unavailable");
  return bridge;
}
export function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isElectron()) { try { return electronBridge().invoke<T>(command, args); } catch (error) { return Promise.reject(error); } }
  return tauriInvoke<T>(command, args);
}
export function channel<T>(): { onmessage: (event: T) => void } {
  return isElectron() ? { onmessage: () => undefined } : new TauriChannel<T>();
}
export async function listen<T>(event: string, receive: (event: { payload: T }) => void): Promise<() => void> {
  if (isElectron()) return electronBridge().on(event as DesktopEvent, payload => receive({ payload: payload as T }));
  return (await import("@tauri-apps/api/event")).listen<T>(event, receive);
}
export async function openDesktopUrl(url: string): Promise<void> {
  if (isElectron()) return invoke("desktop_open_url", { url });
  return (await import("@tauri-apps/plugin-opener")).openUrl(url);
}
