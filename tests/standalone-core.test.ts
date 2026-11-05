import { describe, expect, it, vi } from "vitest";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { requestCoreApproval } from "../src/core/card-actions.js";
import { buildEngineEnvironment } from "../src/core/engine-factory.js";
import { loadGatewayEnvironment } from "../src/gateway/environment.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("standalone core transport boundary", () => {
  it("never discovers a transport from ambient credentials; integrations require explicit ports", async () => {
    const runtime = createCoreServiceRuntime();
    expect(await runtime.detectLarkCli()).toEqual({ available: false });
    await expect(runtime.createChat({ name: "test", mode: "group" })).rejects.toThrow("platform_integration_unavailable");
    await expect(runtime.createDocument({ content: "test" })).rejects.toThrow("platform_integration_unavailable");
    const createDocument = vi.fn(async () => ({ documentId: "opt-in" }));
    expect(await createCoreServiceRuntime({ createDocument }).createDocument({ content: "chosen by owner" })).toEqual({ documentId: "opt-in" });
    expect(createDocument).toHaveBeenCalledWith({ content: "chosen by owner" });
  });
  it("keeps user-enabled App tool credentials while legacy channel credentials stay private", () => {
    vi.stubEnv("LARK_APP_SECRET", "optional-tool-secret");
    try { expect(buildEngineEnvironment({}, "gateway").LARK_APP_SECRET).toBe("optional-tool-secret"); expect(buildEngineEnvironment({}, "lark").LARK_APP_SECRET).toBeUndefined(); }
    finally { vi.unstubAllEnvs(); }
  });
  it("cannot resurrect a cancelled approval when a transport reports managed cards unavailable late", async () => {
    const runtime = createCoreServiceRuntime(), abort = new AbortController();
    let release!: () => void;
    const channel = { send: vi.fn(async () => ({ messageId: "should-not-send" })), stream: vi.fn(), downloadResource: vi.fn(), managedCards: { send: () => new Promise<undefined>(resolve => { release = () => resolve(undefined); }), update: vi.fn(), updateElement: vi.fn() } };
    const answer = requestCoreApproval({ channel, runtime, chatId: "chat", abortSignal: abort.signal, request: { engine: "claude", toolName: "AskUserQuestion", toolInput: { questions: [{ question: "Pick", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] } } });
    abort.abort(); expect(await answer).toEqual({ behavior: "deny" }); release();
    await new Promise(resolve => setImmediate(resolve));
    expect(channel.send).not.toHaveBeenCalled(); expect(runtime.pendingApprovals.size).toBe(0);
  });
  it("prefers bot.env while preserving historical settings and optional tool credentials", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "standalone-env-"));
    try {
      await writeFile(path.join(state, "lark.env"), "IFIND_TOKEN=historical\nASR_MAX_AUDIO_SECONDS=60\nLARK_APP_SECRET=unused-channel-secret\n");
      await writeFile(path.join(state, "bot.env"), "IFIND_TOKEN=chosen-tool-token\nNODE_OPTIONS=--require=wrong\nASR_MAX_AUDIO_SECONDS=90\n");
      const env = await loadGatewayEnvironment(state, "fixture", {});
      expect(env.IFIND_TOKEN).toBe("chosen-tool-token"); expect(env.ASR_MAX_AUDIO_SECONDS).toBe("90");
      expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.LARK_APP_SECRET).toBeUndefined();
      expect((await loadGatewayEnvironment(state, "fixture", { LARK_APP_ID: "explicit-optional-tool", LARK_APP_SECRET: "explicit-optional-secret" })).LARK_APP_ID).toBe("explicit-optional-tool");
    } finally { await rm(state, { recursive: true, force: true }); }
  });
});
