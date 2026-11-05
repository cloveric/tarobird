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
  document.addEventListener("pointerover", pointer, true);
  document.addEventListener("pointermove", pointer, true);
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("pointerout", leave, true);
  document.addEventListener("keydown", keyboard, true);
  document.addEventListener("focusin", focus, true);
  document.addEventListener("scroll", scroll, true);
  document.addEventListener("visibilitychange", clear);
  window.addEventListener("blur", clear);
  return () => {
    clear();
    document.removeEventListener("pointerover", pointer, true);
    document.removeEventListener("pointermove", pointer, true);
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("pointerout", leave, true);
    document.removeEventListener("keydown", keyboard, true);
    document.removeEventListener("focusin", focus, true);
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("visibilitychange", clear);
    window.removeEventListener("blur", clear);
  };
}
