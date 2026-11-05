import { isDispatcher } from "./dispatcher.js";
import { timeoutSignal } from "./abort-signals.js";
import { ExplanationList } from "./ExplanationList.js";
import { AvatarEditor } from "./Avatar.js";
import { CreationDialog } from "./CreationDialog.js";
import { t, useLocale } from "./i18n.js";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { ChevronDown, ChevronRight, History, MessageSquarePlus, RotateCcw, SlidersHorizontal, Sparkles, Unplug, type LucideIcon } from "lucide-react";
import "./conversation-settings.css";
import { useBotLabels } from "./BotReferences.js";
import { ClearHistoryControl } from "./ClearHistoryControl.js";

function SessionAction({ icon: Icon, title, description, disabled, onClick, danger = false }: { icon: LucideIcon; title: string; description: string; disabled: boolean; onClick: () => void; danger?: boolean }) {
  const descriptionId = useId();
  return <button type="button" className={`session-action${danger ? " session-action-danger" : ""}`} aria-label={title} aria-describedby={descriptionId} disabled={disabled} onClick={onClick}>
    <Icon className="session-action-icon" size={20} aria-hidden="true"/><span><strong>{title}</strong><small id={descriptionId}>{description}</small></span><ChevronRight size={16} aria-hidden="true"/>
  </button>;
}

export function ConversationPanel({ connection, conversation, group, pinned, globallyPinned = false, globalPin, pin, close, newChat, externalError, chooseRecipient, returnFocus, initialBot }: { initialBot?: string; returnFocus?: RefObject<HTMLElement | null>; connection: HubConnection; conversation: Conversation; group?: Conversation; pinned: boolean; globallyPinned?: boolean; globalPin?: (value: boolean) => Promise<void>; pin: (value: boolean) => Promise<void>; close: () => void; newChat: (botId: string) => void; externalError?: string; chooseRecipient: (botId: string) => void }) {
  useLocale(); const labels = useBotLabels();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [targetBot, setTargetBot] = useState(initialBot && conversation.botIds.includes(initialBot) ? initialBot : conversation.botIds[0] ?? "");
  const [title, setTitle] = useState(conversation.title), [baseline, setBaseline] = useState(conversation.title);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [sessions, setSessions] = useState<{ id: string; title: string; updatedAt: string }[]>([]), [session, setSession] = useState("");
  const [advanced, setAdvanced] = useState(false), [sessionsLoaded, setSessionsLoaded] = useState(false);
  const advancedId = useId();
  // A dispatcher's hidden engine worker only runs its ticket conversations.
  const engineWorker = !!state.dispatchWorkers?.some(bot => bot.id === targetBot);
  const compactSupported = ["claude", "kimi", "deepseek"].includes(state.bots.find(bot => bot.id === targetBot)?.engine ?? "");
  const [refreshFailed, setRefreshFailed] = useState(false), [queuedCommands, setQueuedCommands] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [confirmation, setConfirmation] = useState<"discard" | "reset" | "unbind" | "new" | "detach">();
  const previous = useRef(conversation), editing = useRef(false), editRevision = useRef(0);
  const refreshRequest = useRef(0);
  const alive = useRef(true), commandIds = useRef(new Map<string, string>());
  const titleInput = useRef<HTMLInputElement>(null);
  const cancelConfirmation = useRef<HTMLButtonElement>(null);
  const deletedBot = !conversation.botIds.length || conversation.botIds.some(id => state.deletedBots?.some(bot => bot.id === id));
  const archived = !!conversation.archived || !!group?.archived;
  const dirty = title !== baseline;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const requestClose = () => { if (busyRef.current || confirmation) return; if (dirty) setConfirmation("discard"); else close(); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const old = previous.current;
    if (old.id !== conversation.id) {
      editing.current = false; setTitle(conversation.title); setBaseline(conversation.title);
      setSession(""); setSessions([]); setSessionsLoaded(false); setAdvanced(false); setTargetBot(conversation.botIds[0] ?? "");
    } else if (old.title !== conversation.title) {
      setBaseline(conversation.title);
      setTitle(value => { if (value === conversation.title) editing.current = false; return editing.current ? value : conversation.title; });
    }
    if (!conversation.botIds.includes(targetBot)) setTargetBot(conversation.botIds[0] ?? "");
    if (old.bindingId !== conversation.bindingId) setSession("");
    previous.current = conversation;
  }, [conversation, targetBot]);
  const muted = state.notifications?.mutedConversations?.includes(conversation.id) ?? false;
  const refresh = async (saved = false) => {
    const request = ++refreshRequest.current;
    try { await connection.refreshNotificationPreferences(timeoutSignal(20_000)); if (alive.current && request === refreshRequest.current) setRefreshFailed(false); }
    catch { if (alive.current && request === refreshRequest.current) { setRefreshFailed(true); setNotice(saved ? t("通知设置暂时无法刷新，已保存的修改仍然有效。") : t("通知设置暂时无法刷新，请稍后重试。")); } }
  };
  useEffect(() => { void refresh(); }, [connection, conversation.id]);
  const act = async (work: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : t("操作失败")); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  // These WS metadata frames have no request ID. Wait for the matching durable
  // cache value instead of presenting a successful socket write as a receipt.
  const change = async (frame: Parameters<HubConnection["send"]>[0], accepted: (value: Conversation) => boolean) => {
    await connection.send(frame);
    if (!alive.current) throw new Error("conversation_panel_closed");
    const started = Date.now();
    while (alive.current) {
      const value = (await connection.cache.conversations()).find(item => item.id === conversation.id);
      if (!alive.current) break;
      if (value && accepted(value)) return;
      if (Date.now() - started > 20_000) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(t("未能确认操作结果，请核对最新状态后再试。"));
  };
  const saveName = () => void act(async () => {
    const value = title.trim(), revision = editRevision.current;
    if (!value) return;
    await change({ v: 1, type: "conversation.rename", conversationId: conversation.id, title: value }, c => c.title === value);
    if (!alive.current) return;
    setBaseline(value);
    if (revision === editRevision.current) { editing.current = false; setTitle(value); }
    setNotice(t("对话名称已保存"));
  });
  const setMute = (value: boolean) => void act(async () => {
    try {
      await connection.http("/api/conversations/mute", { method: "PUT", signal: timeoutSignal(20_000), body: JSON.stringify({ conversationId: conversation.id, muted: value }) });
      connection.acceptConversationMute(conversation.id, value);
      if (alive.current) setNotice(t("通知设置已保存"));
      void refresh(true);
    } catch {
      await refresh();
      throw new Error(t("未能确认操作结果，请核对最新状态后再试。"));
    }
  });
  const command = (text: string) => {
    if (archived || !targetBot || queuedCommands.includes(`${targetBot}:${text}`)) return;
    void act(async () => {
      const key = `${conversation.id}:${targetBot}:${text}`;
      const id = commandIds.current.get(key) ?? `client_${crypto.randomUUID()}`;
      commandIds.current.set(key, id); chooseRecipient(targetBot);
      await connection.send({ v: 1, type: "message.send", clientMsgId: id, conversationId: conversation.id, text, attachments: [], mentions: [targetBot] });
      if (!alive.current) return;
      setQueuedCommands(old => [...old, `${targetBot}:${text}`]);
      if (!dirtyRef.current) close(); else setNotice(t("命令已加入发送队列；再次执行请重新打开对话设置。"));
    });
  };
  const commandDisabled = (text: string) => busy || archived || queuedCommands.includes(`${targetBot}:${text}`);
  const bind = (sessionId: string | null) => void act(async () => {
    if (archived) return;
    await change({ v: 1, type: "conversation.bind", conversationId: conversation.id, sessionId, expectedBindingId: conversation.bindingId ?? null }, c => (c.sessionId ?? null) === sessionId && (!sessionId || c.bindingId !== conversation.bindingId));
    setSession(""); setNotice(t("会话选择已更新"));
  });
  return <CreationDialog mobilePage title={t("对话设置")} className="settings-panel conversation-settings" returnFocus={returnFocus} closeLabel={t("关闭对话设置")} busy={busy} close={requestClose}>
    {group && <><AvatarEditor kind="group" id={group.id} name={group.title} label={t("群头像")} ownerId={group.ownerId}/>{conversation.parentId && <p className="muted">{t("话题沿用所属群的头像。")}</p>}</>}
    {!group && !conversation.parentId && <AvatarEditor kind="group" id={conversation.id} name={conversation.title} label={t("对话头像")} ownerId={conversation.ownerId} conversation={conversation}/>}
    <form className="conversation-name-form" onSubmit={e => { e.preventDefault(); saveName(); }}><label>{t("对话名称")}<input ref={titleInput} value={title} minLength={1} maxLength={256} required onChange={e => { editRevision.current++; editing.current = true; setTitle(e.target.value); }}/></label><button className="primary" type="submit" disabled={busy || !title.trim() || !dirty}>{t("保存名称")}</button></form>
    {globalPin && <label className="settings-row"><span>{t("全局置顶")}</span><input type="checkbox" checked={globallyPinned} disabled={busy} onChange={e => { const value = e.target.checked; void act(() => globalPin(value)); }}/></label>}
    <label className="settings-row"><span>{t("分组置顶")}</span><input type="checkbox" checked={pinned} disabled={busy} onChange={e => { const value = e.target.checked; void act(() => pin(value)); }}/></label>
    <label className="settings-row"><span>{t("此对话免打扰")}</span><input type="checkbox" checked={muted} disabled={busy || !state.notifications || state.status !== "online"} onChange={e => setMute(e.target.checked)}/></label>
    <section className="session-section" aria-label={t("聊天与上下文")}>
      <h3>{t("聊天与上下文")}</h3>
      {conversation.botIds.length > 1 && <label className="session-bot-select">{t("操作的 Bot")}<select aria-label={t("操作的 Bot")} value={targetBot} disabled={busy} onChange={e => setTargetBot(e.target.value)}>{conversation.botIds.map(id => <option key={id} value={id}>{labels.get(id) ?? id}</option>)}</select></label>}
      <p className="session-scope">{t("当前操作对象：此对话中的 {0}", labels.get(targetBot) ?? state.bots.find(bot => bot.id === targetBot)?.name ?? targetBot)}</p>
      <div className="session-action-list">
        {!isDispatcher(state.bots.find(bot => bot.id === targetBot)) && !engineWorker && <SessionAction icon={MessageSquarePlus} title={t("新建独立对话")} description={t("开启另一段聊天，不带入这里的上下文。Bot 人设和配置继续沿用。")} disabled={busy || !targetBot} onClick={() => { if (dirty) setConfirmation("new"); else newChat(targetBot); }}/>}
        {compactSupported && <SessionAction icon={Sparkles} title={t("整理上下文")} description={t("聊天太长时，总结前文再继续。聊天记录保留，部分细节可能省略。")} disabled={commandDisabled("/compact")} onClick={() => command("/compact")}/>}
      </div>
      <button type="button" className="session-advanced-toggle" aria-label={t("高级对话管理")} aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced(value => !value)}><SlidersHorizontal size={18} aria-hidden="true"/><span><strong>{t("高级对话管理")}</strong><small>{t("继续旧会话、退出接入或重新开始")}</small></span><ChevronDown size={16} aria-hidden="true"/></button>
      {advanced && <div id={advancedId} className="session-advanced-content">
        {conversation.botIds.length === 1 && <section className="session-recovery" aria-label={t("继续已有会话")}>
          <h4><History size={18} aria-hidden="true"/>{t("继续已有会话")}</h4>
          <p>{t("接着此 Bot 已有的会话聊，会使用那段会话的上下文。")}</p>
          <button type="button" className="session-load" disabled={busy || state.status !== "online"} onClick={() => void act(() => connection.http<typeof sessions>(`/api/bots/${targetBot}/sessions`, { signal: timeoutSignal(20_000) }).then(value => { if (alive.current) { setSessions(value); setSessionsLoaded(true); } }))}>{t("查看可继续的会话")}</button>
          {sessionsLoaded && (sessions.length ? <div className="session-picker"><label>{t("已有会话")}<select aria-label={t("已有会话")} value={session} disabled={busy || archived} onChange={e => setSession(e.target.value)}><option value="">{t("选择会话…")}</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.title} · {new Date(s.updatedAt).toLocaleDateString()}</option>)}</select></label><button className="primary" disabled={busy || archived || !sessions.some(item => item.id === session)} onClick={() => bind(session)}>{t("使用此会话")}</button><small>{t("下一条消息开始使用。若其他对话也在使用它，会共享上下文，并依次执行任务。")}</small></div> : <p role="status">{t("暂时没有可继续的会话，可以尝试下方的更多恢复方式。")}</p>)}
          {conversation.sessionId && <div className="session-binding-recovery"><details><summary>{t("已选择的会话")}</summary><code>{conversation.sessionId}</code></details><button type="button" disabled={busy || archived} onClick={() => setConfirmation("unbind")}>{t("清除会话选择")}</button><p>{t("清除只取消恢复选择，不撤销已发生的切换。恢复曾中断时，请先切断或重置会话，再发消息。")}</p></div>}
        </section>}
        <div className="session-action-list">
          <SessionAction icon={History} title={t("更多恢复方式")} description={t("在聊天中查看当前引擎提供的会话查找或恢复方式。")} disabled={commandDisabled("/resume")} onClick={() => command("/resume")}/>
          <SessionAction icon={Unplug} title={t("退出接入的会话")} description={t("优先回到接入前的会话；没有可恢复的会话时，下次从新上下文开始。")} disabled={commandDisabled("/detach")} onClick={() => setConfirmation("detach")}/>
          <SessionAction icon={RotateCcw} title={t("重新开始上下文")} description={t("在当前对话从头开始，不再带入之前的聊天上下文。历史消息仍可查看。")} disabled={commandDisabled("/reset")} danger onClick={() => setConfirmation("reset")}/>
        </div>
      </div>}
    </section>
    <h3>{t("历史")}</h3>{deletedBot && <p className="muted">{t("Bot 已删除，此对话仅保留历史记录。")}</p>}<button disabled={busy || conversation.archived && deletedBot} onClick={() => void act(async () => { await change({ v: 1, type: "conversation.archive", conversationId: conversation.id, archived: !conversation.archived }, c => c.archived === !conversation.archived); if (!dirtyRef.current) close(); })}>{conversation.archived ? t("恢复到会话列表") : t("归档对话")}</button>
    <ClearHistoryControl connection={connection} conversationId={conversation.id} disabled={busy}/>
    {refreshFailed && <button disabled={busy} onClick={() => void act(() => refresh())}>{t("重新检查")}</button>}
    {busy && <p role="status">{t("正在处理…")}</p>}{notice && <p role="status">{notice}</p>}{(error || externalError) && <p className="error-text" role="alert">{error || externalError}</p>}
  {confirmation && <CreationDialog className="confirmation-dialog" initialFocus={cancelConfirmation} title={(confirmation === "discard" || confirmation === "new") ? t("放弃尚未保存的对话名称？") : confirmation === "detach" ? t("退出接入的会话") : confirmation === "reset" ? t("重新开始上下文") : t("清除会话选择")} closeLabel={t("关闭确认")} close={() => setConfirmation(undefined)} busy={busy} returnFocus={confirmation === "discard" ? titleInput : undefined}>
    <p className="confirmation-lead">{confirmation === "detach" ? t("回到接入前的会话。") : confirmation === "reset" ? t("Bot 将从新的上下文开始，不再带入之前的聊天内容。") : confirmation === "unbind" ? t("只清除已选会话，不撤销已经发生的切换。") : t("对话名称的修改尚未保存。")}</p>
    {(confirmation === "reset" || confirmation === "detach" || confirmation === "unbind") && <ExplanationList items={confirmation === "unbind" ? [
      { label: t("恢复中断时"), description: t("先退出接入的会话或重新开始上下文，再发送消息。") },
    ] : [
      ...(confirmation === "detach" ? [{ label: t("无法恢复时"), description: t("下一条消息从新的上下文开始。") }] : []),
      { label: t("仍保留"), description: t("聊天记录和 Bot 人设。") },
    ]}/>}
    <div className="confirmation-actions"><button ref={cancelConfirmation} disabled={busy} onClick={() => setConfirmation(undefined)}>{t("取消")}</button><button className="primary" disabled={busy} onClick={() => { const action = confirmation; setConfirmation(undefined); if (action === "discard") close(); else if (action === "new") newChat(targetBot); else if (action === "reset") command("/reset"); else if (action === "detach") command("/detach"); else bind(null); }}>{t("确认")}</button></div>
  </CreationDialog>}</CreationDialog>;
}
