import { z } from "zod";
import { idSchema } from "./index.js";
import { searchCursorSchema } from "./search.js";

export const CONVERSATION_FILES_PAGE_SIZE = 50;
export const conversationFilesQuerySchema = z.object({
  conversationId: idSchema, botId: idSchema.optional(),
  q: z.string().max(256).refine(value => !value.includes("\0")).default(""),
  cursor: searchCursorSchema.optional(),
}).strict();
export type ConversationFilesQuery = z.infer<typeof conversationFilesQuerySchema>;
export const conversationFileSchema = z.object({
  attachmentId: idSchema, messageId: idSchema, conversationId: idSchema,
  conversationTitle: z.string(), name: z.string(), mime: z.string(), size: z.number().int().nonnegative(),
  authorId: idSchema, authorType: z.enum(["user", "bot", "system"]), authorName: z.string(), createdAt: z.number().int().safe(),
}).strict();
export const conversationFilesPageSchema = z.object({
  items: z.array(conversationFileSchema).max(CONVERSATION_FILES_PAGE_SIZE), nextCursor: searchCursorSchema.nullable(),
}).strict();
export type ConversationFile = z.infer<typeof conversationFileSchema>;
export type ConversationFilesPage = z.infer<typeof conversationFilesPageSchema>;
