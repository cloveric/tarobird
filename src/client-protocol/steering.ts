import { nativeInputCapabilitySchema, nativeInputActionSchema } from "./native-input.js";
import { z } from "zod";
import { idSchema, textSchema } from "./index.js";
import { workbenchContextSchema } from "./workbench.js";

export const steerReasonSchema = z.enum(["unsupported", "idle", "stale", "binding_changed", "queued", "not_ready", "uncertain"]);
/** `background-review` is only an input target: Claude is reviewing a finished
 * background task and no foreground run exists. It carries no Stop authority. */
export const steerStatusSchema = z.object({ supported: z.boolean(), targetId: idSchema.optional(), targetKind: z.literal("background-review").optional(), reason: steerReasonSchema.optional(), sendBehavior: z.literal("steer").optional(), nativeInput: nativeInputCapabilitySchema.optional() });
/** `workbench` (workbench.design.open.v1 Hosts only) is the sending chat's
 * opener-only context. The Hub stores it on the new record; it never reaches
 * a Gateway in the steer call. */
export const steerRequestSchema = z.object({ botId: idSchema, requestId: idSchema, targetId: idSchema, mode: z.literal("message").optional(), text: textSchema.refine((text) => !!text.trim(), "empty_message"), workbench: workbenchContextSchema.optional() }).strict();
/** Hub → Gateway. The Hub adds `backgroundReview` only for a client that asked
 * for review targets and a worker advertising NATIVE_REVIEW_INPUT_CAPABILITY. */
export const steerStatusCallSchema = z.object({ conversationId: idSchema, backgroundReview: z.literal(true).optional() }).strict();
/** Hub → Gateway. `messageId` (the Hub steering record) is sent only to a
 * worker advertising NATIVE_REVIEW_INPUT_CAPABILITY. */
export const steerCallSchema = steerRequestSchema.omit({ botId: true, workbench: true }).extend({ conversationId: idSchema, userId: idSchema, messageId: idSchema.optional() }).strict();
/** `sourceMessageId`: the source of the live run that admitted (or may have
 * admitted) the input. The Hub keeps it off the record's visible receipt. */
export const steerResultSchema = z.object({ outcome: z.enum(["accepted", "rejected", "unknown"]), reason: steerReasonSchema.optional(), sourceMessageId: idSchema.optional() });
export type SteerResult = z.infer<typeof steerResultSchema>;

export const nativeInputControlRequestSchema = z.object({ requestId: idSchema, action: nativeInputActionSchema }).strict();
