import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { AgentBusConfig, AgentBusRun, AgentBusStage, AgentBusWorkspace } from "../../src/client-protocol/agent-bus.js";
import { agentBusConfigSchema } from "../../src/client-protocol/agent-bus.js";
import { busComparableConfig, busConfigIssue, busCoordinatorExecutes, busErrorText, busInstructionCopy, busPreparationErrorText, busReadErrorText, busMemberStatus, busRoleName, busRunErrorText, busSlotKey, busStartRunId } from "../src/agent-bus-view.js";
import { BUS_GOAL_CHARS, busBotLabel, busCreatedId, busCreateRejected, busDraftSaved, busRecoverCreatedConfig } from "../src/agent-bus-view.js";

const workspace: AgentBusWorkspace = {
  id: "bus", revision: "v1", name: "Research", mode: "chain", createdAt: 1, updatedAt: 1,
  coordinator: { botId: "main", conversationId: "main-chat" },
  members: [{ botId: "research", conversationId: "research-chat" }, { botId: "review", conversationId: "review-chat" }],
  maxResearchQuestions: 5, maxRevisionRounds: 1,
};
const stage = (botId: string, status: AgentBusStage["status"], id = botId): AgentBusStage => ({ id, botId, conversationId: `${botId}-chat`, status, startedAt: 1 });
const run = (status: AgentBusRun["status"], stages: AgentBusStage[] = []): AgentBusRun => ({ id: "run", workspaceId: "bus", messageId: "message", status, text: "Research", createdAt: 1, snapshot: structuredClone({ name: workspace.name, mode: workspace.mode, coordinator: workspace.coordinator, members: workspace.members, maxResearchQuestions: workspace.maxResearchQuestions, maxRevisionRounds: workspace.maxRevisionRounds }), stages });

describe("Agent Bus configuration next step", () => {
  const config = (changes: Partial<AgentBusConfig> = {}): AgentBusConfig => ({ ...run("completed").snapshot, ...changes });
  it("prioritizes the name, then coordinator, then the specific missing member over numeric options", () => {
    const draft = config({ name: "  ", coordinator: { botId: "" }, members: [{ botId: "" }], maxResearchQuestions: 1.5 });
    expect(busConfigIssue(draft)).toEqual({ field: "name", message: "请输入 Bus 名称。" });
    draft.name = "Research";
    expect(busConfigIssue(draft)).toEqual({ field: "coordinator", index: -1, message: "请为发起者选择 Bot。" });
    draft.coordinator = { botId: "main" };
    expect(busConfigIssue(draft)).toEqual({ field: "members", index: 0, message: "请为步骤 1选择 Bot。" });
    expect(busConfigIssue(config({ name: "x".repeat(81) }))).toEqual({ field: "name", message: "Bus 名称最多 80 个字符。" });
  });
  it("treats invisible-only names as empty and compares normalized draft text", () => {
    expect(busConfigIssue(config({ name: "\u200b\u200d" }))?.field).toBe("name");
    expect(busConfigIssue(config({ name: "家庭👨‍👩‍👧‍👦" }))).toBeUndefined();
    const original = config({ name: "Research", members: [{ botId: "research", instruction: "task" }] });
    expect(busComparableConfig({ ...original, name: "  Research  ", members: [{ botId: "research", instruction: " task " }] })).toBe(busComparableConfig(original));
    expect(busComparableConfig(config({ members: [{ botId: "research", instruction: "\u200b\u200d" }] }))).toBe(busComparableConfig(config({ members: [{ botId: "research" }] })));
  });
  it("identifies missing roles and rejects repeated participants and wrong member counts", () => {
    expect(busConfigIssue(config({ mode: "crew", members: [{ botId: "research" }, { botId: "" }, { botId: "writer" }, { botId: "review" }] }))?.message).toBe("请为分析员选择 Bot。");
    expect(busConfigIssue(config({ mode: "verify", members: [{ botId: "" }] }))?.message).toBe("请为复核者选择 Bot。");
    for (const members of [[{ botId: "main", conversationId: "main-chat" }], [{ botId: "research", conversationId: "shared-chat" }, { botId: "research", conversationId: "shared-chat" }]]) {
      expect(busConfigIssue(config({ members }))?.message).toBe("同一个 Bot 可以重复参与，请为每个步骤选择不同的对话。");
    }
    expect(busConfigIssue(config({ members: [] }))?.message).toBe("请选择 1–11 位成员。");
    expect(busConfigIssue(config({ members: Array.from({ length: 12 }, (_, i) => ({ botId: `member_${i}` })) }))?.message).toBe("请选择 1–11 位成员。");
    expect(busConfigIssue(config({ mode: "ask" }))?.message).toBe("单人委托需要 1 位成员。");
    expect(busConfigIssue(config({ mode: "crew" }))?.message).toBe("研究团队需要 4 位成员。");
    expect(busConfigIssue(config({ mode: "crew", members: [] }))?.message).toBe("研究团队需要 4 位成员。");
  });
  it("explains invalid Crew integers and range limits, including non-finite input", () => {
    const crew = config({ mode: "crew", members: ["research", "analysis", "writer", "review"].map(botId => ({ botId })) });
    for (const maxResearchQuestions of [0, 11, 1.5, NaN, Infinity]) {
      expect(busConfigIssue({ ...crew, maxResearchQuestions })).toEqual({ field: "maxResearchQuestions", message: "研究问题上限请输入 1–10 的整数。" });
    }
    for (const maxRevisionRounds of [-1, 4, 0.5, NaN, Infinity]) {
      expect(busConfigIssue({ ...crew, maxRevisionRounds })).toEqual({ field: "maxRevisionRounds", message: "修订轮数上限请输入 0–3 的整数。" });
    }
    for (const maxResearchQuestions of [1, 10]) for (const maxRevisionRounds of [0, 3]) {
      expect(busConfigIssue({ ...crew, maxResearchQuestions, maxRevisionRounds })).toBeUndefined();
    }
  });
  it("clears guidance for all valid modes and preserves the shared schema's trimmed-name behavior", () => {
    for (const mode of ["ask", "fan", "chain", "verify", "crew"] as const) {
      const members = (mode === "crew" ? ["research", "analysis", "writer", "review"] : ["research"]).map(botId => ({ botId }));
      expect(busConfigIssue(config({ mode, members, name: "  Research  " }))).toBeUndefined();
    }
  });
});

describe("Agent Bus evidence-based member status", () => {
  it("never shares status between the same Bot's different conversations", () => {
    const member = { botId: "main", conversationId: "main-second" };
    const same = { ...workspace, members: [member] };
    const current = run("running", [{ ...stage("main", "running"), conversationId: member.conversationId }]);
    expect(busMemberStatus(same, current, member)).toBe("执行中");
    expect(busMemberStatus(same, current, same.coordinator)).toBe("协调中");
    expect(busConfigIssue({ ...current.snapshot, coordinator: same.coordinator, members: [member, { botId: "main" }] })).toBeUndefined();
  });
  it("distinguishes a waiting member from a finished step while the coordinator remains active", () => {
    const current = run("running", [stage("research", "completed")]);
    expect(busMemberStatus(workspace, current, { botId: "main", conversationId: "main-chat" })).toBe("协调中");
    expect(busMemberStatus(workspace, current, { botId: "research", conversationId: "research-chat" })).toBe("本步完成");
    expect(busMemberStatus(workspace, current, { botId: "review", conversationId: "review-chat" })).toBe("等待接力");
    expect(busMemberStatus(workspace, run("queued"), { botId: "review", conversationId: "review-chat" })).toBe("排队中");
    expect(busMemberStatus({ ...workspace, mode: "fan" }, current, { botId: "review", conversationId: "review-chat" })).toBe("等待执行");
    expect(busMemberStatus({ ...workspace, mode: "ask" }, current, { botId: "review", conversationId: "review-chat" })).toBe("等待执行");
  });
  it("shows a repeated crew stage still running even when its earlier stage failed", () => {
    const current = run("running", [stage("research", "failed", "first"), stage("research", "running", "retry")]);
    expect(busMemberStatus(workspace, current, { botId: "research", conversationId: "research-chat" })).toBe("执行中");
    expect(busMemberStatus(workspace, { ...current, status: "stopping" }, { botId: "research", conversationId: "research-chat" })).toBe("正在停止");
  });
  it("retains finished evidence after cancellation and never marks an unexecuted member complete", () => {
    const current = run("cancelled", [stage("research", "completed")]);
    expect(busMemberStatus(workspace, current, { botId: "research", conversationId: "research-chat" })).toBe("已完成");
    expect(busMemberStatus(workspace, current, { botId: "review", conversationId: "review-chat" })).toBe("未执行");
    expect(busMemberStatus(workspace, run("completed"), { botId: "review", conversationId: "review-chat" })).toBe("未执行");
    expect(busMemberStatus(workspace, current, { botId: "main", conversationId: "main-chat" })).toBe("已取消");
  });
  it("keeps cancelled steps cancelled while stopping and ignores stale running flags after the run ends", () => {
    expect(busMemberStatus(workspace, run("stopping", [stage("review", "cancelled")]), { botId: "review", conversationId: "review-chat" })).toBe("已取消");
    expect(busMemberStatus(workspace, run("cancelled", [stage("review", "running")]), { botId: "review", conversationId: "review-chat" })).toBe("已取消");
    expect(busMemberStatus(workspace, run("interrupted", [stage("review", "running")]), { botId: "review", conversationId: "review-chat" })).toBe("已中断");
  });
  it("counts mixed terminal steps per member without erasing partial completed work", () => {
    const stages = [stage("review", "completed", "draft"), stage("review", "failed", "revision"), stage("review", "cancelled", "final"), stage("research", "completed", "research")];
    for (const status of ["failed", "cancelled", "interrupted"] as const) expect(busMemberStatus(workspace, run(status, stages), { botId: "review", conversationId: "review-chat" })).toBe("1/3 步完成");
    expect(busMemberStatus(workspace, run("running", stages), { botId: "review", conversationId: "review-chat" })).toBe("1/3 步完成");
    expect(busMemberStatus(workspace, run("completed", [stage("review", "completed", "draft"), stage("review", "completed", "revision")]), { botId: "review", conversationId: "review-chat" })).toBe("已完成");
  });
  it("does not hide a failed recorded member step behind the overall completed state", () => {
    expect(busMemberStatus(workspace, run("completed", [stage("review", "failed")]), { botId: "review", conversationId: "review-chat" })).toBe("未完成");
    expect(busMemberStatus(workspace, undefined, { botId: "main", conversationId: "main-chat" })).toBe("待启动");
  });
});

it("names ordered and crew roles without treating the coordinator as a participant step", () => {
  expect(busRoleName("chain", -1)).toBe("发起者");
  expect(busRoleName("chain", 2)).toBe("步骤 3");
  expect([0, 1, 2, 3].map(index => busRoleName("crew", index))).toEqual(["研究员", "分析员", "撰写者", "审阅者"]);
  expect(busRoleName("verify", 0)).toBe("复核者");
});

it("separates stale edits from uncertain operations and does not expose raw server details", () => {
  expect(busPreparationErrorText(new Error("collaboration_conflict"))).toContain("重新检查并准备");
  expect(busPreparationErrorText(new Error("collaboration_conflict"))).not.toContain("重新载入");
  expect(busPreparationErrorText(new Error("collaboration_listener_unknown"))).toContain("已确认的权限修改会保留");
  expect(busPreparationErrorText(new Error("socket closed"))).not.toContain("请求编号");
  expect(busReadErrorText(new Error("socket closed: /private/host-token"))).toContain("自动更新");
  expect(busReadErrorText(new Error("socket closed"))).not.toContain("请求编号");
  expect(busReadErrorText(new Error("agent_bus_not_found"))).toContain("已被删除");
  expect(busReadErrorText(new Error("device_revoked"))).toContain("管理权限");
  expect(busErrorText(new Error("agent_bus_revision_conflict"))).toContain("当前内容已保留");
  expect(busErrorText(new Error("agent_bus_active_run"))).toContain("仍在执行");
  expect(busErrorText(new Error("owner_required"))).toContain("管理权限");
  expect(busErrorText(new Error("collaboration_disabled_wildcard_requires_review"))).toContain("具体成员");
  expect(busErrorText(new Error("collaboration_listener_unknown"))).toContain("权限没有改动");
  const uncertain = busErrorText(new Error("socket closed: /private/host-token"));
  expect(uncertain).toBe("操作尚未确认。内容已保留，请检查连接后重试。");
  expect(uncertain).not.toContain("请求编号");
  expect(uncertain).not.toContain("host-token");
});


it("distinguishes known request rejection from uncertain delivery and stale configuration", () => {
  for (const [code, meaning] of [
    ["agent_bus_bot_unavailable", "重新选择成员"],
    ["agent_bus_worker_update_required", "服务版本过旧"],
    ["agent_bus_limit", "64 个 Bus"],
    ["agent_bus_deleted", "已被删除"],
    ["agent_bus_conversation", "未归档单人对话"],
    ["request_id_conflict", "请求编号"],
    ["invalid_request", "请求内容无效"],
  ]) {
    const message = busErrorText(new Error(code));
    expect(message).toContain(meaning);
    expect(message).not.toContain("操作尚未确认");
    expect(message).not.toContain("当前配置与主机记录不一致");
  }
});

it("matches the Hub owner/request run identity without using task text", () => {
  const owner = "owner", request = "bus_request-123";
  expect(busStartRunId(owner, request)).toBe(`abr_${createHash("sha256").update(JSON.stringify([owner, request])).digest("hex").slice(0, 32)}`);
  expect(busStartRunId(owner, request)).not.toBe(busStartRunId("another_owner", request));
  expect(busStartRunId(owner, request)).not.toBe(busStartRunId(owner, "another_request"));
});

it("directs archived record recovery without suggesting the same archived dedicated conversation", () => {
  const message = busErrorText(new Error("agent_bus_conversation_archived"));
  expect(message).toContain("工作台 → 已归档对话");
  expect(message).toContain("恢复原记录对话");
  expect(message).toContain("改绑未归档");
  expect(message).not.toContain("使用专用对话");
  expect(message).not.toContain("操作尚未确认");
});

it("sanitizes terminal run errors and never treats a terminal failure as an uncertain mutation retry", () => {
  expect(busRunErrorText("agent_bus_output_not_delivered")).toContain("结果未完整交付");
  expect(busRunErrorText("agent_bus_output_not_delivered")).toContain("不会自动重发");
  expect(busRunErrorText("agent_bus_output_not_delivered")).not.toContain("连接");
  expect(busRunErrorText("agent_bus_result_unconfirmed: /private/token=secret")).toContain("未自动重发");
  expect(busRunErrorText("peer_not_allowed")).toContain("协作权限已变化");
  expect(busRunErrorText("request timed out after 2000ms")).toContain("未在时限内返回");
  expect(busRunErrorText("bot_offline")).toContain("成员当前不可用");
  for (const error of ["agent_bus_result_unconfirmed: /private/token=secret", "engine exploded: /private/token=secret", "request timed out: /private/token=secret"]) {
    const message = busRunErrorText(error);
    expect(message).not.toContain("/private");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("同一请求编号");
  }
});


it("maps actual Bus client errors to safe actionable guidance", () => {
  for (const error of ['Instance "private-bot" is not in the peer list']) {
    expect(busRunErrorText(error)).toContain("协作权限");
    expect(busRunErrorText(error)).not.toContain("private-bot");
  }
  for (const error of ['Instance "private-bot" is not running or not registered on the bus', "could not reach the bus server"]) {
    expect(busRunErrorText(error)).toContain("成员当前不可用");
    expect(busRunErrorText(error)).not.toContain("private-bot");
  }
  expect(busRunErrorText("Bus is not enabled on this instance")).toContain("协作尚未启用");
  expect(busRunErrorText("agent_bus_not_executed")).toContain("发起者对话");
  expect(busRunErrorText("agent_bus_not_executed")).not.toContain("成员对话");
  expect(busErrorText(new Error("idempotency_conflict"))).toContain("请求编号");
  expect(busErrorText(new Error("idempotency_conflict"))).not.toContain("当前配置与主机记录不一致");
});

describe("Agent Bus per-slot instructions", () => {
  const chain = (changes: Partial<AgentBusConfig> = {}): AgentBusConfig => ({ name: "Research", mode: "chain", coordinator: { botId: "main" }, members: [{ botId: "research" }, { botId: "review" }], maxResearchQuestions: 5, maxRevisionRounds: 1, ...changes });
  it("lets only executing coordinators carry a task, and names it after the role", () => {
    expect((["ask", "fan", "chain", "verify", "crew"] as const).filter(busCoordinatorExecutes)).toEqual(["fan", "verify", "crew"]);
    expect(busInstructionCopy("chain", 0).label).toBe("本步任务");
    expect(busInstructionCopy("fan", -1).label).toBe(busInstructionCopy("fan", 2).label);
    expect(busInstructionCopy("verify", -1).label).toBe("回答要求");
    expect(busInstructionCopy("verify", 0).label).toBe("复核重点");
    expect(busInstructionCopy("crew", -1).label).toBe("拆解要求");
    expect(busInstructionCopy("crew", 3).label).toBe("角色要求");
    for (const mode of ["ask", "fan", "chain", "verify", "crew"] as const) for (const index of [-1, 0]) {
      const copy = busInstructionCopy(mode, index);
      expect(copy.placeholder).toContain("留空");
      expect(copy.blank).not.toBe("");
    }
  });
  it("compares drafts in their saved form so blank or padded tasks are not unsaved edits", () => {
    const saved = chain({ members: [{ botId: "research", conversationId: "research-chat", instruction: "整理公司研究" }, { botId: "review" }] });
    const draft = chain({ members: [{ instruction: "  整理公司研究\n", conversationId: "research-chat", botId: "research" }, { botId: "review", instruction: "   " }] });
    expect(busComparableConfig(draft)).toBe(busComparableConfig(saved));
    expect(busComparableConfig(chain())).toBe(busComparableConfig(chain({ members: [{ botId: "research", instruction: "" }, { botId: "review" }] })));
    expect(busComparableConfig(chain({ members: [{ botId: "research", instruction: "估值" }, { botId: "review" }] }))).not.toBe(busComparableConfig(chain()));
    // The comparison form is exactly what the shared schema saves.
    expect(JSON.parse(busComparableConfig(draft))).toEqual(JSON.parse(JSON.stringify(agentBusConfigSchema.parse(draft))));
  });
  it("keeps a UI-only slot identity through edits without reaching JSON or the strict schema", () => {
    const first = { botId: "research" }, repeated = { botId: "research" };
    expect(busSlotKey(first)).not.toBe(busSlotKey(repeated));
    const { botId: _, ...rest } = { ...first, instruction: "研究" };
    expect(busSlotKey({ ...rest, botId: "review" })).toBe(busSlotKey(first));
    expect(JSON.stringify(first)).toBe('{"botId":"research"}');
    expect(agentBusConfigSchema.safeParse(chain({ members: [first, repeated] })).success).toBe(true);
  });
  it("points instruction problems at the exact slot", () => {
    expect(busConfigIssue(chain({ coordinator: { botId: "main", instruction: "研究" } }))).toEqual({ field: "coordinator", index: -1, message: "串联步骤中的发起者只负责发起与汇报，请清空它的任务。" });
    expect(busConfigIssue(chain({ mode: "fan", coordinator: { botId: "main", instruction: "研究" } }))).toBeUndefined();
    expect(busConfigIssue(chain({ members: [{ botId: "research" }, { botId: "review", instruction: "x".repeat(8001) }] }))).toEqual({ field: "members", index: 1, message: "步骤 2的任务最多 8000 字。" });
    expect(busConfigIssue(chain({ members: [{ botId: "research", instruction: ` ${"x".repeat(8000)} ` }, { botId: "review" }] }))).toBeUndefined();
    expect(busErrorText(new Error("agent_bus_coordinator_not_a_step"))).toContain("只负责发起与汇报");
  });
  it("describes post-send transport failures conservatively and without peer names", () => {
    const cases = [
      ['Connection to "private-bot" was lost while waiting for the result; execution may have started and the task was not resent', "连接中断"],
      ["connection_lost", "连接中断"],
      ['Response from "private-bot" exceeds the 16 MiB limit; the task was not resent', "超过传输上限"],
      ['Invalid bus response from "private-bot"', "无法识别"],
      ['Delegation to "private-bot" timed out after 1800 seconds', "未在时限内返回"],
    ] as const;
    for (const [error, meaning] of cases) {
      const message = busRunErrorText(error);
      expect(message).toContain(meaning);
      expect(message).not.toContain("private-bot");
      expect(message).not.toMatch(/已完成|已中止|已停止|不可用/);
    }
    for (const [error] of cases.slice(0, 4)) expect(busRunErrorText(error)).toContain("未自动重发");
  });
  it("prefers the recorded [code] prefix over the detail text", () => {
    expect(busRunErrorText('[connection_lost] Connection to "private-bot" was lost while waiting for the result')).toContain("连接中断");
    expect(busRunErrorText("[timeout] engine said: unavailable")).toContain("未在时限内返回");
    expect(busRunErrorText("[instance_unavailable] timed out probing")).toContain("成员当前不可用");
    expect(busRunErrorText("[request_too_large] agent_bus_request_too_large")).toContain("这一步未发送");
    expect(busRunErrorText("[response_too_large] x")).toContain("超过传输上限");
    expect(busRunErrorText("[invalid_response] x")).toContain("无法识别");
    expect(busRunErrorText("[peer_not_allowed] agent_bus_target_not_in_run")).toContain("协作权限");
    expect(busRunErrorText("[cancelled] Delegation was cancelled")).not.toMatch(/连接中断|时限|不可用/);
  });
});

describe("2026-10-19 re-audit helpers", () => {
  it("releases only creation identities whose transaction definitely rejected the payload", () => {
    for (const code of ["invalid_request", "agent_bus_limit", "agent_bus_bot_unavailable", "agent_bus_conversation_archived", "agent_bus_conversation_unsupported", "agent_bus_conversation_bot_mismatch", "agent_bus_conversation_forbidden", "agent_bus_duplicate_member"])
      expect(busCreateRejected(new Error(code))).toBe(true);
    for (const code of ["owner_required", "device_revoked", "forbidden", "403", "404", "agent_bus_deleted", "agent_bus_not_found", "agent_bus_conflict", "idempotency_conflict", "socket closed", "prefix agent_bus_conversation_archived"])
      expect(busCreateRejected(new Error(code))).toBe(false);
    expect(busCreateRejected("agent_bus_conversation_archived")).toBe(false);
    expect(busErrorText(new Error("agent_bus_create_review_required"))).toContain("草稿已保留");
  });
  it("derives the Hub's created workspace ID from the same owner/request identity", () => {
    const digest = createHash("sha256").update(JSON.stringify(["owner", "bus_request"])).digest("hex").slice(0, 32);
    expect(busCreatedId("owner", "bus_request")).toBe(`ab_${digest}`);
    expect(busCreatedId("owner", "bus_request")).not.toBe(busCreatedId("other", "bus_request"));
  });
  it("confirms saved drafts only when every record binding is explicit and matches", () => {
    const draft: AgentBusConfig = { name: " Research ", mode: "chain", coordinator: { botId: "main" }, members: [{ botId: "research", conversationId: "research-chat", instruction: " collect sources " }, { botId: "review" }], maxResearchQuestions: 5, maxRevisionRounds: 1 };
    const saved = { ...workspace, members: [{ botId: "research", conversationId: "research-chat", instruction: "collect sources" }, { botId: "review", conversationId: "review-chat" }] };
    expect(busDraftSaved(draft, saved)).toBe(false);
    expect(busDraftSaved({ ...draft, coordinator: saved.coordinator, members: saved.members }, saved)).toBe(true);
    expect(busDraftSaved(draft, { ...saved, members: [saved.members[0]!, { botId: "review", conversationId: "another-devices-chat" }] })).toBe(false);
    expect(busDraftSaved({ ...draft, members: [draft.members[0]!, { botId: "review", conversationId: "other-chat" }] }, saved)).toBe(false);
    expect(busDraftSaved({ ...draft, members: [{ ...draft.members[0]!, instruction: "something else" }, draft.members[1]!] }, saved)).toBe(false);
    expect(busDraftSaved({ ...draft, name: "Renamed" }, saved)).toBe(false);
  });
  it("preserves every current record binding during a name-only creation recovery", () => {
    const original: AgentBusConfig = { ...run("completed").snapshot, coordinator: { botId: "main" }, members: [{ botId: "research" }, { botId: "review" }] };
    const draft = { ...original, name: " Renamed " }, before = structuredClone(original);
    expect(busRecoverCreatedConfig(original, workspace, draft)).toEqual({ ...agentBusConfigSchema.parse(original), name: "Renamed", coordinator: workspace.coordinator, members: workspace.members });
    expect(busDraftSaved(busRecoverCreatedConfig(original, workspace, original)!, workspace)).toBe(true);
    expect(original).toEqual(before);
    // An opaque default ID may have changed elsewhere. Preserve that current
    // ID during a name-only edit, rather than resetting it to a default record.
    const rebound = { ...workspace, members: [workspace.members[0]!, { botId: "review", conversationId: "another-devices-chat" }] };
    const recovered = busRecoverCreatedConfig(original, rebound, draft)!;
    expect(recovered.members).toEqual(rebound.members);
    expect(recovered.coordinator).toEqual(rebound.coordinator);
    expect(recovered.name).toBe("Renamed");
  });
  it("does not recover over another device's changed tasks, name, limits or explicit bindings", () => {
    const original = run("completed").snapshot, draft = { ...original, name: "Local name" };
    for (const current of [
      { ...workspace, name: "Remote name" },
      { ...workspace, maxRevisionRounds: 2 },
      { ...workspace, members: [{ ...workspace.members[0]!, instruction: "Remote task" }, workspace.members[1]!] },
      { ...workspace, members: [{ ...workspace.members[0]!, conversationId: "remote-record" }, workspace.members[1]!] },
    ]) expect(busRecoverCreatedConfig(original, current, draft)).toBeUndefined();
    const defaults = { ...original, members: [{ botId: "research" }, { botId: "review" }] };
    expect(busRecoverCreatedConfig(defaults, { ...workspace, members: [{ ...workspace.members[0]!, instruction: "Remote task" }, workspace.members[1]!] }, { ...defaults, name: "Local name" })).toBeUndefined();
  });
  it("does not infer records for changed or reordered default Bots during create recovery", () => {
    const original = { ...run("completed").snapshot, members: [{ botId: "research" }, { botId: "review" }] };
    expect(busRecoverCreatedConfig(original, workspace, { ...original, members: [...original.members].reverse() })).toBeUndefined();
    expect(busRecoverCreatedConfig(original, workspace, { ...original, members: [{ botId: "other" }, original.members[1]!] })).toBeUndefined();
    expect(busRecoverCreatedConfig(original, workspace, { ...original, members: [{ botId: "research", conversationId: "chosen-record" }, original.members[1]!] })).toBeUndefined();
    expect(busRecoverCreatedConfig(original, workspace, { ...original, members: [{ botId: "research", instruction: "New local task" }, original.members[1]!] })).toBeUndefined();
  });
  it("confirms a recovery update whose response was lost only by its exact resolved payload", () => {
    const original = { ...run("completed").snapshot, coordinator: { botId: "main" }, members: [{ botId: "research" }, { botId: "review" }] };
    const draft = { ...original, name: "Renamed" }, attempted = { ...run("completed").snapshot, name: "Renamed" }, current = { ...workspace, name: "Renamed" };
    expect(busRecoverCreatedConfig(original, current, draft)).toBeUndefined();
    expect(busRecoverCreatedConfig(original, current, draft, attempted)).toEqual(attempted);
    expect(busRecoverCreatedConfig(original, { ...current, members: [{ ...current.members[0]!, instruction: "Later remote task" }, current.members[1]!] }, draft, attempted)).toBeUndefined();
  });
  it("labels only Bots whose names collide with the same suffix as the member picker", () => {
    const bots = [{ id: "research", name: "研究助手" }, { id: "research_twin", name: "研究助手" }, { id: "review", name: "审阅助手" }];
    expect(busBotLabel(bots, "research")).toBe("研究助手 · search");
    expect(busBotLabel(bots, "research_twin")).toBe("研究助手 · h_twin");
    expect(busBotLabel(bots, "review")).toBe("审阅助手");
    expect(busBotLabel(bots, "missing")).toBe("missing");
  });
  it("uses the start schema's goal limit and explains a deleted Bus without blaming the host version", () => {
    expect(BUS_GOAL_CHARS).toBe(48_000);
    expect(busErrorText(new Error("agent_bus_not_found"))).toContain("已被删除");
    expect(busErrorText(new Error("agent_bus_not_found"))).not.toContain("主机版本");
    expect(busErrorText(new Error("agent_bus_run_not_found"))).not.toContain("已被删除");
  });
});

it("distinguishes a busy member from a broken connection without promising no execution", () => {
  expect(busRunErrorText("[server_busy] capacity exhausted")).toContain("成员当前繁忙");
  expect(busRunErrorText("[server_busy] capacity exhausted")).not.toContain("未执行");
});
