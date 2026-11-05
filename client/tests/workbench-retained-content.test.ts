import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchController } from "../src/workbench-controller.js";
import { BoardSession, type BoardAdapter, type BoardController } from "../src/workbench-board.js";
import { workbenchEditorLock } from "../src/workbench-library.js";
import { emptyDesign, type DesignDocument } from "../src/workbench-design.js";
import { emptyMarkdown, type MarkdownDocument } from "../src/workbench-markdown.js";
import { emptyBoard, emptyWorkbench, workbenchScope, type BoardDocument, type BoardScene, type WorkbenchLayout, type WorkbenchTab } from "../src/workbench-model.js";
import type { HubConnection } from "../src/connection.js";

// Real Node Web Locks; every test uses its own conversation so locks never meet.
const owners: WorkbenchController[] = [];
afterEach(() => { owners.forEach(owner => owner.dispose()); owners.length = 0; vi.unstubAllGlobals(); });
let sequence = 0;
const fresh = () => `retained${++sequence}`;
const tab = (id: string, kind: WorkbenchTab["kind"]): WorkbenchTab => ({ id, kind, title: id.toUpperCase() });
const adapter: BoardAdapter = { create: values => values, apply: () => undefined, selection: () => [] };
const scene = (x: number): BoardScene => ({ elements: [{ id: "shape", type: "rectangle", x, y: 10, width: 80, height: 50, version: 1 }], appState: {} });

/** One same-origin store shared by every window of a test. */
function store(conversation: string, initial: WorkbenchLayout) {
  let layout = structuredClone(initial), failing = false;
  const boards = new Map<string, BoardDocument>(), designs = new Map<string, DesignDocument>(), notes = new Map<string, MarkdownDocument>();
  const commit = (expected: number, next: WorkbenchLayout) => { if (layout.revision !== expected) throw Error("workbench_revision_conflict"); layout = structuredClone(next); };
  const cache = {
    readWorkbench: async () => structuredClone(layout),
    saveWorkbench: async (_scope: string, expected: number, next: WorkbenchLayout) => commit(expected, next),
    readWorkbenchBoard: async (_scope: string, id: string) => structuredClone(boards.get(id)),
    createWorkbenchBoardAndLayout: async (_scope: string, next: BoardDocument, expectedLayout: number, layout: WorkbenchLayout) => { commit(expectedLayout, layout); boards.set(next.id, structuredClone(next)); },
    saveWorkbenchBoard: async (_scope: string, expected: number, next: BoardDocument) => {
      if (failing) { const error = new Error("The quota has been exceeded."); error.name = "QuotaExceededError"; throw error; }
      if ((boards.get(next.id)?.revision ?? -1) !== expected) throw Error("whiteboard_revision_conflict"); boards.set(next.id, structuredClone(next));
    },
    deleteWorkbenchBoardAndLayout: async (_scope: string, id: string, expected: number, expectedLayout: number, next: WorkbenchLayout) => {
      if (boards.get(id)?.revision !== expected) throw Error("whiteboard_revision_conflict"); commit(expectedLayout, next); boards.delete(id);
    },
    readWorkbenchDesign: async (_scope: string, id: string) => structuredClone(designs.get(id)),
    saveWorkbenchDesign: async (_scope: string, expected: number, next: DesignDocument) => { if ((designs.get(next.id)?.revision ?? -1) !== expected) throw Error("design_revision_conflict"); designs.set(next.id, structuredClone(next)); },
    deleteWorkbenchDesignAndLayout: async (_scope: string, id: string, expected: number, expectedLayout: number, next: WorkbenchLayout) => {
      if (designs.get(id)?.revision !== expected) throw Error("design_revision_conflict"); commit(expectedLayout, next); designs.delete(id);
    },
    readWorkbenchMarkdown: async (_scope: string, id: string) => structuredClone(notes.get(id)),
  };
  const connection = { identity: { deviceId: "device", hubPublicKey: "host" }, state: { status: "online", user: { id: "owner" }, workbenchDesignAvailable: true, workbenchMarkdownAvailable: true },
    isClosed: false, isReadOnly: false, cache, subscribe: () => () => undefined, conversationRevision: () => 0, http: vi.fn() } as unknown as HubConnection;
  return { cache, connection, boards, designs, notes, layout: () => layout, scope: workbenchScope("host", "owner", conversation), fail: (value: boolean) => { failing = value; } };
}
async function open(db: ReturnType<typeof store>, conversation: string) {
  const controller = new WorkbenchController({ connection: db.connection, conversationId: conversation }); owners.push(controller);
  await controller.initialize(); controller.setVisible(true); return controller;
}
/** What WorkbenchCanvas builds: a session from the controller's document and real saved revision. */
function canvas(controller: WorkbenchController, id: string) {
  const document = controller.getSnapshot().boards.get(id)!;
  const session = new BoardSession(document, (expected, next) => controller.persistBoard(expected, next), adapter, controller.boardDocument,
    (controller as { boardSavedRevision?: (id: string) => number | undefined }).boardSavedRevision?.(id));
  session.setWritable(true); return session;
}
/** Captures the controller's beforeunload guard (no window in Node). */
function unloadGuard() {
  const handlers: Array<(event: BeforeUnloadEvent) => void> = [];
  vi.stubGlobal("addEventListener", (type: string, handler: (event: BeforeUnloadEvent) => void) => { if (type === "beforeunload") handlers.push(handler); });
  vi.stubGlobal("removeEventListener", () => undefined);
  return () => { let blocked = false; for (const handler of handlers) handler({ preventDefault: () => { blocked = true; }, returnValue: "" } as unknown as BeforeUnloadEvent); return blocked; };
}
/** Holds a Web Lock; the returned release settles once the lock is actually free. */
const hold = async (name: string, mode: LockMode = "exclusive") => {
  let release!: () => void, granted!: () => void; const ready = new Promise<void>(resolve => { granted = resolve; });
  const done = navigator.locks.request(name, { mode }, () => { granted(); return new Promise<void>(resolve => { release = resolve; }); });
  await ready; return () => { release(); return done; };
};

describe("F1: a failed whiteboard save stays truthfully unsaved across a remount", () => {
  it("keeps the edit and the real saved revision, guards unload, and saves against storage after recovery", async () => {
    const conversation = fresh(), guard = unloadGuard();
    const db = store(conversation, { ...emptyWorkbench(), tabs: [tab("b", "whiteboard")], visible: ["b"], active: "b" });
    db.boards.set("b", emptyBoard("b"));
    const controller = await open(db, conversation);
    const first = canvas(controller, "b");
    db.fail(true);
    first.local(scene(40), {}); await expect(first.flush()).rejects.toThrow("quota");
    expect(controller.getSnapshot().boards.get("b")!.revision).toBe(1);
    expect(guard()).toBe(true);
    // The person switches chat: the editor unmounts, its final flush fails too.
    first.dispose(); await first.flush().catch(() => undefined);
    controller.setVisible(false); await new Promise(resolve => setTimeout(resolve, 10));
    expect(controller.getSnapshot().boards.get("b")?.scene.elements[0]!.x, "the unsaved scene is kept while hidden").toBe(40);
    expect(guard()).toBe(true);
    controller.setVisible(true); await new Promise(resolve => setTimeout(resolve, 10));
    const second = canvas(controller, "b");
    expect(second.dirty(), "shown as unsaved, not as saved").toBe(true);
    expect(second.document.scene.elements[0]!.x).toBe(40);
    db.fail(false); await second.flush();
    expect(db.boards.get("b")!.revision).toBe(1); expect(db.boards.get("b")!.scene.elements[0]!.x).toBe(40);
    expect(second.dirty()).toBe(false); expect(guard()).toBe(false);
  });

  it("keeps a retained unsaved board in memory when its Tab is closed while no editor is mounted", async () => {
    const conversation = fresh(), guard = unloadGuard();
    const db = store(conversation, { ...emptyWorkbench(), tabs: [tab("b", "whiteboard"), tab("c", "chart")], visible: ["b"], active: "b" });
    db.boards.set("b", emptyBoard("b"));
    const controller = await open(db, conversation), editor = canvas(controller, "b");
    db.fail(true); editor.local(scene(70), {}); await expect(editor.flush()).rejects.toThrow();
    editor.dispose();
    await controller.change({ type: "select", id: "c" });
    expect(controller.getSnapshot().boards.get("b")?.scene.elements[0]!.x).toBe(70); expect(guard()).toBe(true);
  });

  it("reopening the closed Tab keeps the retained edit, retries, and saves it against storage", async () => {
    const conversation = fresh(), guard = unloadGuard();
    const db = store(conversation, { ...emptyWorkbench(), tabs: [tab("b", "whiteboard"), tab("c", "chart")], visible: ["b"], active: "b" });
    db.boards.set("b", emptyBoard("b"));
    const controller = await open(db, conversation), editor = canvas(controller, "b");
    db.fail(true); editor.local(scene(70), {}); await expect(editor.flush()).rejects.toThrow();
    editor.dispose();
    await controller.closeTab("b"); await controller.reopen("b");
    expect(controller.getSnapshot().boards.get("b")?.scene.elements[0]?.x, "retained draft must survive closed-tab reopen").toBe(70);
    expect(controller.boardSavedRevision("b")).toBe(0); expect(guard()).toBe(true);
    const reopened = canvas(controller, "b");
    expect(reopened.dirty()).toBe(true);
    await expect(reopened.flush(), "storage still failing: stays unsaved for Retry").rejects.toThrow("quota");
    expect(reopened.dirty()).toBe(true); expect(guard()).toBe(true);
    db.fail(false); await reopened.flush();
    expect(db.boards.get("b")).toMatchObject({ revision: 1 }); expect(db.boards.get("b")!.scene.elements[0]!.x).toBe(70);
    expect(reopened.dirty()).toBe(false); expect(guard()).toBe(false);
  });

  it("a reopened retained edit never overwrites a newer stored board (CAS), and a deleted board is not reopened", async () => {
    const conversation = fresh(), guard = unloadGuard();
    const db = store(conversation, { ...emptyWorkbench(), tabs: [tab("b", "whiteboard"), tab("c", "chart")], visible: ["b"], active: "b" });
    db.boards.set("b", emptyBoard("b"));
    const controller = await open(db, conversation), editor = canvas(controller, "b");
    db.fail(true); editor.local(scene(70), {}); await expect(editor.flush()).rejects.toThrow();
    editor.dispose(); db.fail(false);
    await controller.closeTab("b");
    // Another window saved its own change meanwhile.
    db.boards.set("b", { ...emptyBoard("b"), revision: 1, scene: scene(5) });
    await controller.reopen("b");
    expect(controller.getSnapshot().boards.get("b")!.scene.elements[0]!.x).toBe(70);
    await expect(canvas(controller, "b").flush()).rejects.toThrow("whiteboard_revision_conflict");
    expect(db.boards.get("b")!.scene.elements[0]!.x, "the other window's save is kept").toBe(5); expect(guard()).toBe(true);
    // Reopen still requires the stored item.
    await controller.closeTab("b"); db.boards.delete("b");
    await expect(controller.reopen("b")).rejects.toThrow("whiteboard_not_found");
    expect(db.layout().closed.map(item => item.id)).toContain("b");
  });

  it("a replayed create request keeps its retained unsaved board", async () => {
    const conversation = fresh(), guard = unloadGuard();
    const db = store(conversation, { ...emptyWorkbench(), tabs: [tab("c", "chart")], visible: ["c"], active: "c" });
    const controller = await open(db, conversation), id = await controller.createBoard("白板", "request-1");
    const editor = canvas(controller, id);
    db.fail(true); editor.local(scene(70), {}); await expect(editor.flush()).rejects.toThrow();
    editor.dispose();
    await controller.closeTab(id);
    expect(await controller.createBoard("白板", "request-1")).toBe(id);
    expect(controller.getSnapshot().layout.tabs.map(item => item.id)).toContain(id);
    expect(controller.getSnapshot().boards.get(id)!.scene.elements[0]!.x).toBe(70);
    expect(controller.boardSavedRevision(id)).toBe(0); expect(guard()).toBe(true);
    db.fail(false); await canvas(controller, id).flush();
    expect(db.boards.get(id)!.scene.elements[0]!.x).toBe(70); expect(guard()).toBe(false);
  });

  it("a session given no saved revision behaves exactly as before", () => {
    const session = new BoardSession({ ...emptyBoard("b"), revision: 3 }, async () => undefined, adapter);
    expect(session.dirty()).toBe(false); expect(session.savedRevision).toBe(3);
    // An impossible saved revision (newer than the document) is ignored.
    expect(new BoardSession({ ...emptyBoard("b"), revision: 3 }, async () => undefined, adapter, () => undefined, 9).savedRevision).toBe(3);
  });
});

describe("F2: deleting from a Tab never removes content another window is editing", () => {
  it("refuses a whiteboard edited in another window and leaves storage untouched", async () => {
    const conversation = fresh(), db = store(conversation, { ...emptyWorkbench(), tabs: [tab("b", "whiteboard")], visible: [], active: null });
    db.boards.set("b", emptyBoard("b"));
    const controller = await open(db, conversation), release = await hold(workbenchEditorLock("whiteboard", db.scope, "b"));
    await expect(controller.deleteBoard("b")).rejects.toThrow("whiteboard_read_only");
    expect(db.boards.has("b")).toBe(true); expect(db.layout().tabs.map(item => item.id)).toEqual(["b"]);
    await release(); await controller.deleteBoard("b");
    expect(db.boards.has("b")).toBe(false); expect(db.layout().tabs).toEqual([]);
  });

  it("refuses when this window's own editor is read-only, and deletes after flushing an owning editor", async () => {
    const conversation = fresh(), db = store(conversation, { ...emptyWorkbench(), tabs: [tab("b", "whiteboard")], visible: ["b"], active: "b" });
    db.boards.set("b", emptyBoard("b"));
    const controller = await open(db, conversation), flush = vi.fn(async () => undefined);
    let owns = false;
    controller.bindBoard("b", { flush, ownsEditor: () => owns } as unknown as BoardController);
    await expect(controller.deleteBoard("b")).rejects.toThrow("whiteboard_read_only"); expect(db.boards.has("b")).toBe(true);
    // The owning editor holds the exclusive lock itself: no second request that would wait on it.
    owns = true; const release = await hold(workbenchEditorLock("whiteboard", db.scope, "b"));
    await controller.deleteBoard("b"); await release();
    expect(flush).toHaveBeenCalled(); expect(db.boards.has("b")).toBe(false);
  });

  it("deletes a Design whose only editor is this window's own, without waiting on its own shared lease", async () => {
    const conversation = fresh(), db = store(conversation, { ...emptyWorkbench(), tabs: [tab("d", "design")], visible: ["d"], active: "d" });
    db.designs.set("d", emptyDesign("d"));
    const controller = await open(db, conversation), name = workbenchEditorLock("design", db.scope, "d");
    await new Promise(resolve => setTimeout(resolve, 10));
    const session = controller.designSession("d")!; let lease = await hold(name, "shared"); const events: string[] = [];
    session.bindEditor({ flush: async () => { events.push("flush"); }, reload: async () => undefined, retire: async () => undefined,
      discard: () => { events.push("discard"); lease(); },
      suspend: async () => { events.push("suspend"); await lease(); return async () => { events.push("resume"); lease = await hold(name, "shared"); }; } });
    // Another window's editor holds the same shared lock: refused, own lease restored.
    const other = await hold(name, "shared");
    await expect(controller.deleteDesign("d")).rejects.toThrow("design_in_use");
    expect(db.designs.has("d")).toBe(true); expect(events).toEqual(["flush", "suspend", "resume"]);
    await other(); events.length = 0;
    await controller.deleteDesign("d");
    expect(db.designs.has("d")).toBe(false); expect(events).toEqual(["flush", "suspend", "discard"]);
  });
});

describe("DS2-06: one unavailable visible item does not stop the whole workbench", () => {
  it("opens with a missing visible Design, reports it, and keeps the other content usable", async () => {
    const conversation = fresh(), db = store(conversation, { ...emptyWorkbench(), tabs: [tab("d", "design"), tab("b", "whiteboard")], visible: ["d", "b"], active: "d" });
    db.boards.set("b", emptyBoard("b"));
    const controller = await open(db, conversation);
    expect(controller.getSnapshot().ready).toBe(true); expect(controller.getSnapshot().error).toBe("design_not_found");
    expect(controller.getSnapshot().boards.has("b")).toBe(true);
    // The person can close the unavailable Tab and keep working.
    await controller.closeTab("d"); expect(db.layout().visible).toEqual(["b"]);
  });
});
