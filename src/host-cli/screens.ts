import { randomUUID } from "node:crypto";
import { screenConfigureSchema, screenConfigureText, screenPolicySchema, screenStatusSchema, type ScreenConfigure } from "../client-protocol/remote-screen.js";
import { hashSecret } from "../hub/auth.js";
import type { LocalHostClient } from "./client.js";

export async function screenCommand(client: LocalHostClient, sub: string, deviceId?: string, options: { yes?: boolean; permission?: string; requestId?: string; command?: unknown } = {}) {
  if (!client.supports("desktop.screen.v1")) throw new Error("请先更新目标主机；此版本尚不支持远程屏幕。");
  if (sub === "stop") {
    if (!options.yes) throw new Error("停止指定屏幕会话（未填 ID 则停止全部），确认后加 --yes。");
    return client.request("/api/screens/stop", "POST", { ...(deviceId ? { sessionId: deviceId } : {}) });
  }
  const status = screenStatusSchema.parse(await client.request("/api/screens/status"));
  if (sub === "status") return status;
  if (!["configure", "enable", "disable", "allow", "revoke"].includes(sub)) throw new Error("未知 screens 命令。");
  if (!options.yes) throw new Error("先用 screens status 核对目标设备与权限，确认后加 --yes。");
  if (!status.canManage || !status.policy) throw new Error("需要目标主机的本机控制器管理远程屏幕授权。");
  const policy = status.policy;
  let command: ScreenConfigure;
  if (sub === "configure") command = screenConfigureSchema.parse(options.command);
  else {
    command = { operation: "screen.configure", expectedRevision: policy.revision, enabled: policy.enabled, grants: policy.grants, requestId: options.requestId ?? randomUUID() };
    if (sub === "enable" || sub === "disable") command.enabled = sub === "enable";
    else {
      const device = status.devices?.find(d => d.id === deviceId);
      if (!device) throw new Error("未找到该已配对设备；请先 screens status 核对设备 ID。");
      command.grants = policy.grants.filter(g => g.deviceId !== device.id);
      if (sub === "allow") {
        if (options.permission !== "view" && options.permission !== "control") throw new Error("指定 --permission view（仅查看）或 control（查看并控制）。");
        command.grants.push({ deviceId: device.id, publicKey: device.publicKey, permission: options.permission });
      }
    }
  }
  const proof = await client.deviceAction({ operation: "screen-grant", target: hashSecret(screenConfigureText(command)) });
  return screenPolicySchema.parse(await client.request("/api/screens/configure", "POST", { command, proof }));
}
