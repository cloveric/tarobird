import { afterEach, expect, it, vi } from "vitest";
import { queueRequest } from "../client/src/prompt-queue-request.js";

afterEach(() => { vi.useRealTimers(); });

it("ends a timed-out wait even if native IPC ignores cancellation, then allows a fresh request", async () => {
  vi.useFakeTimers();
  const request = queueRequest([], 10_000);
  let resolve!: (value: string) => void;
  const old = request.wait(new Promise<string>(done => { resolve = done; }));
  const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(10_000); await rejected; request.dispose();
  expect(request.signal.aborted).toBe(true);
  const fresh = queueRequest([], 10_000);
  await expect(fresh.wait(Promise.resolve("new snapshot"))).resolves.toBe("new snapshot");
  fresh.dispose(); resolve("late stale snapshot");
  await expect(old).rejects.toMatchObject({ name: "AbortError" });
  expect(vi.getTimerCount()).toBe(0);
});

it("ends a navigation-cancelled wait and consumes a late native rejection", async () => {
  vi.useFakeTimers();
  const parent = new AbortController(), request = queueRequest([parent.signal], 10_000);
  let reject!: (error: Error) => void;
  const old = request.wait(new Promise<never>((_, fail) => { reject = fail; }));
  parent.abort(); await expect(old).rejects.toMatchObject({ name: "AbortError" });
  request.dispose(); reject(new Error("late native failure"));
  await Promise.resolve(); expect(vi.getTimerCount()).toBe(0);
});

it("preserves a definite HTTP failure instead of replacing it with a later timeout", async () => {
  vi.useFakeTimers();
  const request = queueRequest([], 10_000), conflict = new Error("queue_changed");
  await expect(request.wait(Promise.reject(conflict))).rejects.toBe(conflict);
  request.dispose(); expect(vi.getTimerCount()).toBe(0);
});
