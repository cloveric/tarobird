import { z } from "zod";

export const PERSONA_MAX_LENGTH = 16_000;
export const personaSettingsSchema = z.object({
  scope: z.literal("bot"), revision: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().max(PERSONA_MAX_LENGTH), activeTurns: z.number().int().nonnegative(),
}).strict();
export const personaPatchSchema = personaSettingsSchema.pick({ revision: true, text: true });
export const personaErrorSchema = z.enum(["persona_conflict", "persona_unreadable", "persona_too_large", "persona_unwritable"]);
export const personaResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), settings: personaSettingsSchema }),
  z.object({ ok: z.literal(false), error: personaErrorSchema }),
]);
