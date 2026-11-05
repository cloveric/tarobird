import { getDesktopWindow } from "./desktop-window.js";
import { isDesktop, isElectron } from "./desktop-bridge.js";

// The macOS window draws its content under a transparent title bar
// (Electron hiddenInset, legacy Tauri Overlay). Rows that sit where a title bar
// would be drag the window, including their empty space. Electron CSS and the
// legacy drag script leave controls clickable. ADHD cards keep their own headers.
const DRAG_ROWS = ":is(.host-workspace>.app-shell,.adhd-shell)>.sidebar>.brand, .host-workspace>.app-shell>.conversation-main>.conversation-header, .adhd-workbench>.adhd-toolbar, .mobile-home .mh-header, .image-preview-toolbar>.image-preview-actions";
// Full-window file surfaces may move the native window. Small modal settings
// and creation dialogs own their in-page movement; never mark their headers.
const DRAG_DIALOG_ROWS = ".file-center>.file-center-header, .file-preview:not(.is-movable)>header";
// Full-page screens drag only from their own background, so text stays selectable.
const DRAG_PAGES = ".pairing-page, .loading-screen, .app-lock-screen, .startup-failure";

/** Marks the macOS desktop shell so CSS reserves room for the traffic lights,
 * and keeps the top rows draggable as React mounts them. Web and mobile builds
 * are untouched. */
export function installDesktopWindowChrome(): () => void {
  if (!isDesktop() || !/Macintosh/.test(navigator.userAgent)) return () => undefined;
  const root = document.documentElement;
  const previousChrome = root.getAttribute("data-window-chrome"), previousFullscreen = root.getAttribute("data-window-fullscreen");
  root.dataset.windowChrome = "mac-overlay";
  if (isElectron()) root.dataset.desktopEngine = "electron";
  const owned = new WeakMap<Element, string>();
  const mark = (element: Element) => {
    if (element.hasAttribute("data-tauri-drag-region")) return;
    if (element.matches(`${DRAG_ROWS},${DRAG_DIALOG_ROWS}`)) element.setAttribute("data-tauri-drag-region", "deep");
    else if (element.matches(DRAG_PAGES)) element.setAttribute("data-tauri-drag-region", "");
    else return;
    owned.set(element, element.getAttribute("data-tauri-drag-region")!);
  };
  const markTree = (element: Element) => {
    mark(element);
    for (const descendant of element.querySelectorAll(`${DRAG_ROWS},${DRAG_DIALOG_ROWS},${DRAG_PAGES}`)) mark(descendant);
  };
  // Streamed text is not window chrome. Inspect only inserted element subtrees,
  // rather than rescanning the entire message history every animation frame.
  const observer = new MutationObserver(records => {
    for (const record of records) {
      // A draft preview starts as a loading document and may become a movable
      // video without replacing its header. Reconcile only these dialog roots.
      if (record.type === "attributes") {
        const element = record.target;
        if (!(element instanceof Element) || !element.matches(".file-preview")) continue;
        for (const header of element.children) if (header.tagName === "HEADER") {
          if (owned.has(header) && !header.matches(DRAG_DIALOG_ROWS)) {
            if (header.getAttribute("data-tauri-drag-region") === owned.get(header)) header.removeAttribute("data-tauri-drag-region");
            owned.delete(header);
          }
          mark(header);
        }
      } else for (const node of record.addedNodes) if (node instanceof Element) markTree(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  markTree(document.body);
  let disposed = false, revision = 0, frame: number | undefined, unlisten: (() => void) | undefined;
  // Full screen hides the traffic lights, so their reserved room collapses.
  void getDesktopWindow().then(async (window) => {
    if (disposed) return;
    const sync = async () => {
      const current = ++revision;
      try {
        const fullscreen = await window.isFullscreen();
        if (!disposed && current === revision) root.toggleAttribute("data-window-fullscreen", fullscreen);
      } catch { /* Preserve the last confirmed layout if native IPC fails. */ }
    };
    const stop = await window.onResized(() => {
      if (!disposed && frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; void sync(); });
    });
    if (disposed) { stop(); return; }
    unlisten = stop;
    await sync();
  }).catch(() => { /* Keep the reserved room if the window API is unavailable. */ });
  return () => {
    if (disposed) return;
    disposed = true; revision++; observer.disconnect(); unlisten?.();
    if (isElectron()) delete root.dataset.desktopEngine;
    if (frame !== undefined) cancelAnimationFrame(frame);
    for (const element of document.querySelectorAll("[data-tauri-drag-region]")) if (owned.has(element) && element.getAttribute("data-tauri-drag-region") === owned.get(element)) element.removeAttribute("data-tauri-drag-region");
    if (previousChrome === null) root.removeAttribute("data-window-chrome"); else root.setAttribute("data-window-chrome", previousChrome);
    if (previousFullscreen === null) root.removeAttribute("data-window-fullscreen"); else root.setAttribute("data-window-fullscreen", previousFullscreen);
  };
}
