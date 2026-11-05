import { describe, expect, it } from "vitest";
import { deepseekGoalUsageDefinition as definition } from "../src/codex/deepseek-goal-usage.js";

function fixture() {
  let state = definition.init();
  const event = (type: string, data: Record<string, unknown>) => { state = definition.apply(state, { type, data }); };
  return {
    event,
    goal: (id: string) => event("goal/change", { operation: "create", goal: { id } }),
    turn: (turn: number, source: Record<string, unknown>) => { event("turn/start", { turn }); event("user/message", { source }); },
    sample: (turn: number, step: number, inputTokens: number, outputTokens: number, type = "assistant/message") => event(type, { turn, step, stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens, outputTokens, cacheReadTokens: 2, cacheWriteTokens: 3 } } }] }),
    view: () => definition.wire.view(state),
    checkpoint: () => { state = definition.stateSchema.parse(JSON.parse(JSON.stringify(state))); },
  };
}
const goalSource = (goalId = "a") => ({ kind: "goal", goalId, round: 1 });
describe("native DeepSeek goal token projection", () => {
  it("reports arithmetic overflow as unavailable without throwing inside native publication", () => {
    const state = { view: { goalId: "a", tokensUsed: Number.MAX_SAFE_INTEGER }, turn: { id: 1, chosen: true, goalId: "a" }, last: null };
    const next = definition.apply(state, { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 2, outputTokens: 1 } } });
    expect(definition.wire.view(next)).toEqual({ goalId: "a", tokensUsed: Number.MAX_SAFE_INTEGER, error: "overflow" });
    expect(() => definition.stateSchema.parse(next)).not.toThrow();
  });
  it("attributes interleaved turns to their originating goal, never ordinary or background work", () => {
    const f = fixture(); f.goal("a");
    f.turn(1, goalSource()); f.sample(1, 1, 10, 4); expect(f.view().tokensUsed).toBe(19);
    f.turn(2, { kind: "user", rpcId: "ordinary" }); f.sample(2, 1, 500, 900);
    f.turn(3, { kind: "tool-jobs", form: "notice" }); f.sample(3, 1, 800, 200);
    f.turn(4, goalSource()); f.sample(4, 1, 20, 6);
    expect(f.view()).toEqual({ goalId: "a", tokensUsed: 50 });
  });
  it("replaces cumulative samples in one step, adds retries, and survives checkpoints", () => {
    const f = fixture(); f.goal("a"); f.turn(1, goalSource());
    f.sample(1, 1, 10, 2, "assistant/attempt"); f.checkpoint();
    f.sample(1, 1, 10, 4); expect(f.view().tokensUsed).toBe(19);
    const view = f.view(); f.sample(1, 1, 10, 4); expect(f.view()).toBe(view);
    f.event("llm/retry-started", { turn: 1, step: 1 }); f.checkpoint();
    f.sample(1, 1, 10, 6, "assistant/attempt"); expect(f.view().tokensUsed).toBe(40);
    f.sample(1, 1, 10, 8); expect(f.view().tokensUsed).toBe(42);
    f.sample(1, 2, 5, 2); expect(f.view().tokensUsed).toBe(54);
  });
  it("pins first work input through steering, merged inputs, and goal replacement", () => {
    const f = fixture(); f.goal("a"); f.turn(1, { kind: "runtime-context" });
    f.event("user/message", { source: goalSource() });
    f.event("user/message", { source: { kind: "tarocub-steer" } }); f.sample(1, 1, 10, 4);
    f.goal("b"); f.sample(1, 2, 50, 50); expect(f.view()).toEqual({ goalId: "b", tokensUsed: 0 });
    f.turn(2, { kind: "user" }); f.event("user/message", { source: goalSource("b") }); f.sample(2, 1, 40, 60);
    expect(f.view().tokensUsed).toBe(0);
    f.turn(3, goalSource("b")); f.sample(3, 1, 1, 1); expect(f.view().tokensUsed).toBe(7);
    f.event("goal/change", { operation: "pause", goal: { id: "b" } });
    f.event("goal/change", { operation: "resume", goal: { id: "b" } }); expect(f.view().tokensUsed).toBe(7);
    f.event("goal/change", { operation: "clear" }); f.sample(3, 2, 100, 100);
    expect(f.view()).toEqual({ goalId: null, tokensUsed: 0 });
  });
  it("counts goal usage after the native working-directory notice without attributing ordinary work to a goal", () => {
    const f = fixture(); f.goal("a");
    f.turn(1, { kind: "working-directory" });
    f.event("user/message", { source: goalSource() }); f.sample(1, 1, 10, 4);
    expect(f.view().tokensUsed).toBe(19);
    f.turn(2, { kind: "working-directory" });
    f.event("user/message", { source: { kind: "user", rpcId: "ordinary" } });
    f.event("user/message", { source: goalSource() }); f.sample(2, 1, 100, 400);
    expect(f.view().tokensUsed).toBe(19);
  });
  it("uses the last stream sample or legacy usage and ignores invalid or missing reports", () => {
    const f = fixture(); f.goal("a"); f.turn(1, goalSource());
    f.event("assistant/attempt", { turn: 1, step: 1, stream: [
      { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } } },
      { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 3 } } },
    ] }); expect(f.view().tokensUsed).toBe(14);
    f.event("assistant/message", { turn: 1, step: 1, usage: { inputTokens: 12, outputTokens: 4 } }); expect(f.view().tokensUsed).toBe(16);
    f.event("assistant/message", { turn: 1, step: 2, usage: { inputTokens: -1, outputTokens: 4 } });
    f.event("assistant/attempt", { turn: 1, step: 3, stream: [] });
    f.sample(99, 1, 100, 100); expect(f.view().tokensUsed).toBe(16);
  });
  it("does not promote an unowned or malformed goal input to budgeted work", () => {
    const f = fixture(); f.goal("a");
    f.turn(1, { kind: "goal", goalId: "a", round: 0 }); f.sample(1, 1, 100, 100);
    f.turn(2, { kind: "unknown" }); f.event("user/message", { source: goalSource() }); f.sample(2, 1, 100, 100);
    f.event("turn/start", { turn: 3 }); f.sample(3, 1, 100, 100);
    expect(f.view().tokensUsed).toBe(0);
  });
});
