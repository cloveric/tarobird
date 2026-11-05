import { randomUUID } from "node:crypto";
import { WIDGET_SETTINGS_CAPABILITY, widgetSettingsSchema, widgetSettingsUpdateSchema } from "../client-protocol/widget-settings.js";
import type { LocalHostClient } from "./client.js";

export async function widgetSettingsCommand(client: Pick<LocalHostClient, "request" | "ready">, action: string, flags: { enabled?: string; revision?: string; requestId?: string }, submitted: (id: string) => void) {
  if (!client.ready.serverCapabilities.includes(WIDGET_SETTINGS_CAPABILITY)) throw new Error("请更新主机后使用图形回复设置。");
  if (action === "status") {
    if (flags.enabled !== undefined || flags.revision !== undefined) throw new Error("status 不接受修改参数。");
    return widgetSettingsSchema.parse(await client.request(`/api/settings/widgets${flags.requestId ? `?requestId=${encodeURIComponent(flags.requestId)}` : ""}`));
  }
  if (action !== "set" || !["on", "off"].includes(flags.enabled ?? "")) throw new Error("请使用 widgets set --enabled on|off --revision REV。");
  if (!flags.revision?.trim()) throw new Error("请先运行 widgets status 读取 revision，再用 --revision 提交。");
  const command = widgetSettingsUpdateSchema.parse({ requestId: flags.requestId ?? randomUUID(), revision: flags.revision, enabled: flags.enabled === "on" });
  submitted(command.requestId);
  await client.request("/api/settings/widgets", "PUT", command);
  const current = widgetSettingsSchema.parse(await client.request(`/api/settings/widgets?requestId=${command.requestId}`));
  if (current.receipt?.requestId !== command.requestId || current.receipt.revision !== current.revision || current.enabled !== command.enabled) throw new Error("保存结果已变化或尚未核实，请用 status --request-id 核对；不要使用新编号重复提交。");
  return current;
}
