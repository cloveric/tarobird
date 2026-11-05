import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { delegateToInstance as busDelegateToInstance } from "../src/bus/bus-client.js";
import { registerInstance } from "../src/bus/bus-registry.js";
import { createBusServer, startBusServer, stopBusServer } from "../src/bus/bus-server.js";
import { parseAuditEvents } from "../src/state/audit-log.js";
import { CrewRunStore } from "../src/state/crew-run-store.js";
import { handleCrewCoreWorkflow } from "../src/core/shared/crew-workflow.js";
import type { CommandMessage } from "../src/runtime/command-message.js";
import { removeTempRoot } from "./helpers/temp-files.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createNormalizedMessage(text: string): CommandMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments: [],
  };
}

function createCrewConfig(overrides?: {
  peers?: "*";
  maxDepth?: number;
  port?: number;
  secret?: string;
  parallel?: string[];
  chain?: string[];
  verifier?: string | null;
  crew?: Partial<ReturnType<typeof createCrewConfigBase>["crew"]> & {
    roles?: Partial<ReturnType<typeof createCrewConfigBase>["crew"]["roles"]>;
  };
}) {
  return {
    ...createCrewConfigBase(),
    ...overrides,
    crew: {
      ...createCrewConfigBase().crew,
      ...(overrides?.crew ?? {}),
      roles: {
        ...createCrewConfigBase().crew.roles,
        ...(overrides?.crew?.roles ?? {}),
      },
    },
  };
}

function createCrewConfigBase() {
  return {
    peers: "*",
    maxDepth: 3,
    port: 0,
    secret: "secret",
    parallel: [],
    chain: [],
    verifier: null,
    crew: {
      enabled: true,
      workflow: "research-report" as const,
      coordinator: "coordinator",
      roles: {
        researcher: "researcher",
        analyst: "analyst",
        writer: "writer",
        reviewer: "reviewer",
      },
      maxResearchQuestions: 4,
      maxRevisionRounds: 1,
    },
  };
}

describe("handleCrewTelegramWorkflow", () => {
  it("runs the fixed research-report workflow through the coordinator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({
        text: "1. Which industries are changing fastest?\n2. What measurable impact is already visible?",
      }),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ text: "Research findings A" })
      .mockResolvedValueOnce({ text: "Research findings B" })
      .mockResolvedValueOnce({ text: "Analysis summary" })
      .mockResolvedValueOnce({ text: "Draft report" })
      .mockResolvedValueOnce({ text: "VERDICT: PASS\nISSUES:\n- none" });

    try {
      const handled = await handleCrewCoreWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: { disableRuntimeTimeout: true },
        normalized: createNormalizedMessage("Analyze how AI is changing major industries."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 90,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const coordinatorInput = bridge.handleAuthorizedMessage.mock.calls[0]?.[0];
      expect(coordinatorInput?.disableRuntimeTimeout).toBe(true);
      expect(coordinatorInput?.chatId).toBeLessThan(-9_000_000_000_000_000);
      expect(delegateToInstance).toHaveBeenNthCalledWith(1, expect.objectContaining({
        fromInstance: "coordinator",
        targetInstance: "researcher",
        prompt: expect.stringContaining("Your only job is to find accurate"),
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(3, expect.objectContaining({
        targetInstance: "analyst",
        prompt: expect.stringContaining("Research findings A"),
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(4, expect.objectContaining({
        targetInstance: "writer",
        prompt: expect.stringContaining("Analysis summary"),
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(5, expect.objectContaining({
        targetInstance: "reviewer",
        prompt: expect.stringContaining("Draft report"),
      }));
      expect(sendMessage).toHaveBeenCalledWith(123, "Running research-report crew...");
      expect(sendMessage).toHaveBeenCalledWith(123, "Draft report");

      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "crew",
          workflow: "research-report",
          coordinator: "coordinator",
          reviewerVerdict: "pass",
        }),
      }));

      const runFiles = await readdir(path.join(root, "crew-runs"));
      expect(runFiles).toHaveLength(1);
      const crewRun = JSON.parse(
        await readFile(path.join(root, "crew-runs", runFiles[0]!), "utf8"),
      ) as Record<string, unknown>;
      expect(crewRun).toEqual(expect.objectContaining({
        workflow: "research-report",
        status: "completed",
        currentStage: "completed",
        coordinator: "coordinator",
        originalPrompt: "Analyze how AI is changing major industries.",
        finalOutput: "Draft report",
        stages: expect.objectContaining({
          decomposition: expect.objectContaining({
            status: "completed",
            subQuestions: [
              "Which industries are changing fastest?",
              "What measurable impact is already visible?",
            ],
          }),
          research: expect.objectContaining({
            status: "completed",
            findings: ["Research findings A", "Research findings B"],
          }),
          analysis: expect.objectContaining({
            status: "completed",
            output: "Analysis summary",
          }),
          writing: expect.objectContaining({
            status: "completed",
            draft: "Draft report",
            revisionCount: 0,
          }),
          review: expect.objectContaining({
            status: "completed",
            verdict: "pass",
            issues: "- none",
          }),
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("routes reviewer issues back to the writer for one revision round", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({
        text: "1. What happened?\n2. Why does it matter?",
      }),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ text: "Research X" })
      .mockResolvedValueOnce({ text: "Research Y" })
      .mockResolvedValueOnce({ text: "Analysis Z" })
      .mockResolvedValueOnce({ text: "Initial draft" })
      .mockResolvedValueOnce({ text: "VERDICT: REVISE\nISSUES:\n- Add concrete numbers." })
      .mockResolvedValueOnce({ text: "Revised draft with numbers" })
      .mockResolvedValueOnce({ text: "VERDICT: PASS\nISSUES:\n- none" });

    try {
      const handled = await handleCrewCoreWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Explain the business impact of AI."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 91,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      expect(delegateToInstance).toHaveBeenNthCalledWith(6, expect.objectContaining({
        targetInstance: "writer",
        prompt: expect.stringContaining("Add concrete numbers."),
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(7, expect.objectContaining({
        targetInstance: "reviewer",
        prompt: expect.stringContaining("Revised draft with numbers"),
      }));
      expect(sendMessage).toHaveBeenCalledWith(123, "Revised draft with numbers");

      const runFiles = await readdir(path.join(root, "crew-runs"));
      expect(runFiles).toHaveLength(1);
      const crewRun = JSON.parse(
        await readFile(path.join(root, "crew-runs", runFiles[0]!), "utf8"),
      ) as Record<string, unknown>;
      expect(crewRun).toEqual(expect.objectContaining({
        status: "completed",
        currentStage: "completed",
        finalOutput: "Revised draft with numbers",
        stages: expect.objectContaining({
          writing: expect.objectContaining({
            status: "completed",
            draft: "Revised draft with numbers",
            revisionCount: 1,
          }),
          review: expect.objectContaining({
            status: "completed",
            verdict: "pass",
            issues: "- none",
          }),
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("supports more than one revision round when maxRevisionRounds allows it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({
        text: "1. What happened?\n2. Why does it matter?",
      }),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ text: "Research X" })
      .mockResolvedValueOnce({ text: "Research Y" })
      .mockResolvedValueOnce({ text: "Analysis Z" })
      .mockResolvedValueOnce({ text: "Initial draft" })
      .mockResolvedValueOnce({ text: "VERDICT: REVISE\nISSUES:\n- Add concrete numbers." })
      .mockResolvedValueOnce({ text: "Revised draft with numbers" })
      .mockResolvedValueOnce({ text: "VERDICT: PASS\nISSUES:\n- none" });

    try {
      const handled = await handleCrewCoreWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Explain the business impact of AI."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 92,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig({
          crew: { maxRevisionRounds: 2 },
        })),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      expect(delegateToInstance).toHaveBeenNthCalledWith(6, expect.objectContaining({
        targetInstance: "writer",
        prompt: expect.stringContaining("Add concrete numbers."),
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(7, expect.objectContaining({
        targetInstance: "reviewer",
        prompt: expect.stringContaining("Revised draft with numbers"),
      }));
      expect(sendMessage).toHaveBeenCalledWith(123, "Revised draft with numbers");

      const runFiles = await readdir(path.join(root, "crew-runs"));
      const crewRun = JSON.parse(
        await readFile(path.join(root, "crew-runs", runFiles[0]!), "utf8"),
      ) as Record<string, unknown>;
      expect(crewRun).toEqual(expect.objectContaining({
        status: "completed",
        finalOutput: "Revised draft with numbers",
        stages: expect.objectContaining({
          writing: expect.objectContaining({
            revisionCount: 1,
          }),
          review: expect.objectContaining({
            verdict: "pass",
          }),
        }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects a second crew run for the same chat while one is already active", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridgeGate = createDeferred<{ text: string }>();
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockReturnValueOnce(bridgeGate.promise),
    };

    try {
      const firstRun = handleCrewCoreWorkflow({
        stateDir: root,
        startedAt: Date.now(),
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Analyze adoption trends."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 93,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: vi.fn() as never,
      });

      await Promise.resolve();

      const handledSecond = await handleCrewCoreWorkflow({
        stateDir: root,
        startedAt: Date.now(),
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Analyze adoption trends."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 94,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: vi.fn() as never,
      });

      expect(handledSecond).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(123, "A crew run is already active for this chat.");

      bridgeGate.resolve({
        text: "1. Which industries are changing fastest?\n2. What measurable impact is already visible?",
      });
      await firstRun;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs research sub-questions in parallel and continues when one specialist fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({
        text: "1. What changed first?\n2. What is measurable now?",
      }),
    };
    const firstResearch = createDeferred<{ text: string }>();
    const secondResearch = createDeferred<{ text: string }>();
    const researchCalls: string[] = [];
    const delegateToInstance = vi.fn().mockImplementation(async (input: { targetInstance: string; prompt: string }) => {
      if (input.targetInstance === "researcher") {
        researchCalls.push(input.prompt);
        if (researchCalls.length === 1) {
          return await firstResearch.promise;
        }
        return await secondResearch.promise;
      }
      if (input.targetInstance === "analyst") {
        return { text: "Analysis summary" };
      }
      if (input.targetInstance === "writer") {
        return { text: "Draft report" };
      }
      if (input.targetInstance === "reviewer") {
        return { text: "VERDICT: PASS\nISSUES:\n- none" };
      }
      throw new Error(`unexpected target ${input.targetInstance}`);
    });

    try {
      const runPromise = handleCrewCoreWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Explain the impact of AI."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 95,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: delegateToInstance as never,
      });

      await vi.waitFor(() => {
        expect(researchCalls).toHaveLength(2);
      });
      expect(researchCalls).toHaveLength(2);

      firstResearch.resolve({ text: "Research findings A" });
      secondResearch.reject(new Error("research timeout"));

      const handled = await runPromise;
      expect(handled).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(123, "Research stage completed with 1 failed sub-question.");
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        targetInstance: "analyst",
        prompt: expect.stringContaining("Research findings A"),
      }));
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        targetInstance: "analyst",
        prompt: expect.stringContaining("RESEARCH FAILED: research timeout"),
      }));
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await removeTempRoot(root);
    }
  });

  it("keeps the last successfully-entered stage when the next stage state update fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({
        text: "1. What changed first?\n2. What is measurable now?",
      }),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ text: "Research findings A" })
      .mockResolvedValueOnce({ text: "Research findings B" });

    const originalUpdate = CrewRunStore.prototype.update;
    const updateSpy = vi.spyOn(CrewRunStore.prototype, "update").mockImplementation(async function(this: CrewRunStore, runId, mutate) {
      return originalUpdate.call(this, runId, (record) => {
        mutate(record);
        if (
          record.currentStage === "analysis" &&
          record.stages.analysis?.status === "running"
        ) {
          throw new Error("simulated state write failure");
        }
      });
    });

    try {
      const handled = await handleCrewCoreWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Explain the impact of AI."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 96,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(123, "Crew execution failed: simulated state write failure");

      const runFiles = await readdir(path.join(root, "crew-runs"));
      const crewRun = JSON.parse(
        await readFile(path.join(root, "crew-runs", runFiles[0]!), "utf8"),
      ) as Record<string, unknown>;

      expect(crewRun).toEqual(expect.objectContaining({
        status: "failed",
        currentStage: "research",
        lastError: "simulated state write failure",
        stages: expect.objectContaining({
          research: expect.objectContaining({
            status: "failed",
          }),
        }),
      }));
    } finally {
      updateSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("releases the active crew lock when setup fails before the workflow try/finally starts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const activeRunKey = "crew-setup-failure-lock";
    const createSpy = vi.spyOn(CrewRunStore.prototype, "create").mockRejectedValueOnce(new Error("state init failed"));

    try {
      await expect(handleCrewCoreWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Explain the impact of AI."),
        context: {
          api: { sendMessage } as never,
          bridge: { handleAuthorizedMessage: vi.fn() } as never,
          instanceName: "coordinator",
          updateId: 97,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: vi.fn() as never,
        activeRunKey,
      })).rejects.toThrow("state init failed");

      createSpy.mockRestore();

      const handled = await handleCrewCoreWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Explain the impact of AI."),
        context: {
          api: { sendMessage } as never,
          bridge: {
            handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({
              text: "1. What changed first?\n2. What is measurable now?",
            }),
          } as never,
          instanceName: "coordinator",
          updateId: 98,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: vi.fn()
          .mockResolvedValueOnce({ text: "Research findings A" })
          .mockResolvedValueOnce({ text: "Research findings B" })
          .mockResolvedValueOnce({ text: "Analysis summary" })
          .mockResolvedValueOnce({ text: "Draft report" })
          .mockResolvedValueOnce({ text: "VERDICT: PASS\nISSUES:\n- none" }) as never,
        activeRunKey,
      });

      expect(handled).toBe(true);
      expect(sendMessage).not.toHaveBeenCalledWith(123, "A crew run is already active for this chat.");
    } finally {
      createSpy.mockRestore();
      await removeTempRoot(root);
    }
  });
});

describe("Agent Bus crew member preflight", () => {
  const unauthorized = "协作成员无效或尚未获准。请重新选择成员并检查协作权限；任务未启动。";
  const roles = (researcher: string, analyst: string, writer: string, reviewer: string) => ({ researcher, analyst, writer, reviewer });
  const crewConfig = (crewRoles: ReturnType<typeof roles>) => ({
    enabled: true, workflow: "research-report" as const, coordinator: "alpha", roles: crewRoles, maxResearchQuestions: 2, maxRevisionRounds: 0,
  });
  // Real Bus state layout: <channel>/<bot>/config.json, as read by bus-client.
  async function channel(bus?: unknown) {
    const channelRoot = await mkdtemp(path.join(os.tmpdir(), "crew-preflight-"));
    const stateDir = path.join(channelRoot, "alpha");
    await mkdir(stateDir, { recursive: true });
    if (bus !== undefined) await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ bus }), "utf8");
    return { channelRoot, stateDir };
  }
  const run = (stateDir: string, crewRoles: ReturnType<typeof roles>, bridge: unknown, delegate: unknown, sendMessage: unknown) => handleCrewCoreWorkflow({
    stateDir, startedAt: Date.now(), locale: "zh", cfg: { disableRuntimeTimeout: true },
    normalized: createNormalizedMessage("研究这个问题"),
    context: { api: { sendMessage } as never, bridge: bridge as never, instanceName: "alpha" },
    delegateToInstance: delegate as never, crewConfig: crewConfig(crewRoles), agentBus: true,
  });

  it.each([
    ["the Bus is disabled", undefined, roles("beta", "beta", "beta", "beta")],
    ["one remote role is not an allowed peer", { peers: ["beta"], secret: "alpha-secret" }, roles("beta", "gamma", "beta", "beta")],
  ])("rejects before any coordinator turn, run record or delegation when %s", async (_case, bus, crewRoles) => {
    const { channelRoot, stateDir } = await channel(bus);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const bridge = { handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "1. 问题一\n2. 问题二" }) };
    const delegate = vi.fn(busDelegateToInstance);
    try {
      expect(await run(stateDir, crewRoles, bridge, delegate, sendMessage)).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(delegate).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls.map(call => call[1])).toEqual([unauthorized]);
      await expect(readdir(path.join(stateDir, "crew-runs"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTempRoot(channelRoot);
    }
  });

  it("keeps repeated-Bot and coordinator-local roles, delegating remote roles through the real Bus", async () => {
    // alpha may delegate only to beta; it is deliberately not its own peer.
    const { channelRoot, stateDir } = await channel({ peers: ["beta"], secret: "alpha-secret" });
    const betaDir = path.join(channelRoot, "beta");
    await mkdir(betaDir, { recursive: true });
    await writeFile(path.join(betaDir, "config.json"), JSON.stringify({ bus: { peers: ["alpha"], secret: "beta-secret" } }), "utf8");
    const prompts: string[] = [];
    const server = createBusServer("beta", betaDir, async (request) => {
      prompts.push(request.prompt);
      return { success: true, text: /VERDICT/.test(request.prompt) ? "VERDICT: PASS\nISSUES:\n- none" : `beta result ${prompts.length}` };
    }, "beta-secret");
    const port = await startBusServer(server, 0);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const bridge = { handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "1. 问题一\n2. 问题二" }) };
    // The Gateway runs the coordinator's own roles locally (no self grant);
    // every other role uses the real bus-client permission and transport path.
    const local = vi.fn().mockResolvedValue({ success: true, text: "alpha analysis" });
    const delegate = vi.fn((input: Parameters<typeof busDelegateToInstance>[0]) => input.targetInstance === "alpha" ? local(input) : busDelegateToInstance(input));
    try {
      await registerInstance(channelRoot, "beta", port, "beta-secret");
      expect(await run(stateDir, roles("beta", "alpha", "beta", "beta"), bridge, delegate, sendMessage)).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(local).toHaveBeenCalledTimes(1);
      expect(prompts).toHaveLength(4);
      const sent = sendMessage.mock.calls.map(call => String(call[1]));
      expect(sent).not.toContain(unauthorized);
      expect(sent.some(text => text.includes("beta result"))).toBe(true);
    } finally {
      await stopBusServer(server);
      await removeTempRoot(channelRoot);
    }
  });

  it("leaves a saved /crew and custom role delegates on their existing path", async () => {
    // Without the Agent Bus marker the workflow behaves as before, even when
    // the saved peers would not pass the explicit-member preflight.
    const root = await mkdtemp(path.join(os.tmpdir(), "crew-preflight-saved-"));
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const bridge = { handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "1. What changed first?\n2. What is measurable now?" }) };
    const delegate = vi.fn()
      .mockResolvedValueOnce({ text: "Research findings A" })
      .mockResolvedValueOnce({ text: "Research findings B" })
      .mockResolvedValueOnce({ text: "Analysis summary" })
      .mockResolvedValueOnce({ text: "Draft report" })
      .mockResolvedValueOnce({ text: "VERDICT: PASS\nISSUES:\n- none" });
    try {
      expect(await handleCrewCoreWorkflow({
        stateDir: root, startedAt: Date.now(), locale: "en", cfg: {},
        normalized: createNormalizedMessage("Explain the impact of AI."),
        context: { api: { sendMessage } as never, bridge: bridge as never, instanceName: "coordinator" },
        loadBusConfig: vi.fn().mockResolvedValue({ ...createCrewConfig(), peers: ["researcher"] }),
        delegateToInstance: delegate as never,
      })).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(delegate).toHaveBeenCalledTimes(5);
      expect(sendMessage).toHaveBeenCalledWith(123, "Draft report");
    } finally {
      await removeTempRoot(root);
    }
  });
});
