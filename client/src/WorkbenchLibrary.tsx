import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, CheckSquare, ChevronDown, Download, FileText, FolderOpen, LayoutGrid, RefreshCw, Search, SquarePen, Trash2 } from "lucide-react";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { WorkbenchLibraryContext, type WorkbenchFileTarget, type WorkbenchLibraryHost } from "./workbench-library-context.js";
import { listWorkbenchLibrary, deleteWorkbenchLibraryEntries, exportStoredDesign, type WorkbenchLibraryEntry, type WorkbenchLibraryDeleteStatus } from "./workbench-library.js";
import { saveDesignBackup } from "./workbench-design-export.js";
import { workbenchErrorText } from "./workbench-error.js";
import { t, useLocale } from "./i18n.js";
import "./workbench-library.css";

/** Keep the native chooser and its 16px focus floor on phones. The compact
 * selected label is presentation-only, so opening a filter never zooms the page. */
function LibraryFilter({label, value, display, disabled, change, children}: {label:string;value:string;display:string;disabled:boolean;change(value:string):void;children:ReactNode}) {
  return <label className="workbench-library-filter">
    <select aria-label={label} value={value} disabled={disabled} onChange={event => change(event.target.value)}>{children}</select>
    <span className="workbench-library-filter-display" aria-hidden="true"><span>{display}</span><ChevronDown size={14}/></span>
  </label>;
}

type Row = WorkbenchLibraryEntry & { key: string; host: WorkbenchLibraryHost; label: string; conversationTitle?: string; conversationMissing: boolean; conversationArchived: boolean };
type Result = { row: Row; status: WorkbenchLibraryDeleteStatus; error?: string };
const PAGE_SIZE = 40, MAX_SELECTION = 200;

/** Metadata only: opening this page never mounts an editor or a browser tab. */
export function WorkbenchLibrary({ connection, active, onBusy, onOpened, openLocalFile }: {
  connection: HubConnection; active: boolean; onBusy(value: boolean): void;
  onOpened(): void; openLocalFile?: (file: WorkbenchFileTarget) => Promise<void>;
}) {
  const locale = useLocale();
  const library = useContext(WorkbenchLibraryContext), hostName = useContext(RuntimeHostContext);
  const sources = library?.hosts ?? [{ id: "local", name: hostName ?? t("当前主机"), connection }];
  const sourcesRef = useRef(sources); sourcesRef.current = sources;
  const [identityVersion, setIdentityVersion] = useState(0);
  const sourceKey = sources.map(host => JSON.stringify([host.id, host.connection.cache.databaseName, host.connection.identity.hubPublicKey, host.connection.identity.deviceId, host.connection.state.user?.id, host.connection.isReadOnly, host.connection.isClosed])).join("|");
  const [rows, setRows] = useState<Row[]>([]), [notices, setNotices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [kind, setKind] = useState(""), [hostFilter, setHostFilter] = useState(""), [stateFilter, setStateFilter] = useState("");
  const [page, setPage] = useState(0), [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<Row[]>(), [results, setResults] = useState<Result[]>([]);
  const [operationNote, setOperationNote] = useState("");
  const generation = useRef(0), operation = useRef(false), request = useRef(0), mounted = useRef(true);
  const sourceKeyRef = useRef(sourceKey); sourceKeyRef.current = sourceKey;
  const selectionHint = useRef<HTMLParagraphElement>(null);
  const typeName = (value: string) => value === "markdown" ? t("笔记") : value === "design" ? t("设计") : t("白板");
  const stateName = (value: string) => ({ open: t("标签已打开"), closed: t("标签已关闭"), orphan: t("未关联标签"), missing: t("内容不存在") }[value] ?? value);
  const resultText = (status: WorkbenchLibraryDeleteStatus, error?: string) => error === "workbench_locks_unavailable" ? t("无法确认编辑状态，未删除") : ({
    deleted: t("已删除"), already_deleted: t("内容已不存在，记录已清理"),
    busy: t("正在编辑，请先关闭该标签后重试"),
    kind_mismatch: t("项目类型已变化，请刷新后重试"),
    scope_unavailable: t("所属主机或用户已变化，未删除"),
    reset_in_progress: t("正在重置本地数据，未删除"),
    failed: t("未能删除，请刷新后重试"),
  }[status] ?? t("未能删除，请刷新后重试"));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  // Only identity/access transitions trigger a reload, not every streamed reply.
  useEffect(() => {
    const stops = sourcesRef.current.map(host => {
      const identity = () => JSON.stringify([host.connection.state.user?.id, host.connection.isReadOnly, host.connection.isClosed]);
      let previous = identity();
      return host.connection.subscribe(() => { const next = identity(); if (previous !== next) { previous = next; setIdentityVersion(value => value + 1); } });
    });
    return () => stops.forEach(stop => stop());
  }, [sourceKey]);
  async function load(keepResults = false) {
    const version = generation.current, key = sourceKeyRef.current, read = ++request.current;
    setLoading(true); setError("");
    if (!keepResults) setResults([]);
    try {
      const hosts = [...sourcesRef.current];
      const values = await Promise.allSettled(hosts.map(async host => {
        const listing = await listWorkbenchLibrary(host.connection);
        const conversations = await host.connection.cache.conversations();
        return { listing, conversations: new Map(conversations.map(item => [item.id, item])) };
      }));
      if (!mounted.current || generation.current !== version || sourceKeyRef.current !== key || request.current !== read) return;
      const next: Row[] = [], warnings: string[] = [];
      values.forEach((value, index) => {
        const host = hosts[index]!;
        if (value.status !== "fulfilled") { warnings.push(t("「{0}」的本地文件暂不可读取，请恢复该主机的用户身份后刷新。", host.name)); return; }
        for (const item of value.value.listing.entries) {
          const conversation = value.value.conversations.get(item.conversationId);
          next.push({ ...item, host, key: JSON.stringify([host.connection.cache.databaseName, item.scope, item.kind, item.id]),
            conversationTitle: conversation?.title, conversationMissing: !conversation, conversationArchived: !!conversation?.archived,
            label: item.title || `${t("未命名 {0}", typeName(item.kind))} · ${item.id.slice(-6)}` });
        }
        if (value.value.listing.truncated) warnings.push(t("「{0}」记录较多，本次仅显示扫描范围内的结果，部分文件可能未列出。", host.name));
        if (value.value.listing.skipped) warnings.push(t("「{0}」有 {1} 条无法识别的记录，已保留。", host.name, value.value.listing.skipped));
      });
      setRows(next); setNotices(warnings);
      setSelected(old => new Set([...old].filter(key => next.some(row => row.key === key))));
    } catch (cause) {
      if (mounted.current && generation.current === version && request.current === read) { setRows([]); setError(t("暂时无法读取工作台文件，请重试。")); }
    } finally { if (mounted.current && generation.current === version && request.current === read) setLoading(false); }
  }
  useEffect(() => {
    generation.current++; setSelected(new Set()); setConfirmation(undefined); setResults([]); setRows([]);
    if (active) void load();
    return () => { generation.current++; };
  }, [active, sourceKey]);
  // Keep the identity subscription observable without making all connection
  // status messages part of the list-query dependencies.
  void identityVersion;
  useEffect(() => { setPage(0); setSelected(new Set()); setConfirmation(undefined); }, [query, kind, hostFilter, stateFilter]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter(row => (!kind || row.kind === kind) && (!hostFilter || row.host.id === hostFilter) && (!stateFilter || row.state === stateFilter)
      && `${row.label} ${row.conversationTitle ?? ""} ${row.host.name}`.toLocaleLowerCase().includes(needle));
  }, [rows, query, kind, hostFilter, stateFilter]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), current = Math.min(page, pages - 1), shown = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const chosen = rows.filter(row => selected.has(row.key));
  const toggle = (row: Row) => setSelected(old => { const next = new Set(old); if (next.has(row.key)) next.delete(row.key); else if (next.size < MAX_SELECTION) next.add(row.key); return next; });
  const disabled = busy || loading;
  async function open(row: Row) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(""); setOperationNote("");
    const version = generation.current;
    try {
      const target: WorkbenchFileTarget = { scope: row.scope, conversationId: row.conversationId, id: row.id, kind: row.kind, title: row.label };
      if (library) await library.open(row.host, target);
      else if (openLocalFile) await openLocalFile(target);
      else throw new Error("workbench_library_open_unavailable");
      if (mounted.current && generation.current === version) onOpened();
    } catch (cause) { if (mounted.current && generation.current === version) setError(workbenchErrorText(cause instanceof Error ? cause.message : "workbench_failed", locale)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  /** A design the App no longer opens (a Baoyu canvas from 1.6.0 or earlier) is saved as a project backup; nothing is opened or changed. */
  async function exportProject(row: Row) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(""); setOperationNote("");
    const version = generation.current;
    try { await saveDesignBackup(await exportStoredDesign(row.host.connection, row.scope, row.id, row.label), row.label); }
    catch (cause) { if (mounted.current && generation.current === version) setError(workbenchErrorText(cause instanceof Error ? cause.message : "workbench_failed", locale)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  async function remove() {
    if (!confirmation || operation.current) return;
    const captured = [...confirmation], version = generation.current, key = sourceKeyRef.current;
    operation.current = true; setBusy(true); setError(""); setOperationNote("");
    const outcomes: Result[] = [];
    try {
      for (const host of new Set(captured.map(row => row.host))) {
        if (!mounted.current || generation.current !== version || sourceKeyRef.current !== key) break;
        const items = captured.filter(row => row.host === host);
        try {
          const receipts = await deleteWorkbenchLibraryEntries(host.connection, items);
          items.forEach((row, index) => outcomes.push({ row, status: receipts[index]?.status ?? "failed", error: receipts[index]?.error }));
        } catch { for (const row of items) outcomes.push({ row, status: "failed" }); }
      }
      if (mounted.current && generation.current === version && sourceKeyRef.current === key) {
        setConfirmation(undefined); setResults(outcomes);
        setSelected(new Set(outcomes.filter(value => !["deleted", "already_deleted"].includes(value.status)).map(value => value.row.key)));
        await load(true); selectionHint.current?.focus({ preventScroll: true });
      } else if (mounted.current) {
        // Do not expose a previous identity's filenames after a scope change,
        // but keep an honest receipt for deletions that already committed.
        const cleared = outcomes.filter(value => ["deleted", "already_deleted"].includes(value.status)).length;
        const unstarted = captured.length - outcomes.length;
        setOperationNote(t("已清理 {0} 项。主机或身份已变化，{1} 项未继续执行；请刷新核对结果。", cleared, unstarted));
      }
    } finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  const removed = results.filter(result => result.status === "deleted" || result.status === "already_deleted").length;
  const failed = results.filter(result => result.status !== "deleted" && result.status !== "already_deleted");
  return <div className="workbench-library">
    <p className="settings-lede">{t("集中管理这台设备保存的白板、笔记和设计，包含已关闭的标签。")}</p>
    <div className="workbench-library-filters">
      <label className="workbench-library-search"><Search size={16} aria-hidden="true"/><input type="search" aria-label={t("搜索工作台文件")} placeholder={t("搜索名称、对话或主机")} value={query} disabled={busy} onChange={event => setQuery(event.target.value)}/></label>
      <LibraryFilter label={t("工作台文件类型")} value={kind} disabled={busy} change={setKind} display={kind ? typeName(kind) : t("全部类型")}><option value="">{t("全部类型")}</option>{["whiteboard", "markdown", "design"].map(value => <option key={value} value={value}>{typeName(value)}</option>)}</LibraryFilter>
      <LibraryFilter label={t("工作台文件主机")} value={hostFilter} disabled={busy} change={setHostFilter} display={sources.find(host => host.id === hostFilter)?.name ?? t("全部主机")}><option value="">{t("全部主机")}</option>{sources.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}</LibraryFilter>
      <LibraryFilter label={t("工作台文件状态")} value={stateFilter} disabled={busy} change={setStateFilter} display={stateFilter ? stateName(stateFilter) : t("全部状态")}><option value="">{t("全部状态")}</option>{["open", "closed", "orphan", "missing"].map(value => <option key={value} value={value}>{stateName(value)}</option>)}</LibraryFilter>
    </div>
    <div className="workbench-library-toolbar">
      <span>{t("共 {0} 项", filtered.length)}</span>
      <button type="button" disabled={disabled} onClick={() => { setOperationNote(""); void load(); }}><RefreshCw size={14} aria-hidden="true"/>{t("刷新")}</button>
      <button type="button" disabled={disabled || !shown.length} onClick={() => setSelected(old => shown.every(row => old.has(row.key)) ? new Set([...old].filter(key => !shown.some(row => row.key === key))) : new Set([...old, ...shown.map(row => row.key)].slice(0, MAX_SELECTION)))}><CheckSquare size={14} aria-hidden="true"/>{shown.length && shown.every(row => selected.has(row.key)) ? t("取消本页选择") : t("选择本页")}</button>
    </div>
    <div className="workbench-library-selection">
      <p ref={selectionHint} tabIndex={-1} role="status">{selected.size ? t("已选 {0} 项", selected.size) : t("勾选后可批量删除")}{selected.size >= MAX_SELECTION && t(" · 每次最多 200 项")}</p>
      {!!selected.size && <button type="button" disabled={disabled} onClick={() => setSelected(new Set())}>{t("取消选择")}</button>}
      <button type="button" className="text-danger" disabled={disabled || !chosen.length} onClick={() => setConfirmation(chosen)}><Trash2 size={14} aria-hidden="true"/>{t("删除所选")}</button>
    </div>
    {notices.map(notice => <p className="settings-note" role="status" key={notice}>{notice}</p>)}
    {operationNote && <p role="status" className="workbench-library-result">{operationNote}</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {!!results.length && <div className="workbench-library-result" role="status"><p>{(failed.length ? t("已清理 {0} 项，{1} 项未删除。", removed, failed.length) : t("已清理 {0} 项。", removed))}</p>{!!failed.length && <ul>{failed.map(result => <li key={result.row.key}><strong>{result.row.label}</strong> · {resultText(result.status, result.error)}</li>)}</ul>}</div>}
    {loading ? <p role="status" className="workbench-library-empty">{t("正在读取文件列表…")}</p> : !filtered.length ? <div className="workbench-library-empty"><FolderOpen size={24} aria-hidden="true"/><p>{rows.length ? t("没有匹配的文件，试试调整筛选。") : t("当前没有可显示的工作台文件。")}</p></div> : <ul className="workbench-library-list">
      {shown.map(row => { const Icon = row.kind === "markdown" ? FileText : row.kind === "design" ? LayoutGrid : SquarePen; const canOpen = ["open", "closed", "orphan"].includes(row.state) && !row.layoutInvalid && !row.conversationMissing && !row.conversationArchived && !!(library || openLocalFile);
        // Not a deck with a Tab: a Baoyu canvas, which is no longer opened, or a design without a Tab. Its stored project can still be saved.
        const exportable = row.kind === "design" && row.state !== "missing" && row.designFormat !== "slides";
        const openButton = <button type="button" disabled={busy || !canOpen} title={!canOpen ? t("所属对话或文件不可打开，仍可清理此记录") : undefined} aria-label={t("打开：{0}", row.label)} onClick={() => void open(row)}><ArrowUpRight size={15} aria-hidden="true"/>{t("打开")}</button>;
        return <li key={row.key} data-selected={selected.has(row.key)}>
        <input type="checkbox" checked={selected.has(row.key)} disabled={busy || !selected.has(row.key) && selected.size >= MAX_SELECTION} aria-label={t("选择：{0}", row.label)} onChange={() => toggle(row)}/><Icon className="workbench-library-kind" size={19} aria-hidden="true"/>
        <div className="workbench-library-description"><strong title={row.label}>{row.label}</strong><span>{row.host.name} · {row.conversationTitle || t("对话已移除")}</span><small>{typeName(row.kind)} · {stateName(row.state)}{row.conversationArchived && t(" · 对话已归档")}{row.layoutInvalid && t(" · 标签记录异常")}</small></div>
        {exportable ? <span className="workbench-library-row-actions"><button type="button" disabled={busy} title={t("导出项目备份（.tarobot-design.json）")} aria-label={t("导出：{0}", row.label)} onClick={() => void exportProject(row)}><Download size={15} aria-hidden="true"/>{t("导出")}</button>{openButton}</span> : openButton}
      </li>; })}
    </ul>}
    {pages > 1 && <nav className="workbench-library-pagination" aria-label={t("工作台文件分页")}><button disabled={disabled || current === 0} onClick={() => setPage(current - 1)}>{t("上一页")}</button><span>{current + 1} / {pages}</span><button disabled={disabled || current + 1 >= pages} onClick={() => setPage(current + 1)}>{t("下一页")}</button></nav>}
    <p className="settings-note muted">{t("文件仅保存在当前设备。删除不会清理聊天消息、模型会话或其他设备的副本；浏览器网站数据也不在此清理。")}</p>
    {confirmation && <CreationDialog title={t("删除这 {0} 项工作台内容？", confirmation.length)} busy={busy} close={() => setConfirmation(undefined)} closeLabel={t("取消删除工作台文件")} mobilePage showHost={false} className="workbench-library-confirm">
      <p>{t("仅删除下面所选内容在这台设备上的保存副本及标签记录。无法撤销，需要保留时请先在工作台导出。")}</p>
      <p>{t("正在编辑的项目会保留，并在结果中说明。聊天消息和模型会话保留。")}</p>
      {confirmation.some(row => row.layoutInvalid) && <p>{t("标签记录异常的项目仅删除对应文件内容，异常标签记录会保留。")}</p>}
      <ul>{confirmation.map(row => <li key={row.key}><strong>{row.label}</strong><small>{row.host.name} · {row.conversationTitle || t("对话已移除")}</small></li>)}</ul>
      <footer><button disabled={busy} onClick={() => setConfirmation(undefined)}>{t("取消")}</button><button className="text-danger" disabled={busy} onClick={() => void remove()}>{busy ? t("正在删除…") : t("删除 {0} 项", confirmation.length)}</button></footer>
    </CreationDialog>}
  </div>;
}
