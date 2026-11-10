import { createHash } from "node:crypto";
import os from "node:os";
import { spawnEngine } from "./engine-process.js";
import { EFFORT_LEVELS } from "../state/config-file-schema.js";

export type DiscoveredModel = { id: string; label?: string; efforts: string[] };
/** `defaultLabel` names what the CLI's own default resolves to, when it says. */
export type DiscoveredModels = { models: DiscoveredModel[]; defaultLabel?: string };
type DiscoveryEngine = "claude" | "codex";

const TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 1024 * 1024;
const SUCCESS_TTL_MS = 300_000;
const FAILURE_TTL_MS = 30_000;
const CLAUDE_REQUEST_ID = "tarobot-model-list";

/** Tests and fixtures set TAROBOT_MODEL_DISCOVERY=0 so a developer's installed CLIs never shape a result. */
export function modelDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TAROBOT_MODEL_DISCOVERY !== "0";
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\s\p{Cc}]/u.test(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() && !/\p{Cc}/u.test(value) ? value.trim().slice(0, 80) : undefined;
const efforts = (levels: unknown): string[] =>
  ["", ...EFFORT_LEVELS.filter(level => Array.isArray(levels) && levels.includes(level))];

/** Claude Code's `initialize` control response: the same rows as its own /model menu. */
export function parseClaudeModels(payload: unknown): DiscoveredModels {
  const rows = (payload as { models?: unknown } | undefined)?.models;
  const result: DiscoveredModels = { models: [] };
  if (!Array.isArray(rows)) return result;
  type Row = { value?: unknown; resolvedModel?: unknown; displayName?: unknown; supportsEffort?: unknown; supportedEffortLevels?: unknown };
  const named = new Map<string, string>();
  for (const row of rows as Row[]) {
    const display = text(row?.displayName);
    if (validId(row?.value) && row.value !== "default" && validId(row.resolvedModel) && display) named.set(row.resolvedModel, display);
  }
  const seen = new Set<string>();
  for (const row of rows as Row[]) {
    if (!validId(row?.value)) continue;
    const resolved = validId(row.resolvedModel) ? row.resolvedModel : undefined;
    if (row.value === "default") {
      // "Default (recommended)" says nothing; name the model it resolves to.
      if (resolved) result.defaultLabel = named.get(resolved) ?? resolved;
      continue;
    }
    if (seen.has(row.value)) continue;
    seen.add(row.value);
    const display = text(row.displayName);
    // An alias ("fable") keeps its name visible: it follows the CLI's next release.
    const label = display && resolved && resolved !== row.value ? `${display} (${row.value})` : display;
    result.models.push({ id: row.value, ...(label ? { label } : {}), efforts: row.supportsEffort === false ? [""] : efforts(row.supportedEffortLevels) });
  }
  return result;
}

/** Codex app-server `model/list` rows; hidden models stay out of the picker. */
export function parseCodexModels(rows: unknown[]): DiscoveredModels {
  const result: DiscoveredModels = { models: [] };
  const seen = new Set<string>();
  type Row = { id?: unknown; model?: unknown; displayName?: unknown; hidden?: unknown; supportedReasoningEfforts?: unknown };
  for (const row of rows as Row[]) {
    const id = validId(row?.model) ? row.model : validId(row?.id) ? row.id : undefined;
    if (!id || row.hidden === true || seen.has(id)) continue;
    seen.add(id);
    const levels = Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts.map(entry => typeof entry === "string" ? entry : (entry as { reasoningEffort?: unknown })?.reasoningEffort)
      : [];
    const label = text(row.displayName);
    result.models.push({ id, ...(label ? { label } : {}), efforts: efforts(levels) });
  }
  return result;
}

/** One bounded JSON-lines exchange with a CLI. Never starts a model turn; the
 * child is killed as soon as the answer (or a failure) arrives. */
function exchange<T>(executable: string, args: string[], env: NodeJS.ProcessEnv,
  start: (write: (message: unknown) => void) => void,
  receive: (message: Record<string, unknown>, write: (message: unknown) => void) => T | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawnEngine(executable, args, { env, cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let buffer = "", length = 0, settled = false;
    const finish = (error: Error | undefined, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdout?.removeAllListeners("data"); child.stdin?.end(); child.kill("SIGKILL");
      if (error) reject(error); else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error("model_list_timeout")), TIMEOUT_MS);
    const write = (message: unknown) => { if (!settled) child.stdin?.write(JSON.stringify(message) + "\n"); };
    child.once("error", error => finish(error));
    child.once("close", () => finish(new Error("model_list_failed")));
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > OUTPUT_LIMIT) { finish(new Error("model_output_limit")); return; }
      buffer += chunk.toString("utf8");
      for (let index = buffer.indexOf("\n"); index >= 0 && !settled; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line.startsWith("{")) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        if (!message || typeof message !== "object") continue;
        try {
          const value = receive(message as Record<string, unknown>, write);
          if (value !== undefined) finish(undefined, value);
        } catch (error) { finish(error instanceof Error ? error : new Error("model_list_failed")); }
      }
    });
    start(write);
  });
}

function discoverClaude(env: NodeJS.ProcessEnv): Promise<DiscoveredModels> {
  // --safe-mode skips the owner's hooks, plugins and MCP servers but still reads
  // their account and default model, so the list matches their own /model menu.
  return exchange(executable("claude", env), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-chrome", "--safe-mode"], env,
    write => write({ type: "control_request", request_id: CLAUDE_REQUEST_ID, request: { subtype: "initialize" } }),
    message => {
      const response = message.type === "control_response" ? message.response as { request_id?: unknown; subtype?: unknown; response?: unknown } | undefined : undefined;
      if (response?.request_id !== CLAUDE_REQUEST_ID) return undefined;
      if (response.subtype !== "success") throw new Error("model_list_failed");
      return parseClaudeModels(response.response);
    });
}

function discoverCodex(env: NodeJS.ProcessEnv): Promise<DiscoveredModels> {
  const rows: unknown[] = [];
  return exchange(executable("codex", env), ["app-server"], env,
    write => write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "tarocub", title: "TaroCub", version: "0.1.0" }, capabilities: { experimentalApi: true } } }),
    (message, write) => {
      if (typeof message.id !== "number") return undefined;
      if (message.error) throw new Error("model_list_failed");
      if (message.id === 1) {
        write({ jsonrpc: "2.0", method: "initialized" });
        write({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} });
        return undefined;
      }
      const result = message.result as { data?: unknown; nextCursor?: unknown } | undefined;
      if (Array.isArray(result?.data)) rows.push(...result.data);
      if (typeof result?.nextCursor === "string" && result.nextCursor && message.id < 12) {
        write({ jsonrpc: "2.0", id: message.id + 1, method: "model/list", params: { cursor: result.nextCursor } });
        return undefined;
      }
      return parseCodexModels(rows);
    });
}

function executable(engine: DiscoveryEngine, env: NodeJS.ProcessEnv): string {
  const configured = engine === "claude" ? env.CLAUDE_EXECUTABLE : env.CODEX_EXECUTABLE;
  return (configured || engine).trim().replace(/^"(.*)"$/, "$1");
}

const cache = new Map<string, { expires: number; result: Promise<DiscoveredModels | undefined> }>();

/** The models the installed Claude Code or Codex CLI offers right now, or
 * undefined when it cannot say (missing, too old, signed out, timed out). */
export function discoverCliModels(engine: DiscoveryEngine, env: NodeJS.ProcessEnv = process.env): Promise<DiscoveredModels | undefined> {
  if (!modelDiscoveryEnabled(env)) return Promise.resolve(undefined);
  const key = createHash("sha256").update(JSON.stringify([engine, env])).digest("hex");
  const current = cache.get(key);
  if (current && current.expires > Date.now()) return current.result;
  const entry = { expires: Date.now() + SUCCESS_TTL_MS, result: Promise.resolve<DiscoveredModels | undefined>(undefined) };
  entry.result = (engine === "claude" ? discoverClaude(env) : discoverCodex(env))
    .then(found => found.models.length ? found : undefined, () => undefined)
    .then(found => { if (!found) entry.expires = Date.now() + FAILURE_TTL_MS; return found; });
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
  return entry.result;
}

export function resetModelDiscoveryCacheForTest(): void {
  cache.clear();
}
