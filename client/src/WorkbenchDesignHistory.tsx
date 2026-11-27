import { useState, useSyncExternalStore } from "react";
import { History, RotateCcw } from "lucide-react";
import { localeIntlTag, t, useLocale } from "./i18n.js";
import type { DesignSession } from "./workbench-design-session.js";
import "./workbench-design-history.css";

// App-side History panel for a Workbench document. It runs in the App, outside the
// opaque editor frame; file contents are shown only as text nodes. Restores go
// through the session's flush → lock → CAS → reload path and become new versions.
type Listing = Awaited<ReturnType<DesignSession["historyList"]>>["result"];
export type DesignHistoryRow = Listing["rows"][number];
type Diff = Awaited<ReturnType<DesignSession["historyDiff"]>>["result"];

export function historyAuthorLabel(row: Pick<DesignHistoryRow, "by" | "name"> & { initial?: boolean }) {
  if (row.initial) return t("初始内容");
  if (row.by === "system") return t("系统记录");
  if (row.by === "agent") return `${row.name || "Bot"} · Bot`;
  return row.name || t("你");
}
export function historyNotes(row: DesignHistoryRow): string[] {
  return [
    ...(row.restoredFrom !== undefined ? [row.restoredPart ? t("部分恢复自 #{0}", row.restoredFrom) : t("恢复自 #{0}", row.restoredFrom)] : []),
    ...(row.gap ? [t("此处有未记录的修改")] : []),
    ...(row.objectsOmitted ? [t("超出历史容量，旧内容未保留")] : []),
  ];
}
export const historyOpLabel = (op: "added" | "edited" | "deleted") => op === "added" ? t("新增") : op === "deleted" ? t("删除") : t("修改");
/** What a refusal means for the person; never "saved" on failure. */
export function historyErrorText(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (/revision_conflict|request_conflict/.test(code)) return t("设计刚被修改。已刷新历史，请确认后再恢复。");
  if (code === "design_history_object_missing") return t("这一版的部分内容已不在本机历史中，无法恢复。");
  if (code === "design_history_path_not_found" || code === "design_history_version_not_found") return t("这一版或这个文件已不在历史中。");
  if (/design_(invalid_index|artboard_missing|slide_missing|format_mismatch|index_required)/.test(code)) return t("只恢复这个文件会让设计不完整，请恢复整版。");
  if (code === "design_closing") return t("应用正在退出或更新，请稍后再试。");
  if (code === "design_read_only") return t("这里只能查看，不能恢复。");
  return t("未能恢复，设计保持原样。请重试。");
}

/** Why the latest saves may be missing from the history; undefined when it is complete. */
export function historyStatusText(status: { status: string; code?: string } | undefined) {
  if (status?.status === "gap") return t("最近一次保存已写入设计，但未能记入历史（存储空间不足或历史出错）。");
  if (status?.status === "unavailable") return t("本机历史记录无法读取，新的修改不会进入历史。设计本身照常保存。");
  return undefined;
}

export function WorkbenchDesignHistory({ session, readOnly = false, onRestored }: { session: DesignSession; readOnly?: boolean; onRestored?(): void }) {
  const locale = useLocale();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot), notice = historyStatusText(snapshot.history);
  const [listing, setListing] = useState<Listing>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  // A failed restore is kept apart from load/diff errors: the list refresh that
  // follows it must not wipe the only sign that nothing was restored.
  const [restoreError, setRestoreError] = useState("");
  const [diff, setDiff] = useState<{ row: DesignHistoryRow; path: string; result: Diff }>(), [confirm, setConfirm] = useState<{ row: DesignHistoryRow; path?: string }>();
  const when = (at: string) => new Date(at).toLocaleString(localeIntlTag(locale), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const load = async (before?: number) => {
    setBusy(true); setError("");
    try { const { result } = await session.historyList({ limit: 30, ...(before !== undefined ? { before } : {}) }); setListing(current => before !== undefined && current ? { rows: [...current.rows, ...result.rows], more: result.more } : result); }
    catch { setError(t("无法读取历史，请重试。")); }
    finally { setBusy(false); }
  };
  const showDiff = async (row: DesignHistoryRow, path: string) => {
    setBusy(true); setError("");
    try { setDiff({ row, path, result: (await session.historyDiff({ version: row.n, path })).result }); }
    catch { setError(t("无法读取这次改动。")); }
    finally { setBusy(false); }
  };
  const canRestore = !session.readOnly && !readOnly;
  const restore = async () => {
    if (!confirm || !canRestore) return;
    setBusy(true); setError(""); setRestoreError("");
    try { await session.restoreFromUi(confirm.row.n, confirm.path ? [confirm.path] : undefined); setConfirm(undefined); setDiff(undefined); onRestored?.(); setBusy(false); await load(); }
    catch (cause) { setConfirm(undefined); setRestoreError(historyErrorText(cause)); setBusy(false); await load(); }
  };
  const close = () => { setListing(undefined); setDiff(undefined); setConfirm(undefined); setError(""); setRestoreError(""); };
  return <span className="design-history">
    <button disabled={busy} aria-expanded={!!listing} title={notice} onClick={() => listing ? close() : void load()}><History size={14}/>{t("历史")}{notice ? " ⚠" : ""}</button>
    {notice && !listing && <span className="design-history-warning" role="status">{t("历史不完整")}</span>}
    {listing && <div role="dialog" aria-label={t("版本历史")} data-workbench-overlay>
      {confirm ? <div className="design-history-confirm" role="alertdialog" aria-label={t("确认恢复")}>
        <p>{confirm.path ? t("把「{0}」恢复到 {1} 的版本？", confirm.path.replace(/^project\//, ""), when(confirm.row.at))
          : t("把整个设计恢复到 {0} 的版本？", when(confirm.row.at))}</p>
        <p className="design-history-muted">{t("恢复会保存为一个新版本，现在的内容仍保留在历史里。")}</p>
        <div className="design-history-actions"><button disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button><button disabled={busy} className="primary" onClick={() => void restore()}><RotateCcw size={14}/>{t("恢复")}</button></div>
      </div> : diff ? <div className="design-history-diff">
        <div className="design-history-head"><button onClick={() => setDiff(undefined)}>{t("返回")}</button><span>{diff.path.replace(/^project\//, "")} · #{diff.row.n}</span></div>
        {"missing" in diff.result && diff.result.missing ? <p>{t("这次改动的内容已不在本机历史中。")}</p>
          : "binary" in diff.result && diff.result.binary ? <p>{t("二进制文件，无法逐行比较。")}</p>
          : "tooLarge" in diff.result && diff.result.tooLarge ? <p>{t("文件太大，无法逐行比较。")}</p>
          : <pre aria-label={t("新增 {0} 行，删除 {1} 行", diff.result.added, diff.result.removed)}>{diff.result.lines.map(([kind, line], index) => <div key={index} className={`design-history-line ${kind === "+" ? "add" : kind === "-" ? "del" : kind === "~" ? "skip" : ""}`}>{kind === "~" ? t("… {0} 行未变", line) : `${kind === " " ? " " : kind} ${line}`}</div>)}</pre>}
        {canRestore && !diff.row.current && !diff.row.objectsOmitted && <div className="design-history-actions"><button disabled={busy} onClick={() => setConfirm({ row: diff.row, path: diff.path })}>{t("恢复此文件")}</button></div>}
      </div> : <>
        <div className="design-history-head"><strong>{t("版本历史")}</strong><span className="design-history-muted">{session.shared ? t("保存在共享源设备") : t("保存在本机 · 最近 200 版")}</span></div>
        {notice && <p role="alert">{notice}</p>}
        {!listing.rows.length && <p>{t("还没有历史版本。保存修改后会出现在这里。")}</p>}
        <ol>{listing.rows.map(row => <li key={row.n}>
          <div className="design-history-row"><span>#{row.n} · {when(row.at)} · {historyAuthorLabel(row)}{row.current ? ` · ${t("当前")}` : ""}</span>
            {canRestore && !row.current && !row.objectsOmitted && <button disabled={busy} onClick={() => setConfirm({ row })}>{t("恢复整版")}</button>}</div>
          {historyNotes(row).map(note => <div key={note} className="design-history-muted">{note}</div>)}
          <ul>{row.files.map(file => <li key={file.path}><span>{historyOpLabel(file.op)} {file.path.replace(/^project\//, "")}</span><button disabled={busy} onClick={() => void showDiff(row, file.path)}>{t("改动")}</button></li>)}</ul>
        </li>)}</ol>
        {listing.more && <button disabled={busy} onClick={() => void load(listing.rows.at(-1)?.n)}>{t("更早的版本")}</button>}
      </>}
      {restoreError && <p role="alert">{restoreError}</p>}
      {error && <p role="alert">{error}</p>}
      {!confirm && <div className="design-history-actions"><button disabled={busy} onClick={close}>{t("关闭")}</button></div>}
    </div>}
  </span>;
}
