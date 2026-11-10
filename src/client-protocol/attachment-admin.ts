import { z } from "zod";

// Self-contained on purpose: index.ts imports the capability from here, so this
// module must not import index.ts (an import cycle would leave schemas undefined).
const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** Owner-only attachment management (File Center › 附件管理, `tarobot attachments`).
 * Advertised in `ready.serverCapabilities`; older Hubs omit it. */
export const ATTACHMENT_ADMIN_CAPABILITY = "attachments.admin.v1";
export const ATTACHMENT_ADMIN_SUMMARY_PATH = "/api/attachment-admin/summary";
export const ATTACHMENT_ADMIN_LIST_PATH = "/api/attachment-admin/list";
export const ATTACHMENT_ADMIN_DELETE_PATH = "/api/attachment-admin/delete";
export const ATTACHMENT_ADMIN_PAGE_SIZE = 100;
/** One delete request may name at most this many attachments. */
export const ATTACHMENT_ADMIN_DELETE_LIMIT = 500;

const bytes = z.number().int().nonnegative().safe();
export const attachmentAdminConversationSchema = z.object({
  conversationId: idSchema, title: z.string(), count: z.number().int().nonnegative(), bytes,
}).strict();
export const attachmentAdminSummarySchema = z.object({
  count: z.number().int().nonnegative(), bytes, conversations: z.array(attachmentAdminConversationSchema).max(10_000),
}).strict();
export type AttachmentAdminSummary = z.infer<typeof attachmentAdminSummarySchema>;

export const attachmentAdminSortSchema = z.enum(["size", "time"]);
export const attachmentAdminListQuerySchema = z.object({
  conversationId: idSchema, sort: attachmentAdminSortSchema.default("size"),
  offset: z.coerce.number().int().nonnegative().max(1_000_000).default(0),
}).strict();
export type AttachmentAdminListQuery = z.infer<typeof attachmentAdminListQuerySchema>;
export const attachmentAdminItemSchema = z.object({
  id: idSchema, conversationId: idSchema, name: z.string(), mime: z.string(), size: bytes,
  createdAt: z.number().int().safe(),
  /** Earliest message that shares it; the attachment can appear in several. */
  messageId: idSchema,
  /** A Bot has not finished the message yet; deleting is refused until it does. */
  pending: z.boolean(),
}).strict();
export type AttachmentAdminItem = z.infer<typeof attachmentAdminItemSchema>;
export const attachmentAdminListSchema = z.object({
  items: z.array(attachmentAdminItemSchema).max(ATTACHMENT_ADMIN_PAGE_SIZE), total: z.number().int().nonnegative(),
}).strict();
export type AttachmentAdminList = z.infer<typeof attachmentAdminListSchema>;

/** Exactly one of `ids` or `conversationId` (= every attachment in that chat). */
export const attachmentAdminDeleteSchema = z.object({
  ids: z.array(idSchema).min(1).max(ATTACHMENT_ADMIN_DELETE_LIMIT).optional(),
  conversationId: idSchema.optional(),
}).strict().refine(value => (value.ids === undefined) !== (value.conversationId === undefined), { message: "ids_or_conversation" });
export type AttachmentAdminDelete = z.infer<typeof attachmentAdminDeleteSchema>;
export const attachmentAdminDeleteResultSchema = z.object({
  deleted: z.number().int().nonnegative(), freedBytes: bytes,
  /** Exactly the attachments retired by this request (for local cache eviction). */
  ids: z.array(idSchema).max(1_000_000),
  /** Still referenced by a message a Bot has not finished; nothing was changed for these. */
  pending: z.array(idSchema).max(ATTACHMENT_ADMIN_DELETE_LIMIT * 20),
}).strict();
export type AttachmentAdminDeleteResult = z.infer<typeof attachmentAdminDeleteResultSchema>;
