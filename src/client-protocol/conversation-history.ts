import { z } from "zod";

/** Host/worker history support. Native operations remain engine-specific. */
export const CONVERSATION_HISTORY_CAPABILITY = "conversations.history.v1";
/** Query opt-in for extended reasons (`side_session`): older v1.6.0 clients parse `historyReasonSchema` strictly without it. */
export const HISTORY_SIDE_REASON_QUERY = "sideReason";
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const historyBoundarySchema = z.enum(["before-input", "after-turn"]);
export const historyReasonSchema = z.enum([
  "unsupported", "wrong_scope", "not_ready", "busy", "queued", "goal_active",
  "background_work", "side_session", "shared_session", "binding_pending", "outcome_unknown",
  "source_changed", "source_missing", "anchor_unavailable", "request_conflict", "storage_unavailable",
  "uncertain", "cancelled",
]);
/** Client-side decoder accepting known reasons and future identifier-shaped reason codes so newer clients never lock out on upgrades. */
export const historyClientReasonSchema = z.union([historyReasonSchema, id]);
export function compatHistoryReason(reason: HistoryReason | undefined, allowSideReason: boolean): HistoryReason | undefined {
  return !allowSideReason && reason === "side_session" ? "background_work" : reason;
}
export const historyCapabilitiesSchema = z.object({
  rewind: z.boolean(), fork: z.boolean(), anchoredFork: z.boolean(),
}).strict();
export const historySnapshotSchema = z.object({
  supported: z.boolean(), revision: id.optional(),
  capabilities: historyCapabilitiesSchema.optional(), blocked: historyReasonSchema.optional(),
  pendingOperation: id.optional(),
}).strict();
export const historyAnchorSchema = z.object({
  id, messageId: id, rewind: z.boolean(), fork: z.boolean(),
  forkBoundary: historyBoundarySchema.optional(),
}).strict();
export const historyAnchorPageSchema = z.object({
  anchors: z.array(historyAnchorSchema).max(100), next: id.optional(),
}).strict();
const forkTitle = z.string().trim().min(1).max(256).optional();
/** A default fork title, numbered when the same title is already taken
 * (" 2", " 3", …). Shared by the App and the Host so both number alike. */
export function numberedForkTitle(base: string, taken: Iterable<string>): string {
  const used = new Set(taken), fit = (suffix: string) => `${base.slice(0, 256 - suffix.length)}${suffix}`;
  if (!used.has(fit(""))) return fit("");
  for (let n = 2; ; n++) if (!used.has(fit(` ${n}`))) return fit(` ${n}`);
}
export const historyActionSchema = z.union([
  z.object({ kind: z.literal("rewind"), anchorId: id }).strict(),
  z.object({ kind: z.literal("fork"), scope: z.literal("whole"), title: forkTitle }).strict(),
  z.object({ kind: z.literal("fork"), scope: z.literal("anchor"), anchorId: id, title: forkTitle }).strict(),
]);
export const historyChangeSchema = z.object({
  botId: id, requestId: id, expectedRevision: id, action: historyActionSchema,
}).strict();
export const historyOperationSchema = z.object({
  requestId: id, operationId: id,
  state: z.enum(["pending", "applied", "rejected", "unknown"]),
  reason: historyReasonSchema.optional(), sourceRevision: id,
  resultingRevision: id.optional(), destinationConversationId: id.optional(), sourceEventSeq: z.number().int().positive().optional(),
}).strict();
/** Host-owned display metadata; clients cannot assign these fields. */
export const historyContextSchema = z.object({ excludedBy: id }).strict();
export const historyOriginSchema = z.object({
  operationId: id, sourceConversationId: id, sourceMessageId: id.optional(),
  sourceRevision: id, boundary: z.enum(["whole", "before-input", "after-turn"]),
}).strict();
/** Private Hub/Gateway result, never sent directly to an App. */
export const historyNativeResultSchema = z.object({
  outcome: z.enum(["applied", "rejected", "unknown"]), reason: historyReasonSchema.optional(),
  sourceSessionId: z.string().min(1).max(4096).optional(),
  destinationSessionId: z.string().min(1).max(4096).optional(), nativeHead: z.string().max(4096).optional(),
  excludedNativeInputIds: z.array(z.string().min(1).max(4096)).max(100000).optional(),
  forkBoundary: historyBoundarySchema.optional(),
}).strict();
export const historyInternalSnapshotSchema = historySnapshotSchema.extend({
  sourceSessionId: z.string().min(1).max(4096).optional(), bindingGeneration: id.optional(),
});
export const historyNativeAnchorSchema = z.object({
  sessionId: z.string().min(1).max(4096), inputId: z.string().min(1).max(4096),
  rewind: z.boolean(), fork: z.boolean(), forkBoundary: historyBoundarySchema.optional(),
  data: z.record(z.string().max(128), z.union([z.string().max(4096), z.number().finite(), z.null()])).optional(),
}).strict().refine(value => !value.fork || value.forkBoundary !== undefined, "history_fork_boundary_missing");
export const historyAnchorEvidenceSchema = z.object({
  conversationId: id, messageId: id, sessionId: z.string().min(1).max(4096),
  bindingGeneration: id, revision: id, nativeAnchor: historyNativeAnchorSchema,
}).strict().refine(value => JSON.stringify(value.nativeAnchor).length <= 16384, "history_anchor_too_large")
  .refine(value => value.sessionId === value.nativeAnchor.sessionId, "history_anchor_session_mismatch");
export const historyClientSnapshotSchema = historySnapshotSchema.extend({ blocked: historyClientReasonSchema.optional() }).strict();
export const historyClientOperationSchema = historyOperationSchema.extend({ reason: historyClientReasonSchema.optional() }).strict();
export type HistoryBoundary = z.infer<typeof historyBoundarySchema>;
export type HistoryReason = z.infer<typeof historyReasonSchema>;
export type HistoryClientReason = z.infer<typeof historyClientReasonSchema>;
export type HistoryCapabilities = z.infer<typeof historyCapabilitiesSchema>;
export type HistorySnapshot = z.infer<typeof historySnapshotSchema>;
export type HistoryClientSnapshot = z.infer<typeof historyClientSnapshotSchema>;
export type HistoryAnchor = z.infer<typeof historyAnchorSchema>;
export type HistoryAnchorPage = z.infer<typeof historyAnchorPageSchema>;
export type HistoryAction = z.infer<typeof historyActionSchema>;
export type HistoryChange = z.infer<typeof historyChangeSchema>;
export type HistoryOperation = z.infer<typeof historyOperationSchema>;
export type HistoryClientOperation = z.infer<typeof historyClientOperationSchema>;
export type HistoryContext = z.infer<typeof historyContextSchema>;
export type HistoryOrigin = z.infer<typeof historyOriginSchema>;
export type HistoryNativeResult = z.infer<typeof historyNativeResultSchema>;
export type HistoryInternalSnapshot = z.infer<typeof historyInternalSnapshotSchema>;
export type HistoryAnchorEvidence = z.infer<typeof historyAnchorEvidenceSchema>;
