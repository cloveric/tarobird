import { idSchema } from "../client-protocol/index.js";
import { WORKSPACE_DIFF_CAPABILITY, workspaceChangesSchema, workspaceDiffPathSchema, workspaceFileDiffSchema, type WorkspaceChanges, type WorkspaceFileDiff } from "../client-protocol/workspace-diff.js";
import type { LocalHostClient } from "./client.js";
import { RUN_CHANGES_CAPABILITY, runChangesSchema, runChangeDetailSchema, type RunChanges, type RunChangeDetail } from "../client-protocol/run-changes.js";

export async function runChangesCommand(
  client: Pick<LocalHostClient, "request" | "ready">,
  command: string | undefined,
  conversationId: string | undefined,
  options: { bot?: string; path?: string; preview?: boolean; message?: string; operation?: string },
): Promise<WorkspaceChanges | WorkspaceFileDiff | RunChanges | RunChangeDetail> {
  if (command !== "list" && command !== "show") throw new Error("用法：tarobot changes list|show CONVERSATION --bot BOT [--path FILE --preview]。");
  if (!conversationId) throw new Error("缺少对话 ID。");
  if (!options.bot) throw new Error("缺少 --bot Bot ID。");
  const conversation = idSchema.parse(conversationId), botId = idSchema.parse(options.bot);
  for (const [key, value] of Object.entries(options)) if (value !== undefined && !(command === "list" ? ["bot", "message"] : ["bot", "path", "preview", "message", "operation"]).includes(key)) throw new Error(`changes ${command} 不支持 --${key}。`);
  if (options.message) {
    if (!client.ready.serverCapabilities.includes(RUN_CHANGES_CAPABILITY)) throw new Error("请更新主机以查看本轮修改记录。");
    if (command === "show" && !options.path) throw new Error("缺少 --path 记录中的文件路径。");
    if (options.operation && !/^\d+-\d+$/.test(options.operation)) throw new Error("无效修改步骤。");
    const message = idSchema.parse(options.message), base = `/api/messages/${message}/changes`, query = new URLSearchParams({ conversationId: conversation, botId });
    const list = runChangesSchema.parse(await client.request(`${base}?${query}`));
    if (list.messageId !== message || list.conversationId !== conversation || list.botId !== botId) throw new Error("run_changes_scope_mismatch");
    if (command === "list") return list;
    if (!options.path) throw new Error("缺少 --path 记录中的文件路径。");
    const matches = list.items.filter(file => file.path === options.path || file.key === options.path);
    if (matches.length !== 1) throw new Error("未匹配到唯一文件，请先 changes list --message 查看并使用文件 key。");
    query.set("key", matches[0]!.key); query.set("revision", list.revision); query.set("runId", list.runId);
    if (options.operation) { if (!/^\d+-\d+$/.test(options.operation)) throw new Error("无效修改步骤。"); query.set("operation", options.operation); }
    if (options.preview) query.set("preview", "1");
    const result = runChangeDetailSchema.parse(await client.request(`${base}/file?${query}`));
    if (result.messageId !== message || result.runId !== list.runId || result.conversationId !== conversation || result.botId !== botId || result.file.key !== matches[0]!.key || result.revision !== list.revision || options.operation && result.operation.id !== options.operation) throw new Error("run_changes_scope_mismatch");
    return result;
  }
  if (options.operation) throw new Error("--operation 需要 --message。");
  if (!client.ready.serverCapabilities.includes(WORKSPACE_DIFF_CAPABILITY)) throw new Error("主机尚不支持工作区变更查看，请更新主机后重试。");
  const query = new URLSearchParams({ botId });
  if (command === "show") {
    if (!options.path) throw new Error("缺少 --path 相对工作区文件路径。");
    query.set("path", workspaceDiffPathSchema.parse(options.path));
    if (options.preview) query.set("preview", "1");
  }
  // URLSearchParams leaves dots and stars literal, but the controller's route
  // guard rejects '..' and '*'. Preserve filenames without relaxing that guard.
  const route = `/api/conversations/${conversation}/changes${command === "show" ? "/file" : ""}?${query.toString().replaceAll(".", "%2E").replaceAll("*", "%2A")}`;
  const result = await client.request(route);
  return command === "list" ? workspaceChangesSchema.parse(result) : workspaceFileDiffSchema.parse(result);
}
