import { randomUUID } from "node:crypto";
import { voiceSettingsSchema, voiceSettingsUpdateSchema, VOICE_SETTINGS_CAPABILITY } from "../client-protocol/voice-settings.js";
import type { LocalHostClient } from "./client.js";

export async function voiceCommand(client: LocalHostClient, action: string | undefined, flags: {
  mode?: string; enabled?: string; adapter?: string; revision?: string; thresholdSeconds?: string; requestId?: string; yes?: boolean;
}, submitted: (id: string) => void) {
  if (!client.ready.serverCapabilities.includes(VOICE_SETTINGS_CAPABILITY)) throw new Error("请更新主机后使用语音转写设置。");
  if (action === "status") {
    if (flags.mode !== undefined || flags.enabled !== undefined || flags.adapter !== undefined || flags.revision !== undefined || flags.thresholdSeconds !== undefined || flags.yes) throw new Error("status 不接受修改参数。");
    return voiceSettingsSchema.parse(await client.request(`/api/integrations/voice${flags.requestId ? `?requestId=${encodeURIComponent(flags.requestId)}` : ""}`));
  }
  if (action !== "set") throw new Error("请使用 integrations voice status 或 integrations voice set。");
  if (flags.mode !== undefined && flags.enabled !== undefined) throw new Error("--mode 与旧参数 --enabled 不能同时使用。");
  if (flags.enabled !== undefined && !["on", "off"].includes(flags.enabled)) throw new Error("--enabled 只接受 on|off。");
  const mode = flags.mode ?? (flags.enabled === "on" ? "auto" : flags.enabled === "off" ? "local" : undefined);
  if (!["local", "cloud", "auto"].includes(mode ?? "")) throw new Error("请用 --mode local|cloud|auto 明确选择转写方式。");
  if (!flags.yes) throw new Error("全部云端会上传所有语音；自动模式按时长上传。云端可能产生费用，设置作用于此主机。确认后加 --yes。");
  const command = voiceSettingsUpdateSchema.parse({ requestId: flags.requestId ?? randomUUID(), revision: flags.revision,
    mode, adapterId: flags.adapter, thresholdSeconds: Number(flags.thresholdSeconds), cloudConsent: flags.yes });
  submitted(command.requestId);
  await client.request("/api/integrations/voice", "PUT", command);
  const current = voiceSettingsSchema.parse(await client.request(`/api/integrations/voice?requestId=${command.requestId}`));
  if (current.receipt?.requestId !== command.requestId || current.receipt.revision !== current.revision || current.mode !== command.mode || current.adapterId !== command.adapterId || current.thresholdSeconds !== command.thresholdSeconds) throw new Error("保存结果已变化或尚未核实，请用 status --request-id 核对；不要使用新编号重复提交。");
  return current;
}
