import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderBackgroundTaskHeader } from "../runtime/background-task-header.js";
import type { Locale } from "../runtime/locale.js";

export async function readRawCoreConfig(stateDir: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function resolveCoreLocale(stateDir: string): Promise<Locale> {
  const rawConfig = await readRawCoreConfig(stateDir);
  return rawConfig.locale === "en" ? "en" : "zh";
}

/** Shared with the Telegram channel so the two cannot disagree on a status. */
export function renderCoreBackgroundTaskHeader(locale: Locale, status?: string): string {
  return renderBackgroundTaskHeader(locale, status);
}

export function renderCoreStopResult(stopped: boolean, locale: Locale): string {
  if (locale === "en") {
    return stopped ? "Stopped." : "No active task.";
  }
  return stopped ? "已停止。" : "当前没有正在运行的任务。";
}

export function renderCoreQueuedTaskSkipped(locale: Locale): string {
  return locale === "en" ? "Queued task skipped." : "已跳过排队中的任务。";
}

export function renderCoreConversationQueueWait(locale: Locale): string {
  return locale === "en"
    ? "Another task is still running in this conversation. This message is queued; send `/stop` if the previous task is stuck."
    : "同一个会话里还有任务在运行，这条消息已排队；如果前一个任务卡住，请发送 `/stop` 取消。";
}

export function renderCoreTurnPoolWait(locale: Locale): string {
  return locale === "en"
    ? "All AI worker slots are busy. This message is queued and will continue when capacity frees up."
    : "当前 AI worker 名额已满，这条消息已排队；有空位后会继续处理。";
}

export function renderCoreAudioTranscriptionFailure(locale: Locale, cloudOnly: false | "failed" | "empty" | "audio" = false): string {
  if (cloudOnly === "empty") return locale === "en" ? "Cloud transcription returned no text. The recording may be silent or the result format may have changed. The original recording is still available." : "云端未返回转写文字，可能是静音录音或结果格式变化，原录音仍保留。";
  if (cloudOnly === "audio") return locale === "en" ? "Usable audio could not be verified or extracted. The original file was not uploaded. Check the host's audio tools (ffprobe / ffmpeg) and try again." : "未能确认或提取可用音频，原文件未上传云端。请检查主机的音频处理组件（ffprobe / ffmpeg）后重试。";
  if (cloudOnly) return locale === "en"
    ? "Cloud transcription failed. This host uses cloud-only transcription, so local transcription was not attempted. Check the Tongyi configuration or try again later. The original recording is still available."
    : "云端语音转写失败。当前主机选择了全部云端，因此未切换到本地。请检查通义配置或稍后重试，原录音仍保留。";
  return locale === "en"
    ? "Audio transcription failed. Please send text or a shorter audio file."
    : "音频转写失败，请发送文字消息或较短的音频文件。";
}

export function renderCoreCronRuntimeMissing(locale: Locale): string {
  return locale === "en"
    ? "Lark cron runtime is not started. Restart the Lark service and try again."
    : "Lark cron runtime 尚未启动。请重启 Lark service 后再试。";
}

export function renderCoreApprovalExpired(locale: Locale): string {
  return locale === "en" ? "Approval expired (denied)." : "审批已过期，已拒绝。";
}

export function renderCoreChatAccessDenied(locale: Locale): string {
  return locale === "en" ? "Current chat is not authorized." : "当前聊天未获授权。";
}

export function renderCoreUserAccessDenied(locale: Locale): string {
  return locale === "en" ? "Current user is not authorized." : "当前用户未获授权。";
}

export function renderCoreOperatorAccessDenied(locale: Locale): string {
  return locale === "en" ? "Current operator is not authorized." : "当前操作者未获授权。";
}
