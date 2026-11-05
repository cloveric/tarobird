import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const measuredStyles = ["fontFamily", "fontSize", "fontStyle", "fontWeight", "fontStretch", "fontVariant", "lineHeight", "letterSpacing", "wordSpacing", "textTransform", "textIndent", "tabSize", "whiteSpace", "wordBreak", "overflowWrap", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;

type Observed = { node: HTMLTextAreaElement; layout: string; dispose: () => void };

/** Resize only for draft/width changes, never for streaming tokens. This also
 * works in WebViews without CSS field-sizing and preserves the list's existing
 * ResizeObserver-based reading anchor. A keystroke measures once, with one
 * reused out-of-flow field; layout changes also re-measure on the next frame. */
export function useComposerSize(ref: RefObject<HTMLTextAreaElement | null>, draft: string, conversation: string, phone: boolean, details: boolean, appearance: string, active: boolean) {
  const [expanded, setExpanded] = useState(false);
  const field = useRef<HTMLTextAreaElement | null>(null), width = useRef(0), phoneLayout = useRef(phone);
  const observed = useRef<Observed | undefined>(undefined), measuredText = useRef<{ draft: string; expanded: boolean } | undefined>(undefined);
  phoneLayout.current = phone;
  const measure = () => {
    const node = ref.current; if (!node) return;
    const composer = node.closest<HTMLElement>(".composer");
    const toolbar = composer?.querySelector<HTMLElement>(".composer-toolbar");
    const nextWidth = node.clientWidth; if (!nextWidth) return;
    width.current = nextWidth;
    let measureField = field.current;
    if (!measureField) {
      measureField = document.createElement("textarea");
      measureField.tabIndex = -1;
      measureField.setAttribute("aria-hidden", "true");
      Object.assign(measureField.style, { position: "fixed", top: "0", left: "0", visibility: "hidden", pointerEvents: "none", height: "0", minHeight: "0", maxHeight: "none", margin: "0", border: "0", boxSizing: "border-box", overflow: "hidden", resize: "none" });
      field.current = measureField;
    }
    const style = getComputedStyle(node);
    for (const property of measuredStyles) measureField.style[property] = style[property];
    measureField.style.width = `${nextWidth}px`;
    measureField.wrap = node.wrap;
    measureField.value = node.value || node.placeholder;
    const line = parseFloat(style.lineHeight) || 24;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    // Never collapse the focused field to measure it. In WebKit, that
    // transient layout can scroll the caret/history even before a paint.
    // This out-of-flow measurement field cannot move the live composer.
    document.body.append(measureField);
    let height: number;
    try {
      height = Math.min(Math.max(measureField.scrollHeight + border, 44), line * 6 + padding + border);
      let multiline = false;
      if (phoneLayout.current && composer && toolbar && node.value) {
        // Always test the compact layout, even while expanded. Measuring the
        // current (wider) field would alternate layouts around the wrap point.
        // Flexible status/hint spacers and auto margins consume only spare
        // space; the fixed controls reserve the same width in both layouts.
        const controls = [...toolbar.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.offsetWidth > 0 && getComputedStyle(child).flexGrow === "0");
        const gap = parseFloat(getComputedStyle(toolbar).columnGap) || 0;
        const actionsWidth = controls.reduce((sum, child) => sum + child.offsetWidth, 0) + Math.max(0, controls.length - 1) * gap;
        measureField.style.width = `${Math.max(1, composer.clientWidth - actionsWidth)}px`;
        measureField.value = node.value;
        multiline = node.value.includes("\n") || measureField.scrollHeight > line + padding + 1;
      }
      setExpanded(previous => previous === multiline ? previous : multiline);
    }
    finally { measureField.remove(); }
    const value = `${style.boxSizing === "border-box" ? height : height - padding - border}px`;
    if (node.style.height !== value) node.style.height = value;
  };
  const latest = useRef(measure); latest.current = measure;
  // Runs after every commit but only does work when an input actually changed:
  // the field element, a layout input, the draft text or the compact/expanded state.
  useLayoutEffect(() => {
    const node = ref.current, layout = `${conversation}\u0000${phone}\u0000${details}\u0000${appearance}\u0000${active}`;
    if (observed.current && (observed.current.node !== node || observed.current.layout !== layout)) { observed.current.dispose(); observed.current = undefined; }
    if (!node) return;
    if (!observed.current) {
      let frame = 0;
      latest.current();
      // Appearance preferences are applied to the root after layout effects.
      frame = requestAnimationFrame(() => latest.current());
      // A viewport change can resize this field while observers are being
      // delivered. Write its height on the next frame to avoid a WebKit loop.
      const observer = new ResizeObserver(() => {
        if (node.clientWidth === width.current) return;
        cancelAnimationFrame(frame); frame = requestAnimationFrame(() => latest.current());
      });
      observer.observe(node);
      observed.current = { node, layout, dispose: () => { observer.disconnect(); cancelAnimationFrame(frame); } };
      measuredText.current = { draft, expanded };
      return;
    }
    if (measuredText.current?.draft === draft && measuredText.current.expanded === expanded) return;
    measuredText.current = { draft, expanded };
    latest.current();
  });
  useLayoutEffect(() => () => { observed.current?.dispose(); observed.current = undefined; field.current?.remove(); field.current = null; }, []);
  return phone && expanded;
}
