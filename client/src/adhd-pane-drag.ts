import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const headerSelector = ".conversation-header,.adhd-card-bar";
const interactiveSelector = "button,a,input,textarea,select,label,summary,dialog,.desktop-menu,[role=button],[role=link],[role=menu],[role=menuitem],[role=dialog],[role=listbox],[role=option],[role=tab],[role=switch],[role=checkbox],[contenteditable]:not([contenteditable=false]),[tabindex]";
type Slot = { key: string; row: HTMLElement; rect: DOMRect };
type Positions = Map<HTMLElement, DOMRect>;

/** Keep live panes mounted. Hit-test their original grid slots, never animated
 * rectangles: a neighbouring pane moving out of the way is not a new target. */
export function useAdhdPaneDrag(root: RefObject<HTMLDivElement | null>, keys: string[], enabled: boolean, reorder: (key: string, destination: number) => void) {
  const latest = useRef({ keys, reorder }); latest.current = { keys, reorder };
  const sync = useRef<(() => void) | undefined>(undefined);
  const prepare = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => { sync.current?.(); });
  useEffect(() => {
    const grid = root.current;
    if (!grid) return;
    const animations = new Map<HTMLElement, Animation>();
    let frame = 0, lastFrame = 0, suppressClick = false;
    let target: Slot | undefined, placeholder: HTMLDivElement | undefined, pending: Positions | undefined;
    let scrollPositions: { node: HTMLElement; top: number; left: number }[] | undefined;
    let drag: { id: number; key: string; row: HTMLElement; x: number; y: number; startX: number; startY: number; grabX: number; grabY: number; buttonsReliable: boolean; moved: boolean;
      slots: Slot[]; scrollX: number; scrollY: number; width: number; height: number; contentWidth: number; contentHeight: number } | undefined;
    if (enabled) grid.dataset.adhdReorderable = "true";

    const clearAnimations = () => {
      for (const [row, animation] of animations) { animation.cancel(); delete row.dataset.adhdSettling; }
      animations.clear();
    };
    const animate = (row: HTMLElement, from: string, to: string) => {
      animations.get(row)?.cancel(); animations.delete(row);
      if (from === to) { delete row.dataset.adhdSettling; return; }
      const animation = row.animate([{ transform: from }, { transform: to }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
      animations.set(row, animation);
      animation.onfinish = () => {
        if (animations.get(row) !== animation) return;
        animations.delete(row); delete row.dataset.adhdSettling;
      };
    };
    const settle = (positions: Positions) => {
      for (const [row, before] of positions) {
        if (!row.isConnected || row.hidden) continue;
        const after = row.getBoundingClientRect(), x = before.left - after.left, y = before.top - after.top;
        if (Math.abs(x) + Math.abs(y) < .5) continue;
        row.dataset.adhdSettling = "true";
        animate(row, `translate(${x}px,${y}px)`, "none");
      }
    };
    const highlight = (next?: Slot) => {
      if (target === next) return;
      if (target) delete target.row.dataset.adhdDropTarget;
      target = next;
      if (target) target.row.dataset.adhdDropTarget = "true";
      if (!drag?.moved) return;
      const { slots, key } = drag, source = slots.findIndex(slot => slot.key === key);
      const destination = target ? slots.indexOf(target) : source;
      const order = [...slots]; order.splice(destination, 0, order.splice(source, 1)[0]!);
      for (const slot of slots) {
        if (slot.key === key) continue;
        const position = slots[order.indexOf(slot)]!.rect;
        const transform = `translate(${position.left - slot.rect.left}px,${position.top - slot.rect.top}px)`;
        const from = getComputedStyle(slot.row).transform;
        slot.row.style.transform = transform; animate(slot.row, from, transform);
      }
      if (placeholder) {
        const rect = slots[destination]!.rect, bounds = grid.getBoundingClientRect();
        Object.assign(placeholder.style, { left: `${rect.left - bounds.left + drag.scrollX - grid.clientLeft}px`, top: `${rect.top - bounds.top + drag.scrollY - grid.clientTop}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      }
    };
    const stop = (commit = false, motion = true) => {
      const previous = drag, destination = target?.key;
      const positions: Positions = new Map(previous?.moved ? previous.slots.map(slot => [slot.row, slot.row.getBoundingClientRect()]) : []);
      drag = undefined; cancelAnimationFrame(frame); frame = 0; lastFrame = 0;
      highlight(); placeholder?.remove(); placeholder = undefined; delete grid.dataset.adhdDragging;
      if (!previous) return;
      suppressClick = previous.moved;
      if (!previous.moved) {
        for (const animation of animations.values()) animation.play();
        if (grid.hasPointerCapture(previous.id)) grid.releasePointerCapture(previous.id);
        return;
      }
      clearAnimations();
      for (const slot of previous.slots) slot.row.style.removeProperty("transform");
      delete previous.row.dataset.adhdDragging;
      if (grid.hasPointerCapture(previous.id)) grid.releasePointerCapture(previous.id);
      if (commit && previous.moved && destination && latest.current.keys.includes(previous.key)) {
        const index = latest.current.keys.indexOf(destination);
        if (index >= 0 && index !== latest.current.keys.indexOf(previous.key)) {
          pending = positions; latest.current.reorder(previous.key, index); return;
        }
      }
      if (motion) settle(positions);
    };
    prepare.current = () => {
      if (drag) stop(false, false);
      pending ??= new Map([...grid.querySelectorAll<HTMLElement>(":scope > [data-pane-key]")].filter(row => !row.hidden).map(row => [row, row.getBoundingClientRect()]));
      // React preserves component state, but moving an existing DOM subtree
      // resets nested scroll offsets in Chromium/WKWebView. Restore all panes,
      // including neighbours physically moved by React's keyed reconciliation.
      scrollPositions = [grid, ...grid.querySelectorAll<HTMLElement>(".message-scroll,.composer textarea,pre")].map(node => ({ node, top: node.scrollTop, left: node.scrollLeft }));
      clearAnimations();
    };
    sync.current = () => {
      if (scrollPositions) {
        for (const { node, top, left } of scrollPositions) if (node.isConnected) node.scrollTo({ top, left, behavior: "instant" });
        scrollPositions = undefined;
      }
      if (pending) { const positions = pending; pending = undefined; settle(positions); }
      // A pane added/removed while dragging invalidates the original slots.
      if (drag?.moved && (drag.slots.length !== latest.current.keys.length || drag.slots.some((slot, i) => slot.key !== latest.current.keys[i]))) stop(false, false);
    };
    const locate = () => {
      if (!drag?.moved) return;
      const bounds = grid.getBoundingClientRect(), { x, y } = drag;
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) { highlight(); return; }
      const dx = grid.scrollLeft - drag.scrollX, dy = grid.scrollTop - drag.scrollY;
      const slot = drag.slots.find(({ rect }) => x >= rect.left - dx && x <= rect.right - dx && y >= rect.top - dy && y <= rect.bottom - dy);
      // Gaps keep the visible insertion slot, so crossing a gutter does not
      // send neighbours back home for a frame. Leaving the board still cancels.
      if (!slot) return;
      highlight(slot?.key !== drag.key ? slot : undefined);
    };
    const followPointer = () => {
      if (!drag?.moved) return;
      const rect = grid.getBoundingClientRect(), source = drag.slots.find(slot => slot.key === drag!.key)!.rect;
      // Do not let transforms grow the scrollable canvas as the pointer exits.
      const left = source.left - rect.left + drag.scrollX, top = source.top - rect.top + drag.scrollY;
      const dx = Math.max(-left, Math.min(drag.contentWidth - left - source.width, drag.x - drag.grabX - source.left + grid.scrollLeft - drag.scrollX));
      const dy = Math.max(-top, Math.min(drag.contentHeight - top - source.height, drag.y - drag.grabY - source.top + grid.scrollTop - drag.scrollY));
      drag.row.style.transform = `translate(${dx}px,${dy}px)`;
    };
    const tick = (timestamp: number) => {
      if (!drag?.moved) return;
      if (!drag.row.isConnected || !latest.current.keys.includes(drag.key)) { stop(false, false); return; }
      const rect = grid.getBoundingClientRect();
      if (Math.abs(rect.width - drag.width) > 1 || Math.abs(rect.height - drag.height) > 1 || drag.slots.some(slot => Math.abs(slot.row.offsetWidth - slot.rect.width) > 1 || Math.abs(slot.row.offsetHeight - slot.rect.height) > 1)) { stop(false, false); return; }
      // Only the board scrolls; the pane's transcript and editor stay intact.
      const step = Math.min(32, lastFrame ? timestamp - lastFrame : 16) * .5; lastFrame = timestamp;
      if (drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom) {
        grid.scrollLeft += drag.x < rect.left + 28 ? -step : drag.x > rect.right - 28 ? step : 0;
        grid.scrollTop += drag.y < rect.top + 28 ? -step : drag.y > rect.bottom - 28 ? step : 0;
      }
      locate();
      followPointer();
      frame = requestAnimationFrame(tick);
    };
    const down = (event: PointerEvent) => {
      suppressClick = false;
      const element = event.target instanceof Element ? event.target : null;
      const header = element?.closest<HTMLElement>(headerSelector), handle = element?.closest<HTMLButtonElement>(".adhd-grip");
      if (!enabled || drag || !header || !event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (handle ? handle.disabled : header.classList.contains("history-search-header") || element?.closest(interactiveSelector)) return;
      const row = header.closest<HTMLElement>("[data-pane-key]"), key = row?.dataset.paneKey;
      if (!row || !key || !grid.contains(row) || !latest.current.keys.includes(key)) return;
      // Portalled/overlay controls must not inherit dragging from a header.
      const rect = header.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      if (handle) { event.preventDefault(); handle.focus({ preventScroll: true }); }
      const pickup = row.getBoundingClientRect();
      for (const animation of animations.values()) animation.pause();
      drag = { id: event.pointerId, key, row, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, grabX: event.clientX - pickup.left, grabY: event.clientY - pickup.top, buttonsReliable: !!(event.buttons & 1), moved: false,
        slots: [], scrollX: 0, scrollY: 0, width: 0, height: 0, contentWidth: 0, contentHeight: 0 };
      grid.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      // Some WKWebView native input paths report buttons=0 even on down and
      // during a captured drag. Trust a missing button only after this gesture
      // has actually reported it pressed; up/cancel/blur still always cancel.
      if (drag.buttonsReliable && !(event.buttons & 1)) { stop(); return; }
      drag.buttonsReliable ||= !!(event.buttons & 1);
      if (!drag.row.isConnected || !latest.current.keys.includes(drag.key)) { stop(false, false); return; }
      drag.x = event.clientX; drag.y = event.clientY;
      if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 6) {
        const pickup = new Map([...animations.keys()].map(row => [row, row.getBoundingClientRect()]));
        clearAnimations();
        drag.slots = [...grid.querySelectorAll<HTMLElement>(":scope > [data-pane-key]")].filter(row => !row.hidden).map(row => ({ row, key: row.dataset.paneKey!, rect: row.getBoundingClientRect() }));
        for (const slot of drag.slots) {
          const before = pickup.get(slot.row);
          if (before) slot.row.style.transform = `translate(${before.left - slot.rect.left}px,${before.top - slot.rect.top}px)`;
        }
        const bounds = grid.getBoundingClientRect();
        Object.assign(drag, { moved: true, scrollX: grid.scrollLeft, scrollY: grid.scrollTop, width: bounds.width, height: bounds.height, contentWidth: grid.scrollWidth, contentHeight: grid.scrollHeight });
        drag.row.querySelector<HTMLButtonElement>(".adhd-grip")?.focus({ preventScroll: true });
        grid.dataset.adhdDragging = "true"; drag.row.dataset.adhdDragging = "true";
        placeholder = document.createElement("div"); placeholder.className = "adhd-drop-slot"; placeholder.setAttribute("aria-hidden", "true"); grid.append(placeholder);
        target = drag.slots.find(slot => slot.key === drag!.key); highlight();
        frame = requestAnimationFrame(tick);
      }
      if (drag.moved) locate();
    };
    const up = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      // Resize events/rAF may arrive after pointerup in a native WebView. Do
      // not commit stale slot geometry even in that last-frame race.
      const bounds = grid.getBoundingClientRect();
      if (drag.moved && (Math.abs(bounds.width - drag.width) > 1 || Math.abs(bounds.height - drag.height) > 1 || drag.slots.some(slot => Math.abs(slot.row.offsetWidth - slot.rect.width) > 1 || Math.abs(slot.row.offsetHeight - slot.rect.height) > 1))) { stop(false, false); return; }
      drag.x = event.clientX; drag.y = event.clientY;
      if (event.type === "pointerup" && drag.moved) { locate(); followPointer(); }
      stop(event.type === "pointerup");
    };
    const click = (event: MouseEvent) => {
      if (suppressClick && event.detail > 0) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const cancel = () => stop();
    const escape = (event: KeyboardEvent) => {
      if (drag && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); stop(); }
    };
    grid.addEventListener("pointerdown", down); grid.addEventListener("pointermove", move);
    grid.addEventListener("pointerup", up); grid.addEventListener("pointercancel", up);
    grid.addEventListener("lostpointercapture", cancel); grid.addEventListener("click", click, true); grid.addEventListener("contextmenu", cancel);
    document.addEventListener("keydown", escape, true); document.addEventListener("visibilitychange", cancel);
    window.addEventListener("blur", cancel); window.addEventListener("resize", cancel);
    return () => {
      stop(false, false); clearAnimations(); pending = undefined; scrollPositions = undefined; sync.current = undefined; prepare.current = undefined; delete grid.dataset.adhdReorderable;
      grid.removeEventListener("pointerdown", down); grid.removeEventListener("pointermove", move);
      grid.removeEventListener("pointerup", up); grid.removeEventListener("pointercancel", up);
      grid.removeEventListener("lostpointercapture", cancel); grid.removeEventListener("click", click, true); grid.removeEventListener("contextmenu", cancel);
      document.removeEventListener("keydown", escape, true); document.removeEventListener("visibilitychange", cancel);
      window.removeEventListener("blur", cancel); window.removeEventListener("resize", cancel);
    };
  }, [root, enabled]);
  return () => prepare.current?.();
}
