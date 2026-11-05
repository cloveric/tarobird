import { randomUUID } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree } from "./process-tree.js";

/** Native Claude Code side questions (`control_request` subtype
 * `side_question`, Claude Code 2.1.x stream-json). The CLI answers from the
 * live session messages with no tools and never writes the exchange to the
 * transcript; the caller supplies earlier side exchanges as `history`. */
export type ClaudeSideExchange = { question: string; response: string };

/** The CLI returns its own timeout error after 11 minutes. */
export const CLAUDE_SIDE_QUESTION_TIMEOUT_MS = 12 * 60_000;
const SIDE_HISTORY_EXCHANGES = 40;
const SIDE_HISTORY_CHARS = 200_000;
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 8 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The process carrying a side question exited or was replaced. A side
 * question has no tools, so it can be asked again elsewhere without effects. */
export class ClaudeSideChannelClosedError extends Error {
  constructor(message = "Claude side question channel closed") { super(message); this.name = "ClaudeSideChannelClosedError"; }
}

export function boundedSideHistory(history: ClaudeSideExchange[]): ClaudeSideExchange[] {
  const kept = history.slice(-SIDE_HISTORY_EXCHANGES);
  let size = kept.reduce((sum, item) => sum + item.question.length + item.response.length, 0);
  while (kept.length > 1 && size > SIDE_HISTORY_CHARS) {
    const dropped = kept.shift()!;
    size -= dropped.question.length + dropped.response.length;
  }
  return kept;
}

type Waiter = { finish: (error?: Error, text?: string) => void };

/** Correlates side questions with control responses on one stream-json process. */
export class ClaudeSideQuestionChannel {
  private readonly waiters = new Map<string, Waiter>();
  constructor(private readonly write: (payload: unknown) => void, private readonly timeoutMs = CLAUDE_SIDE_QUESTION_TIMEOUT_MS) {}

  get pendingCount(): number { return this.waiters.size; }

  ask(input: { question: string; history: ClaudeSideExchange[]; signal: AbortSignal }): Promise<string> {
    input.signal.throwIfAborted();
    const requestId = `tarobot-side-${randomUUID()}`;
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        this.write({ type: "control_cancel_request", request_id: requestId });
        finish(new Error("cancelled"));
      };
      const timer = setTimeout(() => {
        this.write({ type: "control_cancel_request", request_id: requestId });
        finish(new Error("Claude side question timed out"));
      }, this.timeoutMs);
      timer.unref?.();
      const finish = (error?: Error, text?: string) => {
        if (!this.waiters.delete(requestId)) return;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve(text ?? "");
      };
      this.waiters.set(requestId, { finish });
      input.signal.addEventListener("abort", onAbort, { once: true });
      const history = boundedSideHistory(input.history);
      this.write({ type: "control_request", request_id: requestId, request: { subtype: "side_question", question: input.question, ...(history.length ? { history } : {}) } });
    });
  }

  /** Consumes only this channel's response and progress frames. */
  handle(frame: Record<string, unknown>): boolean {
    if (frame.type === "control_request_progress") {
      const nested = frame.response && typeof frame.response === "object" ? (frame.response as Record<string, unknown>).request_id : undefined;
      return [frame.request_id, nested].some((id) => typeof id === "string" && this.waiters.has(id));
    }
    if (frame.type !== "control_response" || !frame.response || typeof frame.response !== "object") return false;
    const response = frame.response as { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown };
    const waiter = typeof response.request_id === "string" ? this.waiters.get(response.request_id) : undefined;
    if (!waiter) return false;
    if (response.subtype === "success") {
      const answer = response.response && typeof response.response === "object" ? (response.response as { response?: unknown }).response : undefined;
      if (typeof answer === "string") waiter.finish(undefined, answer);
      else waiter.finish(new Error("Claude returned no side answer"));
    } else {
      waiter.finish(new Error(typeof response.error === "string" && response.error ? response.error : "Claude side question failed"));
    }
    return true;
  }

  failAll(error: Error): void {
    for (const waiter of [...this.waiters.values()]) waiter.finish(error);
  }
}

type ChildLike = {
  pid?: number;
  stdin?: { write(chunk: string, callback?: (error?: Error | null) => void): boolean; on?(event: "error", listener: (error: Error) => void): void };
  stdout?: { on(event: "data", listener: (chunk: Buffer | { toString(): string } | string) => void): void };
  stderr?: { on(event: "data", listener: (chunk: Buffer | { toString(): string } | string) => void): void };
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

const decode = (decoder: StringDecoder, chunk: Buffer | { toString(): string } | string) =>
  typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk.toString();

/** Arguments for an isolated, unpersisted fork used only for side questions:
 * no tools, no MCP servers, no settings-file hooks, never a user turn. */
export function claudeSideProcessArgs(input: { sourceSessionId: string; forkSessionId: string; effort?: string; model?: string; workspacePath?: string; appendSystemPromptFile?: string }): string[] {
  return [
    "-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--resume", input.sourceSessionId, "--fork-session", "--session-id", input.forkSessionId, "--no-session-persistence",
    "--restricted", "--tools", "", "--strict-mcp-config", "--permission-mode", "plan", "--no-chrome",
    ...(input.effort ? ["--effort", input.effort] : []),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.workspacePath ? ["--add-dir", input.workspacePath] : []),
    ...(input.appendSystemPromptFile ? ["--append-system-prompt-file", input.appendSystemPromptFile] : []),
  ];
}

/** One dedicated side process. Created only when the parent session has no
 * live worker; it is never registered as a session worker. */
export class ClaudeSideProcess {
  readonly channel: ClaudeSideQuestionChannel;
  exited = false;
  private lineBuffer = "";
  private stderrTail = "";
  private disposed = false;
  private readonly stdout = new StringDecoder("utf8");
  private readonly stderr = new StringDecoder("utf8");

  constructor(private readonly child: ChildLike, private readonly residue: { configDir: string; sessionId: string }, private readonly onExit?: () => void) {
    this.channel = new ClaudeSideQuestionChannel((payload) => this.write(payload));
    child.stdout?.on("data", (chunk) => this.onStdout(decode(this.stdout, chunk)));
    child.stderr?.on("data", (chunk) => { this.stderrTail = `${this.stderrTail}${decode(this.stderr, chunk)}`.slice(-MAX_STDERR_CHARS); });
    child.stdin?.on?.("error", (error) => this.exit(error));
    child.once("error", (error) => this.exit(error));
    child.once("close", (code) => this.exit(this.exitError(code)));
  }

  private exitError(code: number | null): Error {
    if (/no conversation found|session .*not found/i.test(this.stderrTail)) return new Error("no_main_session");
    return new ClaudeSideChannelClosedError(`Claude side process exited${code === null ? "" : ` with code ${code}`}`);
  }

  private exit(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.channel.failAll(error);
    this.onExit?.();
  }

  private write(payload: unknown): void {
    if (this.exited) return;
    try {
      this.child.stdin?.write(`${JSON.stringify(payload)}\n`, (error) => { if (error) this.exit(error); });
    } catch (error) {
      this.exit(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onStdout(chunk: string): void {
    this.lineBuffer += chunk;
    if (this.lineBuffer.length > MAX_LINE_CHARS && !this.lineBuffer.includes("\n")) {
      this.lineBuffer = "";
      return;
    }
    let newline = this.lineBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.lineBuffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (this.channel.handle(frame)) return;
    // The fork has no tools; any permission or host request is refused.
    if (frame.type === "control_request" && typeof frame.request_id === "string") {
      const subtype = frame.request && typeof frame.request === "object" ? (frame.request as { subtype?: unknown }).subtype : undefined;
      this.write(subtype === "can_use_tool"
        ? { type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { behavior: "deny", message: "Side conversations are read-only." } } }
        : { type: "control_response", response: { subtype: "error", request_id: frame.request_id, error: "Unsupported control request" } });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.exit(new Error("expired"));
    killProcessTree(this.child.pid);
    const remaining = await removeClaudeSessionResidue(this.residue.configDir, this.residue.sessionId);
    if (remaining.length) throw new Error(`Claude side fork cleanup failed: ${remaining.length} item(s) remain`);
  }
}

export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

/** Returns the path when an owned entry is still present after removal. */
async function removeOwned(target: string): Promise<string | undefined> {
  const stats = await lstat(target).catch(() => undefined);
  if (!stats || stats.isSymbolicLink()) return undefined;
  await rm(target, { recursive: true, force: true }).catch(() => undefined);
  return await lstat(target).then(() => target, () => undefined);
}

/** Removes any transcript state of an unpersisted fork, should the CLI have
 * written some anyway. Only exact entries named by the generated UUID under
 * the engine config directory are touched; symbolic links are never followed. */
export async function removeClaudeSessionResidue(configDir: string, sessionId: string): Promise<string[]> {
  if (!UUID.test(sessionId)) return [];
  const projects = path.join(configDir, "projects");
  const entries = await readdir(projects, { withFileTypes: true }).catch(() => []);
  const remaining: string[] = [];
  const remove = async (target: string) => { const left = await removeOwned(target); if (left) remaining.push(left); };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await remove(path.join(projects, entry.name, `${sessionId}.jsonl`));
    await remove(path.join(projects, entry.name, sessionId));
  }
  await remove(path.join(configDir, "session-env", sessionId));
  return remaining;
}
