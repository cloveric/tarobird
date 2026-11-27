import { StringDecoder } from "node:string_decoder";
import type { PiAssistantMessage, PiImageContent, PiMessage, PiModel, PiQueueMode, PiSessionState, PiThinkingLevel, PiUsage } from "./pi-rpc-protocol.js";

/**
 * Wire protocol for `omp --mode rpc` / `omp --mode rpc-ui` (can1357/oh-my-pi).
 * Supports protocol versions 1 and 2, including v2 lossless `rpc_chunk` framing,
 * per-prompt `prompt_result` + `session_settled` lifecycle, three queues
 * (steer / follow_up / aside `btw`), subagent subscriptions, and `rpc-ui`.
 */
export const OMP_SUPPORTED_PROTOCOL_VERSIONS = [1, 2] as const;
export const OMP_DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const OMP_DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

export class OmpProtocolVersionError extends Error {
  constructor(
    message: string,
    readonly advertisedVersion: unknown,
    readonly supportedVersions: readonly number[],
  ) {
    super(message);
    this.name = "OmpProtocolVersionError";
  }
}

export class OmpFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpFrameError";
  }
}

export interface OmpReadyFrame {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions?: number[];
  maxFrameBytes?: number;
  maxReassembledFrameBytes?: number;
  supportsBashExcludeFromContext?: boolean;
}

export interface OmpRpcChunkFrame {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

export interface OmpPromptResultFrame {
  type: "prompt_result";
  id?: string;
  agentInvoked: boolean;
  status: "completed" | "aborted" | "error";
  error?: {
    message: string;
    provider?: string;
    model?: string;
    httpStatus?: number;
    retryable?: boolean;
    code?: string;
  };
  sessionSettled: boolean;
}

export interface OmpSessionSettledFrame {
  type: "session_settled";
}

export interface OmpQueueUpdateFrame {
  type: "queue_update";
  steering: string[];
  followUp: string[];
}

export interface OmpSlashCommand {
  name: string;
  source: string;
  aliases?: string[];
  description?: string;
  input?: { hint?: string };
  subcommands?: Array<{ name: string; description?: string }>;
}

export interface OmpAvailableCommandsUpdateFrame {
  type: "available_commands_update";
  commands: OmpSlashCommand[];
}

export interface OmpSubagentSummary {
  id: string;
  index?: number;
  agent?: string;
  agentSource?: string;
  description?: string;
  status: "started" | "running" | "completed" | "failed" | "aborted" | (string & {});
  task?: string;
  sessionFile?: string;
  parentToolCallId?: string;
  error?: string;
}

export interface OmpSubagentProgressPayload {
  id?: string;
  index?: number;
  agent?: string;
  task?: string;
  description?: string;
  progress?: {
    status?: string;
    currentTool?: string;
    lastIntent?: string;
    text?: string;
    recentTools?: Array<{ tool?: string; args?: string }>;
    [key: string]: unknown;
  } | string;
  [key: string]: unknown;
}

export interface OmpSubagentLifecycleFrame {
  type: "subagent_lifecycle";
  payload?: OmpSubagentSummary;
}

export interface OmpSubagentProgressFrame {
  type: "subagent_progress";
  payload?: OmpSubagentProgressPayload;
}

export interface OmpSubagentEventFrame {
  type: "subagent_event";
  payload?: {
    id?: string;
    event?: Record<string, unknown>;
  };
}

export type OmpBtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";
export interface OmpBtwRecord {
  id: string;
  question: string;
  answer: string;
  status: OmpBtwStatus;
  leafId: string | null;
  createdAt: number;
  updatedAt: number;
  error?: string;
  followUps?: Array<{ question: string; answer: string; status: OmpBtwStatus; createdAt: number; updatedAt: number; error?: string }>;
}

export interface OmpBtwRecordFrame {
  type: "btw_record";
  record: OmpBtwRecord;
}

export interface OmpBtwDeltaFrame {
  type: "btw_delta";
  recordId: string;
  delta: string;
}

export interface OmpExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "ask" | "form" | "cancel" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | "open_url" | (string & {});
  title?: string;
  message?: string;
  placeholder?: string;
  prefill?: string;
  options?: string[];
  optionDetails?: Array<{ description?: string }>;
  timeout?: number;
  secret?: boolean;
  targetId?: string;
  html?: string;
  fields?: Array<{
    name: string;
    type?: string;
    label?: string;
    placeholder?: string;
    value?: string;
    options?: Array<string | { value?: string; label: string; description?: string }>;
    required?: boolean;
  }>;
  questions?: Array<{
    id: string;
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string; preview?: string }>;
    multi?: boolean;
    recommended?: number;
  }>;
  url?: string;
  launchUrl?: string;
  instructions?: string;
  [key: string]: unknown;
}

export type OmpExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean }
  | { type: "extension_ui_response"; id: string; answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> }
  | { type: "extension_ui_response"; id: string; data: Record<string, string | number | string[]> };

export interface OmpHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
  loadMode?: "essential" | "discoverable";
  readsSkillUris?: boolean;
}

export interface OmpHostToolCallFrame {
  type: "host_tool_call";
  id: string;
  toolCallId?: string;
  toolName: string;
  arguments?: unknown;
}

export interface OmpHostToolCancelFrame {
  type: "host_tool_cancel";
  id?: string;
  targetId: string;
}

export interface OmpHostToolResultFrame {
  type: "host_tool_result";
  id: string;
  isError?: boolean;
  result: {
    content: Array<{ type: "text"; text: string }>;
  };
}

export interface OmpHostToolUpdateFrame {
  type: "host_tool_update";
  id: string;
  partialResult: {
    content: Array<{ type: "text"; text: string }>;
  };
}

export interface OmpSessionEntry {
  id: string;
  parentId?: string | null;
  type: string;
  timestamp?: string | number;
  message?: { role?: string; content?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

export interface OmpGoalRecord {
  objective: string;
  status?: "active" | "paused" | "blocked" | "complete" | "usageLimited" | "budgetLimited" | "budget-limited" | "dropped" | (string & {});
  token_budget?: number | null;
  tokenBudget?: number | null;
  tokens_used?: number;
  tokensUsed?: number;
  time_used_seconds?: number;
  timeUsedSeconds?: number;
  created_at?: number;
  createdAt?: number;
  updated_at?: number;
  updatedAt?: number;
}

export interface OmpGoalModeState {
  enabled?: boolean;
  mode?: string;
  reason?: string;
  goal?: OmpGoalRecord | null;
  status?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  [key: string]: unknown;
}

export interface OmpGoalUpdatedFrame {
  type: "goal_updated";
  goal?: OmpGoalRecord | OmpGoalModeState | null;
  state?: OmpGoalModeState | null;
}

export interface OmpResponseFrame {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

export interface OmpSessionState extends Omit<PiSessionState, "thinkingLevel" | "pendingMessageCount"> {
  thinkingLevel: PiThinkingLevel | "inherit" | "auto";
  pendingMessageCount?: number;
  queuedMessageCount?: number;
  isSettled?: boolean;
  hasPendingAsyncWork?: boolean;
  interruptMode?: "immediate" | "wait";
  queuedMessages?: { steering: string[]; followUp: string[] };
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  goal?: OmpGoalModeState | OmpGoalRecord | null;
}

export type OmpCommand =
  | { type: "negotiate_protocol"; protocolVersion: 2 }
  | { type: "prompt"; message: string; images?: PiImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string; images?: PiImageContent[] }
  | { type: "follow_up"; message: string; images?: PiImageContent[] }
  | { type: "remove_queued_message"; message: string; queue: "steering" | "followUp" }
  | { type: "promote_queued_message"; message: string }
  | { type: "abort" }
  | { type: "abort_and_prompt"; message: string; images?: PiImageContent[] }
  | { type: "abort_and_restore_queue" }
  | { type: "abort_and_deliver_queue" }
  | { type: "resume" }
  | { type: "new_session"; parentSession?: string }
  | { type: "open_session"; sessionDir: string; provider?: string; modelId?: string }
  | { type: "switch_session"; sessionPath: string; provider?: string; modelId?: string }
  | { type: "get_state" }
  | { type: "get_entries"; since?: string }
  | { type: "get_tree" }
  | { type: "fork"; entryId?: string }
  | { type: "navigate_tree"; entryId: string; summarize?: boolean; customInstructions?: string }
  | { type: "set_session_name"; name: string }
  | { type: "set_host_tools"; tools: OmpHostToolDefinition[] }
  | { type: "get_available_models" }
  | { type: "get_available_commands" }
  | { type: "get_available_thinking_levels" }
  | { type: "set_model"; provider: string; modelId: string; thinkingLevel?: string; role?: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "set_steering_mode"; mode: PiQueueMode }
  | { type: "set_follow_up_mode"; mode: PiQueueMode }
  | { type: "set_interrupt_mode"; mode: "immediate" | "wait" }
  | { type: "set_ask_dialog"; enabled: boolean }
  | { type: "set_subagent_subscription"; level: "off" | "progress" | "events" }
  | { type: "get_subagents" }
  | { type: "cancel_subagent"; subagentId: string }
  | { type: "steer_subagent"; subagentId: string; message: string }
  | { type: "btw"; question: string; recordId?: string }
  | { type: "btw_cancel"; recordId?: string }
  | { type: "get_btw_history" }
  | { type: "compact"; customInstructions?: string }
  | { type: "get_session_stats" }
  | { type: "goal"; op: "get" | "create" | "resume" | "pause" | "drop"; objective?: string; token_budget?: number }
  | { type: "bash"; command: string; excludeFromContext?: boolean }
  | { type: "abort_bash" };

export type OmpSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: PiMessage[]; isTerminal?: boolean; yielded?: boolean; awaitingAsyncWork?: boolean; messageCount?: number }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: PiMessage }
  | { type: "message_start"; messageId?: string; message?: PiMessage }
  | { type: "message_update"; messageId?: string; usage?: PiUsage; message?: PiMessage; assistantMessageEvent?: Record<string, unknown> }
  | { type: "message_end"; messageId?: string; message?: PiAssistantMessage | PiMessage }
  | { type: "tool_execution_start"; toolCallId?: string; toolName?: string; args?: unknown; parentToolCallId?: string }
  | { type: "tool_execution_update"; toolCallId?: string; toolName?: string; args?: unknown; partialResult?: unknown; parentToolCallId?: string }
  | { type: "tool_stream_update"; toolCallId?: string; toolName?: string; delta?: string; parentToolCallId?: string }
  | { type: "tool_execution_end"; toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean; durationMs?: number; parentToolCallId?: string }
  | { type: "manual_compaction_start" | "auto_compaction_start"; mode?: string; reason?: string }
  | { type: "manual_compaction_end" | "auto_compaction_end"; aborted?: boolean; skipped?: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string }
  | { type: "auto_retry_end"; success?: boolean; attempt?: number; finalError?: string }
  | { type: "retry_fallback_applied"; from?: string; to?: string; role?: string; reason?: string }
  | { type: "ttsr_triggered"; rules?: Array<{ name?: string; path?: string; content?: string }> }
  | OmpGoalUpdatedFrame
  | { type: "command_output"; text?: string; output?: string }
  | { type: "notice"; level?: string; source?: string; message?: string }
  | { type: "extension_error"; extensionPath?: string; event?: string; error?: string }
  | { type: "rpc_frame_error"; error?: string }
  | { type: string; [key: string]: unknown };

export type OmpOutboundFrame =
  | OmpReadyFrame
  | OmpRpcChunkFrame
  | OmpResponseFrame
  | OmpPromptResultFrame
  | OmpSessionSettledFrame
  | OmpQueueUpdateFrame
  | OmpAvailableCommandsUpdateFrame
  | OmpSubagentLifecycleFrame
  | OmpSubagentProgressFrame
  | OmpSubagentEventFrame
  | OmpBtwRecordFrame
  | OmpBtwDeltaFrame
  | OmpExtensionUiRequest
  | OmpHostToolCallFrame
  | OmpHostToolCancelFrame
  | OmpGoalUpdatedFrame
  | OmpSessionEvent;

/**
 * Validate the startup `ready` frame and select the protocol version to use.
 * Refuses unsupported versions explicitly — never silently downgrades.
 */
export function selectOmpProtocolVersion(ready: OmpReadyFrame): {
  targetVersion: 1 | 2;
  needsNegotiation: boolean;
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
} {
  const advertised = Array.isArray(ready.supportedProtocolVersions) && ready.supportedProtocolVersions.length > 0
    ? ready.supportedProtocolVersions.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
    : typeof ready.protocolVersion === "number" && Number.isInteger(ready.protocolVersion)
      ? [ready.protocolVersion]
      : [];
  const supported = advertised.filter((v): v is 1 | 2 => v === 1 || v === 2);
  if (supported.length === 0) {
    throw new OmpProtocolVersionError(
      `Unsupported omp RPC protocol version (advertised: ${JSON.stringify(advertised.length ? advertised : ready.protocolVersion)}; TaroBird supports v1 and v2). Update TaroBird or omp.`,
      ready.protocolVersion,
      OMP_SUPPORTED_PROTOCOL_VERSIONS,
    );
  }
  const targetVersion: 1 | 2 = supported.includes(2) ? 2 : 1;
  return {
    targetVersion,
    needsNegotiation: targetVersion === 2 && ready.protocolVersion !== 2,
    maxFrameBytes: typeof ready.maxFrameBytes === "number" && ready.maxFrameBytes > 0 ? ready.maxFrameBytes : OMP_DEFAULT_MAX_FRAME_BYTES,
    maxReassembledFrameBytes: typeof ready.maxReassembledFrameBytes === "number" && ready.maxReassembledFrameBytes > 0 ? ready.maxReassembledFrameBytes : OMP_DEFAULT_MAX_REASSEMBLED_BYTES,
  };
}

/**
 * Strict LF-delimited JSONL + protocol v2 `rpc_chunk` frame decoder.
 * Rejects interleaved/interrupted chunks and enforces `maxReassembledFrameBytes`.
 */
export class OmpFrameDecoder {
  private readonly textDecoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private activeChunk: { chunkId: string; count: number; byteLength: number; nextIndex: number; parts: Buffer[]; receivedBytes: number } | undefined;
  private maxReassembledBytes = OMP_DEFAULT_MAX_REASSEMBLED_BYTES;

  setMaxReassembledBytes(limit: number): void {
    if (Number.isFinite(limit) && limit > 0) this.maxReassembledBytes = limit;
  }

  push(chunk: Buffer): OmpOutboundFrame[] {
    this.lineBuffer += this.textDecoder.write(chunk);
    return this.drainLines();
  }

  end(): OmpOutboundFrame[] {
    this.lineBuffer += this.textDecoder.end();
    const frames = this.drainLines();
    if (this.lineBuffer.trim()) {
      const trailing = this.lineBuffer.trim();
      this.lineBuffer = "";
      const frame = this.decodeLine(trailing);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private drainLines(): OmpOutboundFrame[] {
    const frames: OmpOutboundFrame[] = [];
    let nl: number;
    while ((nl = this.lineBuffer.indexOf("\n")) >= 0) {
      const line = this.lineBuffer.slice(0, nl).trim();
      this.lineBuffer = this.lineBuffer.slice(nl + 1);
      if (!line) continue;
      const frame = this.decodeLine(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private decodeLine(line: string): OmpOutboundFrame | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      return undefined;
    }
    const frame = parsed as OmpOutboundFrame;
    if (frame.type === "rpc_chunk") {
      return this.consumeChunk(frame as OmpRpcChunkFrame);
    }
    if (this.activeChunk) {
      const interrupted = this.activeChunk.chunkId;
      this.activeChunk = undefined;
      throw new OmpFrameError(`Interrupted omp rpc_chunk sequence ${interrupted} by ${frame.type}`);
    }
    return frame;
  }

  private consumeChunk(chunk: OmpRpcChunkFrame): OmpOutboundFrame | undefined {
    if (typeof chunk.chunkId !== "string" || !chunk.chunkId || !Number.isInteger(chunk.index) || !Number.isInteger(chunk.count) || chunk.count < 1 || !Number.isInteger(chunk.byteLength) || chunk.byteLength < 0 || typeof chunk.data !== "string") {
      this.activeChunk = undefined;
      throw new OmpFrameError("Malformed omp rpc_chunk header");
    }
    if (chunk.byteLength > this.maxReassembledBytes) {
      this.activeChunk = undefined;
      throw new OmpFrameError(`omp rpc_chunk byteLength ${chunk.byteLength} exceeds maxReassembledFrameBytes ${this.maxReassembledBytes}`);
    }
    if (!this.activeChunk) {
      if (chunk.index !== 0) {
        throw new OmpFrameError(`Unexpected omp rpc_chunk start index ${chunk.index} for ${chunk.chunkId}`);
      }
      this.activeChunk = { chunkId: chunk.chunkId, count: chunk.count, byteLength: chunk.byteLength, nextIndex: 0, parts: [], receivedBytes: 0 };
    }
    const state = this.activeChunk;
    if (chunk.chunkId !== state.chunkId || chunk.index !== state.nextIndex || chunk.count !== state.count || chunk.byteLength !== state.byteLength) {
      this.activeChunk = undefined;
      throw new OmpFrameError(`Interleaved or mismatched omp rpc_chunk ${chunk.chunkId} at index ${chunk.index}`);
    }
    const decoded = Buffer.from(chunk.data, "base64");
    state.parts.push(decoded);
    state.receivedBytes += decoded.length;
    state.nextIndex += 1;
    if (state.receivedBytes > state.byteLength) {
      this.activeChunk = undefined;
      throw new OmpFrameError(`omp rpc_chunk ${state.chunkId} exceeded declared byteLength`);
    }
    if (state.nextIndex < state.count) return undefined;
    this.activeChunk = undefined;
    if (state.receivedBytes !== state.byteLength) {
      throw new OmpFrameError(`omp rpc_chunk ${state.chunkId} byteLength mismatch (${state.receivedBytes} != ${state.byteLength})`);
    }
    const full = Buffer.concat(state.parts, state.byteLength);
    const jsonText = new TextDecoder("utf-8", { fatal: true }).decode(full);
    const assembled = JSON.parse(jsonText) as OmpOutboundFrame;
    if (!assembled || typeof assembled !== "object" || typeof assembled.type !== "string") {
      throw new OmpFrameError(`Reassembled omp rpc_chunk ${state.chunkId} is not a valid frame`);
    }
    return assembled;
  }
}

export function encodeOmpRecord(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

export type OmpModel = PiModel;
