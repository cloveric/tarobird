import path from "node:path";
import type { CoreServiceRuntime } from "../core/runtime.js";
import { loadInstanceConfig } from "../state/instance-config.js";
import { createDefaultTranscribeVoice } from "../core/voice.js";
import { isPartialMediaTranscriptionError } from "../runtime/media-transcript.js";
import type { GatewayChannel } from "./channel.js";
import { isGeneratedVoiceFilename } from "../client-protocol/voice-presentation.js";
import { isCloudAsrRequiredError } from "../runtime/asr-cloud.js";
import { renderCoreAudioTranscriptionFailure } from "../core/locale.js";

/** Per-message wrapper; it must not replace the transcriber on a shared Feishu
 * runtime or capture the wrong conversation when two Bots are working. */
export function gatewayMediaRuntime(runtime: CoreServiceRuntime, channel: GatewayChannel, stateDir: string, chatId: string, replyTo: string): CoreServiceRuntime {
  const transcribe = runtime.transcribeMedia ?? createDefaultTranscribeVoice();
  return Object.assign(Object.create(runtime) as CoreServiceRuntime, {
    transcribeMedia: async (file: string, options: Parameters<typeof transcribe>[1]) => {
      const en = (await loadInstanceConfig(stateDir)).locale === "en";
      const card = (title: string, body: string) => ({ schema: "2.0", config: { update_multi: true }, body: { elements: [
        { tag: "markdown", content: `**${title}**` },
        ...(!isGeneratedVoiceFilename(path.basename(file)) ? [{ tag: "div", text: { tag: "plain_text", content: path.basename(file) } }] : []),
        { tag: "markdown", content: body },
      ] } });
      // Status delivery is best effort; it cannot turn a successful transcription
      // into a failure or prevent cancellation when the client disconnects.
      const progress = await channel.send(chatId, { card: card(en ? "Transcribing audio…" : "正在转写音频…", en ? "The Bot will continue automatically. Use Stop to cancel." : "完成后 Bot 会自动继续；可点输入框旁的停止按钮取消。") }, { replyTo }).catch(() => undefined);
      const update = async (title: string, body: string) => { if (progress) await channel.updateCard(progress.messageId, card(title, body)).catch(() => undefined); };
      const excerpt = (text: string) => text.length > 2000 ? `${text.slice(0, 2000)}\n\n${en ? "Preview only. The full transcript was passed to the Bot." : "这里只显示前 2000 字，完整转写已交给 Bot。"}` : text;
      try {
        const text = await transcribe(file, options);
        await update(text.trim() ? (en ? "Audio transcription complete" : "音频转写完成") : (en ? "No speech recognized" : "未识别到语音"), excerpt(text) || (en ? "Check the recording and try again." : "请检查录音内容后重试。"));
        return text;
      } catch (error) {
        const partial = isPartialMediaTranscriptionError(error);
        await update(options?.abortSignal?.aborted ? (en ? "Transcription stopped" : "已停止转写") : partial ? (en ? "Partial transcription" : "部分转写完成") : (en ? "Transcription unavailable" : "转写未完成"), partial ? `${en ? "Missing segments" : "缺失片段"}: ${error.failedChunkNumbers.join(", ")} / ${error.totalChunks}\n\n${excerpt(error.transcript)}` : isCloudAsrRequiredError(error) && !options?.abortSignal?.aborted ? renderCoreAudioTranscriptionFailure(en ? "en" : "zh", error.reason) : (en ? "The original recording remains in this conversation." : "原录音仍保留在对话中。"));
        throw error;
      }
    },
  });
}
