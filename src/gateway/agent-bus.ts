import { delegateToInstance as defaultDelegateToInstance, resolveDefaultDelegationTimeoutMs } from "../bus/bus-client.js";
import { createBusTalkHandler } from "../bus/bus-handler.js";
import { MAX_BODY_BYTES } from "../bus/bus-server.js";
import { BusProtocolError } from "../bus/bus-protocol.js";
import { withBusStageInstruction } from "../bus/stage-instructions.js";
import { busFailureDetail } from "../bus/error-presentation.js";
import { AGENT_BUS_RECORD_PROMPT_CHARS, AGENT_BUS_RECORD_TEXT_BYTES, type AgentBusDispatch, type AgentBusEvent } from "../client-protocol/agent-bus.js";
import type { CoreServiceRuntime } from "../core/runtime.js";
import type { CoreBridgeLike } from "../core/types.js";
import type { GatewayTransport } from "./transport.js";

const EARLY_STOP_LIMIT = 256;
type Report = AgentBusEvent extends infer E ? E extends AgentBusEvent ? Omit<E, "runId" | "messageId"> : never : never;

/** Live controllers keyed by Hub run ID, so a Hub stop aborts exactly one run. */
export class GatewayAgentBusRuns {
  private readonly live = new Map<string, AbortController>();
  private readonly early = new Set<string>();
  open(runId: string, stopRequested: boolean): AbortController {
    const controller = new AbortController();
    if (stopRequested || this.early.delete(runId)) controller.abort(new Error("agent_bus_stopped"));
    this.live.set(runId, controller);
    return controller;
  }
  close(runId: string, controller: AbortController): void { if (this.live.get(runId) === controller) this.live.delete(runId); }
  /** A stop may race the input frame; remember a bounded set of early stops. */
  stop(runId: string, onlyIfLive = false): boolean {
    const controller = this.live.get(runId);
    if (controller) { controller.abort(new Error("agent_bus_stopped")); return true; }
    if (onlyIfLive) return false;
    this.early.add(runId);
    if (this.early.size > EARLY_STOP_LIMIT) this.early.delete(this.early.values().next().value!);
    return false;
  }
}

/** Observes one Hub-dispatched run without changing how it executes: member
 * work still goes through the real Bus client (permissions, budget, timeout,
 * abort), and local coordinator turns through the same bridge. */
export function observeAgentBusRun(input: {
  transport: Pick<GatewayTransport, "enqueue">; runs: GatewayAgentBusRuns; botId: string; messageId: string;
  dispatch: AgentBusDispatch; runtime: CoreServiceRuntime; bridge: CoreBridgeLike; onWarning?: (code: string) => void;
}) {
  const { dispatch, messageId } = input;
  const controller = input.runs.open(dispatch.runId, dispatch.stopRequested === true);
  const members = new Set(dispatch.members);
  const localHandlers = new Map<string, ReturnType<typeof createBusTalkHandler>>();
  const admitted = new Map<string, Set<Promise<void>>>();
  let seq = 0, outcome: { result: string; detail?: string } | undefined, cancelledStage = false, firstFailure: string | undefined;
  const durable: Promise<void>[] = [];
  // Each report enters the durable outbox immediately, in order. The outbox
  // sends and replays in that order, so the input's later ack can never
  // overtake a report, however slow the Hub's responses are. The Hub ignores
  // reports for a run it has already settled.
  const report = (event: Report) => {
    let persisted: Promise<void>;
    try {
      const queued = input.transport.enqueue("agentBus.event", { ...event, runId: dispatch.runId, messageId });
      persisted = queued.persisted;
      void queued.response.catch(() => input.onWarning?.("agent_bus_event_failed"));
    } catch (error) { persisted = Promise.reject(error); }
    durable.push(persisted);
    // Observe early rejections without swallowing them: finish must fail the
    // input's durable receipt if any report could not enter the outbox.
    void persisted.catch(() => input.onWarning?.("agent_bus_event_unpersisted"));
  };
  const stage = async <T>(botId: string, prompt: string, signal: AbortSignal | undefined, execute: () => Promise<T>, text: (result: T) => string, conversationId?: string): Promise<T> => {
    // A queued step rejected before execution is not a member stage/record.
    if (controller.signal.aborted || signal?.aborted) {
      cancelledStage = true;
      controller.signal.throwIfAborted();
      signal?.throwIfAborted();
    }
    const stageId = `s${++seq}`;
    report({ type: "stage.started", stageId, botId, ...(conversationId ? { conversationId } : {}), prompt: excerpt(prompt) });
    try {
      const result = await execute();
      report({ type: "stage.finished", stageId, botId, ...(conversationId ? { conversationId } : {}), status: "completed", text: clip(text(result)) });
      return result;
    } catch (error) {
      const cancelled = controller.signal.aborted || !!signal?.aborted || error instanceof BusProtocolError && error.code === "cancelled";
      if (cancelled) cancelledStage = true; else firstFailure ??= message(error);
      report({ type: "stage.finished", stageId, botId, ...(conversationId ? { conversationId } : {}), status: cancelled ? "cancelled" : "failed", ...(cancelled ? {} : { error: message(error) }) });
      throw error;
    }
  };
  const delegate = input.runtime.busRuntime?.delegateToInstance ?? defaultDelegateToInstance;
  const delegateToInstance: typeof defaultDelegateToInstance = async (args) => {
    // Bind by the explicit workflow slot, never by call/completion order. Crew
    // revisits roles and fan requests finish out of order.
    const index = args.agentBusMemberIndex;
    const hasBindings = !!dispatch.conversations;
    if (!members.has(args.targetInstance) || hasBindings && (index === undefined || dispatch.members[index] !== args.targetInstance || !dispatch.conversations?.[index]))
      throw new BusProtocolError({ message: "agent_bus_target_not_in_run", code: "peer_not_allowed", retryable: false });
    const conversationId = hasBindings ? dispatch.conversations![index!] : undefined;
    // The immutable dispatch slot owns its task, including duplicate Bots.
    // Compose after authorization and before both observation and execution.
    args = { ...args, prompt: withBusStageInstruction(args.prompt, index === undefined ? undefined : dispatch.instructions?.[index]) };
    const signal = args.abortSignal ? AbortSignal.any([args.abortSignal, controller.signal]) : controller.signal;
    // A fan may contain eleven slots on one Bot; its existing Bus server
    // admits eight requests. Leave room for other work. Waiting slots have
    // no running stage/record yet.
    const pending = admitted.get(args.targetInstance) ?? new Set<Promise<void>>();
    admitted.set(args.targetInstance, pending);
    while (pending.size >= 4) { await Promise.race(pending); signal.throwIfAborted(); }
    const task = stage(args.targetInstance, args.prompt, signal, async () => {
      if (args.targetInstance !== input.botId) return delegate({ ...args, abortSignal: signal });
      // A role on the coordinator Bot is local work authorized by the Hub's
      // fixed snapshot. Use the existing temporary-session/accounting handler;
      // no self-peer grant, socket loop, chat-history access or observer nesting.
      if (!conversationId || args.depth !== 0) throw new BusProtocolError({ message: "agent_bus_invalid_local_stage", code: "peer_not_allowed", retryable: false });
      if (Buffer.byteLength(JSON.stringify({ prompt: args.prompt }), "utf8") > MAX_BODY_BYTES)
        throw new BusProtocolError({ message: "agent_bus_request_too_large", code: "request_too_large", retryable: false });
      let handler = localHandlers.get(args.stateDir);
      if (!handler) {
        handler = createBusTalkHandler({ bridge: { handleAuthorizedMessage: turn => input.bridge.handleAuthorizedMessage({
          ...turn, conversationKey: `agent-bus-local:${dispatch.runId}:${turn.sessionIdOverride}`,
          replyContext: turn.replyContext ? { ...turn.replyContext, messageId: String(turn.replyContext.messageId) } : undefined,
        }) }, stateDir: args.stateDir, instanceName: input.botId });
        // Handler-local synthetic chat IDs may coincide with another run or
        // the network listener. Temporary roles also need a unique lock scope.
        localHandlers.set(args.stateDir, handler);
      }
      const timed = AbortSignal.any([signal, AbortSignal.timeout(args.timeoutMs ?? resolveDefaultDelegationTimeoutMs())]);
      const result = await handler({ fromInstance: input.botId, prompt: args.prompt, depth: 1 }, { abortSignal: timed });
      if (timed.aborted && !signal.aborted) throw new BusProtocolError({ message: "agent_bus_local_stage_timeout", code: "timeout", retryable: false });
      if (!result.success) throw new BusProtocolError({ message: result.error ?? "agent_bus_failed", code: result.errorCode ?? "unknown", retryable: false });
      return result;
    }, result => result.text, conversationId);
    const settled = task.then(() => {}, () => {}); pending.add(settled);
    try { return await task; } finally { pending.delete(settled); }
  };
  const runtime = Object.assign(Object.create(input.runtime) as CoreServiceRuntime, {
    busRuntime: { ...input.runtime.busRuntime, delegateToInstance, agentBusRun: {
      signal: controller.signal,
      started: () => report({ type: "run.started" }),
      outcome: (result: string, detail?: string) => { outcome = { result, ...(detail ? { detail } : {}) }; },
    } },
  });
  const bridge = new Proxy(input.bridge, { get(target, key, receiver) {
    if (key === "handleAuthorizedMessage") return async (turn: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0]) => {
      const signal = turn.abortSignal ? AbortSignal.any([turn.abortSignal, controller.signal]) : controller.signal;
      // Coordinator work is recorded only as status; its output reaches its own chat.
      const text = withBusStageInstruction(turn.text, dispatch.coordinatorInstruction);
      return stage(input.botId, dispatch.coordinatorInstruction ? text : "", turn.abortSignal, () => target.handleAuthorizedMessage({ ...turn, text, abortSignal: signal }), result => result.text, dispatch.coordinatorConversationId);
    };
    const value: unknown = Reflect.get(target, key, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return {
    runtime, bridge,
    /** Reports the run's own terminal state before its input is acknowledged. */
    async finish(error?: unknown): Promise<void> {
      // Chat Stop can end the core workflow between stages without aborting
      // this Bus controller or producing a cancelled stage observation.
      const status = !error && outcome?.result === "success" ? "completed" : controller.signal.aborted || cancelledStage || outcome?.result === "stopped" ? "cancelled" : "failed";
      const detail = error ? message(error) : outcome ? outcome.detail ?? firstFailure ?? "agent_bus_failed" : "agent_bus_not_executed";
      try {
        // Only local writes are awaited, never Hub responses. Do not publish a
        // terminal state over missing evidence. Propagating a persistence error
        // lets Gateway retain a failed receipt and settle without rerunning work.
        await Promise.all(durable);
        report({ type: "run.finished", status, ...(status === "failed" ? { error: detail.slice(0, 500) } : {}) });
        await Promise.all(durable);
      } finally { input.runs.close(dispatch.runId, controller); }
    },
  };
}

function message(error: unknown): string {
  return busFailureDetail(error).slice(0, 500) || "agent_bus_failed";
}
function excerpt(prompt: string): string {
  if (prompt.length <= AGENT_BUS_RECORD_PROMPT_CHARS) return prompt;
  let end = AGENT_BUS_RECORD_PROMPT_CHARS;
  // The record limit counts UTF-16 units. Do not introduce a lone surrogate
  // when a valid emoji straddles it; the member still receives the full prompt.
  if (/[\uD800-\uDBFF]/.test(prompt[end - 1]!) && /[\uDC00-\uDFFF]/.test(prompt[end]!)) end--;
  return `${prompt.slice(0, end)}\n\n…（已截断）`;
}
function clip(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= AGENT_BUS_RECORD_TEXT_BYTES) return text;
  return `${new TextDecoder().decode(bytes.slice(0, AGENT_BUS_RECORD_TEXT_BYTES)).replace(/�$/, "")}\n\n…（记录已截断）`;
}
