import { PUSH_FOREGROUND_EVENT } from "./push-maintenance.js";
import { t } from "./i18n.js";
import { Capacitor } from "@capacitor/core";
import { ListenerScope } from "./listener-scope.js";
import { isDesktop, isElectron, electronBridge, invoke } from "./desktop-bridge.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { deviceActionStatementSchema, type DeviceActionStatement } from "../../src/client-protocol/device-actions.js";
import { nativeDevice } from "./native-device.js";

export function nativePlatform(): "web" | "macos" | "windows" | "ios" | "android" {
  if (isElectron()) return electronBridge().platform === "win32" ? "windows" : "macos";
  if (isDesktop()) return navigator.userAgent.includes("Windows") ? "windows" : "macos";
  const platform = Capacitor.getPlatform(); return platform === "ios" || platform === "android" ? platform : "web";
}
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export async function createNativeIdentity(): Promise<{ deviceId: string; keyRef: string; publicKey: string }> {
  if (isDesktop()) return invoke("device_create");
  if (!Capacitor.isNativePlatform()) throw new Error("native_key_storage_required");
  return nativeDevice().create();
}
export async function signNative(keyRef: string, deviceId: string, nonce: string, clientNonce: string): Promise<string> {
  if (isDesktop()) return invoke("device_sign", { keyRef, deviceId, nonce, clientNonce });
  if (keyRef !== deviceId || !/^device_[A-Za-z0-9_]+$/.test(keyRef)) throw new Error("device_key_unavailable");
  return (await nativeDevice().sign({ keyRef, deviceId, nonce, clientNonce })).signature;
}
export async function signNativeDeviceAction(keyRef: string, raw: DeviceActionStatement): Promise<string> {
  const statement = deviceActionStatementSchema.parse(raw);
  if (keyRef !== statement.deviceId) throw new Error("device_key_unavailable");
  if (isDesktop()) return invoke("device_sign_action", { keyRef, statement });
  return (await nativeDevice().signAction({ keyRef, statement })).signature;
}
export async function deleteNativeIdentity(keyRef: string): Promise<void> {
  if (!/^device_[A-Za-z0-9_]+$/.test(keyRef)) throw new Error("invalid_device_id");
  if (isDesktop()) { await invoke("device_forget", { keyRef }); return; }
  if (Capacitor.isNativePlatform()) await nativeDevice().forget({ keyRef });
}
export function verifyEd25519(publicKey: string, signature: string, message: Uint8Array): boolean {
  const spki = decode(publicKey); const prefix = [0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00];
  if (spki.length !== 44 || prefix.some((v, i) => spki[i] !== v)) return false;
  return ed25519.verify(decode(signature), message, spki.subarray(12), { zip215: false });
}
let deepLinkRevision = 0;
let launchHandled = false;
export function navigateDeepLink(raw: string): boolean {
  try { const url = new URL(raw); const conversationId = url.pathname.slice(1); if (url.protocol !== "tarocub:" || url.hostname !== "conversation" || !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) return false; const messageId = url.searchParams.get("message"), hostId = url.searchParams.get("host"); if (messageId && !/^[A-Za-z0-9_-]{1,128}$/.test(messageId) || hostId && !/^hub_[0-9a-f]{64}$/.test(hostId)) return false; launchHandled = true; ++deepLinkRevision; return !window.dispatchEvent(new CustomEvent("tarocub-navigate", { cancelable: true, detail: { conversationId, messageId, ...(hostId ? { hostId } : {}) } })); } catch { return false; }
}
function readLaunchLinks(scope: ListenerScope, read: (active: () => boolean) => Promise<string[] | null | undefined>): void {
  // Initial OS state belongs to this document, not to each connection effect.
  // A cancelled first install must leave it available to its replacement.
  if (launchHandled) return;
  const revision = deepLinkRevision; let interacted = false;
  // A slow OS startup lookup must not take over after the user has begun using
  // the app. Capture activation (including accessibility clicks), not hydration
  // or automatic default selection. Remove these observers as soon as settled.
  const stopWatching = scope.listen<Event>((emit) => {
    const events = ["pointerdown", "keydown", "click"];
    events.forEach((name) => window.addEventListener(name, emit, true));
    return () => events.forEach((name) => window.removeEventListener(name, emit, true));
  }, (event) => { if (event.isTrusted) { launchHandled = true; interacted = true; stopWatching(); } });
  scope.listen<string[] | null | undefined>(async (emit, active) => {
    try { emit(await read(active)); } finally { if (active()) launchHandled = true; stopWatching(); }
  }, (urls) => { launchHandled = true; if (!interacted && revision === deepLinkRevision) urls?.forEach(navigateDeepLink); }, { retry: false });
}
export function installNativeEvents(resume: () => void, scope = new ListenerScope()): () => void {
  if (isElectron()) {
    scope.listen<unknown>(emit => electronBridge().on("focus", emit), resume);
    readLaunchLinks(scope, async () => invoke<string[]>("desktop_launch_links"));
    scope.listen<unknown>(emit => electronBridge().on("deep-link", emit), value => {
      if (Array.isArray(value)) for (const url of value) if (typeof url === "string") navigateDeepLink(url);
    });
    return scope.close;
  }
  if (isDesktop()) {
    // Native window activation can precede WebView focus/visibility updates.
    // Resume all hosts immediately; a healthy connection only sends a ping.
    // One scoped registration also fences late events after unmount/retry.
    scope.listen<unknown>(async (emit, active) => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      if (active()) return getCurrentWindow().listen("tauri://focus", emit);
    }, resume);
    readLaunchLinks(scope, async (active) => { const links = await import("@tauri-apps/plugin-deep-link"); if (active()) return links.getCurrent(); });
    scope.listen<string[]>(async (emit, active) => {
      const links = await import("@tauri-apps/plugin-deep-link"); if (active()) return links.onOpenUrl(emit);
    }, (urls) => urls.forEach(navigateDeepLink));
    return scope.close;
  }
  if (Capacitor.isNativePlatform()) {
    readLaunchLinks(scope, async (active) => { const { App } = await import("@capacitor/app"); if (active()) { const launch = await App.getLaunchUrl(); return launch ? [launch.url] : undefined; } });
    scope.listen<{ url: string }>(async (emit, active) => {
      const { App } = await import("@capacitor/app"); if (!active()) return;
      const listener = await App.addListener("appUrlOpen", emit); return () => listener.remove();
    }, (event) => navigateDeepLink(event.url));
    scope.listen<{ isActive: boolean }>(async (emit, active) => {
      const { App } = await import("@capacitor/app"); if (!active()) return;
      const listener = await App.addListener("appStateChange", emit); return () => listener.remove();
    }, (event) => { if (event.isActive) { resume(); window.dispatchEvent(new Event(PUSH_FOREGROUND_EVENT)); } });
    return scope.close;
  }
  const navigate = () => { const params = new URLSearchParams(location.hash.slice(1)); const conversation = params.get("conversation"); const message = params.get("message"), host = params.get("host"); if (conversation) { const query = new URLSearchParams(); if (message) query.set("message", message); if (host) query.set("host", host); navigateDeepLink(`tarocub://conversation/${conversation}?${query}`); } };
  scope.listen<Event>((emit) => { window.addEventListener("hashchange", emit); return () => window.removeEventListener("hashchange", emit); }, navigate);
  navigate(); return scope.close;
}
export async function nativeHaptic(): Promise<void> { if (Capacitor.isNativePlatform()) { const { Haptics, ImpactStyle } = await import("@capacitor/haptics"); await Haptics.impact({ style: ImpactStyle.Light }); } }
// Android WebView supplies LONG_PRESS feedback itself. Adding an impact here
// produces a second pulse; preserve native selection and system touch settings.
export async function nativeHoldHaptic(): Promise<void> {
  if (nativePlatform() !== "android") await nativeHaptic();
}
export async function setAutostart(enabled: boolean): Promise<void> { if (isElectron()) return invoke("desktop_autostart_set", { enabled }); if (!isDesktop()) throw new Error(t("此设置仅适用于桌面客户端")); const auto = await import("@tauri-apps/plugin-autostart"); if (enabled) await auto.enable(); else await auto.disable(); }
export async function autostartEnabled(): Promise<boolean> { return isElectron() ? invoke<boolean>("desktop_autostart_get") : isDesktop() ? (await import("@tauri-apps/plugin-autostart")).isEnabled() : false; }
export async function updateBadge(count: number): Promise<void> { if (isDesktop()) await invoke("unread_count", { count }); }

