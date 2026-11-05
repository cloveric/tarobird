import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { installDesktopWindowChrome } from "../src/desktop-window-chrome.js";

const native = vi.hoisted(() => ({ isTauri: vi.fn(), isFullscreen: vi.fn(), onResized: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: native.isTauri }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe("Mac window chrome lifecycle", () => {
  let cleanup: (() => void) | undefined, resize: () => void, mutated: MutationCallback;
  let frames: Map<number, FrameRequestCallback>, disconnect: ReturnType<typeof vi.fn>, stop: ReturnType<typeof vi.fn>;
  const flushFrames = () => { for (const [id, run] of frames) { frames.delete(id); run(0); } };
  beforeEach(() => {
    vi.resetAllMocks();
    const { document, Element } = parseHTML('<html><body><div class="host-workspace"><div class="app-shell"><aside class="sidebar"><header class="brand"><button>按钮</button></header></aside><main class="conversation-main"><header class="conversation-header"></header><div class="message-blocks"></div></main></div></div></body></html>');
    frames = new Map(); let id = 0; stop = vi.fn(); disconnect = vi.fn();
    vi.stubGlobal("document", document); vi.stubGlobal("Element", Element); vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Macintosh" });
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => { frames.set(++id, run); return id; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("MutationObserver", class { constructor(callback: MutationCallback) { mutated = callback; } observe() {} disconnect = disconnect; });
    native.isTauri.mockReturnValue(true); native.isFullscreen.mockResolvedValue(false);
    native.onResized.mockImplementation(async (callback: () => void) => { resize = callback; return stop; });
  });
  afterEach(() => { cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(["web", "Windows", "Linux", "iPhone"])("leaves %s untouched", async platform => {
    native.isTauri.mockReturnValue(platform !== "web");
    if (platform !== "web") vi.stubGlobal("navigator", { userAgent: platform === "iPhone" ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" : platform });
    cleanup = installDesktopWindowChrome(); await tick();
    expect(document.documentElement.hasAttribute("data-window-chrome")).toBe(false);
    expect(document.querySelector("[data-tauri-drag-region]")).toBeNull(); expect(native.onResized).not.toHaveBeenCalled();
  });

  it("marks inserted chrome only, preserves opt-outs, and releases its own markers", async () => {
    document.querySelector(".conversation-header")!.setAttribute("data-tauri-drag-region", "false");
    cleanup = installDesktopWindowChrome(); await tick();
    expect(document.querySelector(".brand")!.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(document.querySelector("button")!.hasAttribute("data-tauri-drag-region")).toBe(false);
    const scan = vi.spyOn(document, "querySelectorAll");
    const message = document.querySelector(".message-blocks")!, text = document.createTextNode("streaming"); message.append(text);
    mutated([{ addedNodes: [text] } as unknown as MutationRecord], {} as MutationObserver);
    expect(frames.size).toBe(0); expect(scan).not.toHaveBeenCalled();
    const panel = document.createElement("div"); panel.innerHTML = '<header class="image-preview-toolbar"><div class="image-preview-actions"><button>关闭</button></div><p class="image-export-status">可选择的反馈文字</p></header><header class="adhd-card-header">重排卡片</header>';
    document.body.append(panel); mutated([{ addedNodes: [panel] } as unknown as MutationRecord], {} as MutationObserver);
    expect(panel.querySelector(".image-preview-actions")!.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(panel.firstElementChild!.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(panel.lastElementChild!.hasAttribute("data-tauri-drag-region")).toBe(false); expect(scan).not.toHaveBeenCalled();
    cleanup(); cleanup(); cleanup = undefined;
    expect(disconnect).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
    expect(document.querySelector(".brand")!.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(document.querySelector(".conversation-header")!.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(document.documentElement.hasAttribute("data-window-chrome")).toBe(false);
  });

  it("coalesces resize bursts and ignores stale fullscreen replies", async () => {
    cleanup = installDesktopWindowChrome(); await tick();
    const first = deferred<boolean>(), second = deferred<boolean>();
    native.isFullscreen.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    resize(); resize(); resize(); expect(frames.size).toBe(1); flushFrames();
    resize(); flushFrames();
    second.resolve(true); await tick(); first.resolve(false); await tick();
    expect(document.documentElement.hasAttribute("data-window-fullscreen")).toBe(true);
    native.isFullscreen.mockRejectedValueOnce(new Error("window closing")); resize(); flushFrames(); await tick();
    expect(document.documentElement.hasAttribute("data-window-fullscreen")).toBe(true);
  });

  it("keeps small settings and creation dialogs out of native window dragging", async () => {
    document.body.insertAdjacentHTML("beforeend", '<dialog class="preferences-dialog"><header class="preferences-header"><button>关闭</button></header></dialog><dialog class="creation-dialog"><header>新建</header></dialog><dialog class="creation-dialog is-movable"><header>内页拖动</header></dialog><section class="file-center"><header class="file-center-header">文件</header></section><section class="file-preview"><header>文档</header></section><section class="file-preview is-movable"><header>视频</header></section>');
    cleanup = installDesktopWindowChrome(); await tick();
    for (const selector of [".file-center-header", ".file-preview:not(.is-movable)>header"]) expect(document.querySelector(selector)!.getAttribute("data-tauri-drag-region")).toBe("deep");
    for (const element of document.querySelectorAll(".preferences-header, .creation-dialog>header, .is-movable>header, button")) expect(element.hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  it("releases a draft header when asynchronous loading enables in-page dragging", async () => {
    document.body.insertAdjacentHTML("beforeend", '<section class="file-preview"><header>加载中</header></section>');
    cleanup = installDesktopWindowChrome(); await tick();
    const preview = document.querySelector(".file-preview")!, header = preview.firstElementChild!;
    const changed = () => mutated([{ type: "attributes", target: preview, attributeName: "class" } as MutationRecord], {} as MutationObserver);
    expect(header.getAttribute("data-tauri-drag-region")).toBe("deep");
    const scan = vi.spyOn(document, "querySelectorAll");
    preview.classList.add("is-movable"); changed();
    expect(header.hasAttribute("data-tauri-drag-region")).toBe(false);
    preview.classList.remove("is-movable"); changed();
    expect(header.getAttribute("data-tauri-drag-region")).toBe("deep");
    // A component may explicitly opt out after the installer marked it. Neither
    // a mode transition nor disposal is allowed to remove that component value.
    header.setAttribute("data-tauri-drag-region", "false");
    preview.classList.add("is-movable"); changed();
    preview.classList.remove("is-movable"); changed();
    expect(header.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(scan).not.toHaveBeenCalled();
    cleanup(); cleanup = undefined;
    expect(header.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("disposes a late listener registration without reading fullscreen", async () => {
    const listener = deferred<() => void>(); native.onResized.mockReturnValueOnce(listener.promise);
    cleanup = installDesktopWindowChrome(); await tick(); cleanup(); cleanup = undefined;
    listener.resolve(stop); await tick();
    expect(stop).toHaveBeenCalledOnce(); expect(native.isFullscreen).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute("data-window-chrome")).toBe(false);
  });

  it("ignores native replies and cancels queued resize after disposal", async () => {
    const pending = deferred<boolean>(); native.isFullscreen.mockReturnValueOnce(pending.promise);
    cleanup = installDesktopWindowChrome(); await tick(); resize();
    cleanup(); cleanup = undefined; pending.resolve(true); await tick(); flushFrames();
    expect(native.isFullscreen).toHaveBeenCalledOnce(); expect(frames.size).toBe(0);
    expect(document.documentElement.hasAttribute("data-window-fullscreen")).toBe(false);
  });
});
