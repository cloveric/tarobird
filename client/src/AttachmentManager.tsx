import { ArrowLeft, MessageSquareText, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ATTACHMENT_ADMIN_DELETE_PATH, ATTACHMENT_ADMIN_LIST_PATH, ATTACHMENT_ADMIN_PAGE_SIZE, ATTACHMENT_ADMIN_SUMMARY_PATH, attachmentAdminDeleteResultSchema, attachmentAdminListSchema, attachmentAdminSummarySchema, type AttachmentAdminList, type AttachmentAdminSummary } from "../../src/client-protocol/attachment-admin.js";
import type { HubConnection } from "./connection.js";
import { bytes } from "./file-size.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";

type Pending = { ids?: string[]; conversationId?: string; count: number; size: number; expected?: { count: number; bytes: number; revision: string } };
const kind = (mime: string, name: string) => /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toUpperCase() ?? mime.split("/")[1]?.toUpperCase() ?? mime;
const failure = (error: unknown) => error instanceof HubHttpError && error.code === "owner_required" ? t("仅主机主人可以管理附件。")
  : error instanceof HubHttpError && error.code === "attachment_set_changed" ? t("这个对话的附件刚有变化，没有删除。已重新读取，请再确认一次。") : t("操作未完成，请检查连接后重试。");

/** File Center › 附件管理: owner-only view of host attachments by conversation,
 * with real deletion. `selected` is owned by File Center for back navigation. */
export function AttachmentManager({ connection, selected, select, locate, busyChange }: {
  connection: HubConnection; selected: string; select: (conversationId: string) => void;
  locate?: (conversationId: string, messageId: string) => void; busyChange: (busy: boolean) => void;
}) {
  const locale = useLocale();
  const [summary, setSummary] = useState<AttachmentAdminSummary>(), [list, setList] = useState<AttachmentAdminList & { conversationId: string }>();
  const [sort, setSort] = useState<"size" | "time">("size"), [offset, setOffset] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set()), [confirm, setConfirm] = useState<Pending>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [error, setError] = useState("");
  const alive = useRef(true), listRequest = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { busyChange(busy); }, [busy, busyChange]);
  const loadSummary = async () => { try { const value = attachmentAdminSummarySchema.parse(await connection.http(ATTACHMENT_ADMIN_SUMMARY_PATH)); if (alive.current) setSummary(value); } catch (e) { if (alive.current) setError(failure(e)); } };
  const loadList = async () => {
    if (!selected) { setList(undefined); return; }
    const n = ++listRequest.current, query = new URLSearchParams({ conversationId: selected, sort, offset: String(offset) });
    try { const value = attachmentAdminListSchema.parse(await connection.http(`${ATTACHMENT_ADMIN_LIST_PATH}?${query}`)); if (alive.current && n === listRequest.current) setList({ ...value, conversationId: selected }); }
    catch (e) { if (alive.current && n === listRequest.current) setError(failure(e)); }
  };
  useEffect(() => { void loadSummary(); }, [connection]);
  useEffect(() => { setChecked(new Set()); setConfirm(undefined); void loadList(); }, [connection, selected, sort, offset]);
  useEffect(() => { setOffset(0); }, [selected, sort]);
  const conversation = summary?.conversations.find(item => item.conversationId === selected);
  const items = list?.conversationId === selected ? list.items : [];
  const pages = Math.max(1, Math.ceil((list?.total ?? 0) / ATTACHMENT_ADMIN_PAGE_SIZE)), page = Math.floor(offset / ATTACHMENT_ADMIN_PAGE_SIZE);
  const selectedItems = items.filter(item => checked.has(item.id));
  const toggle = (id: string) => setChecked(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const remove = async (target: Pending) => {
    setBusy(true); setError(""); setStatus("");
    try {
      const result = attachmentAdminDeleteResultSchema.parse(await connection.http(ATTACHMENT_ADMIN_DELETE_PATH, { method: "POST", body: JSON.stringify(target.ids ? { ids: target.ids } : { conversationId: target.conversationId, ...(target.expected ? { expected: target.expected } : {}) }) }));
      await connection.forgetDeletedAttachments(result.ids);
      if (!alive.current) return;
      setConfirm(undefined); setChecked(new Set());
      setStatus([result.deleted ? t("已删除 {0} 个附件，释放 {1}。", result.deleted, bytes(result.freedBytes)) : "",
        result.pending.length ? t("{0} 个附件所在的消息 Bot 还没处理完，稍后再删。", result.pending.length) : ""].filter(Boolean).join(" "));
      await Promise.all([loadSummary(), loadList()]);
    } catch (e) {
      if (!alive.current) return;
      setError(failure(e));
      if (e instanceof HubHttpError && e.code === "attachment_set_changed") { setConfirm(undefined); await Promise.all([loadSummary(), loadList()]); }
    }
    finally { if (alive.current) setBusy(false); }
  };
  const when = (at: number) => new Date(at).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return <>
    <div className="file-center-summary"><div><small>{t("附件总占用")}</small><strong>{summary ? bytes(summary.bytes) : "—"}</strong></div><div><small>{t("附件数")}</small><strong>{summary?.count ?? "—"}</strong></div>
      <button className="file-action" disabled={busy} onClick={() => { setStatus(""); setError(""); void loadSummary(); void loadList(); }}><RefreshCw size={15}/>{t("刷新")}</button></div>
    <div className="file-center-notices" aria-live="polite">{status && <span role="status">{status}</span>}{error && <p className="error-text" role="alert">{error}</p>}</div>
    <div className="file-center-body"><div className="file-center-browser attachment-browser">
      <p className="file-filter-count">{summary ? t("{0} 个对话有附件", summary.conversations.length) : t("正在读取附件…")}</p>
      <div className="file-center-list">{summary?.conversations.map(item => <button key={item.conversationId} className={`file-unit ${selected === item.conversationId ? "selected" : ""}`} disabled={busy} onClick={() => select(item.conversationId)}>
        <div><strong>{item.title || t("未命名对话")}</strong><span>{t("{0} 个附件", item.count)}</span></div><div><b>{bytes(item.bytes)}</b></div></button>)}</div>
      {summary && !summary.conversations.length && <p className="file-center-empty">{t("暂无占用空间的附件。")}</p>}
    </div>
    {selected && <aside className="file-details attachment-details" aria-label={t("对话附件")}>
      <header><button className="file-action" disabled={busy} onClick={() => select("")}><ArrowLeft size={16}/>{t("返回对话列表")}</button>
        <h3>{conversation?.title || t("未命名对话")}</h3>{conversation && <p>{t("{0} 个附件 · 共 {1}", conversation.count, bytes(conversation.bytes))}</p>}</header>
      <div className="attachment-toolbar"><select aria-label={t("附件排序")} value={sort} disabled={busy} onChange={event => setSort(event.target.value === "time" ? "time" : "size")}><option value="size">{t("占用从大到小")}</option><option value="time">{t("最近上传")}</option></select>
        <button type="button" className="danger" disabled={busy || !conversation} onClick={() => conversation && setConfirm({ conversationId: selected, count: conversation.count, size: conversation.bytes, expected: { count: conversation.count, bytes: conversation.bytes, revision: conversation.revision } })}><Trash2 size={15}/>{t("删除全部附件")}</button></div>
      <ul className="attachment-list">{items.map(item => <li key={item.id} data-pending={item.pending || undefined}>
        <label><input type="checkbox" disabled={busy || item.pending} checked={checked.has(item.id)} onChange={() => toggle(item.id)} aria-label={t("选择附件 {0}", item.name)}/>
          <span><strong title={item.name}>{item.name}</strong><small>{kind(item.mime, item.name)} · {bytes(item.size)} · {when(item.createdAt)}</small></span></label>
        <div className="attachment-item-actions">{item.pending && <span className="file-safety">{t("Bot 未处理完")}</span>}
          {locate && <button type="button" className="icon-button" title={t("定位消息")} aria-label={t("定位到附件 {0} 的消息", item.name)} disabled={busy} onClick={() => locate(item.conversationId, item.messageId)}><MessageSquareText size={16}/></button>}</div>
      </li>)}</ul>
      {list && list.conversationId === selected && !items.length && <p className="file-center-empty">{t("这个对话已没有可删除的附件。")}</p>}
      {pages > 1 && <nav className="file-pagination" aria-label={t("附件分页")}><button disabled={busy || page === 0} onClick={() => setOffset((page - 1) * ATTACHMENT_ADMIN_PAGE_SIZE)}>{t("上一页")}</button><span>{page + 1} / {pages}</span><button disabled={busy || page + 1 >= pages} onClick={() => setOffset((page + 1) * ATTACHMENT_ADMIN_PAGE_SIZE)}>{t("下一页")}</button></nav>}
      {confirm ? <div className="attachment-confirm" role="alertdialog" aria-label={t("确认删除附件")}>
        <p><strong>{t("删除 {0} 个附件，释放 {1}？", confirm.count, bytes(confirm.size))}</strong></p>
        <p className="muted">{t("删除后无法恢复；只删除主机上的这份，消息里会显示「附件已删除」。")}</p>
        <div><button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button><button type="button" className="danger" disabled={busy} onClick={() => { void remove(confirm); }}>{busy ? t("正在删除…") : t("确认删除")}</button></div>
      </div> : <div className="attachment-selection"><button type="button" className="danger" disabled={busy || !selectedItems.length}
        onClick={() => setConfirm({ ids: selectedItems.map(item => item.id), count: selectedItems.length, size: selectedItems.reduce((sum, item) => sum + item.size, 0) })}><Trash2 size={15}/>{t("删除所选（{0}）", selectedItems.length)}</button></div>}
    </aside>}</div>
  </>;
}
