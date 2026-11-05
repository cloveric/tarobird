import { useContext, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Play, Video } from "lucide-react";
import type { HubConnection } from "./connection.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { AUTO_VIDEO_POSTER_BYTES, cachedVideoPoster, videoDuration, videoPoster, type VideoPoster } from "./video-thumbnail.js";
import { t } from "./i18n.js";
import "./video-thumbnail.css";

export function VideoThumbnail({ connection, id, name, size, busy, source, opener, open }: {
  connection: HubConnection; id: string; name: string; size: number; busy?: boolean; source?: Blob;
  opener: RefObject<HTMLButtonElement | null>; open: () => void;
}) {
  const active = useContext(RuntimeHostActiveContext), area = useRef<HTMLDivElement>(null);
  const status = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state.status);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState<{ connection: HubConnection; id: string; poster: VideoPoster }>();
  const poster = loaded?.connection === connection && loaded.id === id ? loaded.poster : cachedVideoPoster(connection, id);
  useEffect(() => {
    const node = area.current; if (!node) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (poster || !active || !visible || busy || !source && (status !== "online" || size <= 0 || size > AUTO_VIDEO_POSTER_BYTES)) return;
    const controller = new AbortController();
    // A slow/offline original must not monopolize the passive queue indefinitely.
    const timer = setTimeout(() => controller.abort(), 30_000);
    void videoPoster(connection, id, controller.signal, source).then(poster => {
      if (!controller.signal.aborted) setLoaded({ connection, id, poster });
    }).catch(() => { /* Unsupported or unavailable media keeps its explicit preview/save actions. */ }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [connection, id, size, active, visible, busy, source, status, poster]);
  return <div ref={area} className="video-thumbnail">
    <button ref={opener} data-message-hold aria-label={t("预览 {0}", name)} aria-disabled={busy} onClick={open}
      style={poster ? { aspectRatio: `${poster.width} / ${poster.height}`, maxWidth: `min(100%, ${300 * poster.width / poster.height}px)` } : undefined}>
      {poster && <img src={poster.url} alt=""/>}
      <span className="video-play" aria-hidden="true"><Play size={24} fill="currentColor"/></span>
      <span className="video-duration" aria-hidden="true"><Video size={13}/>{poster?.duration !== undefined ? videoDuration(poster.duration) : t("预览")}</span>
    </button>
  </div>;
}
