import { z } from "zod";
import { idSchema } from "./index.js";
import { MAX_DELETE_MESSAGES } from "./message-deletion.js";

/** Personal history clearing: repeated personal deletions up to a fixed cutoff. */
export const MESSAGE_CLEAR_CAPABILITY = "messages.clear.v1";
export const MAX_CLEAR_MESSAGES = MAX_DELETE_MESSAGES;
const count = z.number().int().nonnegative().safe();
export const clearMessagesPlanSchema = z.object({ throughId: idSchema.optional(), count }).strict();
export const clearMessagesInputSchema = z.object({ throughId: idSchema }).strict();
/** `seq` is the conversation head when the page committed, also for an empty
 * page: a device has applied this page once its cursor reaches it. */
export const clearMessagesResultSchema = z.object({ throughId: idSchema, clearedIds: z.array(idSchema).max(MAX_CLEAR_MESSAGES), remaining: count, seq: count }).strict();
export type ClearMessagesPlan = z.infer<typeof clearMessagesPlanSchema>;
export type ClearMessagesInput = z.infer<typeof clearMessagesInputSchema>;
export type ClearMessagesResult = z.infer<typeof clearMessagesResultSchema>;
/** Raised for the whole page, before any write, when it reaches unfinished work. */
export const MESSAGE_CLEAR_ACTIVE = "message_clear_active";

// Mirrors client/src/question-draft.ts nativeQuestionData and
// client/src/attention.ts messageAttention, so the Host refuses exactly the
// questions and approvals an App still offers as actionable.
const questionSchema = z.object({
  question: z.string(), header: z.string(), multiSelect: z.boolean(), required: z.boolean(), allowFreeText: z.boolean(),
  minSelections: z.number().int().nonnegative().optional(), maxSelections: z.number().int().nonnegative().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() })).max(100),
});
const questionFormSchema = z.object({ version: z.literal(1), requestId: z.string(), questions: z.array(questionSchema).min(1).max(100), notice: z.string().optional() });
type Node = { type?: unknown; disabled?: unknown; actionId?: unknown; url?: unknown; name?: unknown; value?: unknown; extra?: unknown; children?: unknown };
const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.filter((item): item is Node => !!item && typeof item === "object" && !Array.isArray(item)) : [];
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** Card blocks of a Bot message (not forwarded, not deleted/error) that still
 * carry an enabled question or approval action. Disabled ancestors close it. */
export function hasPendingCardAction(blocks: unknown): boolean {
  const visit = (elements: Node[]): boolean => elements.some(element => {
    if (element.disabled) return false;
    const children = nodes(element.children);
    if (element.type === "form" && questionFormSchema.safeParse(record(element.extra)?.tarocub_questions).success
      && children.some(child => child.name === "askq_submit" && record(child.extra)?.form_action_type === "submit")
      && children.some(child => child.type === "button" && child.name === "askq_submit" && child.actionId && !child.disabled && !child.url)) return true;
    const value = record(element.value);
    if (element.type === "button" && element.actionId && !element.url && typeof value?.requestId === "string" && value.requestId
      && (value.cctb_lark === "ask_user_question" && value.action === "form_submit"
        || value.cctb_lark === "approval" && ["allow_once", "allow_session", "deny"].includes(String(value.decision)))) return true;
    return visit(children);
  });
  return nodes(blocks).some(block => block.type === "card" && visit(nodes((block as { elements?: unknown }).elements)));
}
