// Fault injection around the actual standalone bootstrap. Commands stay local;
// this fixture never asks an installed model to execute a turn.
import { z } from "zod";
import { runGatewayWorker } from "../../src/gateway/worker.js";
import { FileWorkflowStore } from "../../src/state/file-workflow-store.js";
import { GatewayTransport } from "../../src/gateway/transport.js";
import { CronScheduler } from "../../src/runtime/cron-scheduler.js";
import { Bridge } from "../../src/runtime/bridge.js";
import type { CoreServiceRuntime } from "../../src/core/runtime.js";

const options = z.object({ stateDir: z.string(), url: z.string(), mode: z.enum(["kill", "throw", "cleanup", "slow-cleanup", "stop-startup", "normal", "drain", "drain-interactions"]), interaction: z.enum(["choice", "native-choice", "async-question", "approval"]).optional() }).parse(JSON.parse(process.env.TAROCUB_RESTART_FIXTURE ?? "{}"));
if (options.mode === "drain") {
  const releases: Array<() => void> = [];
  Bridge.prototype.handleAuthorizedMessage = async function (input) {
    process.send?.({ type: "fixture.turn" });
    await new Promise<void>(resolve => releases.push(resolve));
    if (input.abortSignal?.aborted) throw new Error("fixture_turn_was_aborted");
    return { text: "finished" };
  };
  process.on("message", value => { if (value && typeof value === "object" && "type" in value && value.type === "fixture.release") for (const release of releases.splice(0)) release(); });
}
let releaseCleanup: (() => void) | undefined;
const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
if (options.mode === "slow-cleanup") {
  Bridge.prototype.handleAuthorizedMessage = async () => { process.send?.({ type: "fixture.unwanted-turn" }); return { text: "must not start while stopping" }; };
  process.on("message", value => { if (value && typeof value === "object" && "type" in value && value.type === "fixture.release-cleanup") releaseCleanup?.(); });
}
const stopScheduler = CronScheduler.prototype.stop;
CronScheduler.prototype.stop = async function () {
  await stopScheduler.call(this);
  if (options.mode === "cleanup") throw new Error("synthetic_cleanup_failure");
  if (options.mode === "slow-cleanup") { process.send?.({ type: "fixture.cleanup-waiting" }); await cleanupGate; }
};
const recover = FileWorkflowStore.prototype.failInterruptedProcessing;
FileWorkflowStore.prototype.failInterruptedProcessing = async function (...args) {
  process.send?.({ type: "maintenance" });
  if (options.mode === "kill") { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); }
  if (options.mode === "throw") throw new Error("synthetic_recovery_failure");
  return recover.apply(this, args);
};
const connect = GatewayTransport.prototype.connect;
GatewayTransport.prototype.connect = async function () {
  if (options.mode === "stop-startup") {
    process.send?.({ type: "fixture.startup-waiting" });
    await new Promise<void>(resolve => {
      const release = (value: unknown) => { if (value && typeof value === "object" && "type" in value && value.type === "fixture.release-startup") { process.off("message", release); resolve(); } };
      process.on("message", release);
    });
  }
  const boot = this.onBoot;
  if (options.mode === "drain-interactions") {
    const runtime = (this.options as typeof this.options & { runtime: CoreServiceRuntime }).runtime;
    const conversationKey = "lark:gw_card_conversation";
    if (options.interaction === "choice" || options.interaction === "native-choice") {
      runtime.choiceCards.set("fixture_card", { messageId: "fixture_card", status: "active", createdAt: Date.now(), ...(options.interaction === "native-choice" ? { answerActiveTurn: async () => true } : {}) });
    } else {
      const timer = setTimeout(() => {}, 60_000); timer.unref();
      runtime.pendingApprovals.set("fixture_question", { requestId: "fixture_question", chatId: "gw_card_conversation", conversationKey, timer, resolve: () => {}, reject: () => {}, ...(options.interaction === "async-question" ? { asyncQuestion: { isCurrentTurn: () => false } } : {}) });
    }
    if (options.interaction === "approval" || options.interaction === "native-choice") runtime.activeRuns.set(conversationKey, { abortController: new AbortController() });
    process.on("message", value => {
      if (value && typeof value === "object" && "type" in value && value.type === "fixture.release-interaction") {
        for (const pending of runtime.pendingApprovals.values()) clearTimeout(pending.timer);
        runtime.pendingApprovals.clear(); runtime.choiceCards.clear(); runtime.activeRuns.clear();
        process.send?.({ type: "fixture.interaction-released" });
      }
    });
  }
  this.onBoot = async () => { await boot?.(); process.send?.({ type: "boot-complete" }); };
  return connect.call(this);
};
try { await runGatewayWorker(["run", "--state-dir", options.stateDir, "--bot-id", "alpha", "--hub-url", options.url]); }
catch (error) { console.error(error instanceof Error ? error.message : "fixture_failed"); process.exit(1); }
