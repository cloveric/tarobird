import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import "./side-conversation.css";

/** Shared width allocation and keyboard/pointer behavior for both right-hand surfaces. */
export function SidePanelResize({panel,visible,controls,label}: {panel:RefObject<HTMLElement|null>;visible:boolean;controls:string;label:string}) {
  const splitter = useRef<HTMLDivElement>(null), drag = useRef<{pointer:number;x:number;width:number}|undefined>(undefined);
  const [size,setSize] = useState({width:400,min:320,max:400});
  const bounds = useCallback(() => {
    const shell = panel.current?.parentElement, width = shell?.clientWidth ?? innerWidth;
    const sidebar = shell?.querySelector<HTMLElement>(":scope > .sidebar")?.getBoundingClientRect().width ?? 0;
    if (shell?.dataset.sideWindow === "pending") return { min: 320, max: Math.max(320, width - sidebar - 24) };
    // Match the CSS allocation; only the other columns limit the maximum width.
    const min = Math.min(320, Math.max(280, (width - 200) / 2));
    const base = shell?.dataset.sideWindow === "expanded" ? parseFloat(shell.style.getPropertyValue("--side-window-base-width")) : NaN;
    const main = Number.isFinite(base) ? Math.min(440, base - sidebar) : Math.min(440, Math.max(280, (width - 200) / 2));
    return { min, max: Math.max(min, width - sidebar - main) };
  }, []);
  const setWidth = (value: number) => { const { min, max } = bounds(); document.documentElement.style.setProperty("--side-panel-width", `${Math.min(max, Math.max(min, value))}px`); };
  const stopDrag = useCallback(() => {
    const pointer = drag.current?.pointer; drag.current = undefined; delete document.documentElement.dataset.sideResizing;
    if (pointer !== undefined && splitter.current?.hasPointerCapture(pointer)) splitter.current.releasePointerCapture(pointer);
  }, []);
  const resetWidth = () => { stopDrag(); document.documentElement.style.removeProperty("--side-panel-width"); };
  // The parent owns the aside ref. Passive effects run after that parent ref
  // is attached; a child's layout effect can otherwise miss the initial mount.
  useEffect(() => {
    if (!visible || !panel.current) return;
    const measure = () => { setSize({ width: Math.round(panel.current!.getBoundingClientRect().width), ...bounds() });  };
    const observer = new ResizeObserver(measure); observer.observe(panel.current); observer.observe(panel.current.parentElement!); measure();
    window.addEventListener("blur", stopDrag); window.addEventListener("resize", stopDrag);
    return () => { observer.disconnect(); window.removeEventListener("blur", stopDrag); window.removeEventListener("resize", stopDrag); stopDrag(); };
  }, [visible, bounds, stopDrag]);
  return (
<div ref={splitter} className="side-resize-handle" role="separator" aria-orientation="vertical" aria-controls={controls} aria-label={label} aria-valuemin={Math.round(size.min)} aria-valuemax={Math.round(size.max)} aria-valuenow={size.width} tabIndex={visible ? 0 : -1}
      onDoubleClick={resetWidth} onPointerDown={event => { if (!event.isPrimary || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); drag.current = { pointer: event.pointerId, x: event.clientX, width: panel.current!.getBoundingClientRect().width }; event.currentTarget.setPointerCapture(event.pointerId); document.documentElement.dataset.sideResizing = "true"; }}
      onPointerMove={event => { const current = drag.current; if (current?.pointer === event.pointerId) setWidth(current.width + current.x - event.clientX); }} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
      onKeyDown={event => { const width = panel.current!.getBoundingClientRect().width; if (event.key === "ArrowLeft") setWidth(width + (event.shiftKey ? 32 : 8)); else if (event.key === "ArrowRight") setWidth(width - (event.shiftKey ? 32 : 8)); else if (event.key === "Home") setWidth(bounds().min); else if (event.key === "End") setWidth(bounds().max); else if (event.key === "Enter") resetWidth(); else if (event.key === "Escape" && drag.current) { setWidth(drag.current.width); stopDrag(); } else return; event.preventDefault(); event.stopPropagation(); }}/>
  );
}
