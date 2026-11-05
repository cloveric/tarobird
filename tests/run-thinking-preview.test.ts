import { describe, expect, it } from "vitest";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";
import { publicThinkingPreview, runThinkingPreview } from "../src/client-protocol/run-thinking.js";
import { forwardedBlocks } from "../src/client-protocol/forwarding.js";
import type { Block } from "../src/client-protocol/index.js";

describe("live public thinking preview", () => {
  it("keeps new public progress when one thinking block exceeds the journal text limit", () => {
    const record = createRunRecord();
    recordRunEvent(record, { type: "thinking", text: "old-prefix:" + "a".repeat(33000), delta: false });
    recordRunEvent(record, { type: "thinking", text: "最新进展：核对完成。", delta: true });
    const run = summarizeRun(record, "running");
    expect(publicThinkingPreview(record.entries, run)?.text).toMatch(/最新进展：核对完成。$/);
    expect(record.entries[0]).toMatchObject({ truncated: true });
    expect(record.entries[0].text?.length).toBeLessThanOrEqual(32768);
    // A cap landing inside an astral character must not leave an orphan UTF-16 unit.
    recordRunEvent(record, { type: "thinking", text: "😀" + "b".repeat(32767), delta: false });
    expect(record.entries[1].text).toBe("b".repeat(32767));
    recordRunEvent(record, { type: "thinking", text: "下一步", delta: true });
    expect(publicThinkingPreview(record.entries, summarizeRun(record, "running"))?.text).toMatch(/下一步$/);
  });
  it("keeps only the latest foreground thought, including deltas while tools run", () => {
    const record = createRunRecord();
    recordRunEvent(record, { type: "thinking", text: "较早摘要", delta: false });
    recordRunEvent(record, { type: "thinking", text: "较长公开摘要".repeat(500), delta: false });
    recordRunEvent(record, { type: "thinking", text: "最新进展：核对归档文件。", delta: true });
    recordRunEvent(record, { type: "tool_use", toolName: "Bash", toolUseId: "tool", toolInput: { command: "DO_NOT_PREVIEW_COMMAND" } });
    recordRunEvent(record, { type: "scoped", scope: { id: "child", kind: "subagent" }, event: { type: "thinking", text: "DO_NOT_PREVIEW_CHILD" } });
    const run = summarizeRun(record, "running"), preview = publicThinkingPreview(record.entries, run)!;
    expect(preview.text.length).toBeLessThanOrEqual(600);
    expect(preview).toMatchObject({ runId: run.id, revision: run.revision, truncated: true });
    expect(preview.text).toMatch(/最新进展：核对归档文件。$/);
    expect(JSON.stringify(preview)).not.toMatch(/DO_NOT_PREVIEW|较早摘要/);
    expect(run.current?.name).toBe("Bash");
    expect(JSON.stringify(run)).not.toContain("最新进展");
    const block: Extract<Block, { type: "card" }> = { type: "card", elements: [], extra: { nativeRun: run, nativeRunThinking: preview } };
    expect(runThinkingPreview(block, run)).toEqual(preview);
    expect(runThinkingPreview(block, { ...run, id: "another" })).toBeUndefined();
    expect(runThinkingPreview(block, { ...run, revision: run.revision + 1 })).toBeUndefined();
    expect(runThinkingPreview({ extra: { ...block.extra, scopedRun: run } }, run)).toBeUndefined();
    expect(JSON.stringify(forwardedBlocks([block], new Map()))).not.toContain("nativeRunThinking");
    for (const phase of ["done", "error", "stopped", "interrupted", "partial"] as const) {
      expect(publicThinkingPreview(record.entries, { ...run, phase })).toBeUndefined();
      expect(runThinkingPreview(block, { ...run, phase })).toBeUndefined();
    }
  });
  it("does not invent thoughts from reply text, tool output, empty or malformed evidence", () => {
    const record = createRunRecord();
    recordRunEvent(record, { type: "assistant_text", text: "正常回复" });
    recordRunEvent(record, { type: "tool_use", toolName: "Read", toolUseId: "read" });
    recordRunEvent(record, { type: "tool_result", toolUseId: "read", output: "工具结果" });
    recordRunEvent(record, { type: "thinking", text: "   " });
    const run = summarizeRun(record, "running");
    expect(publicThinkingPreview(record.entries, run)).toBeUndefined();
    expect(publicThinkingPreview([{ ...record.entries[0], kind: "thinking", text: (() => "bad") as any }], run)).toBeUndefined();
    expect(runThinkingPreview({ extra: { nativeRunThinking: { version: 2, text: "未知格式" } } }, run)).toBeUndefined();
  });
});
