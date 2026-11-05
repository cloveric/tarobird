import { elementScroll, observeElementOffset, type Virtualizer } from "@tanstack/react-virtual";

type List = Virtualizer<HTMLDivElement, HTMLElement>;

export function usesIosReadingScroll(device: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  if (/iP(hone|od|ad)/.test(device.userAgent)) return true;
  // iPad desktop mode identifies as a touch Mac. Touch-enabled Chromium on a
  // Mac has that same platform tuple, but does not need WebKit's compensation.
  // Applying it there transiently shifts short viewports above their scrollable
  // origin, so a visible iframe control can be clipped behind the chat header.
  return device.platform === "MacIntel" && device.maxTouchPoints > 0 && /AppleWebKit\//.test(device.userAgent)
    && !/Android|(?:Chrome|Chromium|Edg|OPR|Firefox)\//.test(device.userAgent);
}

/** Keep virtual-row corrections in layout coordinates while WebKit owns a
 * touch/momentum scroll. Moving the list origin preserves the visible anchor;
 * handing that origin back to scrollTop after settling is visually neutral. */
export function createReadingScroll(getHistory: () => HTMLDivElement | null) {
  let shift = 0, touching = false, scrolling = false, settleTimer = 0, settleFrame = 0;
  let list: List | undefined, observed: ((offset: number, scrolling: boolean) => void) | undefined;
  let nativeObserver: { instance: List; callback: (offset: number, scrolling: boolean) => void } | undefined;
  let lastOffset = -1, lastScrolling = false;
  const cancelSettle = () => {
    clearTimeout(settleTimer); cancelAnimationFrame(settleFrame); settleTimer = settleFrame = 0;
  };
  const ios = usesIosReadingScroll(navigator);
  const paint = () => {
    const history = getHistory();
    if (!history || !list) return;
    // Measurement notifications can precede React's commit by one frame. Move
    // mounted rows and their compensated origin together, using public layout
    // coordinates, so that frame cannot paint the origin with old row positions.
    const positions = new Map(list.getVirtualItems().map(item => [String(item.key), item.start]));
    for (const row of history.children) {
      const node = row as HTMLElement, start = positions.get(node.dataset.messageId ?? "");
      if (start !== undefined) node.style.transform = `translateY(${start}px)`;
    }
    history.style.transform = shift ? `translateY(${-shift}px)` : "";
    history.style.height = `${Math.max(0, list.getTotalSize() - shift)}px`;
  };
  const publish = () => {
    const node = list?.scrollElement;
    if (!node || !observed) return;
    const offset = node.scrollTop + shift;
    if (offset === lastOffset && scrolling === lastScrolling) return;
    lastOffset = offset; lastScrolling = scrolling;
    observed(offset, scrolling);
  };
  const release = () => {
    cancelSettle();
    const node = list?.scrollElement;
    if (!shift || !node) return;
    // Let Safari finish its elastic edge bounce before changing scrollTop.
    if (node.scrollTop < 0 || node.scrollTop > node.scrollHeight - node.clientHeight + 1) return;
    const offset = node.scrollTop + shift;
    shift = 0; paint();
    node.scrollTop = offset;
    publish();
  };
  const settle = () => {
    cancelSettle();
    if (touching || scrolling || !shift) return;
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      let previous = list?.scrollElement?.scrollTop, stable = 0;
      const check = () => {
        settleFrame = 0;
        if (touching || scrolling || !list?.scrollElement) return;
        const offset = list.scrollElement.scrollTop;
        stable = offset === previous ? stable + 1 : 0; previous = offset;
        // A blocked main thread can deliver the idle timer before queued scroll
        // events. Require two rendered, stationary frames before native writes.
        if (stable >= 2) release(); else settleFrame = requestAnimationFrame(check);
      };
      settleFrame = requestAnimationFrame(check);
    }, 160);
  };
  const reset = () => {
    cancelSettle(); shift = 0; touching = false; scrolling = false; paint();
    // Hiding makes native geometry zero. Keep the virtualizer's logical offset
    // intact so reattachment restores it; never publish that hidden zero.
  };
  return {
    ios,
    get shift() { return shift; },
    reset,
    canAdjust(nativeOffset: number, observedOffset: number | null, adjustments: number) {
      // Explicit navigation writes scrollTop before its scroll event updates
      // the virtualizer. Compensating from that stale offset would undo the
      // jump. Allow fractional browser rounding; preserve the independent iOS
      // deferred-origin policy below.
      return ios || Math.abs((observedOffset ?? 0) + adjustments - nativeOffset) <= 1.5;
    },
    defer(delta: number) {
      if (!ios || !list?.scrollElement) return false;
      shift += delta;
      return true;
    },
    changed(instance: List) { list = instance; if (shift) { paint(); publish(); if (!settleTimer && !settleFrame) settle(); } },
    observe(instance: List, callback: (offset: number, isScrolling: boolean) => void) {
      if (!ios) {
        const owner = { instance, callback };
        nativeObserver = owner;
        const stop = observeElementOffset(instance, callback);
        return () => { stop?.(); if (nativeObserver === owner) nativeObserver = undefined; };
      }
      list = instance; observed = callback; lastOffset = -1;
      const node = instance.scrollElement;
      let target: EventTarget | null = null;
      const clearTarget = () => { target?.removeEventListener("touchend", end); target?.removeEventListener("touchcancel", end); target = null; };
      const start = (event: TouchEvent) => {
        touching = true; cancelSettle();
        clearTarget(); target = event.target;
        target?.addEventListener("touchend", end); target?.addEventListener("touchcancel", end);
      };
      const end = () => { touching = false; clearTarget(); settle(); };
      node?.addEventListener("touchstart", start, { passive: true });
      // A cancelled gesture is an end too; no dependency-private flags involved.
      window.addEventListener("touchend", end, true);
      window.addEventListener("touchcancel", end, true);
      const stop = observeElementOffset(instance, (_offset, active) => { scrolling = active; publish(); settle(); });
      return () => {
        stop?.(); clearTarget(); observed = undefined; reset(); list = undefined;
        node?.removeEventListener("touchstart", start);
        window.removeEventListener("touchend", end, true);
        window.removeEventListener("touchcancel", end, true);
      };
    },
    scrollTo(offset: number, options: { adjustments?: number; behavior?: ScrollBehavior }, instance: List) {
      // Explicit navigation (search/latest) establishes a new logical target.
      // Restore the full scroll extent before the browser clamps that target.
      if (ios && shift) { shift = 0; paint(); }
      elementScroll(offset, options, instance);
      // An accepted immediate navigation has already moved the DOM. Publish
      // its position through the public observer before another
      // measurement can replay a pending correction from the old location.
      // Compensation writes must retain the virtualizer's own accounting;
      // smooth scrolling and iOS still report through their native observers.
      // Do not adopt a clamped offset while a remounted reader's full height
      // has not yet committed; it must retain its saved logical position.
      if (!ios && options.adjustments === undefined && options.behavior !== "smooth" && nativeObserver?.instance === instance && instance.scrollElement && instance.scrollElement.clientHeight > 0 && Math.abs(instance.scrollElement.scrollTop - offset) <= 1.5) {
        nativeObserver.callback(instance.scrollElement.scrollTop, false);
      }
    },
  };
}
