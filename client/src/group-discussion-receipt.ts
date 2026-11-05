import { z } from "zod";
import { groupDiscussionStartSchema } from "../../src/client-protocol/group-discussion.js";

/** A topic-dialog receipt pins the original request before HTTP. Upload IDs
 * belong to this conversation; reloading must not upload them under a new ID. */
export const discussionStartReceiptSchema = z.object({
  version: z.literal(1), body: groupDiscussionStartSchema,
  draftText: z.string(), fileRevision: z.string().optional(),
}).strict();
export type DiscussionStartReceipt = z.infer<typeof discussionStartReceiptSchema>;
export const discussionStartReceiptKey = (conversationId: string) => `group-discussion-start:${conversationId}`;
