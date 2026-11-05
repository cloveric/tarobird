import type { AgentBusConfig, AgentBusMember, AgentBusMode, AgentBusRun, AgentBusRunStatus, AgentBusWorkspace } from "../../src/client-protocol/agent-bus.js";
import { AGENT_BUS_INSTRUCTION_CHARS, agentBusConfigSchema, agentBusWritableConfigSchema, agentBusIsActive, agentBusStartSchema, hasVisibleAgentBusText } from "../../src/client-protocol/agent-bus.js";
import { t } from "./i18n.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const busRequestDigest = (userId: string, requestId: string) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([userId, requestId])))).slice(0, 32);
/** Matches the Hub's durable owner/request identity; task text is not identity. */
export const busStartRunId = (userId: string, requestId: string) => `abr_${busRequestDigest(userId, requestId)}`;
/** The workspace one create request makes, so an uncertain create can be looked up. */
export const busCreatedId = (userId: string, requestId: string) => `ab_${busRequestDigest(userId, requestId)}`;
/** The start schema owns the common goal's limit; the editor counts against it. */
export const BUS_GOAL_CHARS = agentBusStartSchema.shape.text.maxLength ?? 48_000;
/** A Bot's name, with the member picker's ID suffix when names collide. */
export const busBotLabel = (bots: { id: string; name: string }[], id: string) => {
  const bot = bots.find(item => item.id === id);
  return !bot ? id : bots.some(other => other.id !== id && other.name === bot.name) ? `${bot.name} · ${id.slice(-6)}` : bot.name;
};

export const busModes: AgentBusMode[] = ["ask", "fan", "chain", "verify", "crew"];
export const busModeName = (mode: AgentBusMode) => ({ ask: t("单人委托"), fan: t("并行询问"), chain: t("串联步骤"), verify: t("回答后复核"), crew: t("研究团队") })[mode];
export const busModeDescription = (mode: AgentBusMode) => ({
  ask: t("交给一位成员，结果回到发起对话。"),
  fan: t("发起者与成员同时回答，保留各自结果。"),
  chain: t("按顺序接力，每一步接收上一步成果。"),
  verify: t("先回答，再复核。保留原答与复核意见。"),
  crew: t("拆解、研究、分析、撰写、审阅，组成完整团队。"),
})[mode];
export const busStatusName = (status?: AgentBusRunStatus) => status ? ({ queued: t("排队中"), running: t("协作中"), stopping: t("正在停止"), completed: t("已完成"), failed: t("未完成"), cancelled: t("已取消"), interrupted: t("已中断") })[status] : t("待启动");
export const busRoleName = (mode: AgentBusMode, index: number) => index < 0 ? t("发起者") : mode === "crew" ? [t("研究员"), t("分析员"), t("撰写者"), t("审阅者")][index] ?? t("成员") : mode === "chain" ? t("步骤 {0}", index + 1) : mode === "verify" ? t("复核者") : t("成员 {0}", index + 1);

/** Ask and chain coordinators only dispatch and report; fan, verify and crew
 * coordinators execute their own role, so only they accept an instruction. */
export const busCoordinatorExecutes = (mode: AgentBusMode) => mode === "fan" || mode === "verify" || mode === "crew";
/** Field name, prompt and the behavior of a blank instruction for one slot. */
export function busInstructionCopy(mode: AgentBusMode, index: number): { label: string; placeholder: string; blank: string } {
  if (index < 0 && mode === "crew") return { label: t("拆解要求"), placeholder: t("怎样拆解问题；留空则按默认方式拆解"), blank: t("按默认方式拆解") };
  if (index < 0 && mode === "verify") return { label: t("回答要求"), placeholder: t("怎样回答；留空则按共同目标回答"), blank: t("按共同目标回答") };
  if (mode === "fan") return { label: t("负责内容"), placeholder: t("负责哪一部分；留空则按共同目标回答"), blank: t("按共同目标回答") };
  if (mode === "verify") return { label: t("复核重点"), placeholder: t("重点核对什么；留空则按默认方式复核"), blank: t("按默认方式复核") };
  if (mode === "crew") return { label: t("角色要求"), placeholder: t("额外约束；留空则按默认角色执行"), blank: t("按默认角色执行") };
  if (mode === "chain") return { label: t("本步任务"), placeholder: t("这一步做什么、交付什么；留空则按共同目标执行"), blank: t("按共同目标执行") };
  return { label: t("任务"), placeholder: t("要做什么、交付什么；留空则按共同目标执行"), blank: t("按共同目标执行") };
}

const slotKey = Symbol("agentBusSlot");
let slotSequence = 0;
/** UI-only slot identity. A symbol key follows a member object through spreads
 * but is invisible to JSON and the strict protocol schema, so unsaved and
 * repeated Bots keep their own card, focus and draft while moving. */
export function busSlotKey(member: object): string {
  const slot = member as { [slotKey]?: string };
  return slot[slotKey] ??= `slot-${++slotSequence}`;
}

/** Compare drafts in their saved form: trimmed instructions, blanks omitted. */
export function busComparableConfig(config: AgentBusConfig): string {
  const member = ({ botId, conversationId, instruction }: AgentBusConfig["coordinator"]) => ({ botId, ...(conversationId ? { conversationId } : {}), ...(instruction && hasVisibleAgentBusText(instruction) ? { instruction: instruction.trim() } : {}) });
  const { name, mode, coordinator, members, maxResearchQuestions, maxRevisionRounds } = config;
  return JSON.stringify({ name: name.trim(), mode, coordinator: member(coordinator), members: members.map(member), maxResearchQuestions, maxRevisionRounds });
}

/** A conflicting PUT is confirmed only by its exact resolved configuration.
 * An omitted default record is an instruction, not a wildcard receipt. */
export function busDraftSaved(draft: AgentBusConfig, saved: AgentBusConfig): boolean {
  const parsed = agentBusConfigSchema.safeParse(draft);
  return parsed.success && [parsed.data.coordinator, ...parsed.data.members].every(member => !!member.conversationId)
    && busComparableConfig(parsed.data) === busComparableConfig(saved);
}

/** Only these create-specific failures roll back before writing the request
 * receipt. Auth, deletion and transport errors may follow a commit. */
export function busCreateRejected(error: unknown): boolean {
  return error instanceof Error && new Set([
    "invalid_request", "agent_bus_limit", "agent_bus_bot_unavailable", "agent_bus_conversation_archived",
    "agent_bus_conversation_unsupported", "agent_bus_conversation_bot_mismatch", "agent_bus_conversation_forbidden", "agent_bus_duplicate_member",
  ]).has(error.message);
}

/** Use only after replaying the original POST with its original payload. The
 * replay proves creation identity, not the origin of opaque record IDs. Only
 * apply a local name correction, preserving the entire current configuration.
 * Other draft/remote edits require review; a prior PUT needs an exact receipt. */
export function busRecoverCreatedConfig(original: AgentBusConfig, current: AgentBusConfig, draft: AgentBusConfig, attemptedUpdate?: AgentBusConfig): AgentBusConfig | undefined {
  const initial = agentBusConfigSchema.safeParse(original), desired = agentBusConfigSchema.safeParse(draft);
  if (!initial.success || !desired.success || initial.data.members.length !== current.members.length) return;
  if (busComparableConfig({ ...desired.data, name: initial.data.name }) !== busComparableConfig(initial.data)) return;
  const resolve = (slot: AgentBusConfig["coordinator"], held: AgentBusConfig["coordinator"] | undefined) => slot.conversationId ? slot : { ...slot, conversationId: held?.conversationId };
  const before = initial.data;
  const resolved = { ...before, coordinator: resolve(before.coordinator, current.coordinator), members: before.members.map((member, index) => resolve(member, current.members[index])) };
  if (!busDraftSaved(resolved, current) && !(attemptedUpdate && busDraftSaved(attemptedUpdate, current))) return;
  const { mode, coordinator, members, maxResearchQuestions, maxRevisionRounds } = current;
  const result = agentBusConfigSchema.safeParse({ name: desired.data.name, mode, coordinator, members, maxResearchQuestions, maxRevisionRounds });
  return result.success ? result.data : undefined;
}

/** Explain one schema rejection at a time, in form order. The shared schema
 * remains the authority for whether a configuration can be saved. */
export function busConfigIssue(config: AgentBusConfig): { field: keyof AgentBusConfig; message: string; index?: number } | undefined {
  const result = agentBusWritableConfigSchema.safeParse(config);
  if (result.success) return undefined;
  const issues = result.error.issues;
  const name = issues.find(issue => issue.path[0] === "name");
  if (name) return { field: "name", message: name.code === "too_big" ? t("Bus 名称最多 80 个字符。") : t("请输入 Bus 名称。") };
  const slot = (path: PropertyKey | undefined, index: number, notAStep = false) => {
    const role = busRoleName(config.mode, index);
    if (path === "conversationId") return t("请重新选择{0}的记录对话。", role);
    if (path !== "instruction") return t("请为{0}选择 Bot。", role);
    return notAStep ? t("{0}中的发起者只负责发起与汇报，请清空它的任务。", busModeName(config.mode)) : t("{0}的任务最多 {1} 字。", role, AGENT_BUS_INSTRUCTION_CHARS);
  };
  const coordinator = issues.find(issue => issue.path[0] === "coordinator");
  if (coordinator) return { field: "coordinator", index: -1, message: slot(coordinator.path[1], -1, coordinator.message === "agent_bus_coordinator_not_a_step") };
  const member = issues.find(issue => issue.path[0] === "members" && typeof issue.path[1] === "number");
  if (member) return { field: "members", index: member.path[1] as number, message: slot(member.path[2], member.path[1] as number) };
  const members = issues.find(issue => issue.message === "agent_bus_duplicate_member") ?? issues.find(issue => issue.message === "agent_bus_member_count") ?? issues.find(issue => issue.path[0] === "members");
  if (members) return { field: "members", message: members.message === "agent_bus_duplicate_member" ? t("同一个 Bot 可以重复参与，请为每个步骤选择不同的对话。") : members.message === "agent_bus_member_count" ? t("{0}需要 {1} 位成员。", busModeName(config.mode), config.mode === "crew" ? 4 : 1) : t("请选择 1–11 位成员。") };
  if (issues.some(issue => issue.path[0] === "maxResearchQuestions")) return { field: "maxResearchQuestions", message: t("研究问题上限请输入 1–10 的整数。") };
  if (issues.some(issue => issue.path[0] === "maxRevisionRounds")) return { field: "maxRevisionRounds", message: t("修订轮数上限请输入 0–3 的整数。") };
  return { field: "mode", message: t("请选择协作方式。") };
}

export function busMemberStatus(workspace: AgentBusWorkspace, run: AgentBusRun | undefined, member: Pick<AgentBusMember, "botId"> & { conversationId?: string }): string {
  if (!run) return t("待启动");
  const stages = run.stages.filter(stage => stage.botId === member.botId && stage.conversationId === member.conversationId);
  if (agentBusIsActive(run.status) && stages.some(stage => stage.status === "running")) return run.status === "stopping" ? t("正在停止") : t("执行中");
  const completed = stages.filter(stage => stage.status === "completed").length;
  if (stages.length > 1 && completed > 0 && completed < stages.length) return t("{0}/{1} 步完成", completed, stages.length);
  if (stages.some(stage => stage.status === "failed")) return t("未完成");
  if (stages.some(stage => stage.status === "cancelled")) return t("已取消");
  if (agentBusIsActive(run.status)) {
    if (run.status === "queued") return t("排队中");
    if (member.botId === workspace.coordinator.botId && member.conversationId === workspace.coordinator.conversationId) return t("协调中");
    return stages.length ? t("本步完成") : workspace.mode === "fan" || workspace.mode === "ask" ? t("等待执行") : t("等待接力");
  }
  if (stages.length && stages.every(stage => stage.status === "completed")) return t("已完成");
  if (!stages.length) return member.botId === workspace.coordinator.botId && member.conversationId === workspace.coordinator.conversationId ? busStatusName(run.status) : t("未执行");
  return busStatusName(run.status);
}
export function busErrorText(error: unknown, fallback = t("操作尚未确认。内容已保留，请检查连接后重试。")): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "agent_bus_create_review_required") return t("原 Bus 已找到。当前草稿已保留，请重新载入已创建的 Bus 后核对。");
  if (/collaboration_disabled_peers_requires_review/.test(code)) return t("停用的协作配置还包含未选中的 Bot，请先在协作设置中确认成员，再启用这组协作。");
  if (/collaboration_disabled_wildcard_requires_review/.test(code)) return t("已有全部 Bot 授权处于停用状态，请先在协作设置中改为具体成员，再启用这组协作。");
  if (/collaboration_listener_unknown/.test(code)) return t("尚未确认成员服务状态。请等待连接恢复后重新检查，权限没有改动。");
  if (code === "agent_bus_abandon_unavailable") return t("当前已不能结束等待，请关闭此提示并刷新运行状态。原任务没有被强制停止。");
  if (/agent_bus_bot_unavailable/.test(code)) return t("所选 Bot 已不可用，请重新选择成员。");
  if (/agent_bus_worker_update_required/.test(code)) return t("发起者的主机服务版本过旧，请更新后再启动协作。");
  if (/agent_bus_limit/.test(code)) return t("此主机已保存 64 个 Bus，请删除不再使用的配置后再创建。");
  // A loaded workspace that is no longer found was deleted, not unsupported.
  if (/agent_bus_deleted|agent_bus_not_found/.test(code)) return t("这个 Bus 已被删除。成员对话和消息仍然保留，请返回列表。");
  if (/agent_bus_duplicate_member/.test(code)) return t("同一个 Bot 可以重复参与，请为每个步骤选择不同的对话。");
  if (/agent_bus_coordinator_not_a_step/.test(code)) return t("单人委托和串联步骤中的发起者只负责发起与汇报，不能设置任务。");
  if (/agent_bus_conversation_archived/.test(code)) return t("记录对话已归档。请到左下角「工作台 → 已归档对话」恢复原记录对话，或在成员设置中改绑未归档的对话。");
  if (/agent_bus_conversation/.test(code)) return t("记录对话已变化。请选择属于该成员的未归档单人对话，或使用专用对话。");
  if (/idempotency_conflict|request_id_conflict/.test(code)) return t("这个请求编号已用于其他内容，请先核对原请求结果。");
  if (/invalid_request/.test(code)) return t("请求内容无效，请检查配置与输入后再提交。");
  if (/conflict|revision/.test(code)) return t("当前配置与主机记录不一致，请重新载入并核对。当前内容已保留。");
  if (/owner_required|forbidden|revoked/.test(code)) return t("当前设备没有此主机的管理权限。");
  if (/busy|active_run/.test(code)) return t("这组协作仍在执行，请完成或停止后再操作。");
  if (/member|conversation|peer/.test(code)) return t("成员或对话已变化，请检查选择与协作权限。");
  if (/not_found|unsupported|404/.test(code)) return t("此主机尚不支持 Agent Bus 工作区，或该 Bus 已被移除。请刷新并检查主机版本。");
  return fallback;
}

export function busPreparationErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (/conflict|revision/.test(code)) return t("成员协作权限已被修改，请重新检查并准备。已确认的权限修改会保留。");
  if (/collaboration_listener_unknown/.test(code)) return t("尚未确认成员服务状态，请等待连接恢复后重新检查。已确认的权限修改会保留。");
  return busErrorText(error, t("协作准备尚未完成，请检查连接后重试。已确认的权限修改会保留，尚未发送任务。"));
}

/** A failed poll has no mutation receipt to retry. Keep actionable known
 * rejections, but never label a network read failure as an uncertain write. */
export function busReadErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /owner_required|forbidden|revoked|not_found|deleted|unsupported|404/.test(code)
    ? busErrorText(error) : t("暂时无法刷新协作状态，连接恢复后会自动更新。");
}

/** Run failures are terminal evidence, not an instruction to retry a mutation. */
export function busRunErrorText(error: string): string {
  if (error === "agent_bus_wait_abandoned") return t("已结束等待，未重发任务。原任务可能仍在主机上执行，请确认成员对话后再启动新协作。");
  if (error === "agent_bus_output_not_delivered") return t("结果未完整交付，请查看发起者对话中的失败原因。已发送的附件不会自动重发。");
  if (/worker_update_required/.test(error)) return t("发起者的主机服务版本过旧，请更新后再启动协作。");
  // Stage records keep the Bus error code as a "[code] detail" prefix. Prefer
  // it over the detail text; older records only have the text.
  const code = error.match(/^\[([a-z_]+)\]/)?.[1];
  // Transport outcomes after a task was sent: the member may have started or
  // even finished. Say only what is known, and that nothing was resent.
  if (code === "connection_lost" || !code && /connection_lost|Connection .* was lost/i.test(error)) return t("等待结果时与成员的连接中断。成员可能已开始执行，结果未确认，未自动重发。请先查看成员对话中的记录。");
  if (code === "response_too_large" || !code && /response_too_large|Response from .* exceeds/i.test(error)) return t("成员返回的结果超过传输上限，未能带回，未自动重发。请先查看成员对话中的记录。");
  if (code === "invalid_response" || !code && /invalid_response|Invalid bus response/i.test(error)) return t("成员返回的内容无法识别，结果未确认，未自动重发。请先查看成员对话中的记录。");
  if (code === "request_too_large") return t("发给成员的内容（含上一步结果）超过传输上限，这一步未发送。");
  if (code === "timeout") return t("成员未在时限内返回，请查看已有结果后再决定是否重新运行。");
  if (code === "server_busy") return t("成员当前繁忙，协作未完成。请查看已有记录，稍后再启动。");
  if (code === "instance_unavailable") return t("成员当前不可用，请检查主机连接和成员服务。");
  if (code === "peer_not_allowed") return t("成员协作权限已变化，请检查权限后再发起新任务。");
  if (code === "bus_disabled") return t("协作尚未启用，请先检查并准备成员权限。");
  if (/result_unconfirmed|delivery_failed|interrupted/.test(error)) return t("主机连接或任务回执中断，未自动重发。请先查看成员对话中的已完成结果。");
  if (/agent_bus_not_executed/.test(error)) return t("协作未开始，请查看发起者对话中的权限、成员或预算提示。");
  if (/Bus is not enabled/i.test(error)) return t("协作尚未启用，请先检查并准备成员权限。");
  if (/peer_not_allowed|forbidden|revoked|not in the peer list/i.test(error)) return t("成员协作权限已变化，请检查权限后再发起新任务。");
  if (/timeout|timed.out/.test(error)) return t("成员未在时限内返回，请查看已有结果后再决定是否重新运行。");
  if (/unavailable|offline|not_found|not running or not registered|could not reach the bus server/i.test(error)) return t("成员当前不可用，请检查主机连接和成员服务。");
  return t("协作未能全部完成，请查看成员对话中的执行记录。");
}
