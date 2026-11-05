import { z } from 'zod';
import { conversationSchema, idSchema } from './index.js';
import { conversationFoldersSchema, folderNameSchema } from './conversation-folders.js';

export const CONVERSATION_BATCH_CAPABILITY = 'conversations.batch.v1';
export const CONVERSATION_RESTORE_CAPABILITY = 'conversations.restore.v1';
export const CONVERSATION_BATCH_LIMIT = 100;
export const conversationIdsSchema = z.array(idSchema).min(1).max(CONVERSATION_BATCH_LIMIT)
  .refine(ids => new Set(ids).size === ids.length, 'Duplicate conversations');
const base = { requestId: idSchema, conversationIds: conversationIdsSchema };
export const conversationBatchSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('archive') }).strict(),
  z.object({ ...base, action: z.literal('restore') }).strict(),
  z.object({ ...base, action: z.literal('move'), revision: z.number().int().nonnegative().safe(),
    target: z.union([
      z.object({ folderId: idSchema.nullable() }).strict(),
      z.object({ newFolder: z.object({ id: idSchema, name: folderNameSchema }).strict() }).strict(),
    ]),
  }).strict(),
]);
export const conversationBatchReceiptSchema = z.object({
  requestId: idSchema, action: z.enum(['archive', 'restore', 'move']), conversationIds: conversationIdsSchema,
  completedAt: z.number().int().nonnegative(), folderId: idSchema.nullable().optional(),
});
export const conversationBatchResultSchema = z.object({
  receipt: conversationBatchReceiptSchema, replayed: z.boolean(),
  // Current state, including on receipt replay; never restore an old snapshot.
  conversations: z.array(conversationSchema).max(CONVERSATION_BATCH_LIMIT),
  folders: conversationFoldersSchema.optional(),
});
export type ConversationBatch = z.infer<typeof conversationBatchSchema>;
export type ConversationBatchReceipt = z.infer<typeof conversationBatchReceiptSchema>;
export type ConversationBatchResult = z.infer<typeof conversationBatchResultSchema>;
