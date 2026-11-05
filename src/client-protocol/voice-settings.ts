import { z } from "zod";
import { idSchema } from "./index.js";

export const VOICE_SETTINGS_CAPABILITY = "integrations.voice.v2";
export const VOICE_POLICY_CAPABILITY = "integrations.voice-policy.v2";
export const voiceRoutingModeSchema = z.enum(["local", "cloud", "auto"]);
export type VoiceRoutingMode = z.infer<typeof voiceRoutingModeSchema>;
export const voiceSettingsUpdateSchema = z.object({
  requestId: idSchema,
  revision: z.string().min(1).max(100),
  mode: voiceRoutingModeSchema,
  adapterId: z.string().max(100),
  thresholdSeconds: z.number().int().min(60).max(7200),
  cloudConsent: z.boolean(),
}).strict();
export type VoiceSettingsUpdate = z.infer<typeof voiceSettingsUpdateSchema>;
export const voiceAdapterSchema = z.object({
  id: z.string(), directory: z.string(), source: z.enum(["configured", "standard", "legacy", "saved"]),
  script: z.boolean(), python: z.boolean(), credentials: z.boolean(), private: z.boolean(), permissionsVerified: z.boolean(), ready: z.boolean(),
});
export const voiceSettingsSchema = z.object({
  revision: z.string(), managed: z.boolean(), mode: voiceRoutingModeSchema, adapterId: z.string(),
  thresholdSeconds: z.number().positive(), adapters: z.array(voiceAdapterSchema),
  receipt: z.object({ requestId: z.string(), revision: z.string() }).nullable(),
  workersNeedingUpdate: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  // File readiness is deliberately not represented as a successful cloud API test.
  cloudVerified: z.literal(false),
  legacyModeInvalid: z.boolean().optional(),
});
export type VoiceSettingsState = z.infer<typeof voiceSettingsSchema>;
