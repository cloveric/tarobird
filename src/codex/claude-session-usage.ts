import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { withFileMutex } from "../state/file-mutex.js";
import { JsonStore } from "../state/json-store.js";

const MAX_ENTRIES = 512;
const MAX_RESULT_IDS = 32;
const USAGE_IO_TIMEOUT_MS = 2_000;
const entrySchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  /** High-water mark of the session's cumulative ledger already accounted for. */
  totalCostUsd: z.number().finite().nonnegative(),
  /** Recent result ids, so a late or repeated frame is never counted again. */
  resultIds: z.array(z.string().max(128)).max(MAX_RESULT_IDS).default([]),
  updatedAt: z.number().finite(),
});
const stateSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(MAX_ENTRIES) });
type State = z.infer<typeof stateSchema>;
const emptyState = (): State => ({ version: 1, entries: [] });

export interface ClaudeResultCost {
  /** This result's own cost; undefined whenever it cannot be proven exactly once. */
  costUsd: number | undefined;
  /** A baseline for this session is durably stored (or in memory without a file). */
  baselineSaved: boolean;
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Claude session usage I/O timed out")), timeoutMs);
    operation.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Pure accounting step. The stored total only rises: a lower total is a late
 * frame or a ledger reset, so it is unknown and cannot reopen an already counted
 * interval. A session without a baseline is unknown unless the CLI created it in
 * this worker (`fresh`), whose ledger starts at zero. */
function applyResult(state: State, key: string, total: number, resultId: string | undefined, fresh: boolean): { costUsd: number | undefined; next?: State } {
  const existing = state.entries.find(entry => entry.key === key);
  if (existing && resultId && existing.resultIds.includes(resultId)) return { costUsd: 0 };
  const previous = existing?.totalCostUsd ?? (fresh ? 0 : undefined);
  const lower = previous !== undefined && total < previous;
  const entry = {
    key,
    totalCostUsd: lower ? previous : total,
    resultIds: resultId ? [...(existing?.resultIds ?? []), resultId].slice(-MAX_RESULT_IDS) : existing?.resultIds ?? [],
    updatedAt: Date.now(),
  };
  return {
    costUsd: previous === undefined || lower ? undefined : Number((total - previous).toFixed(12)),
    next: { version: 1, entries: [...state.entries.filter(item => item.key !== key), entry].slice(-MAX_ENTRIES) },
  };
}

/**
 * Claude Code reports `total_cost_usd` as the session's cumulative ledger, and
 * `-r` restores that ledger in a new process (verified with Claude Code 2.1.307);
 * `usage` is per turn. Converts each foreground result into its own cost using a
 * per native session and workspace baseline. Stores only hashed keys, totals,
 * result ids and timestamps.
 *
 * With a file, every result is a mutex-guarded transaction that re-reads the
 * baselines and durably writes the new one before its cost is released, so
 * concurrent adapters or processes on the same ledger cannot lose each other's
 * baselines, and a crash can only drop a cost, never count it twice. A failed or
 * slow write releases no cost and leaves the old baseline, which charges that
 * interval once with the next recorded result.
 */
export class ClaudeSessionUsage {
  private memory = emptyState();
  private readonly store?: JsonStore<State>;
  private queue: Promise<unknown> = Promise.resolve();
  private warned = false;

  constructor(private readonly file?: string, private readonly ioTimeoutMs = USAGE_IO_TIMEOUT_MS) {
    if (file) this.store = new JsonStore(file, value => stateSchema.parse(value));
  }

  private key(sessionId: string, workspace?: string): string {
    return createHash("sha256").update(JSON.stringify([sessionId, workspace ? path.resolve(workspace) : ""])).digest("hex");
  }

  private warn(message: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(message);
  }

  /** Re-read inside the transaction. A corrupt cache is set aside (its sessions
   * become unknown); any other read failure aborts without overwriting the file. */
  private async readDurable(): Promise<State> {
    try {
      return await this.store!.read(emptyState());
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      await this.store!.quarantineCurrentFile("corrupt");
      this.warn("Claude session usage baselines were unreadable and have been set aside; affected costs are reported as unknown.");
      return emptyState();
    }
  }

  async recordResult(input: { sessionId: string; workspace?: string; totalCostUsd: unknown; resultId?: string; freshLedger: boolean }): Promise<ClaudeResultCost> {
    const total = input.totalCostUsd;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return { costUsd: undefined, baselineSaved: false };
    const key = this.key(input.sessionId, input.workspace);
    const resultId = typeof input.resultId === "string" && input.resultId.length > 0 && input.resultId.length <= 128 ? input.resultId : undefined;
    if (!this.store) {
      const outcome = applyResult(this.memory, key, total, resultId, input.freshLedger);
      if (outcome.next) this.memory = outcome.next;
      return { costUsd: outcome.costUsd, baselineSaved: true };
    }
    let abandoned = false;
    const transaction = this.queue.then(() => withFileMutex(this.file!, async (): Promise<ClaudeResultCost> => {
      if (abandoned) return { costUsd: undefined, baselineSaved: false };
      const outcome = applyResult(await this.readDurable(), key, total, resultId, input.freshLedger);
      // A caller that already gave up must not move the baseline past a cost it never released.
      if (abandoned) return { costUsd: undefined, baselineSaved: false };
      if (outcome.next) await this.store!.write(outcome.next);
      return { costUsd: outcome.costUsd, baselineSaved: true };
    }, { waitTimeoutMs: this.ioTimeoutMs }));
    // Keep one transaction at a time even after a caller times out.
    this.queue = transaction.catch(() => undefined);
    try {
      return await bounded(transaction, this.ioTimeoutMs);
    } catch {
      abandoned = true;
      this.warn("Claude session usage baselines could not be saved; affected costs are reported as unknown.");
      return { costUsd: undefined, baselineSaved: false };
    }
  }

  async flush(): Promise<void> { await this.queue; }
}
