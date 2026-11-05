import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveBotTarget } from "../client-protocol/bot-messages.js";
import { z } from "zod";
import { DISPATCH_ENGINES, dispatchEngineSchema, dispatchCapabilitiesRequestSchema, dispatcherSettingsSchema, type DispatcherSettings } from "../client-protocol/dispatch.js";
import { requestTicketAssistanceSchema } from "../client-protocol/dispatch-assistance.js";
import { instanceEndpoint } from "./bot-messages.js";
import { HostCliError, LocalHostClient } from "./client.js";

export type TicketOptions = { bot?: string; engine?: string; title?: string; text?: string; "text-file"?: string; model?: string; effort?: string; force?: boolean; status?: string; note?: string;
  open?: boolean; match?: string; offset?: string; assist?: string; "request-id"?: string; "context-message"?: string; "dispatch-mode"?: string; "max-concurrent"?: string; allow?: string; revision?: string };
const OWNER_ONLY = ["pause", "resume", "cancel", "accept", "remove", "engine-reset", "settings"];
function contextError(missing: boolean, status?: number): HostCliError {
  const error = new HostCliError("dispatch_context_not_active", status);
  error.message += missing
    ? ": 缺少当前轮次的消息标识，本次工单操作未发送。请从本轮指引取得 --context-message ID 后重试；持久会话不保证更新环境变量。"
    : ": 主机拒绝了本次工单操作：消息上下文未生效、已过期或不属于当前 Bot。请核对本轮指引的 --context-message ID；若本轮 ID 仍被拒绝，报告具体阻塞。";
  error.message += " 这不是工单接口未启用。不要猜测消息 ID、改用主人身份或移除 Bot 环境变量；不要直接启动引擎 CLI 绕过工单。已有操作编号须保留，结果不确定时先读取工单核对。";
  return error;
}
const required = (value: string | undefined, message: string) => { if (!value) throw new Error(message); return value; };
async function textOf(options: TicketOptions, name = "--text"): Promise<string | undefined> {
  if (options.text !== undefined && options["text-file"] !== undefined) throw new Error(`${name} 与 --text-file 只能选一个。`);
  return options["text-file"] !== undefined ? (await readFile(path.resolve(options["text-file"]), "utf8")).trim() : options.text;
}
/** "codex,claude" → engines; "all" → every installed engine CLI. */
export function allowedEnginesOption(value: string | undefined): DispatcherSettings["allowedEngines"] | "all" | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "all") return "all";
  return z.array(dispatchEngineSchema).min(1).parse(value.split(",").map(item => item.trim()).filter(Boolean));
}

/** `tarobot tickets …`. Inside a dispatcher Bot's turn this uses the Bot's own
 * identity and the turn context; otherwise it is the local owner controller. */
export async function runTicketsCommand(directory: string, sub: string | undefined, argument: string | undefined, options: TicketOptions, receipt: (id: string) => void): Promise<unknown> {
  const commands = ["list", "show", "targets", "capabilities", "create", "dispatch", "update", "assist", "assist-status", "assists", "engines", ...OWNER_ONLY];
  if (!sub || !commands.includes(sub)) throw new Error(`请使用 tickets ${commands.join("|")}。`);
  const capabilityQuery = sub === "capabilities" ? dispatchCapabilitiesRequestSchema.parse({ engine: required(options.engine, "缺少 --engine。"), ...(options.match !== undefined ? { match: options.match } : {}), ...(options.offset !== undefined ? { offset: Number(options.offset) } : {}) }) : undefined;
  const botId = process.env.TAROBOT_ACTIVE_INSTANCE ?? process.env.TAROBOT_INSTANCE;
  if (botId) {
    if (OWNER_ONLY.includes(sub)) throw new Error(`tickets ${sub} 只能由主人在本机 CLI 或 App 中执行。`);
    if (options.bot && options.bot !== botId) throw new Error("调度 Bot 只能管理自己的工单；不要传 --bot。");
    const contextMessage = options["context-message"] ?? process.env.TAROBOT_MESSAGE_ID;
    if (["create", "dispatch", "update", "assist", "assist-status"].includes(sub) && !contextMessage) throw contextError(true);
    const endpoint = await instanceEndpoint(directory, botId);
    const call = async (operation: string, data: Record<string, unknown> = {}) => {
      try { return await endpoint.post("/api/instance/tickets", { operation, ...(contextMessage ? { contextMessage } : {}), data }); }
      catch (error) {
        if (error instanceof HostCliError && error.code === "dispatch_context_not_active" && error.status === 403) throw contextError(false, error.status);
        throw error;
      }
    };
    if (sub === "list") return call("list", options.open ? { open: true } : {});
    if (sub === "engines") return { engines: (await call("list", { open: true })).engines };
    if (sub === "show") return call("show", { ticketId: required(argument, "缺少工单 ID。") });
    if (sub === "targets") return call("targets");
    if (sub === "assist-status") return call("assist-status");
    if (sub === "assists") return call("assists", { ticketId: required(argument, "缺少工单 ID。") });
    if (capabilityQuery) return call("capabilities", capabilityQuery);
    return call(sub, await mutation(sub, argument, options, receipt));
  }
  if (sub === "assist" || sub === "assist-status") throw new Error(`tickets ${sub} 只供正在执行工单的 Worker 使用；请从幕僚长对话安排任务，或用 tickets assists 工单ID 查看协助记录。`);
  const client = await LocalHostClient.connect(directory);
  try {
    const dispatchers = client.ready.bots.filter(bot => bot.role === "dispatcher" && !bot.deletedAt);
    const dispatcher = () => {
      if (options.bot) return resolveBotTarget(options.bot, dispatchers, "dispatcher");
      if (dispatchers.length === 1) return dispatchers[0]!;
      throw new Error(dispatchers.length ? "有多个调度 Bot，请用 --bot 指定。" : "本机还没有调度 Bot。创建时使用 bots create --role dispatcher。");
    };
    const ticketRoute = (id: string) => `/api/tickets/${encodeURIComponent(id)}`;
    if (sub === "engines") return { engines: (await client.request<{ engines: unknown[] }>(`/api/bots/${dispatcher().id}/tickets?open=1`)).engines };
    if (sub === "engine-reset") {
      const engine = required(argument, `缺少引擎名称：${DISPATCH_ENGINES.join("|")}。`);
      return { engines: await client.request(`/api/dispatch/engines/${encodeURIComponent(engine)}/reset`, "POST", {}) };
    }
    if (sub === "list") return client.request(`/api/bots/${dispatcher().id}/tickets${options.open ? "?open=1" : ""}`);
    if (sub === "show") return client.request(ticketRoute(required(argument, "缺少工单 ID。")));
    if (sub === "assists") return client.request(`${ticketRoute(required(argument, "缺少工单 ID。"))}/assists`);
    if (sub === "targets") return client.request(`/api/bots/${dispatcher().id}/dispatch-targets`);
    if (capabilityQuery) {
      const query = new URLSearchParams({ engine: capabilityQuery.engine, offset: String(capabilityQuery.offset), ...(capabilityQuery.match !== undefined ? { match: capabilityQuery.match } : {}) });
      return client.request(`/api/bots/${dispatcher().id}/dispatch-capabilities?${query}`);
    }
    if (["pause", "resume", "cancel", "accept", "remove"].includes(sub)) {
      const requestId = options["request-id"] ?? randomUUID(); receipt(requestId);
      return client.request(`${ticketRoute(required(argument, "缺少工单 ID。"))}/action`, "POST", { requestId, action: sub });
    }
    if (sub === "settings") {
      const id = dispatcher().id, current = await client.request<{ settings: DispatcherSettings; revision: string }>(`/api/bots/${id}/dispatcher`);
      const allow = allowedEnginesOption(options.allow);
      if (options["dispatch-mode"] === undefined && options["max-concurrent"] === undefined && allow === undefined) return current;
      const { allowedEngines: _all, ...rest } = current.settings;
      const settings = dispatcherSettingsSchema.parse({ ...(allow === "all" ? rest : current.settings), ...(Array.isArray(allow) ? { allowedEngines: allow } : {}),
        ...(options["dispatch-mode"] !== undefined ? { mode: options["dispatch-mode"] } : {}), ...(options["max-concurrent"] !== undefined ? { maxConcurrent: Number(options["max-concurrent"]) } : {}) });
      return client.request(`/api/bots/${id}/dispatcher`, "PUT", { settings, expectedRevision: options.revision ?? current.revision });
    }
    const id = dispatcher().id;
    const body = await mutation(sub, argument, options, receipt);
    return client.request(`/api/bots/${id}/tickets${sub === "create" ? "" : `/${sub}`}`, "POST", body);
  } finally { client.close(); }
}

async function mutation(sub: string, argument: string | undefined, options: TicketOptions, receipt: (id: string) => void): Promise<Record<string, unknown>> {
  if (sub === "assist") {
    if (argument || options.force || options.status || options.title || options.assist !== undefined) throw new Error("tickets assist 不接受工单 ID、--force、--status、--title 或 --assist；主机自动绑定当前工单。");
    const requestId = options["request-id"] ?? randomUUID(); receipt(requestId);
    return requestTicketAssistanceSchema.parse({ requestId,
      engine: required(options.engine, "缺少 --engine。"), text: required(await textOf(options), "缺少 --text 或 --text-file（协助内容）。"),
      note: required(options.note, "缺少 --note（请求协助的原因）。"),
      ...(options.model !== undefined ? { model: options.model } : {}), ...(options.effort !== undefined ? { effort: options.effort } : {}),
    });
  }
  if (sub === "create") {
    const requestId = options["request-id"] ?? randomUUID(); receipt(requestId);
    return { requestId, title: required(options.title, "缺少 --title。"), request: required(await textOf(options), "缺少 --text 或 --text-file（工单要求）。") };
  }
  if (sub === "dispatch") {
    const requestId = options["request-id"] ?? randomUUID(); receipt(requestId);
    const text = await textOf(options);
    return { requestId, ticketId: required(argument, "缺少工单 ID。"), engine: dispatchEngineSchema.parse(required(options.engine, `缺少 --engine（${DISPATCH_ENGINES.join("|")}）。`)),
      ...(options.model !== undefined ? { model: options.model } : {}), ...(options.effort !== undefined ? { effort: options.effort } : {}), ...(text ? { text } : {}), ...(options.force ? { force: true } : {}),
      ...(options.assist !== undefined ? { assist: z.number().int().min(0).max(2).parse(Number(options.assist)) } : {}) };
  }
  if (options.status === undefined && options.note === undefined) throw new Error("tickets update 需要 --status 或 --note。");
  return { ticketId: required(argument, "缺少工单 ID。"), ...(options.status !== undefined ? { status: options.status } : {}), ...(options.note !== undefined ? { note: options.note } : {}) };
}
