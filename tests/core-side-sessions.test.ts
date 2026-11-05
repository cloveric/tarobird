import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreSideSessions, SideSessionError } from "../src/core/side-sessions.js";
import type { EngineSideSession } from "../src/codex/adapter.js";
import { SIDE_ANSWER_LIMIT, SIDE_LEASE_MS, type SideView } from "../src/client-protocol/side.js";

const scope = { userId: "owner", deviceId: "desktop", conversationId: "main" };
const capability = { supported: true, concurrent: true, liveContext: false, tools: "read-only" as const };
const managers: CoreSideSessions[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.closeAll())); });
function fixture(send?: EngineSideSession["send"], extra: Partial<ConstructorParameters<typeof CoreSideSessions>[0]> = {}) {
  const handle: EngineSideSession = { nativeId: "temporary", send: vi.fn(send ?? (async ({ text }) => ({ text: `answer:${text}`, usage: { inputTokens: 5, outputTokens: 3 } }))), dispose: vi.fn(async () => {}) };
  const open = vi.fn(async () => handle), record = vi.fn(async () => {}), beforeAsk = vi.fn(async () => {});
  const manager = new CoreSideSessions({ open, record, beforeAsk, ...extra }); managers.push(manager);
  const start = async (requestId = "open") => { const result = manager.open(scope, requestId, capability); if (!result.ok || !result.view) throw new Error("open failed"); await vi.waitFor(() => expect(manager.read(scope, result.view!.id).view?.phase).toBe("idle")); return result.view.id; };
  const finished = async (id: string): Promise<SideView> => { await vi.waitFor(() => expect(manager.read(scope, id).view?.phase).toBe("idle")); return manager.read(scope, id).view!; };
  return { manager, handle, start, finished, open, record, beforeAsk };
}
describe("temporary side lifecycle", () => {
  it("binds negotiated delivery to one exchange, revokes it at turn end and leaves legacy sides unchanged", async () => {
    const publish: Array<(value: import("../src/client-protocol/side.js").SideDelivery) => void> = [];
    const tools = { definitions: [], instructions: "Files go to this side.", call: vi.fn(), register: async () => {}, isRegistered: async () => true };
    const f = fixture(async input => {
      if (input.appPlatformTools) publish.at(-1)!({ id: "out_one", attachments: [{ type: "image", attachmentId: "att_one", title: "image" }] });
      return { text: "answer" };
    }, { deliveryTools: (_scope, _side, _request, _signal, receiver) => { publish.push(receiver); return tools; } });
    const opened = f.manager.open(scope, "modern", { ...capability, tools: "inherited", delivery: true });
    if (!opened.ok || !opened.view) throw Error("open failed");
    const id = opened.view.id; await f.finished(id);
    f.manager.ask(scope, id, "one", "send image");
    const view = await f.finished(id);
    expect(view.exchanges[0]?.deliveries).toHaveLength(1);
    expect(f.handle.send).toHaveBeenCalledWith(expect.objectContaining({ appPlatformTools: tools }));
    expect(() => publish[0]!({ id: "late", attachments: [{ type: "image", attachmentId: "att_two", title: "late" }] })).toThrow();
    expect(() => f.manager.read({ ...scope, deviceId: "other" }, id)).toThrow("expired");
    await f.manager.close(scope, id);
    const legacy = await f.start("legacy"); f.manager.ask(scope, legacy, "two", "explain");
    expect((await f.finished(legacy)).exchanges[0]?.deliveries).toBeUndefined();
    expect(publish).toHaveLength(1);
  });
  it("keeps negotiated tool access on the handle and uses instructions that allow explicit side operations", async () => {
    const f = fixture();
    const opened = f.manager.open(scope, "tools", { ...capability, tools: "inherited" });
    if (!opened.ok || !opened.view) throw new Error("open failed");
    const id = opened.view.id;
    await f.finished(id);
    expect(f.open).toHaveBeenCalledWith(scope, expect.any(AbortSignal), "inherited");
    // A replay cannot change the permissions of an existing side.
    expect(f.manager.open(scope, "tools", capability)).toMatchObject({ view: { id, capability: { tools: "inherited" } } });
    f.manager.ask(scope, id, "one", "Read this website");
    await f.finished(id);
    expect(f.handle.send).toHaveBeenCalledWith(expect.objectContaining({ turnInstructions: expect.stringContaining("Use available search, network, browser, MCP and plugin tools") }));
    expect(f.handle.send).not.toHaveBeenCalledWith(expect.objectContaining({ turnInstructions: expect.stringContaining("Do not modify files") }));
  });
  it("answers multiple questions without rebinding and deduplicates uncertain sends", async () => {
    const f = fixture(), id = await f.start();
    f.manager.ask(scope, id, "one", "first"); f.manager.ask(scope, id, "one", "first");
    expect(() => f.manager.ask(scope, id, "one", "different")).toThrow("failed");
    await f.finished(id); f.manager.ask(scope, id, "two", "follow up");
    expect((await f.finished(id)).exchanges.map(row => row.answer)).toEqual(["answer:first", "answer:follow up"]);
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.handle.send).toHaveBeenCalledTimes(2); expect(f.record).toHaveBeenCalledTimes(2);
    expect(f.record).toHaveBeenLastCalledWith(scope, { inputTokens: 5, outputTokens: 3 }, "success");
    expect(f.manager.read(scope, id, f.manager.read(scope, id).revision).view).toBeUndefined();
    await f.manager.close(scope, id); expect(f.handle.dispose).toHaveBeenCalledTimes(1);
    expect(() => f.manager.read(scope, id)).toThrow("expired");
    expect(() => f.manager.open(scope, "open", capability)).toThrow("expired");
    expect((await f.finished(await f.start("new"))).exchanges).toEqual([]);
  });
  it("keeps device and conversation ownership independent even for the same user", async () => {
    const f = fixture(), id = await f.start();
    for (const other of [{ ...scope, deviceId: "phone" }, { ...scope, userId: "guest" }, { ...scope, conversationId: "other" }]) {
      expect(() => f.manager.read(other, id)).toThrow("expired");
      expect(() => f.manager.ask(other, id, "bad", "secret?")).toThrow("expired");
      await expect(f.manager.close(other, id)).rejects.toThrow("expired");
    }
    expect(f.handle.dispose).not.toHaveBeenCalled();
  });
  it("stops only the active side turn and allows another question", async () => {
    const f = fixture(async ({ text, abortSignal, onEngineEvent }) => {
      if (text === "slow") { await onEngineEvent({ type: "assistant_text", text: "partial", delta: true }); await new Promise<void>(resolve => abortSignal.addEventListener("abort", () => resolve(), { once: true })); abortSignal.throwIfAborted(); }
      return { text: "next answer" };
    });
    const id = await f.start(); f.manager.ask(scope, id, "one", "slow");
    await vi.waitFor(() => expect(f.manager.read(scope, id).view?.exchanges[0]?.answer).toBe("partial"));
    f.manager.stop(scope, id); expect((await f.finished(id)).exchanges[0]).toMatchObject({ status: "stopped", answer: "partial" });
    expect(f.handle.dispose).not.toHaveBeenCalled(); expect(f.record).toHaveBeenCalledWith(scope, undefined, "cancelled");
    f.manager.ask(scope, id, "two", "next"); expect((await f.finished(id)).exchanges[1]?.answer).toBe("next answer");
  });
  it("disposes late opens after closing and discards late streaming callbacks", async () => {
    let release!: (handle: EngineSideSession) => void;
    const f = fixture(undefined, { open: () => new Promise(resolve => { release = resolve; }) });
    const result = f.manager.open(scope, "open", capability); if (!result.ok || !result.view) throw new Error();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const closing = f.manager.close(scope, result.view.id); release(f.handle); await closing;
    await vi.waitFor(() => expect(f.handle.dispose).toHaveBeenCalledTimes(1));
    expect(() => f.manager.read(scope, result.view!.id)).toThrow("expired");
  });
  it("drains pending native opens before shutdown finishes", async () => {
    let release!: (handle: EngineSideSession) => void;
    const f = fixture(undefined, { open: () => new Promise(resolve => { release = resolve; }) });
    f.manager.open(scope, "open", capability);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    let closed = false;
    const shutdown = f.manager.closeAll().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    try { expect(closed).toBe(false); } finally { release(f.handle); }
    await shutdown;
    expect(f.handle.dispose).toHaveBeenCalledTimes(1);
  });
  it("waits for a previously closed handle's cleanup during shutdown", async () => {
    let release!: () => void;
    const f = fixture(), id = await f.start();
    f.handle.dispose = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const closing = f.manager.close(scope, id);
    let finished = false;
    const shutdown = f.manager.closeAll().then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    try { expect(finished).toBe(false); } finally { release(); }
    await closing; await shutdown;
    expect(f.handle.dispose).toHaveBeenCalledTimes(1);
  });
  it("does not confirm native cleanup when disposal fails", async () => {
    const f = fixture(), id = await f.start();
    f.handle.dispose = async () => { throw new Error("private native path"); };
    await expect(f.manager.close(scope, id)).resolves.toEqual({ ok: false, error: "failed" });
    expect(() => f.manager.read(scope, id)).toThrow("expired");
  });
  it("replaces an abandoned handle for the same owner and waits for its native cleanup", async () => {
    const f = fixture(), old = await f.start();
    let release!: () => void;
    f.handle.dispose = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      const reopened = f.manager.open(scope, "reopen", capability);
      if (!reopened.ok || !reopened.view) throw new Error();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(() => f.manager.read(scope, old)).toThrow("expired");
      expect(f.open).toHaveBeenCalledTimes(1);
      expect(f.manager.read(scope, reopened.view.id).view?.phase).toBe("preparing");
      release(); await f.finished(reopened.view.id); expect(f.open).toHaveBeenCalledTimes(2);
    } finally { release?.(); f.handle.dispose = vi.fn(async () => {}); }
  });
  it("serializes a new open behind an explicitly closed native open that finishes late", async () => {
    let release!: (handle: EngineSideSession) => void;
    const f = fixture();
    f.open.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.manager.open(scope, "first", capability);
    if (!first.ok || !first.view) throw new Error();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const closed = f.manager.close(scope, first.view.id), next = f.manager.open(scope, "next", capability);
    if (!next.ok || !next.view) throw new Error();
    try { expect(f.open).toHaveBeenCalledTimes(1); } finally { release(f.handle); }
    await closed; await f.finished(next.view.id);
    expect(f.open).toHaveBeenCalledTimes(2); expect(f.handle.dispose).toHaveBeenCalledTimes(1);
  });
  it("evicts closed open receipts instead of refusing new owners after many short-lived handles", async () => {
    const f = fixture();
    for (let i = 0; i < 1100; i++) {
      const owner = { ...scope, deviceId: `cli-${i % 3}` }, opened = f.manager.open(owner, `cycle-${i}`, capability);
      await f.manager.close(owner, opened.view!.id);
    }
    expect(f.manager.activeCount()).toBe(0);
    expect(f.manager.open({ ...scope, userId: "guest" }, "fresh", capability).ok).toBe(true);
    // Recent receipts still refuse to reopen their closed handle.
    expect(() => f.manager.open({ ...scope, deviceId: "cli-1" }, "cycle-1099", capability)).toThrow("expired");
  });
  it("replays a failed close receipt without falsely confirming native cleanup", async () => {
    const f = fixture(), id = await f.start();
    f.handle.dispose = vi.fn(async () => { throw new Error("native delete failed"); });
    expect(await f.manager.close(scope, id)).toEqual({ ok: false, error: "failed" });
    expect(await f.manager.close(scope, id)).toEqual({ ok: false, error: "failed" });
    await expect(f.manager.close({ ...scope, deviceId: "another_device" }, id)).rejects.toThrow("expired");
    expect(f.handle.dispose).toHaveBeenCalledTimes(1);
  });
  it("checks budget before model invocation and sanitizes private failure details", async () => {
    const f = fixture(undefined, { beforeAsk: async () => { throw new SideSessionError("budget_exhausted"); } }), id = await f.start();
    f.manager.ask(scope, id, "one", "question");
    expect((await f.finished(id)).exchanges[0]).toMatchObject({ status: "error", error: "budget_exhausted" });
    expect(f.handle.send).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
    const broken = fixture(async () => { throw new Error("secret /private/file token=123"); }), bid = await broken.start();
    broken.manager.ask(scope, bid, "one", "q");
    expect(JSON.stringify(await broken.finished(bid))).not.toContain("/private");
    expect(broken.record).toHaveBeenCalledWith(scope, undefined, "error");
  });
  it("expires abandoned handles and bounds retained answer bodies", async () => {
    let now = 1000;
    const f = fixture(async () => ({ text: "x".repeat(SIDE_ANSWER_LIMIT + 1) }), { now: () => now }), id = await f.start();
    for (let i = 0; i < 3; i++) { f.manager.ask(scope, id, `q${i}`, "question"); await f.finished(id); }
    const view = f.manager.read(scope, id).view!;
    expect(view.exchanges).toHaveLength(2); expect(view.omitted).toBe(1); expect(view.exchanges[0]).toMatchObject({ truncated: true });
    now += SIDE_LEASE_MS + 1; f.manager.sweep();
    expect(() => f.manager.read(scope, id)).toThrow("expired"); await vi.waitFor(() => expect(f.handle.dispose).toHaveBeenCalledTimes(1));
  });
});
