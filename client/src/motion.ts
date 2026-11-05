/** App motion stays enabled; keep interaction-safe animation lifetimes. */
const scenes = new Set<Animation>();

function trackScene(animation: Animation): void {
  scenes.add(animation);
  const release = () => { scenes.delete(animation); };
  void animation.finished.then(release, release);
}

export function installMotion(): () => void {
  document.documentElement.dataset.motion = "full";
  // Hold the hit target still between down and click. Cancelling a translated
  // page on pointerdown moves its controls before pointerup and loses clicks.
  const paused = new Set<Animation>();
  let releaseTimer: number | undefined;
  const clearRelease = () => { window.clearTimeout(releaseTimer); releaseTimer = undefined; };
  const stop = () => { clearRelease(); for (const animation of scenes) animation.cancel(); paused.clear(); };
  const hold = () => {
    clearRelease();
    for (const animation of scenes) {
      if (animation.playState === "idle" || animation.playState === "finished") continue;
      animation.pause(); paused.add(animation);
    }
  };
  const settle = (animations: Iterable<Animation>) => {
    for (const animation of animations) { animation.cancel(); paused.delete(animation); }
  };
  // The browser has already resolved the click target before capture runs.
  const click = () => { clearRelease(); settle(paused); };
  const release = () => {
    // Native touch click synthesis can cross a frame/process boundary. Keep
    // geometry stable until click, never settle in the first rAF after up.
    // If a gesture produces no click/cancel, resume smoothly as a bounded fallback.
    // Normal clicks are handled immediately above, with no timer delay.
    clearRelease();
    const pending = [...paused];
    if (!pending.length) return;
    releaseTimer = window.setTimeout(() => {
      releaseTimer = undefined;
      // A field focused during the press stays still through click dispatch.
      // If no click follows, settle instead of moving its native caret later.
      if (document.activeElement?.matches("input,textarea,select,[contenteditable=true]")) settle(pending);
      else for (const animation of pending) {
        if (paused.delete(animation) && animation.playState === "paused") animation.play();
      }
    }, 350);
  };
  const focus = (event: FocusEvent) => {
    // Pointerdown precedes focusin. Cancelling a held scene here would move
    // the focused radio/field away before pointerup and lose the first click.
    if (!paused.size && (event.target as Element | null)?.matches("input,textarea,select,[contenteditable=true]")) stop();
  };
  const hide = () => { if (document.hidden) stop(); };
  const enter = (event: AnimationEvent) => {
    if (event.animationName !== "tarobot-page-in" || !(event.target instanceof HTMLElement)) return;
    for (const animation of event.target.getAnimations()) {
      if (!("animationName" in animation) || animation.animationName !== event.animationName) continue;
      trackScene(animation);
      if (document.hidden || (event.target.contains(document.activeElement) && document.activeElement?.matches("input,textarea,select,[contenteditable=true]"))) animation.cancel();
    }
  };
  document.addEventListener("pointerdown", hold, true);
  document.addEventListener("touchstart", hold, { passive: true, capture: true });
  document.addEventListener("pointerup", release, true);
  document.addEventListener("touchend", release, { passive: true, capture: true });
  document.addEventListener("click", click, true);
  document.addEventListener("pointercancel", click, true);
  document.addEventListener("touchcancel", click, true);
  document.addEventListener("contextmenu", click, true);
  document.addEventListener("keydown", stop, true);
  document.addEventListener("focusin", focus, true);
  document.addEventListener("visibilitychange", hide);
  document.addEventListener("animationstart", enter, true);
  return () => {
    stop();
    paused.clear();
    document.removeEventListener("pointerdown", hold, true);
    document.removeEventListener("touchstart", hold, true);
    document.removeEventListener("pointerup", release, true);
    document.removeEventListener("touchend", release, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("pointercancel", click, true);
    document.removeEventListener("touchcancel", click, true);
    document.removeEventListener("contextmenu", click, true);
    document.removeEventListener("keydown", stop, true);
    document.removeEventListener("focusin", focus, true);
    document.removeEventListener("visibilitychange", hide);
    document.removeEventListener("animationstart", enter, true);
  };
}

/** Animate one arriving surface, never virtual rows or a second copy of history.
 * A zero direction is a peer-tab change; forward/back retain spatial direction. */
export function animateScene(node: HTMLElement | null, direction = 1): () => void {
  if (!node || document.hidden || !node.getClientRects().length || !node.animate) return () => {};
  // UIKit draws the caret separately. A focused field must stay where it is.
  if (node.contains(document.activeElement) && document.activeElement?.matches("input,textarea,select,[contenteditable=true]")) direction = 0;
  const animation = node.animate([
    { transform: `translateX(${direction * 28}px)`, opacity: direction ? .82 : .65 },
    { transform: "none", opacity: 1 },
  ], { duration: direction ? 180 : 120, easing: "cubic-bezier(.2,.8,.2,1)" });
  trackScene(animation);
  return () => { animation.cancel(); scenes.delete(animation); };
}
