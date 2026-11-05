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
