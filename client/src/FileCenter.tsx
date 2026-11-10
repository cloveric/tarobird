import { HostLocation } from "./RuntimeHost.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AttachmentManager } from "./AttachmentManager.js";
import { useBackAction } from "./back-navigation.js";
import { ArrowLeft, FolderOpen, RefreshCw, Star, X } from "lucide-react";
import { fileCategories, fileSafetyStates, fileCenterStatusSchema, type FileCenterStatus, type FileCenterUnit, type FileLabelPatch } from "../../src/client-protocol/file-center.js";
import type { Bot, HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale, formatList } from "./i18n.js";
import { bytes } from "./file-size.js";

const categoryNames = () => ({ browser: t("浏览器资料"), project: t("项目"), deliverable: t("成果文件"), download: t("下载与收件"), environment: t("运行环境"), cache: t("缓存与模型"), temporary: t("临时内容"), source: t("素材与资料"), unknown: t("用途待确认") });
const safetyNames = () => ({ protected: t("需要保留"), important: t("已标重要"), active: t("近期活跃"), rebuildable: t("通常可重建"), temporary: t("临时内容"), review: t("需要确认") });
const origins = () => ({ "bridge-input": t("Bot 收到的附件"), runtime: t("工具生成"), workspace: t("工作区"), unknown: t("来源待确认") });
function errorText(error: unknown): string {
  if (error instanceof HubHttpError && error.code === "file_label_conflict") return t("另一台设备已修改标注。你的草稿已保留，请先读取最新标注再决定。");
  if (error instanceof HubHttpError && error.code === "file_reveal_unavailable") return t("暂时无法在 Hub 电脑中显示。请检查 Bot 是否在线、文件是否仍在当前工作区。");
  return t("操作未完成，请检查连接后重试。");
}

function fileUnitDescription(unit: FileCenterUnit): string {
  if (unit.note) return unit.note;
  if (unit.rootKind === "workspace" && unit.kind === "directory") {
    if (/^\.(?:tarobot|lark|telegram)-files$/.test(unit.relativePath)) return t("处理附件时使用的工作副本");
    if (/^\.(?:tarobot|lark|telegram)-out$/.test(unit.relativePath)) return t("Bot 生成文件的工作目录");
  }
  return unit.relativePath;
}

export function FileCenter({ connection, bots, close, locate }: { connection: HubConnection; bots: Bot[]; close: () => void; locate?: (conversationId: string, messageId: string) => void }) {
  const locale = useLocale();
  const attachmentsAvailable = useSyncExternalStore(notify => connection.subscribe(notify), () => !!connection.state.attachmentAdminAvailable);
  const [view, setView] = useState<"files" | "attachments">("files"), [attachmentChat, setAttachmentChat] = useState(""), [attachmentBusy, setAttachmentBusy] = useState(false);
  const attachments = view === "attachments" && attachmentsAvailable;
  const [status, setStatus] = useState<FileCenterStatus>(); const [error, setError] = useState("");
  const [query, setQuery] = useState(""); const [category, setCategory] = useState(""); const [safety, setSafety] = useState(""); const [botId, setBotId] = useState(""); const [sort, setSort] = useState("size");
  const [selected, setSelected] = useState(""); const [page, setPage] = useState(0); const [dirty, setDirty] = useState(false);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const panel = useRef<HTMLElement>(null), sequence = useRef(0), closed = useRef(false), revision = useRef("");
  const accept = (value: unknown) => { const parsed = fileCenterStatusSchema.parse(value); revision.current = parsed.revision; setStatus(parsed); setError(""); return parsed; };
  const load = async () => { const n = ++sequence.current; const value = await connection.http<FileCenterStatus | { unchanged: true }>(`/api/files?revision=${encodeURIComponent(revision.current)}`); if (!closed.current && n === sequence.current) { if ("unchanged" in value && value.unchanged) { setError(""); return; } return accept(value); } };
  const scan = async () => { try { const n = ++sequence.current; const value = await connection.http("/api/files/scan", { method: "POST" }); if (!closed.current && n === sequence.current) accept(value); } catch (e) { setError(errorText(e)); } };
  const canLeave = () => !detailsBusy && !attachmentBusy && (!dirty || window.confirm(t("放弃尚未保存的标注？")));
  const leave = () => { if (canLeave()) close(); };
  const leaveRef = useRef(leave); leaveRef.current = leave;
  useEffect(() => {
    closed.current = false; let polling = false;
    const tick = async (initial = false) => { if (polling) return; polling = true; try { const result = await load(); if (initial && result && !result.inventory && !result.scanning) await scan(); } catch (e) { if (!closed.current) setError(errorText(e)); } finally { polling = false; } };
    void tick(true); const timer = setInterval(() => { if (document.visibilityState === "visible") void tick(); }, 1500);
    const focus = () => { void tick(); }; window.addEventListener("focus", focus);
    return () => { closed.current = true; sequence.current++; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [connection]);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null; panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); leaveRef.current(); }
      if (event.key === "Tab") {
        const elements = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[href]") ?? [])].filter((e) => e.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (!panel.current?.contains(document.activeElement) || !(document.activeElement as HTMLElement)?.getClientRects().length) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", key); return () => { document.removeEventListener("keydown", key); trigger?.focus(); };
  }, []);
  useEffect(() => { setPage(0); }, [query, category, safety, botId, sort]);
  const names = (ids: string[]) => formatList(ids.map((id) => bots.find((b) => b.id === id)?.name ?? id));
  const units = status?.inventory?.units ?? [];
  const visible = units.filter((u) => (!category || u.category === category) && (!safety || u.safety === safety) && (!botId || u.instances.includes(botId)) && `${u.name} ${u.absolutePath} ${u.note ?? ""} ${names(u.instances)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "modified" ? b.lastModifiedAt.localeCompare(a.lastModifiedAt) : b.allocatedBytes - a.allocatedBytes);
  const pages = Math.max(1, Math.ceil(visible.length / 50)), current = Math.min(page, pages - 1);
  const selectedUnit = units.find((unit) => unit.id === selected);
  useBackAction(panel, () => {
    if (!canLeave()) return;
    if (attachments && attachmentChat) setAttachmentChat("");
    else if (!attachments && selectedUnit) { setSelected(""); setDirty(false); }
    else close();
  });
  const save = async (patch: FileLabelPatch) => {
    sequence.current++; const result = await connection.http("/api/files/labels", { method: "PATCH", body: JSON.stringify(patch) }); sequence.current++;
    const next = accept(result); return next.inventory!.units.find((unit) => unit.id === patch.unitId)!;
  };
  return <div className="modal-scrim file-center-scrim"><section ref={panel} tabIndex={-1} className={`file-center ${(attachments ? attachmentChat : selectedUnit) ? "has-selection" : ""}`} role="dialog" aria-modal="true" aria-label={t("文件中心")}>
    <header className="file-center-header"><div><h2><FolderOpen size={21}/>{t("文件中心")}</h2><p>{t("查看 Bot 的工作区、附件和语音转写文件。共享工作区只统计一次。")}</p></div><button className="icon-button" aria-label={t("关闭文件中心")} onClick={leave}><X size={20}/></button><HostLocation/></header>
    {attachmentsAvailable && <div className="file-center-tabs" role="tablist" aria-label={t("文件中心视图")}>{([["files", t("工作区文件")], ["attachments", t("附件管理")]] as const).map(([value, label]) =>
      <button key={value} type="button" role="tab" aria-selected={view === value} disabled={detailsBusy || attachmentBusy} onClick={() => { if (view !== value && canLeave()) { setView(value); setSelected(""); setDirty(false); } }}>{label}</button>)}</div>}
    {attachments ? <AttachmentManager connection={connection} selected={attachmentChat} select={setAttachmentChat} locate={locate && ((conversationId, messageId) => { if (canLeave()) { close(); locate(conversationId, messageId); } })} busyChange={setAttachmentBusy}/> : <>
    <div className="file-center-summary"><div><small>{t("磁盘实际占用")}</small><strong>{status?.inventory ? bytes(status.inventory.totalAllocatedBytes) : "—"}</strong></div><div><small>{t("文件内容大小")}</small><strong>{status?.inventory ? bytes(status.inventory.totalLogicalBytes) : "—"}</strong></div><div><small>{t("文件组")}</small><strong>{status?.inventory?.unitCount ?? "—"}</strong></div><button className="file-action" disabled={!status || status.scanning} onClick={() => { void scan(); }}><RefreshCw size={15}/>{status?.scanning ? t("正在盘点…") : t("重新盘点")}</button>{status?.scanning && <button className="file-action" onClick={() => { void connection.http("/api/files/cancel", { method: "POST" }).then(load).catch((e: unknown) => setError(errorText(e))); }}>{t("取消盘点")}</button>}</div>
    <div className="file-center-notices" aria-live="polite">{status?.inventory && <span>{t("上次盘点：")}{new Date(status.inventory.generatedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</span>}{status?.error && <p role="status">{status.error === "scan_cancelled" ? t("盘点已取消，保留上次结果。") : t("盘点未完成，保留上次结果。请重试。")}</p>}{error && <p className="error-text" role="alert">{error}</p>}{!!status?.inventory?.warnings.length && <details><summary>{t("有 {0} 项未能完整盘点", status.inventory.warnings.length)}</summary>{status.inventory.warnings.map((w, i) => <p key={i}>{w}</p>)}</details>}</div>
    <div className="file-center-body"><div className="file-center-browser">
      <div className="file-center-filters">
        <input type="search" aria-label={t("搜索文件中心")} placeholder={t("搜索名称、位置或备注")} value={query} onChange={(e) => setQuery(e.target.value)}/>
        <select aria-label={t("所属 Bot")} value={botId} onChange={(e) => setBotId(e.target.value)}><option value="">{t("全部 Bot")}</option>{bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <select aria-label={t("文件分类")} value={category} onChange={(e) => setCategory(e.target.value)}><option value="">{t("全部分类")}</option>{fileCategories.map((v) => <option key={v} value={v}>{categoryNames()[v]}</option>)}</select>
        <select aria-label={t("文件状态")} value={safety} onChange={(e) => setSafety(e.target.value)}><option value="">{t("全部状态")}</option>{fileSafetyStates.map((v) => <option key={v} value={v}>{safetyNames()[v]}</option>)}</select>
      </div>
      <div className="file-center-results">
        <p className="file-filter-count">{t("共 {0} 组 · 当前筛选 {1} 组", units.length, visible.length)}</p>
        <select aria-label={t("文件排序")} value={sort} onChange={(e) => setSort(e.target.value)}><option value="size">{t("占用从大到小")}</option><option value="modified">{t("最近修改")}</option><option value="name">{t("按名称")}</option></select>
      </div>
      <div className="file-center-list">{visible.slice(current * 50, (current + 1) * 50).map((unit) => <button className={`file-unit ${selected === unit.id ? "selected" : ""}`} key={unit.id} onClick={() => { if (unit.id !== selected && canLeave()) { setSelected(unit.id); setDirty(false); } }}><div><strong>{unit.important && <Star size={13} fill="currentColor"/>}{t(unit.name)}</strong><span>{categoryNames()[unit.category]} · {names(unit.instances)}</span><small>{fileUnitDescription(unit)}</small></div><div><b>{bytes(unit.allocatedBytes)}</b><span className={`file-safety ${unit.safety}`}>{safetyNames()[unit.safety]}</span>{unit.partial && <small>{t("统计不完整")}</small>}</div></button>)}</div>
      {!visible.length && <p className="file-center-empty">{status?.scanning ? t("正在读取文件信息，请稍候。") : units.length ? t("没有匹配的文件组，试试调整筛选条件。") : t("尚无可显示的文件组。可在 Bot 工作区保存文件后重新盘点。")}</p>}
      {pages > 1 && <nav className="file-pagination" aria-label={t("文件分页")}><button disabled={current === 0} onClick={() => setPage(current - 1)}>{t("上一页")}</button><span>{current + 1} / {pages}</span><button disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>{t("下一页")}</button></nav>}
    </div>{selectedUnit && <FileDetails key={selectedUnit.id} unit={selectedUnit} names={names} canReveal={status?.canReveal ?? false} save={save} connection={connection} setDirty={setDirty} setParentBusy={setDetailsBusy} back={() => { if (canLeave()) { setSelected(""); setDirty(false); } }}/>}</div></>}
  </section></div>;
}

function FileDetails({ unit, names, canReveal, connection, save, setDirty, setParentBusy, back }: { unit: FileCenterUnit; names: (ids: string[]) => string; canReveal: boolean; connection: HubConnection; save: (p: FileLabelPatch) => Promise<FileCenterUnit>; setDirty: (v: boolean) => void; setParentBusy: (v: boolean) => void; back: () => void }) {
  const locale = useLocale();
  const [base, setBase] = useState(unit), [category, setCategory] = useState(unit.categorySource === "user" ? unit.category : ""), [important, setImportant] = useState(unit.important), [note, setNote] = useState(unit.note ?? "");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const dirty = category !== (base.categorySource === "user" ? base.category : "") || important !== base.important || note !== (base.note ?? "");
  const reset = (next: FileCenterUnit) => { setBase(next); setCategory(next.categorySource === "user" ? next.category : ""); setImportant(next.important); setNote(next.note ?? ""); setError(""); };
  useEffect(() => { setDirty(dirty); }, [dirty, setDirty]);
  useEffect(() => { if (!dirty && unit.labelRevision !== base.labelRevision) reset(unit); }, [unit, dirty, base.labelRevision]);
  const act = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setParentBusy(true); setError(""); setMessage(""); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); setParentBusy(false); } };
  return <aside className="file-details" aria-label={t("文件组详情")}><header><button className="file-action" disabled={busy} onClick={back}><ArrowLeft size={16}/>{t("返回文件列表")}</button><h3>{t(unit.name)}</h3><span className={`file-safety ${unit.safety}`}>{safetyNames()[unit.safety]}</span></header>
    <dl className="file-facts"><div><dt>{t("磁盘实际占用")}</dt><dd>{bytes(unit.allocatedBytes)}</dd></div><div><dt>{t("文件内容大小")}</dt><dd>{bytes(unit.logicalBytes)}</dd></div><div><dt>{t("文件与文件夹")}</dt><dd>{t("{0} 个文件 · {1} 个文件夹", unit.fileCount, unit.directoryCount)}</dd></div><div><dt>{t("符号链接")}</dt><dd>{unit.symlinkCount}</dd></div><div><dt>{t("最近修改")}</dt><dd>{new Date(unit.lastModifiedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</dd></div><div><dt>{t("所属 Bot")}</dt><dd>{names(unit.instances)}</dd></div><div><dt>{t("文件来源")}</dt><dd>{origins()[unit.origin]}</dd></div></dl>
    {unit.partial && <p className="error-text">{t("有 {0} 处内容无法读取，大小和数量可能偏小。", unit.errorCount)}</p>}
    <h4>{t("位置")}</h4><code className="file-location">{unit.absolutePath}</code><div className="file-detail-actions"><button className="file-action" disabled={busy} onClick={() => { void act(async () => { await navigator.clipboard.writeText(unit.absolutePath); setMessage(t("已复制位置")); }); }}>{t("复制位置")}</button>{canReveal && <button className="file-action" disabled={busy} onClick={() => { void act(async () => { await connection.http("/api/files/reveal", { method: "POST", body: JSON.stringify({ unitId: unit.id }) }); setMessage(t("已在 Hub 电脑中请求显示")); }); }}>{t("在 Hub 电脑中显示")}</button>}</div>
    <details><summary>{t("分类与状态依据")}</summary><ul>{unit.reasons.map((reason, index) => <li key={index}>{t(reason)}</li>)}</ul></details>
    {unit.topExtensions.length > 0 && <><h4>{t("主要文件类型")}</h4><ul className="file-types">{unit.topExtensions.map((ext) => <li key={ext.extension}><span>{ext.extension}</span><span>{bytes(ext.allocatedBytes)} · {ext.files}</span></li>)}</ul></>}
    {unit.largestFiles.length > 0 && <><h4>{t("最大的几个文件")}</h4><ul className="file-largest">{unit.largestFiles.map((file) => <li key={file.relativePath}><span title={file.relativePath}>{file.relativePath}</span><b>{bytes(file.allocatedBytes)}</b></li>)}</ul></>}
    <form onSubmit={(e) => { e.preventDefault(); void act(async () => { const next = await save({ unitId: unit.id, expectedRevision: base.labelRevision, category: category ? category as FileCenterUnit["category"] : null, important, note }); reset(next); setMessage(t("标注已保存，两端共享。")); }); }}>
      <h4>{t("你的标注")}</h4><p>{t("标注帮助你认出文件用途，不会改动文件内容。")}</p>
      {unit.labelRevision !== base.labelRevision && dirty && <p role="status">{t("另一台设备有新标注，你的草稿仍保留。")}</p>}
      <label className="file-important"><input type="checkbox" disabled={busy} checked={important} onChange={(e) => setImportant(e.target.checked)}/><Star size={15}/>{t("标记为重要")}</label>
      <label>{t("手动分类")}<select aria-label={t("手动分类")} disabled={busy} value={category} onChange={(e) => setCategory(e.target.value)}><option value="">{t("自动识别")}</option>{fileCategories.map((v) => <option key={v} value={v}>{categoryNames()[v]}</option>)}</select></label>
      <label>{t("文件备注")}<textarea aria-label={t("文件备注")} disabled={busy} maxLength={500} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("例如：客户交付稿，项目结束前保留")}/></label><small>{note.length} / 500</small>
      <div className="file-detail-actions"><button className="primary file-action" disabled={busy || !dirty} type="submit">{busy ? t("保存中…") : t("保存标注")}</button><button className="file-action" type="button" disabled={busy || !dirty} onClick={() => { reset(unit); setMessage(""); }}>{unit.labelRevision !== base.labelRevision ? t("读取最新标注") : t("还原标注")}</button></div>
    </form>{message && <p role="status">{message}</p>}{error && <p className="error-text" role="alert">{error}</p>}
  </aside>;
}
