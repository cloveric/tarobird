import { EngineCancellationUnconfirmedError } from "./adapter.js";

export const CODEX_RETRY_TOOL_WAIT_MS = 30 * 60_000;
type Command = Record<string, unknown> & { id: string };

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function command(value: unknown): Command | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if ((item.type === "commandExecution" || item.type === "command_execution") && typeof item.id === "string" && item.id) return item as Command;
}

/** Read only the commands this failed native turn actually started. Neither a
 * foreground failure, an elapsed timeout nor a missing item proves completion.
 * The caller keeps its tool ledger until `settled` publishes an actual receipt. */
export async function reconcileCodexRetryCommands(input: {
  turnId: string;
  ownedIds: ReadonlySet<string>;
  requestedIds: readonly string[];
  terminalItems: unknown;
  read: (ids: string[], signal?: AbortSignal) => Promise<unknown>;
  settled: (item: Command) => Promise<void>;
  waiting: (ids: readonly string[]) => Promise<void>;
  isAvailable?: () => boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const remaining = new Set(input.requestedIds.filter(id => input.ownedIds.has(id)));
  // Unknown/anonymous/oversized work stays fenced in the bridge. Do not poll a
  // subset while another, unsupported operation may need active intervention.
  if (!remaining.size || remaining.size !== new Set(input.requestedIds).size || remaining.size > 100) return;
  const consume = async (values: unknown[]) => {
    for (const value of values) {
      input.signal?.throwIfAborted();
      const item = command(value);
      if (!item || !remaining.has(item.id) || !["completed", "failed", "declined"].includes(String(item.status))) continue;
      await input.settled(item);
      remaining.delete(item.id);
    }
  };
  try {
    input.signal?.throwIfAborted();
    await consume(Array.isArray(input.terminalItems) ? input.terminalItems : []);
    if (!remaining.size) return;
    input.signal?.throwIfAborted();
    if (input.isAvailable?.() === false) return;
    await input.waiting([...remaining]);
    const deadline = performance.now() + CODEX_RETRY_TOOL_WAIT_MS;
    let failures = 0, polls = 0;
    while (remaining.size && performance.now() < deadline) {
      input.signal?.throwIfAborted();
      if (input.isAvailable?.() === false) return;
      let result: unknown;
      try {
        result = await input.read([...remaining], input.signal);
        input.signal?.throwIfAborted();
        failures = 0;
      } catch (error) {
        if (input.signal?.aborted) throw error;
        if (input.isAvailable?.() === false) return;
        // A transient read failure may recover; repeated failure keeps the fence.
        if (++failures >= 3) return;
      }
      if (failures === 0) {
        const data = (result as { data?: unknown } | null)?.data;
        // Persisted item reads may be empty while a known command is running.
        // Keep waiting for those IDs; absence is neither success nor failure.
        // Foreign entries, incompatible APIs and unknown states stay fenced.
        if (!Array.isArray(data)) return;
        if (data.some(entry => entry?.turnId !== input.turnId || !command(entry.item) || !remaining.has(entry.item.id)
          || !["inProgress", "completed", "failed", "declined"].includes(entry.item.status))) return;
        const items = data.map(entry => entry.item);
        await consume(items);
      }
      const pollDelay = [5_000, 15_000, 30_000][Math.min(polls++, 2)]!;
      if (remaining.size) await wait(Math.min(pollDelay, Math.max(0, deadline - performance.now())), input.signal);
    }
  } catch (error) {
    // Stop cancels reconciliation, not the already-running native command. Do
    // not falsely report it stopped, or replace uncertainty with a timeout.
    if (input.signal?.aborted && remaining.size) throw new EngineCancellationUnconfirmedError({ cause: error },
      input.signal.reason instanceof Error && input.signal.reason.name === "EngineRecoveryTimeoutError" ? "runtime-deadline" : "tool-recovery");
    throw error;
  }
}
