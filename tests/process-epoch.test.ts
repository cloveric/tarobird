import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mock.exec }) }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const guid = "AABBCCDD-1111-2222-3333-444444444444";
beforeEach(() => {
  vi.resetModules(); mock.exec.mockReset();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  mock.exec.mockImplementation(async (_file, args: string[]) => ({ stdout: Buffer.from(args.at(-1)!, "base64").toString("utf16le").includes("Cryptography") ? guid : "123456789012345678", stderr: "" }));
});
afterEach(() => { Object.defineProperty(process, "platform", platform); });

it("reads a stable Windows machine identity once and retains independent PID creation times", async () => {
  const { readProcessEpoch } = await import("../src/state/process-epoch.js");
  const expected = { machineId: `win32:${guid.toLowerCase()}`, processBirth: "win32:123456789012345678" };
  expect(await readProcessEpoch(process.pid)).toEqual(expected);
  expect(await readProcessEpoch(process.pid)).toEqual(expected);
  expect(await readProcessEpoch(process.pid + 1)).toEqual(expected);
  expect(mock.exec.mock.calls.filter(([, args]) => Buffer.from(args.at(-1), "base64").toString("utf16le").includes("Cryptography"))).toHaveLength(1);
  expect(mock.exec).toHaveBeenCalledTimes(3);
  for (const [file, , options] of mock.exec.mock.calls) {
    expect(file).toBe("powershell.exe"); expect(options).toMatchObject({ windowsHide: true, timeout: 5000 });
  }
});

it("keeps the machine identity available when the queried PID has already exited", async () => {
  mock.exec.mockImplementation(async (_file, args: string[]) => {
    if (!Buffer.from(args.at(-1)!, "base64").toString("utf16le").includes("Cryptography")) throw new Error("process not found");
    return { stdout: guid, stderr: "" };
  });
  const { readProcessEpoch } = await import("../src/state/process-epoch.js");
  expect(await readProcessEpoch(123)).toEqual({ machineId: `win32:${guid.toLowerCase()}` });
});

it.each(["not-a-guid", "unavailable"])("keeps machine ownership unknown for %s instead of inventing it", async value => {
  mock.exec.mockImplementation(async (_file, args: string[]) => {
    if (Buffer.from(args.at(-1)!, "base64").toString("utf16le").includes("Cryptography")) {
      if (value === "unavailable") throw new Error("access denied");
      return { stdout: value, stderr: "" };
    }
    return { stdout: "123", stderr: "" };
  });
  const { readProcessEpoch } = await import("../src/state/process-epoch.js");
  expect(await readProcessEpoch(123)).toEqual({ processBirth: "win32:123" });
});

it("captures Darwin process birth with a stable locale and distinguishes reused PIDs", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  let birth = "Mon Oct 19 08:00:00 2026";
  mock.exec.mockImplementation(async (file: string) => ({ stdout: file === "/usr/sbin/sysctl" ? guid : birth, stderr: "" }));
  const { readProcessEpoch } = await import("../src/state/process-epoch.js");
  const first = await readProcessEpoch(123);
  birth = "Mon Oct 19 08:00:01 2026";
  const second = await readProcessEpoch(123);
  expect(first.bootId).toBe(`darwin:${guid.toLowerCase()}`);
  expect(first.processBirth).toMatch(/^darwin:\d+$/);
  expect(second.processBirth).not.toBe(first.processBirth);
  expect(mock.exec).toHaveBeenCalledWith("/bin/ps", ["-p", "123", "-o", "lstart="], expect.objectContaining({ env: expect.objectContaining({ LC_ALL: "C", TZ: "UTC" }) }));
});
