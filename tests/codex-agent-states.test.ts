import { describe, expect, it } from "vitest";
import { extractCodexToolItem } from "../src/codex/app-server-adapter.js";
import { createRunRecord, recordRunEvent } from "../src/core/run-record.js";

const limit = 65536;
function capture(agentsStates: unknown) {
  const event = extractCodexToolItem({ type: "collabAgentToolCall", id: "wait-1", tool: "wait", status: "completed", agentsStates })!;
  const record = createRunRecord();
  recordRunEvent(record, { type: "tool_result", ...event });
  return { event, record, states: JSON.parse(record.entries[0]!.output!) as Record<string, any> };
}

describe("bounded Codex agent reports", () => {
  it("preserves small snapshots exactly, including future fields and statuses", () => {
    const states = { reviewer: { status: "queued", message: null, future: { extra: true } } };
    const { event, record } = capture(states);
    expect(event.output).toBe(JSON.stringify(states));
    expect(event.truncated).toBeUndefined();
    expect(record.entries[0]?.truncated).toBeUndefined();
  });

  it("fairly retains four large child reports as valid JSON after journal capture", () => {
    const states = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`reviewer-${i}`, { status: "completed", message: `${i}`.repeat(20000) }]));
    const original = JSON.stringify(states), { event, record, states: result } = capture(states);
    expect(event.output!.length).toBeLessThanOrEqual(limit);
    expect(event.truncated).toBe(true);
    expect(record.entries[0]?.truncated).toBe(true);
    expect(Object.keys(result)).toEqual(Object.keys(states));
    const lengths = Object.values(result).map(value => value.message.length);
    expect(Math.min(...lengths)).toBeGreaterThan(16000);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
    for (const [id, state] of Object.entries(result)) expect(states[id]!.message.startsWith(state.message)).toBe(true);
    expect(JSON.stringify(states)).toBe(original);
  });

  it("measures JSON escaping and never splits an emoji surrogate pair", () => {
    const message = '\u0000"\\\n😀'.repeat(15000);
    const { event, states } = capture({ first: { status: "completed", message }, second: { status: "completed", message } });
    expect(event.output!.length).toBeLessThanOrEqual(limit);
    expect(event.truncated).toBe(true);
    for (const state of Object.values(states)) {
      expect(message.startsWith(state.message)).toBe(true);
      expect(state.message).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(state.message.length).toBeGreaterThan(1000);
    }
  });

  it("preserves exact long identities without key collisions and budgets metadata", () => {
    const prefix = '"\\'.repeat(1000), ids = [`${prefix}first`, `${prefix}second`];
    const { event, states } = capture(Object.fromEntries(ids.map(id => [id, { status: "completed", message: "a".repeat(60000) }])));
    expect(event.output!.length).toBeLessThanOrEqual(limit);
    expect(Object.keys(states)).toEqual(ids);
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`${i}-${"x".repeat(500)}`, { status: "completed", message: "a".repeat(1000) }]));
    const bounded = capture(many);
    expect(bounded.event.output!.length).toBeLessThanOrEqual(limit);
    expect(bounded.event.truncated).toBe(true);
    expect(Object.keys(bounded.states).length).toBeGreaterThan(100);
    expect(Object.keys(bounded.states).every(id => Object.hasOwn(many, id))).toBe(true);
  });

  it("keeps known reports when unknown fields or shapes overflow without fabricating statuses", () => {
    const status = "future-status".repeat(8);
    const source = { reviewer: { status, message: "actual report", extra: "x".repeat(100000) }, strange: { nested: "y".repeat(100000) } };
    const original = JSON.stringify(source), { event, states } = capture(source);
    expect(event.output!.length).toBeLessThanOrEqual(limit);
    expect(event.truncated).toBe(true);
    expect(states.reviewer).toEqual({ status, message: "actual report" });
    expect(states.strange.capture).toBe("unrecognized_agent_state");
    expect(states.strange.status).toBeUndefined();
    expect(states.strange.message).toBeUndefined();
    expect(JSON.stringify(source)).toBe(original);
  });

  it("uses explicit valid JSON fallback for huge unknown shapes or unrepresentable IDs", () => {
    for (const source of [["x".repeat(100000)], "x".repeat(100000), { ["x".repeat(100000)]: { status: "completed", message: "report" } }]) {
      const { event, states } = capture(source);
      expect(event.output!.length).toBeLessThanOrEqual(limit);
      expect(event.truncated).toBe(true);
      expect(states.capture).toBeDefined();
      expect(states.status).toBeUndefined();
    }
  });
});
