import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, Mic, Trash2 } from "lucide-react";
import { t } from "./i18n.js";
import type { useVoiceRecorder } from "./useVoiceRecorder.js";
import type { VoiceMeter } from "./voice-meter.js";
import "./hold-to-talk.css";

export function VoiceWaveform({ meter, recording = false }: { meter?: VoiceMeter; recording?: boolean }) {
  const svg = useRef<SVGSVGElement>(null);
  // Read readiness before paint instead of briefly reporting an unavailable
  // meter until the first waveform frame. Listen for genuine suspend/resume.
  const subscribe = useCallback((notify: () => void) => {
    meter?.context.addEventListener("statechange", notify);
    return () => meter?.context.removeEventListener("statechange", notify);
  }, [meter]);
  const available = useSyncExternalStore(subscribe, () => meter?.context.state === "running", () => false);
  useEffect(() => {
    const bars = svg.current?.querySelectorAll("rect");
    if (!bars) return;
    const history = Array<number>(48).fill(0), data = new Uint8Array(meter?.analyser.fftSize ?? 1024);
    let frame = 0, last = 0;
    const draw = (now: number) => {
      if (now - last >= 50) {
        last = now;
        const running = meter?.context.state === "running";
        let energy = 0;
        if (running) { meter.analyser.getByteTimeDomainData(data); for (const sample of data) energy += ((sample - 128) / 128) ** 2; }
        const level = running ? Math.min(1, Math.sqrt(energy / data.length) * 3) : 0;
        history.shift(); history.push(level);
        bars.forEach((bar, index) => { const height = 3 + history[index]! * 49; bar.setAttribute("y", String((64 - height) / 2)); bar.setAttribute("height", String(height)); });
        svg.current?.setAttribute("data-level", level.toFixed(3));
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [meter]);
  return <div className="voice-waveform"><svg ref={svg} viewBox="0 0 288 64" preserveAspectRatio="none" role="img" aria-label={t("实时录音波形")}>{Array.from({ length: 48 }, (_, index) => <rect key={index} x={index * 6 + 1} y={30.5} width={3} height={3} rx={1.5}/>)}</svg>{recording && !available && <small>{t("音量指示暂不可用")}</small>}</div>;
}

export function VoiceRecordingPanel({ voice, cancelling }: { voice: ReturnType<typeof useVoiceRecorder>; cancelling: boolean }) {
  return <div className="hold-voice-panel">
      <div className="hold-voice-status" role="status">{voice.phase === "requesting" ? t("等待麦克风权限…") : voice.phase === "stopping" ? t("正在保存录音…") : t("正在录音")}</div>
      <time aria-label={t("录音时长")}>{Math.floor(voice.seconds / 60).toString().padStart(2, "0")}:{(voice.seconds % 60).toString().padStart(2, "0")}</time>
      <VoiceWaveform meter={voice.meter} recording={voice.phase === "recording"}/>
      <span className="hold-voice-cancel-icon" aria-hidden="true"><Trash2 size={21}/></span>
      <p role="status">{cancelling ? t("松开取消") : t("松开发送，上滑取消")}</p>
    </div>;
}

type Props = { voice: ReturnType<typeof useVoiceRecorder>; disabled: boolean; progress?: number; recovering: boolean; cancelUpload: () => void; hasDraft: boolean; start: () => void; close: () => void };
export function HoldToTalk({ voice, disabled, progress, recovering, cancelUpload, hasDraft, start, close }: Props) {
  const helpId = useId();
  const press = useRef<{ pointer?: number; key?: string; y: number; cancel: boolean } | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);
  const reset = () => { press.current = undefined; setCancelling(false); };
  const cancel = () => { reset(); voice.cancel(); };
  const release = () => { const held = press.current; reset(); if (!held) return; if (held.cancel) voice.cancel(); else voice.finishHeld(); };
  useEffect(() => { if (voice.phase === "idle") reset(); }, [voice.phase]);
  useEffect(() => {
    const blur = () => { if (press.current) cancel(); };
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("blur", blur); };
  }, [voice.cancel]);
  useEffect(() => () => { if (press.current) voice.cancel(); }, [voice.cancel]);
  const busy = voice.busy, uploading = progress !== undefined;
  return <section className={`hold-voice${busy ? " is-recording" : ""}${cancelling ? " is-cancelling" : ""}`} aria-label={t("语音输入")}>
    {busy && <VoiceRecordingPanel voice={voice} cancelling={cancelling}/>}
    {!busy && hasDraft && <small className="hold-voice-draft-note">{t("文字和附件草稿已保留")}</small>}
    {uploading && <div className="hold-voice-upload"><span role="status">{recovering ? t("连接中断，等待恢复…") : t("上传 {0}%", Math.round(progress * 100))}</span><button type="button" onClick={cancelUpload}>{t("取消上传")}</button></div>}
    <div className="hold-voice-controls">
      <button type="button" className="icon-button voice-keyboard" disabled={busy || uploading} aria-label={t("切换到键盘")} onClick={close}><Keyboard size={22}/></button>
      <button type="button" className="hold-voice-button" aria-label={t("按住说话")} aria-describedby={helpId} disabled={disabled || uploading} aria-pressed={busy}
        onContextMenu={event => event.preventDefault()} onClick={event => event.preventDefault()}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary || press.current || busy) return;
          event.preventDefault(); event.currentTarget.focus();
          press.current = { pointer: event.pointerId, y: event.clientY, cancel: false }; setCancelling(false);
          event.currentTarget.setPointerCapture(event.pointerId); start();
        }}
        onPointerMove={event => { const held = press.current; if (held?.pointer !== event.pointerId) return; held.cancel = held.y - event.clientY >= 64; setCancelling(held.cancel); }}
        onPointerUp={event => { if (press.current?.pointer === event.pointerId) { event.preventDefault(); release(); } }}
        onPointerCancel={event => { if (press.current?.pointer === event.pointerId) cancel(); }}
        onLostPointerCapture={event => { if (press.current?.pointer === event.pointerId) cancel(); }}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
          if (![" ", "Enter"].includes(event.key)) return; event.preventDefault();
          if (event.repeat || press.current || busy) return;
          press.current = { key: event.key, y: 0, cancel: false }; start();
        }}
        onKeyUp={event => { if (press.current?.key === event.key) { event.preventDefault(); release(); } }}
        onBlur={() => { if (press.current?.key) cancel(); }}>
        <Mic size={25}/><span>{uploading ? t("正在发送…") : cancelling ? t("松开取消") : busy ? t("松开发送") : t("按住说话")}</span>
      </button>
    </div>
    <span id={helpId} className="screen-reader-only">{t("按住空格或回车录音，松开发送；按 Esc 取消。")}</span>
  </section>;
}
