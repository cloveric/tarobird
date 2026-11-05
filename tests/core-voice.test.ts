import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { removeTempRoot } from "./helpers/temp-files.js";
import { describe, expect, it, vi } from "vitest";
import { createDefaultTranscribeVoice } from "../src/core/voice.js";
import { PartialMediaTranscriptionError } from "../src/runtime/media-transcript.js";

// Shared ASR regressions formerly reached through the retired Telegram facade.
describe("createDefaultTranscribeVoice", () => {
  it("splits long audio before transcription to keep ASR memory bounded", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      const chunkName = path.basename(body.path ?? "", path.extname(body.path ?? ""));
      return {
        ok: true,
        text: async () => `${chunkName} transcript`,
      };
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "1069.261333\n", "");
        return;
      }

      if (file === "ffmpeg") {
        const pattern = String(args.at(-1));
        void Promise.all([
          writeFile(pattern.replace("%03d", "000"), "chunk-000"),
          writeFile(pattern.replace("%03d", "001"), "chunk-001"),
        ]).then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }

      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      watchdog,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkAfterSeconds: 300,
      chunkSeconds: 120,
      env: {},
    } as never);

    await expect(transcribeVoice("/tmp/long-meeting.m4a")).resolves.toBe("chunk-000 transcript\nchunk-001 transcript");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as { path?: string };
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body ?? "{}")) as { path?: string };
    expect(firstBody.path).toMatch(/chunk-000\.wav$/);
    expect(secondBody.path).toMatch(/chunk-001\.wav$/);
  });

  it("reports partial long-audio transcripts when a chunk fails", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      const chunkName = path.basename(body.path ?? "", path.extname(body.path ?? ""));
      if (chunkName === "chunk-001") {
        return {
          ok: false,
          status: 500,
          text: async () => "",
        };
      }
      return {
        ok: true,
        text: async () => `${chunkName} transcript`,
      };
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "1069.261333\n", "");
        return;
      }

      if (file === "ffmpeg") {
        const pattern = String(args.at(-1));
        void Promise.all([
          writeFile(pattern.replace("%03d", "000"), "chunk-000"),
          writeFile(pattern.replace("%03d", "001"), "chunk-001"),
          writeFile(pattern.replace("%03d", "002"), "chunk-002"),
        ]).then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }

      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      watchdog,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkAfterSeconds: 300,
      chunkSeconds: 120,
      env: {},
    } as never);

    let failure: unknown;
    try {
      await transcribeVoice("/tmp/long-meeting.m4a");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PartialMediaTranscriptionError);
    expect(failure).toMatchObject({
      transcript: expect.stringContaining("chunk-000 transcript"),
      failedChunkNumbers: [2],
      totalChunks: 3,
    });
    expect((failure as PartialMediaTranscriptionError).transcript).toContain("chunk-002 transcript");
    expect((failure as PartialMediaTranscriptionError).transcript).not.toContain("transcription failed");
  });

  it("retries a temporarily unavailable HTTP ASR before using CLI fallback", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "" })
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "recovered transcript" });
    const execFileImpl = vi.fn((
      file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "30\n", "");
        return;
      }
      callback(new Error(`unexpected CLI fallback: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "/tmp/qwen-python",
      cliScript: "/tmp/qwen-transcribe.py",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
      httpRetryWindowMs: 100,
      httpRetryDelayMs: 1,
    } as never);

    await expect(transcribeVoice("/tmp/voice.ogg")).resolves.toBe("recovered transcript");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(execFileImpl).not.toHaveBeenCalledWith(
      "/tmp/qwen-python",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not retry a non-transient HTTP ASR rejection", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "" });
    const execFileImpl = vi.fn((
      file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "30\n", "");
        return;
      }
      if (file === "/tmp/qwen-python") {
        callback(null, "CLI fallback transcript", "");
        return;
      }
      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "/tmp/qwen-python",
      cliScript: "/tmp/qwen-transcribe.py",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
      httpRetryWindowMs: 100,
      httpRetryDelayMs: 1,
    } as never);

    await expect(transcribeVoice("/tmp/voice.ogg")).resolves.toBe("CLI fallback transcript");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("chunks long audio before invoking the CLI fallback", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "90\n", "");
        return;
      }
      if (file === "ffmpeg") {
        const pattern = String(args.at(-1));
        void Promise.all([
          writeFile(pattern.replace("%03d", "000"), "chunk-000"),
          writeFile(pattern.replace("%03d", "001"), "chunk-001"),
        ]).then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }
      if (file === "/tmp/qwen-python") {
        callback(null, `${path.basename(String(args[1]))} transcript`, "");
        return;
      }
      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "/tmp/qwen-python",
      cliScript: "/tmp/qwen-transcribe.py",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkAfterSeconds: 120,
      cliChunkSeconds: 45,
      httpRetryWindowMs: 0,
    } as never);

    await expect(transcribeVoice("/tmp/meeting.m4a")).resolves.toBe(
      "chunk-000.wav transcript\nchunk-001.wav transcript",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(execFileImpl.mock.calls.filter(([file]) => file === "/tmp/qwen-python")).toHaveLength(2);
  });

  it("extracts short video audio to wav before transcription", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      return {
        ok: true,
        text: async () => `transcribed ${path.basename(body.path ?? "")}`,
      };
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "37.5\n", "");
        return;
      }

      if (file === "ffmpeg") {
        expect(args).toContain("-vn");
        const pattern = String(args.at(-1));
        void writeFile(pattern.replace("%03d", "000"), "chunk-000").then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }

      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkAfterSeconds: 120,
      chunkSeconds: 60,
    } as never);

    await expect(transcribeVoice("/tmp/short-clip.mp4")).resolves.toBe("transcribed chunk-000.wav");

    expect(execFileImpl).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-i", "/tmp/short-clip.mp4", "-vn"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("still extracts video audio when ffprobe cannot read the duration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-voice-"));
    const videoPath = path.join(root, "short-clip.mp4");
    await writeFile(videoPath, "video");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      return {
        ok: true,
        text: async () => `transcribed ${path.basename(body.path ?? "")}`,
      };
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(new Error("ffprobe failed"), "", "ffprobe failed");
        return;
      }

      if (file === "ffmpeg") {
        const pattern = String(args.at(-1));
        void writeFile(pattern.replace("%03d", "000"), "chunk-000").then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }

      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkAfterSeconds: 120,
      chunkSeconds: 60,
    } as never);

    try {
      await expect(transcribeVoice(videoPath)).resolves.toBe("transcribed chunk-000.wav");
      expect(execFileImpl).toHaveBeenCalledWith(
        "ffmpeg",
        expect.arrayContaining(["-i", videoPath, "-vn"]),
        expect.any(Object),
        expect.any(Function),
      );
    } finally {
      warnSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("chunks audio before transcription when ffprobe cannot determine duration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "core-voice-"));
    const audioPath = path.join(root, "meeting.m4a");
    await writeFile(audioPath, Buffer.alloc(128 * 1024 + 1));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      return {
        ok: true,
        text: async () => `transcribed ${path.basename(body.path ?? "")}`,
      };
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(new Error("ffprobe missing"), "", "ffprobe missing");
        return;
      }
      if (file === "ffmpeg") {
        const pattern = String(args.at(-1));
        void writeFile(pattern.replace("%03d", "000"), "chunk-000").then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }
      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
    } as never);

    try {
      await expect(transcribeVoice(audioPath)).resolves.toBe("transcribed chunk-000.wav");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ffprobe failed"));
      expect(fetchImpl).toHaveBeenCalledWith(
        "http://127.0.0.1:8412/transcribe",
        expect.objectContaining({ body: expect.stringContaining("chunk-000.wav") }),
      );
    } finally {
      warnSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("caps configured ASR chunks below the local service's 300-second limit", async () => {
    let segmentTimeArg = "";
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "chunk transcript",
    });
    const execFileImpl = vi.fn((
      file: string,
      args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "1200\n", "");
        return;
      }

      if (file === "ffmpeg") {
        segmentTimeArg = String(args[args.indexOf("-segment_time") + 1]);
        const pattern = String(args.at(-1));
        void writeFile(pattern.replace("%03d", "000"), "chunk-000").then(
          () => callback(null, "", ""),
          (error) => callback(error, "", String(error)),
        );
        return;
      }

      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      execFileImpl,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      chunkSeconds: 99_999,
      env: {},
    } as never);

    await expect(transcribeVoice("/tmp/meeting.m4a")).resolves.toBe("chunk transcript");

    expect(segmentTimeArg).toBe("270");
  });

  it("cancels local Qwen HTTP transcription without watchdog noise or CLI fallback", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectCancelled = () => {
          reject(signal?.reason instanceof Error ? signal.reason : new Error("local ASR cancelled"));
        };
        markRequestStarted?.();
        if (signal?.aborted) {
          rejectCancelled();
          return;
        }
        signal?.addEventListener("abort", rejectCancelled, { once: true });
      })
    );
    const execFileImpl = vi.fn((
      file: string,
      _args: readonly string[],
      options: { signal?: AbortSignal },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        expect(options.signal).toBeDefined();
        callback(null, "30\n", "");
        return;
      }
      callback(new Error(`unexpected CLI fallback: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "/tmp/qwen-python",
      cliScript: "/tmp/qwen-transcribe.py",
      fetchImpl: fetchImpl as never,
      watchdog,
      execFileImpl,
      ffprobePath: "ffprobe",
    } as never);
    const controller = new AbortController();
    const pending = transcribeVoice("/tmp/voice.ogg", { abortSignal: controller.signal });

    await requestStarted;
    controller.abort(new Error("stopped by user"));

    await expect(pending).rejects.toThrow("stopped by user");
    expect(watchdog.recordFailure).not.toHaveBeenCalled();
    expect(execFileImpl).not.toHaveBeenCalledWith(
      "/tmp/qwen-python",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("passes the turn cancellation signal into local Qwen CLI fallback", async () => {
    let markCliStarted: (() => void) | undefined;
    const cliStarted = new Promise<void>((resolve) => {
      markCliStarted = resolve;
    });
    let observedCliSignal: AbortSignal | undefined;
    const execFileImpl = vi.fn((
      file: string,
      _args: readonly string[],
      options: { signal?: AbortSignal },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "ffprobe") {
        callback(null, "30\n", "");
        return;
      }
      if (file === "/tmp/qwen-python") {
        observedCliSignal = options.signal;
        markCliStarted?.();
        options.signal?.addEventListener("abort", () => {
          callback(new Error("qwen CLI aborted"), "", "");
        }, { once: true });
        return;
      }
      callback(new Error(`unexpected command: ${file}`), "", "");
    });
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "",
      cliPython: "/tmp/qwen-python",
      cliScript: "/tmp/qwen-transcribe.py",
      execFileImpl,
      ffprobePath: "ffprobe",
    } as never);
    const controller = new AbortController();
    const pending = transcribeVoice("/tmp/voice.ogg", { abortSignal: controller.signal });

    await cliStarted;
    controller.abort(new Error("stopped by user"));

    await expect(pending).rejects.toThrow("qwen CLI aborted");
    expect(observedCliSignal).toBe(controller.signal);
  });

  it("uses a configurable ASR HTTP timeout", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted by test timeout")), { once: true });
        setTimeout(() => reject(new Error(`not aborted: ${String(signal?.aborted)}`)), 20);
      })
    );
    const execFileImpl = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, "30\n", ""));
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      watchdog,
      execFileImpl,
      ffprobePath: "ffprobe",
      httpTimeoutMs: 1,
    } as never);

    await expect(transcribeVoice("/tmp/voice.ogg")).rejects.toThrow("aborted by test timeout");

    expect(watchdog.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: "aborted by test timeout",
    }));
  });

  it("records ASR HTTP failures with the watchdog before falling back", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));
    const execFileImpl = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, "30\n", ""));
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl,
      watchdog,
      execFileImpl,
      ffprobePath: "ffprobe",
    });

    await expect(transcribeVoice("/tmp/voice.ogg")).rejects.toThrow("connection refused");

    expect(watchdog.recordFailure).toHaveBeenCalledTimes(1);
    expect(watchdog.recordSuccess).not.toHaveBeenCalled();
  });

  it("treats an empty ASR HTTP response as a watchdog failure", async () => {
    const watchdog = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
    });
    const execFileImpl = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, "30\n", ""));
    const transcribeVoice = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl,
      watchdog,
      execFileImpl,
      ffprobePath: "ffprobe",
    });

    await expect(transcribeVoice("/tmp/voice.ogg")).rejects.toThrow("ASR HTTP server returned an empty transcript");

    expect(watchdog.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: "ASR HTTP server returned an empty transcript",
    }));
    expect(watchdog.recordSuccess).not.toHaveBeenCalled();
  });
});
