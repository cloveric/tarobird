import "./reply-typography.css";
import { WorkbenchLink } from "./WorkbenchEntry.js";
import { useBotLabels } from "./BotReferences.js";
import { annotateBotReferences } from "./bot-references.js";
import { Fragment, memo, useMemo, startTransition, useEffect, useRef, useState, type ReactElement } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import type { Root } from "hast";
import { RotateCw, Image as ImageIcon, ImageOff, ArrowUpRight } from "lucide-react";
import { CodeBlock } from "./CodeBlock.js";
import { t, useLocale } from "./i18n.js";
import { createMarkdownJob } from "./markdown-jobs.js";
import { cachedMarkdown, rememberMarkdown } from "./markdown-parse-cache.js";
import { markdownImageUrl } from "./markdown-image.js";
import { MarkdownTable } from "./MarkdownTable.js";

const components: Components = {
  a: ({ children, href, className }) => {
    if (className?.split(" ").includes("markdown-image-link")) {
      const url = markdownImageUrl(href);
      if (!url) return <span className="markdown-image-unavailable" title={t("图片链接不可用")}><ImageOff size={14} aria-hidden="true"/>{children || t("图片链接不可用")}</span>;
      const host = new URL(url).hostname;
      return <a className="markdown-image-link" href={url} target="_blank" rel="noopener noreferrer" title={t("点击打开外部图片")}><ImageIcon size={14} aria-hidden="true"/><span>{children || t("外部图片")}</span><small>{host}</small><ArrowUpRight size={13} aria-hidden="true"/></a>;
    }
    // Relative destinations belong to the Bot's workspace, not this App's
    // origin. Avoid opening a blank App copy for anchors or rejected URLs.
    if (!href || !/^(?:https?:\/\/|mailto:|ircs?:|xmpp:)/i.test(href)) return <span>{children}</span>;
    return <WorkbenchLink href={href} target="_blank" rel="noopener noreferrer">{children}</WorkbenchLink>;
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: MarkdownTable,
  th: ({ children, style }) => <th style={style} scope="col"><span className="markdown-table-cell">{children}</span></th>,
  td: ({ children, style }) => <td style={style}><span className="markdown-table-cell">{children}</span></td>,
};
// Reference thumbnails share the parser but contain no actionable links or
// code-copy controls. They can safely live inside a forwarding form.
const previewComponents: Components = {
  ...components,
  a: ({ children, className }) => <span className={className?.split(" ").includes("markdown-image-link") ? "markdown-image-label" : "markdown-preview-link"}>{children || t("外部图片")}</span>,
  pre: ({ children }) => <div className="code-block"><pre>{children}</pre></div>,
  table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
};
type Chunk = { fingerprint: string; tree: Root };
const TreeChunk = memo(function TreeChunk({ chunk, preview }: { chunk: Chunk; preview?: boolean }) {
  useLocale();
  const labels = useBotLabels();
  const tree = useMemo(() => annotateBotReferences(chunk.tree, labels), [chunk.tree, labels]);
  return <div className="markdown-chunk">{toJsxRuntime(tree, { Fragment, jsx, jsxs, components: preview ? previewComponents : components, ignoreInvalidStyle: true }) as ReactElement}</div>;
});
function WorkerMarkdown({ text, preview }: { text: string; preview?: boolean }) {
  const [initial] = useState(() => cachedMarkdown(text));
  const job = useRef<ReturnType<typeof createMarkdownJob> | null>(null); const previous = useRef<Chunk[]>(initial ?? []);
  const paintFrame = useRef<number | undefined>(undefined), shown = useRef(initial?.length ?? 0), paintRevision = useRef(0);
  const [chunks, setChunks] = useState<Chunk[]>(initial ?? []), [failed, setFailed] = useState(false);
  const cancelPaint = () => { paintRevision.current++; if (paintFrame.current !== undefined) cancelAnimationFrame(paintFrame.current); paintFrame.current = undefined; };
  useEffect(() => { const active = createMarkdownJob(); job.current = active; return () => { active.dispose(); job.current = null; cancelPaint(); }; }, []);
  useEffect(() => {
    // A remount of an already-parsed text needs no worker round trip.
    if (previous.current.length && shown.current === previous.current.length && cachedMarkdown(text) === previous.current) return;
    job.current!.update(text, (data) => {
      cancelPaint();
      if (!data) { setFailed(true); return; }
      const next = data.map(({ fingerprint, serialized }, index) => previous.current[index]?.fingerprint === fingerprint ? previous.current[index] : { fingerprint, tree: JSON.parse(serialized) as Root });
      previous.current = next; rememberMarkdown(text, next);
      const revision = paintRevision.current;
      const publish = () => {
        if (revision !== paintRevision.current || !job.current) return;
        // Keep existing blocks and add only two new bounded groups per paint.
        // Never mix chunks from different parsed versions or estimate heights.
        shown.current = Math.min(next.length, shown.current + 2);
        const visible = next.slice(0, shown.current);
        startTransition(() => { setChunks(visible); setFailed(false); });
        paintFrame.current = shown.current < next.length ? requestAnimationFrame(publish) : undefined;
      };
      publish();
    });
  }, [text]);
  // If a platform blocks workers, preserve readable escaped content instead of
  // stalling the composer with a synchronous full-document parse.
  if (failed || !chunks.length) return <><div className="markdown-pending">{text}</div>{failed && <button type="button" className="markdown-retry" title={t("重新加载此消息的排版")} onClick={event => {
    const root = event.currentTarget.closest<HTMLElement>(".markdown");
    if (root) { root.tabIndex = -1; root.addEventListener("blur", () => root.removeAttribute("tabindex"), { once: true }); root.focus({ preventScroll: true }); }
    cancelPaint(); shown.current = 0; setChunks([]); setFailed(false); job.current?.retry();
  }}><RotateCw size={14}/>{t("恢复排版")}</button>}</>;
  return <>{chunks.map((chunk, index) => <TreeChunk key={index} chunk={chunk} preview={preview}/>)}</>;
}
export const MarkdownText = memo(function MarkdownText({ text, preview, reply = false }: { text: string; preview?: boolean; reply?: boolean }) {
  useLocale();
  // Short and long messages share one parser and safety policy off the UI
  // thread. Pairing/first paint no longer evaluates the parser, KaTeX or
  // highlighter; readable escaped text remains available while parsing starts.
  return <div className={`markdown${reply && !preview ? " reply-prose" : ""}`}><WorkerMarkdown text={text} preview={preview}/></div>;
});
