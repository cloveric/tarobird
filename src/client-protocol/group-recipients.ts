import { z } from "zod";
import { GROUP_MAX_REMOTE_MEMBERS } from "./group-members.js";

export const GROUP_RECIPIENT_KEYS_CAPABILITY = "groups.recipient-keys.v1";
export const GROUP_RECIPIENT_RETRY_CAPABILITY = "groups.recipient-retry.v1";

const localKey = z.string().regex(/^local:[A-Za-z0-9_-]{1,128}$/);
const remoteKey = z.string().max(260).regex(/^remote:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/);
export const groupRecipientKeySchema = z.union([localKey, remoteKey]);
export const groupRecipientKeysSchema = z.array(groupRecipientKeySchema).max(64);

/** Only the fields required to render and address an already joined member. */
export const remoteGroupRosterSchema = z.array(z.object({
  memberKey: remoteKey,
  name: z.string().max(256),
  hostName: z.string().max(256),
}).strict()).max(GROUP_MAX_REMOTE_MEMBERS);
export type RemoteGroupRoster = z.infer<typeof remoteGroupRosterSchema>;
