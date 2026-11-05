import { getDesktopWindow, focusDesktopView } from "./desktop-window.js";
import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from "react";
import { Capacitor } from "@capacitor/core";
import { isDesktop } from "./desktop-bridge.js";
import { setImmersiveSystemBars } from "./appearance.js";
import { t } from "./i18n.js";

/** One window-level fullscreen surface: a browser document or the Tauri window. */
export type FullscreenTarget = {
  read(): Promise<boolean>;
  set(value: boolean): Promise<void>;
  watch(changed: () => void): () => void;
};

export type FullscreenController = {
  readonly active: boolean; readonly error?: string;
  toggle(): void;
  /** Wait for pending entry and exit before removing the fullscreen surface. */
  exit(): Promise<boolean>;
  /** Synchronous Escape/Back arbitration: true means "only leave fullscreen". */
  consumeEscape(): boolean;
  dispose(): void;
};

/** Operations are serialized, so late native completions cannot reorder state.
 * An idle request starts synchronously to keep the click's user activation.
 * Toggles flip the latest requested state, not a state that has yet to settle. */
export function createFullscreenController(target: FullscreenTarget, changed: () => void, now = () => performance.now()): FullscreenController {
  let disposed = false, active = false, initial: boolean | undefined, entered = false, error: string | undefined, left = -Infinity, leaving = false;
  let desired: boolean | undefined, pending = 0, queue: Promise<unknown> = Promise.resolve();
  const serial = (task: (immediate: boolean) => Promise<void>) => {
    const run = (immediate: boolean) => task(immediate).finally(() => { pending--; });
    const next = ++pending === 1 ? run(true) : queue.then(() => run(false), () => run(false));
    queue = next.catch(() => undefined);
    return next;
  };
  const publish = () => { if (!disposed) changed(); };
  const sync = () => serial(async () => {
    const value = await target.read();
    initial ??= value;
    // Only an exit the viewer did not request can share an Escape with the page.
    if (active && !value && !leaving) left = now();
    if (!value) leaving = false;
    if (pending === 1) desired = undefined; // settled: later toggles start from reality
    if (value !== active) { active = value; publish(); }
  }).catch(() => undefined);
  const request = (value: boolean, settle = false) => {
    if (disposed) return Promise.resolve(false);
    desired = value;
    let applied = false;
    return serial(async immediate => {
      if (desired !== value) return; // a later request superseded this one
      initial ??= await target.read();
      // A queued request re-reads; an idle one must call set() within the click.
      // Explicit close also waits for the target's native transition even if
      // HTML fullscreen already ended through Escape/the browser itself.
      if (!immediate && !settle && await target.read() === value) { applied = true; return; }
      leaving = !value;
      try { await target.set(value); } catch (cause) { leaving = false; throw cause; }
      if (value) entered = true;
      applied = true;
    }).then(() => { error = undefined; return applied; }, () => { error = t("无法切换全屏，请稍后重试。"); return false; })
      .finally(() => { publish(); void sync(); });
  };
  const unwatch = target.watch(() => { void sync(); });
  void sync();
  return {
    get active() { return active; }, get error() { return error; },
    toggle() { void request(!(desired ?? active)); },
    exit() { return request(false, true); },
    consumeEscape() {
      if (disposed) return false;
      // Exit only: a stale state may cost a no-op exit, never a new fullscreen.
      if (desired ?? active) { void request(false); return true; }
      // A browser may leave fullscreen on this same Escape before the page sees it.
      return now() - left < 150;
    },
    dispose() {
      if (disposed) return;
      disposed = true; unwatch();
      // Undo only fullscreen this viewer entered; keep a window that already was.
      void serial(async () => {
        if (entered && initial === false && await target.read()) await target.set(false);
      }).catch(() => undefined);
    },
  };
}

/** A modal <dialog> cannot itself be the fullscreen element (Chromium rejects
 * "Dialog elements are invalid"); the root goes fullscreen and the open dialog
 * stays in the top layer above it. */
export function documentFullscreen(doc: Document): FullscreenTarget {
  return {
    read: async () => !!doc.fullscreenElement,
    set: async value => {
      if (value && !doc.fullscreenElement) await doc.documentElement.requestFullscreen({ navigationUI: "hide" });
      else if (!value && doc.fullscreenElement) await doc.exitFullscreen();
    },
    watch: changed => { doc.addEventListener("fullscreenchange", changed); return () => doc.removeEventListener("fullscreenchange", changed); },
  };
}

let stopRefocus = () => {};
/** Leaving macOS fullscreen leaves the NSWindow as first responder, so keys
 * stop reaching the page (document.hasFocus() false while the window is key).
 * setFullscreen(false) resolves before the exit animation ends, so wait until
 * the window is windowed, then focus the WebView, and once more in case AppKit
 * reasserts the window. Nothing happens while another app or window is key.
 * Bounded to 3 s; a newer exit replaces an older wait. */
function refocusAfterExit(window: Promise<TauriWindow>): void {
  stopRefocus();
  let stopped = false, focused = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + 3000;
  const stop = () => { stopped = true; clearTimeout(timer); };
  stopRefocus = stop;
  const step = async () => {
    try {
      const current = await window;
      if (stopped || await current.isFullscreen()) { /* still animating or re-entered */ }
      else if (!await current.isFocused()) return stop();
      else { await focusDesktopView(); if (++focused === 2) return stop(); }
    } catch { /* A closed window or a denied permission ends the wait. */ return stop(); }
    if (!stopped && Date.now() < deadline) timer = setTimeout(() => { void step(); }, focused ? 300 : 120);
  };
  void step();
}

type TauriWindow = Awaited<ReturnType<typeof getDesktopWindow>>;
/** WebView2 keeps element fullscreen inside the window, so desktop uses the window. */
export function tauriFullscreen(): FullscreenTarget {
  const window = getDesktopWindow();
  let known: boolean | undefined;
  const observe = (value: boolean) => { if (known && !value) refocusAfterExit(window); known = value; };
  return {
    // Observing every read also catches exits the OS performed itself (Escape, green button).
    read: async () => { const value = await (await window).isFullscreen(); observe(value); return value; },
    set: async value => { await (await window).setFullscreen(value); if (value) stopRefocus(); else refocusAfterExit(window); known = value; },
    watch: changed => {
      let stopped = false, stop: (() => void) | undefined;
      void window.then(current => current.onResized(changed)).then(unlisten => { if (stopped) unlisten(); else stop = unlisten; }, () => undefined);
      return () => { stopped = true; stop?.(); };
    },
  };
}

function platformFullscreen(): FullscreenTarget | undefined {
  // Phones hold a native immersive canvas for the whole reader instead.
  if (Capacitor.isNativePlatform()) return;
  if (isDesktop()) return tauriFullscreen();
  if (typeof document !== "undefined" && document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function") return documentFullscreen(document);
}

export function useImageFullscreen(dialog: RefObject<HTMLDialogElement | null>): { supported: boolean; active: boolean; toggle: () => void; consumeEscape: () => boolean; error?: string } {
  const [target] = useState(platformFullscreen), [, render] = useReducer((value: number) => value + 1, 0);
  const controller = useRef<FullscreenController>(undefined);
  useEffect(() => {
    if (!target) return;
    const current = createFullscreenController(target, render);
    controller.current = current;
    return () => { current.dispose(); if (controller.current === current) controller.current = undefined; };
  }, [target]);
  const toggle = useCallback(() => { if (dialog.current?.open) controller.current?.toggle(); }, [dialog]);
  const consumeEscape = useCallback(() => controller.current?.consumeEscape() ?? false, []);
  return { supported: !!target, active: controller.current?.active ?? false, toggle, consumeEscape, error: controller.current?.error };
}

let immersive = 0;
/** Hide native system bars while the reader is open. Leases nest; the
 * last release shows them again, even if an earlier native call was rejected. */
export function acquireImageViewerImmersive(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  let held = true;
  if (immersive++ === 0) void setImmersiveSystemBars(true).catch(() => undefined);
  return () => {
    if (!held) return;
    held = false;
    if (--immersive === 0) void setImmersiveSystemBars(false).catch(() => undefined);
  };
}
