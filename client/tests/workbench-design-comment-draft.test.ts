import { describe, expect, it } from "vitest";
import { bindWorkbenchDraft, mergeDesignCommentDraft, type WorkbenchDraft } from "../src/workbench-draft.js";
const design = (id = "canvas-a", revision = 3, ids = ["thread-a"]): WorkbenchDraft => ({ context: { kind: "design", target: { deviceId: "device", windowId: "window", tabId: id }, revision }, files: [], designComments: ids });

describe("design comment draft ownership", () => {
  it("refuses comments from another canvas without changing the original association", () => {
    const original = design(), before = structuredClone(original);
    expect(() => mergeDesignCommentDraft(original, design("canvas-b", 8, ["thread-b"]))).toThrow("workbench_design_draft_target_changed");
    expect(original).toEqual(before);
  });
  it("does not merge an identically named tab from another device", () => {
    const other = design(); other.context.target.deviceId = "another-device";
    expect(() => mergeDesignCommentDraft(design(), other)).toThrow("workbench_design_draft_target_changed");
  });
  it("merges same-design IDs without duplicates and keeps the earliest document revision", () => {
    const original = design("slides-a", 3, ["thread-a", "thread-b"]), incoming = design("slides-a", 9, ["thread-b", "thread-c"]);
    const merged = mergeDesignCommentDraft(original, incoming);
    expect(merged.designComments).toEqual(["thread-a", "thread-b", "thread-c"]);
    expect(merged.context.revision).toBe(3);
    expect(original.designComments).toEqual(["thread-a", "thread-b"]);
    expect(incoming.context.revision).toBe(9);
  });
  it("also retains an older revision carried by the newly added comments", () => {
    expect(mergeDesignCommentDraft(design("canvas-a", 9), design("canvas-a", 3, ["other"])).context.revision).toBe(3);
  });
  it("a newly appended complete thread replaces only that thread's snapshot hash", () => {
    const first=design("canvas-a",3,["c_1111111111","c_2222222222"]),next=design("canvas-a",9,["c_1111111111"]);
    first.designCommentVersions={c_1111111111:"a".repeat(64),c_2222222222:"b".repeat(64)};next.designCommentVersions={c_1111111111:"c".repeat(64)};
    const merged=mergeDesignCommentDraft(first,next);
    expect(merged.designCommentVersions).toEqual({c_1111111111:"c".repeat(64),c_2222222222:"b".repeat(64)});expect(merged.context.revision).toBe(3);
    expect(first.designCommentVersions.c_1111111111).toBe("a".repeat(64));
  });
  it("a reopened original design may rebind its window without changing revision or target identity", () => {
    const incoming = design("canvas-a", 9, ["new"]); incoming.context.target.windowId = "reopened";
    const merged = mergeDesignCommentDraft(design(), incoming);
    expect(merged.context).toMatchObject({ target: { deviceId: "device", windowId: "reopened", tabId: "canvas-a" }, revision: 3 });
    const bound = bindWorkbenchDraft(merged, "device", "conversation", { windowId: "newer", conversationId: "conversation", generation: "current", visible: true, capabilities: ["design.v1"], tabs: [{ id: "canvas-a", kind: "design", title: "Original" }] });
    expect(bound.context).toMatchObject({ target: { tabId: "canvas-a", windowId: "newer" }, revision: 3 });
  });
  it("deduplicates first composition IDs and rejects invalid comment drafts", () => {
    expect(mergeDesignCommentDraft(undefined, design("canvas-a", 0, ["same", "same"])).designComments).toEqual(["same"]);
    expect(() => mergeDesignCommentDraft(undefined, { ...design(), context: { kind: "design", target: {deviceId:"device",windowId:"window"}, revision:0 } })).toThrow();
  });
  it("keeps a whiteboard draft instead of replacing its original attachments", () => {
    const files = [1, 2].map(n => ({ name:`${n}.png`, type:"image/png", size:1, sha256:String(n).repeat(64) }));
    const board: WorkbenchDraft = { context:{kind:"whiteboard",target:{deviceId:"device",windowId:"window",tabId:"board"},revision:0,imageEdit:{requestId:"edit",boardId:"board",baseRevision:0,originalElementId:"image",attachmentIds:[]}},files };
    expect(() => mergeDesignCommentDraft(board, design())).toThrow("workbench_design_draft_target_changed");
    expect(board.files).toEqual(files);
  });
  it("refuses an oversized merge without discarding already drafted comment IDs", () => {
    const original = design("canvas-a", 3, Array.from({length:200},(_,index)=>`old-${index}`));
    expect(() => mergeDesignCommentDraft(original, design("canvas-a", 9, ["new"]))).toThrow();
    expect(original.designComments).toHaveLength(200);
  });
});
