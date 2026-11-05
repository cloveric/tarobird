import { useBotLabels } from "./BotReferences.js";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { CollaborationSettings, CollaborationSnapshot } from "../../src/client-protocol/collaboration.js";
import { collaborationSettingsSchema } from "../../src/client-protocol/collaboration.js";
import type { HubConnection } from "./connection.js";
import { t, useLocale } from "./i18n.js";

function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "collaboration_conflict": return t("另一台设备或本机配置已更新。你的修改仍保留，请重新读取后再编辑。");
    case "collaboration_config_unreadable":
    case "collaboration_config_unsupported": return t("现有协作配置无法完整读取。请先检查本机配置，App 不会覆盖它。");
    case "collaboration_invalid_peer":
    case "collaboration_target_not_allowed": return t("协作对象必须是允许访问的 Bot，请检查所选成员。");
    default: return t("操作结果未确认，请检查连接并重新读取配置。重启情况可在服务详情中查看。");
  }
}
export function CollaborationPanel({ connection, botId, name, back, open, guard, backLabel }: {
  connection: HubConnection; botId: string; name: string; back: () => void;
  open: (bot: { botId: string; name: string }) => void; guard: (check: (() => boolean) | undefined) => void;
  backLabel?: string;
}) {
  useLocale(); const labels = useBotLabels();
  const [data, setData] = useState<CollaborationSnapshot>(), [draft, setDraft] = useState<CollaborationSettings>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState("");
  const sequence = useRef(0), restartId = useRef<string | undefined>(undefined);
  const dirty = !!data && JSON.stringify(data.settings) !== JSON.stringify(draft);
  const canLeave = () => !busy && (!dirty || window.confirm(t("放弃尚未保存的协作设置？")));
  useEffect(() => { guard(canLeave); return () => guard(undefined); }, [busy, dirty, guard]);
  async function load() {
    const current = ++sequence.current; setBusy(true); setError("");
    try { const value = await connection.http<CollaborationSnapshot>(`/api/bots/${botId}/collaboration`); if (sequence.current === current) { setData(value); setDraft(value.settings); } }
    catch (e) { if (sequence.current === current) setError(errorText(e)); }
    finally { if (sequence.current === current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [connection, botId]);
  const update = (value: Partial<CollaborationSettings>) => { setDraft((previous) => previous ? { ...previous, ...value } : previous); setReceipt(""); };
  const label = (id: string) => labels.get(id) ?? (id === botId ? name : data?.peers.find((peer) => peer.id === id)?.name ?? id);
  const allowed = draft?.peers === "*" ? data?.peers.map((peer) => peer.id) ?? [] : draft?.peers ?? [];
  const options = (includeSelf = false) => [...new Set([...(includeSelf ? [botId] : []), ...allowed])].map((id) => <option key={id} value={id}>{label(id)}</option>);
  const validTargets = draft && [...draft.parallel, ...draft.chain, ...(draft.verifier ? [draft.verifier] : []), ...(draft.crew ? [draft.crew.coordinator, ...Object.values(draft.crew.roles)].filter((id) => id !== botId) : [])].every((id) => allowed.includes(id));
  const valid = draft && collaborationSettingsSchema.safeParse(draft).success && validTargets;
  const removePeer = (id: string) => {
    if (!draft || draft.peers === "*") return;
    update({ peers: draft.peers.filter((peer) => peer !== id) }); // Keep workflows visible so the owner can resolve references deliberately.
  };
  const sequenceEditor = (field: "parallel" | "chain", title: string) => <fieldset><legend>{title}</legend>
    <p className="muted">{field === "parallel" ? t("同时询问当前 Bot 和所选成员，对照各自的回答。") : t("按顺序执行，每一步都会收到上一步的输出。")}</p>
    {draft![field].map((id, index) => <div className="collaboration-step" key={id}><span>{index + 1}. {label(id)}</span>{field === "chain" && <><button type="button" disabled={busy || index === 0} aria-label={t("上移 {0}", label(id))} onClick={() => { const next = [...draft!.chain]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; update({ chain: next }); }}>{t("上移")}</button><button type="button" disabled={busy || index === draft!.chain.length - 1} aria-label={t("下移 {0}", label(id))} onClick={() => { const next = [...draft!.chain]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; update({ chain: next }); }}>{t("下移")}</button></>}<button type="button" disabled={busy} aria-label={t("从{0}移除 {1}", title, label(id))} onClick={() => update({ [field]: draft![field].filter((peer) => peer !== id) })}>{t("移除")}</button></div>)}
    <label>{t("添加到{0}", title)}<select disabled={busy} value="" onChange={(e) => { if (e.target.value) update({ [field]: [...draft![field], e.target.value] }); }}><option value="">{t("选择 Bot")}</option>{allowed.filter((id) => !draft![field].includes(id)).map((id) => <option key={id} value={id}>{label(id)}</option>)}</select></label>
  </fieldset>;
  return <div className="collaboration-panel">
    <button type="button" className="file-action" onClick={() => { if (canLeave()) back(); }}><ArrowLeft size={16}/>{backLabel ?? t("返回运行概览")}</button>
    <h3>{label(botId)} · {t("协作设置")}</h3>
    <p>{t("配置此 Bot 可以与谁协作。双方都需要允许对方；加入同一个群组不会自动授权。")}</p>
    <div className="quick-actions"><button disabled={busy} onClick={() => { if (canLeave()) { setReceipt(""); void load(); } }}>{t("重新读取配置")}</button></div>
    {error && <p role="alert" className="error-text">{error}</p>}{receipt && <p role="status" className="dashboard-notice">{receipt}</p>}
    {data && draft && <form onSubmit={(e) => { e.preventDefault(); if (!valid || busy) return; setBusy(true); setError(""); setReceipt(""); void connection.http<CollaborationSnapshot>(`/api/bots/${botId}/collaboration`, { method: "PUT", body: JSON.stringify({ revision: data.revision, settings: draft }) }).then((value) => { setData(value); setDraft(value.settings); restartId.current = undefined; setReceipt(t("协作设置已保存。点击空闲后重启，完成服务配置应用。")); }, (e: unknown) => setError(errorText(e))).finally(() => setBusy(false)); }}>
      <p className="muted">{data.listener === "online" ? t("协作服务可连接；这不代表最近保存的配置已全部应用。") : data.listener === "offline" ? t("协作服务尚未连接。启用并保存后，需要空闲重启。") : t("协作服务状态未知。")}</p>
      <label className="collaboration-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(e) => update({ enabled: e.target.checked })}/>{t("启用多 Bot 协作")}</label>
      <fieldset disabled={busy}><legend>{t("允许协作的 Bot")}</legend>
        <label className="collaboration-check"><input type="checkbox" checked={draft.peers === "*"} onChange={(e) => update({ peers: e.target.checked ? "*" : [] })}/>{t("允许本 Hub 下所有协作 Bot，包括以后新增的 Bot")}</label>
        {!data.peers.length && <p>{t("先新建另一个 Bot，再来配置协作。")}</p>}
        {data.peers.map((peer) => <div className="collaboration-peer" key={peer.id}>
          <label className="collaboration-check"><input type="checkbox" disabled={draft.peers === "*"} checked={draft.peers === "*" || draft.peers.includes(peer.id)} onChange={(e) => e.target.checked ? update({ peers: [...allowed, peer.id] }) : removePeer(peer.id)}/><strong>{label(peer.id)}</strong></label>
          <small>{peer.allowsThisBot === null ? t("对方权限未知") : peer.allowsThisBot ? t("对方已允许此 Bot") : t("对方尚未允许此 Bot")}{" · "}{peer.listener === "online" ? t("协作服务在线") : peer.listener === "offline" ? t("协作服务离线") : t("协作服务状态未知。")}</small>
          <button type="button" onClick={() => { if (canLeave()) open({ botId: peer.id, name: peer.name }); }}>{t("配置 {0}", label(peer.id))}</button>
        </div>)}
        {draft.peers !== "*" && draft.peers.filter((id) => !data.peers.some((peer) => peer.id === id)).map((id) => <p key={id}>{t("未托管成员：{0}", id)} <button type="button" onClick={() => removePeer(id)}>{t("移除")}</button></p>)}
      </fieldset>
      {sequenceEditor("parallel", t("并行询问"))}{sequenceEditor("chain", t("串联步骤"))}
      <label>{t("复核 Bot")}<select disabled={busy} value={draft.verifier ?? ""} onChange={(e) => update({ verifier: e.target.value || null })}><option value="">{t("不使用复核 Bot")}</option>{draft.verifier && !allowed.includes(draft.verifier) && <option value={draft.verifier}>{label(draft.verifier)}</option>}{options()}</select></label>
      <p className="muted">{t("使用 /ask、/fan、/chain、/verify 发起对应协作。")}</p>
      <details><summary>{t("研究团队与高级设置")}</summary>
        <label>{t("最大委派层数")}<input type="number" min={1} max={32} disabled={busy} value={draft.maxDepth} onChange={(e) => update({ maxDepth: Number(e.target.value) })}/></label>
        <label className="collaboration-check"><input type="checkbox" disabled={busy} checked={!!draft.crew} onChange={(e) => update({ crew: e.target.checked ? { enabled: true, workflow: "research-report", coordinator: botId, roles: { researcher: allowed[0] ?? "", analyst: allowed[1] ?? "", writer: allowed[2] ?? "", reviewer: allowed[3] ?? "" }, maxResearchQuestions: 5, maxRevisionRounds: 1 } : null })}/>{t("启用 Crew 研究团队")}</label>
        <p>{t("需要 5 个不同的 Bot。协调者收到普通文字消息时，也会自动启动研究、分析、写作和复核流程。附件消息沿用普通处理。")}</p>
        {draft.crew && <>
          <label>{t("协调者")}<select disabled={busy} value={draft.crew.coordinator} onChange={(e) => update({ crew: { ...draft.crew!, coordinator: e.target.value } })}>{options(true)}</select></label>
          {([["researcher", t("研究员")], ["analyst", t("分析员")], ["writer", t("撰写者")], ["reviewer", t("审阅者")]] as const).map(([role, title]) => <label key={role}>{title}<select disabled={busy} value={draft.crew!.roles[role]} onChange={(e) => update({ crew: { ...draft.crew!, roles: { ...draft.crew!.roles, [role]: e.target.value } } })}><option value="">{t("选择 Bot")}</option>{options(true)}</select></label>)}
          <label>{t("最多研究问题数")}<input type="number" min={1} max={50} disabled={busy} value={draft.crew.maxResearchQuestions} onChange={(e) => update({ crew: { ...draft.crew!, maxResearchQuestions: Number(e.target.value) } })}/></label>
          <label>{t("最多修订轮数")}<input type="number" min={0} max={10} disabled={busy} value={draft.crew.maxRevisionRounds} onChange={(e) => update({ crew: { ...draft.crew!, maxRevisionRounds: Number(e.target.value) } })}/></label>
        </>}
      </details>
      {!valid && <p className="error-text">{t("请至少选择一名协作成员，并检查所有流程成员已获允许、Crew 的五个角色不重复，以及数值范围。")}</p>}
      <p className="muted">{t("权限和流程的修改可能影响后续请求；当前任务继续运行。服务启停需要空闲后重启。")}</p>
      <div className="quick-actions"><button type="submit" className="primary" disabled={busy || !dirty || !valid}>{busy ? t("处理中…") : t("保存协作设置")}</button><button type="button" disabled={busy || dirty} onClick={() => {
        setBusy(true); setError(""); setReceipt(""); const id = restartId.current ??= `collaboration_${crypto.randomUUID()}`;
        void connection.http<{ ok: boolean }>(`/api/bots/${botId}/restart`, { method: "POST", body: JSON.stringify({ receiptId: id }) }).then((value) => { if (!value.ok) { restartId.current = undefined; throw new Error("restart_unconfirmed"); } restartId.current = undefined; setReceipt(t("已安排空闲后重启。任务结束后再重新读取配置，检查协作服务连接。")); }).catch((e: unknown) => { setError(errorText(e)); }).finally(() => setBusy(false));
      }}>{t("空闲后重启并应用")}</button></div>
    </form>}
  </div>;
}
