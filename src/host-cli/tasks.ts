import { randomUUID } from "node:crypto";
import { idSchema } from "../client-protocol/index.js";
import { engineSessionRecoverySchema, engineTaskSnapshotSchema, engineTaskStopSchema, engineTaskControlResultSchema } from "../client-protocol/engine-tasks.js";
import type { LocalHostClient } from "./client.js";

export async function runTasksCommand(client: Pick<LocalHostClient, "request">, command: string | undefined, conversation: string | undefined, options: { bot?: string; task?: string; token?: string; yes?: boolean; "request-id"?: string }, receipt?: (id: string) => void) {
  const conversationId = idSchema.parse(conversation), botId = idSchema.parse(options.bot), route = `/api/conversations/${conversationId}/tasks`;
  if (command === "list") {
    if (options.task !== undefined || options.token !== undefined || options.yes || options["request-id"] !== undefined) throw new Error("tasks list 只接受 --bot。");
    return engineTaskSnapshotSchema.parse(await client.request(`${route}?botId=${botId}`));
  }
  if (command === "recover") {
    if (!options.yes || options.task) throw new Error("强制结束此会话及其全部后台任务，需要 --token TOKEN --yes；先用 tasks list 核对。");
    const input = engineSessionRecoverySchema.parse({ botId, token: options.token, requestId: options["request-id"] ?? randomUUID() });
    receipt?.(input.requestId);
    return engineTaskControlResultSchema.parse(await client.request(`${route}/recover`, "POST", input));
  }
  if (options.token !== undefined || options.yes) throw new Error("--token 和 --yes 仅用于 tasks recover。");
  if (command !== "stop") throw new Error("请使用 tasks list|stop CONVERSATION --bot BOT，停止时指定 --task ID。");
  const input = engineTaskStopSchema.parse({ botId, taskId: options.task, requestId: options["request-id"] ?? randomUUID() });
  receipt?.(input.requestId);
  return engineTaskControlResultSchema.parse(await client.request(route, "POST", input));
}
