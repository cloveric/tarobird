import { useEffect, useRef, type RefObject } from "react";

/** Inbox rows and folder headings are controls, not selectable message text. Keep native scrolling
 * and cancel a hold as soon as the finger, list or active surface moves. */
export function useConversationHold(root: RefObject<HTMLElement | null>, scope: string, enabled: boolean, open: (row: HTMLElement) => void, selector = ".mh-row[data-conversation-id][data-host-id]") {
  const latest = useRef(open); latest.current = open;
  useEffect(() => {
    if (!enabled) return;
    let pending: { pointer: number; x: number; y: number; top: number; row: HTMLElement; key: string } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let suppressClickUntil = 0;
    let touchGesture = false;
    const cancel = () => { clearTimeout(timer); timer = undefined; pending = undefined; };
    const eligible = (target: EventTarget | null) => {
      const row = target instanceof Element ? target.closest<HTMLElement>(selector) : null;
      return row && root.current?.contains(row) ? row : undefined;
    };
    const key = (row: HTMLElement) => `${row.dataset.hostId}\0${row.dataset.conversationId}\0${row.dataset.renameFolderId}`;
    const down = (event: PointerEvent) => {
      const wasPending = !!pending; cancel(); suppressClickUntil = 0;
      touchGesture = event.pointerType === "touch";
      if (wasPending || !event.isPrimary || event.pointerType !== "touch" || event.button !== 0 || document.querySelector("dialog:modal")) return;
      const row = eligible(event.target); if (!row) return;
      pending = { pointer: event.pointerId, x: event.clientX, y: event.clientY, top: row.getBoundingClientRect().top, row, key: key(row) };
      timer = setTimeout(() => {
        const held = pending; cancel();
        if (!held || document.hidden || !held.row.isConnected || !root.current?.contains(held.row) || key(held.row) !== held.key || Math.abs(held.row.getBoundingClientRect().top - held.top) > 10 || document.querySelector("dialog:modal")) return;
        suppressClickUntil = Infinity;
        latest.current(held.row);
      }, 500);
    };
    const move = (event: PointerEvent) => { if (pending?.pointer === event.pointerId && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 10) cancel(); };
    const up = () => { cancel(); if (suppressClickUntil === Infinity) suppressClickUntil = Date.now() + 800; };
    const scroll = () => { if (pending && Math.abs(pending.row.getBoundingClientRect().top - pending.top) > 10) cancel(); };
    const context = (event: MouseEvent) => {
      if (!eligible(event.target)) return;
      event.preventDefault();
      // Touch contextmenu must neither restart a cancelled hold nor reopen the
      // sheet. The row handler still supports mouse and keyboard activation.
      if (touchGesture || pending || Date.now() < suppressClickUntil || event instanceof PointerEvent && event.pointerType === "touch") event.stopImmediatePropagation();
    };
    const click = (event: MouseEvent) => { if (event.detail > 0 && Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); suppressClickUntil = 0; } };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("contextmenu", context, true);
    document.addEventListener("click", click, true);
    document.addEventListener("visibilitychange", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("contextmenu", context, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("visibilitychange", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [root, scope, enabled, selector]);
}
