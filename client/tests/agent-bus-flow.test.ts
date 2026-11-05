import { describe, expect, it } from "vitest";
import type { AgentBusRun } from "../../src/client-protocol/agent-bus.js";
import { busEdgeActive, busFlowLayout, busNodeTone } from "../src/agent-bus-flow.js";

describe("Bus topology and truthful execution motion", () => {
  it("shows the actual participant count and in-bounds nodes for narrow and wide panels", () => {
    for (const mode of ["ask", "fan", "chain", "verify", "crew"] as const) for (const width of [260, 320, 406, 600]) for (const count of [1, 4, 11]) {
      const graph = busFlowLayout(mode, count, width);
      expect(graph.nodes).toHaveLength(count + 1);
      for (const node of graph.nodes) { expect(node.x).toBeGreaterThanOrEqual(0); expect(node.x + node.width).toBeLessThanOrEqual(width); expect(node.y + node.height).toBeLessThanOrEqual(graph.height); }
      for (const [i, a] of graph.nodes.entries()) for (const b of graph.nodes.slice(i + 1)) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
  });
  it("distinguishes delegation, parallel dispatch, ordered handoff and optional revision", () => {
    expect(busFlowLayout("ask", 1, 400).edges.map(e => [e.from, e.to, e.kind])).toEqual([[-1, 0, "forward"], [0, -1, "return"]]);
    expect(busFlowLayout("fan", 5, 400).edges.map(e => e.from)).toEqual([-1, -1, -1, -1, -1]);
    expect(busFlowLayout("chain", 3, 400).edges.map(e => [e.from, e.to])).toEqual([[-1, 0], [0, 1], [1, 2]]);
    expect(busFlowLayout("crew", 4, 400).edges.at(-1)).toMatchObject({ from: 3, to: 2, kind: "revision" });
    expect(busFlowLayout("crew", 4, 400, false).edges).toHaveLength(4);
  });
  it("distinguishes usable partial Crew results from complete member failure", () => {
    const stages = [{ botId: "research", conversationId: "research-chat", status: "completed" }, { botId: "research", conversationId: "research-chat", status: "failed" }, { botId: "research", conversationId: "research-chat", status: "completed" }];
    for (const status of ["running", "completed", "failed", "cancelled"] as const) expect(busNodeTone({ status, stages } as AgentBusRun, { botId: "research", conversationId: "research-chat" }, false)).toBe("partial");
    expect(busNodeTone({ status: "completed", stages: [{ botId: "research", conversationId: "research-chat", status: "failed" }] } as AgentBusRun, { botId: "research", conversationId: "research-chat" }, false)).toBe("failed");
    expect(busNodeTone({ status: "running", stages: [...stages, { botId: "research", conversationId: "research-chat", status: "running" }] } as AgentBusRun, { botId: "research", conversationId: "research-chat" }, false)).toBe("running");
  });
  it("stops motion on terminal/stopping runs and activates the revision route only on repeated writing", () => {
    const graph = busFlowLayout("crew", 4, 400), ids = ["c", "r", "a", "w", "v"].map(botId => ({ botId, conversationId: `${botId}-chat` }));
    const run = { status: "running", stages: [{ botId: "w", conversationId: "w-chat", status: "completed" }, { botId: "w", conversationId: "w-chat", status: "running" }] } as AgentBusRun;
    expect(graph.edges.filter(e => busEdgeActive(e, "crew", ids, run)).map(e => e.kind)).toEqual(["revision"]);
    for (const status of ["stopping", "cancelled", "failed", "completed", "interrupted", "queued"] as const) expect(graph.edges.some(e => busEdgeActive(e, "crew", ids, { ...run, status }))).toBe(false);
    expect(busNodeTone({ ...run, status: "stopping" }, { botId: "w", conversationId: "w-chat" }, false)).toBe("stopping");
    expect(busNodeTone({ ...run, status: "cancelled" }, { botId: "w", conversationId: "w-chat" }, false)).toBe("partial");
    expect(busNodeTone({ status: "cancelled", stages: [{ botId: "w", conversationId: "w-chat", status: "cancelled" }] } as AgentBusRun, { botId: "w", conversationId: "w-chat" }, false)).toBe("cancelled");
    expect(busNodeTone({ ...run, status: "completed" }, { botId: "v", conversationId: "v-chat" }, false)).toBe("idle");
  });
});
