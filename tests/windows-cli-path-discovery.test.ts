import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// Synthetic Windows filesystem + process platform fixture so Windows CLI path
// discovery, registry refresh, and BotManager/HubEngineSettings integration run
// deterministically on every OS without touching the developer's machine.
const fixture = vi.hoisted(() => {
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  return {
    platform,
    files: new Set<string>(),
    directories: new Set<string>(),
    forkCalls: [] as Array<{ modulePath: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }>,
  };
});

vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>();
  return { ...actual.win32, default: actual.win32 };
});

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const synthetic = (file: unknown): file is string => typeof file === "string" && /^[A-Za-z]:[\\/]/.test(file);
  const key = (file: string) => file.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const missing = () => Object.assign(new Error("fixture file missing"), { code: "ENOENT" });
  const overrides = {
    existsSync: (file: string) => synthetic(file) ? fixture.files.has(key(file)) || fixture.directories.has(key(file)) : actual.existsSync(file),
    accessSync: (file: string, mode?: number) => {
      if (!synthetic(file)) return actual.accessSync(file, mode);
      if (!fixture.files.has(key(file)) && !fixture.directories.has(key(file))) throw missing();
    },
    statSync: (file: string) => {
      if (!synthetic(file)) return actual.statSync(file);
      const k = key(file);
      if (!fixture.files.has(k) && !fixture.directories.has(k)) throw missing();
      return { isFile: () => fixture.files.has(k), isDirectory: () => fixture.directories.has(k), size: 64, mtimeMs: 1, ctimeMs: 1, ino: 1 };
    },
    realpathSync: (file: string) => synthetic(file) ? file : actual.realpathSync(file),
    lstatSync: (file: string) => { if (synthetic(file)) throw missing(); return actual.lstatSync(file); },
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const fork = vi.fn((modulePath: string, args: readonly string[] = [], options?: { env?: NodeJS.ProcessEnv }) => {
    fixture.forkCalls.push({ modulePath, args, env: options?.env ? { ...options.env } : undefined });
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      connected: true,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stderr: new EventEmitter(),
      send: vi.fn((_msg: unknown, cb?: (error: Error | null) => void) => { cb?.(null); return true; }),
      kill: vi.fn(() => true),
    });
    return child;
  });
  return { ...actual, fork, default: { ...actual, fork } };
});

// The opportunistic discovery cache writes through the real fs/promises; with the
// synthetic C:\ state directory that would create files in the working directory.
vi.mock("../src/runtime/host-engine-settings.js", async original => {
  const actual = await original<typeof import("../src/runtime/host-engine-settings.js")>();
  return { ...actual, writeEngineDiscoveryCache: vi.fn(async () => undefined) };
});

vi.mock("../src/codex/antigravity-acp-support.js", () => ({
  antigravitySupportsAcp: vi.fn(async () => true),
}));

vi.mock("../src/runtime/model-catalog.js", async original => {
  const actual = await original<typeof import("../src/runtime/model-catalog.js")>();
  return {
    ...actual,
    readModelCatalogAnswer: vi.fn(async () => ({
      choices: [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash", efforts: ["", "high"] }],
      answered: true,
    })),
  };
});

import { discoverEngineDirectories } from "../src/host-cli/engine-discovery.js";
import { hostProcessEnvironment } from "../src/host-cli/environment.js";
import { inspectEngines } from "../src/host-cli/doctor.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubEngineSettings } from "../src/hub/engine-settings.js";
import { resolveEngineExecutable } from "../src/runtime/engine-process.js";
import { hostEngineEnvironment } from "../src/runtime/host-engine-settings.js";
import {
  WINDOWS_REGISTRY_PATH_KEYS,
  markLiveHostEnvironment,
  refreshWindowsRegistryPath,
  resetWindowsRegistryPathCache,
  setWindowsRegistryQueryForTest,
} from "../src/runtime/windows-registry-path.js";

const profile = "C:\\Users\\alice";
const local = `${profile}\\AppData\\Local`;
const roaming = `${profile}\\AppData\\Roaming`;
const hostDir = "C:\\Fixture\\host";

const norm = (value: string) => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const addDir = (...dirs: string[]) => {
  for (const dir of dirs) fixture.directories.add(norm(dir));
};
const installFile = (...files: string[]) => {
  for (const file of files) {
    fixture.files.add(norm(file));
    const idx = file.lastIndexOf("\\");
    if (idx > 2) fixture.directories.add(norm(file.slice(0, idx)));
  }
};

beforeEach(() => {
  fixture.files.clear();
  fixture.directories.clear();
  fixture.forkCalls.length = 0;
  resetWindowsRegistryPathCache();
  setWindowsRegistryQueryForTest(undefined);
});

afterEach(() => {
  resetWindowsRegistryPathCache();
  setWindowsRegistryQueryForTest(undefined);
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: fixture.platform, configurable: true });
});

describe("Windows discoverEngineDirectories and hostEngineEnvironment", () => {
  it("discovers common Windows CLI directories including %LOCALAPPDATA%\\agy\\bin and %APPDATA%\\npm", () => {
    const dirs = [
      `${local}\\agy\\bin`,
      `${local}\\Programs\\Antigravity\\bin`,
      `${local}\\Programs`,
      `${roaming}\\npm`,
      `${local}\\pnpm`,
      `${local}\\Microsoft\\WinGet\\Links`,
      `${profile}\\.local\\bin`,
      `${profile}\\.bun\\bin`,
      `${profile}\\.cargo\\bin`,
      `${profile}\\.volta\\bin`,
      `${profile}\\scoop\\shims`,
      `${profile}\\.claude\\bin`,
      `${profile}\\.kimi-code\\bin`,
      `${profile}\\.pi\\agent\\bin`,
    ];
    addDir(...dirs);
    const env: NodeJS.ProcessEnv = { USERPROFILE: profile, LOCALAPPDATA: local, APPDATA: roaming };
    const discovered = discoverEngineDirectories(profile, env, "win32");
    for (const dir of dirs) expect(discovered.map(norm)).toContain(norm(dir));
  });

  it("honors explicit PNPM_HOME/VOLTA_HOME/BUN_INSTALL/SCOOP/CARGO_HOME and rejects invalid roots without unsafe fallback", () => {
    addDir("D:\\PnpmHome", "D:\\Volta\\bin", `${local}\\agy\\bin`, `${roaming}\\npm`);
    const customEnv: NodeJS.ProcessEnv = {
      USERPROFILE: profile,
      LOCALAPPDATA: local,
      APPDATA: roaming,
      PNPM_HOME: "D:\\PnpmHome",
      VOLTA_HOME: "D:\\Volta",
    };
    const found = discoverEngineDirectories(profile, customEnv, "win32").map(norm);
    expect(found).toContain(norm("D:\\PnpmHome"));
    expect(found).toContain(norm("D:\\Volta\\bin"));

    // Explicit invalid LOCALAPPDATA must fail closed (must NOT fall back to USERPROFILE\AppData\Local).
    const badLocal = discoverEngineDirectories(profile, {
      USERPROFILE: profile,
      LOCALAPPDATA: "\\drive-relative",
      APPDATA: "relative\\roaming",
    }, "win32").map(norm);
    expect(badLocal).not.toContain(norm(`${local}\\agy\\bin`));
    expect(badLocal).not.toContain(norm(`${roaming}\\npm`));
  });

  it("canonicalizes Windows Path/PATH without leaving duplicate keys or mutating base, and keeps inherited PATH first", () => {
    installFile("C:\\Preferred\\agy.exe", `${local}\\agy\\bin\\agy.exe`);
    const base: NodeJS.ProcessEnv = {
      userprofile: profile,
      localappdata: local,
      Path: `C:\\Preferred;${local.toLowerCase()}\\agy\\bin\\`,
      PATHEXT: ".EXE;.CMD",
    };
    const snapshot = { ...base };
    const resolvedEnv = hostEngineEnvironment(hostDir, base);

    // Base object must not be mutated.
    expect(base).toEqual(snapshot);
    // Only canonical uppercase PATH exists; no competing Path key remains.
    expect(Object.keys(resolvedEnv).filter(k => k.toUpperCase() === "PATH")).toEqual(["PATH"]);
    const segments = resolvedEnv.PATH!.split(";");
    // Case-insensitive dedup keeps only one copy of agy\bin, and inherited C:\Preferred stays first.
    expect(segments.filter(item => norm(item) === norm(`${local}\\agy\\bin`))).toHaveLength(1);
    expect(resolveEngineExecutable("agy", resolvedEnv, "win32")?.toLowerCase()).toBe("c:\\preferred\\agy.exe");
  });

  it("preserves POSIX behavior when platform is darwin or linux", () => {
    addDir(`${local}\\agy\\bin`, `${roaming}\\npm`);
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/alice",
      USERPROFILE: profile,
      LOCALAPPDATA: local,
      APPDATA: roaming,
      PATH: "/usr/bin:/bin",
    };
    const darwinEnv = hostEngineEnvironment(hostDir, env, { format: 1, revision: "default", paths: {}, receipts: [] }, "darwin");
    expect(darwinEnv.PATH).not.toContain("AppData");
    expect(darwinEnv.PATH).toContain("/usr/bin:/bin");
  });
});

describe("end-to-end post-startup CLI discovery without restarting Host", () => {
  it("detects agy.exe installed in %LOCALAPPDATA%\\agy\\bin after startup across BotManager, HubEngineSettings, Doctor, and launched workers", async () => {
    const startupBase = hostProcessEnvironment({
      home: profile,
      executable: "C:\\TaroBird\\node.exe",
      env: {
        USERPROFILE: profile,
        LOCALAPPDATA: local,
        APPDATA: roaming,
        Path: "C:\\Windows\\System32",
        PATHEXT: ".EXE;.CMD",
      },
    });
    const manager = new BotManager({} as never, hostDir, { entrypoint: "C:\\TaroBird\\dist\\src\\index.js", env: startupBase }, () => "http://127.0.0.1:8788", async () => {});
    const settings = new HubEngineSettings(hostDir, () => startupBase);

    // 1. At Host startup, agy and codex are not installed yet.
    expect(manager.engineAvailable("antigravity")).toBe(false);
    expect(manager.engineAvailable("codex")).toBe(false);
    expect((await manager.engineCatalog("antigravity")).available).toBe(false);
    expect(settings.status().engines.find(e => e.id === "antigravity")?.available).toBe(false);

    // 2. While Host stays running with the SAME frozen startupBase, user installs agy.exe and codex.cmd.
    const agyExe = `${local}\\agy\\bin\\agy.exe`;
    const codexCmd = `${roaming}\\npm\\codex.cmd`;
    installFile(agyExe, codexCmd);

    // 3. Immediately discovered without restarting BotManager or Host!
    expect(manager.engineAvailable("antigravity")).toBe(true);
    expect(manager.engineAvailable("codex")).toBe(true);

    const agyEntry = await manager.engineCatalog("antigravity");
    expect(agyEntry.available).toBe(true);
    expect(agyEntry.permissions?.choices.some(choice => choice.label.includes("逐项确认"))).toBe(true);

    const catalog = await manager.catalog();
    expect(catalog.engines.find(e => e.id === "antigravity")?.available).toBe(true);
    expect(catalog.engines.find(e => e.id === "codex")?.available).toBe(true);

    const status = settings.status();
    const agyStatus = status.engines.find(e => e.id === "antigravity");
    const codexStatus = status.engines.find(e => e.id === "codex");
    expect(agyStatus).toMatchObject({ available: true, source: "auto" });
    expect(agyStatus?.executable?.toLowerCase()).toBe(agyExe.toLowerCase());
    expect(codexStatus).toMatchObject({ available: true, source: "auto" });
    expect(codexStatus?.executable?.toLowerCase()).toBe(codexCmd.toLowerCase());

    const doctorRows = inspectEngines(hostEngineEnvironment(hostDir, startupBase));
    const doctorAgy = doctorRows.find(e => e.engine === "antigravity");
    expect(doctorAgy?.installed).toBe(true);
    expect(doctorAgy?.executable?.toLowerCase()).toBe(agyExe.toLowerCase());

    // 4. Launching a Bot worker passes canonical PATH containing %LOCALAPPDATA%\agy\bin (and no duplicate Path key).
    (manager as unknown as { launch(botId: string): unknown }).launch("bot_agy_post_startup");
    expect(fixture.forkCalls).toHaveLength(1);
    const workerEnv = fixture.forkCalls[0]!.env!;
    expect(Object.keys(workerEnv).filter(key => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(workerEnv.PATH!.split(";").map(norm)).toContain(norm(`${local}\\agy\\bin`));
    expect(resolveEngineExecutable("agy", workerEnv, "win32")?.toLowerCase()).toBe(agyExe.toLowerCase());
  });

  it("detects a CLI installed into a custom directory added to Windows Registry Path after startup", async () => {
    let hkcuPath = "";
    setWindowsRegistryQueryForTest(async key => {
      if (key === WINDOWS_REGISTRY_PATH_KEYS[0]) return "C:\\Windows\\System32";
      return hkcuPath;
    });

    const liveBase = markLiveHostEnvironment({
      USERPROFILE: profile,
      LOCALAPPDATA: local,
      APPDATA: roaming,
      CUSTOM_CLI_ROOT: "D:\\CustomVendor",
      Path: "C:\\Windows\\System32",
      PATHEXT: ".EXE;.CMD",
    });
    const manager = new BotManager({} as never, hostDir, { entrypoint: "C:\\TaroBird\\dist\\src\\index.js", env: liveBase }, () => "http://127.0.0.1:8788", async () => {});
    const settings = new HubEngineSettings(hostDir, () => liveBase);

    // 1. Before install: not detected.
    expect((await manager.catalog()).engines.find(e => e.id === "antigravity")?.available).toBe(false);

    // 2. Installer puts agy.exe in a non-standard directory and appends %CUSTOM_CLI_ROOT%\agy-cli\bin to HKCU\Environment\Path.
    const customExe = "D:\\CustomVendor\\agy-cli\\bin\\agy.exe";
    installFile(customExe);
    hkcuPath = "%CUSTOM_CLI_ROOT%\\agy-cli\\bin";

    // 3. Re-checking catalog / settings refreshes live registry PATH without restarting Host.
    const refreshedCatalog = await manager.catalog(undefined, undefined, { forceRefresh: true });
    expect(refreshedCatalog.engines.find(e => e.id === "antigravity")?.available).toBe(true);
    expect(manager.engineAvailable("antigravity")).toBe(true);

    await settings.refresh(true);
    const settingsState = settings.status();
    const customStatus = settingsState.engines.find(e => e.id === "antigravity");
    expect(customStatus).toMatchObject({ available: true, source: "auto" });
    expect(customStatus?.executable?.toLowerCase()).toBe(customExe.toLowerCase());
    expect(settingsState.searchPaths.map(norm)).toContain(norm("D:\\CustomVendor\\agy-cli\\bin"));

    // 4. Spawned Bot worker inherits the expanded registry directory in canonical PATH.
    (manager as unknown as { launch(botId: string): unknown }).launch("bot_agy_registry");
    expect(fixture.forkCalls).toHaveLength(1);
    const workerEnv = fixture.forkCalls[0]!.env!;
    expect(Object.keys(workerEnv).filter(key => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(resolveEngineExecutable("agy", workerEnv, "win32")?.toLowerCase()).toBe(customExe.toLowerCase());

    // 5. Meanwhile, an isolated synthetic environment never inherits the machine registry cache.
    const isolatedEnv = hostEngineEnvironment(hostDir, { USERPROFILE: profile, Path: "C:\\Windows\\System32", PATHEXT: ".EXE;.CMD" });
    expect(resolveEngineExecutable("agy", isolatedEnv, "win32")).toBeUndefined();
    expect(await refreshWindowsRegistryPath({ USERPROFILE: profile, Path: "C:\\Windows\\System32" }, { platform: "win32" })).toEqual([]);
  });
});
