import { useSyncExternalStore } from "react";
import { t, useLocale } from "./i18n.js";

// One shared page-visibility read: a hidden window pauses the breathing halo
// instead of animating where nobody can see it.
const subscribe = (notify: () => void) => { document.addEventListener("visibilitychange", notify); return () => document.removeEventListener("visibilitychange", notify); };
const pageHidden = () => document.visibilityState === "hidden";

/** The header's inline IM status ("正在回复"). `names` lists the Bots whose replies
 * are actually streaming while connected; empty means idle and renders no text,
 * never a "done" claim. Groups name the Bot after the state, so a narrow header
 * ellipsizes the name, not the state. The polite region stays mounted (visually
 * hidden while empty, without the status role) so each real change is announced once. */
export function ReplyActivity({ names, group, offline = false }: { names: string[]; group: boolean; offline?: boolean }) {
  useLocale();
  const paused = useSyncExternalStore(subscribe, pageHidden);
  const waiting = offline && !names.length;
  const label = !names.length ? waiting ? t("Bot 离线") : "" : names.length > 1 ? t("{0} 个 Bot 正在回复", names.length) : group && names[0] ? t("正在回复 · {0}", names[0]) : t("正在回复");
  return <span className="header-activity" data-offline={waiting || undefined} title={waiting ? t("离线 Bot 会在上线后处理消息。") : label || undefined} aria-live="polite">{label ? <><i className="activity-dot" data-paused={paused || waiting || undefined} aria-hidden="true"/><span>{label}</span></> : null}</span>;
}
