import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, CheckSquare, ChevronDown, FileText, FolderOpen, LayoutGrid, RefreshCw, Search, SquarePen, Trash2 } from "lucide-react";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { WorkbenchLibraryContext, type WorkbenchFileTarget, type WorkbenchLibraryHost } from "./workbench-library-context.js";
import { listWorkbenchLibrary, deleteWorkbenchLibraryEntries, type WorkbenchLibraryEntry, type WorkbenchLibraryDeleteStatus } from "./workbench-library.js";
import { workbenchErrorText } from "./workbench-error.js";
import { useLocale } from "./i18n.js";
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
  const locale = useLocale(), word = (zh: string, en: string) => locale === "en" ? en : zh;
  const library = useContext(WorkbenchLibraryContext), hostName = useContext(RuntimeHostContext);
  const sources = library?.hosts ?? [{ id: "local", name: hostName ?? word("当前主机", "Current host"), connection }];
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
  const typeName = (value: string) => value === "markdown" ? word("笔记", "Note") : value === "design" ? word("设计", "Design") : word("白板", "Whiteboard");
  const stateName = (value: string) => ({ open: word("标签已打开", "Tab open"), closed: word("标签已关闭", "Tab closed"), orphan: word("未关联标签", "No tab reference"), missing: word("内容不存在", "Content missing") }[value] ?? value);
  const resultText = (status: WorkbenchLibraryDeleteStatus, error?: string) => error === "workbench_locks_unavailable" ? word("无法确认编辑状态，未删除", "Editing state could not be verified; not deleted") : ({
    deleted: word("已删除", "Deleted"), already_deleted: word("内容已不存在，记录已清理", "Missing content; reference cleared"),
    busy: word("正在编辑，请先关闭该标签后重试", "In use. Close its editor tab and retry"),
    kind_mismatch: word("项目类型已变化，请刷新后重试", "Item type changed. Refresh and retry"),
    scope_unavailable: word("所属主机或用户已变化，未删除", "Host or user changed; not deleted"),
    reset_in_progress: word("正在重置本地数据，未删除", "Local reset in progress; not deleted"),
    failed: word("未能删除，请刷新后重试", "Could not delete. Refresh and retry"),
  }[status] ?? word("未能删除，请刷新后重试", "Could not delete. Refresh and retry"));
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
        if (value.status !== "fulfilled") { warnings.push(word(`「${host.name}」的本地文件暂不可读取，请恢复该主机的用户身份后刷新。`, `Local files for “${host.name}” are unavailable. Restore its user identity and refresh.`)); return; }
        for (const item of value.value.listing.entries) {
          const conversation = value.value.conversations.get(item.conversationId);
          next.push({ ...item, host, key: JSON.stringify([host.connection.cache.databaseName, item.scope, item.kind, item.id]),
            conversationTitle: conversation?.title, conversationMissing: !conversation, conversationArchived: !!conversation?.archived,
            label: item.title || `${word("未命名", "Untitled ")}${typeName(item.kind)} · ${item.id.slice(-6)}` });
        }
        if (value.value.listing.truncated) warnings.push(word(`「${host.name}」记录较多，本次仅显示扫描范围内的结果，部分文件可能未列出。`, `The scan limit was reached for “${host.name}”. Some files may not be listed.`));
        if (value.value.listing.skipped) warnings.push(word(`「${host.name}」有 ${value.value.listing.skipped} 条无法识别的记录，已保留。`, `${value.value.listing.skipped} unrecognized records in “${host.name}” were kept.`));
      });
      setRows(next); setNotices(warnings);
      setSelected(old => new Set([...old].filter(key => next.some(row => row.key === key))));
    } catch (cause) {
      if (mounted.current && generation.current === version && request.current === read) { setRows([]); setError(word("暂时无法读取工作台文件，请重试。", "Workbench files could not be read. Try again.")); }
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
        setOperationNote(word(`已清理 ${cleared} 项。主机或身份已变化，${unstarted} 项未继续执行；请刷新核对结果。`, `${cleared} items cleared. The host or identity changed; ${unstarted} items were not attempted. Refresh to check the results.`));
      }
    } finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  const removed = results.filter(result => result.status === "deleted" || result.status === "already_deleted").length;
  const failed = results.filter(result => result.status !== "deleted" && result.status !== "already_deleted");
  return <div className="workbench-library">
    <p className="settings-lede">{word("集中管理这台设备保存的白板、笔记和设计，包含已关闭的标签。", "Manage boards, notes and designs saved on this device, including closed tabs.")}</p>
    <div className="workbench-library-filters">
      <label className="workbench-library-search"><Search size={16} aria-hidden="true"/><input type="search" aria-label={word("搜索工作台文件", "Search workbench files")} placeholder={word("搜索名称、对话或主机", "Search name, conversation or host")} value={query} disabled={busy} onChange={event => setQuery(event.target.value)}/></label>
      <LibraryFilter label={word("工作台文件类型", "Workbench file type")} value={kind} disabled={busy} change={setKind} display={kind ? typeName(kind) : word("全部类型", "All types")}><option value="">{word("全部类型", "All types")}</option>{["whiteboard", "markdown", "design"].map(value => <option key={value} value={value}>{typeName(value)}</option>)}</LibraryFilter>
      <LibraryFilter label={word("工作台文件主机", "Workbench file host")} value={hostFilter} disabled={busy} change={setHostFilter} display={sources.find(host => host.id === hostFilter)?.name ?? word("全部主机", "All hosts")}><option value="">{word("全部主机", "All hosts")}</option>{sources.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}</LibraryFilter>
      <LibraryFilter label={word("工作台文件状态", "Workbench file state")} value={stateFilter} disabled={busy} change={setStateFilter} display={stateFilter ? stateName(stateFilter) : word("全部状态", "All states")}><option value="">{word("全部状态", "All states")}</option>{["open", "closed", "orphan", "missing"].map(value => <option key={value} value={value}>{stateName(value)}</option>)}</LibraryFilter>
    </div>
    <div className="workbench-library-toolbar">
      <span>{word(`共 ${filtered.length} 项`, `${filtered.length} items`)}</span>
      <button type="button" disabled={disabled} onClick={() => { setOperationNote(""); void load(); }}><RefreshCw size={14} aria-hidden="true"/>{word("刷新", "Refresh")}</button>
      <button type="button" disabled={disabled || !shown.length} onClick={() => setSelected(old => shown.every(row => old.has(row.key)) ? new Set([...old].filter(key => !shown.some(row => row.key === key))) : new Set([...old, ...shown.map(row => row.key)].slice(0, MAX_SELECTION)))}><CheckSquare size={14} aria-hidden="true"/>{shown.length && shown.every(row => selected.has(row.key)) ? word("取消本页选择", "Deselect page") : word("选择本页", "Select page")}</button>
    </div>
    <div className="workbench-library-selection">
      <p ref={selectionHint} tabIndex={-1} role="status">{selected.size ? word(`已选 ${selected.size} 项`, `${selected.size} selected`) : word("勾选后可批量删除", "Select files to delete them together")}{selected.size >= MAX_SELECTION && word(" · 每次最多 200 项", " · Up to 200 per batch")}</p>
      {!!selected.size && <button type="button" disabled={disabled} onClick={() => setSelected(new Set())}>{word("取消选择", "Clear selection")}</button>}
      <button type="button" className="text-danger" disabled={disabled || !chosen.length} onClick={() => setConfirmation(chosen)}><Trash2 size={14} aria-hidden="true"/>{word("删除所选", "Delete selected")}</button>
    </div>
    {notices.map(notice => <p className="settings-note" role="status" key={notice}>{notice}</p>)}
    {operationNote && <p role="status" className="workbench-library-result">{operationNote}</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {!!results.length && <div className="workbench-library-result" role="status"><p>{word(`已清理 ${removed} 项${failed.length ? `，${failed.length} 项未删除` : ""}。`, `${removed} items cleared${failed.length ? `; ${failed.length} not deleted` : ""}.`)}</p>{!!failed.length && <ul>{failed.map(result => <li key={result.row.key}><strong>{result.row.label}</strong> · {resultText(result.status, result.error)}</li>)}</ul>}</div>}
    {loading ? <p role="status" className="workbench-library-empty">{word("正在读取文件列表…", "Loading files…")}</p> : !filtered.length ? <div className="workbench-library-empty"><FolderOpen size={24} aria-hidden="true"/><p>{rows.length ? word("没有匹配的文件，试试调整筛选。", "No matches. Try different filters.") : word("当前没有可显示的工作台文件。", "No workbench files to show.")}</p></div> : <ul className="workbench-library-list">
      {shown.map(row => { const Icon = row.kind === "markdown" ? FileText : row.kind === "design" ? LayoutGrid : SquarePen; const canOpen = ["open", "closed", "orphan"].includes(row.state) && !row.layoutInvalid && !row.conversationMissing && !row.conversationArchived && !!(library || openLocalFile); return <li key={row.key} data-selected={selected.has(row.key)}>
        <input type="checkbox" checked={selected.has(row.key)} disabled={busy || !selected.has(row.key) && selected.size >= MAX_SELECTION} aria-label={word(`选择：${row.label}`, `Select: ${row.label}`)} onChange={() => toggle(row)}/><Icon className="workbench-library-kind" size={19} aria-hidden="true"/>
        <div className="workbench-library-description"><strong title={row.label}>{row.label}</strong><span>{row.host.name} · {row.conversationTitle || word("对话已移除", "Conversation removed")}</span><small>{typeName(row.kind)} · {stateName(row.state)}{row.conversationArchived && word(" · 对话已归档", " · Conversation archived")}{row.layoutInvalid && word(" · 标签记录异常", " · Invalid tab record")}</small></div>
        <button type="button" disabled={busy || !canOpen} title={!canOpen ? word("所属对话或文件不可打开，仍可清理此记录", "The conversation or file is unavailable; this record can still be cleaned up") : undefined} aria-label={word(`打开：${row.label}`, `Open: ${row.label}`)} onClick={() => void open(row)}><ArrowUpRight size={15} aria-hidden="true"/>{word("打开", "Open")}</button>
      </li>; })}
    </ul>}
    {pages > 1 && <nav className="workbench-library-pagination" aria-label={word("工作台文件分页", "Workbench files pagination")}><button disabled={disabled || current === 0} onClick={() => setPage(current - 1)}>{word("上一页", "Previous")}</button><span>{current + 1} / {pages}</span><button disabled={disabled || current + 1 >= pages} onClick={() => setPage(current + 1)}>{word("下一页", "Next")}</button></nav>}
    <p className="settings-note muted">{word("文件仅保存在当前设备。删除不会清理聊天消息、模型会话或其他设备的副本；浏览器网站数据也不在此清理。", "Files are stored on this device. Deleting them does not remove chat messages, model sessions or copies on other devices. Website data is managed separately.")}</p>
    {confirmation && <CreationDialog title={word(`删除这 ${confirmation.length} 项工作台内容？`, `Delete these ${confirmation.length} workbench items?`)} busy={busy} close={() => setConfirmation(undefined)} closeLabel={word("取消删除工作台文件", "Cancel workbench deletion")} mobilePage showHost={false} className="workbench-library-confirm">
      <p>{word("仅删除下面所选内容在这台设备上的保存副本及标签记录。无法撤销，需要保留时请先在工作台导出。", "Only the selected saved content and its tab references on this device will be removed. This cannot be undone. Export anything you need from the workbench first.")}</p>
      <p>{word("正在编辑的项目会保留，并在结果中说明。聊天消息和模型会话保留。", "Items being edited will be kept and listed in the result. Chat messages and model sessions remain.")}</p>
      {confirmation.some(row => row.layoutInvalid) && <p>{word("标签记录异常的项目仅删除对应文件内容，异常标签记录会保留。", "For items with invalid tab records, only the file content is deleted; the invalid record is retained.")}</p>}
      <ul>{confirmation.map(row => <li key={row.key}><strong>{row.label}</strong><small>{row.host.name} · {row.conversationTitle || word("对话已移除", "Conversation removed")}</small></li>)}</ul>
      <footer><button disabled={busy} onClick={() => setConfirmation(undefined)}>{word("取消", "Cancel")}</button><button className="text-danger" disabled={busy} onClick={() => void remove()}>{busy ? word("正在删除…", "Deleting…") : word(`删除 ${confirmation.length} 项`, `Delete ${confirmation.length} items`)}</button></footer>
    </CreationDialog>}
  </div>;
}
