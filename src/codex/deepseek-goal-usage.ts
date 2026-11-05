import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const deepseekGoalUsageSchema = z.object({ goalId: z.string().min(1).nullable(), tokensUsed: count, error: z.literal("overflow").optional() }).strict();
const stateSchema = z.object({
  view: deepseekGoalUsageSchema,
  turn: z.object({ id: count, chosen: z.boolean(), goalId: z.string().nullable() }).nullable(),
  last: z.object({ turn: count, step: count, tokens: count }).nullable(),
}).strict();
type State = z.infer<typeof stateSchema>;
type Event = { type: string; data: Record<string, unknown> };
const contextSources = new Set(["user-approval", "runtime-context", "agent-instructions", "skill-catalog", "working-directory", "tarocub-steer"]);
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Mirrors dsh-token-meter v2: last provider sample per settlement, replacing
 * the same turn/step slot, with llm/retry-started opening a new billed attempt.
 * Reasoning is already part of outputTokens; input excludes cache traffic. */
function usage(event: Event): number | undefined {
  let sample = event.type === "assistant/message" ? record(event.data.usage) : undefined;
  if (!sample && Array.isArray(event.data.stream)) {
    for (const entry of event.data.stream) {
      const item = record(entry), chunk = record(item?.chunk);
      if (item?.type === "chunk" && chunk?.type === "usage") sample = record(chunk.usage);
    }
  }
  if (!sample) return;
  const parts = [sample.inputTokens, sample.outputTokens, sample.cacheReadTokens ?? 0, sample.cacheWriteTokens ?? 0];
  if (!parts.every(isCount)) return;
  const total = parts.reduce((sum, n) => sum + n, 0);
  return isCount(total) ? total : undefined;
}

/** Native durable projection, replayed/checkpointed by sessionProjections.
 * Counts provider-reported usage of turns whose first work input explicitly
 * names this goal. Ordinary turns and untraceable tool-job/child sessions are
 * never charged by inference. A goal changed mid-turn retains the old owner. */
export const deepseekGoalUsageDefinition = {
  key: "tarocubGoalUsage",
  stateVersion: 3,
  stateSchema,
  init: (): State => ({ view: { goalId: null, tokensUsed: 0 }, turn: null, last: null }),
  apply: (state: State, event: Event): State => {
    if (event.type === "goal/change") {
      if (event.data.operation === "clear") return { ...state, view: { goalId: null, tokensUsed: 0 }, last: null };
      const id = record(event.data.goal)?.id;
      if (typeof id === "string" && id && id !== state.view.goalId) return { ...state, view: { goalId: id, tokensUsed: 0 }, last: null };
      return state;
    }
    if (event.type === "turn/start" && isCount(event.data.turn)) return { ...state, turn: { id: event.data.turn, chosen: false, goalId: null } };
    if (event.type === "user/message" && state.turn && !state.turn.chosen) {
      const source = record(event.data.source);
      if (contextSources.has(String(source?.kind))) return state;
      const goalId = source?.kind === "goal" && typeof source.goalId === "string" && isCount(source.round) && source.round > 0 ? source.goalId : null;
      return { ...state, turn: { ...state.turn, chosen: true, goalId } };
    }
    if (event.type === "llm/retry-started") return state.last && state.last.turn === event.data.turn && state.last.step === event.data.step ? { ...state, last: null } : state;
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return state;
    if (state.view.error || !state.view.goalId || state.turn?.goalId !== state.view.goalId || state.turn.id !== event.data.turn || !isCount(event.data.step)) return state;
    const tokens = usage(event);
    if (tokens === undefined) return state;
    const previous = state.last && state.last.turn === event.data.turn && state.last.step === event.data.step ? state.last.tokens : 0;
    const total = state.view.tokensUsed - previous + tokens;
    // Projection listeners run inside native publication; do not throw there.
    if (!isCount(total)) return { ...state, view: { ...state.view, error: "overflow" } };
    return {
      ...state,
      view: total === state.view.tokensUsed ? state.view : { ...state.view, tokensUsed: total },
      last: { turn: state.turn.id, step: event.data.step, tokens },
    };
  },
  wire: { viewSchema: deepseekGoalUsageSchema, view: (state: State) => state.view },
};
