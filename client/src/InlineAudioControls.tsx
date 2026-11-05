import { useEffect, useRef, useState, type RefObject } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { t } from "./i18n.js";

const time = (value: number) => {
  const seconds = Math.floor(Number.isFinite(value) && value > 0 ? value : 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Desktop chrome around the existing media element. Playback, decoding and
 * the timeline retention lease remain owned by Audio in Content.tsx. */
export function InlineAudioControls({ media, playing, active }: {
  media: RefObject<HTMLAudioElement | null>; playing: boolean; active: boolean;
}) {
  const [position, setPosition] = useState(0), [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState("");
  const attempt = useRef(0), busy = useRef(false);
  useEffect(() => {
    const node = media.current;
    if (!node) return;
    const sync = () => {
      setPosition(Number.isFinite(node.currentTime) ? node.currentTime : 0);
      setDuration(Number.isFinite(node.duration) && node.duration > 0 ? node.duration : 0);
      setMuted(node.muted || node.volume === 0);
    };
    const events = ["loadedmetadata", "durationchange", "timeupdate", "seeked", "ended", "emptied", "volumechange"];
    sync(); events.forEach(event => node.addEventListener(event, sync));
    return () => { attempt.current++; events.forEach(event => node.removeEventListener(event, sync)); };
  }, [media]);
  useEffect(() => { if (!active) { attempt.current++; busy.current = false; setPending(false); } }, [active]);
  const toggle = async () => {
    const node = media.current;
    if (!node || !active) return;
    setError("");
    if (busy.current || !node.paused) { attempt.current++; busy.current = false; setPending(false); node.pause(); return; }
    const revision = ++attempt.current; busy.current = true; setPending(true);
    try { await node.play(); }
    catch (reason) {
      if (attempt.current === revision && !(reason instanceof DOMException && reason.name === "AbortError")) setError(t("播放未能开始，请重试。"));
    } finally { if (attempt.current === revision) { busy.current = false; setPending(false); } }
  };
  return <>
    <div className="inline-audio-controls" role="group" aria-label={t("语音播放")}>
      <button className="inline-audio-toggle" type="button" aria-label={playing || pending ? t("暂停语音") : t("播放语音")} title={playing || pending ? t("暂停语音") : t("播放语音")} disabled={!active} aria-busy={pending || undefined} onClick={() => { void toggle(); }}>
        {playing || pending ? <Pause size={17} fill="currentColor" aria-hidden="true"/> : <Play size={17} fill="currentColor" aria-hidden="true"/>}
      </button>
      <span className="inline-audio-time" aria-hidden="true">{time(position)} / {duration ? time(duration) : "–:––"}</span>
      <input type="range" min={0} max={duration || 1} step={0.05} value={Math.min(position, duration || 1)} disabled={!active || !duration}
        aria-label={t("播放进度")} aria-valuetext={t("{0}，共 {1}", time(position), time(duration))}
        onChange={event => { const node = media.current; if (node && active && duration) { node.currentTime = Number(event.target.value); setPosition(node.currentTime); } }}/>
      <button className="inline-audio-volume" type="button" aria-label={muted ? t("取消静音") : t("静音")} title={muted ? t("取消静音") : t("静音")} disabled={!active}
        onClick={() => { const node = media.current; if (node) { const silent = node.muted || node.volume === 0; if (silent && node.volume === 0) node.volume = 1; node.muted = !silent; } }}>
        {muted ? <VolumeX size={17} aria-hidden="true"/> : <Volume2 size={17} aria-hidden="true"/>}
      </button>
    </div>
    {error && <small role="alert">{error}</small>}
  </>;
}
