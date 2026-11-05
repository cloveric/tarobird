// Real UI components, isolated from native host startup and saved identities.
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";
import "../../src/safe-area.css";
import "../../src/viewport.css";
import "../../src/message-images.css";
import "../../src/expressive-themes.css";
import "../../src/cli-typography.css";
import "../../src/bot-name.css";
import "../../src/layout-density.css";
import "../../src/quoted-reply.css";
import "../../src/motion.css";
import "../../src/porcelain-details.css";
import "../../src/desktop-window-chrome.css";
import "../../src/ios-adaptive.css";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { setLocale } from "../../src/i18n.js";
const params = new URLSearchParams(location.search);
if (params.get("lang") === "en") setLocale("en");
const desktopPlatform = params.get("platform");
Capacitor.getPlatform = () => desktopPlatform ? "web" : params.get("os") === "ios" ? "ios" : "android";
const { restoreAppearance, applyAppearance } = await import("../../src/appearance.js");
const { defaultPreferences } = await import("../../src/storage.js");
restoreAppearance();
applyAppearance({ ...defaultPreferences, theme: params.get("theme") === "dark" ? "dark" : "light" });
if (desktopPlatform) {
  Object.assign(globalThis, { isTauri: true });
  if (desktopPlatform === "windows") Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  const { mockIPC } = await import("@tauri-apps/api/mocks");
  mockIPC((command) => {
    if (command === "net_document") return "pairing-design";
    if (command === "desktop_host") return Promise.reject("desktop_host_runtime_missing");
    return Promise.reject("native_request_timeout");
  });
}
const [{ DesktopWelcome }, { Pairing }] = await Promise.all([import("../../src/DesktopWelcome.js"), import("../../src/Pairing.js")]);
const { HubConnection } = await import("../../src/connection.js");
const pendingConnection = params.has("pending") ? new HubConnection({ deviceId: "design-device", name: "Preview desktop", publicKey: "device", hubPublicKey: "host", routes: [{ name: "Direct", url: "http://127.0.0.1:8788" }], pendingPairing: { code: "12345678", expiresAt: Date.now() + 300000 } }) : undefined;
function Fixture() {
  const [remote, setRemote] = useState(params.get("view") === "phone");
  if (desktopPlatform) return <Pairing connected={() => undefined} pendingConnection={pendingConnection}/>;
  return remote ? <Pairing connected={() => undefined} pendingConnection={pendingConnection} cancel={params.get("view") === "phone" ? undefined : () => setRemote(false)}/> : <DesktopWelcome connected={() => undefined} remote={() => setRemote(true)}/>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
