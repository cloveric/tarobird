import { standardAsrReady } from "../runtime/qwen-asr-paths.js";
import { reuseMediaTranscript } from "../runtime/media-transcript-cache.js";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  detectCloudAsrOverride,
  readCloudAsrConfig,
  transcribeViaTingwuCloud,
  type TranscribeMediaOptions,
  isCloudAsrCancelledError,
  CloudAsrRequiredError,
  CloudAsrEmptyResultError,
} from "../runtime/asr-cloud.js";
import { hasTranscribableMediaExtension, hasTranscribableVideoExtension } from "../runtime/media-extensions.js";
import {
  formatBridgeMediaTranscript,
  formatBridgePartialMediaTranscript,
  isPartialMediaTranscriptionError,
  PartialMediaTranscriptionError,
} from "../runtime/media-transcript.js";

import { createAsrWatchdogFromEnv, type AsrWatchdog } from "./asr-watchdog.js";

// Voice transcription configuration. Override via env vars:
//   ASR_HTTP_URL — warm ASR HTTP server (fast path)
//   ASR_CLI_PYTHON + ASR_CLI_SCRIPT — CLI fallback (cold start)
//   ASR_HTTP_TIMEOUT_MS — per-file/chunk ASR HTTP timeout
//   ASR_HTTP_RETRY_WINDOW_MS — wait/retry before using the cold CLI fallback
//   ASR_CHUNK_AFTER_SECONDS + ASR_CHUNK_SECONDS — split long audio before ASR
//   ASR_CLI_CHUNK_SECONDS — fallback CLI segment size, including unknown-duration input
//   ASR_UNKNOWN_DURATION_DIRECT_MAX_BYTES — tiny unknown-duration audio may skip pre-chunking
//   ASR_MAX_AUDIO_SECONDS — hard per-request limit of the local ASR service
// An empty ASR_HTTP_URL disables the HTTP path; missing CLI paths disable
// the CLI path. If both are unavailable, voice messages fail cleanly
// with an "ASR not configured" error instead of spawning against
// nonexistent files.

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;
type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
  callback: ExecFileCallback,
) => void;

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}

function isLikelyVideoFile(filePath: string): boolean {
  return hasTranscribableVideoExtension(filePath);
}

function execFileText(
  execFileImpl: ExecFileImpl,
  file: string,
  args: readonly string[],
  options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
      if (error) {
        reject(new Error(stderrText.trim() || error.message));
        return;
      }
      resolve({
        stdout: Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout,
        stderr: stderrText,
      });
    });
  });
}

async function probeAudioDurationSeconds(
  audioPath: string,
  execFileImpl: ExecFileImpl,
  ffprobePath: string,
  abortSignal?: AbortSignal,
): Promise<number | null> {
  try {
    const { stdout } = await execFileText(execFileImpl, ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ], {
      timeout: 10_000,
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    try {
      await access(audioPath);
    } catch {
      return null;
    }
    console.warn(`ASR ffprobe failed for ${path.basename(audioPath)}; duration is unknown and large files will be pre-chunked by size: ${summarizeError(error)}`);
    return null;
  }
}

async function splitAudioIntoChunks(inputPath: string, options: {
  chunkSeconds: number;
  execFileImpl: ExecFileImpl;
  ffmpegPath: string;
  abortSignal?: AbortSignal;
}): Promise<{ chunks: string[]; cleanup: () => Promise<void> }> {
  const chunkDir = await mkdtemp(path.join(os.tmpdir(), "cctb-asr-chunks-"));
  const pattern = path.join(chunkDir, "chunk-%03d.wav");

  try {
    await execFileText(options.execFileImpl, options.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "segment",
      "-segment_time",
      String(options.chunkSeconds),
      "-reset_timestamps",
      "1",
      pattern,
    ], {
      timeout: 300_000,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });

    const chunks = (await readdir(chunkDir))
      .filter((entry) => /^chunk-\d+\.wav$/.test(entry))
      .sort()
      .map((entry) => path.join(chunkDir, entry));

    if (chunks.length === 0) {
      throw new Error("ffmpeg did not produce ASR audio chunks");
    }

    return {
      chunks,
      cleanup: () => rm(chunkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
    };
  } catch (error) {
    await rm(chunkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    throw error;
  }
}

export function createDefaultTranscribeVoice(options: {
  httpUrl?: string;
  cliPython?: string;
  cliScript?: string;
  fetchImpl?: typeof fetch;
  watchdog?: AsrWatchdog;
  execFileImpl?: ExecFileImpl;
  ffprobePath?: string;
  ffmpegPath?: string;
  httpTimeoutMs?: number;
  httpRetryWindowMs?: number;
  httpRetryDelayMs?: number;
  chunkAfterSeconds?: number;
  chunkSeconds?: number;
  cliChunkSeconds?: number;
  unknownDurationDirectMaxBytes?: number;
  maxAudioSeconds?: number;
  /**
   * Local ASR settings are read at factory creation, after Worker config loads.
   * Long-audio cloud routing settings are read at call time.
   */
  env?: NodeJS.ProcessEnv;
  /** Fallback state dir for cloud ASR job dirs when the call carries none. */
  stateDir?: string;
} = {}): (audioPath: string, callOptions?: TranscribeMediaOptions) => Promise<string> {
  const env = options.env ?? process.env;
  const asrHome = env.HOME ?? env.USERPROFILE;
  const installedAsr = asrHome ? path.join(asrHome, ".tarobot/integrations/qwen3-asr") : undefined;
  const legacyAsr = asrHome ? path.join(asrHome, "projects/qwen3-asr") : undefined;
  const standardReady = !!installedAsr && standardAsrReady(installedAsr);
  const useLegacy = !!legacyAsr && !!installedAsr && !standardReady && existsSync(path.join(legacyAsr, "transcribe.py"));
  const ASR_HTTP_URL = env.ASR_HTTP_URL ?? "http://127.0.0.1:8412/transcribe";
  const ASR_CLI_PYTHON = env.ASR_CLI_PYTHON
    ?? (useLegacy ? path.join(legacyAsr!, "venv/bin/python3") : installedAsr ? path.join(installedAsr, ".venv/bin/python") : undefined);
  const ASR_CLI_SCRIPT = env.ASR_CLI_SCRIPT
    ?? (useLegacy ? path.join(legacyAsr!, "transcribe.py") : installedAsr ? path.join(installedAsr, "transcribe.py") : undefined);
  const ASR_HTTP_TIMEOUT_MS = parsePositiveNumber(env.ASR_HTTP_TIMEOUT_MS, 180_000);
  const ASR_HTTP_RETRY_WINDOW_MS = parseNonNegativeNumber(env.ASR_HTTP_RETRY_WINDOW_MS, 20_000);
  const ASR_HTTP_RETRY_DELAY_MS = parsePositiveNumber(env.ASR_HTTP_RETRY_DELAY_MS, 1_000);
  const ASR_CHUNK_AFTER_SECONDS = parsePositiveNumber(env.ASR_CHUNK_AFTER_SECONDS, 120);
  const ASR_CHUNK_SECONDS = parsePositiveNumber(env.ASR_CHUNK_SECONDS, 60);
  const ASR_CLI_CHUNK_SECONDS = parsePositiveNumber(env.ASR_CLI_CHUNK_SECONDS, 45);
  const ASR_UNKNOWN_DURATION_DIRECT_MAX_BYTES = parseNonNegativeNumber(
    env.ASR_UNKNOWN_DURATION_DIRECT_MAX_BYTES,
    128 * 1024,
  );
  const ASR_MAX_AUDIO_SECONDS = parsePositiveNumber(env.ASR_MAX_AUDIO_SECONDS, 300);
  const httpUrl = options.httpUrl ?? ASR_HTTP_URL;
  const cliPython = options.cliPython ?? ASR_CLI_PYTHON;
  const cliScript = options.cliScript ?? ASR_CLI_SCRIPT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const watchdog = options.watchdog ?? createAsrWatchdogFromEnv(env);
  const execFileImpl = options.execFileImpl ?? (execFile as ExecFileImpl);
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const httpTimeoutMs = options.httpTimeoutMs ?? ASR_HTTP_TIMEOUT_MS;
  const httpRetryWindowMs = options.httpRetryWindowMs ?? ASR_HTTP_RETRY_WINDOW_MS;
  const httpRetryDelayMs = options.httpRetryDelayMs ?? ASR_HTTP_RETRY_DELAY_MS;
  const configuredMaxAudioSeconds = options.maxAudioSeconds ?? ASR_MAX_AUDIO_SECONDS;
  const maxAudioSeconds = Number.isFinite(configuredMaxAudioSeconds) && configuredMaxAudioSeconds > 0
    ? configuredMaxAudioSeconds
    : ASR_MAX_AUDIO_SECONDS;
  // Leave timestamp/container headroom below the ASR service's hard cap. A
  // nominally exact 300s segment can probe slightly above 300s and be rejected.
  const safeChunkSeconds = Math.max(1, Math.floor(maxAudioSeconds * 0.9));
  const chunkAfterSeconds = Math.min(options.chunkAfterSeconds ?? ASR_CHUNK_AFTER_SECONDS, maxAudioSeconds);
  const chunkSeconds = Math.min(options.chunkSeconds ?? ASR_CHUNK_SECONDS, safeChunkSeconds);
  const cliChunkSeconds = Math.min(options.cliChunkSeconds ?? ASR_CLI_CHUNK_SECONDS, safeChunkSeconds);
  const configuredUnknownDurationDirectMaxBytes = options.unknownDurationDirectMaxBytes
    ?? ASR_UNKNOWN_DURATION_DIRECT_MAX_BYTES;
  const unknownDurationDirectMaxBytes = Number.isFinite(configuredUnknownDurationDirectMaxBytes)
    && configuredUnknownDurationDirectMaxBytes >= 0
    ? configuredUnknownDurationDirectMaxBytes
    : ASR_UNKNOWN_DURATION_DIRECT_MAX_BYTES;
  const cloudEnv = options.env ?? process.env;
  const factoryStateDir = options.stateDir;
  let httpRetryCooldownUntil = 0;

  async function recordHttpSuccess(): Promise<void> {
    try {
      watchdog.recordSuccess();
    } catch {
      // Watchdog diagnostics must never break transcription.
    }
  }

  async function recordHttpFailure(error: unknown): Promise<void> {
    try {
      await watchdog.recordFailure(error);
    } catch {
      // Watchdog diagnostics must never break CLI fallback.
    }
  }

  async function waitBeforeHttpRetry(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
    if (delayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        abortSignal?.removeEventListener("abort", abort);
        resolve();
      }, delayMs);
      const abort = () => {
        clearTimeout(timer);
        reject(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error("ASR retry cancelled"));
      };
      if (abortSignal?.aborted) {
        abort();
        return;
      }
      abortSignal?.addEventListener("abort", abort, { once: true });
    });
  }

  async function transcribeViaCli(audioPath: string, abortSignal?: AbortSignal): Promise<string> {
    if (!cliPython || !cliScript) {
      throw new Error(
        "ASR not configured: set ASR_HTTP_URL or ASR_CLI_PYTHON + ASR_CLI_SCRIPT env vars, or run scripts/install-qwen-asr.sh and configure ~/.tarobot/integrations.env.",
      );
    }

    abortSignal?.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      execFileImpl(cliPython, [cliScript, audioPath], {
        timeout: 300_000,
        env,
        ...(abortSignal ? { signal: abortSignal } : {}),
      }, (error, stdout, stderr) => {
        if (error) {
          const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
          reject(new Error(stderrText.trim() || error.message));
          return;
        }
        const transcript = (Buffer.isBuffer(stdout) ? stdout.toString("utf8") : stdout).trim();
        if (!transcript) {
          reject(new Error("ASR CLI returned an empty transcript"));
          return;
        }
        resolve(transcript);
      });
    });
  }

  async function transcribeChunkFiles(
    chunks: string[],
    transcribeChunk: (chunk: string) => Promise<string>,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const transcripts: string[] = [];
    const failedChunkNumbers: number[] = [];
    for (const [index, chunk] of chunks.entries()) {
      abortSignal?.throwIfAborted();
      try {
        const transcript = (await transcribeChunk(chunk)).trim();
        if (transcript) {
          transcripts.push(transcript);
        } else {
          failedChunkNumbers.push(index + 1);
          console.warn(`ASR chunk ${index + 1}/${chunks.length} returned an empty transcript`);
        }
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        failedChunkNumbers.push(index + 1);
        console.warn(`ASR chunk ${index + 1}/${chunks.length} transcription failed: ${summarizeError(error)}`);
      }
    }

    const mergedTranscript = transcripts.join("\n").trim();
    if (!mergedTranscript) {
      throw new Error("ASR chunk transcription failed or returned empty for all chunks");
    }
    if (failedChunkNumbers.length > 0) {
      throw new PartialMediaTranscriptionError(mergedTranscript, failedChunkNumbers, chunks.length);
    }
    return mergedTranscript;
  }

  async function transcribeViaChunkedCli(audioPath: string, abortSignal?: AbortSignal): Promise<string> {
    const { chunks, cleanup } = await splitAudioIntoChunks(audioPath, {
      chunkSeconds: cliChunkSeconds,
      execFileImpl,
      ffmpegPath,
      ...(abortSignal ? { abortSignal } : {}),
    });
    try {
      return await transcribeChunkFiles(
        chunks,
        async (chunk) => await transcribeViaCli(chunk, abortSignal),
        abortSignal,
      );
    } finally {
      await cleanup();
    }
  }

  async function transcribeSingleFile(
    audioPath: string,
    duration: number | null,
    abortSignal?: AbortSignal,
    allowCliChunking = true,
  ): Promise<string> {
    abortSignal?.throwIfAborted();
    if (httpUrl) {
      const retryDeadline = Date.now() + Math.max(0, httpRetryWindowMs);
      let failureRecorded = false;
      while (true) {
        let failure: Error;
        let retryable = true;
        let serviceFailure = true;
        try {
          const timeoutSignal = AbortSignal.timeout(httpTimeoutMs);
          const response = await fetchImpl(httpUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: audioPath }),
            signal: abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal,
          });
          abortSignal?.throwIfAborted();
          if (response.ok) {
            const text = await response.text();
            if (text.trim()) {
              httpRetryCooldownUntil = 0;
              await recordHttpSuccess();
              return text.trim();
            }
            failure = new Error("ASR HTTP server returned an empty transcript");
          } else {
            failure = new Error(`ASR HTTP server returned ${response.status}`);
            retryable = response.status === 408 || response.status === 429 || response.status >= 500;
            // Invalid/silent audio and queue saturation are not a broken ASR
            // process. Never restart another Bot's inference for these responses.
            serviceFailure = response.status >= 500 && response.status !== 503;
          }
        } catch (error) {
          if (abortSignal?.aborted) throw error;
          failure = error instanceof Error ? error : new Error(String(error));
        }
        if (!failureRecorded) {
          failureRecorded = true;
          if (serviceFailure) await recordHttpFailure(failure);
          else await recordHttpSuccess();
        }
        const remainingMs = Date.now() < httpRetryCooldownUntil
          ? 0
          : retryDeadline - Date.now();
        if (!cliPython || !cliScript) throw failure;
        if (!retryable || remainingMs <= 0 || httpRetryWindowMs <= 0) break;
        await waitBeforeHttpRetry(Math.min(httpRetryDelayMs, remainingMs), abortSignal);
      }
      httpRetryCooldownUntil = Date.now() + Math.max(0, httpRetryWindowMs);
    }

    if (
      allowCliChunking &&
      cliPython &&
      cliScript &&
      (duration === null || duration > cliChunkSeconds || isLikelyVideoFile(audioPath))
    ) {
      return transcribeViaChunkedCli(audioPath, abortSignal);
    }
    return transcribeViaCli(audioPath, abortSignal);
  }

  async function transcribeLocally(
    audioPath: string,
    duration: number | null,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    abortSignal?.throwIfAborted();
    // Unknown duration is not evidence that the media is short. Large files
    // are segmented so a broken/missing ffprobe cannot make the local service
    // silently clip a long recording. Tiny voice notes remain direct: this
    // preserves service during a transient ffprobe outage without risking the
    // local ASR duration cap at normal speech bitrates.
    let unknownDurationNeedsChunking = false;
    if (duration === null) {
      try {
        unknownDurationNeedsChunking = (await stat(audioPath)).size > unknownDurationDirectMaxBytes;
      } catch {
        // Let the configured ASR backend report an unreadable/missing input.
      }
    }
    const shouldExtractOrChunk = unknownDurationNeedsChunking
      || isLikelyVideoFile(audioPath)
      || (duration !== null && duration > chunkAfterSeconds);
    if (shouldExtractOrChunk) {
      const { chunks, cleanup } = await splitAudioIntoChunks(audioPath, {
        chunkSeconds,
        execFileImpl,
        ffmpegPath,
        ...(abortSignal ? { abortSignal } : {}),
      });
      try {
        return await transcribeChunkFiles(
          chunks,
          async (chunk) => await transcribeSingleFile(chunk, chunkSeconds, abortSignal, false),
          abortSignal,
        );
      } finally {
        await cleanup();
      }
    }

    return transcribeSingleFile(audioPath, duration, abortSignal);
  }

  return async function defaultTranscribeVoice(audioPath: string, callOptions?: TranscribeMediaOptions): Promise<string> {
    const abortSignal = callOptions?.abortSignal;
    abortSignal?.throwIfAborted();
    // Snapshot host routing before probing: changing settings must not reroute
    // a recording that has already entered this pipeline.
    const cloudConfig = readCloudAsrConfig(cloudEnv);
    const duration = await probeAudioDurationSeconds(audioPath, execFileImpl, ffprobePath, abortSignal);

    // Fixed modes override message keywords. Automatic routing keeps unknown
    // durations local unless the user explicitly requests cloud transcription.
    const override = detectCloudAsrOverride(callOptions?.messageText);
    const shouldUseCloud = cloudConfig !== null &&
      (cloudConfig.mode === "cloud" || (override !== "local" &&
      (override === "cloud" || (duration !== null && duration >= cloudConfig.thresholdSeconds))));
    const transcribe = async () => {
      if (shouldUseCloud && cloudConfig !== null) {
        const jobStateDir = callOptions?.stateDir ?? factoryStateDir;
        const jobRootDir = jobStateDir
          ? path.join(jobStateDir, "asr-jobs")
          : path.join(os.tmpdir(), "cctb-asr-jobs");
        let audioDirectory: string | undefined, cloudStarted = false;
        try {
          let cloudAudioPath = audioPath;
          let extractAudio = callOptions?.mediaKind === "video";
          // MIME, extension and the caller's audio hint do not attest to the
          // actual streams. Only a positive audio-only probe permits uploading
          // the original; otherwise extract audio or fail without uploading it.
          if (!extractAudio) {
            try {
              const streams = JSON.parse((await execFileText(execFileImpl, ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", audioPath], { timeout: 10_000, signal: abortSignal })).stdout).streams;
              extractAudio = !Array.isArray(streams) || streams.length === 0 || streams.some((stream: { codec_type?: string }) => stream.codec_type !== "audio");
            } catch { abortSignal?.throwIfAborted(); extractAudio = true; }
          }
          if (extractAudio) {
            // Cloud ASR permission covers audio, not video frames. Bound both
            // decoding time and output size, and never upload the original on
            // extraction failure. The original remains available to the caller.
            audioDirectory = await mkdtemp(path.join(os.tmpdir(), "tarobot-asr-audio-"));
            cloudAudioPath = path.join(audioDirectory, "audio.wav");
            const limit = 64 * 1024 * 1024;
            await execFileText(execFileImpl, ffmpegPath, ["-nostdin", "-v", "error", "-i", audioPath,
              "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
              "-fs", String(limit), cloudAudioPath], { timeout: 120_000, signal: abortSignal });
            const info = await stat(cloudAudioPath);
            if (info.size <= 44 || info.size >= limit) throw new Error("audio extraction unavailable");
          }
          // The caller's abort signal (when it has one) is threaded straight into
          // the child process: a cancelled turn must not leave a cloud job
          // holding the chat's queue slot until the wall-clock bound expires.
          cloudStarted = true;
          return await transcribeViaTingwuCloud(cloudAudioPath, {
            config: cloudConfig,
            jobRootDir,
            ...(callOptions?.abortSignal ? { abortSignal: callOptions.abortSignal } : {}),
          });
        } catch (error) {
          // A CANCELLED job is not a failure: the operator pressed stop, so
          // restarting the same work locally would defeat the stop entirely.
          if (isCloudAsrCancelledError(error) || abortSignal?.aborted) {
            throw error;
          }
          if (isPartialMediaTranscriptionError(error)) throw error;
          if (cloudConfig.mode === "cloud") throw new CloudAsrRequiredError(!cloudStarted ? "audio" : error instanceof CloudAsrEmptyResultError ? "empty" : "failed");
          // In automatic mode, cloud failure falls back to local transcription.
          // The error messages from asr-cloud.ts carry no stderr content and no
          // env values, so this warn cannot leak signed URLs or credentials.
          console.warn("ASR cloud transcription failed; falling back to local ASR");
        } finally { if (audioDirectory) await rm(audioDirectory, { recursive: true, force: true }).catch(() => undefined); }
      }

      return transcribeLocally(audioPath, duration, abortSignal);
    };
    // Resolve routing before cache lookup: disabling cloud or changing its
    // adapter must not reuse a result from a different transcription policy.
    const hostDir = cloudEnv.TAROBOT_HOST_DIR;
    if (!hostDir || !callOptions?.reuse) return transcribe();
    return reuseMediaTranscript({ hostDir, ...callOptions.reuse, file: audioPath, signal: abortSignal,
      policy: { cloud: shouldUseCloud ? cloudConfig : null, mediaKind: callOptions.mediaKind ?? "unknown",
        local: { httpUrl, cliPython, cliScript, chunkAfterSeconds, chunkSeconds, cliChunkSeconds, unknownDurationDirectMaxBytes, maxAudioSeconds } },
      waitTimeoutMs: Math.max(20 * 60_000, (cloudConfig?.processWallClockSeconds ?? 0) * 1000 + 90_000),
    }, transcribe);
  };
}
