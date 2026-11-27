import { afterEach, describe, expect, it, vi } from "vitest";
import { addGlobalListener, getGlobalListenerStats, subscribeMediaQuery } from "../src/global-event-hub.js";

function createFakeTarget() {
  const native = new Map<string, Set<EventListener>>();
  const attachments: Array<{ type: string; options?: boolean | AddEventListenerOptions }> = [];
  const detachments: Array<{ type: string; options?: boolean | EventListenerOptions }> = [];
  return {
    native,
    attachments,
    detachments,
    addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) {
      attachments.push({ type, options });
      const capture = typeof options === "boolean" ? options : !!options?.capture;
      const key = `${type}:${capture ? "1" : "0"}`;
      let set = native.get(key);
      if (!set) native.set(key, set = new Set());
      set.add(listener);
    },
    removeEventListener(type: string, listener: EventListener, options?: boolean | EventListenerOptions) {
      detachments.push({ type, options });
      const capture = typeof options === "boolean" ? options : !!options?.capture;
      const key = `${type}:${capture ? "1" : "0"}`;
      native.get(key)?.delete(listener);
    },
    dispatch(type: string, capture: boolean, event: Event) {
      const key = `${type}:${capture ? "1" : "0"}`;
      for (const listener of [...(native.get(key) ?? [])]) listener(event);
    },
  };
}

describe("global-event-hub", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pools multiple subscribers into one native listener and detaches when empty", () => {
    const fake = createFakeTarget();
    const target = fake as unknown as Document;
    const calls: string[] = [];

    const offA = addGlobalListener(target, "keydown", () => calls.push("a"), { capture: true });
    const offB = addGlobalListener(target, "keydown", () => calls.push("b"), { capture: true });
    const offC = addGlobalListener(target, "keydown", () => calls.push("c"), { capture: true, first: true });

    expect(fake.native.get("keydown:1")?.size).toBe(1);
    expect(getGlobalListenerStats(target)).toEqual({
      nativeCount: 1,
      subscriberCount: 3,
      byKey: { "keydown:1": 3 },
    });

    const event = { type: "keydown", stopImmediatePropagation() {} } as unknown as KeyboardEvent;
    fake.dispatch("keydown", true, event);
    expect(calls).toEqual(["c", "a", "b"]);

    offA();
    offB();
    expect(fake.native.get("keydown:1")?.size).toBe(1);
    offC();
    expect(fake.native.get("keydown:1")?.size).toBe(0);
    expect(getGlobalListenerStats(target)).toEqual({
      nativeCount: 0,
      subscriberCount: 0,
      byKey: {},
    });
  });

  it("honors stopImmediatePropagation and isolates subscriber errors", () => {
    const fake = createFakeTarget();
    const target = fake as unknown as Document;
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (err: unknown) => reported.push(err));

    const seen: string[] = [];
    const off1 = addGlobalListener(target, "pointerdown", () => {
      seen.push("1");
      throw new Error("boom");
    }, { capture: true });
    const off2 = addGlobalListener(target, "pointerdown", (e) => {
      seen.push("2");
      e.stopImmediatePropagation();
    }, { capture: true });
    const off3 = addGlobalListener(target, "pointerdown", () => {
      seen.push("3");
    }, { capture: true });

    const nativeStop = vi.fn();
    const event = { type: "pointerdown", stopImmediatePropagation: nativeStop } as unknown as PointerEvent;
    fake.dispatch("pointerdown", true, event);

    expect(seen).toEqual(["1", "2"]);
    expect(reported).toHaveLength(1);
    expect(nativeStop).toHaveBeenCalledOnce();

    off1();
    off2();
    off3();
  });

  it("shares one MediaQueryList listener per query across subscribers", () => {
    const mqlListeners = new Set<() => void>();
    const matchMediaMock = vi.fn(() => ({
      matches: false,
      addEventListener: (_: string, fn: () => void) => mqlListeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => mqlListeners.delete(fn),
    }));
    vi.stubGlobal("matchMedia", matchMediaMock);

    let count = 0;
    const off1 = subscribeMediaQuery("(max-width:760px)", () => { count += 1; });
    const off2 = subscribeMediaQuery("(max-width:760px)", () => { count += 10; });

    expect(matchMediaMock).toHaveBeenCalledTimes(1);
    expect(mqlListeners.size).toBe(1);

    for (const fn of mqlListeners) fn();
    expect(count).toBe(11);

    off1();
    expect(mqlListeners.size).toBe(1);
    off2();
    expect(mqlListeners.size).toBe(0);
  });

  it("passes explicit passive: false on direct active registration and passive-to-active upgrade", () => {
    const fake = createFakeTarget();
    const target = fake as unknown as Window;

    const offTouch = addGlobalListener(target, "touchstart", () => {}, { passive: false });
    expect(fake.attachments).toEqual([{ type: "touchstart", options: { capture: false, passive: false } }]);
    offTouch();
    expect(fake.detachments).toEqual([{ type: "touchstart", options: undefined }]);

    fake.attachments.length = 0;
    fake.detachments.length = 0;

    const offPassive = addGlobalListener(target, "wheel", () => {}, { capture: true, passive: true });
    expect(fake.attachments).toEqual([{ type: "wheel", options: { capture: true, passive: true } }]);

    const offActive = addGlobalListener(target, "wheel", () => {}, { capture: true, passive: false });
    expect(fake.detachments).toEqual([{ type: "wheel", options: { capture: true } }]);
    expect(fake.attachments).toEqual([
      { type: "wheel", options: { capture: true, passive: true } },
      { type: "wheel", options: { capture: true, passive: false } },
    ]);

    // Removing the active subscriber downgrades the shared bucket back to passive.
    offActive();
    expect(fake.attachments.at(-1)).toEqual({ type: "wheel", options: { capture: true, passive: true } });

    offPassive();
    expect(fake.native.get("wheel:1")?.size).toBe(0);
  });
});
