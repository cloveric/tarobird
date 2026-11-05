import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { DeepSeekHarnessHost as HostType, SpawnDeepSeekHarness, DeepSeekHarnessChildProcess } from "../../src/codex/deepseek-harness-host.js";
import type { DeepSeekHarnessAdapter as AdapterType } from "../../src/codex/deepseek-harness-adapter.js";

test("real DeepSeek refuses an active-message stop that would pause an armed goal", async ({}, info) => {
  test.skip(process.env.TAROCUB_LIVE_DEEPSEEK_STOP !== "1", "explicit native boundary acceptance only");
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-deepseek-stop-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const { DeepSeekHarnessHost } = await import(pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-host.js")).href);
  const { DeepSeekHarnessAdapter } = await import(pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-adapter.js")).href);
  const children: ChildProcess[] = [], diagnostics: string[] = [];
  const spawnDsh: SpawnDeepSeekHarness = (executable, args, options) => { const child = spawn(executable, args, options); children.push(child); return child as unknown as DeepSeekHarnessChildProcess; };
  const host: HostType = new DeepSeekHarnessHost({ executable: process.env.DSH_EXECUTABLE || "dsh", sharedHome: process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), stateDir: root, workspacePath: workspace, spawnDsh, onDiagnostic: (text) => diagnostics.push(text) });
  const adapter: AdapterType = new DeepSeekHarnessAdapter({ gateway: host, workspacePath: workspace, model: { reasoningEffort: "low" }, permissionPreset: "workspace-write" });
  let requestId: string | undefined, text = "", stopOutcome: string | undefined, receipt: Record<string, unknown> | undefined, turnError: unknown;
  const request = host.request.bind(host), cancel = host.cancelPrompt.bind(host);
  host.request = async (method, payload, signal) => { if (method === "session.prompt") requestId = (payload as { requestId: string }).requestId; return request(method, payload, signal); };
  host.cancelPrompt = async (...args) => { const result = await cancel(...args); stopOutcome = result.outcome; return result; };
  try {
    const { sessionId } = await adapter.createSession(921), abort = new AbortController();
    const turn = adapter.sendUserMessage(sessionId, { text: "直接在对话中写一篇约 10000 汉字的长篇科幻故事，第一行固定为星海书信。不要使用工具、运行命令或读取文件。", files: [], abortSignal: abort.signal,
      onEngineEvent: (event) => { if (event.type === "assistant_text") text += event.text; } });
    const result = turn.then(() => undefined, (error) => { turnError = error; return error; });
    await expect.poll(() => text.includes("星海书信"), { timeout: 60_000 }).toBe(true);
    await adapter.setThreadGoal(sessionId, { objective: "在上一条普通长回复结束后，回复 GOAL-GUARD-READY 并完成目标。不要调用外部工具。", tokenBudget: 80000 });
    expect((await adapter.getThreadGoal(sessionId)).goal?.status).toBe("active");
    abort.abort();
    expect(await result).toMatchObject({ name: "EngineCancellationUnconfirmedError", reason: "goal-active" });
    expect(stopOutcome).toBe("goal-active");
    expect((await adapter.getThreadGoal(sessionId)).goal?.status).toBe("active");
    const history = await host.request("session.history", { sessionId }) as { events: Array<{ event: { type: string; data?: { reason?: { kind?: string } } } }> };
    expect(history.events.some(({ event }) => event.type === "turn/end" && event.data?.reason?.kind === "aborted")).toBe(false);
    // Explicit fixture cleanup: disarm the goal first, then stop only the owned
    // ordinary request. No session-wide cancellation or shared-home edits.
    await adapter.clearThreadGoal(sessionId);
    expect((await cancel(sessionId, requestId!)).outcome).toBe("cancelled");
    receipt = { nativeGoalGuard: true, refusedStopOutcome: "goal-active", goalStillActiveAfterRefusal: true, noNativeAbortedTurnBeforeExplicitClear: true,
      ordinaryStoppedOnlyAfterGoalCleared: true, realNativeCli: true, browserOrPhysicalDeviceAcceptance: false };
  } catch (error) {
    await writeFile(info.outputPath("deepseek-stop-diagnostics.json"), JSON.stringify({ diagnostics, text, stopOutcome,
      turnError: turnError instanceof Error ? { name: turnError.name, message: turnError.message, stack: turnError.stack } : turnError }, null, 2));
    throw error;
  } finally {
    await adapter.destroy();
    await rm(root, { recursive: true, force: true });
    const ownedProcesses = children.map((child) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }));
    expect(ownedProcesses.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    if (receipt) await writeFile(info.outputPath("deepseek-stop-boundary.json"), JSON.stringify({ ...receipt, privateHostClosed: true, fixtureRemoved: true, ownedProcesses }, null, 2));
  }
});
