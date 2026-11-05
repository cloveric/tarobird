import { afterEach, expect, it, vi } from "vitest";
import { anySignal, timeoutSignal } from "../client/src/abort-signals.js";
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("falls back on old WebKit and retains timeout reason", async () => {
  vi.spyOn(AbortSignal, "any", "get").mockReturnValue(undefined as never);
  vi.spyOn(AbortSignal, "timeout", "get").mockReturnValue(undefined as never);
  vi.useFakeTimers();
  const source = new AbortController(), signal = anySignal([source.signal, timeoutSignal(20)]);
  await vi.advanceTimersByTimeAsync(20);
  expect(signal.aborted).toBe(true); expect(signal.reason.name).toBe("TimeoutError");
  const reason = new Error("stopped"); source.abort(reason);
  expect(anySignal([source.signal]).reason).toBe(reason);
});
