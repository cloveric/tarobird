import { afterAll, beforeEach, expect, it, vi } from "vitest";

// Synthetic Windows filesystem: never execute candidate launchers or depend on
// a developer's installed engines. Exercise the actual consumers on every OS.
const fixture = vi.hoisted(() => {
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  return { platform, files: new Set<string>(), directories: new Set<string>() };
});
vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>();
  return { ...actual.win32, default: actual.win32 };
});
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const synthetic = (file: unknown): file is string => typeof file === "string" && /^(?:[A-Za-z]:[\\/]|fixture-relative[\\/])/.test(file);
  const key = (file: string) => file.replace(/\//g, "\\").toLowerCase();
  const missing = () => Object.assign(new Error("fixture file missing"), { code: "ENOENT" });
  const overrides = {
    existsSync: (file: string) => synthetic(file) ? fixture.files.has(key(file)) || fixture.directories.has(key(file)) : actual.existsSync(file),
    accessSync: (file: string, mode?: number) => {
      if (!synthetic(file)) return actual.accessSync(file, mode);
      if (!fixture.files.has(key(file)) && !fixture.directories.has(key(file))) throw missing();
    },
    statSync: (file: string) => {
      if (!synthetic(file)) return actual.statSync(file);
      if (!fixture.files.has(key(file)) && !fixture.directories.has(key(file))) throw missing();
      return { isFile: () => fixture.files.has(key(file)), isDirectory: () => fixture.directories.has(key(file)) };
    },
    lstatSync: (file: string) => { if (synthetic(file)) throw missing(); return actual.lstatSync(file); },
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

import { resolveBridgeConfig } from "../src/config.js";
import { inspectEngines, inspectHost } from "../src/host-cli/doctor.js";
import * as hostPaths from "../src/host-cli/paths.js";
import * as serviceManager from "../src/host-cli/service-manager.js";
import * as hubService from "../src/hub/service.js";
import { buildHostEnvironment, hostProcessEnvironment } from "../src/host-cli/environment.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubEngineSettings } from "../src/hub/engine-settings.js";
import { resolveEngineExecutable } from "../src/runtime/engine-process.js";
import { resolveDeepSeekExecutable } from "../src/runtime/deepseek-executable.js";
import { hostEngineEnvironment } from "../src/runtime/host-engine-settings.js";

const profile = "C:\\Users\\example", roaming = `${profile}\\AppData\\Roaming`, local = `${profile}\\AppData\\Local`;
const desktop = `${local}\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd`;
const npm = `${roaming}\\npm\\dsh.cmd`, other = "C:\\Tools\\dsh.cmd";
const base = { USERPROFILE: profile, APPDATA: roaming, LOCALAPPDATA: local, PATH: "C:\\Tools", PATHEXT: ".EXE;.CMD" };
const normalize = (file: string | null | undefined) => file?.toLowerCase() ?? null;
const install = (...files: string[]) => files.forEach(file => fixture.files.add(file.toLowerCase()));
beforeEach(() => { fixture.files.clear(); fixture.directories.clear(); });
afterAll(() => { Object.defineProperty(process, "platform", { value: fixture.platform, configurable: true }); });

function surfaces(input: NodeJS.ProcessEnv = base) {
  const env = hostProcessEnvironment({ env: input, home: profile, executable: "C:\\TaroBird\\node.exe" });
  const before = { ...env };
  const settings = new HubEngineSettings("C:\\Fixture\\host", () => env).status().engines.find(item => item.id === "deepseek")!;
  const manager = new BotManager({} as never, "C:\\Fixture\\host", { entrypoint: "unused", env }, () => "", async () => {});
  const doctor = inspectEngines(env).find(item => item.engine === "deepseek")!;
  const initial = inspectEngines(input).find(item => item.engine === "deepseek")!;
  // Workers have an explicit state directory; missing/case-varied profile roots
  // here exercise CLI discovery, not the separate default state-dir policy.
  const command = resolveBridgeConfig({ ...env, TAROBOT_STATE_DIR: "C:\\Fixture\\bot" }).deepseekExecutable;
  const launched = resolveEngineExecutable(command, env);
  expect(env).toEqual(before); // Discovery must not inject DSH_EXECUTABLE or PATH.
  return { available: manager.engineAvailable("deepseek"), settings, paths: [settings.executable, doctor.executable, initial.executable, launched].map(normalize) };
}
function expectFile(file: string | null, env: NodeJS.ProcessEnv = base) {
  const result = surfaces(env);
  expect(result.available).toBe(file !== null);
  expect(result.paths).toEqual(Array(4).fill(normalize(file)));
  return result;
}

it("discovers the Desktop default when it is absent from PATH across launch, Doctor and settings", () => {
  install(desktop);
  expect(expectFile(desktop).settings.source).toBe("auto");
});
it("keeps npm ahead of Desktop and another PATH installation", () => {
  install(npm, desktop, other);
  expectFile(npm);
});
it("keeps an existing PATH installation ahead of the new Desktop fallback", () => {
  install(desktop, other);
  expectFile(other);
});
it("preserves relative PATH commands without resolving their directory twice", () => {
  const relative = "fixture-relative\\dsh.cmd";
  install(relative);
  expectFile(relative, { ...base, PATH: "fixture-relative" });
  install(desktop);
  expectFile(relative, { ...base, PATH: "fixture-relative" });
});
it("preserves explicit paths, including invalid overrides, without silently falling back", () => {
  install(npm, desktop, other);
  expect(expectFile(other, { ...base, DSH_EXECUTABLE: other }).settings.source).toBe("environment");
  expectFile(null, { ...base, DSH_EXECUTABLE: "C:\\Missing\\dsh.cmd" });
});
it("uses the same profile-derived npm location when APPDATA is absent", () => {
  install(npm, desktop);
  expectFile(npm, { ...base, APPDATA: undefined });
});
it("uses the profile-derived Desktop location when LOCALAPPDATA is absent", () => {
  install(desktop);
  expectFile(desktop, { ...base, LOCALAPPDATA: undefined });
});
it("ignores missing candidates and directories masquerading as launchers", () => {
  expectFile(null);
  fixture.directories.add(desktop.toLowerCase());
  expectFile(null);
});
it("sees install and uninstall on the next read without a cached negative result", () => {
  expectFile(null);
  install(desktop);
  expectFile(desktop);
  fixture.files.clear();
  expectFile(null);
});
it("keeps the other engines on their existing discovery paths", () => {
  install(desktop, ...["codex", "claude", "agy", "kimi"].map(name => `C:\\Tools\\${name}.cmd`));
  const rows = inspectEngines(base).filter(row => row.engine !== "deepseek" && row.engine !== "pi" && row.engine !== "omp");
  expect(rows.map(row => normalize(row.executable))).toEqual(["codex", "claude", "agy", "kimi"].map(name => `c:\\tools\\${name}.cmd`));
});
it("handles case-insensitive Windows variables and keeps explicit source labels", () => {
  install(desktop, other);
  const env = { userprofile: profile, appdata: roaming, localappdata: local, Path: "C:\\Empty", pathext: ".EXE;.CMD" };
  expectFile(desktop, env);
  expect(expectFile(other, { ...env, dsh_executable: `"${other}"` }).settings.source).toBe("environment");
  const alias: NodeJS.ProcessEnv = { DSH_EXECUTABLE: undefined, dsh_executable: other };
  expect(resolveDeepSeekExecutable(alias)).toBe(other);
});
it("does not turn empty or invalid explicit commands into PATH extension probes", () => {
  install(desktop, npm, "C:\\Tools\\.CMD");
  for (const explicit of ['""', "   ", "C:\\Tools\\bad\u0000.cmd"]) expectFile(null, { ...base, DSH_EXECUTABLE: explicit });
});
it("rejects invalid installation roots before deriving or normalizing a candidate", () => {
  install(desktop);
  for (const root of ["relative", "\\drive-relative", "C:\\invalid\n\\..\\Users\\example", `${local}\u0000`]) {
    expectFile(null, { ...base, LOCALAPPDATA: root });
    expectFile(null, { ...base, APPDATA: undefined, LOCALAPPDATA: undefined, USERPROFILE: root });
  }
  expectFile(null, { PATH: "C:\\Empty" });
});
it("does not consider Windows candidates on macOS or Linux", () => {
  install(desktop, npm, other);
  for (const platform of ["darwin", "linux"] as const) {
    expect(resolveDeepSeekExecutable(base, platform)).toBe("dsh");
    expect(resolveDeepSeekExecutable({ ...base, DSH_EXECUTABLE: '"/fixture/dsh"' }, platform)).toBe("/fixture/dsh");
  }
});
it("canonicalizes a real Windows Host override before Bot-specific environment loading", () => {
  const inherited = { ...base, dsh_executable: other, DSH_EXECUTABLE: undefined };
  const env = hostEngineEnvironment("C:\\Fixture\\host", inherited);
  expect(env.DSH_EXECUTABLE).toBe(other);
  expect(env.dsh_executable).toBeUndefined();
  expect(inherited.dsh_executable).toBe(other);
  expect(inherited.DSH_EXECUTABLE).toBeUndefined();
  install(desktop, other);
  expectFile(other, env);
  // Do not reinterpret empty/invalid explicit values when canonicalizing case.
  expect(hostEngineEnvironment("C:\\Fixture\\host", { dsh_executable: "   " }).DSH_EXECUTABLE).toBe("   ");
});
it("accepts the same quoted DeepSeek override in Doctor/service and worker environments", () => {
  install(desktop, other);
  const options = { home: profile, executable: "C:\\TaroBird\\node.exe" };
  const env = buildHostEnvironment({ ...options, env: { ...base, DSH_EXECUTABLE: `"${other}"` } });
  expect(env.DSH_EXECUTABLE).toBe(other);
  expectFile(other, env);
  expect(() => buildHostEnvironment({ ...options, env: { ...base, DSH_EXECUTABLE: `${other}\n` } })).toThrow("host_service_invalid_environment");
  expect(() => buildHostEnvironment({ ...options, env: { ...base, CODEX_EXECUTABLE: `"${other}"` } })).toThrow("host_service_engine_override_absolute_path_required");
});
it("keeps a quoted DeepSeek override in Doctor's invalid-environment fallback", async () => {
  vi.spyOn(hostPaths, "exists").mockResolvedValue(false);
  vi.spyOn(hostPaths, "resolveDesktopHostDirectory").mockResolvedValue("C:\\Fixture\\host");
  vi.spyOn(hubService, "inspectHubService").mockResolvedValue({ running: false });
  vi.spyOn(serviceManager, "managedServiceStatus").mockRejectedValue(new Error("fixture unavailable"));
  vi.spyOn(serviceManager, "managedServiceEnvironmentDifferences").mockResolvedValue([]);
  const custom = "C:\\Manual\\dsh.cmd";
  const env = { ...base, DSH_EXECUTABLE: `"${custom}"`, PATHEXT: "invalid" };
  try {
    install(desktop, other, custom);
    const report = await inspectHost("C:\\Fixture\\host", env);
    expect(report.environmentCheck?.error).toBe("host_environment_invalid");
    expect(report.engines.find(row => row.engine === "deepseek")).toMatchObject({ installed: true, executable: custom });
    fixture.files.delete(custom.toLowerCase());
    expect((await inspectHost("C:\\Fixture\\host", env)).engines.find(row => row.engine === "deepseek")?.installed).toBe(false);
  } finally { vi.restoreAllMocks(); }
});
