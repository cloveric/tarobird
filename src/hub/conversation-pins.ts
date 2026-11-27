import { z } from "zod";
import {
  conversationPinsSchema,
  emptyConversationPins,
  pinChangeSchema,
  type ConversationPinsState,
  type PinReconcileItem,
} from "../client-protocol/conversation-pins.js";
import type { HubDatabase } from "./database.js";
import { HubError } from "./store.js";

const timestampsSchema = z.record(z.string(), z.number().int().nonnegative().safe());
const MAX_PINS = 2048;
const MAX_STORED_TIMESTAMPS = 4096;
const PRUNE_UNPINNED_TIMESTAMPS = 2048;
const FUTURE_CLOCK_TOLERANCE_MS = 60_000;

/** Per-user conversation pins on this Hub (`pins` and `globalPins`), scoped to
 * that user's paired devices with optimistic revision checks and LWW timestamps. */
export class ConversationPins {
  constructor(
    private readonly db: HubDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private metaKey(userId: string): string {
    return `conversation-pins:${userId}`;
  }

  private async load(userId: string): Promise<{ state: ConversationPinsState; timestamps: Record<string, number> }> {
    const row = await this.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [this.metaKey(userId)]);
    if (!row) return { state: emptyConversationPins(), timestamps: {} };
    const stored: unknown = JSON.parse(row.value);
    const parsed = conversationPinsSchema.parse(stored);
    const state: ConversationPinsState = {
      revision: parsed.revision,
      pins: [...new Set(parsed.pins)],
      globalPins: [...new Set(parsed.globalPins)],
    };
    const rawTimestamps = stored && typeof stored === "object" && "timestamps" in stored
      ? timestampsSchema.safeParse((stored as { timestamps?: unknown }).timestamps)
      : undefined;
    return { state, timestamps: rawTimestamps?.success ? { ...rawTimestamps.data } : {} };
  }

  private async save(userId: string, state: ConversationPinsState, timestamps: Record<string, number>): Promise<void> {
    const pruned = this.pruneTimestamps(state, timestamps);
    await this.db.run(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [this.metaKey(userId), JSON.stringify({ ...state, ...(Object.keys(pruned).length ? { timestamps: pruned } : {}) })],
    );
  }

  private pruneTimestamps(state: ConversationPinsState, timestamps: Record<string, number>): Record<string, number> {
    const entries = Object.entries(timestamps);
    if (entries.length <= MAX_STORED_TIMESTAMPS) return timestamps;
    const pinnedKeys = new Set([
      ...state.pins.map(id => `group:${id}`),
      ...state.globalPins.map(id => `global:${id}`),
    ]);
    const kept: Record<string, number> = {};
    const unpinned: Array<[string, number]> = [];
    for (const [key, ts] of entries) {
      if (pinnedKeys.has(key)) kept[key] = ts;
      else unpinned.push([key, ts]);
    }
    unpinned.sort((a, b) => b[1] - a[1]);
    for (const [key, ts] of unpinned.slice(0, PRUNE_UNPINNED_TIMESTAMPS)) kept[key] = ts;
    return kept;
  }

  private async isAvailableConversation(userId: string, conversationId: string): Promise<boolean> {
    const chat = await this.db.get(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m ON m.conversation_id=c.id
       WHERE c.id=? AND c.archived=0 AND m.member_type='user' AND m.member_id=?
         AND (c.parent_id IS NULL OR EXISTS(SELECT 1 FROM conversations p WHERE p.id=c.parent_id AND p.archived=0))`,
      [conversationId, userId],
    );
    return !!chat;
  }

  read(userId: string, validate?: () => Promise<unknown>): Promise<ConversationPinsState> {
    return this.db.serial(async () => {
      await validate?.();
      return (await this.load(userId)).state;
    });
  }

  async change(userId: string, value: unknown, validate?: () => Promise<unknown>): Promise<{ state: ConversationPinsState; changed: boolean }> {
    return this.db.transaction(async () => {
      await validate?.();
      return this.changeInTransaction(userId, pinChangeSchema.parse(value));
    });
  }

  async changeInTransaction(userId: string, value: unknown): Promise<{ state: ConversationPinsState; changed: boolean }> {
    const input = pinChangeSchema.parse(value);
    const { state, timestamps } = await this.load(userId);
    if (input.revision !== state.revision) throw new HubError("pins_changed", 409);

    if (input.type === "set") {
      if (input.pinned && !(await this.isAvailableConversation(userId, input.conversationId))) {
        throw new HubError("conversation_not_available", 404);
      }
      const list = input.scope === "global" ? state.globalPins : state.pins;
      if (input.pinned) {
        if (!list.includes(input.conversationId)) {
          if (list.length >= MAX_PINS) throw new HubError("pin_limit", 409);
          list.push(input.conversationId);
        }
      } else {
        const next = list.filter(id => id !== input.conversationId);
        if (input.scope === "global") state.globalPins = next;
        else state.pins = next;
      }
      const key = `${input.scope}:${input.conversationId}`;
      timestamps[key] = Math.max(this.now(), timestamps[key] ?? 0);
      state.revision++;
      await this.save(userId, state, timestamps);
      return { state, changed: true };
    }

    if (input.type === "merge") {
      let changed = false;
      for (const [scope, incoming, target] of [
        ["group", input.pins, state.pins] as const,
        ["global", input.globalPins, state.globalPins] as const,
      ]) {
        for (const id of new Set(incoming)) {
          if (target.includes(id)) continue;
          if (!(await this.isAvailableConversation(userId, id))) continue;
          if (target.length >= MAX_PINS) throw new HubError("pin_limit", 409);
          target.push(id);
          const key = `${scope}:${id}`;
          timestamps[key] = Math.max(timestamps[key] ?? 0, 1);
          changed = true;
        }
      }
      if (changed) {
        state.revision++;
        await this.save(userId, state, timestamps);
      }
      return { state, changed };
    }

    // Reconcile offline changes: keep the latest timestamp per (scope, conversationId).
    const collapsed = new Map<string, PinReconcileItem>();
    for (const item of input.changes) {
      const key = `${item.scope}:${item.conversationId}`;
      const existing = collapsed.get(key);
      if (!existing || item.at >= existing.at) collapsed.set(key, item);
    }

    let stateChanged = false;
    let metaChanged = false;
    const maxAt = this.now() + FUTURE_CLOCK_TOLERANCE_MS;
    for (const [key, item] of collapsed) {
      const prevAt = timestamps[key] ?? 0;
      if (item.at < prevAt) continue;
      const effectiveAt = Math.min(item.at, maxAt);
      const list = item.scope === "global" ? state.globalPins : state.pins;
      if (item.pinned) {
        if (!(await this.isAvailableConversation(userId, item.conversationId))) continue;
        if (!list.includes(item.conversationId)) {
          if (list.length >= MAX_PINS) throw new HubError("pin_limit", 409);
          list.push(item.conversationId);
          stateChanged = true;
        }
      } else {
        const idx = list.indexOf(item.conversationId);
        if (idx !== -1) {
          list.splice(idx, 1);
          stateChanged = true;
        }
      }
      if (timestamps[key] !== effectiveAt) {
        timestamps[key] = effectiveAt;
        metaChanged = true;
      }
    }

    if (stateChanged) state.revision++;
    if (stateChanged || metaChanged) await this.save(userId, state, timestamps);
    return { state, changed: stateChanged };
  }
}
