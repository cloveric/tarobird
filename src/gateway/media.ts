import path from "node:path";
import type { CoreServiceRuntime } from "../core/runtime.js";
import { loadInstanceConfig } from "../state/instance-config.js";
import { createDefaultTranscribeVoice } from "../core/voice.js";
import { isPartialMediaTranscriptionError } from "../runtime/media-transcript.js";
import type { GatewayChannel } from "./channel.js";
import { isGeneratedVoiceFilename } from "../client-protocol/voice-presentation.js";
import { isCloudAsrRequiredError } from "../runtime/asr-cloud.js";
import { renderCoreAudioTranscriptionFailure } from "../core/locale.js";
import { buildCoreConversationKey } from "../core/message-normalizer.js";
import { hostT } from "../locales/index.js";

/** Per-message wrapper; it must not replace the transcriber on a shared Feishu
 * runtime or capture the wrong conversation when two Bots are working. */
export function gatewayMediaRuntime(runtime: CoreServiceRuntime, channel: GatewayChannel, stateDir: string, chatId: string, replyTo: string): CoreServiceRuntime {
  const transcribe = runtime.transcribeMedia ?? createDefaultTranscribeVoice();
  return Object.assign(Object.create(runtime) as CoreServiceRuntime, {
    transcribeMedia: async (file: string, options: Parameters<typeof transcribe>[1]) => {
      options?.abortSignal?.throwIfAborted();
      const { locale } = await loadInstanceConfig(stateDir);
      const startedAt = Date.now();
      const card = (title: string, body: string, active: boolean) => ({ schema: "2.0", appTranscription: { version: 1, active, at: startedAt }, config: { update_multi: true }, body: { elements: [
        { tag: "markdown", content: `**${title}**` },
        ...(!isGeneratedVoiceFilename(path.basename(file)) ? [{ tag: "div", text: { tag: "plain_text", content: path.basename(file) } }] : []),
        { tag: "markdown", content: body },
      ] } });
      // Status delivery is best effort; it cannot turn a successful transcription
      // into a failure or prevent cancellation when the client disconnects.
      const progress = await channel.send(chatId, { card: card(hostT(locale, "正在转写音频…"), hostT(locale, "完成后 Bot 会自动继续；可点输入框旁的停止按钮取消。"), true) }, { replyTo }).catch(() => undefined);
      const conversationKey = buildCoreConversationKey(chatId);
      const activeRun = progress && options?.abortSignal
        ? [runtime.activeRuns.get(conversationKey), ...(runtime.concurrentRuns.get(conversationKey) ?? [])]
            .find((run) => run?.abortController.signal === options.abortSignal)
        : undefined;
      if (activeRun) activeRun.hasRunCard = true;
      let stoppedCardRendered = false;
      const update = async (title: string, body: string): Promise<boolean> => {
        if (!progress) return false;
        try {
          await channel.updateCard(progress.messageId, card(title, body, false));
          return true;
        } catch (error) {
          // Do not mask a transport stop into a completed message receipt when
          // the terminal transcription card update was lost before journaling.
          if (error instanceof Error && error.message === "gateway_stopped") throw error;
          return false;
        }
      };
      const excerpt = (text: string) => text.length > 2000 ? `${text.slice(0, 2000)}\n\n${hostT(locale, "这里只显示前 2000 字，完整转写已交给 Bot。")}` : text;
      let text: string;
      try {
        options?.abortSignal?.throwIfAborted();
        text = await transcribe(file, options);
        options?.abortSignal?.throwIfAborted();
        await update(hostT(locale, text.trim() ? "音频转写完成" : "未识别到语音"), excerpt(text) || hostT(locale, "请检查录音内容后重试。"));
      } catch (error) {
        if (error instanceof Error && error.message === "gateway_stopped") throw error;
        const partial = isPartialMediaTranscriptionError(error);
        const aborted = Boolean(options?.abortSignal?.aborted);
        const updated = await update(
          hostT(locale, aborted ? "已停止转写" : partial ? "部分转写完成" : "转写未完成"),
          partial
            ? `${hostT(locale, "缺失片段")}: ${error.failedChunkNumbers.join(", ")} / ${error.totalChunks}\n\n${excerpt(error.transcript)}`
            : isCloudAsrRequiredError(error) && !aborted
              ? renderCoreAudioTranscriptionFailure(locale, error.reason)
              : hostT(locale, "原录音仍保留在对话中。"),
        );
        if (aborted && updated) stoppedCardRendered = true;
        throw error;
      } finally {
        if (activeRun && !stoppedCardRendered) activeRun.hasRunCard = false;
      }
      options?.abortSignal?.throwIfAborted();
      return text;
    },
  });
}
