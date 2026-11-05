import { afterEach, describe, expect, it, vi } from "vitest";
import { killProcessTree } from "../src/codex/process-tree.js";
import { stopCoreConversation } from "../src/core/card-actions.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { APP_STOP_PROCESS_GRACE_MS, APP_USER_STOP_REASON, appStopKillOptions } from "../src/runtime/turn-cancellation.js";

afterEach(() => vi.useRealTimers());

describe("App explicit user stop", () => {
  it("preserves its reason through combined signals while isolating the compatibility profile and other conversations", async () => {
    const runtime = createCoreServiceRuntime();
    const app = new AbortController(), feishu = new AbortController(), other = new AbortController();
    for (const [key, controller] of [["app", app], ["feishu", feishu], ["other", other]] as const) {
      runtime.activeRuns.set(key, { abortController: controller, startedAt: Date.now() });
    }
    const combined = AbortSignal.any([app.signal, new AbortController().signal]);
    expect(appStopKillOptions(combined)).toBeUndefined();
    await Promise.all([
      withChannelProfile("gateway", async () => { await Promise.resolve(); await stopCoreConversation(runtime, "app"); }),
      withChannelProfile("feishu", async () => { await Promise.resolve(); await stopCoreConversation(runtime, "feishu"); }),
    ]);
    expect(combined.reason).toBe(APP_USER_STOP_REASON);
    expect(appStopKillOptions(combined)).toEqual({ graceMs: APP_STOP_PROCESS_GRACE_MS });
    expect(feishu.signal.aborted).toBe(true);
    expect(appStopKillOptions(feishu.signal)).toBeUndefined();
    expect(other.signal.aborted).toBe(false);
    const timeout = new AbortController(); timeout.abort(new Error("Task was stopped by user"));
    expect(appStopKillOptions(timeout.signal)).toBeUndefined();
  });

  it.each([false, true])("bounds the App grace period without killing a reused PID (reused=%s)", async (reused) => {
    vi.useFakeTimers();
    const abort = new AbortController(); abort.abort(APP_USER_STOP_REASON);
    const killFn = vi.fn(); let identity = "original";
    killProcessTree(123, {
      ...appStopKillOptions(abort.signal), platform: "linux", killFn,
      execFileFn: vi.fn((_cmd, _args, callback) => { callback(null, ""); }) as never,
      readIdentityFn: (_pid, callback) => callback(identity),
    });
    // Liveness polls use signal 0; only real signals are counted here.
    const signals = () => killFn.mock.calls.filter(([, signal]) => signal !== 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(killFn).toHaveBeenCalledWith(123, "SIGTERM");
    if (reused) identity = "replacement";
    await vi.advanceTimersByTimeAsync(APP_STOP_PROCESS_GRACE_MS - 1);
    expect(signals()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    if (reused) expect(signals()).toHaveLength(1);
    else expect(signals().at(-1)).toEqual([123, "SIGKILL"]);
  });
});
