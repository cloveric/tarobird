import { closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { NativeAppPipe } from "./native-app-pipe.js";
import { deepseekGoalUsageDefinition } from "./deepseek-goal-usage.js";

export const name = "tarocub-native-app-tools";
export const inject = ["tools", "agents", "sessionProjections"];
const installSchema = z.object({ sessionId: z.string().min(1), definitions: z.array(z.object({ name: z.enum(["app_send_file", "app_send_batch", "app_capability", "app_show_widget", "app_workbench"]), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) }).strict()).min(1).max(5) }).strict();
type Event = { type: string; seq: number; data: Record<string, unknown> };
type InboxMessage = { id: string; source: { kind?: unknown; rpcId?: unknown; targetTurn?: unknown; targetRpcId?: unknown; goalId?: unknown; round?: unknown } };
type SteerMessage = InboxMessage & { role: "user"; content: readonly { type: "text"; text: string }[] };
type Agent = { id: string; status: string; session: { snapshotEvents(): readonly Event[] }; inbox?: { nextTurn: readonly InboxMessage[]; nextStep: readonly InboxMessage[]; remove(id: string): boolean }; inject?(message: SteerMessage): void; cancel?(reason: { kind: "user" }, options: { keepInbox: true }): void; ctx: { effect(effect: () => (() => void)): unknown; tools: { register(definition: unknown): () => void } } };
type Execution = { agent?: Agent; callId: string; rootCallId: string; signal: AbortSignal; parent?: unknown };
type ClaimedInput = { agent: Agent; message: InboxMessage; turn: number };
type Services = {
  fileUploads: { retirePrompt(agent: Agent, rpcId: string): void };
  goals: { get(agent: Agent): { id?: string; revision?: number; phase: string; activation: string } | undefined; pause?(agent: Agent, ref: { id: string; revision: number }): { id: string; revision: number } };
  sessionProjections: { register(definition: typeof deepseekGoalUsageDefinition): (() => void | Promise<void>) | PromiseLike<{ dispose(): void | Promise<void> }> };
};
type Hooks = {
  "agent/created": (input: { agent: Agent }) => Promise<void> | void;
  "agent/error": (input: { agent: Agent; turn: number }) => void;
  "agent/inbox/claimed": (input: ClaimedInput) => void;
  "agent/pre-step": (input: { agent: Agent; turn: number; signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>;
  "session/event": (session: Agent["session"], event: Event) => void;
};
type Context = { agents: { get(id: string): Agent | undefined; withInitiator?<T>(agent: Agent, operation: () => T): T }; get?<K extends keyof Services>(name: K): Services[K] | undefined; on?<K extends keyof Hooks>(name: K, handler: Hooks[K], options?: { prepend: boolean }): () => void; effect(effect: () => (() => void | Promise<void>)): unknown };
type Claim = { turn: number; sources: InboxMessage["source"][] };
const promptStopSchema = z.object({ sessionId: z.string().min(1), sourceRpcId: z.string().uuid() }).strict();
const promptSteerSchema = promptStopSchema.extend({ expectedTurn: z.number().int().nonnegative(), requestId: z.string().uuid(), text: z.string().min(1).max(200_000), clientTimeZone: z.string().min(1).max(100) }).strict();
const goalBudgetPauseSchema = z.object({ sessionId: z.string().min(1), ref: z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict() }).strict();
const contextSources = new Set(["user-approval", "runtime-context", "agent-instructions", "skill-catalog", "working-directory"]);
const steerSource = "tarocub-steer";

/** Runs inside the native host without yielding between identity check and
 * mutation. A client-side snapshot followed by session.cancel cannot provide
 * this guarantee: a goal or another prompt may own the session by arrival. */
function cancelPrompt(ctx: Context, claimed: WeakMap<Agent, Claim>, sessionId: string, sourceRpcId: string) {
  const agent = ctx.agents.get(sessionId);
  if (!agent) return { outcome: "missing" };
  if (!agent.inbox || !agent.cancel) return { outcome: "unsupported" };
  const matches = (source: InboxMessage["source"] | undefined) => source?.kind === "user" && source.rpcId === sourceRpcId;
  const retire = () => { try { ctx.get?.("fileUploads")?.retirePrompt(agent, sourceRpcId); } catch { /* Cleanup cannot undo or obscure a committed withdrawal. */ } };
  const queued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].filter((message) => matches(message.source));
  if (queued.length) {
    for (const message of queued) agent.inbox.remove(message.id);
    retire();
    return { outcome: "removed" };
  }
  const events = agent.session.snapshotEvents();
  let start = events.length - 1;
  while (start >= 0 && !["turn/start", "turn/end"].includes(events[start]!.type)) start--;
  if (start >= 0 && events[start]!.type === "turn/start" && agent.status === "running") {
    const claim = claimed.get(agent);
    const sources = claim && claim.turn === events[start]!.data.turn ? claim.sources
      : events.slice(start + 1).filter((event) => event.type === "user/message").map((event) => event.data.source as InboxMessage["source"]);
    const index = sources.findIndex(matches);
    if (index >= 0) {
      if (sources.slice(0, index).some((source) => source?.kind === "goal" || source?.kind === "user" && typeof source.rpcId === "string" && source.rpcId !== sourceRpcId)) return { outcome: "merged" };
      // The native goal driver treats any aborted turn as a goal stop, even
      // an ordinary turn between rounds. Refuse that non-isolated operation.
      const goal = ctx.get?.("goals")?.get(agent);
      if (goal?.phase === "active" && goal.activation === "armed") return { outcome: "goal-active" };
      agent.cancel({ kind: "user" }, { keepInbox: true });
      if (!events.slice(start + 1).some((event) => event.type === "user/message" && matches(event.data.source as InboxMessage["source"]))) retire();
      return { outcome: "cancelled" };
    }
  }
  // A completed or superseded request must never cancel the current owner.
  return { outcome: events.some((event) => event.type === "user/message" && matches(event.data.source as InboxMessage["source"] | undefined)) ? "settled" : "missing" };
}

/** A tool is authorized by its logged execution in the open native step, not
 * merely by whichever user prompt happens to be newest when it starts. */
function sourceForCall(events: readonly Event[], exec: Execution, name: string, args: unknown): string {
  const deny = (reason: string) => { throw new Error(`No matching active user App call (${reason}); nothing was sent.`); };
  exec.signal.throwIfAborted();
  let start = events.length - 1;
  for (; start >= 0; start--) {
    if (events[start]!.type === "turn/end") return deny("turn-ended");
    if (events[start]!.type === "turn/start") break;
  }
  if (start < 0) return deny("turn-missing");
  let source: { kind?: unknown; rpcId?: unknown } | undefined, step: Event | undefined, sourceChosen = false;
  for (let i = start + 1; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "user/message" && !sourceChosen) {
      const candidate = event.data.source as typeof source;
      // configureSession can queue a user-approval policy notice BEFORE the
      // admitted prompt. These native context records do not originate work.
      if (!contextSources.has(String(candidate?.kind))) { source = candidate; sourceChosen = true; }
    }
    if (event.type === "step/start") step = event;
    if (event.type === "step/end") step = undefined;
  }
  if (!step) return deny("step-missing");
  if (source?.kind !== "user") return deny(`source-${typeof source?.kind === "string" && /^[a-z-]{1,32}$/.test(source.kind) ? source.kind : "unknown"}`);
  if (typeof source.rpcId !== "string" || !source.rpcId) return deny("source-rpc-missing");
  const calls = events.slice(start + 1).filter((event) => event.seq > step!.seq);
  const roots = calls.filter((event) => event.type === "tool/call" && event.data.callId === exec.rootCallId && event.data.turn === step!.data.turn && event.data.step === step!.data.step);
  if (roots.length !== 1 || calls.some((event) => event.type === "tool/result" && (event.data.message as { source?: { callId?: string } } | undefined)?.source?.callId === exec.rootCallId)) return deny("native-root");
  if (exec.parent === undefined) {
    let loggedArgs: unknown;
    try { loggedArgs = JSON.parse(String(roots[0]!.data.arguments)); } catch { return deny("native-arguments-json"); }
    if (exec.callId !== exec.rootCallId || roots[0]!.data.name !== name || !isDeepStrictEqual(loggedArgs, args)) return deny("native-arguments-mismatch");
  } else {
    const visible = new Set([exec.rootCallId]); let matched = false;
    for (const event of calls) {
      if (event.type === "tool/ptc-dispatch-start" && event.data.rootCallId === exec.rootCallId && visible.has(String(event.data.parentCallId))) {
        const id = String(event.data.subCallId); if (visible.has(id)) return deny("ptc-duplicate-id");
        visible.add(id);
        if (id === exec.callId) {
          if (event.data.name !== name || !isDeepStrictEqual(event.data.arguments, args)) return deny("ptc-arguments-mismatch");
          matched = true;
        }
      }
      if (event.type === "tool/ptc-dispatch" && event.data.subCallId === exec.callId) return deny("ptc-settled");
    }
    if (!matched) return deny("ptc-missing");
  }
  return source.rpcId;
}

/** Loaded only in TaroCub's private Harness home. The CLI's own tool registry
 * supplies execution identity. No public RPC, global config or log parsing. */
export async function apply(ctx: Context): Promise<void> {
  if (process.env.TAROCUB_DSH_APP_PIPES !== "1") return;
  delete process.env.TAROCUB_DSH_APP_PIPES;
  // libuv owns these inherited handles, including close/cancellation. A fs
  // stream with autoClose:false would leave the peer unaware of plugin failure.
  let input: Socket | undefined, output: Socket | undefined;
  try { input = new Socket({ fd: 3, readable: true, writable: false }); output = new Socket({ fd: 4, readable: false, writable: true }); }
  catch {
    input?.destroy(); output?.destroy();
    // Never close an already-owned fd twice: libuv completes destroy itself.
    for (const [fd, owner] of [[3, input], [4, output]] as const) { if (!owner) { try { closeSync(fd); } catch {} } }
    return; // Unsupported handles leave this process on compatible delivery.
  }
  await connectDeepSeekAppPlugin(ctx, input, output);
}

export async function connectDeepSeekAppPlugin(ctx: Context, input: Readable, output: Writable): Promise<() => Promise<void>> {
  let closed = false, disconnect: (() => void) | undefined;
  let releaseUsage: (() => void | Promise<void>) | undefined, releasing: Promise<void> | undefined;
  const close = async () => {
    closed = true;
    const cleanup = disconnect; disconnect = undefined;
    try { cleanup?.(); }
    finally {
      input.destroy(); output.destroy();
      // A context can retire while register() is pending. Its late handle
      // still needs disposal, so an early close must not cache an empty release.
      if (releaseUsage) releasing ??= Promise.resolve().then(releaseUsage);
      await releasing;
    }
  };
  const pendingClose = () => { closed = true; input.destroy(); output.destroy(); };
  input.on("error", pendingClose); input.on("close", pendingClose); input.on("end", pendingClose);
  output.on("error", pendingClose); output.on("close", pendingClose);
  const detach = () => {
    input.off("error", pendingClose); input.off("close", pendingClose); input.off("end", pendingClose);
    output.off("error", pendingClose); output.off("close", pendingClose);
  };
  try {
    ctx.effect(() => close);
    // Await the thenable before inspecting its shape: rc.1's compatibility
    // object is both callable and awaitable, but only awaiting observes errors.
    const handle = await ctx.get?.("sessionProjections")?.register(deepseekGoalUsageDefinition);
    releaseUsage = typeof handle === "function" ? handle : handle ? () => handle.dispose() : undefined;
    if (closed || input.destroyed || output.destroyed) throw new Error("Native App plugin closed during initialization");
    disconnect = connectReadyDeepSeekAppPlugin(ctx, input, output);
    detach();
    return close;
  } catch (error) {
    await close();
    // Retain error listeners on failed streams for late teardown errors.
    throw error;
  }
}

function connectReadyDeepSeekAppPlugin(ctx: Context, input: Readable, output: Writable): () => void {
  const installed = new WeakMap<Agent, { key: string; cleanup: () => void }>();
  const registrations = new Set<() => void>();
  // Keep durable usage alive if just the private pipe closes; budget frames
  // still reach the adapter so it can stop native continuation safely.
  // Inbox claims precede async prompt assembly and the durable user/message.
  // Observe their native identity to cover cancellation during that gap.
  const claimed = new WeakMap<Agent, Claim>();
  const live = new WeakMap<Agent, { turn: number; signal: AbortSignal }>();
  const steering = new Map<Agent, { turn: number; ids: Set<string>; cleanup: () => boolean }>();
  const removeSteering = (agent: Agent, turn?: number) => {
    for (const message of [...agent.inbox?.nextTurn ?? [], ...agent.inbox?.nextStep ?? []]) {
      if (message.source.kind === steerSource && (turn === undefined || message.source.targetTurn === turn)) agent.inbox!.remove(message.id);
    }
  };
  // A private host crash can persist the inbox but lose in-memory listeners.
  // Native source kinds are producer-extensible; remove only our durable
  // ephemeral instructions before a resumed Agent may wake its driver.
  const releaseCreated = ctx.on?.("agent/created", ({ agent }) => { removeSteering(agent); });
  const releaseErrors = ctx.on?.("agent/error", ({ agent, turn }) => {
    const bound = steering.get(agent); if (bound?.turn === turn) bound.cleanup();
  });
  const releasePreStep = ctx.on?.("agent/pre-step", async (input, next) => {
    live.set(input.agent, { turn: input.turn, signal: input.signal });
    const decision = await next();
    // Run outside session.append, before the loop tests hasPending. Prepend
    // wraps native veto listeners, including those which restore claimed work.
    if ((decision as { kind?: string })?.kind === "reject") {
      if (steering.get(input.agent)?.cleanup() === false) throw new Error("Native steering cleanup failed");
    }
    return decision;
  }, { prepend: true });
  const releaseEvents = ctx.on?.("session/event", (session, event) => {
    if (event.type !== "turn/end") return;
    for (const [agent, bound] of steering) {
      // Session publication forbids reentrant writes. Error/blocked/abort
      // paths clear BEFORE publication; this releases the normal empty entry.
      if (agent.session === session && bound.turn === event.data.turn) queueMicrotask(() => bound.cleanup());
    }
  });
  const releaseClaimed = ctx.on?.("agent/inbox/claimed", ({ agent, message, turn }) => {
    steering.get(agent)?.ids.delete(message.id);
    if (contextSources.has(String(message.source?.kind))) return;
    const prior = claimed.get(agent);
    if (prior?.turn === turn) prior.sources.push(message.source);
    else claimed.set(agent, { turn, sources: [message.source] });
  });
  let closed = false;
  const cleanup = () => { if (closed) return; closed = true; releaseCreated?.(); releaseErrors?.(); releaseClaimed?.(); releasePreStep?.(); releaseEvents?.(); for (const bound of steering.values()) bound.cleanup(); for (const unregister of registrations) unregister(); };
  const pipe = new NativeAppPipe(input, output, async (method, payload, signal) => {
    if (method === "pause-goal-budget") {
      const p = goalBudgetPauseSchema.parse(payload); signal.throwIfAborted();
      const agent = ctx.agents.get(p.sessionId), goals = ctx.get?.("goals");
      if (!agent || !goals?.pause || !ctx.agents.withInitiator) return { outcome: "unsupported" };
      const goal = goals.get(agent);
      if (!goal || goal.id !== p.ref.id || goal.revision !== p.ref.revision || goal.phase !== "active") return { outcome: "stale" };
      const events = agent.session.snapshotEvents();
      let start = events.length - 1;
      while (start >= 0 && !["turn/start", "turn/end"].includes(events[start]!.type)) start--;
      const open = start >= 0 && events[start]!.type === "turn/start";
      const claim = claimed.get(agent);
      const sources = open && claim && claim.turn === events[start]!.data.turn ? claim.sources : open
        ? events.slice(start + 1).filter((event) => event.type === "user/message").map((event) => event.data.source as InboxMessage["source"]) : [];
      const owner = sources.find((source) => !contextSources.has(String(source?.kind)) && source?.kind !== steerSource);
      const ownsTurn = open && agent.status === "running" && owner?.kind === "goal" && owner.goalId === p.ref.id && typeof owner.round === "number" && owner.round > 0;
      if (ownsTurn && !agent.cancel) return { outcome: "unsupported" };
      // Native external goal.pause cancels whichever turn happens to be active.
      // Suppress that blanket cancellation, then stop only the identified goal
      // round. No await separates the CAS/origin checks from either mutation.
      const paused = ctx.agents.withInitiator(agent, () => goals.pause!(agent, p.ref));
      if (ownsTurn) agent.cancel!({ kind: "user" }, { keepInbox: true });
      return { outcome: "paused", ref: { id: paused.id, revision: paused.revision } };
    }
    if (method === "steer-prompt") {
      const p = promptSteerSchema.parse(payload); signal.throwIfAborted();
      const agent = ctx.agents.get(p.sessionId);
      if (!agent) return { outcome: "stale" };
      if (!ctx.on || !agent.inject || !agent.inbox) return { outcome: "unsupported" };
      const matches = (source: InboxMessage["source"] | undefined) => source?.kind === "user" && source.rpcId === p.sourceRpcId;
      if ([...agent.inbox.nextTurn, ...agent.inbox.nextStep].some((message) => matches(message.source))) return { outcome: "queued" };
      const events = agent.session.snapshotEvents();
      let boundary = events.length - 1;
      while (boundary >= 0 && !["turn/start", "turn/end"].includes(events[boundary]!.type)) boundary--;
      if (agent.status !== "running" || boundary < 0 || events[boundary]!.type !== "turn/start" || events[boundary]!.data.turn !== p.expectedTurn) return { outcome: "stale" };
      const claim = claimed.get(agent);
      const sources = claim?.turn === p.expectedTurn ? claim.sources
        : events.slice(boundary + 1).filter((event) => event.type === "user/message").map((event) => event.data.source as InboxMessage["source"]);
      const owner = sources.find((source) => source?.kind === "goal" || source?.kind === "user" && typeof source.rpcId === "string");
      if (!matches(owner)) return { outcome: "stale" };
      const current = live.get(agent);
      if (!current || current.turn !== p.expectedTurn) return { outcome: "not_ready" };
      if (current.signal.aborted) return { outcome: "stale" };
      let bound = steering.get(agent);
      if (bound?.turn !== p.expectedTurn) {
        if (bound?.cleanup() === false) return { outcome: "not_ready" };
        const ids = new Set<string>();
        const cleanup = () => {
          // An unconsumed instruction belongs only to this turn, even on
          // rejection/error/keepInbox cancellation. Never leave it for a goal.
          try {
            removeSteering(agent, p.expectedTurn);
            for (const id of ids) if ([...agent.inbox!.nextTurn, ...agent.inbox!.nextStep].some((message) => message.id === id)) agent.inbox!.remove(id);
          }
          catch { return false; } // Preserve identity for the next safe cleanup.
          if (steering.get(agent) === bound) steering.delete(agent);
          current.signal.removeEventListener("abort", cleanup); ids.clear(); return true;
        };
        bound = { turn: p.expectedTurn, ids, cleanup }; steering.set(agent, bound);
        current.signal.addEventListener("abort", cleanup, { once: true });
      }
      // Matches native createUserMessage: fresh ID, frozen role/content/source.
      // inject is next-step WITHOUT wakeup: unlike steer(), it cannot open a
      // replacement turn after cancellation. Check and mutation never await.
      const message: SteerMessage = Object.freeze({ id: randomUUID(), role: "user", content: Object.freeze([Object.freeze({ type: "text" as const, text: p.text })]), source: Object.freeze({ kind: steerSource, rpcId: p.requestId, targetTurn: p.expectedTurn, targetRpcId: p.sourceRpcId, clientTimeZone: p.clientTimeZone }) });
      bound.ids.add(message.id); agent.inject(message);
      return { outcome: "accepted" };
    }
    if (method === "cancel-prompt") {
      const { sessionId, sourceRpcId } = promptStopSchema.parse(payload);
      signal.throwIfAborted();
      return cancelPrompt(ctx, claimed, sessionId, sourceRpcId);
    }
    if (method !== "install") throw new Error("Unsupported App operation");
    const { sessionId, definitions } = installSchema.parse(payload);
    const agent = ctx.agents.get(sessionId); if (!agent) return { installed: false };
    const key = JSON.stringify(definitions), previous = installed.get(agent);
    if (previous?.key === key) return { installed: true };
    if (agent.status !== "idle" || new Set(definitions.map((tool) => tool.name)).size !== definitions.length) return { installed: false };
    signal.throwIfAborted(); previous?.cleanup();
    const dispose: (() => void)[] = [];
    let entry: { key: string; cleanup: () => void } | undefined;
    let releaseEffect: (() => void) | undefined;
    const cleanup = () => {
      registrations.delete(cleanup); if (installed.get(agent) === entry) installed.delete(agent);
      const release = releaseEffect; releaseEffect = undefined;
      for (const remove of dispose.splice(0)) { try { remove(); } catch {} }
      release?.();
    };
    try {
      for (const definition of definitions) dispose.push(agent.ctx.tools.register({
        name: definition.name, description: definition.description, parameters: definition.inputSchema,
        output: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, render: (_args: unknown, value: { text: string }) => [{ type: "text", text: value.text }] },
        execute: async (args: unknown, exec: Execution) => {
          if (exec.agent !== agent) throw new Error("Subagents must return artifacts to the parent App turn; nothing was sent.");
          const sourceRpcId = sourceForCall(agent.session.snapshotEvents(), exec, definition.name, args);
          const result = z.object({ text: z.string(), isError: z.boolean().optional() }).strict().parse(await pipe.request("call", {
            sessionId: agent.id, sourceRpcId, callId: exec.callId, rootCallId: exec.rootCallId,
            name: definition.name, arguments: args,
          }, exec.signal));
          if (result.isError) throw new Error(result.text);
          return { text: result.text };
        },
      }));
      entry = { key, cleanup }; installed.set(agent, entry);
      registrations.add(cleanup);
      const release = agent.ctx.effect(() => cleanup);
      if (typeof release === "function") releaseEffect = release as () => void;
      return { installed: installed.get(agent) === entry };
    } catch { cleanup(); return { installed: false }; }
  }, cleanup);
  return () => { pipe.close(); cleanup(); };
}
