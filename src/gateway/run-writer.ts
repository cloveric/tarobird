import { runEntrySchema, type RunEntry } from "../client-protocol/run.js";

type Target = { messageId: string; conversationId: string; runId: string };
type State = Target & {
  revisions: Map<number, number>; pending: Map<number, RunEntry>;
  ready: boolean; failed: boolean; blocked?: boolean; notBefore: number; waiters: Array<(ok: boolean) => void>;
};

/** One durable RPC at a time per worker. Live publications do not await the
 * journal; terminal publications flush their own run before becoming final.
 * Pending revisions coalesce by sequence, never across messages or runs. */
export class GatewayRunWriter {
  private states = new Map<string, State>();
  private publications = new Set<{ target: Target; entries: RunEntry[] }>();
  private active?: State;
  private activeEntries: RunEntry[] = [];
  private pumping?: Promise<void>;
  private stopping?: Promise<void>;
  private wake?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private write: (input: Target & { entries: RunEntry[] }) => Promise<unknown>) {}
  private key(target: Target): string { return `${target.conversationId}:${target.messageId}:${target.runId}`; }
  unavailable(target: Target): boolean { return this.states.get(this.key(target))?.failed ?? false; }
  hasPending(target: Target): boolean {
    const state = this.states.get(this.key(target));
    return !!state && (state.pending.size > 0 || state === this.active) || [...this.publications].some(held => this.key(held.target) === this.key(target) && held.entries.length > 0);
  }
  isBusy(): boolean { return !!this.pumping || !!this.wake || this.publications.size > 0; }
  /** Own captured evidence while the body publication awaits acknowledgement.
   * It must survive an explicit stop even before normal background scheduling. */
  holdForPublication(target: Target, entries: RunEntry[]): () => void {
    if (this.stopped) return () => {};
    const held = { target, entries }; this.publications.add(held);
    return () => {
      if (this.publications.delete(held) && !this.stopped) this.enqueue(target, entries);
    };
  }
  /** Validate/copy only revisions not already queued or acknowledged. The
   * returned entries are owned by the writer, detached from the live producer. */
  capture(target: Target, entries: RunEntry[]): RunEntry[] {
    const state = this.states.get(this.key(target));
    if (state?.blocked) return [];
    return entries.filter(entry => entry.revision > Math.max(state?.revisions.get(entry.seq) ?? 0, state?.pending.get(entry.seq)?.revision ?? 0))
      .map(entry => runEntrySchema.parse(entry));
  }
  enqueue(target: Target, entries: RunEntry[]): State {
    const key = this.key(target);
    let state = this.states.get(key);
    if (!state) {
      state = { ...target, revisions: new Map(), pending: new Map(), ready: false, failed: false, notBefore: 0, waiters: [] };
      this.states.set(key, state);
    }
    if (state.blocked) return state;
    const waiting = state.ready && state.pending.size > 0;
    for (const entry of entries) if (entry.revision > Math.max(state.revisions.get(entry.seq) ?? 0, state.pending.get(entry.seq)?.revision ?? 0)) {
      state.pending.set(entry.seq, entry);
    }
    if (this.stopped) { state.failed = true; return state; }
    state.ready = state.pending.size > 0;
    if (!this.bodyTextOnly(state)) state.notBefore = 0;
    else if (!waiting) state.notBefore = Date.now() + 200;
    this.start();
    this.prune();
    return state;
  }
  private start(): void {
    if (this.stopped || this.pumping || ![...this.states.values()].some(state => state.ready)) return;
    if (this.wake) { clearTimeout(this.wake); this.wake = undefined; }
    const ready = [...this.states.values()].filter(state => state.ready);
    if (!ready.some(state => state.waiters.length || state.notBefore <= Date.now())) {
      this.wake = setTimeout(() => { this.wake = undefined; this.start(); }, Math.max(1, Math.min(...ready.map(state => state.notBefore)) - Date.now()));
      return;
    }
    this.pumping = this.drain().catch(() => {
      for (const state of this.states.values()) if (state.ready) { state.failed = true; state.ready = false; this.settle(state); }
      this.active = undefined; this.activeEntries = [];
    }).finally(() => { this.pumping = undefined; this.prune(); this.start(); });
  }
  async flush(target: Target, entries: RunEntry[]): Promise<boolean> {
    const state = this.enqueue(target, entries);
    if (this.stopped || (!state.pending.size && state !== this.active)) return !state.failed;
    const ok = await new Promise<boolean>(resolve => { state.waiters.push(resolve); this.start(); });
    // A rejected terminal flush is visible as unavailable, not a forever-retained
    // copy of the whole run. A later normal retry can recapture unacked entries.
    if (!ok && !this.stopped) { state.pending.clear(); state.ready = false; }
    return ok;
  }
  private settle(state: State): void {
    for (const resolve of state.waiters.splice(0)) resolve(!state.failed);
  }
  private async drain(): Promise<void> {
    // Yield between batches so queued body publications reach the transport
    // before another optional batch. This is not a display throttle.
    while (!this.stopped) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (this.stopped) break;
      const ready = [...this.states.values()].filter(value => value.ready && (value.waiters.length || value.notBefore <= Date.now()));
      const state = ready.find(value => value.waiters.length) ?? ready[0];
      if (!state) break;
      this.active = state;
      const entries = this.batch(state.pending.values()); this.activeEntries = entries;
      try {
        await this.write({ messageId: state.messageId, conversationId: state.conversationId, runId: state.runId, entries });
        for (const entry of entries) {
          state.revisions.set(entry.seq, entry.revision);
          const pending = state.pending.get(entry.seq);
          state.pending.delete(entry.seq);
          if (pending && pending.revision > entry.revision) state.pending.set(entry.seq, pending);
        }
        state.ready = state.pending.size > 0;
        if (state.ready && this.bodyTextOnly(state)) state.notBefore = Date.now() + 200;
        if (!state.ready) { state.failed = false; this.settle(state); }
      } catch (error) {
        // Retain failed revisions for the next ordinary update/terminal flush;
        // do not spin or hide the answer when evidence storage is unavailable.
        state.failed = true; state.ready = false;
        if (error instanceof Error && ["run_limit", "run_forbidden", "invalid_request"].includes(error.message)) {
          state.blocked = true; state.pending.clear();
        }
        this.settle(state);
      } finally {
        this.active = undefined; this.activeEntries = [];
        // Round robin across conversations sharing this Bot worker.
        this.states.delete(this.key(state)); this.states.set(this.key(state), state);
      }
    }
  }
  private bodyTextOnly(state: State): boolean {
    // Body text already reached the App. Coalesce only its duplicate detail
    // revisions; public thoughts, tools and terminal flushes never wait for this.
    return state.pending.size > 0 && [...state.pending.values()].every(entry => entry.kind === "text");
  }
  private batch(values: Iterable<RunEntry>): RunEntry[] {
    const entries: RunEntry[] = []; let bytes = 0;
    for (const entry of values) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      // A capped 64 KiB tool result and its neighboring text must fit together;
      // a 64 KiB batch target turns each into separate durable RPCs.
      if (entries.length && (entries.length === 4 || bytes + size > 256 * 1024)) break;
      entries.push(entry); bytes += size; // An oversized individual entry goes alone.
    }
    return entries;
  }
  private prune(): void {
    for (const [key, state] of this.states) {
      if (this.states.size <= 128) break;
      if (state !== this.active && !state.pending.size && !state.ready && !state.waiters.length) this.states.delete(key);
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    for (const held of this.publications) this.enqueue(held.target, held.entries);
    this.publications.clear();
    this.stopped = true;
    if (this.wake) { clearTimeout(this.wake); this.wake = undefined; }
    const saved: Promise<unknown>[] = [];
    for (const state of this.states.values()) {
      const pending = [...state.pending.values()].filter(entry => !this.activeEntries.some(inflight => this.active === state && inflight.seq === entry.seq && inflight.revision >= entry.revision));
      while (pending.length) {
        const entries = this.batch(pending); pending.splice(0, entries.length);
        // Invoke synchronously, before GatewayTransport.disconnect marks itself
        // stopped. request() registers every batch on its durable diskTail before
        // yielding; disconnect then drains that tail and replay retains evidence.
        try { saved.push(Promise.resolve(this.write({ messageId: state.messageId, conversationId: state.conversationId, runId: state.runId, entries })).catch(() => undefined)); } catch { /* Transport already stopped. */ }
      }
      if (state.pending.size) state.failed = true; this.settle(state);
    }
    this.stopping = Promise.allSettled([this.pumping, ...saved]).then(() => { this.states.clear(); });
    return this.stopping;
  }
}
