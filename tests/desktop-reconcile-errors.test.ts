// Isolated regression: runtime probes never stop or replace a production Host.
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopHost } from "../src/hub/desktop.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { managedServiceStatus } from "../src/host-cli/service-manager.js";
import { hubServiceCommand, inspectHubService } from "../src/hub/service.js";
import { withFileMutex } from "../src/state/file-mutex.js";
import { recoverLocalController } from "../client/src/local-controller.js";
import type { HostRegistry } from "../client/src/host-registry.js";

vi.mock("../src/hub/service.js", async original => ({ ...await original<typeof import("../src/hub/service.js")>(), hubServiceCommand: vi.fn(), inspectHubService: vi.fn() }));
vi.mock("../src/host-cli/service-manager.js", async original => ({ ...await original<typeof import("../src/host-cli/service-manager.js")>(), managedServiceStatus: vi.fn() }));
const proof = ["desktop-controller-challenge", "enroll-desktop-controller"];
let root: string;
beforeEach(async () => {
  vi.mocked(inspectHubService).mockResolvedValue({ running: false });
  root = await fs.mkdtemp(path.join(os.tmpdir(), "audit-d5-resume-"));
  await initializeHost(root, "Fixture"); await fs.writeFile(path.join(root, "desktop-enabled.json"), "true\n");
  vi.mocked(managedServiceStatus).mockResolvedValue({ configured: false } as Awaited<ReturnType<typeof managedServiceStatus>>);
});
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it.skipIf(process.platform !== "darwin")("a transient control timeout during an already-current resume retains a retryable waiting status", async () => {
  const identity = JSON.parse(await fs.readFile(path.join(root, "identity.json"), "utf8"));
  // Unauthenticated status works (host running, current, native proof supported);
  // only the authenticated status used by the reconciler times out once.
  vi.mocked(inspectHubService).mockImplementation(async (_d, _c, options) => {
    if (options?.authenticate) throw new Error("hub_control_timeout");
    return { running: true, pid: process.pid, url: "http://127.0.0.1:1", publicKey: identity.publicKey, version: "0.1.445", controlCapabilities: proof };
  });
  const result = await desktopHost("resume", root, path.resolve("dist/src/index.js"));
  expect(result).toMatchObject({ running: true, runtimeIssue: "runtime_waiting" });
  expect(hubServiceCommand).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== "darwin")("a desktop-start mutex held for more than 30 s retains a retryable waiting status", async () => {
  vi.mocked(inspectHubService).mockResolvedValue({ running: false });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const owner = withFileMutex(path.join(root, "desktop-start"), async () => { entered(); await held; });
  await ready;
  try {
    const result = await desktopHost("resume", root, path.resolve("dist/src/index.js"));
    expect(result).toMatchObject({ runtimeIssue: "runtime_waiting" });
    expect(hubServiceCommand).not.toHaveBeenCalled();
  } finally { release(); await owner; }
}, 45_000);

it("the App keeps an authenticated compatible Host usable after a failed update", async () => {
  const pool = { localHostKey: "host-key", localControllerPending: false, refresh: vi.fn(async () => {}) };
  const published: unknown[] = [];
  await recoverLocalController({} as HostRegistry, pool, result => published.push(result), () => true,
    async () => ({ available: true, running: true, publicKey: "host-key", runtimeIssue: "runtime_recovery_failed", controlCapabilities: proof }));
  expect(pool.localControllerPending).toBe(false);
  expect(pool.refresh).not.toHaveBeenCalled();
  expect(published).toEqual([{ publicKey: "host-key", pending: false, issue: "runtime_recovery_failed" }]);
});
