import { afterEach, expect, it, vi } from "vitest";
import { watchLocalHostRecovery } from "../client/src/local-controller.js";

afterEach(() => vi.useRealTimers());

it("resumes an enabled native host periodically and after wake without overlapping attempts", async () => {
  vi.useFakeTimers(); const events = new EventTarget();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const request = vi.fn(async () => { await held; return { available: true }; });
  const stop = watchLocalHostRecovery(request, [events]);
  try {
    await vi.advanceTimersByTimeAsync(20_000); events.dispatchEvent(new Event("focus")); await Promise.resolve();
    expect(request).toHaveBeenCalledExactlyOnceWith({ action: "resume" });
    await vi.advanceTimersByTimeAsync(180_000); events.dispatchEvent(new Event("online"));
    expect(request).toHaveBeenCalledTimes(1);
    release(); await vi.advanceTimersByTimeAsync(60_000); expect(request).toHaveBeenCalledTimes(2);
    stop(); await vi.advanceTimersByTimeAsync(120_000); events.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(2);
  } finally { release(); stop(); }
});

it("recovers after native errors and never upgrades resume into an explicit start or pairing", async () => {
  vi.useFakeTimers(); const events = new EventTarget();
  const request = vi.fn().mockRejectedValueOnce(new Error("temporarily_unavailable")).mockResolvedValue({ available: true, running: false });
  const stop = watchLocalHostRecovery(request, [events]);
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls).toEqual([[{ action: "resume" }], [{ action: "resume" }]]);
  } finally { stop(); }
});
