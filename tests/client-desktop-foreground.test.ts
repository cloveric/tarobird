import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pure SDK-boundary tests: no browser, OS focus events, Hub or UI automation.
const bridge = vi.hoisted(() => ({ listen: vi.fn(), current: vi.fn(), links: vi.fn() }));
vi.mock("../client/node_modules/@tauri-apps/api/core.js", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("../client/node_modules/@tauri-apps/api/window.js", () => ({ getCurrentWindow: () => ({ listen: bridge.listen }) }));
vi.mock("../client/node_modules/@tauri-apps/plugin-deep-link/dist-js/index.js", () => ({ getCurrent: bridge.current, onOpenUrl: bridge.links }));
import { installNativeEvents } from "../client/src/native.js";
import { ListenerScope } from "../client/src/listener-scope.js";

const scopes: ListenerScope[] = [];
const install = (resume: () => void) => { const scope = new ListenerScope(); scopes.push(scope); installNativeEvents(resume, scope); return scope; };
const flushImports = async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 5; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("window", new EventTarget());
  bridge.listen.mockReset(); bridge.current.mockReset().mockResolvedValue(null); bridge.links.mockReset().mockResolvedValue(() => {});
});
afterEach(() => { for (const scope of scopes.splice(0)) scope.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("desktop foreground recovery", () => {
  it("registers native activation even when the launch lookup is unavailable", async () => {
    bridge.current.mockRejectedValue(new Error("launch unavailable"));
    const remove = vi.fn(), resume = vi.fn(); let emit!: (event: unknown) => void;
    bridge.listen.mockImplementation(async (name, callback) => { expect(name).toBe("tauri://focus"); emit = callback; return remove; });
    const scope = install(resume); await flushImports();
    expect(bridge.listen).toHaveBeenCalledTimes(1); emit({}); expect(resume).toHaveBeenCalledTimes(1);
    scope.close(); emit({}); expect(resume).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
  });
  it("does not duplicate an unresolved registration and cleans its late receipt", async () => {
    const resume = vi.fn(), remove = vi.fn(); let emit!: (event: unknown) => void, release!: (remove: () => void) => void;
    bridge.listen.mockImplementation((_name, callback) => { emit = callback; return new Promise(resolve => { release = resolve; }); });
    const scope = install(resume); await flushImports(); await vi.advanceTimersByTimeAsync(120_000);
    expect(bridge.listen).toHaveBeenCalledTimes(1);
    scope.close(); emit({}); release(remove); await flushImports();
    expect(resume).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledTimes(1);
  });
  it("retries a rejected registration while fencing any retained old callback", async () => {
    const resume = vi.fn(), callbacks: ((event: unknown) => void)[] = [];
    bridge.listen.mockImplementation(async (_name, emit) => { callbacks.push(emit); if (callbacks.length === 1) throw new Error("transient bridge failure"); return () => {}; });
    install(resume); await flushImports(); await vi.advanceTimersByTimeAsync(1000); await flushImports();
    expect(callbacks).toHaveLength(2); callbacks.forEach(emit => emit({})); expect(resume).toHaveBeenCalledTimes(1);
  });
  it("a cancelled install never subscribes after its dynamic import completes", async () => {
    const resume = vi.fn(); install(resume).close(); await flushImports();
    expect(bridge.listen).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  });
});
