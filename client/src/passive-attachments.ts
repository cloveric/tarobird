export type AttachmentLease = { promise: Promise<Blob>; release: () => void };
type Entry = {
  id: string; users: number; interactive: boolean; controller: AbortController;
  promise: Promise<Blob>; resolve: (blob: Blob) => void; reject: (error: unknown) => void;
  phase: "cache" | "queued" | "running" | "settled";
  retirement?: ReturnType<typeof setTimeout>;
};
const cancelled = () => new DOMException("Attachment consumer released", "AbortError");

/** Owns only passive image/audio work. Explicit file saves keep their own signal.
 * Cache hits bypass the network budget, including while other downloads recover. */
export class PassiveAttachments {
  private readonly entries = new Map<string, Entry>();
  private readonly queued = new Set<Entry>();
  private running = 0;
  constructor(private readonly cached: (id: string) => Promise<Blob | undefined>,
    private readonly download: (id: string, signal: AbortSignal) => Promise<Blob>,
    private readonly limit = 3, private readonly graceMs = 750) {}

  acquire(id: string, interactive = false): AttachmentLease {
    let entry = this.entries.get(id);
    if (!entry) {
      let resolve!: Entry["resolve"], reject!: Entry["reject"];
      const promise = new Promise<Blob>((yes, no) => { resolve = yes; reject = no; });
      // A released lease may have no observer left when cancellation settles.
      void promise.catch(() => undefined);
      entry = { id, users: 0, interactive, controller: new AbortController(), promise, resolve, reject, phase: "cache" };
      this.entries.set(id, entry);
      const target = entry;
      void Promise.resolve().then(() => this.cached(id)).then(blob => {
        if (target.controller.signal.aborted || target.phase === "settled") return;
        if (blob) this.finish(target, blob);
        else { target.phase = "queued"; this.queued.add(target); this.pump(); }
      }, error => this.finish(target, undefined, error));
    }
    entry.users++; entry.interactive ||= interactive;
    clearTimeout(entry.retirement); entry.retirement = undefined;
    this.pump();
    const target = entry; let released = false;
    return { promise: entry.promise, release: () => {
      if (released) return; released = true;
      if (--target.users || target.phase === "settled") return;
      target.retirement = setTimeout(() => this.cancel(target), this.graceMs);
    } };
  }
  /** This pool is owned by one connection; close cancels all work, not a route handoff. */
  cancelAll(reason: Error = cancelled()): void { for (const entry of [...this.entries.values()]) this.cancel(entry, reason); }
  private cancel(entry: Entry, reason: Error = cancelled()): void {
    clearTimeout(entry.retirement); entry.retirement = undefined;
    if (entry.phase === "settled") return;
    // Remove before abort: a new consumer must never inherit an aborted promise.
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    this.queued.delete(entry); entry.controller.abort(reason);
    if (entry.phase !== "running") this.finish(entry, undefined, reason);
  }
  private finish(entry: Entry, blob?: Blob, error?: unknown): void {
    if (entry.phase === "settled") return;
    entry.phase = "settled"; clearTimeout(entry.retirement); this.queued.delete(entry);
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    if (entry.controller.signal.aborted) entry.reject(entry.controller.signal.reason ?? cancelled());
    else if (blob) entry.resolve(blob); else entry.reject(error);
  }
  private pump(): void {
    while (this.running < this.limit && this.queued.size) {
      const waiting = [...this.queued].filter(value => value.users > 0);
      const entry = waiting.find(value => value.interactive) ?? waiting[0];
      if (!entry) return;
      this.queued.delete(entry); entry.phase = "running"; this.running++;
      void Promise.resolve().then(() => {
        if (entry.controller.signal.aborted) throw cancelled();
        return this.download(entry.id, entry.controller.signal);
      }).then(blob => this.finish(entry, blob), error => this.finish(entry, undefined, error))
        .finally(() => { this.running--; this.pump(); });
    }
  }
}
