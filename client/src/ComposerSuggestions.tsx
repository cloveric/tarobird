import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Keep completions anchored to the composer without covering the chat header.
 * Measure actual space: an IME candidate bar, quote or attachment can all change
 * it independently of window.innerHeight. The menu itself never resizes its
 * anchor, so observing these boxes cannot create a menu/layout feedback loop. */
export function ComposerSuggestions({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    const anchor = menu?.parentElement;
    const column = anchor?.closest(".conversation-main");
    const header = column?.querySelector(".conversation-header");
    const messages = column?.querySelector(".message-scroll");
    if (!menu || !anchor || !column || !header || !messages) return;
    let frame = 0;
    const measure = () => {
      const top = Math.max(header.getBoundingClientRect().bottom, messages.getBoundingClientRect().top, window.visualViewport?.offsetTop ?? 0);
      // Eight pixels above and below the menu; margin-bottom owns the lower gap.
      const room = Math.max(0, Math.floor(anchor.getBoundingClientRect().top - top - 16));
      menu.style.setProperty("--composer-menu-room", `${room}px`);
      // In an extremely short landscape viewport, keep typing possible instead
      // of drawing an unusable sliver over the header. Resizing restores it.
      menu.dataset.noSpace = String(room < 54);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    measure();
    // Constrain before the resize frame paints, so the previous tall menu does
    // not flash across the header while the keyboard/candidate bar animates.
    const observer = new ResizeObserver(measure);
    for (const element of [anchor, column, header, messages]) observer.observe(element);
    window.addEventListener("resize", schedule);
    const visual = window.visualViewport;
    visual?.addEventListener("resize", schedule);
    visual?.addEventListener("scroll", schedule);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      visual?.removeEventListener("resize", schedule);
      visual?.removeEventListener("scroll", schedule);
    };
  }, []);
  // Suppress compatibility mouse focus, not touchstart: swiping must still
  // scroll the suggestions, while choosing one must keep the keyboard open.
  return <div ref={ref} className="command-menu" role="group" aria-label={label} onMouseDown={(event) => { if ((event.target as HTMLElement).closest("button")) event.preventDefault(); }}>{children}</div>;
}
