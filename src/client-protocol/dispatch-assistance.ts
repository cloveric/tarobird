import { z } from "zod";
import { dispatchTicketRequestSchema } from "./dispatch.js";

/** A worker proposes one bounded helper task. Parent/attempt/workspace are
 * resolved by the Host from its authenticated active input, never caller IDs. */
export const ASSIST_MAX_PER_DISPATCH = 2;
export const requestTicketAssistanceSchema = dispatchTicketRequestSchema.omit({ ticketId: true, force: true, assist: true }).extend({
  text: z.string().trim().min(1).max(12_000),
  note: z.string().trim().min(1).max(600),
}).strict();
export type RequestTicketAssistance = z.infer<typeof requestTicketAssistanceSchema>;
