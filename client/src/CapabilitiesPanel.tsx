import { SettingsPageHeader, captureSettingsPageFocus, useSettingsPageViewport } from "./SettingsPageHeader.js";
import { ZodError } from "zod";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { runtimeHostId } from "./host-registry.js";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { BookOpen, ChevronDown, Info, MessageSquare, Plug, Plus, RefreshCw, Search } from "lucide-react";
import { botCapabilitiesSchema, type BotCapabilities, type BotCapability } from "../../src/client-protocol/capabilities.js";
import { useBackAction } from "./back-navigation.js";
import { useBotLabels } from "./BotReferences.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import type { HubConnection, Bot } from "./connection.js";
import { IntegrationRecommendations } from "./IntegrationRecommendations.js";
import type { CapabilityHelpRequest } from "./CapabilityHelpDialog.js";
import { capabilityGroupStatus, filterCapabilityGroups, groupCapabilities, type CapabilityStateFilter } from "./capability-groups.js";
import "./capabilities.css";

type Kind = BotCapability["kind"];
type Warning = BotCapabilities["warnings"][number];
type StateFilter = CapabilityStateFilter;
type HelpRequest = { botId: string; kind: Kind; name?: string; source?: string; intent: "add" | "check" };
type Props = {
  connection: HubConnection; bots: Bot[]; initialBot?: string; close: () => void;
  /** Parent prepares a reviewable request, then a separate conversation with this Bot; nothing is installed or authorized here. */
  help?: (request: CapabilityHelpRequest) => void;
};

const PAGE_SIZE = 30;
// Warnings that change how far the list can be trusted stay inline; the rest fold under 读取范围与限制.
const prominent = new Set<Warning>(["config_unreadable", "workspace_unknown", "offline_workspace_only", "scan_limited"]);
const scopes = () => ({ user: t("用户共享"), workspace: t("工作区"), plugin: t("插件"), bridge: "TaroBird", system: t("系统"), bot: t("Bot 私有") });
const statuses = () => ({ discovered: t("已发现"), configured: t("已配置"), disabled: t("配置已禁用"), "partial-disabled": t("部分禁用"), mixed: t("状态不同") });
const stateFilters = () => ({ all: t("全部"), active: t("已发现/配置"), disabled: t("已禁用") });
const transports = () => ({ stdio: t("本地进程"), http: t("远程服务"), sse: t("远程服务"), ws: t("远程服务"), sdk: t("内置 SDK"), unknown: t("未知") });
const warnings = () => ({
  runtime_unverified: t("清单来自主机配置，尚未确认各会话实际加载或连接状态。"),
  partial_catalog: t("仅展示本次可读取的配置；云端连接器、动态插件及其他会话工作区可能未包含。"),
  offline_workspace_only: t("Bot 未响应，仅能读取该 Bot 本地工作区，用户共享配置尚未确认。"),
  config_unreadable: t("Bot 配置无法读取，无法确定其能力清单。"),
  workspace_unknown: t("无法确定 Bot 的工作区。"),
  scan_limited: t("清单达到读取上限，部分条目未展示。"),
  deepseek_dynamic_config: t("DeepSeek 的动态配置尚不能完整读取，当前仅展示已发现的 Skills 与平台注入项。"),
});
// Status is configuration metadata only; never phrase it as connected, authorized or loaded.
const meaning = (entry: BotCapability) => entry.status === "disabled" ? t("此来源将它标记为禁用；会话中的最终生效状态仍需检查。")
  : entry.status === "configured" ? t("已找到此项配置；能否连接、是否需要授权、会话是否已加载均未确认。")
  : t("已在读取范围内找到此项；会话是否实际加载未确认。");
const nextStep = (entry: BotCapability) => entry.status === "disabled" ? t("如需启用，可让 Bot 检查配置并说明修改范围与生效方式。")
  : entry.kind === "mcp" ? t("如需确认能否连接或是否需要授权，可让 Bot 实际检查。")
  : t("如需确认会话是否加载此 Skill 及其适用任务，可让 Bot 实际检查。");

export function CapabilitiesPanel({ connection, bots, initialBot, close, help }: Props) {
  const hostName = useContext(RuntimeHostContext)?.trim() || connection.state.hostProfile?.name?.trim() || connection.state.network?.host.name?.trim() || t("未知主机");
  const locale = useLocale(), labels = useBotLabels(), uid = useId();
  const [botId, setBotId] = useState(initialBot ?? bots[0]?.id ?? "");
  const [kind, setKind] = useState<Kind>("skill"), [query, setQuery] = useState(""), [scope, setScope] = useState(""), [state, setState] = useState<StateFilter>("all");
  const [loaded, setLoaded] = useState<{ bot: string; value: BotCapabilities }>(), [error, setError] = useState<{ text: string; retry: boolean }>();
  const [busy, setBusy] = useState(false), [page, setPage] = useState(0), [open, setOpen] = useState("");
  const [overviewOpen, setOverviewOpen] = useState(false), [recommendationsOpen, setRecommendationsOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), host = useRef<HTMLDetailsElement>(null);
  useSettingsPageViewport(body);
  const sequence = useRef(0), panel = useRef<HTMLElement>(null), closeRef = useRef(close); closeRef.current = close;
  const openRef = useRef(open); openRef.current = open;
  // Back/Esc close the focused or innermost disclosure before leaving this page.
  const dismiss = () => {
    const id = openRef.current;
    const toggle = [...(panel.current?.querySelectorAll<HTMLElement>("[data-entry]") ?? [])].find((element) => element.dataset.entry === id);
    const disclosures = [...(panel.current?.querySelectorAll<HTMLDetailsElement>("details[open]") ?? [])]
      .filter(element => !element.parentElement?.closest("details:not([open])"));
    const closest = document.activeElement?.closest<HTMLDetailsElement>("details[open]");
    const focused = closest && disclosures.includes(closest) ? closest : undefined;
    // Touch and WebKit may not focus a clicked button. An expanded entry still
    // precedes unrelated disclosures unless focus explicitly identifies one.
    if (id && !focused) { setOpen(""); toggle?.focus(); return true; }
    const disclosure = focused ?? disclosures.at(-1);
    if (disclosure) { disclosure.open = false; disclosure.querySelector("summary")?.focus(); return true; }
    return false;
  };
  const dismissRef = useRef(dismiss); dismissRef.current = dismiss;
  useBackAction(panel, () => { if (!dismissRef.current()) closeRef.current(); });
  useEffect(() => {
    const returnFocus = captureSettingsPageFocus(); panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const active = document.activeElement;
      // A dialog opened above this panel (e.g. the parent's help preview) owns the keyboard.
      if (active && !panel.current?.contains(active) && active.closest("dialog[open],[aria-modal=true]")) return;
      if (event.key === "Escape") { event.preventDefault(); if (!dismissRef.current()) closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,select,summary") ?? [])].filter((element) => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!panel.current?.contains(active) || active === panel.current) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key); return () => { document.removeEventListener("keydown", key); returnFocus(); sequence.current++; };
  }, []);
  async function load(keep = false) {
    const current = ++sequence.current, bot = botId; setError(undefined); setBusy(true); if (!keep) setLoaded(undefined);
    if (!bot) { setBusy(false); return; }
    try {
      const next = botCapabilitiesSchema.parse(await connection.http(`/api/bots/${encodeURIComponent(bot)}/capabilities`));
      if (current === sequence.current) { setLoaded({ bot, value: next }); setPage(0); setOpen(""); }
    } catch (error) {
      if (current === sequence.current) {
        setLoaded(undefined);
        setError(error instanceof ZodError ? { retry: false, text: t("主机数据与客户端版本不兼容，请更新两端后重试。") }
          : error instanceof HubHttpError && error.status === 404 ? { retry: false, text: t("此主机版本尚不支持 Skills 与 MCP 页面，请更新主机。") }
          : error instanceof HubHttpError && error.code === "owner_required" ? { retry: false, text: t("仅主机所有者可查看 Skills 和 MCP。") }
          : error instanceof HubHttpError && error.code === "bot_forbidden" ? { retry: false, text: t("此 Bot 已不可访问，请选择其他 Bot。") }
          : { retry: true, text: t("无法读取能力清单，请确认主机和 Bot 在线后重试。") });
      }
    } finally { if (current === sequence.current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [botId, connection]);
  useEffect(() => { if (!bots.some((bot) => bot.id === botId)) setBotId(bots[0]?.id ?? ""); }, [bots, botId]);
  // Data is keyed by the Bot it was read for, so a late or stale response can never render under another Bot.
  const data = loaded?.bot === botId ? loaded.value : undefined;
  const canHelp = !!help && bots.some((bot) => bot.id === botId);
  const blocking = data?.warnings.some((value) => value === "config_unreadable" || value === "workspace_unknown");
  const failedSources = data?.sources.filter((value) => value.status === "unreadable" || value.status === "limited").length ?? 0;
  const notes = data?.warnings.filter((value) => value !== "runtime_unverified" && value !== "partial_catalog") ?? [];
  const inline = notes.filter((value) => prominent.has(value)), folded = notes.filter((value) => !prominent.has(value));
  const foldedCount = folded.length;
  const entries = data?.entries.filter((entry) => entry.kind === kind) ?? [];
  const availableScopes = new Set(entries.map((value) => value.scope));
  const groups = groupCapabilities(entries);
  const matched = filterCapabilityGroups(groups, query, scope);
  const active = filterCapabilityGroups(matched, "", "", "active"), disabled = filterCapabilityGroups(matched, "", "", "disabled");
  const counts: Record<StateFilter, number> = { all: matched.length, active: active.length, disabled: disabled.length };
  const rows = (state === "active" ? active : state === "disabled" ? disabled : matched)
    .sort((a, b) => Number(a.sources.every(entry => entry.status === "disabled")) - Number(b.sources.every(entry => entry.status === "disabled")));
  const overlappingStates = kind === "skill" && active.length + disabled.length > matched.length;
  const filtered = !!(query || scope || state !== "all");
  const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1), currentPage = Math.min(page, lastPage);
  const hostFingerprint = (() => { try { return runtimeHostId(connection.identity.hubPublicKey ?? "").slice(4).match(/.{1,4}/g)!.join(" "); } catch { return t("未知主机"); } })();
  const scopeNames = scopes(), statusNames = statuses(), stateNames = stateFilters(), transportNames = transports(), warningText = warnings();
  const helpHint = t("配置消息由你确认发送，Bot 会在独立对话中协助设置；本地语音也可在下方单独确认安装。");
  const manualHint = t("可在与此 Bot 的会话中直接提出；本页只读取配置清单，不会安装或检查。");
  const resetView = () => { setPage(0); setOpen(""); };
  const turnPage = (value: number) => {
    if (value < 0 || value > lastPage) return;
    setPage(value); setOpen("");
    // Land on the first row of the new page, below the sticky filters.
    if (body.current && list.current) body.current.scrollTo({ top: Math.max(0, list.current.offsetTop - (toolbar.current?.offsetHeight ?? 0)) });
  };
  const switchKind = (value: Kind) => { setKind(value); setQuery(""); setScope(""); setState("all"); resetView(); };
  const switchBot = (value: string) => { if (value === botId) return; sequence.current++; setError(undefined); setLoaded(undefined); setBotId(value); resetView(); };
  const clearFilters = () => { setQuery(""); setScope(""); setState("all"); resetView(); search.current?.focus(); };
  const ask = (request: Omit<HelpRequest, "botId">) => { if (help && canHelp) help({ botId, ...request }); };
  return <div className="modal-scrim settings-page-scrim"><section ref={panel} tabIndex={-1} className="settings-panel capabilities-panel mobile-settings-page" role="dialog" aria-modal="true" aria-label={t("Skills 与 MCP")}>
    <SettingsPageHeader title={t("Skills 与 MCP")} eyebrow={t("主机能力")} closeLabel={t("关闭能力页面")} close={close}/>
    <div className="capabilities-context">
      <div className="capabilities-host-row"><span>{t("当前连接主机")}</span><details ref={host} className="capabilities-host"><summary data-disclosure-icon><span>{hostName}</span><ChevronDown size={14} aria-hidden/></summary><code>{hostFingerprint}</code><p>{t("仅显示当前连接主机上的 Bot。")}</p></details></div>
      <label><span className="capabilities-bot-label">{t("选择 Bot")}</span><select aria-label={t("选择 Bot")} value={botId} onChange={(event) => switchBot(event.target.value)} disabled={!bots.length}>{!bots.length && <option value="">{t("暂无 Bot")}</option>}{bots.map((bot) => <option key={bot.id} value={bot.id}>{labels.get(bot.id) ?? bot.name} · {bot.engine}</option>)}</select></label>
      <button className="file-action capabilities-refresh" aria-disabled={busy || !botId} data-busy={busy || undefined} onClick={() => { if (!busy && botId) void load(true); }}><RefreshCw size={15} aria-hidden/><span>{t("刷新清单")}</span></button>
    </div>
    <div className="capabilities-tabbar">
      <nav className="capabilities-tabs" aria-label={t("能力分类")}><button aria-pressed={kind === "skill"} onClick={() => switchKind("skill")}><BookOpen size={17} aria-hidden/>Skills{data && <span>{blocking ? "—" : groupCapabilities(data.entries.filter((row) => row.kind === "skill")).length}</span>}</button><button aria-pressed={kind === "mcp"} onClick={() => switchKind("mcp")}><Plug size={17} aria-hidden/>MCP{data && <span>{blocking ? "—" : data.entries.filter((row) => row.kind === "mcp").length}</span>}</button></nav>
      {canHelp && <button className="capabilities-action primary" aria-describedby={`${uid}-hint`} onClick={() => ask({ kind, intent: "add" })}><Plus size={15} aria-hidden/>{kind === "skill" ? t("添加 Skills") : t("添加 MCP")}</button>}
    </div>
    <div ref={body} className="capabilities-body" aria-busy={busy}>
      <details className="capabilities-overview" onToggle={event => setOverviewOpen(event.currentTarget.open)}>
        <summary data-disclosure-icon><Info size={14} aria-hidden/><span>{t("说明与建议")}</span>{data && <span className="capabilities-overview-status">{t("部分清单 · 未验证")}</span>}{foldedCount > 0 && <span className="capabilities-badge">{t("{0} 条提示", foldedCount)}</span>}<ChevronDown size={14} className="capabilities-overview-chevron" aria-hidden/></summary>
        <div className="capabilities-overview-content">
          <div className="capabilities-intro"><p>{kind === "skill" ? t("Skills 为 Bot 提供处理特定任务的方法与流程。") : t("MCP 为 Bot 接入外部工具、服务与数据。")}</p>{botId && <p id={`${uid}-hint`} className="capabilities-hint">{canHelp ? helpHint : manualHint}</p>}</div>
          {canHelp && <details className="integration-recommendations-entry" onToggle={event => setRecommendationsOpen(event.currentTarget.open)}><summary>{t("语音与搜索建议（可选）")}</summary><IntegrationRecommendations connection={connection} active={overviewOpen && recommendationsOpen} key={botId} disabled={connection.state.status !== "online"} prepare={features => help?.({ botId, kind: "integrations", features })}/></details>}
          {data && <>
            <p className="capabilities-notice-title">{t("部分配置清单 · 运行状态未确认")}</p>
            <p>{warningText.runtime_unverified}</p>
            <details className="capabilities-scope"><summary>{t("读取范围与限制")}{foldedCount > 0 && <span className="capabilities-badge">{t("{0} 条提示", foldedCount)}</span>}</summary>
              <ul>{folded.map((value) => <li key={value}>{warningText[value]}</li>)}<li>{t("以此 Bot 当前保存的默认工作区为范围；不同会话可能使用不同工作区。")}</li><li>{warningText.partial_catalog}</li></ul>
              <dl>{data.workspace && <div><dt>{t("工作区")}</dt><dd><code>{data.workspace}</code></dd></div>}<div><dt>{t("读取时间")}</dt><dd>{new Date(data.generatedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</dd></div></dl>
              <p className="capabilities-subhead">{t("读取来源详情")}</p>
              <ul className="capabilities-sources">{data.sources.map((source, index) => <li key={index}><code>{source.source}</code><span data-problem={source.status === "unreadable" || source.status === "limited" || undefined}>{source.status === "read" ? t("已读取") : source.status === "missing" ? t("未找到") : source.status === "limited" ? t("读取受限") : t("无法读取")}</span></li>)}</ul>
            </details>
          </>}
        </div>
      </details>
      {busy && <p className="capabilities-loading" role="status">{t("正在读取主机能力…")}</p>}
      {error && <div className="capabilities-error"><p className="error-text" role="alert">{error.text}</p>{error.retry && botId && <button className="capabilities-action" onClick={() => { panel.current?.focus(); void load(); }}>{t("重试")}</button>}</div>}
      {data && <>
        {failedSources > 0 && <p className="capabilities-warning" role="status">{t("{0} 个配置来源无法读取，清单可能不完整。", failedSources)}</p>}
        {inline.map((value) => <p key={value} className="capabilities-warning" role="status">{warningText[value]}</p>)}
        {!blocking && <>
          <div ref={toolbar} className="capabilities-toolbar">
            <div className="capabilities-filters"><label className="capabilities-search"><Search size={16} aria-hidden/><input ref={search} aria-label={t("搜索能力")} placeholder={t("搜索名称、说明或来源")} value={query} onChange={(event) => { setQuery(event.target.value); resetView(); }}/></label><select aria-label={t("能力来源")} value={scope} onChange={(event) => { setScope(event.target.value); resetView(); }}><option value="">{t("全部来源")}</option>{Object.entries(scopeNames).filter(([value]) => availableScopes.has(value as BotCapability["scope"]) || value === scope).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="capabilities-states-row"><div className="capabilities-states" role="group" aria-label={t("配置状态")}>{(["all", "active", "disabled"] as const).map((value) => <button key={value} aria-pressed={state === value} onClick={() => { setState(value); resetView(); }}><span className="capabilities-state-label">{stateNames[value]}<span>{counts[value]}</span></span></button>)}</div><span className="capabilities-result" role="status">{t("显示 {0} 项", rows.length)}</span></div>
          </div>
          {overlappingStates && <p className="capabilities-hint capabilities-group-note">{t("按 Skill 名称计数；同名 Skill 的不同来源可能分属不同状态。")}</p>}
          <div ref={list} className="capabilities-list">{rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((group, index) => {
            const entry = group.entries[0]!, multiple = group.total > 1;
            const expanded = open === group.id, detail = `${uid}-entry-${index}`;
            const status = capabilityGroupStatus(group.sources);
            const descriptions = new Set(group.sources.map(value => value.description));
            const description = descriptions.size === 1 ? entry.description : t("各来源的说明不同，展开查看详情。");
            return <article className="capability-card" data-status={status} key={group.id}>
              <button type="button" className="capability-summary" data-entry={group.id} aria-expanded={expanded} aria-controls={expanded ? detail : undefined} onClick={() => setOpen(expanded ? "" : group.id)}><strong>{group.name}</strong><span className={`capability-status ${status}`}>{statusNames[status]}</span><ChevronDown className="capability-chevron" size={16} aria-hidden/></button>
              {description && <p className="capability-description">{description}</p>}
              <div className="capability-meta">{multiple ? <><span className="capability-source-count">{group.entries.length === group.total ? t("{0} 个来源", group.total) : t("显示 {0} / {1} 个来源", group.entries.length, group.total)}</span><span>{[...new Set(group.sources.map(source => scopeNames[source.scope]))].join(" · ")}</span></> : <span>{scopeNames[entry.scope]}</span>}{entry.transport && <span>{entry.transport}</span>}</div>
              {expanded && <div id={detail} className={`capability-detail${multiple ? " capability-group-detail" : ""}`}>
                {multiple && <p className="capability-group-intro">{t("同名 Skill 按来源列出；内容可能不同，实际加载状态未确认。")}</p>}
                {group.entries.map((sourceEntry, sourceIndex) => {
                  const sourcePath = `${detail}-source-${sourceIndex}-path`;
                  const hint = multiple ? `${detail}-hint` : `${detail}-source-${sourceIndex}-hint`;
                  return <div className={multiple ? "capability-source" : undefined} key={sourceEntry.id} role={multiple ? "group" : undefined} aria-labelledby={multiple ? sourcePath : undefined}>
                    {multiple && <>
                      <code id={sourcePath} className="capability-source-path">{sourceEntry.source}</code>
                      <div className="capability-source-heading"><span>{scopeNames[sourceEntry.scope]}</span><span className={`capability-status ${sourceEntry.status}`}>{statusNames[sourceEntry.status]}</span></div>
                      {descriptions.size > 1 && sourceEntry.description && <p className="capability-description">{sourceEntry.description}</p>}
                    </>}
                    {!multiple && <p>{meaning(sourceEntry)}</p>}
                    {!multiple && <dl>
                      <div><dt>{t("实际状态")}</dt><dd>{t("未确认")}</dd></div>
                      <div><dt>{t("来源范围")}</dt><dd>{scopeNames[sourceEntry.scope]}</dd></div>
                      {sourceEntry.transport && <div><dt>{t("连接方式")}</dt><dd>{transportNames[sourceEntry.transport]}{sourceEntry.transport !== "unknown" && ` · ${sourceEntry.transport}`}</dd></div>}
                      <div><dt>{t("配置来源")}</dt><dd><code>{sourceEntry.source}</code></dd></div>
                    </dl>}
                    {(!multiple || canHelp) && <div className="capability-next">
                      {!multiple && <p><strong>{t("建议下一步")}</strong>{nextStep(sourceEntry)}</p>}
                      {canHelp ? <><button className="capabilities-action" aria-describedby={multiple ? `${sourcePath} ${hint}` : hint} onClick={() => ask({ kind: sourceEntry.kind, name: sourceEntry.name, source: sourceEntry.source, intent: "check" })}><MessageSquare size={15} aria-hidden/>{t("让 Bot 检查")}</button>{!multiple && <p id={hint} className="capabilities-hint">{helpHint}</p>}</>
                        : !multiple && <p className="capabilities-hint">{manualHint}</p>}
                    </div>}
                  </div>;
                })}
                {multiple && <p id={`${detail}-hint`} className="capabilities-hint capability-group-hint">{canHelp ? t("每次只检查一个来源；消息由你确认发送。") : manualHint}</p>}
              </div>}
            </article>;
          })}</div>
          {!rows.length && <div className="capabilities-empty"><p>{filtered ? t("没有匹配的条目，试试调整筛选条件。") : t("本次未发现条目。可在“说明与建议”中查看读取范围。")}</p>{filtered && <button className="capabilities-action" onClick={clearFilters}>{t("清除筛选")}</button>}</div>}
          {rows.length > PAGE_SIZE && <nav className="capabilities-pages" aria-label={t("分页")}><button className="capabilities-action" aria-disabled={currentPage === 0} onClick={() => turnPage(currentPage - 1)}>{t("上一页")}</button><span>{currentPage + 1} / {lastPage + 1}</span><button className="capabilities-action" aria-disabled={currentPage === lastPage} onClick={() => turnPage(currentPage + 1)}>{t("下一页")}</button></nav>}
        </>}
      </>}
    </div>
  </section></div>;
}
