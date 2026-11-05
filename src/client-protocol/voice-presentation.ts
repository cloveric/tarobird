import type { CardElement } from "./index.js";

export const isGeneratedVoiceFilename = (name: string): boolean => /^voice-\d{10,}\.(?:m4a|mp4|webm|ogg|wav)$/i.test(name);

/** Older hosts include an internal recording name in ASR cards. Keep cached
 * history and copy/forward data intact; omit only that known metadata row. */
export function voiceCardElements(elements: CardElement[]): CardElement[] {
  const [heading, filename, transcript] = elements;
  if (elements.length !== 3 || heading?.type !== "markdown" || filename?.type !== "markdown" || transcript?.type !== "markdown") return elements;
  if (!/^\*\*(?:音频转写完成|正在转写音频…|未识别到语音|已停止转写|部分转写完成|转写未完成|Audio transcription complete|Transcribing audio…|No speech recognized|Transcription stopped|Partial transcription|Transcription unavailable)\*\*$/.test(heading.text ?? "")) return elements;
  return isGeneratedVoiceFilename(filename.text ?? "") ? [heading, transcript] : elements;
}
