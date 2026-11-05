import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, Maximize2 } from "lucide-react";
import { CreationDialog } from "./CreationDialog.js";
import { t } from "./i18n.js";
import "./markdown-table.css";

function scrollWithArrows(event: KeyboardEvent<HTMLDivElement>) {
  // WebKit does not consistently scroll a focused overflow region with arrows.
  // Leave links, text selection and modified browser shortcuts alone.
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
  event.preventDefault(); event.stopPropagation();
  event.currentTarget.scrollLeft += event.key === "ArrowRight" ? 80 : -80;
}

/** Keep intrinsic column widths inside a scrollport, never on the chat itself. */
export function MarkdownTable({ children }: { children?: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = useState({ wide: false, tall: false });
  const [expanded, setExpanded] = useState<{ reply: boolean } | null>(null);
  useEffect(() => {
    const port = viewport.current!, content = table.current!;
    const measure = () => {
      const wide = content.scrollWidth > port.clientWidth + 1, tall = content.clientHeight > 320;
      setLayout(previous => previous.wide === wide && previous.tall === tall ? previous : { wide, tall });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(port); observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return <div className="markdown-table">
    {(layout.wide || layout.tall || expanded) && <div className="markdown-table-tools">
      <span>{layout.wide && <><ArrowLeftRight size={14} aria-hidden="true"/>{t("左右滑动查看")}</>}</span>
      <button ref={trigger} type="button" onClick={() => setExpanded({ reply: viewport.current?.closest(".markdown")?.classList.contains("reply-prose") ?? false })} aria-haspopup="dialog"><Maximize2 size={14} aria-hidden="true"/>{t("展开表格")}</button>
    </div>}
    <div ref={viewport} className="table-scroll" role="region" aria-label={t(layout.wide ? "表格，可左右滑动" : "表格")} tabIndex={layout.wide ? 0 : undefined} onKeyDown={scrollWithArrows}>
      <table ref={table}>{children}</table>
    </div>
    {expanded && createPortal(<CreationDialog title={t("表格")} closeLabel={t("关闭表格")} close={() => setExpanded(null)} returnFocus={trigger} showHost={false} className="markdown-table-dialog">
      <div className={`markdown markdown-table-reader${expanded.reply ? " reply-prose" : ""}`} role="region" aria-label={t("表格内容")} tabIndex={0} onKeyDown={scrollWithArrows}><table>{children}</table></div>
    </CreationDialog>, document.body)}
  </div>;
}
