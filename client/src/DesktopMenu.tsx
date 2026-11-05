import "./desktop-menu.css";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useBackAction } from "./back-navigation.js";

/** Compact conversations clip their content; menus escape to the shared overlay. */
export const DesktopMenuPortalContext = createContext(false);

/** A desktop disclosure popover anchored to its trigger (the caller renders the
 * trigger with aria-expanded / aria-controls). Items stay ordinary buttons, so their
 * accessible names are their visible labels. Escape and Tab close it and return
 * focus to the trigger; a pointer press outside closes it without moving focus;
 * arrows, Home and End move between enabled buttons. Activating a button moves
 * focus to the trigger before closing, so a dialog opened by the item restores
 * focus there. Items that move focus to the composer can opt out with
 * restoreFocusOnSelect. Buttons marked data-menu-keep stay open (toggles). Callers close
 * the popover when its target changes (chat, host or layout). */
export function DesktopMenu({ id, label, open, close, trigger, placement, point, portalTarget, restoreFocusOnSelect = true, onDismiss, className = "", children }: { id: string; label: string; open: boolean; close: () => void; trigger: RefObject<HTMLElement | null>; placement: "down-start" | "down-end" | "up-start" | "up-end"; point?: { x: number; y: number }; portalTarget?: Element | null; restoreFocusOnSelect?: boolean; onDismiss?(): void; className?: string; children: ReactNode }) {
  const floating = useContext(DesktopMenuPortalContext) && !point;
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number; maxHeight?: number } | undefined>(point);
  const closeRef = useRef(close); closeRef.current = close;
  const dismiss = () => { trigger.current?.focus({ preventScroll: true }); closeRef.current(); onDismiss?.(); };
  useBackAction(panel, () => { if (!open) return false; dismiss(); });
  useLayoutEffect(() => {
    if (!open || !panel.current || !point && !floating) return;
    const node = panel.current;
    const measure = () => {
      if (point) { setPosition({ x: Math.max(8, Math.min(point.x, innerWidth - node.offsetWidth - 8)), y: Math.max(8, Math.min(point.y, innerHeight - node.offsetHeight - 8)) }); return; }
      const anchor = trigger.current?.getBoundingClientRect(); if (!anchor) return;
      const above = Math.max(0, anchor.top - 14), below = Math.max(0, innerHeight - anchor.bottom - 14);
      const preferAbove = placement.startsWith("up"), naturalHeight = node.scrollHeight + node.offsetHeight - node.clientHeight;
      const up = preferAbove ? above >= naturalHeight || above > below : below < naturalHeight && above > below;
      const maxHeight = Math.max(1, up ? above : below), height = Math.min(naturalHeight, maxHeight);
      const x = Math.max(8, Math.min(placement.endsWith("end") ? anchor.right - node.offsetWidth : anchor.left, innerWidth - node.offsetWidth - 8));
      const y = Math.max(8, Math.min(up ? anchor.top - height - 6 : anchor.bottom + 6, innerHeight - height - 8));
      setPosition(old => old?.x === x && old.y === y && old.maxHeight === maxHeight ? old : { x, y, maxHeight });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    // Focus/right-click can enqueue an ancestor scroll before this menu opens.
    // That already-applied move must not dismiss the freshly opened menu.
    const offsets = new Map<Element, { x: number; y: number }>();
    for (let ancestor: Element | null = trigger.current; ancestor; ancestor = ancestor.parentElement) offsets.set(ancestor, { x: ancestor.scrollLeft, y: ancestor.scrollTop });
    const moved = (event: Event) => {
      if (event.target instanceof Node && node.contains(event.target)) return;
      const target = event.target === document ? document.scrollingElement : event.target;
      if (event.type === "scroll" && target instanceof Element) {
        const previous = offsets.get(target);
        // A streaming chat can scroll while a sidebar/pane menu is open.
        // Only an ancestor can move this anchored popover; another pane must
        // not dismiss it between pointer-down and selection.
        if (!previous) return;
        if (previous && previous.x === target.scrollLeft && previous.y === target.scrollTop) return;
      }
      closeRef.current();
    };
    window.addEventListener("resize", moved); document.addEventListener("scroll", moved, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", moved); document.removeEventListener("scroll", moved, true); };
  }, [open, point, floating, placement, trigger]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { const target = event.target as Node | null; if (target && !panel.current?.contains(target) && (point || !trigger.current?.contains(target))) closeRef.current(); };
    const escape = (event: KeyboardEvent) => { if (event.key !== "Escape" || event.defaultPrevented) return; event.preventDefault(); dismiss(); };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
  }, [open, trigger, point]);
  if (!open) return null;
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
    if (event.key === "Tab") { event.preventDefault(); dismiss(); return; }
    const items = [...panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement), last = items.length - 1;
    const next = event.key === "ArrowDown" ? (current < 0 || current === last ? 0 : current + 1) : event.key === "ArrowUp" ? (current <= 0 ? last : current - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    if (next < 0) return;
    event.preventDefault(); items[next]?.focus({ preventScroll: true });
  };
  // Bubbles after the item's own handler, which has already scheduled its dialog.
  const chosen = (event: ReactMouseEvent<HTMLDivElement>) => {
    const item = (event.target as HTMLElement).closest("button");
    if (!item || item.disabled || item.dataset.menuKeep !== undefined || !panel.current?.contains(item)) return;
    if (restoreFocusOnSelect) dismiss(); else closeRef.current();
  };
  // Menus nested in a draggable title row must also exclude their headings,
  // separators and padding from native window dragging, not only their buttons.
  const content = <div ref={panel} id={id} data-tauri-drag-region="false" role={point ? "menu" : "group"} aria-label={label} style={point || floating ? { left: position?.x ?? point?.x ?? 8, top: position?.y ?? point?.y ?? 8, ...(floating ? { maxHeight: position?.maxHeight } : {}) } : undefined} className={`desktop-menu ${point ? "desktop-menu-context" : floating ? "desktop-menu-floating" : `desktop-menu-${placement}`} ${className}`.trim()} onKeyDown={keys} onClick={chosen}>{children}</div>;
  // Native modal dialogs are above body portals and make those portals inert.
  return point || floating ? createPortal(content, portalTarget ?? document.body) : content;
}
