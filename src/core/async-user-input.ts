import { z } from "zod";
import type { Locale } from "../runtime/locale.js";

const option = z.union([z.string().trim().min(1), z.object({ label: z.string().trim().min(1), description: z.string().optional(), preview: z.string().optional() })]);
const payload = z.object({ questions: z.array(z.object({
  title: z.string().trim().min(1).optional(), question: z.string().trim().min(1).optional(),
  header: z.string().trim().min(1).optional(), options: z.array(option).max(100).nullish(),
  multiSelect: z.boolean().optional(), multi_select: z.boolean().optional(), required: z.boolean().optional(),
})).min(1).max(100) });

/** Async Codex prompts allow free text without options. Keep every question and
 * disambiguate repeated text, since the shared answer map is keyed by question. */
export function normalizeAsyncUserInput(raw: unknown, locale: Locale) {
  const source = payload.parse(raw);
  const used = new Set<string>();
  return { questions: source.questions.map((item, index) => {
    const text = item.question ?? item.title;
    if (!text) throw new Error("async_question_missing_text");
    let question = text;
    while (used.has(question)) question += ` (${index + 1})`;
    used.add(question);
    return { question, header: item.header ?? (locale === "en" ? `Question ${index + 1}` : `问题 ${index + 1}`),
      options: item.options ?? [], multiSelect: item.multiSelect ?? item.multi_select ?? false,
      required: item.required !== false, allowFreeText: true };
  }) };
}
