import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchController } from "../src/workbench-controller.js";
import { deleteWorkbenchLibraryEntries, listWorkbenchLibrary, workbenchEditorLock, workbenchLibraryKey, type StoredWorkbenchItem, type WorkbenchItemKind, type WorkbenchOwner } from "../src/workbench-library.js";
import { emptyMarkdown, type MarkdownDocument } from "../src/workbench-markdown.js";
import { emptyDesign, emptySlides, type DesignDocument } from "../src/workbench-design.js";
import { noteRecoveryKey, readNoteRecovery, rememberNoteRecovery } from "../src/workbench-note-recovery.js";
import { changeWorkbench, emptyBoard, emptyWorkbench, workbenchScope, type BoardDocument, type WorkbenchLayout, type WorkbenchTab } from "../src/workbench-model.js";
import type { HubConnection } from "../src/connection.js";

// Node provides real Web Locks; each test uses its own conversation so locks never leak between tests.
const owners: WorkbenchController[] = [];
afterEach(() => { owners.forEach(owner => owner.dispose()); owners.length = 0; vi.unstubAllGlobals(); });
const tab = (id: string, kind: WorkbenchTab["kind"], title = id.toUpperCase()): WorkbenchTab => ({ id, kind, title });
let sequence = 0;
const fresh = () => `conversation${++sequence}`;

/** Same-origin storage shared by every window of one test, with library deletion semantics. */
function store(conversation: string, initial: WorkbenchLayout) {
  let layout = structuredClone(initial);
  const boards = new Map<string, BoardDocument>(), notes = new Map<string, MarkdownDocument>(), designs = new Map<string, DesignDocument>();
  const listeners = new Set<(ids: string[]) => void>(), deletions: Array<{ scope: string; items: Array<{ kind: WorkbenchItemKind; id: string }> }> = [];
  const content = (kind: WorkbenchItemKind) => kind === "whiteboard" ? boards : kind === "markdown" ? notes : designs;
  const commit = (expected: number, next: WorkbenchLayout) => { if (layout.revision !== expected) throw Error("workbench_revision_conflict"); layout = structuredClone(next); };
  const cache = {
    isClosed: false, databaseName: "tarocub-host-test",
    conversation: async (id: string) => id === conversation ? { id, title: "Planning", archived: false } : undefined,
    readWorkbench: async () => structuredClone(layout),
    saveWorkbench: async (_scope: string, expected: number, next: WorkbenchLayout) => commit(expected, next),
    readWorkbenchBoard: async (_scope: string, id: string) => boards.get(id),
    saveWorkbenchBoard: async (_scope: string, expected: number, next: BoardDocument) => { if ((boards.get(next.id)?.revision ?? -1) !== expected) throw Error("whiteboard_revision_conflict"); boards.set(next.id, next); },
    readWorkbenchMarkdown: async (_scope: string, id: string) => notes.get(id),
    saveWorkbenchMarkdown: async (_scope: string, expected: number, next: MarkdownDocument) => { if ((notes.get(next.id)?.revision ?? -1) !== expected) throw Error("markdown_revision_conflict"); notes.set(next.id, next); },
    readWorkbenchDesign: async (_scope: string, id: string) => designs.get(id),
    saveWorkbenchDesign: async (_scope: string, expected: number, next: DesignDocument) => { if ((designs.get(next.id)?.revision ?? -1) !== expected) throw Error("design_revision_conflict"); designs.set(next.id, next); },
    hasWorkbenchItem: async (_scope: string, kind: WorkbenchItemKind, id: string) => content(kind).has(id),
    subscribeWorkbenchChanges: (_scope: string, listener: (ids: string[]) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    listWorkbenchItems: vi.fn(async (_owner: WorkbenchOwner): Promise<{ items: StoredWorkbenchItem[]; truncated: boolean; skipped: number }> => ({ items: [], truncated: false, skipped: 0 })),
    deleteWorkbenchItems: async (_owner: WorkbenchOwner, scope: string, items: Array<{ kind: WorkbenchItemKind; id: string }>) => {
      deletions.push({ scope, items: structuredClone(items) });
      let next = layout;
      const results = items.map(({ kind, id }) => {
        const exists = content(kind).delete(id);
        if ([...layout.tabs, ...layout.closed].some(value => value.id === id)) next = changeWorkbench(next, { type: "delete", id });
        return { kind, id, status: exists ? "deleted" as const : "already_deleted" as const };
      });
      if (next !== layout) layout = { ...next, revision: layout.revision + 1 };
      listeners.forEach(listener => listener(items.map(item => item.id)));
      return results;
    },
  };
  const connection = { identity: { deviceId: "device", hubPublicKey: "host" }, state: { status: "online", user: { id: "owner" }, workbenchDesignAvailable: true, workbenchMarkdownAvailable: true }, isClosed: false, isReadOnly: false, cache,
    subscribe: () => () => undefined, conversationRevision: () => 0, http: vi.fn() } as unknown as HubConnection;
  const scope = workbenchScope("host", "owner", conversation);
  // The UI passes its listed rows; their cache key is re-checked against this connection.
  const item = (kind: WorkbenchItemKind, id: string, at = scope) => ({ key: workbenchLibraryKey(cache.databaseName, at, kind, id), scope: at, kind, id });
  return { cache, connection, boards, notes, designs, deletions, layout: () => layout, scope, item };
}
async function open(db: ReturnType<typeof store>, conversation: string, visible = true) {
  const controller = new WorkbenchController({ connection: db.connection, conversationId: conversation }); owners.push(controller);
  await controller.initialize(); controller.setVisible(visible); return controller;
}

describe("device workbench library listing", () => {
  it("returns this owner's metadata and refuses an unknown owner or a closed cache", async () => {
    const conversation = fresh(), db = store(conversation, emptyWorkbench()), entry: StoredWorkbenchItem = { scope: db.scope, conversationId: conversation, id: "b1", kind: "whiteboard", title: "Plan", state: "open", layoutRevision: 2 };
    db.cache.listWorkbenchItems.mockResolvedValue({ truncated: true, skipped: 1, items: [entry] });
    expect(await listWorkbenchLibrary(db.connection, { maxScopes: 99_999 })).toEqual({ entries: [entry], truncated: true, skipped: 1 });
    expect(db.cache.listWorkbenchItems).toHaveBeenCalledWith({ host: "host", user: "owner" }, { scopes: 1000, entries: 5000 });
    (db.cache as { isClosed: boolean }).isClosed = true;
    await expect(listWorkbenchLibrary(db.connection)).rejects.toThrow("local_cache_closed");
    (db.cache as { isClosed: boolean }).isClosed = false; (db.connection.state as { user?: unknown }).user = undefined;
    await expect(listWorkbenchLibrary(db.connection)).rejects.toThrow("workbench_scope_unavailable");
  });

  it("never shows a listing read for a previous user", async () => {
    const db = store(fresh(), emptyWorkbench()), state = db.connection.state as { user?: { id: string } };
    db.cache.listWorkbenchItems.mockImplementation(async () => { state.user = { id: "next" }; return { items: [], truncated: false, skipped: 0 }; });
    await expect(listWorkbenchLibrary(db.connection)).rejects.toThrow("workbench_scope_unavailable");
  });
});

describe("device workbench library deletion", () => {
  it("returns one result per input, in order, re-checking the cache key and owner of each entry", async () => {
    const conversation = fresh(), db = store(conversation, emptyWorkbench());
    db.boards.set("a", emptyBoard("a")); db.notes.set("n", emptyMarkdown("n"));
    const foreign = workbenchScope("host", "someone-else", conversation), other = workbenchScope("host", "owner", fresh());
    const results = await deleteWorkbenchLibraryEntries(db.connection, [
      db.item("whiteboard", "a"), db.item("markdown", "x", foreign), { scope: db.scope, kind: "markdown" as const, id: "n" },
      { ...db.item("markdown", "n"), key: workbenchLibraryKey("another-cache", db.scope, "markdown", "n") },
      db.item("markdown", "n"), db.item("whiteboard", "a"), db.item("design", "gone", other),
    ]);
    expect(results.map(result => [result.scope === db.scope ? "here" : result.scope === other ? "other" : "foreign", result.id, result.status])).toEqual([
      ["here", "a", "deleted"], ["foreign", "x", "scope_unavailable"], ["here", "n", "deleted"], ["here", "n", "scope_unavailable"],
      ["here", "n", "deleted"], ["here", "a", "deleted"], ["other", "gone", "already_deleted"],
    ]);
    // Duplicates run once; another user's scope and another cache's rows never reach storage.
    expect(db.deletions).toEqual([{ scope: db.scope, items: [{ kind: "markdown", id: "n" }, { kind: "whiteboard", id: "a" }] }, { scope: other, items: [{ kind: "design", id: "gone" }] }]);
  });

  it("reports an item held by an editor as busy and deletes the rest of its conversation", async () => {
    const db = store(fresh(), emptyWorkbench());
    db.notes.set("held", emptyMarkdown("held")); db.notes.set("free", emptyMarkdown("free"));
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let granted!: () => void; const holding = new Promise<void>(resolve => { granted = resolve; });
    void navigator.locks.request(workbenchEditorLock("markdown", db.scope, "held"), async () => { granted(); await held; });
    await holding;
    const results = await deleteWorkbenchLibraryEntries(db.connection, [db.item("markdown", "held"), db.item("markdown", "free")]);
    release();
    expect(results.map(result => [result.id, result.status, result.error])).toEqual([["held", "busy", "workbench_item_busy"], ["free", "deleted", undefined]]);
    expect(db.notes.has("held")).toBe(true);
  });

  it("maps storage failures per conversation and validates the whole batch first", async () => {
    const db = store(fresh(), emptyWorkbench()), second = workbenchScope("host", "owner", fresh());
    db.cache.deleteWorkbenchItems = vi.fn(async (_owner: WorkbenchOwner, scope: string) => { throw new Error(scope === db.scope ? "local_reset_in_progress" : "QuotaExceededError"); });
    expect((await deleteWorkbenchLibraryEntries(db.connection, [db.item("whiteboard", "a"), db.item("whiteboard", "b", second)])).map(result => [result.status, result.error]))
      .toEqual([["reset_in_progress", "local_reset_in_progress"], ["failed", "QuotaExceededError"]]);
    await expect(deleteWorkbenchLibraryEntries(db.connection, Array.from({ length: 201 }, (_, index) => db.item("whiteboard", `b${index}`)))).rejects.toThrow("workbench_library_batch_limit");
    await expect(deleteWorkbenchLibraryEntries(db.connection, [{ ...db.item("whiteboard", "c"), kind: "chart" as never }])).rejects.toThrow("workbench_library_invalid_input");
    (db.connection as { isReadOnly: boolean }).isReadOnly = true;
    expect((await deleteWorkbenchLibraryEntries(db.connection, [db.item("whiteboard", "a")]))[0].status).toBe("scope_unavailable");
  });

  it("deletes nothing when the user switches while editor locks are being taken", async () => {
    const db = store(fresh(), emptyWorkbench()), state = db.connection.state as { user?: { id: string } }, locks = navigator.locks;
    db.boards.set("a", emptyBoard("a"));
    vi.stubGlobal("navigator", { locks: { request: (...args: Parameters<LockManager["request"]>) => { state.user = { id: "next" }; return (locks.request as (...values: unknown[]) => Promise<unknown>)(...args); } } });
    const results = await deleteWorkbenchLibraryEntries(db.connection, [db.item("whiteboard", "a")]);
    expect(results.map(result => [result.status, result.error])).toEqual([["scope_unavailable", "workbench_scope_unavailable"]]);
    expect(db.deletions).toEqual([]);
    expect(db.boards.has("a")).toBe(true);
  });

  it("fails closed for every kind when Web Locks are unavailable", async () => {
    const db = store(fresh(), emptyWorkbench());
    vi.stubGlobal("navigator", {});
    const results = await deleteWorkbenchLibraryEntries(db.connection, [db.item("design", "d"), db.item("whiteboard", "b"), db.item("markdown", "n")]);
    expect(results.map(result => [result.status, result.error])).toEqual(Array(3).fill(["busy", "workbench_locks_unavailable"]));
    expect(db.deletions).toEqual([]);
  });

  it("clears this window's emergency note draft of a deleted note", async () => {
    const db = store(fresh(), emptyWorkbench()), key = noteRecoveryKey("device", db.scope, "n");
    db.notes.set("n", emptyMarkdown("n")); rememberNoteRecovery(key, { content: "unsaved", revision: 0 });
    await deleteWorkbenchLibraryEntries(db.connection, [db.item("markdown", "n")]);
    expect(readNoteRecovery(key)).toBeUndefined();
  });
});

describe("controller after a device-library deletion", () => {
  it("forgets a closed design's lingering session and adopts the committed layout", async () => {
    const conversation = fresh(), db = store(conversation, { ...emptyWorkbench(), tabs: [tab("d", "design"), tab("b", "whiteboard")], visible: ["d"], active: "d" });
    db.designs.set("d", emptyDesign("d")); db.boards.set("b", emptyBoard("b"));
    const controller = await open(db, conversation);
    await vi.waitFor(() => expect(controller.designSession("d")).toBeDefined());
    await controller.closeTab("d");
    expect(controller.designSession("d")).toBeDefined();
    expect((await deleteWorkbenchLibraryEntries(db.connection, [db.item("design", "d")]))[0].status).toBe("deleted");
    await vi.waitFor(() => expect(controller.designSession("d")).toBeUndefined());
    expect(controller.getSnapshot().layout.closed).toEqual([]);
    expect(controller.getRegistration()?.tabs.map(value => value.id)).toEqual(["b"]);
    // The adopted layout is current: the next action commits without a conflict.
    await controller.change({ type: "select", id: "b" });
    expect(db.layout().active).toBe("b");
  });

  it("keeps an open note busy, and forgets a deleted closed note and its recovery", async () => {
    const conversation = fresh(), db = store(conversation, { ...emptyWorkbench(), tabs: [tab("n", "markdown")], closed: [tab("m", "markdown")], visible: ["n"], active: "n" });
    db.notes.set("n", emptyMarkdown("n", "open")); db.notes.set("m", emptyMarkdown("m", "closed"));
    const controller = await open(db, conversation), key = noteRecoveryKey("device", db.scope, "m");
    await vi.waitFor(() => expect(controller.markdownSession("n")?.ownership).toBe("owned"));
    expect((await deleteWorkbenchLibraryEntries(db.connection, [db.item("markdown", "n")]))[0].status).toBe("busy");
    rememberNoteRecovery(key, { content: "stale", revision: 0 });
    expect((await deleteWorkbenchLibraryEntries(db.connection, [db.item("markdown", "m")]))[0].status).toBe("deleted");
    await vi.waitFor(() => expect(controller.getSnapshot().layout.closed).toEqual([]));
    expect(readNoteRecovery(key)).toBeUndefined();
    expect(controller.getSnapshot().notes.has("m")).toBe(false);
    expect([...db.notes.keys()]).toEqual(["n"]);
    expect(controller.markdownSession("n")?.readOnly).toBe(false);
  });
});

describe("opening a device-library item", () => {
  it("selects an open Tab, reopens a closed one and restores unreferenced content by its stable ID", async () => {
    const conversation = fresh(), db = store(conversation, { ...emptyWorkbench(), tabs: [tab("a", "whiteboard"), tab("c", "chart")], closed: [tab("n", "markdown")], visible: ["c"], active: "c" });
    db.boards.set("a", emptyBoard("a")); db.notes.set("n", emptyMarkdown("n")); db.designs.set("orphan", emptyDesign("orphan"));
    const controller = await open(db, conversation), at = (id: string, kind: WorkbenchItemKind, title = id) => ({ scope: db.scope, conversationId: conversation, id, kind, title });
    expect(await controller.openLibraryFile(at("a", "whiteboard"))).toBe("selected");
    expect(db.layout().active).toBe("a");
    expect(await controller.openLibraryFile(at("n", "markdown"), { assertActive: () => undefined })).toBe("reopened");
    expect(db.layout()).toMatchObject({ active: "n", closed: [] });
    expect(await controller.openLibraryFile(at("orphan", "design", "  Poster  "))).toBe("restored");
    expect(db.layout().tabs.find(value => value.id === "orphan")).toEqual({ id: "orphan", kind: "design", title: "Poster" });
  });

  it("restores a PPT project with its format rather than opening it as a canvas", async () => {
    const conversation = fresh(), db = store(conversation, emptyWorkbench());
    db.designs.set("slides", emptySlides("slides", "Recovered PPT"));
    const controller = await open(db, conversation);
    expect(await controller.openLibraryFile({scope:db.scope,conversationId:conversation,id:"slides",kind:"design"})).toBe("restored");
    expect(db.layout().tabs[0]).toMatchObject({id:"slides",kind:"design",designFormat:"slides",title:"PPT"});
  });

  it("rejects another scope, a wrong kind, missing content and a late open without writing", async () => {
    const conversation = fresh(), db = store(conversation, { ...emptyWorkbench(), tabs: [tab("a", "whiteboard")], closed: [tab("m", "markdown")], visible: ["a"], active: "a" });
    db.boards.set("a", emptyBoard("a"));
    const controller = await open(db, conversation), before = db.layout();
    const at = (id: string, kind: WorkbenchItemKind) => ({ scope: db.scope, conversationId: conversation, id, kind, title: id });
    await expect(controller.openLibraryFile({ ...at("a", "whiteboard"), scope: workbenchScope("host", "owner", "elsewhere") })).rejects.toThrow("workbench_scope_mismatch");
    await expect(controller.openLibraryFile({ ...at("a", "whiteboard"), conversationId: "elsewhere" })).rejects.toThrow("workbench_scope_mismatch");
    await expect(controller.openLibraryFile(at("a", "markdown"))).rejects.toThrow("workbench_wrong_kind");
    await expect(controller.openLibraryFile(at("m", "markdown"))).rejects.toThrow("markdown_not_found");
    await expect(controller.openLibraryFile(at("never", "design"))).rejects.toThrow("design_not_found");
    let active = true;
    const opening = controller.openLibraryFile(at("a", "whiteboard"), { assertActive: () => { if (!active) throw new Error("workbench_target_changed"); } });
    active = false;
    await expect(opening).rejects.toThrow("workbench_target_changed");
    expect(db.layout()).toEqual(before);
  });
});
