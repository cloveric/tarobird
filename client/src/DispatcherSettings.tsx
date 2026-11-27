import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDown, Server } from "lucide-react";
import { z } from "zod";
import {
  DISPATCH_ENGINES, DISPATCH_MAX_CONCURRENT, dispatchNodesResponseSchema, dispatcherSettingsSchema,
  type DispatchNodeTarget, type DispatchNodesResponse, type DispatcherNodeSettings, type DispatcherSettings, type HostDispatchPreference,
} from "../../src/client-protocol/dispatch.js";
import type { Bot, HubConnection } from "./connection.js";
import type { BotCatalog } from "../../src/client-protocol/bots.js";
import { BotMessageHostsContext, botMessageHostId } from "./bot-message-hosts.js";
import { CreationDialog } from "./CreationDialog.js";
import { useBotSettingsRequest } from "./bot-settings-request.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import "./dispatch.css";

export const ENGINE_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude", kimi: "Kimi", deepseek: "DeepSeek", antigravity: "Antigravity", pi: "Pi", omp: "oh-my-pi" };
type Engine = NonNullable<DispatcherSettings["allowedEngines"]>[number];
/** Engine CLIs installed on the Host, from its Bot catalog. */
export const installedEngines = (catalog?: BotCatalog): Engine[] => (catalog?.engines ?? []).filter(engine => engine.available).map(engine => engine.id).filter((id): id is Engine => (DISPATCH_ENGINES as readonly string[]).includes(id));
/** An omitted allowlist means every CLI, including ones installed later. An
 * explicit one never depends on what is installed now: a missing CLI stays
 * listed, and naming every installed CLI does not allow later installs. */
export function normalizedDispatcherSettings(value: DispatcherSettings, _installed?: readonly Engine[]): DispatcherSettings {
  const { allowedEngines, nodes, ...rest } = value;
  const normalizedNodes = nodes?.length ? [...nodes].map(({ allowedEngines: nodeEngines, ...nodeRest }) => (
    nodeEngines ? { ...nodeRest, allowedEngines: DISPATCH_ENGINES.filter(id => nodeEngines.includes(id)) } : nodeRest
  )).sort((a, b) => a.hostId.localeCompare(b.hostId)) : undefined;
  return {
    ...rest,
    ...(allowedEngines ? { allowedEngines: DISPATCH_ENGINES.filter(id => allowedEngines.includes(id)) } : {}),
    ...(normalizedNodes?.length ? { nodes: normalizedNodes } : {}),
  };
}
/** Ticking adds a CLI and unticking narrows the list; undefined when it would leave none. */
export function toggledDispatcherEngine(value: DispatcherSettings, installed: readonly Engine[], id: Engine, checked: boolean): DispatcherSettings | undefined {
  const current = value.allowedEngines ?? installed;
  const next = DISPATCH_ENGINES.filter(engine => engine === id ? checked : current.includes(engine));
  return next.length ? { ...value, allowedEngines: next } : undefined;
}
/** Allowing CLIs installed later drops the list; leaving that choice lists the
 * installed CLIs. Undefined when nothing is installed to list. */
export function laterInstalledEngines(value: DispatcherSettings, installed: readonly Engine[], allow: boolean): DispatcherSettings | undefined {
  const { allowedEngines: _allowed, ...rest } = value;
  if (allow) return rest;
  const listed = DISPATCH_ENGINES.filter(id => installed.includes(id));
  return listed.length ? { ...rest, allowedEngines: listed } : undefined;
}

/** Shared by New Bot and Bot settings. Without the Host catalog (`failed`) the
 * allowlist is left as it is and only the other settings can change. */
export function DispatcherSettingsFields({ value, change, engines, loading = false, failed = false, retry, disabled = false }: { value: DispatcherSettings; change: (value: DispatcherSettings) => void; engines: readonly Engine[]; loading?: boolean; failed?: boolean; retry?: () => void; disabled?: boolean }) {
  useLocale();
  const modeHelp = useId();
  const allowed = (id: Engine) => !value.allowedEngines || value.allowedEngines.includes(id);
  // Allowed CLIs that are not installed stay visible, so saving cannot drop them unseen.
  const choices = DISPATCH_ENGINES.filter(id => engines.includes(id) || !!value.allowedEngines?.includes(id));
  return <div className="dispatcher-fields">
    <fieldset disabled={disabled}><legend>{t("可以使用的 CLI")}</legend>
      {loading ? <p className="muted" role="status">{t("正在读取可用的 CLI…")}</p>
        : failed ? <div role="alert" className="error-text"><p>{t("暂时无法读取可用引擎，请重试。")}</p>{retry && <button type="button" onClick={retry}>{t("重新读取可用的 CLI")}</button>}</div>
        : choices.length ? <>{choices.map(engine => <label className="collaboration-check" key={engine}><input type="checkbox" checked={allowed(engine)} onChange={event => { const next = toggledDispatcherEngine(value, engines, engine, event.target.checked); if (next) change(next); }}/>{ENGINE_NAMES[engine] ?? engine}{!engines.includes(engine) && t("（未安装）")}</label>)}
          <label className="collaboration-check"><input type="checkbox" checked={!value.allowedEngines} disabled={!value.allowedEngines && !engines.length} onChange={event => { const next = laterInstalledEngines(value, engines, event.target.checked); if (next) change(next); }}/>{t("也允许以后安装的 CLI")}</label></>
        : <p className="muted">{t("这台主机还没有检测到可用的 CLI；安装并登录后即可使用。")}</p>}
    </fieldset>
    <label>{t("派活方式")}<select aria-label={t("派活方式")} aria-describedby={modeHelp} disabled={disabled} value={value.mode} onChange={event => change({ ...value, mode: event.target.value as DispatcherSettings["mode"] })}><option value="ask">{t("派工前询问我")}</option><option value="auto">{t("自动派工")}</option></select></label>
    <p id={modeHelp} className="muted">{value.mode === "ask" ? t("幕僚长会先说明分工，征得你同意后再派出工单。") : t("幕僚长可自行派出工单，完成后向你汇报。")}</p>
    <label>{t("同时进行的工单上限")}<select aria-label={t("同时进行的工单上限")} disabled={disabled} value={value.maxConcurrent} onChange={event => change({ ...value, maxConcurrent: Number(event.target.value) })}>{Array.from({ length: DISPATCH_MAX_CONCURRENT }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count}</option>)}</select></label>
  </div>;
}

const snapshotSchema = z.object({ settings: dispatcherSettingsSchema, revision: z.string() });
function errorText(error: unknown) {
  if (error instanceof HubHttpError && error.status === 404) return t("此主机尚不支持幕僚长，请更新主机版本。");
  switch (error instanceof Error ? error.message : "") {
    case "dispatcher_settings_conflict": return t("其他设备已修改幕僚长设置。请重新读取后再保存。");
    default: return t("未能确认设置结果，请重新读取后核对。不会自动重试保存。");
  }
}
/** Bot settings row for a dispatcher Bot; edits the Host's settings with a revision. */
export function DispatcherSettingsControl({ connection, bot, online, owner }: { connection: HubConnection; bot: Bot; online: boolean; owner: boolean }) {
  useLocale();
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!owner) setOpen(false); }, [owner]);
  return <><button ref={trigger} className="header-effort" aria-label={t("设置幕僚长")} disabled={!owner} onClick={() => setOpen(true)}>{t("设置")}<ChevronDown size={12}/></button>
    {open && owner && <DispatcherDialog connection={connection} bot={bot} online={online} close={() => setOpen(false)} returnFocus={trigger}/>}
  </>;
}
function nodeStatusLabel(node: DispatchNodeTarget, enabled: boolean): string {
  if (!node.online) return t("离线");
  if (!node.authorized) return t("未授权");
  if (!enabled) return t("已停用");
  return t("可用");
}
function quotaHint(node: DispatchNodeTarget): string | undefined {
  const flagged = node.load.engines.filter(e => e.installed && (e.quotaState === "blocked" || e.quotaState === "warning"));
  if (!flagged.length) return undefined;
  return flagged.map(e => `${ENGINE_NAMES[e.engine] ?? e.engine}: ${e.quotaState === "blocked" ? t("配额耗尽") : t("配额偏低")}`).join(" · ");
}

function DispatcherDialog({ connection, bot, online, close, returnFocus }: { connection: HubConnection; bot: Bot; online: boolean; close: () => void; returnFocus: RefObject<HTMLButtonElement | null> }) {
  const { data, busy, saving, error, saved, load, save } = useBotSettingsRequest(connection, bot.id, "dispatcher", snapshotSchema);
  const hostEntries = useContext(BotMessageHostsContext);
  const [draft, setDraft] = useState<DispatcherSettings>();
  const [confirm, setConfirm] = useState<"close" | "reload">();
  const continueEditing = useRef<HTMLButtonElement>(null);
  const [catalog, setCatalog] = useState<BotCatalog>(), [catalogFailed, setCatalogFailed] = useState(false), [catalogAttempt, setCatalogAttempt] = useState(0);
  const [nodesView, setNodesView] = useState<DispatchNodesResponse>();
  const [grantBusyHost, setGrantBusyHost] = useState(""), [grantError, setGrantError] = useState("");
  const crossHostAvailable = connection.state.crossHostDispatchAvailable;
  const loadNodes = useCallback(async () => {
    if (!crossHostAvailable) { setNodesView(undefined); return; }
    try {
      const value = dispatchNodesResponseSchema.parse(await connection.http(`/api/bots/${encodeURIComponent(bot.id)}/dispatch-nodes`));
      setNodesView(value);
    } catch { /* Optional cross-host capability; older Hubs return 404. */ }
  }, [connection, bot.id, crossHostAvailable]);
  const reloadAll = useCallback(() => {
    void load();
    if (online) void loadNodes();
  }, [load, loadNodes, online]);
  useEffect(() => { let alive = true; setCatalogFailed(false); void connection.http<BotCatalog>("/api/bots/catalog").then(value => { if (alive) setCatalog(value); }, () => { if (alive) setCatalogFailed(true); }); return () => { alive = false; }; }, [connection, catalogAttempt]);
  useEffect(() => { if (online) void loadNodes(); }, [online, loadNodes]);
  useEffect(() => { if (online && saved) void loadNodes(); }, [online, saved, data?.revision, loadNodes]);
  const engines = useMemo(() => installedEngines(catalog), [catalog]);
  // The draft never waits for the catalog: the allowlist does not depend on it.
  useEffect(() => { if (data) setDraft(normalizedDispatcherSettings(data.settings)); }, [data]);
  const changed = !!data && !!draft && JSON.stringify(normalizedDispatcherSettings(draft)) !== JSON.stringify(normalizedDispatcherSettings(data.settings));
  const leave = () => { if (changed) setConfirm("close"); else close(); };
  const updateNode = (node: DispatchNodeTarget, patch: Partial<DispatcherNodeSettings> & { allowedEngines?: Engine[] | undefined }) => {
    if (!draft) return;
    const existing = draft.nodes ?? [];
    const savedEntry = existing.find(item => item.hostId === node.hostId);
    const current: DispatcherNodeSettings = savedEntry ?? {
      hostId: node.hostId,
      enabled: node.enabled,
      maxConcurrent: node.maxConcurrent,
      preference: node.preference,
    };
    const nextEntry: DispatcherNodeSettings = { ...current, ...patch };
    if ("allowedEngines" in patch && patch.allowedEngines === undefined) delete nextEntry.allowedEngines;
    const others = existing.filter(item => item.hostId !== node.hostId);
    setDraft({ ...draft, nodes: [...others, nextEntry] });
  };
  const canManageRemoteGrant = (remoteEntry: (typeof hostEntries)[number] | undefined) => {
    const remoteConn = remoteEntry?.connection;
    return !!remoteEntry && !!remoteConn
      && !remoteEntry.host.networkBlocked
      && !remoteConn.isNetworkBlocked
      && !remoteConn.isReadOnly
      && remoteConn.state.status === "online"
      && remoteConn.state.user?.role === "owner"
      && !!remoteConn.state.crossHostDispatchAvailable;
  };
  const setRemoteGrant = async (node: DispatchNodeTarget, allowed: boolean) => {
    if (!nodesView?.ownHostId || grantBusyHost) return;
    const remoteEntry = hostEntries.find(entry => entry.host.publicKey && botMessageHostId(entry.host.publicKey) === node.hostId);
    const remoteConn = remoteEntry?.connection;
    if (!canManageRemoteGrant(remoteEntry) || !remoteConn) return;
    setGrantBusyHost(node.hostId); setGrantError("");
    try {
      await remoteConn.saveCrossHostDispatchGrants({ operation: "cross-host-dispatch-grant", sourceHost: nodesView.ownHostId, sourceBot: bot.id, allowed });
      await loadNodes();
    } catch {
      setGrantError(allowed ? t("授权未能确认，请在远端主机确认后重试。") : t("撤销授权未能确认，请在远端主机确认后重试。"));
    } finally { setGrantBusyHost(""); }
  };
  const showNodes = (nodesView?.nodes.length ?? 0) > 1 || (draft?.nodes?.length ?? 0) > 0;
  return <CreationDialog mobilePage title={t("幕僚长设置")} closeLabel={t("关闭幕僚长设置")} close={leave} busy={saving} returnFocus={returnFocus}>
    <div className="effort-settings">
      <p className="effort-scope"><strong>{bot.name}</strong><span>{t("决定它可以用哪些 CLI、派活前是否先问你，以及同时进行几张。")}</span></p>
      {data && draft && <form onSubmit={event => { event.preventDefault(); if (!busy && online && changed) void save({ settings: normalizedDispatcherSettings(draft), expectedRevision: data.revision }); }}>
        <DispatcherSettingsFields value={draft} change={setDraft} engines={engines} loading={!catalog && !catalogFailed} failed={!catalog && catalogFailed} retry={() => setCatalogAttempt(value => value + 1)} disabled={busy || !online}/>
        {showNodes && nodesView && <fieldset className="dispatcher-nodes" disabled={busy || !online}>
          <legend>{t("跨主机协作节点")}</legend>
          <p className="muted">{t("选择参与并发派工的组网主机。远程执行者使用接收主机的手动审批设置。")}</p>
          {grantError && <p role="alert" className="error-text">{grantError}</p>}
          <ul className="dispatcher-node-list">
            {nodesView.nodes.map(node => {
              const savedEntry = draft.nodes?.find(item => item.hostId === node.hostId);
              const enabled = savedEntry?.enabled ?? node.enabled;
              const preference = savedEntry?.preference ?? node.preference;
              const maxConcurrent = savedEntry?.maxConcurrent ?? node.maxConcurrent;
              const nodeInstalled = node.load.engines.filter(e => e.installed).map(e => e.engine);
              const nodeChoices = DISPATCH_ENGINES.filter(id => nodeInstalled.includes(id) || !!savedEntry?.allowedEngines?.includes(id));
              const effectiveNodeAllowed = savedEntry?.allowedEngines ?? draft.allowedEngines;
              const nodeEngineAllowed = (id: Engine) => !effectiveNodeAllowed || effectiveNodeAllowed.includes(id);
              const toggleNodeEngine = (engine: Engine, checked: boolean) => {
                const base = savedEntry?.allowedEngines
                  ?? (draft.allowedEngines ? DISPATCH_ENGINES.filter(id => draft.allowedEngines!.includes(id) && nodeChoices.includes(id)) : nodeChoices);
                const next = DISPATCH_ENGINES.filter(id => id === engine ? checked : base.includes(id));
                if (next.length) updateNode(node, { allowedEngines: next });
              };
              const remoteEntry = !node.local ? hostEntries.find(entry => entry.host.publicKey && botMessageHostId(entry.host.publicKey) === node.hostId) : undefined;
              const canManageHere = !node.local && canManageRemoteGrant(remoteEntry);
              const qHint = quotaHint(node);
              return <li key={node.hostId} className="dispatcher-node-row" data-online={node.online ? "1" : "0"} data-authorized={node.authorized ? "1" : "0"}>
                <div className="dispatcher-node-head">
                  <label className="collaboration-check">
                    <input type="checkbox" checked={enabled} onChange={event => updateNode(node, { enabled: event.target.checked })}/>
                    <Server size={13}/>
                    <strong>{node.hostName}</strong>
                    {node.local && <span className="dispatch-node-pill">{t("本机")}</span>}
                  </label>
                  <span className="dispatch-node-pill" data-state={node.online && node.authorized && enabled ? "ready" : "muted"}>{nodeStatusLabel(node, enabled)}</span>
                </div>
                <div className="dispatcher-node-meta">
                  <span>{t("进行中 {0}/{1}", node.activeOnNode, maxConcurrent)}</span>
                  {node.load.cpuLoadRatio !== undefined && <span>{t("负载 {0}%", Math.round(node.load.cpuLoadRatio * 100))}</span>}
                  {qHint && <span>{qHint}</span>}
                </div>
                <div className="dispatcher-node-controls">
                  <label>{t("调度偏好")}
                    <select value={preference} onChange={event => updateNode(node, { preference: event.target.value as HostDispatchPreference })}>
                      <option value="prefer">{t("优先使用")}</option>
                      <option value="normal">{t("正常调度")}</option>
                      <option value="less_often">{t("尽量少用")}</option>
                      <option value="manual_only">{t("仅手动指定")}</option>
                    </select>
                  </label>
                  <label>{t("此机并发")}
                    <select value={maxConcurrent} onChange={event => updateNode(node, { maxConcurrent: Number(event.target.value) })}>
                      {Array.from({ length: DISPATCH_MAX_CONCURRENT }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count}</option>)}
                    </select>
                  </label>
                </div>
                {nodeChoices.length > 0 && <div className="dispatcher-node-engines">
                  <span className="dispatcher-node-engines-label">{t("此机可用 CLI")}</span>
                  <div className="dispatcher-node-engines-checks">
                    {nodeChoices.map(engine => <label className="collaboration-check" key={engine}>
                      <input type="checkbox" checked={nodeEngineAllowed(engine)} onChange={event => toggleNodeEngine(engine, event.target.checked)}/>
                      {ENGINE_NAMES[engine] ?? engine}{!nodeInstalled.includes(engine) && t("（未安装）")}
                    </label>)}
                    <label className="collaboration-check">
                      <input type="checkbox" checked={!savedEntry?.allowedEngines} onChange={event => {
                        if (event.target.checked) {
                          updateNode(node, { allowedEngines: undefined });
                        } else {
                          const pinned = draft.allowedEngines
                            ? DISPATCH_ENGINES.filter(id => draft.allowedEngines!.includes(id) && nodeChoices.includes(id))
                            : nodeChoices;
                          if (pinned.length) updateNode(node, { allowedEngines: pinned });
                        }
                      }}/>
                      {t("跟随全局 CLI 设置")}
                    </label>
                  </div>
                </div>}
                {!node.local && !node.authorized && <div className="dispatcher-node-auth">
                  {canManageHere
                    ? <button type="button" disabled={!!grantBusyHost || !online} onClick={() => void setRemoteGrant(node, true)}>{grantBusyHost === node.hostId ? t("授权中…") : t("授权此主机接收派工")}</button>
                    : <p className="muted">{t("尚未获得远端授权，请在对方主机的终端或已连客户端授权。")}</p>}
                </div>}
                {!node.local && node.authorized && canManageHere && <div className="dispatcher-node-auth">
                  <button type="button" disabled={!!grantBusyHost || !online} onClick={() => void setRemoteGrant(node, false)}>{grantBusyHost === node.hostId ? t("撤销中…") : t("撤销此主机授权")}</button>
                </div>}
              </li>;
            })}
          </ul>
        </fieldset>}
        <p className="muted">{t("进行中的工单不受影响；之后派出的工单使用新设置。")}</p>
        <p role="status" className={changed || saved ? "dashboard-notice" : "muted"}>{saving ? t("保存中…") : error !== undefined ? t("保存结果尚未确认，请核对下方提示。") : changed ? t("修改尚未保存，点击「保存到此 Bot」后生效。") : saved ? t("幕僚长设置已保存。") : t("当前显示的是主机已保存的设置。")}</p>
        <div className="effort-actions"><button type="button" disabled={busy || !online} onClick={() => changed ? setConfirm("reload") : reloadAll()}>{t("重新读取")}</button><button type="submit" className="primary" disabled={busy || !online || !changed}>{saving ? t("保存中…") : t("保存到此 Bot")}</button></div>
      </form>}
      {!data && <button disabled={busy || !online} onClick={() => reloadAll()}>{busy ? t("正在读取…") : t("重新读取")}</button>}
      {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
      {error !== undefined && <p role="alert" className="error-text">{errorText(error)}</p>}
    </div>
    {confirm && <CreationDialog title={t("有未保存的修改")} showHost={false} closeLabel={t("取消")} close={() => setConfirm(undefined)} initialFocus={continueEditing}>
      <p>{error !== undefined ? t("上次保存结果尚未确认。放弃本页修改不会撤销主机可能已保存的设置，请重新读取核对。") : confirm === "close" ? t("这些修改尚未保存。请返回编辑页保存，或放弃修改后退出。") : t("重新读取会丢弃本页未保存的修改，恢复主机已保存的设置。")}</p>
      <div className="effort-actions"><button ref={continueEditing} type="button" className="primary" onClick={() => setConfirm(undefined)}>{t("继续编辑")}</button><button type="button" onClick={() => { const action = confirm; setConfirm(undefined); if (action === "close") close(); else reloadAll(); }}>{t("放弃修改")}</button></div>
    </CreationDialog>}
  </CreationDialog>;
}
