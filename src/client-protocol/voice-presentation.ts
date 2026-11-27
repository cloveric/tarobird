import { z } from "zod";
import type { Block, CardElement } from "./index.js";

/** Gateway-authored marker for an in-flight Host audio transcription card. */
export const transcriptionStateSchema = z.object({
  version: z.literal(1),
  active: z.boolean(),
  at: z.number().int().nonnegative().optional(),
}).strict();
export type TranscriptionState = z.infer<typeof transcriptionStateSchema>;

export function transcriptionState(block: Extract<Block, { type: "card" }>): TranscriptionState | undefined {
  const parsed = transcriptionStateSchema.safeParse(block.extra?.appTranscription);
  return parsed.success ? parsed.data : undefined;
}

export function isTranscriptionMessage(message: { blocks: readonly Block[] }): boolean {
  return message.blocks.some(block => block.type === "card" && block.extra?.appTranscription !== undefined);
}

export function isActiveTranscriptionMessage(message: { status: string; forwardedFrom?: unknown; blocks: readonly Block[] }): boolean {
  if (message.forwardedFrom || !["pending", "streaming"].includes(message.status)) return false;
  return message.blocks.some(block => block.type === "card" && transcriptionState(block)?.active === true);
}

export const isGeneratedVoiceFilename = (name: string): boolean => /^voice-\d{10,}\.(?:m4a|mp4|webm|ogg|wav)$/i.test(name);

/** Explicit recording flag wins; legacy App recordings fall back to the
 * recorder's generated `voice-<timestamp>.<ext>` name. */
export function isRecordedVoiceBlock(block: { type: string; name?: string; recording?: boolean }): boolean {
  if (block.type !== "audio") return false;
  if (block.recording !== undefined) return block.recording;
  return !!block.name && isGeneratedVoiceFilename(block.name);
}

/** Older hosts include an internal recording name in ASR cards. Keep cached
 * history and copy/forward data intact; omit only that known metadata row. */
export function voiceCardElements(elements: CardElement[]): CardElement[] {
  const [heading, filename, transcript] = elements;
  if (elements.length !== 3 || heading?.type !== "markdown" || filename?.type !== "markdown" || transcript?.type !== "markdown") return elements;
  if (!/^\*\*(?:音频转写完成|正在转写音频…|未识别到语音|已停止转写|转写已中断|部分转写完成|转写未完成|Audio transcription complete|Transcribing audio…|No speech recognized|Transcription stopped|Transcription interrupted|Partial transcription|Transcription unavailable)\*\*$/.test(heading.text ?? "")) return elements;
  return isGeneratedVoiceFilename(filename.text ?? "") ? [heading, transcript] : elements;
}
