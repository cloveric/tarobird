import { z } from "zod";
import { idSchema } from "./index.js";

export const AVATAR_EDGE = 256;
export const MAX_AVATAR_BYTES = 300 * 1024;
// `group` identifies a root conversation (direct or group), never its Bot.
// Topics inherit their root group picture. Kept stable for older clients.
export const avatarKindSchema = z.enum(["user", "bot", "group"]);
export const avatarTargetSchema = z.object({ kind: avatarKindSchema, id: idSchema }).strict();
export const avatarSchema = avatarTargetSchema.extend({ revision: z.number().int().positive().safe(), hasImage: z.boolean() });
export const avatarPatchSchema = z.object({ expectedRevision: z.number().int().nonnegative().safe(), dataUrl: z.string().max(Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 32).nullable() }).strict();
export type AvatarTarget = z.infer<typeof avatarTargetSchema>;
export type ProfileAvatar = z.infer<typeof avatarSchema>;
export const profileUserSchema = z.object({ id: idSchema, name: z.string(), role: z.enum(["owner", "member"]) });
export const profileCacheSchema = z.object({ user: profileUserSchema.optional(), avatars: z.array(avatarSchema) });
export type ProfileCache = z.infer<typeof profileCacheSchema>;
export const avatarKey = ({ kind, id }: AvatarTarget): string => `${kind}:${id}`;
