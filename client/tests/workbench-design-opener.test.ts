import { describe, expect, it, vi } from "vitest";
import { WorkbenchDesignOpener } from "../src/workbench-design-opener.js";
import type { HubConnection } from "../src/connection.js";
import type { WorkbenchCommandFrame, WorkbenchRegistration } from "../../src/client-protocol/workbench.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const sent: any[] = [], changes = new Set<() => void>(), commands = new Set<(frame: any) => void>();
  const registrations = new Map<string, WorkbenchRegistration>();
  let eligible = true, gate: Promise<unknown> | undefined, targetsGate: Promise<unknown> | undefined, failTargets = false;
  const state = { status: "online", user: { id: "owner" }, workbenchDesignOpenAvailable: true, workbenchSlidesAvailable: true };
  const connection = {
    state, identity: { deviceId: "phone", hubPublicKey: "host" }, sessionEpoch: 1, isClosed: false, isReadOnly: false,
    cache: { readWorkbench: vi.fn(() => { throw new Error("Must stay lazy"); }) },
    subscribe: (fn: () => void) => { changes.add(fn); return () => changes.delete(fn); },
    subscribeWorkbench: (fn: (frame: any) => void) => { commands.add(fn); return () => commands.delete(fn); },
    send: vi.fn(async (frame: any) => {
      sent.push(frame);
      if (frame.type === "workbench.register") registrations.set(frame.registration.windowId, frame.registration);
      if (frame.type === "workbench.unregister") registrations.delete(frame.windowId);
    }),
    http: vi.fn(async (url: string, options?: any) => {
      if (url.endsWith("/targets")) {
        await targetsGate;
        if (failTargets) throw new Error("targets_unavailable");
        return [...registrations.values()].map(value => ({ ...value, deviceId: "phone" }));
      }
      if (url === "/api/workbench/admit") {
        await gate;
        const id = JSON.parse(options.body).dispatchId, frame = issued.get(id)!;
        return { admitted: true, generation: frame.generation, target: frame.target };
      }
      throw new Error("Unexpected request");
    }),
  };
  const issued = new Map<string, WorkbenchCommandFrame>();
  const real: WorkbenchRegistration = { conversationId: "chat", windowId: "real", generation: "real_generation", visible: true,
    capabilities: ["design.slides.v1"], tabs: [{ id: "design", kind: "design", designFormat: "slides", title: "PPT", revision: 3 }], activeTabId: "design" };
  const open = vi.fn(async (_id: string, check: () => void) => {
    check(); return { registration: real, target: { deviceId: "phone", windowId: "real", tabId: "design" }, revision: 3, created: false };
  });
  const endpoint = new WorkbenchDesignOpener(connection as unknown as HubConnection, "chat", { eligible: () => eligible, open });
  const frame = (id: string, overrides: Partial<WorkbenchCommandFrame> = {}): WorkbenchCommandFrame => ({ v: 1, type: "workbench.command", dispatchId: id, deadline: Date.now() + 10000,
    userId: "owner", conversationId: "chat", generation: endpoint.generation, target: { deviceId: "phone", windowId: endpoint.windowId },
    request: { requestId: id, operation: "design.open", payload: { format: "slides" } }, ...overrides });
  const emit = (value: any) => { if (value.type === "workbench.command") issued.set(value.dispatchId, value); for (const listener of commands) listener(value); };
  const emitChange = () => { for (const listener of changes) listener(); };
  const receipt = (id: string) => sent.find(value => value.type === "workbench.receipt" && value.dispatchId === id)?.receipt;
  return { connection, endpoint, frame, emit, emitChange, receipt, open, sent, real,
    gate: (value: Promise<unknown>) => { gate = value; },
    targetsGate: (value: Promise<unknown> | undefined) => { targetsGate = value; },
    setFailTargets: (value: boolean) => { failTargets = value; },
    leave: () => { eligible = false; } };
}

describe("the lightweight Design opener", () => {
  it("registers without loading files; confirms only once per connection and preserves a real context", async () => {
    const f = fixture();
    try {
      const first = await f.endpoint.context();
      expect(first).toEqual({ target: { deviceId: "phone", windowId: f.endpoint.windowId }, openTarget: { deviceId: "phone", windowId: f.endpoint.windowId } });
      const real = { target: { deviceId: "phone", windowId: "real", tabId: "design" }, kind: "design" as const, revision: 3 };
      expect(await f.endpoint.context(real)).toMatchObject({ ...real, openTarget: first!.openTarget });
      expect(f.connection.http).toHaveBeenCalledTimes(1);
      expect(f.connection.cache.readWorkbench).not.toHaveBeenCalled();
    } finally { f.endpoint.dispose(); }
  });
  it("admits once and publishes the real target before the saved receipt", async () => {
    const f = fixture();
    try {
      await f.endpoint.context(); const frame = f.frame("open"); f.emit(frame); f.emit(frame);
      await vi.waitFor(() => expect(f.receipt("open")).toMatchObject({ status: "applied", saved: true, revision: 3, result: { target: { windowId: "real", tabId: "design" }, created: false } }));
      expect(f.open).toHaveBeenCalledTimes(1);
      expect(f.sent.findIndex(value => value.type === "workbench.register" && value.registration.windowId === "real"))
        .toBeLessThan(f.sent.findIndex(value => value.type === "workbench.receipt"));
    } finally { f.endpoint.dispose(); }
  });
  it.each([{ userId: "other" }, { conversationId: "other" }, { generation: "old" }, { target: { deviceId: "other", windowId: "placeholder" } }])("refuses stale or wrong identity %j", async override => {
    const f = fixture();
    try {
      const target = "target" in override ? { ...override.target, windowId: f.endpoint.windowId } : undefined;
      f.emit(f.frame("wrong", { ...override, ...(target ? { target } : {}) }));
      await vi.waitFor(() => expect(f.receipt("wrong")).toMatchObject({ status: "not_executed", error: "workbench_target_mismatch" }));
      expect(f.open).not.toHaveBeenCalled();
    } finally { f.endpoint.dispose(); }
  });
  it("does not open after cancellation while admission is pending", async () => {
    const f = fixture(), gate = deferred(); f.gate(gate.promise);
    try {
      f.emit(f.frame("cancel"));
      await vi.waitFor(() => expect(f.connection.http).toHaveBeenCalledWith("/api/workbench/admit", expect.anything()));
      f.emit({ v: 1, type: "workbench.cancel", dispatchId: "cancel", reason: "turn_ended" }); gate.resolve();
      await vi.waitFor(() => expect(f.receipt("cancel")).toMatchObject({ status: "not_executed" }));
      expect(f.open).not.toHaveBeenCalled();
    } finally { gate.resolve(); f.endpoint.dispose(); }
  });
  it("late initialization cannot publish success after navigation or disposal", async () => {
    const f = fixture(), gate = deferred();
    f.open.mockImplementationOnce(async (_id, check) => { await gate.promise; check(); return { registration: f.real, target: { deviceId: "phone", windowId: "real", tabId: "design" }, revision: 3, created: false }; });
    f.emit(f.frame("late")); await vi.waitFor(() => expect(f.open).toHaveBeenCalled());
    f.leave(); f.endpoint.dispose(); gate.resolve();
    await vi.waitFor(() => expect(f.receipt("late")).toMatchObject({ status: "unknown" }));
    expect(f.sent.some(value => value.type === "workbench.register" && value.registration.windowId === "real")).toBe(false);
  });
  it("cancelling a stalled initializer releases the queue without waiting for its late result", async () => {
    const f = fixture(), gate = deferred();
    f.open.mockImplementationOnce(async (_id, check) => { await gate.promise; check(); return { registration: f.real, target: { deviceId: "phone", windowId: "real", tabId: "design" }, revision: 3, created: false }; });
    try {
      f.emit(f.frame("stalled")); await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(1));
      f.emit({ v: 1, type: "workbench.cancel", dispatchId: "stalled", reason: "turn_ended" });
      await vi.waitFor(() => expect(f.receipt("stalled")).toMatchObject({ status: "unknown" }));
      f.emit(f.frame("next"));
      await vi.waitFor(() => expect(f.receipt("next")).toMatchObject({ status: "applied" }));
      gate.resolve(); await Promise.resolve();
      expect(f.sent.filter(value => value.type === "workbench.receipt" && value.dispatchId === "stalled")).toHaveLength(1);
    } finally { gate.resolve(); f.endpoint.dispose(); }
  });
  it("unsupported hosts never receive the new registration or context", async () => {
    const f = fixture(); f.endpoint.dispose(); f.connection.state.workbenchDesignOpenAvailable = false; f.sent.length = 0;
    const endpoint = new WorkbenchDesignOpener(f.connection as unknown as HubConnection, "chat", { eligible: () => true, open: f.open });
    try { expect(await endpoint.context()).toBeUndefined(); expect(f.sent).toHaveLength(0); }
    finally { endpoint.dispose(); }
  });
  it("hosts without workbenchSlidesAvailable never register an opener or freeze openTarget", async () => {
    const f = fixture(); f.endpoint.dispose();
    f.connection.state.workbenchDesignOpenAvailable = true;
    f.connection.state.workbenchSlidesAvailable = false;
    f.sent.length = 0; f.connection.http.mockClear();
    const endpoint = new WorkbenchDesignOpener(f.connection as unknown as HubConnection, "chat", { eligible: () => true, open: f.open });
    try {
      expect(await endpoint.context()).toBeUndefined();
      expect(f.sent).toHaveLength(0);
      expect(f.connection.http).not.toHaveBeenCalled();
    } finally { endpoint.dispose(); }
  });
  it("a retired opener cannot be reused by another chat view", async () => {
    const f = fixture(); const old = f.frame("old"); f.endpoint.dispose();
    const endpoint = new WorkbenchDesignOpener(f.connection as unknown as HubConnection, "chat", { eligible: () => true, open: f.open });
    try { expect(endpoint.windowId).not.toBe(old.target.windowId); f.emit(old); await Promise.resolve(); expect(f.open).not.toHaveBeenCalled(); }
    finally { endpoint.dispose(); }
  });
  it("contextSnapshot never blocks on pending registration and attaches openTarget immediately once confirmed", async () => {
    const pendingTargets = deferred();
    const f = fixture();
    f.targetsGate(pendingTargets.promise);
    f.endpoint.dispose();
    f.sent.length = 0;
    f.connection.http.mockClear();
    const endpoint = new WorkbenchDesignOpener(f.connection as unknown as HubConnection, "chat", { eligible: () => true, open: f.open });
    const existing = { target: { deviceId: "phone", windowId: "real", tabId: "design" }, kind: "design" as const, revision: 3 };
    try {
      expect(endpoint.contextSnapshot()).toBeUndefined();
      expect(endpoint.contextSnapshot(existing)).toEqual(existing);
      // Repeated snapshot calls while registration is in flight do not start duplicate registrations.
      expect(f.sent.filter(value => value.type === "workbench.register")).toHaveLength(1);
      pendingTargets.resolve();
      await vi.waitFor(() => expect(endpoint.contextSnapshot()).toEqual({
        target: { deviceId: "phone", windowId: endpoint.windowId },
        openTarget: { deviceId: "phone", windowId: endpoint.windowId },
      }));
      expect(endpoint.contextSnapshot(existing)).toMatchObject({ ...existing, openTarget: { deviceId: "phone", windowId: endpoint.windowId } });
      expect(f.connection.http).toHaveBeenCalledTimes(1);
    } finally { pendingTargets.resolve(); endpoint.dispose(); }
  });
  it("contextSnapshot retries failed background registration without stalling and respects epoch and revoke resets", async () => {
    const f = fixture();
    f.setFailTargets(true);
    try {
      await vi.waitFor(() => expect(f.connection.http).toHaveBeenCalledTimes(1));
      // Failed background registration clears cleanly; next snapshot kicks off a retry without blocking.
      expect(f.endpoint.contextSnapshot()).toBeUndefined();
      f.setFailTargets(false);
      await vi.waitFor(() => expect(f.endpoint.contextSnapshot()).toMatchObject({
        openTarget: { deviceId: "phone", windowId: f.endpoint.windowId },
      }));

      // Reconnect (sessionEpoch bump) resets confirmation and starts background registration for the new epoch.
      const epoch2Gate = deferred();
      f.targetsGate(epoch2Gate.promise);
      f.connection.sessionEpoch = 2;
      f.emitChange();
      expect(f.endpoint.contextSnapshot()).toBeUndefined();
      epoch2Gate.resolve();
      await vi.waitFor(() => expect(f.endpoint.contextSnapshot()).toMatchObject({
        openTarget: { deviceId: "phone", windowId: f.endpoint.windowId },
      }));

      // Revoke/dispose immediately withdraws the opener without blocking or re-registering.
      const existing = { target: { deviceId: "phone", windowId: "real", tabId: "design" }, kind: "design" as const, revision: 3 };
      f.endpoint.dispose();
      expect(f.endpoint.contextSnapshot()).toBeUndefined();
      expect(f.endpoint.contextSnapshot(existing)).toEqual(existing);
    } finally { f.endpoint.dispose(); }
  });
  it("contextSnapshot omits openTarget while /targets retries after a WS-vs-HTTP race, then attaches once confirmed", async () => {
    const f = fixture();
    f.endpoint.dispose();
    f.sent.length = 0;
    f.connection.http.mockClear();
    let targetPolls = 0;
    const secondPollGate = deferred();
    const originalHttp = f.connection.http.getMockImplementation()!;
    f.connection.http.mockImplementation(async (url: string, options?: any) => {
      if (url.endsWith("/targets")) {
        targetPolls++;
        if (targetPolls === 1) return [];
        await secondPollGate.promise;
      }
      return originalHttp(url, options);
    });
    const endpoint = new WorkbenchDesignOpener(f.connection as unknown as HubConnection, "chat", { eligible: () => true, open: f.open });
    try {
      await vi.waitFor(() => expect(targetPolls).toBe(2));
      expect(endpoint.contextSnapshot()).toBeUndefined();
      expect(f.sent.filter(value => value.type === "workbench.register")).toHaveLength(1);
      secondPollGate.resolve();
      await vi.waitFor(() => expect(endpoint.contextSnapshot()).toEqual({
        target: { deviceId: "phone", windowId: endpoint.windowId },
        openTarget: { deviceId: "phone", windowId: endpoint.windowId },
      }));
    } finally { secondPollGate.resolve(); endpoint.dispose(); }
  });
});
