import { describe, expect, it } from "vitest";

import {
  cloudAsrAgentInstruction,
  larkAgentInstructions,
  larkMediaTaskInstruction,
  localAsrAgentInstruction,
  mergeTurnInstructions,
  resetCloudAsrConfiguredCacheForTests,
} from "../src/core/agent-instructions.js";
import { coreDeliveryFollowupInstruction } from "../src/core/delivery-followup.js";
import { appAgentInstructions } from "../src/gateway/agent-instructions.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("stable instructions", () => {
  it("keeps delivery follow-up checks out of the stable prompt", () => {
    const followup = coreDeliveryFollowupInstruction("好了吗") ?? "";
    // Without an explicitly selected platform policy, Core contributes no stable prompt.
    expect(larkAgentInstructions()).toBe("");
    expect(appAgentInstructions()).not.toContain("Delivery follow-up for THIS turn");
    expect(followup).toContain("verify platform delivery, not session memory");
    expect(coreDeliveryFollowupInstruction("解释交付机制")).toBeUndefined();
  });
});

describe("dynamic media instructions", () => {
  it("does not make ordinary turns pay the ASR prompt cost", () => {
    const previousUrl = process.env.ASR_HTTP_URL;
    const previousDir = process.env.TINGWU_ASR_DIR;
    process.env.ASR_HTTP_URL = "http://127.0.0.1:8412/transcribe";
    process.env.TINGWU_ASR_DIR = "/tmp/tingwu";
    resetCloudAsrConfiguredCacheForTests();
    try {
      expect(appAgentInstructions()).not.toContain("Aliyun Tingwu");
      expect(appAgentInstructions()).not.toContain("local Qwen");
      expect(larkMediaTaskInstruction("帮我整理今天的待办")).toBeUndefined();
      expect(larkMediaTaskInstruction("下载这个视频并转写")).toContain("Aliyun Tingwu first");
      expect(larkMediaTaskInstruction("https://youtu.be/example")).toContain("Aliyun Tingwu first");
      expect(larkMediaTaskInstruction("https://b23.tv/example")).toContain("Aliyun Tingwu first");
      expect(larkMediaTaskInstruction("帮我整理成文字 /tmp/meeting.m4a")).toContain("Aliyun Tingwu first");
      expect(larkMediaTaskInstruction([
        "[Bridge media transcription completed]",
        'File: "audio-1.ogg"',
        "Use the transcript below as the completed transcription. Do not inspect, probe, split, or transcribe the attached media again unless the user explicitly asks for a retry.",
        "Transcript:",
        "把这个 B 站视频转写一下",
        "[End bridge media transcription]",
      ].join("\n"))).toContain("Aliyun Tingwu first");
      expect(larkMediaTaskInstruction([
        "[Bridge media transcription completed]",
        "Transcript:",
        "先整理会议结论",
        "[End bridge media transcription]",
        "[Bridge media transcription unavailable for second.m4a; inspect or transcribe the attached file if needed.]",
      ].join("\n"))).toContain("Aliyun Tingwu first");
    } finally {
      restoreEnv("ASR_HTTP_URL", previousUrl);
      restoreEnv("TINGWU_ASR_DIR", previousDir);
      resetCloudAsrConfiguredCacheForTests();
    }
  });

  it("never asks the agent to re-transcribe bridge-completed media", () => {
    const text = [
      "[Bridge media transcription completed]",
      'File: "audio-1.ogg"',
      "Use the transcript below as the completed transcription. Do not inspect, probe, split, or transcribe the attached media again unless the user explicitly asks for a retry.",
      "Transcript:",
      "请总结今天的会议结论",
      "[End bridge media transcription]",
    ].join("\n");
    expect(larkMediaTaskInstruction(text)).toBeUndefined();
  });

  it("routes long fetched media through Tingwu and bounds local ASR requests", () => {
    const previousUrl = process.env.ASR_HTTP_URL;
    const previousDir = process.env.TINGWU_ASR_DIR;
    const previousMax = process.env.ASR_MAX_AUDIO_SECONDS;
    process.env.ASR_HTTP_URL = "http://127.0.0.1:8412/transcribe";
    process.env.TINGWU_ASR_DIR = "/tmp/tingwu";
    process.env.ASR_MAX_AUDIO_SECONDS = "120";
    resetCloudAsrConfiguredCacheForTests();
    try {
      const asr = localAsrAgentInstruction() ?? "";
      expect(asr).toContain("Aliyun Tingwu first");
      expect(asr).toContain("Max 120s per request");
      expect(asr).toContain("-segment_time 108");
      expect(asr).toContain("do NOT use whisper/mlx_whisper/parakeet");
      expect(asr).toContain("do NOT inspect/probe/split/re-transcribe");
    } finally {
      restoreEnv("ASR_HTTP_URL", previousUrl);
      restoreEnv("TINGWU_ASR_DIR", previousDir);
      restoreEnv("ASR_MAX_AUDIO_SECONDS", previousMax);
      resetCloudAsrConfiguredCacheForTests();
    }
  });

  it("advertises cloud inbound routing when only Tingwu is configured", () => {
    const previousHttp = process.env.ASR_HTTP_URL;
    const previousCli = process.env.ASR_CLI_PYTHON;
    const previousTingwu = process.env.TINGWU_ASR_DIR;
    delete process.env.ASR_HTTP_URL;
    process.env.ASR_CLI_PYTHON = "/nonexistent/python";
    process.env.TINGWU_ASR_DIR = "/tmp/tingwu";
    resetCloudAsrConfiguredCacheForTests();
    try {
      expect(localAsrAgentInstruction()).toBeUndefined();
      expect(cloudAsrAgentInstruction()).toContain("Aliyun Tingwu cloud");
      expect(larkMediaTaskInstruction("总结这个 podcast")).toContain("Inbound audio is auto-transcribed");
      expect(larkMediaTaskInstruction("总结这个 podcast")).toContain("longer or unprobeable videos are attached directly");
    } finally {
      restoreEnv("ASR_HTTP_URL", previousHttp);
      restoreEnv("ASR_CLI_PYTHON", previousCli);
      restoreEnv("TINGWU_ASR_DIR", previousTingwu);
      resetCloudAsrConfiguredCacheForTests();
    }
  });

  it("combines independent turn-only instructions without empty blocks", () => {
    expect(mergeTurnInstructions(undefined, " one ", "two")).toBe("one\n\ntwo");
    expect(mergeTurnInstructions(undefined, "  ")).toBeUndefined();
  });
});
