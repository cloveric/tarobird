import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import type { CardElement, Message } from "../../src/client-protocol/index.js";

const questionSchema = z.object({
  question: z.string(), header: z.string(), multiSelect: z.boolean(), required: z.boolean(), allowFreeText: z.boolean(),
  minSelections: z.number().int().nonnegative().optional(), maxSelections: z.number().int().nonnegative().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() })).max(100),
});
const formSchema = z.object({ version: z.literal(1), requestId: z.string(), questions: z.array(questionSchema).min(1).max(100), notice: z.string().optional() });
export type Question = z.infer<typeof questionSchema>;
export type QuestionData = z.infer<typeof formSchema>;
export function nativeQuestionData(element: CardElement): QuestionData | undefined {
  const result = formSchema.safeParse(element.extra?.tarocub_questions);
  return result.success && element.children?.some((e) => e.name === "askq_submit" && e.extra?.form_action_type === "submit") ? result.data : undefined;
}
export const questionDraftSchema = z.object({
  values: z.record(z.string().regex(/^q\d+(?:_other)?$/), z.union([z.string().max(16000), z.array(z.string().max(128)).max(100)])),
  step: z.number().int().min(0).max(99),
});
export type QuestionDraft = z.infer<typeof questionDraftSchema>;
export const questionDraftPrefix = (messageId: string) => `question-draft:${messageId}:`;
export function questionDraftKey(messageId: string, data: QuestionData): string {
  // Notices may change without invalidating an answer. Changed prompts/options,
  // selection limits or request identity must never inherit another form's edits.
  return questionDraftPrefix(messageId) + bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([data.requestId, data.questions]))));
}
export function activeQuestionDrafts(message: Message): Set<string> {
  const keys = new Set<string>();
  if (message.status === "deleted") return keys;
  const visit = (elements: CardElement[]) => { for (const e of elements) {
    if (e.type === "form" && !e.disabled) {
      const data = nativeQuestionData(e);
      if (data && e.children?.some((child) => child.name === "askq_submit" && !child.disabled)) keys.add(questionDraftKey(message.id, data));
    }
    visit(e.children ?? []);
  } };
  for (const block of message.blocks) if (block.type === "card") visit(block.elements);
  return keys;
}
