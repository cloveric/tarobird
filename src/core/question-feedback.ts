import type { EngineAnswerProgress } from "../codex/adapter.js";
import { runToolAction } from "../client-protocol/run-tools.js";
import type { Locale } from "../runtime/locale.js";
import type { AnswerFollowup } from "../client-protocol/answer-followup.js";

export type AsyncAnswerPhase = AnswerFollowup["phase"];
/** Host-observed answer lifecycle, independent of the engine or task outcome. */
export function asyncAnswerFeedback(phase: AsyncAnswerPhase, locale: Locale): string {
  const en = locale === "en";
  switch (phase) {
    case "queued": return en ? "Answer queued, waiting to be processed; no need to submit again." : "答案已排队，等待处理，无需重复提交。";
    case "sent": return en ? "Answer delivered to the current task. Follow-up progress will appear in this conversation." : "答案已送达当前任务，后续进展会显示在对话中。";
    case "processing": return en ? "Processing your answer. Follow-up progress will appear in this conversation." : "正在处理你的补充答案，后续进展会显示在对话中。";
    case "finished": return en ? "Follow-up reply generated. See the conversation for the result." : "已生成后续回复，请查看对话中的结果。";
    case "interrupted": return en ? "Follow-up stopped. Your submitted answer is kept here." : "后续处理已停止，你的补充答案保留在此。";
    case "failed": return en ? "Follow-up failed. Your answer is kept here; check the conversation before retrying." : "后续处理失败，你的答案保留在此，请查看对话后再决定是否重试。";
    case "skipped": return en ? "Queued answer not delivered: the task or session changed. Your answer is kept here." : "排队中的答案未送达，任务或会话已变化，你的答案保留在此。";
    case "blocked": return en ? "Follow-up could not start. Your answer is kept here; see the conversation for the reason." : "后续处理未能开始，你的答案保留在此，请查看对话中的原因。";
  }
}

/** A receipt is evidence of submission, not proof that the whole task succeeded. */
export function questionFeedback(progress: EngineAnswerProgress | undefined, locale: Locale): string {
  const en = locale === "en";
  switch (progress?.phase) {
    case "sent": return en ? "Answer sent to Claude. Waiting for its follow-up; no need to submit again." : "答案已发送给 Claude，等待后续回复，无需重复提交。";
    case "thinking": return en ? "Follow-up: Claude is processing your answer." : "后续进展：Claude 正在处理你的答案。";
    case "working": {
      const action = runToolAction(progress.toolName);
      const labels = { read: ["读取文件", "reading files"], edit: ["修改文件", "editing files"], search: ["检索信息", "searching"], execute: ["执行命令", "running a command"], plan: ["更新计划", "updating the plan"], delegate: ["调用子代理", "delegating to a subagent"], other: ["执行工具", "using a tool"] };
      return en ? `Follow-up: Claude is ${labels[action][1]}.` : `后续进展：Claude 正在${labels[action][0]}。`;
    }
    case "replying": return en ? "Follow-up: Claude is preparing its reply." : "后续进展：Claude 正在整理回复。";
    case "finished": return en ? "Claude has generated the follow-up. See the conversation for its result." : "Claude 已生成后续回复，请查看对话中的结果。";
    case "interrupted": return en ? "The follow-up was interrupted. Your submitted answer is kept here; check the task before retrying." : "后续处理已中断。你的答案保留在此，请核实任务状态后再决定是否重试。";
    case "unknown": return en ? "The follow-up status is unconfirmed. Your answer is kept here; check the conversation before retrying." : "后续处理状态未确认。你的答案保留在此，请查看对话后再决定是否重试。";
    case "waiting_input": return en ? "Claude needs another confirmation. Please check the new question or approval." : "Claude 需要进一步确认，请查看新的问题或审批。";
    default: return en ? "Answer received; no need to submit again. Follow-up progress will appear in this conversation." : "答案已收到，无需重复提交。后续进展会显示在对话中。";
  }
}
