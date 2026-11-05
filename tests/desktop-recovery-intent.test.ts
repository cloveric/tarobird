import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopHost, refreshDesktopHostNetworks } from "../src/hub/desktop.js";
import * as tls from "../src/hub/desktop-tls.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { managedServiceStatus } from "../src/host-cli/service-manager.js";
import { hubServiceCommand, inspectHubService } from "../src/hub/service.js";
import { withFileMutex } from "../src/state/file-mutex.js";

vi.mock("node:fs/promises", async original => {
  const native = await original<typeof import("node:fs/promises")>();
  return { ...native, readFile: vi.fn(native.readFile), writeFile: vi.fn(native.writeFile) };
});
vi.mock("../src/hub/service.js", async original => ({ ...await original<typeof import("../src/hub/service.js")>(), hubServiceCommand: vi.fn(), inspectHubService: vi.fn() }));
vi.mock("../src/host-cli/service-manager.js", async original => ({ ...await original<typeof import("../src/host-cli/service-manager.js")>(), managedServiceStatus: vi.fn() }));
beforeEach(() => {
  vi.mocked(inspectHubService).mockResolvedValue({ running: false });
  vi.mocked(managedServiceStatus).mockResolvedValue({ configured: false } as Awaited<ReturnType<typeof managedServiceStatus>>);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it("a manual stop wins against an automatic resume already waiting for the desktop mutex", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-resume-stop-"));
  await initializeHost(root, "Fixture"); await fs.writeFile(path.join(root, "desktop-enabled.json"), "true\n");
  vi.mocked(managedServiceStatus).mockResolvedValue({ configured: false } as Awaited<ReturnType<typeof managedServiceStatus>>);
  let running = false;
  vi.mocked(inspectHubService).mockImplementation(async () => ({ running }));
  vi.mocked(hubServiceCommand).mockImplementation(async action => { running = action === "start"; });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const owner = withFileMutex(path.join(root, "desktop-start"), async () => { entered(); await held; });
  let resuming: Promise<unknown> | undefined, stopping: Promise<unknown> | undefined;
  try {
    await ready; vi.mocked(fs.readFile).mockClear();
    resuming = desktopHost("resume", root, "fixture");
    await vi.waitFor(() => expect(vi.mocked(fs.readFile).mock.calls.filter(args => String(args[0]).endsWith("desktop-enabled.json"))).toHaveLength(2));
    await new Promise<void>(resolve => setImmediate(resolve));
    stopping = desktopHost("stop", root, "fixture");
    await new Promise<void>(resolve => setImmediate(resolve)); release();
    await Promise.all([owner, resuming, stopping]);
    expect(running).toBe(false);
    expect((await fs.readFile(path.join(root, "desktop-enabled.json"), "utf8")).trim()).toBe("false");
    expect(vi.mocked(hubServiceCommand).mock.calls.at(-1)?.[0]).toBe("stop");
    await desktopHost("resume", root, "fixture"); expect(running).toBe(false);
  } finally { release(); await Promise.allSettled([owner, resuming, stopping]); await fs.rm(root, { recursive: true, force: true }); }
});

it("automatic desktop recovery never rearms an installed OS supervisor", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-resume-supervised-"));
  try {
    await initializeHost(root, "Fixture"); await fs.writeFile(path.join(root, "desktop-enabled.json"), "true\n");
    vi.mocked(managedServiceStatus).mockResolvedValue({ configured: true, enabled: true } as Awaited<ReturnType<typeof managedServiceStatus>>);
    vi.mocked(inspectHubService).mockResolvedValue({ running: false });
    expect(await desktopHost("resume", root, "fixture")).toMatchObject({ running: false });
    expect(hubServiceCommand).not.toHaveBeenCalled();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("persists legacy network opt-in before replacing listeners, including a flag write failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-network-intent-"));
  try {
    const files = await tls.desktopTls(root, ["127.0.0.1", "100.101.102.103"]);
    const config = { host: "127.0.0.1", port: 8788, tlsListeners: ["127.0.0.1", "100.101.102.103"].map(host => ({ host, port: 9876, exposure: "private", tls: { cert: files.cert, key: files.key } })) };
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(config));
    vi.spyOn(tls, "desktopLanAddresses").mockReturnValue(["127.0.0.1"]); vi.spyOn(tls, "desktopTailscaleAddresses").mockReturnValue([]);
    const native = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.writeFile).mockImplementation(((file: any, ...args: any[]) => {
      if (String(file).endsWith("desktop-tailscale-enabled.json")) return Promise.reject(new Error("fixture_flag_write_failed"));
      return (native.writeFile as any)(file, ...args);
    }) as typeof fs.writeFile);
    const apply = vi.fn(async () => {});
    await expect(refreshDesktopHostNetworks(root, apply)).rejects.toThrow("fixture_flag_write_failed");
    expect(apply).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8"))).toEqual(config);
    vi.mocked(fs.writeFile).mockImplementation(native.writeFile);
    await refreshDesktopHostNetworks(root, apply);
    expect((await fs.readFile(path.join(root, "desktop-tailscale-enabled.json"), "utf8")).trim()).toBe("true");
    expect(JSON.parse(await fs.readFile(path.join(root, "config.json"), "utf8")).tlsListeners).toHaveLength(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
