import { useLayoutEffect, type RefObject } from "react";
import "./dialog-drag.css";

/** Only opt-in desktop dialogs move; touch sheets keep their scroll gestures. */
export function useDialogDrag(dialog: RefObject<HTMLElement | null>, handle: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const node = dialog.current, header = handle.current;
    if (!enabled || !node || !header) return;
    const phone = matchMedia("(max-width:760px),(hover:none) and (pointer:coarse)");
    let x = 0, y = 0, frame = 0;
    let drag: { id: number; x: number; y: number } | undefined;
    const apply = () => { node.style.translate = `${x}px ${y}px`; };
    const stop = () => {
      const id = drag?.id;
      drag = undefined;
      delete node.dataset.dragging;
      if (id !== undefined && header.hasPointerCapture(id)) header.releasePointerCapture(id);
    };
    const move = (dx: number, dy: number) => {
      const rect = node.getBoundingClientRect();
      // Keep both the title and close button reachable after dragging/resizing.
      x += Math.max(12 - rect.left, Math.min(dx, innerWidth - 12 - rect.right));
      y += Math.max(12 - rect.top, Math.min(dy, innerHeight - 12 - rect.bottom));
      apply();
    };
    const resize = () => {
      stop();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (phone.matches) { x = 0; y = 0; node.style.removeProperty("translate"); }
        else if (x || y) move(0, 0);
      });
    };
    const down = (event: PointerEvent) => {
      if (phone.matches || event.pointerType === "touch" || !event.isPrimary || event.button !== 0 || drag) return;
      if ((event.target as Element).closest("button, a, input, select, textarea, [contenteditable]")) return;
      // Finish entry motion before measuring, so grabbing during opening does
      // not make the dialog jump or leave its final bounds outside the viewport.
      for (const animation of node.getAnimations()) {
        if ((animation.effect as KeyframeEffect | null)?.target === node) animation.finish();
      }
      event.preventDefault();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      header.setPointerCapture(event.pointerId);
      node.dataset.dragging = "true";
    };
    const pointerMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      move(event.clientX - drag.x, event.clientY - drag.y);
      drag.x = event.clientX; drag.y = event.clientY;
    };
    const up = (event: PointerEvent) => { if (drag?.id === event.pointerId) stop(); };
    header.addEventListener("pointerdown", down);
    header.addEventListener("pointermove", pointerMove);
    header.addEventListener("pointerup", up);
    header.addEventListener("pointercancel", up);
    header.addEventListener("lostpointercapture", up);
    window.addEventListener("blur", stop);
    window.addEventListener("resize", resize);
    phone.addEventListener("change", resize);
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => {
      stop(); cancelAnimationFrame(frame); observer.disconnect();
      header.removeEventListener("pointerdown", down);
      header.removeEventListener("pointermove", pointerMove);
      header.removeEventListener("pointerup", up);
      header.removeEventListener("pointercancel", up);
      header.removeEventListener("lostpointercapture", up);
      window.removeEventListener("blur", stop);
      window.removeEventListener("resize", resize);
      phone.removeEventListener("change", resize);
      node.style.removeProperty("translate");
    };
  }, [dialog, handle, enabled]);
}
