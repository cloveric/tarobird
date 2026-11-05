import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { networkCanonical } from "../../src/client-protocol/private-network.js";
import { workbenchTargetSchema } from "../../src/client-protocol/workbench.js";
import { designCommentsSchema, type DesignCommentThread, type DesignCommentsDoc } from "./workbench-design-comments.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const designCommentVersionsSchema = z.record(z.string().regex(/^c_[a-f0-9]{10,32}$/), z.string().regex(/^[a-f0-9]{64}$/))
  .refine(value => Object.keys(value).length <= 200, "design_comment_delivery_limit");
export const designCommentReceiptSchema = z.object({
  owner: z.string().max(8192), scope: z.string().max(4096), conversationId: id,
  target: workbenchTargetSchema.required({ tabId: true }), revision: z.number().int().nonnegative().safe(),
  versions: designCommentVersionsSchema, frameHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type DesignCommentReceipt = z.infer<typeof designCommentReceiptSchema>;
export type DesignCommentAcceptance = { messageId?: string; workbenchContextOmitted?: string };
export const designCommentReceiptKey = (clientMsgId: string) => `design-comment-receipt:${clientMsgId}`;
export const designCommentFingerprint = (value: unknown): string => bytesToHex(sha256(new TextEncoder().encode(networkCanonical(value))));
/** Freeze exactly the comment versions whose words entered the composer. */
export function designCommentVersions(threads: DesignCommentThread[]): Record<string, string> {
  const doc = designCommentsSchema.parse({ schema: 1, revision: 0, threads, receipts: [] });
  return designCommentVersionsSchema.parse(Object.fromEntries(doc.threads.map(thread => [thread.id, designCommentFingerprint(thread)])));
}
/** Authenticated message acceptance only. Changes, deleted threads and replies
 * after drafting never inherit an older message's delivery status. */
export function applyDesignCommentDelivery(raw: unknown, receipt: DesignCommentReceipt, accepted: DesignCommentAcceptance, now = new Date().toISOString()): DesignCommentsDoc | undefined {
  if (!id.safeParse(accepted.messageId).success || accepted.workbenchContextOmitted !== undefined) return;
  const doc = designCommentsSchema.parse(raw), next = structuredClone(doc);
  let changed = false;
  for (const thread of next.threads) {
    const version = receipt.versions[thread.id];
    if (!version || thread.agent?.status === "replied" || version !== designCommentFingerprint(thread)) continue;
    thread.agent = { status: "delivered", sentAt: now, deliveredAt: now, via: "chat", messageId: accepted.messageId! };
    thread.updatedAt = now; changed = true;
  }
  if (!changed) return;
  next.revision++;
  return designCommentsSchema.parse(next);
}
