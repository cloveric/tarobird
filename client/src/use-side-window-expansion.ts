import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isDesktop, isElectron, invoke } from "./desktop-bridge.js";
import { createSideWindowExpansion, type SideWindowPort } from "./side-window-expansion.js";

async function nativeWindow(): Promise<SideWindowPort> {
  if (isElectron()) return {
    read: () => invoke("desktop_window_read"),
    size: (width, height) => invoke("desktop_window_size", { width, height }),
    position: (x, y) => invoke("desktop_window_position", { x, y }),
    minimum: width => invoke("desktop_window_side_minimum", { width }),
  };
  const { getCurrentWindow, currentMonitor, PhysicalSize, PhysicalPosition } = await import("@tauri-apps/api/window");
  const window = getCurrentWindow();
  return {
    read: async () => {
      const [position, inner, outer, scale, maximized, fullscreen, resizable, monitor] = await Promise.all([
        window.outerPosition(), window.innerSize(), window.outerSize(), window.scaleFactor(), window.isMaximized(), window.isFullscreen(), window.isResizable(), currentMonitor(),
      ]);
      return { x: position.x, y: position.y, width: inner.width, height: inner.height, outerWidth: outer.width, outerHeight: outer.height,
        scale, maximized, fullscreen, resizable, work: monitor ? { ...monitor.workArea.position, ...monitor.workArea.size } : null };
    },
    size: (width, height) => window.setSize(new PhysicalSize(width, height)),
    position: (x, y) => window.setPosition(new PhysicalPosition(x, y)),
  };
}
const expansion = createSideWindowExpansion(nativeWindow);

/** Native desktop only. Browser tabs retain their existing in-page split. */
export function useSideWindowExpansion(root: RefObject<HTMLElement | null>, visible: boolean) {
  const native = isDesktop(), owner = useRef({}), [layout, setLayout] = useState<"expanded" | "pending" | "split" | "restoring">("pending");
  const closing = useRef<Promise<number | undefined> | undefined>(undefined);
  useLayoutEffect(() => {
    const shell = root.current;
    const clear = () => { for (const key of ["base-width", "panel-width", "sidebar-width"]) shell?.style.removeProperty(`--side-window-${key}`); };
    if (!native || !visible || !shell) {
      const restoration = closing.current; closing.current = undefined;
      if (native && shell && restoration) {
        let active = true, resolved = false, viewport: number | undefined;
        const finish = () => {
          if (!active) return;
          active = false; clearTimeout(deadline); window.removeEventListener("resize", measure);
          clear(); setLayout("pending");
        };
        const measure = () => {
          if (resolved && (viewport === undefined || innerWidth <= viewport + 1)) finish();
        };
        // Native size receipts precede renderer resize events. Hold the chat
        // until both agree, but never leave a blank column after failed/stuck IPC.
        const deadline = setTimeout(finish, 2_000);
        setLayout("restoring");
        window.addEventListener("resize", measure);
        void restoration.then(width => { viewport = width; resolved = true; measure(); }, finish);
        return () => { active = false; clearTimeout(deadline); window.removeEventListener("resize", measure); };
      }
      clear(); setLayout("pending"); return;
    }
    // A close can be reopened before Chromium delivers the shrink event. Its
    // pinned CSS width is still the right baseline for the new opening.
    const restoringBase = shell.dataset.sideWindow === "restoring" ? parseFloat(shell.style.getPropertyValue("--side-window-base-width")) : NaN;
    let active = true, base = Number.isFinite(restoringBase) ? restoringBase : innerWidth, panel = 400;
    let resolved = false, expanded = false, presented = false;
    let trackingWidth: number | undefined, stableBase: number | undefined;
    let modeTimeout: ReturnType<typeof setTimeout> | undefined;
    const clearResizeHold = () => { delete shell.dataset.sideWindowResizing; shell.style.removeProperty("--side-window-resize-base-width"); };
    let modeRestricted = false, resizing = false, readingMode = false, resizeVersion = 0;
    let modePort: Promise<SideWindowPort> | undefined;
    const panels = () => Array.from(shell.querySelectorAll<HTMLElement>(":scope > .conversation-side-panel"));
    const side = () => panels().find(node => !node.hidden && getComputedStyle(node).display !== "none" && getComputedStyle(node).position !== "absolute");
    const protect = () => {
      if (!active || !expanded || trackingWidth === undefined || resizing || modeRestricted) return;
      const width = side()?.getBoundingClientRect().width;
      if (width && width > 0) { stableBase = innerWidth - width; expansion.protect(owner.current, stableBase + 320); }
    };
    const observer = new ResizeObserver(protect);
    let observedSide: HTMLElement | undefined;
    const observeSide = () => {
      if (!active) return;
      const node = side();
      if (node !== observedSide) {
        observer.disconnect(); observedSide = node;
        if (node) observer.observe(node);
      }
      protect();
    };
    // Lazy loading replaces its placeholder; cached right-hand surfaces also
    // switch via `hidden` without remounting this hook. Follow only direct panel
    // nodes, not chat streaming mutations or nested editor changes.
    const panelObserver = new MutationObserver(records => {
      if (records.some(record => record.type === "childList")) watchPanels();
      else observeSide();
    });
    const watchPanels = () => {
      if (!active) return;
      panelObserver.disconnect(); panelObserver.observe(shell, { childList: true });
      for (const node of panels()) panelObserver.observe(node, { attributes: true, attributeFilter: ["hidden", "class"] });
      observeSide();
    };
    watchPanels();
    let revealTimeout: ReturnType<typeof setTimeout> | undefined;
    const chosen = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--side-panel-width"));
    panel = Number.isFinite(chosen) ? Math.max(320, chosen) : innerWidth >= 1500 ? 440 : 400;
    const sidebar = shell.querySelector<HTMLElement>(":scope > .sidebar")?.getBoundingClientRect().width ?? 272;
    shell.style.setProperty("--side-window-base-width", `${base}px`);
    shell.style.setProperty("--side-window-panel-width", `${panel}px`);
    shell.style.setProperty("--side-window-sidebar-width", `${sidebar}px`);
    setLayout("pending");
    const measure = () => {
      if (!active || !resolved) return;
      let fits = innerWidth + 1 >= base + panel;
      if (expanded && trackingWidth !== undefined && !resizing && !modeRestricted) {
        // Native right-edge resizing belongs to the right panel. Internal
        // splitter drags still choose a new main/panel allocation themselves.
        const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--side-panel-width"));
        const before = Number.isFinite(current) ? current : panel;
        const width = before + innerWidth - trackingWidth;
        fits = width >= 319;
        if (fits && innerWidth !== trackingWidth) {
          panel = Math.max(320, width);
          document.documentElement.style.setProperty("--side-panel-width", `${panel}px`);
        }
      }
      // Native frame acknowledgement can precede the WebView resize event.
      // Do not animate an old-width split before the final right edge exists.
      if (!presented && expanded && !fits) return;
      presented = true;
      clearTimeout(revealTimeout);
      setLayout(expanded && fits ? "expanded" : "split");
      if (expanded && fits && !resizing && !modeRestricted) {
        trackingWidth = innerWidth;
        // The first ResizeObserver notification can trail another native resize.
        // The acknowledged opening already owns this baseline even while hidden.
        stableBase ??= base;
        // The native frame protects the current chat + sidebar, not a hardcoded
        // width. Re-evaluate after deliberate internal divider changes too.
        observeSide();
      }
    };
    // Maximize/fullscreen also emit resize. Confirm the native mode before
    // remembering a right-edge drag, or a temporary viewport jump becomes the
    // next panel's saved width. Coalesce reads and reject stale IPC replies.
    const resized = () => {
      if (!active) return;
      // The renderer resizes before mode IPC answers. Hold the last allocation
      // until that answer, instead of letting chat grow then snap back. This is
      // temporary presentation only; maximize/fullscreen never persist a width.
      if (expanded && trackingWidth !== undefined && stableBase !== undefined && !modeRestricted
        && side() && getComputedStyle(side()!).position !== "absolute") {
        shell.style.setProperty("--side-window-resize-base-width", `${stableBase}px`);
        shell.dataset.sideWindowResizing = "true";
      }
      resizing = true; resizeVersion++;
      if (readingMode) return;
      readingMode = true;
      const version = resizeVersion;
      const deadline = new Promise<never>((_, reject) => { modeTimeout = setTimeout(() => reject(new Error("window_read_timeout")), 2_000); });
      void Promise.race([(modePort ??= nativeWindow()).then(port => port.read()), deadline]).then(frame => {
        if (!active || version !== resizeVersion) return;
        const restricted = frame.maximized || frame.fullscreen;
        if (restricted || modeRestricted) trackingWidth = undefined;
        modeRestricted = restricted; resizing = false; clearResizeHold(); measure();
      }, () => {
        if (!active || version !== resizeVersion) return;
        // A missing native answer cannot prove a deliberate user resize.
        trackingWidth = undefined; resizing = false; clearResizeHold(); measure();
      }).finally(() => { clearTimeout(modeTimeout); readingMode = false; if (active && resizing) resized(); });
    };
    // Bound the whole opening, including a native IPC that never answers.
    // Only release unanswered native work. An acknowledged expansion keeps its
    // lease if the WebView resize is late; reveal the current split and let the
    // eventual resize choose the expanded layout without shrinking the frame.
    revealTimeout = setTimeout(() => {
      if (!active || presented) return;
      if (!resolved) {
        expansion.release(owner.current);
        resolved = true; expanded = false;
      }
      presented = true;
      measure();
    }, 2_000);
    expansion.acquire({ owner: owner.current, panel, viewport: base, sidebar, changed: state => {
      if (!active) return;
      base = state.viewport; panel = state.panel;
      shell.style.setProperty("--side-window-base-width", `${base}px`);
      shell.style.setProperty("--side-window-panel-width", `${state.panel}px`);
      shell.style.setProperty("--side-window-sidebar-width", `${state.sidebar}px`);
      resolved = true; expanded = state.expanded;
      measure();
    } });
    window.addEventListener("resize", resized);
    return () => {
      active = false; observer.disconnect(); panelObserver.disconnect(); clearTimeout(revealTimeout); clearTimeout(modeTimeout); clearResizeHold(); window.removeEventListener("resize", resized);
      closing.current = expansion.release(owner.current);
    };
  }, [native, visible, root]);
  return native && (visible || layout === "restoring") ? layout : undefined;
}
