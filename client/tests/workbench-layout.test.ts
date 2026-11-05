import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
async function fixture() {
  const frames: FrameRequestCallback[] = [], mutations: MutationCallback[] = [];
  let rect = { x: 10, y: 40, width: 640, height: 480 }, hidden = false;
  const invoke = vi.fn(async () => undefined), events = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("MutationObserver", class { constructor(callback: MutationCallback) { mutations.push(callback); } observe() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("window", { ...events, tarobotDesktop: { version: 1, engine: "electron", platform: "darwin", invoke, openSocket() {}, on() {} } });
  vi.stubGlobal("document", { ...events, body: {}, get hidden() { return hidden; }, querySelectorAll: () => [] });
  const node = { isConnected: true, closest: () => null, getBoundingClientRect: () => rect } as unknown as HTMLElement;
  const module = await import("../src/workbench-browser.js");
  const stop = module.registerBrowserSurface("page", node, () => true);
  const frame = async () => { const batch = frames.splice(0); batch.forEach(callback => callback(0)); await Promise.resolve(); await Promise.resolve(); };
  const mutate = () => mutations.forEach(callback => callback([], {} as MutationObserver));
  return { ...module, invoke, stop, frame, mutate, move: () => { rect = { ...rect, x: 25 }; }, hide: (value: boolean) => { hidden = value; } };
}
it("skips unchanged layout IPC from unrelated streaming DOM while preserving movement and overlays", async () => {
  const f = await fixture();
  try {
    await f.frame(); expect(f.invoke).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 60; i++) { f.mutate(); await f.frame(); }
    expect(f.invoke).toHaveBeenCalledTimes(1);
    f.move(); f.mutate(); await f.frame(); expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.invoke.mock.calls.at(-1)).toEqual(["workbench_browser_layout", expect.objectContaining({ views: [expect.objectContaining({ x: 25 })], hidden: false })]);
    f.hide(true); f.scheduleBrowserLayout(); await f.frame(); expect(f.invoke).toHaveBeenCalledTimes(3);
    f.hide(false); f.scheduleBrowserLayout(); await f.frame(); expect(f.invoke).toHaveBeenCalledTimes(4);
    Object.assign(window, {devicePixelRatio:2}); f.mutate(); await f.frame();
    expect(f.invoke).toHaveBeenCalledTimes(5); // Same CSS bounds, different native scaling.
  } finally { f.stop(); await f.frame(); }
  expect(f.invoke.mock.calls.at(-1)).toEqual(["workbench_browser_layout", expect.objectContaining({ views: [] })]);
});
it("does not let a stale IPC failure invalidate a newer successful layout", async () => {
  const f = await fixture(); let reject!: (cause: Error) => void;
  try {
    f.invoke.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    await f.frame(); f.move(); f.mutate(); await f.frame();
    reject(new Error("old_layout_failed")); await Promise.resolve(); await Promise.resolve();
    f.mutate(); await f.frame(); expect(f.invoke).toHaveBeenCalledTimes(2);
  } finally { f.stop(); await f.frame(); }
});
it("retries a failed layout on the next scheduling event", async () => {
  const f = await fixture();
  try {
    f.invoke.mockRejectedValueOnce(new Error("bridge_temporarily_unavailable"));
    await f.frame(); f.mutate(); await f.frame(); expect(f.invoke).toHaveBeenCalledTimes(2);
    f.mutate(); await f.frame(); expect(f.invoke).toHaveBeenCalledTimes(2);
  } finally { f.stop(); await f.frame(); }
});
