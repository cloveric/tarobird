import * as admission from "../src/host-cli/windows-state-admission.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostCli } from "../src/host-cli/cli.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { HostNetwork } from "../src/host-cli/network-cli.js";
import * as setup from "../src/host-cli/setup.js";
import * as runtime from "../src/host-cli/update.js";
import * as guard from "../src/host-cli/schema-guard.js";
import * as manager from "../src/host-cli/service-manager.js";
import * as service from "../src/hub/service.js";
import * as tls from "../src/hub/desktop-tls.js";
import * as network from "../src/hub/desktop-network.js";
import * as lifecycle from "../src/host-cli/lifecycle.js";
import * as recovery from "../src/host-cli/update-recovery.js";
import * as files from "node:fs/promises";
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
const key = "A".repeat(59) + "=";
const status = { running: true, pid: process.pid, publicKey: key, url: "http://127.0.0.1:8788", drained: false, draining: false, controlCapabilities: ["drain-renew", "drained-stop"] };
afterEach(async () => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-cli-day-audit-")); roots.push(directory);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(setup, "requireInitialized").mockResolvedValue(undefined as never);
  vi.spyOn(setup, "readHostProfile").mockResolvedValue({ name: "Fixture", revision: 0 });
  vi.spyOn(runtime, "resolveHostRuntime").mockResolvedValue({ entrypoint: "/fixture/dist/src/index.js", executable: process.execPath } as never);
  vi.spyOn(guard, "assertHostRuntimeCompatible").mockResolvedValue({ schema: 14, minHubSchema: 1, maxHubSchema: 14, writeHubSchema: 14 });
  return { directory, output, args: ["--state-dir", directory, "--json"] };
}
async function pairingFixture(addresses = ["192.168.1.2"], renewed = false, mode: "lan" | "tailscale" = "lan") {
  const f = await fixture(), cert = path.join(f.directory, "desktop-tls/server.pem"), keyFile = path.join(f.directory, "desktop-tls/server-key.pem");
  await mkdir(path.dirname(cert)); await writeFile(cert, "old-certificate"); await writeFile(keyFile, "old-key");
  await writeFile(path.join(f.directory, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 8788, instancePort: 8789, tlsListeners: addresses.map(host => ({ host, exposure: mode === "tailscale" ? "private" : "public", port: 8790, tls: { cert, key: keyFile } })) }));
  vi.spyOn(tls, "desktopLanAddresses").mockReturnValue(mode === "lan" ? addresses : []);
  vi.spyOn(tls, "desktopTailscaleAddresses").mockReturnValue(mode === "tailscale" ? addresses : []);
  vi.spyOn(tls, "desktopTls").mockImplementation(async () => {
    if (renewed) { await writeFile(cert, "new-certificate"); await writeFile(keyFile, "new-key"); }
    return { cert, key: keyFile, certificateAuthority: "A".repeat(120), renewed };
  });
  // Pairing policy uses fake interfaces/certificates; real HTTPS and port
  // availability are covered by desktop-host.test.ts.
  const verifyRoute = vi.spyOn(network, "verifyNetworkRoute").mockResolvedValue(undefined);
  const inspect = vi.spyOn(service, "inspectHubService").mockResolvedValue(status as never);
  const host = vi.spyOn(service, "hubServiceCommand").mockResolvedValue(status as never);
  const request = vi.fn(async (route: string, method: string) => {
    if (route !== "/api/devices/invites" || method !== "POST") throw new Error("unexpected_fixture_request");
    return { id: "i".repeat(22), invite: "t".repeat(43), expiresAt: Date.now() + 300000, serverTime: Date.now() };
  });
  const connect = vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ request, supports: (cap: string) => cap === "pairing-invites.v1", close: vi.fn() } as never);
  return { ...f, inspect, host, connect, verifyRoute, cert, keyFile };
}

it("pairs through an unchanged listener immediately without draining busy Bots or changing network membership/routes", async () => {
  const f = await pairingFixture();
  const drain = vi.spyOn(lifecycle, "waitForHostIdle").mockRejectedValue(new Error("busy Bots must not block pairing"));
  await runHostCli(["pair", "--lan", ...f.args]);
  expect(drain).not.toHaveBeenCalled();
  expect(f.host.mock.calls.map(call => call[0])).toEqual(["start"]);
  expect(f.inspect.mock.calls.every(call => call[1] === undefined)).toBe(true);
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.verifyRoute).toHaveBeenCalledExactlyOnceWith("https://192.168.1.2:8790", "A".repeat(120), key);
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ routes: [{ url: "https://192.168.1.2:8790" }] });
});

it.each(["none", "tailscale", "public", "same-lan", "other-lan"])("records a supported LAN selection without editing signed routes: %s", async kind => {
  const f = await pairingFixture();
  const client = await LocalHostClient.connect(f.directory);
  client.supports = () => true;
  const selected = { name: "Direct", url: "https://192.168.1.2:8790", certificateAuthority: "A".repeat(120) };
  const routes = kind === "none" ? [] : [{ ...selected, name: kind === "tailscale" ? "Tailscale" : "Direct", url: kind === "same-lan" ? selected.url : kind === "tailscale" ? "https://100.64.1.2:8790" : kind === "public" ? "https://relay.example.test:8790" : "https://192.168.1.3:8790" }];
  vi.spyOn(HostNetwork.prototype, "view").mockResolvedValue({ host: { routes } } as never);
  const select = vi.spyOn(HostNetwork.prototype, "selectLan").mockResolvedValue({} as never);
  const command = vi.spyOn(HostNetwork.prototype, "command").mockRejectedValue(new Error("signed routes must remain unchanged"));
  const warning = vi.spyOn(console, "error").mockImplementation(() => {});
  await runHostCli(["pair", "--lan", ...f.args]);
  if (kind === "other-lan") { expect(select).not.toHaveBeenCalled(); expect(warning).toHaveBeenCalledWith(expect.stringContaining("原共享局域网线路保持不变")); }
  else expect(select).toHaveBeenCalledExactlyOnceWith(selected);
  expect(command).not.toHaveBeenCalled();
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ routes: [selected] });
});

it("does not create a pairing invite when the selected endpoint fails HTTPS verification", async () => {
  const f = await pairingFixture();
  f.verifyRoute.mockRejectedValueOnce(new Error("ECONNREFUSED"));
  const drain = vi.spyOn(lifecycle, "waitForHostIdle");
  await expect(runHostCli(["pair", "--lan", ...f.args])).rejects.toThrow("desktop_host_lan_not_listening");
  expect(f.connect).not.toHaveBeenCalled();
  expect(drain).not.toHaveBeenCalled();
  expect(f.output).not.toHaveBeenCalled();
});

it("closes a reserved pairing output if stat fails without deleting a file of unknown identity", async () => {
  const f = await pairingFixture(), destination = path.join(f.directory, "pair.txt");
  const { open: actualOpen } = await vi.importActual<typeof files>("node:fs/promises");
  let closed = false;
  vi.spyOn(files, "open").mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    if (args[0] === destination) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "stat").mockRejectedValue(new Error("stat failed"));
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed = true; });
    }
    return handle;
  });
  await expect(runHostCli(["pair", "--lan", "--out", destination, ...f.args])).rejects.toThrow("stat failed");
  expect(closed).toBe(true);
  expect(await readFile(destination, "utf8")).toBe("");
  expect(f.host).not.toHaveBeenCalled();
});

it("drains only when a listener certificate needs restarting and releases its exact lease", async () => {
  const f = await pairingFixture(undefined, true);
  const drain = vi.spyOn(lifecycle, "waitForHostIdle").mockResolvedValue("pair_lease");
  vi.spyOn(lifecycle, "captureDrainedStopGuard").mockResolvedValue({ drainId: "pair_lease", pid: process.pid, publicKey: key });
  await runHostCli(["pair", "--lan", ...f.args]);
  expect(drain).toHaveBeenCalledOnce();
  expect(f.host).toHaveBeenCalledWith("restart", expect.any(String), expect.any(String), { requireDrained: true, drainedStop: { drainId: "pair_lease", pid: process.pid, publicKey: key } });
  expect(f.inspect).toHaveBeenCalledWith(expect.any(String), "drain-cancel", { drainId: "pair_lease" });
});

it("restores the existing certificate and leaves the host untouched when pre-restart drain is refused", async () => {
  const f = await pairingFixture(undefined, true), config = await readFile(path.join(f.directory, "config.json"), "utf8");
  vi.spyOn(lifecycle, "waitForHostIdle").mockRejectedValue(new Error("another operation owns drain"));
  await expect(runHostCli(["pair", "--lan", ...f.args])).rejects.toThrow("another operation owns drain");
  expect(f.host).not.toHaveBeenCalled();
  expect(await readFile(f.cert, "utf8")).toBe("old-certificate");
  expect(await readFile(f.keyFile, "utf8")).toBe("old-key");
  expect(await readFile(path.join(f.directory, "config.json"), "utf8")).toBe(config);
});

it("lists multiple interface addresses before configuring anything and accepts an explicit address", async () => {
  const f = await pairingFixture(["172.17.0.1", "192.168.1.2"]), leaf = vi.mocked(tls.desktopTls);
  await expect(runHostCli(["pair", "--lan", ...f.args])).rejects.toThrow("172.17.0.1、192.168.1.2");
  expect(leaf).not.toHaveBeenCalled(); expect(f.host).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  await runHostCli(["pair", "--lan", "--address", "192.168.1.2", ...f.args]);
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ routes: [{ url: "https://192.168.1.2:8790" }] });
  expect(f.connect).toHaveBeenCalledTimes(1);
});

it("pairs a dual-stack Tailscale interface through its unique IPv4 by default and honors explicit IPv6", async () => {
  const ipv6 = "fd7a:115c:a1e0::1234", ipv4 = "100.101.102.103";
  const f = await pairingFixture([ipv6, ipv4], false, "tailscale");
  const drain = vi.spyOn(lifecycle, "waitForHostIdle").mockRejectedValue(new Error("unchanged listener must not drain"));
  await runHostCli(["pair", "--tailscale", ...f.args]);
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ routes: [{ url: `https://${ipv4}:8790` }] });
  await runHostCli(["pair", "--tailscale", "--address", ipv6, ...f.args]);
  expect(JSON.parse(f.output.mock.calls[1]![0])).toMatchObject({ routes: [{ url: `https://[${ipv6}]:8790` }] });
  expect(drain).not.toHaveBeenCalled(); expect(f.connect).toHaveBeenCalledTimes(2);
});

it("requires an address for multiple Tailscale IPv4 candidates but accepts a sole IPv6 route", async () => {
  const ipv6 = "fd7a:115c:a1e0::1234", f = await pairingFixture(["100.101.102.103", ipv6, "100.101.102.104"], false, "tailscale");
  await expect(runHostCli(["pair", "--tailscale", ...f.args])).rejects.toThrow("--address IP");
  expect(tls.desktopTls).not.toHaveBeenCalled(); expect(f.host).not.toHaveBeenCalled();
  vi.mocked(tls.desktopTailscaleAddresses).mockReturnValue([ipv6]);
  // Matching the sole remaining listener avoids an unrelated restart in this check.
  const configFile = path.join(f.directory, "config.json"), config = JSON.parse(await readFile(configFile, "utf8"));
  config.tlsListeners = config.tlsListeners.filter((listener: { host: string }) => listener.host === ipv6);
  await writeFile(configFile, JSON.stringify(config));
  await runHostCli(["pair", "--tailscale", ...f.args]);
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ routes: [{ url: `https://[${ipv6}]:8790` }] });
});

it.each(["apply", "rollback"])("stops %s at a rejected launcher preflight before drain or runtime selection", async action => {
  const f = await fixture();
  vi.spyOn(runtime, "preflightHostUpdate").mockRejectedValue(new Error("host_service_windows_launcher_missing"));
  const drain = vi.spyOn(lifecycle, "waitForHostIdle"), inspect = vi.spyOn(service, "inspectHubService");
  const activate = vi.spyOn(runtime, "activateHostUpdate"), rollback = vi.spyOn(runtime, "rollbackHostUpdate");
  await expect(runHostCli(["update", action, ...(action === "apply" ? ["next"] : []), "--yes", ...f.args])).rejects.toThrow("host_service_windows_launcher_missing");
  expect(drain).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled(); expect(rollback).not.toHaveBeenCalled();
});

it.each(["service", "update"])("honors cancellation before %s staging begins", async command => {
  const f = await fixture();
  vi.mocked(setup.requireInitialized).mockImplementation(async () => { process.emit("SIGINT"); });
  const stage = vi.spyOn(runtime, "stageHostUpdate"), activate = vi.spyOn(runtime, "activateHostUpdate"), install = vi.spyOn(manager, "installManagedService");
  await expect(runHostCli([command, command === "service" ? "install" : "stage", ...(command === "update" ? ["--from", "/fixture/package"] : []), ...f.args])).rejects.toMatchObject({ exitCode: 130 });
  expect(stage).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
});

it.each(["stage", "activate"])("does not advance service installation after cancellation during %s", async boundary => {
  const f = await fixture();
  vi.spyOn(service, "inspectHubService").mockResolvedValue({ running: false });
  vi.spyOn(runtime, "inspectHostUpdateRecovery").mockResolvedValue({} as never);
  vi.spyOn(runtime, "stageHostUpdate").mockImplementation(async () => { if (boundary === "stage") process.emit("SIGTERM"); return { id: "new" } as never; });
  const activate = vi.spyOn(runtime, "activateHostUpdate").mockImplementation(async () => { process.emit("SIGINT"); return {} as never; });
  const install = vi.spyOn(manager, "installManagedService");
  await expect(runHostCli(["service", "install", ...f.args])).rejects.toMatchObject({ exitCode: 130 });
  if (boundary === "stage") expect(activate).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
});

it("restores normal signal delivery when a second interrupt arrives during cancellation", async () => {
  const f = await fixture(), originalListeners = process.listenerCount("SIGINT");
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  vi.mocked(setup.requireInitialized).mockImplementation(async () => {
    process.emit("SIGINT"); process.emit("SIGINT");
    expect(process.listenerCount("SIGINT")).toBe(originalListeners);
  });
  await expect(runHostCli(["update", "stage", "--from", "/fixture/package", ...f.args])).rejects.toMatchObject({ exitCode: 130 });
  expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, "SIGINT");
});

it("rejects a Windows source missing its launcher before freezing or activating it", async () => {
  const f = await fixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  vi.spyOn(admission, "admitWindowsDirectory").mockResolvedValue(f.directory);
  vi.spyOn(admission, "assertWindowsRuntimeAdmission").mockResolvedValue();
  vi.spyOn(service, "inspectHubService").mockResolvedValue({ running: false });
  vi.spyOn(manager, "assertWindowsHostLauncher").mockRejectedValue(new Error("host_service_windows_launcher_missing"));
  const stage = vi.spyOn(runtime, "stageHostUpdate"), activate = vi.spyOn(runtime, "activateHostUpdate"), install = vi.spyOn(manager, "installManagedService");
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try { await expect(runHostCli(["service", "install", ...f.args])).rejects.toThrow("host_service_windows_launcher_missing"); }
  finally { Object.defineProperty(process, "platform", platform); }
  expect(stage).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
});

it("rejects someone else's drain immediately, includes lease expiry, and leaves it untouched", async () => {
  const expires = Date.now() + 30_000;
  const inspect = vi.spyOn(service, "inspectHubService").mockResolvedValue({ ...status, draining: true, drainId: "other", drainLeaseExpiresAt: expires } as never);
  await expect(lifecycle.waitForHostIdle("/fixture", 300_000)).rejects.toThrow(new Date(expires).toISOString());
  expect(inspect).toHaveBeenCalledExactlyOnceWith("/fixture");
});

it("does not request drain when the caller was already cancelled or cancelled during status inspection", async () => {
  const controller = new AbortController(); controller.abort();
  const inspect = vi.spyOn(service, "inspectHubService").mockResolvedValue(status as never);
  await expect(lifecycle.waitForHostIdle("/fixture", 300_000, controller.signal)).rejects.toThrow("等待已取消");
  expect(inspect).not.toHaveBeenCalled();
  const later = new AbortController(); inspect.mockImplementation(async () => { later.abort(); return status as never; });
  await expect(lifecycle.waitForHostIdle("/fixture", 300_000, later.signal)).rejects.toThrow("等待已取消");
  expect(inspect).toHaveBeenCalledExactlyOnceWith("/fixture");
});

it("reports the protected async question's Bot, conversation and next action when drain times out", async () => {
  const inspect = vi.spyOn(service, "inspectHubService").mockImplementation(async (_directory, command, options) => {
    if (!command || command === "status") return { ...status, draining: !!options, drainId: options?.drainId } as never;
    return status as never;
  });
  let drainId: string | undefined;
  inspect.mockImplementation(async (_directory, command, options) => {
    if (command === "drain") drainId = options?.drainId;
    if (command === "drain-cancel") return status as never;
    return { ...status, draining: !!drainId, drainId, drainBlockers: [{ botId: "alpha", conversationKey: "lark:gw_card_conversation", type: "async_question", count: 2 }] } as never;
  });
  await expect(lifecycle.waitForHostIdle("/fixture", 0)).rejects.toThrow("Bot alpha / 会话 lark:gw_card_conversation：待回答的异步问题 2 项");
  expect(inspect).toHaveBeenLastCalledWith("/fixture", "drain-cancel", { drainId });
});

it.each(["refresh", "login"])("reports selected-update recovery when service %s fails", async failure => {
  const f = await fixture();
  vi.spyOn(runtime, "preflightHostUpdate").mockResolvedValue({} as never);
  vi.spyOn(service, "inspectHubService").mockResolvedValue({ running: false });
  vi.spyOn(service, "hubServiceCommand").mockResolvedValue({ running: false });
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: true, enabled: true, running: false } as never);
  vi.spyOn(manager, "refreshManagedServiceRuntime").mockImplementation(async () => { if (failure === "refresh") throw new Error("fixture refresh failed"); });
  vi.spyOn(manager, "enableManagedServiceOnLogin").mockRejectedValue(new Error("fixture login failed"));
  vi.spyOn(runtime, "activateHostUpdate").mockResolvedValue({ id: "receipt", after: { entrypoint: "/new/index.js", executable: process.execPath } } as never);
  const rollback = vi.spyOn(runtime, "rollbackHostUpdate");
  await expect(runHostCli(["update", "apply", "next", "--yes", ...f.args])).rejects.toThrow(/更新已保留记录和原数据.*主机当前未运行.*update status/);
  expect(rollback).not.toHaveBeenCalled();
});

it.each([true, false])("preserves pre-update login intent after an offline selection failure (enabled=%s)", async enabled => {
  const f = await fixture();
  vi.spyOn(runtime, "preflightHostUpdate").mockResolvedValue({} as never);
  vi.spyOn(service, "inspectHubService").mockResolvedValue({ running: false });
  const host = vi.spyOn(service, "hubServiceCommand").mockResolvedValue({ running: false });
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: true, enabled, running: false } as never);
  vi.spyOn(recovery, "captureUpdateRecovery").mockResolvedValue({ running: false, pointer: "original", runtimeId: "original" });
  const restore = vi.spyOn(recovery, "recoverUnchangedAutostart").mockImplementation(async (_directory, _entrypoint, _point, enable) => { await enable(); return true; });
  const enable = vi.spyOn(manager, "enableManagedServiceOnLogin").mockResolvedValue(undefined);
  vi.spyOn(runtime, "activateHostUpdate").mockRejectedValue(new Error("fixture selection failed"));
  await expect(runHostCli(["update", "apply", "next", "--yes", ...f.args])).rejects.toThrow(enabled ? "原登录自启设置已恢复" : "更新选择未完成");
  expect(restore).toHaveBeenCalledTimes(Number(enabled)); expect(enable).toHaveBeenCalledTimes(Number(enabled));
  expect(host.mock.calls.some(call => call[0] === "start")).toBe(false);
});

it("restores pre-update login intent after an online stop failure", async () => {
  const f = await fixture();
  vi.spyOn(runtime, "preflightHostUpdate").mockResolvedValue({} as never);
  vi.spyOn(service, "inspectHubService").mockResolvedValue(status as never);
  vi.spyOn(lifecycle, "waitForHostIdle").mockResolvedValue("update");
  vi.spyOn(lifecycle, "captureDrainedStopGuard").mockResolvedValue({ drainId: "update", pid: process.pid, publicKey: key });
  vi.spyOn(service, "hubServiceCommand").mockRejectedValue(new Error("stop reply lost"));
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: true, enabled: true, running: true } as never);
  vi.spyOn(recovery, "captureUpdateRecovery").mockResolvedValue({ running: true, pointer: "original", runtimeId: "original", publicKey: key });
  vi.spyOn(recovery, "recoverUnchangedRuntime").mockResolvedValue(true);
  const restore = vi.spyOn(recovery, "recoverUnchangedAutostart").mockImplementation(async (_directory, _entrypoint, _point, enable) => { await enable(); return true; });
  const reassert = vi.spyOn(manager, "reassertManagedServiceIntent").mockResolvedValue({ enabled: true } as never);
  await expect(runHostCli(["update", "apply", "next", "--yes", ...f.args])).rejects.toThrow("原登录自启设置已恢复");
  expect(restore).toHaveBeenCalledOnce();
  expect(reassert).toHaveBeenCalledOnce();
});

it("does not report start success or enroll a controller while an existing Hub is draining", async () => {
  const f = await fixture();
  vi.spyOn(service, "inspectHubService").mockResolvedValue({ ...status, draining: true } as never);
  const control = vi.spyOn(LocalHostClient, "connect"), start = vi.spyOn(service, "hubServiceCommand");
  await expect(runHostCli(["start", ...f.args])).rejects.toThrow("主机正在收尾或退出");
  expect(control).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});
