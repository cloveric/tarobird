import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { MarkdownText } from "./MarkdownText.js";
import { scopedTaskDescription } from "./run-presentation.js";
import { t } from "./i18n.js";

/** A scope label can be a native completion summary, not just an Agent name.
 * Keep this metadata separate from the reply and leave persisted bytes intact. */
export function ScopedTaskDescription({ text }: { text: string }) {
  const id = useId(), preview = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false), [clipped, setClipped] = useState(false), [disclosed, setDisclosed] = useState(false);
  const { excerpt, expandable } = scopedTaskDescription(text);
  useLayoutEffect(() => {
    const node = preview.current;
    if (!node || expanded) return;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [excerpt, expanded]);
  // Keep a used trigger stable if the viewport widens while reading. Removing
  // it immediately on collapse would discard keyboard focus.
  const canExpand = disclosed || clipped || expandable;
  return <section className="scoped-task-description">
    {canExpand && <div className="scoped-task-description-heading">
      <span>{t("任务说明")}</span>
      <button type="button" aria-expanded={expanded} aria-controls={id}
        aria-label={t(expanded ? "收起任务说明" : "展开任务说明")} onClick={() => { setDisclosed(true); setExpanded(value => !value); }}>
        {t(expanded ? "收起" : "展开")}<ChevronDown size={13} aria-hidden="true"/>
      </button>
    </div>}
    <div id={id}>
      {expanded ? <div className="card-text"><MarkdownText text={text}/></div>
        : <p ref={preview} className="scoped-task-excerpt">{excerpt}</p>}
    </div>
  </section>;
}
