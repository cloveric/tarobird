import { z } from "zod";
import { idSchema } from "./index.js";

export const ASR_SETUP_CAPABILITY = "integrations.asr.v1";
export const asrPhaseSchema = z.enum(["checking", "dependencies", "model", "installing", "service", "completed"]);
export const asrInstallSchema = z.object({ requestId: idSchema, model: z.boolean(), service: z.boolean() }).strict();
export type AsrInstall = z.infer<typeof asrInstallSchema>;
export const asrJobSchema = z.object({ requestId: idSchema, status: z.enum(["running", "completed", "failed", "interrupted"]),
  phase: asrPhaseSchema, startedAt: z.number(), finishedAt: z.number().optional(), error: z.string().max(100).optional(),
  pid: z.number().int().positive(), model: z.boolean(), service: z.boolean() });
export type AsrJob = z.infer<typeof asrJobSchema>;
export const asrStateSchema = z.object({ platform: z.string(), supported: z.boolean(), installed: z.boolean(), pythonPresent: z.boolean(),
  modelPresent: z.boolean(), running: z.boolean(), managed: z.boolean(), legacyService: z.boolean(), activeRequests: z.number().int().nonnegative().nullable(),
  watchdog: z.object({ enabled: z.boolean(), reason: z.string().max(120), available: z.boolean(), memoryBytes: z.number().nonnegative().nullable(),
    limitBytes: z.number().positive(), intervalSeconds: z.number().positive() }).nullable(), autostart: z.enum(["login", "disabled"]),
  job: asrJobSchema.nullable().optional(), error: z.string().max(100).optional() });
export type AsrState = z.infer<typeof asrStateSchema>;
