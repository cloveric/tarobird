import { describe, it, expect, vi } from "vitest";
import { emptyBoard, type BoardDocument, type BoardScene } from "../src/workbench-model.js";
import { BoardSession, patchBoardScene, type BoardAdapter } from "../src/workbench-board.js";

const create: BoardAdapter["create"] = values => values.map(value => ({ ...value, version: 1, isDeleted: false }));
const scene = (): BoardScene => ({ elements: [{ id: "existing", type: "rectangle", x: 10, y: 10, width: 80, height: 50, version: 1 }], appState: {} });
const added = { op: "add", id: "new", type: "rectangle", x: 100, y: 20 };
function fixture(save?: (expected: number, document: BoardDocument) => Promise<void>) {
  const document = { ...emptyBoard("board"), scene: scene() }, writes: BoardDocument[] = [], shown: BoardDocument[] = [];
  let persisted = 0;
  const persist = vi.fn(async (expected: number, value: BoardDocument) => {
    if (save) await save(expected, value);
    expect(expected).toBe(persisted); expect(value.revision).toBe(expected + 1);
    persisted = value.revision; writes.push(structuredClone(value));
  });
  const session = new BoardSession(document, persist, { create, apply: value => shown.push(structuredClone(value)), selection: () => ["existing", "unrelated"] });
  session.setWritable(true); return { session, persist, writes, shown };
}
describe("whiteboard restricted patch", () => {
  it("edits stable ids and preserves unrelated elements, rejecting an invalid atomic tail", () => {
    const before = scene(), next = patchBoardScene(before, [added], create);
    expect(next.elements[0]).toEqual(before.elements[0]); expect(next.elements[1].id).toBe("new"); expect(before.elements).toHaveLength(1);
    expect(() => patchBoardScene(before, [added, { op: "delete", id: "missing" }], create)).toThrow("whiteboard_element_missing"); expect(before.elements).toHaveLength(1);
  });
  it("refuses injected keys, URLs, duplicate identities and protected elements", () => {
    expect(() => patchBoardScene(scene(), [{ ...added, link: "javascript:alert(1)" }], create)).toThrow();
    expect(() => patchBoardScene(scene(), [{ ...added, id: "existing" }], create)).toThrow("whiteboard_element_exists");
    const locked = scene(); locked.elements[0].locked = true;
    expect(() => patchBoardScene(locked, [{ op: "update", id: "existing", changes: { x: 30 } }], create)).toThrow("whiteboard_element_locked");
    expect(() => patchBoardScene(scene(), [{ op: "update", id: "existing", changes: { id: "other" } }], create)).toThrow();
    expect(() => patchBoardScene(scene(), [{ op: "add", id: "text", type: "text", text: "bad font", fontFamily: 4 }], create)).toThrow();
  });
  it("cleans dangling line bindings and rejects binding to a missing element", () => {
    const value = scene(); value.elements.push({ id: "arrow", type: "arrow", startBinding: { elementId: "existing", gap: 0, focus: 0 }, endBinding: null });
    const next = patchBoardScene(value, [{ op: "delete", id: "existing" }], create);
    expect(next.elements[0].startBinding).toBeNull();
    expect(() => patchBoardScene(scene(), [{ ...added, type: "arrow", startBinding: { elementId: "missing", gap: 0, focus: 0 } }], create)).toThrow("whiteboard_binding_missing");
  });
  it("moves connected endpoints and bound labels with a shape while preserving a connector's intermediate route", () => {
    const value = scene(); value.elements.push({ id: "line", type: "arrow", x: 100, y: 40, points: [[0, 0], [40, 50], [100, 0]], startBinding: { elementId: "existing", focus: 0, gap: 10 }, angle: 0 }, { id: "text", type: "text", x: 20, y: 20, width: 40, height: 20, containerId: "existing" });
    const result = patchBoardScene(value, [{ op: "update", id: "existing", changes: { x: 60, y: 30 } }], create);
    expect(result.elements[1]).toMatchObject({ x: 150, y: 60, points: [[0, 0], [-10, 30], [50, -20]] });
    expect(result.elements[2]).toMatchObject({ x: 70, y: 40 });
  });
  it("deleting an unrelated element leaves existing binding lists and element versions exactly unchanged", () => {
    const value = scene(); value.elements.push({ id: "other", type: "rectangle", x: 200, y: 100, width: 100, height: 100, version: 7, boundElements: [{ id: "text", type: "text" }] }, { id: "text", type: "text", x: 220, y: 110, containerId: "other", text: "keep", version: 4 });
    const next = patchBoardScene(value, [{ op: "delete", id: "existing" }], create);
    expect(next.elements).toEqual(value.elements.slice(1));
  });
});
describe("whiteboard revision and save boundary", () => {
  it("does not turn editor defaults on opening into a content edit or undo entry", async () => {
    const { session, persist } = fixture(), normalized = scene(); normalized.appState = { scrollX: 0, scrollY: 0, zoom: { value: 1 } }; normalized.elements[0].index = "a0";
    expect(session.initializeView(normalized, {})).toBe(true); await session.flush();
    expect(session.document.revision).toBe(0); expect(session.document.undo).toEqual([]); expect(persist).not.toHaveBeenCalled();
    const other = fixture(), changed = scene(); changed.elements[0].x = 400;
    expect(other.session.initializeView(changed, {})).toBe(false); other.session.local(changed, {}); await other.session.flush(); expect(other.session.document.revision).toBe(1);
  });
  it("treats restored empty hand-drawn bindings as a no-op without hiding binding or geometry edits", async () => {
    const { session, persist } = fixture(); session.document.scene.elements[0].boundElements = null;
    const restored = structuredClone(session.document.scene); restored.elements[0].boundElements = [];
    expect(session.initializeView(restored, {})).toBe(true);
    session.local(restored, {}); await session.flush();
    expect(session.document.revision).toBe(0); expect(session.document.undo).toEqual([]); expect(persist).not.toHaveBeenCalled();
    for (const change of [{ boundElements: [{ id: "label", type: "text" }] }, { boundElements: [], x: 90 }]) {
      const other = fixture(); other.session.document.scene.elements[0].boundElements = null;
      const edited = structuredClone(other.session.document.scene); Object.assign(edited.elements[0], change);
      expect(other.session.initializeView(edited, {})).toBe(false);
      other.session.local(edited, {}); await other.session.flush();
      expect(other.session.document.revision).toBe(1); expect(other.persist).toHaveBeenCalledTimes(1);
    }
  });
  it("only returns applied after the actual save, deduplicates matching retries and rejects changed requests", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
    const { session, persist, shown } = fixture(() => gate);
    let done = false; const request = { requestId: "request", expectedRevision: 0, ops: [added] };
    const pending = session.apply(request).then(value => { done = true; return value; });
    await vi.waitFor(() => expect(shown).toHaveLength(1)); expect(done).toBe(false);
    release(); expect(await pending).toMatchObject({ status: "applied", revision: 1, saved: true });
    expect(await session.apply(request)).toMatchObject({ status: "applied", revision: 1, saved: true, result: { duplicate: true } });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await session.apply({ ...request, ops: [{ ...added, x: 999 }] })).toMatchObject({ status: "conflict", error: "whiteboard_request_conflict" });
  });
  it("keeps failed-save changes visible and retries the same revision without repeating its effect", async () => {
    let fails = true;
    const { session, shown, writes } = fixture(async () => { if (fails) throw new Error("disk_full"); });
    const request = { requestId: "request", expectedRevision: 0, ops: [added] };
    expect(await session.apply(request)).toMatchObject({ status: "applied_not_saved", revision: 1, saved: false, error: "disk_full" });
    expect(shown).toHaveLength(1); expect(writes).toHaveLength(0);
    fails = false;
    expect(await session.apply(request)).toMatchObject({ status: "applied", revision: 1, saved: true });
    expect(shown).toHaveLength(1); expect(writes).toHaveLength(1); expect(session.document.scene.elements).toHaveLength(2);
  });
  it("flushes manual changes before checking a Bot base revision without overwriting them", async () => {
    const { session, shown } = fixture(), manual = scene(); manual.elements[0].x = 55;
    session.local(manual, {});
    expect(await session.apply({ requestId: "request", expectedRevision: 0, ops: [added] })).toMatchObject({ status: "conflict", revision: 1 });
    expect(session.document.scene.elements[0].x).toBe(55); expect(shown).toHaveLength(0);
    const read = await session.read(); expect(read.selection).toEqual(["existing"]); expect(read.document.revision).toBe(1);
  });
  it("retains user input that arrives during an asynchronous save as its own next revision", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); let first = true;
    const { session, writes } = fixture(async () => { if (first) { first = false; await gate; } });
    const firstScene = scene(); firstScene.elements[0].x = 50; session.local(firstScene, {});
    const saving = session.flush(); await vi.waitFor(() => expect(session.document.revision).toBe(1));
    const newer = scene(); newer.elements[0].x = 100; session.local(newer, {});
    release(); await saving; expect(session.dirty()).toBe(true);
    await session.flush(); expect(session.document.revision).toBe(2); expect(session.document.scene.elements[0].x).toBe(100); expect(writes).toHaveLength(2);
  });
  it("rejecting a new unsupported editor edit can restore a valid unsaved gesture without losing it", async () => {
    const { session, shown, writes } = fixture(), draft = scene(); draft.elements[0].x = 77;
    session.local(draft, {}); session.restoreView();
    expect(shown[0].scene.elements[0].x).toBe(77); expect(writes).toHaveLength(0); expect(session.dirty()).toBe(true);
    session.dispose(); await session.flush(); expect(writes[0].scene.elements[0].x).toBe(77);
  });
  it("makes Bot patches single undo/redo steps and preserves the original drawing", async () => {
    const { session } = fixture();
    await session.apply({ requestId: "patch", expectedRevision: 0, ops: [added, { op: "update", id: "existing", changes: { x: 70 } }] });
    expect(await session.undo({ requestId: "undo", expectedRevision: 1 })).toMatchObject({ status: "applied", revision: 2 });
    expect(session.document.scene).toEqual(scene());
    expect(await session.redo({ requestId: "redo", expectedRevision: 2 })).toMatchObject({ status: "applied", revision: 3 });
    expect(session.document.scene.elements).toHaveLength(2); expect(session.document.scene.elements[0].x).toBe(70);
  });
  it("rejects unavailable and read-only boards without applying or saving", async () => {
    const { session, persist, shown } = fixture(); session.setWritable(false);
    expect(await session.apply({ requestId: "no", expectedRevision: 0, ops: [added] })).toMatchObject({ status: "not_executed", error: "whiteboard_read_only" });
    session.setWritable(true); session.dispose();
    expect(await session.apply({ requestId: "no", expectedRevision: 0, ops: [added] })).toMatchObject({ status: "not_executed", error: "whiteboard_closed" });
    expect(persist).not.toHaveBeenCalled(); expect(shown).toHaveLength(0);
  });
  it("rechecks cancellation after asynchronous preparation and fences queued work across reopening", async () => {
    const { session, shown } = fixture(); let checks = 0;
    expect(await session.apply({ requestId: "cancelled", expectedRevision: 0, ops: [added], assertActive: () => { if (++checks > 1) throw new Error("workbench_cancelled"); } })).toMatchObject({ status: "not_executed", error: "workbench_cancelled" });
    const stale = session.apply({ requestId: "stale", expectedRevision: 0, ops: [added] });
    session.dispose(); session.activate();
    expect(await stale).toMatchObject({ status: "not_executed", error: "whiteboard_closed" }); expect(shown).toHaveLength(0);
  });
  it("maintains connector backlinks when a Bot adds an arrow, so later manual movement keeps the connection", () => {
    const linked = patchBoardScene(scene(), [{ ...added, type: "arrow", startBinding: { elementId: "existing", focus: 0, gap: 1 } }], create);
    expect(linked.elements[0].boundElements).toEqual([{ id: "new", type: "arrow" }]);
    const detached = patchBoardScene(linked, [{ op: "delete", id: "new" }], create);
    expect(detached.elements[0].boundElements ?? []).toEqual([]);
  });
});
