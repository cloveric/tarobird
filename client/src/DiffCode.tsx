import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { WorkspaceDiffLine } from "../../src/client-protocol/workspace-diff.js";
import type { DiffReviewNote } from "./diff-review-draft.js";
import { diffRows, diffDisplayColumns, type DisplayDiff } from "./diff-view-rows.js";
import { highlightDiff, type DiffToken } from "./diff-highlight.js";
import { t } from "./i18n.js";

export function DiffCode({ file, split, canAnnotate, notes, annotate }: { file: DisplayDiff; split: boolean; canAnnotate: boolean; notes: DiffReviewNote[]; annotate: (line: WorkspaceDiffLine, side: "old" | "new", event: MouseEvent) => void }) {
  const scroll = useRef<HTMLDivElement>(null), rows = useMemo(() => diffRows(file, split), [file, split]);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 25, overscan: 8 });
  useEffect(() => { if (scroll.current) { scroll.current.scrollTop = 0; scroll.current.scrollLeft = 0; } }, [file, split]);
  const [colors, setColors] = useState(new Map<string, DiffToken[]>());
  useEffect(() => { let active = true; setColors(new Map()); void highlightDiff(file).then(value => { if (active) setColors(value); }).catch(() => undefined); return () => { active = false; }; }, [file]);
  const [codeWidth, setCodeWidth] = useState(0);
  useEffect(() => {
    const node = scroll.current; if (!node) return;
    const measure = () => {
      const context = document.createElement("canvas").getContext("2d");
      const style = getComputedStyle(node);
      let measured = false;
      if (context && style.fontSize && style.fontFamily) {
        // WebViews may omit the font shorthand. A sentinel detects rejected
        // font values instead of silently measuring with canvas's 10px default.
        context.font = "1px monospace";
        context.font = `${style.fontStyle || "normal"} ${style.fontWeight || "normal"} ${style.fontSize} ${style.fontFamily}`;
        measured = context.font !== "1px monospace";
      }
      const fallbackWidth = Math.max(8, Number.parseFloat(style.fontSize) || 12);
      const longest = Math.max(0, ...file.hunks.flatMap(h => h.lines.map(line => measured ? context!.measureText(line.text.replace(/\t/g, "    ")).width : diffDisplayColumns(line.text) * fallbackWidth)));
      setCodeWidth(Math.ceil(longest) + (split ? 68 : 104));
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [file, split]);
  const cell = (line: WorkspaceDiffLine | undefined, side?: "old" | "new", hi = "0") => {
    if (!line) return <div className="diff-code-cell is-blank"/>;
    const version = side ?? (line.kind === "delete" ? "old" : "new"), n = version === "old" ? line.oldLine : line.newLine;
    const marked = notes.some(note => note.path === file.file.path && note.head === file.head && note.side === version && n !== null && n >= note.start && n <= note.end);
    const clickable = canAnnotate && n !== null && !line.clipped;
    const content = <><span className="diff-line-numbers">{side ? n ?? "" : <><span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span></>}</span><span className="diff-line-sign">{marked ? "●" : line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}</span><code>{colors.get(`${hi}:${version}:${n}`)?.map((token, i) => <span key={i} className={token.classes.join(" ")}>{token.text}</span>) ?? line.text}{line.clipped && <span> …</span>}</code></>;
    const classes = `diff-code-cell is-${line.kind} ${marked ? "has-note" : ""}`;
    return clickable ? <button type="button" className={classes} aria-label={t("批注第 {0} 行（{1}）", n, version === "old" ? t("旧") : t("新"))} onClick={event => annotate(line, version, event)}>{content}</button> : <div className={classes}>{content}</div>;
  };
  return <div ref={scroll} className={`diff-code-scroll ${split ? "is-split" : ""}`} data-testid="diff-code" role="region" aria-label={t("代码差异")} tabIndex={0}><div style={{ height: virtual.getTotalSize(), position: "relative", width: "100%", minWidth: split ? codeWidth * 2 : codeWidth }}>
    {virtual.getVirtualItems().map(item => { const row = rows[item.index]!; return <div key={row.key} className={`diff-code-row ${row.header ? "is-hunk" : ""}`} style={{ position: "absolute", transform: `translateY(${item.start}px)`, height: item.size, left: 0, right: 0 }}>{row.header ? <code>{row.header}</code> : split ? <>{cell(row.left, "old", row.key.split(":")[0])}{cell(row.right, "new", row.key.split(":")[0])}</> : cell(row.line, undefined, row.key.split(":")[0])}</div>; })}
  </div></div>;
}
