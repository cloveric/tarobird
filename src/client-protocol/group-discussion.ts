import { z } from "zod";
import { conversationSchema, idSchema } from "./index.js";

export const GROUP_DISCUSSION_CAPABILITY = "groups.discussion.v1";
export const GROUP_DISCUSSION_COMPOSER_CAPABILITY = "groups.discussion.composer.v1";
/** Start participants/supersedes, note `then`/`ifRunning`, revision-tolerant
 * end/pause, recovery view fields and the discussion-mode addressing rules. */
export const GROUP_DISCUSSION_RECOVERY_CAPABILITY = "groups.discussion.recovery.v1";
export const GROUP_PARALLEL_CAPABILITY = "groups.parallel.v1";
export const GROUP_DISCUSSION_WORKER_CAPABILITY = "group-discussion.worker.v1";
export const GROUP_DISCUSSION_MIN_MEMBERS = 2;
export const GROUP_DISCUSSION_MAX_MEMBERS = 8;
export const GROUP_DISCUSSION_MAX_ROUNDS = 5;
export const GROUP_DISCUSSION_TEXT_LIMIT = 24_000;
/** Every speaking turn, including explicit retries, of one run. */
export const GROUP_DISCUSSION_MAX_STEPS = GROUP_DISCUSSION_MAX_MEMBERS * (GROUP_DISCUSSION_MAX_ROUNDS + 1);
export const GROUP_DISCUSSION_PROPOSAL_LIMIT = 4000;
export const GROUP_DISCUSSION_SUMMARY_LIMIT = 500;
/** Unseen note IDs listed in a run view; `unseenNoteCount` carries the total. */
export const GROUP_DISCUSSION_UNSEEN_NOTE_IDS = 20;
/** Fence info string of the structured position at the end of a final reply. */
export const GROUP_STANCE_FENCE = "group_stance";
/** Reject visually empty requests without stripping meaningful joiners from
 * actual prose, emoji or scripts. Historical reads remain permissive. */
export const hasVisibleGroupText = (text: string): boolean => /[^\s\p{Default_Ignorable_Code_Point}]/u.test(text);

export const groupDiscussionModeSchema = z.enum(["mentions", "parallel", "sequential", "independent"]);
export function automaticGroupDiscussion(mode: string): mode is "sequential" | "independent" {
  return mode === "sequential" || mode === "independent";
}
export const groupDiscussionPolicySchema = z.object({
  mode: groupDiscussionModeSchema,
  botOrder: z.array(idSchema).max(32).refine(ids => new Set(ids).size === ids.length),
  maxRounds: z.number().int().min(1).max(GROUP_DISCUSSION_MAX_ROUNDS),
}).strict();
export type GroupDiscussionPolicy = z.infer<typeof groupDiscussionPolicySchema>;
export function defaultGroupDiscussionPolicy(botIds: string[]): GroupDiscussionPolicy {
  return { mode: "mentions", botOrder: [...botIds], maxRounds: 3 };
}
export const groupSettingsSnapshotSchema = z.object({
  group: conversationSchema,
  policy: groupDiscussionPolicySchema,
  revision: z.string().min(1).max(128),
});
export type GroupSettingsSnapshot = z.infer<typeof groupSettingsSnapshotSchema>;

/** A Bot's own structured position. Missing or malformed blocks are never agreement. */
export const groupStanceSchema = z.object({
  stance: z.enum(["propose", "agree", "disagree", "abstain"]),
  proposalId: z.string().regex(/^P\d{1,3}$/).optional(),
  proposal: z.string().trim().min(1).max(GROUP_DISCUSSION_PROPOSAL_LIMIT).optional(),
  summary: z.string().trim().max(GROUP_DISCUSSION_SUMMARY_LIMIT).default(""),
}).strict().superRefine((value, context) => {
  if (value.stance === "propose" && !value.proposal) context.addIssue({ code: "custom", message: "proposal_required" });
  if (value.stance !== "propose" && value.proposal !== undefined) context.addIssue({ code: "custom", message: "proposal_only_for_propose" });
  if (value.stance === "agree" && !value.proposalId) context.addIssue({ code: "custom", message: "proposal_id_required" });
});
export type GroupStance = z.infer<typeof groupStanceSchema>;

export const groupDiscussionStepResultSchema = z.enum(["answered", "partial", "failed", "stopped", "interrupted", "no_reply", "unavailable", "cancelled", "worker_update_required"]);
export type GroupDiscussionStepResult = z.infer<typeof groupDiscussionStepResultSchema>;
export const groupDiscussionStepSchema = z.object({
  id: idSchema, botId: idSchema, round: z.number().int().positive(),
  phase: z.enum(["opinion", "vote"]),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "interrupted"]),
  text: z.string().max(GROUP_DISCUSSION_TEXT_LIMIT).optional(),
  /** `text` is a preview of a longer completed output (brief reads). */
  textTruncated: z.boolean().optional(),
  vote: z.enum(["agree", "disagree", "unconfirmed"]).optional(),
  error: z.string().max(256).optional(),
  // Additive fields; older readers ignore them.
  inputMessageId: idSchema.optional(),
  /** Reached the worker; it may still wait in that worker's Core queue. */
  dispatched: z.boolean().optional(),
  position: z.number().int().nonnegative().optional(),
  attempt: z.number().int().positive().optional(),
  /** First independent round: other members' answers are withheld from this Bot. */
  blind: z.boolean().optional(),
  result: groupDiscussionStepResultSchema.optional(),
  stance: z.object({ kind: groupStanceSchema.shape.stance, proposalId: z.string().max(16).optional(), summary: z.string().max(GROUP_DISCUSSION_SUMMARY_LIMIT).optional() }).optional(),
  /** Live engine turn waits for the user (approval or question card). */
  attention: z.enum(["approval", "answer"]).optional(),
  startedAt: z.number().optional(), finishedAt: z.number().optional(),
});
export type GroupDiscussionStep = z.infer<typeof groupDiscussionStepSchema>;
export const groupDiscussionActionSchema = z.enum(["pause", "resume", "end", "retry"]);
export type GroupDiscussionAction = z.infer<typeof groupDiscussionActionSchema>;
export const groupDiscussionRunSchema = z.object({
  id: idSchema, conversationId: idSchema, revision: z.string().min(1).max(128),
  mode: z.enum(["sequential", "independent"]), topic: z.string().max(GROUP_DISCUSSION_TEXT_LIMIT),
  status: z.enum(["running", "pausing", "paused", "ending", "completed", "ended", "failed", "interrupted"]),
  phase: z.enum(["opinion", "vote", "finished"]),
  round: z.number().int().positive(), maxRounds: z.number().int().positive(),
  participants: z.array(z.object({ botId: idSchema, name: z.string(), active: z.boolean().optional() })).max(GROUP_DISCUSSION_MAX_MEMBERS),
  currentBotId: idSchema.optional(),
  steps: z.array(groupDiscussionStepSchema).max(GROUP_DISCUSSION_MAX_STEPS),
  outcome: z.enum(["consensus", "different_views", "stopped", "failed", "interrupted"]).optional(),
  conclusion: z.string().max(GROUP_DISCUSSION_TEXT_LIMIT).optional(),
  error: z.string().max(256).optional(),
  createdAt: z.number(), finishedAt: z.number().optional(),
  // Additive fields; older readers ignore them.
  groupId: idSchema.optional(),
  topicMessageId: idSchema.optional(),
  createdBy: idSchema.optional(),
  /** blind: first independent round, answers withheld from members; discussion: sequential speaking. */
  stage: z.enum(["blind", "discussion"]).optional(),
  currentBotIds: z.array(idSchema).max(GROUP_DISCUSSION_MAX_MEMBERS).optional(),
  pauseReason: z.string().max(64).optional(),
  proposal: z.object({ id: z.string().max(16), botId: idSchema, text: z.string().max(GROUP_DISCUSSION_PROPOSAL_LIMIT) }).optional(),
  /** Actions this reader may submit now; never a substitute for the Hub's own checks. */
  actions: z.array(groupDiscussionActionSchema).max(4).optional(),
  /** Each member's latest structured position (the consensus evidence). */
  positions: z.array(z.object({
    botId: idSchema, stance: groupStanceSchema.shape.stance.or(z.literal("none")), proposalId: z.string().max(16).optional(),
    summary: z.string().max(GROUP_DISCUSSION_SUMMARY_LIMIT).optional(), turnId: idSchema.optional(), agreesWithProposal: z.boolean(),
  })).max(GROUP_DISCUSSION_MAX_MEMBERS).optional(),
  /** Step texts were shortened for a brief read; fetch a step for its full text. */
  brief: z.boolean().optional(),
  // Recovery fields (groups.discussion.recovery.v1).
  /** User notes bound to this run, and the newest one (text preview only). */
  noteCount: z.number().int().nonnegative().optional(),
  latestNote: z.object({ messageId: idSchema, text: z.string().max(500) }).optional(),
  /** Notes no scheduled turn has received yet; at a terminal run, notes no Bot ever saw. */
  unseenNoteCount: z.number().int().nonnegative().optional(),
  unseenNotes: z.array(idSchema).max(GROUP_DISCUSSION_UNSEEN_NOTE_IDS).optional(),
  /** The speaking slot Continue (or normal progress) schedules next; absent when none remains. */
  next: z.object({ botId: idSchema, round: z.number().int().positive(), position: z.number().int().nonnegative() }).optional(),
  /** Unfinished turns that Retry re-runs (every unacknowledged first-round failure at once). */
  retryTargets: z.array(z.object({ stepId: idSchema, botId: idSchema, round: z.number().int().positive(), position: z.number().int().nonnegative() })).max(GROUP_DISCUSSION_MAX_MEMBERS).optional(),
});
export type GroupDiscussionRun = z.infer<typeof groupDiscussionRunSchema>;
export const groupDiscussionViewSchema = z.object({
  settings: groupSettingsSnapshotSchema, run: groupDiscussionRunSchema.nullable(),
  /** Opaque reader-specific cache token; older Hosts/clients omit or ignore it. */
  viewRevision: z.string().min(1).max(260).optional(),
});
export type GroupDiscussionView = z.infer<typeof groupDiscussionViewSchema>;
export const groupDiscussionStartSchema = z.object({
  requestId: idSchema, revision: z.string().min(1).max(128),
  text: z.string().trim().min(1).max(GROUP_DISCUSSION_TEXT_LIMIT),
  attachments: z.array(idSchema).max(16).optional(),
  replyTo: idSchema.optional(),
  /** This run's speakers: a subset of the saved order, which they keep. Omitted = every member. */
  participants: z.array(idSchema).min(GROUP_DISCUSSION_MIN_MEMBERS).max(GROUP_DISCUSSION_MAX_MEMBERS).refine(ids => new Set(ids).size === ids.length, "participants_duplicate").optional(),
  /** Atomically end this paused run (no speaking turn) and start the new topic. */
  supersedes: z.object({ runId: idSchema }).strict().optional(),
}).strict();
export type GroupDiscussionStart = z.infer<typeof groupDiscussionStartSchema>;
export const groupDiscussionNoteSchema = z.object({
  requestId: idSchema, text: z.string().max(GROUP_DISCUSSION_TEXT_LIMIT),
  attachments: z.array(idSchema).max(16).default([]), replyTo: idSchema.optional(),
  /** Store the note and apply this control in one transaction; either both happen or neither. */
  then: z.enum(["resume", "retry"]).optional(),
  /** Run revision for `then` (the same CAS as the control API). */
  revision: z.string().min(1).max(128).optional(),
  /** Reject instead of storing when the run is no longer running (e.g. paused on another device). */
  ifRunning: z.literal(true).optional(),
}).strict().refine(value => !!value.text.trim() || !!value.attachments.length, "empty_message")
  .refine(value => !value.then === !value.revision, "note_then_revision_pair")
  .refine(value => !(value.then && value.ifRunning), "note_then_if_running");
export const groupDiscussionControlSchema = z.object({
  requestId: idSchema, revision: z.string().min(1).max(128),
  action: groupDiscussionActionSchema,
}).strict();
export type GroupDiscussionControl = z.infer<typeof groupDiscussionControlSchema>;
export function groupDiscussionActive(run: GroupDiscussionRun): boolean {
  return ["running", "pausing", "paused", "ending"].includes(run.status);
}

/** Hub -> worker metadata for one discussion input. Built and frozen by the Hub
 * when the turn is created; the worker never derives it from message text. */
const referenceSchema = z.object({
  botId: idSchema, name: z.string().max(256), round: z.number().int().positive(),
  text: z.string().max(GROUP_DISCUSSION_TEXT_LIMIT), truncated: z.boolean().optional(),
}).strict();
export const groupDiscussionDispatchSchema = z.object({
  v: z.literal(1), runId: idSchema, turnId: idSchema, conversationId: idSchema,
  mode: z.enum(["sequential", "independent"]), stage: z.enum(["blind", "discussion"]),
  round: z.number().int().positive(), maxRounds: z.number().int().positive(),
  position: z.number().int().nonnegative(), attempt: z.number().int().positive(),
  self: z.object({ botId: idSchema, name: z.string().max(256) }).strict(),
  participants: z.array(z.object({ botId: idSchema, name: z.string().max(256) }).strict()).min(1).max(GROUP_DISCUSSION_MAX_MEMBERS),
  topic: z.string().max(GROUP_DISCUSSION_TEXT_LIMIT),
  topicAttachments: z.array(z.string().max(256)).max(16),
  references: z.array(referenceSchema).max(GROUP_DISCUSSION_MAX_STEPS),
  /** Older unseen member texts left out to respect the context bound. */
  omittedReferences: z.number().int().positive().optional(),
  positions: z.array(z.object({ botId: idSchema, name: z.string().max(256), stance: groupStanceSchema.shape.stance.or(z.literal("none")), proposalId: z.string().max(16).optional(), summary: z.string().max(GROUP_DISCUSSION_SUMMARY_LIMIT).optional() }).strict()).max(GROUP_DISCUSSION_MAX_MEMBERS),
  proposal: z.object({ id: z.string().max(16), botId: idSchema, name: z.string().max(256), text: z.string().max(GROUP_DISCUSSION_PROPOSAL_LIMIT) }).strict().optional(),
  notes: z.array(z.string().max(2000)).max(10),
  remainingRounds: z.number().int().nonnegative(),
}).strict();
export type GroupDiscussionDispatch = z.infer<typeof groupDiscussionDispatchSchema>;
/** Worker -> Hub: the engine's completed final text for this input, with the
 * trailing position block removed and parsed. The Hub accepts it only for the
 * reporting Bot's own dispatched turn. */
export const groupDiscussionReportSchema = z.object({
  messageId: idSchema, turnId: idSchema,
  text: z.string().max(GROUP_DISCUSSION_TEXT_LIMIT), truncated: z.boolean().optional(),
  stance: groupStanceSchema.optional(),
}).strict();
export type GroupDiscussionReport = z.infer<typeof groupDiscussionReportSchema>;
