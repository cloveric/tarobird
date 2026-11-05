import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { inspectHubService, startHubControl } from "../src/hub/service.js";

it("binds a foreground stop to the exact process and host identity even if the endpoint is replaced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h-target-")), shutdown = vi.fn();
  let target = { running: true as const, pid: process.pid, publicKey: "original", url: "http://127.0.0.1:8788" };
  const close = await startHubControl(root, () => target, shutdown, { authenticate: true });
  try {
    const observed = await inspectHubService(root, "status", { authenticate: true });
    expect(observed).toMatchObject({ controlCapabilities: ["target-stop"] });
    const guard = { authenticate: true, expectedPid: target.pid, expectedPublicKey: target.publicKey };
    target = { ...target, pid: target.pid + 1 };
    expect(await inspectHubService(root, "stop", guard)).toMatchObject({ controlError: "host_stop_target_changed" });
    expect(shutdown).not.toHaveBeenCalled();
    target = { ...target, pid: process.pid, publicKey: "replacement" };
    expect(await inspectHubService(root, "stop", guard)).toMatchObject({ controlError: "host_stop_target_changed" });
    expect(shutdown).not.toHaveBeenCalled();
    expect(await inspectHubService(root, "stop", { ...guard, expectedPublicKey: target.publicKey })).not.toHaveProperty("controlError");
    expect(shutdown).toHaveBeenCalledOnce();
  } finally { await close(); await rm(root, { recursive: true, force: true }); }
});
