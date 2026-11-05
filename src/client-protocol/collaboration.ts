import { z } from "zod";
import { idSchema } from "./index.js";
const ids = z.array(idSchema).max(64).refine((items) => new Set(items).size === items.length, "duplicate_bot");
export const crewSettingsSchema = z.object({
  enabled: z.literal(true), workflow: z.literal("research-report"), coordinator: idSchema,
  roles: z.object({ researcher: idSchema, analyst: idSchema, writer: idSchema, reviewer: idSchema }).strict(),
  maxResearchQuestions: z.number().int().min(1).max(50), maxRevisionRounds: z.number().int().min(0).max(10),
}).strict().refine((crew) => new Set([crew.coordinator, ...Object.values(crew.roles)]).size === 5, "crew_requires_five_distinct_bots");
export const collaborationSettingsSchema = z.object({
  enabled: z.boolean(), peers: z.union([z.literal("*"), ids]),
  maxDepth: z.number().int().min(1).max(32), parallel: ids, chain: ids,
  verifier: idSchema.nullable(), crew: crewSettingsSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.enabled && Array.isArray(value.peers) && value.peers.length === 0) ctx.addIssue({ code: "custom", message: "select_at_least_one_peer", path: ["peers"] });
});
export const collaborationPatchSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), settings: collaborationSettingsSchema }).strict();
export type CollaborationSettings = z.infer<typeof collaborationSettingsSchema>;
export type CollaborationSnapshot = {
  taskSelection?: boolean;
  revision: string; settings: CollaborationSettings;
  listener: "online" | "offline" | "unknown";
  peers: { id: string; name: string; online: boolean; allowsThisBot: boolean | null; listener: "online" | "offline" | "unknown" }[];
};
