import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { RunPresentation } from "./RunPresentation.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { useConnectionSelection } from "./connection-selection.js";
import { groupElapsed, taskCounts, visibleTaskIds, type BackgroundTaskGroup as Group } from "./background-task-groups.js";
import { formatRunDuration } from "./run-presentation.js";
import { t, useLocale } from "./i18n.js";
import "./background-task-groups.css";

// UI disclosure only, bounded like the run reader positions. A virtualized row
// remounts when scrolled back; keep the user's choice for the same activity state
// so a group that started or finished meanwhile still folds/unfolds by default.
type FocusRequest = { messageId?: string };
type View = { expanded: boolean; all: boolean; active: boolean; focus?: FocusRequest };
const views = new Map<string, View>();
function rememberView(key: string, view: View) { views.delete(key); views.set(key, view); while (views.size > 64) views.delete(views.keys().next().value!); }

function Summary({ group }: { group: Group }) {
  const counts = taskCounts(group);
  if (counts.done === group.tasks.length) return <>{t("{0} 个后台任务已完成", counts.done)}</>;
  return <>{[
    counts.running > 0 && <span key="running" className="is-running">{t("{0} 运行中", counts.running)}</span>,
    counts.done > 0 && <span key="done">{t("{0} 完成", counts.done)}</span>,
    counts.error > 0 && <span key="error" className="is-error">{t("{0} 失败", counts.error)}</span>,
    counts.interrupted > 0 && <span key="interrupted">{t("{0} 中断", counts.interrupted)}</span>,
    counts.unknown > 0 && <span key="unknown">{t("{0} 待确认", counts.unknown)}</span>,
  ].filter(Boolean).map((part, i) => <span key={i}>{i > 0 && " · "}{part}</span>)}</>;
}

export const BackgroundTaskGroup = memo(function BackgroundTaskGroup({ group, connection, focusRequest, original, locate }: { original?: Message; locate?: (conversationId: string, messageId: string) => void; focusRequest?: FocusRequest; group: Group; connection: HubConnection }) {
  useLocale(); const hostActive = useContext(RuntimeHostActiveContext);
  const state = useConnectionSelection(connection, value => ({ online: value.state.status === "online" && !!value.state.bots.find(bot => bot.id === group.anchor.authorId)?.online, offset: value.state.serverTimeOffset ?? 0 }));
  const backgroundSource = useMemo(() => group.anchor.replyTo && locate ? { original, open: () => locate(group.anchor.conversationId, group.anchor.replyTo!) } : undefined, [original, locate, group.anchor.conversationId, group.anchor.replyTo]);
  const counts = taskCounts(group), active = counts.running > 0;
  const viewKey = `${connection.identity.hubPublicKey}:${group.key}`, remembered = views.get(viewKey);
  const restored = remembered?.active === active ? remembered : undefined;
  const [expanded, setExpanded] = useState(restored?.expanded ?? active), [all, setAll] = useState(restored?.all ?? false), [now, setNow] = useState(Date.now);
  const handledFocus = useRef(remembered?.focus);
  useEffect(() => { rememberView(viewKey, { expanded, all, active, focus: handledFocus.current }); }, [viewKey, expanded, all, active, focusRequest]);
  const heading = useRef<HTMLButtonElement>(null);
  const wasActive = useRef(active);
  // A location reveals the member once. Virtualization may remount this card
  // with the same request after the user deliberately folded it again.
  useLayoutEffect(() => {
    if (focusRequest?.messageId && handledFocus.current !== focusRequest && group.tasks.some(task => task.message.id === focusRequest.messageId)) {
      handledFocus.current = focusRequest; setExpanded(true); setAll(true);
    }
  }, [focusRequest, group.key]);
  useLayoutEffect(() => { if (wasActive.current !== active) { wasActive.current = active; setExpanded(active); } }, [active]);
  useEffect(() => { if (!active || !state.online || !hostActive) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active, state.online, hostActive]);
  const elapsed = groupElapsed(group, state.online && hostActive ? now + state.offset : 0);
  const visibleTasks = visibleTaskIds(group);
  return <section className={`background-task-group${expanded ? " is-expanded" : " is-collapsed"}`} data-background-group-id={group.anchor.id} aria-label={t("后台任务组")} onContextMenu={event => event.stopPropagation()}>
    <button type="button" className="background-group-heading" ref={heading} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {active || counts.done !== group.tasks.length ? <GitBranch size={14}/> : <Check size={14}/>}
      <span className="background-group-title">{expanded ? t("后台任务 {0}", group.tasks.length) : active && !state.online ? t("后台任务状态待确认") : <Summary group={group}/>}</span>
      {expanded && <span className="background-group-count">{active && !state.online ? t("状态待确认") : <Summary group={group}/>}</span>}
      {!expanded && <><time>{formatRunDuration(elapsed)}</time><span>{t("查看")}</span></>}
      {expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
    </button>
    {/* Keep the existing reader mounted when the last task finishes or the list
        folds. Its portal and per-message journal remain independent. */}
    <div hidden={!expanded} className="background-group-rows">
      {group.tasks.map(task => <div key={task.message.id} data-background-message-id={task.message.id} hidden={!all && !visibleTasks.has(task.message.id)}>
        <RunPresentation compact compactReturnFocus={heading} backgroundSource={backgroundSource} run={task.run} block={task.block} message={task.message} connection={connection}/>
      </div>)}
      {group.tasks.length > 5 && <button type="button" className="background-group-more" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? t("收起") : t("还有 {0} 个", group.tasks.length - 5)}</button>}
    </div>
  </section>;
});

/** Observe actual rectangles inside this conversation's scrollport. Virtualized
 * unmounted cards count as offscreen; overscan alone never means visible. */
export function BackgroundTaskDock({ groups, connection, viewport, active, locate, children }: { groups: Group[]; connection: HubConnection; viewport: RefObject<HTMLDivElement | null>; active: boolean; locate: (conversationId: string, messageId: string) => void; children?: (dock: ReactNode, hasActiveGroups: boolean) => ReactNode }) {
  useLocale(); const state = useConnectionSelection(connection, value => ({ online: value.state.status === "online", bots: value.state.bots }));
  const running = groups.filter(group => taskCounts(group).running > 0), signature = running.map(group => group.anchor.id).join("\0");
  const [visible, setVisible] = useState<Set<string>>(() => new Set());
  useLayoutEffect(() => {
    const root = viewport.current;
    if (!active || !root || !signature) { setVisible(previous => previous.size ? new Set() : previous); return; }
    const ids = new Set(signature.split("\0")); let frame = 0;
    const check = () => {
      frame = 0; const bounds = root.getBoundingClientRect(), next = new Set<string>();
      root.querySelectorAll<HTMLElement>("[data-background-group-id]").forEach(element => {
        const id = element.dataset.backgroundGroupId!, rect = element.getBoundingClientRect();
        if (ids.has(id) && rect.height > 0 && rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1 && rect.right > bounds.left && rect.left < bounds.right) next.add(id);
      });
      setVisible(previous => previous.size === next.size && [...previous].every(id => next.has(id)) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    check(); root.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule); resize.observe(root);
    const mutation = new MutationObserver(schedule); mutation.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "hidden"] });
    window.addEventListener("resize", schedule);
    return () => { root.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame); };
  }, [active, signature, viewport]);
  const offscreen = running.filter(group => !visible.has(group.anchor.id)), group = offscreen[0];
  const online = state.online && !!state.bots.find(bot => bot.id === group?.anchor.authorId)?.online;
  const dock = active && group ? <button type="button" className="background-task-dock" aria-label={t("定位后台任务组")} onClick={() => locate(group.anchor.conversationId, group.anchor.id)}>
    <GitBranch size={14}/><span><small className="background-dock-scope">{t("本组")}</small>{online ? <Summary group={group}/> : t("后台任务状态待确认")}</span>
    {offscreen.length > 1 && <small>{t("另 {0} 组", offscreen.length - 1)}</small>}
    <ChevronRight size={14}/>
  </button> : null;
  // Compose the existing read-only locator with native management. Counts and
  // control handles never cross this boundary; the two sources are not joined.
  return children ? children(dock, running.length > 0) : dock;
}
