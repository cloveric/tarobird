import { createContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AgentSignal, AgentState } from "./agent-state.js";
import type { AvatarFace } from "./avatar-face.js";
import { useAvatarMotion } from "./avatar-motion.js";
import { t } from "./i18n.js";
import "./agent-avatar.css";
import { mergeAgentSignals, useTicketSignal } from "./dispatcher-signal.js";
import type { HubConnection } from "./connection.js";

/** Read by the row's own Avatar to add an animated face; nested collage
 * members reset it so only the row identity animates. */
export const AgentAvatarContext = createContext<{ state: Exclude<AgentState, "idle">; enter?: "done" | "failed" } | undefined>(undefined);
/** True where an Avatar must not draw its own dispatcher star: list rows draw
 * it beside the animated picture, and group collages never show it. */
export const RoleStarSuppressed = createContext(false);

/** Static gold star at the avatar's lower left (dispatcher Bots). */
export function RoleStar() {
  return <i className="role-star" data-role="dispatcher" aria-hidden="true" title={t("幕僚长")}><svg viewBox="-10.4 -10.8 20.8 21.6"><path d="M0-10 2.7-3.72 9.51-3.09 4.37 1.42 5.88 8.09 0 4.6-5.88 8.09-4.37 1.42-9.51-3.09-2.7-3.72Z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg></i>;
}

// A stable row offset also separates simultaneous completions. Reply timestamps
// cancel out their different animation start times and can synchronize live rows.
function restingPhase(id: string) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${-((hash >>> 0) % 2400)}ms`;
}

/** A list avatar wrapper. Working and waiting states loop; completion and
 * failure entrance gestures play once only when observed live. Unread done
 * rows then hop gently; both finished states keep their badge and expression.
 * A cold start or remount never replays the entrance gesture. */
export function AgentAvatar({ signal: own, size, className, dispatcher = false, tickets, children }: { signal: AgentSignal; size: number; className: string; dispatcher?: boolean; tickets?: { connection: HubConnection; botId: string }; children: ReactNode }) {
  // A dispatcher's row also shows its tickets, which run in hidden conversations.
  const signal = mergeAgentSignals(own, useTicketSignal(tickets?.connection, tickets?.botId));
  const animated = useAvatarMotion();
  const rowId = useId();
  const mountedAt = useRef(performance.now()), previous = useRef(signal.state);
  const [enter, setEnter] = useState<"done" | "failed">();
  useLayoutEffect(() => {
    const before = previous.current; previous.current = signal.state;
    if (!animated) { setEnter(undefined); return; }
    if (before === signal.state) return;
    const live = performance.now() - mountedAt.current > 1200 && Math.abs(Date.now() - signal.at) < 120_000;
    setEnter(live && (signal.state === "done" || signal.state === "failed") ? signal.state : undefined);
  }, [signal.state, signal.at, animated]);
  // Retire the entrance gesture after it plays, so row reordering cannot replay
  // it. Unread done rows continue with their CSS-only resting hops.
  useEffect(() => {
    if (!enter) return;
    const timer = window.setTimeout(() => setEnter(undefined), 2600);
    return () => window.clearTimeout(timer);
  }, [enter]);
  const state = signal.state === "idle" ? undefined : signal.state;
  const badge = state === "done" || state === "failed" || state === "ask" ? state : undefined;
  const label = badge === "done" ? t("已完成") : badge === "failed" ? t("回复失败") : badge === "ask" ? t("待处理") : undefined;
  const visibleEnter = animated ? enter : undefined;
  return <AgentAvatarContext.Provider value={state && animated ? { state, enter: visibleEnter } : undefined}><RoleStarSuppressed.Provider value={true}>
    <span className={className} data-agent-state={state} data-agent-enter={visibleEnter} data-agent-motion={animated ? "on" : "off"} style={state ? { "--agent-avatar": `${size}px`, ...(state === "done" ? { "--agent-phase": restingPhase(rowId) } : {}) } as CSSProperties : undefined}>
      {children}
      {/* A sibling of the picture: row motion transforms only `> .profile-avatar`. */}
      {dispatcher && <RoleStar/>}
      {/* Rows already announce unread and pending counts; keep their names stable. */}
      {badge && <i className="agent-badge" data-kind={badge} aria-hidden="true" title={label}><BadgeIcon kind={badge}/></i>}
      {visibleEnter === "done" && <svg className="agent-spark" viewBox="-30 -30 160 160" aria-hidden="true">
        {[-158, -124, -90, -56, -22].map((deg, i) => { const r = deg * Math.PI / 180; return <line key={i} x1={50 + Math.cos(r) * 48} y1={55 + Math.sin(r) * 48} x2={50 + Math.cos(r) * 64} y2={55 + Math.sin(r) * 64} style={{ "--ray": i } as CSSProperties}/>; })}
      </svg>}
      {state === "working" && animated && <svg className="agent-typing" viewBox="0 0 64 40" aria-hidden="true">
        <rect className="agent-typing-shape" x="8" y="2" width="54" height="28" rx="14"/><circle className="agent-typing-shape" cx="9" cy="33" r="4.5"/>
        {[22, 35, 48].map((x, i) => <circle key={x} className="agent-typing-dot" cx={x} cy="16" r="4.6" style={{ animationDelay: `${i * .32}s` }}/>)}
      </svg>}
    </span>
  </RoleStarSuppressed.Provider></AgentAvatarContext.Provider>;
}

function BadgeIcon({ kind }: { kind: "done" | "failed" | "ask" }) {
  if (kind === "done") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.2 12.6 10.2 16.4 17.8 8.4" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  if (kind === "failed") return <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><rect x="10.3" y="5" width="3.4" height="10" rx="1.7"/><circle cx="12" cy="18.6" r="1.9"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.9 9.2a3.2 3.2 0 1 1 4.6 2.9c-1 .5-1.5 1.2-1.5 2.3v.4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/><circle cx="12" cy="18.7" r="1.7" fill="currentColor"/></svg>;
}

/** Eyes redrawn over an eye-free copy of the same picture, in percent units. */
export function AgentFace({ face }: { face: AvatarFace }) {
  const [left, right] = face.eyes.map(eye => ({ cx: (eye.x + eye.w / 2) * 100, cy: (eye.y + eye.h / 2) * 100, w: eye.w * 100, h: eye.h * 100 })) as [Eye, Eye];
  const width = Math.min(left.w, right.w);
  const style = { "--eye-dx": `${width * .2}px`, "--eye-dy": `${Math.min(left.h, right.h) * .1}px` } as CSSProperties;
  const arc = (e: Eye) => `M${e.cx - e.w * .62} ${e.cy + e.h * .18}Q${e.cx} ${e.cy + e.h * .18 - e.h * 1.24} ${e.cx + e.w * .62} ${e.cy + e.h * .18}`;
  const chevron = (e: Eye, side: 1 | -1) => `M${e.cx - side * e.w * .45} ${e.cy - e.h * .33}L${e.cx + side * e.w * .4} ${e.cy}L${e.cx - side * e.w * .45} ${e.cy + e.h * .33}`;
  return <span className="agent-face" aria-hidden="true" style={style}>
    {/* A background, not an <img>: the avatar keeps exactly one picture element. */}
    <span className="agent-face-plain" style={{ backgroundImage: `url("${face.plain}")` }}/>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <g className="agent-eyes-open" fill={face.ink}>{[left, right].map((e, i) => <g key={i} className="agent-eye-look"><ellipse className="agent-eye" cx={e.cx} cy={e.cy} rx={e.w / 2} ry={e.h / 2}/></g>)}</g>
      <g className="agent-eyes-happy" fill="none" stroke={face.ink} strokeWidth={width * .34} strokeLinecap="round" strokeLinejoin="round"><path d={arc(left)}/><path d={arc(right)}/></g>
      <g className="agent-eyes-pain" fill="none" stroke={face.ink} strokeWidth={width * .3} strokeLinecap="round" strokeLinejoin="round"><path d={chevron(left, 1)}/><path d={chevron(right, -1)}/></g>
    </svg>
  </span>;
}
type Eye = { cx: number; cy: number; w: number; h: number };
