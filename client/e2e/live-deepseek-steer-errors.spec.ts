import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { DeepSeekHarnessHost as HostType, SpawnDeepSeekHarness, DeepSeekHarnessChildProcess } from "../../src/codex/deepseek-harness-host.js";
import type { DeepSeekHarnessAdapter as AdapterType } from "../../src/codex/deepseek-harness-adapter.js";

for (const failure of ["error", "blocked", "crash"] as const) test(`real DeepSeek removes unconsumed steering before a native ${failure} boundary`, async ({}, info) => {
  test.skip(process.env.TAROCUB_LIVE_DEEPSEEK_STEER_ERRORS !== "1", "explicit native fault-injection acceptance only");
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-deepseek-steer-error-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const plugin = path.join(root, "fault.mjs"), ready = path.join(root, "ready"), go = path.join(root, "go"), flushed = path.join(root, "flushed.json");
  // Inject only a controlled boundary fault in this temporary private host.
  // Native session/inbox/append/driver and the product plugin stay unmodified.
  await writeFile(plugin, `import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
export const name = 'tarocub-steer-boundary-test';
export const inject = ['sessions'];
export function apply(ctx) {
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    if (turn !== 1 || existsSync(${JSON.stringify(flushed)})) return;
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    for (let i = 0; !existsSync(${JSON.stringify(go)}); i++) { if (i > 1500) throw new Error('fixture deadline'); await setTimeout(10); }
    if (${JSON.stringify(failure)} === 'crash') {
      const participated = await ctx.sessions.flush(agent.session);
      writeFileSync(${JSON.stringify(flushed)}, JSON.stringify({ participated, sources: agent.inbox.nextStep.map(m => m.source) }));
      process.kill(process.pid, 'SIGKILL'); await new Promise(() => {});
    }
    if (${JSON.stringify(failure)} === 'error') throw new Error('TAROCUB_CONTROLLED_BOUNDARY_ERROR');
  });
  ctx.on('agent/pre-step', async ({ agent, turn, step, messages }, next) => {
    if (${JSON.stringify(failure)} !== 'blocked' || turn !== 1 || step !== 2) return next();
    for (const message of messages) if (message.source.kind === 'tarocub-steer') agent.inbox.prepend('next-step', message);
    return { kind: 'reject' };
  });
}`);
  const { DeepSeekHarnessHost } = await import(pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-host.js")).href);
  const { DeepSeekHarnessAdapter } = await import(pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-adapter.js")).href);
  const children: ChildProcess[] = [], diagnostics: string[] = [];
  const spawnDsh: SpawnDeepSeekHarness = (executable, args, options) => {
    appendFileSync(path.join(options.env.DSH_HOME!, "cordis.patch.yml"), `\n- insert:\n    - id: tarocub-steer-boundary-test\n      name: ${JSON.stringify(plugin)}\n`);
    const child = spawn(executable, args, options); children.push(child); return child as unknown as DeepSeekHarnessChildProcess;
  };
  const host: HostType = new DeepSeekHarnessHost({ executable: "dsh", sharedHome: process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), stateDir: root, workspacePath: workspace, spawnDsh, onDiagnostic: (text) => diagnostics.push(text) });
  const adapter: AdapterType = new DeepSeekHarnessAdapter({ gateway: host, workspacePath: workspace, model: { reasoningEffort: "low" }, permissionPreset: "workspace-write" });
  const request = host.request.bind(host); let sourceRpcId: string | undefined, receipt: unknown;
  host.request = async (method, payload, signal) => { if (method === "session.prompt") sourceRpcId = (payload as { requestId: string }).requestId; return request(method, payload, signal); };
  type Event = { type: string; data: { turn?: number; reason?: { kind: string }; source?: { kind: string; rpcId?: string } } };
  let history: (() => Promise<Event[]>) | undefined;
  try {
    const { sessionId } = await adapter.createSession(928);
    history = async () => ((await request("session.history", { sessionId })) as { events: Array<{ event: Event }> }).events.map((row) => row.event);
    const pending = adapter.sendUserMessage(sessionId, { text: "不要调用工具，只回复 ORIGINAL-ANSWER。", files: [] }).then((reply) => ({ text: reply.text }), (error) => ({ error: String(error) }));
    await expect.poll(() => existsSync(ready), { timeout: 60_000 }).toBe(true);
    const steerId = randomUUID();
    expect(await host.steerPrompt({ sessionId, sourceRpcId: sourceRpcId!, expectedTurn: 1, requestId: steerId, text: "STALE-STEER-MUST-NOT-ESCAPE", clientTimeZone: "Asia/Shanghai" })).toEqual({ outcome: "accepted" });
    await writeFile(go, "go"); await pending;
    let durableCrashProof: unknown;
    if (failure === "crash") {
      durableCrashProof = JSON.parse(await readFile(flushed, "utf8"));
      expect(durableCrashProof).toMatchObject({ participated: true, sources: [expect.objectContaining({ kind: "tarocub-steer", rpcId: steerId })] });
      // The managed host already resumes the observed session after restart.
      // Do not race it with a second session.create write handle.
      await expect.poll(async () => ((await request("session.history", { sessionId })) as { projections?: { values?: { inbox?: Record<string, unknown[]> } } }).projections?.values?.inbox?.["next-step"], { timeout: 15_000 }).toEqual([]);
    } else {
    await expect.poll(async () => (await history!()).some((event) => event.type === "turn/end" && event.data.turn === 1 && event.data.reason?.kind === failure)).toBe(true);
    }
    const inbox = await request("session.history", { sessionId }) as { projections: { values: { inbox: Record<string, unknown[]> } } };
    expect(inbox.projections.values.inbox["next-step"]).toEqual([]);
    expect(diagnostics.join("\n")).not.toContain("session append cannot reenter");
    const follow = await adapter.sendUserMessage(sessionId, { text: "不要调用工具，只回复 NEXT-CLEAN。", files: [] }); expect(follow.text).toContain("NEXT-CLEAN");
    const events = await history(); expect(events.filter((event) => event.type === "turn/start")).toHaveLength(2);
    const turn2 = events.findIndex((event) => event.type === "turn/start" && event.data.turn === 2);
    expect(events.slice(turn2).find((event) => event.type === "user/message" && event.data.source?.kind !== "runtime-context")?.data.source).toMatchObject({ kind: "user", rpcId: sourceRpcId });
    expect(events.slice(turn2).some((event) => event.type === "user/message" && event.data.source?.rpcId === steerId)).toBe(false);
    receipt = { failure, durableCrashProof, realNativeCli: true, controlledBoundaryFault: true, sessionAppendAndInboxUnmodified: true, noAppendReentrancyWarning: true,
      nativeNextStepEmptyBeforeFollowup: true, noAdditionalEmptyTurn: true, subsequentUserFirstAndReplySucceeded: true, physicalDevices: false };
  } catch (error) {
    await writeFile(info.outputPath(`steering-${failure}-diagnostics.json`), JSON.stringify({ diagnostics, events: await history?.().catch(() => []) }, null, 2)); throw error;
  } finally {
    await adapter.destroy(); await rm(root, { recursive: true, force: true });
    const ownedProcesses = children.map((child) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }));
    expect(ownedProcesses.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    if (receipt) await writeFile(info.outputPath(`steering-${failure}.json`), JSON.stringify({ ...receipt as object, privateHostClosed: true, fixtureRemoved: true, ownedProcesses }, null, 2));
  }
});
