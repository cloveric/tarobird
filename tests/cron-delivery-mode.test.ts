import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appCapabilityInstructions, appTurnInstructions } from "../src/gateway/agent-instructions.js";
import { buildCoreCronExecutor } from "../src/core/cron.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { extractCoreToolTagMatches, parseCoreToolTagPayload } from "../src/core/shared/tool-tags.js";
import { buildCronInput, executeCronAddTool } from "../src/tools/cron-add-tool.js";
import { CronStore } from "../src/state/cron-store.js";
import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import { resolveTimelineLogPath } from "../src/state/timeline-log.js";
import { removeTempRoot } from "./helpers/temp-files.js";

describe("Scheduled task deliveryMode clarity (#114)", () => {
  it("provides parseable tool-call envelope examples in schedules guidance that validate against buildCronInput", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cron-guidance-"));
    try {
      const cap = appCapabilityInstructions("schedules", { timezone: "Asia/Shanghai" });
      expect(cap).toContain("deliveryMode");
      expect(cap).toContain("notify");
      expect(cap).toContain("agent");
      expect(cap).toMatch(/one-shot|in\/at/i);

      const capMatches = extractCoreToolTagMatches(cap);
      expect(capMatches).toHaveLength(2);
      expect(extractCoreToolTagMatches(cap.replaceAll("```tool-call", "```json"))).toEqual([]);

      const parsed = capMatches.map((match) => parseCoreToolTagPayload(match.payload));
      expect(parsed).toEqual([
        {
          name: "cron.add",
          payload: {
            at: "2026-11-24T11:31:00+08:00",
            prompt: "Check status and continue",
            deliveryMode: "agent",
          },
        },
        {
          name: "cron.add",
          payload: {
            in: "10m",
            prompt: "Drink water",
            deliveryMode: "notify",
          },
        },
      ]);

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-11-24T10:00:00+08:00"));
        const ctx = {
          channel: "lark" as const,
          chatId: 1,
          userId: 2,
          chatType: "private" as const,
          larkChatId: "gw_conv1",
          conversationKey: "lark:gw_conv1",
          locale: "en" as const,
          stateDir,
        };
        const agentInput = await buildCronInput(parsed[0]!.payload, ctx);
        expect(agentInput).toMatchObject({
          runOnce: true,
          deliveryMode: "agent",
          prompt: "Check status and continue",
          targetAt: "2026-11-24T03:31:00.000Z",
        });

        const notifyInput = await buildCronInput(parsed[1]!.payload, ctx);
        expect(notifyInput).toMatchObject({
          runOnce: true,
          deliveryMode: "notify",
          prompt: "Drink water",
        });
      } finally {
        vi.useRealTimers();
      }

      const turn = appTurnInstructions("20分钟后提醒另一个 Bot 继续工作", {
        engine: "claude",
        nativeDelivery: true,
        nativeWidgets: true,
      }) ?? "";
      const turnMatches = extractCoreToolTagMatches(turn);
      expect(turnMatches).toHaveLength(2);
      expect(turnMatches.map((match) => parseCoreToolTagPayload(match.payload).name)).toEqual([
        "cron.add",
        "cron.add",
      ]);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("clearly states in cron.add receipt whether the Bot will run or only send a reminder (zh & en)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cron-mode-"));
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn().mockResolvedValue(undefined), runJobNow: vi.fn().mockResolvedValue(undefined) };
    const baseCtx = {
      channel: "lark" as const,
      chatId: 1,
      userId: 2,
      chatType: "private" as const,
      larkChatId: "gw_conv1",
      conversationKey: "lark:gw_conv1",
      stateDir,
      instanceName: "bot1",
      cronRuntime: { store, scheduler },
    };
    try {
      // 1. One-shot default -> notify (zh)
      const notifyZh = await executeCronAddTool({ in: "10m", prompt: "喝水" }, { ...baseCtx, locale: "zh" });
      expect(notifyZh.ok).toBe(true);
      expect(notifyZh.message).toContain("仅发送提醒");
      expect(notifyZh.message).toContain("不会运行 Bot");

      // 2. One-shot default -> notify (en)
      const notifyEn = await executeCronAddTool({ in: "10m", prompt: "Drink water" }, { ...baseCtx, locale: "en" });
      expect(notifyEn.ok).toBe(true);
      expect(notifyEn.message).toMatch(/only reminds you|reminder only/i);
      expect(notifyEn.message).toMatch(/Bot will not run/i);

      // 3. One-shot explicit deliveryMode: "agent" -> agent (zh)
      const agentZh = await executeCronAddTool({ in: "10m", prompt: "检查额度并通知另一个 Bot", deliveryMode: "agent" }, { ...baseCtx, locale: "zh" });
      expect(agentZh.ok).toBe(true);
      expect(agentZh.message).toContain("自动运行 Bot");

      // 4. Recurring default -> agent (en)
      const agentEn = await executeCronAddTool({ cron: "0 9 * * *", prompt: "Send morning digest" }, { ...baseCtx, locale: "en" });
      expect(agentEn.ok).toBe(true);
      expect(agentEn.message).toMatch(/Bot will run/i);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("records deliveryMode on cron.completed timeline events so reminder-only runs are distinguishable", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cron-log-"));
    const store = new CronStore(stateDir);
    try {
      const job = await store.add({
        channel: "lark",
        chatId: 1,
        userId: 2,
        chatType: "private",
        cronExpr: "0 9 * * *",
        prompt: "Standup reminder",
        larkChatId: "gw_conv1",
        conversationKey: "lark:gw_conv1",
        deliveryMode: "notify",
        runOnce: true,
        targetAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const scheduler = new CronScheduler({ store, executor: async () => {}, stateDir });
      try {
        await scheduler.runJobNow(job.id);
      } finally {
        await scheduler.stop();
      }
      const raw = await readFile(resolveTimelineLogPath(stateDir), "utf8");
      const events = raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const completed = events.find(e => e.type === "cron.completed" && e.metadata?.cronJobId === job.id);
      expect(completed).toBeDefined();
      expect(completed?.outcome).toBe("success");
      expect(completed?.metadata?.deliveryMode).toBe("notify");
      expect(completed?.detail).toBe("reminder sent (Bot did not run)");
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("logs muted reminder detail instead of reminder sent when a notify job is muted", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cron-muted-"));
    const store = new CronStore(stateDir);
    const channel = { send: vi.fn().mockResolvedValue({ messageId: "om_unused" }) };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "should not run" }),
    };
    try {
      const coreMutedJob = await store.add({
        channel: "lark",
        chatId: 1,
        userId: 2,
        chatType: "private",
        cronExpr: "0 9 * * *",
        prompt: "Muted reminder",
        larkChatId: "oc_conv1",
        conversationKey: "lark:oc_conv1",
        deliveryMode: "notify",
        mute: true,
        runOnce: true,
        targetAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const fallbackMutedJob = await store.add({
        channel: "lark",
        chatId: 1,
        userId: 2,
        chatType: "private",
        cronExpr: "0 9 * * *",
        prompt: "Fallback muted reminder",
        larkChatId: "oc_conv1",
        conversationKey: "lark:oc_conv1",
        deliveryMode: "notify",
        mute: true,
        runOnce: true,
        targetAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const coreScheduler = new CronScheduler({
        store,
        executor: buildCoreCronExecutor({
          channel: channel as never,
          bridge: bridge as never,
          runtime: createCoreServiceRuntime(),
          stateDir,
        }),
        stateDir,
      });
      const fallbackScheduler = new CronScheduler({ store, executor: async () => {}, stateDir });
      try {
        await coreScheduler.runJobNow(coreMutedJob.id);
        await fallbackScheduler.runJobNow(fallbackMutedJob.id);
      } finally {
        await coreScheduler.stop();
        await fallbackScheduler.stop();
      }

      expect(channel.send).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();

      const raw = await readFile(resolveTimelineLogPath(stateDir), "utf8");
      const events = raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      for (const id of [coreMutedJob.id, fallbackMutedJob.id]) {
        const completed = events.find(e => e.type === "cron.completed" && e.metadata?.cronJobId === id);
        expect(completed).toBeDefined();
        expect(completed?.outcome).toBe("success");
        expect(completed?.detail).toBe("reminder muted (Bot did not run)");
        expect(completed?.metadata?.deliveryMode).toBe("notify");
        expect(completed?.metadata?.mute).toBe(true);
      }
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("logs budget.blocked and budget exhausted detail on cron.completed instead of Bot turn completed", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cron-budget-log-"));
    const store = new CronStore(stateDir);
    const channel = { send: vi.fn().mockResolvedValue({ messageId: "om_budget" }) };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "should not run" }),
    };
    const onJobFailure = vi.fn().mockResolvedValue(undefined);
    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ budgetUsd: 1.0 }), "utf8");
      await writeFile(path.join(stateDir, "usage.json"), JSON.stringify({
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCachedTokens: 0,
        totalCostUsd: 1.25,
        requestCount: 2,
        lastUpdatedAt: "2026-11-24T00:00:00.000Z",
      }), "utf8");

      const job = await store.add({
        channel: "lark",
        chatId: 1,
        userId: 2,
        chatType: "private",
        cronExpr: "0 9 * * *",
        prompt: "Check status and continue",
        larkChatId: "oc_conv1",
        conversationKey: "lark:oc_conv1",
        deliveryMode: "agent",
        locale: "en",
        maxFailures: 1,
      });

      const scheduler = new CronScheduler({
        store,
        executor: buildCoreCronExecutor({
          channel: channel as never,
          bridge: bridge as never,
          runtime: createCoreServiceRuntime(),
          stateDir,
          instanceName: "bot1",
        }),
        stateDir,
        instanceName: "bot1",
        onJobFailure,
      });
      try {
        await scheduler.runJobNow(job.id);
      } finally {
        await scheduler.stop();
      }

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(onJobFailure).not.toHaveBeenCalled();
      expect(await store.get(job.id)).toMatchObject({ enabled: true, failureCount: 0 });

      const raw = await readFile(resolveTimelineLogPath(stateDir), "utf8");
      const events = raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const blocked = events.find(e => e.type === "budget.blocked" && e.metadata?.cronJobId === job.id);
      expect(blocked).toBeDefined();
      expect(blocked?.detail).toBe("budget exhausted");
      expect(blocked?.metadata).toMatchObject({
        cronJobId: job.id,
        budgetUsd: 1.0,
        totalCostUsd: 1.25,
      });

      const completed = events.find(e => e.type === "cron.completed" && e.metadata?.cronJobId === job.id);
      expect(completed).toBeDefined();
      expect(completed?.outcome).toBe("blocked");
      expect(completed?.detail).toBe("budget exhausted (Bot did not run)");
      expect(completed?.metadata).toMatchObject({
        cronJobId: job.id,
        deliveryMode: "agent",
        reason: "budget_exhausted",
      });
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("logs Bot turn completed when an agent cron job executes normally", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cron-agent-log-"));
    const store = new CronStore(stateDir);
    const channel = { send: vi.fn().mockResolvedValue({ messageId: "om_agent" }) };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "Status checked" }),
    };
    try {
      const job = await store.add({
        channel: "lark",
        chatId: 1,
        userId: 2,
        chatType: "private",
        cronExpr: "0 9 * * *",
        prompt: "Check status",
        larkChatId: "oc_conv1",
        conversationKey: "lark:oc_conv1",
        deliveryMode: "agent",
        locale: "en",
      });
      const scheduler = new CronScheduler({
        store,
        executor: buildCoreCronExecutor({
          channel: channel as never,
          bridge: bridge as never,
          runtime: createCoreServiceRuntime(),
          stateDir,
        }),
        stateDir,
      });
      try {
        await scheduler.runJobNow(job.id);
      } finally {
        await scheduler.stop();
      }

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const raw = await readFile(resolveTimelineLogPath(stateDir), "utf8");
      const events = raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const completed = events.find(e => e.type === "cron.completed" && e.metadata?.cronJobId === job.id);
      expect(completed).toBeDefined();
      expect(completed?.outcome).toBe("success");
      expect(completed?.detail).toBe("Bot turn completed");
      expect(completed?.metadata).toMatchObject({
        cronJobId: job.id,
        deliveryMode: "agent",
      });
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
