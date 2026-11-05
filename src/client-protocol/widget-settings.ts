import { z } from "zod";
import { idSchema } from "./index.js";

export const WIDGET_SETTINGS_CAPABILITY = "widgets.settings.v1";
export const WIDGET_POLICY_CAPABILITY = "widgets.policy.v1";
export const widgetSettingsUpdateSchema = z.object({ requestId: idSchema, revision: z.string().min(1).max(100), enabled: z.boolean() }).strict();
export type WidgetSettingsUpdate = z.infer<typeof widgetSettingsUpdateSchema>;
export const widgetSettingsSchema = z.object({
  revision: z.string(), enabled: z.boolean(), recoveryRequired: z.boolean().optional(),
  receipt: z.object({ requestId: z.string(), revision: z.string() }).nullable(),
  workersNeedingUpdate: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
export type WidgetSettingsState = z.infer<typeof widgetSettingsSchema>;
