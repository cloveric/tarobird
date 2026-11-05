import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { handleDelegationCoreCommand } from "../src/core/shared/delegation-commands.js";
import { BusProtocolError } from "../src/bus/bus-protocol.js";
import { parseAuditEvents } from "../src/state/audit-log.js";
import type { CommandMessage } from "../src/runtime/command-message.js";

function createNormalizedMessage(text: string): CommandMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("handleDelegationTelegramCommand", () => {
  it.each(["/ask", "/ask peer", "/ask peer \u200b", "/fan", "/CHAIN  ", "/verify\n", "/fan@bot \u200b", "/fan --bots=peer", "/chain --bots=peer --", "/VERIFY@bot --bots=peer -- \n", "/fan --bots=one,two --", "/chain --bots=peer -- \u200d", "/verify --bots=peer -- \u2060"])("handles incomplete %s without falling through to a model", async text => {
    const api = { sendMessage: vi.fn() }, bridge = { handleAuthorizedMessage: vi.fn() }, delegate = vi.fn();
    const handled = await handleDelegationCoreCommand({ stateDir: "/unused", startedAt: Date.now(), locale: "zh", cfg: {}, normalized: createNormalizedMessage(text), context: { api, instanceName: "owner" }, bridge, delegateToInstance: delegate, loadBusConfig: vi.fn().mockResolvedValue({ enabled: true, peers: ["peer"] }) });
    expect(handled).toBe(true); expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("用法："));
    expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled(); expect(delegate).not.toHaveBeenCalled();
  });
  it.each(["/fantastic", "请解释 /fan", "/asker"])("leaves ordinary command-like text untouched: %s", async text => {
    const api = { sendMessage: vi.fn() }, bridge = { handleAuthorizedMessage: vi.fn() };
    expect(await handleDelegationCoreCommand({ stateDir: "/unused", startedAt: Date.now(), locale: "zh", cfg: {}, normalized: createNormalizedMessage(text), context: { api }, bridge })).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("handles successful /btw turns and records command audit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "side answer" }),
    };

    try {
      const handled = await handleDelegationCoreCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { disableRuntimeTimeout: true },
        normalized: createNormalizedMessage("/btw hello"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 77,
        },
        bridge: bridge as never,
        loadBusConfig: vi.fn(),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "bus",
        disableRuntimeTimeout: true,
        text: "hello",
      }));
      expect(api.sendMessage).toHaveBeenCalledWith(123, "side answer");
      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "btw",
          responseChars: 11,
          chunkCount: 1,
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects /ask when delegating to the current instance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleDelegationCoreCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/ask default hello"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 78,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn(),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Cannot delegate to yourself.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reports missing /fan parallel bots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleDelegationCoreCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/fan hello"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn().mockResolvedValue({}),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "No parallel bots configured. Add instance names to bus.parallel in config.json.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs /btw on a fresh ephemeral session", async () => {
    // Finding 3: /btw is a one-off side question and must not resume or persist a
    // session. It passes a sessionIdOverride which bypasses getOrCreateSession/bindSession.
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }) };
    const handleAuthorizedMessage = vi.fn().mockResolvedValue({ text: "side answer" });

    try {
      await handleDelegationCoreCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/btw hello"),
        context: { api: api as never, instanceName: "default", updateId: 77 },
        bridge: { handleAuthorizedMessage } as never,
        loadBusConfig: vi.fn(),
        delegateToInstance: vi.fn(),
      });

      const override = handleAuthorizedMessage.mock.calls[0]?.[0]?.sessionIdOverride;
      // Must keep the `telegram-` marker every adapter checks for a FRESH
      // session — a bare `btw-<uuid>` was resumed instead and failed the turn.
      expect(override).toMatch(/^tarobot-btw-/);
    } finally {
      await removeTempRoot(root);
    }
  });

  it.each(["fan", "verify"])("preserves topic scope in the local /%s turn", async (command) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const handleAuthorizedMessage = vi.fn().mockResolvedValue({ text: "local answer" });
    try {
      await handleDelegationCoreCommand({
        stateDir: root, startedAt: Date.now(), locale: "en", cfg: {},
        normalized: { ...createNormalizedMessage(`/${command} hello`), messageThreadId: 7, conversationKey: "chat:123:topic:7" },
        context: { api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }) } as never, instanceName: "default" },
        bridge: { handleAuthorizedMessage } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ parallel: ["peer"], verifier: "peer" }),
        delegateToInstance: vi.fn().mockResolvedValue({ text: "peer answer" }),
      });
      expect(handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({ messageThreadId: 7, conversationKey: "chat:123:topic:7", text: "hello" }));
    } finally { await removeTempRoot(root); }
  });

  it("excludes the current instance from /fan so it does not run twice", async () => {
    // Finding 6: the current instance already runs the prompt locally, so a self-listed
    // bus.parallel entry must be dropped from the peer fan-out.
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }) };
    const handleAuthorizedMessage = vi.fn().mockResolvedValue({ text: "local answer" });
    const delegateToInstance = vi.fn().mockResolvedValue({ text: "peer answer" });

    try {
      const handled = await handleDelegationCoreCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/fan hello"),
        context: { api: api as never, instanceName: "default", updateId: 79 },
        bridge: { handleAuthorizedMessage } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ parallel: ["default", "peer"] }),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      // Local turn runs exactly once; the only delegated peer is "peer", never "default".
      expect(handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(delegateToInstance).toHaveBeenCalledTimes(1);
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({ targetInstance: "peer" }));
      expect(delegateToInstance).not.toHaveBeenCalledWith(expect.objectContaining({ targetInstance: "default" }));
      // "Querying N bots" counts self + remaining peers (1 + 1 = 2).
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Querying 2 bots in parallel...");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("explains both local and peer transport failures in Chinese without retrying fan branches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fan-error-presentation-"));
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }) };
    const handleAuthorizedMessage = vi.fn().mockRejectedValue(new BusProtocolError({ code: "timeout", message: "raw deadline diagnostic", retryable: false }));
    const delegateToInstance = vi.fn().mockRejectedValue(new BusProtocolError({ code: "connection_lost", message: "raw socket diagnostic", retryable: false }));
    try {
      await handleDelegationCoreCommand({
        stateDir: root, startedAt: Date.now(), locale: "zh", cfg: {},
        normalized: createNormalizedMessage("/fan task"),
        context: { api: api as never, instanceName: "default", updateId: 79 },
        bridge: { handleAuthorizedMessage } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ parallel: ["peer"] }),
        delegateToInstance,
      });
      const text = api.sendMessage.mock.calls.map((call) => String(call[1])).join("\n");
      expect(text).toContain("未在设定时限内返回");
      expect(text).toContain("执行结果尚未确认，未自动重发");
      expect(text).not.toContain("raw deadline diagnostic");
      expect(text).not.toContain("raw socket diagnostic");
      expect(handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(delegateToInstance).toHaveBeenCalledTimes(1);
    } finally { await removeTempRoot(root); }
  });

  it("runs a local-only fan when the only configured parallel target is the current instance", async () => {
    // Finding 6 + self-review: self is excluded from the peer fan-out so it never
    // runs twice, but a bus.parallel that lists ONLY the current instance still has
    // runnable content — it must run locally (once), not error as "unconfigured".
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }) };
    const handleAuthorizedMessage = vi.fn().mockResolvedValue({ text: "local answer" });
    const delegateToInstance = vi.fn();

    try {
      const handled = await handleDelegationCoreCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/fan hello"),
        context: { api: api as never, instanceName: "default", updateId: 79 },
        bridge: { handleAuthorizedMessage } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ parallel: ["default"] }),
        delegateToInstance,
      });

      expect(handled).toBe(true);
      // Runs locally exactly once, never delegates to itself, never errors.
      expect(handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(delegateToInstance).not.toHaveBeenCalled();
      const sent = api.sendMessage.mock.calls.map((call) => String(call[1]));
      expect(sent.some((text) => text.includes("No parallel bots configured"))).toBe(false);
      expect(sent.some((text) => text.includes("local answer"))).toBe(true);
    } finally {
      await removeTempRoot(root);
    }
  });

  it.each((["zh", "en"] as const).flatMap(locale => (["none", "local", "peer", "prior-failure", "mixed", "all", "not-stopped"] as const).map(scenario => ({ locale, scenario }))))("renders truthful stopped fan results: $locale / $scenario", async ({ locale, scenario }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fan-stop-summary-"));
    const controller = new AbortController(), local = deferred<{ text: string }>(), peer = deferred<{ text: string }>(), extra = deferred<{ text: string }>();
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }) };
    const handleAuthorizedMessage = vi.fn(() => local.promise);
    const delegateToInstance = vi.fn((input: { targetInstance: string }) => input.targetInstance === "gamma" ? extra.promise : peer.promise);
    const targets = scenario === "mixed" ? ["beta", "gamma"] : ["beta"];
    try {
      const running = handleDelegationCoreCommand({ stateDir: root, startedAt: Date.now(), locale, cfg: {}, normalized: createNormalizedMessage("/fan task"),
        context: { api: api as never, instanceName: "alpha", abortSignal: controller.signal }, bridge: { handleAuthorizedMessage } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ parallel: targets }), delegateToInstance: delegateToInstance as never });
      await vi.waitFor(() => expect(delegateToInstance).toHaveBeenCalledTimes(targets.length));
      if (["local", "mixed", "all"].includes(scenario)) local.resolve({ text: "LOCAL_COMPLETED" });
      if (["peer", "all", "not-stopped"].includes(scenario)) peer.resolve({ text: "PEER_COMPLETED" });
      if (scenario === "prior-failure") local.reject(new Error("REAL_FAILURE_BEFORE_STOP"));
      if (scenario === "mixed") peer.reject(new Error("REAL_FAILURE_BEFORE_STOP"));
      if (scenario === "not-stopped") local.reject(new Error("Delegation was cancelled but this is an ordinary failure"));
      // Let successful results and genuine earlier failures settle before Stop.
      // For all-success, both promises resolve immediately before the request.
      if (scenario !== "all") await new Promise<void>(resolve => setImmediate(resolve));
      if (scenario !== "not-stopped") controller.abort(new Error("explicit_user_stop"));
      if (["none", "peer"].includes(scenario)) local.reject(new Error("lab_engine_aborted"));
      if (["none", "local", "prior-failure"].includes(scenario)) peer.reject(new Error("RAW_DELEGATION_CANCELLED"));
      if (scenario === "mixed") extra.reject(new Error("RAW_DELEGATION_CANCELLED"));
      expect(await running).toBe(true);
      const text = String(api.sendMessage.mock.calls.at(-1)![1]);
      const stopped = locale === "zh" ? "已停止，未返回完成结果。" : "Stopped before returning a completed result.";
      if (scenario === "none" || scenario === "prior-failure") {
        expect(text).toContain(locale === "zh" ? "协作已停止，尚未取得完成结果。" : "Collaboration stopped. No completed results were received.");
        expect(text).not.toContain(locale === "zh" ? "以下为已取得的结果" : "Available results follow");
        expect(text).toContain(`[beta] ${stopped}`);
        if (scenario === "none") expect(text).toContain(`[alpha] ${stopped}`);
        else expect(text).toContain("[alpha] Error: REAL_FAILURE_BEFORE_STOP");
      } else if (["local", "peer", "mixed"].includes(scenario)) {
        const total = scenario === "mixed" ? 3 : 2;
        expect(text).toContain(locale === "zh" ? `协作已停止，已保留 1/${total} 个 Bot 返回的结果。` : `Collaboration stopped. Results from 1/${total} Bots were preserved.`);
        expect(text).toContain(scenario === "peer" ? "[beta]\nPEER_COMPLETED" : "[alpha]\nLOCAL_COMPLETED");
        expect(text).toContain(`[${scenario === "mixed" ? "gamma" : scenario === "peer" ? "alpha" : "beta"}] ${stopped}`);
        if (scenario === "mixed") expect(text).toContain("[beta] Error: REAL_FAILURE_BEFORE_STOP");
      } else if (scenario === "all") {
        expect(text).toContain(locale === "zh" ? "已收到停止请求；所有 2 个 Bot 均已返回结果。" : "Stop requested. All 2 Bots returned results.");
        expect(text).toContain("[alpha]\nLOCAL_COMPLETED");
        expect(text).toContain("[beta]\nPEER_COMPLETED");
        expect(text).not.toContain(stopped);
      } else {
        expect(text).toContain("[alpha] Error: Delegation was cancelled but this is an ordinary failure");
        expect(text).toContain(locale === "zh" ? "部分完成：1/2 个 Bot 返回结果。" : "Partially completed: 1/2 Bots returned results.");
        expect(text).not.toContain(stopped);
        expect(text).not.toContain(locale === "zh" ? "协作已停止" : "Collaboration stopped");
      }
      expect(text).not.toContain("lab_engine_aborted");
      expect(text).not.toContain("RAW_DELEGATION_CANCELLED");
      expect(handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(delegateToInstance).toHaveBeenCalledTimes(targets.length);
    } finally { await removeTempRoot(root); }
  });

  it("reports missing /chain bots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleDelegationCoreCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/chain hello"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 79,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn().mockResolvedValue({}),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "No chain bots configured. Add instance names to bus.chain in config.json.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects /verify when the verifier is the current instance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleDelegationCoreCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/verify hello"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 80,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ verifier: "default" }),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Verifier cannot be the same instance.");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs /chain sequentially across configured bots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ text: "draft from reviewer" })
      .mockResolvedValueOnce({ text: "final from writer" });

    try {
      const handled = await handleDelegationCoreCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/chain improve this answer"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 81,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ chain: ["reviewer", "writer"] }),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      expect(delegateToInstance).toHaveBeenNthCalledWith(1, expect.objectContaining({
        fromInstance: "default",
        targetInstance: "reviewer",
        prompt: "improve this answer",
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(2, expect.objectContaining({
        fromInstance: "default",
        targetInstance: "writer",
        prompt: expect.stringContaining("draft from reviewer"),
      }));
      expect(api.sendMessage).toHaveBeenCalledWith(123, "Running chain across 2 bots...");
      expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("[Chain stage 1: reviewer]"));
      expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("[Chain stage 2: writer]"));

      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "chain",
          chainTargets: ["reviewer", "writer"],
          stageCount: 2,
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects /chain when the configured targets include the current instance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-delegation-commands-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };

    try {
      const handled = await handleDelegationCoreCommand({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("/chain improve this answer"),
        context: {
          api: api as never,
          instanceName: "default",
          updateId: 82,
        },
        bridge: {
          handleAuthorizedMessage: vi.fn(),
        } as never,
        loadBusConfig: vi.fn().mockResolvedValue({ chain: ["reviewer", "default"] }),
        delegateToInstance: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        "Chain config cannot include the current instance. Remove self-targets from bus.chain.",
      );
    } finally {
      await removeTempRoot(root);
    }
  });
});
