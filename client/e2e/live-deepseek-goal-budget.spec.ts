import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DeepSeekHarnessHost as HostType, SpawnDeepSeekHarness, DeepSeekHarnessChildProcess } from "../../src/codex/deepseek-harness-host.js";
import type { DeepSeekHarnessAdapter as AdapterType } from "../../src/codex/deepseek-harness-adapter.js";

type Event = { type: string; data: { turn?: number; reason?: { kind: string }; source?: { kind: string; rpcId?: string; goalId?: string }; stream?: Array<{ type: string; chunk?: { type: string; usage?: Record<string, number> } }> } };
type Snapshot = { events: Array<{ event: Event }>; projections: { values: { goal: { goal: { id: string; revision: number; phase: string } } | null; tarocubGoalUsage: { goalId: string; tokensUsed: number }; tokenUsage: Record<string, number> } } };

for (const flow of ["goal-turn", "ordinary-turn", "pipe-closed-ordinary-turn", "complete-race", "host-crash"] as const) test(`real DeepSeek budget pause owns only its ${flow}, with durable goal usage`, async ({}, info) => {
  test.skip(process.env.TAROCUB_LIVE_DEEPSEEK_GOAL_BUDGET !== "1", "explicit native usage acceptance only");
  test.setTimeout(150_000);
  const ordinaryFlow = flow === "ordinary-turn" || flow === "pipe-closed-ordinary-turn";
  const pipeFailure = flow === "pipe-closed-ordinary-turn";
  const completeRace = flow === "complete-race";
  const hostCrash = flow === "host-crash";
  const root = await mkdtemp(path.join(os.tmpdir(), "live-deepseek-budget-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const ready = path.join(root, "ready"), go = path.join(root, "go"), plugin = path.join(root, "boundary.mjs");
  // Only hold the native end boundary so an ordinary request can take over
  // before the delayed budget RPC arrives. Neither usage nor results are mocked.
  await writeFile(plugin, `import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
export const name = 'tarocub-goal-budget-boundary';
export const inject = ['sessions'];
export function apply(ctx) {
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (turn !== 1) return;
    await ctx.sessions.flush(agent.session);
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    for (let i = 0; !existsSync(${JSON.stringify(go)}) && !signal.aborted; i++) {
      if (i > 6000) throw new Error('fixture deadline'); await setTimeout(10);
    }
  });
}`);
  const { DeepSeekHarnessHost } = await import(pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-host.js")).href);
  const { DeepSeekHarnessAdapter } = await import(pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-adapter.js")).href);
  const children: ChildProcess[] = [], diagnostics: string[] = [];
  const spawnDsh: SpawnDeepSeekHarness = (executable, args, options) => {
    appendFileSync(path.join(options.env.DSH_HOME!, "cordis.patch.yml"), `\n- insert:\n    - id: tarocub-goal-budget-boundary\n      name: ${JSON.stringify(plugin)}\n`);
    const child = spawn(executable, args, options); children.push(child); return child as unknown as DeepSeekHarnessChildProcess;
  };
  const make = () => {
    const host: HostType = new DeepSeekHarnessHost({ executable: "dsh", sharedHome: process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), stateDir: root, workspacePath: workspace, spawnDsh, onDiagnostic: (text) => diagnostics.push(text) });
    const adapter: AdapterType = new DeepSeekHarnessAdapter({ gateway: host, workspacePath: workspace, goalStatePath: path.join(root, "goals.json"), model: { reasoningEffort: "low" }, permissionPreset: "workspace-write" });
    return { host, adapter };
  };
  let { host, adapter } = make(), receipt: Record<string, unknown> | undefined, sessionId = "", pausedRequest = false;
  let releasePause!: () => void; const pauseGate = new Promise<void>((resolve) => { releasePause = resolve; });
  const pause = host.pauseGoalForBudget.bind(host);
  host.pauseGoalForBudget = async (input) => { pausedRequest = true; await pauseGate; return pause(input); };
  const snapshot = async (): Promise<Snapshot> => await host.request("session.history", { sessionId }) as Snapshot;
  let watch: Promise<unknown> | undefined, ordinary: Promise<unknown> | undefined;
  try {
    ({ sessionId } = await adapter.createSession(931));
    watch = adapter.watchThreadGoal(sessionId, { objective: "这是受控目标预算验收。当前轮次只回复 GOAL-USAGE-ROUND；不要调用工具或完成/暂停目标，预算控制器会停止本轮。", tokenBudget: 1 }).then((result) => result, (error) => ({ error: String(error) }));
    await expect.poll(() => existsSync(ready), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => pausedRequest).toBe(true);
    const before = await snapshot(); expect(before.projections.values.goal!.goal.phase).toBe("active");
    const usage = before.projections.values.tarocubGoalUsage;
    expect(usage.goalId).toBe(before.projections.values.goal!.goal.id); expect(usage.tokensUsed).toBeGreaterThan(1);
    const goalEvents = before.events.map((row) => row.event);
    expect(goalEvents.some((event) => event.type === "user/message" && event.data.source?.kind === "goal" && event.data.source.goalId === usage.goalId)).toBe(true);
    // This fixture has one goal request/settlement. Compare provider buckets
    // from the real log independently with the projection's result.
    const samples = goalEvents.filter((event) => event.type === "assistant/message").flatMap((event) => event.data.stream ?? []).filter((item) => item.type === "chunk" && item.chunk?.type === "usage");
    expect(samples).toHaveLength(1);
    const reported = samples[0]!.chunk!.usage!;
    const expected = reported.inputTokens! + reported.outputTokens! + (reported.cacheReadTokens ?? 0) + (reported.cacheWriteTokens ?? 0);
    expect(usage.tokensUsed).toBe(expected);
    if (ordinaryFlow) {
      ordinary = adapter.sendUserMessage(sessionId, { text: "忽略前面验收目标的输出格式。本条是独立普通聊天，不要调用工具。直接输出 1000 字左右的科幻故事，开头为「普通聊天验收开始」，末尾为「普通聊天验收结束」。", files: [] }).then((result) => result, (error) => ({ error: String(error) }));
      await expect.poll(async () => ((await host.request("session.history", { sessionId })) as any).projections.values.inbox["next-turn"].some((item: any) => item.source.kind === "user")).toBe(true);
      await writeFile(go, "go");
      await expect.poll(async () => (await snapshot()).events.some(({ event }) => event.type === "user/message" && event.data.source?.kind === "user"), { timeout: 15_000 }).toBe(true);
    }
    if (pipeFailure) (host as unknown as { appTools: { close(): void } }).appTools.close();
    if (hostCrash) {
      const child = children[0]!;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL"); await closed;
    }
    if (completeRace) {
      await host.request("goals/complete", { agentId: sessionId, ref: { id: usage.goalId, revision: before.projections.values.goal!.goal.revision } });
      await writeFile(go, "go");
    }
    releasePause();
    if (hostCrash) {
      const result = await watch as { error?: string; goal?: { status: string } | null };
      expect(result.error ? /Goal (cleared|stop could not be confirmed)/.test(result.error) : result.goal?.status === "budgetLimited").toBe(true);
      // A status read can confirm a previously uncertain stop after reconnect.
      await adapter.getThreadGoal(sessionId);
    } else if (pipeFailure) await expect(watch).resolves.toMatchObject({ error: expect.stringContaining("Goal cleared to stop automatic continuation") });
    else await expect(watch).resolves.toMatchObject({ goal: { status: completeRace ? "complete" : "budgetLimited", tokensUsed: expected, tokenBudget: 1, usageScope: "nativeGoalTurns" } });
    if (ordinary) await expect(ordinary).resolves.toMatchObject({ text: expect.stringContaining("普通聊天验收结束") });
    const after = await snapshot();
    const cleared = pipeFailure || hostCrash && after.projections.values.goal === null;
    expect(after.projections.values.tarocubGoalUsage).toEqual(cleared ? { goalId: null, tokensUsed: 0 } : usage);
    if (cleared) expect(after.projections.values.goal).toBeNull();
    else expect(after.projections.values.goal!.goal.phase).toBe(completeRace ? "complete" : "paused");
    const ends = after.events.filter(({ event }) => event.type === "turn/end").map(({ event }) => event.data);
    expect(ends).toHaveLength(ordinaryFlow ? 2 : 1);
    if (hostCrash) expect(ends[0]?.reason?.kind).toBe("interrupted");
    else expect(ends[0]?.reason?.kind).toBe(ordinaryFlow || completeRace ? "completed" : "aborted");
    if (ordinaryFlow) {
      expect(ends[1]?.reason?.kind).toBe("completed");
      expect(Object.values(after.projections.values.tokenUsage).reduce((a, b) => a + b, 0)).toBeGreaterThan(expected);
    }
    const state = JSON.parse(await readFile(path.join(root, "goals.json"), "utf8"));
    expect(state.version).toBe(2); expect(state.sessions[sessionId]).toEqual(cleared ? undefined : { goalId: usage.goalId, tokenBudget: 1 });
    await adapter.destroy(); ({ host, adapter } = make());
    const recovered = await adapter.getThreadGoal(sessionId);
    if (cleared) expect(recovered.goal).toBeNull();
    else expect(recovered.goal).toMatchObject({ tokensUsed: expected, tokenBudget: 1, status: completeRace ? "complete" : "budgetLimited", usageScope: "nativeGoalTurns" });
    expect((await snapshot()).events.filter(({ event }) => event.type === "turn/start")).toHaveLength(ends.length);
    expect(diagnostics.join("\n")).not.toContain("session append cannot reenter");
    receipt = { flow, nativeCli: true, controlledNativeEndBoundary: true, delayedBudgetDispatch: true, goalProviderTokens: expected,
      ordinaryUsageExcluded: flow === "ordinary-turn", ordinaryCompletedAfterBudgetProtection: ordinaryFlow, goalTurnAbortedAtLimit: flow === "goal-turn",
      emergencyContinuationClearedAfterPipeLoss: pipeFailure, nativeUsageProjectionSurvivesPipeLoss: pipeFailure, nativeCompletionWinsStaleBudgetPause: completeRace, nativeHostKilledAndRecovered: hostCrash, statusQueryUsedAfterCrash: hostCrash,
      durableNativeProjectionRecovered: true, durableBudgetRecovered: true, noExtraTurnAfterRestart: true, physicalDevices: false };
  } catch (error) {
    await writeFile(info.outputPath(`goal-budget-${flow}-diagnostics.json`), JSON.stringify({ diagnostics, snapshot: sessionId ? await snapshot().catch(() => null) : null }, null, 2)); throw error;
  } finally {
    releasePause(); await writeFile(go, "go"); await adapter.destroy(); await Promise.allSettled([watch, ordinary]);
    await rm(root, { recursive: true, force: true });
    const ownedProcesses = children.map((child) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }));
    expect(ownedProcesses.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    if (receipt) await writeFile(info.outputPath(`goal-budget-${flow}.json`), JSON.stringify({ ...receipt, ownedProcesses, fixtureRemoved: true }, null, 2));
  }
});
