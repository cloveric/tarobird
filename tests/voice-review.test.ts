import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDefaultTranscribeVoice } from "../src/core/voice.js";
import { readCloudAsrConfig, transcribeViaTingwuCloud } from "../src/runtime/asr-cloud.js";
import { HubVoiceSettings } from "../src/hub/voice-settings.js";
vi.mock("../src/runtime/asr-cloud.js", async original => ({ ...await original<typeof import("../src/runtime/asr-cloud.js")>(), transcribeViaTingwuCloud: vi.fn() }));
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "voice-review-")); vi.mocked(transcribeViaTingwuCloud).mockReset().mockResolvedValue("synthetic transcript"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it.each([[" LOCAL ", "local"], ["ClOuD", "cloud"], ["AUTO", "auto"], ["cluod", "local"], ["", "auto"]])("uses the same safe legacy mode in Hub and worker: %s", async (input, expected) => {
  const env = { TINGWU_ASR_DIR: root, ASR_CLOUD_MODE: input };
  expect((await new HubVoiceSettings(root, root, env).status()).mode).toBe(expected);
  const config = readCloudAsrConfig(env);
  expect(config ? config.mode ?? "auto" : "local").toBe(expected);
});
it.skipIf(["ffmpeg", "ffprobe"].some(binary => spawnSync(binary, ["-version"]).status !== 0))("uploads only an audio track from a synthetic MP4 and removes it afterward", async () => {
  const video = path.join(root, "fixture.mp4");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=16x16:d=0.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-shortest", "-c:v", "mpeg4", "-c:a", "aac", video], { timeout: 10000 });
  let uploaded = "";
  vi.mocked(transcribeViaTingwuCloud).mockImplementation(async file => {
    uploaded = file; expect(file).not.toBe(video);
    const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8", timeout: 10000 })).streams;
    expect(streams).toHaveLength(1); expect(streams[0]).toMatchObject({ codec_type: "audio", sample_rate: "16000", channels: 1 });
    return "synthetic transcript";
  });
  const transcribe = createDefaultTranscribeVoice({ env: { TINGWU_ASR_DIR: root, ASR_CLOUD_MODE: "cloud" }, execFileImpl: execFile, stateDir: root });
  expect(await transcribe(video, { mediaKind: "audio" })).toBe("synthetic transcript");
  await expect(stat(video)).resolves.toBeDefined(); await expect(stat(uploaded)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["failure", "oversize", "cancel"])("never uploads video after extraction %s and cleans its scratch directory", async kind => {
  const abort = new AbortController(); let output = "";
  const fetchImpl = vi.fn();
  const transcribe = createDefaultTranscribeVoice({ env: { TINGWU_ASR_DIR: root, ASR_CLOUD_MODE: "cloud" }, stateDir: root, fetchImpl,
    execFileImpl: ((file: string, args: string[], options: { timeout: number; signal: AbortSignal }, done: (err: Error | null, out: string, errout: string) => void) => {
      if (file === "ffprobe") { done(null, "5", ""); return; }
      expect(args).toContain("-nostdin"); expect(args).toContain("-vn"); expect(options.timeout).toBe(120000); expect(options.signal).toBe(abort.signal);
      output = args.at(-1)!;
      if (kind === "oversize") void writeFile(output, Buffer.alloc(64 * 1024 * 1024)).then(() => done(null, "", ""));
      else { if (kind === "cancel") abort.abort(); done(new Error("fixture"), "", "PRIVATE_PATH_AND_STDERR"); }
    }) as never });
  await expect(transcribe(path.join(root, "fixture.mp4"), { abortSignal: abort.signal })).rejects.toThrow();
  expect(transcribeViaTingwuCloud).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  await expect(stat(path.dirname(output))).rejects.toMatchObject({ code: "ENOENT" });
});
it("uploads a verified audio-only recording without requiring ffmpeg", async () => {
  const execFileImpl = vi.fn((file: string, args: string[], _options: unknown, done: (err: Error | null, out: string, errout: string) => void) => {
    expect(file).toBe("ffprobe"); done(null, args.includes("stream=codec_type") ? JSON.stringify({ streams: [{ codec_type: "audio" }] }) : "5", "");
  });
  const transcribe = createDefaultTranscribeVoice({ env: { TINGWU_ASR_DIR: root, ASR_CLOUD_MODE: "cloud" }, stateDir: root, execFileImpl: execFileImpl as never });
  const recording = path.join(root, "voice.webm");
  expect(await transcribe(recording, { mediaKind: "audio" })).toBe("synthetic transcript");
  expect(execFileImpl).toHaveBeenCalledTimes(2);
  expect(transcribeViaTingwuCloud).toHaveBeenCalledWith(recording, expect.any(Object));
});
it("does not trust an audio hint when neither probing nor extraction is available", async () => {
  const execFileImpl = vi.fn((_file: string, _args: string[], _options: unknown, done: (err: Error) => void) => done(new Error("media tool unavailable")));
  const transcribe = createDefaultTranscribeVoice({ env: { TINGWU_ASR_DIR: root, ASR_CLOUD_MODE: "cloud" }, stateDir: root, execFileImpl: execFileImpl as never });
  await expect(transcribe(path.join(root, "voice.webm"), { mediaKind: "audio" })).rejects.toMatchObject({ reason: "audio" });
  expect(transcribeViaTingwuCloud).not.toHaveBeenCalled();
});
it.each(["3gp", "3gpp", "mpeg", "mpg"])("never bypasses audio extraction for unknown .%s media", async extension => {
  const execFileImpl = vi.fn((file: string, _args: string[], _options: unknown, done: (err: Error | null, out: string, errout: string) => void) => {
    if (file === "ffprobe") done(null, "5", ""); else done(new Error("no audio track"), "", "private fixture path");
  });
  const transcribe = createDefaultTranscribeVoice({ env: { TINGWU_ASR_DIR: root, ASR_CLOUD_MODE: "cloud" }, stateDir: root, execFileImpl: execFileImpl as never });
  await expect(transcribe(path.join(root, `clip.${extension}`), { mediaKind: "unknown" })).rejects.toMatchObject({ reason: "audio" });
  expect(execFileImpl.mock.calls.map(call => call[0])).toContain("ffmpeg");
  expect(transcribeViaTingwuCloud).not.toHaveBeenCalled();
});
