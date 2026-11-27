import { expect, it, vi } from "vitest";
import { EngineSessionRestarts } from "../src/codex/engine-session-restart.js";

it("shares a close attempt, times out honestly, and keeps the old process fenced until a verified exit", async () => {
  vi.useFakeTimers();
  try {
    let exit!: () => void;
    const exited = new Promise<void>(resolve => { exit = resolve; });
    const stop = vi.fn();
    const restarts = new EngineSessionRestarts();
    const first = restarts.close("session", { exited, stop });
    expect(restarts.close("session")).toBe(first);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(first).resolves.toEqual({ outcome: "exit_unconfirmed" });
    expect(restarts.exiting("session")).toBeInstanceOf(Promise);
    expect(stop).toHaveBeenCalledOnce();

    const retry = restarts.close("session");
    await vi.advanceTimersByTimeAsync(0);
    exit();
    await expect(retry).resolves.toEqual({ outcome: "closed" });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(restarts.exiting("session")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
