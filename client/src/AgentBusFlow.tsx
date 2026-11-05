import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, CircleDashed, CircleMinus, Clock3, LoaderCircle, Plus, Square } from "lucide-react";
import type { AgentBusConfig, AgentBusRun, AgentBusWorkspace } from "../../src/client-protocol/agent-bus.js";
import { Avatar } from "./Avatar.js";
import { busEdgeActive, busFlowLayout, busNodeTone } from "./agent-bus-flow.js";
import { busMemberStatus, busRoleName } from "./agent-bus-view.js";
import { t } from "./i18n.js";

/** Run visualization. Configuration edits happen in the division list. */
export function AgentBusFlow({ config, run, workspace, selected, select, label, conversationLabel, visible }: {
  config: AgentBusConfig; workspace?: AgentBusWorkspace; run?: AgentBusRun;
  selected: number; select: (index: number) => void; label: (id: string) => string; conversationLabel: (id?: string) => string;
  visible: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null), [width, setWidth] = useState(380), marker = `bus-arrow-${useId().replace(/:/g, "")}`;
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    const measure = () => { if (element.clientWidth >= 260) setWidth(element.clientWidth); };
    const observer = new ResizeObserver(measure); observer.observe(element); measure(); return () => observer.disconnect();
  }, []);
  const graph = useMemo(() => busFlowLayout(config.mode, config.members.length, width, config.maxRevisionRounds > 0), [config.mode, config.members.length, config.maxRevisionRounds, width]);
  useLayoutEffect(() => {
    const element = viewport.current, node = graph.nodes.find(item => item.index === selected);
    if (!element || !node || !visible) return;
    if (node.y < element.scrollTop) element.scrollTop = node.y;
    else if (node.y + node.height > element.scrollTop + element.clientHeight) element.scrollTop = node.y + node.height - element.clientHeight + 8;
  }, [selected, graph, visible]);
  const members = [config.coordinator, ...config.members];
  // Paint active branches last so shared fan trunks cannot be covered by an
  // inactive branch. This changes only paint order, not execution order.
  const edges = graph.edges.map(edge => ({ ...edge, active: busEdgeActive(edge, config.mode, members, run) })).sort((a, b) => Number(a.active) - Number(b.active));
  return <section className={`agent-bus-flow is-${config.mode} ${workspace ? "is-execution" : ""} ${visible ? "" : "is-paused"}`} aria-label={t("成员流程")}>
    <div className="agent-bus-flow-heading"><span>{t("成员流程")}</span><small>{t("{0} 位成员", members.length)}</small></div>
    <div ref={viewport} className="agent-bus-flow-viewport"><div className="agent-bus-flow-canvas" style={{ height: graph.height }}>
      <svg className="agent-bus-flow-lines" width="100%" height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`} aria-hidden="true">
        <defs>{[false, true].map(active => <marker key={String(active)} id={`${marker}${active ? "-active" : ""}`} markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto-start-reverse"><path d="M1 1L5 3.5L1 6" fill="none" stroke={active ? "var(--accent,var(--blue))" : "var(--muted)"} strokeWidth="1.2"/></marker>)}</defs>
        {edges.map(edge => <path key={`${edge.from}/${edge.to}/${edge.kind}`} className={`agent-bus-flow-edge is-${edge.kind} ${edge.active ? "is-active" : ""}`} d={edge.path} markerEnd={`url(#${marker}${edge.active ? "-active" : ""})`}/>)}
      </svg>
      {graph.nodes.map(node => {
        const member = members[node.index + 1]!, name = member.botId ? label(member.botId) : t("选择 Bot"), role = busRoleName(config.mode, node.index);
        const status = member.botId && workspace ? busMemberStatus(workspace, run, member) : member.botId ? t("已选择") : t("待配置");
        const showStatus = !!workspace || !member.botId;
        const tone = busNodeTone(run, member, node.index < 0);
        const Icon = tone === "running" ? LoaderCircle : tone === "stopping" ? Clock3 : tone === "partial" ? CircleMinus : tone === "completed" ? Check : tone === "failed" ? CircleAlert : tone === "cancelled" ? Square : CircleDashed;
        return <div key={member.conversationId ? `${member.botId}/${member.conversationId}` : `slot-${node.index}`} className="agent-bus-flow-item" style={{ width: node.width, height: node.height, transform: `translate(${node.x}px, ${node.y}px)` }}>
          <button type="button" data-node-index={node.index} data-bot-id={member.botId} data-conversation-id={member.conversationId} aria-label={t("{0}：{1}", role, `${name} · ${conversationLabel(member.conversationId)}`)} aria-pressed={selected === node.index} aria-describedby={showStatus ? `${marker}-status-${node.index}` : undefined}
          className={`agent-bus-flow-node is-${tone} ${selected === node.index ? "is-selected" : ""} ${!member.botId ? "is-empty" : ""}`}
          onClick={() => select(node.index)}>
          <span className="agent-bus-flow-node-meta"><small>{role}</small>{showStatus && <span id={`${marker}-status-${node.index}`} className="agent-bus-flow-node-status"><Icon size={11} className={tone === "running" ? "spin" : ""}/><span title={status}>{status}</span></span>}<span className="agent-bus-flow-node-order" aria-hidden="true">{node.index < 0 ? "" : String(node.index + 1).padStart(2, "0")}</span></span>
          <span className="agent-bus-flow-node-identity"><span className="agent-bus-flow-node-avatar">{member.botId ? <Avatar kind="bot" id={member.botId} name={name} size={24}/> : <Plus size={16}/>}</span><strong title={name}>{name}</strong></span>
          <span className="agent-bus-flow-node-conversation" title={member.botId ? conversationLabel(member.conversationId) : undefined}>{member.botId ? conversationLabel(member.conversationId) : "\u00a0"}</span>
          </button>
        </div>;
      })}
    </div></div>
    {workspace && <div className="agent-bus-flow-caption">{config.mode === "fan" ? t("发起者与成员同时回答") : config.mode === "crew" && config.maxRevisionRounds ? t("可按需修订，最多 {0} 轮", config.maxRevisionRounds) : config.mode === "ask" || config.mode === "verify" ? t("结果返回发起对话") : t("按连线顺序传递成果")}</div>}
  </section>;
}
