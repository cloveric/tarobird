import { useState, useSyncExternalStore } from "react";
import { History, RotateCcw } from "lucide-react";
import { useLocale } from "./i18n.js";
import type { DesignSession } from "./workbench-design-session.js";
import "./workbench-design-history.css";

// App-side History panel for a Baoyu document. It runs in the App, outside the
// opaque editor frame; file contents are shown only as text nodes. Restores go
// through the session's flush → lock → CAS → reload path and become new versions.
type Listing = Awaited<ReturnType<DesignSession["historyList"]>>["result"];
export type DesignHistoryRow = Listing["rows"][number];
type Diff = Awaited<ReturnType<DesignSession["historyDiff"]>>["result"];
type Word = (zh: string, en: string) => string;

export function historyAuthorLabel(row: Pick<DesignHistoryRow, "by" | "name"> & { initial?: boolean }, word: Word) {
  if (row.initial) return word("初始内容", "Initial content");
  if (row.by === "system") return word("系统记录", "System record");
  if (row.by === "agent") return `${row.name || "Bot"} · Bot`;
  return row.name || word("你", "You");
}
export function historyNotes(row: DesignHistoryRow, word: Word): string[] {
  return [
    ...(row.restoredFrom !== undefined ? [row.restoredPart ? word(`部分恢复自 #${row.restoredFrom}`, `Partly restored from #${row.restoredFrom}`) : word(`恢复自 #${row.restoredFrom}`, `Restored from #${row.restoredFrom}`)] : []),
    ...(row.gap ? [word("此处有未记录的修改", "Unrecorded changes here")] : []),
    ...(row.objectsOmitted ? [word("超出历史容量，旧内容未保留", "Over the history budget; earlier content not kept")] : []),
  ];
}
export const historyOpLabel = (op: "added" | "edited" | "deleted", word: Word) => op === "added" ? word("新增", "Added") : op === "deleted" ? word("删除", "Deleted") : word("修改", "Edited");
/** What a refusal means for the person; never "saved" on failure. */
export function historyErrorText(error: unknown, word: Word) {
  const code = error instanceof Error ? error.message : "";
  if (/revision_conflict|request_conflict/.test(code)) return word("设计刚被修改。已刷新历史，请确认后再恢复。", "The design just changed. History was refreshed; check it and try again.");
  if (code === "design_history_object_missing") return word("这一版的部分内容已不在本机历史中，无法恢复。", "Part of this version is no longer in this device's history, so it cannot be restored.");
  if (code === "design_history_path_not_found" || code === "design_history_version_not_found") return word("这一版或这个文件已不在历史中。", "That version or file is no longer in the history.");
  if (/design_(invalid_index|artboard_missing|slide_missing|format_mismatch|index_required)/.test(code)) return word("只恢复这个文件会让设计不完整，请恢复整版。", "Restoring only this file would leave the design incomplete. Restore the whole version.");
  if (code === "design_closing") return word("应用正在退出或更新，请稍后再试。", "The App is quitting or updating. Try again later.");
  if (code === "design_read_only") return word("这里只能查看，不能恢复。", "This view is read-only.");
  return word("未能恢复，设计保持原样。请重试。", "Could not restore; the design is unchanged. Try again.");
}

/** Why the latest saves may be missing from the history; undefined when it is complete. */
export function historyStatusText(status: { status: string; code?: string } | undefined, word: Word) {
  if (status?.status === "gap") return word("最近一次保存已写入设计，但未能记入历史（存储空间不足或历史出错）。", "The latest save was stored, but it could not be recorded in the history (storage full or a history error).");
  if (status?.status === "unavailable") return word("本机历史记录无法读取，新的修改不会进入历史。设计本身照常保存。", "This device's history cannot be read; new changes are not recorded. The design itself still saves.");
  return undefined;
}

export function WorkbenchDesignHistory({ session, onRestored }: { session: DesignSession; onRestored?(): void }) {
  const locale = useLocale(), word: Word = (zh, en) => locale === "en" ? en : zh;
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot), notice = historyStatusText(snapshot.history, word);
  const [listing, setListing] = useState<Listing>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  // A failed restore is kept apart from load/diff errors: the list refresh that
  // follows it must not wipe the only sign that nothing was restored.
  const [restoreError, setRestoreError] = useState("");
  const [diff, setDiff] = useState<{ row: DesignHistoryRow; path: string; result: Diff }>(), [confirm, setConfirm] = useState<{ row: DesignHistoryRow; path?: string }>();
  const when = (at: string) => new Date(at).toLocaleString(locale === "en" ? "en" : "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const load = async (before?: number) => {
    setBusy(true); setError("");
    try { const { result } = await session.historyList({ limit: 30, ...(before !== undefined ? { before } : {}) }); setListing(current => before !== undefined && current ? { rows: [...current.rows, ...result.rows], more: result.more } : result); }
    catch { setError(word("无法读取历史，请重试。", "Could not load history. Retry.")); }
    finally { setBusy(false); }
  };
  const showDiff = async (row: DesignHistoryRow, path: string) => {
    setBusy(true); setError("");
    try { setDiff({ row, path, result: (await session.historyDiff({ version: row.n, path })).result }); }
    catch { setError(word("无法读取这次改动。", "Could not load this change.")); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!confirm) return;
    setBusy(true); setError(""); setRestoreError("");
    try { await session.restoreFromUi(confirm.row.n, confirm.path ? [confirm.path] : undefined); setConfirm(undefined); setDiff(undefined); onRestored?.(); setBusy(false); await load(); }
    catch (cause) { setConfirm(undefined); setRestoreError(historyErrorText(cause, word)); setBusy(false); await load(); }
  };
  const close = () => { setListing(undefined); setDiff(undefined); setConfirm(undefined); setError(""); setRestoreError(""); };
  const canRestore = !session.readOnly;
  return <span className="design-history">
    <button disabled={busy} aria-expanded={!!listing} title={notice} onClick={() => listing ? close() : void load()}><History size={14}/>{word("历史", "History")}{notice ? " ⚠" : ""}</button>
    {notice && !listing && <span className="design-history-warning" role="status">{word("历史不完整", "History incomplete")}</span>}
    {listing && <div role="dialog" aria-label={word("版本历史", "Version history")} data-workbench-overlay>
      {confirm ? <div className="design-history-confirm" role="alertdialog" aria-label={word("确认恢复", "Confirm restore")}>
        <p>{confirm.path ? word(`把「${confirm.path.replace(/^project\//, "")}」恢复到 ${when(confirm.row.at)} 的版本？`, `Restore “${confirm.path.replace(/^project\//, "")}” to the version from ${when(confirm.row.at)}?`)
          : word(`把整个设计恢复到 ${when(confirm.row.at)} 的版本？`, `Restore the whole design to the version from ${when(confirm.row.at)}?`)}</p>
        <p className="design-history-muted">{word("恢复会保存为一个新版本，现在的内容仍保留在历史里。", "This is saved as a new version; the current content stays in the history.")}</p>
        <div className="design-history-actions"><button disabled={busy} onClick={() => setConfirm(undefined)}>{word("取消", "Cancel")}</button><button disabled={busy} className="primary" onClick={() => void restore()}><RotateCcw size={14}/>{word("恢复", "Restore")}</button></div>
      </div> : diff ? <div className="design-history-diff">
        <div className="design-history-head"><button onClick={() => setDiff(undefined)}>{word("返回", "Back")}</button><span>{diff.path.replace(/^project\//, "")} · #{diff.row.n}</span></div>
        {"missing" in diff.result && diff.result.missing ? <p>{word("这次改动的内容已不在本机历史中。", "This change's content is no longer in this device's history.")}</p>
          : "binary" in diff.result && diff.result.binary ? <p>{word("二进制文件，无法逐行比较。", "Binary file; no line comparison.")}</p>
          : "tooLarge" in diff.result && diff.result.tooLarge ? <p>{word("文件太大，无法逐行比较。", "Too large to compare line by line.")}</p>
          : <pre aria-label={word(`新增 ${diff.result.added} 行，删除 ${diff.result.removed} 行`, `${diff.result.added} added, ${diff.result.removed} removed`)}>{diff.result.lines.map(([kind, line], index) => <div key={index} className={`design-history-line ${kind === "+" ? "add" : kind === "-" ? "del" : kind === "~" ? "skip" : ""}`}>{kind === "~" ? word(`… ${line} 行未变`, `… ${line} unchanged lines`) : `${kind === " " ? " " : kind} ${line}`}</div>)}</pre>}
        {canRestore && !diff.row.current && !diff.row.objectsOmitted && <div className="design-history-actions"><button disabled={busy} onClick={() => setConfirm({ row: diff.row, path: diff.path })}>{word("恢复此文件", "Restore this file")}</button></div>}
      </div> : <>
        <div className="design-history-head"><strong>{word("版本历史", "Version history")}</strong><span className="design-history-muted">{session.shared ? word("保存在共享源设备", "Stored on the sharing device") : word("保存在本机 · 最近 200 版", "Stored on this device · latest 200")}</span></div>
        {notice && <p role="alert">{notice}</p>}
        {!listing.rows.length && <p>{word("还没有历史版本。保存修改后会出现在这里。", "No versions yet. Saved changes appear here.")}</p>}
        <ol>{listing.rows.map(row => <li key={row.n}>
          <div className="design-history-row"><span>#{row.n} · {when(row.at)} · {historyAuthorLabel(row, word)}{row.current ? ` · ${word("当前", "Current")}` : ""}</span>
            {canRestore && !row.current && !row.objectsOmitted && <button disabled={busy} onClick={() => setConfirm({ row })}>{word("恢复整版", "Restore version")}</button>}</div>
          {historyNotes(row, word).map(note => <div key={note} className="design-history-muted">{note}</div>)}
          <ul>{row.files.map(file => <li key={file.path}><span>{historyOpLabel(file.op, word)} {file.path.replace(/^project\//, "")}</span><button disabled={busy} onClick={() => void showDiff(row, file.path)}>{word("改动", "Changes")}</button></li>)}</ul>
        </li>)}</ol>
        {listing.more && <button disabled={busy} onClick={() => void load(listing.rows.at(-1)?.n)}>{word("更早的版本", "Older versions")}</button>}
      </>}
      {restoreError && <p role="alert">{restoreError}</p>}
      {error && <p role="alert">{error}</p>}
      {!confirm && <div className="design-history-actions"><button disabled={busy} onClick={close}>{word("关闭", "Close")}</button></div>}
    </div>}
  </span>;
}
