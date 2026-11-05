import { useEffect, useRef, type RefObject } from 'react';

/** Capture on the stable list, not the reordered row. Only the handle owns
 * touch gestures; names and other list space keep normal scrolling. */
export function useFolderOrderDrag(root: RefObject<HTMLOListElement | null>, order: (string | null)[], enabled: boolean, change: (order: (string | null)[]) => void, announce: (order: (string | null)[], index: number) => void, sameSection: (a: string | null, b: string | null) => boolean) {
  const latest = useRef({ order, change, announce, sameSection }); latest.current = { order, change, announce, sameSection };
  useEffect(() => {
    const list = root.current;
    if (!enabled || !list) return;
    let frame = 0;
    let drag: { pointerId: number; folderId: string | null; y: number; startY: number; moved: boolean; offset: number; before: (string | null)[]; row: HTMLElement } | undefined;
    const stop = (cancel = false) => {
      const previous = drag; if (!previous) return;
      drag = undefined; cancelAnimationFrame(frame); delete list.dataset.dragging;
      delete previous.row.dataset.dragging;
      if (cancel) latest.current.change(previous.before);
      else latest.current.announce(latest.current.order, latest.current.order.indexOf(previous.folderId));
      if (list.hasPointerCapture(previous.pointerId)) list.releasePointerCapture(previous.pointerId);
    };
    const tick = () => {
      if (!drag) return;
      // Grabbing a handle alone must not scroll/reorder a long list or move a
      // row while the sheet finishes its entry animation.
      if (!drag.moved) { frame = requestAnimationFrame(tick); return; }
      const bounds = list.getBoundingClientRect();
      const distance = drag.y < bounds.top + 32 ? -8 : drag.y > bounds.bottom - 32 ? 8 : 0;
      if (distance) list.scrollTop += distance;
      const rows = [...list.querySelectorAll<HTMLElement>('[data-order-id]')];
      let target = 0, nearest = Infinity;
      rows.forEach((row, index) => {
        if (!latest.current.sameSection(drag!.folderId, row.dataset.orderId || null)) return;
        const rect = row.getBoundingClientRect(), delta = Math.abs(drag!.y - drag!.offset - (rect.top + rect.height / 2));
        if (delta < nearest) { nearest = delta; target = index; }
      });
      const current = latest.current.order, from = current.indexOf(drag.folderId);
      if (from >= 0 && from !== target) {
        const next = [...current]; next.splice(target, 0, ...next.splice(from, 1));
        latest.current.order = next; latest.current.change(next);
      }
      frame = requestAnimationFrame(tick);
    };
    const down = (event: PointerEvent) => {
      if (drag) { stop(true); return; }
      const handle = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-folder-drag-handle]') : null;
      if (!handle || handle.disabled || !event.isPrimary || event.button !== 0) return;
      const row = handle.closest<HTMLElement>('[data-order-id]');
      if (!row || !list.contains(row)) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      drag = { pointerId: event.pointerId, folderId: row.dataset.orderId || null, y: event.clientY, startY: event.clientY, moved: false, offset: event.clientY - rect.top - rect.height / 2, before: [...latest.current.order], row };
      list.setPointerCapture(event.pointerId); list.dataset.dragging = 'true'; row.dataset.dragging = 'true';
      frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) { drag.y = event.clientY; drag.moved ||= Math.abs(event.clientY - drag.startY) > 4; } };
    const up = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) stop(event.type !== 'pointerup'); };
    const cancel = () => stop(true);
    const escape = (event: KeyboardEvent) => { if (drag && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); stop(true); } };
    list.addEventListener('pointerdown', down);
    list.addEventListener('pointermove', move);
    list.addEventListener('pointerup', up);
    list.addEventListener('pointercancel', up);
    list.addEventListener('lostpointercapture', up);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('visibilitychange', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => {
      cancel();
      list.removeEventListener('pointerdown', down);
      list.removeEventListener('pointermove', move);
      list.removeEventListener('pointerup', up);
      list.removeEventListener('pointercancel', up);
      list.removeEventListener('lostpointercapture', up);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('visibilitychange', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
    };
  }, [root, enabled]);
}
