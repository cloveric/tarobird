import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ platform: "android", tauri: false, reject: false, reducedMotion: false, bg: "#ffffff", calls: [] as { method: string; options?: unknown }[] }));
// Client packages resolve from client/node_modules, not the repository root.
vi.mock("../client/node_modules/@capacitor/core", () => {
  const record = (method: string) => (options?: unknown) => { native.calls.push({ method, options }); return native.reject ? Promise.reject(new Error("native_rejected")) : Promise.resolve(); };
  return {
    Capacitor: { getPlatform: () => native.platform, isNativePlatform: () => native.platform !== "web" },
    registerPlugin: () => new Proxy({}, { get: (_target, key) => typeof key === "string" && key !== "then" ? record(`appearance.${key}`) : undefined }),
    SystemBars: { setStyle: record("bars.setStyle"), hide: record("bars.hide"), show: record("bars.show") },
    SystemBarsStyle: { Light: "LIGHT", Dark: "DARK" },
  };
});
vi.mock("../client/node_modules/@capacitor/keyboard", () => ({ Keyboard: { setStyle: () => Promise.resolve() }, KeyboardStyle: { Light: "LIGHT", Dark: "DARK" } }));
vi.mock("../client/node_modules/@tauri-apps/api/core", () => ({ isTauri: () => native.tauri }));
const tauri = vi.hoisted(() => ({ fullscreen: false, focused: true, exitMs: 0, focusFails: false, calls: [] as string[] }));
vi.mock("../client/node_modules/@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  isFullscreen: async () => tauri.fullscreen, isFocused: async () => tauri.focused,
  // macOS resolves setFullscreen(false) when the exit animation starts, not when it ends.
  setFullscreen: async (value: boolean) => { tauri.calls.push(`fullscreen:${value}`); if (value || !tauri.exitMs) tauri.fullscreen = value; else setTimeout(() => { tauri.fullscreen = false; }, tauri.exitMs); },
  onResized: async () => () => {},
}) }));
vi.mock("../client/node_modules/@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: async () => { tauri.calls.push("focus"); if (tauri.focusFails) throw new Error("denied"); } }) }));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const calls = (prefix: string) => native.calls.filter(call => call.method.startsWith(prefix));
async function load() {
  vi.resetModules();
  return { appearance: await import("../client/src/appearance.js"), viewer: await import("../client/src/image-viewer-fullscreen.js") };
}

beforeEach(() => {
  native.platform = "android"; native.reject = false; native.reducedMotion = false; native.bg = "#ffffff"; native.calls.length = 0;
  vi.stubGlobal("document", { documentElement: { dataset: {} }, querySelector: () => null });
  vi.stubGlobal("window", { matchMedia: () => ({ get matches() { return native.reducedMotion; } }), dispatchEvent: vi.fn() });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => native.bg }));
});

describe("reader system bars", () => {
  it("paints Android bars with a transient dark reader canvas and returns to the saved theme", async () => {
    const { appearance } = await load();
    const first = appearance.acquireDarkNativeStatusBar(), second = appearance.acquireDarkNativeStatusBar();
    expect(calls("appearance.")).toEqual([{ method: "appearance.setReaderCanvas", options: { color: "#101113", darkIcons: false } }]);
    // A theme change while reading persists the app canvas; native code keeps the override on top.
    native.bg = "#17191c"; appearance.syncThemeColor();
    expect(calls("appearance.setCanvas")).toEqual([{ method: "appearance.setCanvas", options: { color: "#17191c", darkIcons: false } }]);
    first(); first();
    expect(calls("appearance.setReaderCanvas")).toHaveLength(1);
    second();
    expect(calls("appearance.setReaderCanvas").at(-1)).toEqual({ method: "appearance.setReaderCanvas", options: {} });
    expect(native.calls.some(call => (call.options as { color?: string } | undefined)?.color === "#101113" && call.method === "appearance.setCanvas")).toBe(false);
  });

  it("keeps the iOS style lease and does nothing in browsers", async () => {
    native.platform = "ios";
    const { appearance } = await load();
    const release = appearance.acquireDarkNativeStatusBar();
    expect(calls("bars.setStyle").at(-1)?.options).toEqual({ style: "DARK" });
    release();
    expect(calls("bars.setStyle").at(-1)?.options).toEqual({ style: "LIGHT" });
    expect(calls("appearance.setReaderCanvas")).toEqual([]);
    native.platform = "web"; native.calls.length = 0;
    appearance.acquireDarkNativeStatusBar()();
    expect(native.calls).toEqual([]);
  });

  it("nests immersive leases and always shows bars after the last release", async () => {
    const { viewer } = await load();
    native.reject = true; // a rejected hide must neither throw nor strand hidden bars
    const a = viewer.acquireImageViewerImmersive(), b = viewer.acquireImageViewerImmersive();
    a(); a(); await flush();
    expect(calls("appearance.setImmersive")).toEqual([{ method: "appearance.setImmersive", options: { enabled: true } }]);
    b(); await flush();
    expect(calls("appearance.setImmersive").at(-1)).toEqual({ method: "appearance.setImmersive", options: { enabled: false } });
    native.platform = "ios"; native.reject = false; native.calls.length = 0;
    viewer.acquireImageViewerImmersive()();
    expect(native.calls.map(call => [call.method, call.options])).toEqual([["bars.hide", { animation: "FADE" }], ["bars.show", { animation: "FADE" }]]);
    native.platform = "web"; native.calls.length = 0;
    viewer.acquireImageViewerImmersive()();
    expect(native.calls).toEqual([]);
  });

  it("keeps requesting iOS immersive fade when the system reports reduced motion", async () => {
    native.platform = "ios"; native.reducedMotion = true;
    const { viewer } = await load();
    viewer.acquireImageViewerImmersive()();
    expect(native.calls.map(call => [call.method, call.options])).toEqual([["bars.hide", { animation: "FADE" }], ["bars.show", { animation: "FADE" }]]);
  });
});

/** A controllable window: set() settles only when the test says so. */
function fakeWindow(initial = false) {
  const state = { value: initial, sets: [] as boolean[], watchers: new Set<() => void>(), gate: undefined as undefined | { resolve: () => void; reject: (error: Error) => void } };
  const target = {
    read: async () => state.value,
    set: (value: boolean) => { state.sets.push(value); return new Promise<void>((resolve, reject) => { state.gate = { resolve: () => { state.value = value; resolve(); }, reject }; }); },
    watch: (changed: () => void) => { state.watchers.add(changed); return () => state.watchers.delete(changed); },
  };
  return { state, target, external: (value: boolean) => { state.value = value; state.watchers.forEach(watch => watch()); } };
}

describe("viewer fullscreen controller", () => {
  it("settles an explicit queued close even when the logical fullscreen state is already false", async () => {
    const { viewer } = await load(), window = fakeWindow(false);
    // Queue behind the initial read, as when a browser exit event has already
    // changed HTML state but the native Space transition is still pending.
    const controller = viewer.createFullscreenController(window.target, () => {});
    let finished = false;
    const exited = controller.exit().then(result => { finished = true; return result; });
    await flush();
    expect(window.state.sets).toEqual([false]); expect(finished).toBe(false);
    window.state.gate!.resolve(); expect(await exited).toBe(true);
    controller.dispose();
  });

  it("awaits a pending entry and explicit exit before allowing the surface to close", async () => {
    const { viewer } = await load(), window = fakeWindow();
    const controller = viewer.createFullscreenController(window.target, () => {});
    await flush(); controller.toggle();
    let finished = false;
    const exited = controller.exit().then(result => { finished = true; return result; });
    await flush(); expect(finished).toBe(false); expect(window.state.sets).toEqual([true]);
    window.state.gate!.resolve(); await flush();
    expect(window.state.sets).toEqual([true, false]); expect(finished).toBe(false);
    window.state.gate!.resolve(); expect(await exited).toBe(true);
    expect(window.state.value).toBe(false); controller.dispose();
  });

  it("rejects a failed exit as a close barrier and permits an explicit retry", async () => {
    const { viewer } = await load(), window = fakeWindow();
    const controller = viewer.createFullscreenController(window.target, () => {});
    await flush(); controller.toggle(); window.state.gate!.resolve(); await flush();
    const failed = controller.exit(); window.state.gate!.reject(new Error("exit failed"));
    expect(await failed).toBe(false); expect(controller.error).toBeTruthy();
    await flush(); expect(window.state.value).toBe(true);
    const retry = controller.exit(); window.state.gate!.resolve();
    expect(await retry).toBe(true); expect(window.state.value).toBe(false);
    controller.dispose(); expect(await controller.exit()).toBe(false);
  });

  it("starts an idle request synchronously and undoes only fullscreen it entered", async () => {
    const { viewer } = await load(), window = fakeWindow(), changed = vi.fn();
    const controller = viewer.createFullscreenController(window.target, changed);
    await flush();
    controller.toggle();
    expect(window.state.sets).toEqual([true]); // still inside the click's user activation
    window.state.gate!.resolve(); await flush();
    expect(controller.active).toBe(true); expect(changed).toHaveBeenCalled();
    controller.dispose(); await flush();
    expect(window.state.sets).toEqual([true, false]);
    window.state.gate!.resolve(); await flush();
    expect(window.state.value).toBe(false); expect(window.state.watchers.size).toBe(0);
  });

  it("preserves a window that was already fullscreen", async () => {
    const { viewer } = await load(), window = fakeWindow(true);
    const controller = viewer.createFullscreenController(window.target, () => {});
    await flush(); expect(controller.active).toBe(true);
    controller.dispose(); await flush();
    expect(window.state.sets).toEqual([]);
    const again = viewer.createFullscreenController(window.target, () => {});
    await flush(); again.toggle(); window.state.gate!.resolve(); await flush();
    again.toggle(); window.state.gate!.resolve(); await flush();
    again.dispose(); await flush();
    expect(window.state.sets).toEqual([false, true]); // explicit choices only; close never toggles it again
  });

  it("restores after a request that completes late, after close", async () => {
    const { viewer } = await load(), window = fakeWindow(), changed = vi.fn();
    const controller = viewer.createFullscreenController(window.target, changed);
    await flush(); controller.toggle(); controller.dispose();
    const renders = changed.mock.calls.length;
    window.state.gate!.resolve(); await flush();
    expect(window.state.sets).toEqual([true, false]);
    window.state.gate!.resolve(); await flush();
    expect(window.state.value).toBe(false);
    expect(changed.mock.calls.length).toBe(renders); // no render after unmount
  });

  it("reports rejected requests without changing state", async () => {
    const { viewer } = await load(), window = fakeWindow();
    const controller = viewer.createFullscreenController(window.target, () => {});
    await flush(); controller.toggle(); window.state.gate!.reject(new Error("permission")); await flush();
    expect(controller.active).toBe(false); expect(controller.error).toBeTruthy();
    controller.dispose(); await flush();
    expect(window.state.sets).toEqual([true]);
  });

  it("toggles from the latest request, so quick repeats never enter twice", async () => {
    const { viewer } = await load(), window = fakeWindow();
    const twice = viewer.createFullscreenController(window.target, () => {});
    await flush(); twice.toggle(); twice.toggle();
    expect(window.state.sets).toEqual([true]);
    window.state.gate!.resolve(); await flush();
    expect(window.state.sets).toEqual([true, false]); // queued request re-read the window
    window.state.gate!.resolve(); await flush();
    expect(twice.active).toBe(false); twice.dispose(); await flush();
    const thrice = viewer.createFullscreenController(window.target, () => {});
    await flush(); thrice.toggle(); thrice.toggle(); thrice.toggle();
    window.state.gate!.resolve(); await flush();
    expect(window.state.sets).toEqual([true, false, true]); // superseded exit skipped; enter already settled
    expect(thrice.active).toBe(true);
    // An exit the OS performed resets the toggle baseline.
    window.external(false); await flush();
    thrice.toggle();
    expect(window.state.sets).toEqual([true, false, true, true]);
    window.state.gate!.resolve(); await flush();
    thrice.dispose(); await flush(); window.state.gate?.resolve(); await flush();
  });

  it("lets Escape and Back leave fullscreen without closing the viewer", async () => {
    let clock = 0;
    const { viewer } = await load(), window = fakeWindow();
    const controller = viewer.createFullscreenController(window.target, () => {}, () => clock);
    await flush();
    expect(controller.consumeEscape()).toBe(false);
    controller.toggle(); window.state.gate!.resolve(); await flush();
    expect(controller.consumeEscape()).toBe(true);
    expect(window.state.sets).toEqual([true, false]); // exit only, never a fresh enter
    window.state.gate!.resolve(); await flush();
    // The next Escape closes the viewer, however quickly it follows.
    expect(controller.consumeEscape()).toBe(false);
    // The browser itself consumed Escape and left fullscreen first.
    controller.toggle(); window.state.gate!.resolve(); await flush();
    clock = 1000; window.external(false); await flush();
    clock = 1100; expect(controller.consumeEscape()).toBe(true);
    clock = 1200; expect(controller.consumeEscape()).toBe(false);
    controller.dispose();
  });
});

describe("Tauri window fullscreen", () => {
  const focusCalls = () => tauri.calls.filter(call => call === "focus").length;
  beforeEach(() => { vi.useFakeTimers(); Object.assign(tauri, { fullscreen: false, focused: true, exitMs: 0, focusFails: false }); tauri.calls.length = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it("refocuses the WebView only after the exit animation leaves the window windowed", async () => {
    const { viewer } = await load(), target = viewer.tauriFullscreen();
    await target.set(true); tauri.exitMs = 900;
    await target.set(false);
    await vi.advanceTimersByTimeAsync(800);
    expect(focusCalls()).toBe(0); // still fullscreen: AppKit would take focus back
    await vi.advanceTimersByTimeAsync(800);
    expect(focusCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(focusCalls()).toBe(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("also covers exits the OS performed itself", async () => {
    const { viewer } = await load(), target = viewer.tauriFullscreen();
    tauri.fullscreen = true; expect(await target.read()).toBe(true);
    tauri.fullscreen = false; expect(await target.read()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(focusCalls()).toBe(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("never takes focus from another app and stops when re-entered, denied or out of time", async () => {
    const { viewer } = await load(), target = viewer.tauriFullscreen();
    tauri.focused = false; await target.set(true); await target.set(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(focusCalls()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    tauri.focused = true; tauri.exitMs = 900;
    await target.set(true); await target.set(false); await target.set(true); // re-entered mid-animation
    await vi.advanceTimersByTimeAsync(4000);
    expect(focusCalls()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    tauri.exitMs = 0; tauri.focusFails = true;
    await target.set(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(focusCalls()).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });
});
