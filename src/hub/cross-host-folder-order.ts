import {
  crossHostFolderOrderChangeSchema,
  crossHostFolderOrderSchema,
  emptyCrossHostFolderOrderState,
  type CrossHostFolderOrderState,
} from "../client-protocol/cross-host-folder-order.js";
import type { HubDatabase } from "./database.js";
import { HubError } from "./store.js";

const FUTURE_CLOCK_TOLERANCE_MS = 60_000;

function dedup(items: readonly string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canonicalOrder(pinned: readonly string[], ordinary: readonly string[]): string {
  return JSON.stringify([pinned, ordinary]);
}

/** Per-user synced cross-host folder display order stored on this Hub with
 * optimistic revision checks and last-write-wins timestamp reconciliation. */
export class CrossHostFolderOrder {
  constructor(
    private readonly db: HubDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private metaKey(userId: string): string {
    return `cross-host-folder-order:${userId}`;
  }

  private async load(userId: string): Promise<CrossHostFolderOrderState> {
    const row = await this.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [this.metaKey(userId)]);
    if (!row) return emptyCrossHostFolderOrderState();
    const parsed = crossHostFolderOrderSchema.parse(JSON.parse(row.value));
    return {
      version: 1,
      revision: parsed.revision,
      updatedAt: parsed.updatedAt,
      pinned: dedup(parsed.pinned),
      ordinary: dedup(parsed.ordinary),
    };
  }

  read(userId: string, validate?: () => Promise<unknown>): Promise<CrossHostFolderOrderState> {
    return this.db.serial(async () => {
      await validate?.();
      return this.load(userId);
    });
  }

  async change(
    userId: string,
    value: unknown,
    validate?: () => Promise<unknown>,
  ): Promise<{ state: CrossHostFolderOrderState; changed: boolean }> {
    return this.db.transaction(async () => {
      await validate?.();
      return this.changeInTransaction(userId, value);
    });
  }

  async changeInTransaction(
    userId: string,
    value: unknown,
  ): Promise<{ state: CrossHostFolderOrderState; changed: boolean }> {
    const input = crossHostFolderOrderChangeSchema.parse(value);
    const state = await this.load(userId);
    if (input.revision !== state.revision) throw new HubError("cross_host_folder_order_changed", 409);

    const nextPinned = dedup(input.pinned);
    const nextOrdinary = dedup(input.ordinary);
    const maxAt = this.now() + FUTURE_CLOCK_TOLERANCE_MS;
    let effectiveAt = Math.min(input.updatedAt, maxAt);
    if (effectiveAt === 0 && (nextPinned.length > 0 || nextOrdinary.length > 0)) {
      effectiveAt = Math.max(1, this.now());
    }

    if (effectiveAt < state.updatedAt) {
      return { state, changed: false };
    }
    if (effectiveAt === state.updatedAt) {
      if (sameList(state.pinned, nextPinned) && sameList(state.ordinary, nextOrdinary)) {
        return { state, changed: false };
      }
      if (canonicalOrder(nextPinned, nextOrdinary) <= canonicalOrder(state.pinned, state.ordinary)) {
        return { state, changed: false };
      }
    }

    const nextState: CrossHostFolderOrderState = {
      version: 1,
      revision: state.revision + 1,
      updatedAt: effectiveAt,
      pinned: nextPinned,
      ordinary: nextOrdinary,
    };
    await this.db.run(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [this.metaKey(userId), JSON.stringify(nextState)],
    );
    return { state: nextState, changed: true };
  }
}
