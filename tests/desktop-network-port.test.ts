import net from "node:net";
import { randomInt } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freeDesktopPort } from "../src/hub/desktop-network.js";
import { isLoopback } from "../src/hub/network.js";

vi.mock("node:crypto", async importOriginal => ({ ...await importOriginal<typeof import("node:crypto")>(), randomInt: vi.fn() }));
vi.mock("../src/hub/network.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/hub/network.js")>(), isLoopback: vi.fn() }));

const servers: net.Server[] = [];
async function occupiedPort() {
  const server = net.createServer(); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return (server.address() as net.AddressInfo).port;
}
function rejectBinds(code: string, count: number) {
  const original = net.Server.prototype.listen;
  return vi.spyOn(net.Server.prototype, "listen").mockImplementation(function(this: net.Server, ...args: any[]) {
    if (count-- > 0) { queueMicrotask(() => this.emit("error", Object.assign(new Error(code), { code }))); return this; }
    return Reflect.apply(original, this, args);
  });
}

beforeEach(() => { vi.mocked(isLoopback).mockReturnValue(false); vi.mocked(randomInt).mockReturnValue(0); });
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  await Promise.all(servers.splice(0).filter(server => server.listening).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("desktop network port allocation", () => {
  it("retries an occupied explicit candidate and releases the successful probe", async () => {
    const occupied = await occupiedPort();
    vi.mocked(randomInt).mockReturnValueOnce(occupied).mockReturnValueOnce(0);
    const port = await freeDesktopPort();
    expect(port).not.toBe(occupied);
    expect(randomInt).toHaveBeenCalledTimes(2);
    expect(randomInt).toHaveBeenNthCalledWith(1, 20_000, 32_768);
    const server = net.createServer(); servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  });
  it("keeps OS allocation for loopback-only listeners", async () => {
    vi.mocked(isLoopback).mockReturnValue(true);
    expect(await freeDesktopPort()).toBeGreaterThan(0);
    expect(randomInt).not.toHaveBeenCalled();
  });
  it("retries a Windows excluded explicit port", async () => {
    const listen = rejectBinds("EACCES", 1);
    expect(await freeDesktopPort()).toBeGreaterThan(0);
    expect(listen).toHaveBeenCalledTimes(2);
  });
  it("does not retry a loopback permission error or a vanished interface", async () => {
    vi.mocked(isLoopback).mockReturnValue(true);
    let listen = rejectBinds("EACCES", 1);
    await expect(freeDesktopPort()).rejects.toMatchObject({ code: "EACCES" });
    expect(listen).toHaveBeenCalledTimes(1); listen.mockRestore();
    vi.mocked(isLoopback).mockReturnValue(false);
    listen = rejectBinds("EADDRNOTAVAIL", 1);
    await expect(freeDesktopPort()).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
    expect(listen).toHaveBeenCalledTimes(1);
  });
  it("bounds explicit candidate retries", async () => {
    const listen = rejectBinds("EACCES", 20);
    await expect(freeDesktopPort()).rejects.toMatchObject({ code: "EACCES" });
    expect(listen).toHaveBeenCalledTimes(16);
  });
});

// An interface can disappear between discovery and the first allocation. The
// probe must not let one such address abort every other candidate, and must
// not report a port that was never bound anywhere.
describe("desktop network port allocation with an unavailable interface", () => {
  const vanished = "192.0.2.123", alsoVanished = "192.0.2.124";
  // randomInt is overloaded; this is the synchronous form the allocator uses.
  const candidatePort = vi.mocked(randomInt as unknown as (min: number, max: number) => number);
  async function freePort() {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
  }
  async function expectReleased(port: number) {
    const server = net.createServer(); servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  }
  /** Address-specific bind outcomes; every other bind reaches the real socket. */
  function bindOutcomes(outcomes: Record<string, string[]>) {
    const original = net.Server.prototype.listen;
    return vi.spyOn(net.Server.prototype, "listen").mockImplementation(function(this: net.Server, ...args: any[]) {
      const code = outcomes[String(args[1])]?.shift();
      if (code) { queueMicrotask(() => this.emit("error", Object.assign(new Error(code), { code }))); return this; }
      return Reflect.apply(original, this, args);
    });
  }

  it.each([[[vanished, "127.0.0.1"]], [["127.0.0.1", vanished]]])("keeps the candidate probed on the remaining address and releases it: %j", async addresses => {
    const candidate = await freePort();
    candidatePort.mockReturnValue(candidate);
    expect(await freeDesktopPort(addresses)).toBe(candidate);
    expect(randomInt).toHaveBeenCalledTimes(1);
    await expectReleased(candidate);
  });
  it.each(["EADDRNOTAVAIL", "ENODEV", "ENETUNREACH", "EAFNOSUPPORT"])("treats %s as that address being unavailable, like the Host's optional listener", async code => {
    const candidate = await freePort();
    candidatePort.mockReturnValue(candidate);
    const listen = bindOutcomes({ "198.51.100.7": [code] });
    expect(await freeDesktopPort(["198.51.100.7", "127.0.0.1"])).toBe(candidate);
    expect(listen).toHaveBeenCalledTimes(2);
  });
  it("still retries a conflict on the remaining address", async () => {
    const occupied = await occupiedPort(), candidate = await freePort();
    candidatePort.mockReturnValueOnce(occupied).mockReturnValueOnce(candidate);
    expect(await freeDesktopPort([vanished, "127.0.0.1"])).toBe(candidate);
    expect(randomInt).toHaveBeenCalledTimes(2);
    await expectReleased(candidate);
  });
  it("still retries a Windows excluded port on the remaining address", async () => {
    const excluded = await freePort(), candidate = await freePort();
    candidatePort.mockReturnValueOnce(excluded).mockReturnValueOnce(candidate);
    bindOutcomes({ "127.0.0.1": ["EACCES"] });
    expect(await freeDesktopPort([vanished, "127.0.0.1"])).toBe(candidate);
    expect(randomInt).toHaveBeenCalledTimes(2);
  });
  it("requires one successful probe: every address is tried once, then the unavailability is reported without a retry", async () => {
    const listen = vi.spyOn(net.Server.prototype, "listen");
    await expect(freeDesktopPort([vanished, alsoVanished])).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
    expect(listen).toHaveBeenCalledTimes(2);
    expect(randomInt).toHaveBeenCalledTimes(1);
  });
  it("stays fail-closed on an unexpected bind error and releases the probe already held", async () => {
    const candidate = await freePort();
    candidatePort.mockReturnValue(candidate);
    const listen = bindOutcomes({ "198.51.100.7": ["EINVAL"] });
    await expect(freeDesktopPort(["127.0.0.1", "198.51.100.7"])).rejects.toMatchObject({ code: "EINVAL" });
    expect(listen).toHaveBeenCalledTimes(2);
    listen.mockRestore();
    await expectReleased(candidate);
  });
});
