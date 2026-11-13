import { SettingsPageHeader, captureSettingsPageFocus, useSettingsPageViewport } from "./SettingsPageHeader.js";
import { AvatarEditor } from "./Avatar.js";
import { useBackAction } from "./back-navigation.js";
import { useBotLabels } from "./BotReferences.js";
import { CollaborationPanel } from "./CollaborationPanel.js";
import { BotDashboard } from "./BotDashboard.js";
import { DiagnosticsPanel } from "./DiagnosticsPanel.js";
import { t, useLocale } from "./i18n.js";
import { ENGINE_SETTINGS_REPAIR_HINT } from "../../src/client-protocol/engine-settings.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HubConnection, Bot } from "./connection.js";
type Usage = { totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number; requestCount: number; unmeteredRequestCount?: number };
type Status = { hub: { uptimeSeconds: number; memoryBytes: number; routes: string[]; clients: number }; instances: (Bot & { status?: { engine?: string; activeTurns: number; queued: number; approvals: number; usage: Usage | null; usageSource?: "current" | "last-good" | null } })[] };

function operationError(message: string): string {
  switch (message) {
    case "hub_stopping": return t("Hub 正在关闭，请重新连接后再试。");
    case "bot_worker_stopping": return t("Bot 进程通信已断开，正在等待退出。请刷新服务状态。");
    case "restart_send_failed": return t("重启请求未送达。请检查服务状态后再试。");
    case "restart_confirmation_unavailable":
    case "operation_interrupted": return t("重启结果尚未确认。请先检查服务状态，再决定是否重试。");
    case "operation_failed": return t("操作失败，请查看服务详情后再试。");
    case "engine_settings_unavailable": return t(ENGINE_SETTINGS_REPAIR_HINT);
    default: return message;
  }
}

function UsageSummary({ usage, engine }: { usage: Usage | null; engine: string }) {
  if (!usage) return <><p>{t("token 用量未知")} · {t("费用未知")}</p><p className="muted">{t("用量账本不可用，消耗未知。")}</p></>;
  const tokens = usage.totalInputTokens + usage.totalOutputTokens;
  // The instance ledger may include earlier engines. Keep recorded totals,
  // but an absent measurement is neither a zero-token turn nor free usage.
  const tokenText = usage.requestCount > 0 || tokens > 0 ? `${tokens.toLocaleString()} tokens` : t("token 用量未知");
  // This ledger has no per-request cost-presence flag, including across an
  // engine switch; a zero aggregate cannot establish a measured zero cost.
  const costText = usage.totalCostUsd > 0 ? `$${usage.totalCostUsd.toFixed(4)}` : t("费用未知");
  return <>
    <p>{t("已记录用量：")}{tokenText} · {costText}{usage.unmeteredRequestCount ? t(" · {0} 次用量未知", usage.unmeteredRequestCount) : ""}</p>
    <p className="muted">{t("累计记录不包含未上报的用量或费用。")}{engine === "kimi"
      ? t("Kimi 当前不提供逐轮 token 和美元费用。")
      : engine !== "claude" ? t("当前引擎不提供美元费用，美元预算无法约束其消耗。") : ""}</p>
  </>;
}
export function OperationsPanel({ connection, close, initialBot, initialView = "collaboration" }: { connection: HubConnection; close: () => void; initialBot?: { botId: string; name: string }; initialView?: "collaboration" | "dashboard" }) {
  useLocale(); const labels = useBotLabels();
  const closeGuard = useRef<(() => boolean) | undefined>(undefined);
  const guard = useCallback((check: (() => boolean) | undefined) => { closeGuard.current = check; }, []);
  const guardedClose = () => { if (!closeGuard.current || closeGuard.current()) close(); };
  const panel = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null), closeRef = useRef(close); closeRef.current = guardedClose;
  useSettingsPageViewport(body);
  useEffect(() => {
    const returnFocus = captureSettingsPageFocus(); panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
      if (e.key !== "Tab") return;
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[href]") ?? [])].filter((item) => item.getClientRects().length);
      const first = controls[0], last = controls.at(-1), active = document.activeElement;
      if (!panel.current?.contains(active) || active === panel.current) { e.preventDefault(); (e.shiftKey ? last : first)?.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key); return () => { document.removeEventListener("keydown", key); returnFocus(); };
  }, []);
  const [collaboration, setCollaboration] = useState<{ botId: string; name: string } | undefined>(initialView === "collaboration" ? initialBot : undefined);
  const [dashboard, setDashboard] = useState<{ botId: string; name: string } | undefined>(initialView === "dashboard" ? initialBot : undefined);
  const [diagnostic, setDiagnostic] = useState<{ botId: string | null; name: string }>();
  const [status, setStatus] = useState<Status>(); const [error, setError] = useState(""); const [result, setResult] = useState(""); const [busy, setBusy] = useState(false);
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = 0; if (panel.current) panel.current.scrollTop = 0; }, [collaboration?.botId, dashboard?.botId, diagnostic?.botId]);
  const back = () => {
    if (busy || closeGuard.current && !closeGuard.current()) return;
    if (collaboration) setCollaboration(undefined);
    else if (dashboard) setDashboard(undefined);
    else if (diagnostic) setDiagnostic(undefined);
    else close();
  };
  useBackAction(panel, back);
  const load = () => connection.http<Status>("/api/ops").then(setStatus);
  useEffect(() => { void load().catch((e: unknown) => setError(String(e))); }, [connection]);
  const act = async (work: () => Promise<void>) => { setBusy(true); setError(""); setResult(""); try { await work(); } catch (e) { setError(e instanceof Error ? operationError(e.message) : t("操作失败")); } finally { setBusy(false); } };
  return <div className="modal-scrim settings-page-scrim"><section ref={panel} tabIndex={-1} className="settings-panel operations-panel mobile-settings-page" role="dialog" aria-modal="true" aria-label={t("运行状态")}><SettingsPageHeader title={t("运行状态")} closeLabel={t("关闭运行状态")} close={guardedClose} back={back}/><div ref={body} className="operations-body">{collaboration ? <CollaborationPanel key={collaboration.botId} connection={connection} {...collaboration} back={() => setCollaboration(undefined)} open={setCollaboration} guard={guard}/> : dashboard ? <BotDashboard key={dashboard.botId} connection={connection} {...dashboard} back={() => setDashboard(undefined)} records={() => { setDiagnostic(dashboard); setDashboard(undefined); }}/> : diagnostic ? <DiagnosticsPanel key={diagnostic.botId ?? "hub"} connection={connection} {...diagnostic} back={() => setDiagnostic(undefined)}/> : <><button disabled={busy} onClick={() => { void act(load); }}>{t("刷新状态")}</button>{status && <><h3>Hub</h3><div className="operation-metrics"><span>{t("已运行 {0} 分钟", Math.floor(status.hub.uptimeSeconds / 60))}</span><span>{Math.round(status.hub.memoryBytes / 1024 / 1024)} MB</span><span>{status.hub.clients} {t("个设备连接")}</span></div><button onClick={() => { void act(async () => setResult((await connection.http<{ text: string }>("/api/ops/logs")).text)); }}>{t("查看只读日志")}</button><button onClick={() => setDiagnostic({ botId: null, name: "Hub" })}>{t("查看 Hub 审计")}</button><h3>{t("实例")}</h3>{status.instances.map((bot) => <article className="operation-bot" key={bot.id}><header><strong><i className={`status-dot ${bot.online ? "online" : ""}`}/> {labels.get(bot.id) ?? bot.name}</strong><small>{bot.engine} · {bot.model}</small></header><AvatarEditor kind="bot" id={bot.id} name={labels.get(bot.id) ?? bot.name} label={t("Bot 头像")}/>{bot.status && <><p>{bot.status.activeTurns} {t("个运行中 ·")}{bot.status.queued} {t("个排队 ·")}{bot.status.approvals} {t("项待确认")}</p><UsageSummary usage={bot.status.usage} engine={bot.status.engine ?? bot.engine}/>{bot.status.usageSource === "last-good" && <p className="muted">{t("当前账本不可读，正在展示最近有效备份，数据可能较旧。")}</p>}</>}<div className="quick-actions">{!!bot.managed && <button onClick={() => setCollaboration({ botId: bot.id, name: bot.name })}>{t("协作设置")}</button>}<button onClick={() => setDashboard({ botId: bot.id, name: bot.name })}>{t("详细概览")}</button><button onClick={() => setDiagnostic({ botId: bot.id, name: bot.name })}>{t("运行记录")}</button><button disabled={(!bot.online && !bot.managed) || busy} onClick={() => { void act(async () => setResult((await connection.http<{ text: string }>(`/api/bots/${bot.id}/service-status`)).text)); }}>{t("服务详情")}</button><button disabled={(!bot.online && !bot.managed) || busy} onClick={() => { if (window.confirm(t("安排 {0} 在当前任务完成后重启？", bot.name))) void act(async () => { const receipt = await connection.http<{ ok: boolean; result?: { text: string }; error?: string }>(`/api/bots/${bot.id}/restart`, { method: "POST", body: JSON.stringify({ receiptId: `restart_${crypto.randomUUID()}` }) }); if (!receipt.ok) throw new Error(receipt.error ?? t("未安排重启")); setResult(receipt.result?.text ?? t("已安排空闲后重启")); }); }}>{t("空闲后重启")}</button></div></article>)}</>}{result && <pre className="operation-log">{result}</pre>}{error && <p className="error-text" role="alert">{error}</p>}</>}</div></section></div>;
}
