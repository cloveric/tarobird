import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t, useLocale } from "./i18n.js";
import type { HubConnection } from "./connection.js";
import { blobVideoPoster, cachedVideoPoster, videoPoster, type VideoPoster } from "./video-thumbnail.js";

// An absent/empty poster lets Android WebView stretch its legacy play graphic
// under the real controls. Supply a quiet placeholder on the very first render.
const pendingVideoPoster = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><path fill="#17191d" d="M0 0h300v150H0z"/></svg>');

export function MediaReader({ blob, kind, name, connection, attachmentId }: { blob: Blob; kind: "image" | "audio" | "video"; name: string; connection?: HubConnection; attachmentId?: string }) {
  useLocale(); const [url, setUrl] = useState<string>(), [failed, setFailed] = useState(false);
  const [cover, setCover] = useState<{ blob: Blob; poster: VideoPoster }>();
  const [dimensions, setDimensions] = useState<{ blob: Blob; width: number; height: number }>();
  const poster = cover?.blob === blob ? cover.poster : connection && attachmentId ? cachedVideoPoster(connection, attachmentId) : undefined;
  // Poster pixels are capped for memory. Keep the original video's geometry,
  // including while a local draft's cover is still being decoded.
  const size = dimensions?.blob === blob ? dimensions : poster;
  const frame = useRef<HTMLDivElement>(null), [room, setRoom] = useState<{ width: number; height: number }>();
  useLayoutEffect(() => {
    const node = frame.current; if (kind !== "video" || !node) return;
    const measure = () => setRoom(old => old?.width === node.clientWidth && old.height === node.clientHeight ? old : { width: node.clientWidth, height: node.clientHeight });
    const observer = new ResizeObserver(measure); observer.observe(node); measure();
    return () => observer.disconnect();
  }, [kind]);
  // Size attributes alone let max-width/max-height clamp one axis only. The
  // stretched box letterboxes the picture and detaches the native controls.
  const fit = size && room?.width && room.height ? Math.min(1, room.width / size.width, room.height / size.height) : 0;
  useEffect(() => { const value = URL.createObjectURL(blob); setUrl(value); setFailed(false); return () => URL.revokeObjectURL(value); }, [blob]);
  useEffect(() => {
    if (kind !== "video" || poster || failed) return;
    const controller = new AbortController();
    // Reuse chat covers and already-downloaded bytes; never fetch another copy
    // or play/seek the visible player merely to prepare its opening picture.
    const job = connection && attachmentId ? videoPoster(connection, attachmentId, controller.signal, blob) : blobVideoPoster(blob, controller.signal);
    void job.then(value => { if (!controller.signal.aborted) setCover({ blob, poster: value }); }).catch(() => undefined);
    return () => controller.abort();
  }, [blob, kind, connection, attachmentId, poster, failed]);
  return <div ref={frame} className="file-media-preview">{failed ? <p role="status">{t("此设备无法预览该文件，请另存为后打开。")}</p> : url && (kind === "image" ? <img src={url} alt={name} onError={() => setFailed(true)}/> : kind === "audio" ? <audio src={url} controls onError={() => setFailed(true)}/> : <video poster={poster?.url ?? pendingVideoPoster} style={fit ? { width: Math.floor(size!.width * fit), height: Math.floor(size!.height * fit) } : undefined} src={url} controls playsInline onLoadedMetadata={event => { const video = event.currentTarget; if (video.videoWidth && video.videoHeight) setDimensions({ blob, width: video.videoWidth, height: video.videoHeight }); }} onError={() => setFailed(true)}/>)}</div>;
}
