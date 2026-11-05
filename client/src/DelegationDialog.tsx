import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp, Check, RefreshCw, Users, X } from "lucide-react";
import type { CollaborationSnapshot } from "../../src/client-protocol/collaboration.js";
import { textSchema } from "../../src/client-protocol/index.js";
import { hasVisibleAgentBusText } from "../../src/client-protocol/agent-bus.js";
import { delegationCommand } from "../../src/bus/delegation-plan.js";
import { CreationDialog } from "./CreationDialog.js";
import { CollaborationPanel } from "./CollaborationPanel.js";
import { collaborationIssues, prepareCollaboration, type PreparationStep } from "./collaboration-task.js";
import { useSettingsPageViewport } from "./SettingsPageHeader.js";
import { Avatar } from "./Avatar.js";
import type { Bot, HubConnection } from "./connection.js";
import { useBotLabels } from "./BotReferences.js";
import { t, useLocale, formatList } from "./i18n.js";
import "./delegation.css";
export type DelegationMode = "ask" | "fan" | "chain" | "verify";
type Selections = Record<DelegationMode, string[]>;
const emptySelections = (): Selections => ({ ask: [], fan: [], chain: [], verify: [] });
function problem(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "collaboration_disabled_wildcard_requires_review") return t("已有全部 Bot 授权处于停用状态，请先在协作设置中改为具体成员，再启用这组协作。");
  if (message === "collaboration_disabled_peers_requires_review") return t("停用的协作配置还包含未选中的 Bot，请先在协作设置中确认成员，再启用这组协作。");
  if (message === "collaboration_listener_unknown") return t("尚未确认成员服务状态。请等待连接恢复后重新检查，权限没有改动。");
  if (message === "collaboration_conflict") return t("另一台设备修改了协作设置。已完成的配置会保留，请刷新状态后重试。");
  if (message === "collaboration_invalid_peer") return t("成员已移除或不属于当前主机，请重新选择。");
  if (message === "owner_required" || message === "forbidden") return t("只有主机所有者可以配置协作，请联系主机所有者。");
  return t("操作未完成。任务文字和已保存的配置会保留，请检查连接后重试。");
}
export function DelegationDialog({ connection, bots, members, initialBot, initialMode = "ask", prompt, changePrompt, close, createBot, send }: {
  connection: HubConnection; bots: Bot[]; members: string[]; initialBot?: string; initialMode?: DelegationMode;
  prompt: string; changePrompt: (text: string) => void; close: () => void; createBot?: () => void;
  send: (text: string, botId: string, clientMsgId: string) => Promise<void>;
}) {
  useLocale(); const labels = useBotLabels(); const formId = useId();
  const state = useSyncExternalStore(useCallback(listener => connection.subscribe(listener), [connection]), () => connection.state);
  const [coordinator, setCoordinator] = useState(members.includes(initialBot ?? "") ? initialBot! : members[0] ?? "");
  const [mode, setMode] = useState<DelegationMode>(initialMode), [selections, setSelections] = useState<Selections>(emptySelections);
  const [config, setConfig] = useState<CollaborationSnapshot>(), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [preparing, setPreparing] = useState(false), [review, setReview] = useState(false), [receipt, setReceipt] = useState("");
  const [steps, setSteps] = useState<Record<string, PreparationStep["state"]>>({});
  const [editing, setEditing] = useState<{ botId: string; name: string }>();
  const selected = bots.find(bot => bot.id === coordinator && members.includes(bot.id));
  const generation = useRef(0), initialized = useRef(""), active = useRef(true), action = useRef(false), abort = useRef<AbortController | undefined>(undefined);
  const restartIds = useRef(new Map<string, string>()), sendReceipt = useRef<{ key: string; id: string } | undefined>(undefined);
  const editGuard = useRef<(() => boolean) | undefined>(undefined), scroll = useRef<HTMLDivElement>(null);
  const guard = useCallback((check: (() => boolean) | undefined) => { editGuard.current = check; }, []);
  useSettingsPageViewport(scroll);
  const label = (id: string) => labels.get(id) ?? bots.find(bot => bot.id === id)?.name ?? id;
  const online = state.status === "online" && !connection.isReadOnly;
  const read = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError("");
    try {
      const value = await connection.http<CollaborationSnapshot>(`/api/bots/${coordinator}/collaboration`);
      if (!active.current || generation.current !== request) return undefined;
      setConfig(value);
      if (initialized.current !== coordinator) {
        initialized.current = coordinator;
        setSelections({ ask: [], fan: value.settings.parallel.filter(id => id !== coordinator), chain: value.settings.chain, verify: value.settings.verifier ? [value.settings.verifier] : [] });
      }
      if (!value.taskSelection) setSelections(old => ({ ...old, fan: value.settings.parallel.filter(id => id !== coordinator), chain: value.settings.chain, verify: value.settings.verifier ? [value.settings.verifier] : [] }));
      return value;
    } catch (cause) { if (active.current && generation.current === request) { setConfig(undefined); setError(problem(cause)); } return undefined; }
    finally { if (active.current && generation.current === request) setLoading(false); }
  }, [connection, coordinator]);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; abort.current?.abort(); }; }, []);
  useEffect(() => {
    initialized.current = ""; setConfig(undefined); setSelections(emptySelections()); setSteps({}); setReceipt(""); setReview(false);
    if (selected?.managed) void read(); else setLoading(false);
    return () => { generation.current++; };
  }, [read, selected?.managed]);
  const targets = selections[mode];
  const peers = selected?.managed ? config?.peers ?? [] : bots.filter(bot => bot.id !== coordinator).map(bot => ({ ...bot, allowsThisBot: null, listener: "unknown" as const }));
  const issues = config ? collaborationIssues(config, targets) : [];
  const supportsSelection = mode === "ask" || config?.taskSelection === true;
  const hasTargets = targets.length > 0 && targets.length <= 64 && (mode !== "ask" && mode !== "verify" || targets.length === 1);
  const command = supportsSelection ? delegationCommand(mode, targets, prompt) : `/${mode} ${prompt.trim()}`;
  const hasTask = hasVisibleAgentBusText(prompt), validText = hasTask && textSchema.safeParse(command).success;
  const ready = !!selected?.online && online && (selected.managed ? !!config && hasTargets && !issues.length : mode !== "ask" || hasTargets && peers.some(peer => peer.id === targets[0] && peer.online));
  const canSend = ready && validText && !loading && !busy;
  // Reconnect/restart may take time; refresh only while this dialog is awaiting
  // services. These reads never send the task or repeat permission writes.
  useEffect(() => {
    if (!receipt || ready || !online || busy || editing) return;
    const timer = setInterval(() => { void read(); }, 4000);
    return () => clearInterval(timer);
  }, [receipt, ready, online, busy, editing, read]);
  const changeTargets = (next: string[]) => { setSelections(old => ({ ...old, [mode]: next })); setReview(false); setReceipt(""); setError(""); };
  const descriptions: Record<DelegationMode, string> = {
    ask: t("把任务交给一位成员独立处理，结果回到这里。"),
    fan: t("发起 Bot 和所选成员同时回答，分别展示结果，方便比较。"),
    chain: t("按下方顺序接力，每位成员收到原始任务和上一步结果。"),
    verify: t("发起 Bot 先回答，再由所选成员检查；保留原回答和复核意见。"),
  };
  const reason = (issue: typeof issues[number]) => {
    switch (issue.reason) {
      case "disabled": return t("{0} 尚未启用协作", label(coordinator));
      case "permission": return t("{0} 尚未允许与此成员协作", label(coordinator)) + ` · ${label(issue.id)}`;
      case "reciprocal": return t("{0} 尚未双向授权", label(issue.id));
      case "offline": return t("{0} 的协作服务尚未就绪", label(issue.id || coordinator));
      case "missing": return t("{0} 已移除或不属于当前主机", label(issue.id));
    }
  };
  const prepare = async () => {
    if (action.current || !hasTargets || !online) return;
    action.current = true; setBusy(true); setPreparing(true); setError(""); setSteps({});
    const controller = new AbortController(); abort.current = controller;
    try {
      await prepareCollaboration(connection, coordinator, targets, restartIds.current, step => { if (active.current) setSteps(old => ({ ...old, [step.botId]: step.state })); }, controller.signal);
      if (active.current) { setReview(false); setReceipt(t("协作权限已保存；正在等待服务就绪。任务尚未发送。")); await read(); }
    } catch (cause) { if (active.current) { setError(problem(cause)); await read(); setError(problem(cause)); } }
    finally { action.current = false; if (active.current) { setBusy(false); setPreparing(false); } }
  };
  const submit = async () => {
    if (action.current || !canSend) return;
    action.current = true; setBusy(true); setError("");
    try {
      const fresh = selected?.managed ? await read() : undefined;
      if (!active.current) return;
      const freshDefaults = mode === "fan" ? fresh?.settings.parallel.filter(id => id !== coordinator) : mode === "chain" ? fresh?.settings.chain : fresh?.settings.verifier ? [fresh.settings.verifier] : [];
      const planChanged = mode !== "ask" && fresh && (Boolean(fresh.taskSelection) !== Boolean(config?.taskSelection) || !fresh.taskSelection && JSON.stringify(freshDefaults) !== JSON.stringify(targets));
      if (selected?.managed && (!fresh || collaborationIssues(fresh, targets).length || planChanged) || connection.state.status !== "online" || connection.isReadOnly || !bots.find(bot => bot.id === coordinator)?.online) {
        setError(t("协作状态已变化，请处理未就绪项后再发送。任务尚未发送。")); return;
      }
      // Retrying an uncertain local enqueue uses the same ID and exact payload.
      const key = JSON.stringify([coordinator, command]);
      if (sendReceipt.current?.key !== key) sendReceipt.current = { key, id: `client_${crypto.randomUUID()}` };
      await send(command, coordinator, sendReceipt.current.id);
      if (active.current) close();
    } catch (cause) { if (active.current) setError(problem(cause)); }
    finally { action.current = false; if (active.current) setBusy(false); }
  };
  const leaveEditor = () => { if (!editGuard.current || editGuard.current()) { setEditing(undefined); void read(); } };
  return <CreationDialog className="delegation-dialog" title={editing ? t("协作设置") : t("发起 Bot 协作")} close={editing ? leaveEditor : close} closeLabel={editing ? t("返回协作任务") : t("关闭协作操作")} back={!!editing} busy={busy}>
    <div ref={scroll} className="delegation-scroll">{editing ? <CollaborationPanel key={editing.botId} connection={connection} {...editing} guard={guard} open={setEditing} back={() => { setEditing(undefined); void read(); }} backLabel={t("返回协作任务")}/> : <form id={formId} className="delegation-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p className="delegation-intro">{t("选择合适的成员一起完成任务，结果回到当前对话。")}</p>
      <div className="delegation-basics"><label>{t("发起 Bot")}<select aria-label={t("发起 Bot")} disabled={busy} value={coordinator} onChange={event => setCoordinator(event.target.value)}>{bots.filter(bot => members.includes(bot.id)).map(bot => <option key={bot.id} value={bot.id}>{label(bot.id)}</option>)}</select></label>
      <label>{t("协作方式")}<select aria-label={t("协作方式")} disabled={busy} value={mode} onChange={event => { setMode(event.target.value as DelegationMode); setReview(false); setReceipt(""); }}><option value="ask">{t("委托给一个 Bot")}</option><option value="fan">{t("并行询问")}</option><option value="chain">{t("串联步骤")}</option><option value="verify">{t("回答后复核")}</option></select></label></div>
      <p className="delegation-description">{descriptions[mode]}</p>
      {loading && !config && <p role="status">{t("正在读取协作配置…")}</p>}
      {!selected?.managed && <div className="delegation-notice">{t("此 Bot 由外部服务管理，请先在它所在的主机配置协作。")}</div>}
      {(config || !selected?.managed) && (peers.length ? <>
        {mode === "ask" || mode === "verify" ? <label>{mode === "ask" ? t("协作对象") : t("复核 Bot")}<select aria-label={mode === "ask" ? t("协作对象") : t("复核 Bot")} disabled={busy || !supportsSelection} value={targets[0] ?? ""} onChange={event => changeTargets(event.target.value ? [event.target.value] : [])}><option value="">{t("选择 Bot")}</option>{targets[0] && !peers.some(peer => peer.id === targets[0]) && <option value={targets[0]}>{label(targets[0])} · {t("不可用")}</option>}{peers.map(peer => <option key={peer.id} value={peer.id}>{label(peer.id)}</option>)}</select></label> : selected?.managed ? <fieldset className="delegation-members"><legend>{t("参与成员")}</legend>{peers.map(peer => <label key={peer.id} className="delegation-member"><input type="checkbox" disabled={busy || !supportsSelection} checked={targets.includes(peer.id)} onChange={event => changeTargets(event.target.checked ? [...targets, peer.id] : targets.filter(id => id !== peer.id))}/><Avatar kind="bot" id={peer.id} name={label(peer.id)} size={28}/><span><strong>{label(peer.id)}</strong><small>{!peer.online ? t("Bot 离线") : peer.allowsThisBot && (config?.settings.peers === "*" || config?.settings.peers.includes(peer.id)) && config?.settings.enabled && peer.listener === "online" ? t("可以协作") : t("需要准备协作")}</small></span></label>)}</fieldset> : null}
        {mode === "chain" && !!targets.length && <ol className="delegation-order" aria-label={t("执行顺序")}>{targets.map((id, index) => <li key={id}><span>{index + 1}. {label(id)}</span><button type="button" aria-label={t("上移 {0}", label(id))} disabled={busy || !supportsSelection || index === 0} onClick={() => { const next = [...targets]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; changeTargets(next); }}><ArrowUp size={16}/></button><button type="button" aria-label={t("下移 {0}", label(id))} disabled={busy || !supportsSelection || index === targets.length - 1} onClick={() => { const next = [...targets]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; changeTargets(next); }}><ArrowDown size={16}/></button><button type="button" aria-label={t("移除 {0}", label(id))} disabled={busy || !supportsSelection} onClick={() => changeTargets(targets.filter(value => value !== id))}><X size={16}/></button></li>)}</ol>}
        {selected?.managed && !supportsSelection && <p className="muted">{t("升级此主机后可为每次任务单独选择成员；当前使用已保存的流程。")}</p>}
      </> : <div className="delegation-empty"><Users size={24}/><strong>{t("这台主机还没有其他可协作的 Bot")}</strong><p>{t("请先在 Bot 页面新建至少一个 Bot，再返回这里。任务文字会保留。")}</p><button type="button" onClick={createBot ?? close}>{createBot ? t("新建 Bot") : t("返回对话")}</button></div>)}
      {!!targets.length && <div className="delegation-route"><strong>{t("本次流程")}</strong><p>{(mode === "fan" || mode === "verify" ? [coordinator, ...targets] : targets).map(label).join(mode === "fan" ? " + " : " → ")}</p><small>{t("本次成员与顺序不会覆盖默认流程。")}</small></div>}
      {!online ? <p className="error-text" role="status">{t("主机连接已断开，恢复连接后可继续。任务文字会保留。")}</p> : selected && !selected.online ? <p className="error-text">{t("发起 Bot 离线，请先连接它的服务。")}</p> : null}
      {config && !!issues.length && <div className="delegation-notice"><strong>{t("还需准备")}</strong><ul>{issues.map((issue, index) => <li key={`${issue.id}:${index}`}>{reason(issue)}</li>)}</ul></div>}
      {config && hasTargets && (issues.length > 0 || !selected?.online) && !issues.some(issue => issue.reason === "missing") && <button type="button" className="delegation-prepare" disabled={busy || !online} onClick={() => setReview(!review)}>{t("准备这组协作")}</button>}
      {review && <div className="delegation-setup"><strong>{t("启用所选成员的双向协作")}</strong><p>{t("允许发起 Bot 与下列成员互相协作。只添加所选关系，不开放给全部 Bot。未连接的服务会在当前任务结束后启动或重启。")}</p><p>{label(coordinator)} ↔ {formatList(targets.map(label))}</p><p>{t("此操作会保存协作权限，不会发送任务。")}</p><div className="quick-actions"><button type="button" className="primary" disabled={busy || !online} onClick={() => { void prepare(); }}>{preparing ? t("正在准备…") : t("启用并连接")}</button><button type="button" disabled={busy} onClick={() => setReview(false)}>{t("取消")}</button></div></div>}
      {!!Object.keys(steps).length && (!ready || busy || !!error) && <ul className="delegation-steps" aria-label={t("准备进展")}>{Object.entries(steps).map(([id, phase]) => <li key={id}>{phase === "saved" && <Check size={14}/>}<span>{label(id)}</span><small>{phase === "reading" ? t("检查中") : phase === "saving" ? t("保存权限中") : phase === "connecting" ? t("请求连接中") : t("准备操作已确认")}</small></li>)}</ul>}
      {receipt && <p role="status" className="delegation-receipt">{ready ? t("所选成员已就绪，可以发送任务。") : receipt}</p>}
      {selected?.managed && <div className="delegation-tools"><button type="button" disabled={busy || loading || !online} onClick={() => { void read(); }}><RefreshCw size={14}/>{t("刷新协作状态")}</button><button type="button" disabled={busy} onClick={() => setEditing({ botId: coordinator, name: label(coordinator) })}>{t("编辑 {0} 的协作设置", label(coordinator))}</button></div>}
      <label>{t("协作任务")}<textarea aria-label={t("协作任务")} rows={4} disabled={busy} value={prompt} onChange={event => changePrompt(event.target.value)} placeholder={t("描述目标、分工和期望的交付结果…")}/></label>
      {hasTask && !validText && <p role="alert" className="error-text">{t("任务文字过长，请缩短后再发送。")}</p>}
      <p className="muted">{t("成员来自当前主机。任务以文字发送，不会自动共享本次对话历史或附件；可在对话中查看结果和停止任务。")}</p>
      {error && <p role="alert" className="error-text">{error}</p>}
    </form>}</div>
    {!editing && <div className="delegation-footer"><button form={formId} className="primary full" type="submit" disabled={!canSend}>{busy && !preparing ? t("发送中…") : t("发送协作任务")}</button></div>}
  </CreationDialog>;
}
