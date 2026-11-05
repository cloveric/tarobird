import type { HubConnection } from "./connection.js";

export type VideoPoster = { url: string; width: number; height: number; duration?: number };
// Match the existing original-attachment cache limit. Larger files only decode
// a cover after an explicit preview has already acquired their bytes.
export const AUTO_VIDEO_POSTER_BYTES = 16 * 1024 ** 2;
const posters = new WeakMap<HubConnection, Map<string, VideoPoster>>();
export const cachedVideoPoster = (connection: HubConnection, id: string) => posters.get(connection)?.get(id);
const localPosters = new WeakMap<Blob, VideoPoster>();
const cancelled = () => new DOMException("Video thumbnail cancelled", "AbortError");

// One passive transfer/decoder at a time across mounted conversations. Removing
// a card or changing hosts aborts its own job, including while it is queued.
let queue: Promise<unknown> = Promise.resolve();
function enqueuePoster(signal: AbortSignal, decode: () => Promise<VideoPoster>): Promise<VideoPoster> {
  const job = queue.catch(() => undefined).then(() => {
    if (signal.aborted) throw cancelled();
    return decode();
  });
  queue = job.catch(() => undefined); return job;
}
async function localPoster(blob: Blob, signal: AbortSignal): Promise<VideoPoster> {
  if (signal.aborted) throw cancelled();
  const cached = localPosters.get(blob); if (cached) return cached;
  const poster = await decodeVideoPoster(blob, signal);
  localPosters.set(blob, poster); return poster;
}
/** Draft/reader bytes are already local. Share the decoder budget and retain a
 * cover only while its source Blob is still owned by a preview or draft. */
export function blobVideoPoster(blob: Blob, signal: AbortSignal): Promise<VideoPoster> {
  return enqueuePoster(signal, () => localPoster(blob, signal));
}
export function videoPoster(connection: HubConnection, id: string, signal: AbortSignal, source?: Blob): Promise<VideoPoster> {
  return enqueuePoster(signal, async () => {
    const cached = cachedVideoPoster(connection, id); if (cached) return cached;
    const blob = source ?? await connection.blob(id, { signal });
    if (signal.aborted) throw cancelled();
    const poster = await localPoster(blob, signal);
    let cache = posters.get(connection); if (!cache) { cache = new Map(); posters.set(connection, cache); }
    cache.set(id, poster);
    while (cache.size > 48) cache.delete(cache.keys().next().value!);
    return poster;
  });
}

function decodeVideoPoster(blob: Blob, signal: AbortSignal): Promise<VideoPoster> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const video = document.createElement("video"), url = URL.createObjectURL(blob);
    let done = false, seeking = false, presented = false, frameCallback: number | undefined;
    const finish = (poster?: VideoPoster, error?: unknown) => {
      if (done) return; done = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
      video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
      video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
      if (poster) resolve(poster); else reject(error ?? new Error("video_thumbnail_unavailable"));
    };
    const abort = () => finish(undefined, cancelled());
    const timer = setTimeout(() => finish(), 10_000);
    const capture = () => {
      if (done || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      try {
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const ctx = canvas.getContext("2d"); if (!ctx) { finish(); return; }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish({ url: canvas.toDataURL("image/jpeg", .8), width: video.videoWidth, height: video.videoHeight,
          duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined });
      } catch (error) { finish(undefined, error); }
    };
    video.muted = true; video.playsInline = true; video.preload = "auto";
    // WebKit can fire seeked/loadeddata before canvas-readable pixels exist.
    // Subscribe before loading and wait for an actual presented frame.
    const frameReady = typeof video.requestVideoFrameCallback === "function";
    // Chromium can present that frame just before readyState reaches
    // HAVE_CURRENT_DATA; the one-shot callback then defers to loadeddata.
    if (frameReady) frameCallback = video.requestVideoFrameCallback(() => { presented = true; capture(); });
    video.onloadedmetadata = () => {
      if (!frameReady && Number.isFinite(video.duration) && video.duration > 0) { seeking = true; video.currentTime = Math.min(.1, video.duration / 2); }
    };
    video.onloadeddata = () => { if (frameReady ? presented : !seeking) capture(); };
    video.onseeked = () => { if (!frameReady) capture(); };
    video.onerror = () => finish();
    signal.addEventListener("abort", abort, { once: true });
    video.src = url; video.load();
  });
}

export function videoDuration(seconds: number): string {
  const total = Math.floor(seconds), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s).padStart(2, "0")}`;
}
