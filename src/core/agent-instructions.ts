import { existsSync } from "node:fs";
import path from "node:path";

import { platformPolicy } from "./platform-policy.js";

import { readCloudAsrConfig } from "../runtime/asr-cloud.js";
import { BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER } from "../runtime/media-transcript.js";
import type { InstanceEngine } from "../state/instance-config.js";

/**
 * Whether this machine has a local speech-to-text backend the agent can call
 * itself. Use the same install/legacy path precedence as the voice router.
 * Gating on real availability keeps the instruction
 * out of the prompt on machines without it (so it never misleads), and keeps it
 * absent in tests/CI (no env, no CLI files) so the prompt-length bound is stable.
 */
function localAsrCommand(): string | undefined {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const installed = home ? path.join(home, ".tarobot/integrations/qwen3-asr") : undefined;
  const legacy = home ? path.join(home, "projects/qwen3-asr") : undefined;
  const useLegacy = !!legacy && !!installed && !existsSync(path.join(installed, "transcribe.py")) && existsSync(path.join(legacy, "transcribe.py"));
  const python = process.env.ASR_CLI_PYTHON
    ?? (useLegacy ? path.join(legacy!, "venv/bin/python3") : installed ? path.join(installed, ".venv/bin/python") : undefined);
  const script = process.env.ASR_CLI_SCRIPT
    ?? (useLegacy ? path.join(legacy!, "transcribe.py") : installed ? path.join(installed, "transcribe.py") : undefined);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const cli = python && script && existsSync(python) && existsSync(script)
    ? `${quote(python)} ${quote(script)} "<absolute-path>"` : undefined;
  const configuredHttp = process.env.ASR_HTTP_URL?.trim();
  if (!configuredHttp && !cli) return undefined;
  // Empty HTTP is an explicit opt-out, not a request for the default endpoint.
  const httpUrl = configuredHttp ?? "http://127.0.0.1:8412/transcribe";
  if (!httpUrl) return cli;
  const http = `curl -fsS ${quote(httpUrl)} -H 'Content-Type: application/json' -d '{"path":"<absolute-path>"}'`;
  return cli ? `${http}; if HTTP unavailable: ${cli}` : http;
}

/**
 * Tells the agent to use the machine-local ASR for transcription it does
 * itself (e.g. summarizing a video/voice file it downloaded) instead of reaching
 * for whisper/mlx_whisper/parakeet and giving up when none are found. Returns
 * undefined when no local ASR is available, so it is never injected on machines
 * that can't honor it. The endpoint is read from env (not hard-coded), so this is
 * safe to ship — it only appears where an ASR is actually configured/installed.
 */
/** Default must match the ASR service's own ASR_MAX_AUDIO_SECONDS. */
const DEFAULT_ASR_MAX_AUDIO_SECONDS = 300;

function localAsrMaxAudioSeconds(): number {
  const raw = Number.parseInt((process.env.ASR_MAX_AUDIO_SECONDS ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ASR_MAX_AUDIO_SECONDS;
}

function localAsrSegmentSeconds(maxSeconds: number): number {
  // Container timestamps can push a nominally exact segment slightly over the
  // service cap, so retain headroom instead of segmenting at the rejection edge.
  return Math.max(1, Math.floor(maxSeconds * 0.9));
}

function formatAsrThreshold(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}

/** Kept for existing integrations/tests; cloud routing is now read per turn. */
export function resetCloudAsrConfiguredCacheForTests(): void {}

export function localAsrAgentInstruction(): string | undefined {
  const cloudConfig = readCloudAsrConfig(process.env);
  if (cloudConfig?.mode === "cloud") {
    const argv = JSON.stringify([cloudConfig.pythonPath, cloudConfig.scriptPath, "--file", "<absolute media path>", "--source-language", "auto", "--wait", "--out-dir", "<workspace job dir>"]);
    return `Fetched media: all audio uses Aliyun Tingwu (argv, not shell): ${argv}; use transcription.txt; before uploading video, extract only audio locally with ffmpeg -vn -sn -dn -map_metadata -1; never upload the original video for ASR; do NOT read/copy credentials. Report cloud failures; do not fall back to local ASR. Host all-cloud mode overrides duration and routing keywords. "[${BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER}]" final; do NOT inspect/probe/split/re-transcribe unless asked; transcribe only media marked unavailable unless its marker explicitly forbids retry/upload; respect that restriction.`;
  }
  const command = localAsrCommand();
  if (!command) {
    return undefined;
  }
  const maxSeconds = localAsrMaxAudioSeconds();
  const segmentSeconds = localAsrSegmentSeconds(maxSeconds);
  // The length bound is not cosmetic. The ASR serializes inference behind one
  // global lock, and an over-long request wedged the model in an uninterruptible
  // MPS wait — the lock was never released, so EVERY instance's transcription
  // then timed out. The service now rejects over-long input outright; this tells
  // the agent where the edge is and what to do at it, so a rejection becomes a
  // split-and-retry instead of a reported failure.
  // Without this, a user-sent recording that arrived as a FILE got transcribed
  // locally (slowly, chunked) even though the bridge had already routed it —
  // the "use it FIRST" rule read as an instruction to do so.
  const localRoute = `local Qwen: ${command}; Max ${maxSeconds}s per request (shared model). >${maxSeconds}s: ffmpeg -i "<in>" -vn -ac 1 -ar 16000 -c:a pcm_s16le -f segment -segment_time ${segmentSeconds} part_%03d.wav; transcribe parts.`;
  if (!cloudConfig) {
    return `Use ${localRoute} do NOT use whisper/mlx_whisper/parakeet. Never retry longer input as-is; frames/OCR if ASR fails.`;
  }

  const threshold = formatAsrThreshold(cloudConfig.thresholdSeconds);
  // Use the resolved policy paths, not stale process env. An argv description
  // keeps quotes/metacharacters in a configured directory from becoming shell.
  const cloudCommand = JSON.stringify([
    cloudConfig.pythonPath, cloudConfig.scriptPath, "--file", "<absolute media path>",
    "--source-language", "auto", "--wait", "--out-dir", "<workspace job dir>",
  ]);
  return `Fetched media: probe duration; >=${threshold}: Aliyun Tingwu first (argv, not shell): ${cloudCommand}; use transcription.txt; before uploading video, extract only audio locally with ffmpeg -vn -sn -dn -map_metadata -1; never upload the original video for ASR; do NOT read/copy its credentials. Shorter/cloud fails: ${localRoute} do NOT use whisper/mlx_whisper/parakeet or claim no ASR. Never retry longer input as-is. "[${BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER}]" final; do NOT inspect/probe/split/re-transcribe unless asked; transcribe only media marked unavailable unless its marker explicitly forbids retry/upload; respect that restriction.`;
}

/**
 * Cloud long-audio routing note (Aliyun Tingwu). Gated ONLY on TINGWU_ASR_DIR —
 * the cloud path is what the bridge itself does to inbound audio and works with
 * or without a local ASR backend, so hiding it behind local-ASR availability
 * made the bot deny a capability it has.
 *
 * The wording must match reality: a bare voice message carries no caption, so
 * the force keywords only reach the router when they travel WITH the audio
 * (caption, or a text message in the same attachment burst). A keyword sent
 * afterwards is a new turn and cannot reroute a transcription already running.
 */
export function cloudAsrAgentInstruction(): string | undefined {
  const config = readCloudAsrConfig(process.env);
  if (!config) {
    return undefined;
  }
  if (config.mode === "cloud") {
    return "Inbound audio of every duration uses Aliyun Tingwu cloud. Report cloud failures without local fallback; routing keywords do not override the host's all-cloud mode. Videos up to 10 seconds are framed and audio-transcribed; longer or unprobeable videos are attached directly for inspection and are not automatically transcribed.";
  }
  const threshold = formatAsrThreshold(config.thresholdSeconds);
  return `Inbound audio is auto-transcribed (>=${threshold} → Aliyun Tingwu cloud, shorter → local Qwen ASR); never deny it. Videos up to 10 seconds are framed and audio-transcribed; longer or unprobeable videos are attached directly for inspection and are not automatically transcribed. 强制本地转写/强制云端转写 forces a route only when sent WITH the audio (same message or burst), not afterwards.`;
}

export type LarkAgentInstructionContext = "chat" | "card" | "comment" | "cron" | "bus" | "meeting";

export interface LarkAgentInstructionOptions {
  engine?: InstanceEngine;
  claudeChrome?: boolean;
  timezone?: string;
  context?: LarkAgentInstructionContext;
}

const FETCHED_MEDIA_TASK_PATTERN = /(?:transcrib|transcript|subtitle|caption|podcast|audio|video|youtube|youtu\.be|bilibili|b23\.tv|douyin|speech[- ]?to[- ]?text|\.(?:aac|flac|m4a|mkv|mov|mp3|mp4|ogg|wav|webm)\b|转写|转录|字幕|音频|视频|录音|语音|播客|整理成.{0,4}文字|下载.{0,8}(?:视频|音频))/iu;

function mediaTaskIntentText(text: string): string {
  if (!text.includes(`[${BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER}]`)) {
    return text;
  }
  return text
    .replace(
      /\[Bridge media transcription completed\]\r?\n(?:File:[^\r\n]*\r?\n)?(?:Use the transcript below[^\r\n]*\r?\n)?Transcript:\r?\n([\s\S]*?)\r?\n\[End bridge media transcription\]/giu,
      "$1",
    )
    .replace(/\[Bridge media transcription completed\]/giu, "")
    .replace(/^File:[^\r\n]*$/gimu, "")
    .replace(/^Use the transcript below[^\r\n]*$/gimu, "")
    .replace(/^Transcript:\s*$/gimu, "")
    .replace(/^\[End bridge media transcription\]\s*$/gimu, "");
}

/** Per-turn media procedure. Ordinary turns should not pay this prompt cost. */
export function larkMediaTaskInstruction(text: string): string | undefined {
  if (!FETCHED_MEDIA_TASK_PATTERN.test(mediaTaskIntentText(text))) {
    return undefined;
  }
  return localAsrAgentInstruction() ?? cloudAsrAgentInstruction();
}

export function mergeTurnInstructions(...instructions: Array<string | undefined>): string | undefined {
  const merged = instructions.map((instruction) => instruction?.trim()).filter(Boolean) as string[];
  return merged.length > 0 ? merged.join("\n\n") : undefined;
}

export function larkAgentInstructions(options: LarkAgentInstructionOptions = {}): string { return platformPolicy().instructions?.(options) ?? ""; }
