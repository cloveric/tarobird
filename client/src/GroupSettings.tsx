import { anySignal, timeoutSignal } from "./abort-signals.js";
import { BotName } from "./BotName.js";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { CircleStop, Laptop, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Avatar, AvatarEditor } from "./Avatar.js";
import { useBotLabels } from "./BotReferences.js";
import { CreationDialog } from "./CreationDialog.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import type { Bot, HubConnection } from "./connection.js";
import type { Conversation } from "../../src/client-protocol/index.js";
import { defaultGroupDiscussionPolicy, groupSettingsSnapshotSchema, GROUP_DISCUSSION_MAX_MEMBERS, automaticGroupDiscussion, type GroupDiscussionPolicy, type GroupSettingsSnapshot } from "../../src/client-protocol/group-discussion.js";
import { groupMembersStateSchema, type GroupHistoryVisibility, type GroupMembersState, type RemoteGroupQuestionStatus } from "../../src/client-protocol/group-members.js";
import { GroupDiscussionOptions } from "./GroupDiscussionOptions.js";
import "./group-settings.css";

function historyVisibilityLabel(v: GroupHistoryVisibility): string {
  if (v.kind === "none") return t("不看入群前消息");
  if (v.kind === "all") return t("可看全部历史");
  return t("最近 {0} 条消息", v.count);
}

function questionStatusLabel(status: RemoteGroupQuestionStatus): string {
  switch (status) {
    case "sending": return t("发送中");
    case "delivered": return t("已送达");
    case "failed": return t("发送失败");
    case "uncertain": return t("状态待确认");
  }
}

export function GroupSettings({ connection, group, bots, close, returnFocus, membersFirst = false }: {
  connection: HubConnection; group: Conversation; bots: Bot[]; close: () => void;
  returnFocus: RefObject<HTMLElement | null>; membersFirst?: boolean;
}) {
  useLocale(); const labels = useBotLabels();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [{ group: baseline, policy: baselinePolicy, revision: policyRevision }, setBaseline] = useState<Omit<GroupSettingsSnapshot, "revision"> & { revision?: string }>(() => ({
    group, policy: defaultGroupDiscussionPolicy(group.botIds),
  }));
  const [titleDraft, setTitleDraft] = useState<string>();
  const [memberChoices, setMemberChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [policyDraft, setPolicyDraft] = useState<Partial<GroupDiscussionPolicy>>({});
  // The snapshot owns the saved values. Each draft field overrides only what the user edited.
  const title = titleDraft ?? baseline.title;
  const chosen = [...new Set([...baseline.botIds, ...memberChoices.keys()])].filter(id => memberChoices.get(id) ?? true);
  const botOrder = [...new Set([...(policyDraft.botOrder ?? baselinePolicy.botOrder), ...baselinePolicy.botOrder, ...chosen])].filter(id => chosen.includes(id));
  const policy: GroupDiscussionPolicy = { ...baselinePolicy, ...policyDraft, botOrder };
  const [loadingPolicy, setLoadingPolicy] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirmClose, setConfirmClose] = useState(false);
  const [memberState, setMemberState] = useState<GroupMembersState>();
  const [memberFeedback, setMemberFeedback] = useState("");
  const [addHostId, setAddHostId] = useState("local");
  const [addBotId, setAddBotId] = useState("");
  const [addSessionId, setAddSessionId] = useState("");
  const [addHistory, setAddHistory] = useState<"none" | "recent:20" | "all">("recent:20");
  const [memberBusy, setMemberBusy] = useState(false);
  const saving = useRef(false), alive = useRef(false), pickerInitialized = useRef(false), titleInput = useRef<HTMLInputElement>(null), members = useRef<HTMLFieldSetElement>(null);
  const settingsRead = useRef(0), appliedSettingsRead = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const allowed = state.status === "online" && state.user?.id === group.ownerId && !group.archived;
  const dirty = title.trim() !== baseline.title || chosen.length !== baseline.botIds.length || chosen.some(id => !baseline.botIds.includes(id)) || !!state.groupDiscussionAvailable && JSON.stringify(policy) !== JSON.stringify(baselinePolicy);
  const validMembers = chosen.length > 0 && chosen.length <= 32;
  const validPolicy = !state.groupDiscussionAvailable || (policyRevision && (policy.mode !== "parallel" || state.groupParallelAvailable) && (policy.mode !== "designated" || state.crossHostGroupsAvailable) && (!automaticGroupDiscussion(policy.mode) || chosen.length >= 2 && chosen.length <= GROUP_DISCUSSION_MAX_MEMBERS));

  const loadMemberState = useCallback(async () => {
    if (!state.crossHostGroupsAvailable) return;
    try {
      const raw = await connection.http(`/api/groups/${group.id}/members`, { signal: timeoutSignal(15_000) });
      const parsed = groupMembersStateSchema.parse(raw);
      if (alive.current) {
        setMemberState(parsed);
        if (!pickerInitialized.current) {
          const firstPeer = parsed.directory?.find((b) => b.hostId !== "local") ?? parsed.directory?.[0];
          if (firstPeer) {
            pickerInitialized.current = true;
            setAddHostId(firstPeer.hostId);
            setAddBotId(firstPeer.botId);
            setAddSessionId(firstPeer.sessions[0]?.sessionId ?? "");
          }
        }
      }
    } catch { /* older Host without cross-host group sessions */ }
  }, [connection, group.id, state.crossHostGroupsAvailable]);

  const readSettings = useCallback(async (signal: AbortSignal) => {
    const sequence = ++settingsRead.current;
    const latest = state.groupDiscussionAvailable
      ? groupSettingsSnapshotSchema.parse(await connection.http(`/api/groups/${group.id}/settings`, { signal }))
      : undefined;
    const savedGroup = latest?.group ?? (await connection.http<Conversation[]>("/api/conversations", { signal })).find(value => value.id === group.id);
    if (!savedGroup || savedGroup.archived) throw new Error("unavailable");
    if (signal.aborted || !alive.current || sequence < appliedSettingsRead.current) return;
    appliedSettingsRead.current = sequence;
    setBaseline(latest ?? { group: savedGroup, policy: defaultGroupDiscussionPolicy(savedGroup.botIds) });
  }, [connection, group.id, state.groupDiscussionAvailable]);

  const syncSettingsBaseline = async () => {
    if (!state.groupDiscussionAvailable) return;
    try { await readSettings(timeoutSignal(15_000)); }
    catch { /* ignore transient refresh errors; save will still guard by revision */ }
  };

  useEffect(() => {
    if (!state.groupDiscussionAvailable) return;
    let active = true;
    const abort = new AbortController();
    setLoadingPolicy(true);
    void readSettings(anySignal([abort.signal, timeoutSignal(20_000)]))
      .catch(() => { if (active) setError(t("未能读取最新群组设置，请稍后重试。")); })
      .finally(() => { if (active) setLoadingPolicy(false); });
    return () => { active = false; abort.abort(); };
  }, [readSettings, state.groupDiscussionAvailable]);

  useEffect(() => {
    pickerInitialized.current = false;
    void loadMemberState();
  }, [loadMemberState]);

  const hostsInDirectory = useMemo(() => {
    const map = new Map<string, string>();
    for (const bot of memberState?.directory ?? []) map.set(bot.hostId, bot.hostName);
    return [...map.entries()].map(([hostId, hostName]) => ({ hostId, hostName }));
  }, [memberState?.directory]);

  const botsForSelectedHost = useMemo(
    () => (memberState?.directory ?? []).filter((b) => b.hostId === addHostId),
    [memberState?.directory, addHostId],
  );
  const selectedCandidateBot = botsForSelectedHost.find((b) => b.botId === addBotId) ?? botsForSelectedHost[0];

  const handleAddSessionMember = async () => {
    if (!selectedCandidateBot || memberBusy || !allowed) return;
    setMemberBusy(true); setMemberFeedback(""); setError("");
    try {
      const historyVisibility: GroupHistoryVisibility = addHistory === "none"
        ? { kind: "none" }
        : addHistory === "all"
          ? { kind: "all" }
          : { kind: "recent", count: 20 };
      await connection.http(`/api/groups/${group.id}/members`, {
        method: "POST",
        signal: timeoutSignal(20_000),
        body: JSON.stringify({
          hostId: selectedCandidateBot.hostId,
          botId: selectedCandidateBot.botId,
          ...(addSessionId ? { sessionId: addSessionId } : {}),
          historyVisibility,
        }),
      });
      await loadMemberState();
      await syncSettingsBaseline();
      if (alive.current) setMemberFeedback(t("已按会话添加成员「{0}」", selectedCandidateBot.name));
    } catch {
      if (alive.current) setError(t("添加会话成员失败，请确认目标主机在线后重试。"));
    } finally {
      if (alive.current) setMemberBusy(false);
    }
  };

  const handleSwitchNewSession = async (memberKey: string) => {
    if (memberBusy || !allowed) return;
    setMemberBusy(true); setMemberFeedback(""); setError("");
    try {
      await connection.http(`/api/groups/${group.id}/members/${encodeURIComponent(memberKey)}/session`, {
        method: "PATCH",
        signal: timeoutSignal(20_000),
        body: JSON.stringify({ createNew: true }),
      });
      await loadMemberState();
      if (alive.current) setMemberFeedback(t("已为该成员切换到新会话，旧会话历史保留。"));
    } catch {
      if (alive.current) setError(t("切换会话失败，请稍后重试。"));
    } finally {
      if (alive.current) setMemberBusy(false);
    }
  };

  const handleRemoveSessionMember = async (memberKey: string) => {
    if (memberBusy || !allowed) return;
    setMemberBusy(true); setMemberFeedback(""); setError("");
    try {
      await connection.http(`/api/groups/${group.id}/members/${encodeURIComponent(memberKey)}`, {
        method: "DELETE",
        signal: timeoutSignal(20_000),
      });
      await loadMemberState();
      await syncSettingsBaseline();
      if (alive.current) setMemberFeedback(t("已移出成员并回收访问权限，原会话历史保留。"));
    } catch {
      if (alive.current) setError(t("移出成员失败，请稍后重试。"));
    } finally {
      if (alive.current) setMemberBusy(false);
    }
  };

  const handleSetDesignated = async (memberKey: string) => {
    if (memberBusy || !allowed) return;
    setMemberBusy(true); setError("");
    try {
      await connection.http(`/api/groups/${group.id}/designated`, {
        method: "PUT",
        signal: timeoutSignal(15_000),
        body: JSON.stringify({ memberKey: memberKey || null }),
      });
      await loadMemberState();
    } catch {
      if (alive.current) setError(t("设置默认回复成员失败，请稍后重试。"));
    } finally {
      if (alive.current) setMemberBusy(false);
    }
  };

  const handleRetryQuestion = async (questionId: string) => {
    if (memberBusy || !allowed) return;
    setMemberBusy(true); setMemberFeedback(""); setError("");
    try {
      await connection.http(`/api/groups/${group.id}/questions/${questionId}/retry`, {
        method: "POST",
        signal: timeoutSignal(20_000),
        body: "{}",
      });
      await loadMemberState();
    } catch {
      if (alive.current) setError(t("核对或重试提问失败，请稍后重试。"));
    } finally {
      if (alive.current) setMemberBusy(false);
    }
  };

  const handleNewRoom = async () => {
    if (memberBusy || !allowed) return;
    setMemberBusy(true); setMemberFeedback(""); setError("");
    try {
      await connection.http(`/api/groups/${group.id}/rooms`, {
        method: "POST",
        signal: timeoutSignal(20_000),
        body: JSON.stringify({}),
      });
      await loadMemberState();
      if (alive.current) setMemberFeedback(t("已新建讨论房间，所有成员已切换到新会话。"));
    } catch {
      if (alive.current) setError(t("新建讨论房间失败，请稍后重试。"));
    } finally {
      if (alive.current) setMemberBusy(false);
    }
  };

  const handleStopGroup = async () => {
    if (memberBusy || !allowed) return;
    setMemberBusy(true); setMemberFeedback(""); setError("");
    try {
      const res = await connection.http<{ stoppedUnansweredCount: number }>(`/api/groups/${group.id}/stop`, {
        method: "POST",
        signal: timeoutSignal(20_000),
        body: JSON.stringify({}),
      });
      await loadMemberState();
      if (alive.current) {
        setMemberFeedback(res.stoppedUnansweredCount > 0
          ? t("已停止整群任务，并标记 {0} 条未回复的跨主机提问。", res.stoppedUnansweredCount)
          : t("已停止整群进行中的任务。"));
      }
    } catch {
      if (alive.current) setError(t("停止群任务失败，请稍后重试。"));
    } finally {
      if (alive.current) setMemberBusy(false);
    }
  };

  const changePolicy = (next: GroupDiscussionPolicy) => {
    const orderChanged = next.botOrder.length !== policy.botOrder.length || next.botOrder.some((id, index) => id !== policy.botOrder[index]);
    setPolicyDraft(draft => ({
      ...draft,
      ...(next.mode !== policy.mode ? { mode: next.mode } : {}),
      ...(next.maxRounds !== policy.maxRounds ? { maxRounds: next.maxRounds } : {}),
      ...(orderChanged ? { botOrder: next.botOrder } : {}),
    }));
  };
  const directory = [...bots, ...chosen.filter(id => !bots.some(bot => bot.id === id)).map(id => ({ id, name: labels.get(id) ?? id }))];
  const requestClose = () => { if (dirty) setConfirmClose(true); else close(); };
  const save = async () => {
    if (saving.current || loadingPolicy || !allowed || !title.trim() || !validMembers || !validPolicy) return;
    saving.current = true; setBusy(true); setError("");
    try {
      await connection.http(`/api/groups/${group.id}/settings`, { method: "PUT", signal: timeoutSignal(20_000), body: JSON.stringify({ title: title.trim(), botIds: chosen, expectedTitle: baseline.title, expectedBotIds: baseline.botIds, ...(state.groupDiscussionAvailable ? { policy, expectedRevision: policyRevision } : {}) }) });
      if (alive.current) close();
    } catch (e) {
      if (alive.current) setError(e instanceof HubHttpError && e.message === "group_settings_conflict" ? t("群组已在其他设备修改，请重新读取后再保存。")
        : e instanceof HubHttpError && e.message === "group_bot_busy" ? t("要移除的 Bot 仍有排队或进行中的任务，请完成或停止任务后再试。")
        : e instanceof HubHttpError && e.message === "group_discussion_active" ? t("讨论尚未结束，暂时不能移除参与成员。")
        : e instanceof HubHttpError && e.message === "group_parallel_discussion_active" ? t("请先结束群内讨论，再切换为并行回复。")
        : e instanceof HubHttpError && e.message === "group_designated_client_update_required" ? t("此群已开启指定 Bot 回复，请更新 App 后再修改群组设置。")
        : e instanceof HubHttpError && e.status === 403 ? t("当前账号无权修改此群组或添加所选 Bot。")
        : e instanceof HubHttpError && e.status === 404 ? t("群组或 Bot 不可用，请检查主机已更新并重新读取。")
        : t("未能确认操作结果，请核对最新状态后再试。"));
    } finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  const reload = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {
      await readSettings(timeoutSignal(20_000));
      if (alive.current) setError("");
      await loadMemberState();
    } catch { if (alive.current) setError(t("未能读取最新群组设置，请稍后重试。")); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };

  return <CreationDialog mobilePage title={t("群组设置")} closeLabel={t("关闭群组设置")} className="group-settings" movable busy={busy} close={requestClose} returnFocus={returnFocus} initialFocus={membersFirst ? members : titleInput}>
    <AvatarEditor kind="group" id={group.id} name={group.title} ownerId={group.ownerId} label={t("群头像")}/>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>{t("群组名称")}<input ref={titleInput} value={title} maxLength={256} required disabled={busy || !allowed} onChange={event => setTitleDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }}/></label>
      {state.groupDiscussionAvailable ? <GroupDiscussionOptions value={policy} change={changePolicy} bots={bots} parallelAvailable={!!state.groupParallelAvailable} crossHostAvailable={!!state.crossHostGroupsAvailable} disabled={busy || !allowed}/> : <p className="creation-help">{t("更新主机后，可设置轮流讨论和独立评议。")}</p>}
      {policy.mode === "designated" && memberState && memberState.members.length > 0 && (
        <label className="group-designated-picker">
          <span>{t("指定默认回复成员")}</span>
          <select disabled={!allowed || memberBusy} value={memberState.designatedMemberKey ?? ""} onChange={e => void handleSetDesignated(e.target.value)}>
            <option value="">{t("未指定（仅 @ 时回复）")}</option>
            {memberState.members.map(m => (
              <option key={m.memberKey} value={m.memberKey}>{m.nameSnapshot} · {m.hostName}</option>
            ))}
          </select>
        </label>
      )}
      {state.groupDiscussionAvailable && policy.mode !== baselinePolicy.mode && <p className="group-mode-footnote" role="status">{policy.mode === "parallel" ? t("如有进行中的讨论，请先结束，再切换为并行回复。") : t("如有进行中的讨论，新方式在其结束后生效；如需立即切换，请先结束讨论。")}</p>}
      {loadingPolicy && <p className="muted" role="status">{t("正在读取群聊方式…")}</p>}

      {memberState && (
        <section className="group-session-members" aria-label={t("按会话与跨主机成员")}>
          <div className="group-session-head">
            <h4>{t("成员会话与所在电脑")} · {memberState.members.length}/32</h4>
            <div className="group-quick-controls">
              <button type="button" className="secondary" disabled={!allowed || memberBusy} onClick={() => void handleNewRoom()}><Plus size={14}/>{t("新建房间")}</button>
              <button type="button" className="text-danger" disabled={!allowed || memberBusy} onClick={() => void handleStopGroup()}><CircleStop size={14}/>{t("停止整群")}</button>
            </div>
          </div>

          <ul className="group-session-list">
            {memberState.members.map((member) => (
              <li key={member.memberKey} className="group-session-row" data-kind={member.kind}>
                <div className="group-session-info">
                  <div className="group-session-title">
                    <strong>{member.nameSnapshot}</strong>
                    <span className="group-host-pill"><Laptop size={12}/>{member.hostName}</span>
                    <span className="group-engine-pill">{member.engineSnapshot}</span>
                  </div>
                  <small className="muted">
                    {t("会话：{0}", member.sessionTitle)} · {historyVisibilityLabel(member.historyVisibility)}
                  </small>
                </div>
                <div className="group-session-actions">
                  <button type="button" className="secondary" disabled={!allowed || memberBusy} onClick={() => void handleSwitchNewSession(member.memberKey)}><RefreshCw size={13}/>{t("换新会话")}</button>
                  <button type="button" className="text-danger" disabled={!allowed || memberBusy} onClick={() => void handleRemoveSessionMember(member.memberKey)}><Trash2 size={13}/>{t("移出")}</button>
                </div>
              </li>
            ))}
          </ul>

          {memberState.formerSessionIds.length > 0 && (
            <p className="muted group-former-note">{t("已移出/切换的旧会话：{0} 个（历史保留，访问权限已回收）", memberState.formerSessionIds.length)}</p>
          )}

          {hostsInDirectory.length > 0 && (
            <div className="group-add-member-box">
              <strong>{t("添加成员（按会话，支持其他电脑）")}</strong>
              <div className="group-add-member-grid">
                <label>{t("电脑")}
                  <select value={addHostId} disabled={!allowed || memberBusy} onChange={(e) => {
                    const nextHost = e.target.value;
                    setAddHostId(nextHost);
                    const firstBot = (memberState.directory ?? []).find((b) => b.hostId === nextHost);
                    setAddBotId(firstBot?.botId ?? "");
                    setAddSessionId(firstBot?.sessions[0]?.sessionId ?? "");
                  }}>
                    {hostsInDirectory.map((h) => <option key={h.hostId} value={h.hostId}>{h.hostName}</option>)}
                  </select>
                </label>
                <label>Bot
                  <select value={selectedCandidateBot?.botId ?? ""} disabled={!allowed || memberBusy} onChange={(e) => {
                    const nextBotId = e.target.value;
                    setAddBotId(nextBotId);
                    const bot = botsForSelectedHost.find((b) => b.botId === nextBotId);
                    setAddSessionId(bot?.sessions[0]?.sessionId ?? "");
                  }}>
                    {botsForSelectedHost.map((b) => <option key={b.botId} value={b.botId}>{b.name} ({b.engine})</option>)}
                  </select>
                </label>
                <label>{t("带入会话")}
                  <select value={addSessionId} disabled={!allowed || memberBusy} onChange={(e) => setAddSessionId(e.target.value)}>
                    <option value="">{t("自动选择最近会话（无则新建）")}</option>
                    {(selectedCandidateBot?.sessions ?? []).map((s) => (
                      <option key={s.sessionId} value={s.sessionId}>{s.title}</option>
                    ))}
                  </select>
                </label>
                <label>{t("入群可见历史")}
                  <select value={addHistory} disabled={!allowed || memberBusy} onChange={(e) => setAddHistory(e.target.value as "none" | "recent:20" | "all")}>
                    <option value="none">{t("不看入群前消息")}</option>
                    <option value="recent:20">{t("最近 20 条消息")}</option>
                    <option value="all">{t("可看全部历史")}</option>
                  </select>
                </label>
              </div>
              <button type="button" className="secondary" disabled={!allowed || memberBusy || !selectedCandidateBot} onClick={() => void handleAddSessionMember()}>
                <Plus size={14}/>{t("加入群组")}
              </button>
            </div>
          )}

          {memberState.questions.length > 0 && (
            <div className="group-remote-questions">
              <h5>{t("跨主机提问状态")}</h5>
              <ul>
                {memberState.questions.slice(0, 6).map((q) => (
                  <li key={q.id} className="group-question-row" data-status={q.status}>
                    <span><strong>{q.botNameSnapshot}</strong> · {q.hostName}</span>
                    <span className="group-question-status">{questionStatusLabel(q.status)}{q.stoppedUnanswered ? ` · ${t("停止时尚未回复")}` : ""}</span>
                    {(q.status === "failed" || q.status === "uncertain") && (
                      <button type="button" className="secondary" disabled={!allowed || memberBusy} onClick={() => void handleRetryQuestion(q.id)}>{t("核对 / 重试")}</button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {memberFeedback && <p className="muted" role="status">{memberFeedback}</p>}
        </section>
      )}

      <fieldset ref={members} tabIndex={-1} disabled={busy || !allowed}><legend>{t("本机群组 Bot")} · {chosen.length}/32</legend>
        <p className="creation-help">{t("勾选以添加 Bot，取消勾选以移除。群内话题同步使用这些 Bot，历史消息和各自的会话保留。")}</p>
        <div className="group-member-options">{directory.map(bot => <label className="bot-option" key={bot.id}>
          <input type="checkbox" aria-label={labels.get(bot.id) ?? bot.name} checked={chosen.includes(bot.id)} disabled={!chosen.includes(bot.id) && chosen.length >= 32} onChange={event => {
            const checked = event.target.checked;
            setMemberChoices(choices => new Map(choices).set(bot.id, checked));
          }}/>
          <Avatar kind="bot" id={bot.id} name={labels.get(bot.id) ?? bot.name} size={32}/><span className="bot-option-copy"><strong><BotName id={bot.id} name={labels.get(bot.id) ?? bot.name} bot={bots.find(value => value.id === bot.id)}/></strong></span>
        </label>)}</div>
      </fieldset>
      {!chosen.length && <p role="status" className="muted">{t("群组至少保留一个 Bot。")}</p>}
      {state.groupDiscussionAvailable && automaticGroupDiscussion(policy.mode) && chosen.length < 2 && <p role="status" className="muted">{t("自动讨论至少需要两个 Bot。")}</p>}
      {!allowed && <p className="muted" role="status">{state.status !== "online" ? t("连接恢复后即可操作") : t("仅群组创建者可修改名称和 Bot。")}</p>}
      {error && <div role="alert" className="error-text"><p>{error}</p><button type="button" disabled={busy || state.status !== "online"} onClick={() => void reload()}>{t("重新读取群组设置")}</button></div>}
      <div className="rename-conversation-actions"><button type="button" disabled={busy} onClick={requestClose}>{t("取消")}</button><button type="submit" className="primary" disabled={busy || loadingPolicy || !validPolicy || !allowed || !dirty || !title.trim() || !validMembers}>{busy ? t("正在保存…") : t("保存")}</button></div>
    </form>
    {confirmClose && <CreationDialog title={t("放弃尚未保存的群组设置？")} closeLabel={t("继续编辑")} close={() => setConfirmClose(false)}>
      <p>{t("放弃尚未保存的群组设置？")}</p><div className="rename-conversation-actions"><button onClick={() => setConfirmClose(false)}>{t("继续编辑")}</button><button onClick={close}>{t("放弃更改")}</button></div>
    </CreationDialog>}
  </CreationDialog>;
}
