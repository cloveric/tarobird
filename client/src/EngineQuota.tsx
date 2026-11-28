import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Info, LoaderCircle, RefreshCw } from "lucide-react";
import { quotaReadingExpired, type QuotaAuthMode, type QuotaConstraint, type QuotaEngine, type QuotaReason, type QuotaScope, type QuotaSnapshot, type QuotaWindow } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "./connection.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { SettingsGroupHeading } from "./SettingsParts.js";
import { MAX_CONCURRENT_QUOTA_REFRESH, useEngineQuota } from "./use-engine-quota.js";
import { formatQuotaWindowLabel, formatResetCountdown, groupQuotaScopesByAccount, quotaRefreshAfter, quotaScopeCanRead, shouldShowQuotaPoolHeading } from "./quota-ui.js";
import { QUOTA_SHOWN_FOR_MS, quotaReadingAgeLabel, usageTone } from "./usage-readings.js";
import { localeIntlTag, t, useLocale } from "./i18n.js";
import "./engine-quota.css";

const engines: Record<QuotaEngine, string> = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  pi: "Pi",
  omp: "oh-my-pi (omp)",
};

function reasonText(reason: QuotaReason | undefined, engine: QuotaEngine, authMode?: QuotaAuthMode): string {
  switch (reason) {
    case "not_adapted": return t("此引擎尚未接入原生额度。");
    case "not_loaded": return t("尚未读取原生额度，可点击刷新。");
    case "native_unverified": return t("此引擎的原生额度接口尚未验证。");
    case "mode_not_supported":
      if (engine === "kimi") {
        return authMode === "api_key"
          ? t("当前仅配置了 API Key，未登录 Kimi For Coding 套餐账号，无套餐额度可读取。")
          : t("当前账号不是 Kimi For Coding 套餐账号（服务端返回 404），不提供编程套餐额度。");
      }
      if (engine === "pi") return t("当前供应商不提供可读取的账号额度（Pi 仅统计本会话 token 与费用）。");
      return t("此授权方式不提供可读取的原生额度。");
    case "no_passive_event": return t("尚未收到原生额度状态，仅在正常使用中被动更新。");
    case "login_required": return t("请先在运行主机上完成引擎登录，再刷新。");
    case "auth_changed": return t("授权信息已变化，旧额度已清除。请核对后再次刷新。");
    case "scope_unverifiable": return engine === "claude"
      ? t("Claude Code 的凭据来源无法由公开接口核实（例如 macOS 钥匙串登录），为避免显示其他账号的额度，不展示被动收到的读数。")
      : t("无法从运行主机的凭据文件确认当前账号（例如登录保存在系统钥匙串），读数不会保留；刷新时由引擎原生接口当场核对一次，只有原生回包能把当前用户、前后两次的工作区和这次用量对应到同一账号时才展示读数。");
    case "offline": return t("Bot 当前离线，连接恢复后重新读取列表。");
    case "timeout": return t("读取原生额度超时，可稍后再刷新。");
    case "cancelled": return t("本次读取已取消，可重新刷新。");
    case "rate_limited": return t("原生服务暂时限制读取，请等待后再刷新。");
    case "invalid_response": return t("原生额度数据无法确认，未将缺失数据当作零。");
    case "cli_unavailable": return t("主机上的引擎程序不可用，请检查后再刷新。");
    case "native_error": return t("暂时无法读取原生额度，可稍后再刷新。");
    case "host_upgrade_required": return t("请更新主机与 Bot 运行程序以读取额度。");
    default: return "";
  }
}

// Verified against each engine's own CLI help/changelog and official docs; shown when no current reading exists.
function helpText(help: QuotaSnapshot["help"]): string {
  switch (help) {
    case "codex_usage": return t("官方查看：在运行主机的 Codex CLI 中以 ChatGPT 登录后输入 /usage，可查看账号额度和重置时间。");
    case "claude_usage": return t("官方查看：订阅登录时，在 Claude Code 中输入 /usage，或打开 claude.ai/settings/usage。");
    case "antigravity_usage": return t("官方查看：在 Antigravity CLI 中输入 /usage 或 /quota，AI credits 用 /credits；GEMINI_API_KEY 没有账号额度，请在 Google AI Studio 查看该 Key 的用量。");
    case "gemini_api_usage": return t("官方查看：GEMINI_API_KEY 没有账号额度，请在 Google AI Studio 查看该 Key 的用量。");
    case "kimi_usage": return t("官方查看：在 Kimi Code CLI 交互界面输入 /usage 查看套餐额度；ACP 会话里的 /usage 只显示本会话 token。");
    case "deepseek_balance": return t("官方查看：使用 DeepSeek 官方 API 时，登录 DeepSeek 开放平台（platform.deepseek.com）查看账户余额；其他供应商请在其控制台查看。");
    default: return "";
  }
}

function constraintText(constraint: QuotaConstraint): string {
  switch (constraint.code) {
    case "ordinary_usage_blocked": return t("常规使用受限");
    case "spend_control": return t("已触发原生消费限制");
    case "credits_depleted": return t("原生 credits 已耗尽");
    case "overage_disabled": return t("超额使用未启用");
    default: return t("存在其他原生限制");
  }
}

const expired = (value: { expiresAt: string; resetsAt?: string }, now: number) =>
  Date.parse(value.expiresAt) <= now || (!!value.resetsAt && Date.parse(value.resetsAt) <= now);

function WindowQuota({
  window,
  siblings,
  stale,
  now,
  formatTime,
  formatNumber,
}: {
  window: QuotaWindow;
  siblings: readonly QuotaWindow[];
  stale: boolean;
  now: number;
  formatTime: (value: string) => string;
  formatNumber: (value: number) => string;
}) {
  const old = stale || expired(window, now);
  const label = formatQuotaWindowLabel(window, siblings);
  const percent = window.metric === "percent" ? window.usedPercent : undefined;
  const remaining = percent === undefined ? undefined : Math.max(0, 100 - percent);
  const tone = remaining === undefined ? undefined : usageTone(remaining);
  const value = percent === undefined
    ? t("尚无数据")
    : percent > 100
      ? t("超出 {0}%", formatNumber(percent - 100))
      : t("剩余 {0}%", formatNumber(100 - percent));
  // Only the number is shown; the full sentence (with "上次读数" for an old reading) stays for screen readers.
  const shown = percent === undefined ? value : percent > 100 ? value : `${formatNumber(100 - percent)}%`;
  const spoken = old && percent !== undefined ? t("上次读数：{0}", value) : value;
  const countdown = window.resetsAt ? formatResetCountdown(window.resetsAt, now) : undefined;
  const exactTime = window.resetsAt ? formatTime(window.resetsAt) : undefined;

  return <div className="quota-window" data-stale={old || undefined}>
    <span className="quota-window-name">{label}</span>
    {percent !== undefined && <div
      className="quota-meter"
      role="meter"
      aria-label={t("{0} 剩余额度", label)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.max(0, Math.min(100, Math.round(remaining ?? 0)))}
      aria-valuetext={value}
    >
      <span data-tone={old ? undefined : tone} style={{ width: `${Math.max(0, Math.min(100, remaining ?? 0))}%` }}/>
    </div>}
    <strong className="quota-window-primary" data-tone={old ? undefined : tone}>
      {shown === spoken ? shown : <><span aria-hidden="true">{shown}</span><span className="quota-sr-only">{spoken}</span></>}
    </strong>
    <div className="quota-window-meta">
      {countdown && window.resetsAt && <time dateTime={window.resetsAt} title={exactTime} className="quota-reset-countdown">
        {countdown.text}
      </time>}
      {countdown && !countdown.expired && exactTime && <span className="quota-reset-exact">{exactTime}</span>}
    </div>
  </div>;
}

type OverviewRow = { key: string; name: string; engine: QuotaEngine; scope: QuotaScope; left: number; window: string; resetsAt?: string };
/** One row per Bot with its tightest percent window, least left first; Bots without one are only named. */
function overviewRows(scopes: readonly QuotaScope[], labels: ReadonlyMap<string, string>) {
  const rows: OverviewRow[] = [], unread: { scope: QuotaScope; names: string[] }[] = [], login: string[] = [], unsupported: string[] = [], nonPercent: string[] = [];
  for (const scope of scopes) {
    let best: { left: number; window: string; resetsAt?: string } | undefined;
    for (const pool of scope.pools) for (const window of pool.windows) {
      if (window.metric !== "percent" || window.usedPercent === undefined) continue;
      const left = Math.max(0, Math.min(100, 100 - window.usedPercent));
      if (best && left >= best.left) continue;
      const pooled = shouldShowQuotaPoolHeading(scope.engine, pool.label, scope.pools.length) ? `${pool.label} · ` : "";
      best = { left, window: pooled + formatQuotaWindowLabel(window, pool.windows), resetsAt: window.resetsAt };
    }
    // The Host sends one scope per Bot. botIds also contains every verified account peer.
    const name = labels.get(scope.id) ?? scope.label;
    if (best) rows.push({ key: scope.id, name, engine: scope.engine, scope, ...best });
    else if (scope.state === "login_required") login.push(name);
    else if (scope.state === "unsupported" || scope.capability.mode === "unsupported") unsupported.push(name);
    else if (scope.state === "ready" || scope.state === "stale") nonPercent.push(name);
    else unread.push({ scope, names: [name] });
  }
  rows.sort((a, b) => a.left - b.left || a.name.localeCompare(b.name));
  return { rows, unread, login, unsupported, nonPercent };
}

export function EngineQuota({ connection, active }: { connection: HubConnection; active: boolean }) {
  const locale = useLocale(), host = useContext(RuntimeHostContext);
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const owner = state.user?.role === "owner" && !connection.isReadOnly, online = state.status === "online", supported = state.engineQuotaAvailable === true, unsupported = state.engineQuotaAvailable === false;
  const quota = useEngineQuota(connection, { userId: state.user?.id, owner, online, supported, unsupported, active });
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!active || !quota.visible) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, quota.visible]);

  const now = clock + (state.serverTimeOffset ?? 0);
  const formatTime = (value: string) => new Intl.DateTimeFormat(localeIntlTag(locale), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  // Whole percents read best; keep one decimal only below 1%.
  const formatNumber = (value: number) => new Intl.NumberFormat(localeIntlTag(locale), { maximumFractionDigits: value > 0 && value < 1 ? 1 : 0 }).format(value);
  if (!owner) return null;

  const botLabels = new Map(state.bots.map(bot => [bot.id, bot.name]));
  const cards = quota.directory ? groupQuotaScopesByAccount(quota.directory.scopes, { now, botLabels }) : [];
  const overview = quota.directory ? overviewRows(quota.directory.scopes, botLabels) : undefined;
  const cardOf = new Map(cards.flatMap((card, index) => card.scopes.map(item => [item.id, index] as const)));
  const jumpTo = (scope: QuotaScope) => { const index = cardOf.get(scope.id); if (index !== undefined) document.getElementById(`quota-card-${index}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); };
  const cardScopes = (scope: QuotaScope) => cards[cardOf.get(scope.id) ?? -1]?.scopes ?? [scope];
  const rowStale = (scope: QuotaScope) => !online || !!quota.error || quota.cachedScopeIds.has(scope.id)
    || cardScopes(scope).some(member => !!quota.errors[member.id])
    || scope.state === "stale" || scope.state === "offline" || quotaReadingExpired(scope, now)
    || (!!scope.observedAt && now - Date.parse(scope.observedAt) >= QUOTA_SHOWN_FOR_MS);
  const oldest = overview?.rows.reduce<string | undefined>((value, row) => row.scope.observedAt && (!value || Date.parse(row.scope.observedAt) < Date.parse(value)) ? row.scope.observedAt : value, undefined);
  const unreadTargets = overview?.unread.map(item => item.scope).filter(scope => {
    const members = cardScopes(scope);
    if (members.some(member => quota.waitingLate.includes(member.id))) return false;
    const next = quotaRefreshAfter(members);
    return scope.capability.mode === "active" && quotaScopeCanRead(scope) && (!next || Date.parse(next) <= now);
  }) ?? [];
  const readUnread = async () => {
    const read = new Set<string>();
    for (const scope of unreadTargets) {
      if (read.has(scope.id)) continue;
      const ids = cardScopes(scope).map(member => member.id);
      ids.forEach(id => read.add(id));
      await quota.refresh(scope, ids, true);
    }
  };

  return <div className="engine-quota">
    <SettingsGroupHeading scope="host" host={host}>{t("原生模型额度")}</SettingsGroupHeading>
    <p className="settings-note muted">{t("按账号展示原生额度；确认同一账号的多个 Bot 会合并展示，无法确认时分开显示。这里不是消息用量统计。")}</p>
    {!online && <p className="quota-notice" role="status">{t("连接已断开，仅保留上次读数。恢复后重新核对。")}</p>}
    {unsupported ? <p role="status">{t("请更新主机以查看模型额度。")}</p> : <>
      <div className="quota-toolbar">
        <button type="button" className="secondary" title={t("打开页面自动读取缓存；单卡刷新不会发送模型消息。")} disabled={!online || !supported || quota.loading || quota.busy.length > 0} onClick={() => void quota.readDirectory()}>
          <RefreshCw size={14} aria-hidden="true"/>{t("重新读取列表")}
        </button>
        <small>{oldest ? t("上次读数 · {0}", quotaReadingAgeLabel(oldest, now, locale)) : t("打开页面自动读取缓存；单卡刷新不会发送模型消息。")}</small>
      </div>
      {quota.loading && <p role="status"><LoaderCircle size={14} className="spin" aria-hidden="true"/> {t("正在读取…")}</p>}
      {quota.error && <p className="quota-notice" role="alert">{quota.error === "permission" ? t("额度查看权限已变化，旧数据已清除。请重新连接后核对。") : quota.error === "upgrade" ? t("请更新主机以查看模型额度。") : t("未能读取额度列表，请重新读取。保留的读数不代表当前余额。")}</p>}
      {quota.notice === "changed" && <p className="quota-notice" role="status">{t("Bot 或授权配置已变化，已重新读取列表。请核对后再刷新。")}</p>}
      {quota.directory?.truncated && <p className="quota-notice" role="status">{t("主机只返回了部分 Bot 的额度状态。")}</p>}
      {quota.directory && !cards.length && <p role="status">{t("当前主机还没有可展示额度的 Bot。")}</p>}
      {overview && (overview.rows.length > 0 || overview.unread.length + overview.login.length + overview.unsupported.length + overview.nonPercent.length > 0) && <section className="quota-overview" aria-label={t("全部 Bot 的额度")}>
        <div className="quota-overview-cols" aria-hidden="true"><span>Bot</span><span>{t("最紧的窗口")}</span><span/><span>{t("剩余")}</span><span>{t("重置")}</span></div>
        {overview.rows.map(row => {
          const old = rowStale(row.scope), tone = old ? undefined : usageTone(row.left);
          const label = t("{0}：{1}，剩余 {2}%", row.name, row.window, formatNumber(row.left));
          return <button type="button" key={row.key} className="quota-overview-row" data-stale={old || undefined} onClick={() => jumpTo(row.scope)}
            aria-label={old ? t("上次读数：{0}", label) : label}>
            <span className="quota-overview-bot"><strong>{row.name}</strong><small>{engines[row.engine]}</small></span>
            <span className="quota-overview-window">{old && <>{t("待更新")} · </>}{row.window}</span>
            <span className="quota-meter" aria-hidden="true"><span data-tone={tone} style={{ width: `${row.left}%` }}/></span>
            <span className="quota-overview-pct" data-tone={tone}>{formatNumber(row.left)}%</span>
            <span className="quota-overview-reset">{row.resetsAt ? formatResetCountdown(row.resetsAt, now).text : ""}</span>
          </button>;
        })}
        {overview.unread.length + overview.login.length + overview.unsupported.length + overview.nonPercent.length > 0 && <div className="quota-overview-row is-other">
          <span>{[
            overview.nonPercent.length ? t("{0} 没有百分比窗口", overview.nonPercent.join("、")) : "",
            overview.unread.length ? t("{0} 还没读到", overview.unread.flatMap(item => item.names).join("、")) : "",
            overview.login.length ? t("{0} 需要登录", overview.login.join("、")) : "",
            overview.unsupported.length ? t("{0} 不支持", overview.unsupported.join("、")) : "",
          ].filter(Boolean).join(" · ")}</span>
          {unreadTargets.length > 0 && <button type="button" className="secondary" disabled={!online || !supported || quota.loading || quota.busy.length > 0} onClick={() => void readUnread()}>{t("读取")}</button>}
        </div>}
      </section>}
      <div className="quota-list">{cards.map((card, cardIndex) => {
        const scope = card.primary;
        const cardError = card.scopes.some(item => !!quota.errors[item.id]);
        // Gateway/window expiry (60s TTL or resets) marks a reading "待更新"; genuinely old (>= 30m), cached, or offline readings show "旧读数 · <age>".
        // The card shows its primary reading, so "old" is about that reading.
        const fromCache = quota.cachedScopeIds.has(scope.id);
        const observedAge = scope.observedAt ? Math.max(0, now - Date.parse(scope.observedAt)) : 0;
        const oldReading = !!scope.observedAt && (fromCache || !online || scope.state === "offline" || observedAge >= QUOTA_SHOWN_FOR_MS);
        const stale = !online || !!quota.error || cardError || fromCache || scope.state === "stale" || (scope.state === "offline" && !!scope.observedAt) || quotaReadingExpired(scope, now) || (!!scope.observedAt && observedAge >= QUOTA_SHOWN_FOR_MS);
        const ageLabel = scope.observedAt ? quotaReadingAgeLabel(scope.observedAt, now, locale) : "";
        const waiting = card.scopes.some(item => quota.waitingLate.includes(item.id));
        const busy = waiting || card.scopes.some(item => quota.busy.includes(item.id));
        const status = busy
          ? t("正在读取…")
          : oldReading
            ? t("旧读数 · {0}", ageLabel)
            : stale
              ? t("待更新")
              : ({ ready: t("已读取"), stale: t("待更新"), unknown: t("尚无数据"), login_required: t("需要登录"), offline: t("离线"), unavailable: t("暂不可用"), unsupported: t("暂不支持") })[scope.state];
        const passive = scope.capability.mode === "passive";
        const canRead = quotaScopeCanRead(scope);
        const nextRefreshAt = quotaRefreshAfter(card.scopes);
        const cooling = !!nextRefreshAt && Date.parse(nextRefreshAt) > now;
        const reason = waiting ? t("正在等待引擎返回额度，结果到达后会自动更新。") : reasonText(scope.reason ?? scope.capability.reason, scope.engine, scope.authMode);
        const help = (scope.state === "ready" && !stale) || waiting ? "" : helpText(scope.help);
        const auth = ({ subscription: t("订阅授权"), api_key: "API Key", adc: t("应用默认凭据"), other: t("其他授权"), unknown: t("授权方式未确认") })[scope.authMode as QuotaAuthMode];
        const constraints = [...scope.constraints, ...scope.pools.flatMap(pool => pool.constraints)];
        const availabilityNotice = scope.availability === "blocked" ? t("原生服务报告使用受限；窗口剩余量不代表可以继续请求。") : scope.availability === "warning" ? t("原生服务报告额度预警。") : "";
        const regionLabel = card.merged
          ? `${engines[card.engine]} · ${card.bots.map(bot => bot.label).join(", ")}`
          : `${scope.label} · ${engines[scope.engine]}`;

        return <section className="quota-card" id={`quota-card-${cardIndex}`} key={card.key} aria-label={regionLabel} aria-busy={busy || undefined}>
          <header className="quota-card-heading">
            <div className="quota-card-identity">
              <div className="quota-card-title-row">
                <h4>{engines[card.engine]}</h4>
                {card.merged && <span className="quota-account-badge">{t("{0} 个 Bot 共用同一账号", card.bots.length)}</span>}
                {card.unconfirmedPeer && <span className="quota-separate-note" title={t("未合并：无法确认此 Bot 与其他 {0} Bot 使用同一账号，已分开展示。", engines[card.engine])}><Info size={12} aria-hidden="true"/>{t("未合并")}</span>}
              </div>
              <div className="quota-bot-chips">
                {card.bots.map(bot => <span className="quota-bot-chip" key={bot.id}>{bot.label}</span>)}
              </div>
            </div>
            <span className={`quota-state${busy ? " is-reading" : stale ? " is-stale" : scope.state === "ready" ? " is-ready" : ""}`}>
              {busy && <LoaderCircle size={12} className="spin" aria-hidden="true"/>}
              {status}
            </span>
          </header>

          {availabilityNotice && <p className="quota-notice">{stale ? t("上次读数：{0}", availabilityNotice) : availabilityNotice}</p>}
          {constraints.length > 0 && <ul className="quota-constraints">{constraints.map((value, index) => {
            const c = value.resetsAt ? formatResetCountdown(value.resetsAt, now) : undefined;
            const exact = value.resetsAt ? formatTime(value.resetsAt) : undefined;
            return <li key={`${value.code}:${index}`}>
              {constraintText(value)}
              {c && <span title={exact}> · {c.text}{!c.expired && exact ? ` (${exact})` : ""}</span>}
            </li>;
          })}</ul>}

          {scope.pools.map(pool => <div className="quota-pool" key={pool.id}>
            {shouldShowQuotaPoolHeading(scope.engine, pool.label, scope.pools.length) && <h5>{pool.label}</h5>}
            {pool.models?.length ? <p className="quota-pool-models muted" title={pool.models.join(" · ")}>{pool.models.length === 1 ? pool.models[0] : t("{0} 个模型", pool.models.length)}</p> : null}
            <div className="quota-windows">
              {pool.windows.map(window => <WindowQuota key={window.id} window={window} siblings={pool.windows} stale={stale} now={now} formatTime={formatTime} formatNumber={formatNumber}/>)}
            </div>
            {pool.balances.map(balance => <p className="quota-balance" key={balance.id}>
              <span>{balance.kind === "currency" ? (balance.id === "top_up" ? t("加油包余额") : balance.id.startsWith("bonus_") ? t("赠送余额") : balance.id.startsWith("recharge_") ? t("充值余额") : t("账户余额")) : t("原生 credits")}</span>
              <strong>{balance.unlimited ? t("不限额") : balance.amount === null ? t("尚无数据") : `${balance.amount} ${balance.unit}`}</strong>
              {(stale || expired(balance, now)) && <small>{t("上次读数，需重新读取")}</small>}
            </p>)}
          </div>)}

          {reason && <p className="quota-reason">{reason}</p>}
          {help && <p className="quota-help">{help}</p>}
          {passive && <p className="quota-secondary-note muted">{t("仅显示正常使用中收到的状态；读取不会触发新对话。")}</p>}
          {cardError && <p className="quota-notice" role="alert">{t("本次刷新失败，可重试。保留的读数不代表当前余额。")}</p>}

          <footer className="quota-card-footer">
            <div className="quota-card-meta">
              <span>{auth}</span>
              {scope.observedAt && <time dateTime={scope.observedAt}>{t("读取于 {0}", formatTime(scope.observedAt))}</time>}
              {cooling && nextRefreshAt && <time dateTime={nextRefreshAt}>{t("{0} 后可再刷新", formatTime(nextRefreshAt))}</time>}
            </div>
            {canRead && <button
              type="button"
              className="secondary"
              disabled={!online || !supported || quota.loading || quota.busy.length >= MAX_CONCURRENT_QUOTA_REFRESH || busy || cooling || quota.error === "permission"}
              onClick={() => void quota.refresh(scope, card.scopes.map(item => item.id))}
            >
              {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true"/> : <RefreshCw size={14} aria-hidden="true"/>}
              {busy ? t("正在读取…") : passive ? t("读取已知状态") : t("刷新")}
            </button>}
          </footer>
        </section>;
      })}</div>
      {quota.directory && <p className="quota-local-time muted">{t("时间按当前设备时区显示；到达重置时间不会自动填满额度。")}</p>}
    </>}
  </div>;
}
