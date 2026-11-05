import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchController } from "../src/workbench-controller.js";
import { emptyMarkdown, type MarkdownDocument } from "../src/workbench-markdown.js";
import { emptyBoard, emptyWorkbench, type BoardDocument, type WorkbenchLayout } from "../src/workbench-model.js";
import type { BoardController } from "../src/workbench-board.js";
import type { HubConnection } from "../src/connection.js";

const owners: WorkbenchController[] = [];
afterEach(() => { owners.forEach(owner => owner.dispose()); owners.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });
const chart = (id: string) => ({ id, kind: "chart" as const, title: id.toUpperCase(), source: { messageId: "m", blockIndex: 0, version: 0 } });

/** One same-origin IndexedDB shared by every window (controller) in a test. */
function store(initial: WorkbenchLayout) {
  let layout = structuredClone(initial); const boards = new Map<string, BoardDocument>(), notes = new Map<string, MarkdownDocument>(), writes: WorkbenchLayout[] = [];
  const commit = (expected: number, next: WorkbenchLayout) => { if (layout.revision !== expected) throw Error("workbench_revision_conflict"); layout = structuredClone(next); writes.push(layout); };
  const cache = {
    readWorkbench: async () => structuredClone(layout),
    saveWorkbench: async (_scope: string, expected: number, next: WorkbenchLayout) => commit(expected, next),
    readWorkbenchMarkdown: async (_scope: string, id: string) => notes.get(id),
    createWorkbenchMarkdownAndLayout: async (_scope: string, document: MarkdownDocument, expected: number, next: WorkbenchLayout) => { commit(expected, next); notes.set(document.id, document); },
    readWorkbenchBoard: async (_scope: string, id: string) => boards.get(id),
    saveWorkbenchBoard: async (_scope: string, _expected: number, document: BoardDocument) => { boards.set(document.id, document); },
    createWorkbenchBoardAndLayout: async (_scope: string, document: BoardDocument, expected: number, next: WorkbenchLayout) => {
      if (boards.has(document.id)) throw Error("workbench_revision_conflict");
      commit(expected, next); boards.set(document.id, document);
    },
  };
  return { cache, layout: () => layout, boards, writes };
}
function native() {
  let receive: ((event: unknown) => void) | undefined;
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("window", { tarobotDesktop: { version: 1, engine: "electron", platform: "darwin", openSocket: async () => undefined,
    on: (_name: string, listener: (event: unknown) => void) => { receive = listener; return () => undefined; },
    invoke: async (_command: string, args: Record<string, unknown>) => args.action === "capabilities" ? { status: "ok", window: "window" } : args.action === "list" ? { status: "ok", tabs: [] } : { status: "ok" } } });
  return (event: Record<string, unknown>) => receive?.(event);
}
async function open(cache: unknown) {
  const connection = { identity: { deviceId: "device", hubPublicKey: "host" }, state: { status: "online", user: { id: "owner" } }, isClosed: false, isReadOnly: false, cache,
    subscribe: () => () => undefined, conversationRevision: () => 0, http: vi.fn() } as unknown as HubConnection;
  const controller = new WorkbenchController({ connection, conversationId: "conversation" }); owners.push(controller);
  await controller.initialize(); controller.setVisible(true); return controller;
}

describe("workbench layout shared by same-origin windows", () => {
  it("reports one conflict, adopts the newer layout and never replays the stale intent", async () => {
    native();
    const db = store({ ...emptyWorkbench(), tabs: [chart("a"), chart("b"), chart("c")], visible: ["a"], active: "a" });
    const first = await open(db.cache), second = await open(db.cache);
    await first.closeTab("c");                                         // the other window closes c
    await expect(second.change({ type: "select", id: "c" })).rejects.toThrow("workbench_revision_conflict");
    expect(second.getSnapshot().layout).toEqual(db.layout());           // adopted, not merged with the stale intent
    expect(db.layout().tabs.map(tab => tab.id)).toEqual(["a", "b"]);
    await second.change({ type: "select", id: "b" });                  // the next action works
    expect(db.layout().active).toBe("b");
    // Symmetric: the first window is now the stale one; it conflicts once too.
    await expect(first.change({ type: "expanded", value: true })).rejects.toThrow("workbench_revision_conflict");
    await first.change({ type: "expanded", value: true });
    // A queued action behind the conflicting one runs on the adopted layout.
    const [late, queued] = await Promise.allSettled([second.change({ type: "ratio", axis: "column", value: .3 }), second.change({ type: "ratio", axis: "row", value: .7 })]);
    expect(late.status).toBe("rejected"); expect(queued.status).toBe("fulfilled");
    expect(db.layout()).toMatchObject({ expanded: true, column: .5, row: .7 });
  });
  it("saves a dirty board that leaves view before adopting another window's layout", async () => {
    native();
    const db = store({ ...emptyWorkbench(), tabs: [chart("a"), { id: "board", kind: "whiteboard", title: "Board" }], visible: ["board"], active: "board" });
    db.boards.set("board", { schema: 1, id: "board", revision: 0, scene: { elements: [], appState: {} }, files: {}, undo: [], redo: [], receipts: [] });
    const first = await open(db.cache), second = await open(db.cache);
    const flush = vi.fn(async () => undefined);
    second.bindBoard("board", { flush } as unknown as BoardController);
    await first.change({ type: "select", id: "a" });
    await expect(second.change({ type: "expanded", value: true })).rejects.toThrow("workbench_revision_conflict");
    expect(flush).toHaveBeenCalled(); expect(second.getSnapshot().layout.visible).toEqual(["a"]);
  });
});

describe("new whiteboards commit with their Tab", () => {
  it("never leaves board bytes when the layout refuses the Tab, and replays a request without a second board", async () => {
    native();
    const full = store({ ...emptyWorkbench(), tabs: Array.from({ length: 64 }, (_, i) => chart(`c${i}`)), visible: ["c0"], active: "c0" });
    const crowded = await open(full.cache);
    await expect(crowded.createBoard("白板")).rejects.toThrow("workbench_tab_limit");
    expect(full.boards.size).toBe(0);
    const db = store(emptyWorkbench()), win = await open(db.cache);
    const id = await win.createBoard("白板", "bot-request");
    expect(db.boards.has(id)).toBe(true); expect(db.layout().tabs.map(tab => tab.id)).toEqual([id]);
    await win.closeTab(id);
    expect(await win.createBoard("白板", "bot-request")).toBe(id);           // replay reopens the same board
    expect(db.boards.size).toBe(1); expect(db.layout().tabs.map(tab => tab.id)).toEqual([id]);
  });
  it("a stale window creating a board writes nothing and catches up", async () => {
    native();
    const db = store({ ...emptyWorkbench(), tabs: [chart("a")], visible: ["a"], active: "a" });
    const first = await open(db.cache), second = await open(db.cache);
    await first.change({ type: "expanded", value: true });
    await expect(second.createBoard("白板")).rejects.toThrow("workbench_revision_conflict");
    expect(db.boards.size).toBe(0); expect(second.getSnapshot().layout.revision).toBe(db.layout().revision);
    await second.createBoard("白板"); expect(db.boards.size).toBe(1);
  });
});

describe("new content preserves the editor it replaces", () => {
  for (const operation of ["create", "import", "note"] as const) it(`${operation} retains a dirty board when saving it fails`, async () => {
    native();
    const original = emptyBoard("original");
    const db = store({ ...emptyWorkbench(), tabs: [{ id: original.id, kind: "whiteboard", title: "Original" }], visible: [original.id], active: original.id });
    db.boards.set(original.id, original);
    vi.stubGlobal("navigator", {});
    const win = await open(db.cache), flush = vi.fn(async (): Promise<void> => { throw Error("whiteboard_save_failed"); });
    win.bindBoard(original.id, { flush } as unknown as BoardController);
    const next = () => operation === "create" ? win.createBoard("New") : operation === "note" ? win.createMarkdown("Note", "Kept") : win.importBoard({ title: "Imported", scene: { elements: [], appState: {} }, files: {} });
    await expect(next()).rejects.toThrow("whiteboard_save_failed");
    expect(flush).toHaveBeenCalledOnce();
    expect(db.writes).toHaveLength(0); expect(db.boards.size).toBe(1);
    expect(win.getSnapshot().layout.visible).toEqual([original.id]);
    expect(win.getSnapshot().boards.has(original.id)).toBe(true);
    const saved = { ...original, revision: 1, scene: { elements: [{ id: "retained", type: "rectangle", x: 1, y: 2, width: 3, height: 4 }], appState: {} } };
    flush.mockImplementation(async () => { db.boards.set(original.id, saved); });
    await next();
    expect(flush).toHaveBeenCalledTimes(2); expect(db.boards.size).toBe(operation === "note" ? 1 : 2);
    expect(db.boards.get(original.id)?.scene.elements[0]?.id).toBe("retained");
  });
});

describe("native page metadata persistence", () => {
  const page = { id: "web", kind: "browser" as const, title: "Inbox", url: "https://mail.example/" };
  it("does not rewrite the layout for title ticks, and saves the latest title on hide", async () => {
    const emit = native(); vi.useFakeTimers();
    const db = store({ ...emptyWorkbench(), tabs: [page], visible: ["web"], active: "web" }), win = await open(db.cache);
    for (let i = 1; i <= 30; i++) { emit({ kind: "state", tab: "web", url: page.url, title: `(${i}) Inbox` }); await vi.advanceTimersByTimeAsync(100); }
    expect(db.writes.length).toBeLessThanOrEqual(1);                      // 3 s of ticks: at most the 5 s trailing save
    win.setVisible(false); await vi.advanceTimersByTimeAsync(0);
    expect(db.layout().tabs[0]!.title).toBe("(30) Inbox");
    const before = db.writes.length;
    for (let i = 0; i < 5; i++) { emit({ kind: "state", tab: "web", url: page.url, title: "x".repeat(300) }); await vi.advanceTimersByTimeAsync(6000); }
    expect(db.writes.length - before).toBe(1);                            // a long title is compared after truncation
  });
  it("saves a new address immediately, coalesces bursts and keeps the last address through hide and disposal", async () => {
    const emit = native(); vi.useFakeTimers();
    const db = store({ ...emptyWorkbench(), tabs: [page], visible: ["web"], active: "web" }), win = await open(db.cache);
    emit({ kind: "state", tab: "web", url: "https://mail.example/a", title: "A" }); await vi.advanceTimersByTimeAsync(0);
    expect(db.layout().tabs[0]!.url).toBe("https://mail.example/a");      // a single navigation is not delayed
    const before = db.writes.length;
    for (let i = 0; i < 20; i++) { emit({ kind: "state", tab: "web", url: `https://mail.example/feed?item=${i}` }); await vi.advanceTimersByTimeAsync(20); }
    await vi.advanceTimersByTimeAsync(300);
    expect(db.writes.length - before).toBeLessThanOrEqual(3); expect(db.layout().tabs[0]!.url).toBe("https://mail.example/feed?item=19");
    emit({ kind: "state", tab: "web", url: "https://mail.example/last" });
    win.dispose(); await vi.advanceTimersByTimeAsync(0);
    expect(db.layout().tabs[0]!.url).toBe("https://mail.example/last");   // nothing lost at teardown
  });
  it("keeps the last address when hiding queues its save immediately before disposal (cross-review case)", async () => {
    const emit = native(); vi.useFakeTimers();
    const db = store({ ...emptyWorkbench(), tabs: [page], visible: ["web"], active: "web" }), win = await open(db.cache);
    emit({ kind: "state", tab: "web", url: "https://mail.example/last" });
    win.setVisible(false); win.dispose(); await vi.advanceTimersByTimeAsync(0);
    expect(db.layout().tabs[0]!.url).toBe("https://mail.example/last");
    // Identity/CAS still gate it: a newer layout from another window is not overwritten.
    const other = store({ ...emptyWorkbench(), tabs: [page], visible: ["web"], active: "web" }), stale = await open(other.cache);
    emit({ kind: "state", tab: "web", url: "https://mail.example/stale" });
    const newer = await open(other.cache); await newer.change({ type: "expanded", value: true });
    stale.setVisible(false); stale.dispose(); await vi.advanceTimersByTimeAsync(0);
    expect(other.layout()).toMatchObject({ expanded: true }); expect(other.layout().tabs[0]!.url).not.toBe("https://mail.example/stale");
  });
});

describe("one-click split and merge use the shared flush and CAS queue", () => {
  const board = { id: "board", kind: "whiteboard" as const, title: "Board" };
  it("merging saves a leaving board first and keeps the split when that save fails", async () => {
    native();
    const db = store({ ...emptyWorkbench(), tabs: [chart("a"), board], visible: ["a", "board"], active: "a", column: .3 });
    db.boards.set(board.id, emptyBoard(board.id));
    const win = await open(db.cache), flush = vi.fn(async (): Promise<void> => { throw Error("whiteboard_save_failed"); });
    win.bindBoard(board.id, { flush } as unknown as BoardController);
    await expect(win.change({ type: "single", id: "a" })).rejects.toThrow("whiteboard_save_failed");
    expect(flush).toHaveBeenCalledOnce(); expect(db.writes).toHaveLength(0);
    expect(win.getSnapshot().layout).toMatchObject({ visible: ["a", "board"], active: "a", revision: 0 });
    expect(win.getSnapshot().boards.has(board.id)).toBe(true);
    flush.mockImplementation(async () => undefined);
    await win.change({ type: "single", id: "a" });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(db.layout()).toMatchObject({ visible: ["a"], active: "a", column: .3, revision: 1 });
    expect(db.layout().tabs.map(tab => tab.id)).toEqual(["a", "board"]);    // merged, not closed
    expect(db.boards.has(board.id)).toBe(true);
  });
  it("tiling loads every board it reveals, and writes nothing when one is unavailable", async () => {
    native();
    const db = store({ ...emptyWorkbench(), tabs: [chart("a"), board, chart("c")], visible: ["a"], active: "a" });
    const win = await open(db.cache);
    await expect(win.change({ type: "tile" })).rejects.toThrow("whiteboard_not_found");
    expect(db.writes).toHaveLength(0); expect(win.getSnapshot().layout.visible).toEqual(["a"]);
    db.boards.set(board.id, emptyBoard(board.id));
    await win.change({ type: "tile" });
    expect(db.layout()).toMatchObject({ visible: ["a", "board", "c"], active: "a" });
    expect(win.getSnapshot().boards.has(board.id)).toBe(true);
  });
  it("tile with one tab saves the unchanged regions through CAS", async () => {
    native();
    const initial = { ...emptyWorkbench(), tabs: [chart("a")], visible: ["a"], active: "a" };
    const db = store(initial), win = await open(db.cache);
    await win.change({ type: "tile" });
    expect(db.writes).toEqual([{ ...initial, revision: 1 }]); expect(win.getSnapshot().layout).toEqual(db.layout());
  });
  it("a stale window's tile or merge conflicts once, adopts the newer layout and is never replayed", async () => {
    native();
    const db = store({ ...emptyWorkbench(), tabs: [chart("a"), chart("b"), chart("c")], visible: ["a"], active: "a" });
    const first = await open(db.cache), second = await open(db.cache);
    await first.change({ type: "tile" });
    await expect(second.change({ type: "tile" })).rejects.toThrow("workbench_revision_conflict");
    expect(second.getSnapshot().layout).toEqual(db.layout()); expect(db.writes).toHaveLength(1);
    await second.change({ type: "single", id: "b" });
    expect(db.layout()).toMatchObject({ visible: ["b"], active: "b", revision: 2 });
    // The first window still shows its split; its merge is stale and must not overwrite.
    await expect(first.change({ type: "single", id: "a" })).rejects.toThrow("workbench_revision_conflict");
    expect(db.layout()).toMatchObject({ visible: ["b"], active: "b", revision: 2 }); expect(db.writes).toHaveLength(2);
    expect(first.getSnapshot().layout).toEqual(db.layout());
    await first.change({ type: "tile" });
    expect(db.layout()).toMatchObject({ visible: ["a", "b", "c"], active: "b", revision: 3 });
  });
});


describe("explicit split selection uses the existing persistence boundary", () => {
  it("does not partially replace panes when a leaving editor fails to save, then commits once on retry", async () => {
    native();
    const board = { id: "board", kind: "whiteboard" as const, title: "Board" };
    const db = store({ ...emptyWorkbench(), tabs: [chart("a"), board, chart("c"), chart("d")], visible: ["a", "board"], active: "a" });
    db.boards.set(board.id, emptyBoard(board.id));
    const win = await open(db.cache), flush = vi.fn(async (): Promise<void> => { throw Error("whiteboard_save_failed"); });
    win.bindBoard(board.id, { flush } as unknown as BoardController);
    await expect(win.change({ type: "set-visible", ids: ["c", "d"] })).rejects.toThrow("whiteboard_save_failed");
    expect(db.writes).toHaveLength(0); expect(win.getSnapshot().layout.visible).toEqual(["a", "board"]);
    flush.mockImplementation(async () => undefined);
    await win.change({ type: "set-visible", ids: ["c", "d"] });
    expect(db.writes).toHaveLength(1); expect(db.layout()).toMatchObject({ visible: ["c", "d"], active: "c", revision: 1 });
    expect(db.layout().tabs).toHaveLength(4); expect(db.boards.has(board.id)).toBe(true);
  });
  it("adopts a concurrent close without replaying a stale selection, then permits a corrected selection", async () => {
    native();
    const db = store({ ...emptyWorkbench(), tabs: [chart("a"), chart("b"), chart("c")], visible: ["a"], active: "a" });
    const first = await open(db.cache), second = await open(db.cache);
    await first.closeTab("c");
    await expect(second.change({ type: "set-visible", ids: ["b", "c"] })).rejects.toThrow("workbench_revision_conflict");
    expect(db.writes).toHaveLength(1); expect(second.getSnapshot().layout).toEqual(db.layout());
    await expect(second.change({ type: "set-visible", ids: ["b", "c"] })).rejects.toThrow("workbench_tab_closed");
    await second.change({ type: "set-visible", ids: ["a", "b"] });
    expect(db.writes).toHaveLength(2); expect(db.layout()).toMatchObject({ visible: ["a", "b"], active: "a", revision: 2 });
  });
});
