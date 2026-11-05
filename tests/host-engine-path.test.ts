import { mkdtemp, mkdir, chmod, writeFile, readFile, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostProcessEnvironment, buildHostEnvironment } from "../src/host-cli/environment.js";
import { hubServiceCommand, inspectHubService } from "../src/hub/service.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { HostManagement } from "../src/host-cli/management.js";
import { renderCoreUserFacingError } from "../src/core/errors.js";

const roots: string[] = [], directories: string[] = [], children: ChildProcess[] = [];
const entry = path.resolve("dist/src/index.js");
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await hubServiceCommand("stop", directory, entry);
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM"); await exited;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(["darwin", "linux", "win32"] as const)("keeps %s host PATH consistent without changing overrides or the input environment", platform => {
  const windows = platform === "win32";
  const home = windows ? "C:\\Users\\demo" : "/home/demo", executable = windows ? "D:\\TaroBot\\node.exe" : "/opt/tarobot/node";
  const env = windows ? { Path: "C:\\Windows;C:\\custom", APPDATA: "C:\\Users\\demo\\AppData\\Roaming", CODEX_EXECUTABLE: "C:\\custom\\codex.cmd", MY_ENGINE_SETTING: "preserved" } : { PATH: "/usr/bin:/bin:/custom", CODEX_EXECUTABLE: "/custom/codex", MY_ENGINE_SETTING: "preserved" };
  const snapshot = { ...env }, result = hostProcessEnvironment({ platform, home, executable, env });
  expect(env).toEqual(snapshot);
  expect(result.CODEX_EXECUTABLE).toBe(env.CODEX_EXECUTABLE);
  expect(result.MY_ENGINE_SETTING).toBe("preserved");
  expect(result.PATH).toBe(buildHostEnvironment({ platform, home, executable, env }).PATH);
  expect(hostProcessEnvironment({ platform, home, executable, env: result }).PATH).toBe(result.PATH);
  if (windows) { expect(result.Path).toBeUndefined(); expect(result.PATH?.split(";")).toContain("C:\\Users\\demo\\AppData\\Roaming\\npm"); }
  else { expect(result.PATH?.split(":")).toContain("/opt/homebrew/bin"); expect(result.PATH?.split(":")).toContain("/home/demo/.kimi-code/bin"); }
});

it.each(["codex", "claude", "kimi", "agy", "dsh"])("explains a missing %s startup path without leaking the executable path or promising restart will fix it", engine => {
  const error = new Error(`spawn /private/owner/${engine} ENOENT`);
  expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("CLI 安装、启动路径（PATH）和 Bot 工作目录");
  expect(renderCoreUserFacingError(error, "engine", "en")).toContain("executable or working directory");
  expect(renderCoreUserFacingError(error, "engine", "zh")).not.toMatch(/重启|private/);
});

it.runIf(process.platform !== "win32").each(["detached", "foreground"] as const)("finds all five installed CLIs from a minimal system PATH in a real %s host", async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-path-")); roots.push(root);
  const home = path.join(root, "user"), directory = path.join(root, "host"); directories.push(directory);
  await mkdir(path.join(home, ".local/bin"), { recursive: true });
  // The catalog uses disposable executables, never a real engine or model.
  for (const command of ["codex", "claude", "kimi", "dsh", "agy"]) {
    const cli = path.join(home, ".local/bin", command);
    await writeFile(cli, "#!/bin/sh\nexit 0\n"); await chmod(cli, 0o700);
  }
  await initializeHost(directory, "PATH regression host");
  const identity = await readFile(path.join(directory, "identity.json"), "utf8");
  const env = { ...process.env, HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CODEX_EXECUTABLE: "", CLAUDE_EXECUTABLE: "", KIMI_EXECUTABLE: "", DSH_EXECUTABLE: "", ANTIGRAVITY_EXECUTABLE: "" };
  if (mode === "detached") {
    for (const key of ["HOME", "PATH", "CODEX_EXECUTABLE", "CLAUDE_EXECUTABLE", "KIMI_EXECUTABLE", "DSH_EXECUTABLE", "ANTIGRAVITY_EXECUTABLE"] as const) vi.stubEnv(key, env[key]);
    await hubServiceCommand("start", directory, entry);
    vi.unstubAllEnvs();
  } else {
    const child = spawn(process.execPath, [entry, "hub", "run", "--state-dir", directory], { env, stdio: "ignore" }); children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    await vi.waitFor(async () => expect((await inspectHubService(directory)).running).toBe(true), { timeout: 15000 });
  }
  const client = await LocalHostClient.connect(directory, { enroll: true });
  try {
    const catalog = await new HostManagement(client).catalog();
    expect(catalog.engines.map(engine => [engine.id, engine.available]).sort()).toEqual([
      ["antigravity", true], ["claude", true], ["codex", true], ["deepseek", true], ["kimi", true],
    ]);
  } finally { client.close(); }
  expect(await readFile(path.join(directory, "identity.json"), "utf8")).toBe(identity);
}, 25000);
