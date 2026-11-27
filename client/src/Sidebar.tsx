import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { addGlobalListener } from "./global-event-hub.js";
import { t, useLocale } from "./i18n.js";
import "./sidebar-resize.css";

const property = "--desktop-sidebar-width";
const minimum = 200;

/** Width belongs to this window, not a host or persisted preference. The root
 * custom property shares it across mounted hosts and resets on a fresh launch. */
export function Sidebar({ shown, active, children }: { shown: boolean; active: boolean; children: ReactNode }) {
  useLocale();
  const id = useId(), sidebar = useRef<HTMLElement>(null), handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; width: number; pendingWidth?: number; frame?: number } | undefined>(undefined);
  const [size, setSize] = useState({ width: 272, max: 480 });
  const bounds = useCallback(() => {
    const shell = sidebar.current?.parentElement, width = shell?.clientWidth ?? innerWidth;
    const compact = Math.max(280, (width - minimum) / 2);
    const reserved = shell?.classList.contains("has-side-panel") && shell.dataset.sideWindow !== "pending" ? Math.min(320, compact) + Math.min(440, compact) : 360;
    return Math.max(minimum, Math.min(480, width - reserved));
  }, []);
  const setWidth = useCallback((width: number) => {
    const clamped = Math.round(Math.max(minimum, Math.min(bounds(), width)));
    const value = `${clamped}px`;
    document.documentElement.style.setProperty(property, value);
    const shell = sidebar.current?.parentElement;
    if (shell?.dataset.sideWindow === "expanded" || shell?.dataset.sideWindow === "pending") shell.style.setProperty("--side-window-sidebar-width", value);
    return clamped;
  }, [bounds]);
  const measureNow = useCallback(() => {
    const node = sidebar.current;
    if (!node) return;
    const width = Math.round(node.getBoundingClientRect().width);
    if (width > 0) {
      const max = bounds();
      setSize(old => old.width === width && old.max === max ? old : { width, max });
    }
  }, [bounds]);
  const stop = useCallback((flush = true) => {
    const activeDrag = drag.current;
    if (!activeDrag) return;
    if (activeDrag.frame !== undefined) {
      cancelAnimationFrame(activeDrag.frame);
      activeDrag.frame = undefined;
    }
    if (flush && activeDrag.pendingWidth !== undefined) {
      setWidth(activeDrag.pendingWidth);
    }
    const pointer = activeDrag.id;
    drag.current = undefined;
    delete document.documentElement.dataset.sidebarResizing;
    if (handle.current?.hasPointerCapture(pointer)) handle.current.releasePointerCapture(pointer);
    measureNow();
  }, [measureNow, setWidth]);
  const reset = () => {
    stop(false);
    const shell = sidebar.current?.parentElement;
    if (shell?.dataset.sideWindow === "expanded" || shell?.dataset.sideWindow === "pending") {
      setWidth(parseFloat(getComputedStyle(shell).getPropertyValue("--desktop-sidebar-default")) || 272);
    }
    document.documentElement.style.removeProperty(property);
    measureNow();
  };
  useLayoutEffect(() => {
    if (!active || !sidebar.current) return;
    let measureFrame = 0;
    const scheduleMeasure = () => {
      if (drag.current || measureFrame) return;
      measureFrame = requestAnimationFrame(() => {
        measureFrame = 0;
        measureNow();
      });
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(sidebar.current); observer.observe(sidebar.current.parentElement!);
    // Opening/closing a side panel changes the limit even if the current
    // directory width still fits and no resize notification is delivered.
    const layout = new MutationObserver(scheduleMeasure);
    layout.observe(sidebar.current.parentElement!, { attributes: true, attributeFilter: ["class", "data-side-window"] });
    measureNow();
    const stopBlur = addGlobalListener(window, "blur", () => stop(true));
    const stopResize = addGlobalListener(window, "resize", () => stop(true));
    return () => { cancelAnimationFrame(measureFrame); observer.disconnect(); layout.disconnect(); stopBlur(); stopResize(); stop(true); };
  }, [active, measureNow, stop]);
  return <aside ref={sidebar} id={id} className={`sidebar ${shown ? "shown" : ""}`}>
    {children}
    <div ref={handle} className="sidebar-resize-handle" role="separator" aria-orientation="vertical" aria-controls={id}
      aria-label={t("调整侧栏宽度")} title={t("拖动调整侧栏宽度，双击恢复默认")}
      aria-valuemin={minimum} aria-valuemax={size.max} aria-valuenow={size.width} tabIndex={active ? 0 : -1}
      onDoubleClick={reset}
      onPointerDown={event => {
        if (!active || !event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
        drag.current = { id: event.pointerId, x: event.clientX, width: sidebar.current!.getBoundingClientRect().width };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.documentElement.dataset.sidebarResizing = "true";
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (current?.id !== event.pointerId) return;
        current.pendingWidth = current.width + event.clientX - current.x;
        if (current.frame === undefined) {
          current.frame = requestAnimationFrame(() => {
            if (drag.current !== current || current.pendingWidth === undefined) return;
            current.frame = undefined;
            const nextWidth = setWidth(current.pendingWidth);
            current.pendingWidth = undefined;
            if (handle.current) handle.current.setAttribute("aria-valuenow", String(nextWidth));
          });
        }
      }}
      onPointerUp={event => { if (drag.current?.id === event.pointerId) stop(true); }}
      onPointerCancel={() => stop(true)} onLostPointerCapture={() => stop(true)}
      onKeyDown={event => {
        if (!active) return;
        const width = sidebar.current!.getBoundingClientRect().width;
        if (event.key === "ArrowLeft") { setWidth(width - (event.shiftKey ? 32 : 8)); measureNow(); }
        else if (event.key === "ArrowRight") { setWidth(width + (event.shiftKey ? 32 : 8)); measureNow(); }
        else if (event.key === "Home") { setWidth(minimum); measureNow(); }
        else if (event.key === "End") { setWidth(bounds()); measureNow(); }
        else if (event.key === "Enter") reset();
        else if (event.key === "Escape" && drag.current) { const startWidth = drag.current.width; stop(false); setWidth(startWidth); measureNow(); }
        else return;
        event.preventDefault(); event.stopPropagation();
      }}/>
  </aside>;
}
