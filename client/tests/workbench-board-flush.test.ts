import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { boardDocumentSchema, emptyBoard, WORKBENCH_BOARD_BYTES, type BoardDocument, type BoardScene } from "../src/workbench-model.js";
import { BoardSession, type BoardAdapter } from "../src/workbench-board.js";

// Autosave validates files and budgets before the document changes and leaves
// the full schema to the storage boundary; neither may cost the person an edit.
const create: BoardAdapter["create"] = values => values;
const adapter: BoardAdapter = { create, apply: () => undefined, selection: () => [] };
const scene = (x = 10): BoardScene => ({ elements: [{ id: "shape", type: "rectangle", x, y: 10, width: 80, height: 50, version: 1 }], appState: {} });
// Files only survive retainBoardFiles when an element uses them.
const withImage = (x: number, fileId: string): BoardScene => ({ ...scene(x), elements: [...scene(x).elements, { id: "image", type: "image", fileId, x: 0, y: 0, width: 10, height: 10, version: 1 }] });
function session(persist: (expected: number, value: BoardDocument) => Promise<void>) {
  const value = new BoardSession({ ...emptyBoard("board"), scene: scene() }, persist, adapter); value.setWritable(true); return value;
}
const storage = (writes: BoardDocument[]) => vi.fn(async (_expected: number, value: BoardDocument) => { writes.push(boardDocumentSchema.parse(value)); });

describe("whiteboard autosave validation", () => {
  it("saves a valid edit with one undo step, exactly as the full schema accepts it", async () => {
    const writes: BoardDocument[] = [], board = session(storage(writes));
    board.local(scene(40), {}); await board.flush();
    expect(writes).toHaveLength(1); expect(writes[0]!.revision).toBe(1); expect(writes[0]!.scene.elements[0]!.x).toBe(40);
    expect(writes[0]!.undo[0]!.elements[0]!.x).toBe(10); expect(board.dirty()).toBe(false);
  });
  it("rejects invalid file data before the document changes and keeps the edit as a draft", async () => {
    const persist = vi.fn(async () => undefined), board = session(persist);
    board.local(withImage(40, "bad"), { bad: { id: "bad", dataURL: 1n } as never });
    await expect(board.flush()).rejects.toBeInstanceOf(z.ZodError);
    expect(persist).not.toHaveBeenCalled(); expect(board.document.revision).toBe(0); expect(board.document.scene.elements[0]!.x).toBe(10);
    expect(board.dirty()).toBe(true);
    board.local(scene(41), {}); await board.flush();                       // the person can still save after fixing it
    expect(board.document.revision).toBe(1); expect(board.dirty()).toBe(false);
  });
  it("rejects a document over the storage budget before it changes", async () => {
    const persist = vi.fn(async () => undefined), board = session(persist);
    board.local(withImage(40, "big"), { big: { id: "big", mimeType: "image/png", dataURL: "x".repeat(WORKBENCH_BOARD_BYTES) } });
    await expect(board.flush()).rejects.toThrow("whiteboard_storage_limit");
    expect(persist).not.toHaveBeenCalled(); expect(board.document.revision).toBe(0); expect(board.dirty()).toBe(true);
  });
  it("restores the saved document and the draft when the storage boundary refuses the content", async () => {
    let refuse = true; const writes: BoardDocument[] = [];
    const board = session(async (_expected, value) => { if (refuse) z.string().parse(1); writes.push(value); });
    board.local(scene(40), {});
    await expect(board.flush()).rejects.toBeInstanceOf(z.ZodError);
    expect(board.document.revision).toBe(0); expect(board.document.scene.elements[0]!.x).toBe(10); expect(board.dirty()).toBe(true);
    refuse = false; await board.flush();
    expect(writes).toHaveLength(1); expect(writes[0]!.scene.elements[0]!.x).toBe(40);
  });
  it("keeps a newer edit made during a refused write instead of the older one", async () => {
    let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), writing = new Promise<void>(resolve => { entered = resolve; });
    let refuse = true; const writes: BoardDocument[] = [];
    const board = session(async (_expected, value) => { entered(); await gate; if (refuse) z.string().parse(1); writes.push(value); });
    board.local(scene(40), {});
    const saving = board.flush(); await writing;
    board.local(scene(50), {});                                            // the person keeps drawing
    release(); await expect(saving).rejects.toBeInstanceOf(z.ZodError);
    refuse = false; await board.flush();
    expect(writes.at(-1)!.scene.elements[0]!.x).toBe(50); expect(board.dirty()).toBe(false);
  });
  it("keeps an applied revision for a later retry after an ordinary storage failure", async () => {
    let fail = true; const writes: BoardDocument[] = [];
    const board = session(async (_expected, value) => { if (fail) throw new Error("idb_unavailable"); writes.push(value); });
    board.local(scene(40), {});
    await expect(board.flush()).rejects.toThrow("idb_unavailable");
    expect(board.document.revision).toBe(1); expect(board.dirty()).toBe(true);
    fail = false; await board.flush(); expect(writes.map(value => value.revision)).toEqual([1]); expect(board.dirty()).toBe(false);
  });
});
