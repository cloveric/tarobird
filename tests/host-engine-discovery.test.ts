import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildHostEnvironment, hostProcessEnvironment } from "../src/host-cli/environment.js";
import { inspectEngines, inspectEnginesWithDiscovery, inspectHost, mergeDiscoveryMetadata } from "../src/host-cli/doctor.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { resolveEngineExecutable } from "../src/runtime/engine-process.js";
import {
  clearDiscoveryCaches,
  defaultCommandRunner,
  diagnoseExecutableCandidates,
  discoverWindowsEngineDirectories,
  lookupEnvCaseInsensitive,
  probeExecutableVersion,
  probeLoginShellEnvironment,
  probePackageManagerBinDirectories,
  runEnvironmentDiscovery,
  SHELL_ENV_PROBE_FLAG,
  type CommandRunner,
} from "../src/host-cli/engine-discovery.js";
import {
  markLiveHostEnvironment,
  parseWindowsRegistryPathEntries,
  parseWindowsRegistryQueryOutput,
  refreshWindowsRegistryPath,
  resetWindowsRegistryPathCache,
  setWindowsRegistryQueryForTest,
} from "../src/runtime/windows-registry-path.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubEngineSettings } from "../src/hub/engine-settings.js";
import {
  engineDiscoveryCacheFile,
  engineSettingsFile,
  hostEngineEnvironment,
  readEngineDiscoveryCache,
  readHostEngineSettings,
  storedEngineSettingsSchema,
} from "../src/runtime/host-engine-settings.js";

const roots: string[] = [];
afterEach(async () => {
  clearDiscoveryCaches();
  resetWindowsRegistryPathCache();
  setWindowsRegistryQueryForTest(undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() { const home = await mkdtemp(path.join(os.tmpdir(), "cli-discovery-")); roots.push(home); return home; }
async function file(home: string, relative: string, text = "#!/bin/sh\nexit 0\n") {
  const target = path.join(home, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); await chmod(target, 0o700); return target;
}
it.runIf(process.platform !== "win32").each([".volta/bin", ".bun/bin", ".asdf/shims", ".local/share/mise/shims"])("discovers %s with a minimal GUI PATH", async directory => {
  const home = await fixture(), cli = await file(home, `${directory}/discovery-cli`);
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } }))).toBe(cli);
});
it.runIf(process.platform !== "win32")("selects only nvm's default version and keeps the inherited PATH ahead of fallbacks", async () => {
  const home = await fixture();
  const chosen = await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  await file(home, ".nvm/versions/node/v24.1.0/bin/discovery-cli");
  await file(home, ".nvm/alias/default", "lts/example\n"); await file(home, ".nvm/alias/lts/example", "v22.12.0\n");
  const env = hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(chosen);
  expect(env.PATH).not.toContain("v24.1.0");
  const inherited = await file(home, "selected/bin/discovery-cli");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, env: { PATH: path.dirname(inherited) } }))).toBe(inherited);
  expect(hostProcessEnvironment({ home, env }).PATH).toBe(env.PATH);
});
it.runIf(process.platform !== "win32")("bounds nvm alias traversal and never executes a profile or guesses an unselected version", async () => {
  const home = await fixture(); await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  await file(home, ".nvm/alias/default", "loop\n"); await file(home, ".nvm/alias/loop", "default\n");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } }))).toBeUndefined();
  await file(home, ".nvm/alias/default", "../../outside\n");
  expect(hostProcessEnvironment({ home, env: {} }).PATH).not.toContain("versions/node");
});
it.runIf(process.platform !== "win32")("honors an explicit nvm root instead of silently choosing the home-directory installation", async () => {
  const home = await fixture();
  await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  await file(home, ".nvm/alias/default", "22\n");
  const configured = path.join(home, "configured-nvm");
  const chosen = await file(configured, "versions/node/v24.1.0/bin/discovery-cli");
  await file(configured, "alias/default", "24\n");
  const env = hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin", NVM_DIR: configured } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(chosen);
  expect(env.PATH).not.toContain(path.join(home, ".nvm/versions/node"));
});
it.runIf(process.platform !== "win32")("follows fnm's default alias including a macOS path containing spaces", async () => {
  const home = await fixture(), root = path.join(home, "Library/Application Support/fnm");
  const cli = await file(home, "Library/Application Support/fnm/node-versions/v22.12.0/installation/bin/discovery-cli");
  await mkdir(path.join(root, "aliases"), { recursive: true });
  await symlink(path.dirname(path.dirname(cli)), path.join(root, "aliases/default"));
  const env = hostProcessEnvironment({ home, platform: "darwin", env: { PATH: "/usr/bin:/bin" } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(path.join(root, "aliases/default/bin/discovery-cli"));
});
it.runIf(process.platform !== "win32")("resolves nvm's stable alias like node instead of preferring an even major", async () => {
  const home = await fixture();
  await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  const latest = await file(home, ".nvm/versions/node/v23.5.0/bin/discovery-cli");
  for (const alias of ["stable", "node"]) {
    await file(home, ".nvm/alias/default", `${alias}\n`);
    const env = hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } });
    expect(resolveEngineExecutable("discovery-cli", env)).toBe(latest);
    expect(env.PATH).not.toContain("v22.12.0");
  }
});
// fnm uses the first existing base directory: XDG data, then ~/.fnm, then (macOS)
// Application Support. A directory fnm itself would not use is never searched.
it.runIf(process.platform !== "win32").each([
  { name: "XDG data on macOS", platform: "darwin" as const, installed: [".local/share/fnm"], chosen: ".local/share/fnm" },
  { name: "the legacy home directory on macOS", platform: "darwin" as const, installed: [".fnm"], chosen: ".fnm" },
  { name: "the legacy home directory on Linux", platform: "linux" as const, installed: [".fnm"], chosen: ".fnm" },
  { name: "XDG data ahead of Application Support", platform: "darwin" as const, installed: [".local/share/fnm", "Library/Application Support/fnm"], chosen: ".local/share/fnm" },
  { name: "the legacy home directory ahead of Application Support", platform: "darwin" as const, installed: [".fnm", "Library/Application Support/fnm"], chosen: ".fnm" },
  { name: "XDG data ahead of the legacy home directory", platform: "linux" as const, installed: [".local/share/fnm", ".fnm"], chosen: ".local/share/fnm" },
])("follows fnm's base directory order: $name", async ({ platform, installed, chosen }) => {
  const home = await fixture();
  for (const root of installed) await file(home, `${root}/aliases/default/bin/discovery-cli`);
  const env = hostProcessEnvironment({ home, platform, env: { PATH: "/usr/bin:/bin" } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(path.join(home, chosen, "aliases/default/bin/discovery-cli"));
  for (const root of installed.filter(root => root !== chosen)) expect(env.PATH).not.toContain(path.join(home, root));
});
it.runIf(process.platform !== "win32")("does not search an fnm directory that fnm itself would not use", async () => {
  const home = await fixture();
  // fnm selects the existing XDG directory even though it has no default alias.
  await mkdir(path.join(home, ".local/share/fnm"), { recursive: true });
  await file(home, ".fnm/aliases/default/bin/discovery-cli");
  await file(home, "Library/Application Support/fnm/aliases/default/bin/discovery-cli");
  for (const platform of ["darwin", "linux"] as const) expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, platform, env: { PATH: "/usr/bin:/bin" } }))).toBeUndefined();
  // An explicit root still wins over every default location.
  const configured = path.join(home, "configured-fnm"), chosen = await file(configured, "aliases/default/bin/discovery-cli");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, platform: "darwin", env: { PATH: "/usr/bin:/bin", FNM_DIR: configured } }))).toBe(chosen);
  // Application Support is a macOS location only.
  const linuxHome = await fixture(); await file(linuxHome, "Library/Application Support/fnm/aliases/default/bin/discovery-cli");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home: linuxHome, platform: "linux", env: { PATH: "/usr/bin:/bin" } }))).toBeUndefined();
});

it.runIf(process.platform !== "win32")("recovers from a dangling symlink on PATH when the real binary lives in a manual Node directory found via login shell", async () => {
  const root = await fixture();
  const stateDir = path.join(root, "state"); await mkdir(stateDir, { recursive: true });
  const localBin = path.join(root, ".local/bin"); await mkdir(localBin, { recursive: true });
  const deletedTarget = path.join(root, "deleted-tool/node/bin/dsh");
  const danglingLink = path.join(localBin, "dsh");
  await symlink(deletedTarget, danglingLink);

  const manualNodeBin = path.join(root, ".local/share/node/node-v24.0.0-darwin-arm64/bin");
  const realDsh = await file(root, ".local/share/node/node-v24.0.0-darwin-arm64/bin/dsh", "#!/bin/sh\necho 'dsh 0.9.4'\n");

  // Without login shell discovery, diagnosing Host PATH sees the dangling symlink and fails to find dsh.
  const baseline = diagnoseExecutableCandidates("dsh", [{ dir: localBin, rule: "path" }], { PATH: localBin });
  expect(baseline.executable).toBeNull();
  expect(baseline.danglingLinks).toEqual([{ linkPath: danglingLink, targetPath: deletedTarget }]);

  // Login shell probe passes TAROBIRD_SHELL_ENV_PROBE=1 and returns the terminal PATH + `command -v dsh`.
  let sawProbeFlag = false;
  const runner: CommandRunner = async (cmd, args, opts) => {
    if (args[0] === "-ilc") {
      sawProbeFlag = opts.env?.[SHELL_ENV_PROBE_FLAG] === "1";
      return {
        stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${localBin}:${manualNodeBin}:/usr/bin\n__TAROBIRD_SHELL_PATH_END__\n__TAROBIRD_CMD__:dsh=${realDsh}\n`,
        stderr: "",
      };
    }
    if (cmd === realDsh && args[0] === "--version") return { stdout: "dsh 0.9.4\n", stderr: "" };
    throw new Error(`unexpected command: ${cmd}`);
  };

  const baseEnv = { HOME: root, PATH: localBin, SHELL: "/bin/zsh" };
  const settings = new HubEngineSettings(stateDir, () => baseEnv);
  const status = await settings.statusAsync(undefined, { forceRefresh: true, runner });
  expect(sawProbeFlag).toBe(true);
  expect(status.shellProbeStatus).toBe("ok");

  const dshRow = status.engines.find(e => e.id === "deepseek")!;
  expect(dshRow.available).toBe(true);
  expect(dshRow.executable).toBe(realDsh);
  expect(dshRow.rule).toBe("login-shell");
  expect(dshRow.version).toBe("dsh 0.9.4");
  expect(dshRow.danglingLinks).toEqual([{ linkPath: danglingLink, targetPath: deletedTarget }]);
  expect(dshRow.terminalExecutable).toBe(realDsh);
  expect(dshRow.override).toBeNull();

  // Auto-discovered path is persisted in the separate discovery cache without mutating strict engine-settings.json.
  await expect(readFile(engineSettingsFile(stateDir), "utf8")).rejects.toThrow();
  const cacheJson = JSON.parse(await readFile(engineDiscoveryCacheFile(stateDir), "utf8"));
  expect(cacheJson.paths?.deepseek).toBe(realDsh);
  expect(cacheJson.searchDirs).toContain(manualNodeBin);
  expect((await stat(engineDiscoveryCacheFile(stateDir))).mode & 0o777).toBe(0o600);
  const hydratedEnv = hostEngineEnvironment(stateDir, baseEnv);
  expect(hydratedEnv.DSH_EXECUTABLE).toBe(realDsh);
  expect(hydratedEnv.PATH?.split(":")).toContain(manualNodeBin);

  // When the remembered auto-discovered binary becomes invalid, Host stops reusing it and searches again.
  await rm(realDsh);
  expect(hostEngineEnvironment(stateDir, baseEnv).DSH_EXECUTABLE).toBeUndefined();
  const movedDsh = await file(root, ".local/share/node/node-v24.1.0-darwin-arm64/bin/dsh", "#!/bin/sh\necho 'dsh 0.9.5'\n");
  const movedBin = path.dirname(movedDsh);
  const runner2: CommandRunner = async (cmd, args) => {
    if (args[0] === "-ilc") {
      return {
        stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${localBin}:${movedBin}:/usr/bin\n__TAROBIRD_SHELL_PATH_END__\n__TAROBIRD_CMD__:dsh=${movedDsh}\n`,
        stderr: "",
      };
    }
    if (cmd === movedDsh && args[0] === "--version") return { stdout: "dsh 0.9.5\n", stderr: "" };
    throw new Error(`unexpected command: ${cmd}`);
  };
  const rechecked = await settings.statusAsync(undefined, { forceRefresh: true, runner: runner2 });
  expect(rechecked.engines.find(e => e.id === "deepseek")?.executable).toBe(movedDsh);
  expect(rechecked.engines.find(e => e.id === "deepseek")?.version).toBe("dsh 0.9.5");
});

it.runIf(process.platform !== "win32")("queries custom npm prefix -g and other package managers for global bin directories", async () => {
  const root = await fixture();
  const stateDir = path.join(root, "state"); await mkdir(stateDir, { recursive: true });
  const customPrefix = path.join(root, "custom-npm-prefix");
  const customBin = path.join(customPrefix, "bin");
  const dsh = await file(root, "custom-npm-prefix/bin/dsh", "#!/bin/sh\necho 'dsh 1.0.0'\n");
  const npmDir = path.join(root, "tool-bin");
  const fakeNpm = await file(root, "tool-bin/npm", "#!/bin/sh\nexit 0\n");

  const pmDirs = await probePackageManagerBinDirectories({
    searchDirs: [npmDir],
    platform: "darwin",
    runner: async (cmd, args) => {
      if (cmd === fakeNpm && args.join(" ") === "prefix -g") return { stdout: `${customPrefix}\n`, stderr: "" };
      throw new Error("not installed");
    },
  });
  expect(pmDirs).toEqual([customBin]);

  const settings = new HubEngineSettings(stateDir, () => ({ HOME: root, PATH: npmDir, SHELL: "/bin/zsh" }));
  const status = await settings.statusAsync(undefined, {
    forceRefresh: true,
    runner: async (cmd, args) => {
      if (args[0] === "-ilc") return { stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${npmDir}\n__TAROBIRD_SHELL_PATH_END__\n`, stderr: "" };
      if (cmd === fakeNpm && args.join(" ") === "prefix -g") return { stdout: `${customPrefix}\n`, stderr: "" };
      if (cmd === dsh && args[0] === "--version") return { stdout: "dsh 1.0.0\n", stderr: "" };
      throw new Error("missing");
    },
  });
  const row = status.engines.find(e => e.id === "deepseek")!;
  expect(row.available).toBe(true);
  expect(row.executable).toBe(dsh);
  expect(row.rule).toBe("package-manager");
  expect(row.version).toBe("dsh 1.0.0");
});

it("parses Windows registry PATH (HKCU + HKLM), expands variables, handles Path casing and discovers Scoop/WinGet/nvm-windows/APPDATA/Git Bash/WSL", async () => {
  const winEnv: NodeJS.ProcessEnv = {
    Path: "C:\\Windows\\System32",
    APPDATA: "C:\\Users\\example\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
    PNPM_HOME: "C:\\Users\\example\\AppData\\Local\\pnpm",
    VOLTA_HOME: "C:\\Users\\example\\AppData\\Local\\Volta",
    SCOOP: "C:\\Users\\example\\scoop",
    NVM_SYMLINK: "C:\\Program Files\\nodejs",
    ProgramFiles: "C:\\Program Files",
    SystemRoot: "C:\\Windows",
  };
  expect(lookupEnvCaseInsensitive(winEnv, "PATH", "win32")).toBe("C:\\Windows\\System32");

  const raw = parseWindowsRegistryQueryOutput(
    "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %APPDATA%\\npm;%LOCALAPPDATA%\\Microsoft\\WinGet\\Links;C:\\Tools\\Custom\r\n",
  );
  const parsed = parseWindowsRegistryPathEntries(raw ? [raw] : [], winEnv);
  expect(parsed).toEqual([
    "C:\\Users\\example\\AppData\\Roaming\\npm",
    "C:\\Users\\example\\AppData\\Local\\Microsoft\\WinGet\\Links",
    "C:\\Tools\\Custom",
  ]);

  const existing = new Set([
    "C:\\Users\\example\\AppData\\Roaming\\npm",
    "C:\\Users\\example\\AppData\\Local\\pnpm",
    "C:\\Users\\example\\AppData\\Local\\Volta\\bin",
    "C:\\Users\\example\\scoop\\shims",
    "C:\\Program Files\\nodejs",
    "C:\\Users\\example\\AppData\\Local\\Microsoft\\WinGet\\Links",
    "C:\\Program Files\\Git\\cmd",
    "C:\\Windows\\System32",
  ]);
  const discovered = discoverWindowsEngineDirectories("C:\\Users\\example", winEnv, dir => existing.has(dir));
  // One Windows known-folder list (#180's order), with Git for Windows and System32 appended last.
  expect(discovered).toEqual([
    "C:\\Users\\example\\AppData\\Local\\Microsoft\\WinGet\\Links",
    "C:\\Users\\example\\AppData\\Roaming\\npm",
    "C:\\Users\\example\\AppData\\Local\\pnpm",
    "C:\\Users\\example\\AppData\\Local\\Volta\\bin",
    "C:\\Program Files\\nodejs",
    "C:\\Users\\example\\scoop\\shims",
    "C:\\Program Files\\Git\\cmd",
    "C:\\Windows\\System32",
  ]);
});

it.runIf(process.platform !== "win32")("falls back cleanly to existing rules when the login shell probe times out", async () => {
  const root = await fixture();
  const stateDir = path.join(root, "state"); await mkdir(stateDir, { recursive: true });
  const voltaCodex = await file(root, ".volta/bin/codex", "#!/bin/sh\necho 'codex 2.1.0'\n");

  const timedOutProbe = await probeLoginShellEnvironment({
    commands: ["codex"],
    env: { HOME: root, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
    runner: async () => {
      const err = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM" });
      throw err;
    },
  });
  expect(timedOutProbe.ok).toBe(false);
  expect(timedOutProbe.status).toBe("timeout");

  const settings = new HubEngineSettings(stateDir, () => ({ HOME: root, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" }));
  const status = await settings.statusAsync(undefined, {
    forceRefresh: true,
    runner: async (cmd, args) => {
      if (args[0] === "-ilc") {
        throw Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
      }
      if (cmd === voltaCodex && args[0] === "--version") return { stdout: "codex 2.1.0\n", stderr: "" };
      throw new Error("not found");
    },
  });
  expect(status.shellProbeStatus).toBe("timeout");
  const codexRow = status.engines.find(e => e.id === "codex")!;
  expect(codexRow.available).toBe(true);
  expect(codexRow.executable).toBe(voltaCodex);
  expect(codexRow.rule).toBe("known-directory");
  expect(codexRow.version).toBe("codex 2.1.0");
});

it.runIf(process.platform !== "win32" && !!resolveEngineExecutable("/bin/zsh"))("wires login-shell discovery into Hub startup, BotManager, /api/bots/catalog, doctor liveEngines, and worker PATH without touching engine-settings.json", async () => {
  const root = await fixture();
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  await mkdir(home, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await initializeHost(stateDir, "Discovery startup host");

  const manualNodeBin = path.join(home, ".local/share/node/node-v24/bin");
  const realDsh = await file(home, ".local/share/node/node-v24/bin/dsh", "#!/bin/sh\necho 'dsh 0.9.9'\n");
  await writeFile(path.join(home, ".zshrc"), `export PATH="${manualNodeBin}:$PATH"\n`);

  const minimalEnv: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/zsh",
    TAROBOT_MODEL_DISCOVERY: "0",
  };
  const hub = await HubServer.start({
    stateDir,
    managedBots: { entrypoint: path.resolve("dist/src/index.js"), env: minimalEnv },
  });
  const closeControl = await startHubControl(
    stateDir,
    { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey },
    () => {},
    { enrollController: value => hub.enrollLocalController(value) },
  );
  const client = await LocalHostClient.connect(stateDir, { enroll: true });
  try {
    // Before GET /api/settings/engines is ever called, /api/bots/catalog already sees DeepSeek.
    const catalog = await client.request<{ engines: Array<{ id: string; available: boolean }> }>("/api/bots/catalog?includePi=1");
    expect(catalog.engines.find(e => e.id === "deepseek")?.available).toBe(true);

    // Strict engine-settings.json was never polluted (v1.6.0 rollback safe).
    await expect(readFile(engineSettingsFile(stateDir), "utf8")).rejects.toThrow();
    expect(storedEngineSettingsSchema.parse(readHostEngineSettings(stateDir)).paths).toEqual({});

    // hostEngineEnvironment includes the discovered bin dir and manual path bin dir in PATH.
    const hydrated = hostEngineEnvironment(stateDir, minimalEnv);
    expect(hydrated.DSH_EXECUTABLE).toBe(realDsh);
    expect(hydrated.PATH?.split(":")).toContain(manualNodeBin);

    const manualBin = path.join(root, "manual-cli-bin");
    const manualCodex = await file(root, "manual-cli-bin/codex", "#!/bin/sh\nexit 0\n");
    const manualEnv = hostEngineEnvironment(stateDir, minimalEnv, {
      format: 1,
      revision: "manual-1",
      paths: { codex: manualCodex },
      receipts: [],
    });
    expect(manualEnv.CODEX_EXECUTABLE).toBe(manualCodex);
    expect(manualEnv.PATH?.split(":")).toContain(manualBin);

    // `tarobot doctor` (`inspectHost(..., true)`) discovers the `.zshrc`-configured dsh and checks liveEngines.
    const report = await inspectHost(stateDir, minimalEnv, true);
    const doctorDsh = report.engines.find(e => e.engine === "deepseek")!;
    expect(doctorDsh.installed).toBe(true);
    const doctorBaseline = resolveEngineExecutable("dsh", buildHostEnvironment({ home, env: minimalEnv }));
    expect(doctorDsh.executable).toBe(doctorBaseline ?? realDsh);
    expect(doctorDsh.terminalExecutable).toBe(realDsh);
    expect(report.liveEngines?.find(e => e.id === "deepseek")?.available).toBe(true);
  } finally {
    client.close();
    await closeControl();
    await hub.close();
  }
}, 25_000);

it("keeps engine-discovery-cache.json non-fail-closed while strict engine-settings.json stays v1.6.0-compatible", async () => {
  const root = await fixture();
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(engineDiscoveryCacheFile(stateDir), "not-valid-json", { mode: 0o600 });
  expect(readEngineDiscoveryCache(stateDir)).toEqual({ format: 1, paths: {}, searchDirs: [] });
  expect(() => hostEngineEnvironment(stateDir, { HOME: root, PATH: "/usr/bin:/bin" })).not.toThrow();
  // v1.6.0 strict schema rejects unknown keys like `discoveredPaths`.
  expect(() => storedEngineSettingsSchema.parse({ format: 1, revision: "r1", paths: {}, receipts: [], discoveredPaths: {} })).toThrow();
});

it("reuses cached Windows registry PATH across discovery calls and refreshes it when requested", async () => {
  let regCalls = 0;
  let currentPath = "C:\\Tools\\v1";
  setWindowsRegistryQueryForTest(async key => {
    regCalls++;
    return key === "HKCU\\Environment" ? "%APPDATA%\\npm" : currentPath;
  });
  const env = {
    USERPROFILE: "C:\\Users\\example",
    APPDATA: "C:\\Users\\example\\AppData\\Roaming",
    PATH: "C:\\Windows\\System32",
  };
  const options = { commands: ["dsh"], home: env.USERPROFILE, platform: "win32" as const };
  expect((await runEnvironmentDiscovery({ ...options, baseEnv: { ...env } })).windowsRegistryDirs).toEqual([]);
  expect(regCalls).toBe(0);

  const discovery = { ...options, baseEnv: markLiveHostEnvironment(env) };
  const first = await runEnvironmentDiscovery(discovery);
  expect(first.windowsRegistryDirs).toEqual(["C:\\Tools\\v1", "C:\\Users\\example\\AppData\\Roaming\\npm"]);
  expect(regCalls).toBe(2);

  currentPath = "C:\\Tools\\v2";
  expect((await runEnvironmentDiscovery(discovery)).windowsRegistryDirs).toEqual(first.windowsRegistryDirs);
  expect(regCalls).toBe(2);
  expect((await runEnvironmentDiscovery({ ...discovery, forceRefresh: true })).windowsRegistryDirs)
    .toEqual(["C:\\Tools\\v2", "C:\\Users\\example\\AppData\\Roaming\\npm"]);
  expect(regCalls).toBe(4);

  // A forced re-detect whose caller already force-read the registry reuses that read: one query per re-detect.
  currentPath = "C:\\Tools\\v3";
  await refreshWindowsRegistryPath(discovery.baseEnv, { platform: "win32", force: true });
  expect(regCalls).toBe(6);
  expect((await runEnvironmentDiscovery({ ...discovery, forceRefresh: true, registryRefreshed: true })).windowsRegistryDirs)
    .toEqual(["C:\\Tools\\v3", "C:\\Users\\example\\AppData\\Roaming\\npm"]);
  expect(regCalls).toBe(6);
});

it("ignores extensionless npm files on Windows", async () => {
  // On Windows, findCommandInDirs inside probePackageManagerBinDirectories must ignore extensionless POSIX npm scripts.
  const root = await fixture();
  const fakeBin = path.join(root, "fake-win-bin");
  await file(root, "fake-win-bin/npm", "#!/bin/sh\necho posix\n");
  const invoked: string[] = [];
  await probePackageManagerBinDirectories({
    searchDirs: [fakeBin],
    platform: "win32",
    runner: async (cmd) => { invoked.push(cmd); return { stdout: "", stderr: "" }; },
  });
  expect(invoked).toEqual([]);
});

it.runIf(process.platform !== "win32")("does not skip login shell probing for buildHostEnvironment/managed-service envs and preserves discovery metadata in doctor", async () => {
  // Managed service / buildHostEnvironment({ env: process.env }) returns a new object with HOME === os.homedir() and no SHELL.
  const built = buildHostEnvironment({ env: process.env });
  expect(built).not.toBe(process.env);
  expect(built.SHELL).toBeUndefined();
  const probed = await probeLoginShellEnvironment({ env: built, commands: ["sh"], timeoutMs: 5000 });
  expect(probed.status).toBe("ok");
  expect(probed.pathDirs.length).toBeGreaterThan(0);

  // mergeDiscoveryMetadata retains safe Unix/Windows discovery metadata while excluding proxies/secrets.
  const unixMerged = mergeDiscoveryMetadata(
    { HOME: "/home/example", PATH: "/usr/bin" },
    { SHELL: "/bin/zsh", ZDOTDIR: "/home/example/.zsh", NVM_DIR: "/home/example/.nvm", HTTPS_PROXY: "http://secret:pass@proxy.invalid", CODEX_HOME: "relative-secret" },
    "darwin",
  );
  expect(unixMerged.SHELL).toBe("/bin/zsh");
  expect(unixMerged.ZDOTDIR).toBe("/home/example/.zsh");
  expect(unixMerged.NVM_DIR).toBe("/home/example/.nvm");
  expect(unixMerged.HTTPS_PROXY).toBeUndefined();
  expect(unixMerged.CODEX_HOME).toBeUndefined();

  const winMerged = mergeDiscoveryMetadata(
    { HOME: "C:\\Users\\example", USERPROFILE: "C:\\Users\\example", PATH: "C:\\Windows\\System32" },
    { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", SCOOP: "C:\\Users\\example\\scoop", PNPM_HOME: "C:\\pnpm", VOLTA_HOME: "C:\\Volta", NVM_SYMLINK: "C:\\Program Files\\nodejs", HTTPS_PROXY: "http://secret@proxy.invalid" },
    "win32",
  );
  expect(winMerged).toMatchObject({
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    SCOOP: "C:\\Users\\example\\scoop",
    PNPM_HOME: "C:\\pnpm",
    VOLTA_HOME: "C:\\Volta",
    NVM_SYMLINK: "C:\\Program Files\\nodejs",
  });
  expect(winMerged.HTTPS_PROXY).toBeUndefined();
});

it.runIf(process.platform !== "win32")("prefers fresh discovery over remembered cache on re-detect, keeps dangling symlinks visible, and avoids stale pinning in hostEngineEnvironment", async () => {
  const root = await fixture();
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  const localBin = path.join(root, ".local/bin");
  await mkdir(localBin, { recursive: true });
  const deletedTarget = path.join(root, "deleted/bin/dsh");
  const danglingLink = path.join(localBin, "dsh");
  await symlink(deletedTarget, danglingLink);

  const dsh22 = await file(root, "node-v22/bin/dsh", "#!/bin/sh\necho 'dsh 22.0.0'\n");
  const dsh24 = await file(root, "node-v24/bin/dsh", "#!/bin/sh\necho 'dsh 24.0.0'\n");
  const bin22 = path.dirname(dsh22);
  const bin24 = path.dirname(dsh24);

  let activeBin = bin22;
  let activeExe = dsh22;
  let activeVer = "dsh 22.0.0";
  let shouldTimeout = false;
  const runner: CommandRunner = async (cmd, args) => {
    if (args[0] === "-ilc") {
      if (shouldTimeout) throw Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
      return {
        stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${localBin}:${activeBin}:/usr/bin\n__TAROBIRD_SHELL_PATH_END__\n__TAROBIRD_CMD__:dsh=${activeExe}\n`,
        stderr: "",
      };
    }
    if (args[0] === "--version" && cmd === activeExe) return { stdout: `${activeVer}\n`, stderr: "" };
    throw new Error(`unexpected: ${cmd}`);
  };

  const baseEnv = { HOME: root, PATH: localBin, SHELL: "/bin/zsh" };
  const settings = new HubEngineSettings(stateDir, () => baseEnv);
  const first = await settings.statusAsync(undefined, { forceRefresh: true, runner });
  const row1 = first.engines.find(e => e.id === "deepseek")!;
  expect(row1.executable).toBe(dsh22);
  expect(row1.rule).toBe("login-shell");
  expect(row1.danglingLinks).toEqual([{ linkPath: danglingLink, targetPath: deletedTarget }]);

  // Switch terminal PATH to node-v24 and re-detect: fresh discovery outranks remembered v22 AND preserves danglingLinks.
  activeBin = bin24;
  activeExe = dsh24;
  activeVer = "dsh 24.0.0";
  const second = await settings.statusAsync(undefined, { forceRefresh: true, runner });
  const row2 = second.engines.find(e => e.id === "deepseek")!;
  expect(row2.executable).toBe(dsh24);
  expect(row2.rule).toBe("login-shell");
  expect(row2.version).toBe("dsh 24.0.0");
  expect(row2.danglingLinks).toEqual([{ linkPath: danglingLink, targetPath: deletedTarget }]);

  // When shell probe times out, remembered v24 acts as fallback while keeping danglingLinks visible.
  shouldTimeout = true;
  const timedOut = await settings.statusAsync(undefined, { forceRefresh: true, runner });
  const row3 = timedOut.engines.find(e => e.id === "deepseek")!;
  expect(row3.executable).toBe(dsh24);
  expect(row3.rule).toBe("auto-discovered");
  expect(row3.danglingLinks).toEqual([{ linkPath: danglingLink, targetPath: deletedTarget }]);

  // Normal PATH binary outranks stale remembered cache in hostEngineEnvironment.
  const normalBin = path.join(root, "normal-bin");
  const normalDsh = await file(root, "normal-bin/dsh", "#!/bin/sh\nexit 0\n");
  const envWithNormalPath = hostEngineEnvironment(stateDir, { HOME: root, PATH: normalBin });
  expect(envWithNormalPath.DSH_EXECUTABLE).toBeUndefined();
  expect(resolveEngineExecutable("dsh", envWithNormalPath)).toBe(normalDsh);

  // doctor.ts inspectEnginesWithDiscovery aligns with statusAsync: falls back to terminalExecutable for all engines.
  const onlyCmdCodex = await file(root, "terminal-only/codex", "#!/bin/sh\necho 'codex 3.0.0'\n");
  const doctorRows = await inspectEnginesWithDiscovery(stateDir, baseEnv, {
    forceRefresh: true,
    runner: async (cmd, args) => {
      if (args[0] === "-ilc") {
        return {
          stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${localBin}\n__TAROBIRD_SHELL_PATH_END__\n__TAROBIRD_CMD__:codex=${onlyCmdCodex}\n`,
          stderr: "",
        };
      }
      if (args[0] === "--version" && cmd === onlyCmdCodex) return { stdout: "codex 3.0.0\n", stderr: "" };
      throw new Error(`unexpected: ${cmd}`);
    },
  });
  const docCodex = doctorRows.find(e => e.engine === "codex")!;
  expect(docCodex.installed).toBe(true);
  expect(docCodex.executable).toBe(onlyCmdCodex);
  expect(docCodex.rule).toBe("login-shell");
  expect(docCodex.terminalExecutable).toBe(onlyCmdCodex);
});

it.runIf(process.platform !== "win32")("reports auto-discovered Pi in ~/.pi/agent/bin as known-directory (never setting) and keeps cached paths labeled auto-discovered in non-live doctor", async () => {
  const root = await fixture();
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  const piExe = await file(root, ".pi/agent/bin/pi", "#!/bin/sh\necho 'pi 1.2.3'\n");
  const baseEnv = { HOME: root, PATH: "/usr/bin:/bin", [SHELL_ENV_PROBE_FLAG]: "0" };
  const settings = new HubEngineSettings(stateDir, () => baseEnv);

  const syncRow = settings.status().engines.find(e => e.id === "pi")!;
  expect(syncRow).toMatchObject({ source: "auto", override: null, executable: piExe, available: true, rule: "known-directory" });

  const asyncRow = (await settings.statusAsync(undefined, { forceRefresh: true, probeVersions: false })).engines.find(e => e.id === "pi")!;
  expect(asyncRow).toMatchObject({ source: "auto", override: null, executable: piExe, available: true, rule: "known-directory" });

  // Non-live inspectEngines / inspectHost must not mislabel cached auto-discovered paths as "environment" or "setting".
  const dshExe = await file(root, "custom-node/bin/dsh", "#!/bin/sh\nexit 0\n");
  await writeFile(engineDiscoveryCacheFile(stateDir), JSON.stringify({ format: 1, paths: { deepseek: dshExe }, searchDirs: [path.dirname(dshExe)] }), { mode: 0o600 });
  const storedSettings = readHostEngineSettings(stateDir);
  const discoveryCache = readEngineDiscoveryCache(stateDir);
  const isolatedNonLive = inspectEngines(
    hostEngineEnvironment(stateDir, baseEnv, storedSettings, { discoveryCache }),
    { baseEnv, settings: storedSettings, discoveryCache },
  );
  expect(isolatedNonLive.find(e => e.engine === "pi")).toMatchObject({ installed: true, executable: piExe, rule: "known-directory" });
  expect(isolatedNonLive.find(e => e.engine === "deepseek")).toMatchObject({ installed: true, executable: dshExe, rule: "auto-discovered" });
  expect(inspectEngines(baseEnv).find(e => e.engine === "pi")?.rule).toBe("known-directory");

  const report = await inspectHost(stateDir, { HOME: root, PATH: "/usr/bin:/bin" }, false);
  for (const row of report.engines) {
    expect(row.rule).not.toBe("setting");
    expect(row.rule).not.toBe("environment");
  }
});

it.runIf(process.platform !== "win32")("does not misclassify a symlink to an existing non-executable file as a dangling symlink", async () => {
  const root = await fixture();
  const binDir = path.join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const nonExecTarget = path.join(root, "real-dsh");
  await writeFile(nonExecTarget, "#!/bin/sh\nexit 0\n");
  await chmod(nonExecTarget, 0o644);
  await symlink(nonExecTarget, path.join(binDir, "dsh"));

  const diagnosed = diagnoseExecutableCandidates("dsh", [{ dir: binDir, rule: "path" }], { PATH: binDir });
  expect(diagnosed.executable).toBeNull();
  expect(diagnosed.danglingLinks).toEqual([]);

  const missingTarget = path.join(root, "does-not-exist");
  const brokenLink = path.join(binDir, "codex");
  await symlink(missingTarget, brokenLink);
  const broken = diagnoseExecutableCandidates("codex", [{ dir: binDir, rule: "path" }], { PATH: binDir });
  expect(broken.executable).toBeNull();
  expect(broken.danglingLinks).toEqual([{ linkPath: brokenLink, targetPath: missingTarget }]);
});

it.runIf(process.platform !== "win32" && !!resolveEngineExecutable("/bin/zsh"))("closes stdin in defaultCommandRunner, guards recursive shell probing, resolves past aliases, and supports non-POSIX shells", async () => {
  // Stdin is closed immediately (`stdio: ["ignore", ...]`), so `cat` returns quickly instead of timing out.
  const started = Date.now();
  const catResult = await defaultCommandRunner("/bin/sh", ["-c", "cat"], { timeout: 2000 });
  expect(catResult.stdout).toBe("");
  expect(Date.now() - started).toBeLessThan(1500);

  // Recursion guard skips when TAROBIRD_SHELL_ENV_PROBE is "1" or "0".
  for (const flag of ["0", "1"]) {
    const res = await probeLoginShellEnvironment({ env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh", [SHELL_ENV_PROBE_FLAG]: flag } });
    expect(res).toEqual({ ok: false, status: "skipped", pathDirs: [], resolvedCommands: {} });
  }

  // Shell aliases in .zshrc / .bashrc must not break resolvedCommands, and a missing last command must not fail exit status.
  const root = await fixture();
  const toolBin = path.join(root, "tool-bin");
  const realDsh = await file(root, "tool-bin/dsh", "#!/bin/sh\nexit 0\n");
  await writeFile(path.join(root, ".zshrc"), `export PATH="${toolBin}:$PATH"\nalias dsh="echo wrapped"\n`);
  await writeFile(path.join(root, ".bashrc"), `shopt -s expand_aliases\nexport PATH="${toolBin}:$PATH"\nalias dsh="echo wrapped"\ndsh() { echo fn; }\n`);
  await writeFile(path.join(root, ".bash_profile"), `source "$HOME/.bashrc"\n`);

  const zshProbe = await probeLoginShellEnvironment({
    shell: "/bin/zsh",
    commands: ["dsh", "definitely_missing_engine_xyz"],
    env: { HOME: root, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
    timeoutMs: 5000,
  });
  expect(zshProbe.ok).toBe(true);
  expect(zshProbe.resolvedCommands.dsh).toBe(realDsh);

  const bashProbe = await probeLoginShellEnvironment({
    shell: "/bin/bash",
    commands: ["dsh", "definitely_missing_engine_xyz"],
    env: { HOME: root, PATH: "/usr/bin:/bin", SHELL: "/bin/bash" },
    timeoutMs: 5000,
  });
  expect(bashProbe.ok).toBe(true);
  expect(bashProbe.resolvedCommands.dsh).toBe(realDsh);

  // Non-POSIX tcsh succeeds on macOS/Unix where /bin/tcsh exists.
  if (resolveEngineExecutable("/bin/tcsh")) {
    await writeFile(path.join(root, ".tcshrc"), `setenv PATH "${toolBin}:$PATH"\nalias dsh "echo wrapped"\n`);
    const tcshProbe = await probeLoginShellEnvironment({
      shell: "/bin/tcsh",
      commands: ["dsh", "definitely_missing_engine_xyz"],
      env: { HOME: root, PATH: "/usr/bin:/bin", SHELL: "/bin/tcsh" },
      timeoutMs: 5000,
    });
    expect(tcshProbe.ok).toBe(true);
    expect(tcshProbe.pathDirs).toContain(toolBin);
    expect(tcshProbe.resolvedCommands.dsh).toBe(realDsh);
  }

  // Fish uses `string join : -- $PATH` and `type -P`.
  let fishArgs: string[] = [];
  const fishProbe = await probeLoginShellEnvironment({
    shell: "/usr/local/bin/fish",
    commands: ["dsh"],
    env: { HOME: root, PATH: "/usr/bin:/bin" },
    runner: async (_cmd, args) => {
      fishArgs = args;
      return {
        stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${toolBin}:/usr/bin\n__TAROBIRD_SHELL_PATH_END__\n__TAROBIRD_CMD__:dsh=${realDsh}\n`,
        stderr: "",
      };
    },
  });
  expect(fishProbe.ok).toBe(true);
  expect(fishArgs[1]).toContain("string join : -- $PATH");
  expect(fishArgs[1]).toContain("type -P -- dsh");
});

it.runIf(process.platform !== "win32")("recovers probeExecutableVersion from transient failures and refreshes static shims on forceRefresh", async () => {
  const root = await fixture();
  const shim = await file(root, "volta/bin/dsh", "#!/bin/sh\necho 'dsh 1.0.0'\n");

  let mode: "fail" | "v1" | "v2" = "fail";
  const runner: CommandRunner = async () => {
    if (mode === "fail") throw Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM", code: "ETIMEDOUT" });
    return { stdout: mode === "v1" ? "dsh 1.0.0\n" : "dsh 2.0.0\n", stderr: "" };
  };

  // Transient error/timeout must NOT be permanently cached.
  expect(await probeExecutableVersion(shim, process.env, runner)).toBeNull();
  mode = "v1";
  expect(await probeExecutableVersion(shim, process.env, runner)).toBe("dsh 1.0.0");

  // Upgrade behind a static shim whose mtimeMs never changed: cached until forceRefresh.
  mode = "v2";
  expect(await probeExecutableVersion(shim, process.env, runner)).toBe("dsh 1.0.0");
  expect(await probeExecutableVersion(shim, process.env, runner, { forceRefresh: true })).toBe("dsh 2.0.0");
});

it.runIf(process.platform !== "win32")("reports and probes the same PATH executable workers launch", async () => {
  const root = await fixture();
  const hostDsh = await file(root, "host/bin/dsh");
  const terminalDsh = await file(root, "terminal/bin/dsh");
  const baseEnv = { HOME: root, PATH: path.dirname(hostDsh), SHELL: "/bin/sh" };
  const settings = new HubEngineSettings(root, () => baseEnv);
  const versionProbes: string[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    if (args[0] === "-ilc") return {
      stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${path.dirname(terminalDsh)}\n__TAROBIRD_SHELL_PATH_END__\n__TAROBIRD_CMD__:dsh=${terminalDsh}\n`,
      stderr: "",
    };
    if (args[0] === "--version") {
      versionProbes.push(cmd);
      return { stdout: "dsh 1.0.0\n", stderr: "" };
    }
    throw new Error("unexpected command");
  };

  await settings.statusAsync(undefined, { runner });
  expect(versionProbes).toEqual([]);
  const status = await settings.statusAsync(undefined, { forceRefresh: true, runner });
  const workerEnv = settings.environment();
  const row = status.engines.find(engine => engine.id === "deepseek");
  expect(row).toMatchObject({
    executable: resolveEngineExecutable(workerEnv.DSH_EXECUTABLE ?? "dsh", workerEnv),
    terminalExecutable: terminalDsh,
    version: "dsh 1.0.0",
    rule: "path",
  });
  expect(versionProbes).toEqual([hostDsh]);
});


it.runIf(process.platform !== "win32")("serves a warm catalog while discovery refreshes and retains the newer explicit result", async () => {
  const root = await fixture();
  const oldDsh = await file(root, "old/bin/dsh");
  const newDsh = await file(root, "new/bin/dsh");
  const env = { HOME: root, PATH: path.join(root, "empty"), SHELL: "/bin/sh", TAROBOT_MODEL_DISCOVERY: "0" };
  const settings = new HubEngineSettings(root, () => env);
  const manager = new BotManager({} as never, root, { entrypoint: "unused", env, engineSettings: settings }, () => "", async () => {});
  const shellOutput = (executable: string) => ({
    stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${path.dirname(executable)}\n__TAROBIRD_SHELL_PATH_END__\n`,
    stderr: "",
  });
  await settings.warmDiscovery({ runner: async () => shellOutput(oldDsh) });

  let finishProbe!: () => void;
  const pending = new Promise<void>(resolve => { finishProbe = resolve; });
  let startProbe!: () => void;
  const started = new Promise<void>(resolve => { startProbe = resolve; });
  const warm = settings.warmDiscovery.bind(settings);
  const refresh = vi.spyOn(settings, "warmDiscovery").mockImplementationOnce(options => warm({
    ...options,
    runner: async () => {
      startProbe();
      await pending;
      return shellOutput(oldDsh);
    },
  }));
  try {
    const catalog = manager.engineCatalog("deepseek");
    await started;
    expect((await catalog).available).toBe(true);

    await settings.statusAsync(undefined, { forceRefresh: true, probeVersions: false, runner: async () => shellOutput(newDsh) });
  } finally {
    finishProbe();
    await refresh.mock.results[0]?.value;
    refresh.mockRestore();
  }
  expect(settings.environment().DSH_EXECUTABLE).toBe(newDsh);
  expect(readEngineDiscoveryCache(root).paths.deepseek).toBe(newDsh);
});

it.runIf(process.platform !== "win32")("never spawns the login shell for a bare environment without HOME", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: CommandRunner = async (file, args) => { calls.push({ file, args }); return { stdout: "", stderr: "" }; };
  const isShellProbe = (args: string[]) => args.some(arg => arg === "-ilc" || arg === "-ic");

  const probe = await probeLoginShellEnvironment({ env: { PATH: "/usr/bin:/bin" }, commands: ["codex"], shell: "/bin/sh", runner });
  expect(probe).toEqual({ ok: false, status: "skipped", pathDirs: [], resolvedCommands: {} });
  const discovery = await runEnvironmentDiscovery({ baseEnv: { PATH: "/usr/bin:/bin" }, commands: ["codex", "agy"], forceRefresh: true, runner });
  expect(discovery.shell.status).toBe("skipped");
  expect(calls.filter(call => isShellProbe(call.args))).toEqual([]);

  // With HOME present the probe still runs (unchanged behaviour).
  await probeLoginShellEnvironment({ env: { HOME: os.homedir(), PATH: "/usr/bin:/bin" }, commands: ["codex"], shell: "/bin/sh", runner });
  expect(calls.filter(call => isShellProbe(call.args))).toHaveLength(1);
});
