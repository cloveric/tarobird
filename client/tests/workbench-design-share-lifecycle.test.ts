import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchController } from "../src/workbench-controller.js";
import { DesignShareClient, designShareManager, existingDesignShareManager, type DesignShareTransport } from "../src/workbench-design-collaboration.js";
import { emptyDesign, type DesignDocument } from "../src/workbench-design.js";
import { emptyWorkbench, workbenchScope, type WorkbenchLayout } from "../src/workbench-model.js";
import type { HubConnection } from "../src/connection.js";
import type { DesignShareServerFrame } from "../../src/client-protocol/workbench-design-sharing.js";

// Opus CC1: the controller's share lifecycle hooks. A deleted design ends its
// share for everyone; a closed window only stops serving it. In-memory store in
// the style of workbench-retained-content; the share client is scripted.
const owners: WorkbenchController[] = [];
afterEach(() => { owners.forEach(owner => owner.dispose()); owners.length = 0; });
let sequence = 0;
const fresh = () => `share-life-${++sequence}`;
function store(conversation: string) {
  let layout: WorkbenchLayout = { ...emptyWorkbench(), tabs: [{ id: "d", kind: "design", title: "D" }], visible: ["d"], active: "d" };
  const designs = new Map<string, DesignDocument>([["d", emptyDesign("d")]]), changes = new Set<(ids: string[]) => void>();
  const commit = (expected: number, next: WorkbenchLayout) => { if (layout.revision !== expected) throw Error("workbench_revision_conflict"); layout = structuredClone(next); };
  const cache = {
    readWorkbench: async () => structuredClone(layout), saveWorkbench: async (_scope: string, expected: number, next: WorkbenchLayout) => commit(expected, next),
    readWorkbenchDesign: async (_scope: string, id: string) => structuredClone(designs.get(id)),
    saveWorkbenchDesign: async (_scope: string, expected: number, next: DesignDocument) => { if ((designs.get(next.id)?.revision ?? -1) !== expected) throw Error("design_revision_conflict"); designs.set(next.id, structuredClone(next)); },
    deleteWorkbenchDesignAndLayout: async (_scope: string, id: string, expected: number, expectedLayout: number, next: WorkbenchLayout) => { if (designs.get(id)?.revision !== expected) throw Error("design_revision_conflict"); commit(expectedLayout, next); designs.delete(id); },
    subscribeWorkbenchChanges: (_scope: string, listener: (ids: string[]) => void) => { changes.add(listener); return () => { changes.delete(listener); }; },
  };
  const connection = { identity: { deviceId: "device", hubPublicKey: "host" }, state: { status: "online", user: { id: "owner" }, workbenchDesignAvailable: true },
    isClosed: false, isReadOnly: false, cache, subscribe: () => () => undefined, conversationRevision: () => 0, http: vi.fn() } as unknown as HubConnection;
  /** Another window deleted the design: storage changed, then the broadcast. */
  const deletedElsewhere = () => { layout = { ...layout, revision: layout.revision + 1, tabs: [], visible: [], active: null }; designs.delete("d"); for (const listener of [...changes]) listener(["d"]); };
  return { connection, designs, deletedElsewhere, scope: workbenchScope("host", "owner", conversation) };
}
function scripted(conversationId: string, options: { failClose?: boolean; holdOpen?: Promise<void> } = {}) {
  const ops: string[] = []; let receive: (frame: DesignShareServerFrame) => void = () => {};
  const view = { shareId: `ds_${"b".repeat(24)}`, conversationId, designId: "d", format: "canvas", title: "D", generation: 1, ownerUserId: "owner", ownerName: "Owner", role: "owner", revision: 0, sourceOnline: true };
  const transport: DesignShareTransport = { onFrame: listener => { receive = listener; return () => {}; }, send: frame => {
    const op = frame.request.op; ops.push(op);
    const error = op === "close" && options.failClose ? "design_share_app_unavailable" : undefined;
    const answer = () => receive({ v: 1, type: "design.share.result", requestId: frame.requestId, ok: !error, ...(error ? { error } : { result: op === "open" || op === "attach" ? view : {} }) } as never);
    if (op === "open" && options.holdOpen) void options.holdOpen.then(answer); else queueMicrotask(answer);
  } };
  return { ops, client: new DesignShareClient(transport, 2_000) };
}
async function sharedDesign(options: { failClose?: boolean } = {}) {
  const conversation = fresh(), db = store(conversation);
  const controller = new WorkbenchController({ connection: db.connection, conversationId: conversation }); owners.push(controller);
  await controller.initialize(); controller.setVisible(true); await new Promise(resolve => setTimeout(resolve, 10));
  const session = controller.designSession("d")!, share = scripted(conversation, options), manager = designShareManager(db.connection, share.client);
  await manager.share(session, { conversationId: conversation, windowId: "w", title: "D" });
  return { db, controller, session, manager, ops: share.ops };
}

describe("Workbench controller ends or detaches Baoyu shares with the document", () => {
  it("deleting the design closes its share for everyone", async () => {
    const { controller, session, manager, ops, db } = await sharedDesign();
    await controller.deleteDesign("d");
    expect(db.designs.has("d")).toBe(false);
    await vi.waitFor(() => expect(ops).toContain("close"));
    expect(manager.sourceFor(session)).toBeUndefined(); expect(ops).not.toContain("detach");
  });
  it("a deletion from another window closes this window's share too", async () => {
    const { session, manager, ops, db } = await sharedDesign();
    db.deletedElsewhere();
    await vi.waitFor(() => expect(ops).toContain("close"));
    expect(manager.sourceFor(session)).toBeUndefined();
  });
  it("if the Host cannot be told, the deleted design at least stops being served from here", async () => {
    const { controller, session, manager, ops } = await sharedDesign({ failClose: true });
    await controller.deleteDesign("d");
    await vi.waitFor(() => expect(ops).toContain("detach"));
    expect(ops.indexOf("close")).toBeLessThan(ops.indexOf("detach")); expect(manager.sourceFor(session)).toBeUndefined();
  });
  it("closing the window only detaches: the share and its grants stay", async () => {
    const { controller, session, manager, ops } = await sharedDesign();
    controller.dispose();
    await vi.waitFor(() => expect(ops).toContain("detach"));
    expect(ops).not.toContain("close"); expect(manager.sourceFor(session)).toBeUndefined();
  });
  it("without any sharing on this connection the hooks create nothing", async () => {
    const conversation = fresh(), db = store(conversation);
    const controller = new WorkbenchController({ connection: db.connection, conversationId: conversation }); owners.push(controller);
    await controller.initialize(); controller.setVisible(true); await new Promise(resolve => setTimeout(resolve, 10));
    await controller.deleteDesign("d"); controller.dispose();
    expect(existingDesignShareManager(db.connection)).toBeUndefined();
  });
  it("closing the window while its first share open is still on the wire leaves no source behind", async () => {
    const conversation = fresh(), db = store(conversation);
    const controller = new WorkbenchController({ connection: db.connection, conversationId: conversation }); owners.push(controller);
    await controller.initialize(); controller.setVisible(true); await new Promise(resolve => setTimeout(resolve, 10));
    let release!: () => void; const holdOpen = new Promise<void>(resolve => { release = resolve; });
    const session = controller.designSession("d")!, share = scripted(conversation, { holdOpen }), manager = designShareManager(db.connection, share.client);
    const opening = manager.share(session, { conversationId: conversation, windowId: "w", title: "D" });
    await vi.waitFor(() => expect(share.ops).toContain("open"));
    controller.dispose(); release();
    await expect(opening).rejects.toThrow("design_share_source_stopped");
    expect(manager.sourceFor(session)).toBeUndefined(); expect(share.ops).toEqual(["open", "detach"]);
  });
});
