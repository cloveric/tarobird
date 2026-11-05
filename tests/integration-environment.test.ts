import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadGatewayEnvironment } from "../src/gateway/environment.js";
import { createDefaultTranscribeVoice } from "../src/core/voice.js";
import { parseIntegrationEnvironment } from "../src/runtime/integration-environment.js";
import { localAsrAgentInstruction, resetCloudAsrConfiguredCacheForTests } from "../src/core/agent-instructions.js";

it("advertises a fresh Qwen installation and honors CLI-only configuration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tarobot-asr-instructions-"));
  const installed = path.join(home, ".tarobot/integrations/qwen3-asr");
  try {
    await mkdir(path.join(installed, ".venv/bin"), { recursive: true });
    const python = path.join(installed, ".venv/bin/python"), script = path.join(installed, "transcribe.py");
    await writeFile(python, "fixture"); await writeFile(script, "fixture");
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", undefined);
    for (const key of ["ASR_HTTP_URL", "ASR_CLI_PYTHON", "ASR_CLI_SCRIPT", "TINGWU_ASR_DIR"]) vi.stubEnv(key, undefined);
    resetCloudAsrConfiguredCacheForTests();
    expect(localAsrAgentInstruction()).toContain("local Qwen");
    expect(localAsrAgentInstruction()).toContain(script);
    vi.stubEnv("ASR_HTTP_URL", "");
    const cliOnly = localAsrAgentInstruction();
    expect(cliOnly).toContain(python); expect(cliOnly).toContain(script);
    expect(cliOnly).not.toContain("curl"); expect(cliOnly).not.toContain("8412");
  } finally { vi.unstubAllEnvs(); resetCloudAsrConfiguredCacheForTests(); await rm(home, { recursive: true, force: true }); }
});

it("loads private shared settings for new Bots with explicit/instance precedence and reserved process isolation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tarobot-integrations-"));
  try {
    const state = path.join(home, "hub/bots/alpha");
    await mkdir(state, { recursive: true }); await mkdir(path.join(home, ".tarobot")); await mkdir(path.join(home, ".cctb"));
    await writeFile(path.join(home, ".cctb/shared.env"), "BRAVE_API_KEY=legacy\nIFIND_TOKEN=legacy-ifind\n");
    await writeFile(path.join(home, ".tarobot/integrations.env"), 'BRAVE_API_KEY=private-fixture\nTAVILY_API_KEY=private-tavily\nASR_HTTP_URL=http://127.0.0.1:5555/transcribe\nASR_CLI_SCRIPT="/path with spaces/transcribe.py"\nTINGWU_ASR_DIR=/private/tingwu\nASR_CLOUD_THRESHOLD_SECONDS=901\nASR_CLOUD_MODE=cloud\nNODE_OPTIONS=--require=bad\nCODEX_HOME=/wrong\nCLAUDE_CONFIG_DIR=/wrong\nLARK_APP_SECRET=wrong\n');
    await writeFile(path.join(state, "bot.env"), 'TAVILY_API_KEY=\nASR_HTTP_URL=""\n');
    const loaded = await loadGatewayEnvironment(state, "alpha", { HOME: home, BRAVE_API_KEY: "explicit" });
    expect(loaded).toMatchObject({ BRAVE_API_KEY: "explicit", TAVILY_API_KEY: "", ASR_HTTP_URL: "", ASR_CLI_SCRIPT: "/path with spaces/transcribe.py", TINGWU_ASR_DIR: "/private/tingwu", ASR_CLOUD_THRESHOLD_SECONDS: "901", ASR_CLOUD_MODE: "cloud", IFIND_TOKEN: "legacy-ifind" });
    for (const key of ["NODE_OPTIONS", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "LARK_APP_SECRET"]) expect(loaded[key]).toBeUndefined();
    const fresh = await loadGatewayEnvironment(path.join(home, "fresh"), "fresh", { HOME: home });
    expect(fresh).toMatchObject({ BRAVE_API_KEY: "private-fixture", ASR_HTTP_URL: "http://127.0.0.1:5555/transcribe" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("reads local ASR settings after module import and keeps per-factory environments isolated", async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => "配置已生效" });
  const calls: string[] = [];
  const execFileImpl = ((file: string, _args: string[], _options: unknown, callback: Function) => { calls.push(file); callback(null, file === "ffprobe" ? "5" : "CLI transcript", ""); }) as never;
  const first = createDefaultTranscribeVoice({ env: { ASR_HTTP_URL: "http://configured/transcribe", ASR_HTTP_TIMEOUT_MS: "1000", ASR_CLI_PYTHON: "", ASR_CLI_SCRIPT: "" }, fetchImpl, execFileImpl });
  const second = createDefaultTranscribeVoice({ env: { ASR_HTTP_URL: "", ASR_CLI_PYTHON: "/private/python", ASR_CLI_SCRIPT: "/private/transcribe.py" }, fetchImpl, execFileImpl });
  expect(await first("voice.ogg")).toBe("配置已生效");
  expect(fetchImpl.mock.calls[0]![0]).toBe("http://configured/transcribe");
  expect(await second("voice.ogg")).toBe("CLI transcript");
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(calls).toEqual(["ffprobe", "ffprobe", "/private/python"]);
});

it("parses quoted paths literally and refuses other process variables", () => {
  expect(parseIntegrationEnvironment('ASR_CLI_SCRIPT="/space dir/$(do-not-run).py"\nASR_HTTP_URL=\nNODE_OPTIONS=bad\n# ASR_MODEL_PATH=no\nASR_UNKNOWN_CONTROL=bad')).toEqual({ ASR_CLI_SCRIPT: "/space dir/$(do-not-run).py", ASR_HTTP_URL: "" });
});
