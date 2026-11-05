import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { runHostRuntime, type ForegroundRuntimeOptions } from "../src/host-cli/foreground.js";

class Child extends EventEmitter {
  pid = 778899;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
  finish(code: number | null, signal: NodeJS.Signals | null = null) { this.exitCode = code; this.signalCode = signal; this.emit("exit", code, signal); }
}
function fixture(platform: NodeJS.Platform) {
  const child = new Child(), signals = new EventEmitter(), setExitCode = vi.fn(), report = vi.fn();
  const spawn = vi.fn(() => child);
  const inspect = vi.fn<NonNullable<ForegroundRuntimeOptions["inspect"]>>(async () => ({ running: true, pid: child.pid, publicKey: "fixture", controlCapabilities: ["target-stop"], url: "https://localhost:8788" }));
  const options: ForegroundRuntimeOptions = { platform, spawn, signals, inspect, setExitCode, report, retryMs: 1, warnAfterMs: 5 };
  return { child, signals, setExitCode, report, spawn, inspect, options, start: () => runHostRuntime("/node", "/entry.js", ["host", "run"], "/state", options) };
}

it("does not redeliver inherited POSIX SIGINT and retains handlers until the child exits", async () => {
  const f = fixture("darwin"), task = f.start();
  f.signals.emit("SIGINT"); f.signals.emit("SIGINT");
  expect(f.child.kill).not.toHaveBeenCalled(); expect(f.signals.listenerCount("SIGINT")).toBe(1);
  f.child.finish(0); await task;
  expect(f.setExitCode).toHaveBeenCalledWith(0); expect(f.signals.listenerCount("SIGINT")).toBe(0);
  expect(f.spawn).toHaveBeenCalledWith("/node", ["/entry.js", "host", "run"], { stdio: "inherit", windowsHide: true });
});
it("forwards termination once and maps SIGHUP to graceful POSIX SIGTERM", async () => {
  const f = fixture("linux"), task = f.start();
  f.signals.emit("SIGHUP"); f.signals.emit("SIGTERM"); f.signals.emit("SIGTERM");
  expect(f.child.kill).toHaveBeenCalledTimes(1); expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(f.signals.listenerCount("SIGTERM")).toBe(1);
  f.child.finish(null, "SIGTERM"); await task; expect(f.setExitCode).toHaveBeenCalledWith(143);
});
it("uses private control for Windows shutdown without kill(SIGINT), including repeated interrupts", async () => {
  const f = fixture("win32"), task = f.start();
  f.signals.emit("SIGINT"); f.signals.emit("SIGBREAK");
  await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledWith("/state", "stop", { expectedPid: f.child.pid, expectedPublicKey: "fixture" }), { interval: 1 });
  expect(f.child.kill).not.toHaveBeenCalled(); expect(f.signals.listenerCount("SIGINT")).toBe(1);
  f.child.finish(0); await task;
  expect(f.signals.listenerCount("SIGBREAK")).toBe(0); expect(f.setExitCode).toHaveBeenCalledWith(0);
});
it("retries a transient Windows pipe closure and confirms actual child exit", async () => {
  const f = fixture("win32"); f.inspect.mockRejectedValueOnce(new Error("hub_control_closed"));
  const task = f.start(); f.signals.emit("SIGTERM");
  await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledWith("/state", "stop", { expectedPid: f.child.pid, expectedPublicKey: "fixture" }), { interval: 1 });
  expect(f.setExitCode).not.toHaveBeenCalled(); f.child.finish(0); await task;
});
it("does not stop a different Hub when the foreground child fails to acquire its lock", async () => {
  const f = fixture("win32"); f.inspect.mockResolvedValue({ running: true, pid: 112233, publicKey: "other", url: "https://localhost:8788" });
  const task = f.start(); f.signals.emit("SIGINT");
  await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledWith("/state", "status"), { interval: 1 });
  expect(f.inspect.mock.calls.some(call => call[1] === "stop")).toBe(false);
  f.child.finish(78); await task; expect(f.setExitCode).toHaveBeenCalledWith(78);
});
it("reports an unconfirmed Windows shutdown while staying attached rather than orphaning a live child", async () => {
  const f = fixture("win32"); f.inspect.mockRejectedValue(new Error("unavailable"));
  const task = f.start(); f.signals.emit("SIGINT");
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce(), { interval: 1 });
  expect(f.child.kill).not.toHaveBeenCalled(); expect(f.setExitCode).not.toHaveBeenCalled();
  expect(f.signals.listenerCount("SIGINT")).toBe(1);
  f.child.finish(0); await task;
});
it("cleans up signal handlers after spawn failure", async () => {
  const f = fixture("linux"), task = f.start(); const rejected = expect(task).rejects.toThrow("spawn failed");
  f.child.emit("error", new Error("spawn failed")); await rejected;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(f.signals.listenerCount(signal)).toBe(0);
});
it("propagates a child interrupt exit status", async () => {
  const f = fixture("darwin"), task = f.start(); f.child.finish(null, "SIGINT"); await task;
  expect(f.setExitCode).toHaveBeenCalledWith(130);
});

it.each(["darwin", "linux"] as const)("handles a SIGINT sent only to the %s wrapper via exact-child private control", async platform => {
  const f = fixture(platform), task = f.start(); f.signals.emit("SIGINT");
  await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledWith("/state", "stop", { expectedPid: f.child.pid, expectedPublicKey: "fixture" }), { interval: 1 });
  expect(f.child.kill).not.toHaveBeenCalled(); f.child.finish(0); await task;
});
it("uses graceful POSIX termination for an older child without target-bound control", async () => {
  const f = fixture("linux"); f.inspect.mockResolvedValue({ running: true, pid: f.child.pid, publicKey: "old", url: "https://localhost:8788" });
  const task = f.start(); f.signals.emit("SIGINT");
  await vi.waitFor(() => expect(f.child.kill).toHaveBeenCalledWith("SIGTERM"), { interval: 1 });
  expect(f.child.kill).toHaveBeenCalledTimes(1); f.child.finish(0); await task;
});
it("never sends an unguarded Windows stop to an older control server", async () => {
  const f = fixture("win32"); f.inspect.mockResolvedValue({ running: true, pid: f.child.pid, publicKey: "old", url: "https://localhost:8788" });
  const task = f.start(); f.signals.emit("SIGINT");
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce(), { interval: 1 });
  expect(f.inspect.mock.calls.some(call => call[1] === "stop")).toBe(false); expect(f.child.kill).not.toHaveBeenCalled();
  f.child.finish(0); await task;
});
