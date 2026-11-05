import { agentBusIsActive, type AgentBusConfig, type AgentBusMode, type AgentBusRun } from "../../src/client-protocol/agent-bus.js";

export type BusFlowNode = { index: number; x: number; y: number; width: number; height: number };
export type BusFlowEdge = { from: number; to: number; kind: "forward" | "return" | "revision"; path: string };
export type BusFlowLayout = { width: number; height: number; nodes: BusFlowNode[]; edges: BusFlowEdge[] };

/** Five bounded product topologies. Status never participates in layout. */
export function busFlowLayout(mode: AgentBusMode, members: number, availableWidth: number, revisions = true): BusFlowLayout {
  const width = Math.max(260, Math.round(availableWidth)), count = Math.max(1, Math.min(11, members));
  const parallel = mode === "fan", nodeHeight = 84, gap = 24, top = 14;
  const cardWidth = parallel ? (width - 44) / 2 : Math.min(292, width - 70);
  const nodes: BusFlowNode[] = [{ index: -1, x: (width - Math.min(244, width - 70)) / 2, y: top, width: Math.min(244, width - 70), height: nodeHeight }];
  for (let i = 0; i < count; i++) {
    nodes.push({ index: i, x: parallel ? count === 1 ? (width - cardWidth) / 2 : 16 + (i % 2) * (cardWidth + 12) : (width - cardWidth) / 2,
      y: top + (parallel ? Math.floor(i / 2) + 1 : i + 1) * (nodeHeight + gap), width: cardWidth, height: nodeHeight });
  }
  const edges: BusFlowEdge[] = [];
  const connect = (from: BusFlowNode, to: BusFlowNode) => {
    const sx = from.x + from.width / 2, sy = from.y + from.height, tx = to.x + to.width / 2, ty = to.y;
    // Parallel dispatch shares the center gutter, then branches in each row's
    // gap. Every edge still originates at the coordinator, never a prior row.
    const path = parallel && count > 1
      ? `M ${sx} ${sy} V ${ty - gap / 2} H ${tx} V ${ty}`
      : `M ${sx} ${sy} C ${sx} ${sy + gap / 2}, ${tx} ${ty - gap / 2}, ${tx} ${ty}`;
    edges.push({ from: from.index, to: to.index, kind: "forward", path });
  };
  for (let i = 1; i < nodes.length; i++) connect(parallel ? nodes[0]! : nodes[i - 1]!, nodes[i]!);
  if (mode === "ask" || mode === "verify" || mode === "crew" && revisions) {
    const from = nodes.at(-1)!, to = mode === "crew" ? nodes.at(-2)! : nodes[0]!, rail = width - 10;
    const sy = from.y + from.height / 2, ty = to.y + to.height / 2;
    edges.push({ from: from.index, to: to.index, kind: mode === "crew" ? "revision" : "return",
      path: `M ${from.x + from.width} ${sy} H ${rail - 8} Q ${rail} ${sy} ${rail} ${sy - 8} V ${ty + 8} Q ${rail} ${ty} ${rail - 8} ${ty} H ${to.x + to.width}` });
  }
  return { width, height: nodes.at(-1)!.y + nodeHeight + 18, nodes, edges };
}

export type BusNodeTone = "idle" | "waiting" | "running" | "stopping" | "partial" | "completed" | "failed" | "cancelled";
export function busNodeTone(run: AgentBusRun | undefined, member: AgentBusConfig["coordinator"], coordinator: boolean): BusNodeTone {
  if (!run) return "idle";
  const stages = run.stages.filter(stage => stage.botId === member.botId && stage.conversationId === member.conversationId);
  if (run.status === "running" && stages.some(stage => stage.status === "running")) return "running";
  if (run.status === "stopping" && stages.some(stage => stage.status === "running")) return "stopping";
  const completed = stages.filter(stage => stage.status === "completed").length;
  if (completed > 0 && completed < stages.length) return "partial";
  if (stages.some(stage => stage.status === "failed")) return "failed";
  if (stages.some(stage => stage.status === "cancelled")) return "cancelled";
  if (stages.length && stages.every(stage => stage.status === "completed")) return "completed";
  if (agentBusIsActive(run.status)) return "waiting";
  if (!coordinator && !stages.length) return "idle";
  return run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : "failed";
}

/** Animate only an observed active handoff, never a guessed completion ratio. */
export function busEdgeActive(edge: BusFlowEdge, mode: AgentBusMode, members: AgentBusConfig["members"], run?: AgentBusRun): boolean {
  if (run?.status !== "running" || edge.kind === "return") return false;
  const target = members[edge.to + 1], stages = run.stages.filter(stage => stage.botId === target?.botId && stage.conversationId === target?.conversationId);
  if (!stages.some(stage => stage.status === "running")) return false;
  const revising = mode === "crew" && edge.to === 2 && stages.length > 1;
  return edge.kind === "revision" ? revising : !revising;
}
