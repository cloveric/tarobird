import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineNativeInputUnsentError, type CodexAdapter } from "../src/codex/adapter.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { normalizeCoreMessage } from "../src/core/message-normalizer.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { Bridge, type AccessStoreLike, type SessionManagerLike } from "../src/runtime/bridge.js";
import { fakeChannel, fakeLarkMessage } from "./helpers/core-compat-fixtures.js";

describe("Claude review input through shared Core and Bridge", () => {
  let stateDir: string;
  beforeEach(async () => { stateDir = await mkdtemp(path.join(os.tmpdir(), "review-core-")); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "en" })); });
  afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });
  const admission = () => ({ reviewAdmission: "native" as const, nativeInput: { id: "native-input", onProgress: vi.fn() } });
  it("carries admission only for direct human inputs", () => {
    const message = { ...fakeLarkMessage(), ...admission() };
    expect(normalizeCoreMessage(message)).toMatchObject({ reviewAdmission: "native", nativeInput: message.nativeInput });
    for (const extra of [{ chatType: "group", mentionedBot: true }, { botSource: {} }, { agentBus: {} }, { groupDiscussion: {} }]) {
      expect(normalizeCoreMessage({ ...message, ...extra } as never)).not.toHaveProperty("reviewAdmission");
    }
  });
  it.each(["not_admitted", "withdrawn"] as const)("silently settles and recalls the empty run when input is %s", async reason => {
    const channel = { ...fakeChannel(), profile: "gateway" as const };
    const bridge = { handleAuthorizedMessage: vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
      expect(input.reviewAdmission).toBe("native"); expect(input.nativeInput?.id).toBe("native-input");
      throw new EngineNativeInputUnsentError(reason);
    }) };
    const runtime = createCoreServiceRuntime();
    const result = await withChannelProfile("gateway", () => handleCoreMessage({ channel, bridge, runtime, stateDir, message: { ...fakeLarkMessage(), ...admission() } }));
    expect(result).toBe(true); expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
    expect(channel.recallMessage).toHaveBeenCalledWith("sent_1"); expect(runtime.activeRuns.size).toBe(0);
    // No delivery-repair turn, generic failure text, or phantom active reply.
    expect(channel.send.mock.calls.filter(([,input]) => "markdown" in input)).toEqual([]);
  });
  it("uses one trusted owner for target reads and writes; no target read creates a session", async () => {
    const access: AccessStoreLike = { load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [84], pairedUsers: [], pendingPairs: [] }), issuePairingCode: vi.fn() };
    const manager: SessionManagerLike = { getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "session" }), getExistingSession: vi.fn().mockResolvedValue({ sessionId: "session" }), bindSession: vi.fn() };
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }), backgroundInputTarget: vi.fn().mockReturnValue("target") };
    const bridge = new Bridge(access, manager, adapter), input = { chatId: 84, conversationKey: "lark:chat", userId: 42, chatType: "private", text: "Hello", files: [], ...admission() };
    expect(await bridge.backgroundInputTarget(input)).toBe("target"); expect(manager.getOrCreateSession).not.toHaveBeenCalled();
    await bridge.handleAuthorizedMessage(input);
    const read = vi.mocked(adapter.backgroundInputTarget!).mock.calls[0]!;
    const sent = vi.mocked(adapter.sendUserMessage).mock.calls[0]![1];
    expect(read[1]).toBe(sent.inputOwnerKey); expect(sent.inputOwnerKey).toBeTruthy();
    expect(sent.reviewAdmission).toBe("native"); expect(sent.nativeInput).toBe(input.nativeInput);
  });
});
