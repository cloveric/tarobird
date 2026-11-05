import { describe, it, expect } from "vitest";
import { diffRows, diffExcerpt, diffDisplayColumns } from "../src/diff-view-rows.js";
import { highlightLines, highlightDiff } from "../src/diff-highlight.js";
import type { WorkspaceFileDiff } from "../../src/client-protocol/workspace-diff.js";
const file = { file: { path: "example.ts" }, hunks: [{ header: "@@ -2,2 +2,3 @@", lines: [
  { kind: "delete", text: "old", oldLine: 2, newLine: null, clipped: false },
  { kind: "add", text: "new", oldLine: null, newLine: 2, clipped: false },
  { kind: "add", text: "extra", oldLine: null, newLine: 3, clipped: false },
  { kind: "context", text: "same", oldLine: 3, newLine: 4, clipped: false },
] }] } as WorkspaceFileDiff;
describe("diff visible rows", () => {
  it("reserves scroll width for CJK, emoji and tabs", () => { expect(diffDisplayColumns("ab中😀\t")).toBe(10); expect(diffDisplayColumns("中".repeat(4096))).toBe(8192); });
  it("pairs unequal removals/additions without changing either side's line identity", () => {
    const rows = diffRows(file, true); expect(rows).toHaveLength(4); expect(rows[1]!.left!.oldLine).toBe(2); expect(rows[1]!.right!.newLine).toBe(2); expect(rows[2]!.left).toBeUndefined(); expect(rows[2]!.right!.newLine).toBe(3);
    expect(diffRows(file, false)).toHaveLength(5); expect(diffExcerpt(file, "old", 2, 3)).toEqual(["old", "same"]); expect(diffExcerpt(file, "new", 2, 4)).toEqual(["new", "extra", "same"]);
  });
  it("keeps multiline highlight ancestry and text without interpreting HTML", () => {
    const lines = highlightLines([{ type: "element", tagName: "span", properties: { className: ["hljs-comment", "bad class"] }, children: [{ type: "text", value: "/* first\nsecond */<script>" }] }]);
    expect(lines).toEqual([[{ text: "/* first", classes: ["hljs-comment"] }], [{ text: "second */<script>", classes: ["hljs-comment"] }]]);
  });
  it("does not import or run highlighting for large diffs", async () => {
    expect((await highlightDiff({ ...file, hunks: [{ ...file.hunks[0]!, lines: Array(201).fill(file.hunks[0]!.lines[0]) }] })).size).toBe(0);
    expect((await highlightDiff({ ...file, hunks: [{ ...file.hunks[0]!, lines: [{ ...file.hunks[0]!.lines[0]!, text: "中".repeat(12000) }] }] })).size).toBe(0);
  });
  it("leaves mid-file fragments plain when their preceding lexical state is unknown", async () => {
    const fragment = { ...file, hunks: [{ ...file.hunks[0]!, lines: [{ kind: "context", text: "still inside a block comment */", oldLine: 42, newLine: 42, clipped: false }] }] } as WorkspaceFileDiff;
    expect((await highlightDiff(fragment)).size).toBe(0);
  });
});
