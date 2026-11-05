import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n.js";
import { createVoiceMeter, type VoiceMeter } from "./voice-meter.js";

type Phase = "idle" | "requesting" | "recording" | "stopping";
type Capture = { generation: number; recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; bytes: number; started: number; discard: boolean; finishing: boolean; released: boolean; delivered: boolean; held: boolean; send: boolean; meter?: VoiceMeter; timer?: ReturnType<typeof setInterval> };
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;
export function useVoiceRecorder(conversationId: string, captured: (file: File, send: boolean) => void, failed: (message: string) => void) {
  const [phase, setPhase] = useState<Phase>("idle"), [seconds, setSeconds] = useState(0);
  const generation = useRef(0), active = useRef<Capture | undefined>(undefined), alive = useRef(true), pending = useRef(false);
  const pendingMeter = useRef<VoiceMeter | undefined>(undefined);
  const callbacks = useRef({ captured, failed }); callbacks.current = { captured, failed };
  const release = (capture: Capture) => { if (capture.released) return; capture.released = true; clearInterval(capture.timer); capture.meter?.close(); for (const track of capture.stream.getTracks()) { track.onended = null; if (track.readyState !== "ended") track.stop(); } };
  const cancel = useCallback(() => {
    pendingMeter.current?.close(); pendingMeter.current = undefined;
    generation.current++; pending.current = false; const capture = active.current; active.current = undefined;
    if (capture) { capture.discard = true; if (capture.recorder.state !== "inactive") capture.recorder.stop(); release(capture); }
    if (alive.current) { setPhase("idle"); setSeconds(0); }
  }, []);
  useEffect(() => {
    alive.current = true; setPhase("idle"); setSeconds(0);
    return () => {
      alive.current = false;
      // Explicitly finished audio has already been accepted for the originating
      // draft. Let its encoder deliver there after navigation, but detach it so
      // its late callbacks cannot change the next conversation's recorder.
      if (active.current?.finishing && !active.current.discard) {
        active.current.send = false; // Navigation may preserve a draft, never send late.
        release(active.current); active.current = undefined;
        generation.current++; pending.current = false;
      } else cancel();
    };
  }, [conversationId, cancel]);
  const finish = useCallback(() => {
    const capture = active.current; if (!capture) return;
    if (capture.finishing) { capture.send = false; return; }
    if (capture.held) { cancel(); return; }
    capture.finishing = true; setPhase("stopping");
    if (capture.recorder.state !== "inactive") capture.recorder.stop();
    release(capture);
  }, [cancel]);
  const finishHeld = useCallback(() => {
    const capture = active.current;
    if (!capture || capture.finishing) { if (pending.current) cancel(); return; }
    if (performance.now() - capture.started < 600) {
      cancel(); callbacks.current.failed(t("说话时间太短，请按住再说一次。")); return;
    }
    capture.send = true; capture.finishing = true; setPhase("stopping");
    if (capture.recorder.state !== "inactive") capture.recorder.stop();
    release(capture);
  }, [cancel]);
  useEffect(() => {
    // Mobile OSes can suspend a background WebView without a final event. On
    // hiding, cancel a held capture (no release gesture); finish desktop drafts.
    const hidden = () => { if (document.visibilityState === "hidden") { if (active.current) finish(); else if (pending.current) cancel(); } };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [cancel, finish]);
  const startCapture = useCallback(async (held: boolean) => {
    if (pending.current || active.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { callbacks.current.failed(t("当前环境不支持录音，请使用添加文件发送音频。")); return; }
    pending.current = true; setPhase("requesting"); setSeconds(0); const current = ++generation.current, origin = callbacks.current; let stream: MediaStream | undefined;
    let meter: VoiceMeter | undefined;
    try { meter = createVoiceMeter(); pendingMeter.current = meter; } catch { /* Recording still works without Web Audio metering. */ }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (current !== generation.current || !alive.current) { meter?.close(); stream.getTracks().forEach((track) => track.stop()); return; }
      pendingMeter.current = undefined;
      try { meter?.connect(stream); } catch { meter?.close(); meter = undefined; }
      // Let the MP4 encoder choose its native codec. Some Chromium builds report
      // explicit AAC as supported, then fail asynchronously when recording starts.
      const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"].find((mime) => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000 });
      const capture: Capture = { generation: current, recorder, stream, chunks: [], bytes: 0, started: performance.now(), discard: false, finishing: false, released: false, delivered: false, held, send: false, meter }; active.current = capture;
      recorder.ondataavailable = ({ data }) => { if (data.size && !capture.discard) { capture.chunks.push(data); capture.bytes += data.size; if (capture.bytes >= MAX_RECORDING_BYTES && recorder.state !== "inactive") { origin.failed(t("录音已达到 64 MB，已结束并保留，可试听后发送。")); capture.finishing = true; setPhase("stopping"); recorder.stop(); release(capture); } } };
      recorder.onstop = () => {
        release(capture);
        if (capture.delivered || capture.discard || (!capture.finishing && (current !== generation.current || !alive.current))) return;
        capture.delivered = true;
        if (active.current === capture) { active.current = undefined; pending.current = false; if (alive.current) setPhase("idle"); }
        if (!capture.bytes) { origin.failed(t("没有录到声音，请重试。")); return; }
        const mime = recorder.mimeType || mimeType || "audio/webm", extension = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
        origin.captured(new File(capture.chunks, `voice-${Date.now()}.${extension}`, { type: mime }), capture.send);
      };
      recorder.onerror = () => {
        if (capture.delivered || capture.discard) return;
        capture.discard = true; if (recorder.state !== "inactive") recorder.stop(); release(capture);
        if (active.current === capture) { active.current = undefined; pending.current = false; if (alive.current) setPhase("idle"); }
        origin.failed(t("录音中断，请检查麦克风后重试。"));
      };
      for (const track of stream.getAudioTracks()) track.onended = () => { if (active.current === capture) finish(); };
      recorder.start(1000); capture.timer = setInterval(() => setSeconds(Math.floor((performance.now() - capture.started) / 1000)), 250); pending.current = false; setPhase("recording");
    } catch (error) {
      meter?.close();
      stream?.getTracks().forEach((track) => track.stop());
      if (current !== generation.current || !alive.current) return;
      active.current = undefined; pending.current = false; pendingMeter.current = undefined; setPhase("idle");
      callbacks.current.failed(error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name) ? t("请在系统或浏览器设置中允许麦克风，然后重试。") : t("无法打开麦克风，请检查设备或上传已有音频文件。"));
    }
  }, [cancel, finish]);
  const start = useCallback(() => startCapture(false), [startCapture]);
  const startHeld = useCallback(() => startCapture(true), [startCapture]);
  return { phase, seconds, busy: phase !== "idle", meter: phase === "recording" ? active.current?.meter : undefined, start, startHeld, finish, finishHeld, cancel };
}
