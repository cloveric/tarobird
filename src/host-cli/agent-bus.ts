import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import { idSchema } from "../client-protocol/index.js";
import {
  agentBusConfigSchema, agentBusCreateSchema, agentBusDeleteSchema, agentBusMemberSchema,
  agentBusStartSchema, agentBusStopSchema, agentBusUpdateSchema,
  type AgentBusDetail, type AgentBusRun, type AgentBusWorkspace,
} from "../client-protocol/agent-bus.js";
import type { LocalHostClient } from "./client.js";
import { collaborationSnapshotSchema, prepareAgentBusCollaboration, agentBusPeerIds, type CollaborationConnection } from "../client-protocol/collaboration-prepare.js";

export interface AgentBusCommandOptions {
  from?: string;
  revision?: string;
  "text-file"?: string;
  "request-id"?: string;
  run?: string;
  yes?: boolean;
  abandon?: boolean;
  coordinator?: string;
  members?: string;
}

const timestamp = z.number().int().nonnegative();
const runSummarySchema = z.object({
  id: idSchema, workspaceId: idSchema, messageId: idSchema,
  status: z.enum(["queued", "running", "stopping", "completed", "failed", "cancelled", "interrupted"]),
  createdAt: timestamp, startedAt: timestamp.optional(), finishedAt: timestamp.optional(), error: z.string().optional(), canAbandon: z.boolean().optional(),
});
const memberSchema = agentBusMemberSchema.extend({ conversationId: idSchema });
const snapshotSchema = agentBusConfigSchema.safeExtend({
  coordinator: memberSchema, members: z.array(memberSchema).min(1).max(11),
  maxResearchQuestions: agentBusConfigSchema.shape.maxResearchQuestions.removeDefault(),
  maxRevisionRounds: agentBusConfigSchema.shape.maxRevisionRounds.removeDefault(),
});
const runSchema: z.ZodType<AgentBusRun> = runSummarySchema.extend({
  snapshot: snapshotSchema, text: z.string(), stages: z.array(z.object({
    id: idSchema, botId: idSchema, conversationId: idSchema,
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    messageId: idSchema.optional(), startedAt: timestamp, finishedAt: timestamp.optional(), error: z.string().optional(),
  })),
});
const workspaceSchema: z.ZodType<AgentBusWorkspace> = agentBusConfigSchema.safeExtend({
  id: idSchema, revision: idSchema, coordinator: memberSchema,
  members: z.array(memberSchema).min(1).max(11), createdAt: timestamp, updatedAt: timestamp,
  latestRun: runSummarySchema.optional(),
});
const detailSchema: z.ZodType<AgentBusDetail> = z.object({ workspace: workspaceSchema, runs: z.array(runSchema) });

/** One-shot operations against the existing local Hub and App management identity. */
export async function runAgentBusCommand(
  client: Pick<LocalHostClient, "request">,
  command: string | undefined,
  workspaceId: string | undefined,
  options: AgentBusCommandOptions,
  receipt: (requestId: string) => void = () => {},
) {
  const allowed: Record<string, string[]> = {
    list: [], show: [], create: ["from", "request-id"], update: ["from", "revision"],
    run: ["text-file", "revision", "request-id"], stop: ["run", "request-id", "abandon"], delete: ["revision", "yes"],
    permissions: [], prepare: ["coordinator", "members", "yes", "request-id"],
  };
  if (!command || !Object.hasOwn(allowed, command)) throw new Error("用法：tarobot bus list|show|create|update|run|stop|delete|permissions|prepare；请执行 tarobot --help。");
  for (const [key, value] of Object.entries(options)) if (value !== undefined && !allowed[command]!.includes(key)) throw new Error(`bus ${command} 不支持 --${key}。`);
  if (["list", "create", "prepare"].includes(command) && workspaceId !== undefined) throw new Error(`bus ${command} 不接受工作区 ID。`);
  if (command === "permissions") {
    const botId = idSchema.parse(required(workspaceId, "缺少 Bot ID。"));
    return collaborationSnapshotSchema.parse(await client.request(`/api/bots/${botId}/collaboration`));
  }
  if (command === "prepare") {
    if (options.yes !== true) throw new Error("准备协作会添加所选 Bot 的双向权限，并为离线协作服务安排空闲重启；核对 --coordinator、--members 后加 --yes。");
    const coordinator = idSchema.parse(required(options.coordinator, "缺少 --coordinator Bot ID。"));
    const members = required(options.members, "缺少 --members ID,ID。").split(",").map(value => idSchema.parse(value.trim()));
    if (!members.length || members.length > 64) throw new Error("collaboration_invalid_peer");
    const requestId = idSchema.parse(options["request-id"] ?? randomUUID());
    // The same operation survives a lost response or a new CLI process. Stable
    // per-Bot receipts ask Hub for the previous idle-restart outcome, never a
    // newly numbered restart. An explicit rejection requires operator review.
    const restartIds = new Map([coordinator, ...agentBusPeerIds(coordinator, members)].map(botId => [botId,
      `bus_prepare_${createHash("sha256").update(JSON.stringify([requestId, coordinator, [...members].sort(), botId])).digest("hex")}`]));
    const restarts: { botId: string; receiptId: string; accepted: true }[] = [];
    const transport: CollaborationConnection = { http: async <T>(route: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<T> => {
      init?.signal?.throwIfAborted();
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
      const result = await client.request<T>(route, init?.method ?? "GET", body);
      if (route.endsWith("/restart") && (result as { ok?: unknown })?.ok === true) {
        const botId = route.split("/")[3]!;
        restarts.push({ botId, receiptId: restartIds.get(botId)!, accepted: true });
      }
      return result;
    } };
    receipt(requestId);
    await prepareAgentBusCollaboration(transport, coordinator, members, restartIds, () => {}, new AbortController().signal);
    return { requestId, coordinator, members, permissionsPrepared: true, restarts, taskSent: false };
  }
  const route = command === "list" || command === "create" ? "/api/agent-buses" : `/api/agent-buses/${idSchema.parse(required(workspaceId, "缺少 Agent Bus 工作区 ID；请先 bus list。"))}`;
  if (command === "list") return z.object({ items: z.array(workspaceSchema) }).parse(await client.request(route));
  if (command === "show") return detailSchema.parse(await client.request(route));
  if (command === "delete") {
    if (options.yes !== true) throw new Error("删除 Agent Bus 工作区会保留关联对话；核对工作区 ID 和 revision 后加 --yes 执行。");
    const input = agentBusDeleteSchema.parse({ revision: options.revision });
    return z.object({ ok: z.literal(true) }).parse(await client.request(route, "DELETE", input));
  }
  if (command === "update") {
    const revision = idSchema.parse(options.revision);
    const config = agentBusConfigSchema.parse(JSON.parse(await readInput(required(options.from, "缺少 --from 配置文件。"), 512 * 1024)));
    const input = agentBusUpdateSchema.parse({ revision, config });
    return workspaceSchema.parse(await client.request(route, "PUT", input));
  }
  const requestId = idSchema.parse(options["request-id"] ?? randomUUID());
  if (command === "create") {
    const config = agentBusConfigSchema.parse(JSON.parse(await readInput(required(options.from, "缺少 --from 配置文件。"), 512 * 1024)));
    const input = agentBusCreateSchema.parse({ requestId, config });
    receipt(requestId);
    return workspaceSchema.parse(await client.request(route, "POST", input));
  }
  if (command === "stop") {
    const runId = idSchema.parse(required(options.run, "缺少 --run 运行 ID；请先 bus show ID。"));
    const input = agentBusStopSchema.parse({ requestId, ...(options.abandon ? { abandon: true } : {}) });
    receipt(requestId);
    return runSchema.parse(await client.request(`${route}/runs/${runId}/stop`, "POST", input));
  }
  const revision = idSchema.parse(options.revision);
  const text = await readInput(required(options["text-file"], "缺少 --text-file UTF-8 任务文件。"), 48_000 * 4);
  const input = agentBusStartSchema.parse({ requestId, revision, text });
  // Preserve the original ID, revision and text on an uncertain response. Do not
  // refresh the revision, retry, or start a second run behind the operator's back.
  receipt(requestId);
  return runSchema.parse(await client.request(`${route}/runs`, "POST", input));
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

async function readInput(file: string, maximum: number): Promise<string> {
  if (!file.trim() || file.includes("\0")) throw new Error("输入文件路径无效。");
  const checked = await lstat(file);
  if (!checked.isFile() || checked.size === 0 || checked.size > maximum) throw new Error("输入须为大小受限、非空的普通文件，不能使用符号链接或设备文件。");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== checked.dev || before.ino !== checked.ino || before.size !== checked.size || before.mtimeMs !== checked.mtimeMs || before.ctimeMs !== checked.ctimeMs) throw new Error("读取前输入文件发生变化，请重新检查。");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("读取期间输入文件发生变化，请重新检查。");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { throw new Error("输入文件不是有效的 UTF-8，请另存为 UTF-8 后重试。"); }
  } finally { await handle.close(); }
}
