import { useEffect, useRef, type RefObject } from "react";

/** Delegated touch gesture: no per-message timers, pointer capture or blocked scrolling. */
export function useMessageHold(root: RefObject<HTMLElement | null>, scope: string, enabled: boolean, open: (messageId: string, trigger: HTMLElement) => void) {
  const latest = useRef(open); latest.current = open;
  useEffect(() => {
    if (!enabled) return;
    let pending: { id: number; x: number; y: number; row: HTMLElement; messageId: string; top: number; container: HTMLElement } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let suppressClickUntil = 0;
    const cancel = () => { clearTimeout(timer); timer = undefined; if (pending) delete pending.container.dataset.touchHold; pending = undefined; };
    const eligible = (target: EventTarget | null) => {
      const container = root.current;
      if (!container || !(target instanceof Element) || !container.contains(target) || !target.closest(".message-blocks,.message-meta")) return;
      // Author/time also opens the menu for audio-only messages without
      // stealing native player/seek gestures. Ordinary controls retain their
      // native long press. File/image primaries
      // explicitly opt in: short tap opens; holding acts on their owning message.
      const control = target.closest("button,a,input,textarea,select,label,summary,audio,video,pre,code,[role=button],[contenteditable=true]");
      if (control && !control.hasAttribute("data-message-hold")) return;
      return target.closest<HTMLElement>("article[data-message-id]") ?? undefined;
    };
    const down = (event: PointerEvent) => {
      const wasPending = !!pending;
      cancel(); suppressClickUntil = 0;
      if (wasPending || !event.isPrimary || event.pointerType !== "touch" || event.button !== 0 || document.querySelector("dialog:modal")) return;
      const row = eligible(event.target), messageId = row?.dataset.messageId;
      if (!row || !messageId || document.getSelection()?.containsNode(row, true) && document.getSelection()?.isCollapsed === false) return;
      pending = { id: event.pointerId, x: event.clientX, y: event.clientY, row, messageId, top: row.getBoundingClientRect().top, container: root.current! };
      pending.container.dataset.touchHold = "true";
      timer = setTimeout(() => {
        const held = pending; cancel();
        if (!held || !held.row.isConnected || held.row.dataset.messageId !== held.messageId || document.hidden || document.querySelector("dialog:modal") || !root.current?.contains(held.row)) return;
        suppressClickUntil = Infinity;
        latest.current(held.messageId, held.row);
      }, 500);
    };
    const move = (event: PointerEvent) => {
      if (pending && event.pointerId === pending.id && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 10) cancel();
    };
    const up = () => { cancel(); if (suppressClickUntil === Infinity) suppressClickUntil = Date.now() + 800; };
    const selection = () => { if (pending && document.getSelection()?.isCollapsed === false && document.getSelection()?.containsNode(pending.row, true)) cancel(); };
    const scrolled = (event: Event) => {
      if (pending && event.target === pending.container && Math.abs(pending.row.getBoundingClientRect().top - pending.top) > 10) cancel();
    };
    const context = (event: MouseEvent) => {
      if (pending && eligible(event.target) || Date.now() < suppressClickUntil) event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      // The finger that opened the sheet must never activate a newly covered
      // file/button. A genuinely new pointerdown clears this guard immediately.
      if (event.detail > 0 && Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); suppressClickUntil = 0; }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("scroll", scrolled, true);
    document.addEventListener("selectionchange", selection);
    document.addEventListener("visibilitychange", cancel);
    document.addEventListener("contextmenu", context, true);
    document.addEventListener("click", click, true);
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("selectionchange", selection);
      document.removeEventListener("visibilitychange", cancel);
      document.removeEventListener("contextmenu", context, true);
      document.removeEventListener("click", click, true);
      window.removeEventListener("blur", cancel);
    };
  }, [root, scope, enabled]);
}
