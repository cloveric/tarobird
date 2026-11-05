import { z } from "zod";

// Validate controls before trimming so pasted newlines or invisible directional
// overrides cannot silently become a different host's visible name.
export const hostNameSchema = z.string().refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), "host_name_invalid")
  .transform(value => value.trim()).pipe(z.string().min(1).max(100));
export const hostProfileSchema = z.object({
  name: hostNameSchema,
  revision: z.number().int().nonnegative().safe(),
}).strict();
export const hostProfileChangeSchema = hostProfileSchema;
export type HostProfileState = z.infer<typeof hostProfileSchema>;
export type HostProfileChange = z.infer<typeof hostProfileChangeSchema>;
