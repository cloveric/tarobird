import { describe, expect, it } from "vitest";
import { extractAntigravityTaskPlan, parseAntigravityTaskMarkdown } from "../src/codex/antigravity-task-plan.js";
import { publicPlanPreview, runPlanPreview, serializeRunPlanInput } from "../src/client-protocol/run-plan.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";
import type { RunEntry, RunSummary } from "../src/client-protocol/run.js";

describe("Antigravity task.md to-do list parsing (#95)", () => {
  it("parses pending, in-progress, and completed Markdown checkboxes while ignoring fenced code blocks", () => {
    const markdown = [
      "# Task Plan",
      "",
      "- [x] 1. Read `a.txt` (`alpha`)",
      "- [/] 2. Update adapter and UI",
      "- [ ] 3. Run unit tests",
      "  * [X] Sub-item done",
      "```markdown",
      "- [ ] Should be ignored inside code fence",
      "```",
    ].join("\n");

    expect(parseAntigravityTaskMarkdown(markdown)).toEqual([
      { content: "1. Read `a.txt` (`alpha`)", status: "completed" },
      { content: "2. Update adapter and UI", status: "in_progress" },
      { content: "3. Run unit tests", status: "pending" },
      { content: "Sub-item done", status: "completed" },
    ]);
  });

  it("extracts task.md updates from ACP tool_call_update diff newText and write_file Content", () => {
    const sessionId = "61c53ef3-4e39-4398-8ead-b30e026ab601";
    const diffUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      kind: "edit",
      status: "completed",
      name: "edit_file",
      title: `File .../brain/${sessionId}/task.md`,
      content: [
        {
          type: "diff",
          path: `/srv/state/.gemini/antigravity-cli/brain/${sessionId}/task.md`,
          oldText: "- [ ] Step 1\n- [ ] Step 2\n",
          newText: "- [x] Step 1\n- [/] Step 2\n",
        },
      ],
      rawInput: {
        ArtifactMetadata: { UserFacing: true, RequestFeedback: false, Summary: "Progress" },
        Path: `/srv/state/.gemini/antigravity-cli/brain/${sessionId}/task.md`,
      },
    };
    const extracted = extractAntigravityTaskPlan(diffUpdate, sessionId);
    expect(extracted?.isTaskArtifact).toBe(true);
    expect(extracted?.todos).toEqual([
      { content: "Step 1", status: "completed" },
      { content: "Step 2", status: "in_progress" },
    ]);

    // Non-task workspace files must NOT be treated as Antigravity's task plan.
    const normalEdit = {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_2",
      kind: "edit",
      status: "completed",
      name: "write_file",
      content: [{ type: "diff", path: "/srv/workspace/README.md", newText: "- [ ] Checklist item\n" }],
    };
    expect(extractAntigravityTaskPlan(normalEdit, sessionId)).toBeUndefined();
  });

  it("builds a bounded nativeRunPlan preview from the latest foreground plan entry", () => {
    const run: RunSummary = {
      version: 1, id: "run_1", revision: 4, phase: "working",
      startedAt: 1000, updatedAt: 2000, count: 2, completed: 1, failed: 0, truncated: false,
    };
    const entries: RunEntry[] = [
      { seq: 1, revision: 1, kind: "plan", status: "done", at: 1100, name: "TodoWrite", input: JSON.stringify({ todos: [{ content: "Old", status: "pending" }] }) },
      { seq: 2, revision: 3, kind: "plan", status: "done", at: 1500, name: "TodoWrite", input: JSON.stringify({ todos: [{ content: "Read config", status: "completed" }, { content: "Build UI", status: "in_progress" }, { content: "Ship PR", status: "pending" }] }) },
      { seq: 3, revision: 4, kind: "plan", status: "done", at: 1800, name: "TodoWrite", scope: { id: "sub_1", kind: "subagent" }, input: JSON.stringify({ todos: [{ content: "Child task", status: "pending" }] }) },
    ];
    const preview = publicPlanPreview(entries, run);
    expect(preview).toEqual({
      version: 1,
      runId: "run_1",
      revision: 4,
      seq: 2,
      items: [
        { content: "Read config", status: "completed" },
        { content: "Build UI", status: "in_progress" },
        { content: "Ship PR", status: "pending" },
      ],
    });
    expect(runPlanPreview({ extra: { nativeRunPlan: preview } }, run)).toEqual(preview);
    expect(runPlanPreview({ extra: { nativeRunPlan: preview, scopedRun: run } }, run)).toBeUndefined();
  });

  it("rejects non-edit tools and arbitrary workspace /brain/.../task.md paths while honoring structured locations", () => {
    const sessionId = "61c53ef3-4e39-4398-8ead-b30e026ab601";
    // Arbitrary run_command ending in /brain/.../task.md must NEVER be suppressed as a task artifact.
    expect(extractAntigravityTaskPlan({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_cmd",
      kind: "execute",
      status: "completed",
      name: "run_command",
      title: "rm -f /workspace/brain/task.md",
    }, sessionId)).toBeUndefined();

    // Reading task.md (kind: "read") is not a task artifact write.
    expect(extractAntigravityTaskPlan({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_read",
      kind: "read",
      status: "completed",
      name: "read_file",
      rawInput: { Path: `/srv/state/.gemini/antigravity-cli/brain/${sessionId}/task.md` },
    }, sessionId)).toBeUndefined();

    // Workspace write_file to /workspace/packages/brain/task.md without ArtifactMetadata or matching sessionId.
    expect(extractAntigravityTaskPlan({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_ws",
      kind: "edit",
      status: "completed",
      name: "write_file",
      title: "File /workspace/packages/brain/task.md",
      content: [{ type: "diff", path: "/workspace/packages/brain/task.md", newText: "- [ ] Workspace doc\n" }],
      rawInput: { Path: "/workspace/packages/brain/task.md", Content: "- [ ] Workspace doc\n" },
    }, sessionId)).toBeUndefined();

    // Structured update.locations[].path under Antigravity brain directory IS recognized.
    const fromLocations = extractAntigravityTaskPlan({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_loc",
      kind: "edit",
      status: "completed",
      name: "write_file",
      locations: [{ path: `/srv/state/.gemini/antigravity-cli/brain/other-session/task.md`, line: 1 }],
      rawInput: { Content: "- [x] From locations\n" },
    }, sessionId);
    expect(fromLocations).toEqual({
      isTaskArtifact: true,
      markdown: "- [x] From locations\n",
      todos: [{ content: "From locations", status: "completed" }],
    });

    // Diff-only tool_call_update (omitting path/rawInput/title/kind/name) still extracts when alreadyTaskArtifact is set.
    const diffOnly = extractAntigravityTaskPlan({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_diff_only",
      status: "completed",
      content: [{ type: "diff", newText: "- [x] Diff-only update\n" }],
    }, sessionId, undefined, { alreadyTaskArtifact: true, toolKind: "edit", toolName: "edit_file" });
    expect(diffOnly).toEqual({
      isTaskArtifact: true,
      markdown: "- [x] Diff-only update\n",
      todos: [{ content: "Diff-only update", status: "completed" }],
    });
  });

  it("ignores failed/uncompleted task.md updates, preserves literal $ tokens in Replacement, and handles Append", () => {
    const sessionId = "61c53ef3-4e39-4398-8ead-b30e026ab601";
    const taskPath = `/srv/state/.gemini/antigravity-cli/brain/${sessionId}/task.md`;
    const baseline = "- [ ] Fix price\n";

    // Failed or in-progress updates must not produce markdown or todos.
    expect(extractAntigravityTaskPlan({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_fail",
      kind: "edit",
      status: "failed",
      name: "write_file",
      content: [{ type: "diff", path: taskPath, newText: "- [x] Failed write\n" }],
      rawInput: { Path: taskPath, Content: "- [x] Failed write\n" },
    }, sessionId, baseline)).toEqual({ isTaskArtifact: true, todos: [] });

    expect(extractAntigravityTaskPlan({
      sessionUpdate: "tool_call",
      toolCallId: "call_pending",
      kind: "edit",
      status: "in_progress",
      name: "edit_file",
      rawInput: { Path: taskPath, Target: "- [ ] Fix price", Replacement: "- [x] Fix price" },
    }, sessionId, baseline)).toEqual({ isTaskArtifact: true, todos: [] });

    // Replacement containing JS special $ tokens must not be expanded.
    const dollarEdit = extractAntigravityTaskPlan({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_dollar",
      kind: "edit",
      status: "completed",
      name: "edit_file",
      rawInput: { Path: taskPath, Target: "- [ ] Fix price", Replacement: "- [x] Fix $$ and $& price" },
    }, sessionId, baseline);
    expect(dollarEdit).toEqual({
      isTaskArtifact: true,
      markdown: "- [x] Fix $$ and $& price\n",
      todos: [{ content: "Fix $$ and $& price", status: "completed" }],
    });

    // Append: true appends to previousMarkdown instead of wiping prior items.
    const appended = extractAntigravityTaskPlan({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_append",
      kind: "edit",
      status: "completed",
      name: "write_file",
      rawInput: { Path: taskPath, Content: "- [ ] Add tests\n", Append: true },
    }, sessionId, dollarEdit?.markdown);
    expect(appended).toEqual({
      isTaskArtifact: true,
      markdown: "- [x] Fix $$ and $& price\n- [ ] Add tests\n",
      todos: [
        { content: "Fix $$ and $& price", status: "completed" },
        { content: "Add tests", status: "pending" },
      ],
    });
  });

  it("keeps oversized TodoWrite plans valid within 32 KiB, reports accurate counts beyond 50 items, and selects highest-revision non-error plan", () => {
    const record = createRunRecord();
    // 55 items with 1-50 completed and 51-55 pending, plus large activeForm payloads exceeding 32 KiB when pretty-printed.
    const todos55 = Array.from({ length: 55 }, (_, i) => ({
      content: `Step ${i + 1}: ${"x".repeat(260)}`,
      activeForm: `Working on step ${i + 1}: ${"y".repeat(300)}`,
      status: i < 50 ? "completed" : "pending",
    }));
    recordRunEvent(record, { type: "tool_use", toolName: "TodoWrite", toolUseId: "plan_large", toolInput: { todos: todos55 } }, 1000);
    expect(record.entries[0]!.input!.length).toBeLessThanOrEqual(32768);
    expect(record.entries[0]!.truncated).toBeUndefined();
    const summaryLarge = summarizeRun(record, "running");
    const previewLarge = publicPlanPreview(record.entries, summaryLarge);
    expect(previewLarge).toBeDefined();
    expect(previewLarge?.items).toHaveLength(50);
    expect(previewLarge?.total).toBe(55);
    expect(previewLarge?.completed).toBe(50);
    expect(previewLarge?.truncated).toBe(true);
    expect(runPlanPreview({ extra: { nativeRunPlan: previewLarge } }, summaryLarge)).toEqual(previewLarge);

    // 80 max-length items compact cleanly without truncating mid-JSON.
    const todos80 = Array.from({ length: 80 }, (_, i) => ({ content: `${i + 1} ${"z".repeat(310)}`, status: "pending" as const }));
    const serialized80 = serializeRunPlanInput({ todos: todos80 });
    expect(serialized80.length).toBeLessThanOrEqual(32768);
    expect(() => JSON.parse(serialized80)).not.toThrow();

    // Selecting highest revision (even if updated in place at earlier seq) and skipping status:'error' entries.
    const r2 = createRunRecord();
    recordRunEvent(r2, { type: "tool_use", toolName: "TodoWrite", toolUseId: "p1", toolInput: { todos: [{ content: "v1", status: "pending" }] } }, 1000);
    recordRunEvent(r2, { type: "tool_use", toolName: "TodoWrite", toolUseId: "p2", toolInput: { todos: [{ content: "v2", status: "pending" }] } }, 1100);
    // In-place update on seq:1 raises its revision above seq:2.
    recordRunEvent(r2, { type: "tool_use", toolName: "TodoWrite", toolUseId: "p1", toolInput: { todos: [{ content: "v3 updated in place", status: "in_progress" }] } }, 1200);
    // A subsequent failed TodoWrite at seq:3 (status:'error') must be ignored in favor of the latest valid plan (p1).
    recordRunEvent(r2, { type: "tool_use", toolName: "TodoWrite", toolUseId: "p3", toolInput: { todos: [{ content: "errored plan", status: "completed" }] } }, 1300);
    recordRunEvent(r2, { type: "tool_result", toolUseId: "p3", output: "validation error", isError: true }, 1310);

    const s2 = summarizeRun(r2, "running");
    const preview2 = publicPlanPreview(r2.entries, s2);
    expect(preview2).toMatchObject({
      seq: 1,
      items: [{ content: "v3 updated in place", status: "in_progress" }],
    });
  });
});
