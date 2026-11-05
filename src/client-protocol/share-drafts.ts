import { z } from "zod";
import { idSchema, textSchema } from "./index.js";

// Local review metadata only. Native files and immutable delivery pins remain
// separate; importing this schema must not pull in a client connection/runtime.
export const shareDraftSchema = z.object({
  text: textSchema,
  recipient: z.union([idSchema, z.literal("")]),
  mentions: z.array(idSchema).max(64),
});
export type ShareDraft = z.infer<typeof shareDraftSchema>;
export type SavedShareDraft = { revision?: string; draft?: ShareDraft; retired: boolean };
