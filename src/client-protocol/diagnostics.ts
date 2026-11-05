import { z } from "zod";

export const diagnosticQuerySchema = z.object({
  source: z.enum(["audit", "timeline"]).default("timeline"),
  type: z.string().trim().max(160).optional(), outcome: z.string().trim().max(80).optional(),
  channel: z.enum(["gateway", "lark", "telegram", "bus", "hub"]).optional(),
  chat: z.string().trim().max(200).optional(), search: z.string().trim().max(200).optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  before: z.string().regex(/^[a-f0-9]{32}$|^hub_[0-9]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
}).strict().refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), "invalid date range");
export type DiagnosticQuery = z.infer<typeof diagnosticQuerySchema>;
export const diagnosticEventSchema = z.object({
  id: z.string(), timestamp: z.string(), type: z.string(), outcome: z.string(), channel: z.string(),
  conversation: z.string(), chatId: z.string().default(""), actor: z.string(), detail: z.string(), metadata: z.string(), truncated: z.boolean(),
});
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;
export const diagnosticPageSchema = z.object({
  events: z.array(diagnosticEventSchema).max(50), next: z.string().nullable(), generatedAt: z.iso.datetime(),
  total: z.number().int().nonnegative(), matched: z.number().int().nonnegative(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  lastSuccessAt: z.string().optional(), lastErrorAt: z.string().optional(),
  types: z.array(z.string()), outcomes: z.array(z.string()), channels: z.array(z.string()),
  warnings: z.array(z.string()), missing: z.boolean(), cursorExpired: z.boolean(),
});
export type DiagnosticPage = z.infer<typeof diagnosticPageSchema>;
