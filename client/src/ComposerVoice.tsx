import { Mic } from "lucide-react";
import { VoiceWaveform } from "./HoldToTalk.js";
import { useVoiceRecorder } from "./useVoiceRecorder.js";
import { t } from "./i18n.js";

type Voice = ReturnType<typeof useVoiceRecorder>;
export function ComposerVoiceButton({ busy, disabled, start, title = t("录制语音") }: { busy: boolean; disabled: boolean; title?: string; start(): void }) {
  return <button type="button" className={`icon-button ${busy ? "recording" : ""}`} title={title} aria-label={t("录制语音")} disabled={disabled || busy} onClick={start}><Mic size={18}/></button>;
}
export function ComposerVoiceRecording({ voice }: { voice: Voice }) {
  return <section className="voice-recording" aria-label={t("录制语音")}><span className="voice-recording-dot"/><strong>{voice.phase === "requesting" ? t("等待麦克风权限…") : voice.phase === "stopping" ? t("正在保存录音…") : t("正在录音")}</strong><time aria-label={t("录音时长")}>{Math.floor(voice.seconds / 60).toString().padStart(2, "0")}:{(voice.seconds % 60).toString().padStart(2, "0")}</time><VoiceWaveform meter={voice.meter} recording={voice.phase === "recording"}/><button type="button" onClick={voice.cancel}>{t("取消录音")}</button><button type="button" className="primary" disabled={voice.phase !== "recording"} onClick={voice.finish}>{t("完成录音")}</button></section>;
}
