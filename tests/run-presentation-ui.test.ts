import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";
import { expect, it } from "vitest";
import { entryStatus, formatRunDuration, runEntryTitle, runExitCode, runDiff, runSources, runKind, runProse, runReportExcerpt, runReportNeedsFormatting, scopedTaskDescription } from "../client/src/run-presentation.js";
import type { Block } from "../src/client-protocol/index.js";
import type { RunEntry } from "../src/client-protocol/run.js";

const command: RunEntry = { seq: 1, revision: 1, at: 1, kind: "tool", name: "Bash", status: "error" };
it("does not split an emoji at the latest excerpt boundary", () => {
  const excerpt = runReportExcerpt("好😀".repeat(150) + "ab", true);
  expect(excerpt).toMatch(/^…/);
  expect(excerpt).not.toMatch(/^…[\uDC00-\uDFFF]/);
  expect(excerpt).toMatch(/好😀ab$/);
  expect(excerpt.length).toBeLessThanOrEqual(181);
});
it("shows recovery as a waiting host activity, preserves prior evidence, and settles it on actual continuation", () => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "tool_use", toolName: "Bash", toolUseId: "earlier", toolInput: { command: "PRIVATE_COMMAND" } }, 500);
  recordRunEvent(record, { type: "engine_retry", status: "waiting", attempt: 1, reason: "capacity", delayMs: 5000 }, 1000);
  const summary = summarizeRun(record, "running");
  expect(summary).toMatchObject({ phase: "working", count: 1, current: { name: "engine_retry", status: "waiting", at: 1000 } });
  expect(runEntryTitle(summary.current!)).toBe("等待模型服务恢复");
  expect(entryStatus(summary.current!)).toBe("等待重试");
  expect(JSON.parse(summary.current!.input!)).toEqual({ reason: "capacity", attempt: 1, delayMs: 5000 });
  expect(JSON.stringify(summary)).not.toContain("PRIVATE_COMMAND");
  expect(record.entries[0]).toMatchObject({ status: "unknown", endedAt: 1000 });
  expect(record.entries[0].input).toContain("PRIVATE_COMMAND");
  recordRunEvent(record, { type: "engine_retry", status: "retrying", attempt: 1, reason: "capacity", delayMs: 0 }, 6000);
  expect(runEntryTitle(summarizeRun(record, "running").current!)).toBe("正在恢复任务");
  recordRunEvent(record, { type: "engine_retry", status: "resumed", attempt: 1, reason: "capacity", delayMs: 0 }, 6500);
  recordRunEvent(record, { type: "tool_use", toolName: "Read", toolUseId: "next", toolInput: { file_path: "/next.md" } }, 6501);
  expect(runEntryTitle(summarizeRun(record, "running").current!)).toBe("读取文件 · next.md");
  expect(record.entries.find(e => e.name === "engine_retry")).toMatchObject({ status: "done", endedAt: 6500 });
  expect(entryStatus(record.entries.find(e => e.name === "engine_retry")!)).toBe("已续接");
  expect(record.endedAt).toBeUndefined();
});

it("does not mistake repeated failed recovery attempts or Stop for success", () => {
  const record = createRunRecord();
  const retry = { type: "engine_retry" as const, reason: "connection" as const, delayMs: 2000 };
  recordRunEvent(record, { ...retry, status: "waiting", attempt: 1 });
  recordRunEvent(record, { ...retry, status: "retrying", attempt: 1 });
  recordRunEvent(record, { ...retry, status: "waiting", attempt: 2 });
  expect(record.entries[0].status).toBe("error");
  expect(runEntryTitle(summarizeRun(record, "running").current!)).toBe("等待连接恢复");
  recordRunEvent(record, { ...retry, status: "cancelled", attempt: 2 });
  expect(record.entries[1].status).toBe("stopped");
  expect(summarizeRun(record, "interrupted").current).toBeUndefined();
  recordRunEvent(record, { ...retry, status: "retrying", attempt: 2 });
  expect(record.entries[1].status).toBe("stopped");
});
it.each(["[文件](https://example.com/file)", "https://example.com/file", "![封面](https://example.com/image.png)", "$x^2$", "*请检查*", "me@example.com", "1. first"])("keeps a complete renderer for short formatted report %s", text => {
  expect(runReportNeedsFormatting(text)).toBe(true);
  expect(runReportNeedsFormatting("核对完毕。")).toBe(false);
});
it("shows recent public progress while preserving the report opening after completion", () => {
  const text = "初始计划。" + "检查过程。".repeat(500) + "最新进展：封面已交付。";
  expect(runReportExcerpt(text, true)).toMatch(/^….*最新进展：封面已交付。$/);
  expect(runReportExcerpt(text)).toMatch(/^初始计划。/);
  expect(runReportExcerpt(text, true)).toHaveLength(181);
});
it("preserves complete report text and strips only validated producer-owned background chrome", () => {
  const text = "## 结果\n\n" + "公开原文。".repeat(500) + "\n\n[交付文件](https://example.com/file)";
  const block: Extract<Block, { type: "card" }> = { type: "card", extra: { backgroundTask: { version: 1, origin: "bound" } }, elements: [
    { type: "markdown", text: "后台任务已完成" }, { type: "markdown", id: "background_context", text: "关联请求提示" },
    { type: "markdown", text }, { type: "markdown", id: "run_legacy_footer", text: "按钮" },
  ] };
  expect(runProse(block).map(entry => entry.text)).toEqual([text]);
  expect(runReportExcerpt(text)).toHaveLength(181);
  expect(runReportExcerpt(text)).toContain("结果");
  expect(runReportExcerpt(text)).not.toContain("##");
  expect(block.elements[2].text).toBe(text);
  expect(runProse({ ...block, extra: { backgroundTask: {} } }).map(entry => entry.text)).toEqual(["关联请求提示", text]);
});
it.each(["Agent", "Task"])("labels Claude %s by its explicit assignment, without exposing the prompt", name => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "tool_use", toolName: name, toolUseId: "child", toolInput: { description: "核对报告", prompt: "PRIVATE_PROMPT" } });
  expect(runEntryTitle(record.entries[0])).toBe("子代理 · 核对报告");
  expect(runEntryTitle(summarizeRun(record, "running").current!)).toBe("子代理 · 核对报告");
  expect(runKind(record.entries[0])).toBe("delegate");
  expect(JSON.stringify(summarizeRun(record, "running"))).not.toContain("PRIVATE_PROMPT");
});
it("never mistakes printed text for an actual exit status", () => {
  expect(runExitCode({ ...command, output: "Process exited with code 0" })).toBeUndefined();
  expect(runExitCode({ ...command, output: '{"exitCode":0}' })).toBeUndefined();
  expect(runExitCode({ ...command, output: "Process exited with code 0", exitCode: 2 })).toBe(2);
});
it("uses explicit command actions and diffs, and excludes credential-bearing sources", () => {
  expect(runEntryTitle({ ...command, input: JSON.stringify({ commandActions: [{ type: "read", path: "C:\\work\\report.md" }] }) })).toContain("report.md");
  expect(runDiff({ ...command, name: "Edit", changes: [{ path: "/report", diff: "- old\n+ new" }] })).toContain("+ new");
  expect(runSources("https://secret:password@example.com https://example.com/docs")).toEqual(["https://example.com/docs"]);
});

it.each([
  ["Codex", "commandExecution", { commandActions: [{ type: "read", path: "/report.md" }] }],
  ["Claude", "Read", { file_path: "/report.md" }],
  ["AGY", "view_file", { AbsolutePath: "/report.md" }],
  ["Kimi", "ReadFile", { path: "/report.md" }],
  ["DeepSeek", "read_file", { path: "/report.md" }],
  ["DeepSeek editor view", "str_replace_editor", { command: "view", path: "/report.md" }],
])("renders the actual %s tool naming in both summary and journal", (_engine, name, input) => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "tool_use", toolName: name as string, toolUseId: "read", toolInput: input });
  expect(runEntryTitle(summarizeRun(record, "running").current!)).toBe("读取文件 · report.md");
  expect(runEntryTitle(record.entries[0])).toBe("读取文件 · report.md");
});
it.each(["TodoWrite", "SetTodoList", "todo_write", "update_plan"])("correlates %s receipts as plans, including unnamed Claude results", name => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "tool_use", toolName: name, toolUseId: "plan", toolInput: { todos: [{ content: "Check", status: "pending" }] } });
  recordRunEvent(record, { type: "tool_result", toolUseId: "plan", output: "failed", isError: true });
  expect(record.entries).toHaveLength(1);
  expect(record.entries[0]).toMatchObject({ kind: "plan", status: "error" });
  expect(summarizeRun(record, "running").count).toBe(0);
});
it("shows AGY multi edits and ACP diffs even when an ACP title is descriptive", () => {
  const edit = { ...command, name: "multi_replace_file_content", input: JSON.stringify({ TargetFile: "/report", ReplacementChunks: [{ TargetContent: "before", ReplacementContent: "after" }] }) };
  expect(runDiff(edit)).toBe("- before\n+ after");
  expect(runDiff({ ...command, name: "Update the report", changes: [{ path: "/report", diff: "-before\n+after" }] })).toContain("+after");
  expect(runEntryTitle({ ...command, name: "mcp__search__web_search", input: JSON.stringify({ Query: "reference" }) })).toBe("搜索资料 · reference");
});


it.each([[0,"0s"],[59000,"59s"],[60000,"1m 0s"],[517000,"8m 37s"],[3599999,"59m 59s"],[3600000,"1h 0m"],[90061000,"1d 1h 1m"],[-10,"0s"],[Infinity,"0s"]])("formats elapsed %s without hundreds of seconds", (ms, expected) => {
  expect(formatRunDuration(ms as number)).toBe(expected);
});
it("retains subsecond detail for short tools", () => expect(formatRunDuration(1250, true)).toBe("1.3s"));

it("shows compaction as an engine activity without inventing a tool or completing the turn", () => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "context_compaction", id: "compact-1", status: "started" }, 1000);
  const summary = summarizeRun(record, "running");
  expect(summary).toMatchObject({ phase: "working", count: 0, current: { kind: "text", name: "context_compaction", status: "running" } });
  expect(runEntryTitle(summary.current!)).toBe("正在压缩上下文");
  expect(summary.endedAt).toBeUndefined();
  recordRunEvent(record, { type: "context_compaction", id: "compact-1", status: "completed" }, 119000);
  expect(record.entries).toHaveLength(1);
  expect(runEntryTitle(record.entries[0])).toBe("压缩上下文");
  expect(record.entries[0]).toMatchObject({ status: "done", at: 1000, endedAt: 119000 });
  expect(summarizeRun(record, "running")).toMatchObject({ phase: "thinking", count: 0, current: undefined });
  expect(record.endedAt).toBeUndefined();
  recordRunEvent(record, { type: "context_compaction", id: "compact-1", status: "started" }, 120000);
  expect(record.entries[0].status).toBe("done");
  expect(summarizeRun(record, "running").current).toBeUndefined();
});

it("retains failed and stopped compaction receipts without claiming success", () => {
  for (const status of ["failed", "stopped"] as const) {
    const record = createRunRecord();
    recordRunEvent(record, { type: "context_compaction", id: "compact-1", status: "started" });
    if (status === "failed") recordRunEvent(record, { type: "context_compaction", id: "compact-1", status: "failed" });
    else summarizeRun(record, "interrupted");
    expect(record.entries[0].status).toBe(status === "failed" ? "error" : "stopped");
    expect(summarizeRun(record, status === "failed" ? "running" : "interrupted").current).toBeUndefined();
    if (status === "stopped") {
      recordRunEvent(record, { type: "context_compaction", id: "compact-1", status: "completed" });
      expect(record.entries[0].status).toBe("stopped");
    }
  }
});

it("shows an unconfirmed compaction deadline without claiming native failure", () => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "context_compaction", id: "slow", status: "started" }, 1000);
  recordRunEvent(record, { type: "context_compaction", id: "slow", status: "unknown" }, 301000);
  expect(record.entries[0]).toMatchObject({ name: "context_compaction", status: "unknown", endedAt: 301000 });
  expect(summarizeRun(record, "running").current).toBeUndefined();
  recordRunEvent(record, { type: "context_compaction", id: "slow", status: "completed" }, 325000);
  expect(record.entries).toHaveLength(1);
  expect(record.entries[0].status).toBe("done");
});

it("ends an unconfirmed maintenance spinner on real resumed output without falsely completing it", () => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "context_compaction", id: "automatic", status: "started" }, 1000);
  recordRunEvent(record, { type: "assistant_text", text: "Continuing" }, 2000);
  expect(record.entries[0].status).toBe("unknown");
  expect(summarizeRun(record, "running")).toMatchObject({ phase: "answering", current: undefined });
  recordRunEvent(record, { type: "context_compaction", id: "automatic", status: "completed" }, 3000);
  expect(record.entries[0].status).toBe("done");
  expect(summarizeRun(record, "running").phase).toBe("answering");
});

it("keeps a completion-only AGY checkpoint distinct from compaction and preserves its native duration", () => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "assistant_text", text: "Already answering" }, 1000);
  recordRunEvent(record, { type: "context_compaction", checkpoint: true, id: "cp", status: "completed", durationMs: 8725.516 }, 10000);
  expect(record.entries[1]).toMatchObject({ name: "context_checkpoint", status: "done", durationMs: 8725.516 });
  expect(runEntryTitle(record.entries[1])).toBe("整理上下文摘要");
  expect(summarizeRun(record, "running")).toMatchObject({ phase: "answering", count: 0, current: undefined });
});


it("does not invent a zero duration for a completion-only maintenance receipt", () => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "context_compaction", id: "boundary-only", status: "completed" }, 1000);
  expect(record.entries[0]).toMatchObject({ status: "done" });
  expect(record.entries[0].endedAt).toBeUndefined();
  expect(record.entries[0].durationMs).toBeUndefined();
});

it("shows real background-review admission without counting it as a tool or answer", () => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "background_review_wait", status: "started" }, 1000);
  const summary = summarizeRun(record, "running");
  expect(summary).toMatchObject({ phase: "working", count: 0, current: { kind: "text", name: "background_review_wait", status: "waiting" } });
  expect(runEntryTitle(summary.current!)).toBe("等待后台结果处理");
  recordRunEvent(record, { type: "background_review_wait", status: "finished" }, 2000);
  expect(summarizeRun(record, "running")).toMatchObject({ phase: "thinking", count: 0 });
  expect(summarizeRun(record, "running").current).toBeUndefined();
  expect(record.entries[0]).toMatchObject({ status: "done", endedAt: 2000 });
});


it("shows native child lifecycle receipts without inventing tools or a completed parent", () => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "assistant_text", text: "Parent is still working" });
  for (const [kind, title] of [["started", "子代理已启动"], ["interacted", "与子代理交互"], ["interrupted", "子代理已中断"], ["completed", "子代理已完成"]] as const) {
    const event = { type: "subagent_activity" as const, id: `activity-${kind}`, kind, agentId: "child-1", label: "/root/reviewer", model: "fixture-model", effort: "xhigh" };
    recordRunEvent(record, event); recordRunEvent(record, event);
    const entry = record.entries.at(-1)!;
    expect(runEntryTitle(entry)).toBe(`${title} · reviewer`);
    expect(entryStatus(entry)).toBe("已记录");
    expect(entry.input).toContain("fixture-model");
    expect(entry.endedAt).toBeUndefined();
  }
  expect(record.entries).toHaveLength(5);
  expect(summarizeRun(record, "running")).toMatchObject({ count: 0, phase: "answering", endedAt: undefined });
  expect(runKind({ ...command, name: "CodexAgent" })).toBe("delegate");
  expect(runKind({ ...command, name: "mcp.example.CodexAgent" })).not.toBe("delegate");
});

it.each(['Review changes', 'Fix #123', 'review foo_bar.ts', 'A & B', '**Review PR**'])("keeps short task metadata simple: %s", text => {
  const description = scopedTaskDescription(text);
  expect(description.expandable).toBe(false);
  expect(description.excerpt).not.toContain('**');
});
it.each(['## Review', 'first\n\nsecond', '- one item', '[reference](https://example.com)', '```text\nunfinished', '长说明'.repeat(166)])("offers disclosure for structured or truncated task metadata: %s", text => {
  const description = scopedTaskDescription(text);
  expect(description.expandable).toBe(true);
  expect(description.excerpt.length).toBeLessThanOrEqual(181);
  expect(description.excerpt).not.toMatch(/\*\*|##|```/);
});

it("shows native input waiting without claiming the model is thinking or counting a tool", () => {
  const record = createRunRecord();
  recordRunEvent(record, { type: "native_input_wait", status: "started" }, 1000);
  const summary = summarizeRun(record, "running");
  expect(summary).toMatchObject({ phase: "working", count: 0, current: { name: "native_input_wait", status: "waiting" } });
  expect(runEntryTitle(summary.current!)).toBe("等待 Claude 读入");
  recordRunEvent(record, { type: "native_input_wait", status: "finished" }, 2000);
  expect(summarizeRun(record, "running").current).toBeUndefined();
});
