import { z } from "zod";

/** Checks local configuration and stored authorization only, never Google APIs. */
export const googleDocsStatusSchema = z.object({ configured: z.boolean(), authorized: z.boolean(), error: z.string().max(100).optional() }).strict();
export type GoogleDocsStatus = z.infer<typeof googleDocsStatusSchema>;
