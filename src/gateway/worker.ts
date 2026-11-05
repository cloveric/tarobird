import path from "node:path";
import { parseArgs } from "node:util";
import { createBridgeDependencies } from "../core/engine-factory.js";
import { recoverInterruptedCoreTurns } from "../core/recovery.js";
import { appAgentInstructions } from "./agent-instructions.js";
import type { EnvSource } from "../config.js";
import { createCoreServiceRuntime } from "../core/runtime.js";
import { sendCoreCronFailureNotification } from "../core/cron.js";
import { CronStore } from "../state/cron-store.js";
import { CronScheduler } from "../runtime/cron-scheduler.js";
import { acquireInstanceLock } from "../state/instance-lock.js";
import { loadInstanceConfig } from "../state/instance-config.js";
import { attachGateway } from "./service.js";
import { readGatewaySecret } from "./transport.js";
import { loadGatewayEnvironment, GATEWAY_LEGACY_IDENTITY_KEYS } from "./environment.js";
import { createDefaultTranscribeVoice } from "../core/voice.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { startGatewayBus } from "./bus.js";
import type { CoreBridgeLike } from "../core/types.js";
import { withChannelProfile } from "./platform-profile.js";
import { clearRestartLoopState, isRestartLoopTripped, recordUncleanBootAndCheck } from "../runtime/restart-loop-guard.js";
import { appendServiceLifecycleEventSync, monitorServiceCrashes } from "../runtime/service-lifecycle-log.js";
import { appendAuditEventBestEffort } from "../runtime/audit-events.js";
import { cancelDrainRequestSchema, drainCommitSchema, drainStatusRequestSchema, restartRequestSchema, shutdownRequestSchema, type DrainBlocker } from "./control.js";
import { gatewayActiveWorkCount, gatewayDrainBlockers } from "./activity.js";
import { settleProcessTreeKills } from "../codex/process-tree.js";

export async function createGatewayBridge(env: EnvSource) {
 const { config, bridge } = await createBridgeDependencies(env, { transport: "gateway", startupInstructions: appAgentInstructions });
 return { stateDir: config.stateDir, bridge };
}

/** Standalone App worker. Shared runtime comes from core; all transport and
 * lifecycle capabilities belong to the App Gateway and its Hub supervisor. */
export async function runGatewayWorker(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { "state-dir": { type: "string" }, "bot-id": { type: "string" }, "hub-url": { type: "string" } } });
  if (positionals[0] !== "run" || !values["state-dir"] || !values["bot-id"] || !values["hub-url"]) throw new Error("gateway run requires state-dir, bot-id and hub-url");
  const stateDir = path.resolve(values["state-dir"]), botId = values["bot-id"];
  const stopCrashMonitor = monitorServiceCrashes(stateDir, botId, "gateway");
  let lock: Awaited<ReturnType<typeof acquireInstanceLock>> | undefined;
  let resolveStop: () => void = () => {}; const stopped = new Promise<void>((resolve) => { resolveStop = resolve; }); let restarting = false;
  let restartReceipts = 0, draining = false, restartRequested = false;
  let stopRequested = false, startupComplete = false, channelStop: Promise<void> | undefined;
  let drainId: string | undefined, drainCommitted = false, isIdle = () => false;
  let drainBlockers = (): DrainBlocker[] => [{ botId, type: "worker", count: 1 }];
  const stop = () => {
    // A dead parent must not leave its retiring worker reconnecting to a new
    // Hub and accepting input while cron/Bus cleanup is still in progress.
    stopRequested = true;
    if (channel && !channelStop) { channelStop = channel.disconnect(); void channelStop.catch(() => undefined); }
    resolveStop();
  }; const message = (value: unknown) => {
    if (shutdownRequestSchema.safeParse(value).success) { stop(); return; }
    const cancel = cancelDrainRequestSchema.safeParse(value);
    if (cancel.success) {
      draining = false; drainId = undefined; drainCommitted = false; restarting = restartRequested;
      restartReceipts++;
      void Promise.resolve(scheduler?.resumeAdmission()).then(() => true, error => { console.error(error instanceof Error ? error.message : "cron_resume_failed"); return false; }).then(ok => {
        if (cancel.data.requestId && process.send) {
          try { process.send({ type: "drain.cancelled", requestId: cancel.data.requestId, pid: process.pid, ok }, () => { restartReceipts--; }); }
          catch { restartReceipts--; }
        } else restartReceipts--;
      });
      return;
    }
    const status = drainStatusRequestSchema.safeParse(value);
    if (status.success) { process.send?.({ type: "drain.status.result", requestId: status.data.requestId, drainId: status.data.drainId, pid: process.pid, idle: draining && status.data.drainId === drainId && isIdle(), blockers: drainBlockers().slice(0, 128) }); return; }
    const commit = drainCommitSchema.safeParse(value);
    if (commit.success) { if (draining && commit.data.drainId === drainId) drainCommitted = true; return; }
    const request = restartRequestSchema.safeParse(value); if (!request.success) return;
    restarting = true;
    if (request.data.type === "drain.whenIdle") { draining = true; drainId = request.data.requestId; drainCommitted = false; scheduler?.pauseAdmission(); }
    else restartRequested = true;
    if (request.data.requestId && process.send) {
      restartReceipts++;
      try { process.send({ type: "restart.queued", requestId: request.data.requestId, pid: process.pid }, () => { restartReceipts--; }); }
      catch { restartReceipts--; }
    }
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop); process.once("disconnect", stop); process.on("message", message);
  let channel: Awaited<ReturnType<typeof attachGateway>> | undefined; let scheduler: CronScheduler | undefined; let idle: ReturnType<typeof setInterval> | undefined;
  let bus: Awaited<ReturnType<typeof startGatewayBus>>; let workerBridge: CoreBridgeLike | undefined;
  try {
    lock = await acquireInstanceLock(stateDir);
    // Use the same persisted window as the Feishu service. A stale lock counts
    // hard kills; handled fatal exits below count even though they release it.
    const loop = lock.recoveredStale ? await recordUncleanBootAndCheck(stateDir) : await isRestartLoopTripped(stateDir);
    if (loop.tripped) {
      const detail = "连续异常退出，已暂缓本次启动恢复；仍可接收新消息。";
      const event = { type: "service.startup_maintenance" as const, instanceName: botId, outcome: "success" as const, detail, metadata: { channel: "gateway", recoverySkipped: true, uncleanBoots: loop.recentBoots.length } };
      appendServiceLifecycleEventSync(stateDir, event);
      await appendAuditEventBestEffort(stateDir, event);
      console.warn(detail);
    }
    try {
      startup: {
        // Engines and the shared ASR pipeline read process.env when launched/called.
        // This is a dedicated worker, so instance credentials never enter the Hub.
        const workerEnv = await loadGatewayEnvironment(stateDir, botId, process.env);
        for (const key of GATEWAY_LEGACY_IDENTITY_KEYS) delete process.env[key];
        Object.assign(process.env, workerEnv);
        if (!loop.tripped) {
          await new FileWorkflowStore(stateDir).failInterruptedProcessing();
          await recoverInterruptedCoreTurns(stateDir, botId);
        }
        const { bridge } = await createGatewayBridge(process.env);
        workerBridge = bridge;
        const config = await loadInstanceConfig(stateDir), runtime = createCoreServiceRuntime({ transcribeMedia: createDefaultTranscribeVoice({ stateDir, ...(process.env.ASR_MAX_AUDIO_SECONDS ? { maxAudioSeconds: Number(process.env.ASR_MAX_AUDIO_SECONDS) } : {}) }) });
        // Gateway warnings are static codes, never transport payloads or secrets.
        channel = await attachGateway({ stateDir, botId, recoverDeliveries: !loop.tripped, url: values["hub-url"], secret: await readGatewaySecret(path.join(stateDir, "gateway.key")), bridge, runtime, engine: config.engine, model: config.model, effort: config.effort, requireMentionInGroup: true, getActiveWorkCount: () => gatewayActiveWorkCount(runtime, bus?.activeCount() ?? 0), onWarning: code => console.warn(`[${new Date().toISOString()}] ${code}`) });
        if (stopRequested) break startup;
        const store = new CronStore(stateDir, { defaultTimezone: config.timezone });
        scheduler = new CronScheduler({ store, stateDir, instanceName: botId, executorManagesAdmission: true, executor: (job, signal, lifecycle) => channel!.runCron!(job, signal, lifecycle), onJobFailure: async (job, detail) => { await channel!.inConversation(job.larkChatId ?? "", () => sendCoreCronFailureNotification(channel!, job, detail)); } });
        if (draining) scheduler.pauseAdmission();
        await scheduler.start(); runtime.cronRuntime = { store, scheduler };
        if (stopRequested) break startup;
        bus = await startGatewayBus(stateDir, botId, bridge);
        if (stopRequested) break startup;
        startupComplete = true;
        drainBlockers = () => {
          const reasons = gatewayDrainBlockers(runtime, botId);
          const add = (type: DrainBlocker["type"], count: number) => { if (count) reasons.push({ botId, type, count }); };
          add("transport", restartReceipts + Number(!!channel?.isBusy()));
          add("cron", scheduler?.activeCount() ?? 0);
          add("bus", bus?.activeCount() ?? 0);
          // A native background task or its result review can outlive the Core
          // foreground run. Never commit drain while the engine still owns it.
          add("worker", Number(bridge.hasPendingNativeWork?.() ?? false));
          return reasons;
        };
        isIdle = () => drainBlockers().length === 0;
        idle = setInterval(() => { if ((draining ? drainCommitted : restartRequested) && isIdle()) resolveStop(); }, 250);
        await stopped;
      }
    } finally {
      if (idle) clearInterval(idle);
      try { await scheduler?.stop(); } finally {
        try { await bus?.stop(); } finally {
          try { await (channelStop ?? channel?.disconnect()); } finally {
            // Adapters start process-tree kills without awaiting them. Their
            // SIGTERM/SIGKILL escalation must finish before exit, while this
            // worker still holds the instance lock.
            try { await workerBridge?.destroy?.(); } finally { await settleProcessTreeKills(); }
          }
        }
      }
    }
    // Only a fully clean shutdown forgives the history. Cleanup failures must
    // retain it, otherwise a fatal startup/teardown loop never trips the guard.
    if (startupComplete) await clearRestartLoopState(stateDir);
  } catch (error) {
    if (lock) await recordUncleanBootAndCheck(stateDir);
    appendServiceLifecycleEventSync(stateDir, { type: "service.fatal", instanceName: botId, outcome: "error", detail: error instanceof Error ? error.message : String(error), metadata: { channel: "gateway" } });
    throw error;
  } finally {
    try { await lock?.release(); } finally {
      stopCrashMonitor();
      process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("disconnect", stop); process.off("message", message);
    }
  }
  // Engine transports can retain background handles. All durable work has
  // stopped above; the owning Hub supervises this dedicated process.
  process.exit(restarting ? 75 : 0);
}
