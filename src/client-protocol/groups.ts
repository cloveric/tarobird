import { z } from "zod";
import { idSchema } from "./index.js";
import { groupDiscussionPolicySchema } from "./group-discussion.js";

const members = z.array(idSchema).max(32).refine(ids => new Set(ids).size === ids.length);
/** Existing identities and session keys stay intact. Compare the displayed
 * metadata so another device's edit cannot silently be overwritten. The
 * discussion policy is optional: older clients omit it and keep the saved one. */
export const groupSettingsSchema = z.object({
  title: z.string().trim().min(1).max(256),
  botIds: members.refine(ids => ids.length > 0),
  expectedTitle: z.string().max(256),
  expectedBotIds: members,
  policy: groupDiscussionPolicySchema.optional(),
  expectedRevision: z.string().min(1).max(128).optional(),
}).strict().refine(value => (value.policy === undefined) === (value.expectedRevision === undefined), "policy_revision_pair");
export type GroupSettingsInput = z.infer<typeof groupSettingsSchema>;
