import { useEffect, useRef, useState } from "react";
import type { SheetPage } from "./spreadsheet-data.js";
import { t, useLocale } from "./i18n.js";
import "./spreadsheet-preview.css";
// Keep the large parser exclusively in the worker, not this UI module.
const ROWS = 100, COLUMNS = 26;
function label(index: number) { let text = ""; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + (n - 1) % 26) + text; return text; }
export default function SpreadsheetPreview({ blob }: { blob: Blob }) {
  useLocale();
  const [page, setPage] = useState<SheetPage>(), [error, setError] = useState(""), [busy, setBusy] = useState(true);
  const worker = useRef<Worker | undefined>(undefined), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), scroll = useRef<HTMLDivElement>(null);
  const fail = (reason: string) => { clearTimeout(timer.current); timer.current = undefined; worker.current?.terminate(); worker.current = undefined; setError(reason); setBusy(false); };
  const arm = () => { clearTimeout(timer.current); timer.current = setTimeout(() => fail("timeout"), 20_000); };
  useEffect(() => {
    let disposed = false;
    setPage(undefined); setError(""); setBusy(true);
    if (blob.size > 10 * 1024 * 1024) { fail("large"); return; }
    arm();
    void blob.arrayBuffer().then(bytes => {
      if (disposed || !timer.current) return;
      const parser = new Worker(new URL("./spreadsheet.worker.ts", import.meta.url), { type: "module" }); worker.current = parser;
      parser.onerror = event => { event.preventDefault(); if (!disposed) fail("invalid"); };
      parser.onmessageerror = () => { if (!disposed) fail("invalid"); };
      parser.onmessage = (event: MessageEvent<{ page?: SheetPage; error?: string }>) => {
        if (disposed) return;
        clearTimeout(timer.current);
        if (event.data.error || !event.data.page) { fail(event.data.error ?? "invalid"); return; }
        setPage(event.data.page); setBusy(false); scroll.current?.scrollTo(0, 0);
      };
      parser.postMessage({ bytes }, [bytes]);
    }).catch(() => { if (!disposed) fail("invalid"); });
    return () => { disposed = true; clearTimeout(timer.current); timer.current = undefined; worker.current?.terminate(); worker.current = undefined; };
  }, [blob]);
  const go = (sheet: number, row = 0, column = 0) => { if (busy || !worker.current) return; setBusy(true); arm(); worker.current.postMessage({ sheet, row, column }); };
  if (error) return <p role="alert">{error === "large" ? t("表格过大或内容过于复杂，请另存为或用其他应用打开。") : error === "timeout" ? t("表格预览超时，请另存为或用其他应用打开。") : t("无法预览此表格，文件可能损坏、已加密或格式不受支持。可用其他应用打开。")}</p>;
  if (!page) return <p role="status">{t("正在打开表格…")}</p>;
  const r0 = page.startRow + page.row * ROWS, c0 = page.startColumn + page.column * COLUMNS;
  return <div className="spreadsheet-reader" aria-busy={busy}>
    <nav className="spreadsheet-tabs" aria-label={t("工作表")}>{page.names.map((name, i) => <button key={i} aria-pressed={page.sheet === i} disabled={busy} onClick={() => go(i)}>{name}</button>)}</nav>
    <div className="spreadsheet-scroll" ref={scroll} tabIndex={0} role="region" aria-label={t("表格内容")}>
      <table aria-label={page.names[page.sheet]}><thead><tr><th aria-label={t("行号")}/>{page.cells[0].map((_, c) => <th scope="col" key={c}>{label(c0+c)}</th>)}</tr></thead>
      <tbody>{page.cells.map((row, r) => <tr key={r}><th scope="row">{r0+r+1}</th>{row.map((cell, c) => cell.covered ? null : <td key={c} className={cell.numeric ? "number" : undefined} rowSpan={cell.rowSpan} colSpan={cell.colSpan} title={cell.text}>{cell.text}</td>)}</tr>)}</tbody></table>
    </div>
    <footer className="spreadsheet-footer"><span>{t("第 {0}–{1} 行", r0+1, r0+page.cells.length)}</span>{page.rows > ROWS && <span className="spreadsheet-paging"><button disabled={busy || page.row === 0} onClick={() => go(page.sheet, page.row-1, page.column)}>{t("上一页")}</button><button disabled={busy || (page.row+1)*ROWS >= page.rows} onClick={() => go(page.sheet, page.row+1, page.column)}>{t("下一页")}</button></span>}{page.columns > COLUMNS && <span className="spreadsheet-paging"><button disabled={busy || page.column === 0} onClick={() => go(page.sheet, page.row, page.column-1)}>{t("前面的列")}</button><button disabled={busy || (page.column+1)*COLUMNS >= page.columns} onClick={() => go(page.sheet, page.row, page.column+1)}>{t("后面的列")}</button></span>}</footer>
    {page.limited && <p className="spreadsheet-note">{t("预览最多显示前 5,000 行、200 列；完整内容请用其他应用打开。")}</p>}
    <p className="spreadsheet-note">{page.formulaOnly ? t("部分公式没有已保存的结果，暂显示公式。") : t("只读预览 · 公式显示文件中已保存的结果")}</p>
  </div>;
}
