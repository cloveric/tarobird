import { useEffect, useId, useRef, useState } from "react";
import { DesktopMenu, DesktopMenuPortalContext } from "./DesktopMenu.js";
import { localeIntlTag, t, useLocale, type Locale } from "./i18n.js";
import { formatQuotaWindowLabel, formatResetCountdown } from "./quota-ui.js";
import { quotaReadingAgeLabel, shortTokens, usageTone, type ContextView, type QuotaBlock, type QuotaView } from "./usage-readings.js";
import "./usage-indicators.css";

/** Context: a ring whose drawn part is what is left of the window. */
export function ContextRing({ left, size = 16, stroke = 2.4 }: { left: number; size?: number; stroke?: number }) {
  const radius = (size - stroke) / 2, around = 2 * Math.PI * radius, centre = size / 2;
  return <svg className="usage-ring" data-tone={usageTone(left)} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
    <circle className="usage-ring-track" cx={centre} cy={centre} r={radius} fill="none" strokeWidth={stroke}/>
    {left > 0 && <circle className="usage-ring-left" cx={centre} cy={centre} r={radius} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${around * left / 100} ${around}`}/>}
  </svg>;
}
/** Quota: a battery whose charge is what is left of the tightest window.
 * When `stale` is true, the battery is greyed out to show it is an older cached reading. */
export function QuotaBattery({ left, height = 16, stale = false }: { left: number; height?: number; stale?: boolean }) {
  return <svg className="usage-battery" data-tone={usageTone(left)} data-stale={stale ? "true" : undefined} width={height * 1.5} height={height} viewBox="0 0 24 16" fill="none" aria-hidden="true">
    <rect className="usage-battery-body" x="1.2" y="2.2" width="18.6" height="11.6" rx="3.2" strokeWidth="1.6"/>
    <path className="usage-battery-body" d="M22.4 6.2v3.6" strokeWidth="1.8" strokeLinecap="round"/>
    <rect className="usage-battery-left" x="4" y="5" width={Math.max(1.2, 13 * left / 100)} height="6" rx="1.4"/>
  </svg>;
}

function clock(value: string, locale: Locale, now = new Date()): string {
  const date = new Date(value), sameDay = date.toDateString() === now.toDateString();
  const cjk = locale === "zh" || locale === "ja";
  const time: Intl.DateTimeFormatOptions = cjk ? { hour: "2-digit", minute: "2-digit", hour12: false } : { hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat(localeIntlTag(locale), sameDay ? time : { month: cjk ? "long" : "short", day: "numeric", ...time }).format(date);
}
// The same wording as the quota page uses for these engine limits.
function blockText(code: QuotaBlock): string {
  switch (code) {
    case "ordinary_usage_blocked": return t("常规使用受限");
    case "spend_control": return t("已触发原生消费限制");
    case "credits_depleted": return t("原生 credits 已耗尽");
    default: return t("存在其他原生限制");
  }
}
function Bar({ left, label, stale = false }: { left: number; label: string; stale?: boolean }) {
  return <div className="usage-bar" data-stale={stale ? "true" : undefined} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left}><i data-tone={stale ? undefined : usageTone(left)} style={{ width: `${left}%` }}/></div>;
}

/** The numbers behind the two symbols. Every percentage is what is left. */
export function UsageDetails({ context, quota, serverTimeOffset }: { context?: ContextView; quota?: QuotaView; serverTimeOffset?: number }) {
  const locale = useLocale();
  const [nowClock, setNowClock] = useState(Date.now);
  const hasQuota = Boolean(quota);
  useEffect(() => {
    if (!hasQuota) return;
    setNowClock(Date.now());
    const timer = setInterval(() => setNowClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasQuota]);
  const nowMs = nowClock + (serverTimeOffset ?? 0);
  const nowDate = new Date(nowMs);
  const pools = quota ? [...new Set(quota.windows.map(window => window.pool))] : [];
  const ageLabel = quota ? quotaReadingAgeLabel(quota.observedAt, Date.now(), locale) : "";
  return <div className="usage-details">
    {context && <section aria-label={t("上下文")}>
      <h4><ContextRing left={context.left} size={14} stroke={2.2}/>{t("上下文")}</h4>
      <div className="usage-row"><b data-tone={usageTone(context.left)}>{context.left}%</b><span>{t("已用 {0} / {1}", shortTokens(context.usedTokens), shortTokens(context.windowTokens))}</span></div>
      <Bar left={context.left} label={t("上下文可用")}/>
      {context.compactAt !== undefined && <p className="usage-note">{t("用到约 {0}% 时自动压缩", context.compactAt)}</p>}
    </section>}
    {quota?.stale && <p className="usage-stale-banner" role="status">{t("上次读数（{0}），正在后台重试更新", ageLabel)}</p>}
    {quota && pools.map(pool => {
      const windows = quota.windows.filter(window => window.pool === pool);
      return <section key={pool} aria-label={t("额度 · {0}", pool)} data-stale={quota.stale ? "true" : undefined}>
        <h4><QuotaBattery left={Math.min(...windows.map(window => window.left))} stale={quota.stale} height={13}/>{t("额度 · {0}", pool)}</h4>
        {windows.map(window => {
          const name = formatQuotaWindowLabel(window, windows);
          const countdown = window.resetsAt ? formatResetCountdown(window.resetsAt, nowMs) : undefined;
          const exact = window.resetsAt ? clock(window.resetsAt, locale, nowDate) : undefined;
          return <div className="usage-window" key={window.id}>
            <div className="usage-row">
              <span className="usage-window-label">{name}</span>
              <b data-tone={quota.stale ? undefined : usageTone(window.left)}>{window.left}%</b>
            </div>
            <Bar left={window.left} stale={quota.stale} label={t("{0} 额度可用", name)}/>
            {countdown && <div className="usage-reset-row">
              <strong title={exact}>{countdown.text}</strong>
              {!countdown.expired && exact && <span>{exact}</span>}
            </div>}
          </div>;
        })}
      </section>;
    })}
    {quota && quota.blocked.length > 0 && <section aria-label={t("额度")}>
      {!quota.windows.length && <h4><QuotaBattery left={0} stale={quota.stale} height={13}/>{t("额度")}</h4>}
      {quota.blocked.map(code => <p className="usage-note usage-blocked" role="status" key={code}>{blockText(code)}</p>)}
    </section>}
    {quota && <p className="usage-note usage-read-at">{quota.stale ? t("{0} 读取（{1}）", clock(quota.observedAt, locale), ageLabel) : t("{0} 读取", clock(quota.observedAt, locale, nowDate))}</p>}
  </div>;
}

/** Desktop composer: the ring and the battery, each with its number and each only when its value can be read. */
export function UsageIndicators({ context, quota, serverTimeOffset, onOpen }: { context?: ContextView; quota?: QuotaView; serverTimeOffset?: number; onOpen?: () => void }) {
  const locale = useLocale();
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null), id = useId();
  const shown = !!context || !!quota;
  // Details that lost both readings are closed for good; they do not come back by themselves with the next reading.
  useEffect(() => { if (!shown) setOpen(false); }, [shown]);
  if (!shown) return null;
  const ageLabel = quota ? quotaReadingAgeLabel(quota.observedAt, Date.now(), locale) : "";
  const quotaLabel = quota
    ? quota.stale
      ? t("额度可用 {0}%（旧读数 · {1}）", quota.left, ageLabel)
      : t("额度可用 {0}%", quota.left)
    : undefined;
  const label = [context && t("上下文可用 {0}%", context.left), quotaLabel].filter(Boolean).join(t("，"));
  return <>
    <button ref={trigger} type="button" className="usage-indicators" aria-label={label} title={label} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { if (!open) onOpen?.(); setOpen(value => !value); }}>
      {context && <span className="usage-pair" data-tone={usageTone(context.left)} data-usage="context"><ContextRing left={context.left}/><span>{context.left}%</span></span>}
      {quota && <span className="usage-pair" data-tone={usageTone(quota.left)} data-stale={quota.stale ? "true" : undefined} data-usage="quota"><QuotaBattery left={quota.left} stale={quota.stale}/><span>{quota.left}%</span></span>}
    </button>
    {open && <DesktopMenuPortalContext.Provider value={true}>
      <DesktopMenu id={id} label={t("上下文与额度")} open close={() => setOpen(false)} trigger={trigger} placement="up-end" className="usage-panel"><UsageDetails context={context} quota={quota} serverTimeOffset={serverTimeOffset}/></DesktopMenu>
    </DesktopMenuPortalContext.Provider>}
  </>;
}

/** What the phone header's battery says to a screen reader and tooltip: carries percentage and old-reading age when stale. */
export const quotaMarkLabel = (left: number, stale = false, observedAt?: string, locale: Locale = "zh"): string => {
  if (stale && observedAt) {
    return t("额度可用 {0}%（旧读数 · {1}）", left, quotaReadingAgeLabel(observedAt, Date.now(), locale));
  }
  return usageTone(left) === "empty" ? t("额度快用完了，查看额度") : t("额度可用 {0}%", left);
};
/** Phone header: the battery alone, whenever the quota can be read. Its charge is what is left; there is no number. */
export function QuotaMark({ left, stale = false, observedAt, onOpen }: { left: number; stale?: boolean; observedAt?: string; onOpen: () => void }) {
  const locale = useLocale();
  const label = quotaMarkLabel(left, stale, observedAt, locale);
  return <button type="button" className="quota-mark" data-stale={stale ? "true" : undefined} aria-label={label} title={label} onClick={onOpen}><QuotaBattery left={left} stale={stale} height={12}/></button>;
}
