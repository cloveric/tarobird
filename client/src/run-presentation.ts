import type { RunEntry, RunScope, RunSummary } from "../../src/client-protocol/run.js";
import { runToolAction, runToolLabels } from "../../src/client-protocol/run-tools.js";
import { t } from "./i18n.js";
import type { Block } from "../../src/client-protocol/index.js";
import { backgroundTaskNotice } from "../../src/client-protocol/background-task.js";
import { conversationPreview } from "./conversation-preview.js";
import { z } from "zod";

const codexAgentState = z.object({ status: z.string().min(1).max(128), message: z.string().nullish() });
const codexAgentStates = z.record(z.string(), z.unknown());
/** A public state snapshot is not proof of a successful child task. Keep the
 * original output available even when a newer/truncated shape cannot parse. */
export function codexAgentReports(entry: RunEntry): Array<{ id: string; status: string; message: string | null; unreadable?: true }> | undefined {
  if (entry.kind !== "tool" || entry.name !== "CodexAgent" || entry.output === undefined) return;
  try {
    const parsed = codexAgentStates.safeParse(JSON.parse(entry.output));
    if (parsed.success && ["unrecognized_agent_states", "unserializable_agent_states"].includes(String(parsed.data.capture))) return;
    if (parsed.success) return Object.entries(parsed.data).map(([id, raw]) => {
      const state = codexAgentState.safeParse(raw);
      return state.success ? { id, status: state.data.status, message: state.data.message ?? null } : { id, status: "unknown", message: null, unreadable: true };
    });
  } catch { /* The raw output remains available. */ }
}
export function codexAgentStatus(status: string): string {
  switch (status) {
    case "pendingInit": return t("等待启动"); case "running": return t("执行中");
    case "interrupted": return t("已中断"); case "completed": return t("已完成");
    case "errored": return t("失败"); case "shutdown": return t("子代理已关闭"); case "notFound": return t("未找到");
    case "unknown": return t("状态待确认"); default: return status;
  }
}

/** Keep the full authored report. Only producer-owned card chrome is removed. */
export function runProse(block: Extract<Block, { type: "card" }>) {
  const background = backgroundTaskNotice(block);
  return block.elements.filter((entry, index) => index > 0 && entry.type === "markdown" && entry.text
    && entry.id !== "run_legacy_footer" && entry.id !== "run_background_note" && !(background && entry.id === "background_context"));
}
/** A literal preview, never an inferred result or a generated summary. */
export function runReportExcerpt(text: string, latest = false): string {
  const preview = conversationPreview(latest ? text.slice(-2048) : text.slice(0, 2048));
  if (latest) return (preview.length > 180 || text.length > 2048 ? "…" : "") + preview.slice(-180).replace(/^[\uDC00-\uDFFF]/, "");
  return preview.slice(0, 180) + (preview.length > 180 || text.length > 2048 ? "…" : "");
}
/** Conservative: a formatting false positive only offers the reader. A false
 * negative could make a link, image or formula unreachable from the preview. */
export function runReportNeedsFormatting(text: string): boolean {
  return /https?:\/\/|www\.|mailto:|[`*_~$<>|\\\[\]#&@]|^\s{0,3}\d+[.)]\s|^(?: {4}|\t)/m.test(text);
}

/** Labels are metadata: short inline emphasis need not become a new panel.
 * Real block structure, linked destinations and truncated text remain readable
 * on demand. Layout overflow is measured separately at the current width. */
export function scopedTaskDescription(text: string): { excerpt: string; expandable: boolean } {
  const excerpt = runReportExcerpt(text);
  return { excerpt, expandable: excerpt !== conversationPreview(text) || /[\r\n]|!?\[[^\]\n]*\]\(|^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~|>\s)/m.test(text) };
}

/** Compact units stay readable for both short tools and multi-day runs. */
export function formatRunDuration(ms: number, precise = false): string {
  const seconds = Math.max(0, Number.isFinite(ms) ? ms / 1000 : 0);
  if (seconds < 60) return `${precise ? seconds.toFixed(1) : Math.floor(seconds)}s`;
  const total = Math.floor(seconds), days = Math.floor(total / 86400), hours = Math.floor(total / 3600) % 24, minutes = Math.floor(total / 60) % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}

export function runInput(entry: RunEntry): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(entry.input ?? "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
export function runScopeLabel(scope: RunScope): string {
  const kind = scope.kind === "subagent" ? t("子代理") : t("后台任务");
  return scope.label ? `${kind} · ${scope.label}` : kind;
}
export function runScopeParent(scope: RunScope): string {
  return [scope.parentId ? t("父作用域：{0}", scope.parentId) : "", scope.parentCallId ? t("父调用：{0}", scope.parentCallId) : ""].filter(Boolean).join(" · ");
}
export function runKind(entry: RunEntry): "file" | "search" | "command" | "delegate" | "other" {
  const action = runToolAction(entry.name, runInput(entry));
  return action === "read" || action === "edit" ? "file" : action === "search" ? "search" : action === "execute" ? "command" : action === "delegate" ? "delegate" : "other";
}
export function runEntryTitle(entry: RunEntry): string {
  if (entry.kind === "text" && entry.name === "engine_retry") {
    if (entry.status === "running") return t("正在恢复任务");
    if (entry.status !== "waiting") return t("自动恢复任务");
    const reason = runInput(entry).reason;
    return reason === "capacity" ? t("等待模型服务恢复") : reason === "rate-limit" ? t("等待限流解除") : t("等待连接恢复");
  }
  if (entry.kind === "tool" && entry.name === "CodexAgent") {
    switch (runInput(entry).action) {
      case "spawnAgent": return t("启动子代理"); case "wait": return t("等待子代理");
      case "resumeAgent": return t("继续子代理"); case "closeAgent": return t("关闭子代理");
      case "sendInput": case "sendMessage": return t("向子代理发送消息");
      case "followupTask": return t("给子代理追加任务"); case "interruptAgent": return t("中断子代理");
      case "listAgents": return t("查看子代理"); default: return t("子代理");
    }
  }
  if (entry.kind === "text" && entry.name?.startsWith("subagent_")) {
    const title = entry.name === "subagent_started" ? t("子代理已启动") : entry.name === "subagent_interacted" ? t("与子代理交互")
      : entry.name === "subagent_interrupted" ? t("子代理已中断") : entry.name === "subagent_completed" ? t("子代理已完成") : t("子代理动态");
    const label = runInput(entry).label;
    return title + (typeof label === "string" && label ? ` · ${label.split("/").filter(Boolean).at(-1)}` : "");
  }
  if (entry.kind === "text" && entry.name === "background_review_wait") return t("等待后台结果处理");
  if (entry.kind === "text" && entry.name === "native_input_wait") return t("等待 Claude 读入");
  if (entry.kind === "text" && entry.name === "context_compaction") return entry.status === "running" ? t("正在压缩上下文") : t("压缩上下文");
  if (entry.kind === "text" && entry.name === "context_checkpoint") return entry.status === "running" ? t("正在整理上下文摘要") : t("整理上下文摘要");
  if (entry.kind === "text" && entry.name === "background_task_started") return t("后台任务已启动");
  if (entry.kind === "text" && entry.name === "background_task_finished") {
    const status = String(runInput(entry).status ?? "").trim().toLowerCase();
    if (["completed", "success", "succeeded"].includes(status)) return t("后台任务完成");
    if (["failed", "error"].includes(status)) return t("后台任务失败");
    if (["stopped", "cancelled", "canceled", "aborted"].includes(status)) return t("后台任务已停止");
    return t("后台任务更新");
  }
  if (entry.kind === "thinking") return t("公开思考摘要");
  if (entry.kind === "text") return t("Bot 说明");
  if (entry.kind === "plan") return t("执行计划");
  if (entry.kind === "question") return t("询问用户");
  const input = runInput(entry), labels = runToolLabels(input), kind = runKind(entry);
  const file = labels.file_path;
  if (kind === "delegate") return `${t("子代理")}${labels.description ? ` · ${labels.description.slice(0, 160)}` : ""}`;
  if (kind === "file") return `${runToolAction(entry.name, input) === "read" ? t("读取文件") : t("修改文件")}${file ? ` · ${file.split(/[\\/]/).at(-1)}` : ""}`;
  if (kind === "search") { const query = labels.query; return `${t("搜索资料")}${typeof query === "string" ? ` · ${query.slice(0, 120)}` : ""}`; }
  if (kind === "command" && Array.isArray(input.commandActions) && input.commandActions.length === 1) {
    const action = input.commandActions[0];
    if (action?.type === "read") { const file = typeof action.path === "string" ? action.path.split(/[\\/]/).at(-1) : typeof action.name === "string" ? action.name : ""; return `${t("读取文件")}${file ? ` · ${file}` : ""}`; }
    if (action?.type === "search") return `${t("搜索文件")}${typeof action.query === "string" ? ` · ${action.query.slice(0, 120)}` : ""}`;
    if (action?.type === "listFiles") return t("查看文件列表");
  }
  if (kind === "command") { const description = labels.description; return typeof description === "string" && description.trim() ? description.slice(0, 160) : t("执行命令"); }
  return entry.name ?? t("执行工具");
}
export function runPhaseLabel(phase: RunSummary["phase"]): string {
  switch (phase) {
    case "thinking": return t("正在思考"); case "working": return t("正在执行"); case "answering": return t("正在输出文字");
    case "waiting_approval": return t("等待授权"); case "waiting_answer": return t("等待回答"); case "stopping": return t("正在停止，等待确认");
    case "delivering": return t("正在交付结果"); case "done": return t("已完成"); case "partial": return t("部分完成");
    case "stopped": return t("已停止"); case "interrupted": return t("运行已中断"); case "error": return t("运行失败");
  }
}
export function entryStatus(entry: RunEntry): string {
  if (entry.kind === "text" && entry.name === "engine_retry" && entry.status === "waiting") return t("等待重试");
  if (entry.kind === "text" && entry.name === "engine_retry" && entry.status === "done") return t("已续接");
  if (entry.kind === "text" && entry.name?.startsWith("subagent_") && entry.status === "done") return t("已记录");
  if (entry.kind === "text" && entry.name?.startsWith("background_task_") && entry.status === "done") return t("已记录");
  switch (entry.status) { case "running": return t("执行中"); case "waiting": return t("等待确认"); case "done": return t("已完成"); case "error": return t("失败"); case "unknown": return t("未收到完成回执"); case "stopped": return t("已停止"); }
}
/** Only explicit HTTP(S) sources returned in the tool's output become links. */
export function runSources(output = ""): string[] {
  return [...new Set(output.match(/https?:\/\/[^\s<>"'`\]\[\\]+/g) ?? [])].flatMap(raw => { try { const url = new URL(raw.replace(/[),.。；]+$/, "")); return !url.username && !url.password ? [url.href] : []; } catch { return []; } }).slice(0, 30);
}
export function runDiff(entry: RunEntry): string | undefined {
  if (entry.changes?.length) return entry.changes.map(change => `${change.path}\n${change.diff}`).join("\n\n");
  if (runKind(entry) !== "file") return;
  const input = runInput(entry);
  const replacements = Array.isArray(input.ReplacementChunks) ? input.ReplacementChunks : Array.isArray(input.edit) ? input.edit : [input];
  const edits = replacements.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const before = item.old_string ?? item.old_str ?? item.old_text ?? item.old ?? item.TargetContent;
    const after = item.new_string ?? item.new_str ?? item.new_text ?? item.new ?? item.ReplacementContent;
    return typeof before === "string" && typeof after === "string" ? [before.split("\n").map(s => `- ${s}`).concat(after.split("\n").map(s => `+ ${s}`)).join("\n")] : [];
  });
  if (edits.length) return edits.join("\n\n");
  const patch = input.patch ?? input.input;
  if (typeof patch === "string" && /\*\*\* (Begin Patch|Update File)|^diff --git|^@@/m.test(patch)) return patch;
}

export function runExitCode(entry: RunEntry): number | undefined {
  // Printed stdout may itself contain JSON or a fake exit-status line. Only
  // structured metadata from the adapter establishes the command's exit code.
  return entry.exitCode;
}

export function runPlan(entry: RunEntry): Array<{ content: string; status: string }> {
  if (entry.kind !== "plan") return [];
  const input = runInput(entry);
  const todos = input.todos ?? input.entries ?? input.plan;
  return Array.isArray(todos) ? todos.flatMap(todo => todo && typeof todo.content === "string" && typeof todo.status === "string" ? [{ content: todo.content, status: todo.status }] : []) : [];
}
