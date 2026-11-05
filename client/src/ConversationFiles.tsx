import { useEffect, useRef, useState } from "react";
import { observeMessageDeletions } from "./observe-message-deletions.js";
import { ArrowUpRight, FolderOpen, RefreshCw, Search } from "lucide-react";
import type { Conversation } from "../../src/client-protocol/index.js";
import { conversationFilesPageSchema, type ConversationFilesPage } from "../../src/client-protocol/conversation-files.js";
import type { Bot, HubConnection } from "./connection.js";
import { AttachmentFile } from "./Content.js";
import { CreationDialog } from "./CreationDialog.js";
import { useBotLabels } from "./BotReferences.js";
import { t, useLocale } from "./i18n.js";
import "./conversation-files.css";

export function ConversationFiles({ connection, conversation, bots, close, locate }: {
  connection: HubConnection; conversation: Conversation; bots: Bot[]; close: () => void;
  locate: (conversationId: string, messageId: string) => void;
}) {
  useLocale(); const labels = useBotLabels();
  const [scope, setScope] = useState(""), [query, setQuery] = useState(""), [applied, setApplied] = useState(""), [revision, refresh] = useState(0);
  const members = bots.filter(bot => conversation.botIds.includes(bot.id));
  const botName = scope ? labels.get(scope) ?? members.find(bot => bot.id === scope)?.name ?? scope : "";
  return <CreationDialog title={t("对话文件")} closeLabel={t("关闭对话文件")} close={close} className="conversation-files" movable>
    <p className="conversation-files-context"><FolderOpen size={18}/><strong>{scope ? t("{0} · 全部对话", botName) : conversation.title}</strong></p>
    <form className="conversation-files-filters" onSubmit={event => { event.preventDefault(); setApplied(query.trim()); refresh(value => value + 1); }}>
      <label className="conversation-files-search"><Search size={17}/><input type="search" maxLength={256} aria-label={t("搜索对话文件")} placeholder={t("搜索文件名")} value={query} onChange={event => setQuery(event.target.value)}/></label>
      <button type="submit">{t("搜索")}</button>
      <select aria-label={t("文件范围")} value={scope} onChange={event => setScope(event.target.value)}><option value="">{t("当前对话")}</option>{members.map(bot => <option value={bot.id} key={bot.id}>{t("{0} · 全部对话", labels.get(bot.id) ?? bot.name)}</option>)}</select>
      <button type="button" className="icon-button" aria-label={t("刷新文件列表")} title={t("刷新文件列表")} onClick={() => refresh(value => value + 1)}><RefreshCw size={17}/></button>
    </form>
    <p className="conversation-files-note">{scope ? t("包含该 Bot 参与且你可访问的单聊、群组和话题中分享的文件。") : t("本对话中收发的文件，按发送时间从新到旧排列。")}</p>
    <FileResults key={JSON.stringify([conversation.id, scope, applied, revision])} connection={connection} conversationId={conversation.id} botId={scope} query={applied} locate={locate}/>
  </CreationDialog>;
}

function FileResults({ connection, conversationId, botId, query, locate }: {
  connection: HubConnection; conversationId: string; botId: string; query: string; locate: (conversationId: string, messageId: string) => void;
}) {
  const locale = useLocale(), labels = useBotLabels();
  const [result, setResult] = useState<ConversationFilesPage>(), [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const requestedPage = useRef(0);
  const cursors = useRef<(string | undefined)[]>([undefined]), controller = useRef<AbortController | undefined>(undefined);
  const load = async (index: number) => {
    requestedPage.current = index; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    const params = new URLSearchParams({ conversationId, q: query });
    if (botId) params.set("botId", botId);
    const cursor = cursors.current[index]; if (cursor) params.set("cursor", cursor);
    try {
      const next = conversationFilesPageSchema.parse(await connection.http(`/api/conversation-files?${params}`, { signal: abort.signal }));
      if (abort.signal.aborted) return;
      setResult(next); setPage(index); cursors.current[index + 1] = next.nextCursor ?? undefined;
    } catch { if (!abort.signal.aborted) setError(t("文件列表加载失败，请检查连接后重试。")); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  useEffect(() => { void load(0); return () => controller.current?.abort(); }, [connection]);
  useEffect(() => {
    if (!result) return;
    return observeMessageDeletions(connection, hidden => {
      if (result.items.some(item => hidden.has(item.messageId))) setResult(current => current === result ? { ...result, items: result.items.filter(item => !hidden.has(item.messageId)) } : current);
    });
  }, [connection, result]);
  return <>
    {error && <p className="error-text" role="alert">{error}<button onClick={() => { void load(requestedPage.current); }}>{t("重试")}</button></p>}
    {busy && <p className="conversation-files-notice" role="status">{t("正在加载文件…")}</p>}
    <div className="conversation-files-head" aria-hidden="true"><span>{t("文件")}</span><span>{t("发送人 / 来源")}</span><span>{t("发送时间")}</span><span/></div>
    <div className="conversation-files-list" aria-busy={busy}>
      {result?.items.map(file => <article className="conversation-file-row" key={`${file.messageId}:${file.attachmentId}`}>
        <AttachmentFile list connection={connection} block={{ type: "file", attachmentId: file.attachmentId, name: file.name, size: file.size, mime: file.mime }}/>
        <div className="conversation-file-author"><span>{file.authorType === "user" && file.authorId === connection.state.user?.id ? t("我") : file.authorType === "bot" ? labels.get(file.authorId) ?? file.authorName : file.authorName}</span><small title={file.conversationTitle}>{file.conversationTitle}</small></div>
        <time dateTime={new Date(file.createdAt).toISOString()}>{new Date(file.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
        <button className="icon-button file-locate" aria-label={t("查看 {0} 的原消息", file.name)} title={t("查看原消息")} onClick={() => locate(file.conversationId, file.messageId)}><ArrowUpRight size={18}/></button>
      </article>)}
      {!busy && !error && !result?.items.length && <div className="conversation-files-empty"><FolderOpen size={30}/><p>{query ? t("没有匹配的文件，试试其他文件名。") : t("这里还没有分享过文件。")}</p></div>}
    </div>
    {(page > 0 || result?.nextCursor) && <nav className="file-pagination" aria-label={t("文件分页")}><button disabled={busy || page === 0} onClick={() => { void load(page - 1); }}>{t("上一页")}</button><span>{t("第 {0} 页", page + 1)}</span><button disabled={busy || !result?.nextCursor} onClick={() => { void load(page + 1); }}>{t("下一页")}</button></nav>}
  </>;
}
