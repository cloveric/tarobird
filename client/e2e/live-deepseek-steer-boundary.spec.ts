import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { DeepSeekHarnessHost as HostType, SpawnDeepSeekHarness, DeepSeekHarnessChildProcess } from "../../src/codex/deepseek-harness-host.js";
import type { DeepSeekHarnessAdapter as AdapterType } from "../../src/codex/deepseek-harness-adapter.js";

test("real DeepSeek turn-bound steering cannot escape into a queued follow-up after cancellation", async ({}, info) => {
  test.skip(process.env.TAROCUB_LIVE_DEEPSEEK_STEER_BOUNDARY !== "1", "explicit native boundary acceptance only");
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-deepseek-steer-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const { DeepSeekHarnessHost } = await import(pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-host.js")).href);
  const { DeepSeekHarnessAdapter } = await import(pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-adapter.js")).href);
  const children: ChildProcess[] = [];
  const spawnDsh: SpawnDeepSeekHarness = (executable, args, options) => { const child = spawn(executable, args, options); children.push(child); return child as unknown as DeepSeekHarnessChildProcess; };
  const host: HostType = new DeepSeekHarnessHost({ executable: process.env.DSH_EXECUTABLE || "dsh", sharedHome: process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), stateDir: root, workspacePath: workspace, spawnDsh });
  const adapter: AdapterType = new DeepSeekHarnessAdapter({ gateway: host, workspacePath: workspace, model: { reasoningEffort: "low" }, permissionPreset: "workspace-write" });
  let sourceRpcId: string | undefined, text = "", receipt: Record<string, unknown> | undefined;
  const request = host.request.bind(host);
  host.request = async (method, payload, signal) => { if (method === "session.prompt") sourceRpcId = (payload as { requestId: string }).requestId; return request(method, payload, signal); };
  try {
    const { sessionId } = await adapter.createSession(927), abort = new AbortController();
    const turn = adapter.sendUserMessage(sessionId, { text: "直接在对话里写约 10000 汉字的科幻故事，第一行固定为引导边界验收。不要调用工具、运行命令或读取文件。", files: [], abortSignal: abort.signal,
      onEngineEvent: (event) => { if (event.type === "assistant_text") text += event.text; } });
    const result = turn.then(() => undefined, (error) => error);
    await expect.poll(() => text.includes("引导边界验收"), { timeout: 60_000 }).toBe(true);
    type NativeEvent = { type: string; data: { turn?: number; reason?: { kind: string }; source?: { rpcId?: string }; message?: { content?: Array<{ type: string; text?: string }> } } };
    const history = async () => ((await request("session.history", { sessionId })) as { events: Array<{ event: NativeEvent }> }).events.map((row) => row.event);
    const first = (await history()).filter((event) => event.type === "turn/start").at(-1)!.data.turn!;
    const base = { sessionId, sourceRpcId: sourceRpcId!, expectedTurn: first, requestId: randomUUID(), text: "UNCONSUMED-STEER-CANARY", clientTimeZone: "Asia/Shanghai" };
    const queuedId = randomUUID();
    await request("session.prompt", { sessionId, requestId: queuedId, mode: "queue", content: [{ type: "text", text: "不要调用工具，只回复 NEXT-TURN-CLEAN。" }], clientTimeZone: "Asia/Shanghai" });
    expect(await host.steerPrompt({ ...base, sourceRpcId: queuedId })).toEqual({ outcome: "queued" });
    expect(await host.steerPrompt({ ...base, expectedTurn: first + 1 })).toEqual({ outcome: "stale" });
    expect(await host.cancelPrompt(sessionId, queuedId)).toEqual({ outcome: "removed" });
    expect(await host.steerPrompt(base)).toEqual({ outcome: "accepted" });
    abort.abort(); expect(await result).toBeInstanceOf(Error);
    await expect.poll(async () => (await history()).some((event) => event.type === "turn/end" && event.data.turn === first && event.data.reason?.kind === "aborted")).toBe(true);
    const follow = await adapter.sendUserMessage(sessionId, { text: "不要调用工具，只回复 NEXT-TURN-CLEAN。", files: [] });
    expect(follow.text).toContain("NEXT-TURN-CLEAN");
    const events = await history();
    expect(events.filter((event) => event.type === "turn/start")).toHaveLength(2);
    expect(events.some((event) => event.type === "user/message" && event.data.source?.rpcId === queuedId)).toBe(false);
    expect(events.some((event) => event.type === "user/message" && event.data.source?.rpcId === base.requestId)).toBe(false);

    expect(await host.steerPrompt({ ...base, requestId: randomUUID() })).toEqual({ outcome: "stale" });
    receipt = { realNativeCli: true, browserOrPhysicalDevices: false, nativeQueuedRejection: true, expectedTurnRejection: true, acceptedAtOriginalTurn: true,
      originalTurnAborted: true, unconsumedSteeringNeverClaimed: true, queuedProbeWithdrawnExplicitly: true, subsequentFollowupSucceeded: true, exactlyTwoNativeTurns: true, staleSteerRejectedAfterEnd: true };
  } finally {
    await adapter.destroy(); await rm(root, { recursive: true, force: true });
    const ownedProcesses = children.map((child) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }));
    expect(ownedProcesses.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    if (receipt) await writeFile(info.outputPath("deepseek-steer-boundary.json"), JSON.stringify({ ...receipt, privateHostClosed: true, fixtureRemoved: true, ownedProcesses }, null, 2));
  }
});
