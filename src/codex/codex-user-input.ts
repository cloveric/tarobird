import { z } from "zod";
import type { EngineApprovalDecision } from "./adapter.js";

// Derived from codex-cli 0.159.3's generated ToolRequestUserInput{Params,Response}.
// This is an answer request, never a tool authorization or a session grant.
const questionSchema = z.object({
  id: z.string().min(1).max(256),
  header: z.string().max(256),
  question: z.string().trim().min(1).max(16_000),
  isOther: z.boolean().default(false),
  isSecret: z.boolean().default(false),
  options: z.array(z.object({ label: z.string().trim().min(1).max(1000), description: z.string().max(4000) })).max(100).nullish(),
});
const requestSchema = z.object({
  threadId: z.string().min(1), turnId: z.string().min(1), itemId: z.string().min(1),
  isBlocking: z.boolean().optional(),
  questions: z.array(questionSchema).min(1).max(20),
}).refine((value) => new Set(value.questions.map((q) => q.id)).size === value.questions.length);

export function normalizeCodexUserInput(value: unknown) {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success || parsed.data.questions.some((q) => q.isSecret)) return undefined;
  const keys = new Set<string>();
  const questions = parsed.data.questions.map((q) => {
    let key = q.question;
    while (keys.has(key)) key += ` (${q.id})`;
    keys.add(key);
    return { ...q, answerKey: key };
  });
  return {
    ...parsed.data,
    toolInput: { questions: questions.map((q) => ({
      question: q.answerKey, header: q.header, options: q.options ?? [],
      multiSelect: false, required: true, allowFreeText: q.isOther || !q.options?.length,
    })) },
    response(decision: EngineApprovalDecision): { answers: Record<string, { answers: string[] }> } {
      if (decision.behavior !== "allow") return { answers: {} };
      const input = z.object({ answers: z.record(z.string(), z.string().trim().min(1).max(16_000)) }).safeParse(decision.updatedInput);
      if (!input.success) return { answers: {} };
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of questions) {
        const answer = Object.hasOwn(input.data.answers, q.answerKey) ? input.data.answers[q.answerKey] : undefined;
        if (!answer || q.options?.length && !q.isOther && !q.options.some((o) => o.label === answer)) return { answers: {} };
        Object.defineProperty(answers, q.id, { value: { answers: [answer] }, enumerable: true });
      }
      return { answers };
    },
  };
}
