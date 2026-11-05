import { afterEach, describe, expect, it, vi } from "vitest";

type Order = "frame-before-data" | "data-before-frame";
const scene = vi.hoisted(() => ({ order: "data-before-frame" as string, draws: 0 }));

/** The decoder's video element: metadata, then a presented frame and loadeddata in either order. */
class FakeVideo {
  muted = false; playsInline = false; preload = ""; readyState = 0; videoWidth = 0; videoHeight = 0; duration = NaN; currentTime = 0;
  onloadedmetadata: (() => void) | null = null; onloadeddata: (() => void) | null = null; onseeked: (() => void) | null = null; onerror: (() => void) | null = null;
  private frame: (() => void) | undefined;
  src = "";
  requestVideoFrameCallback(callback: () => void) { this.frame = callback; return 1; }
  cancelVideoFrameCallback() { this.frame = undefined; }
  pause() {}
  removeAttribute() { this.src = ""; }
  load() {
    if (!this.src) return;
    setTimeout(() => {
      this.readyState = 1; this.videoWidth = 1280; this.videoHeight = 720; this.duration = 3;
      this.onloadedmetadata?.();
      const data = () => { this.readyState = 4; this.onloadeddata?.(); };
      const frame = () => { const callback = this.frame; this.frame = undefined; callback?.(); };
      // Observed in Chromium: the frame callback can run while readyState is
      // still HAVE_METADATA, immediately before loadeddata is dispatched.
      if (scene.order === "frame-before-data") { frame(); data(); } else { data(); frame(); }
    }, 0);
  }
}
const canvas = () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => { scene.draws++; } }), toDataURL: () => "data:image/jpeg;base64,AAAA" });

async function load() {
  vi.resetModules();
  vi.stubGlobal("document", { createElement: (tag: string) => tag === "video" ? new FakeVideo() : canvas() });
  return import("../client/src/video-thumbnail.js");
}

describe("video poster decoding", () => {
  afterEach(() => { vi.unstubAllGlobals(); scene.draws = 0; });

  for (const order of ["frame-before-data", "data-before-frame"] satisfies Order[]) it(`captures one cover when the presented frame and loadeddata arrive ${order}`, async () => {
    scene.order = order;
    const { blobVideoPoster } = await load();
    const timeout = new Promise<"stalled">(resolve => setTimeout(() => resolve("stalled"), 500));
    const poster = await Promise.race([blobVideoPoster(new Blob([new Uint8Array([0])], { type: "video/mp4" }), new AbortController().signal), timeout]);
    expect(poster).toEqual({ url: "data:image/jpeg;base64,AAAA", width: 1280, height: 720, duration: 3 });
    expect(scene.draws).toBe(1);
  });
});
