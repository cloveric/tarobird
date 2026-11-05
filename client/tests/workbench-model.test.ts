import { describe, it, expect } from "vitest";
import { changeWorkbench, emptyWorkbench, workbenchLayoutSchema } from "../src/workbench-model.js";

const tab = (id: string) => ({ id, kind: "whiteboard" as const, title: id });
describe("workbench layout", () => {
  it("keeps 1/2/3/4 distinct regions and replaces only the active region", () => {
    let state = emptyWorkbench();
    for (const id of ["a", "b", "c", "d"]) { state = changeWorkbench(state, { type: "open", tab: tab(id) }); state = changeWorkbench(state, { type: "split", id: "a" }); }
    state = changeWorkbench(state, { type: "split", id: "b" }); state = changeWorkbench(state, { type: "split", id: "c" });
    expect(state.visible).toHaveLength(4);
    state = changeWorkbench(state, { type: "select", id: "b" }); const before = [...state.visible];
    state = changeWorkbench(state, { type: "open", tab: tab("e") });
    expect(state.visible).toEqual(before.map(id => id === "b" ? "e" : id));
    expect(() => changeWorkbench(state, { type: "split", id: "b" })).toThrow("workbench_split_full");
    expect(changeWorkbench(state, { type: "split", id: "a" }).visible).toHaveLength(4);
  });
  it("maximizing and docking preserve the exact split composition and proportions", () => {
    let state = changeWorkbench(emptyWorkbench(), { type: "open", tab: tab("a") });
    state = changeWorkbench(state, { type: "open", tab: tab("b") }); state = changeWorkbench(state, { type: "split", id: "a" });
    state = changeWorkbench(state, { type: "ratio", axis: "column", value: .37 });
    const visible = [...state.visible]; state = changeWorkbench(state, { type: "maximize", id: "a" });
    state = changeWorkbench(state, { type: "expanded", value: true }); state = changeWorkbench(state, { type: "maximize", id: "a" });
    expect(state.visible).toEqual(visible); expect(state.column).toBe(.37); expect(state.maximized).toBeNull();
  });
  it("separates remove, close/reopen and delete, including an empty content area", () => {
    let state = changeWorkbench(emptyWorkbench(), { type: "open", tab: tab("a") });
    state = changeWorkbench(state, { type: "remove", id: "a" }); expect(state.tabs).toHaveLength(1); expect(state.visible).toEqual([]);
    state = changeWorkbench(state, { type: "close", id: "a" }); expect(state.tabs).toHaveLength(0); expect(state.closed).toHaveLength(1);
    state = changeWorkbench(state, { type: "reopen", id: "a" }); expect(state.visible).toEqual(["a"]);
    state = changeWorkbench(state, { type: "delete", id: "a" }); expect(state.tabs).toEqual([]); expect(state.closed).toEqual([]); expect(state.active).toBeNull();
  });
  it("rejects corrupted persisted layouts and stale chart replacement without losing the original", () => {
    expect(workbenchLayoutSchema.safeParse({ ...emptyWorkbench(), visible: ["missing"] }).success).toBe(false);
    const source = { messageId: "m1", blockIndex: 0, version: 1 };
    const state = changeWorkbench(emptyWorkbench(), { type: "open", tab: { id: "chart", kind: "chart", title: "Trend", source } });
    expect(() => changeWorkbench(state, { type: "chart", id: "chart", source: { ...source, version: 2 }, previous: { ...source, version: 0 } })).toThrow("workbench_source_conflict");
    expect(state.tabs[0]?.source).toEqual(source);
  });
  it("never drops a closed board reference when the archive is full", () => {
    let state = emptyWorkbench();
    for (let index=0; index<64; index++) {
      state=changeWorkbench(state,{type:"open",tab:tab(`board_${index}`)});
      state=changeWorkbench(state,{type:"close",id:`board_${index}`});
    }
    state=changeWorkbench(state,{type:"open",tab:tab("new_board")});
    expect(()=>changeWorkbench(state,{type:"close",id:"new_board"})).toThrow("workbench_closed_limit");
    expect(state.closed[0].id).toBe("board_0");expect(state.tabs[0].id).toBe("new_board");
    state=changeWorkbench(state,{type:"reopen",id:"board_0"});
    state=changeWorkbench(state,{type:"close",id:"new_board"});
    expect(state.tabs[0].id).toBe("board_0");expect(state.closed.at(-1)?.id).toBe("new_board");
  });
});

describe("one-click split and merge", () => {
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `t${i}`);
  // Opening replaces the active region: each fixture starts as single view of its last tab.
  const opened = (count: number) => ids(count).reduce((state, id) => changeWorkbench(state, { type: "open", tab: tab(id) }), emptyWorkbench());
  const kept = (state: ReturnType<typeof emptyWorkbench>) => ({ tabs: state.tabs, closed: state.closed, column: state.column, row: state.row, expanded: state.expanded });
  it("tile without two open tabs is harmless: only the revision advances", () => {
    const empty = emptyWorkbench();
    expect(changeWorkbench(empty, { type: "tile" })).toEqual({ ...empty, revision: 1 });
    const one = opened(1);
    expect(changeWorkbench(one, { type: "tile" })).toEqual({ ...one, revision: one.revision + 1 });
    // An emptied content area is not refilled by a split that cannot happen.
    const hidden = changeWorkbench(one, { type: "remove", id: "t0" });
    expect(changeWorkbench(hidden, { type: "tile" })).toEqual({ ...hidden, revision: hidden.revision + 1 });
    // Closed content keeps its reference but is not an open tab to show.
    const closed = changeWorkbench(opened(2), { type: "close", id: "t0" });
    expect(changeWorkbench(closed, { type: "tile" })).toEqual({ ...closed, revision: closed.revision + 1 });
  });
  for (const count of [2, 3, 4]) it(`shows all ${count} tabs in tab order and keeps the active tab`, () => {
    const state = changeWorkbench(opened(count), { type: "select", id: "t1" });
    expect(state.visible).toEqual(["t1"]);
    const next = changeWorkbench(state, { type: "tile" });
    expect(next.visible).toEqual(ids(count)); expect(next.active).toBe("t1"); expect(next.maximized).toBeNull();
    expect(kept(next)).toEqual(kept(state)); expect(next.revision).toBe(state.revision + 1);
  });
  for (const count of [5, 6, 64]) it(`caps ${count} tabs at four: the active tab plus the leftmost others, in tab order`, () => {
    const last = `t${count - 1}`, state = opened(count);
    expect(state.active).toBe(last);
    const atEnd = changeWorkbench(state, { type: "tile" });
    expect(atEnd.visible).toEqual(["t0", "t1", "t2", last]); expect(atEnd.active).toBe(last);
    expect(atEnd.tabs.map(value => value.id)).toEqual(ids(count)); expect(atEnd.closed).toEqual([]);
    const middle = changeWorkbench(changeWorkbench(state, { type: "select", id: "t4" }), { type: "tile" });
    expect(middle.visible).toEqual(["t0", "t1", "t2", "t4"]); expect(middle.active).toBe("t4");
    const first = changeWorkbench(changeWorkbench(state, { type: "select", id: "t0" }), { type: "tile" });
    expect(first.visible).toEqual(["t0", "t1", "t2", "t3"]); expect(first.active).toBe("t0");
  });
  it("follows the current tab strip order and never shows closed content", () => {
    let state = opened(6);
    for (let i = 0; i < 3; i++) state = changeWorkbench(state, { type: "move", id: "t5", direction: -1 });
    state = changeWorkbench(state, { type: "close", id: "t1" });
    expect(state.tabs.map(value => value.id)).toEqual(["t0", "t5", "t2", "t3", "t4"]); expect(state.visible).toEqual(["t5"]);
    const next = changeWorkbench(state, { type: "tile" });
    expect(next.visible).toEqual(["t0", "t5", "t2", "t3"]); expect(next.active).toBe("t5");
    expect(next.closed.map(value => value.id)).toEqual(["t1"]); expect(kept(next)).toEqual(kept(state));
  });
  it("fills an empty content area from the first tabs", () => {
    const state = changeWorkbench(opened(3), { type: "remove", id: "t2" });
    expect(state.visible).toEqual([]); expect(state.active).toBeNull();
    const next = changeWorkbench(state, { type: "tile" });
    expect(next.visible).toEqual(["t0", "t1", "t2"]); expect(next.active).toBe("t0");
  });
  it("restores a maximized split exactly, and repeating tile never merges or re-tiles", () => {
    let state = changeWorkbench(changeWorkbench(opened(3), { type: "select", id: "t1" }), { type: "tile" });
    state = changeWorkbench(state, { type: "ratio", axis: "column", value: .37 }); state = changeWorkbench(state, { type: "ratio", axis: "row", value: .64 });
    state = changeWorkbench(state, { type: "expanded", value: true });
    const split = structuredClone(state.visible);
    state = changeWorkbench(state, { type: "maximize", id: "t2" }); expect(state.maximized).toBe("t2");
    state = changeWorkbench(state, { type: "tile" });
    expect(state).toMatchObject({ visible: split, active: "t2", maximized: null, column: .37, row: .64, expanded: true });
    const again = changeWorkbench(state, { type: "tile" });
    expect(again.visible).toEqual(split); expect(again.revision).toBe(state.revision + 1);
    // A hand-built partial split is also kept as composed, not re-tiled.
    let partial = changeWorkbench(opened(5), { type: "split", id: "t0" });
    expect(partial.visible).toEqual(["t4", "t0"]);
    partial = changeWorkbench(partial, { type: "tile" }); expect(partial.visible).toEqual(["t4", "t0"]);
  });
  it("single shows only the chosen tab and keeps every tab, closed item and proportion", () => {
    let state = changeWorkbench(opened(6), { type: "close", id: "t5" });
    state = changeWorkbench(changeWorkbench(state, { type: "select", id: "t2" }), { type: "tile" });
    state = changeWorkbench(state, { type: "ratio", axis: "column", value: .3 });
    state = changeWorkbench(state, { type: "maximize", id: "t0" });
    const merged = changeWorkbench(state, { type: "single", id: "t0" });
    expect(merged).toMatchObject({ visible: ["t0"], active: "t0", maximized: null }); expect(kept(merged)).toEqual(kept(state));
    expect(changeWorkbench(merged, { type: "single", id: "t0" }).visible).toEqual(["t0"]);   // repeating stays single
    expect(changeWorkbench(merged, { type: "tile" }).visible).toEqual(["t0", "t1", "t2", "t3"]);
    // Any open tab can be the one shown, including one outside the split.
    expect(changeWorkbench(state, { type: "single", id: "t4" })).toMatchObject({ visible: ["t4"], active: "t4", maximized: null });
  });
  it("single rejects a stale target without changing the layout", () => {
    const state = changeWorkbench(changeWorkbench(opened(3), { type: "tile" }), { type: "close", id: "t1" }), before = structuredClone(state);
    expect(() => changeWorkbench(state, { type: "single", id: "t1" })).toThrow("workbench_tab_closed");
    expect(() => changeWorkbench(state, { type: "single", id: "gone" })).toThrow("workbench_tab_closed");
    expect(state).toEqual(before);
  });
  it("single without a target keeps the active region, including a maximized one", () => {
    const split = changeWorkbench(changeWorkbench(opened(4), { type: "select", id: "t2" }), { type: "tile" });
    expect(changeWorkbench(split, { type: "single" })).toMatchObject({ visible: ["t2"], active: "t2", maximized: null });
    const maximized = changeWorkbench(split, { type: "maximize", id: "t3" });
    expect(changeWorkbench(maximized, { type: "single" })).toMatchObject({ visible: ["t3"], active: "t3", maximized: null });
    const empty = changeWorkbench(opened(2), { type: "remove", id: "t1" });
    expect(changeWorkbench(empty, { type: "single" })).toMatchObject({ visible: [], active: null, tabs: empty.tabs });
  });
  it("a maximized region follows the selected split tab", () => {
    let state = changeWorkbench(opened(4), { type: "split", id: "t0" }); state = changeWorkbench(state, { type: "split", id: "t1" });
    state = changeWorkbench(state, { type: "maximize", id: "t3" });
    state = changeWorkbench(state, { type: "select", id: "t1" });
    expect(state).toMatchObject({ visible: ["t3", "t0", "t1"], active: "t1", maximized: "t1" });
    // A tab outside the split replaces the active region and returns to the split.
    state = changeWorkbench(state, { type: "select", id: "t2" });
    expect(state).toMatchObject({ visible: ["t3", "t0", "t2"], active: "t2", maximized: null });
  });
  it("never leaves a single remaining region maximized", () => {
    const state = changeWorkbench(changeWorkbench(opened(2), { type: "tile" }), { type: "maximize", id: "t0" });
    expect(changeWorkbench(state, { type: "close", id: "t1" })).toMatchObject({ visible: ["t0"], maximized: null });
    expect(changeWorkbench(state, { type: "remove", id: "t1" })).toMatchObject({ visible: ["t0"], maximized: null });
    expect(changeWorkbench(opened(1), { type: "maximize", id: "t0" }).maximized).toBeNull();
  });
});


describe("explicit split selection", () => {
  const opened = () => ["a", "b", "c", "d", "e", "f"].reduce((state, id) => changeWorkbench(state, { type: "open", tab: tab(id) }), emptyWorkbench());
  it("selects exactly the requested tabs in one revision, preserving the active tab and all content", () => {
    const old = { ...opened(), column: .3, row: .6, expanded: true };
    const next = changeWorkbench(old, { type: "set-visible", ids: ["b", "d", "e", "f"] });
    expect(next).toEqual({ ...old, visible: ["b", "d", "e", "f"], revision: old.revision + 1 });
    expect(old.visible).toEqual(["f"]);
  });
  it("replaces a maximized selection and chooses the first selected tab when the old active tab is omitted", () => {
    const old = changeWorkbench(changeWorkbench(opened(), { type: "tile" }), { type: "maximize", id: "f" });
    const next = changeWorkbench(old, { type: "set-visible", ids: ["b", "d"] });
    expect(next.visible).toEqual(["b", "d"]); expect(next.active).toBe("b"); expect(next.maximized).toBeNull();
    expect(next.tabs).toEqual(old.tabs); expect(next.closed).toEqual(old.closed);
  });
  it.each([{ids: []}, {ids: ["a"]}, {ids: ["a", "a"]}, {ids: ["a", "b", "c", "d", "e"]}])("rejects invalid selection $ids without mutation", ({ids}) => {
    const old = opened(), before = structuredClone(old);
    expect(() => changeWorkbench(old, { type: "set-visible", ids })).toThrow("workbench_split_selection"); expect(old).toEqual(before);
  });
  it("rejects a tab closed while the selection was queued; never reopens or substitutes it", () => {
    const old = changeWorkbench(opened(), { type: "close", id: "b" }), before = structuredClone(old);
    expect(() => changeWorkbench(old, { type: "set-visible", ids: ["b", "d"] })).toThrow("workbench_tab_closed"); expect(old).toEqual(before);
  });
});
