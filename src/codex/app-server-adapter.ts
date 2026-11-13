import { SIDE_TOOL_INSTRUCTIONS } from "./side-instructions.js";
import { isLogicalSessionId } from "../runtime/logical-session.js";
import { wholeFilePatch } from "../core/recorded-diff.js";
import { spawnEngine } from "../runtime/engine-process.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import type {
  AdapterUsage,
  AppPlatformTools,
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexThreadGoal,
  CodexThreadGoalResponse,
  CodexUserMessageInput,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineSideSession,
  EngineStreamEvent,
  SideCapability,
} from "./adapter.js";
import { EngineContextCompactionPendingError } from "./adapter.js";
import { appendUniqueSendImageTag, extractGeneratedImagePath, sendImageTag } from "./generated-files.js";
import { killProcessTree } from "./process-tree.js";
import { normalizeCodexUserInput } from "./codex-user-input.js";
import { normalizeCodexMcpElicitation } from "./codex-mcp-elicitation.js";
import { normalizeCodexPermissions, deniedCodexPermissions } from "./codex-permissions.js";
import { codexSubagentActivity } from "./subagent-activity.js";
import { boundedCodexAgentStates } from "./agent-states.js";
import { sideAttachmentPrompt } from "./side-attachments.js";
import { prependPrivateTurnInstructions } from "./turn-instructions.js";
import { EngineRetryableError, engineRetryReason, type EngineRetryReason } from "./turn-retry.js";
import { reconcileCodexRetryCommands } from "./retry-tools.js";
import {
  findThreadWriterLockHolder,
  renderThreadWriterLockDiagnosis,
  resolveCodexHome,
} from "./thread-writer-lock.js";
import { readValidatedConfigFile, resolveEngineOverride, unsupportedEngineEffortError, type EngineOverride } from "../state/instance-config.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../state/approval-mode.js";
import { codexManagedSearchConfig, searchMcpBlocksManaged, type NativeSearchMcpPlan, type NativeSearchMcpPlanner } from "../runtime/native-search-mcp.js";

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

type ProcessStreamLike = {
  on(event: "data", listener: (chunk: Buffer | { toString(): string } | string) => void): void;
};

type Writable = {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end?(callback?: () => void): void;
  on?(event: "error", listener: (error: Error) => void): void;
};

type AppServerChildProcess = {
  pid?: number;
  stdin?: Writable;
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: () => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

export type AppServerSpawnCodex = (command: string, args: string[], options: SpawnOptions) => AppServerChildProcess;
const MAX_INSTRUCTIONS_CHARS = 16_000;
/**
 * Cap on raw turn-scoped JSON-RPC lines held while a turn id is not yet confirmed
 * (only reachable while a /goal pursuit shares the thread).
 */
const UNIDENTIFIED_TURN_LINE_BUFFER_MAX = 200;
const UNIDENTIFIED_TURN_LINE_BUFFER_MAX_BYTES = 2 * 1024 * 1024;

const MAX_LINE_BUFFER_BYTES = 1024 * 1024;
const MAX_PROTOCOL_LINE_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 4_000;
export const CODEX_APP_SERVER_TURN_TIMEOUT_MS = 6 * 60 * 60_000;
export const CODEX_APP_SERVER_INACTIVITY_TIMEOUT_MS = 30 * 60_000;
export const CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS = 30_000;
export const CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS = 180_000;
export const CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;
export const CODEX_APP_SERVER_TURN_INTERRUPT_TIMEOUT_MS = 5_000;
export const CODEX_APP_SERVER_TURN_STEER_TIMEOUT_MS = 5_000;
export const CODEX_APP_SERVER_GOAL_RPC_TIMEOUT_MS = 60_000;
// Native compaction of a large context can legitimately exceed three minutes.
export const CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS = 300_000;
// Measured from the start. Without a terminal receipt by then, the operation no
// longer blocks idle admission and its child is recycled once nothing else runs.
export const CODEX_APP_SERVER_COMPACTION_CEILING_MS = 900_000;
export const CODEX_APP_SERVER_AUTO_COMPACT_RATIO = 0.8;
type AppServerApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

type JsonRpcId = number | string;

type JsonRpcResponse = {
  id?: JsonRpcId;
  result?: unknown;
  error?: {
    message?: string;
    code?: number;
  };
  method?: string;
  params?: Record<string, unknown>;
};

type AppServerRequest = JsonRpcResponse & {
  id: JsonRpcId;
  method: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  threadId?: string;
  createdAt: number;
  childGeneration: number;
};

class CodexAppServerRequestTimeoutError extends Error {
  constructor(message: string, readonly childGeneration: number) {
    super(message);
    this.name = "CodexAppServerRequestTimeoutError";
  }
}

class ThreadReadTimeoutError extends CodexAppServerRequestTimeoutError {
  constructor(message: string, childGeneration: number) {
    super(message, childGeneration);
    this.name = "ThreadReadTimeoutError";
  }
}

const CODEX_TRANSIENT_HTTP_ERROR_KINDS = new Set([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);

/** Retryable provider failures from Codex's structured `codexErrorInfo` (0.163
 * schema). Quota, auth, policy, context, sandbox and unknown variants stay fatal. */
export function codexTransientRetryReason(info: unknown): EngineRetryReason | undefined {
  if (info === "serverOverloaded") return "capacity";
  if (info === "rateLimitExceeded") return "rate-limit";
  if (info === "internalServerError") return "connection";
  if (typeof info !== "object" || info === null || Array.isArray(info)) return undefined;
  const entries = Object.entries(info);
  if (entries.length !== 1 || !CODEX_TRANSIENT_HTTP_ERROR_KINDS.has(entries[0]![0])) return undefined;
  const detail = entries[0]![1];
  const status = typeof detail === "object" && detail !== null ? (detail as { httpStatusCode?: unknown }).httpStatusCode : undefined;
  if (status === undefined || status === null) return "connection";
  if (status === 429) return "rate-limit";
  if (status === 529) return "capacity";
  return typeof status === "number" && status >= 500 && status <= 599 ? "connection" : undefined;
}

function readCodexErrorInfo(error: unknown): unknown {
  return typeof error === "object" && error !== null && !Array.isArray(error)
    ? (error as { codexErrorInfo?: unknown }).codexErrorInfo ?? undefined
    : undefined;
}

class CodexActiveWriterConflictError extends Error {
  constructor(
    message: string,
    readonly childGeneration: number,
    readonly isOwnChild: boolean,
  ) {
    super(message);
    this.name = "CodexActiveWriterConflictError";
  }
}

function isThreadReadTimeoutError(error: unknown): error is ThreadReadTimeoutError {
  return error instanceof ThreadReadTimeoutError || (error instanceof Error && error.name === "ThreadReadTimeoutError");
}

/** True when another process still owns Codex's cross-process thread writer lock. */
function isActiveWriterConflict(error: Error): boolean {
  return /already has an active writer/i.test(error.message);
}

const CODEX_SEARCH_CONFIG_READ_TIMEOUT_MS = 5_000;

type AppServerDependencies = {
  findThreadWriterLockHolder: typeof findThreadWriterLockHolder;
  /** Host-managed Brave/Tavily MCP, added per thread when credentials are effective. */
  nativeSearchMcp: NativeSearchMcpPlanner;
};

/** Collab calls that only observe or stop child agents; any other collab tool
 * (spawnAgent, sendInput, resumeAgent, followupTask, sendMessage, or one this
 * adapter does not know) is treated as starting or continuing child work. */
const CODEX_CHILD_OBSERVE_TOOLS = new Set(["wait", "closeAgent", "interruptAgent", "listAgents"]);
/** Explicit agent states proving that a child's work ended; pendingInit,
 * running, a missing state or an unknown value prove nothing. */
const CODEX_CHILD_TERMINAL_STATES = new Set(["completed", "errored", "shutdown", "interrupted", "notFound"]);
const CODEX_RECENT_CHILD_TURNS_MAX = 128;

type CodexChildWork = { launchSeq: number; live: boolean; startedTurnId?: string; startedSeq?: number };
type CodexChildTurn = { startedTurnId?: string; startedSeq?: number; completedTurnId?: string; completedSeq?: number };
/** Child agent work started or continued by one foreground turn. Ordered by the
 * single app-server stream; a child is released only by evidence after its latest launch. */
type CodexChildWorkLedger = {
  children: Map<string, CodexChildWork>;
  launchStarts: Map<string, number>;
  launchesInFlight: Set<string>;
  seenItems: Set<string>;
  unattributed: boolean;
};

type PendingTurn = {
  threadId: string;
  chunks: string[];
  finalText?: string;
  generatedImageTags: string[];
  usage?: AdapterUsage;
  /** Latest app-server `error` notification. These notifications can be
   * transient (`willRetry: true`), so the authoritative turn/completed status
   * decides whether this message is fatal. */
  notificationErrorMessage?: string;
  /** Structured `codexErrorInfo` and `willRetry` from that same notification. */
  notificationErrorInfo?: unknown;
  notificationWillRetry?: boolean;
  /** Child agents this turn started or continued (collabAgentToolCall). */
  childWork?: CodexChildWorkLedger;
  /** Exact native command items observed on this foreground turn. */
  unfinishedCommandIds?: Set<string>;
  errorMessage?: string;
  turnId?: string;
  /**
   * Raw turn-scoped JSON-RPC lines that arrived carrying a turnId BEFORE this
   * turn's own id was known, while a /goal pursuit shared the thread. They cannot
   * be routed yet (they may be the goal's), and dropping them stranded a turn
   * that had already completed. They are replayed once the id-correlated
   * `turn/start` response identifies this turn; mismatched requests are settled
   * explicitly and mismatched notifications are discarded.
   */
  pendingUnidentifiedLines?: string[];
  pendingUnidentifiedBytes?: number;
  /** Cumulative stderr chars seen when this turn started; failure diagnostics
   * only include stderr produced after this point, so an hours-old tail line
   * (e.g. a stale 401) cannot misclassify an unrelated later failure. */
  stderrOffset: number;
  startedAt: number;
  lastActivityAt?: number;
  lastActivityMethod?: string;
  lastInactivityAt?: number;
  onProgress?: (partialText: string) => void;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onUserInputRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  appPlatformTools?: AppPlatformTools;
  appToolCalls?: Map<string, { signature: string; result: Promise<{ text: string; isError?: boolean }> }>;
  interactionAbortController: AbortController;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  /**
   * Set when this turn was aborted/timed out BEFORE its `turn/start` response
   * delivered a turn id. The interrupt could not be addressed yet, so the
   * app-server kept executing the turn and held the thread's writer — every
   * later turn on that thread then failed with "thread ... already has an
   * active writer" until the service restarted. The `turn/start` response
   * handler sends the deferred interrupt as soon as the id arrives.
   */
  abortedBeforeTurnId?: boolean;
  /** Ephemeral side threads reject `thread/read includeTurns`; an empty
   * streamed answer settles as empty instead of reading thread history. */
  ephemeral?: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  inactivityTimeout?: ReturnType<typeof setTimeout>;
  inactivityTimeoutDisabled?: boolean;
  abortCleanup?: () => void;
  resolve: (result: { text: string; usage?: AdapterUsage }) => void;
  reject: (error: Error) => void;
};

type ThreadContextUsage = {
  totalTokens: number;
  modelContextWindow: number;
};

type SideThread = { childGeneration: number; disposed: boolean; tools?: "inherited" };

/** Hidden user-role item appended to an ephemeral side fork, mirroring Codex's
 * native `/side` boundary: inherited history is reference material only. */
const CODEX_SIDE_BOUNDARY = [
  "Side conversation boundary.",
  "Everything before this boundary is inherited history from the parent thread. It is reference context only, not your current task.",
  "Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, goals, or requests from before this boundary. Only messages submitted after this boundary are active user instructions.",
  "You are a temporary side-conversation assistant, separate from the main thread. Answer the user's questions about it without disrupting the main thread.",
  "This side conversation is read-only: do not modify files, source, git state, configuration, or workspace state, and do not request escalated permissions. Do not use sub-agents, send files, schedule tasks, or message other agents.",
].join("\n\n");

type PendingCompaction = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  turnId?: string;
  timeout: ReturnType<typeof setTimeout>;
  /** Relative hard deadline armed at start; cleared by any terminal receipt. */
  ceiling?: ReturnType<typeof setTimeout>;
  childGeneration: number;
  startedAt: number;
  timedOut?: boolean;
  /** No terminal receipt by the ceiling: recycle this child when otherwise idle. */
  expired?: boolean;
};

type AppServerProtocolDiagnostic = {
  at: number;
  id?: number;
  method: string;
  threadId?: string;
  childGeneration: number;
  status?: "ok" | "error";
};

function isLogicalTelegramSessionId(sessionId: string): boolean {
  return isLogicalSessionId(sessionId);
}

export interface CodexToolItemEvent {
  toolName: string;
  toolInput?: unknown;
  toolUseId?: string;
  output?: string;
  truncated?: boolean;
  exitCode?: number; durationMs?: number;
  changes?: Array<{ path: string; diff: string }>;
  sources?: Array<{ url: string; title?: string }>;
  isError: boolean;
}

interface CodexAsyncUserInputRequest {
  requestId?: string;
  toolInput: {
    questions: unknown[];
  };
}

function extractCodexAsyncUserInputRequest(item: unknown): CodexAsyncUserInputRequest | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const record = item as Record<string, unknown>;
  if (
    record.type !== "agentMessage" ||
    record.delivery !== "async" ||
    !Array.isArray(record.questions) ||
    record.questions.length === 0
  ) {
    return null;
  }
  return {
    ...(typeof record.id === "string" && record.id ? { requestId: record.id } : {}),
    toolInput: { questions: record.questions },
  };
}

/**
 * Map a completed Codex app-server item to a tool event for the Lark run card.
 * Codex reports tool work as typed items (commandExecution / fileChange /
 * mcpToolCall / webSearch). Field names vary across Codex versions, so every
 * extraction is best-effort and guarded; unknown items return null.
 */
export function extractCodexToolItem(item: unknown): CodexToolItemEvent | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const rec = item as Record<string, unknown>;
  const type = typeof rec.type === "string" ? rec.type : "";
  const id = typeof rec.id === "string" ? rec.id : undefined;
  const str = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    return undefined;
  };
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  };
  const statusText = str("status");
  const resultRecord = rec.result && typeof rec.result === "object" ? rec.result as Record<string, unknown> : undefined;
  const isErrorStatus = ["failed", "error", "declined", "cancelled"].includes(statusText ?? "") || rec.isError === true || resultRecord?.isError === true || (rec.error !== undefined && rec.error !== null);
  const structuredOutput = (value: unknown): string | undefined => value !== undefined && value !== null ? typeof value === "string" ? value : JSON.stringify(value) : undefined;

  switch (type) {
    case "collabAgentToolCall": {
      const action = str("tool");
      const receivers = Array.isArray(rec.receiverThreadIds) ? rec.receiverThreadIds.filter((value): value is string => typeof value === "string") : [];
      return {
        toolName: "CodexAgent", ...(id ? { toolUseId: id } : {}),
        toolInput: { action, receiverThreadIds: receivers, description: [action, ...receivers].filter(Boolean).join(" · "),
          ...(str("prompt") ? { prompt: str("prompt") } : {}), ...(str("model") ? { model: str("model") } : {}),
          ...(str("reasoningEffort") ? { effort: str("reasoningEffort") } : {}) },
        ...boundedCodexAgentStates(rec.agentsStates), isError: isErrorStatus,
      };
    }
    case "commandExecution":
    case "command_execution": {
      const command = str("command", "cmd");
      const exitCode = num("exitCode", "exit_code");
      return {
        toolName: "Bash",
        ...(command !== undefined ? { toolInput: { command, ...(Array.isArray(rec.commandActions) ? { commandActions: rec.commandActions } : {}) } } : {}),
        ...(id ? { toolUseId: id } : {}),
        output: str("aggregatedOutput", "aggregated_output", "output", "stdout"),
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(num("durationMs", "duration_ms") === undefined ? {} : { durationMs: num("durationMs", "duration_ms") }),
        isError: isErrorStatus || (exitCode !== undefined && exitCode !== 0),
      };
    }
    case "fileChange":
    case "file_change": {
      const changes = Array.isArray(rec.changes) ? rec.changes.flatMap(value => {
        if (!value || typeof value !== "object") return [];
        const change = value as Record<string, unknown>;
        const kind = change.kind && typeof change.kind === "object" ? (change.kind as Record<string, unknown>).type : change.kind;
        return typeof change.path === "string" && typeof change.diff === "string" ? [{ path: change.path, diff: kind === "add" || kind === "delete" && change.diff !== "" ? wholeFilePatch(change.diff, kind) : change.diff }] : [];
      }) : [];
      const path = str("path", "file_path") ?? changes[0]?.path;
      return {
        toolName: "Edit",
        ...(path !== undefined ? { toolInput: { file_path: path } } : {}),
        ...(id ? { toolUseId: id } : {}),
        output: str("summary", "output"),
        ...(changes.length ? { changes } : {}),
        isError: isErrorStatus,
      };
    }
    case "mcpToolCall":
    case "mcp_tool_call": {
      const server = str("server");
      const tool = str("tool", "name");
      return {
        toolName: tool ? (server ? `${server}.${tool}` : tool) : "MCP tool",
        toolInput: rec.arguments ?? rec.input ?? undefined,
        ...(id ? { toolUseId: id } : {}),
        output: str("output", "result") ?? structuredOutput(rec.error ?? rec.result),
        isError: isErrorStatus,
      };
    }
    case "webSearch":
    case "web_search": {
      const query = str("query");
      return {
        toolName: "WebSearch",
        ...(query !== undefined ? { toolInput: { query, ...(rec.action ? { action: rec.action } : {}) } } : {}),
        ...(Array.isArray(rec.sources) ? { sources: rec.sources.flatMap(value => {
          if (!value || typeof value !== "object") return [];
          const source = value as Record<string, unknown>;
          return typeof source.url === "string" ? [{ url: source.url, ...(typeof source.title === "string" ? { title: source.title } : {}) }] : [];
        }) } : {}),
        ...(id ? { toolUseId: id } : {}),
        output: str("output", "result") ?? structuredOutput(rec.error ?? rec.result),
        isError: isErrorStatus,
      };
    }
    case "plan":
    case "update_plan": {
      // Codex's plan/checklist — render it like Claude's TodoWrite plan panel.
      const todos = codexPlanTodos(rec.plan ?? rec.steps ?? rec.items);
      if (!todos) {
        return null;
      }
      return {
        toolName: "TodoWrite",
        toolInput: { todos },
        ...(id ? { toolUseId: id } : {}),
        isError: false,
      };
    }
    default:
      return null;
  }
}

/**
 * Convert Codex plan steps (`[{step, status}]`, status pending/in_progress/
 * completed) into the TodoWrite todo shape the run card's plan panel renders.
 * Returns null when there is nothing usable. Field access is defensive because
 * Codex's payload shape varies across versions.
 */
export function codexPlanTodos(planValue: unknown): Array<{ content: string; status: string; activeForm: string }> | null {
  const arr = Array.isArray(planValue)
    ? planValue
    : (planValue && typeof planValue === "object" && Array.isArray((planValue as Record<string, unknown>).steps)
      ? (planValue as Record<string, unknown>).steps as unknown[]
      : undefined);
  if (!arr) {
    return null;
  }
  const todos = arr
    .map((entry) => {
      const step = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const content = typeof step.step === "string" ? step.step
        : typeof step.content === "string" ? step.content
        : typeof step.text === "string" ? step.text
        : "";
      const status = typeof step.status === "string" ? step.status : "pending";
      return { content: content.trim(), status, activeForm: content.trim() };
    })
    .filter((todo) => todo.content.length > 0);
  return todos.length > 0 ? todos : null;
}

function resolveTurnApprovalPolicy(approvalMode: ApprovalMode): AppServerApprovalPolicy {
  // Missing UI callbacks must never turn normal mode into automatic approval.
  // Native requests without an owner are explicitly declined by the adapter.
  return approvalMode === "normal" ? "on-request" : "never";
}

/** A ticket's model/effort rides turn/start (thread-scoped; verified against
 * Codex CLI 0.165.0 TurnStartParams). The shared app-server keeps the Bot's
 * `-c` defaults and is never restarted for an override. */
function codexTurnSettings(configured: { model?: string; effort?: string }, override: EngineOverride | undefined): { model?: string; effort?: string } {
  if (!override?.model && !override?.effort) return {};
  const { model, effort } = resolveEngineOverride("codex", configured, override);
  // turn/start cannot clear the child's configured effort for one thread.
  if (!override.effort && configured.effort && effort !== configured.effort) throw unsupportedEngineEffortError("codex", configured.effort, model);
  return { ...(override.model ? { model } : {}), ...(override.effort ? { effort } : {}) };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function readUsageNumber(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function readAdapterUsage(value: unknown): AdapterUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const inputTokens = readUsageNumber(usage, "inputTokens", "input_tokens", "promptTokens", "prompt_tokens");
  const outputTokens = readUsageNumber(usage, "outputTokens", "output_tokens", "completionTokens", "completion_tokens");
  const cachedTokens = readUsageNumber(usage, "cachedTokens", "cached_tokens", "cachedInputTokens", "cached_input_tokens");
  const costUsd = readUsageNumber(usage, "costUsd", "cost_usd");
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedTokens === undefined &&
    costUsd === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedTokens: cachedTokens ?? 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function readTurnUsage(value: unknown): AdapterUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const turn = value as Record<string, unknown>;
  return readAdapterUsage(turn.usage) ?? readAdapterUsage(turn);
}

function readTurnItems(value: unknown): { text: string; generatedImagePaths: string[] } {
  if (!Array.isArray(value)) {
    return { text: "", generatedImagePaths: [] };
  }

  const generatedImagePaths: string[] = [];
  let text = "";
  for (let index = value.length - 1; index >= 0; index--) {
    const item = value[index];
    const generatedImagePath = extractGeneratedImagePath(item);
    if (generatedImagePath && !generatedImagePaths.includes(generatedImagePath)) {
      generatedImagePaths.unshift(generatedImagePath);
    }
    if (
      !text &&
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "agentMessage" &&
      (item as { delivery?: unknown }).delivery !== "async" &&
      typeof (item as { text?: unknown }).text === "string" &&
      (item as { text: string }).text.trim()
    ) {
      text = (item as { text: string }).text;
    }
  }

  return { text, generatedImagePaths };
}

function readThreadGoal(value: unknown): CodexThreadGoal | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const goal = value as {
    threadId?: unknown;
    objective?: unknown;
    status?: unknown;
    tokenBudget?: unknown;
    tokensUsed?: unknown;
    timeUsedSeconds?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  if (
    typeof goal.threadId !== "string" ||
    typeof goal.objective !== "string" ||
    (goal.status !== "active" && goal.status !== "paused" && goal.status !== "blocked" && goal.status !== "usageLimited" && goal.status !== "budgetLimited" && goal.status !== "complete")
  ) {
    return null;
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: numberOrNull(goal.tokenBudget),
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
    timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : 0,
    createdAt: typeof goal.createdAt === "number" ? goal.createdAt : 0,
    updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt : 0,
  };
}

function readGoalResponse(value: unknown): CodexThreadGoalResponse {
  if (typeof value === "object" && value !== null && "goal" in value) {
    const raw = (value as { goal?: unknown }).goal;
    if (raw === null) return { goal: null };
    const goal = readThreadGoal(raw);
    if (goal) return { goal };
  }
  // Only a confirmed null means cleared. Unknown/new states must not erase a
  // goal or make a caller claim that no goal exists.
  throw new Error("Invalid Codex goal response");
}

/** An inactive goal is retained natively, but no longer pursues another turn. */
function isStoppedGoalStatus(status: CodexThreadGoal["status"]): boolean {
  return status !== "active";
}

/**
 * How often watchThreadGoal polls the goal status as a fallback. A long multi-turn goal
 * can miss the live terminal thread/goal/updated event, which would otherwise hang the
 * watch (and the caller's active-run slot) forever — the instance then looks permanently
 * "busy" and refuses to restart. Polling guarantees the watch resolves when the goal ends.
 */
const GOAL_WATCH_POLL_MS = 30_000;
export const CODEX_GOAL_FINAL_TURN_TIMEOUT_MS = 60_000;
type CodexGoalWatcher = {
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  /** Mode-gated exactly like PendingTurn.onApprovalRequest. */
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onUserInputRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  /** Closes the pursuit's open questions/approvals when it stops or ends. */
  interactionAbortController: AbortController;
  resolve: (goal: CodexThreadGoal | null) => void;
  reject: (error: Error) => void;
  latestGoal: CodexThreadGoal | null;
  /** Distinguish no state read yet from an authoritative clear. */
  hasGoalState?: boolean;
  acceptGoalEvents?: boolean;
  revision?: number;
  /** Serialize controls behind initial clear/set without holding the chat turn lock. */
  setupDone?: Promise<void>;
  refreshInFlight?: boolean;
  refreshPending?: boolean;
  activeTurnId?: string;
  finalTurnTimer?: ReturnType<typeof setTimeout>;
  finalText?: string;
  terminalDelivered?: boolean;
  stopping?: boolean;
};
/** The callbacks and lifetime an interactive server request is answered with. */
type InteractionOwner = Pick<PendingTurn, "onApprovalRequest" | "onUserInputRequest" | "onEngineEvent" | "interactionAbortController">;
/**
 * Server requests whose handlers can route to a goal owner. Replaying one is
 * safe: none of these handlers fails the thread's ordinary turn.
 */
const GOAL_OWNED_SERVER_REQUESTS = new Set([
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/commandExecution/requestApproval",
  "execCommandApproval",
  "item/fileChange/requestApproval",
  "applyPatchApproval",
]);
const GOAL_RPC_REQUEST_OPTIONS = {
  timeoutMs: CODEX_APP_SERVER_GOAL_RPC_TIMEOUT_MS,
  destroyOnTimeout: true,
} as const;
/**
 * The background goal poll shares the child with every concurrent turn, so a
 * single slow poll must never destroy it — destroyOnTimeout there would reject
 * ALL unrelated pending turns for one thread's laggy goal read, contradicting
 * the adapter's thread-scoped-failure policy. Interactive goal RPCs keep
 * GOAL_RPC_REQUEST_OPTIONS (an operator command on a wedged child must not
 * shadow-fail); the poll escalates to destroy only after
 * GOAL_POLL_TIMEOUTS_BEFORE_DESTROY consecutive timeouts, which indicates a
 * genuinely wedged child rather than momentary load.
 */
const GOAL_POLL_REQUEST_OPTIONS = {
  timeoutMs: CODEX_APP_SERVER_GOAL_RPC_TIMEOUT_MS,
  destroyOnTimeout: false,
} as const;
const GOAL_POLL_TIMEOUTS_BEFORE_DESTROY = 2;

function readClearedResponse(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    "cleared" in value &&
    (value as { cleared?: unknown }).cleared === true;
}

function normalizeExecutableCommand(command: string): string {
  const trimmed = command.trim();

  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function buildCommandInvocation(command: string, args: string[]): { command: string; args: string[]; shell?: boolean } {
  const normalizedCommand = normalizeExecutableCommand(command);
  if (process.platform === "win32") return { command: normalizedCommand, args, shell: false };

  if (/\.(cmd|bat)$/i.test(normalizedCommand)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", normalizedCommand, ...args],
    };
  }

  if (/\.ps1$/i.test(normalizedCommand)) {
    return {
      command: "pwsh",
      args: ["-NoProfile", "-File", normalizedCommand, ...args],
    };
  }

  return { command: normalizedCommand, args, shell: false };
}

function combineInstructions(primary: string | null, secondary: string | null): string | null {
  const parts = [primary?.trim(), secondary?.trim()].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function decodeProcessChunk(
  decoder: StringDecoder,
  chunk: Buffer | { toString(): string } | string,
): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk.toString();
}

export class CodexAppServerAdapter implements CodexAdapter {
  get turnRuntimeLimitMs(): number { return this.turnTimeoutMs; }
  readonly bridgeInstructionMode = "output-directory" as const;
  readonly supportsTurnScopedEnv = false;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnCodex: AppServerSpawnCodex;
  private readonly findWriterLockHolder: typeof findThreadWriterLockHolder;
  private readonly nativeSearchMcp?: NativeSearchMcpPlanner;
  /** Plan of the live child; its credential values are only in that child's env. */
  private searchPlan: { childGeneration: number; plan: NativeSearchMcpPlan } | null = null;
  private readonly searchThreadConfig = new Map<string, Promise<Record<string, unknown>>>();
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  /**
   * Approval mode of the running app-server, captured at spawn alongside
   * sandbox_mode. Turns only forward command approvals in "normal" mode; in
   * bypass (danger-full-access) and full-auto the user opted out of approvals, so
   * the turn runs with policy "never". Without this gate Codex asked even in yolo.
   */
  private currentApprovalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;
  private child: AppServerChildProcess | null = null;
  private initializePromise: Promise<void> | null = null;
  private initializeKey: string | null = null;
  private lineBuffer = "";
  private stderrTail = "";
  /** Cumulative chars ever appended to stderrTail (pre-trim), used as the
   * per-turn offset baseline for turn-scoped failure diagnostics. */
  private stderrSeenChars = 0;
  private stdoutDiagnosticTail = "";
  private childGeneration = 0;
  private readonly interactiveRequests = new Map<JsonRpcId, { threadId: string; controller: AbortController; resolved: boolean }>();
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly nonBlockingRequestIds = new Set<number>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  // Secondary index of the SAME PendingTurn objects, keyed by the engine turn id
  // once it is known. threadId alone is ambiguous: a self-running /goal pursuit and
  // an ordinary turn share one thread, and turn/item notifications carry a turnId
  // (required by the app-server schema for every item/* notification). Matching on
  // it keeps a goal's deltas/usage out of the user's turn, and lets a turn that no
  // longer owns its thread still settle with its own text and usage.
  private readonly pendingTurnsByTurnId = new Map<string, PendingTurn>();
  // Watchers for a self-running thread goal (no user-initiated turn). Codex pursues a
  // goal autonomously and emits the SAME turn/item notifications; when there is no
  // pendingTurn for the thread, events fall back to this watcher so a goal can drive a
  // live run card. Keyed by threadId. Normal turns are unaffected (pendingTurns wins).
  private readonly goalWatchers = new Map<string, CodexGoalWatcher>();
  private readonly loadedThreads = new Set<string>();
  // Ephemeral side forks. Never in loadedThreads: sendUserMessage must not
  // resume, adopt or bind them, and their turns never touch the parent thread.
  private readonly sideThreads = new Map<string, SideThread>();
  // Codex publishes the active context size separately from per-turn billing.
  // Keep it thread-scoped so a long-lived topic can compact before its next turn
  // instead of crossing the model limit and leaking an unrelated old answer.
  private readonly threadContextUsage = new Map<string, ThreadContextUsage>();
  private readonly pendingCompactions = new Map<string, PendingCompaction>();
  // Turn ids that belonged to compaction turns. A compaction can settle on
  // thread/compacted while its own turn/completed (or item/*) is still in the
  // server's write buffer; when that late line lands after the USER's turn/start
  // was written but before its id-correlated response, the un-id'd pending turn
  // would adopt the compaction's id and settle with the thread's PREVIOUS
  // answer via the empty-text thread/read fallback. Never adoptable.
  private readonly settledCompactionTurnIds = new Set<string>();
  private readonly retiredTurnIds = new Set<string>();
  private readonly settledTurnIds = new Set<string>();
  /** Pins the native owner while a failed turn's yielded commands are checked. */
  private readonly retryToolLeases = new Set<() => void>();
  /** Order of child-work evidence on this app-server stream. */
  private childWorkSeq = 0;
  /** Recent turn starts/completions of threads without a foreground turn here
   * (child agents), so a child that starts before its spawn call reports
   * completion is still attributed. Bounded; holds no content. */
  private readonly recentChildTurns = new Map<string, CodexChildTurn>();
  private readonly unresolvedTurnStarts = new Map<string, Set<PendingTurn>>();
  // Covers the whole sendUserMessage lifecycle, including thread resume,
  // preventive compaction, asynchronous session events, and final thread/read.
  // pendingTurns alone starts too late and is removed before final settlement.
  private readonly activeTurnEntries = new Set<string>();
  private completingTurns = 0;
  private readonly idleWaiters = new Set<() => void>();
  // Remembers the initializeKey whose pending config change we have already
  // warned about, so a deferred re-init logs ONCE per distinct change instead of
  // on every message that keeps hitting the busy child.
  private deferredConfigWarningKey: string | null = null;
  private lastRequestDiagnostic: AppServerProtocolDiagnostic | null = null;
  private lastResponseDiagnostic: AppServerProtocolDiagnostic | null = null;
  private lastNotificationDiagnostic: AppServerProtocolDiagnostic | null = null;
  private lastTurnActivityDiagnostic: AppServerProtocolDiagnostic | null = null;
  private deferredChildRecycle: { childGeneration: number; reason: string } | null = null;

  constructor(
    private readonly codexExecutable: string,
    private readonly cwd: string,
    childEnvOrSpawn?: NodeJS.ProcessEnv | AppServerSpawnCodex,
    spawnCodexArg?: AppServerSpawnCodex,
    instructionsPath?: string,
    private readonly engineHomePath?: string,
    configPath?: string,
    private readonly turnTimeoutMs: number = CODEX_APP_SERVER_TURN_TIMEOUT_MS,
    private readonly turnInactivityTimeoutMs: number | null = CODEX_APP_SERVER_INACTIVITY_TIMEOUT_MS,
    private readonly threadReadTimeoutMs: number = CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS,
    dependencies: Partial<AppServerDependencies> = {},
  ) {
    const buildChildEnv = () => {
      const env = { ...process.env };
      delete env.TELEGRAM_BOT_TOKEN;
      if (engineHomePath) {
        env.CODEX_HOME = engineHomePath;
      }
      // Otherwise inherit CODEX_HOME from the parent env so bots track the
      // same config dir the user's main Codex CLI uses. Unset → ~/.codex/.
      return env;
    };

    this.childEnv =
      typeof childEnvOrSpawn === "function"
        ? buildChildEnv()
        : childEnvOrSpawn ?? buildChildEnv();

    this.spawnCodex =
      typeof childEnvOrSpawn === "function"
        ? childEnvOrSpawn
        : spawnCodexArg ?? (spawnEngine as unknown as AppServerSpawnCodex);
    this.findWriterLockHolder = dependencies.findThreadWriterLockHolder ?? findThreadWriterLockHolder;
    this.nativeSearchMcp = dependencies.nativeSearchMcp;
    this.instructionsPath = instructionsPath;
    this.configPath = configPath;
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `tarobot-${chatId}` };
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const runtimeOptions = await this.loadRuntimeOptions();
    const turnSettings = codexTurnSettings(runtimeOptions, input.engineOverride);
    await this.ensureInitialized(runtimeOptions);

    const personaInstructions = this.instructionsPath ? await this.loadInstructions() : null;
    const instructions = combineInstructions(
      personaInstructions,
      input.instructions ?? null,
    );
    const cwd = input.workspaceOverride ?? this.cwd;
    let writerRecoveryAttempted = false;

    while (true) {
      const reservations = new Set<string>();
      const releaseReservations = (): void => {
        for (const reservation of reservations) {
          this.activeTurnEntries.delete(reservation);
        }
        reservations.clear();
        this.notifyIdleWaitersIfIdle();
      };
      const reserve = (key: string): void => {
        if (reservations.has(key)) {
          return;
        }
        if (this.activeTurnEntries.has(key) || this.pendingTurns.has(key)) {
          throw new Error(`Codex thread ${key} already has an in-flight turn`);
        }
        this.activeTurnEntries.add(key);
        reservations.add(key);
      };
      reserve(sessionId);
      let threadId = sessionId;
      try {
        const resolvedThreadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, cwd, input.appPlatformTools);
        reserve(resolvedThreadId);
        threadId = await this.prepareThreadForTurn(resolvedThreadId, cwd, input.appPlatformTools, input.onEngineEvent, input.abortSignal);
        reserve(threadId);
        // Announce the thread BEFORE the turn can fail. Every other adapter emits a
        // mid-turn `session` event that Bridge.handleAuthorizedTurn binds on; the
        // app-server adapter only reported its thread id through a SUCCESSFUL
        // response, so a /stop or a timeout on the first turn of an unbound chat
        // (new chat, after /reset, or after a `thread not found` → startThread)
        // discarded the new thread id and the next message silently started over.
        // Mirrors process-adapter.ts:140.
        await this.emitSessionEvent(threadId, input.onEngineEvent);
        const suppliedTools = input.appPlatformTools;
        const appTools = suppliedTools?.forSession ? await suppliedTools.forSession(threadId)
          : suppliedTools && await suppliedTools.isRegistered(threadId) ? suppliedTools : undefined;
        const appInstructions = input.appPlatformTools ? combineInstructions(
          personaInstructions,
          appTools?.instructions ?? input.instructions ?? null,
        ) : null;
        // App context is a protocol field, not a synthetic user message. This
        // keeps platform/persona prose out of the first-message session title.
        const prompt = input.appPlatformTools
          ? this.buildPrompt({ ...input, turnInstructions: undefined }, null)
          : this.buildPrompt(input, instructions);
        const turn = await this.startTurn(
          threadId,
          prompt,
          input.onProgress,
          input.onEngineEvent,
          // A config change may be deferred while the shared child is busy. Gate
          // approvals with the mode that actually spawned the running child, not
          // the newly-read config, so policy and sandbox never become half-applied.
          this.currentApprovalMode,
          input.onApprovalRequest,
          input.abortSignal,
          input.disableRuntimeTimeout ? null : this.turnTimeoutMs,
          appTools,
          input.appPlatformTools ? [appInstructions, appTools ? appTools.turnInstructions : input.turnInstructions].filter(Boolean).join("\n\n") : undefined,
          false,
          [],
          turnSettings,
          suppliedTools?.executionInstructions,
        );

        return {
          text: turn.text.trim() || `Session ${threadId} completed.`,
          sessionId: threadId !== sessionId ? threadId : undefined,
          usage: turn.usage,
        };
      } catch (error) {
        if (
          !writerRecoveryAttempted
          && error instanceof CodexActiveWriterConflictError
          && error.isOwnChild
        ) {
          writerRecoveryAttempted = true;
          releaseReservations();
          if (error.childGeneration !== this.childGeneration) {
            await this.ensureInitialized(runtimeOptions);
            continue;
          }
          if (this.isIdle()) {
            this.destroy(error.childGeneration, "Recycling Codex app-server after its own writer lock leaked");
            await this.ensureInitialized(runtimeOptions);
            continue;
          }
          this.deferChildRecycle(
            error.childGeneration,
            "Recycling Codex app-server after its own writer lock leaked",
          );
        }
        throw error;
      } finally {
        releaseReservations();
      }
    }
  }

  async getThreadGoal(sessionId: string, input: { workspaceOverride?: string } = {}): Promise<CodexThreadGoalResponse> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);
    const threadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, input.workspaceOverride ?? this.cwd);
    await this.waitForGoalSetup(threadId);
    const watcher = this.goalWatchers.get(threadId);
    const revision = watcher?.revision;
    const result = await this.request("thread/goal/get", { threadId }, GOAL_RPC_REQUEST_OPTIONS);
    const response = readGoalResponse(result);
    if (watcher && this.goalWatchers.get(threadId) === watcher && watcher.revision === revision) {
      this.observeGoalState(threadId, watcher, response.goal);
    }
    return {
      ...response,
      sessionId: threadId !== sessionId ? threadId : undefined,
    };
  }

  async setThreadGoal(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);
    const threadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, input.workspaceOverride ?? this.cwd);
    this.assertNoCompaction(threadId);
    if (this.goalWatchers.has(threadId)) throw new Error("A Codex goal observer is already active for this thread");
    await this.request("thread/goal/clear", { threadId, origin: "user" }, GOAL_RPC_REQUEST_OPTIONS);
    const result = await this.request("thread/goal/set", {
      threadId,
      origin: "user",
      status: "active",
      objective: input.objective,
      tokenBudget: input.tokenBudget ?? null,
    }, GOAL_RPC_REQUEST_OPTIONS);
    return {
      ...readGoalResponse(result),
      sessionId: threadId !== sessionId ? threadId : undefined,
    };
  }

  /** Patches the native goal; never clears its identity, status or usage implicitly. */
  async updateThreadGoal(sessionId: string, input: {
    objective?: string;
    status?: CodexThreadGoal["status"];
    tokenBudget?: number | null;
    workspaceOverride?: string;
    origin?: "user" | "automatic";
    isCurrentSession?: () => boolean | Promise<boolean>;
  }): Promise<CodexThreadGoalResponse> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);
    const threadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, input.workspaceOverride ?? this.cwd);
    this.assertNoCompaction(threadId);
    await this.waitForGoalSetup(threadId);
    await this.assertCurrentGoalSession(sessionId, threadId, input.isCurrentSession);
    const watcher = this.goalWatchers.get(threadId);
    const revision = watcher?.revision;
    const result = await this.request("thread/goal/set", {
      threadId, origin: input.origin ?? "user",
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    }, GOAL_RPC_REQUEST_OPTIONS);
    const response = readGoalResponse(result);
    if (watcher && this.goalWatchers.get(threadId) === watcher && watcher.revision === revision) {
      this.observeGoalState(threadId, watcher, response.goal);
    }
    return { ...response, sessionId: threadId !== sessionId ? threadId : undefined };
  }

  private async assertCurrentGoalSession(sessionId: string, threadId: string, check?: () => boolean | Promise<boolean>): Promise<void> {
    if (check && (threadId !== sessionId || !await check())) throw new Error("Codex goal session binding changed");
  }

  private async waitForGoalSetup(threadId: string): Promise<void> {
    let watcher = this.goalWatchers.get(threadId);
    while (watcher?.setupDone) {
      await watcher.setupDone;
      const current = this.goalWatchers.get(threadId);
      if (current === watcher) return;
      watcher = current;
    }
  }

  /** Register before the native mutation so autonomous events cannot outrun the
   * observer. Resume/observe preserve native identity, objective and accounting. */
  async watchThreadGoal(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    mode?: "replace" | "resume" | "observe";
    isCurrentSession?: () => boolean | Promise<boolean>;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    abortSignal?: AbortSignal;
  }): Promise<CodexThreadGoalResponse> {
    input.abortSignal?.throwIfAborted();
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);
    input.abortSignal?.throwIfAborted();
    const threadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, input.workspaceOverride ?? this.cwd);
    await this.assertCurrentGoalSession(sessionId, threadId, input.isCurrentSession);
    input.abortSignal?.throwIfAborted();
    this.assertNoCompaction(threadId);
    if (this.goalWatchers.has(threadId)) throw new Error("A Codex goal observer is already active for this thread");

    let resolveTerminal!: (goal: CodexThreadGoal | null) => void;
    let rejectTerminal!: (error: Error) => void;
    const terminal = new Promise<CodexThreadGoal | null>((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
    void terminal.catch(() => {});
    let resolveSetup!: () => void;
    let rejectSetup!: (error: unknown) => void;
    const setupDone = new Promise<void>((resolve, reject) => { resolveSetup = resolve; rejectSetup = reject; });
    void setupDone.catch(() => {});
    const interactions = new AbortController();
    const watcher: CodexGoalWatcher = {
      onEngineEvent: input.onEngineEvent,
      onApprovalRequest: this.currentApprovalMode === "normal" ? input.onApprovalRequest : undefined,
      onUserInputRequest: input.onApprovalRequest,
      interactionAbortController: interactions,
      resolve: (goal) => { interactions.abort(); resolveTerminal(goal); },
      reject: (error) => { interactions.abort(); rejectTerminal(error); },
      latestGoal: null, hasGoalState: false, acceptGoalEvents: false, revision: 0, setupDone,
    };
    this.goalWatchers.set(threadId, watcher);
    const onAbort = () => watcher.resolve(watcher.latestGoal);
    if (input.abortSignal) {
      if (input.abortSignal.aborted) onAbort();
      else input.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let goalSetStarted = false;
    try {
      await input.onEngineEvent?.({ type: "session", sessionId: threadId });
      if (input.abortSignal?.aborted) return { goal: null, sessionId: threadId };
      await this.assertCurrentGoalSession(sessionId, threadId, input.isCurrentSession);
      input.abortSignal?.throwIfAborted();
      const mode = input.mode ?? "replace";
      if (mode === "replace") {
        // This clear belongs to setup, not to the new pursuit. Its notification
        // must not resolve the observer before the replacement is even set.
        await this.request("thread/goal/clear", { threadId, origin: "user" }, GOAL_RPC_REQUEST_OPTIONS);
        if (input.abortSignal?.aborted) return { goal: null, sessionId: threadId };
      }
      await this.assertCurrentGoalSession(sessionId, threadId, input.isCurrentSession);
      input.abortSignal?.throwIfAborted();
      watcher.acceptGoalEvents = true;
      const revision = watcher.revision;
      goalSetStarted = mode !== "observe";
      const initialResponse = mode === "observe"
        ? await this.request("thread/goal/get", { threadId }, GOAL_RPC_REQUEST_OPTIONS)
        : await this.request("thread/goal/set", {
          threadId, origin: "user",
          ...(mode === "resume"
            ? { status: "active", ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}) }
            : { objective: input.objective, tokenBudget: input.tokenBudget ?? null, status: "active" }),
        }, GOAL_RPC_REQUEST_OPTIONS);
      const initialGoal = readGoalResponse(initialResponse).goal;
      if (watcher.revision === revision) this.observeGoalState(threadId, watcher, initialGoal);
      resolveSetup();

      let consecutivePollTimeouts = 0;
      let polling = false;
      pollTimer = setInterval(() => {
        if (polling || watcher.terminalDelivered || this.goalWatchers.get(threadId) !== watcher) return;
        polling = true;
        const revision = watcher.revision;
        void this.request("thread/goal/get", { threadId }, GOAL_POLL_REQUEST_OPTIONS)
          .then((response) => {
            if (this.goalWatchers.get(threadId) !== watcher || watcher.terminalDelivered) return;
            consecutivePollTimeouts = 0;
            const goal = readGoalResponse(response).goal;
            // A response to an older read cannot replace a newer live event.
            if (watcher.revision === revision) this.observeGoalState(threadId, watcher, goal);
          })
          .catch((error) => {
            if (this.goalWatchers.get(threadId) !== watcher || watcher.terminalDelivered) return;
            if (!(error instanceof CodexAppServerRequestTimeoutError)) {
              watcher.reject(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            consecutivePollTimeouts += 1;
            if (consecutivePollTimeouts >= GOAL_POLL_TIMEOUTS_BEFORE_DESTROY) this.destroy(error.childGeneration);
          }).finally(() => { polling = false; });
      }, GOAL_WATCH_POLL_MS);
      pollTimer.unref?.();
      const finalGoal = await terminal;
      return { goal: finalGoal, sessionId: threadId !== sessionId ? threadId : undefined };
    } catch (error) {
      rejectSetup(error);
      throw error;
    } finally {
      resolveSetup();
      if (pollTimer) clearInterval(pollTimer);
      interactions.abort();
      if (watcher.finalTurnTimer) clearTimeout(watcher.finalTurnTimer);
      try {
        // Stop only this observer's exact autonomous turn. Automatic teardown is
        // not a new user goal mutation and must not manufacture user provenance.
        if (goalSetStarted && input.abortSignal?.aborted && this.goalWatchers.get(threadId) === watcher) {
          // Setup may have failed after the native mutation. Cleanup already
          // owns this exact thread and must not await its rejected setup barrier
          // or resolve the old session into a different fallback thread.
          await this.clearResolvedThreadGoal(threadId, "automatic");
        }
      } finally {
        if (watcher.activeTurnId) this.rememberRetiredTurn(threadId, watcher.activeTurnId);
        if (this.goalWatchers.get(threadId) === watcher) this.goalWatchers.delete(threadId);
        input.abortSignal?.removeEventListener("abort", onAbort);
        this.notifyIdleWaitersIfIdle();
      }
    }
  }

  private observeGoalState(threadId: string, watcher: CodexGoalWatcher, goal: CodexThreadGoal | null): void {
    if (watcher.terminalDelivered) return;
    watcher.latestGoal = goal;
    watcher.hasGoalState = true;
    watcher.revision = (watcher.revision ?? 0) + 1;
    this.settleGoalAfterFinalTurn(threadId, watcher);
  }

  private refreshGoalState(threadId: string, watcher: CodexGoalWatcher): void {
    // Mutation replies precede ordered notifications. A prior pause/complete/
    // clear can arrive after a replacement or resume, and even a turn ID does
    // not identify the current goal revision. Confirm transitions against the
    // native state. Coalesce bursts, and read again only for an intervening event.
    watcher.revision = (watcher.revision ?? 0) + 1;
    watcher.refreshPending = true;
    if (watcher.refreshInFlight) return;
    watcher.refreshInFlight = true;
    const current = () => this.goalWatchers.get(threadId) === watcher && !watcher.terminalDelivered;
    void (async () => {
      await watcher.setupDone;
      while (watcher.refreshPending && current()) {
        watcher.refreshPending = false;
        const revision = watcher.revision;
        const result = await this.request("thread/goal/get", { threadId }, GOAL_POLL_REQUEST_OPTIONS);
        if (!current()) return;
        if (watcher.revision === revision) this.observeGoalState(threadId, watcher, readGoalResponse(result).goal);
      }
    })().catch(error => {
      if (current()) watcher.reject(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      watcher.refreshInFlight = false;
      // A notification can arrive after the loop exits but before this finally.
      if (watcher.refreshPending && current()) this.refreshGoalState(threadId, watcher);
    });
  }

  private settleGoalAfterFinalTurn(threadId: string, watcher: CodexGoalWatcher): void {
    const finalAnswerExpected = watcher.latestGoal?.status === "complete" || watcher.latestGoal?.status === "budgetLimited";
    if (!finalAnswerExpected && watcher.finalTurnTimer) {
      clearTimeout(watcher.finalTurnTimer); watcher.finalTurnTimer = undefined;
    }
    if (!watcher.hasGoalState || (watcher.latestGoal && !isStoppedGoalStatus(watcher.latestGoal.status))) {
      if (watcher.finalTurnTimer) { clearTimeout(watcher.finalTurnTimer); watcher.finalTurnTimer = undefined; }
      return;
    }
    if (!watcher.activeTurnId) {
      if (watcher.terminalDelivered) return;
      watcher.terminalDelivered = true;
      if (watcher.finalText?.trim()) this.emitEngineEvent(threadId, { type: "result", text: watcher.finalText, sessionId: threadId }, null);
      watcher.resolve(watcher.latestGoal);
    } else if (!watcher.finalTurnTimer && finalAnswerExpected) {
      // Pause/clear stop future pursuit but let an existing native turn drain,
      // matching native CLI semantics; they do not impose a new turn deadline.
      // Native update_goal(complete) can precede the assistant's final answer.
      // Keep streaming until that owned turn ends, with a bounded failure path
      // if its completion notification never arrives.
      watcher.finalTurnTimer = setTimeout(() => {
        this.interruptTurn(threadId, watcher.activeTurnId);
        watcher.reject(new Error("Codex goal ended but its final native turn did not finish in time"));
      }, CODEX_GOAL_FINAL_TURN_TIMEOUT_MS);
      watcher.finalTurnTimer.unref?.();
    }
  }

  async clearThreadGoal(sessionId: string, input: { workspaceOverride?: string; origin?: "user" | "automatic"; isCurrentSession?: () => boolean | Promise<boolean> } = {}): Promise<{ cleared: boolean; sessionId?: string }> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);
    const threadId = await this.resolveThreadForMessageWithRetry(sessionId, runtimeOptions, input.workspaceOverride ?? this.cwd);
    await this.waitForGoalSetup(threadId);
    await this.assertCurrentGoalSession(sessionId, threadId, input.isCurrentSession);
    const cleared = await this.clearResolvedThreadGoal(threadId, input.origin ?? "user");
    return { cleared, sessionId: threadId !== sessionId ? threadId : undefined };
  }

  /** Caller has established ownership and setup ordering for this exact thread. */
  private async clearResolvedThreadGoal(threadId: string, origin: "user" | "automatic"): Promise<boolean> {
    const watcher = this.goalWatchers.get(threadId);
    if (watcher) {
      watcher.stopping = true;
      watcher.interactionAbortController.abort();
    }
    let result: unknown;
    try {
      result = await this.request("thread/goal/clear", { threadId, origin }, GOAL_RPC_REQUEST_OPTIONS);
    } finally {
      // Send even if clear fails: a stop request must still reach its owned
      // native turn. Completed turns remove their ID before this continuation.
      if (watcher) this.interruptTurn(threadId, watcher.activeTurnId);
    }
    // The clear RPC confirms absence even when the notification was missed.
    // Never return the previous active goal from a successful clear.
    if (watcher) {
      watcher.latestGoal = null;
      watcher.hasGoalState = true;
      watcher.resolve(null);
    }
    return readClearedResponse(result);
  }

  async validateExternalSession(sessionId: string): Promise<void> {
    const runtimeOptions = await this.loadRuntimeOptions();
    await this.ensureInitialized(runtimeOptions);

    if (isLogicalTelegramSessionId(sessionId)) {
      return;
    }

    await this.retryThreadReadAfterTimeout(() => this.ensureThreadLoaded(sessionId), runtimeOptions);
  }

  private async loadRuntimeOptions(): Promise<{
    approvalMode: ApprovalMode;
    effort?: string;
    model?: string;
    codexServiceTier?: "fast";
    initializeArgs: string[];
    initializeKey: string;
  }> {
    if (!this.configPath) {
      return {
        approvalMode: "normal",
        initializeArgs: ["app-server"],
        initializeKey: JSON.stringify({ approvalMode: "normal" }),
      };
    }

    const parsed = await readValidatedConfigFile(this.configPath, { forExecution: true });
    const approvalMode: ApprovalMode = normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE;
    const effort = typeof parsed.effort === "string" ? parsed.effort : undefined;
    const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
    const codexServiceTier = parsed.codexServiceTier === "fast" ? "fast" : undefined;
    const initializeArgs = ["app-server"];

    if (approvalMode === "bypass") {
      initializeArgs.push("-c", 'sandbox_mode="danger-full-access"');
    } else {
      initializeArgs.push("-c", 'sandbox_mode="workspace-write"');
    }

    if (effort) {
      initializeArgs.push("-c", `model_reasoning_effort="${effort}"`);
    }

    if (model) {
      initializeArgs.push("-c", `model="${model}"`);
    }

    if (codexServiceTier === "fast") {
      initializeArgs.push("--enable", "fast_mode", "-c", 'service_tier="fast"');
    }

    return {
      approvalMode,
      effort,
      model,
      codexServiceTier,
      initializeArgs,
      initializeKey: JSON.stringify({ approvalMode, effort, model, codexServiceTier }),
    };
  }

  private async loadInstructions(): Promise<string | null> {
    if (!this.instructionsPath) {
      return null;
    }

    try {
      const content = await readFile(this.instructionsPath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) {
        return null;
      }

      if (trimmed.length <= MAX_INSTRUCTIONS_CHARS) {
        return trimmed;
      }

      return `${trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[Instructions truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`;
    } catch {
      return null;
    }
  }

  private buildPrompt(input: CodexUserMessageInput, instructions: string | null): string {
    const parts: string[] = [];

    if (instructions) {
      parts.push(`[System Instructions]\n${instructions}\n[End Instructions]`);
    }

    parts.push(prependPrivateTurnInstructions(input.text, input.turnInstructions));
    for (const file of input.files) {
      parts.push(`Attachment: ${file}`);
    }
    return parts.join("\n");
  }

  private async ensureInitialized(runtimeOptions: {
    approvalMode: ApprovalMode;
    initializeArgs: string[];
    initializeKey: string;
  }): Promise<void> {
    let deferredConfigChange = false;
    if (this.initializeKey !== null && this.initializeKey !== runtimeOptions.initializeKey) {
      if (!this.isIdle() && this.initializePromise) {
        if (this.currentApprovalMode !== runtimeOptions.approvalMode) throw new Error("Codex approval mode changed while busy; wait for active/background tasks to finish before starting another turn");
        if (this.deferredConfigWarningKey !== runtimeOptions.initializeKey) {
          this.deferredConfigWarningKey = runtimeOptions.initializeKey;
          console.error(
            `Codex app-server config change deferred while busy; continuing on the old config until idle${
              this.goalWatchers.size > 0 ? "; a /goal pursuit is holding the session" : ""
            }`,
          );
        }
        deferredConfigChange = true;
      } else {
        try {
          await this.waitForIdle();
          if (this.initializeKey !== null && this.initializeKey !== runtimeOptions.initializeKey) {
            this.destroy();
          }
        } catch (error) {
          if (this.initializePromise) {
            if (this.deferredConfigWarningKey !== runtimeOptions.initializeKey) {
              this.deferredConfigWarningKey = runtimeOptions.initializeKey;
              console.error(
                `Codex app-server config change deferred while busy; continuing on the old config until idle${
                  this.goalWatchers.size > 0 ? "; a /goal pursuit is holding the session" : ""
                }): ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            deferredConfigChange = true;
          }
        }
      }
    }
    // The pending change was applied (or there was nothing to defer): clear the
    // one-shot warning latch so a future deferral logs again.
    if (!deferredConfigChange) {
      this.deferredConfigWarningKey = null;
    }

    if (!this.initializePromise) {
      this.currentApprovalMode = runtimeOptions.approvalMode;
      this.initializeKey = runtimeOptions.initializeKey;
      // A rejected initialize must NOT be sticky. An `initialize` JSON-RPC *error*
      // response (as opposed to a timeout) leaves the child alive, so neither the
      // close nor the error handler fires and nothing resets the cached promise —
      // every later message then re-awaited the same rejection forever. Tear the
      // child down and clear the cached promise so the next call spawns a fresh
      // one; a timeout already destroyed itself, in which case this is a no-op.
      const attempt: Promise<void> = this.startChildAndInitialize(runtimeOptions.initializeArgs).catch((error) => {
        if (this.initializePromise === attempt) {
          this.destroy();
        }
        throw error;
      });
      this.initializePromise = attempt;
    }

    return this.initializePromise;
  }

  private async startChildAndInitialize(appServerArgs: string[]): Promise<void> {
    const invocation = buildCommandInvocation(this.codexExecutable, appServerArgs);
    let searchPlan: NativeSearchMcpPlan | null = null;
    try { searchPlan = this.nativeSearchMcp?.() ?? null; } catch { searchPlan = null; }
    const child = this.spawnCodex(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      // Codex passes these to the managed MCP by name (env_vars); never argv.
      env: searchPlan && Object.keys(searchPlan.processEnv).length > 0 ? { ...this.childEnv, ...searchPlan.processEnv } : this.childEnv,
      cwd: this.cwd,
      windowsHide: true,
    });

    this.child = child;
    const childGeneration = ++this.childGeneration;
    this.searchPlan = searchPlan ? { childGeneration, plan: searchPlan } : null;
    this.searchThreadConfig.clear();
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    // Generation-guard the data handlers exactly like close/error below: a
    // destroyed child gets SIGTERM with a grace period, so it can still flush
    // buffered output after its replacement spawned. Without the guard those
    // stale chunks land in the NEW generation's shared line buffer and
    // thread-keyed state — corrupting JSON framing, settling fresh turns with
    // stale turn/* notifications (the retry path re-resumes the same
    // threadId), and answering stale approval requests on the new child's stdin.
    child.stdout?.on("data", (chunk) => {
      if (childGeneration !== this.childGeneration) {
        return;
      }
      this.handleStdout(decodeProcessChunk(stdoutDecoder, chunk));
    });

    child.stderr?.on("data", (chunk) => {
      if (childGeneration !== this.childGeneration) {
        return;
      }
      // App-server emits JSON-RPC over stdout. Keep a bounded stderr tail so
      // stalled-turn errors carry the underlying runtime context.
      this.appendDiagnostic("stderr", decodeProcessChunk(stderrDecoder, chunk));
    });

    child.stdin?.on?.("error", (error) => {
      if (childGeneration !== this.childGeneration) {
        return;
      }
      this.failAllPending(this.withDiagnostics(error.message));
      this.terminateChild();
      this.resetChildState();
    });

    child.once("error", (error) => {
      if (childGeneration !== this.childGeneration) {
        return;
      }
      this.failAllPending(this.withDiagnostics(error instanceof Error ? error.message : String(error)));
      this.resetChildState();
    });

    child.once("close", (code) => {
      if (childGeneration !== this.childGeneration) {
        return;
      }
      const trailingStdout = stdoutDecoder.end();
      // JSON-RPC is line-delimited, but process exit is also a valid record
      // boundary. Do not lose a final response that omitted its newline.
      this.handleStdout(`${trailingStdout}\n`);
      const trailingStderr = stderrDecoder.end();
      if (trailingStderr) {
        this.appendDiagnostic("stderr", trailingStderr);
      }
      this.failAllPending(this.withDiagnostics(`codex app-server exited with code ${code}`));
      this.resetChildState();
    });

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "tarocub",
          title: "TaroCub",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      },
      {
        timeoutMs: CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
        timeoutMessage: `Codex app-server initialize timed out after ${Math.max(1, Math.round(CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS / 1000))} seconds`,
        destroyOnTimeout: true,
      },
    );
  }

  private handleStdout(chunk: string): void {
    this.lineBuffer += chunk;

    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      if (line.length > MAX_LINE_BUFFER_BYTES && !this.looksLikeJsonRpcLine(line)) {
        this.appendOversizedStdoutDiagnostic(line);
        continue;
      }
      if (this.bufferUnidentifiedTurnLine(line)) {
        continue;
      }
      this.handleMessage(line);
    }

    if (this.lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
      if (this.looksLikeJsonRpcLine(this.lineBuffer)) {
        if (this.lineBuffer.length > MAX_PROTOCOL_LINE_BUFFER_BYTES) {
          this.failAllPending(this.withDiagnostics("Codex app-server JSON-RPC output exceeded maximum buffer size"));
          this.terminateChild();
          this.resetChildState();
        }
        return;
      }
      this.appendOversizedStdoutDiagnostic(this.lineBuffer);
      this.lineBuffer = "";
    }
  }

  private handleMessage(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.appendDiagnostic("stdout", line);
      return;
    }

    if ((typeof parsed.id === "number" || typeof parsed.id === "string") && typeof parsed.method === "string") {
      const threadId = this.readString(parsed.params?.threadId), turnId = this.readTurnIdFromParams(parsed.params);
      if (threadId && turnId && this.retiredTurnIds.has(`${threadId}:${turnId}`)) {
        this.settleUnmatchedBufferedServerRequest(parsed, "Codex turn already stopped");
        return;
      }
      if (threadId && turnId && this.settledTurnIds.has(`${threadId}:${turnId}`)) {
        // Preserve the App tool's explicit non-delivery receipt after the
        // authorized turn ended; the settled ID can never match a new owner.
        if (parsed.method === "item/tool/call") void this.handleAppToolRequest(parsed as AppServerRequest);
        else this.settleUnmatchedBufferedServerRequest(parsed, "Codex turn already completed");
        return;
      }
      this.handleServerRequest(parsed as AppServerRequest);
      return;
    }

    if (typeof parsed.id === "number") {
      const pending = this.pendingRequests.get(parsed.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(parsed.id);
      this.lastResponseDiagnostic = {
        at: Date.now(),
        id: parsed.id,
        method: pending.method,
        threadId: pending.threadId ?? this.readThreadIdFromResult(parsed.result),
        childGeneration: pending.childGeneration,
        status: parsed.error ? "error" : "ok",
      };
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message ?? "Unknown app-server error"));
      } else {
        pending.resolve(parsed.result);
      }
      this.notifyIdleWaitersIfIdle();
      return;
    }

    if (typeof parsed.method === "string") {
      this.recordNotificationDiagnostic(parsed.method, parsed.params);
      // Any thread-scoped notification proves the turn is alive (item starts,
      // command-output deltas, ...), not just the explicitly handled methods —
      // otherwise a quiet long tool execution trips the inactivity watchdog.
      const notificationThreadId = this.readString(parsed.params?.threadId);
      const notificationTurnId = this.readTurnIdFromParams(parsed.params);
      if (notificationThreadId && notificationTurnId && this.retiredTurnIds.has(`${notificationThreadId}:${notificationTurnId}`)) return;
      if (notificationThreadId && notificationTurnId && this.settledTurnIds.has(`${notificationThreadId}:${notificationTurnId}`)) return;
      if (notificationThreadId) {
        this.noteTurnActivity(notificationThreadId, parsed.method);
        const watcher = this.goalWatchers.get(notificationThreadId);
        if (watcher?.activeTurnId === notificationTurnId && watcher.finalTurnTimer) {
          clearTimeout(watcher.finalTurnTimer);
          watcher.finalTurnTimer = undefined;
          this.settleGoalAfterFinalTurn(notificationThreadId, watcher);
        }
      }
    }

    if (parsed.method === "serverRequest/resolved") {
      const id = parsed.params?.requestId;
      const active = typeof id === "string" || typeof id === "number" ? this.interactiveRequests.get(id) : undefined;
      if (active && active.threadId === parsed.params?.threadId) {
        active.resolved = true;
        active.controller.abort();
      }
      return;
    }

    if (parsed.method === "thread/tokenUsage/updated") {
      const threadId = this.readString(parsed.params?.threadId);
      const tokenUsage = parsed.params?.tokenUsage;
      if (threadId && typeof tokenUsage === "object" && tokenUsage !== null) {
        const usage = tokenUsage as Record<string, unknown>;
        const last = typeof usage.last === "object" && usage.last !== null
          ? usage.last as Record<string, unknown>
          : undefined;
        const totalTokens = last ? readUsageNumber(last, "totalTokens", "total_tokens") : undefined;
        const modelContextWindow = readUsageNumber(usage, "modelContextWindow", "model_context_window");
        if (
          totalTokens !== undefined
          && modelContextWindow !== undefined
          && totalTokens >= 0
          && modelContextWindow > 0
        ) {
          this.threadContextUsage.set(threadId, { totalTokens, modelContextWindow });
        }

        // Usage is thread telemetry: on resume Codex replays the previous
        // turn's usage while the new turn/start response is still in flight.
        // Never let it assign that stale turn id to the waiting turn.
        const pending = this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId), { adopt: false });
        if (pending && last) {
          pending.usage = readAdapterUsage(last) ?? pending.usage;
        }
      }
      return;
    }

    if (parsed.method === "thread/compacted") {
      const threadId = this.readString(parsed.params?.threadId);
      const turnId = this.readString(parsed.params?.turnId);
      const pending = threadId ? this.pendingCompactions.get(threadId) : undefined;
      if (threadId && pending && (!pending.turnId || !turnId || pending.turnId === turnId)) {
        this.settleCompaction(threadId);
      }
      return;
    }

    if (parsed.method === "turn/started" || parsed.method === "turn/completed") {
      this.observeChildTurn(parsed.method, this.readString(parsed.params?.threadId), this.readTurnIdFromParams(parsed.params));
    }

    if (parsed.method === "turn/started") {
      // Capture the turn id so an abort/inactivity interrupt can address it.
      const threadId = this.readString(parsed.params?.threadId);
      const pending = threadId ? this.pendingTurns.get(threadId) : undefined;
      // With a /goal pursuit running on this thread, turn/started may belong to
      // the goal's own turn — claiming that id would mislabel the user's turn.
      // The id-correlated turn/start RESPONSE is authoritative there; this
      // notification only fills in when nothing else can (no watcher).
      const turn = parsed.params?.turn;
      const startedGoalTurnId = this.readTurnIdFromParams(parsed.params);
      const watcher = threadId ? this.goalWatchers.get(threadId) : undefined;
      if (watcher && threadId && startedGoalTurnId
        && !this.matchPendingTurn(threadId, startedGoalTurnId)
        && !this.pendingCompactions.has(threadId)) {
        // Unidentified foreground events were buffered before this handler and
        // are replayed only after their turn/start response establishes identity.
        watcher.activeTurnId = startedGoalTurnId;
        watcher.finalText = undefined;
        if (watcher.stopping) this.interruptTurn(threadId, startedGoalTurnId);
      }
      if (pending && !pending.turnId && threadId && !this.goalWatchers.has(threadId)) {
        const startedId = typeof turn === "object" && turn !== null && typeof (turn as { id?: unknown }).id === "string"
          ? (turn as { id: string }).id
          : undefined;
        if (startedId && !this.settledCompactionTurnIds.has(startedId)) {
          this.registerTurnId(pending, startedId);
        }
      } else if (threadId && !pending) {
        const compaction = this.pendingCompactions.get(threadId);
        if (
          compaction
          && !compaction.turnId
          && typeof turn === "object"
          && turn !== null
          && typeof (turn as { id?: unknown }).id === "string"
        ) {
          compaction.turnId = (turn as { id: string }).id;
          this.rememberCompactionTurnId(compaction.turnId);
        }
      }
      return;
    }

    if (parsed.method === "item/agentMessage/delta") {
      const threadId = this.readString(parsed.params?.threadId);
      const delta = this.readString(parsed.params?.delta);
      if (threadId && delta) {
        const pending = this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId));
        if (pending) {
          pending.chunks.push(delta);
          pending.onProgress?.(pending.chunks.join(""));
        }
        this.emitEngineEvent(threadId, {
          type: "assistant_text",
          text: delta,
          delta: true,
          sessionId: threadId,
        }, pending ?? null);
      }
      return;
    }

    if (
      parsed.method === "item/reasoning/delta"
      || parsed.method === "item/reasoning/summaryTextDelta"
      || parsed.method === "item/reasoning/textDelta"
    ) {
      const threadId = this.readString(parsed.params?.threadId);
      const delta = this.readString(parsed.params?.delta);
      if (threadId && delta) {
        this.emitEngineEvent(threadId, {
          type: "thinking",
          text: delta,
          sessionId: threadId,
        }, this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId)) ?? null);
      }
      return;
    }

    if (parsed.method === "turn/plan/updated") {
      // Codex's plan/checklist (the `update_plan` tool). Surface it the same way
      // as Claude's TodoWrite so the run card shows the live plan panel.
      const threadId = this.readString(parsed.params?.threadId);
      const todos = codexPlanTodos((parsed.params as Record<string, unknown> | undefined)?.plan);
      if (threadId && todos) {
        this.emitEngineEvent(threadId, {
          type: "tool_use",
          toolName: "TodoWrite",
          toolInput: { todos },
          sessionId: threadId,
        }, this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId)) ?? null);
      }
      return;
    }

    if (parsed.method === "thread/goal/cleared") {
      const threadId = this.readString(parsed.params?.threadId);
      const watcher = threadId ? this.goalWatchers.get(threadId) : undefined;
      if (threadId && watcher?.acceptGoalEvents) this.refreshGoalState(threadId, watcher);
      return;
    }

    if (parsed.method === "thread/goal/updated") {
      // Progress of a (possibly self-running) thread goal. Feed the goal watcher so a
      // live goal run card can show status/usage; a terminal status ends the watch.
      const threadId = this.readString(parsed.params?.threadId);
      if (threadId) {
        const watcher = this.goalWatchers.get(threadId);
        if (watcher?.acceptGoalEvents) {
          const goal = readThreadGoal((parsed.params as { goal?: unknown } | undefined)?.goal);
          if (goal) {
            if (!watcher.hasGoalState || goal.status !== watcher.latestGoal?.status || watcher.refreshInFlight) {
              this.refreshGoalState(threadId, watcher);
            } else this.observeGoalState(threadId, watcher, goal);
          }
        }
      }
      return;
    }

    if (parsed.method === "item/started") {
      const threadId = this.readString(parsed.params?.threadId);
      const item = parsed.params?.item as { type?: unknown; id?: unknown } | undefined;
      if (this.emitOwnedChildActivity(threadId, this.readString(parsed.params?.turnId), item)) return;
      if (threadId && item?.type === "collabAgentToolCall") this.trackChildWork(this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId)), item, "started");
      if (threadId && item?.type === "contextCompaction" && typeof item.id === "string" && item.id) {
        // Preventive maintenance already has its own callback; this path is
        // for automatic compaction inside the exact foreground/goal turn.
        const turnId = this.readString(parsed.params?.turnId);
        const pending = this.matchPendingTurn(threadId, turnId);
        if (pending || this.matchGoalWatcher(threadId, turnId)) this.emitEngineEvent(threadId, {
          type: "context_compaction", id: item.id, status: "started", sessionId: threadId,
        }, pending ?? null);
        return;
      }
      const tool = extractCodexToolItem(parsed.params?.item);
      if (threadId && tool?.toolUseId && (item?.type === "commandExecution" || item?.type === "command_execution")) {
        const pending = this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId));
        if (pending) (pending.unfinishedCommandIds ??= new Set()).add(tool.toolUseId);
      }
      if (tool?.toolName === "CodexAgent" && (!threadId || !this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId))
        && !this.matchGoalWatcher(threadId, this.readString(parsed.params?.turnId)))) return;
      if (threadId && tool && tool.toolName !== "TodoWrite") this.emitEngineEvent(threadId, {
        type: "tool_use", toolName: tool.toolName, toolInput: tool.toolInput,
        toolUseId: tool.toolUseId, sessionId: threadId,
      }, this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId)) ?? null);
      return;
    }
    if (parsed.method === "item/commandExecution/outputDelta") {
      const threadId = this.readString(parsed.params?.threadId);
      const toolUseId = this.readString(parsed.params?.itemId);
      const delta = this.readString(parsed.params?.delta);
      if (threadId && toolUseId && delta) this.emitEngineEvent(threadId, {
        type: "tool_progress", toolUseId, text: delta, sessionId: threadId,
      }, this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId)) ?? null);
      return;
    }

    if (parsed.method === "item/completed") {
      const threadId = this.readString(parsed.params?.threadId);
      const pending = threadId
        ? this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId))
        : undefined;
      const item = parsed.params?.item;
      if (pending && item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
        pending.unfinishedCommandIds?.delete((item as { id: string }).id);
      }
      if (this.emitOwnedChildActivity(threadId, this.readString(parsed.params?.turnId), item)) return;
      this.trackChildWork(pending, item, "completed");
      const compact = item as { type?: unknown; id?: unknown } | undefined;
      if (threadId && compact?.type === "contextCompaction" && typeof compact.id === "string" && compact.id) {
        if (pending || this.matchGoalWatcher(threadId, this.readString(parsed.params?.turnId))) this.emitEngineEvent(threadId, {
          type: "context_compaction", id: compact.id, status: "completed", sessionId: threadId,
        }, pending ?? null);
        return;
      }
      if (pending && threadId) {
        const generatedImagePath = extractGeneratedImagePath(item);
        if (generatedImagePath) {
          this.addGeneratedImageTag(pending, threadId, generatedImagePath);
        }
      }
      const asyncUserInput = extractCodexAsyncUserInputRequest(item);
      if (threadId && asyncUserInput) {
        this.emitEngineEvent(threadId, {
          type: "user_input_request",
          toolName: "request_user_input_async",
          toolInput: asyncUserInput.toolInput,
          ...(asyncUserInput.requestId ? { requestId: asyncUserInput.requestId } : {}),
          sessionId: threadId,
        }, pending ?? null);
      } else if (
        pending &&
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        (item as { type?: unknown }).type === "agentMessage" &&
        (item as { delivery?: unknown }).delivery !== "async" &&
        "text" in item &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        pending.finalText = (item as { text: string }).text;
      } else if (threadId) {
        const toolEvent = extractCodexToolItem(item);
        if (toolEvent) {
          if (toolEvent.toolName === "CodexAgent" && !pending && !this.matchGoalWatcher(threadId, this.readString(parsed.params?.turnId))) return;
          // Codex app-server reports a completed tool item in one shot. Emit the
          // tool_use + tool_result pair so the Lark run card renders a finished
          // tool panel with output and status, matching the Claude path. Routed via
          // emitEngineEvent so a self-running goal's watcher receives it too.
          this.emitEngineEvent(threadId, {
            type: "tool_use",
            toolName: toolEvent.toolName,
            ...(toolEvent.toolInput === undefined ? {} : { toolInput: toolEvent.toolInput }),
            ...(toolEvent.toolUseId ? { toolUseId: toolEvent.toolUseId } : {}),
            sessionId: threadId,
          }, pending ?? null);
          // A plan (TodoWrite) is meta-state shown as the plan panel, not a tool
          // block, so it needs no completion event. Skipping it also avoids an
          // id-less result wrongly finishing an unrelated running tool.
          if (toolEvent.toolName !== "TodoWrite") {
            this.emitEngineEvent(threadId, {
              type: "tool_result",
              ...(toolEvent.toolUseId ? { toolUseId: toolEvent.toolUseId } : {}),
              toolName: toolEvent.toolName,
              ...(toolEvent.output !== undefined ? { output: toolEvent.output } : {}),
              ...(toolEvent.truncated ? { truncated: true } : {}),
              isError: toolEvent.isError,
              exitCode: toolEvent.exitCode, durationMs: toolEvent.durationMs, changes: toolEvent.changes, sources: toolEvent.sources,
              sessionId: threadId,
            }, pending ?? null);
          }
        }
      }
      return;
    }

    if (parsed.method === "turn/completed") {
      const threadId = this.readString(parsed.params?.threadId);
      const turnId = this.readTurnIdFromParams(parsed.params);
      if (!threadId) {
        return;
      }
      const watcher = this.goalWatchers.get(threadId);
      if (watcher?.activeTurnId === turnId) {
        const finalText = readTurnItems((parsed.params?.turn as { items?: unknown } | undefined)?.items).text;
        if (finalText.trim()) watcher.finalText = finalText;
        watcher.activeTurnId = undefined;
        this.settleGoalAfterFinalTurn(threadId, watcher);
      }

      const compaction = this.pendingCompactions.get(threadId);
      if (
        compaction
        && !this.pendingTurns.has(threadId)
        && (!compaction.turnId || !turnId || compaction.turnId === turnId)
      ) {
        const compactionError = this.readTurnErrorMessage(parsed.params?.turn);
        if (compactionError) {
          this.settleCompaction(threadId, new Error(compactionError));
        } else {
          this.settleCompaction(threadId);
        }
        return;
      }

      // Match on the turn id: a self-running /goal pursuit completes its own turns
      // on this same thread, and settling the user's turn with the goal's text and
      // usage produced the wrong answer AND the wrong billing, then dropped the
      // real user turn (it completed later with no pending entry). An unmatched
      // completion has nothing to settle here — the goal watcher ends on the
      // terminal thread/goal/updated instead.
      const pending = this.matchPendingTurn(threadId, turnId);
      if (!pending) {
        return;
      }
      const completedTurn = parsed.params?.turn;
      if (turnId) {
        this.settledTurnIds.add(`${threadId}:${turnId}`);
        if (this.settledTurnIds.size > 256) this.settledTurnIds.delete(this.settledTurnIds.values().next().value!);
      }
      pending.usage = readTurnUsage(completedTurn) ?? readTurnUsage(parsed.params?.usage) ?? pending.usage;

      // Modern app-server versions include the authoritative final item summary
      // on turn/completed. Consume it before falling back to thread/read: an
      // item/completed notification can be delayed or dropped independently,
      // and waiting for a redundant read used to make an already-finished turn
      // appear stuck for up to the thread/read timeout.
      const completedItems = readTurnItems(
        typeof completedTurn === "object" && completedTurn !== null
          ? (completedTurn as { items?: unknown }).items
          : undefined,
      );
      if (completedItems.text.trim()) {
        pending.finalText = completedItems.text;
      }
      for (const generatedImagePath of completedItems.generatedImagePaths) {
        this.addGeneratedImageTag(pending, threadId, generatedImagePath);
      }

      pending.inactivityTimeout && clearTimeout(pending.inactivityTimeout);
      pending.inactivityTimeout = undefined;
      // The total-turn timer must die with the turn: completeTurn may still be
      // settling (a thread/read for empty streamed text takes up to 180s), and
      // a total-timeout firing in that window would fall through abortTurn's
      // stale-turn guard (the map entry is already gone), rejecting the
      // already-completed turn as "timed out" and discarding its result and
      // usage. A user /stop still works during the settle — its abort is
      // signal-driven, not timer-driven.
      pending.timeout && clearTimeout(pending.timeout);
      pending.timeout = undefined;
      if (this.pendingTurns.get(threadId) === pending) {
        this.pendingTurns.delete(threadId);
      }
      const turnErrorMessage = this.readTurnErrorMessage(parsed.params?.turn);
      this.completingTurns += 1;
      if (turnErrorMessage) {
        const useNotification = turnErrorMessage === "Codex turn failed.";
        const failureMessage = useNotification
          ? pending.notificationErrorMessage ?? turnErrorMessage
          : turnErrorMessage;
        const failure = this.withDiagnostics(failureMessage, pending.stderrOffset);
        // A notification that Codex itself was still retrying cannot describe
        // why the turn finally failed; only a final notification may stand in.
        const finalNotification = useNotification && pending.notificationErrorMessage !== undefined
          && pending.notificationWillRetry !== true;
        pending.reject(useNotification && !finalNotification ? failure : this.withCompletedTurnRetryReceipt(failure, {
          threadId,
          pending,
          turn: completedTurn,
          providerMessage: failureMessage,
          errorInfo: useNotification ? pending.notificationErrorInfo : readCodexErrorInfo((completedTurn as { error?: unknown } | undefined)?.error),
        }));
        this.finishCompletingTurn();
        return;
      }

      void this.completeTurn(threadId, turnId ?? undefined, pending).catch((error) => {
        pending.reject(this.withDiagnostics(error instanceof Error ? error.message : String(error), pending.stderrOffset));
      }).finally(() => {
        this.finishCompletingTurn();
      });
      return;
    }

    if (parsed.method === "error") {
      const threadId = this.readString(parsed.params?.threadId);
      // Same turn-id scoping as turn/completed: a /goal pursuit's error must not
      // poison an unrelated user turn running on the same thread.
      const pending = threadId
        ? this.matchPendingTurn(threadId, this.readString(parsed.params?.turnId))
        : undefined;
      const errorMessage = this.readErrorMessage(parsed.params?.error);

      if (pending && errorMessage) {
        // `error` is also emitted for recoverable transport failures. Do not
        // let a stale reconnect notice override a later authoritative
        // turn/completed status=completed. If the turn ultimately fails, the
        // completion branch above uses this message when it has no better one.
        pending.notificationErrorMessage = errorMessage;
        pending.notificationErrorInfo = readCodexErrorInfo(parsed.params?.error);
        pending.notificationWillRetry = typeof parsed.params?.willRetry === "boolean" ? parsed.params.willRetry : undefined;
      }
      return;
    }
  }

  private readString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private readTurnIdFromParams(params: Record<string, unknown> | undefined): string | null {
    const directTurnId = this.readString(params?.turnId);
    if (directTurnId) {
      return directTurnId;
    }

    const turn = params?.turn;
    if (typeof turn !== "object" || turn === null || Array.isArray(turn)) {
      return null;
    }
    return this.readString((turn as Record<string, unknown>).id);
  }

  private readErrorMessage(value: unknown): string | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    const error = value as { message?: unknown; codexErrorInfo?: unknown };
    const message = typeof error.message === "string" ? error.message.trim() : "";
    const errorInfo = typeof error.codexErrorInfo === "string"
      ? error.codexErrorInfo.trim()
      : error.codexErrorInfo && typeof error.codexErrorInfo === "object"
        ? Object.keys(error.codexErrorInfo as Record<string, unknown>)[0] ?? ""
        : "";
    const structuredCode = errorInfo ? `Codex error code: ${errorInfo}` : "";
    const combined = [message, structuredCode].filter(Boolean).join("\n");
    return combined || null;
  }

  private readTurnErrorMessage(value: unknown): string | null {
    if (typeof value !== "object" || value === null) {
      return null;
    }

    const turn = value as {
      status?: unknown;
      error?: unknown;
    };
    const errorMessage = this.readErrorMessage(turn.error);
    if (errorMessage) {
      return errorMessage;
    }

    if (turn.status === "failed") {
      return "Codex turn failed.";
    }

    return null;
  }

  /**
   * `turn/completed status=failed` for this exact pending turn is Codex's
   * authoritative foreground terminal. The admitted user input and any completed
   * items remain in the native thread, so recovery continues that thread and never
   * replays the original request. Structured `codexErrorInfo` decides the reason;
   * the provider message (never appended stderr) is only consulted when an older
   * Codex sends no structured code. Side (ephemeral) turns are never resumed.
   */
  private withCompletedTurnRetryReceipt(failure: Error, input: {
    threadId: string;
    pending: PendingTurn;
    turn: unknown;
    providerMessage: string;
    errorInfo: unknown;
  }): Error {
    const status = typeof input.turn === "object" && input.turn !== null ? (input.turn as { status?: unknown }).status : undefined;
    if (status !== "failed" || input.pending.ephemeral || isLogicalTelegramSessionId(input.threadId)) {
      return failure;
    }
    // The terminal turn's item summary can carry collab calls whose item
    // notifications were never seen; account for them before deciding.
    const items = (input.turn as { items?: unknown }).items;
    if (Array.isArray(items)) for (const item of items) this.trackChildWork(input.pending, item, "completed", true);
    const reason = input.errorInfo !== undefined
      ? codexTransientRetryReason(input.errorInfo)
      : engineRetryReason(input.providerMessage);
    if (!reason) {
      return failure;
    }
    const turnId = input.pending.turnId;
    const generation = this.childGeneration;
    const ownedIds = new Set(input.pending.unfinishedCommandIds);
    let claimed = false;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    const releaseTools = () => {
      if (leaseTimer) clearTimeout(leaseTimer);
      if (this.retryToolLeases.delete(releaseTools)) this.notifyIdleWaitersIfIdle();
    };
    if (turnId && ownedIds.size) {
      this.retryToolLeases.add(releaseTools);
      // Standalone adapter callers may not run the bridge recovery loop.
      leaseTimer = setTimeout(releaseTools, 60_000);
      leaseTimer.unref();
    }
    return new EngineRetryableError(failure.message, {
      sessionId: input.threadId,
      mode: "continue",
      reason,
      ...(turnId && ownedIds.size ? { releaseTools, reconcileTools: async (requestedIds: readonly string[], signal?: AbortSignal, locale?: "en" | "zh") => {
        if (claimed || !this.retryToolLeases.has(releaseTools)) return;
        claimed = true;
        if (leaseTimer) clearTimeout(leaseTimer);
        try {
          await reconcileCodexRetryCommands({
            turnId, ownedIds, requestedIds, terminalItems: items, signal,
            isAvailable: () => generation === this.childGeneration && this.child !== null,
            read: async (itemIds, signal) => {
              signal?.throwIfAborted();
              if (generation !== this.childGeneration) throw new Error("Native command owner changed during recovery");
              return await this.request("thread/items/read", { threadId: input.threadId, turnId, itemIds }, { timeoutMs: 5_000, signal });
            },
            settled: async item => {
              const tool = extractCodexToolItem(item);
              // Persisted records sometimes omit stdout. Append a clearly
              // labelled terminal status without erasing earlier streamed logs.
              const status = locale === "zh"
                ? `[TaroBird] 已确认命令状态：${item.status === "declined" ? "已拒绝" : item.status === "failed" ? "执行失败" : "已结束"}${tool?.exitCode !== undefined ? `，退出码 ${tool.exitCode}` : ""}。`
                : `[TaroBird] Confirmed command status: ${item.status}${tool?.exitCode !== undefined ? `; exit code ${tool.exitCode}` : ""}.`;
              if (tool) {
                if (tool.output === undefined && tool.toolUseId) await input.pending.onEngineEvent?.({ type: "tool_progress", toolUseId: tool.toolUseId,
                  text: status, delta: false, sessionId: input.threadId });
                await input.pending.onEngineEvent?.({ type: "tool_result", toolName: tool.toolName, toolUseId: tool.toolUseId,
                  output: tool.output, isError: tool.isError || item.status === "declined", exitCode: tool.exitCode, durationMs: tool.durationMs, sessionId: input.threadId });
              }
            },
            waiting: async ids => {
              for (const id of ids) await input.pending.onEngineEvent?.({ type: "tool_progress", toolUseId: id,
                text: locale === "zh" ? "[TaroBird] 模型服务暂时中断，正在等待已启动的命令完成，随后自动继续。"
                  : "[TaroBird] The model service was interrupted. Waiting for the already-started command to finish, then continuing automatically.", delta: false, sessionId: input.threadId });
            },
          });
        } finally { releaseTools(); }
      } } : {}),
      // A child agent this turn started or continued may still be running. The
      // host keeps this context and usage but must not continue alongside it.
      ...(this.hasLiveChildWork(input.pending) ? { unfinishedWork: true as const } : {}),
      ...(input.pending.usage ? { usage: input.pending.usage } : {}),
    }, { cause: failure });
  }

  /**
   * Records collab calls of the exact foreground turn. A completed launch call
   * only means the request was delivered (its agentsStates usually say
   * pendingInit), never that the child finished.
   */
  private trackChildWork(pending: PendingTurn | undefined, value: unknown, phase: "started" | "completed", fromTerminalSummary = false): void {
    if (!pending || typeof value !== "object" || value === null) return;
    const call = value as { type?: unknown; id?: unknown; tool?: unknown; status?: unknown; receiverThreadIds?: unknown; agentsStates?: unknown };
    if (call.type !== "collabAgentToolCall") return;
    const ledger = pending.childWork ??= { children: new Map(), launchStarts: new Map(), launchesInFlight: new Set(), seenItems: new Set(), unattributed: false };
    const id = typeof call.id === "string" && call.id ? call.id : undefined;
    if (fromTerminalSummary && id && ledger.seenItems.has(id)) return;
    if (id) ledger.seenItems.add(id);
    const seq = ++this.childWorkSeq;
    const receivers = Array.isArray(call.receiverThreadIds)
      ? call.receiverThreadIds.filter((receiver): receiver is string => typeof receiver === "string" && receiver.length > 0)
      : [];
    if (typeof call.tool !== "string" || !CODEX_CHILD_OBSERVE_TOOLS.has(call.tool)) {
      if (phase === "started") {
        if (id) {
          ledger.launchesInFlight.add(id);
          ledger.launchStarts.set(id, seq);
        } else {
          ledger.unattributed = true;
        }
      } else {
        if (id) ledger.launchesInFlight.delete(id);
        // Without a receiver the child cannot be followed; a failed call with
        // no receiver started nothing.
        if (receivers.length === 0 && call.status !== "failed") ledger.unattributed = true;
      }
      // Evidence counts from the moment this launch began, even if the child's
      // turn starts before the call reports completion.
      const launchSeq = (id ? ledger.launchStarts.get(id) : undefined) ?? seq;
      for (const receiver of receivers) {
        const known = ledger.children.get(receiver);
        if (known && known.launchSeq >= launchSeq) continue;
        const child: CodexChildWork = { launchSeq, live: true };
        const recent = this.recentChildTurns.get(receiver);
        if (recent?.startedTurnId && recent.startedSeq! > launchSeq) {
          child.startedTurnId = recent.startedTurnId;
          child.startedSeq = recent.startedSeq;
          if (recent.completedTurnId === recent.startedTurnId && recent.completedSeq! > recent.startedSeq!) child.live = false;
        }
        ledger.children.set(receiver, child);
      }
      return;
    }
    // Summary-only launches are counted above. A summary-only observation
    // cannot be ordered against launches seen live, so it never releases work.
    if (phase !== "completed" || fromTerminalSummary) return;
    const states = typeof call.agentsStates === "object" && call.agentsStates !== null && !Array.isArray(call.agentsStates)
      ? call.agentsStates as Record<string, unknown>
      : {};
    for (const [receiver, state] of Object.entries(states)) {
      const status = typeof state === "object" && state !== null ? (state as { status?: unknown }).status : undefined;
      const known = ledger.children.get(receiver);
      if (typeof status === "string" && CODEX_CHILD_TERMINAL_STATES.has(status)) {
        if (known && seq > known.launchSeq) known.live = false;
      } else {
        // A non-terminal report is newer evidence of running work (also for a
        // child released earlier): only a child turn that starts after it and
        // then completes can release the child again.
        ledger.children.set(receiver, { launchSeq: seq, live: true });
      }
    }
  }

  /** Child-thread turn lifecycle; only a turn that started after the child's
   * latest launch and then completed releases it. */
  private observeChildTurn(method: "turn/started" | "turn/completed", threadId: string | null, turnId: string | null): void {
    if (!threadId || !turnId || this.pendingTurns.has(threadId)) return;
    const seq = ++this.childWorkSeq;
    const recent = method === "turn/started"
      ? { startedTurnId: turnId, startedSeq: seq }
      : { ...this.recentChildTurns.get(threadId), completedTurnId: turnId, completedSeq: seq };
    this.recentChildTurns.delete(threadId);
    this.recentChildTurns.set(threadId, recent);
    if (this.recentChildTurns.size > CODEX_RECENT_CHILD_TURNS_MAX) this.recentChildTurns.delete(this.recentChildTurns.keys().next().value!);
    for (const pending of new Set([...this.pendingTurns.values(), ...this.pendingTurnsByTurnId.values()])) {
      const child = pending.childWork?.children.get(threadId);
      if (!child) continue;
      if (method === "turn/started") {
        if (seq > child.launchSeq) {
          // A new child turn means its work is running again, whatever ended before.
          child.live = true;
          child.startedTurnId = turnId;
          child.startedSeq = seq;
        }
      } else if (child.startedTurnId === turnId && child.startedSeq! > child.launchSeq) {
        child.live = false;
      }
    }
  }

  private hasLiveChildWork(pending: PendingTurn): boolean {
    const ledger = pending.childWork;
    return Boolean(ledger && (ledger.unattributed || ledger.launchesInFlight.size > 0 || [...ledger.children.values()].some((child) => child.live)));
  }

  private readThreadIdFromResult(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }

    const result = value as { thread?: unknown; threadId?: unknown };
    if (typeof result.threadId === "string") {
      return result.threadId;
    }
    if (typeof result.thread === "object" && result.thread !== null) {
      const thread = result.thread as { id?: unknown };
      if (typeof thread.id === "string") {
        return thread.id;
      }
    }
    return undefined;
  }

  private recordNotificationDiagnostic(method: string, params: Record<string, unknown> | undefined): void {
    this.lastNotificationDiagnostic = {
      at: Date.now(),
      method,
      threadId: this.readString(params?.threadId) ?? undefined,
      childGeneration: this.childGeneration,
    };
  }

  /** Both native item notifications may carry public lifecycle receipts. The
   * journal deduplicates by native id and activity kind; neither notification
   * can grant ownership to a foreign turn or child thread. */
  private emitOwnedChildActivity(threadId: string | null | undefined, turnId: string | null | undefined, item: unknown): boolean {
    const activity = codexSubagentActivity(item);
    if (!activity) return false;
    if (threadId) {
      const pending = this.matchPendingTurn(threadId, turnId);
      if (pending || this.matchGoalWatcher(threadId, turnId)) {
        this.emitEngineEvent(threadId, { ...activity, sessionId: threadId }, pending ?? null);
      }
    }
    return true;
  }

  /**
   * Routes a normalized engine event to the thread's active turn, or — when the thread
   * is running a goal autonomously (no pendingTurn) — to its goal watcher, so a
   * self-running goal can drive a live run card.
   *
   * `owner` disambiguates the two cases when the caller already matched the
   * notification's turn id: a PendingTurn routes to that exact turn, and `null`
   * means "this notification belongs to another turn on the thread" (typically the
   * autonomous /goal pursuit) so it must go to the goal watcher, never to the
   * unrelated user turn. `undefined` keeps the legacy thread-scoped resolution.
   */
  private emitEngineEvent(threadId: string, event: EngineStreamEvent, owner?: PendingTurn | null): void {
    const sink = owner === undefined
      ? (this.pendingTurns.get(threadId)?.onEngineEvent ?? this.goalWatchers.get(threadId)?.onEngineEvent)
      : owner === null
        ? this.goalWatchers.get(threadId)?.onEngineEvent
        : owner.onEngineEvent;
    if (sink) {
      try { void Promise.resolve(sink(event)).catch(() => {}); }
      catch { /* Observer failures must not change an engine turn. */ }
    }
  }

  /**
   * Emits the `session` event the bridge binds on. Awaited (best effort) so the
   * thread id is persisted before anything else can fail the turn.
   */
  private async emitSessionEvent(
    threadId: string,
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>,
  ): Promise<void> {
    if (!onEngineEvent) {
      return;
    }
    try {
      await onEngineEvent({ type: "session", sessionId: threadId });
    } catch {
      // Session binding is best effort; it must never fail the turn.
    }
  }

  /**
   * Resolves which pending turn a thread-scoped notification belongs to.
   *
   * - A known turn id wins: it still matches a turn that no longer owns the thread.
   * - While the pending turn's own id is unknown (the window between turn/start
   *   being written and its response/turn/started arriving) the thread's pending
   *   turn owns every notification, preserving the previous behavior.
   * - A known-but-different turn id returns undefined: the notification belongs to
   *   another turn on the same thread (a /goal pursuit runs outside the chat queue
   *   and emits the same turn/* and item/* notifications), so it must not append
   *   deltas to — or settle — the user's turn.
   */
  private matchPendingTurn(threadId: string, turnId: string | null | undefined, options: { adopt?: boolean } = {}): PendingTurn | undefined {
    if (turnId && this.retiredTurnIds.has(`${threadId}:${turnId}`)) return undefined;
    if (turnId && this.settledTurnIds.has(`${threadId}:${turnId}`)) return undefined;
    if (turnId) {
      const byTurnId = this.pendingTurnsByTurnId.get(turnId);
      if (byTurnId) {
        return byTurnId.threadId === threadId ? byTurnId : undefined;
      }
    }

    const pending = this.pendingTurns.get(threadId);
    if (!pending) {
      return undefined;
    }
    if (!turnId) {
      // No id on the notification: thread ownership is all we have.
      return pending;
    }
    if (!pending.turnId) {
      // The turn's own id is not registered yet (its `turn/start` response has
      // not landed). Adopting an id-bearing notification here is exactly how a
      // concurrent /goal pursuit's output settled the user's turn — the goal's
      // turn is NOT in pendingTurnsByTurnId (it isn't a pendingTurn at all), so
      // an "is this id taken?" test can never see it. While a pursuit owns this
      // thread the id-correlated `turn/start` response is the only authority,
      // matching the same rule the `turn/started` handler already applies.
      if (this.pendingTurnsByTurnId.has(turnId)) {
        return undefined;
      }
      if (this.settledCompactionTurnIds.has(turnId)) {
        // A compaction turn's late notification must never settle a user turn.
        return undefined;
      }
      if (options.adopt === false) {
        return undefined;
      }
      if (this.goalWatchers.has(threadId)) {
        // A pursuit shares this thread, so an id-bearing notification may be the
        // GOAL's — adopting the id is how the goal's output used to settle the
        // user's turn. But dropping it is equally wrong: the turn's OWN early
        // notifications arrive here too, and discarding a `turn/completed` left a
        // finished turn hanging until it timed out. Defer instead; the caller
        // buffers the raw line and replays it once the id-correlated
        // `turn/start` response says whose it is.
        return undefined;
      }
      this.registerTurnId(pending, turnId);
      return pending;
    }
    return pending.turnId === turnId ? pending : undefined;
  }

  /**
   * A server request no PendingTurn owns may belong to the autonomous /goal
   * pursuit, but only by the watcher's exact live native turn id. Missing,
   * finished, retired, foreign or still-ambiguous ids (an ordinary turn/start on
   * this thread has not answered yet) fail closed.
   */
  private matchGoalWatcher(threadId: string | null | undefined, turnId: string | null | undefined): CodexGoalWatcher | undefined {
    if (!threadId || !turnId || this.retiredTurnIds.has(`${threadId}:${turnId}`)
      || this.pendingTurnsByTurnId.has(turnId) || this.unresolvedTurnStarts.has(threadId)) {
      return undefined;
    }
    const watcher = this.goalWatchers.get(threadId);
    return watcher && !watcher.stopping && !watcher.interactionAbortController.signal.aborted && watcher.activeTurnId === turnId
      ? watcher
      : undefined;
  }

  /**
   * While a /goal pursuit or native App tools share a thread, an event or request can
   * belong either to the pursuit or to a user turn whose own id has not been
   * confirmed yet. Neither routing it nor dropping it is safe, so hold the raw
   * line on the pending turn and replay it once `turn/start` resolves the id.
   * Bounded so a wedged pursuit cannot grow it without limit.
   */
  private bufferUnidentifiedTurnLine(line: string): boolean {
    if (this.goalWatchers.size === 0 && this.unresolvedTurnStarts.size === 0 && ![...this.pendingTurns.values()].some((turn) => turn.appPlatformTools && !turn.turnId)) {
      return false;
    }
    let parsed: JsonRpcResponse | undefined;
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return false;
    }
    if (typeof parsed?.method !== "string") {
      return false;
    }
    const threadId = this.readString(parsed.params?.threadId);
    const turnId = this.readTurnIdFromParams(parsed.params);
    if (!threadId || !turnId) {
      return false;
    }
    if (this.retiredTurnIds.has(`${threadId}:${turnId}`)) return false;
    const unresolved = this.unresolvedTurnStarts.get(threadId);
    const pending = unresolved?.values().next().value ?? this.pendingTurns.get(threadId);
    if (!pending || pending.turnId || (!this.goalWatchers.has(threadId) && !pending.appPlatformTools && !pending.abortedBeforeTurnId)) {
      return false;
    }
    if (this.pendingTurnsByTurnId.has(turnId)) {
      return false;
    }
    const buffered = pending.pendingUnidentifiedLines ?? [];
    const bufferedBytes = pending.pendingUnidentifiedBytes ?? 0;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (
      buffered.length >= UNIDENTIFIED_TURN_LINE_BUFFER_MAX ||
      bufferedBytes + lineBytes > UNIDENTIFIED_TURN_LINE_BUFFER_MAX_BYTES
    ) {
      const message = [
        "Codex app-server unidentified turn event buffer exceeded its safety limit",
        `(max ${UNIDENTIFIED_TURN_LINE_BUFFER_MAX} lines / ${UNIDENTIFIED_TURN_LINE_BUFFER_MAX_BYTES} bytes)`,
      ].join(" ");
      pending.pendingUnidentifiedLines = [...buffered, line];
      pending.pendingUnidentifiedBytes = bufferedBytes + lineBytes;
      this.drainUnidentifiedTurnLines(pending, message);
      this.failPendingTurn(threadId, message);
      return true;
    }
    buffered.push(line);
    pending.pendingUnidentifiedLines = buffered;
    pending.pendingUnidentifiedBytes = bufferedBytes + lineBytes;
    return true;
  }

  /** Replay this turn's buffered lines and explicitly settle mismatched RPC requests. */
  private flushUnidentifiedTurnLines(pending: PendingTurn): void {
    const buffered = pending.pendingUnidentifiedLines;
    if (!buffered || buffered.length === 0) {
      pending.pendingUnidentifiedBytes = undefined;
      return;
    }
    pending.pendingUnidentifiedLines = undefined;
    pending.pendingUnidentifiedBytes = undefined;
    for (const line of buffered) {
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (this.readTurnIdFromParams(parsed.params) === pending.turnId || parsed.id === undefined) {
        // Once the foreground response establishes identity, replay goal
        // notifications too. Dropping them lost goal start/end boundaries.
        this.handleMessage(line);
      } else if (
        typeof parsed.method === "string" && GOAL_OWNED_SERVER_REQUESTS.has(parsed.method)
        && this.matchGoalWatcher(this.readString(parsed.params?.threadId), this.readTurnIdFromParams(parsed.params))
      ) {
        // No longer ambiguous: it names the pursuit's exact live turn.
        this.handleMessage(line);
      } else {
        this.settleUnmatchedBufferedServerRequest(parsed, "No matching pending Codex turn");
      }
    }
  }

  /**
   * A turn can be evicted (/stop, timeout, failed turn/start, unsupported request)
   * while it still holds buffered lines whose owner was never resolved. Dropping
   * buffered NOTIFICATIONS is harmless, but a buffered server REQUEST leaves the
   * app-server waiting on a response that will now never arrive — wedging the
   * /goal pursuit that issued it. Settle them exactly as the unmatched path does.
   */
  private drainUnidentifiedTurnLines(pending: PendingTurn, message: string): void {
    const buffered = pending.pendingUnidentifiedLines;
    pending.pendingUnidentifiedLines = undefined;
    pending.pendingUnidentifiedBytes = undefined;
    if (!buffered) {
      return;
    }
    for (const line of buffered) {
      if (pending.abortedBeforeTurnId) {
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (parsed.id === undefined) {
            const retained = pending.pendingUnidentifiedLines ??= [];
            const retainedBytes: number = pending.pendingUnidentifiedBytes ?? 0;
            const lineBytes = Buffer.byteLength(line, "utf8");
            if (retained.length < UNIDENTIFIED_TURN_LINE_BUFFER_MAX && retainedBytes + lineBytes <= UNIDENTIFIED_TURN_LINE_BUFFER_MAX_BYTES) {
              retained.push(line);
              pending.pendingUnidentifiedBytes = retainedBytes + lineBytes;
            }
            continue;
          }
        } catch { /* malformed frames are discarded */ }
      }
      this.settleUnmatchedBufferedServerRequest(line, message);
    }
  }

  private settleUnmatchedBufferedServerRequest(line: string, message: string): void;
  private settleUnmatchedBufferedServerRequest(parsed: JsonRpcResponse, message: string): void;
  private settleUnmatchedBufferedServerRequest(lineOrParsed: string | JsonRpcResponse, message: string): void {
    let parsed: JsonRpcResponse;
    if (typeof lineOrParsed === "string") {
      try {
        parsed = JSON.parse(lineOrParsed) as JsonRpcResponse;
      } catch {
        return;
      }
    } else {
      parsed = lineOrParsed;
    }

    if (
      (typeof parsed.id !== "number" && typeof parsed.id !== "string") ||
      typeof parsed.method !== "string"
    ) {
      return;
    }
    if (parsed.method === "item/tool/requestUserInput") {
      this.respondToServerRequest(parsed.id, { answers: {} });
      return;
    }
    if (parsed.method === "item/tool/call") {
      this.respondToServerRequest(parsed.id, { success: false, contentItems: [{ type: "inputText", text: message }] });
      return;
    }
    if (parsed.method === "mcpServer/elicitation/request") {
      this.respondToServerRequest(parsed.id, { action: "cancel" });
      return;
    }
    if (parsed.method === "item/permissions/requestApproval") {
      this.respondToServerRequest(parsed.id, deniedCodexPermissions());
      return;
    }
    if (
      parsed.method === "item/commandExecution/requestApproval" ||
      parsed.method === "execCommandApproval" ||
      parsed.method === "item/fileChange/requestApproval" ||
      parsed.method === "applyPatchApproval"
    ) {
      this.respondToServerRequest(parsed.id, { decision: "cancel" });
      return;
    }
    this.rejectServerRequest(parsed.id, message);
  }

  private registerTurnId(pending: PendingTurn, turnId: string): void {
    if (pending.turnId === turnId) {
      return;
    }
    if (pending.turnId && this.pendingTurnsByTurnId.get(pending.turnId) === pending) {
      this.pendingTurnsByTurnId.delete(pending.turnId);
    }
    pending.turnId = turnId;
    this.pendingTurnsByTurnId.set(turnId, pending);
    this.flushUnidentifiedTurnLines(pending);
  }

  private forgetTurnId(pending: PendingTurn): void {
    if (pending.turnId && this.pendingTurnsByTurnId.get(pending.turnId) === pending) {
      this.pendingTurnsByTurnId.delete(pending.turnId);
    }
  }

  /** True while the turn is still tracked (owns its thread, or is a displaced turn
   * still reachable by its turn id), i.e. it has not settled yet. */
  private isPendingTurnTracked(threadId: string, pending: PendingTurn): boolean {
    return (
      this.pendingTurns.get(threadId) === pending ||
      (pending.turnId !== undefined && this.pendingTurnsByTurnId.get(pending.turnId) === pending)
    );
  }

  private handleServerRequest(request: AppServerRequest): void {
    this.recordNotificationDiagnostic(request.method, request.params);
    const threadId = this.readString(request.params?.threadId);
    if (threadId) {
      this.noteTurnActivity(threadId, request.method);
    }

    if (request.method === "item/tool/call") {
      void this.handleAppToolRequest(request);
      return;
    }

    if (request.method === "item/tool/requestUserInput" || request.method === "mcpServer/elicitation/request" || request.method === "item/permissions/requestApproval") {
      void this.handleInteractiveServerRequest(request);
      return;
    }

    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "execCommandApproval"
    ) {
      void this.handleApprovalServerRequest(request, "Codex command approval");
      return;
    }

    if (
      request.method === "item/fileChange/requestApproval" ||
      request.method === "applyPatchApproval"
    ) {
      void this.handleApprovalServerRequest(request, "Codex file change approval");
      return;
    }

    const message = `Unsupported Codex app-server request: ${request.method}`;
    this.rejectServerRequest(request.id, message);
    if (threadId) {
      this.failPendingTurn(threadId, message);
    }
  }

  private async handleAppToolRequest(request: AppServerRequest): Promise<void> {
    const params = request.params ?? {};
    const threadId = this.readString(params.threadId);
    const turnId = this.readString(params.turnId);
    const callId = this.readString(params.callId);
    const name = this.readString(params.tool);
    const pending = threadId && turnId ? this.matchPendingTurn(threadId, turnId) : undefined;
    const tools = pending?.appPlatformTools;
    const response = (value: { text: string; isError?: boolean }) => ({ success: !value.isError, contentItems: [{ type: "inputText", text: value.text }] });
    if (!pending || !tools || !threadId || !callId || !name || params.namespace != null || !tools.definitions.some((tool) => tool.name === name)) {
      const fallback = name === "app_send_file" || name === "app_send_batch"
        ? " No active authorized App turn owns this request. This call did not deliver a file. Background goals and child threads cannot deliver by emitting text markers. State clearly that the file was not delivered, keep its workspace path in the summary, and ask the user to request it in an ordinary chat turn."
        : "";
      this.respondToServerRequest(request.id, response({ text: `App tool unavailable for this turn.${fallback}`, isError: true }));
      return;
    }
    if (this.interactiveRequests.has(request.id)) return;
    const generation = this.childGeneration;
    const active = { threadId, controller: new AbortController(), resolved: false };
    this.interactiveRequests.set(request.id, active);
    const signal = active.controller.signal;
    const abort = () => active.controller.abort();
    pending.interactionAbortController.signal.addEventListener("abort", abort, { once: true });
    if (pending.interactionAbortController.signal.aborted) abort();
    const cancelled = { text: "App tool cancelled; verify any in-flight delivery before resending.", isError: true };
    let cancelWait!: () => void;
    const cancellation = new Promise<typeof cancelled>((resolve) => {
      cancelWait = () => resolve(cancelled);
      if (signal.aborted) cancelWait(); else signal.addEventListener("abort", cancelWait, { once: true });
    });
    try {
      const calls = pending.appToolCalls ??= new Map();
      const signature = JSON.stringify([name, params.arguments]);
      let call = calls.get(callId);
      if (call && call.signature !== signature) {
        this.respondToServerRequest(request.id, response({ text: "Tool call ID reused with different arguments.", isError: true }));
        return;
      }
      if (!call) {
        const result = Promise.resolve().then(async () => {
          signal.throwIfAborted();
          await pending.onEngineEvent?.({ type: "tool_use", toolName: name, toolInput: params.arguments, toolUseId: callId, sessionId: threadId });
          signal.throwIfAborted();
          const value = await tools.call({ name, arguments: params.arguments, callId, sessionId: threadId, abortSignal: signal });
          // A progress-display failure cannot invalidate a confirmed side effect.
          if (!signal.aborted) await Promise.resolve().then(() => pending.onEngineEvent?.({ type: "tool_result", toolName: name, toolUseId: callId, output: value.text, isError: value.isError, sessionId: threadId })).catch(() => undefined);
          return value;
        }).catch(() => ({ text: "App tool failed; no successful delivery receipt was confirmed.", isError: true }));
        call = { signature, result };
        calls.set(callId, call);
      }
      const value = await Promise.race([cancellation, call.result]);
      if (generation === this.childGeneration && !active.resolved) this.respondToServerRequest(request.id, response(value));
    } finally {
      signal.removeEventListener("abort", cancelWait);
      pending.interactionAbortController.signal.removeEventListener("abort", abort);
      if (this.interactiveRequests.get(request.id) === active) this.interactiveRequests.delete(request.id);
    }
  }

  private async handleInteractiveServerRequest(request: AppServerRequest): Promise<void> {
    const isMcp = request.method === "mcpServer/elicitation/request";
    const isPermission = request.method === "item/permissions/requestApproval";
    const permission = isPermission ? normalizeCodexPermissions(request.params) : undefined;
    const form = isPermission ? permission : isMcp ? normalizeCodexMcpElicitation(request.params) : normalizeCodexUserInput(request.params);
    const pending = form && (form.turnId || !this.goalWatchers.has(form.threadId)) ? this.matchPendingTurn(form.threadId, form.turnId) : undefined;
    // An autonomous /goal turn has no PendingTurn; its exact native turn id is the owner.
    const owner: InteractionOwner | undefined = pending ?? (form ? this.matchGoalWatcher(form.threadId, form.turnId) : undefined);
    const callback = isPermission ? owner?.onApprovalRequest : owner?.onUserInputRequest;
    if (!form || !owner || !callback) {
      this.respondToServerRequest(request.id, isPermission ? deniedCodexPermissions() : isMcp ? { action: "cancel" } : { answers: {} });
      return;
    }
    if (this.interactiveRequests.has(request.id)) return;
    const generation = this.childGeneration;
    const active = { threadId: form.threadId, controller: new AbortController(), resolved: false };
    this.interactiveRequests.set(request.id, active);
    const signal = active.controller.signal;
    const abort = () => active.controller.abort();
    owner.interactionAbortController.signal.addEventListener("abort", abort, { once: true });
    if (owner.interactionAbortController.signal.aborted) abort();
    const deny = (): EngineApprovalDecision => ({ behavior: "deny" });
    let cancelWait!: () => void;
    const cancelled = new Promise<EngineApprovalDecision>((resolve) => {
      cancelWait = () => resolve(deny());
      if (signal.aborted) cancelWait(); else signal.addEventListener("abort", cancelWait, { once: true });
    });
    try {
      const decision = await Promise.race([cancelled, Promise.resolve().then(async () => {
        if (signal.aborted) return deny();
        const toolName = permission?.toolName ?? "AskUserQuestion";
        await owner.onEngineEvent?.({ type: "permission_request", toolName, toolInput: form.toolInput, toolUseId: form.itemId, sessionId: form.threadId });
        if (signal.aborted) return deny();
        return callback({ engine: "codex", toolName, toolInput: form.toolInput, sessionId: form.threadId, abortSignal: signal,
          ...(permission ? { cwd: permission.cwd, approvalScopes: permission.approvalScopes } : {}),
        });
      }).catch(deny)]);
      // A late click must never answer a resolved request or a replacement child.
      if (generation === this.childGeneration && !active.resolved) {
        this.respondToServerRequest(request.id, form.response(signal.aborted ? deny() : decision));
        // request_permissions has no ordinary tool-item completion notification
        // in 0.159.3. Finish the permission-request row when its response is sent;
        // later shell/file execution still has its own native tool/result events.
        if (permission && !signal.aborted) {
          await Promise.resolve().then(() => owner.onEngineEvent?.({ type: "tool_result", toolName: permission.toolName,
            toolUseId: permission.itemId, sessionId: permission.threadId,
            output: decision.behavior === "allow" ? `Permission decision sent: ${decision.scope === "session" ? "session" : "turn"}` : "Permission request denied",
            isError: decision.behavior !== "allow",
          })).catch(() => undefined);
        }
      }
    } finally {
      signal.removeEventListener("abort", cancelWait);
      owner.interactionAbortController.signal.removeEventListener("abort", abort);
      if (this.interactiveRequests.get(request.id) === active) this.interactiveRequests.delete(request.id);
    }
  }

  private async handleApprovalServerRequest(request: AppServerRequest, toolName: string): Promise<void> {
    const params = request.params ?? {};
    const threadId = this.readString(params.threadId);
    const turnId = this.readString(params.turnId);
    // Route by turn id when the request carries one: matching on threadId alone
    // sent a /goal pursuit's command approval to the concurrent user turn's
    // approval handler (which answered it as if the operator had approved the
    // user's own command). matchPendingTurn falls back to thread ownership when
    // no id is present, and defers while a pursuit shares an unidentified turn.
    const pending = threadId ? this.matchPendingTurn(threadId, turnId) : undefined;
    // A goal turn reaches its owner only by exact id, and only with the
    // mode-gated callback; otherwise keep the previous cancel.
    const goal = pending ? undefined : this.matchGoalWatcher(threadId, turnId);
    const owner: InteractionOwner | undefined = pending ?? (goal?.onApprovalRequest ? goal : undefined);

    if (!threadId || !owner) {
      this.respondToServerRequest(request.id, { decision: "cancel" });
      return;
    }
    // This entry point cannot present an actionable approval card. Decline
    // without leaving a permission_request event stranded in its run journal.
    if (!owner.onApprovalRequest) {
      this.respondToServerRequest(request.id, { decision: "decline" });
      return;
    }

    if (this.interactiveRequests.has(request.id)) return;
    const generation = this.childGeneration;
    const active = { threadId, controller: new AbortController(), resolved: false };
    this.interactiveRequests.set(request.id, active);
    const signal = active.controller.signal;
    const abort = () => active.controller.abort();
    owner.interactionAbortController.signal.addEventListener("abort", abort, { once: true });
    if (owner.interactionAbortController.signal.aborted) abort();
    let cancelWait!: () => void;
    const deny = (): EngineApprovalDecision => ({ behavior: "deny" });
    const cancelled = new Promise<EngineApprovalDecision>((resolve) => {
      cancelWait = () => resolve(deny());
      if (signal.aborted) cancelWait(); else signal.addEventListener("abort", cancelWait, { once: true });
    });
    try {
      const toolInput = this.buildApprovalToolInput(request.method, params);
      const decision = await Promise.race([cancelled, Promise.resolve().then(async () => {
        if (signal.aborted) return deny();
        await owner.onEngineEvent?.({ type: "permission_request", toolName, toolInput,
          ...(this.readString(params.itemId) ? { toolUseId: this.readString(params.itemId)! } : {}), sessionId: threadId });
        if (signal.aborted) return deny();
        return owner.onApprovalRequest ? owner.onApprovalRequest({
          engine: "codex", toolName, toolInput, approvalScopes: { once: "once", session: "session" },
          cwd: this.readString(params.cwd) ?? undefined, sessionId: threadId, abortSignal: signal,
        }) : deny();
      }).catch((error) => {
        if (pending && generation === this.childGeneration && !active.resolved && !signal.aborted) {
          pending.errorMessage = error instanceof Error ? error.message : String(error);
        }
        return deny();
      })]);
      if (generation === this.childGeneration && !active.resolved) {
        this.respondToServerRequest(request.id, { decision: this.toAppServerApprovalDecision(signal.aborted ? deny() : decision) });
      }
    } finally {
      signal.removeEventListener("abort", cancelWait);
      owner.interactionAbortController.signal.removeEventListener("abort", abort);
      if (this.interactiveRequests.get(request.id) === active) this.interactiveRequests.delete(request.id);
    }
  }

  private buildApprovalToolInput(method: string, params: Record<string, unknown>): Record<string, unknown> {
    const toolInput: Record<string, unknown> = {
      method,
      raw: params,
    };
    for (const key of ["command", "reason", "itemId", "turnId", "cwd", "approvalId"]) {
      const value = this.readString(params[key]);
      if (value) {
        toolInput[key] = value;
      }
    }
    return toolInput;
  }

  private toAppServerApprovalDecision(decision: EngineApprovalDecision): "accept" | "acceptForSession" | "decline" {
    if (decision.behavior !== "allow") {
      return "decline";
    }
    return decision.scope === "session" ? "acceptForSession" : "accept";
  }

  private respondToServerRequest(id: JsonRpcId, result: unknown): void {
    this.writeJsonRpc({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private rejectServerRequest(id: JsonRpcId, message: string): void {
    this.writeJsonRpc({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message,
      },
    });
  }

  private writeJsonRpc(payload: Record<string, unknown>): void {
    try {
      this.child?.stdin?.write(JSON.stringify(payload) + "\n");
    } catch {
      // The existing turn timeout/error path will surface the closed child.
    }
  }

  private failPendingTurn(threadId: string, message: string): void {
    const pending = this.pendingTurns.get(threadId);
    if (!pending) {
      return;
    }

    // Thread-scoped: reject and evict only THIS thread. The child is shared by
    // every concurrent conversation, so we must NOT destroy() it for one
    // thread's fault (e.g. an unsupported server request) — that would tear down
    // unrelated healthy turns. Genuine child-level faults (close/error/oversized
    // protocol line) still failAllPending via their own handlers, and a wedged
    // child is caught by the next thread/resume|read timeout (destroyOnTimeout).
    this.pendingTurns.delete(threadId);
    this.loadedThreads.delete(threadId);
    this.drainUnidentifiedTurnLines(pending, message);
    pending.reject(this.withDiagnostics(this.withAppServerState(message, threadId, pending), pending.stderrOffset));
    this.notifyIdleWaitersIfIdle();
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    options?: { idleBlocking?: boolean; timeoutMs?: number; timeoutMessage?: string; destroyOnTimeout?: boolean; signal?: AbortSignal },
  ): Promise<unknown> {
    const child = this.child;
    const stdin = child?.stdin;

    if (!stdin) {
      return Promise.reject(new Error("codex app-server is not running"));
    }

    const id = this.nextRequestId++;
    const requestChildGeneration = this.childGeneration;
    const requestThreadId = this.readString(params.threadId) ?? undefined;
    const requestCreatedAt = Date.now();
    this.lastRequestDiagnostic = {
      at: requestCreatedAt,
      id,
      method,
      threadId: requestThreadId,
      childGeneration: requestChildGeneration,
    };
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const abort = () => rejectOnce(options?.signal?.reason ?? new Error("Request aborted"));
      const idleBlocking = options?.idleBlocking !== false;
      const resolveOnce = (value: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        options?.signal?.removeEventListener("abort", abort);
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        this.nonBlockingRequestIds.delete(id);
        resolve(value);
      };
      const rejectOnce = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        options?.signal?.removeEventListener("abort", abort);
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        this.pendingRequests.delete(id);
        this.nonBlockingRequestIds.delete(id);
        this.notifyIdleWaitersIfIdle();
        reject(error);
      };

      if (!idleBlocking) {
        this.nonBlockingRequestIds.add(id);
      }
      this.pendingRequests.set(id, {
        resolve: resolveOnce,
        reject: rejectOnce,
        method,
        threadId: requestThreadId,
        createdAt: requestCreatedAt,
        childGeneration: requestChildGeneration,
      });
      if (options?.signal?.aborted) { abort(); return; }
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (typeof options?.timeoutMs === "number" && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          const timeoutMessage = options.timeoutMessage
            ?? `codex app-server ${method} timed out after ${options.timeoutMs}ms`;
          rejectOnce(this.createRequestTimeoutError(method, timeoutMessage, requestChildGeneration));
          if (options.destroyOnTimeout) {
            queueMicrotask(() => {
              // Carry the timeout as the destroy reason: turns swept up by this
              // respawn otherwise surface a bare "Adapter destroyed" instead of
              // the request timeout that actually caused it.
              this.destroy(requestChildGeneration, timeoutMessage);
            });
          }
        }, options.timeoutMs);
      }

      try {
        stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }) + "\n",
          (error) => {
            if (error) {
              rejectOnce(error);
            }
          },
        );
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private currentSearchPlan(): NativeSearchMcpPlan | null {
    return this.searchPlan?.childGeneration === this.childGeneration ? this.searchPlan.plan : null;
  }

  /** Thread-scoped overrides adding the managed search MCP, unless the
   * effective configuration already has a search MCP or disabled one. A
   * failed config/read cannot rule out a duplicate, so it adds nothing. */
  private managedSearchConfig(cwd: string): Promise<Record<string, unknown>> {
    const plan = this.currentSearchPlan();
    if (!plan) return Promise.resolve({});
    const key = `${this.childGeneration}\0${cwd}`;
    const cached = this.searchThreadConfig.get(key);
    if (cached) return cached;
    // Optional check: a short bound keeps a slow read from delaying the turn.
    const pending = this.request("config/read", { cwd, includeLayers: false }, {
      timeoutMs: Math.min(this.threadReadTimeoutMs, CODEX_SEARCH_CONFIG_READ_TIMEOUT_MS),
      timeoutMessage: "Codex app-server config/read timed out",
    }).then((read) => {
      const config = (read as { config?: unknown } | null)?.config;
      if (!config || typeof config !== "object" || Array.isArray(config)) return {};
      const servers = (config as { mcp_servers?: unknown }).mcp_servers;
      if (servers !== undefined && servers !== null && (typeof servers !== "object" || Array.isArray(servers))) return {};
      const entries = Object.entries(servers ?? {}).map(([name, server]) => ({ name, server: (server && typeof server === "object" && !Array.isArray(server) ? server : {}) as Record<string, unknown> }));
      return searchMcpBlocksManaged(entries) ? {} : codexManagedSearchConfig(plan);
    }, () => {
      this.searchThreadConfig.delete(key);
      console.error("[search] Codex configuration unavailable; not adding the managed Search MCP.");
      return {};
    });
    this.searchThreadConfig.set(key, pending);
    return pending;
  }

  private async startThread(cwd: string = this.cwd, appTools?: AppPlatformTools): Promise<string> {
    const searchConfig = await this.managedSearchConfig(cwd);
    const result = (await this.request(
      "thread/start",
      {
        cwd,
        ...(this.configPath ? { sandbox: this.currentApprovalMode === "bypass" ? "danger-full-access" : "workspace-write" } : {}),
        ...(Object.keys(searchConfig).length > 0 ? { config: searchConfig } : {}),
        approvalPolicy: "never",
        experimentalRawEvents: false,
        persistExtendedHistory: true,
        ...(appTools ? { dynamicTools: appTools.definitions.map((tool) => ({ type: "function", ...tool })) } : {}),
      },
      {
        timeoutMs: this.threadReadTimeoutMs,
        timeoutMessage: `Codex app-server thread/start timed out after ${Math.max(1, Math.round(this.threadReadTimeoutMs / 1000))} seconds`,
        destroyOnTimeout: true,
      },
    )) as { thread?: { id?: string } };

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("codex app-server did not return a thread id");
    }

    this.loadedThreads.add(threadId);
    // A failed capability receipt must not lose a newly created session. The
    // next isRegistered check selects the compatible prompt for that thread.
    await appTools?.register(threadId).catch(() => undefined);
    return threadId;
  }

  private async ensureThreadLoaded(threadId: string, cwd: string = this.cwd): Promise<string> {
    if (this.loadedThreads.has(threadId)) {
      return threadId;
    }

    const requestGeneration = this.childGeneration;
    const searchConfig = await this.managedSearchConfig(cwd);
    let result: { thread?: { id?: string } };
    try {
      result = (await this.request(
        "thread/resume",
        {
          threadId,
          // A resumed thread can retain its former full-access sandbox.
          ...(this.configPath ? { sandbox: this.currentApprovalMode === "bypass" ? "danger-full-access" : "workspace-write" } : {}),
          ...(Object.keys(searchConfig).length > 0 ? { config: searchConfig } : {}),
          approvalPolicy: "never",
          excludeTurns: true,
        },
        {
          timeoutMs: this.threadReadTimeoutMs,
          timeoutMessage: `Codex app-server thread/resume timed out after ${Math.max(1, Math.round(this.threadReadTimeoutMs / 1000))} seconds`,
          destroyOnTimeout: true,
        },
      )) as { thread?: { id?: string } };
    } catch (error) {
      const threadResumeError = error instanceof Error ? error : new Error(String(error));
      if (isActiveWriterConflict(threadResumeError)) {
        throw await this.describeActiveWriterConflict(threadId, threadResumeError, requestGeneration);
      }
      throw threadResumeError;
    }
    const resumedThreadId = result.thread?.id;

    if (!resumedThreadId) {
      throw new Error(`codex app-server could not resume thread ${threadId}`);
    }

    this.loadedThreads.add(resumedThreadId);
    return resumedThreadId;
  }

  private async resolveThreadForMessage(threadId: string, cwd: string = this.cwd, appTools?: AppPlatformTools): Promise<string> {
    try {
      return await this.ensureThreadLoaded(threadId, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/thread not found|no rollout found/i.test(message)) {
        return await this.startThread(cwd, appTools);
      }

      throw error;
    }
  }

  private async resolveThreadForMessageWithRetry(
    sessionId: string,
    runtimeOptions: Awaited<ReturnType<CodexAppServerAdapter["loadRuntimeOptions"]>>,
    cwd: string = this.cwd,
    appTools?: AppPlatformTools,
  ): Promise<string> {
    return this.retryThreadReadAfterTimeout(
      () => isLogicalTelegramSessionId(sessionId)
        ? this.startThread(cwd, appTools)
        : this.resolveThreadForMessage(sessionId, cwd, appTools),
      runtimeOptions,
    );
  }

  private async prepareThreadForTurn(threadId: string, cwd: string, appTools?: AppPlatformTools, onEngineEvent?: CodexUserMessageInput["onEngineEvent"], abortSignal?: AbortSignal): Promise<string> {
    // A compaction past its wait deadline still owns this thread until its
    // terminal receipt or a child recycle. Never start a second compaction or a
    // turn beside it, and say which of those two states applies.
    const unconfirmed = this.pendingCompactions.get(threadId);
    if (unconfirmed?.timedOut) {
      throw this.compactionPendingError(unconfirmed, unconfirmed.expired ? "recovering" : "waiting");
    }
    // A second surface can reach the same engine thread without sharing the
    // bridge's logical conversation lock. Never compact underneath the live
    // writer; startTurn will reject the duplicate before it can overwrite the
    // first PendingTurn.
    if (this.pendingTurns.has(threadId)) {
      return threadId;
    }
    // A self-running /goal owns this same thread outside the ordinary turn
    // queue. Compacting underneath it can terminate or misroute the pursuit;
    // leave its context lifecycle to Codex until the watcher settles.
    if (this.goalWatchers.has(threadId)) {
      return threadId;
    }
    const usage = this.threadContextUsage.get(threadId);
    const compactionInFlight = this.pendingCompactions.has(threadId);
    const contextPressure = usage
      ? usage.totalTokens / usage.modelContextWindow
      : 0;
    // An already stopped turn is refused by startTurn without new maintenance.
    if (abortSignal?.aborted || (!compactionInFlight && contextPressure < CODEX_APP_SERVER_AUTO_COMPACT_RATIO)) {
      return threadId;
    }

    // No PendingTurn exists yet, so native compaction notifications have no
    // foreground sink. Report this actual maintenance step to the waiting card.
    const id = randomUUID();
    const report = async (status: "started" | "completed" | "failed" | "unknown"): Promise<void> => {
      try { await onEngineEvent?.({ type: "context_compaction", id, status, sessionId: threadId }); }
      catch { /* Progress delivery must not change compaction or turn recovery. */ }
    };
    await report("started");
    try {
      await this.waitForCompaction(threadId, abortSignal);
      await report("completed");
      return threadId;
    } catch (error) {
      if (error instanceof EngineContextCompactionPendingError || abortSignal?.aborted) {
        // A local deadline or Stop is not an engine failure. Keep the original
        // writer tracked until its terminal receipt; retries must not start a
        // second compaction or silently abandon the user's existing context.
        await report("unknown");
        throw error;
      }
      await report("failed");
      // Compaction is preventive, not a reason to strand the user's message. If
      // the old CLI does not implement the RPC or reports a terminal failure,
      // retire only this saturated thread and continue in a clean one.
      console.error(
        `Codex app-server context compaction failed for ${threadId}; starting a fresh thread: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.threadContextUsage.delete(threadId);
      this.loadedThreads.delete(threadId);
      return await this.startThread(cwd, appTools);
    }
  }

  /** Stop ends this turn's wait only. The native operation stays tracked, so a
   * following message joins it instead of compacting the same thread twice. */
  private waitForCompaction(threadId: string, abortSignal?: AbortSignal): Promise<void> {
    const aborted = () => new Error("Codex app-server turn aborted during context compaction");
    // Stop can land while "started" is being reported. A stopped turn never
    // begins maintenance, and an earlier abort event is not replayed to a listener.
    if (abortSignal?.aborted) {
      return Promise.reject(aborted());
    }
    const compaction = this.compactThread(threadId);
    if (!abortSignal) {
      return compaction;
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(aborted());
      abortSignal.addEventListener("abort", onAbort, { once: true });
      void compaction.then(resolve, reject).finally(() => abortSignal.removeEventListener("abort", onAbort));
      if (abortSignal.aborted) onAbort();
    });
  }

  private compactThread(threadId: string): Promise<void> {
    const existing = this.pendingCompactions.get(threadId);
    if (existing) {
      return existing.promise;
    }

    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Timers and the RPC callback are bound to this object, never to whatever
    // later operation occupies the same thread key. Both deadlines are relative
    // timers armed now, so wall-clock corrections cannot move them.
    const pending: PendingCompaction = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeout: setTimeout(() => this.timeoutCompaction(threadId, pending), CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS),
      ceiling: setTimeout(() => this.expireCompaction(threadId, pending), CODEX_APP_SERVER_COMPACTION_CEILING_MS),
      childGeneration: this.childGeneration,
      startedAt: Date.now(),
    };
    pending.timeout.unref?.();
    pending.ceiling?.unref?.();
    this.pendingCompactions.set(threadId, pending);

    void this.request("thread/compact/start", { threadId }, {
      idleBlocking: false,
      timeoutMs: CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS,
      timeoutMessage: `Codex app-server thread/compact/start timed out after ${Math.max(
        1,
        Math.round(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS / 1000),
      )} seconds`,
    }).catch((error) => {
      if (this.pendingCompactions.get(threadId) !== pending) return;
      if (error instanceof CodexAppServerRequestTimeoutError) {
        this.timeoutCompaction(threadId, pending);
        return;
      }
      this.settleCompaction(threadId, error instanceof Error ? error : new Error(String(error)));
    });

    return promise;
  }

  /** A goal starts autonomous native writes. Unlike an ordinary message it
   * cannot join a compaction, so any operation on the thread refuses it until
   * a terminal receipt or child recycle. Reading or clearing goals stays open. */
  private assertNoCompaction(threadId: string): void {
    const pending = this.pendingCompactions.get(threadId);
    if (pending) {
      throw this.compactionPendingError(pending, pending.expired ? "recovering" : "waiting");
    }
  }

  private compactionPendingError(pending: PendingCompaction, state: EngineContextCompactionPendingError["state"]): EngineContextCompactionPendingError {
    const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
    if (state === "recovering") {
      return new EngineContextCompactionPendingError(
        `Codex context compaction reported no result within ${minutes(CODEX_APP_SERVER_COMPACTION_CEILING_MS)} minutes; the app-server restarts once its other work finishes, then resumes the original thread`,
        state,
        CODEX_APP_SERVER_COMPACTION_CEILING_MS,
      );
    }
    if (state === "waiting") {
      return new EngineContextCompactionPendingError(
        `Codex context compaction started ${minutes(Date.now() - pending.startedAt)} minutes ago is still unconfirmed; no second compaction was started and the original thread is preserved`,
        state,
        CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS,
      );
    }
    return new EngineContextCompactionPendingError(
      `Codex context compaction has not confirmed completion after ${minutes(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS)} minutes; its result is unknown and the original thread is preserved`,
      state,
      CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS,
    );
  }

  private timeoutCompaction(threadId: string, pending: PendingCompaction): void {
    if (this.pendingCompactions.get(threadId) !== pending || pending.timedOut) return;
    pending.timedOut = true;
    clearTimeout(pending.timeout);
    // Reject this wait, not the native operation. A late compacted/completed
    // notification (or app-server exit) still owns cleanup and idle admission
    // until the ceiling; then the child is recycled when nothing else runs.
    pending.reject(this.compactionPendingError(pending, "timed-out"));
  }

  private expireCompaction(threadId: string, pending: PendingCompaction): void {
    if (this.pendingCompactions.get(threadId) !== pending || pending.expired || pending.childGeneration !== this.childGeneration) return;
    // The wait deadline is shorter; this only guards a skipped timer callback.
    if (!pending.timedOut) this.timeoutCompaction(threadId, pending);
    pending.expired = true;
    pending.ceiling = undefined;
    console.error(
      `Codex app-server context compaction for ${threadId} reported no terminal state within ${Math.round(
        CODEX_APP_SERVER_COMPACTION_CEILING_MS / 60_000,
      )} minutes; recycling the app-server once its other work is idle, then resuming the original thread`,
    );
    // The thread stays fenced. Other work continues; the child is replaced only
    // when no unrelated turn, goal, request or live compaction would be cut off.
    this.notifyIdleWaitersIfIdle();
  }

  private settleCompaction(threadId: string, error?: Error): void {
    const pending = this.pendingCompactions.get(threadId);
    if (!pending) {
      return;
    }

    this.pendingCompactions.delete(threadId);
    if (pending.turnId) {
      this.rememberCompactionTurnId(pending.turnId);
    }
    clearTimeout(pending.timeout);
    clearTimeout(pending.ceiling);
    if (error) {
      pending.reject(error);
    } else {
      // A later normal turn will publish a fresh usage snapshot. Deleting the
      // pre-compaction high-water mark prevents an immediate second compaction.
      this.threadContextUsage.delete(threadId);
      pending.resolve();
    }
    this.notifyIdleWaitersIfIdle();
  }

  private async retryThreadReadAfterTimeout<T>(
    operation: () => Promise<T>,
    runtimeOptions: Awaited<ReturnType<CodexAppServerAdapter["loadRuntimeOptions"]>>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isThreadReadTimeoutError(error)) {
        throw error;
      }
      // The destroy below rejects every pending turn with the generic "Adapter
      // destroyed"; for the turn that actually hit the read timeout that hides
      // the diagnosable cause. Pass the real reason so those rejections keep it.
      this.destroy(error.childGeneration, error.message);
      await this.ensureInitialized(runtimeOptions);
      return await operation();
    }
  }

  private async startTurn(
    threadId: string,
    prompt: string,
    onProgress?: (partialText: string) => void,
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>,
    approvalMode: ApprovalMode = this.currentApprovalMode,
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>,
    abortSignal?: AbortSignal,
    timeoutMs: number | null = this.turnTimeoutMs,
    appPlatformTools?: AppPlatformTools,
    appContext?: string,
    /** A side turn owns no parent approvals/questions; delivery uses its own receiver. */
    side = false,
    /** Native input items after the prompt, e.g. side `localImage` attachments. */
    extraInput: Array<Record<string, unknown>> = [],
    /** turn/start `model`/`effort`; Codex keeps them for this thread's later turns. */
    turnSettings: { model?: string; effort?: string } = {},
    executionContext?: string,
  ): Promise<{ text: string; usage?: AdapterUsage }> {
    if (this.pendingTurns.has(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an in-flight turn`);
    }
    // Forward command approvals only in "normal" mode; in bypass/full-auto the user
    // opted out, so the turn runs with approvalPolicy "never" and Codex never asks
    // (mirrors the `approvalMode === "normal"` gate in the Claude/Antigravity/process
    // adapters). Without this, even a yolo/bypass instance prompted for e.g. rm -rf.
    const gatedApprovalRequest = !side && approvalMode === "normal" ? onApprovalRequest : undefined;
    const pending = await new Promise<{ text: string; usage?: AdapterUsage }>((resolve, reject) => {
      const turnErrorPrefix = "Codex app-server turn";
      const rejectAndCleanup = (error: Error) => {
        pendingTurn.interactionAbortController.abort();
        pendingTurn.timeout && clearTimeout(pendingTurn.timeout);
        pendingTurn.timeout = undefined;
        pendingTurn.inactivityTimeout && clearTimeout(pendingTurn.inactivityTimeout);
        pendingTurn.inactivityTimeout = undefined;
        pendingTurn.abortCleanup?.();
        pendingTurn.abortCleanup = undefined;
        this.forgetTurnId(pendingTurn);
        reject(error);
      };
      const resolveAndCleanup = (result: { text: string; usage?: AdapterUsage }) => {
        pendingTurn.interactionAbortController.abort();
        pendingTurn.timeout && clearTimeout(pendingTurn.timeout);
        pendingTurn.timeout = undefined;
        pendingTurn.inactivityTimeout && clearTimeout(pendingTurn.inactivityTimeout);
        pendingTurn.inactivityTimeout = undefined;
        pendingTurn.abortCleanup?.();
        pendingTurn.abortCleanup = undefined;
        this.forgetTurnId(pendingTurn);
        resolve(result);
      };
      const pendingTurn: PendingTurn = {
        threadId,
        chunks: [],
        generatedImageTags: [],
        stderrOffset: this.stderrSeenChars,
        startedAt: Date.now(),
        onProgress,
        onEngineEvent,
        onApprovalRequest: gatedApprovalRequest,
        onUserInputRequest: side ? undefined : onApprovalRequest,
        appPlatformTools,
        interactionAbortController: new AbortController(),
        inactivityTimeoutDisabled: timeoutMs === null,
        ...(side ? { ephemeral: true } : {}),
        resolve: resolveAndCleanup,
        reject: rejectAndCleanup,
      };
      // Thread-scoped abort: reject and evict only this turn's thread. Never
      // destroy() the shared child for one turn's timeout/abort — that would
      // kill other concurrent conversations. A truly wedged child is still
      // caught by the next thread/resume|thread/read request (destroyOnTimeout).
      // turn/interrupt tells the app-server to stop executing server-side too;
      // without it the engine kept running the turn after /stop.
      const abortTurn = (error: Error) => {
        const pendingTurnState = this.pendingTurns.get(threadId);
        // Another turn owning the thread does not mean this one is gone: it may
        // still be tracked by its own turn id (overlapping turns on one thread).
        if (pendingTurnState && pendingTurnState !== pendingTurn && !this.isPendingTurnTracked(threadId, pendingTurn)) {
          return;
        }

        if (pendingTurnState === pendingTurn) {
          this.pendingTurns.delete(threadId);
        }
        this.loadedThreads.delete(threadId);
        if (!pendingTurn.turnId) {
          // No id yet: the interrupt cannot be addressed. Remember to send it
          // when the turn/start response resolves the id, or the server-side
          // turn keeps running and wedges the thread's writer.
          pendingTurn.abortedBeforeTurnId = true;
        }
        this.interruptTurn(threadId, pendingTurn.turnId);
        this.drainUnidentifiedTurnLines(pendingTurn, error.message);
        pendingTurn.reject(error);
        this.notifyIdleWaitersIfIdle();
      };

      if (timeoutMs !== null) {
        pendingTurn.timeout = setTimeout(() => {
          abortTurn(
            this.withDiagnostics(
              this.withAppServerState(
                `${turnErrorPrefix} timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`,
                threadId,
                pendingTurn,
              ),
              pendingTurn.stderrOffset,
            ),
          );
        }, timeoutMs);
      }

      this.pendingTurns.set(threadId, pendingTurn);
      this.scheduleTurnInactivityTimeout(
        threadId,
        pendingTurn,
        timeoutMs === null ? null : this.turnInactivityTimeoutMs,
      );

      if (abortSignal) {
        const onAbort = () => {
          abortTurn(new Error(`${turnErrorPrefix} aborted`));
        };
        pendingTurn.abortCleanup = () => abortSignal.removeEventListener("abort", onAbort);
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
      const turnStartGeneration = this.childGeneration;
      const starts = this.unresolvedTurnStarts.get(threadId) ?? new Set<PendingTurn>();
      starts.add(pendingTurn);
      this.unresolvedTurnStarts.set(threadId, starts);
      const forgetStart = () => {
        starts.delete(pendingTurn);
        if (starts.size === 0 && this.unresolvedTurnStarts.get(threadId) === starts) this.unresolvedTurnStarts.delete(threadId);
      };
      this.request("turn/start", {
        threadId,
        // Each side keeps its negotiated policy. Never use parent callbacks or
        // change the parent thread when enabling tools on an ephemeral fork.
        ...(side
          ? { approvalPolicy: "never", ...(this.sideThreads.get(threadId)?.tools === "inherited"
              ? (this.configPath ? { sandboxPolicy: approvalMode === "bypass" ? { type: "dangerFullAccess" } : { type: "workspaceWrite", networkAccess: true } } : {})
              : { sandboxPolicy: { type: "readOnly", networkAccess: false } }) }
          : {
            approvalPolicy: resolveTurnApprovalPolicy(approvalMode),
            ...(this.configPath ? { sandboxPolicy: { type: approvalMode === "bypass" ? "dangerFullAccess" : "workspaceWrite" } } : {}),
          }),
        ...(appContext || executionContext ? { additionalContext: {
          ...(appContext ? { "tarocub.app": { kind: "application", value: appContext } } : {}),
          ...(executionContext ? { "tarobot.execution": { kind: "application", value: executionContext } } : {}),
        } } : {}),
        ...turnSettings,
        input: [
          {
            type: "text",
            text: prompt,
            text_elements: [],
          },
          ...extraInput,
        ],
      }, {
        idleBlocking: false,
      }).then((result) => {
        forgetStart();
        // The turn/start response carries the turn id immediately (the turn
        // itself runs async); capture it so abort/inactivity can interrupt and so
        // this turn's notifications can be told apart from any other turn running
        // on the same thread. This response is id-correlated, so it is the
        // authoritative source for the turn id.
        const turn = (result as { turn?: { id?: unknown } } | null | undefined)?.turn;
        const startedTurnId = turn && typeof turn.id === "string" ? turn.id : undefined;
        if (this.isPendingTurnTracked(threadId, pendingTurn) && !pendingTurn.turnId) {
          if (startedTurnId) {
            this.registerTurnId(pendingTurn, startedTurnId);
          }
        } else if (pendingTurn.abortedBeforeTurnId && startedTurnId) {
          // The turn was aborted during the id-unknown window: it is no longer
          // tracked, but the app-server started it anyway and still holds the
          // thread's writer. Interrupt it now that it is addressable.
          pendingTurn.abortedBeforeTurnId = false;
          pendingTurn.turnId = startedTurnId;
          this.rememberRetiredTurn(threadId, startedTurnId);
          const watcher = this.goalWatchers.get(threadId);
          if (watcher?.activeTurnId === startedTurnId) {
            watcher.activeTurnId = undefined;
            watcher.finalText = undefined;
            this.settleGoalAfterFinalTurn(threadId, watcher);
          }
          this.interruptTurn(threadId, startedTurnId);
          this.flushUnidentifiedTurnLines(pendingTurn);
        }
      }, (error) => {
        forgetStart();
        const pendingTurnState = this.pendingTurns.get(threadId);
        if (pendingTurnState !== pendingTurn) {
          pendingTurn.abortedBeforeTurnId = false;
          this.flushUnidentifiedTurnLines(pendingTurn);
          this.notifyIdleWaitersIfIdle();
          return;
        }
        this.pendingTurns.delete(threadId);
        this.notifyIdleWaitersIfIdle();
        const turnStartError = error instanceof Error ? error : new Error(String(error));
        if (isActiveWriterConflict(turnStartError)) {
          this.loadedThreads.delete(threadId);
          void this.describeActiveWriterConflict(threadId, turnStartError, turnStartGeneration)
            .then((diagnosedError) => {
              this.drainUnidentifiedTurnLines(pendingTurn, turnStartError.message);
              pendingTurn.reject(diagnosedError);
            });
          return;
        }
        this.drainUnidentifiedTurnLines(pendingTurn, turnStartError.message);
        // turn/started may already have named a native turn. Stop that turn
        // rather than leave it running unobserved; nothing is resent.
        if (pendingTurn.turnId) {
          this.rememberRetiredTurn(threadId, pendingTurn.turnId);
          this.interruptTurn(threadId, pendingTurn.turnId);
        }
        // A request-level RPC error does not provide a native terminal receipt
        // or a documented admission guarantee. Never infer safe input replay
        // from its message or the absence of a turn id.
        pendingTurn.reject(turnStartError);
      });
    });

    return pending;
  }

  private noteTurnActivity(threadId: string, method: string): void {
    const pending = this.pendingTurns.get(threadId);
    if (!pending) {
      return;
    }

    const now = Date.now();
    pending.lastActivityAt = now;
    pending.lastActivityMethod = method;
    this.lastTurnActivityDiagnostic = {
      at: now,
      method,
      threadId,
      childGeneration: this.childGeneration,
    };
    this.scheduleTurnInactivityTimeout(
      threadId,
      pending,
      pending.inactivityTimeoutDisabled ? null : this.turnInactivityTimeoutMs,
    );
  }

  private scheduleTurnInactivityTimeout(
    threadId: string,
    pending: PendingTurn,
    timeoutMs: number | null,
  ): void {
    pending.inactivityTimeout && clearTimeout(pending.inactivityTimeout);
    pending.inactivityTimeout = undefined;

    if (timeoutMs === null) {
      return;
    }

    pending.inactivityTimeout = setTimeout(() => {
      pending.inactivityTimeout = undefined;
      const pendingTurnState = this.pendingTurns.get(threadId);
      if (this.isPendingTurnTracked(threadId, pending)) {
        pending.lastInactivityAt = Date.now();
        if (pendingTurnState === pending) {
          this.pendingTurns.delete(threadId);
        }
        this.loadedThreads.delete(threadId);
        if (!pending.turnId) {
          pending.abortedBeforeTurnId = true;
        }
        this.interruptTurn(threadId, pending.turnId);
        this.drainUnidentifiedTurnLines(pending, "Codex app-server turn became inactive");
        pending.reject(
          this.withDiagnostics(
            this.withAppServerState(
              `Codex app-server turn became inactive after ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`,
              threadId,
              pending,
            ),
            pending.stderrOffset,
          ),
        );
        this.notifyIdleWaitersIfIdle();
        // Thread-scoped: do not destroy the shared child for one turn's
        // inactivity; other concurrent turns keep running. A wedged child is
        // caught by the next thread/resume|read timeout (destroyOnTimeout).
      }
    }, timeoutMs);
  }

  /**
   * Best-effort server-side stop for an aborted or inactive turn (verified
   * protocol method: turn/interrupt, requires threadId + turnId — codex 0.139
   * app-server JSON schema). Fire-and-forget: the local rejection already
   * happened; this only stops the engine from continuing to execute. turnId is
   * briefly unknown until the turn/start response arrives — in that window
   * there is no addressable turn to interrupt yet, so this is a no-op HERE;
   * the caller marks `abortedBeforeTurnId` and the `turn/start` response
   * handler sends the deferred interrupt once the id lands.
   */
  private async describeActiveWriterConflict(
    threadId: string,
    error: Error,
    childGeneration: number,
  ): Promise<CodexActiveWriterConflictError> {
    if (error instanceof CodexActiveWriterConflictError) {
      return error;
    }
    const ownPid = childGeneration === this.childGeneration ? this.child?.pid : undefined;
    const holder = await this.findWriterLockHolder({
      codexHome: resolveCodexHome(this.engineHomePath),
      threadId,
      ...(ownPid !== undefined ? { ownPid } : {}),
    }).catch(() => null);
    return new CodexActiveWriterConflictError(
      `${error.message}\n\n${renderThreadWriterLockDiagnosis(holder)}`,
      childGeneration,
      holder?.isOwnChild === true,
    );
  }

  private interruptTurn(threadId: string, turnId: string | undefined): void {
    if (!turnId || !this.child?.stdin) {
      return;
    }
    void this.request("turn/interrupt", { threadId, turnId }, {
      idleBlocking: false,
      timeoutMs: CODEX_APP_SERVER_TURN_INTERRUPT_TIMEOUT_MS,
    }).catch(() => {});
  }

  /**
   * Inject additional user input into this session's currently running turn
   * (verified protocol method: turn/steer, requires threadId + expectedTurnId
   * + input — codex 0.139 app-server JSON schema). The engine folds the text
   * into the active turn as a new user message and course-corrects. Returns
   * false when there is no addressable turn (none running, turnId not yet
   * known, or expectedTurnId no longer matches because the turn just ended) —
   * callers fall back to a normal queued message so the input is never lost.
   * pendingTurns is keyed by threadId; a bound session's id IS its thread id,
   * so a brand-new chat whose first turn has not persisted a binding yet
   * simply misses here and queues normally.
   */
  async steerActiveTurn(sessionId: string, input: { text: string; throwOnError?: boolean }): Promise<boolean> {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending?.turnId || !this.child?.stdin) {
      return false;
    }
    try {
      await this.request("turn/steer", {
        threadId: sessionId,
        expectedTurnId: pending.turnId,
        input: [{ type: "text", text: input.text }],
      }, {
        idleBlocking: false,
        timeoutMs: CODEX_APP_SERVER_TURN_STEER_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      if (input.throwOnError) throw error;
      return false;
    }
  }

  sideCapability(input?: { tools?: "inherited" }): SideCapability {
    // Images reach the model as `localImage` input items; other files are read
    // from host-private copies using the fork's negotiated tool policy.
    return { context: "native", concurrent: true, readOnly: input?.tools === "inherited" ? "advisory" : "enforced", ...(input?.tools === "inherited" ? { toolAccess: "inherited" as const, delivery: true as const } : {}), residue: "none", seesInProgressTurn: false, attachments: { images: true, files: "any", paths: true } };
  }

  /**
   * Native side conversation: an ephemeral `thread/fork` (Codex 0.163 `/side`
   * uses the same primitive). The parent thread, its binding and any active
   * turn are untouched. The fork stops before the parent's live turn. Legacy
   * callers get read-only; opt-in callers retain Bot tools. Both are ephemeral
   * and unsubscribe on dispose(), without borrowing parent approval handlers.
   */
  async openSideSession(input: { sourceSessionId: string; workspaceOverride?: string; tools?: "inherited"; abortSignal?: AbortSignal }): Promise<EngineSideSession> {
    const sourceThreadId = input.sourceSessionId;
    if (!sourceThreadId || isLogicalTelegramSessionId(sourceThreadId)) throw new Error("no_main_session");
    input.abortSignal?.throwIfAborted();
    await this.ensureInitialized(await this.loadRuntimeOptions());
    input.abortSignal?.throwIfAborted();
    const childGeneration = this.childGeneration;
    const cwd = input.workspaceOverride ?? this.cwd;
    // Modern sides inherit enabled tools and allow network research. Keep the
    // previous enforced read-only policy only for clients that did not opt in.
    // Overrides are fork-scoped, never written to the user's configuration.
    const config = input.tools === "inherited"
      ? { "features.multi_agent": false, "features.multi_agent_v2": false, web_search: "live", "sandbox_workspace_write.network_access": true, ...(await this.managedSearchConfig(cwd)) }
      : await this.sideToolPolicy(cwd);
    input.abortSignal?.throwIfAborted();
    const parentTurn = this.pendingTurns.get(sourceThreadId), parentGoal = this.goalWatchers.get(sourceThreadId);
    const parentTurnId = parentTurn?.turnId ?? parentGoal?.activeTurnId;
    // Native fork includes an admitted, unfinished turn unless given its
    // boundary. Cancelled starts remain unresolved until their late receipt;
    // a goal's known id cannot stand in for an unidentified foreground turn.
    // Keep this check next to request(), which writes the fork synchronously.
    if ([...(this.unresolvedTurnStarts.get(sourceThreadId) ?? [])].some(turn => !turn.turnId)
      || !parentTurn?.turnId && (this.activeTurnEntries.has(sourceThreadId) || parentTurn)
      || !parentTurnId && parentGoal) throw new Error("busy");
    let result: { thread?: { id?: unknown; ephemeral?: unknown } };
    try {
      result = (await this.request("thread/fork", {
        threadId: sourceThreadId,
        ephemeral: true,
        excludeTurns: true,
        cwd,
        ...(input.tools === "inherited"
          ? (this.configPath ? { sandbox: this.currentApprovalMode === "bypass" ? "danger-full-access" : "workspace-write" } : {})
          : { sandbox: "read-only" }),
        approvalPolicy: "never",
        config,
        ...(parentTurnId ? { beforeTurnId: parentTurnId } : {}),
      }, {
        timeoutMs: this.threadReadTimeoutMs,
        timeoutMessage: `Codex app-server thread/fork timed out after ${Math.max(1, Math.round(this.threadReadTimeoutMs / 1000))} seconds`,
      })) as typeof result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/thread not found|no rollout found/i.test(message)) throw new Error("no_main_session");
      throw error;
    }
    const threadId = typeof result.thread?.id === "string" ? result.thread.id : undefined;
    // Every later cleanup acts on this ID; it must never address the parent.
    if (!threadId || threadId === sourceThreadId) throw new Error("codex app-server did not return a distinct side thread id");
    if (result.thread?.ephemeral !== true) {
      // An older CLI may ignore `ephemeral`. Never present a persisted fork as
      // temporary: delete exactly the generated fork, then refuse.
      await this.request("thread/delete", { threadId }, { idleBlocking: false, timeoutMs: this.threadReadTimeoutMs }).catch(() => undefined);
      throw new Error("unsupported");
    }
    this.sideThreads.set(threadId, { childGeneration, disposed: false, ...(input.tools ? { tools: input.tools } : {}) });
    try {
      await this.request("thread/inject_items", {
        threadId,
        items: [{ type: "message", role: "user", content: [{ type: "input_text", text: input.tools === "inherited" ? `Side conversation boundary.\n\n${SIDE_TOOL_INSTRUCTIONS}` : CODEX_SIDE_BOUNDARY }] }],
      }, { timeoutMs: this.threadReadTimeoutMs });
      input.abortSignal?.throwIfAborted();
    } catch (error) {
      await this.disposeSideThread(threadId);
      throw error;
    }
    return {
      nativeId: threadId,
      send: async (turn) => {
        const side = this.sideThreads.get(threadId);
        if (!side || side.disposed || side.childGeneration !== this.childGeneration || !this.child) throw new Error("expired");
        turn.abortSignal.throwIfAborted();
        if (this.activeTurnEntries.has(threadId) || this.pendingTurns.has(threadId)) throw new Error("busy");
        this.activeTurnEntries.add(threadId);
        try {
          const answer = await this.startTurn(
            threadId,
            prependPrivateTurnInstructions(sideAttachmentPrompt(turn.text, turn.attachments, { paths: true, native: ["image"] }), turn.turnInstructions),
            undefined,
            turn.onEngineEvent,
            this.currentApprovalMode,
            undefined,
            turn.abortSignal,
            this.turnTimeoutMs,
            side.tools === "inherited" ? turn.appPlatformTools : undefined,
            undefined,
            true,
            (turn.attachments ?? []).filter((file) => file.kind === "image").map((file) => ({ type: "localImage", path: file.path })),
          );
          return { text: answer.text, usage: answer.usage };
        } finally {
          this.activeTurnEntries.delete(threadId);
          this.notifyIdleWaitersIfIdle();
        }
      },
      dispose: () => this.disposeSideThread(threadId),
    };
  }

  /** Fork-scoped overrides that leave a side conversation only the read-only
   * shell sandbox: every configured MCP server is disabled by name (flat keys
   * keep each server's transport intact), with apps, plugins, browser and
   * computer use, sub-agents and web search off. Fails closed when the
   * effective configuration cannot be read or a server name cannot be
   * addressed safely. */
  private async sideToolPolicy(cwd: string): Promise<Record<string, unknown>> {
    const read = (await this.request("config/read", { cwd, includeLayers: false }, {
      timeoutMs: this.threadReadTimeoutMs,
      timeoutMessage: "Codex app-server config/read timed out",
    })) as { config?: { mcp_servers?: unknown } } | null;
    const servers = read?.config?.mcp_servers;
    if (servers !== undefined && servers !== null && (typeof servers !== "object" || Array.isArray(servers))) throw new Error("unsupported");
    const names = Object.keys(servers ?? {});
    if (names.some((name) => !/^[A-Za-z0-9_-]{1,128}$/.test(name))) throw new Error("unsupported");
    // config/read omits thread-scoped servers, so the managed one is named and
    // disabled explicitly in case a fork inherits its parent's overrides.
    const searchPlan = this.currentSearchPlan();
    return {
      ...Object.fromEntries(names.map((name) => [`mcp_servers.${name}.enabled`, false])),
      ...(searchPlan ? { ...codexManagedSearchConfig(searchPlan), [`mcp_servers.${searchPlan.name}.enabled`]: false } : {}),
      features: {
        apps: false, plugins: false, computer_use: false, browser_use: false, browser_use_external: false,
        multi_agent: false, multi_agent_v2: false, code_mode_host: false, skill_mcp_dependency_install: false,
      },
      web_search: "disabled",
    };
  }

  private async disposeSideThread(threadId: string): Promise<void> {
    const side = this.sideThreads.get(threadId);
    if (!side || side.disposed) return;
    side.disposed = true;
    this.sideThreads.delete(threadId);
    // A replaced child already dropped this ephemeral thread with its memory.
    if (side.childGeneration !== this.childGeneration || !this.child) return;
    const pending = this.pendingTurns.get(threadId);
    if (pending) {
      if (!pending.turnId) pending.abortedBeforeTurnId = true;
      this.interruptTurn(threadId, pending.turnId);
      this.failPendingTurn(threadId, "Codex side conversation closed");
    }
    // Like turn/interrupt, the release is best-effort and never delays a
    // close; an unsubscribed idle ephemeral thread is unloaded by Codex.
    void this.request("thread/unsubscribe", { threadId }, {
      idleBlocking: false,
      timeoutMs: CODEX_APP_SERVER_TURN_INTERRUPT_TIMEOUT_MS,
    }).catch(() => undefined);
  }

  private addGeneratedImageTag(pending: PendingTurn, threadId: string, filePath: string): void {
    const tag = sendImageTag(filePath);
    if (pending.generatedImageTags.includes(tag)) {
      return;
    }
    pending.generatedImageTags.push(tag);
    pending.finalText = appendUniqueSendImageTag(pending.finalText ?? pending.chunks.join(""), filePath);
    void Promise.resolve(pending.onEngineEvent?.({
      type: "assistant_text",
      text: tag,
      sessionId: threadId,
    })).catch(() => {});
  }

  private async completeTurn(threadId: string, turnId: string | undefined, pending: PendingTurn): Promise<void> {
    // Local bridge-side failures (for example, a rejected approval callback)
    // remain fatal. App-server `error` notifications are handled separately:
    // they may be retryable, so turn/completed is the authority for success.
    if (pending.errorMessage) {
      pending.reject(new Error(pending.errorMessage));
      return;
    }

    let text = pending.finalText ?? pending.chunks.join("");
    for (const tag of pending.generatedImageTags) {
      if (!text.includes(tag)) {
        text = [text.trim(), tag].filter(Boolean).join("\n");
      }
    }

    if (!text && pending.ephemeral) {
      pending.resolve({ text: "", usage: pending.usage });
      return;
    }

    if (!text) {
      const turnResult = await this.readTurnResult(threadId, turnId);
      if (turnResult.errorMessage) {
        pending.reject(new Error(turnResult.errorMessage));
        return;
      }

      text = turnResult.text;
      pending.usage = turnResult.usage ?? pending.usage;
    }

    if (!text.trim() && pending.errorMessage) {
      pending.reject(new Error(pending.errorMessage));
      return;
    }

    pending.resolve({ text, usage: pending.usage });
  }

  private async readTurnResult(
    threadId: string,
    turnId: string | undefined,
  ): Promise<{ text: string; usage?: AdapterUsage; errorMessage?: string }> {
    const result = (await this.request("thread/read", {
      threadId,
      includeTurns: true,
    }, {
      timeoutMs: this.threadReadTimeoutMs,
      timeoutMessage: `Codex app-server thread/read timed out after ${Math.max(1, Math.round(this.threadReadTimeoutMs / 1000))} seconds`,
      destroyOnTimeout: true,
    })) as {
      thread?: {
        turns?: Array<{
          id?: string;
          status?: string;
          error?: {
            message?: string;
          } | null;
          items?: Array<{
            type?: string;
            text?: string;
          } & Record<string, unknown>>;
        }>;
      };
    };

    const turns = result.thread?.turns ?? [];
    const targetTurn = turnId ? turns.find((turn) => turn.id === turnId) : turns.at(-1);
    if (turnId && !targetTurn) {
      return { text: "", errorMessage: "Codex turn result unavailable: the requested turn is missing; no other turn was substituted." };
    }

    const turnErrorMessage = this.readErrorMessage(targetTurn?.error);
    if (targetTurn?.status === "failed" && turnErrorMessage) {
      return {
        text: "",
        errorMessage: turnErrorMessage,
      };
    }

    const turnItems = readTurnItems(targetTurn?.items);
    let text = turnItems.text.trim();
    for (const generatedImagePath of turnItems.generatedImagePaths) {
      const tag = sendImageTag(generatedImagePath);
      if (!text.includes(tag)) {
        text = [text, tag].filter(Boolean).join("\n");
      }
    }
    return { text, usage: readTurnUsage(targetTurn) };
  }

  destroy(expectedChildGeneration?: number, reason?: string): void {
    if (expectedChildGeneration !== undefined && expectedChildGeneration !== this.childGeneration) {
      return;
    }
    this.terminateChild();
    // `reason` preserves a diagnosable cause (e.g. the thread/read timeout that
    // triggered the respawn); without it every pending turn was rejected with a
    // bare "Adapter destroyed" and the real failure was unrecoverable from chat.
    this.failAllPending(this.withDiagnostics(reason ?? "Adapter destroyed"));
    this.resetChildState();
  }

  /**
   * destroy() fires when the child is presumed wedged; a bare SIGTERM to the
   * direct child leaves its descendants (shells, MCP servers) running while a
   * replacement is spawned beside them — so kill the whole tree
   * (SIGTERM → grace → SIGKILL). Fakes without a pid fall back to kill().
   */
  private terminateChild(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    if (child.pid) {
      killProcessTree(child.pid);
    } else {
      child.kill?.();
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.nonBlockingRequestIds.clear();

    // Snapshot first: reject() runs the turn's cleanup, which mutates
    // pendingTurnsByTurnId while we iterate.
    for (const pending of new Set([...this.pendingTurns.values(), ...this.pendingTurnsByTurnId.values()])) {
      pending.reject(error);
    }
    this.pendingTurns.clear();
    this.pendingTurnsByTurnId.clear();
    this.completingTurns = 0;
    for (const watcher of this.goalWatchers.values()) {
      watcher.reject(error);
    }
    this.goalWatchers.clear();
    for (const threadId of [...this.pendingCompactions.keys()]) {
      this.settleCompaction(threadId, error);
    }
    this.threadContextUsage.clear();
    this.loadedThreads.clear();
    this.notifyIdleWaitersIfIdle();
  }

  private isIdle(): boolean {
    if (this.retryToolLeases.size) return false;
    for (const requestId of this.pendingRequests.keys()) {
      if (!this.nonBlockingRequestIds.has(requestId)) {
        return false;
      }
    }
    // A compaction past its ceiling stays fenced but no longer holds idle
    // admission; notifyIdleWaitersIfIdle recycles its child instead.
    for (const pending of this.pendingCompactions.values()) {
      if (!pending.expired) {
        return false;
      }
    }
    return (
      this.activeTurnEntries.size === 0 &&
      this.pendingTurns.size === 0 &&
      // A turn displaced from the thread key is still running.
      this.pendingTurnsByTurnId.size === 0 &&
      this.completingTurns === 0 &&
      this.goalWatchers.size === 0
    );
  }

  private async waitForIdle(): Promise<void> {
    if (this.isIdle()) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer);
        this.idleWaiters.delete(waiter);
        resolve();
      };
      const timer = setTimeout(() => {
        this.idleWaiters.delete(waiter);
        reject(new Error(`Codex app-server did not become idle within ${CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS}ms`));
      }, CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS);
      this.idleWaiters.add(waiter);
    });
  }

  private notifyIdleWaitersIfIdle(): void {
    if (!this.isIdle()) {
      return;
    }

    const deferredRecycle = this.deferredChildRecycle;
    if (deferredRecycle) {
      this.deferredChildRecycle = null;
      if (deferredRecycle.childGeneration === this.childGeneration) {
        this.destroy(deferredRecycle.childGeneration, deferredRecycle.reason);
        return;
      }
    }

    // Old writes from a compaction past its ceiling cannot be ruled out on this
    // child. Replace it now, while idle, so the fenced thread resumes on a clean
    // one; destroy settles the compaction and clears its stale usage.
    for (const pending of this.pendingCompactions.values()) {
      if (pending.expired && pending.childGeneration === this.childGeneration) {
        this.destroy(
          this.childGeneration,
          "Recycling Codex app-server after context compaction reported no terminal state; the original thread is preserved",
        );
        return;
      }
    }

    if (this.idleWaiters.size === 0) {
      return;
    }

    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  private deferChildRecycle(childGeneration: number, reason: string): void {
    if (childGeneration !== this.childGeneration) {
      return;
    }
    this.deferredChildRecycle = { childGeneration, reason };
    this.notifyIdleWaitersIfIdle();
  }

  private finishCompletingTurn(): void {
    this.completingTurns = Math.max(0, this.completingTurns - 1);
    this.notifyIdleWaitersIfIdle();
  }

  private rememberCompactionTurnId(turnId: string): void {
    this.settledCompactionTurnIds.add(turnId);
    if (this.settledCompactionTurnIds.size > 64) {
      const oldest = this.settledCompactionTurnIds.values().next().value;
      if (oldest !== undefined) {
        this.settledCompactionTurnIds.delete(oldest);
      }
    }
  }

  private rememberRetiredTurn(threadId: string, turnId: string): void {
    this.retiredTurnIds.add(`${threadId}:${turnId}`);
    if (this.retiredTurnIds.size > 256) this.retiredTurnIds.delete(this.retiredTurnIds.values().next().value!);
  }

  private resetChildState(): void {
    for (const active of this.interactiveRequests.values()) { active.resolved = true; active.controller.abort(); }
    this.interactiveRequests.clear();
    this.settledCompactionTurnIds.clear();
    this.retiredTurnIds.clear();
    this.settledTurnIds.clear();
    for (const release of [...this.retryToolLeases]) {
      this.retryToolLeases.delete(release);
      release();
    }
    this.unresolvedTurnStarts.clear();
    this.deferredChildRecycle = null;
    if (this.child !== null) {
      // Reject output from the retired child immediately, including the window
      // before a replacement child increments the generation during spawn.
      this.childGeneration += 1;
    }
    this.child = null;
    this.initializePromise = null;
    this.initializeKey = null;
    this.lineBuffer = "";
    this.stderrTail = "";
    this.stderrSeenChars = 0;
    this.stdoutDiagnosticTail = "";
    this.lastRequestDiagnostic = null;
    this.lastResponseDiagnostic = null;
    this.lastNotificationDiagnostic = null;
    this.lastTurnActivityDiagnostic = null;
  }

  private appendDiagnostic(channel: "stderr" | "stdout", chunk: string): void {
    const normalized = chunk.trim();
    if (!normalized) {
      return;
    }

    if (channel === "stderr") {
      this.stderrSeenChars += this.stderrTail ? normalized.length + 1 : normalized.length;
      this.stderrTail = this.appendTail(this.stderrTail, normalized);
      return;
    }

    this.stdoutDiagnosticTail = this.appendTail(this.stdoutDiagnosticTail, normalized);
  }

  private looksLikeJsonRpcLine(value: string): boolean {
    return /^\s*\{\s*(?:"jsonrpc"\s*:|"id"\s*:|"method"\s*:)/.test(value);
  }

  private appendOversizedStdoutDiagnostic(value: string): void {
    const suffix = value.slice(-MAX_DIAGNOSTIC_CHARS);
    this.appendDiagnostic(
      "stdout",
      `omitted oversized non-JSON stdout diagnostic (${value.length} chars):\n${suffix}`,
    );
  }

  private appendTail(existing: string, chunk: string): string {
    const next = existing ? `${existing}\n${chunk}` : chunk;
    return next.length > MAX_DIAGNOSTIC_CHARS
      ? next.slice(next.length - MAX_DIAGNOSTIC_CHARS)
      : next;
  }

  /** Stderr produced after the given stderrSeenChars offset (bounded by the
   * retained tail). Turn-scoped failures use this so stale pre-turn stderr
   * (e.g. an old "Reconnecting... 2/5" or 401 line) is not attributed to them. */
  private stderrTailSince(offset: number): string {
    const newChars = this.stderrSeenChars - offset;
    if (newChars <= 0) {
      return "";
    }
    return newChars >= this.stderrTail.length
      ? this.stderrTail
      : this.stderrTail.slice(this.stderrTail.length - newChars);
  }

  private withDiagnostics(message: string, stderrOffset?: number): Error {
    if (message.includes("[engine diagnostics]")) {
      return new Error(message);
    }

    const stderrTail = stderrOffset === undefined ? this.stderrTail : this.stderrTailSince(stderrOffset);
    const sections: string[] = [];
    if (stderrTail) {
      sections.push(`stderr:\n${stderrTail}`);
    }
    if (this.stdoutDiagnosticTail) {
      sections.push(`stdout:\n${this.stdoutDiagnosticTail}`);
    }

    if (sections.length === 0) {
      return new Error(message);
    }

    return new Error(`${message}\n\n[engine diagnostics]\n${sections.join("\n\n")}`);
  }

  private withAppServerState(message: string, threadId?: string, pending?: PendingTurn): string {
    if (message.includes("[app-server state]")) {
      return message;
    }

    return `${message}\n\n[app-server state]\n${this.renderAppServerState(threadId, pending)}`;
  }

  private renderAppServerState(threadId?: string, pending?: PendingTurn): string {
    const now = Date.now();
    const pendingRequests = [...this.pendingRequests.entries()]
      .map(([id, request]) => {
        const parts = [
          `id=${id}`,
          `method=${request.method}`,
          request.threadId ? `threadId=${request.threadId}` : null,
          `ageMs=${Math.max(0, now - request.createdAt)}`,
        ].filter(Boolean);
        return parts.join(" ");
      });

    return [
      pending && threadId
        ? `pending turn: threadId=${threadId} ageMs=${Math.max(0, now - pending.startedAt)} lastActivity=${pending.lastActivityAt ? `${new Date(pending.lastActivityAt).toISOString()} method=${pending.lastActivityMethod ?? "unknown"}` : "none"} lastInactivity=${pending.lastInactivityAt ? new Date(pending.lastInactivityAt).toISOString() : "none"}`
        : "pending turn: none",
      `last request: ${this.formatProtocolDiagnostic(this.lastRequestDiagnostic)}`,
      `last response: ${this.formatProtocolDiagnostic(this.lastResponseDiagnostic)}`,
      `last notification: ${this.formatProtocolDiagnostic(this.lastNotificationDiagnostic)}`,
      `last turn activity: ${this.formatProtocolDiagnostic(this.lastTurnActivityDiagnostic)}`,
      `pending requests: ${pendingRequests.length > 0 ? pendingRequests.join(", ") : "none"}`,
    ].join("\n");
  }

  private formatProtocolDiagnostic(entry: AppServerProtocolDiagnostic | null): string {
    if (!entry) {
      return "none";
    }

    const parts = [
      new Date(entry.at).toISOString(),
      typeof entry.id === "number" ? `id=${entry.id}` : null,
      `method=${entry.method}`,
      entry.threadId ? `threadId=${entry.threadId}` : null,
      entry.status ? `status=${entry.status}` : null,
      `childGeneration=${entry.childGeneration}`,
    ].filter(Boolean);
    return parts.join(" ");
  }

  private createRequestTimeoutError(method: string, message: string, childGeneration: number): Error {
    const withDiagnostics = this.withDiagnostics(this.withAppServerState(message)).message;
    if (method === "thread/start" || method === "thread/resume") {
      return new ThreadReadTimeoutError(withDiagnostics, childGeneration);
    }
    return new CodexAppServerRequestTimeoutError(withDiagnostics, childGeneration);
  }
}
