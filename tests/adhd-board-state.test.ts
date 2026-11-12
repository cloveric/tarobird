import { describe, expect, it } from "vitest";
import { addAdhdPane, adhdBoardForDevice, adhdBoardSchema, adhdBoardSupported, adhdColumns, adhdPaneKey, adhdPhoneBoard, adhdSupported, emptyAdhdBoard, moveAdhdPane } from "../client/src/adhd-board-state.js";
const pane = (hostId = "host-a", registrationId = "registration-a", conversationId = "same-chat") => ({ hostId, registrationId, conversationId });
describe("desktop ADHD board identity and storage", () => {
  it("does not offer the expanded board on ordinary iPhones in either orientation", () => {
    for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932], [440, 956], [466, 678]]) {
      for (const [w, h] of [[width, height], [height, width]]) {
        expect(adhdBoardSupported("ios", w!, h!, "iPhone")).toBe(false);
      }
    }
    expect(adhdBoardSupported("ios", 880, 605, "iPhone")).toBe(true);
    expect(adhdBoardSupported("ios", 1000, 687, "iPhone")).toBe(true);
    expect(adhdBoardSupported("ios", 900, 500, "iPad")).toBe(true);
  });
  it("restores at most two expanded-phone panes without mutating stored conversations or other devices", () => {
    const saved = { ...emptyAdhdBoard(), columns: 4 as const, fontSize: 14, panes: [pane("a"), pane("b"), pane("c")] };
    const restored = adhdBoardForDevice(saved, "ios", "iPhone");
    expect(restored).toEqual({ ...saved, panes: saved.panes.slice(0, 2) });
    expect(saved.panes).toHaveLength(3);
    expect(restored.panes[0]).toBe(saved.panes[0]);
    expect(adhdBoardForDevice(restored, "ios", "iPhone")).toBe(restored);
    for (const [platform, ua] of [["ios", "iPad"], ["ios", "Macintosh"], ["android", "Android"], ["web", "iPhone"], ["macos", "Macintosh"], ["windows", "Windows"]]) {
      expect(adhdBoardForDevice(saved, platform!, ua!)).toBe(saved);
    }
  });
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
  it("opens the board on wide iOS only; desktop and Android answers are unchanged", () => {
    for (const platform of ["macos", "windows", "web", "android", "ios"]) for (const width of [700, 760, 761, 1200, 2500]) {
      const before = !["ios", "android"].includes(platform) && width > 760;
      expect(adhdSupported(platform, width)).toBe(before); // Agent Bus and diff viewers keep this
      expect(adhdBoardSupported(platform, width, 900, "iPad")).toBe(platform === "ios" ? width > 760 : before);
    }
    const ua = {
      iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      ipad: "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
    };
    expect(adhdPhoneBoard("ios", ua.iphone)).toBe(true);
    for (const value of [ua.ipad, ua.mac]) expect(adhdPhoneBoard("ios", value)).toBe(false);
    for (const platform of ["macos", "windows", "web", "android"]) for (const value of Object.values(ua)) expect(adhdPhoneBoard(platform, value)).toBe(false);
  });
  it("fits two tall iPhone panes and never more, while desktop columns keep their 300px rule", () => {
    expect(adhdColumns(584, 2, 0)).toBe(1); expect(adhdColumns(584, 2, 0, 260, 2)).toBe(2);
    expect(adhdColumns(1200, 6, 0, 260, 2)).toBe(2); expect(adhdColumns(1200, 6, 6, 260, 2)).toBe(2); expect(adhdColumns(1200, 1, 0, 260, 2)).toBe(1);
    expect(adhdColumns(1200, 6, 0)).toBe(3); expect(adhdColumns(1200, 6, 6)).toBe(6);
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
