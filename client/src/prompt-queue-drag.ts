import { useLayoutEffect, useRef, type RefObject } from "react";

type Target = { id: string; after: boolean; beforeId: string | null };
type Slot = { id: string; row: HTMLElement; top: number; left: number; width: number; height: number };
type Positions = Map<HTMLElement, { top: number; left: number }>;
type Geometry = { slots: Slot[]; scroller: HTMLElement; revision: string; listWidth: number; listHeight: number };
type Options = {
  beforeSnapshot: RefObject<((ids?: string[]) => void) | undefined>;
  open: boolean;
  enabled: boolean;
  scope: string;
  revision?: string;
  resolve: (source: string, target: { id: string; after: boolean }) => { beforeId: string | null } | undefined;
  commit: (source: string, beforeId: string | null, revision: string) => Promise<{ revision: string } | undefined> | undefined;
};

/** Fixed, untransformed slots own hit testing. Only transforms preview the
 * reorder: the Host still receives exactly one revision-checked move on release. */
export function usePromptQueueDrag(root: RefObject<HTMLDivElement | null>, options: Options) {
  const latest = useRef(options); latest.current = options;
  const sync = useRef<(() => void) | undefined>(undefined);
  const save = useRef<((source: string, beforeId: string | null) => void) | undefined>(undefined);
  useLayoutEffect(() => { sync.current?.(); });
  const { open, scope, beforeSnapshot } = options;
  useLayoutEffect(() => {
    const list = root.current;
    if (!open || !list) return;
    const animations = new Map<HTMLElement, Animation>();
    let frame = 0, lastTick = 0, suppressClick = false;
    let target: Target | undefined, placeholder: HTMLDivElement | undefined, pending: Geometry | undefined;
    let prepared: { geometry: Geometry; order: string[] } | undefined;
    let drag: (Geometry & { pointerId: number; source: string; row: HTMLElement; x: number; y: number; startY: number; grabY: number; moved: boolean; buttonsReliable: boolean; width: number; height: number; listWidth: number; listHeight: number }) | undefined;
    const rows = () => [...list.querySelectorAll<HTMLElement>(":scope > [data-queue-message-id]")];
    const scrollOwner = () => {
      let scroller: HTMLElement = list;
      while (scroller.parentElement && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      return scroller;
    };
    const geometry = (scroller: HTMLElement): Geometry => ({ scroller, revision: latest.current.revision!, listWidth: list.clientWidth, listHeight: list.clientHeight, slots: rows().map(row => {
      const rect = row.getBoundingClientRect();
      return { id: row.dataset.queueMessageId!, row, top: rect.top + scroller.scrollTop, left: rect.left, width: rect.width, height: rect.height };
    }) });
    const sameRows = (state: Geometry) => Math.abs(list.clientWidth - state.listWidth) < 1
      && state.slots.every(slot => slot.row.isConnected && Math.abs(slot.row.offsetHeight - slot.height) < 1);
    const sameSize = (state: Geometry) => sameRows(state) && Math.abs(list.clientHeight - state.listHeight) < 1;
    const transformMatrix = (value: string) => new DOMMatrixReadOnly(value === "none" ? undefined : value);
    const matrix = (row: HTMLElement) => transformMatrix(getComputedStyle(row).transform);
    const clearAnimations = () => { for (const [row, animation] of animations) { animation.cancel(); delete row.dataset.queueSettling; } animations.clear(); };
    const animate = (row: HTMLElement, from: string, to: string) => {
      animations.get(row)?.cancel(); animations.delete(row);
      // Computed "matrix(...)" and authored "translateY(...)" can be equal.
      // Do not animate/promote untouched cards just because the strings differ.
      if (from === to || transformMatrix(from).toString() === transformMatrix(to).toString()) { delete row.dataset.queueSettling; return; }
      row.dataset.queueSettling = "true";
      const animation = row.animate([{ transform: from }, { transform: to }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
      animations.set(row, animation);
      animation.onfinish = () => { if (animations.get(row) === animation) { animations.delete(row); delete row.dataset.queueSettling; } };
    };
    // Reconstruct the pre-render positions even if React has already reordered
    // keyed DOM nodes. Reading their new rects here would apply offsets twice.
    const positions = (state: Geometry): Positions => new Map(state.slots.filter(slot => slot.row.isConnected).map(slot => {
      const offset = matrix(slot.row);
      return [slot.row, { top: slot.top - state.scroller.scrollTop + offset.m42, left: slot.left + offset.m41 }];
    }));
    const clearPreview = (state?: Geometry) => {
      placeholder?.remove(); placeholder = undefined;
      if (target) { const row = state?.slots.find(slot => slot.id === target!.id)?.row; row?.classList.remove("is-drop-before", "is-drop-after"); }
      target = undefined;
      for (const slot of state?.slots ?? []) { slot.row.style.removeProperty("transform"); delete slot.row.dataset.dragging; }
      delete list.dataset.dragging; delete list.dataset.queueSaving;
    };
    const settle = (before: Positions, motion = true) => {
      const offsets: { row: HTMLElement; x: number; y: number }[] = [];
      for (const [row, rect] of before) {
        if (!row.isConnected) continue;
        const after = row.getBoundingClientRect(), x = rect.left - after.left, y = rect.top - after.top;
        if (motion && Math.abs(x) + Math.abs(y) > .5) offsets.push({ row, x, y });
      }
      for (const { row, x, y } of offsets) animate(row, `translate(${x}px,${y}px)`, "none");
    };
    const finishPending = (motion = true) => {
      const state = pending; if (!state) return;
      const before = positions(state); pending = undefined;
      const compatible = sameSize(state);
      clearAnimations(); clearPreview(state); settle(before, motion && compatible);
    };
    const persist = (state: Geometry, source: string, beforeId: string | null) => {
      pending = state; list.dataset.queueSaving = "true";
      observeSize(state);
      // The snapshot render may arrive before or after this promise settles.
      // Successful saves finish on that authoritative render, never on a timer.
      void Promise.resolve(latest.current.commit(source, beforeId, state.revision)).then(result => {
        if (pending !== state) return;
        if (!result && prepared) return; // Error UI and rollback settle in one layout commit.
        if (!result || latest.current.revision === result.revision) finishPending();
      }, () => { if (pending === state) finishPending(); });
    };
    const valid = () => !!drag && latest.current.enabled && latest.current.scope === scope && latest.current.revision === drag.revision
      && drag.width === window.innerWidth && drag.height === window.innerHeight
      && (!drag.moved || sameSize(drag));
    const bounds = () => {
      const rect = list.getBoundingClientRect(), scroll = drag!.scroller.getBoundingClientRect();
      const header = drag!.scroller.matches("dialog") ? drag!.scroller.querySelector("header")?.getBoundingClientRect().bottom : undefined;
      return { left: Math.max(rect.left, scroll.left), right: Math.min(rect.right, scroll.right), top: Math.max(rect.top, scroll.top, header ?? 0), bottom: Math.min(rect.bottom, scroll.bottom, window.innerHeight) };
    };
    const locate = (): Target | undefined => {
      if (!drag?.moved || !valid()) return;
      const box = bounds(), { x, y, scroller } = drag;
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) return;
      const slot = drag.slots.find(slot => y >= slot.top - scroller.scrollTop && y <= slot.top + slot.height - scroller.scrollTop);
      // Keep the insertion while crossing a margin; animated neighbours never
      // become fresh targets and cannot make an idle finger oscillate the list.
      if (!slot) return target;
      const candidate = { id: slot.id, after: y >= slot.top + slot.height / 2 - scroller.scrollTop };
      const position = latest.current.resolve(drag.source, candidate);
      return position ? { ...candidate, ...position } : undefined;
    };
    const destinations = (state: Geometry, source: string, beforeId: string | null | undefined) => {
      const order = [...state.slots], index = order.findIndex(slot => slot.id === source);
      if (beforeId !== undefined && index >= 0) {
        const [item] = order.splice(index, 1), at = beforeId === null ? order.length : order.findIndex(slot => slot.id === beforeId);
        if (at >= 0) order.splice(at, 0, item!); else order.splice(index, 0, item!);
      }
      const first = state.slots[0]!, second = state.slots[1], gap = second ? second.top - first.top - first.height : 0;
      let top = first.top;
      return new Map(order.map(slot => { const result: [string, number] = [slot.id, top]; top += slot.height + gap; return result; }));
    };
    const highlight = (next?: Target, pickup = false) => {
      if (!drag?.moved || !pickup && target?.id === next?.id && target?.after === next?.after) return;
      const old = target; target = next;
      drag.slots.find(slot => slot.id === old?.id)?.row.classList.remove("is-drop-before", "is-drop-after");
      drag.slots.find(slot => slot.id === next?.id)?.row.classList.add(next?.after ? "is-drop-after" : "is-drop-before");
      const tops = destinations(drag, drag.source, next?.beforeId);
      const transforms = new Map(drag.slots.filter(slot => slot.id !== drag!.source).map(slot => [slot.row, getComputedStyle(slot.row).transform]));
      for (const slot of drag.slots) {
        if (slot.id === drag.source) continue;
        const from = transforms.get(slot.row)!, to = `translateY(${tops.get(slot.id)! - slot.top}px)`;
        slot.row.style.transform = to; animate(slot.row, from, to);
      }
      const source = drag.slots.find(slot => slot.id === drag!.source)!;
      if (placeholder) placeholder.style.top = `${tops.get(source.id)! - drag.slots[0]!.top + drag.slots[0]!.row.offsetTop}px`;
    };
    const follow = () => {
      if (!drag?.moved) return;
      const source = drag.slots.find(slot => slot.id === drag!.source)!, first = drag.slots[0]!, last = drag.slots.at(-1)!;
      const top = Math.max(first.top, Math.min(last.top + last.height - source.height, drag.y - drag.grabY + drag.scroller.scrollTop));
      drag.row.style.transform = `translateY(${top - source.top}px)`;
    };
    const stop = (commit = false, motion = true) => {
      if (!drag) return;
      const previous = drag, safeGeometry = valid(), destination = commit && safeGeometry ? locate() : undefined;
      if (previous.moved && destination) highlight(destination);
      const before = previous.moved ? positions(previous) : new Map();
      drag = undefined; cancelAnimationFrame(frame); frame = 0;
      suppressClick = previous.moved;
      if (list.hasPointerCapture(previous.pointerId)) list.releasePointerCapture(previous.pointerId);
      if (!previous.moved) { for (const animation of animations.values()) animation.play(); return; }
      if (destination) {
        const slot = previous.slots.find(slot => slot.id === previous.source)!;
        const from = getComputedStyle(previous.row).transform, to = `translateY(${destinations(previous, previous.source, destination.beforeId).get(previous.source)! - slot.top}px)`;
        delete previous.row.dataset.dragging; delete list.dataset.dragging;
        previous.row.style.transform = to; animate(previous.row, from, to);
        persist(previous, previous.source, destination.beforeId);
      } else { clearAnimations(); clearPreview(previous); settle(before, motion && safeGeometry); }
    };
    const tick = (time: number) => {
      frame = 0;
      if (!valid()) { stop(false, false); return; }
      const box = bounds(), elapsed = Math.min(32, time - lastTick); lastTick = time;
      if (drag!.x >= box.left && drag!.x <= box.right && drag!.y >= box.top && drag!.y <= box.bottom) {
        const edge = Math.min(36, (box.bottom - box.top) / 4);
        const speed = drag!.y < box.top + edge ? -1 : drag!.y > box.bottom - edge ? 1 : 0;
        if (speed) drag!.scroller.scrollTop += speed * elapsed * .4;
      }
      highlight(locate()); follow(); frame = requestAnimationFrame(tick);
    };
    const down = (event: PointerEvent) => {
      suppressClick = false;
      if (drag || pending || prepared || !latest.current.enabled || !event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const handle = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-queue-drag-handle]") : null;
      const row = handle?.closest<HTMLElement>("[data-queue-message-id]");
      if (!handle || handle.disabled || !row || !list.contains(row)) return;
      try { list.setPointerCapture(event.pointerId); } catch { return; }
      event.preventDefault();
      const grabY = event.clientY - row.getBoundingClientRect().top;
      for (const animation of animations.values()) animation.pause();
      drag = { slots: [], scroller: scrollOwner(), revision: latest.current.revision!, pointerId: event.pointerId, source: row.dataset.queueMessageId!, row, x: event.clientX, y: event.clientY, startY: event.clientY, grabY, moved: false, buttonsReliable: !!(event.buttons & 1), width: window.innerWidth, height: window.innerHeight, listWidth: 0, listHeight: 0 };
    };
    const move = (event: PointerEvent) => {
      if (drag?.pointerId !== event.pointerId) return;
      if (!valid()) { stop(false, false); return; }
      if (drag.buttonsReliable && !(event.buttons & 1)) { stop(); return; }
      drag.buttonsReliable ||= !!(event.buttons & 1);
      drag.x = event.clientX; drag.y = event.clientY;
      if (!drag.moved && Math.abs(drag.y - drag.startY) > 5) {
        const pickup = new Map(rows().map(row => [row, row.getBoundingClientRect()])); clearAnimations();
        Object.assign(drag, geometry(drag.scroller), { moved: true, listWidth: list.clientWidth, listHeight: list.clientHeight });
        observeSize(drag);
        for (const slot of drag.slots) { const before = pickup.get(slot.row); if (before) slot.row.style.transform = `translateY(${before.top + drag.scroller.scrollTop - slot.top}px)`; }
        list.dataset.dragging = "true"; drag.row.dataset.dragging = "true";
        placeholder = document.createElement("div"); placeholder.className = "prompt-queue-drop-slot"; placeholder.setAttribute("aria-hidden", "true");
        const source = drag.slots.find(slot => slot.id === drag!.source)!;
        Object.assign(placeholder.style, { top: `${source.row.offsetTop}px`, left: `${source.row.offsetLeft}px`, width: `${source.width}px`, height: `${source.height}px` }); list.append(placeholder);
        // A second pickup can interrupt a return animation. Even with no new
        // insertion target, neighbours must finish returning from that frame.
        highlight(locate(), true);
        lastTick = performance.now(); frame = requestAnimationFrame(tick);
      }
      if (drag.moved) { highlight(locate()); follow(); }
    };
    const up = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) { drag.x = event.clientX; drag.y = event.clientY; stop(event.type === "pointerup"); } };
    const cancel = () => stop();
    const resize = () => { stop(false, false); finishPending(false); clearAnimations(); prepared = undefined; delete list.dataset.queueUpdating; };
    const secondPointer = (event: PointerEvent) => { if (drag && event.pointerId !== drag.pointerId) stop(); };
    const escape = (event: KeyboardEvent) => { if (drag && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); stop(); } };
    const click = (event: MouseEvent) => { if (suppressClick && event.detail > 0) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); } };
    beforeSnapshot.current = nextOrder => {
      const current = rows();
      // No order means error UI is about to move/resize the list. Prepare that
      // layout change too, before a rollback can animate against the old origin.
      const order = nextOrder ?? current.map(row => row.dataset.queueMessageId!);
      if (nextOrder && current.length === order.length && current.every((row, index) => row.dataset.queueMessageId === order[index])) return;
      const state = geometry(scrollOwner());
      // Read First before setSnapshot without stopping an in-flight animation.
      // Keep its natural origin, so the layout effect can include the animation's
      // current progress even if React yields before committing the new order.
      for (const slot of state.slots) { const offset = matrix(slot.row); slot.top -= offset.m42; slot.left -= offset.m41; }
      prepared = { geometry: state, order }; list.dataset.queueUpdating = "true";
    };
    sync.current = () => {
      if (prepared && rows().map(row => row.dataset.queueMessageId).join() === prepared.order.join()) {
        const before = positions(prepared.geometry), state = prepared.geometry; prepared = undefined;
        const compatible = sameRows(state);
        stop(false, false); pending = undefined; clearAnimations(); clearPreview(state); settle(before, compatible); delete list.dataset.queueUpdating;
      }
      if (drag && !valid()) stop(false, false);
      if (pending && latest.current.revision !== pending.revision) finishPending();
    };
    save.current = (source, beforeId) => {
      if (!latest.current.enabled || pending || !latest.current.revision) return;
      stop(false, false); clearAnimations();
      persist(geometry(scrollOwner()), source, beforeId);
    };
    list.addEventListener("pointerdown", down); list.addEventListener("pointermove", move);
    list.addEventListener("pointerup", up); list.addEventListener("pointercancel", up); list.addEventListener("lostpointercapture", cancel);
    list.addEventListener("click", click, true); list.addEventListener("contextmenu", cancel);
    document.addEventListener("pointerdown", secondPointer, true); document.addEventListener("keydown", escape, true); document.addEventListener("visibilitychange", cancel);
    window.addEventListener("blur", cancel); window.addEventListener("resize", resize); window.visualViewport?.addEventListener("resize", resize);
    window.screen.orientation?.addEventListener("change", resize);
    const observer = new ResizeObserver(() => { if (drag?.moved && !valid()) stop(false, false); if (pending && !sameSize(pending)) finishPending(false); });
    const observeSize = (state: Geometry) => { observer.disconnect(); observer.observe(list); for (const slot of state.slots) observer.observe(slot.row); };
    observer.observe(list);
    return () => {
      stop(false, false); finishPending(false); clearAnimations(); prepared = undefined; delete list.dataset.queueUpdating;
      sync.current = undefined; save.current = undefined; beforeSnapshot.current = undefined; observer.disconnect();
      list.removeEventListener("pointerdown", down); list.removeEventListener("pointermove", move);
      list.removeEventListener("pointerup", up); list.removeEventListener("pointercancel", up); list.removeEventListener("lostpointercapture", cancel);
      list.removeEventListener("click", click, true); list.removeEventListener("contextmenu", cancel);
      document.removeEventListener("pointerdown", secondPointer, true); document.removeEventListener("keydown", escape, true); document.removeEventListener("visibilitychange", cancel);
      window.removeEventListener("blur", cancel); window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize);
      window.screen.orientation?.removeEventListener("change", resize);
    };
  }, [root, open, scope, beforeSnapshot]);
  return (source: string, beforeId: string | null) => save.current?.(source, beforeId);
}
