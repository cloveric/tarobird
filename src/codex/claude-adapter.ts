import { isLogicalSessionId } from "../runtime/logical-session.js";
import { claudeAssistantError, claudeError, claudeResultRepeatsError } from "./claude-errors.js";
import { spawnEngine } from "../runtime/engine-process.js";
import { readValidatedConfigFile } from "../state/instance-config.js";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
} from "./adapter.js";
import {
  CLAUDE_PERMISSION_MCP_TOOL_NAME,
  createClaudePermissionMcpConfig,
  resolveClaudePermissionMcpServerInvocation,
  startClaudePermissionHookServer,
  type ClaudePermissionHookServer,
} from "./claude-permission-hook.js";
import { createClaudeInstructionsFile } from "./claude-instructions-file.js";
import { killProcessTree } from "./process-tree.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../state/approval-mode.js";
import { mergeAllowedTurnExtraEnv } from "./turn-env.js";
import { prependPrivateTurnInstructions } from "./turn-instructions.js";
import { claudeNoResponseError, isClaudeNoResponsePlaceholder } from "./claude-turn-recovery.js";

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
  end(callback?: () => void): void;
  on?(event: "error", listener: (error: Error) => void): void;
};

type ClaudeChildProcess = {
  pid?: number;
  stdin?: Writable;
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: (signal?: string) => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnClaude = (command: string, args: string[], options: SpawnOptions) => ClaudeChildProcess;

function decodeProcessChunk(
  decoder: StringDecoder,
  chunk: Buffer | { toString(): string } | string,
): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk.toString();
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  error?: unknown;
  isApiErrorMessage?: boolean;
  api_error_status?: string | number | null;
  terminal_reason?: string;
  result?: string;
  session_id?: string;
  parent_tool_use_id?: string;
  origin?: { kind?: string } | null;
  total_cost_usd?: number;
  message?: {
    model?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const MAX_INSTRUCTIONS_CHARS = 16_000;

function isLogicalTelegramSessionId(sessionId: string): boolean {
  return isLogicalSessionId(sessionId);
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

function getAssistantText(event: ClaudeJsonResult | undefined): string {
  if (!event || event.type !== "assistant") {
    return "";
  }
  if (claudeAssistantError(event)) return "";

  if (event.message?.model === "<synthetic>" && event.message.content?.length === 1
    && isClaudeNoResponsePlaceholder(event.message.content[0]?.text)) return "";
  return event.message?.content
    ?.filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("")
    .trim() ?? "";
}

function appendAssistantText(existing: string, next: string): string {
  if (!next) {
    return existing;
  }

  return existing ? `${existing}\n${next}` : next;
}

function hasDeliveryTag(text: string): boolean {
  return /\[send-(?:file|image):[^\]]+\]/.test(text);
}

function extractDeliveryTags(text: string): string[] {
  return Array.from(text.matchAll(/\[send-(?:file|image):[^\]]+\]/g), (match) => match[0]);
}

function mergeIntermediateDeliveryText(finalResult: string, intermediateDeliveryText: string): string {
  if (!intermediateDeliveryText) {
    return finalResult;
  }

  if (!finalResult) {
    return intermediateDeliveryText;
  }

  if (finalResult.includes(intermediateDeliveryText)) {
    return finalResult;
  }

  if (intermediateDeliveryText.includes(finalResult)) {
    return intermediateDeliveryText;
  }

  const finalDeliveryTags = new Set(extractDeliveryTags(finalResult));
  const intermediateDeliveryTags = extractDeliveryTags(intermediateDeliveryText);
  if (
    intermediateDeliveryTags.length > 0 &&
    intermediateDeliveryTags.every((tag) => finalDeliveryTags.has(tag))
  ) {
    return finalResult;
  }

  return appendAssistantText(intermediateDeliveryText, finalResult);
}

function renderClaudeCliError(json: ClaudeJsonResult, stderr: string): string {
  const result = json.result?.trim();
  if (result) {
    return result;
  }

  if (stderr) {
    return stderr;
  }

  const details = [
    json.api_error_status ? `api_error_status=${json.api_error_status}` : undefined,
    json.subtype ? `subtype=${json.subtype}` : undefined,
    json.terminal_reason ? `terminal_reason=${json.terminal_reason}` : undefined,
  ].filter(Boolean);

  return details.length > 0
    ? `Unknown error from Claude CLI (${details.join(", ")})`
    : "Unknown error from Claude CLI";
}

function parseClaudeJsonOutput(trimmed: string): ClaudeJsonResult | ClaudeJsonResult[] {
  try {
    return JSON.parse(trimmed) as ClaudeJsonResult | ClaudeJsonResult[];
  } catch (jsonError) {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length <= 1) {
      throw jsonError;
    }

    try {
      return lines.map((line) => JSON.parse(line) as ClaudeJsonResult);
    } catch {
      throw jsonError;
    }
  }
}

export class ProcessClaudeAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "generic-file-blocks" as const;
  readonly supportsTurnScopedEnv = true;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnClaude: SpawnClaude;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  private readonly workspacePath: string | undefined;
  private readonly disallowedTools: string[];
  private readonly enableChromeIntegration: boolean;

  constructor(
    private readonly claudeExecutable: string,
    options?: {
      childEnv?: NodeJS.ProcessEnv;
      spawnFn?: SpawnClaude;
      instructionsPath?: string;
      configPath?: string;
      workspacePath?: string;
      engineHomePath?: string;
      disallowedTools?: string[];
      enableChromeIntegration?: boolean;
    },
  ) {
    this.childEnv = options?.childEnv ?? (() => {
      const env = { ...process.env };
      delete env.TELEGRAM_BOT_TOKEN;
      if (options?.engineHomePath) {
        env.CLAUDE_CONFIG_DIR = options.engineHomePath;
      }
      // Otherwise inherit CLAUDE_CONFIG_DIR from the parent env. If the user
      // runs their main Claude CLI with a custom config dir exported in their
      // shell, bots automatically track the same location. If nothing is
      // set, Claude uses its built-in default (~/.claude/).
      return env;
    })();

    this.spawnClaude = options?.spawnFn ?? (spawnEngine as unknown as SpawnClaude);
    this.instructionsPath = options?.instructionsPath;
    this.configPath = options?.configPath;
    this.workspacePath = options?.workspacePath;
    this.disallowedTools = options?.disallowedTools ?? [];
    this.enableChromeIntegration = options?.enableChromeIntegration === true;
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `tarobot-${chatId}` };
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

  private async loadEngineOptions(): Promise<{ approvalMode: ApprovalMode; permissionMode?: string; effort?: string; model?: string; chrome: boolean }> {
    if (!this.configPath) return { approvalMode: "normal", chrome: this.enableChromeIntegration };
    const parsed = await readValidatedConfigFile(this.configPath, { forExecution: true });
    return {
      approvalMode: normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE,
      permissionMode: parsed.claudePermissionMode ?? "manual",
      chrome: parsed.claudeChrome ?? this.enableChromeIntegration,
      effort: parsed.effort,
      model: parsed.model,
    };
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const agentInstructions = this.instructionsPath ? await this.loadInstructions() : null;
    const bridgeInstructions = input.instructions ?? null;
    const engineOptions: Awaited<ReturnType<typeof this.loadEngineOptions>> = this.configPath ? await this.loadEngineOptions() : { approvalMode: "normal", chrome: this.enableChromeIntegration };
    const approvalMode = engineOptions.approvalMode;

    // Build prompt with files
    const parts: string[] = [];
    parts.push(prependPrivateTurnInstructions(input.text, input.turnInstructions));
    for (const file of input.files) {
      parts.push(`Attachment: ${file}`);
    }
    const prompt = parts.join("\n");

    // Build args
    const args: string[] = ["-p", "--verbose", "--output-format", "stream-json"];
    args.push(engineOptions.chrome ? "--chrome" : "--no-chrome");

    // Resume existing session
    if (!isLogicalTelegramSessionId(sessionId)) {
      args.push("-r", sessionId);
    }

    // Approval mode
    if (approvalMode === "bypass") {
      args.push("--dangerously-skip-permissions");
    } else if (approvalMode === "full-auto") {
      args.push("--permission-mode", "bypassPermissions");
    } else if (engineOptions.permissionMode) {
      args.push("--permission-mode", engineOptions.permissionMode);
    }
    for (const toolName of this.disallowedTools) {
      args.push("--disallowedTools", toolName);
    }

    // Effort level
    if (engineOptions.effort) {
      args.push("--effort", engineOptions.effort);
    }

    // Model override
    if (engineOptions.model) {
      args.push("--model", engineOptions.model);
    }

    const combinedInstructions = combineInstructions(agentInstructions, bridgeInstructions);
    const instructionsFile = combinedInstructions ? await createClaudeInstructionsFile(combinedInstructions) : null;
    if (instructionsFile) {
      args.push("--append-system-prompt-file", instructionsFile.path);
    }

    // Workspace directory (where CLAUDE.md lives)
    const effectiveWorkspace = input.workspaceOverride ?? this.workspacePath;
    if (effectiveWorkspace) {
      args.push("--add-dir", effectiveWorkspace);
    }

    let permissionHookServer: ClaudePermissionHookServer | undefined;
    let permissionConfigFile: Awaited<ReturnType<typeof createClaudeInstructionsFile>>;
    let result: Awaited<ReturnType<ProcessClaudeAdapter["runClaudeCommand"]>>;
    try {
      if (approvalMode === "normal" && input.onApprovalRequest) {
        permissionHookServer = await startClaudePermissionHookServer(input.onApprovalRequest);
        const mcpInvocation = resolveClaudePermissionMcpServerInvocation();
        // The loopback capability URL contains a bearer secret. Keep it in a
        // private temporary file, never in process arguments visible to ps.
        permissionConfigFile = await createClaudeInstructionsFile(JSON.stringify(createClaudePermissionMcpConfig({
          ...mcpInvocation, approvalUrl: permissionHookServer.url,
        })), "app-mcp.json");
        args.push("--mcp-config", permissionConfigFile!.path, "--permission-prompt-tool", CLAUDE_PERMISSION_MCP_TOOL_NAME);
      }

      result = await this.runClaudeCommand(args, prompt, input.abortSignal, effectiveWorkspace, input.extraEnv);
    } finally {
      await permissionHookServer?.close();
      await permissionConfigFile?.cleanup().catch(() => {});
      await instructionsFile?.cleanup().catch(() => {});
    }
    const parsed = this.parseResult(result.stdout, {
      stderr: result.stderr,
      exitCode: result.exitCode,
    });

    return {
      text: parsed.text,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
    };
  }

  private parseResult(stdout: string, context: { stderr?: string; exitCode?: number | null } = {}): { text: string; sessionId?: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number } } {
    const trimmed = stdout.trim();
    const stderr = context.stderr?.trim() ?? "";
    const failedExitCode = context.exitCode !== undefined && context.exitCode !== null && context.exitCode !== 0;
    if (!trimmed) {
      if (failedExitCode) {
        throw new Error(stderr || `claude exited with code ${context.exitCode}`);
      }
      return { text: "Claude returned an empty response." };
    }

    try {
      const parsed = parseClaudeJsonOutput(trimmed);
      let json: ClaudeJsonResult | undefined;
      let assistantText = "";
      let assistantError: string | undefined;
      let intermediateDeliveryText = "";
      let sessionId: string | undefined;
      let lastAssistantWasPlaceholder = false;

      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          if (failedExitCode) {
            throw new Error(stderr || `claude exited with code ${context.exitCode}`);
          }
          return { text: "Claude returned an empty response." };
        }

        const parentEvents = parsed.filter(item => item && typeof item === "object"
          && !item.parent_tool_use_id && item.origin?.kind !== "task-notification");
        let sawResultEvent = false;
        for (const item of parentEvents) {
          if (!item || typeof item !== "object") {
            continue;
          }

          if (item.type === "result") {
            sawResultEvent = true;
          }

          if (item.session_id) {
            sessionId = item.session_id;
          }

          const text = getAssistantText(item);
          if (item.type === "assistant") assistantError = claudeAssistantError(item);
          if (item.type === "assistant") lastAssistantWasPlaceholder = item.message?.model === "<synthetic>"
            && item.message.content?.length === 1 && isClaudeNoResponsePlaceholder(item.message.content[0]?.text);
          if (text) {
            assistantText = appendAssistantText(assistantText, text);
            if (hasDeliveryTag(text)) {
              intermediateDeliveryText = appendAssistantText(intermediateDeliveryText, text);
            }
          }

          if (item.type === "result") {
            json = item;
          }
        }

        if (!json) {
          json = [...parentEvents].reverse().find(
            (item): item is ClaudeJsonResult => Boolean(item && typeof item === "object"),
          );
        }

        if (!sawResultEvent && failedExitCode) {
          throw claudeError(assistantError || stderr || `claude exited with code ${context.exitCode}`);
        }
      } else {
        if (parsed.parent_tool_use_id || parsed.origin?.kind === "task-notification") {
          throw new Error("Claude returned no foreground response; only child or background output was received");
        }
        json = parsed;
        sessionId = parsed.session_id ?? undefined;
        assistantText = getAssistantText(parsed);
        assistantError = claudeAssistantError(parsed);
        lastAssistantWasPlaceholder = parsed.type === "assistant" && parsed.message?.model === "<synthetic>"
          && parsed.message.content?.length === 1 && isClaudeNoResponsePlaceholder(parsed.message.content[0]?.text);
      }

      if (!json) {
        if (failedExitCode) {
          throw new Error(stderr || `claude exited with code ${context.exitCode}`);
        }
        return { text: "Claude returned an empty response.", sessionId };
      }

      if (json.is_error) {
        throw claudeError(json.result?.trim() || assistantError || renderClaudeCliError(json, stderr));
      }
      if (assistantError && claudeResultRepeatsError(assistantError, json.result)) throw claudeError(assistantError);
      if (json.type === "assistant" && assistantError) throw claudeError(assistantError);
      if (lastAssistantWasPlaceholder && (!json.result?.trim() || isClaudeNoResponsePlaceholder(json.result))) {
        throw claudeNoResponseError();
      }

      const usage = json.usage ? {
        inputTokens: json.usage.input_tokens ?? 0,
        outputTokens: json.usage.output_tokens ?? 0,
        cachedTokens: json.usage.cache_read_input_tokens ?? 0,
        costUsd: json.total_cost_usd ?? undefined,
      } : undefined;

      // Empty result usually means Claude ended the turn with an interactive
      // tool call (e.g. AskUserQuestion) that can't complete in headless mode.
      // Surface a hint rather than the misleading "completed the request"
      // message we used to return.
      const resultText = json.result?.trim() ?? "";
      // Claude stream-json can emit [send-file:] tags in intermediate assistant
      // messages while the final result only summarizes delivery.
      const finalText = resultText
        ? mergeIntermediateDeliveryText(resultText, intermediateDeliveryText)
        : assistantText
          ? assistantText
          : "(The engine produced no visible reply. If this keeps happening, the model may be calling an interactive tool like AskUserQuestion — ask it to reply in plain text instead.)";

      return {
        text: finalText,
        sessionId: json.session_id ?? sessionId,
        usage,
      };
    } catch (error) {
      // Re-throw real errors (e.g. is_error from Claude); only swallow JSON parse failures
      if (error instanceof SyntaxError) {
        if (failedExitCode) throw claudeError(stderr || `claude exited with code ${context.exitCode}`);
        return { text: trimmed };
      }
      throw error;
    }
  }

  private async runClaudeCommand(args: string[], stdinContent: string, abortSignal?: AbortSignal, cwdOverride?: string, extraEnv?: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const invocation = buildCommandInvocation(this.claudeExecutable, args);
    const child = this.spawnClaude(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: mergeAllowedTurnExtraEnv(this.childEnv, extraEnv),
      cwd: cwdOverride ?? this.workspacePath,
      windowsHide: true,
    });

    return await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let settled = false;
      let abortCleanup: (() => void) | undefined;

      const resolveOnce = (value: { stdout: string; stderr: string; exitCode: number | null }) => {
        if (settled) {
          return;
        }

        settled = true;
        abortCleanup?.();
        resolve(value);
      };

      const rejectOnce = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        abortCleanup?.();
        reject(error);
      };

      if (abortSignal) {
        const onAbort = () => {
          killProcessTree(child.pid);
          rejectOnce(new Error("Task was stopped by user"));
        };
        if (abortSignal.aborted) { onAbort(); return; }
        abortSignal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => abortSignal.removeEventListener("abort", onAbort);
      }

      child.stdout?.on("data", (chunk) => {
        stdout += decodeProcessChunk(stdoutDecoder, chunk);
      });

      child.stderr?.on("data", (chunk) => {
        stderr += decodeProcessChunk(stderrDecoder, chunk);
      });

      child.stdin?.on?.("error", (error) => {
        killProcessTree(child.pid);
        rejectOnce(error);
      });

      child.once("error", (error) => {
        rejectOnce(error);
      });
      child.once("close", (code) => {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        // Claude CLI returns exit code 1 for some API errors (e.g. 401 auth)
        // but still writes a valid {"is_error":true,"result":"..."} JSON to
        // stdout. Resolve with stdout in that case so parseResult() can
        // surface the real error message and its authentication classification.
        // One-shot JSON arrays carry the same structured diagnostics.
        if (code === 0 || (code !== null && (stdout.trim().startsWith("{") || stdout.trim().startsWith("[")))) {
          resolveOnce({ stdout, stderr, exitCode: code });
          return;
        }

        rejectOnce(new Error(stderr.trim() || `claude exited with code ${code}`));
      });

      child.stdin?.write(stdinContent, () => {
        child.stdin?.end();
      });
    });
  }
}
