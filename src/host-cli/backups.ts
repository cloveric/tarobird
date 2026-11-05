import { randomUUID } from "node:crypto";
import { backupSettingsSchema, backupSettingsUpdateSchema } from "../client-protocol/backup-settings.js";
import { idSchema } from "../client-protocol/index.js";
import type { LocalHostClient } from "./client.js";

export async function runBackupsCommand(client: Pick<LocalHostClient, "request">, command: string | undefined,
  options: { days?: string; revision?: string; requestId?: string }, submitted: (id: string) => void = () => {}) {
  if (!['status', 'configure'].includes(command ?? '')) throw new Error("请使用 backups status 或 backups configure --days 0..3650。");
  const requestId = options.requestId === undefined ? undefined : idSchema.parse(options.requestId);
  const read = async (id?: string) => backupSettingsSchema.parse(await client.request(`/api/settings/backups${id ? `?requestId=${encodeURIComponent(id)}` : ''}`));
  if (command === 'status') {
    if (options.days !== undefined || options.revision !== undefined) throw new Error("backups status 不接受 --days 或 --revision。");
    return read(requestId);
  }
  if (!/^(0|[1-9]\d*)$/.test(options.days ?? '')) throw new Error("--days 必须是 0 到 3650 的整数；0 关闭并清理自动备份。");
  // Validate before contacting the host; an explicit revision allows exact retries.
  const draft = backupSettingsUpdateSchema.parse({ retentionDays: Number(options.days), revision: options.revision ?? 'default', requestId: requestId ?? randomUUID() });
  const update = { ...draft, revision: options.revision ?? (await read()).revision };
  submitted(update.requestId);
  await client.request('/api/settings/backups', 'PUT', update);
  const result = await read(update.requestId);
  if (result.retentionDays !== update.retentionDays || result.receipt?.requestId !== update.requestId || result.receipt.revision !== result.revision) throw new Error('backup_settings_unconfirmed');
  return result;
}
