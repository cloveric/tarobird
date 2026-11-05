import { z } from "zod";

/** Negotiated Hub/Gateway support, independently of the native CLI's flags. */
export const NATIVE_INPUT_CAPABILITY = "claude.native-input.v1";
/** Hub/Gateway support for an ordinary input sent while Claude reviews a
 * finished background task: the Gateway starts a new foreground turn whose
 * prompt is admitted natively. Claude may take it into the running review, which
 * then continues as that new turn; it is never a steer of the review. */
export const NATIVE_REVIEW_INPUT_CAPABILITY = "claude.native-input.review.v1";
export const nativeInputCapabilitySchema = z.object({
  sendNow: z.boolean(), cancel: z.boolean(), modelReceipt: z.boolean(),
}).strict();
export type NativeInputCapability = z.infer<typeof nativeInputCapabilitySchema>;

/** Admission, dequeueing and a model reply correlated to this input are
 * separate observations. None of these states means the user's work is done. */
export const nativeInputProgressSchema = z.object({
  state: z.enum(["queued", "dequeued", "received", "cancelled", "dropped", "unknown"]),
  reason: z.string().max(200).optional(),
}).strict();
export type NativeInputProgress = z.infer<typeof nativeInputProgressSchema>;

export const nativeInputActionSchema = z.enum(["send-now", "cancel"]);
export type NativeInputAction = z.infer<typeof nativeInputActionSchema>;
export const nativeInputControlResultSchema = z.object({
  outcome: z.enum(["accepted", "rejected", "unknown"]),
  result: z.enum(["delivering", "stopped", "nothing_waiting", "cancelled", "not_queued"]).optional(),
  reason: z.enum(["unsupported", "stale", "uncertain", "binding_changed"]).optional(),
}).strict();
export type NativeInputControlResult = z.infer<typeof nativeInputControlResultSchema>;

/** Only ordinary Claude input opts in. Legacy explicit steering is unchanged. */
export type NativeInputObserver = { id: string; onProgress: (progress: NativeInputProgress) => void };
