import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic } from "lucide-react";
import { VoiceRecordingPanel } from "./HoldToTalk.js";
import { t } from "./i18n.js";
import type { useVoiceRecorder } from "./useVoiceRecorder.js";

/** Keep the pressed button mounted: changing composer mode mid-gesture loses
 * pointer capture and can invalidate the recorder's originating draft. */
export function VoiceMicButton({ voice, disabled, open, start }: {
  voice: ReturnType<typeof useVoiceRecorder>; disabled: boolean; open: () => void; start: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const press = useRef<{ pointer: number; x: number; y: number; held: boolean; moved: boolean; cancel: boolean } | undefined>(undefined);
  const nativeTap = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ start }); latest.current = { start };
  const [cancelling, setCancelling] = useState(false);
  const reset = () => { clearTimeout(timer.current); timer.current = undefined; press.current = undefined; nativeTap.current = false; setCancelling(false); };
  const cancel = () => { const held = press.current?.held; reset(); if (held) voice.cancel(); };
  useEffect(() => { if (voice.phase === "idle") reset(); }, [voice.phase]);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  useEffect(() => {
    const interrupted = () => cancel();
    const hidden = () => { if (document.visibilityState === "hidden") cancel(); };
    window.addEventListener("blur", interrupted); document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", interrupted); document.removeEventListener("visibilitychange", hidden);
      clearTimeout(timer.current); if (press.current?.held) voice.cancel();
    };
  }, [voice.cancel]);
  const portal = button.current?.closest(".composer-wrap");
  return <>
    <button ref={button} type="button" className={`icon-button voice-mic-shortcut${voice.busy ? " recording" : ""}`}
      title={t("轻点切换语音，长按说话")} aria-label={t("录制语音")} aria-description={t("轻点切换语音，长按说话")} aria-pressed={voice.busy} disabled={disabled}
      onContextMenu={event => event.preventDefault()}
      onClick={event => {
        event.preventDefault(); const acceptedTap = nativeTap.current; nativeTap.current = false;
        if (!voice.busy && (event.detail === 0 || acceptedTap)) open();
      }}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || press.current || voice.busy) return;
        event.preventDefault();
        nativeTap.current = false;
        const gesture = { pointer: event.pointerId, x: event.clientX, y: event.clientY, held: false, moved: false, cancel: false };
        press.current = gesture; event.currentTarget.setPointerCapture(event.pointerId);
        timer.current = setTimeout(() => {
          if (press.current !== gesture) return;
          gesture.held = true; latest.current.start();
        }, 350);
      }}
      onPointerMove={event => {
        const gesture = press.current; if (gesture?.pointer !== event.pointerId) return;
        if (!gesture.held) {
          if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 12) {
            // Movement cancels the long-press timer. Keep the pointer until
            // release: the browser may still recognize a legitimate tap.
            clearTimeout(timer.current); timer.current = undefined; gesture.moved = true;
          }
          return;
        }
        gesture.cancel = gesture.y - event.clientY >= 64; setCancelling(gesture.cancel);
      }}
      onPointerUp={event => {
        const gesture = press.current; if (gesture?.pointer !== event.pointerId) return;
        event.preventDefault(); reset();
        if (!gesture.held) {
          if (gesture.moved) nativeTap.current = true;
          else open();
        }
        else if (gesture.cancel) voice.cancel();
        else voice.finishHeld();
      }}
      onPointerCancel={event => { if (press.current?.pointer === event.pointerId) cancel(); }}
      onLostPointerCapture={event => { if (press.current?.pointer === event.pointerId) cancel(); }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }}>
      <Mic size={18}/>
    </button>
    {voice.busy && portal && createPortal(<div className={`hold-voice mic-hold-panel${cancelling ? " is-cancelling" : ""}`} aria-label={t("语音输入")}>
      <VoiceRecordingPanel voice={voice} cancelling={cancelling}/>
    </div>, portal)}
  </>;
}
