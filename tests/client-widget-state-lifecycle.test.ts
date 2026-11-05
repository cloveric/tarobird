import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WidgetStateSession, WIDGET_STATE_FLUSH_MS, discardWidgetStateOwner, flushWidgetStateOwner, hasWidgetStateSessions, restoredWidgetState, widgetStateFailed, widgetStateOwnerRetiring, subscribeWidgetStateOwners } from "../client/src/widget-state-lifecycle.js";
import { readWidgetState } from "../client/src/widget-state.js";

let serial = 0;
const owners: string[] = [];
let listener: ((event: { source: Window; data: unknown }) => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    addEventListener: (_: string, cb: typeof listener) => { listener = cb; },
    removeEventListener: (_: string, cb: typeof listener) => { if (listener === cb) listener = undefined; },
  });
});
afterEach(() => { owners.splice(0).forEach(discardWidgetStateOwner); vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture(owner = `owner-${++serial}`, scope = `scope-${serial}`) {
  owners.push(owner);
  const source = { postMessage: vi.fn() } as unknown as Window;
  const done = vi.fn(), key = `key-${serial}`, hash = "hash";
  const session = new WidgetStateSession({ owner, scope, hash, source, key, done });
  const emit = (data: Record<string, unknown>, other = source) => listener?.({ source: other, data: { key, ...data } });
  const ack = (state?: string, data: Record<string, unknown> = {}) => {
    const request = vi.mocked(source.postMessage).mock.calls.at(-1)?.[0] as { id: string };
    emit({ type: "tarobot-widget-state-flushed", id: request.id, ok: true, state, ...data });
  };
  return { owner, scope, hash, source, session, done, emit, ack };
}

it("commits the exact final state before resolving and never waits the timeout after ACK", async () => {
  const f = fixture(); f.session.markInitialized();
  f.emit({ type: "tarobot-widget-state", state: '{"range":10}' });
  const result = f.session.retire();
  expect(f.session.retire()).toBe(result); expect(f.source.postMessage).toHaveBeenCalledTimes(1);
  f.ack('{"range":9}');
  expect(await result).toBe("saved"); expect(readWidgetState(f.scope, f.hash)).toBe('{"range":9}');
  expect(f.done).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); expect(listener).toBeUndefined();
});

it("requires the exact source, key and request and isolates simultaneously mounted pane owners", async () => {
  const a = fixture(), b = fixture(); a.session.markInitialized(); b.session.markInitialized();
  const result = flushWidgetStateOwner(a.owner);
  expect(a.session.retiring).toBe(true); expect(b.session.retiring).toBe(false); expect(b.source.postMessage).not.toHaveBeenCalled();
  const id = (vi.mocked(a.source.postMessage).mock.calls[0]![0] as { id: string }).id;
  a.emit({ type: "tarobot-widget-state-flushed", id, ok: true, state: "1" }, b.source);
  a.ack("2", { key: "wrong" }); a.ack("3", { id: "stale" });
  expect(a.done).not.toHaveBeenCalled(); expect(readWidgetState(a.scope, a.hash)).toBeUndefined();
  a.ack("4"); expect(await result).toEqual(["saved"]); expect(hasWidgetStateSessions(b.owner)).toBe(true);
  b.emit({ type: "tarobot-widget-state", state: "5" }); expect(readWidgetState(b.scope, b.hash)).toBe("5");
});

it("times out visibly, preserves the last confirmed state and rejects late final writes", async () => {
  const f = fixture(); f.session.markInitialized(); f.emit({ type: "tarobot-widget-state", state: "10" });
  const result = f.session.retire(); await vi.advanceTimersByTimeAsync(WIDGET_STATE_FLUSH_MS);
  expect(await result).toBe("timeout"); expect(widgetStateFailed(f.scope, f.hash)).toBe(true);
  f.ack("9"); expect(readWidgetState(f.scope, f.hash)).toBe("10"); expect(f.done).toHaveBeenCalledOnce();
  // Reload with no explicit state must not silently clear the warning.
  const next = fixture(f.owner, f.scope); next.session.markInitialized(); const saved = next.session.retire(); next.ack();
  expect(await saved).toBe("saved"); expect(widgetStateFailed(f.scope, f.hash)).toBe(true);
  const fixed = fixture(f.owner, f.scope); fixed.emit({ type: "tarobot-widget-state", state: "8" });
  expect(widgetStateFailed(f.scope, f.hash)).toBe(false);
});

it("permission loss discards immediately with no late state or grace-period authority", async () => {
  const f = fixture(); f.session.markInitialized(); const result = f.session.retire();
  discardWidgetStateOwner(f.owner); expect(await result).toBe("discarded");
  f.ack("7"); expect(readWidgetState(f.scope, f.hash)).toBeUndefined(); expect(listener).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0); expect(widgetStateFailed(f.scope, f.hash)).toBe(false);
});

it("a quickly remounted copy waits for the old same-scope flush without waiting for another pane", async () => {
  const old = fixture(); old.session.markInitialized(); const retiring = old.session.retire();
  const self = fixture(old.owner, old.scope), other = fixture(); other.session.markInitialized();
  let loaded = false; const restored = restoredWidgetState(old.scope, old.hash, self.session).then(value => { loaded = true; return value; });
  await Promise.resolve(); expect(loaded).toBe(false); old.ack('{"tab":"plan"}');
  expect(await retiring).toBe("saved"); expect(await restored).toBe('{"tab":"plan"}');
  expect(other.source.postMessage).not.toHaveBeenCalled();
});

it("rejects invalid/oversized final snapshots without claiming they were saved", async () => {
  for (const value of ["{", "\"" + "中".repeat(6000) + "\"", "x".repeat(17000)]) {
    const f = fixture(); f.session.markInitialized(); const result = f.session.retire(); f.ack(value);
    expect(await result).toBe("invalid"); expect(widgetStateFailed(f.scope, f.hash)).toBe(true); expect(readWidgetState(f.scope, f.hash)).toBeUndefined();
  }
});

it("uninitialized frames and empty owners retire synchronously without timers or protocol messages", async () => {
  const f = fixture(); const result = f.session.retire(); expect(f.done).toHaveBeenCalledWith("saved");
  expect(await result).toBe("saved"); expect(await flushWidgetStateOwner("missing")).toEqual([]);
  expect(f.source.postMessage).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("keeps the entire owner retiring until the slowest component acknowledges", async () => {
  const a = fixture(), b = fixture(a.owner, a.scope + ":second"); a.session.markInitialized(); b.session.markInitialized();
  const pending = flushWidgetStateOwner(a.owner); expect(flushWidgetStateOwner(a.owner)).toBe(pending);
  expect(widgetStateOwnerRetiring(a.owner)).toBe(true);
  a.ack("1"); await Promise.resolve(); expect(widgetStateOwnerRetiring(a.owner)).toBe(true);
  expect(a.session.finished).toBe(true); expect(b.session.finished).toBe(false);
  b.ack("2"); expect(await pending).toEqual(["saved", "saved"]); expect(widgetStateOwnerRetiring(a.owner)).toBe(false);
});

it("runs the navigation continuation before notifying old widgets that an owner may restart", async () => {
  const f = fixture(); f.session.markInitialized(); let committed = false; const order: boolean[] = [];
  const unsubscribe = subscribeWidgetStateOwners(() => { if (!widgetStateOwnerRetiring(f.owner)) order.push(committed); });
  try {
    const pending = flushWidgetStateOwner(f.owner).then(() => { committed = true; }); f.ack();
    await pending; await vi.runAllTimersAsync(); expect(order).toEqual([true]);
  } finally { unsubscribe(); }
});

it("a throwing retire path cannot trap the owner or hide an unknown final state", async () => {
  const f = fixture(); f.session.markInitialized(); vi.spyOn(f.session, "retire").mockImplementation(() => { throw new Error("broken retire"); });
  expect(await flushWidgetStateOwner(f.owner)).toEqual(["invalid"]);
  expect(widgetStateOwnerRetiring(f.owner)).toBe(false); expect(f.session.finished).toBe(true);
  expect(widgetStateFailed(f.scope, f.hash)).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
