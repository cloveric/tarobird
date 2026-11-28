import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const memberKey = z.string().min(1).max(260).regex(/^[A-Za-z0-9_.:-]+$/);

export const CROSS_HOST_GROUPS_CAPABILITY = "groups.cross-host.v1" as const;
export const GROUP_MAX_TOTAL_MEMBERS = 32;
export const GROUP_MAX_REMOTE_MEMBERS = 31;

export const GROUP_AVATAR_LIMIT = 9;
export const remoteGroupAvatarMemberSchema = z.object({
  memberKey: z.string().regex(/^remote:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/),
  preset: z.string().max(64).optional(),
  profile: z.object({ hostId: z.string().regex(/^hub_[a-f0-9]{64}$/), botId: id }).strict().optional(),
}).strict();
export type RemoteGroupAvatarMember = z.infer<typeof remoteGroupAvatarMemberSchema>;

export const groupHistoryVisibilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("recent"), count: z.number().int().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("all") }).strict(),
]);
export type GroupHistoryVisibility = z.infer<typeof groupHistoryVisibilitySchema>;

export const groupMemberSessionSchema = z.object({
  memberKey,
  kind: z.enum(["local", "remote"]),
  hostId: id,
  hostName: z.string().trim().min(1).max(256),
  hostPublicKey: z.string().min(16).max(256).optional(),
  botId: id,
  sessionId: id,
  sessionTitle: z.string().trim().min(1).max(256),
  nameSnapshot: z.string().trim().min(1).max(256),
  avatarSnapshot: z.string().max(512).optional(),
  engineSnapshot: z.string().max(64).default("codex"),
  joinedAt: z.number().int(),
  joinedAfterSeq: z.number().int().nonnegative(),
  historyVisibility: groupHistoryVisibilitySchema,
  active: z.boolean().default(true),
  removedAt: z.number().int().optional(),
}).strict();
export type GroupMemberSession = z.infer<typeof groupMemberSessionSchema>;

export const groupFormerSessionSchema = z.object({
  sessionId: id,
  memberKey,
  botId: id,
  hostId: id,
  revokedAt: z.number().int(),
}).strict();
export type GroupFormerSession = z.infer<typeof groupFormerSessionSchema>;

export const remoteGroupQuestionStatusSchema = z.enum(["sending", "delivered", "failed", "uncertain"]);
export type RemoteGroupQuestionStatus = z.infer<typeof remoteGroupQuestionStatusSchema>;

export const remoteGroupQuestionSchema = z.object({
  id,
  groupId: id,
  conversationId: id,
  memberKey,
  hostId: id,
  hostName: z.string().max(256),
  botId: id,
  sessionId: id,
  botNameSnapshot: z.string().max(256),
  sourceMessageId: id,
  requestId: id,
  status: remoteGroupQuestionStatusSchema,
  stoppedUnanswered: z.boolean().default(false),
  error: z.string().max(512).optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  answeredAt: z.number().int().optional(),
  answerMessageId: id.optional(),
}).strict();
export type RemoteGroupQuestion = z.infer<typeof remoteGroupQuestionSchema>;

export const groupSessionCandidateSchema = z.object({
  sessionId: id,
  title: z.string().max(256),
  createdAt: z.number().int(),
}).strict();
export type GroupSessionCandidate = z.infer<typeof groupSessionCandidateSchema>;

export const groupPeerBotSchema = z.object({
  hostId: id,
  hostName: z.string().max(256),
  hostPublicKey: z.string().max(256).optional(),
  online: z.boolean(),
  botId: id,
  name: z.string().max(256),
  engine: z.string().max(64),
  avatar: z.string().max(512).optional(),
  sessions: z.array(groupSessionCandidateSchema).max(64),
}).strict();
export type GroupPeerBot = z.infer<typeof groupPeerBotSchema>;

export const groupMembersStateSchema = z.object({
  groupId: id,
  designatedMemberKey: memberKey.nullable().optional(),
  members: z.array(groupMemberSessionSchema).max(GROUP_MAX_TOTAL_MEMBERS),
  formerSessionIds: z.array(id).max(512),
  formerSessions: z.array(groupFormerSessionSchema).max(512),
  questions: z.array(remoteGroupQuestionSchema).max(200),
  directory: z.array(groupPeerBotSchema).max(256).optional(),
}).strict();
export type GroupMembersState = z.infer<typeof groupMembersStateSchema>;

export const addGroupMemberInputSchema = z.object({
  hostId: id.optional(),
  botId: id,
  sessionId: id.optional(),
  historyVisibility: groupHistoryVisibilitySchema.optional(),
}).strict();
export type AddGroupMemberInput = z.infer<typeof addGroupMemberInputSchema>;

export const switchGroupMemberSessionInputSchema = z.object({
  sessionId: id.optional(),
  createNew: z.boolean().optional(),
}).strict();
export type SwitchGroupMemberSessionInput = z.infer<typeof switchGroupMemberSessionInputSchema>;

export const setDesignatedMemberInputSchema = z.object({
  memberKey: memberKey.nullable(),
}).strict();
export type SetDesignatedMemberInput = z.infer<typeof setDesignatedMemberInputSchema>;

export const createGroupRoomInputSchema = z.object({
  title: z.string().trim().min(1).max(256).optional(),
}).strict();
export type CreateGroupRoomInput = z.infer<typeof createGroupRoomInputSchema>;

export const groupMailDeliverSchema = z.object({
  requestId: id,
  groupId: id,
  groupTitle: z.string().max(256),
  conversationId: id,
  sourceHostId: id,
  sourceHostName: z.string().max(256),
  sourceMessageId: id,
  botId: id,
  sessionId: id,
  text: z.string().max(200 * 1024),
  contextMessages: z.array(z.object({
    seq: z.number().int().nonnegative(),
    authorName: z.string().max(256),
    text: z.string().max(32_000),
    createdAt: z.number().int(),
  }).strict()).max(200).default([]),
  callbackUrl: z.string().url().max(512).optional(),
}).strict();
export type GroupMailDeliver = z.infer<typeof groupMailDeliverSchema>;

export const groupMailReplySchema = z.object({
  requestId: id,
  groupId: id,
  conversationId: id,
  botId: id,
  sessionId: id,
  text: z.string().max(200 * 1024),
}).strict();
export type GroupMailReply = z.infer<typeof groupMailReplySchema>;

export const groupLocalSessionDispatchSchema = z.object({
  sessionId: id,
  sessionTitle: z.string().max(256),
  groupTitle: z.string().max(256),
  workspacePath: z.string().max(4096).optional(),
  contextMessages: z.array(z.object({
    seq: z.number().int().nonnegative(),
    authorName: z.string().max(256),
    text: z.string().max(32_000),
    createdAt: z.number().int(),
  }).strict()).max(200).optional(),
}).strict();
export type GroupLocalSessionDispatch = z.infer<typeof groupLocalSessionDispatchSchema>;

export function makeGroupMemberKey(kind: "local" | "remote", hostId: string, botId: string): string {
  return kind === "local" ? `local:${botId}` : `remote:${hostId}:${botId}`;
}

export function groupAutoSessionTitle(groupTitle: string, botName: string): string {
  const cleanGroup = groupTitle.trim() || "Group";
  const cleanBot = botName.trim() || "Bot";
  return `${cleanGroup} · ${cleanBot}`.slice(0, 256);
}
