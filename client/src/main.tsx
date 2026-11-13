import { installMotion } from "./motion.js";
import "./transport.js";
import { restoreAppearance } from "./appearance.js";
import { installDesktopWindowChrome } from "./desktop-window-chrome.js";
import { installNativeContextMenu } from "./native-context-menu.js";
import { installFocusIntent } from "./focus-intent.js";
import { installMessageActionHover } from "./message-action-hover.js";
import { installMessageSelectionCopy } from "./message-selection-clipboard.js";
import { AttachmentDropFeedback } from "./AttachmentDropFeedback.js";
import { installAttachmentDropGuard } from "./attachment-drop.js";
import { installModalHistoryGuard } from "./modal-history.js";
import { sweepTemporaryDownloads } from "./download-buffer.js";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { isDesktop } from "./desktop-bridge.js";
import { MobileLock } from "./MobileLock.js";
import { DesktopMigrationGate } from "./DesktopMigrationGate.js";
import { DesktopRecovery } from "./DesktopRecovery.js";
import App from "./Bootstrap.js";
import { NativeBackNavigation } from "./NativeBackNavigation.js";
import { MobileViewport } from "./MobileViewport.js";
import { setLocale } from "./i18n.js";
import { systemLocale } from "./system-locale.js";
import "./styles.css";
// Component skin followed by the selected colour family.
import "./brand-theme.css";
import "./palette-tokens.css";
import "./mobile-im.css";
import "./mobile-shell.css";
import "./safe-area.css";
import "./viewport.css";
import "./message-images.css";
import "./expressive-themes.css";
import "./cli-typography.css";
import "./bot-name.css";
import "./layout-density.css";
import "./quoted-reply.css";
import "./motion.css";
import "./porcelain-details.css";
import "./desktop-window-chrome.css";
import "./ios-adaptive.css";

// Loading and pairing screens follow the system language until saved preferences load.
setLocale(systemLocale());
const stopMotion = installMotion();
restoreAppearance();
const stopWindowChrome = installDesktopWindowChrome();
// Android's native container owns system bars/cutouts; viewport.ts handles the
// keyboard overlay. Zero safe tokens apply before React and survive navigation.
if (Capacitor.getPlatform() === "android") document.documentElement.dataset.nativeInsets = "android";
const stopContextMenu = installNativeContextMenu();
const stopFocusIntent = installFocusIntent();
const stopMessageActionHover = installMessageActionHover();
const stopMessageSelectionCopy = installMessageSelectionCopy();
const stopFileNavigation = installAttachmentDropGuard();
const stopModalHistory = installModalHistoryGuard();
if (import.meta.hot) import.meta.hot.dispose(() => { stopMotion(); stopWindowChrome(); stopContextMenu(); stopFocusIntent(); stopMessageActionHover(); stopMessageSelectionCopy(); stopFileNavigation(); stopModalHistory(); });
// Scratch from a crashed window must also clear before pairing/reset recovery.
// Web Locks keep other windows' active transfers and previews safe.
void sweepTemporaryDownloads().catch(() => undefined);
createRoot(document.getElementById("root")!).render(<><NativeBackNavigation/><MobileViewport/><MobileLock><AttachmentDropFeedback/><DesktopMigrationGate><App/></DesktopMigrationGate></MobileLock><DesktopRecovery/></>);
// Native clients already ship an offline shell. A PWA worker can keep an old
// shell alive across installer upgrades; only browser clients need this cache.
if (import.meta.env.PROD && !isDesktop() && !Capacitor.isNativePlatform() && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
