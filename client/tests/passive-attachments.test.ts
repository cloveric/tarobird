import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PassiveAttachments } from "../src/passive-attachments.js";
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function fixture(cached = async (_id: string): Promise<Blob | undefined> => undefined) {
  const active = new Map<string, { finish: (blob: Blob) => void; signal: AbortSignal }>();
  const started: string[] = []; let peak = 0, aborts = 0;
  const pool = new PassiveAttachments(cached, (id, signal) => new Promise<Blob>((resolve, reject) => {
    started.push(id); active.set(id, { finish: blob => { active.delete(id); resolve(blob); }, signal }); peak = Math.max(peak, active.size);
    signal.addEventListener("abort", () => { aborts++; active.delete(id); reject(new DOMException("cancelled", "AbortError")); }, { once: true });
  }));
  return { pool, active, started, peak: () => peak, aborts: () => aborts };
}
it("caps concurrent downloads, cancels released queued work and clears running work", async () => {
  const f = fixture(); const leases = Array.from({ length: 20 }, (_, i) => f.pool.acquire(String(i)));
  await flush(); expect(f.started).toHaveLength(3); expect(f.peak()).toBe(3);
  for (const lease of leases) lease.release();
  await vi.advanceTimersByTimeAsync(750); await flush();
  expect(f.active.size).toBe(0); expect(f.started).toHaveLength(3); expect(f.aborts()).toBe(3);
  expect((await Promise.allSettled(leases.map(value => value.promise))).every(value => value.status === "rejected")).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("shares consumers and reuses a transfer across a brief remount", async () => {
  const f = fixture(), a = f.pool.acquire("image"), b = f.pool.acquire("image"); await flush();
  a.release(); await vi.advanceTimersByTimeAsync(1000); expect(f.aborts()).toBe(0);
  b.release(); await vi.advanceTimersByTimeAsync(500);
  const c = f.pool.acquire("image"); await vi.advanceTimersByTimeAsync(1000);
  expect(c.promise).toBe(a.promise); expect(f.started).toEqual(["image"]);
  const blob = new Blob(["image"]); f.active.get("image")!.finish(blob);
  expect(await c.promise).toBe(blob); c.release(); await flush(); expect(vi.getTimerCount()).toBe(0);
});
it("does not starve cached images behind three stalled network transfers", async () => {
  const blob = new Blob(["cached"]), f = fixture(async id => id === "cached" ? blob : undefined);
  for (const id of ["a", "b", "c"]) f.pool.acquire(id); await flush();
  expect(await f.pool.acquire("cached").promise).toBe(blob); expect(f.started).toHaveLength(3);
  f.pool.cancelAll(); await flush(); expect(f.active.size).toBe(0);
});
it("prioritizes an interactive preview without exceeding the network budget", async () => {
  const f = fixture(); for (const id of ["a", "b", "c", "d"]) f.pool.acquire(id); await flush();
  const queued = f.pool.acquire("preview"); f.pool.acquire("preview", true); await flush();
  f.active.get("a")!.finish(new Blob(["a"])); await flush();
  expect(f.started).toEqual(["a", "b", "c", "preview"]); expect(f.peak()).toBe(3);
  f.pool.cancelAll(); await expect(queued.promise).rejects.toMatchObject({ name: "AbortError" });
});
it("starts a fresh lease after cancellation and isolates pools for different hosts", async () => {
  const a = fixture(), b = fixture(); const old = a.pool.acquire("same"); await flush();
  old.release(); await vi.advanceTimersByTimeAsync(750); await flush();
  const next = a.pool.acquire("same"), other = b.pool.acquire("same"); await flush();
  expect(next.promise).not.toBe(old.promise); expect(b.started).toEqual(["same"]);
  a.pool.cancelAll(); await flush(); expect(b.aborts()).toBe(0);
  const blob = new Blob(["other"]); b.active.get("same")!.finish(blob); expect(await other.promise).toBe(blob);
});
it("does not start a download after cache lookup finishes for a retired consumer", async () => {
  let complete!: (value: Blob | undefined) => void;
  const f = fixture(() => new Promise(resolve => { complete = resolve; }));
  const lease = f.pool.acquire("slow-cache"); lease.release(); await vi.advanceTimersByTimeAsync(750);
  complete(undefined); await flush(); expect(f.started).toEqual([]);
  await expect(lease.promise).rejects.toMatchObject({ name: "AbortError" });
});
it("retries real failures and releases slots even when the loader throws synchronously", async () => {
  let calls = 0;
  const pool = new PassiveAttachments(async () => undefined, () => { calls++; throw new Error("offline"); });
  for (let i = 0; i < 5; i++) await expect(pool.acquire("image").promise).rejects.toThrow("offline");
  expect(calls).toBe(5);
});

it("reports connection shutdown to mounted consumers, including queued and cached lookups", async () => {
  const f = fixture(); const leases = Array.from({ length: 4 }, (_, i) => f.pool.acquire(String(i)));
  await flush(); const reason = new Error("Connection closed"); f.pool.cancelAll(reason);
  for (const lease of leases) await expect(lease.promise).rejects.toBe(reason);
  await flush(); expect(f.active.size).toBe(0);
  let resolve!: (value: Blob | undefined) => void;
  const waiting = fixture(() => new Promise(done => { resolve = done; }));
  const lease = waiting.pool.acquire("cache"); await flush(); waiting.pool.cancelAll(reason);
  resolve(new Blob(["late"])); await expect(lease.promise).rejects.toBe(reason);
  expect(waiting.started).toEqual([]);
});

it("releases a failed cache lookup even when it throws synchronously", async () => {
  const pool = new PassiveAttachments(() => { throw new Error("cache failure"); }, async () => new Blob());
  for (let i = 0; i < 2; i++) await expect(pool.acquire("image").promise).rejects.toThrow("cache failure");
});
