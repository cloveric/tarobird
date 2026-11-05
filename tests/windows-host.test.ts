import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { controlPath, inspectHubService, startHubControl } from "../src/hub/service.js";
import { executableCandidates, npmShimEntrypoint } from "../src/runtime/engine-process.js";

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
it("uses bounded, case-insensitive, per-host Windows named pipes, including long Unicode paths", () => {
  const dir = "C:\\Users\\测试用户\\AppData\\Roaming\\" + "long".repeat(80);
  const pipe = controlPath(dir, "win32");
  expect(pipe).toMatch(/^\\\\\.\\pipe\\tarobot-hub-[a-f0-9]{64}$/);
  expect(controlPath(dir.toUpperCase(), "win32")).toBe(pipe);
  expect(controlPath(dir + "2", "win32")).not.toBe(pipe);
});
it("finds Windows executable and npm shims using Path/PATHEXT without searching the working directory", () => {
  const env = { Path: '"C:\\Program Files\\nodejs";C:\\Users\\Test\\AppData\\Roaming\\npm', PATHEXT: ".EXE;.CMD;.BAT" };
  expect(executableCandidates("codex", env, "win32")).toContain("C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.CMD");
  expect(executableCandidates('"C:\\Tools\\claude.exe"', env, "win32")).toEqual(["C:\\Tools\\claude.exe"]);
  expect(executableCandidates("codex", { Path: ";;" }, "win32")).toEqual([]);
});
it("resolves npm JS launchers directly, retaining spaces and scoped packages", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "tb-shim-"));
  const entry = path.join(directory, "node_modules", "@example", "cli", "main.mjs");
  await mkdir(path.dirname(entry), { recursive: true }); await writeFile(entry, "");
  const shim = path.join(directory, "test.cmd");
  await writeFile(shim, '@ECHO OFF\r\n"%_prog%" "%dp0%\\node_modules\\@example\\cli\\main.mjs" %*\r\n');
  expect(npmShimEntrypoint(shim)).toBe(entry);
  await writeFile(shim, '@ECHO OFF\r\necho custom launcher\r\n');
  expect(npmShimEntrypoint(shim)).toBeUndefined();
});
it("rejects unauthenticated stop requests and closes its control channel cleanly", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "tb-control-"));
  let stopped = 0;
  const status = { running: true as const, pid: process.pid, url: "http://127.0.0.1:1", publicKey: "fixture" };
  // Exercise the authenticated protocol on Unix too; Windows always requires it.
  const close = await startHubControl(directory, status, () => stopped++, { authenticate: true });
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(controlPath(directory!)); let data = "";
      socket.on("connect", () => socket.end('{"command":"stop"}\n'));
      socket.on("data", chunk => data += chunk); socket.on("close", () => resolve(data)); socket.on("error", reject);
    });
    expect(reply).toBe(""); expect(stopped).toBe(0);
    expect(await inspectHubService(directory, "status", { authenticate: true })).toEqual({ ...status, controlCapabilities: ["target-stop"] });
    expect(await inspectHubService(directory, "stop", { authenticate: true })).toEqual({ ...status, controlCapabilities: ["target-stop"] });
    expect(stopped).toBe(1);
  } finally { await close(); }
  expect(await inspectHubService(directory, "status", { authenticate: true })).toEqual({ running: false });
});
