import { isDispatcher } from "./dispatcher.js";
import { anySignal, timeoutSignal } from "./abort-signals.js";
import { BotName } from "./BotName.js";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Avatar, AvatarEditor } from "./Avatar.js";
import { useBotLabels } from "./BotReferences.js";
import { CreationDialog } from "./CreationDialog.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import type { Bot, HubConnection } from "./connection.js";
import type { Conversation } from "../../src/client-protocol/index.js";
import { defaultGroupDiscussionPolicy, groupSettingsSnapshotSchema, GROUP_DISCUSSION_MAX_MEMBERS, automaticGroupDiscussion, type GroupDiscussionPolicy } from "../../src/client-protocol/group-discussion.js";
import { GroupDiscussionOptions } from "./GroupDiscussionOptions.js";
import "./group-settings.css";

export function GroupSettings({ connection, group, bots, close, returnFocus, membersFirst = false }: {
  connection: HubConnection; group: Conversation; bots: Bot[]; close: () => void;
  returnFocus: RefObject<HTMLElement | null>; membersFirst?: boolean;
}) {
  useLocale(); const labels = useBotLabels();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [baseline, setBaseline] = useState(group), [title, setTitle] = useState(group.title), [chosen, setChosen] = useState(group.botIds);
  const [policy, setPolicy] = useState<GroupDiscussionPolicy>(() => defaultGroupDiscussionPolicy(group.botIds));
  const [baselinePolicy, setBaselinePolicy] = useState(policy), [policyRevision, setPolicyRevision] = useState<string>();
  const [loadingPolicy, setLoadingPolicy] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirmClose, setConfirmClose] = useState(false);
  const saving = useRef(false), alive = useRef(false), titleInput = useRef<HTMLInputElement>(null), members = useRef<HTMLFieldSetElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const allowed = state.status === "online" && state.user?.id === group.ownerId && !group.archived;
  const dirty = title.trim() !== baseline.title || chosen.length !== baseline.botIds.length || chosen.some(id => !baseline.botIds.includes(id)) || !!state.groupDiscussionAvailable && JSON.stringify(policy) !== JSON.stringify(baselinePolicy);
  const validPolicy = !state.groupDiscussionAvailable || (policyRevision && (policy.mode !== "parallel" || state.groupParallelAvailable) && (!automaticGroupDiscussion(policy.mode) || chosen.length >= 2 && chosen.length <= GROUP_DISCUSSION_MAX_MEMBERS));
  useEffect(() => {
    if (!state.groupDiscussionAvailable) return;
    let active = true;
    const abort = new AbortController();
    setLoadingPolicy(true);
    void connection.http(`/api/groups/${group.id}/settings`, { signal: anySignal([abort.signal, timeoutSignal(20_000)]) })
      .then(raw => {
        const latest = groupSettingsSnapshotSchema.parse(raw);
        if (active) { setBaseline(latest.group); setTitle(latest.group.title); setChosen(latest.group.botIds); setPolicy(latest.policy); setBaselinePolicy(latest.policy); setPolicyRevision(latest.revision); }
      })
      .catch(() => { if (active) setError(t("未能读取最新群组设置，请稍后重试。")); })
      .finally(() => { if (active) setLoadingPolicy(false); });
    return () => { active = false; abort.abort(); };
  }, [connection, group.id, state.groupDiscussionAvailable]);
  const chooseMembers = (next: string[]) => {
    setChosen(next);
    setPolicy(old => ({ ...old, botOrder: [...old.botOrder.filter(id => next.includes(id)), ...next.filter(id => !old.botOrder.includes(id))] }));
  };
  // A dispatcher Bot cannot join groups (the Host rejects it); keep only existing members listed.
  const directory = [...bots.filter(bot => !isDispatcher(bot) || chosen.includes(bot.id)), ...chosen.filter(id => !bots.some(bot => bot.id === id)).map(id => ({ id, name: labels.get(id) ?? id }))];
  const requestClose = () => { if (dirty) setConfirmClose(true); else close(); };
  const save = async () => {
    if (saving.current || loadingPolicy || !allowed || !title.trim() || !chosen.length || !validPolicy) return;
    saving.current = true; setBusy(true); setError("");
    try {
      await connection.http(`/api/groups/${group.id}/settings`, { method: "PUT", signal: timeoutSignal(20_000), body: JSON.stringify({ title: title.trim(), botIds: chosen, expectedTitle: baseline.title, expectedBotIds: baseline.botIds, ...(state.groupDiscussionAvailable ? { policy, expectedRevision: policyRevision } : {}) }) });
      // The HTTP response is the durable receipt; WebSocket updates refresh all
      // devices. Do not overwrite a newer cache update with this response.
      if (alive.current) close();
    } catch (e) {
      if (alive.current) setError(e instanceof HubHttpError && e.message === "group_settings_conflict" ? t("群组已在其他设备修改，请重新读取后再保存。")
        : e instanceof HubHttpError && e.message === "group_bot_busy" ? t("要移除的 Bot 仍有排队或进行中的任务，请完成或停止任务后再试。")
        : e instanceof HubHttpError && e.message === "group_discussion_active" ? t("讨论尚未结束，暂时不能移除参与成员。")
        : e instanceof HubHttpError && e.message === "group_parallel_discussion_active" ? t("请先结束群内讨论，再切换为并行回复。")
        : e instanceof HubHttpError && e.status === 403 ? t("当前账号无权修改此群组或添加所选 Bot。")
        : e instanceof HubHttpError && e.status === 404 ? t("群组或 Bot 不可用，请检查主机已更新并重新读取。")
        : t("未能确认操作结果，请核对最新状态后再试。"));
    } finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  const reload = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {
      const snapshot = state.groupDiscussionAvailable ? groupSettingsSnapshotSchema.parse(await connection.http(`/api/groups/${group.id}/settings`, { signal: timeoutSignal(20_000) })) : undefined;
      const latest = snapshot?.group ?? (await connection.http<Conversation[]>("/api/conversations", { signal: timeoutSignal(20_000) })).find(value => value.id === group.id);
      if (!latest || latest.archived) throw new Error("unavailable");
      if (alive.current) { setBaseline(latest); setTitle(latest.title); setChosen(latest.botIds); setError(""); if (snapshot) { setPolicy(snapshot.policy); setBaselinePolicy(snapshot.policy); setPolicyRevision(snapshot.revision); } }
    } catch { if (alive.current) setError(t("未能读取最新群组设置，请稍后重试。")); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  return <CreationDialog mobilePage title={t("群组设置")} closeLabel={t("关闭群组设置")} className="group-settings" movable busy={busy} close={requestClose} returnFocus={returnFocus} initialFocus={membersFirst ? members : titleInput}>
    <AvatarEditor kind="group" id={group.id} name={group.title} ownerId={group.ownerId} label={t("群头像")}/>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>{t("群组名称")}<input ref={titleInput} value={title} maxLength={256} required disabled={busy || loadingPolicy || !allowed} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }}/></label>
      {state.groupDiscussionAvailable ? <GroupDiscussionOptions value={policy} change={setPolicy} bots={bots} parallelAvailable={!!state.groupParallelAvailable} disabled={busy || loadingPolicy || !policyRevision || !allowed}/> : <p className="creation-help">{t("更新主机后，可设置轮流讨论和独立评议。")}</p>}
      {state.groupDiscussionAvailable && policy.mode !== baselinePolicy.mode && <p className="group-mode-footnote" role="status">{policy.mode === "parallel" ? t("如有进行中的讨论，请先结束，再切换为并行回复。") : t("如有进行中的讨论，新方式在其结束后生效；如需立即切换，请先结束讨论。")}</p>}
      {loadingPolicy && <p className="muted" role="status">{t("正在读取群聊方式…")}</p>}
      <fieldset ref={members} tabIndex={-1} disabled={busy || loadingPolicy || !allowed}><legend>{t("群组 Bot")} · {chosen.length}/32</legend>
        <p className="creation-help">{t("勾选以添加 Bot，取消勾选以移除。群内话题同步使用这些 Bot，历史消息和各自的会话保留。")}</p>
        <div className="group-member-options">{directory.map(bot => <label className="bot-option" key={bot.id}>
          <input type="checkbox" aria-label={labels.get(bot.id) ?? bot.name} checked={chosen.includes(bot.id)} disabled={!chosen.includes(bot.id) && chosen.length >= 32} onChange={event => chooseMembers(event.target.checked ? [...chosen, bot.id] : chosen.filter(id => id !== bot.id))}/>
          <Avatar kind="bot" id={bot.id} name={labels.get(bot.id) ?? bot.name} size={32}/><span className="bot-option-copy"><strong><BotName id={bot.id} name={labels.get(bot.id) ?? bot.name} bot={bots.find(value => value.id === bot.id)}/></strong></span>
        </label>)}</div>
      </fieldset>
      {!chosen.length && <p role="status" className="muted">{t("群组至少保留一个 Bot。")}</p>}
      {state.groupDiscussionAvailable && automaticGroupDiscussion(policy.mode) && chosen.length < 2 && <p role="status" className="muted">{t("自动讨论至少需要两个 Bot。")}</p>}
      {!allowed && <p className="muted" role="status">{state.status !== "online" ? t("连接恢复后即可操作") : t("仅群组创建者可修改名称和 Bot。")}</p>}
      {error && <div role="alert" className="error-text"><p>{error}</p><button type="button" disabled={busy || state.status !== "online"} onClick={() => void reload()}>{t("重新读取群组设置")}</button></div>}
      <div className="rename-conversation-actions"><button type="button" disabled={busy} onClick={requestClose}>{t("取消")}</button><button type="submit" className="primary" disabled={busy || loadingPolicy || !validPolicy || !allowed || !dirty || !title.trim() || !chosen.length}>{busy ? t("正在保存…") : t("保存")}</button></div>
    </form>
    {confirmClose && <CreationDialog title={t("放弃尚未保存的群组设置？")} closeLabel={t("继续编辑")} close={() => setConfirmClose(false)}>
      <p>{t("放弃尚未保存的群组设置？")}</p><div className="rename-conversation-actions"><button onClick={() => setConfirmClose(false)}>{t("继续编辑")}</button><button onClick={close}>{t("放弃更改")}</button></div>
    </CreationDialog>}
  </CreationDialog>;
}
