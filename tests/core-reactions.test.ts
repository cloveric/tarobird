import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  resolveLarkReactionSettings,
  withLarkMessageReactions,
} from "../src/core/reactions.js";
import { classifyCoreTurnTermination, handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { EngineCancellationUnconfirmedError, EngineStopTooLateError } from "../src/codex/adapter.js";

// The classification gate without a stop signal (message-handler passes the
// turn's own signal; see the handleCoreMessage cases below).
const isLarkTurnFailure = (error: unknown): boolean =>
  classifyCoreTurnTermination(error, undefined).kind === "error";

describe("Core message reactions", () => {
  it("does not mark an unconfirmed engine stop as interrupted just because the user pressed stop", () => {
    const aborted = new AbortController(); aborted.abort();
    expect(classifyCoreTurnTermination(new EngineCancellationUnconfirmedError(), aborted.signal)).toEqual({ kind: "error" });
    expect(classifyCoreTurnTermination(new EngineStopTooLateError(), aborted.signal)).toEqual({ kind: "error" });
  });
  it("defaults to a done/failure reaction only — no processing reaction (the run card already signals progress)", () => {
    expect(resolveLarkReactionSettings({})).toEqual({
      processingEmoji: null,
      doneEmoji: "DONE",
      failureEmoji: "ERROR",
    });
  });

  it("re-enables the processing reaction when CCTB_LARK_REACTION_EMOJI is set", () => {
    expect(resolveLarkReactionSettings({ CCTB_LARK_REACTION_EMOJI: "OnIt" }).processingEmoji).toBe("OnIt");
  });

  it("lets env override or disable reaction emoji", () => {
    expect(resolveLarkReactionSettings({
      CCTB_LARK_REACTION_EMOJI: "Typing",
      CCTB_LARK_DONE_EMOJI: "OK",
      CCTB_LARK_FAILURE_EMOJI: "Crying",
    })).toEqual({
      processingEmoji: "Typing",
      doneEmoji: "OK",
      failureEmoji: "Crying",
    });
    expect(resolveLarkReactionSettings({
      CCTB_LARK_REACTION_EMOJI: "off",
    })).toEqual({
      processingEmoji: null,
      doneEmoji: "DONE",
      failureEmoji: "ERROR",
    });
  });

  it("removes the processing reaction and adds the done reaction after success", async () => {
    const channel = {
      addReaction: vi.fn(async () => "reaction_1"),
      removeReaction: vi.fn(async () => undefined),
    };

    const result = await withLarkMessageReactions({
      channel,
      messageId: "om_1",
      settings: {
        processingEmoji: "OnIt",
        doneEmoji: "DONE",
        failureEmoji: "ERROR",
      },
      run: async () => "ok",
    });

    expect(result).toBe("ok");
    expect(channel.addReaction).toHaveBeenNthCalledWith(1, "om_1", "OnIt");
    expect(channel.removeReaction).toHaveBeenCalledWith("om_1", "reaction_1");
    expect(channel.addReaction).toHaveBeenNthCalledWith(2, "om_1", "DONE");
  });

  it("keeps engine errors intact while best-effort adding failure reaction", async () => {
    const channel = {
      addReaction: vi.fn(async () => "reaction_1"),
      removeReaction: vi.fn(async () => undefined),
    };

    await expect(withLarkMessageReactions({
      channel,
      messageId: "om_1",
      settings: {
        processingEmoji: "OnIt",
        doneEmoji: "DONE",
        failureEmoji: "ERROR",
      },
      run: async () => {
        throw new Error("boom");
      },
    })).rejects.toThrow("boom");

    expect(channel.removeReaction).toHaveBeenCalledWith("om_1", "reaction_1");
    expect(channel.addReaction).toHaveBeenNthCalledWith(2, "om_1", "ERROR");
  });

  it("does not add the failure reaction when the caller classifies the error as non-failure", async () => {
    const channel = {
      addReaction: vi.fn(async () => "reaction_1"),
      removeReaction: vi.fn(async () => undefined),
    };

    await expect(withLarkMessageReactions({
      channel,
      messageId: "om_1",
      settings: {
        processingEmoji: "OnIt",
        doneEmoji: "DONE",
        failureEmoji: "ERROR",
      },
      isFailure: () => false,
      run: async () => {
        throw new Error("Task was stopped by user");
      },
    } as Parameters<typeof withLarkMessageReactions>[0] & { isFailure: () => boolean })).rejects.toThrow("Task was stopped by user");

    expect(channel.removeReaction).toHaveBeenCalledWith("om_1", "reaction_1");
    expect(channel.addReaction).toHaveBeenCalledTimes(1);
  });

  describe("classifyCoreTurnTermination (the real reaction failure gate) — regression #13", () => {
    it("classifies user-stop and idle-timeout terminations as non-failures", () => {
      expect(classifyCoreTurnTermination(new Error("Task was stopped by user"), undefined).kind).toBe("interrupted");
      expect(classifyCoreTurnTermination(new Error("Session inactive after 30 minutes"), undefined).kind).toBe("idle_timeout");
      const aborted = new AbortController();
      aborted.abort();
      expect(classifyCoreTurnTermination(new Error("anything"), aborted.signal).kind).toBe("interrupted");
      // A bare "aborted" is an engine-INTERNAL AbortError unless the caller's
      // signal actually fired: without it, it's a real failure (audit finding).
      expect(classifyCoreTurnTermination(new Error("aborted"), undefined).kind).toBe("error");
      expect(classifyCoreTurnTermination(new Error("aborted"), aborted.signal).kind).toBe("interrupted");
      // A genuine engine error still classifies as a failure.
      expect(classifyCoreTurnTermination(new Error("ECONNRESET"), undefined).kind).toBe("error");
    });

    it("does NOT stamp the failure reaction for a /stop or idle-timeout turn, but does for a real error", async () => {
      const make = () => ({
        addReaction: vi.fn(async () => "reaction_1"),
        removeReaction: vi.fn(async () => undefined),
      });
      const settings = { processingEmoji: "OnIt", doneEmoji: "DONE", failureEmoji: "ERROR" };

      for (const message of ["Task was stopped by user", "Session inactive after 30 minutes"]) {
        const channel = make();
        await expect(withLarkMessageReactions({
          channel,
          messageId: "om_1",
          settings,
          isFailure: isLarkTurnFailure,
          run: async () => { throw new Error(message); },
        } as Parameters<typeof withLarkMessageReactions>[0] & { isFailure: (e: unknown) => boolean }))
          .rejects.toThrow(message);
        // processing reaction removed, but no ERROR reaction added.
        expect(channel.removeReaction).toHaveBeenCalledWith("om_1", "reaction_1");
        expect(channel.addReaction).toHaveBeenCalledTimes(1);
        expect(channel.addReaction).not.toHaveBeenCalledWith("om_1", "ERROR");
      }

      // A real failure DOES get the failure reaction through the same gate.
      const channel = make();
      await expect(withLarkMessageReactions({
        channel,
        messageId: "om_1",
        settings,
        isFailure: isLarkTurnFailure,
        run: async () => { throw new Error("ECONNRESET"); },
      } as Parameters<typeof withLarkMessageReactions>[0] & { isFailure: (e: unknown) => boolean }))
        .rejects.toThrow("ECONNRESET");
      expect(channel.addReaction).toHaveBeenNthCalledWith(2, "om_1", "ERROR");
    });
  });

  describe("handleCoreMessage reaction gate uses the turn's own stop signal", () => {
    // Engine abort errors without "stopped by user" text (DeepSeek, turn pool,
    // app-server) are user interruptions only because this turn's signal fired.
    const runTurn = async (fail: (stop: () => void) => never) => {
      const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-reaction-stop-"));
      const runtime = createCoreServiceRuntime();
      const channel = {
        send: vi.fn(async () => ({ messageId: "sent_1" })),
        updateCard: vi.fn(async () => undefined),
        recallMessage: vi.fn(async () => undefined),
        downloadResource: vi.fn(async () => Buffer.from("")),
        addReaction: vi.fn(async (_messageId: string, emoji: string) => `reaction_${emoji}`),
        removeReaction: vi.fn(async () => undefined),
      };
      const bridge: CoreBridgeLike = {
        handleAuthorizedMessage: vi.fn(async () => fail(() => {
          for (const run of runtime.activeRuns.values()) run.abortController.abort();
        })),
      };
      try {
        await expect(handleCoreMessage({
          channel: channel as never,
          bridge,
          runtime,
          stateDir,
          reactionSettings: { processingEmoji: null, doneEmoji: "DONE", failureEmoji: "ERROR" },
          message: {
            messageId: "om_stop", chatId: "oc_chat", chatType: "p2p", senderId: "ou_user", content: "work",
            rawContentType: "text", resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now(),
          },
        })).resolves.toBe(true);
        return channel.addReaction.mock.calls.map(call => call[1]);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    };

    it("does not stamp ERROR when the user stopped the turn and the engine reports a bare abort", async () => {
      for (const message of ["DeepSeek Harness turn was aborted", "turn pool wait aborted", "Codex app-server turn aborted"]) {
        const reactions = await runTurn((stop) => { stop(); throw new Error(message); });
        expect(reactions, message).not.toContain("ERROR");
      }
    });

    it("keeps ERROR for unconfirmed or too-late stops and for internal aborts without a user stop", async () => {
      expect(await runTurn((stop) => { stop(); throw new EngineCancellationUnconfirmedError(); })).toContain("ERROR");
      expect(await runTurn((stop) => { stop(); throw new EngineStopTooLateError(); })).toContain("ERROR");
      expect(await runTurn(() => { throw new Error("DeepSeek Harness turn was aborted"); })).toContain("ERROR");
    });
  });
});
