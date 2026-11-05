import { describe, expect, it, vi } from "vitest";
import { GatewayRunWriter } from "../src/gateway/run-writer.js";
import type { RunEntry } from "../src/client-protocol/run.js";

const target = { messageId: "message", conversationId: "conversation", runId: "run" };
const entry = (seq: number, revision = 1, text = "evidence"): RunEntry => ({ seq, revision, kind: "tool", status: "done", at: 1, text });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describe("bounded background process journal", () => {
  it("holds captured evidence behind publication and releases it only once", async () => {
    const writes: RunEntry[][] = [];
    const writer = new GatewayRunWriter(async input => { writes.push(input.entries); });
    const release = writer.holdForPublication(target, writer.capture(target, [entry(1)]));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(writes).toEqual([]); expect(writer.isBusy()).toBe(true);
    release(); release();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject([{ seq: 1 }]);
    await writer.stop(); expect(writer.isBusy()).toBe(false);
  });
  it("saves the latest held revision on stop before a publication settles", async () => {
    const blocked = gate(), writes: RunEntry[][] = [];
    const writer = new GatewayRunWriter(async input => { writes.push(input.entries); if (writes.length === 1) await blocked.promise; });
    writer.enqueue(target, [entry(1)]);
    await expect.poll(() => writes.length).toBe(1);
    const release = writer.holdForPublication(target, writer.capture(target, [entry(1, 2), entry(2)]));
    const stopping = writer.stop(); release();
    expect(writes.flat().map(e => [e.seq, e.revision])).toEqual([[1, 1], [1, 2], [2, 1]]);
    blocked.resolve(); await stopping;
    expect(writer.isBusy()).toBe(false);
  });
  it("coalesces only duplicate body evidence on a bounded timer and terminal flush bypasses it", async () => {
    vi.useFakeTimers();
    const writes: RunEntry[][] = [];
    const writer = new GatewayRunWriter(async input => { writes.push(input.entries); });
    try {
      writer.enqueue(target, [{ ...entry(1), kind: "text" }]);
      expect(writer.isBusy()).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      writer.enqueue(target, [{ ...entry(1, 2), kind: "text" }]);
      await vi.advanceTimersByTimeAsync(99); expect(writes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2); expect(writes.flat()).toMatchObject([{ seq: 1, revision: 2 }]);
      const terminal = writer.flush(target, [{ ...entry(1, 3), kind: "text" }]);
      await vi.advanceTimersByTimeAsync(2); expect(await terminal).toBe(true);
      expect(writes.flat().map(e => e.revision)).toEqual([2, 3]);
    } finally { await writer.stop(); vi.useRealTimers(); }
  });
  it("thoughts, tool events and shutdown bypass the body-journal delay and leave no timer behind", async () => {
    vi.useFakeTimers();
    const writes: RunEntry[][] = [];
    const writer = new GatewayRunWriter(async input => { writes.push(input.entries); });
    try {
      writer.enqueue(target, [{ ...entry(1), kind: "text" }]);
      writer.enqueue(target, [entry(2)]);
      await vi.advanceTimersByTimeAsync(2);
      expect(writes.flat().map(e => e.seq)).toEqual([1, 2]);
      writer.enqueue(target, [{ ...entry(3), kind: "thinking" }]);
      await vi.advanceTimersByTimeAsync(2);
      expect(writes.flat().map(e => e.seq)).toEqual([1, 2, 3]);
      writer.enqueue(target, [{ ...entry(4), kind: "text" }]);
      await writer.stop();
      expect(writes.flat().map(e => e.seq)).toEqual([1, 2, 3, 4]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000); expect(writes).toHaveLength(3);
    } finally { await writer.stop(); vi.useRealTimers(); }
  });
  it("coalesces revisions behind one in-flight request and flushes every sequence", async () => {
    const blocked = gate(), writes: Array<{ runId: string; entries: RunEntry[] }> = [];
    const writer = new GatewayRunWriter(async input => { writes.push(input); if (writes.length === 1) await blocked.promise; });
    writer.enqueue(target, [entry(1), entry(2)]);
    await expect.poll(() => writes.length).toBe(1);
    for (let rev = 2; rev <= 40; rev++) writer.enqueue(target, [entry(1, rev), entry(3, rev)]);
    expect(writes).toHaveLength(1); expect(writer.isBusy()).toBe(true);
    const finished = writer.flush(target, [entry(1, 41), entry(4)]);
    blocked.resolve(); expect(await finished).toBe(true);
    expect(writes.flatMap(x => x.entries.map(e => [e.seq, e.revision]))).toEqual([[1, 1], [2, 1], [3, 40], [4, 1], [1, 41]]);
    expect(await writer.flush(target, [entry(1, 40)])).toBe(true);
    expect(writes).toHaveLength(2); await writer.stop();
  });
  it("bounds batches by bytes and count, yields fairly, and keeps run identities separate", async () => {
    const blocked = gate(), writes: Array<{ messageId: string; runId: string; entries: RunEntry[] }> = [];
    const writer = new GatewayRunWriter(async input => { writes.push(input); if (writes.length === 1) await blocked.promise; });
    const first = writer.flush(target, Array.from({ length: 10 }, (_, i) => ({ ...entry(i + 1, 1, "字".repeat(32768)), output: "字".repeat(32768) })));
    await expect.poll(() => writes.length).toBe(1);
    const other = writer.flush({ ...target, messageId: "other" }, [entry(1, 2)]);
    const otherRun = writer.flush({ ...target, runId: "other_run" }, [entry(1, 3)]);
    blocked.resolve(); expect(await first).toBe(true); expect(await other).toBe(true); expect(await otherRun).toBe(true);
    expect(writes[1]!.messageId).toBe("other"); expect(writes[2]!.runId).toBe("other_run");
    expect(writes.filter(w => w.messageId === "message" && w.runId === "run").every(w => w.entries.length === 1)).toBe(true);
    await writer.stop();
  });
  it("does not spin after failure, retries unacknowledged revisions, and reports terminal failure", async () => {
    let fail = true, calls = 0;
    const writer = new GatewayRunWriter(async () => { calls++; if (fail) throw new Error("disk failure"); });
    expect(await writer.flush(target, [entry(1)])).toBe(false);
    await new Promise<void>(r => setImmediate(r));
    expect(calls).toBe(1); expect(writer.unavailable(target)).toBe(true);
    fail = false;
    expect(await writer.flush(target, [entry(2)])).toBe(true);
    expect(calls).toBe(2); expect(writer.unavailable(target)).toBe(false);
    await writer.stop();
  });
  it("settles terminal waiters and hands unsent batches to the durable transport before stop", async () => {
    const blocked = gate(); let calls = 0;
    const writer = new GatewayRunWriter(async () => { calls++; await blocked.promise; throw new Error("gateway_stopped"); });
    const flushed = writer.flush(target, Array.from({ length: 10 }, (_, i) => entry(i + 1)));
    await expect.poll(() => calls).toBe(1);
    const stopping = writer.stop(); expect(await flushed).toBe(false);
    expect(writer.stop()).toBe(stopping);
    blocked.resolve(); await stopping; expect(calls).toBe(3); expect(writer.isBusy()).toBe(false);
  });
  it("copies only new evidence and prioritizes terminal evidence over another active run", async () => {
    const blocked = gate(), writes: Array<{ messageId: string; entries: RunEntry[] }> = [];
    const writer = new GatewayRunWriter(async input => { writes.push(input); if (writes.length === 1) await blocked.promise; });
    const entries = Array.from({ length: 2000 }, (_, i) => entry(i + 1));
    const owned = writer.capture(target, entries); entries[0]!.text = "producer mutated";
    expect(owned[0]!.text).toBe("evidence");
    writer.enqueue(target, owned);
    expect(writer.capture(target, entries)).toEqual([]);
    await expect.poll(() => writes.length).toBe(1);
    const next = writer.capture(target, [entry(1, 2)]); expect(next).toHaveLength(1);
    writer.enqueue(target, next);
    const terminal = writer.flush({ ...target, messageId: "terminal" }, [entry(1)]);
    blocked.resolve(); expect(await terminal).toBe(true);
    expect(writes[1]!.messageId).toBe("terminal");
    await writer.stop();
  });
  it("does not repeatedly send permanently rejected entries with every live frame", async () => {
    let calls = 0;
    const writer = new GatewayRunWriter(async () => { calls++; throw new Error("run_limit"); });
    expect(await writer.flush(target, [entry(1)])).toBe(false);
    for (let revision = 2; revision < 100; revision++) {
      expect(writer.capture(target, [entry(1, revision)])).toEqual([]);
      writer.enqueue(target, [entry(1, revision)]);
    }
    expect(await writer.flush(target, [])).toBe(false); expect(calls).toBe(1);
    await writer.stop();
  });
});
