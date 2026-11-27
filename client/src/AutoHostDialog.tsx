import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Bot as BotIcon, CheckCircle2, Cpu, LoaderCircle, MemoryStick, Monitor, Plus, RefreshCw, Scale } from "lucide-react";
import {
  defaultLoadBalancingPreferences,
  evaluateHostEngineCandidate,
  selectBalancedHost,
  type HostBalanceCandidate,
  type HostBalanceExclusionReason,
  type HostBalancePreference,
  type HostEngineEvaluation,
  type LoadBalancingPreferences,
} from "../../src/client-protocol/host-balancer.js";
import {
  HOST_BALANCE_RESOURCES_PATH,
  hostBalanceResourcesSchema,
  type HostBalanceResources,
} from "../../src/client-protocol/host-balance-resources.js";
import { createBotSchema, type BotCatalog, type CreateBotInput } from "../../src/client-protocol/bots.js";
import type { QuotaDirectory } from "../../src/client-protocol/engine-quota.js";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { Bot } from "./connection.js";
import type { ConnectedHost } from "./host-connections.js";
import { CreationDialog } from "./CreationDialog.js";
import { HubHttpError } from "./http-error.js";
import { anySignal, timeoutSignal } from "./abort-signals.js";
import { t, useLocale } from "./i18n.js";
import "./load-balancing.css";

const ENGINES: ReadonlyArray<{ id: CreateBotInput["engine"]; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "kimi", label: "Kimi Code" },
  { id: "pi", label: "Pi" },
  { id: "deepseek", label: "DeepSeek" },
];

type HostProbe = {
  hostId: string;
  hostName: string;
  hostKey: string;
  online: boolean;
  preference: HostBalancePreference;
  bots: readonly Bot[];
  isOwner: boolean;
  latencyMs?: number;
  resources?: HostBalanceResources;
  catalog?: BotCatalog;
  quotas?: QuotaDirectory;
};

function exclusionLabel(reason: HostBalanceExclusionReason): string {
  switch (reason) {
    case "offline": return t("离线");
    case "manual_only": return t("已设为仅手动");
    case "engine_unavailable": return t("未安装或未就绪该引擎");
    case "login_required": return t("该引擎尚未登录");
    case "quota_exhausted": return t("额度已用尽");
    case "resources_unavailable": return t("无法读取主机负载");
    case "overloaded": return t("当前负载已满");
  }
}

function isDefiniteClientRejection(err: unknown): boolean {
  return err instanceof HubHttpError && err.status >= 400 && err.status < 500 && err.status !== 408;
}

export function AutoHostDialog({
  hosts,
  loadBalancing,
  recentAssignments,
  onAssigned,
  onManualHost,
  onCreated,
  close,
}: {
  hosts: ConnectedHost[];
  loadBalancing?: LoadBalancingPreferences;
  recentAssignments: readonly string[];
  onAssigned: (hostId: string) => void;
  onManualHost: (hostId: string) => void;
  onCreated: (hostId: string, conversation: Conversation) => void;
  close: () => void;
}) {
  useLocale();
  const prefs: LoadBalancingPreferences = useMemo(() => ({
    ...defaultLoadBalancingPreferences,
    ...loadBalancing,
    hostPreferences: { ...(loadBalancing?.hostPreferences ?? {}) },
    botTemplate: { ...defaultLoadBalancingPreferences.botTemplate, ...(loadBalancing?.botTemplate ?? {}) },
  }), [loadBalancing]);
  const [mode, setMode] = useState<"auto" | "manual">(prefs.enabled ? "auto" : "manual");
  const [engine, setEngine] = useState<CreateBotInput["engine"]>("claude");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [evaluating, setEvaluating] = useState(false);
  const [hostProbes, setHostProbes] = useState<HostProbe[] | undefined>(undefined);
  // Keep the chosen Host pinned during the draft stage until the user explicitly re-picks or changes engine.
  const [pinnedHostId, setPinnedHostId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const evalSeq = useRef(0);
  const evalAbortRef = useRef<AbortController | null>(null);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const recentRef = useRef(recentAssignments);
  recentRef.current = recentAssignments;
  const modelRef = useRef(model);
  modelRef.current = model;

  // Idempotency caches across retries so transient failures never leak duplicate Bots or conversations.
  const pendingBotRequestsRef = useRef<Map<string, string>>(new Map());
  const createdBotsRef = useRef<Map<string, { id: string; name: string }>>(new Map());
  const pendingConvActionsRef = useRef<Map<string, string>>(new Map());

  const evaluate = useCallback(async (targetEngine: CreateBotInput["engine"], forceRepick = false) => {
    evalAbortRef.current?.abort();
    const controller = new AbortController();
    evalAbortRef.current = controller;
    const seq = ++evalSeq.current;
    setEvaluating(true);
    setError("");
    try {
      const currentHosts = hostsRef.current;
      const currentPrefs = prefsRef.current;
      const templateWorkspace = currentPrefs.botTemplate.workspace.trim();
      const catalogPath = `/api/bots/catalog?includePi=1${templateWorkspace ? `&workspace=${encodeURIComponent(templateWorkspace)}` : ""}`;

      const probes: HostProbe[] = await Promise.all(currentHosts.map(async (entry) => {
        const conn = entry.connection;
        const online = conn?.state.status === "online";
        const isOwner = conn?.state.user?.role === "owner";
        const pref = currentPrefs.hostPreferences[entry.host.publicKey] ?? "normal";
        const bots = conn?.state.bots ?? [];

        let resources: HostBalanceResources | undefined;
        let catalog: BotCatalog | undefined;
        let quotas: QuotaDirectory | undefined;
        if (online && conn) {
          const signal = anySignal([controller.signal, timeoutSignal(4_000)]);
          const [resOutcome, catOutcome, quotaOutcome] = await Promise.allSettled([
            conn.state.hostBalanceResourcesAvailable === false
              ? Promise.resolve(undefined)
              : conn.http<unknown>(HOST_BALANCE_RESOURCES_PATH, { signal }),
            isOwner
              ? conn.http<BotCatalog>(catalogPath, { signal })
              : Promise.resolve(undefined),
            isOwner && conn.state.engineQuotaAvailable
              ? conn.readEngineQuotas(signal)
              : Promise.resolve(undefined),
          ]);
          if (resOutcome.status === "fulfilled" && resOutcome.value !== undefined) {
            const parsed = hostBalanceResourcesSchema.safeParse(resOutcome.value);
            if (parsed.success) resources = parsed.data;
          }
          if (catOutcome.status === "fulfilled" && catOutcome.value) {
            catalog = catOutcome.value;
          }
          if (quotaOutcome.status === "fulfilled" && quotaOutcome.value) {
            quotas = quotaOutcome.value;
          }
        }
        return {
          hostId: entry.host.id,
          hostName: entry.host.name,
          hostKey: entry.host.publicKey,
          online,
          preference: pref,
          bots,
          isOwner,
          latencyMs: conn?.state.latency,
          resources,
          catalog,
          quotas,
        };
      }));

      if (controller.signal.aborted || seq !== evalSeq.current) return;
      setHostProbes(probes);

      const candidates: HostBalanceCandidate[] = probes.map((probe) => {
        const evaluated = evaluateHostEngineCandidate({
          engine: targetEngine,
          requestedModel: modelRef.current,
          bots: probe.bots,
          canCreateBot: probe.isOwner,
          catalog: probe.catalog,
          quotas: probe.quotas,
        });
        return {
          hostId: probe.hostId,
          hostName: probe.hostName,
          hostKey: probe.hostKey,
          online: probe.online,
          preference: probe.preference,
          engineAvailable: evaluated.engineAvailable,
          quotaExhausted: evaluated.quotaExhausted,
          loginRequired: evaluated.loginRequired,
          latencyMs: probe.latencyMs,
          resources: probe.resources,
          ...(evaluated.matchingBot ? { matchingBotId: evaluated.matchingBot.id, matchingBotName: evaluated.matchingBot.name } : {}),
        };
      });
      const result = selectBalancedHost(candidates, { recentAssignments: recentRef.current, requireResources: true });
      setPinnedHostId((prev) => {
        if (!forceRepick && prev && result.ranked.some((item) => item.candidate.hostId === prev)) return prev;
        return result.selected?.hostId;
      });
    } catch (err) {
      if (controller.signal.aborted || seq !== evalSeq.current) return;
      setHostProbes(undefined);
      setPinnedHostId(undefined);
      setError(err instanceof Error ? err.message : t("评估主机负载失败，请重试或改为手动选择。"));
    } finally {
      if (seq === evalSeq.current) setEvaluating(false);
    }
  }, []);

  const hostStatusKey = hosts
    .map((entry) => `${entry.host.id}:${entry.connection?.state.status ?? "none"}:${entry.connection?.state.hostBalanceResourcesAvailable ? "1" : "0"}`)
    .join("|");
  const lastEvalTriggerRef = useRef<{ mode: "auto" | "manual"; engine: CreateBotInput["engine"] } | null>(null);

  useEffect(() => {
    if (mode !== "auto") {
      lastEvalTriggerRef.current = { mode, engine };
      evalAbortRef.current?.abort();
      evalAbortRef.current = null;
      ++evalSeq.current;
      setEvaluating(false);
      return;
    }
    const prev = lastEvalTriggerRef.current;
    const forceRepick = !prev || prev.mode !== mode || prev.engine !== engine;
    lastEvalTriggerRef.current = { mode, engine };
    void evaluate(engine, forceRepick);
    return () => {
      evalAbortRef.current?.abort();
      evalAbortRef.current = null;
      ++evalSeq.current;
    };
  }, [mode, engine, hostStatusKey, evaluate]);

  const { selection, evaluationsByHost } = useMemo(() => {
    const map = new Map<string, HostEngineEvaluation>();
    if (!hostProbes) return { selection: undefined, evaluationsByHost: map };
    const candidates: HostBalanceCandidate[] = hostProbes.map((probe) => {
      const evaluated = evaluateHostEngineCandidate({
        engine,
        requestedModel: model,
        bots: probe.bots,
        canCreateBot: probe.isOwner,
        catalog: probe.catalog,
        quotas: probe.quotas,
      });
      map.set(probe.hostId, evaluated);
      return {
        hostId: probe.hostId,
        hostName: probe.hostName,
        hostKey: probe.hostKey,
        online: probe.online,
        preference: prefs.hostPreferences[probe.hostKey] ?? probe.preference,
        engineAvailable: evaluated.engineAvailable,
        quotaExhausted: evaluated.quotaExhausted,
        loginRequired: evaluated.loginRequired,
        latencyMs: probe.latencyMs,
        resources: probe.resources,
        ...(evaluated.matchingBot ? { matchingBotId: evaluated.matchingBot.id, matchingBotName: evaluated.matchingBot.name } : {}),
      };
    });
    return {
      selection: selectBalancedHost(candidates, { recentAssignments, requireResources: true }),
      evaluationsByHost: map,
    };
  }, [hostProbes, engine, model, prefs.hostPreferences, recentAssignments]);

  const chosenCandidate = selection?.ranked.find((item) => item.candidate.hostId === pinnedHostId)?.candidate ?? selection?.selected ?? null;
  const maxModelLength = engine === "pi" || engine === "deepseek" ? 512 : 128;

  const submitAuto = async () => {
    if (busy || evaluating || !chosenCandidate) return;
    const entry = hosts.find((item) => item.host.id === chosenCandidate.hostId);
    const conn = entry?.connection;
    if (!entry || !conn || conn.state.status !== "online") {
      setError(t("所选主机当前不在线，请重新选择或改为手动选择。"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      let botId = chosenCandidate.matchingBotId;
      let botName = chosenCandidate.matchingBotName;
      if (!botId) {
        if (conn.state.user?.role !== "owner") {
          throw new Error(t("该主机上没有匹配的 Bot，且当前账号没有自动创建 Bot 的权限。"));
        }
        const evaluation = evaluationsByHost.get(chosenCandidate.hostId);
        const defaults = evaluation?.createDefaults;
        if (!defaults) {
          throw new Error(t("当前主机无法使用所选引擎或默认模型，请检查模型设置或改为手动选择。"));
        }
        const engineLabel = ENGINES.find((e) => e.id === engine)?.label ?? engine;
        const prefix = prefs.botTemplate.namePrefix.trim();
        const name = prefix ? `${prefix} ${engineLabel}` : engineLabel;
        const workspace = prefs.botTemplate.workspace.trim();
        const botCacheKey = JSON.stringify([entry.host.id, engine, name, defaults.model, defaults.effort, defaults.permission ?? "", workspace]);
        const cachedBot = createdBotsRef.current.get(botCacheKey);
        if (cachedBot) {
          botId = cachedBot.id;
          botName = cachedBot.name;
        } else {
          let botRequestId = pendingBotRequestsRef.current.get(botCacheKey);
          if (!botRequestId) {
            botRequestId = `auto_bot_${crypto.randomUUID()}`;
            pendingBotRequestsRef.current.set(botCacheKey, botRequestId);
          }
          const createBody = createBotSchema.parse({
            requestId: botRequestId,
            name,
            engine,
            model: defaults.model,
            effort: defaults.effort,
            workspace,
            ...(defaults.permission ? { permission: defaults.permission } : {}),
          });
          try {
            const createdBot = await conn.createBot(createBody);
            botId = createdBot.id;
            botName = createdBot.name || name;
            createdBotsRef.current.set(botCacheKey, { id: botId, name: botName });
            pendingBotRequestsRef.current.delete(botCacheKey);
          } catch (botErr) {
            if (isDefiniteClientRejection(botErr)) {
              pendingBotRequestsRef.current.delete(botCacheKey);
            }
            throw botErr;
          }
        }
        if (!botId) throw new Error(t("自动创建 Bot 失败，请手动选择主机创建。"));
      }
      const convTitle = (title.trim() || t("与 {0} 的新对话", botName ?? engine)).slice(0, 256);
      const convCacheKey = JSON.stringify([entry.host.id, botId, convTitle]);
      let clientActionId = pendingConvActionsRef.current.get(convCacheKey);
      if (!clientActionId) {
        clientActionId = `auto_conv_${crypto.randomUUID()}`;
        pendingConvActionsRef.current.set(convCacheKey, clientActionId);
      }
      let conversation: Conversation;
      try {
        conversation = await conn.createConversation({
          v: 1,
          type: "conversation.create",
          conversationType: "direct",
          botIds: [botId],
          title: convTitle,
          clientActionId,
        });
        pendingConvActionsRef.current.delete(convCacheKey);
      } catch (convErr) {
        if (isDefiniteClientRejection(convErr)) {
          pendingConvActionsRef.current.delete(convCacheKey);
        }
        throw convErr;
      }
      onAssigned(entry.host.id);
      onCreated(entry.host.id, conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("创建对话失败，请重试或改为手动选择。"));
    } finally {
      setBusy(false);
    }
  };

  return <CreationDialog className="lb-create-dialog" title={t("新建对话")} close={close} busy={busy}>
    <div className="lb-mode-tabs" role="tablist" aria-label={t("主机选择方式")}>
      <button type="button" role="tab" aria-selected={mode === "auto"} disabled={busy} className={mode === "auto" ? "is-active" : undefined} onClick={() => { if (!busy) setMode("auto"); }}>
        <Scale size={14} aria-hidden="true"/>
        <span>{t("自动选择主机")}</span>
      </button>
      <button type="button" role="tab" aria-selected={mode === "manual"} disabled={busy} className={mode === "manual" ? "is-active" : undefined} onClick={() => { if (!busy) setMode("manual"); }}>
        <Monitor size={14} aria-hidden="true"/>
        <span>{t("手动选择主机")}</span>
      </button>
    </div>

    {mode === "manual" ? (
      <div className="lb-manual-wrap">
        <p className="creation-help">{t("Bot、工作区和会话将保存在所选主机上。")}</p>
        <div className="host-choices">
          {hosts.map((entry) => (
            <button
              key={entry.host.id}
              type="button"
              disabled={busy || !entry.connection || entry.connection.state.status !== "online"}
              onClick={() => onManualHost(entry.host.id)}
            >
              <Monitor size={20}/>
              <span>
                <strong>{entry.host.name}</strong>
                <small>{entry.connection?.state.status === "online" ? t("已连接") : t("离线")}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    ) : (
      <form className="lb-auto-form" onSubmit={(event) => { event.preventDefault(); void submitAuto(); }}>
        <p className="creation-help">{t("只需选择引擎，系统按当前负载、网络延迟与主机偏好自动分配。选定后保持固定，不会在中途迁移。")}</p>
        <div className="lb-field-grid">
          <label>
            <span>{t("选择引擎")}</span>
            <select value={engine} disabled={busy} onChange={(event) => { setEngine(event.target.value as CreateBotInput["engine"]); setModel(""); setPinnedHostId(undefined); }}>
              {ENGINES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span>{t("模型（可选）")}</span>
            <input type="text" maxLength={maxModelLength} value={model} disabled={busy} placeholder={t("跟随默认")} onChange={(event) => setModel(event.target.value)}/>
          </label>
        </div>
        <label>
          <span>{t("对话名称（可选）")}</span>
          <input type="text" maxLength={256} value={title} disabled={busy} placeholder={t("为这段对话起个名字")} onChange={(event) => setTitle(event.target.value)}/>
        </label>

        <div className="lb-result-card" aria-live="polite">
          {evaluating ? (
            <div className="lb-result-loading"><LoaderCircle size={15} className="spin"/><span>{t("正在评估各主机负载…")}</span></div>
          ) : chosenCandidate ? (
            <>
              <div className="lb-result-top">
                <div className="lb-result-host">
                  <CheckCircle2 size={15} className="lb-ok-icon" aria-hidden="true"/>
                  <span>{t("已自动选定")}</span>
                  <strong>{chosenCandidate.hostName}</strong>
                </div>
                <div className="lb-result-actions">
                  <button type="button" className="lb-inline-btn" disabled={busy || evaluating} onClick={() => { if (!busy) void evaluate(engine, true); }}>
                    <RefreshCw size={12}/>
                    <span>{t("重新选择")}</span>
                  </button>
                  <button type="button" className="lb-inline-btn" disabled={busy} onClick={() => { if (!busy) setMode("manual"); }}>
                    <span>{t("改为手动")}</span>
                  </button>
                </div>
              </div>
              {chosenCandidate.resources && <div className="lb-host-metrics">
                <span><Cpu size={11}/> CPU {chosenCandidate.resources.cpuPercent}%</span>
                <span><MemoryStick size={11}/> {t("内存")} {chosenCandidate.resources.memoryUsedPercent}%</span>
                <span><Activity size={11}/> {t("{0} 个进行中", chosenCandidate.resources.activeTurns + chosenCandidate.resources.activeTickets)}</span>
                {typeof chosenCandidate.latencyMs === "number" && <span>{Math.round(chosenCandidate.latencyMs)} ms</span>}
              </div>}
              <div className="lb-bot-plan">
                <BotIcon size={13} aria-hidden="true"/>
                <span>{chosenCandidate.matchingBotName
                  ? t("将复用已有 Bot：{0}", chosenCandidate.matchingBotName)
                  : t("该主机尚无此引擎 Bot，将按预设模板自动创建")}</span>
              </div>
            </>
          ) : (
            <div className="lb-result-empty">
              <div className="lb-result-empty-head">
                <AlertTriangle size={15} aria-hidden="true"/>
                <strong>{t("暂无可自动分配的主机，请改为手动选择")}</strong>
              </div>
              {!!selection?.excluded.length && <ul className="lb-excluded-list">
                {selection.excluded.map((item) => (
                  <li key={item.hostId}><span>{item.hostName}</span><small>{exclusionLabel(item.reason)}</small></li>
                ))}
              </ul>}
              <button type="button" className="lb-inline-btn" disabled={busy} onClick={() => { if (!busy) setMode("manual"); }}>{t("手动选择主机")}</button>
            </div>
          )}
        </div>

        {error && <p role="alert" className="error-text">{error}</p>}
        <button className="primary full" type="submit" disabled={busy || evaluating || !chosenCandidate}>
          {busy ? <LoaderCircle size={16} className="spin"/> : <Plus size={16}/>}
          <span>{busy ? t("正在创建…") : t("在选定主机创建对话")}</span>
        </button>
      </form>
    )}
  </CreationDialog>;
}
