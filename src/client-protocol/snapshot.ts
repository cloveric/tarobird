import { z } from "zod";
import { conversationSchema, idSchema, messageSchema } from "./index.js";

export const SNAPSHOT_EVENT_THRESHOLD = 1000;
export const SNAPSHOT_ACTIVITY_CAPABILITY = "snapshot.activity.v1";
export const SNAPSHOT_DELTA_CAPABILITY = "snapshot.delta.v1";
export const SYNC_LINEAGE_CAPABILITY = "sync.lineage.v1";
export const CONVERSATION_SYNC_CAPABILITY = "sync.conversations.v1";
export const SNAPSHOT_DELTA_THRESHOLD = 64;
const integer = z.number().int().nonnegative().safe();
export const snapshotFrameSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("snapshot.begin"), id: idSchema, conversation: conversationSchema, seq: integer, after: integer, readSeq: integer, lineage: z.string().uuid().optional(), mode: z.literal("merge").optional() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("snapshot.message"), id: idSchema, index: integer, message: messageSchema, contentSeq: integer, contentAt: z.number().int().optional(), unreadSeq: integer }).strict(),
  z.object({ v: z.literal(1), type: z.literal("snapshot.end"), id: idSchema, count: integer }).strict(),
]);
export type SnapshotFrame = z.infer<typeof snapshotFrameSchema>;
export type SnapshotBegin = Extract<SnapshotFrame, { type: "snapshot.begin" }>;
