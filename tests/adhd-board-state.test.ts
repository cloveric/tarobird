import { describe, expect, it } from "vitest";
import { addAdhdPane, adhdBoardSchema, adhdColumns, adhdPaneKey, adhdSupported, emptyAdhdBoard, moveAdhdPane } from "../client/src/adhd-board-state.js";
const pane = (hostId = "host-a", registrationId = "registration-a", conversationId = "same-chat") => ({ hostId, registrationId, conversationId });
describe("desktop ADHD board identity and storage", () => {
  it("starts empty, deduplicates exact identities and isolates hosts and re-pairing", () => {
    const initial = emptyAdhdBoard(), a = addAdhdPane(initial, pane());
    expect(initial.panes).toEqual([]); expect(addAdhdPane(a, pane())).toBe(a);
    const b = addAdhdPane(addAdhdPane(a, pane("host-b")), pane("host-a", "new-registration"));
    expect(b.panes).toHaveLength(3); expect(new Set(b.panes.map(adhdPaneKey)).size).toBe(3);
  });
  it("refuses malformed/duplicate/oversized state and does not silently overwrite it", () => {
    for (const value of [null, {}, { ...emptyAdhdBoard(), columns: 1 }, { ...emptyAdhdBoard(), panes: [pane(), pane()] }, { ...emptyAdhdBoard(), panes: [{ ...pane(), conversationId: "" }] }]) expect(adhdBoardSchema.safeParse(value).success).toBe(false);
    let value = emptyAdhdBoard(); for (let i = 0; i < 12; i++) value = addAdhdPane(value, pane("host-a", "reg", String(i)));
    expect(() => addAdhdPane(value, pane("host-b"))).toThrow(); expect(value.panes).toHaveLength(12);
  });
  it("loads old layouts with an independent small font and validates new display preferences", () => {
    expect(adhdBoardSchema.parse({ version: 1, columns: 4, panes: [pane()] }).fontSize).toBe(12);
    for (const columns of [5, 6]) expect(adhdBoardSchema.parse({ ...emptyAdhdBoard(), columns, fontSize: 16 }).columns).toBe(columns);
    for (const fontSize of [0, 10, 17, 12.5, "12"]) expect(adhdBoardSchema.safeParse({ ...emptyAdhdBoard(), fontSize }).success).toBe(false);
  });
  it("reorders stable identities without changing or losing targets", () => {
    const state = { ...emptyAdhdBoard(), panes: [pane("a"), pane("b"), pane("c")] };
    const moved = moveAdhdPane(state, adhdPaneKey(pane("a")), 2);
    expect(moved.panes.map(item => item.hostId)).toEqual(["b", "c", "a"]);
    expect(moveAdhdPane(state, "missing", 1)).toBe(state); expect(moveAdhdPane(state, adhdPaneKey(pane("a")), -1)).toBe(state);
  });
  it("keeps cards readable and never exposes mode on a native phone/tablet", () => {
    expect(adhdColumns(1000, 6, 0)).toBe(3); expect(adhdColumns(650, 6, 4)).toBe(4);
    expect(adhdColumns(1300, 8, 0)).toBe(4); expect(adhdColumns(1700, 10, 0)).toBe(5);
    expect(adhdColumns(2100, 12, 0)).toBe(6); expect(adhdColumns(2000, 7, 0)).toBe(4); expect(adhdColumns(650, 6, 0)).toBe(2);
    expect(adhdColumns(2000, 1, 0)).toBe(1); expect(adhdSupported("web", 760)).toBe(false);
    for (const platform of ["android", "ios"]) expect(adhdSupported(platform, 2500)).toBe(false);
    for (const platform of ["macos", "windows", "web"]) expect(adhdSupported(platform, 1200)).toBe(true);
  });
});
