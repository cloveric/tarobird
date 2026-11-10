import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyMarkdown } from "../src/workbench-markdown.js";
import { WorkbenchController } from "../src/workbench-controller.js";
import { emptyWorkbench, emptyBoard, type WorkbenchLayout, type BoardDocument } from "../src/workbench-model.js";
import type { HubConnection } from "../src/connection.js";
import type { WorkbenchCommandFrame, WorkbenchRequest } from "../../src/client-protocol/workbench.js";
import { widgetBlock } from "../../src/client-protocol/widget.js";

const owners: WorkbenchController[] = [];
afterEach(() => { owners.forEach(owner => owner.dispose()); owners.length = 0; vi.unstubAllGlobals(); });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(layout: WorkbenchLayout = { ...emptyWorkbench(), tabs: [{ id: "a", kind: "browser", title: "A", url: "https://example.com" }, { id: "b", kind: "browser", title: "B", url: "https://example.org" }], visible: ["a", "b"], active: "a" }, conversationId = "conversation", nativeTabs: Record<string, unknown>[] = []) {
  const active = new Map<string, ReturnType<typeof gate<Record<string, unknown>>>>(), calls: Record<string, unknown>[] = [];
  let receive: ((event: unknown) => void) | undefined;
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("window", { tarobotDesktop: { version: 1, engine: "electron", platform: "darwin", openSocket: async () => undefined, on: (_name: string, listener: (event: unknown) => void) => { receive = listener; return () => undefined; },
    invoke: async (_command: string, args: Record<string, unknown>) => {
      calls.push(args);
      if (args.action === "capabilities") return { status: "ok", window: "window" };
      if (args.action === "list") return { status: "ok", tabs: nativeTabs };
      if (args.action === "observe") { const wait = gate<Record<string, unknown>>(); active.set(String(args.requestId), wait); return wait.promise; }
      if (args.action === "cancel") active.get(String(args.targetRequestId))?.resolve({ status: "unknown", error: "cancelled_after_dispatch" });
      return { status: "ok" };
    } } });
  let stored = structuredClone(layout), boardWrites = 0;
  const frames = new Map<string, WorkbenchCommandFrame>();
  const cache = {
    readWorkbench: async () => structuredClone(stored), saveWorkbench: async (_scope: string, expected: number, next: WorkbenchLayout) => { if (stored.revision !== expected) throw Error("workbench_revision_conflict"); stored = structuredClone(next); },
    readWorkbenchMarkdown: async (_scope: string, id: string) => emptyMarkdown(id, "Local note"),
    readWorkbenchBoard: vi.fn(async (_scope: string, _id: string): Promise<BoardDocument | undefined> => undefined),
    saveWorkbenchBoard: async () => { boardWrites++; },
    workbenchSourceMessage: async (id: string) => ({ id, conversationId: "conversation", authorId: "bot", authorType: "bot", version: 0, status: "complete", createdAt: 1, blocks: [widgetBlock({ title: id, summary: "fixture", report: { version: 1, columns: ["Value"], rows: [[1]] } })] }),
    conversation: async () => ({ id: "conversation", ownerId: "owner" }),
  };
  const connection = { identity: { deviceId: "device", hubPublicKey: "host" }, state: { status: "online", user: { id: "owner" } }, isClosed: false, isReadOnly: false, cache,
    subscribe: () => () => undefined, conversationRevision: () => 0,
    http: vi.fn(async (_route: string, options: RequestInit) => { const frame = frames.get(JSON.parse(String(options.body)).dispatchId)!; return { admitted: true, generation: frame.generation, target: frame.target }; }),
  } as unknown as HubConnection;
  const controller = new WorkbenchController({ connection, conversationId }); owners.push(controller); await controller.initialize(); controller.setVisible(true);
  const frame = (request: WorkbenchRequest, timeout = 5000): WorkbenchCommandFrame => {
    const value: WorkbenchCommandFrame = { v: 1, type: "workbench.command", dispatchId: `dispatch_${request.requestId}`, deadline: Date.now() + timeout, userId: "owner", conversationId: "conversation", generation: controller.getSnapshot().generation, request, target: request.target ?? { deviceId: "device", windowId: controller.getSnapshot().windowId } };
    frames.set(value.dispatchId, value); return value;
  };
  return { controller, connection, cache, calls, active, frame, emit: (event: unknown) => receive?.(event), stored: () => stored, boardWrites: () => boardWrites };
}

describe("workbench App command fencing", () => {
  it("starts the bounded visible-board reads together before opening a saved split", async () => {
    const f = await fixture(emptyWorkbench()); f.controller.dispose();
    const ids = ["one", "two", "three", "four"];
    vi.spyOn(f.cache, "readWorkbench").mockResolvedValue({ ...emptyWorkbench(), tabs: ids.map(id => ({ id, kind: "whiteboard" as const, title: id })), active: ids[0], visible: ids });
    const reads = new Map(ids.map(id => [id, gate<BoardDocument>()]));
    f.cache.readWorkbenchBoard.mockImplementation((_scope, id) => reads.get(id)!.promise);
    const controller = new WorkbenchController({ connection: f.connection, conversationId: "conversation" }); owners.push(controller);
    const opening = controller.initialize();
    try {
      await vi.waitFor(() => expect(f.cache.readWorkbenchBoard).toHaveBeenCalledTimes(4));
      expect(controller.getSnapshot().ready).toBe(false);
    } finally { for (const [id, read] of reads) read.resolve(emptyBoard(id)); await opening; }
    expect([...controller.getSnapshot().boards.keys()]).toEqual(ids);
    expect(controller.getSnapshot().ready).toBe(true);
  });

  it("coalesces overlapping board reads and keeps a newer local edit", async () => {
    const f = await fixture(emptyWorkbench()); f.controller.dispose();
    const layout = { ...emptyWorkbench(), tabs: [{ id: "board", kind: "whiteboard" as const, title: "Board" }], active: "board", visible: ["board"] };
    vi.spyOn(f.cache, "readWorkbench").mockResolvedValue(layout);
    f.cache.readWorkbenchBoard.mockResolvedValue(emptyBoard("board"));
    const controller = new WorkbenchController({ connection: f.connection, conversationId: "conversation" }); owners.push(controller);
    await controller.initialize(); controller.setVisible(false);
    await vi.waitFor(() => expect(controller.getSnapshot().boards.size).toBe(0));
    const read = gate<BoardDocument>(); f.cache.readWorkbenchBoard.mockClear().mockReturnValue(read.promise);
    // Reopen, close and reopen before IndexedDB returns. Both entrants need
    // the same read, while a restored newer editor must not be overwritten.
    for (let index = 0; index < 20; index++) { controller.setVisible(true); controller.setVisible(false); }
    controller.setVisible(true);
    const newer = { ...emptyBoard("board"), revision: 2 };
    controller.boardDocument(newer);
    read.resolve(emptyBoard("board"));
    await read.promise; await Promise.resolve();
    expect(controller.getSnapshot().boards.get("board")?.revision).toBe(2);
    expect(f.cache.readWorkbenchBoard).toHaveBeenCalledTimes(1);
  });

  it("does not restore deleted board bytes from an invalidated read", async () => {
    const f = await fixture(emptyWorkbench()); f.controller.dispose();
    const layout = { ...emptyWorkbench(), tabs: [{ id: "board", kind: "whiteboard" as const, title: "Board" }], active: "board", visible: ["board"] };
    const stored = vi.spyOn(f.cache, "readWorkbench").mockResolvedValue(layout);
    let deleted!: (ids: string[]) => void;
    Object.assign(f.cache, { subscribeWorkbenchChanges: (_scope: string, listener: (ids: string[]) => void) => { deleted = listener; return () => {}; } });
    f.cache.readWorkbenchBoard.mockResolvedValue(emptyBoard("board"));
    const controller = new WorkbenchController({ connection: f.connection, conversationId: "conversation" }); owners.push(controller);
    await controller.initialize(); controller.setVisible(false);
    await vi.waitFor(() => expect(controller.getSnapshot().boards.size).toBe(0));
    const read = gate<BoardDocument>(); f.cache.readWorkbenchBoard.mockReturnValueOnce(read.promise);
    controller.setVisible(true);
    stored.mockResolvedValue({ ...emptyWorkbench(), revision: 1 }); deleted(["board"]);
    await vi.waitFor(() => expect(controller.getSnapshot().layout.tabs).toEqual([]));
    read.resolve({ ...emptyBoard("board"), revision: 5 }); await read.promise; await Promise.resolve();
    expect(controller.getSnapshot().boards.size).toBe(0);
    expect(controller.boardSavedRevision("board")).toBeUndefined();
    // A new load with the same ID is independent of the cancelled flight.
    f.cache.readWorkbenchBoard.mockResolvedValue(emptyBoard("board"));
    vi.spyOn(f.cache, "saveWorkbench").mockResolvedValue(undefined);
    await controller.change({ type: "open", tab: layout.tabs[0] });
    expect(controller.getSnapshot().boards.get("board")?.revision).toBe(0);
  });

  it("discards a board load after its controller is disposed", async () => {
    const f = await fixture(emptyWorkbench());
    const read = gate<BoardDocument>(); f.cache.readWorkbenchBoard.mockReturnValue(read.promise);
    const opening = f.controller.change({ type: "open", tab: { id: "board", kind: "whiteboard", title: "Board" } });
    await vi.waitFor(() => expect(f.cache.readWorkbenchBoard).toHaveBeenCalledTimes(1));
    f.controller.dispose(); const refusal = expect(opening).rejects.toThrow("workbench_scope_unavailable");
    read.resolve(emptyBoard("board")); await refusal;
    expect(f.controller.getSnapshot().boards.size).toBe(0);
  });

  it("allows a new board read after a failed read, without crossing owners", async () => {
    const f = await fixture(emptyWorkbench()); f.controller.dispose();
    vi.spyOn(f.cache, "readWorkbench").mockResolvedValue({ ...emptyWorkbench(), tabs: [{ id: "board", kind: "whiteboard", title: "Board" }], active: "board", visible: ["board"] });
    f.cache.readWorkbenchBoard.mockResolvedValue(emptyBoard("board"));
    const controller = new WorkbenchController({ connection: f.connection, conversationId: "conversation" }); owners.push(controller);
    await controller.initialize(); controller.setVisible(false);
    await vi.waitFor(() => expect(controller.getSnapshot().boards.size).toBe(0));
    f.cache.readWorkbenchBoard.mockRejectedValueOnce(Error("read_failed")); controller.setVisible(true);
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe("read_failed"));
    controller.setVisible(false); controller.setVisible(true);
    await vi.waitFor(() => expect(controller.getSnapshot().boards.has("board")).toBe(true));
  });

  it("adopts the first layout when two same-conversation controllers initialize together", async () => {
    const f = await fixture(emptyWorkbench()); f.controller.dispose();
    let stored: WorkbenchLayout | undefined, writes = 0;
    vi.spyOn(f.cache, "readWorkbench").mockImplementation(async () => structuredClone(stored)!);
    vi.spyOn(f.cache, "saveWorkbench").mockImplementation(async (_scope, expected, next) => {
      if ((stored?.revision ?? -1) !== expected) throw Error("workbench_revision_conflict");
      writes++; stored = structuredClone(next);
    });
    const first = new WorkbenchController({ connection: f.connection, conversationId: "conversation" });
    const second = new WorkbenchController({ connection: f.connection, conversationId: "conversation" });
    owners.push(first, second);
    await Promise.all([first.initialize(), second.initialize()]);
    expect(writes).toBe(1); expect(first.getSnapshot().ready).toBe(true); expect(second.getSnapshot().ready).toBe(true);
    expect(first.getSnapshot().layout).toEqual(stored); expect(second.getSnapshot().layout).toEqual(stored);
  });
  it("does not hide a failed initial layout write as another window's commit", async () => {
    const f = await fixture(emptyWorkbench()); f.controller.dispose();
    vi.spyOn(f.cache, "readWorkbench").mockResolvedValue(undefined!);
    vi.spyOn(f.cache, "saveWorkbench").mockRejectedValue(Error("storage_write_failed"));
    const controller = new WorkbenchController({ connection: f.connection, conversationId: "conversation" }); owners.push(controller);
    await expect(controller.initialize()).rejects.toThrow("storage_write_failed");
    expect(controller.getSnapshot().ready).toBe(false);
  });
  it("closes stale browser metadata when native confirms the page is already absent, but honors other refusals", async () => {
    const f = await fixture();
    const command = vi.spyOn(f.controller.browser,"command");
    command.mockResolvedValueOnce({status:"failed",error:"beforeunload_prevented"});
    await expect(f.controller.closeTab("a")).rejects.toThrow("beforeunload_prevented");
    expect(f.stored().tabs.map(tab=>tab.id)).toEqual(["a","b"]);
    command.mockResolvedValueOnce({status:"failed",error:"tab_not_found"});
    await f.controller.closeTab("a"); expect(f.stored().tabs.map(tab=>tab.id)).toEqual(["b"]);
  });
  it("drops saved board data when an initialized workbench never becomes visible", async () => {
    const f = await fixture(); f.controller.dispose();
    vi.spyOn(f.cache,"readWorkbench").mockResolvedValue({...emptyWorkbench(),tabs:[{id:"board",kind:"whiteboard",title:"Board"}],active:"board",visible:["board"]});
    f.cache.readWorkbenchBoard.mockResolvedValue(emptyBoard("board"));
    const controller = new WorkbenchController({connection:f.connection,conversationId:"conversation"}); owners.push(controller);
    await controller.initialize(); controller.setVisible(false);
    await vi.waitFor(() => expect(controller.getSnapshot().boards.size).toBe(0));
    controller.setVisible(true);
    await vi.waitFor(() => expect(controller.getSnapshot().boards.has("board")).toBe(true));
  });
  it("bounds native page titles before saving a Bot-opened tab", async () => {
    const f = await fixture(), title = "Long page title ".repeat(40);
    vi.spyOn(f.controller.browser,"execute").mockResolvedValue({status:"ok",state:"live",title,url:"https://example.com"});
    expect(await f.controller.handleCommand(f.frame({requestId:"long-title",operation:"browser",payload:{action:"open",url:"https://example.com"}}))).toMatchObject({status:"success"});
    expect(f.stored().tabs.at(-1)?.title).toBe(title.trim().slice(0,128).trim());
  });
  it("does not restore a native page that was already closed during open", async () => {
    const f = await fixture();
    vi.spyOn(f.controller.browser,"execute").mockResolvedValue({status:"cancelled",state:"closed",error:"tab_closed"});
    expect(await f.controller.handleCommand(f.frame({requestId:"closed-open",operation:"browser",payload:{action:"open",url:"https://example.com"}}))).toMatchObject({status:"cancelled"});
    expect(f.stored().tabs.map(tab=>tab.id)).toEqual(["a","b"]);
  });
  it("keeps an already-created native page addressable after cancellation without selecting it", async () => {
    const f = await fixture(), opening = gate<any>();
    const native = f.controller.browser.command.bind(f.controller.browser);
    vi.spyOn(f.controller.browser, "command").mockImplementation((action, ...args) => action === "open" ? opening.promise : native(action, ...args));
    const frame = f.frame({requestId:"cancelled-open",operation:"browser",payload:{action:"open",url:"https://example.com/new"}});
    const pending = f.controller.handleCommand(frame);
    await vi.waitFor(() => expect(f.controller.browser.command).toHaveBeenCalledWith("open", expect.any(String), expect.anything(), "cancelled-open", "bot"));
    f.controller.cancel({v:1,type:"workbench.cancel",dispatchId:frame.dispatchId,reason:"workbench_cancelled"});
    opening.resolve({status:"unknown",state:"live",url:"https://example.com/new",title:"New page",error:"cancelled_after_dispatch"});
    expect(await pending).toMatchObject({status:"unknown"});
    expect(f.stored().tabs).toEqual(expect.arrayContaining([expect.objectContaining({kind:"browser",title:"New page"})]));
    expect(f.stored().active).toBe("a"); expect(f.stored().visible).toEqual(["a","b"]);
    expect(f.calls.filter(call => call.action === "navigate" || call.action === "close")).toEqual([]);
  });
  it("releases a note that finishes loading after its workbench was hidden", async () => {
    const f = await fixture(); f.controller.dispose();
    vi.spyOn(f.cache, "readWorkbench").mockResolvedValue({ ...emptyWorkbench(), tabs: [{id:"late_note",kind:"markdown",title:"Note.md"}], active:"late_note",visible:["late_note"] });
    const reading = gate<ReturnType<typeof emptyMarkdown>>();
    const read = vi.spyOn(f.cache,"readWorkbenchMarkdown").mockImplementation(() => reading.promise);
    const controller = new WorkbenchController({ connection: f.connection, conversationId: "conversation" }); owners.push(controller);
    await controller.initialize(); controller.setVisible(true);
    await vi.waitFor(() => expect(read).toHaveBeenCalled()); controller.setVisible(false);
    reading.resolve(emptyMarkdown("late_note", "Saved note"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.markdownSession("late_note")).toBeUndefined();
    expect(controller.getSnapshot().notes.size).toBe(0);
    controller.setVisible(true);
    await vi.waitFor(() => expect(controller.markdownSession("late_note")).toBeDefined());
  });
  it("releases listeners when initialization fails and allows a fresh owner to retry", async () => {
    const f = await fixture(); f.controller.dispose();
    const add = vi.fn(), remove = vi.fn();
    vi.stubGlobal("addEventListener", add); vi.stubGlobal("removeEventListener", remove);
    const controller = new WorkbenchController({ connection: f.connection, conversationId: "conversation" }); owners.push(controller);
    const stop = vi.fn(); vi.spyOn(controller.browser, "subscribe").mockResolvedValue(stop);
    vi.spyOn(controller.browser, "command").mockImplementation(async action => {
      if (action === "list") throw new Error("native_list_failed");
      return { status: "ok", window: "window" };
    });
    await expect(controller.initialize()).rejects.toThrow("native_list_failed");
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("beforeunload", add.mock.calls[0]![1]);
    controller.dispose(); expect(stop).toHaveBeenCalledOnce();
    const retry = new WorkbenchController({ connection: f.connection, conversationId: "conversation" }); owners.push(retry);
    await retry.initialize(); expect(retry.getSnapshot().ready).toBe(true);
  });
  it.each(["capabilities", "subscribe"])("does not acquire late native resources after disposal during %s", async stage => {
    const f = await fixture(); f.controller.dispose();
    const controller = new WorkbenchController({ connection: f.connection, conversationId: "conversation" }); owners.push(controller);
    const capability = gate<{ status: "ok"; window: string }>(), subscription = gate<() => void>(), stop = vi.fn();
    const command = vi.spyOn(controller.browser, "command").mockImplementation(async action => action === "capabilities"
      ? stage === "capabilities" ? capability.promise : { status: "ok", window: "window" }
      : { status: "ok", tabs: [] });
    const subscribe = vi.spyOn(controller.browser, "subscribe").mockImplementation(() => subscription.promise);
    const pending = controller.initialize(), rejected = expect(pending).rejects.toThrow("workbench_scope_unavailable");
    await vi.waitFor(() => expect(stage === "capabilities" ? command : subscribe).toHaveBeenCalled());
    controller.dispose(); capability.resolve({ status: "ok", window: "window" }); subscription.resolve(stop);
    await rejected;
    expect(command.mock.calls.map(call => call[0])).toEqual(["capabilities"]);
    if (stage === "subscribe") expect(stop).toHaveBeenCalledOnce(); else expect(subscribe).not.toHaveBeenCalled();
    expect(controller.getSnapshot().ready).toBe(false);
  });
  it("keeps independent conversation targets inside one native BrowserWindow", async () => {
    const first = await fixture(), second = new WorkbenchController({ connection: first.connection, conversationId: "other-conversation" }); owners.push(second); await second.initialize(); second.setVisible(true);
    expect(first.controller.getRegistration()?.windowId).not.toBe(second.getRegistration()?.windowId);
    expect(first.controller.getRegistration()?.conversationId).toBe("conversation");
    expect(second.getRegistration()?.conversationId).toBe("other-conversation");
  });
  it("does not collide native browser Tab IDs for equal request IDs in different conversations", async () => {
    const first = await fixture(); const a = await first.controller.openBrowser("https://example.com", "same-request");
    const second = await fixture(undefined, "other-conversation"); const b = await second.controller.openBrowser("https://example.com", "same-request");
    expect(a).not.toBe(b);
  });
  it("recovers orphan native tabs without replacing the active split and clears only recovered page errors", async () => {
    const f = await fixture(undefined, "conversation", [{ tab: "orphan", url: "https://example.com/popup", title: "Recovered", state: "live", navigation: 1, crashed: false }]);
    expect(f.controller.getSnapshot().layout.tabs.map(tab => tab.id)).toContain("orphan");
    expect(f.controller.getSnapshot().layout.visible).toEqual(["a", "b"]); expect(f.controller.getSnapshot().layout.active).toBe("a");
    expect(f.stored().tabs.map(tab => tab.id)).toContain("orphan");
    f.emit({ kind: "opened", tab: "orphan", opener: "a", url: "https://example.com/popup" });
    expect(f.controller.getSnapshot().layout.active).toBe("a");
    f.emit({ kind: "control", tab: "a", control: "user" }); f.emit({ kind: "gone", tab: "a", reason: "unresponsive" });
    expect(f.controller.getSnapshot().browserTabs.get("a")?.error).toBe("unresponsive");
    f.emit({ kind: "state", tab: "a", responsive: true });
    expect(f.controller.getSnapshot().browserTabs.get("a")).toMatchObject({ takeover: true, error: undefined });
    f.emit({ kind: "blocked", tab: "a", what: "permission", reason: "permission" });
    expect(f.controller.getSnapshot().browserTabs.get("a")?.notice).toBeUndefined();
    f.emit({ kind: "blocked", tab: "a", what: "navigation", reason: "unsupported_scheme" });
    expect(f.controller.getSnapshot().browserTabs.get("a")?.notice).toBe("unsupported_scheme");
    f.emit({ kind: "state", tab: "a", loading: false, crashed: false, navigation: 2 });
    expect(f.controller.getSnapshot().browserTabs.get("a")).toMatchObject({ takeover: true, notice: undefined });
  });
  it("ignores foreign cancellation and stops only the exact matching native request", async () => {
    const f = await fixture(), a = f.frame({ requestId: "read_a", operation: "browser", target: { deviceId: "device", windowId: f.controller.getSnapshot().windowId, tabId: "a" }, payload: { action: "observe" } }), b = f.frame({ requestId: "read_b", operation: "browser", target: { deviceId: "device", windowId: f.controller.getSnapshot().windowId, tabId: "b" }, payload: { action: "observe" } });
    const first = f.controller.handleCommand(a), second = f.controller.handleCommand(b);
    await vi.waitFor(() => expect(f.active.size).toBe(2));
    f.controller.cancel({ v: 1, type: "workbench.cancel", dispatchId: "another_window", reason: "cancelled" });
    expect(f.calls.filter(call => call.action === "cancel")).toHaveLength(0);
    f.controller.cancel({ v: 1, type: "workbench.cancel", dispatchId: a.dispatchId, reason: "cancelled" });
    expect(f.calls.filter(call => call.action === "cancel")).toEqual([expect.objectContaining({ tab: "a", targetRequestId: "read_a" })]);
    expect(await first).toMatchObject({ status: "unknown", target: { tabId: "a" } });
    f.active.get("read_b")!.resolve({ status: "ok", observation: { text: "B is still running" } }); expect(await second).toMatchObject({ status: "success", target: { tabId: "b" } });
  });
  it("rechecks cancellation after queued preparation and writes no newly created board", async () => {
    const f = await fixture(), reading = gate<BoardDocument | undefined>(); f.cache.readWorkbenchBoard.mockImplementation(() => reading.promise);
    const frame = f.frame({ requestId: "create_cancel", operation: "whiteboard.create", payload: { title: "Never saved" } });
    const outcome = f.controller.handleCommand(frame);
    await vi.waitFor(() => expect(f.cache.readWorkbenchBoard).toHaveBeenCalled());
    f.controller.cancel({ v: 1, type: "workbench.cancel", dispatchId: frame.dispatchId, reason: "cancelled" }); reading.resolve(undefined);
    expect((await outcome).status).not.toBe("applied"); expect(f.boardWrites()).toBe(0); expect(f.stored().tabs.map(tab => tab.title)).toEqual(["A", "B"]);
  });
  it("distinguishes native preflight rejection, explicit navigation failure and oversized results", async () => {
    const f = await fixture(), target = { deviceId: "device", windowId: f.controller.getSnapshot().windowId, tabId: "a" };
    const invoke = vi.spyOn(window.tarobotDesktop!, "invoke");
    invoke.mockRejectedValueOnce(new Error("invalid_browser_args"));
    expect(await f.controller.handleCommand(f.frame({ requestId: "preflight", operation: "browser", target, payload: { action: "navigate", url: "https://example.com" } }))).toMatchObject({ status: "not_executed", error: "invalid_browser_args" });
    invoke.mockRejectedValueOnce(new Error("invalid_browser_args"));
    expect(await f.controller.handleCommand(f.frame({ requestId: "open-rejected", operation: "browser", payload: { action: "open", url: "https://example.com" } }))).toMatchObject({ status: "not_executed" });
    expect(f.controller.getSnapshot().layout.tabs).toHaveLength(2);
    invoke.mockResolvedValueOnce({ status: "failed", error: "navigation_failed", url: "https://example.com", navigation: 2 });
    expect(await f.controller.handleCommand(f.frame({ requestId: "navigation", operation: "browser", target, payload: { action: "navigate", url: "https://example.com" } }))).toMatchObject({ status: "failed", error: "navigation_failed", result: { navigation: 2 } });
    invoke.mockResolvedValueOnce({ status: "ok", observation: { text: "x".repeat(600 * 1024) } });
    expect(await f.controller.handleCommand(f.frame({ requestId: "oversized", operation: "browser", target, payload: { action: "observe" } }))).toMatchObject({ status: "failed", error: "workbench_result_too_large", result: { nativeStatus: "ok" } });
    invoke.mockRejectedValueOnce(new Error("IPC connection lost"));
    expect(await f.controller.handleCommand(f.frame({ requestId: "lost", operation: "browser", target, payload: { action: "navigate", url: "https://example.com" } }))).toMatchObject({ status: "unknown" });
  });
  it("restores the prior chart reference when the replacement never renders", async () => {
    const source = { messageId: "old", blockIndex: 0, version: 0 };
    const f = await fixture({ ...emptyWorkbench(), tabs: [{ id: "chart", kind: "chart", title: "Chart", source }], visible: ["chart"], active: "chart" });
    const frame = f.frame({ requestId: "bad_chart", operation: "chart.update", target: { deviceId: "device", windowId: f.controller.getSnapshot().windowId, tabId: "chart" }, payload: { source: { ...source, messageId: "new" }, previousSource: source } }, 150);
    const outcome = await f.controller.handleCommand(frame);
    expect(outcome.status).not.toBe("applied"); expect(f.stored().tabs[0].source).toEqual(source); expect(f.controller.getSnapshot().layout.tabs[0].source).toEqual(source);
    expect(f.controller.getRegistration()?.tabs[0].source).toEqual(source);
  });
  it("keeps markdown local on older Hosts while retaining other registrations", async () => {
    vi.stubGlobal("navigator", {});
    const f = await fixture({ ...emptyWorkbench(), tabs: [{ id: "note", kind: "markdown", title: "Note" }, { id: "browser", kind: "browser", title: "Page", url: "https://example.com" }], visible: ["note"], active: "note" });
    const old = f.controller.getRegistration()!;
    expect(old.capabilities).not.toContain("markdown.v1"); expect(old.tabs.map(tab => tab.id)).toEqual(["browser"]);
    expect(old.activeTabId).toBeUndefined(); expect(await f.controller.context()).toBeUndefined();
    f.connection.state.workbenchMarkdownAvailable = true;
    const updated = f.controller.getRegistration()!;
    expect(updated.capabilities).toContain("markdown.v1"); expect(updated.tabs.map(tab => tab.id)).toContain("note");
  });

  it("keeps chat send usable when the active note cannot be saved", async () => {
    vi.stubGlobal("navigator", {});
    const f = await fixture({ ...emptyWorkbench(), tabs: [{ id: "note", kind: "markdown", title: "Note" }], visible: ["note"], active: "note" });
    f.connection.state.workbenchMarkdownAvailable = true;
    await vi.waitFor(() => expect(f.controller.markdownSession("note")).toBeDefined());
    const note = f.controller.markdownSession("note")!; note.setWritable(true); note.local("unsaved");
    expect(await f.controller.context()).toBeUndefined(); expect(f.controller.getSnapshot().error).toBe("markdown_context_not_saved"); expect(note.text()).toBe("unsaved");
  });

});
