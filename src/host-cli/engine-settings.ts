import { randomUUID } from "node:crypto";
import { ENGINE_SETTINGS_CAPABILITY, engineSettingsSchema, engineSettingsUpdateSchema } from "../client-protocol/engine-settings.js";
import type { LocalHostClient } from "./client.js";

export async function engineSettingsCommand(client: Pick<LocalHostClient, "request" | "ready">, action: string, flags: { engine?: string; path?: string; revision?: string; requestId?: string }, submitted: (id: string) => void) {
  if (!client.ready.serverCapabilities.includes(ENGINE_SETTINGS_CAPABILITY)) throw new Error("请更新主机后使用引擎路径设置。");
  if (action === "status") {
    if (flags.engine !== undefined || flags.path !== undefined || flags.revision !== undefined) throw new Error("status 不接受修改参数。");
    return engineSettingsSchema.parse(await client.request(`/api/settings/engines${flags.requestId ? `?requestId=${encodeURIComponent(flags.requestId)}` : ""}`));
  }
  if (!["set", "reset"].includes(action) || !flags.engine || !flags.revision || (action === "set" ? !flags.path : flags.path !== undefined)) throw new Error("请先运行 engines status，再使用 engines set --engine ENGINE --path ABSOLUTE_PATH --revision REV，或 engines reset --engine ENGINE --revision REV。");
  const command = engineSettingsUpdateSchema.parse({ requestId: flags.requestId ?? randomUUID(), revision: flags.revision, engine: flags.engine, path: action === "reset" ? null : flags.path });
  submitted(command.requestId);
  await client.request("/api/settings/engines", "PUT", command);
  const current = engineSettingsSchema.parse(await client.request(`/api/settings/engines?requestId=${encodeURIComponent(command.requestId)}`));
  if (current.receipt?.requestId !== command.requestId || current.receipt.revision !== current.revision || current.engines.find(engine => engine.id === command.engine)?.override !== command.path) throw new Error("保存结果已变化或尚未核实，请用 engines status --request-id 核对；不要使用新编号重复提交。");
  return current;
}
