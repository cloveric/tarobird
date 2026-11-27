import { addGlobalListener } from "./global-event-hub.js";

/** A single pointer-owned toolbar, including across ADHD panes. Delegation
 * avoids React renders on mouse movement and does not depend on WebKit's
 * retained :hover state on transformed/streaming message rows. */
export function installMessageActionHover(): () => void {
  let active: HTMLElement | undefined;
  const set = (next?: HTMLElement) => {
    if (next === active) return;
    if (active) delete active.dataset.actionsHover;
    active = next;
    if (active) active.dataset.actionsHover = "true";
  };
  const clear = () => set();
  const scroll = (event: Event) => {
    // Other ADHD panes and side logs can auto-follow their own replies. Only
    // an ancestor scroll can move this row away from the stationary pointer.
    if (!active) return;
    if (!active.isConnected || event.target === document
      || event.target instanceof Element && event.target.contains(active)) clear();
  };
  const pointer = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") { clear(); return; }
    const target = event.target;
    const row = target instanceof Element && !target.closest("dialog,[inert]")
      ? target.closest<HTMLElement>(".message-scroll article.message[data-message-id]") : null;
    set(row?.querySelector(".message-actions") ? row : undefined);
  };
  const leave = (event: PointerEvent) => { if (!event.relatedTarget) clear(); };
  const keyboard = () => {
    // Installed after focus-intent; keyboard-visible focus owns the toolbar
    // until actual pointer movement/down resumes. Do not blur the control.
    if (document.documentElement.dataset.focusIntent === "keyboard") clear();
  };
  const focus = (event: FocusEvent) => { if (event.target instanceof Element && event.target.closest("dialog")) clear(); };
  const cleanups = [
    addGlobalListener(document, "pointerover", pointer, { capture: true }),
    addGlobalListener(document, "pointermove", pointer, { capture: true }),
    addGlobalListener(document, "pointerdown", pointer, { capture: true }),
    addGlobalListener(document, "pointerout", leave, { capture: true }),
    addGlobalListener(document, "keydown", keyboard, { capture: true }),
    addGlobalListener(document, "focusin", focus, { capture: true }),
    addGlobalListener(document, "scroll", scroll, { capture: true }),
    addGlobalListener(document, "visibilitychange", clear),
    addGlobalListener(window, "blur", clear),
  ];
  return () => {
    clear();
    for (const cleanup of cleanups) cleanup();
  };
}
