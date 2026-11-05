import { BotName } from "./BotName.js";
import { Avatar, AvatarProvider, ConversationAvatar } from "./Avatar.js";
import "./forward-message.css";
import { useBotLabels } from "./BotReferences.js";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type RefObject } from "react";
import { Check, Forward, MessageSquare, Search } from "lucide-react";
import type { Conversation, Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { useConversationMessages } from "./conversation-messages.js";
import { t, useLocale } from "./i18n.js";
import { automaticGroupDiscussion, groupDiscussionViewSchema } from "../../src/client-protocol/group-discussion.js";
import { groupReplyModeFromView, type GroupReplyMode } from "./group-composer-send.js";
import { useGroupReplyMode } from "./group-reply-mode-cache.js";
import { timeoutSignal } from "./abort-signals.js";

export function ForwardMessage({ message, conversations, connection, close, sent, returnFocus }: { message: Message; conversations: Conversation[]; connection: HubConnection; close: () => void; sent: (id: string) => void; returnFocus: RefObject<HTMLElement | null> }) {
  useLocale(); const labels = useBotLabels();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [query, setQuery] = useState(""), [target, setTarget] = useState(""), [reply, setReply] = useState(false), [bots, setBots] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const sending = useRef(false), requestId = useRef(`forward_${crypto.randomUUID()}`);
  const label = (c: Conversation) => c.parentId ? `${conversations.find((parent) => parent.id === c.parentId)?.title ?? ""} / ${c.title}` : c.title;
  const eligible = conversations.filter((c) => !c.archived && (!c.parentId || !conversations.find((parent) => parent.id === c.parentId)?.archived));
  const botNames = (c: Conversation) => c.botIds.map(id => labels.get(id) ?? connection.state.bots.find(bot => bot.id === id)?.name ?? id).join(" · ");
  const filtered = eligible.filter((c) => `${label(c)} ${botNames(c)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const current = eligible.find((c) => c.id === target);
  const groupTarget = current?.type === "group" ? current.id : "";
  const [cachedMode, acceptMode] = useGroupReplyMode(connection, groupTarget);
  const [readMode, setReadMode] = useState<GroupReplyMode>(), [modeError, setModeError] = useState(false), [modeRetry, retryMode] = useState(0);
  const checksMode = !!groupTarget && state.groupDiscussionAvailable !== false;
  const mode = state.status === "online" ? readMode?.conversationId === groupTarget ? readMode : undefined : cachedMode;
  useEffect(() => {
    if (!checksMode || state.status !== "online") return;
    let alive = true, reading = false, revision = -1;
    const read = async () => {
      if (reading || !alive) return;
      reading = true; revision = connection.groupDiscussionRevision;
      try {
        const value = groupReplyModeFromView(groupTarget, groupDiscussionViewSchema.parse(await connection.http(`/api/conversations/${groupTarget}/discussion?brief=1`, { signal: timeoutSignal(10_000) })));
        if (alive) { setReadMode(value); acceptMode(value); setModeError(false); }
      } catch { if (alive) { setReadMode(undefined); setModeError(true); } }
      finally { reading = false; }
    };
    setReadMode(undefined); setModeError(false); void read();
    const unsubscribe = connection.subscribe(() => { if (revision !== connection.groupDiscussionRevision) void read(); });
    return () => { alive = false; unsubscribe(); };
  }, [connection, groupTarget, checksMode, state.status, acceptMode, modeRetry]);
  // Scoped: only this source conversation's revisions can change its messages.
  const history = useConversationMessages(connection, message.conversationId, true, true);
  const source = history.messages.find(item => item.id === message.id);
  const sourceAvailable = conversations.some(item => item.id === message.conversationId);
  const forwardReady = history.ready && sourceAvailable && !!source && ["complete", "error"].includes(source.status);
  const recipients = bots.filter(id => current?.botIds.includes(id) && connection.state.bots.some(bot => bot.id === id));
  const automatic = !!mode && automaticGroupDiscussion(mode.mode);
  const modeProblem = (value: GroupReplyMode | undefined) => !value ? t("暂时无法确认目标群的回复方式，请连接后重试；仍可仅转发保存。")
    : value.activeRun ? t("群内已有进行中的讨论。可仅转发保存；需要 Bot 回复时，请结束讨论后再转发。")
    : automaticGroupDiscussion(value.mode) && !state.groupDiscussionRecoveryAvailable ? t("更新主机后可在讨论模式中点名单个 Bot，内容已保留。")
    : automaticGroupDiscussion(value.mode) && recipients.length !== 1 ? t("此群按顺序讨论，转发时请选择一位 Bot 回复。") : "";
  const replyProblem = reply && checksMode ? !mode && state.status === "online" && !modeError ? t("正在读取群聊方式，请稍后发送。") : modeProblem(mode) : "";
  // Membership can change on another device while this dialog is open. Never
  // retain invisible recipients or silently replace them with a different Bot.
  useEffect(() => {
    if (recipients.length === bots.length) return;
    requestId.current = `forward_${crypto.randomUUID()}`;
    setBots(recipients);
  }, [bots, current, connection.state.bots]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (sending.current || !forwardReady || !current || reply && !recipients.length || replyProblem) return;
    sending.current = true; setBusy(true); setError("");
    try {
      // Recheck the selected destination before queueing. The Hub still guards
      // a discussion starting after this read; no automatic recipient fallback.
      if (reply && checksMode) {
        let latest = mode;
        if (state.status === "online") {
          try { latest = groupReplyModeFromView(current.id, groupDiscussionViewSchema.parse(await connection.http(`/api/conversations/${current.id}/discussion?brief=1`, { signal: timeoutSignal(10_000) }))); }
          catch { throw new Error(t("暂时无法确认目标群的回复方式，请连接后重试；仍可仅转发保存。")); }
        }
        if (latest) { setReadMode(latest); acceptMode(latest); }
        const problem = modeProblem(latest); if (problem) throw new Error(problem);
      }
      await connection.send({ v: 1, type: "message.forward", clientMsgId: requestId.current, conversationId: current.id, sourceMessageId: message.id, ...(reply ? { mentions: recipients } : {}) }); sent(current.id);
    }
    catch (e) { setError(e instanceof Error ? e.message : t("转发失败，请重试")); }
    finally { sending.current = false; setBusy(false); }
  };
  return <AvatarProvider connection={connection} conversations={conversations}><CreationDialog className="forward-dialog" showHost={false} title={t("转发消息")} close={close} busy={busy} closeLabel={t("关闭转发")} returnFocus={returnFocus}>
    <form className="forward-form" onSubmit={(event) => { void submit(event); }}>
      {history.failed ? <p className="forward-source-status" role="alert">{t("消息读取失败，请重试")} <button type="button" onClick={history.retry}>{t("重试")}</button></p>
        : !history.ready ? <p className="forward-source-status" role="status">{t("正在加载…")}</p>
        : !source || !sourceAvailable ? <p className="forward-source-status" role="alert">{t("原消息已删除或当前不可访问")}</p>
        : !forwardReady && <p className="forward-source-status" role="status">{t("生成完成后可转发")}</p>}
      <label className="forward-search"><Search size={16}/><input aria-label={t("搜索转发目标")} placeholder={t("搜索 Bot、对话、群组或话题")} value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)}/></label>
      <div className="forward-targets" role="group" aria-label={t("转发目标")}>{filtered.map((c) => <button type="button" className="forward-target" key={c.id} aria-pressed={target === c.id} aria-label={label(c)} disabled={busy} onClick={() => { if (target !== c.id) { requestId.current = `forward_${crypto.randomUUID()}`; setTarget(c.id); setBots(c.botIds.slice(0, 1)); setReply(c.type === "direct" && c.botIds.length > 0); } }}>
        <ConversationAvatar conversation={c} size={40}/><span className="forward-target-copy"><strong>{c.title}</strong><small>{c.parentId ? conversations.find((parent) => parent.id === c.parentId)?.title : c.type === "group" ? t("群组 · 默认讨论") : <BotName id={c.botIds[0] ?? ""} name={botNames(c)} compact/>}{c.id === message.conversationId ? t(" · 当前对话") : ""}</small></span>{target === c.id && <Check size={17}/>}
      </button>)}{!filtered.length && <p className="muted">{t("没有找到可转发的对话或话题")}</p>}</div>
      {current && <div className="forward-destination"><p>{t("发送到：{0}", label(current))}</p><label><input type="checkbox" checked={reply} disabled={busy} onChange={(event) => { requestId.current = `forward_${crypto.randomUUID()}`; setReply(event.target.checked); }}/>{t("让 Bot 回复这条转发")}</label><small className="forward-delivery-note">{reply ? t("附件会一并交给所选 Bot 读取；离线时将在恢复连接后处理。") : t("仅保存到目标对话，不会让 Bot 读取或回复。")}</small>{replyProblem && <p role="status" className="creation-help">{replyProblem}{modeError && state.status === "online" && <button type="button" disabled={busy} onClick={() => retryMode(value => value + 1)}>{t("重试")}</button>}</p>}{reply && automatic && !replyProblem && <small className="forward-delivery-note">{t("此群按顺序讨论，转发时请选择一位 Bot 回复。")}</small>}{reply && <div className="reply-bots" role={automatic ? "radiogroup" : "group"} aria-label={t("转发后回复的 Bot")}>{connection.state.bots.filter((bot) => current.botIds.includes(bot.id)).map((bot) => <button type="button" role={automatic ? "radio" : "checkbox"} aria-label={labels.get(bot.id) ?? bot.name} aria-checked={bots.includes(bot.id)} disabled={busy || checksMode && (!mode || !!mode.activeRun)} key={bot.id} onClick={() => { requestId.current = `forward_${crypto.randomUUID()}`; setBots((old) => automatic ? old.length === 1 && old[0] === bot.id ? [] : [bot.id] : old.includes(bot.id) ? old.filter((id) => id !== bot.id) : [...old, bot.id]); }}><Avatar kind="bot" id={bot.id} name={labels.get(bot.id) ?? bot.name} size={24}/><BotName id={bot.id} name={labels.get(bot.id) ?? bot.name} bot={bot}/>{bots.includes(bot.id) && <Check size={12}/>}</button>)}</div>}</div>}
      {error && <p role="alert" className="error-text">{error}</p>}
      <button type="submit" className="primary full" disabled={busy || !forwardReady || !current || reply && !recipients.length || !!replyProblem}><Forward size={16}/>{busy ? t("正在转发…") : t("确认转发")}</button>
    </form>
  </CreationDialog></AvatarProvider>;
}
