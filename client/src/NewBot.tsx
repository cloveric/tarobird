import { PermissionSelect } from "./PermissionSelect.js";
import type { PermissionChoice } from "../../src/state/permission-options.js";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Bot as BotIcon, LoaderCircle, SquareTerminal } from "lucide-react";
import type { BotCatalog, CreateBotInput } from "../../src/client-protocol/bots.js";
import type { Bot, HubConnection } from "./connection.js";
import { Avatar } from "./Avatar.js";
import { CreationDialog } from "./CreationDialog.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import { IntegrationRecommendations, type IntegrationFeature } from "./IntegrationRecommendations.js";
import { modelOptionLabel, modelOptions, selectedModelOption, selectedModelEffort, selectModel, selectModelEffort } from "./model-selection.js";
import { effortValueSchema } from "../../src/client-protocol/effort.js";
import { defaultDispatcherSettings, type DispatcherSettings } from "../../src/client-protocol/dispatch.js";
import { DispatcherSettingsFields, installedEngines, normalizedDispatcherSettings } from "./DispatcherSettings.js";
import { DispatcherRoutingHelp } from "./DispatcherRoutingHelp.js";
import "./conversation-creation.css";
import "./new-bot.css";

export function NewBot({ hostName, localHost = false, connection, close, chat, setup }: { hostName?: string; localHost?: boolean; connection: HubConnection; close: () => void; chat: (bot: Bot) => void; setup?: (bot: Bot, features: IntegrationFeature[]) => void }) {
  useLocale(); const state = useSyncExternalStore((f) => connection.subscribe(f), () => connection.state);
  const [firstBot] = useState(() => !state.bots.length && !state.deletedBots?.length);
  const recommend = localHost && firstBot && !!setup;
  const cliHelp = useId();
  const [catalog, setCatalog] = useState<BotCatalog>(); const [name, setName] = useState("");
  const [engine, setEngine] = useState<CreateBotInput["engine"]>("codex"), [model, setModel] = useState(""), [effort, setEffort] = useState<CreateBotInput["effort"]>(""); const [workspace, setWorkspace] = useState("");
  const [permission, setPermission] = useState<PermissionChoice>("bypass");
  const [slowStart, setSlowStart] = useState(false);
  const [effortAdjusted, setEffortAdjusted] = useState(false);
  // Chosen only here; the Host fixes the role at creation.
  const [dispatcher, setDispatcher] = useState(false), [dispatch, setDispatch] = useState<DispatcherSettings>(defaultDispatcherSettings);
  const targets = installedEngines(catalog);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const [created, setCreated] = useState<Bot>();
  const pending = useRef<CreateBotInput>(undefined);
  const options = catalog?.engines.find((e) => e.id === engine);
  const models = modelOptions(engine, options?.models ?? []), selectedModel = selectedModelOption(models, model);
  const displayedEffort = selectedModelEffort(selectedModel, { model, effort }), levels = selectedModel?.efforts ?? [""];
  const validSelection = !!selectedModel && levels.includes(displayedEffort);
  const changeEngine = (id: CreateBotInput["engine"], source = catalog) => { const next = source?.engines.find((e) => e.id === id); setEngine(id); setModel(next?.defaultModel ?? ""); setEffort(effortValueSchema.safeParse(next?.defaultEffort ?? "").data ?? ""); setEffortAdjusted(false); setPermission(next?.permissions?.defaultChoice ?? "bypass"); };
  // A failed catalog read says why: only a missing endpoint means "update the
  // Hub". A dropped connection retries by itself once online; other failures
  // offer an explicit retry instead of requiring the dialog to be reopened.
  const [catalogError, setCatalogError] = useState<"offline" | "failed" | "forbidden" | "unsupported">();
  const [catalogAttempt, setCatalogAttempt] = useState(0), online = state.status === "online";
  useEffect(() => {
    if (catalog) return;
    let alive = true; setCatalogError(undefined);
    void connection.http<BotCatalog>("/api/bots/catalog").then((value) => { if (alive) { setCatalog(value); changeEngine(value.engines.find((e) => e.available)?.id ?? "codex", value); } }).catch((e: unknown) => {
      if (!alive) return;
      const offline = e instanceof HubHttpError ? e.status === 0 : e instanceof TypeError;
      // A Hub that never had Bot creation (404) or runs without a Bot manager
      // will not recover by retrying; other failures are transient.
      const unsupported = e instanceof HubHttpError && (e.status === 404 || e.code === "bot_creation_unavailable");
      setCatalogError(e instanceof HubHttpError && e.status === 403 ? "forbidden" : unsupported ? "unsupported" : offline ? "offline" : "failed");
    });
    return () => { alive = false; };
  }, [connection, catalogAttempt, online]);
  const catalogMessage = catalogError === "forbidden" ? t("只有管理员可以创建 Bot。") : catalogError === "unsupported" ? t("此 Hub 暂未启用 Bot 创建，请更新 Hub 后重试。") : catalogError === "offline" ? t("连接中断，恢复后会自动重新读取可用引擎。") : catalogError === "failed" ? t("暂时无法读取可用引擎，请重试。") : "";
  const submit = async () => {
    if (busy || !validSelection) return; setBusy(true); setError("");
    const selection = selectModelEffort(selectedModel, model, displayedEffort)!;
    pending.current ??= { requestId: `bot_${crypto.randomUUID()}`, name: name.trim(), engine, ...selection, workspace, ...(options?.permissions ? { permission } : {}), ...(dispatcher && state.dispatchAvailable ? { role: "dispatcher" as const, dispatcher: normalizedDispatcherSettings(dispatch, targets) } : {}) };
    try { setCreated(await connection.createBot(pending.current)); }
    catch (e) {
      if (e instanceof HubHttpError && e.status >= 400 && e.status < 500) pending.current = undefined;
      const code = e instanceof Error ? e.message : "";
      setError(code === "bot_engine_unavailable" ? t("运行主机未检测到所选引擎的 CLI。请在该主机安装并完成登录或 API 密钥配置后重试。") : code === "bot_workspace_unavailable" ? t("工作区不存在，请填写运行 Bot 的主机上的文件夹路径。") : code === "permissions_incompatible" ? t("当前引擎不支持此权限模式，请重新读取可用选项。") : code === "bot_effort_incompatible" ? t("所选模型不支持这个 effort，请重新选择。") : t("暂未收到创建结果，请重试。重试会继续同一次创建。"));
    } finally { setBusy(false); }
  };
  const bot = state.bots.find((b) => b.id === created?.id) ?? created;
  useEffect(() => { if (!bot || bot.online) { setSlowStart(false); return; } const timer = setTimeout(() => setSlowStart(true), 15_000); return () => clearTimeout(timer); }, [bot?.id, bot?.online]);
  return <CreationDialog className={`bot-setup${bot ? "" : " conversation-creation"}`} title={t("新建 Bot")} close={close} busy={busy}>{bot ? <div className="bot-created"><Avatar kind="bot" id={bot.id} name={bot.name} size={64}/><h3>{t("{0} 已创建", bot.name)}</h3><p>{bot.engine} · {bot.model || t("引擎默认")} · {bot.effort || t("引擎默认")}</p><p role="status">{bot.online ? t("Bot 已上线，可以开始对话。") : slowStart ? t("Bot 已创建但尚未上线，可在运行状态中查看详情并重试启动。") : t("Bot 正在启动，进入对话后可以先写消息。")}</p>{recommend && <IntegrationRecommendations connection={connection} disabled={state.status !== "online"} prepare={features => setup!(bot, features)}/>}<button className={recommend ? "full" : "primary full"} onClick={() => chat(bot)}>{recommend ? t("跳过，开始对话") : t("开始对话")}</button></div> : <form className="new-bot-form" aria-busy={busy || undefined} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
    <p className="new-bot-lead">{t("设置一次，开对话、开群和开话题都能直接选用。")}</p>
    {/* Engine catalog problems lead the form, outside the disabled fieldset, so their cause and retry are seen first. */}
    {catalogError && <div role="alert" className="error-text new-bot-alert new-bot-catalog"><p>{catalogMessage}</p>{catalogError !== "forbidden" && catalogError !== "unsupported" && <button type="button" disabled={!online} onClick={() => setCatalogAttempt(value => value + 1)}>{t("重新读取")}</button>}</div>}
    {catalog && !catalog.engines.some((e) => e.available) && <p role="alert" className="new-bot-alert new-bot-catalog is-warning">{t("此主机尚未检测到支持的 AI CLI。请先在主机上安装至少一种引擎，再重新打开此页面。")}</p>}
    <fieldset disabled={busy || !!pending.current} className="bot-fields">
    <div className="new-bot-block">
      <label>{t("Bot 名称")}<input autoFocus required maxLength={100} value={name} placeholder={t("例如：研究助手、代码助手")} onChange={(e) => setName(e.target.value)}/></label>
      <p className="new-bot-hint bot-avatar-hint">{t("创建后会自动分配一个精灵头像，可在 Bot 设置中更换。")}</p>
    </div>
    <div className="new-bot-block" role="group" aria-labelledby={`${cliHelp}-model`}>
      <h3 id={`${cliHelp}-model`} className="new-bot-heading">{t("模型配置")}</h3>
      <label>{t("引擎")}<select aria-label={t("引擎")} aria-describedby={cliHelp} value={engine} onChange={(e) => changeEngine(e.target.value as CreateBotInput["engine"])}>{catalog?.engines.map((e) => <option key={e.id} value={e.id} disabled={!e.available}>{e.id}{!e.available ? t("（未检测到 CLI）") : ""}</option>)}</select></label>
      {/* Detection only proves the executable exists; sign-in is still the owner's step. */}
      <p id={cliHelp} className="new-bot-hint new-bot-cli"><SquareTerminal size={14} aria-hidden="true"/><span>{hostName ? t("需先在「{0}」安装此引擎的 CLI，并完成登录或 API 密钥配置。", hostName) : t("需先在运行主机上安装此引擎的 CLI，并完成登录或 API 密钥配置。")}</span></p>
      <div className="new-bot-pair">
        <label>{t("模型")}<select aria-label={t("模型")} value={selectedModel?.id ?? model} onChange={(e) => { const next = selectModel(models, e.target.value, { model, effort }); setModel(next.model); setEffort(next.effort); setEffortAdjusted(!!displayedEffort && next.effort !== displayedEffort); }}>{models.map((m) => <option key={m.id} value={m.id}>{modelOptionLabel(m, t("跟随引擎默认模型"))}</option>)}</select></label>
        <label>{t("推理强度（effort）")}<select aria-label={t("推理强度（effort）")} value={displayedEffort} onChange={(e) => { const next = selectModelEffort(selectedModel, model, e.target.value as CreateBotInput["effort"]); if (next) { setModel(next.model); setEffort(next.effort); setEffortAdjusted(false); } }}>{!levels.includes(displayedEffort) && <option value={displayedEffort} disabled>{displayedEffort} · {t("当前模型不支持")}</option>}{levels.map((value) => <option key={value} value={value}>{value || t("跟随引擎默认强度")}</option>)}</select></label>
      </div>
      {effortAdjusted && <p className="dashboard-notice">{t("已调整为此模型支持的思考强度，请确认。")}</p>}
      {engine === "antigravity" && !model && <p className="new-bot-hint">{t("跟随默认模型时也跟随默认强度；选择具体模型后可调整其支持的档位。")}</p>}
    </div>
    {(state.dispatchAvailable || options?.permissions) && <div className="new-bot-block" role="group" aria-labelledby={`${cliHelp}-role`}>
      <h3 id={`${cliHelp}-role`} className="new-bot-heading">{state.dispatchAvailable && options?.permissions ? t("角色与权限") : state.dispatchAvailable ? t("角色") : t("权限")}</h3>
      {state.dispatchAvailable && <div className="new-bot-role" data-checked={dispatcher || undefined}>
        <div className="dispatcher-role-row"><label className="collaboration-check"><input type="checkbox" aria-describedby={`${cliHelp}-dispatcher`} checked={dispatcher} onChange={(e) => setDispatcher(e.target.checked)}/>{t("作为幕僚长")}</label><DispatcherRoutingHelp/></div>
        <p id={`${cliHelp}-dispatcher`} className="new-bot-hint">{t("你只说目标，它会拆分任务，并调用这台主机上已安装的 CLI 去做。只能在创建时选择。刚开始建议先建普通 Bot，这里不勾选。")}</p>
        {dispatcher && <div className="new-bot-role-details"><p className="new-bot-hint">{t("不需要另外建 Bot；过程不占对话列表，只在需要你决定或验收时提醒你。")}</p><p className="new-bot-hint">{t("上面的引擎、模型和推理强度是它自己思考用的；派出去的每张工单可以各自选择。")}</p><details><summary>{t("幕僚长设置")}</summary><DispatcherSettingsFields value={dispatch} change={setDispatch} engines={targets} loading={!catalog}/></details></div>}
      </div>}
      {options?.permissions && <PermissionSelect value={permission} choices={options.permissions.choices} defaultChoice={options.permissions.defaultChoice} change={setPermission}/>}
    </div>}
    <details><summary>{t("高级设置")}</summary><label>{t("工作区（可选）")}<input value={workspace} placeholder={t("留空，自动创建独立工作区")} onChange={(e) => setWorkspace(e.target.value)}/></label><p className="new-bot-hint">{t("填写运行 Bot 的主机上的文件夹路径；主机在 VPS 时，请填写 VPS 路径。")}</p></details></fieldset>
    <div className="new-bot-footer">
      {!catalog && !catalogError && <p role="status" className="new-bot-status"><LoaderCircle className="spin" size={14} aria-hidden="true"/>{t("正在读取可用引擎…")}</p>}
      {error && <p role="alert" className="error-text new-bot-alert">{error}</p>}
      <button className="primary full new-bot-submit" disabled={busy || !name.trim() || !options?.available || !validSelection || state.status !== "online"}>{busy ? <LoaderCircle className="spin" size={17}/> : <BotIcon size={17}/>} {busy ? t("正在创建 Bot…") : pending.current ? t("重试创建") : t("创建 Bot")}</button>
    </div>
  </form>}</CreationDialog>;
}
