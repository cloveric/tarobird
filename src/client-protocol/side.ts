import { z } from "zod";

export const SIDE_CAPABILITY = "conversations.side.v1";
export const SIDE_QUESTION_LIMIT = 16_000;
export const SIDE_ANSWER_LIMIT = 96_000;
export const SIDE_HISTORY_LIMIT = 200_000;
export const SIDE_LEASE_MS = 90_000;
export const SIDE_ATTACHMENT_COUNT_LIMIT = 8;
export const SIDE_ATTACHMENT_FILE_BYTES = 64 * 1024 * 1024;
export const SIDE_ATTACHMENT_IMAGE_BYTES = 20 * 1024 * 1024;
export const SIDE_ATTACHMENT_TOTAL_BYTES = 128 * 1024 * 1024;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const sideErrorSchema = z.enum(["unsupported", "no_main_session", "busy", "limit_reached", "budget_exhausted", "expired", "cancelled", "failed", "attachment_unavailable", "attachment_unsupported", "attachment_too_large"]);
/** Returned only to status requests that opt in with `attachments=1`: older
 * strict clients must never receive a key they cannot parse. `audio` likewise
 * needs `audio=1`: the Gateway transcribes audio with the host ASR before the
 * model sees it; it never means the engine itself can listen. */
export const sideAttachmentCapabilitySchema = z.object({ images: z.boolean(), files: z.enum(["any", "text"]), maxCount: z.number().int().positive(), maxFileBytes: z.number().int().positive(), maxImageBytes: z.number().int().positive(), maxTotalBytes: z.number().int().positive(), audio: z.literal(true).optional() }).strict();
// `inherited` is opt-in via tools=1 on status and tools:"inherited" on open.
// Legacy callers retain their read-only capability and native handle.
export const sideCapabilitySchema = z.object({ supported: z.boolean(), concurrent: z.boolean(), liveContext: z.boolean(), tools: z.enum(["read-only", "none", "inherited"]), delivery: z.literal(true).optional(), usage: z.literal("unavailable").optional(), attachments: sideAttachmentCapabilitySchema.optional(), reason: sideErrorSchema.optional() }).strict();
export const sideScopeSchema = z.object({ conversationId: id, userId: id, deviceId: id }).strict();
export const sideOpenSchema = z.object({ botId: id, requestId: id, tools: z.literal("inherited").optional(), delivery: z.literal(true).optional() }).strict();
/** Upload IDs only; the Hub resolves them to the caller's own completed files. */
export const sideAttachmentIdsSchema = z.array(id).min(1).max(SIDE_ATTACHMENT_COUNT_LIMIT).refine(ids => new Set(ids).size === ids.length, "duplicate_attachment");
export const sideAskSchema = z.object({ botId: id, requestId: id, text: z.string().trim().max(SIDE_QUESTION_LIMIT).default(""), attachments: sideAttachmentIdsSchema.optional() }).strict()
  .refine(ask => ask.text.length > 0 || !!ask.attachments?.length, { message: "empty_question", path: ["text"] });
/** Hub-resolved metadata the Gateway uses to fetch and verify each file. */
export const sideAttachmentRefSchema = z.object({ id, name: z.string().min(1).max(1024), mime: z.string().min(1).max(255), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
/** Display metadata, shaped like the message image/file blocks. */
export const sideExchangeAttachmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), attachmentId: id, title: z.string().max(1024) }).strict(),
  z.object({ type: z.literal("file"), attachmentId: id, name: z.string().max(1024), size: z.number().int().nonnegative(), mime: z.string().max(255) }).strict(),
]);
/** Only handles opened with delivery:true may return these ephemeral outputs. */
const outputCaption = { caption: z.string().max(12_000).optional() };
const sideDeliveryAttachmentSchema = z.discriminatedUnion("type", [sideExchangeAttachmentSchema.options[0].extend(outputCaption), sideExchangeAttachmentSchema.options[1].extend(outputCaption)]);
export const sideDeliverySchema = z.object({ id, caption: z.string().max(12_000).optional(), attachments: z.array(sideDeliveryAttachmentSchema).min(1).max(50) }).strict();
export const sideExchangeSchema = z.object({ id, question: z.string().max(SIDE_QUESTION_LIMIT), answer: z.string().max(SIDE_ANSWER_LIMIT), status: z.enum(["running", "complete", "stopped", "error"]), error: sideErrorSchema.optional(), truncated: z.boolean().optional(), attachments: z.array(sideExchangeAttachmentSchema).max(SIDE_ATTACHMENT_COUNT_LIMIT).optional(), deliveries: z.array(sideDeliverySchema).max(50).optional(), partialAttachments: z.array(id).max(SIDE_ATTACHMENT_COUNT_LIMIT).optional() }).strict();
export const sideViewSchema = z.object({ id, conversationId: id, revision: z.number().int().nonnegative(), openedAt: z.number(), phase: z.enum(["preparing", "idle", "thinking", "stopping", "error"]), capability: sideCapabilitySchema, exchanges: z.array(sideExchangeSchema).max(40), omitted: z.number().int().nonnegative(), error: sideErrorSchema.optional() }).strict();
export const sidePollSchema = z.object({ revision: z.number().int().nonnegative(), view: sideViewSchema.optional() }).strict();
export const sideReplySchema = z.union([z.object({ ok: z.literal(true), view: sideViewSchema.optional(), revision: z.number().int().nonnegative().optional(), capability: sideCapabilitySchema.optional() }).strict(), z.object({ ok: z.literal(false), error: sideErrorSchema }).strict()]);
export type SideErrorCode = z.infer<typeof sideErrorSchema>;
export type SideCapabilityView = z.infer<typeof sideCapabilitySchema>;
export type SideAttachmentCapability = z.infer<typeof sideAttachmentCapabilitySchema>;
export type SideAttachmentRef = z.infer<typeof sideAttachmentRefSchema>;
export type SideExchangeAttachment = z.infer<typeof sideExchangeAttachmentSchema>;
export type SideScope = z.infer<typeof sideScopeSchema>;
export type SideView = z.infer<typeof sideViewSchema>;
export type SideReply = z.infer<typeof sideReplySchema>;
export type SideDelivery = z.infer<typeof sideDeliverySchema>;
