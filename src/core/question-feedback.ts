import type { EngineAnswerProgress } from "../codex/adapter.js";
import { runToolAction } from "../client-protocol/run-tools.js";
import type { Locale } from "../runtime/locale.js";
import { hostT } from "../locales/index.js";
import type { AnswerFollowup } from "../client-protocol/answer-followup.js";

export type AsyncAnswerPhase = AnswerFollowup["phase"];
/** Host-observed answer lifecycle, independent of the engine or task outcome. */
export function asyncAnswerFeedback(phase: AsyncAnswerPhase, locale: Locale): string {
  switch (phase) {
    case "queued": return hostT(locale, "答案已排队，等待处理，无需重复提交。");
    case "sent": return hostT(locale, "答案已送达当前任务，后续进展会显示在对话中。");
    case "processing": return hostT(locale, "正在处理你的补充答案，后续进展会显示在对话中。");
    case "finished": return hostT(locale, "已生成后续回复，请查看对话中的结果。");
    case "interrupted": return hostT(locale, "后续处理已停止，你的补充答案保留在此。");
    case "failed": return hostT(locale, "后续处理失败，你的答案保留在此，请查看对话后再决定是否重试。");
    case "skipped": return hostT(locale, "排队中的答案未送达，任务或会话已变化，你的答案保留在此。");
    case "blocked": return hostT(locale, "后续处理未能开始，你的答案保留在此，请查看对话中的原因。");
  }
}

/** A receipt is evidence of submission, not proof that the whole task succeeded. */
export function questionFeedback(progress: EngineAnswerProgress | undefined, locale: Locale): string {
  switch (progress?.phase) {
    case "sent": return hostT(locale, "答案已发送给 Claude，等待后续回复，无需重复提交。");
    case "thinking": return hostT(locale, "后续进展：Claude 正在处理你的答案。");
    case "working": {
      const action = runToolAction(progress.toolName);
      const keys = {
        read: "后续进展：Claude 正在读取文件。",
        edit: "后续进展：Claude 正在修改文件。",
        search: "后续进展：Claude 正在检索信息。",
        execute: "后续进展：Claude 正在执行命令。",
        plan: "后续进展：Claude 正在更新计划。",
        delegate: "后续进展：Claude 正在调用子代理。",
        other: "后续进展：Claude 正在执行工具。",
      } as const;
      return hostT(locale, keys[action]);
    }
    case "replying": return hostT(locale, "后续进展：Claude 正在整理回复。");
    case "finished": return hostT(locale, "Claude 已生成后续回复，请查看对话中的结果。");
    case "interrupted": return hostT(locale, "后续处理已中断。你的答案保留在此，请核实任务状态后再决定是否重试。");
    case "unknown": return hostT(locale, "后续处理状态未确认。你的答案保留在此，请查看对话后再决定是否重试。");
    case "waiting_input": return hostT(locale, "Claude 需要进一步确认，请查看新的问题或审批。");
    default: return hostT(locale, "答案已收到，无需重复提交。后续进展会显示在对话中。");
  }
}
