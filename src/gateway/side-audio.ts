import { writeFile } from "node:fs/promises";
import type { EngineSideAttachment } from "../codex/adapter.js";
import type { SideAttachmentRef } from "../client-protocol/side.js";
import { SideSessionError } from "../core/side-sessions.js";
import { SIDE_INLINE_TEXT_LIMIT } from "../core/side-attachments.js";
import { isCloudAsrCancelledError, type TranscribeMediaOptions } from "../runtime/asr-cloud.js";
import { hasTranscribableAudioExtension } from "../runtime/media-extensions.js";
import { formatBridgeMediaTranscript, formatBridgePartialMediaTranscript, isPartialMediaTranscriptionError } from "../runtime/media-transcript.js";

export type SideTranscribe = (file: string, options?: TranscribeMediaOptions) => Promise<string>;

/** Audio an engine could otherwise receive only as opaque bytes. Video keeps
 * its existing binary delivery: this is not a frame or video pipeline. */
export function isSideAudio(file: EngineSideAttachment, ref: SideAttachmentRef): boolean {
  return file.kind === "binary" && (/^audio\//i.test(ref.mime) || hasTranscribableAudioExtension(ref.name));
}

/** Replaces verified private audio copies with host-ASR transcripts, through
 * the main conversation's transcriber and cloud routing. Nothing is published
 * or kept: no progress card, message, parent-session input or host transcript
 * cache entry; the transcript lives beside the private copy until release.
 * A failed or empty transcription throws before any engine call, so the
 * question stays retryable; the turn's signal stops the ASR itself. */
export async function transcribeSideAudio(input: {
  files: EngineSideAttachment[]; refs: SideAttachmentRef[]; transcribe: SideTranscribe;
  stateDir: string; question?: () => string | undefined; signal: AbortSignal;
}): Promise<EngineSideAttachment[]> {
  // Transcripts share the inline budget left after ordinary text attachments.
  let budget = SIDE_INLINE_TEXT_LIMIT - input.files.reduce((sum, file) => sum + (file.kind === "text" ? file.text?.length ?? 0 : 0), 0);
  const result: EngineSideAttachment[] = [];
  for (const file of input.files) {
    const ref = input.refs.find(item => item.id === file.attachmentId);
    if (!ref || !isSideAudio(file, ref)) { result.push(file); continue; }
    input.signal.throwIfAborted();
    let block: string;
    try {
      const messageText = input.question?.();
      // Declared type alone never skips the stream check before a cloud upload.
      const mediaKind = /^audio\//i.test(ref.mime) && hasTranscribableAudioExtension(ref.name) ? "audio" : "unknown";
      block = formatBridgeMediaTranscript(ref.name, await input.transcribe(file.path, { ...(messageText ? { messageText } : {}), mediaKind, stateDir: input.stateDir, abortSignal: input.signal }));
    } catch (error) {
      if (input.signal.aborted) throw error;
      if (isCloudAsrCancelledError(error)) throw new SideSessionError("cancelled");
      if (!isPartialMediaTranscriptionError(error)) throw new SideSessionError("failed");
      // As in the main conversation, usable speech survives with its gaps marked.
      block = formatBridgePartialMediaTranscript(ref.name, error.transcript, error.failedChunkNumbers, error.totalChunks);
    }
    if (!block) throw new SideSessionError("failed");
    input.signal.throwIfAborted();
    // Path-reading engines open the transcript, never the opaque recording.
    const path = `${file.path}.transcript.txt`;
    await writeFile(path, block, { flag: "wx", mode: 0o600 });
    const text = block.slice(0, Math.max(0, budget));
    budget -= text.length;
    result.push({ attachmentId: file.attachmentId, path, name: file.name, mime: "text/plain", size: Buffer.byteLength(block), kind: "text", text, ...(text.length < block.length ? { partial: true } : {}) });
  }
  return result;
}
