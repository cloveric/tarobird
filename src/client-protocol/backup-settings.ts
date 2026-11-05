import { z } from "zod";
import { idSchema } from "./index.js";

export const BACKUP_SETTINGS_CAPABILITY = "backups.settings.v1";
export const DEFAULT_BACKUP_DAYS = 1;
export const MAX_BACKUP_DAYS = 3650;
export const backupDaysSchema = z.number().int().min(0).max(MAX_BACKUP_DAYS);
export const backupSettingsUpdateSchema = z.object({ requestId: idSchema, revision: z.string().min(1).max(100), retentionDays: backupDaysSchema }).strict();
export type BackupSettingsUpdate = z.infer<typeof backupSettingsUpdateSchema>;
export const backupSettingsSchema = z.object({
  revision: z.string(), retentionDays: backupDaysSchema,
  receipt: z.object({ requestId: z.string(), revision: z.string() }).nullable(),
  snapshots: z.object({ count: z.number().int().nonnegative(), bytes: z.number().nonnegative(), latestDay: z.string().nullable() }),
});
export type BackupSettingsState = z.infer<typeof backupSettingsSchema>;
