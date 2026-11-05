import { useCallback, useEffect, useReducer, useRef, type RefObject } from "react";
import { createFullscreenController, type FullscreenController, type FullscreenTarget } from "./image-viewer-fullscreen.js";
import { invoke, isElectron } from "./desktop-bridge.js";
import type { DesktopWindowState } from "./desktop-window.js";

/** Fullscreen the actual viewer, including its controls, without remounting the
 * canvas or borrowing another surface's fullscreen ownership. Electron uses
 * this HTML fullscreen request to enter the native window's fullscreen mode. */
export function useScreenFullscreen(panel: RefObject<HTMLElement | null>, visible: boolean, release: () => void) {
  const [, render] = useReducer(value => value + 1, 0);
  const controller = useRef<FullscreenController>(undefined);
  const releaseNow = useRef(release); releaseNow.current = release;
  useEffect(() => {
    const element = panel.current;
    if (!element || !document.fullscreenEnabled || !element.requestFullscreen) return;
    const target: FullscreenTarget = {
      read: async () => document.fullscreenElement === element,
      set: async active => {
        releaseNow.current();
        if (active) {
          await element.requestFullscreen({ navigationUI: "hide" });
        }
        else if (document.fullscreenElement === element) await document.exitFullscreen();
        else if (document.fullscreenElement) return; // another surface owns fullscreen
        // HTML promises resolve before macOS finishes its Space animation.
        // Serialize both directions through the native event before accepting
        // another transition or removing the viewer. A pre-existing native
        // fullscreen window can remain fullscreen after the HTML surface exits.
        if (isElectron() && window.tarobotDesktop?.platform === "darwin") {
          const deadline = performance.now() + 5000;
          while (active ? document.fullscreenElement === element : !document.fullscreenElement) {
            const state = await invoke<DesktopWindowState>("desktop_window_read");
            if (!state.fullscreenTransitioning && (!active || state.fullscreen)) break;
            if (performance.now() >= deadline) throw new Error("fullscreen_transition_timeout");
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      },
      watch: changed => {
        const sync = () => { releaseNow.current(); changed(); };
        document.addEventListener("fullscreenchange", sync);
        return () => document.removeEventListener("fullscreenchange", sync);
      },
    };
    const current = createFullscreenController(target, render); controller.current = current; render();
    const escape = (event: KeyboardEvent) => {
      // This chord belongs to remote-control release, even in fullscreen.
      if (event.key !== "Escape" || event.ctrlKey && event.altKey && event.shiftKey) return;
      if (current.consumeEscape()) { event.preventDefault(); event.stopPropagation(); }
    };
    // A dialog's native Escape can arrive after the browser already left
    // fullscreen. The controller's short exit guard prevents closing both.
    const cancel = (event: Event) => {
      if (current.consumeEscape()) { event.preventDefault(); event.stopPropagation(); }
    };
    const dialog = element.closest("dialog");
    document.addEventListener("keydown", escape, true); dialog?.addEventListener("cancel", cancel, true);
    return () => {
      document.removeEventListener("keydown", escape, true); dialog?.removeEventListener("cancel", cancel, true);
      current.dispose(); if (controller.current === current) controller.current = undefined;
    };
  }, [panel]);
  useEffect(() => { if (!visible) controller.current?.consumeEscape(); }, [visible]);
  const toggle = useCallback(() => { releaseNow.current(); controller.current?.toggle(); }, []);
  const exit = useCallback(async () => {
    releaseNow.current();
    const current = controller.current;
    if (!current) return true;
    return await current.exit() && controller.current === current;
  }, []);
  return { active: controller.current?.active ?? false, error: controller.current?.error, supported: !!controller.current, toggle, exit };
}
