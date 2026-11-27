import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawnEngine } from "../runtime/engine-process.js";
import { resolveOmpLaunchCommand } from "../runtime/omp-executable.js";
import { killProcessTree } from "./process-tree.js";
import {
  OmpFrameDecoder, OmpProtocolVersionError, encodeOmpRecord, selectOmpProtocolVersion,
  type OmpAvailableCommandsUpdateFrame, type OmpBtwDeltaFrame, type OmpBtwRecord, type OmpBtwRecordFrame,
  type OmpCommand, type OmpExtensionUiRequest, type OmpExtensionUiResponse, type OmpGoalModeState, type OmpGoalRecord,
  type OmpGoalUpdatedFrame, type OmpHostToolCallFrame, type OmpHostToolCancelFrame, type OmpHostToolDefinition,
  type OmpHostToolResultFrame, type OmpHostToolUpdateFrame, type OmpModel, type OmpOutboundFrame,
  type OmpPromptResultFrame, type OmpQueueUpdateFrame, type OmpReadyFrame, type OmpResponseFrame,
  type OmpSessionEntry, type OmpSessionEvent, type OmpSessionSettledFrame, type OmpSessionState,
  type OmpSlashCommand, type OmpSubagentEventFrame, type OmpSubagentLifecycleFrame, type OmpSubagentProgressFrame,
  type OmpSubagentSummary,
} from "./omp-rpc-protocol.js";
import type { PiImageContent } from "./pi-rpc-protocol.js";

export interface OmpLaunchSpec { command: string; args: string[] }
export type OmpSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface OmpRpcClientOptions {
  launch: OmpLaunchSpec;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** RPC mode flag: "rpc-ui" (default for live sessions) or "rpc" (headless catalog). */
  mode?: "rpc" | "rpc-ui";
  args?: string[];
  startupTimeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: OmpSessionEvent) => void;
  onPromptResult?: (result: OmpPromptResultFrame) => void;
  onSessionSettled?: (frame: OmpSessionSettledFrame) => void;
  onQueueUpdate?: (frame: OmpQueueUpdateFrame) => void;
  onSubagentLifecycle?: (frame: OmpSubagentLifecycleFrame) => void;
  onSubagentProgress?: (frame: OmpSubagentProgressFrame) => void;
  onSubagentEvent?: (frame: OmpSubagentEventFrame) => void;
  onBtwRecord?: (frame: OmpBtwRecordFrame) => void;
  onBtwDelta?: (frame: OmpBtwDeltaFrame) => void;
  onExtensionUi?: (request: OmpExtensionUiRequest) => void;
  onCommandsUpdate?: (frame: OmpAvailableCommandsUpdateFrame) => void;
  spawnFn?: OmpSpawn;
  killProcessTreeFn?: (pid: number | undefined) => void | Promise<void>;
}

export interface OmpExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
  stderrTail: string;
  fatalError?: Error;
}

export class OmpStartupError extends Error {
  constructor(message: string, readonly reason: "spawn" | "exit" | "timeout" | "protocol", readonly exit?: OmpExit) {
    super(message);
    this.name = "OmpStartupError";
  }
}

export interface OmpRpcErrorDetails {
  provider?: string;
  model?: string;
  httpStatus?: number;
  retryable?: boolean;
  code?: string;
}

export class OmpRpcCommandError extends Error {
  readonly httpStatus?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly retryable?: boolean;
  constructor(readonly command: string, message: string, readonly code?: string, details?: OmpRpcErrorDetails) {
    super(message);
    this.name = "OmpRpcCommandError";
    if (details?.httpStatus !== undefined) this.httpStatus = details.httpStatus;
    if (details?.provider !== undefined) this.provider = details.provider;
    if (details?.model !== undefined) this.model = details.model;
    if (details?.retryable !== undefined) this.retryable = details.retryable;
  }
}

type Pending = { command: string; resolve(data: unknown): void; reject(error: Error): void; cleanup(): void };

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const QUICK_COMMAND_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 8 * 1024;

export class OmpRpcClient {
  private readonly pending = new Map<string, Pending>();
  private readonly decoder = new OmpFrameDecoder();
  private readonly eventListeners = new Set<(event: OmpSessionEvent) => void>();
  private readonly promptResultListeners = new Set<(frame: OmpPromptResultFrame) => void>();
  private readonly settledListeners = new Set<(frame: OmpSessionSettledFrame) => void>();
  private readonly queueListeners = new Set<(frame: OmpQueueUpdateFrame) => void>();
  private readonly subagentLifecycleListeners = new Set<(frame: OmpSubagentLifecycleFrame) => void>();
  private readonly subagentProgressListeners = new Set<(frame: OmpSubagentProgressFrame) => void>();
  private readonly subagentEventListeners = new Set<(frame: OmpSubagentEventFrame) => void>();
  private readonly btwRecordListeners = new Set<(frame: OmpBtwRecordFrame) => void>();
  private readonly btwDeltaListeners = new Set<(frame: OmpBtwDeltaFrame) => void>();
  private readonly uiListeners = new Set<(request: OmpExtensionUiRequest) => void>();
  private readonly commandsListeners = new Set<(frame: OmpAvailableCommandsUpdateFrame) => void>();
  private readonly hostToolCallListeners = new Set<(frame: OmpHostToolCallFrame) => void>();
  private readonly hostToolCancelListeners = new Set<(frame: OmpHostToolCancelFrame) => void>();
  private readonly goalUpdatedListeners = new Set<(frame: OmpGoalUpdatedFrame) => void>();

  private readyResolve?: (frame: OmpReadyFrame) => void;
  private readyReject?: (error: Error) => void;
  private readonly readyPromise: Promise<OmpReadyFrame>;
  private stderrTail = "";
  private sequence = 0;
  private closing = false;
  private exit: OmpExit | undefined;
  private fatalError: Error | undefined;
  private protocolVersion: 1 | 2 = 1;
  private readyFrame?: OmpReadyFrame;
  readonly exited: Promise<OmpExit>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly killTree: (pid: number | undefined) => void | Promise<void>,
  ) {
    this.readyPromise = new Promise<OmpReadyFrame>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyPromise.catch(() => {});

    this.exited = new Promise<OmpExit>((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exit) return;
        if (!this.fatalError) {
          try {
            for (const frame of this.decoder.end()) this.dispatchFrame(frame);
          } catch (error) {
            if (!this.closing) {
              this.fatalError = error instanceof Error ? error : new Error(String(error));
            }
          }
        }
        this.exit = {
          code,
          signal,
          expected: this.closing && !this.fatalError,
          stderrTail: this.stderrTail.slice(-1200),
          ...(this.fatalError ? { fatalError: this.fatalError } : {}),
        };
        this.readyReject?.(this.fatalError ?? new OmpStartupError(`omp exited before ready (code=${code})`, "exit", this.exit));
        this.readyResolve = undefined;
        this.readyReject = undefined;
        for (const [id, req] of this.pending) {
          this.pending.delete(id);
          req.cleanup();
          req.reject(this.fatalError ?? new OmpRpcCommandError(req.command, `omp exited before answering ${req.command}`));
        }
        resolve(this.exit);
      };
      child.once("close", finish);
      child.once("exit", (code, signal) => setTimeout(() => finish(code, signal), 50).unref?.());
      child.once("error", () => finish(null, null));
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      let frames: OmpOutboundFrame[];
      try {
        frames = this.decoder.push(chunk);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.fatalError = err;
        this.readyReject?.(err);
        this.readyResolve = undefined;
        this.readyReject = undefined;
        for (const [id, req] of this.pending) {
          this.pending.delete(id);
          req.cleanup();
          req.reject(err);
        }
        this.terminate();
        return;
      }
      for (const frame of frames) this.dispatchFrame(frame);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
  }

  get negotiatedProtocolVersion(): 1 | 2 { return this.protocolVersion; }
  get ready(): OmpReadyFrame | undefined { return this.readyFrame; }
  get alive(): boolean { return !this.exit && !this.closing; }
  get pid(): number | undefined { return this.child.pid; }

  static async start(options: OmpRpcClientOptions): Promise<OmpRpcClient> {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
    }
    const spawnFn = options.spawnFn ?? spawnEngine;
    const command = options.spawnFn ? options.launch.command : resolveOmpLaunchCommand(options.launch.command, options.env);
    if (command === undefined) {
      throw new OmpStartupError("omp executable was not found", "spawn");
    }
    const mode = options.mode ?? "rpc-ui";
    let child: ChildProcess;
    try {
      child = spawnFn(command, [...options.launch.args, "--mode", mode, ...(options.args ?? [])], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new OmpStartupError(`omp could not be started: ${error instanceof Error ? error.message : String(error)}`, "spawn");
    }
    const client = new OmpRpcClient(child, options.killProcessTreeFn ?? (pid => killProcessTree(pid)));
    if (options.onEvent) client.eventListeners.add(options.onEvent);
    if (options.onPromptResult) client.promptResultListeners.add(options.onPromptResult);
    if (options.onSessionSettled) client.settledListeners.add(options.onSessionSettled);
    if (options.onQueueUpdate) client.queueListeners.add(options.onQueueUpdate);
    if (options.onSubagentLifecycle) client.subagentLifecycleListeners.add(options.onSubagentLifecycle);
    if (options.onSubagentProgress) client.subagentProgressListeners.add(options.onSubagentProgress);
    if (options.onSubagentEvent) client.subagentEventListeners.add(options.onSubagentEvent);
    if (options.onBtwRecord) client.btwRecordListeners.add(options.onBtwRecord);
    if (options.onBtwDelta) client.btwDeltaListeners.add(options.onBtwDelta);
    if (options.onExtensionUi) client.uiListeners.add(options.onExtensionUi);
    if (options.onCommandsUpdate) client.commandsListeners.add(options.onCommandsUpdate);

    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await new Promise<OmpReadyFrame>((resolve, reject) => {
        timer = setTimeout(() => reject(new OmpStartupError(`omp did not emit ready frame within ${startupTimeoutMs} ms`, "timeout")), startupTimeoutMs);
        timer.unref?.();
        const onAbort = () => reject(new OmpStartupError("omp startup aborted", "exit"));
        options.signal?.addEventListener("abort", onAbort, { once: true });
        client.readyPromise.then(
          (frame) => { options.signal?.removeEventListener("abort", onAbort); resolve(frame); },
          (err) => { options.signal?.removeEventListener("abort", onAbort); reject(err); },
        );
      });
      clearTimeout(timer);
      if (options.signal?.aborted) {
        throw new OmpStartupError("omp startup aborted", "exit");
      }
      client.readyFrame = ready;
      // Strict protocol version check — throws OmpProtocolVersionError on unsupported versions!
      const negotiated = selectOmpProtocolVersion(ready);
      client.decoder.setMaxReassembledBytes(negotiated.maxReassembledFrameBytes);
      if (negotiated.needsNegotiation) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new OmpStartupError("omp startup aborted", "exit"));
          if (options.signal?.aborted) { onAbort(); return; }
          options.signal?.addEventListener("abort", onAbort, { once: true });
          client.command({ type: "negotiate_protocol", protocolVersion: 2 }, startupTimeoutMs).then(
            () => { options.signal?.removeEventListener("abort", onAbort); resolve(); },
            (err) => { options.signal?.removeEventListener("abort", onAbort); reject(err); },
          );
        });
      }
      if (options.signal?.aborted) {
        throw new OmpStartupError("omp startup aborted", "exit");
      }
      client.protocolVersion = negotiated.targetVersion;
      return client;
    } catch (error) {
      clearTimeout(timer);
      await client.close();
      if (error instanceof OmpProtocolVersionError || error instanceof OmpStartupError) throw error;
      throw new OmpStartupError(error instanceof Error ? error.message : String(error), "protocol");
    }
  }

  onEvent(listener: (event: OmpSessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }
  onPromptResult(listener: (frame: OmpPromptResultFrame) => void): () => void {
    this.promptResultListeners.add(listener);
    return () => { this.promptResultListeners.delete(listener); };
  }
  onSessionSettled(listener: (frame: OmpSessionSettledFrame) => void): () => void {
    this.settledListeners.add(listener);
    return () => { this.settledListeners.delete(listener); };
  }
  onQueueUpdate(listener: (frame: OmpQueueUpdateFrame) => void): () => void {
    this.queueListeners.add(listener);
    return () => { this.queueListeners.delete(listener); };
  }
  onSubagentLifecycle(listener: (frame: OmpSubagentLifecycleFrame) => void): () => void {
    this.subagentLifecycleListeners.add(listener);
    return () => { this.subagentLifecycleListeners.delete(listener); };
  }
  onSubagentProgress(listener: (frame: OmpSubagentProgressFrame) => void): () => void {
    this.subagentProgressListeners.add(listener);
    return () => { this.subagentProgressListeners.delete(listener); };
  }
  onSubagentEvent(listener: (frame: OmpSubagentEventFrame) => void): () => void {
    this.subagentEventListeners.add(listener);
    return () => { this.subagentEventListeners.delete(listener); };
  }
  onBtwRecord(listener: (frame: OmpBtwRecordFrame) => void): () => void {
    this.btwRecordListeners.add(listener);
    return () => { this.btwRecordListeners.delete(listener); };
  }
  onBtwDelta(listener: (frame: OmpBtwDeltaFrame) => void): () => void {
    this.btwDeltaListeners.add(listener);
    return () => { this.btwDeltaListeners.delete(listener); };
  }
  onExtensionUi(listener: (request: OmpExtensionUiRequest) => void): () => void {
    this.uiListeners.add(listener);
    return () => { this.uiListeners.delete(listener); };
  }
  onCommandsUpdate(listener: (frame: OmpAvailableCommandsUpdateFrame) => void): () => void {
    this.commandsListeners.add(listener);
    return () => { this.commandsListeners.delete(listener); };
  }
  onHostToolCall(listener: (frame: OmpHostToolCallFrame) => void): () => void {
    this.hostToolCallListeners.add(listener);
    return () => { this.hostToolCallListeners.delete(listener); };
  }
  onHostToolCancel(listener: (frame: OmpHostToolCancelFrame) => void): () => void {
    this.hostToolCancelListeners.add(listener);
    return () => { this.hostToolCancelListeners.delete(listener); };
  }
  onGoalUpdated(listener: (frame: OmpGoalUpdatedFrame) => void): () => void {
    this.goalUpdatedListeners.add(listener);
    return () => { this.goalUpdatedListeners.delete(listener); };
  }

  nextId(prefix = "omp"): string {
    return `${prefix}_${++this.sequence}`;
  }

  command<T = unknown>(cmd: OmpCommand, timeoutMs: number | null = QUICK_COMMAND_TIMEOUT_MS, explicitId?: string): Promise<{ id: string; data: T }> {
    if (this.exit || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new OmpRpcCommandError(cmd.type, `omp process is closed (${cmd.type})`));
    }
    const id = explicitId ?? this.nextId();
    return new Promise<{ id: string; data: T }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { if (timer) clearTimeout(timer); };
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new OmpRpcCommandError(cmd.type, `omp did not answer ${cmd.type} within ${timeoutMs} ms`, "timeout"));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, {
        command: cmd.type,
        resolve: (data) => resolve({ id, data: data as T }),
        reject,
        cleanup,
      });
      try {
        this.child.stdin!.write(encodeOmpRecord({ id, ...cmd }));
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(new OmpRpcCommandError(cmd.type, error instanceof Error ? error.message : String(error)));
      }
    });
  }

  sendExtensionUiResponse(response: OmpExtensionUiResponse): void {
    if (this.exit || !this.child.stdin || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(encodeOmpRecord(response as unknown as Record<string, unknown>));
    } catch {
      // Pipe closing
    }
  }
  sendHostToolResult(result: OmpHostToolResultFrame): void {
    if (this.exit || !this.child.stdin || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(encodeOmpRecord(result as unknown as Record<string, unknown>));
    } catch {
      // Pipe closing
    }
  }
  sendHostToolUpdate(update: OmpHostToolUpdateFrame): void {
    if (this.exit || !this.child.stdin || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(encodeOmpRecord(update as unknown as Record<string, unknown>));
    } catch {
      // Pipe closing
    }
  }

  getState(): Promise<OmpSessionState> {
    return this.command<OmpSessionState>({ type: "get_state" }).then(r => r.data);
  }
  getAvailableModels(): Promise<{ models: OmpModel[] }> {
    return this.command<{ models: OmpModel[] }>({ type: "get_available_models" }).then(r => r.data ?? { models: [] });
  }
  getAvailableCommands(): Promise<{ commands: OmpSlashCommand[] }> {
    return this.command<{ commands: OmpSlashCommand[] }>({ type: "get_available_commands" }).then(r => r.data ?? { commands: [] });
  }
  openSession(sessionDir: string, provider?: string, modelId?: string): Promise<{ cancelled: boolean; resumed: boolean; sessionId?: string; sessionFile?: string }> {
    return this.command<{ cancelled: boolean; resumed: boolean; sessionId?: string; sessionFile?: string }>({
      type: "open_session",
      sessionDir,
      ...(provider && modelId ? { provider, modelId } : {}),
    }).then(r => r.data);
  }
  setModel(provider: string, modelId: string, thinkingLevel?: string): Promise<OmpModel> {
    return this.command<OmpModel>({ type: "set_model", provider, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) }).then(r => r.data);
  }
  setThinkingLevel(level: string): Promise<void> {
    return this.command({ type: "set_thinking_level", level }).then(() => undefined);
  }
  prompt(message: string, images?: PiImageContent[], streamingBehavior?: "steer" | "followUp", explicitId?: string): Promise<{ id: string; data?: { agentInvoked?: boolean } }> {
    return this.command<{ agentInvoked?: boolean }>(
      { type: "prompt", message, ...(images?.length ? { images } : {}), ...(streamingBehavior ? { streamingBehavior } : {}) },
      null,
      explicitId,
    );
  }
  steer(message: string, images?: PiImageContent[], timeoutMs = QUICK_COMMAND_TIMEOUT_MS): Promise<void> {
    return this.command({ type: "steer", message, ...(images?.length ? { images } : {}) }, timeoutMs).then(() => undefined);
  }
  followUp(message: string, images?: PiImageContent[], timeoutMs = QUICK_COMMAND_TIMEOUT_MS): Promise<void> {
    return this.command({ type: "follow_up", message, ...(images?.length ? { images } : {}) }, timeoutMs).then(() => undefined);
  }
  btw(question: string, recordId?: string): Promise<{ record: OmpBtwRecord }> {
    return this.command<{ record: OmpBtwRecord }>({ type: "btw", question, ...(recordId ? { recordId } : {}) }, null).then(r => r.data);
  }
  btwCancel(recordId?: string): Promise<{ cancelled: boolean }> {
    return this.command<{ cancelled: boolean }>({ type: "btw_cancel", ...(recordId ? { recordId } : {}) }).then(r => r.data);
  }
  abort(): Promise<void> {
    return this.command({ type: "abort" }, 10_000).then(() => undefined);
  }
  abortAndRestoreQueue(): Promise<{ steering?: string[]; followUp?: string[] }> {
    return this.command<{ steering?: string[]; followUp?: string[] }>({ type: "abort_and_restore_queue" }, 10_000).then(r => r.data ?? {});
  }
  abortAndPrompt(message: string, images?: PiImageContent[]): Promise<{ id: string; data?: { agentInvoked?: boolean } }> {
    return this.command<{ agentInvoked?: boolean }>({ type: "abort_and_prompt", message, ...(images?.length ? { images } : {}) }, null);
  }
  setSubagentSubscription(level: "off" | "progress" | "events"): Promise<void> {
    return this.command({ type: "set_subagent_subscription", level }).then(() => undefined);
  }
  cancelSubagent(subagentId: string): Promise<{ cancelled: boolean }> {
    return this.command<{ cancelled: boolean }>({ type: "cancel_subagent", subagentId }).then(r => r.data);
  }
  steerSubagent(subagentId: string, message: string): Promise<void> {
    return this.command({ type: "steer_subagent", subagentId, message }, QUICK_COMMAND_TIMEOUT_MS).then(() => undefined);
  }
  setAskDialog(enabled: boolean): Promise<void> {
    return this.command({ type: "set_ask_dialog", enabled }).then(() => undefined);
  }
  setHostTools(tools: OmpHostToolDefinition[]): Promise<{ toolNames: string[] }> {
    return this.command<{ toolNames: string[] }>({ type: "set_host_tools", tools }).then(r => r.data ?? { toolNames: [] });
  }
  getEntries(since?: string): Promise<{ entries: OmpSessionEntry[]; leafId: string | null }> {
    return this.command<{ entries: OmpSessionEntry[]; leafId: string | null }>({ type: "get_entries", ...(since ? { since } : {}) }).then(r => r.data ?? { entries: [], leafId: null });
  }
  fork(entryId?: string): Promise<{ cancelled: boolean }> {
    return this.command<{ cancelled: boolean }>({ type: "fork", ...(entryId ? { entryId } : {}) }).then(r => r.data ?? { cancelled: false });
  }
  navigateTree(entryId: string, options: { summarize?: boolean; customInstructions?: string } = {}): Promise<{ cancelled: boolean; aborted?: true; editorText?: string }> {
    return this.command<{ cancelled: boolean; aborted?: true; editorText?: string }>({ type: "navigate_tree", entryId, ...options }).then(r => r.data ?? { cancelled: false });
  }
  switchSession(sessionPath: string, provider?: string, modelId?: string): Promise<{ cancelled: boolean }> {
    return this.command<{ cancelled: boolean }>({ type: "switch_session", sessionPath, ...(provider && modelId ? { provider, modelId } : {}) }).then(r => r.data ?? { cancelled: false });
  }
  getSubagents(): Promise<{ subagents?: OmpSubagentSummary[] }> {
    return this.command<{ subagents?: OmpSubagentSummary[] }>({ type: "get_subagents" }).then(r => r.data ?? {});
  }
  compact(customInstructions?: string): Promise<unknown> {
    return this.command({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }, null).then(r => r.data);
  }
  goal(op: "get" | "create" | "resume" | "pause" | "drop", options: { objective?: string; token_budget?: number } = {}): Promise<{ goal: OmpGoalRecord | null; state?: OmpGoalModeState | null }> {
    return this.command<{ goal: OmpGoalRecord | null; state?: OmpGoalModeState | null }>({ type: "goal", op, ...options }).then(r => r.data ?? { goal: null });
  }

  private dispatchFrame(frame: OmpOutboundFrame): void {
    if (frame.type === "ready") {
      this.readyResolve?.(frame as OmpReadyFrame);
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (frame.type === "response") {
      const resp = frame as OmpResponseFrame;
      if (resp.id && this.pending.has(resp.id)) {
        const req = this.pending.get(resp.id)!;
        this.pending.delete(resp.id);
        req.cleanup();
        if (resp.success) req.resolve(resp.data);
        else req.reject(new OmpRpcCommandError(resp.command, resp.error || `omp ${resp.command} failed`, resp.code));
      }
      return;
    }
    if (frame.type === "prompt_result") {
      for (const listener of this.promptResultListeners) listener(frame as OmpPromptResultFrame);
      return;
    }
    if (frame.type === "session_settled") {
      for (const listener of this.settledListeners) listener(frame as OmpSessionSettledFrame);
      return;
    }
    if (frame.type === "queue_update") {
      for (const listener of this.queueListeners) listener(frame as OmpQueueUpdateFrame);
      return;
    }
    if (frame.type === "subagent_lifecycle") {
      for (const listener of this.subagentLifecycleListeners) listener(frame as OmpSubagentLifecycleFrame);
      return;
    }
    if (frame.type === "subagent_progress") {
      for (const listener of this.subagentProgressListeners) listener(frame as OmpSubagentProgressFrame);
      return;
    }
    if (frame.type === "subagent_event") {
      for (const listener of this.subagentEventListeners) listener(frame as OmpSubagentEventFrame);
      return;
    }
    if (frame.type === "btw_record") {
      for (const listener of this.btwRecordListeners) listener(frame as OmpBtwRecordFrame);
      return;
    }
    if (frame.type === "btw_delta") {
      for (const listener of this.btwDeltaListeners) listener(frame as OmpBtwDeltaFrame);
      return;
    }
    if (frame.type === "extension_ui_request") {
      for (const listener of this.uiListeners) listener(frame as OmpExtensionUiRequest);
      return;
    }
    if (frame.type === "available_commands_update") {
      for (const listener of this.commandsListeners) listener(frame as OmpAvailableCommandsUpdateFrame);
      return;
    }
    if (frame.type === "host_tool_call") {
      for (const listener of this.hostToolCallListeners) listener(frame as OmpHostToolCallFrame);
      return;
    }
    if (frame.type === "host_tool_cancel") {
      for (const listener of this.hostToolCancelListeners) listener(frame as OmpHostToolCancelFrame);
      return;
    }
    if (frame.type === "goal_updated") {
      for (const listener of this.goalUpdatedListeners) listener(frame as OmpGoalUpdatedFrame);
    }
    for (const listener of this.eventListeners) listener(frame as OmpSessionEvent);
  }

  terminate(): void {
    this.closing = true;
    try { this.child.stdin?.end(); } catch { /* ignore */ }
    void this.killTree(this.child.pid);
  }

  async close(): Promise<OmpExit> {
    if (this.exit) return this.exit;
    this.closing = true;
    try { this.child.stdin?.end(); } catch { /* ignore */ }
    const timer = setTimeout(() => { void this.killTree(this.child.pid); }, 1500);
    timer.unref?.();
    const exit = await this.exited;
    clearTimeout(timer);
    return exit;
  }
}

export async function queryOmpCatalog(options: {
  launch: OmpLaunchSpec;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn?: OmpSpawn;
  timeoutMs?: number;
}): Promise<{ models: OmpModel[]; current?: { provider: string; modelId: string } }> {
  const client = await OmpRpcClient.start({
    launch: options.launch,
    cwd: options.cwd,
    env: options.env,
    mode: "rpc",
    args: ["--no-session", "--no-ui"],
    startupTimeoutMs: options.timeoutMs ?? 15_000,
    ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
  });
  try {
    const [modelsRes, state] = await Promise.all([client.getAvailableModels(), client.getState()]);
    const current = state.model?.provider && state.model?.id ? { provider: state.model.provider, modelId: state.model.id } : undefined;
    return { models: modelsRes.models ?? [], ...(current ? { current } : {}) };
  } finally {
    await client.close();
  }
}
