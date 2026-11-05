import { z } from "zod";

const position = z.number().int().nonnegative().safe();
const cursor = z.number().int().min(-1).safe();
const chunkSchema = z.object({ type: z.string() }).passthrough().superRefine((value, ctx) => {
  if ((value.type === "text-delta" || value.type === "reasoning-delta") && typeof value.text !== "string") {
    ctx.addIssue({ code: "custom", message: "Assistant delta text must be a string" });
  }
});
const run = { time0: z.number().int().safe(), index: position, dt: z.array(z.number().int().safe()) };
const recordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text-chunks"), ...run, texts: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("reasoning-chunks"), ...run, texts: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("tool-call-chunks"), ...run, id: z.string(), name: z.string().optional(), args: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("chunk"), time: z.number().int().safe(), chunk: chunkSchema }),
]).superRefine((value, ctx) => {
  if (value.type !== "chunk" && value.dt.length !== ("texts" in value ? value.texts : value.args).length - 1) {
    ctx.addIssue({ code: "custom", message: "Invalid compact assistant run length" });
  }
});

const attemptSchema = z.object({
  attemptId: z.string().min(1), startedAfterSeq: cursor, turn: position, step: position,
  nextIndex: position, stream: z.array(recordSchema),
}).superRefine((value, ctx) => {
  const count = value.stream.reduce((total, record) => total + (record.type === "chunk" ? 1 : "texts" in record ? record.texts.length : record.args.length), 0);
  if (count !== value.nextIndex) ctx.addIssue({ code: "custom", message: "Assistant baseline index does not match its stream" });
});
const baselineSchema = z.object({ revision: position, activeAttempt: attemptSchema.optional() });
const identity = { attemptId: z.string().min(1), revision: position };
const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), ...identity, startedAfterSeq: cursor, turn: position, step: position }),
  z.object({ type: z.literal("chunk"), ...identity, index: position, time: z.number().int().safe(), chunk: chunkSchema }),
  z.object({ type: z.literal("end"), ...identity, index: position, outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("abandoned") }),
    z.object({ kind: z.literal("committed"), eventType: z.enum(["assistant/message", "assistant/attempt"]), seq: cursor }),
  ]) }),
]);

export const deepseekAssistantPrefixSchema = z.object({
  attemptId: z.string().min(1), startedAfterSeq: cursor, turn: position, step: position,
  text: z.string(), reasoning: z.string(),
});
export type DeepSeekAssistantPrefix = z.infer<typeof deepseekAssistantPrefixSchema>;

/** Process-local presentation only: these frames never enter durable history or its cursor. */
export class DeepSeekAssistantStream {
  private revision = -1;
  private active?: DeepSeekAssistantPrefix & { nextIndex: number };

  replace(value: unknown): DeepSeekAssistantPrefix | undefined {
    const baseline = baselineSchema.parse(value);
    this.revision = baseline.revision;
    this.active = undefined;
    const attempt = baseline.activeAttempt;
    if (!attempt) return;
    const { attemptId, startedAfterSeq, turn, step, nextIndex } = attempt;
    const active = { attemptId, startedAfterSeq, turn, step, nextIndex, text: "", reasoning: "" };
    for (const record of attempt.stream) {
      if (record.type === "text-chunks") active.text += record.texts.join("");
      else if (record.type === "reasoning-chunks") active.reasoning += record.texts.join("");
      else if (record.type === "chunk") this.append(active, record.chunk);
    }
    this.active = active;
    return this.prefix();
  }

  accept(value: unknown): DeepSeekAssistantPrefix | undefined {
    const frame = frameSchema.parse(value);
    if (frame.revision <= this.revision) return;
    const dense = frame.revision === this.revision + 1;
    this.revision = frame.revision;
    if (frame.type === "start") {
      this.active = { ...frame, text: "", reasoning: "", nextIndex: 0 };
      return this.prefix();
    }
    const active = this.active;
    if (!dense || !active || active.attemptId !== frame.attemptId || active.nextIndex !== frame.index) {
      // Do not concatenate around a missing frame. A reconnect baseline or the
      // authoritative assistant/message will reconcile the displayed prefix.
      this.active = undefined;
      return;
    }
    if (frame.type === "end") {
      this.active = undefined;
      return;
    }
    active.nextIndex += 1;
    const changed = this.append(active, frame.chunk);
    return changed ? this.prefix() : undefined;
  }

  private append(active: DeepSeekAssistantPrefix, chunk: z.infer<typeof chunkSchema>): boolean {
    if (chunk.type === "text-delta") { active.text += chunk.text as string; return true; }
    if (chunk.type === "reasoning-delta") { active.reasoning += chunk.text as string; return true; }
    return false;
  }

  private prefix(): DeepSeekAssistantPrefix | undefined {
    if (!this.active) return;
    const { attemptId, startedAfterSeq, turn, step, text, reasoning } = this.active;
    return { attemptId, startedAfterSeq, turn, step, text, reasoning };
  }
}
