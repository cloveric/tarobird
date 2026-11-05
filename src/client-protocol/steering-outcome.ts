import { z } from "zod";

export const STEERING_OUTCOME_CAPABILITY = "steering.outcome.v1";
/** Native observation of input adoption, distinct from admission or task success. */
export const steeringApplicationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), via: z.enum(["fold", "continuation"]) }).strict(),
  z.object({ status: z.literal("absorbed") }).strict(),
  z.object({ status: z.literal("dropped"), reason: z.enum(["stopped", "turn_failed", "not_started", "engine_exit"]) }).strict(),
]);
export type SteeringApplication = z.infer<typeof steeringApplicationSchema>;
