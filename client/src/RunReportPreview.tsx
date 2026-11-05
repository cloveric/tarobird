import { useLayoutEffect, useRef, useState } from "react";
import { runReportExcerpt, runReportNeedsFormatting } from "./run-presentation.js";
import { t } from "./i18n.js";

export function useRunReportPreview(text: string, active: boolean) {
  const ref = useRef<HTMLParagraphElement>(null), [clipped, setClipped] = useState(true);
  const excerpt = runReportExcerpt(text, active);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [excerpt]);
  // Short plain-text reports are already shown in full. Formatted reports keep
  // a reader so links, code and tables remain available without clipped controls.
  const needsReader = active || clipped || excerpt !== text.trim() || runReportNeedsFormatting(text);
  return { needsReader, preview: <div className={`run-report-preview${active ? " is-active" : ""}`}><span>{t(active ? "进展摘录" : "回复摘录")}</span><p ref={ref}>{excerpt || t("暂无回复内容")}</p></div> };
}
