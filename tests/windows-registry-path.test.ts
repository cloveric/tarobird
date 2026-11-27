import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_REGISTRY_PATH_KEYS,
  cachedWindowsRegistryPathDirectories,
  expandWindowsEnvVars,
  isLiveHostEnvironment,
  markLiveHostEnvironment,
  mergeWindowsPathEntries,
  parseWindowsRegistryPathEntries,
  parseWindowsRegistryQueryOutput,
  readWindowsPathEntries,
  refreshWindowsRegistryPath,
  resetWindowsRegistryPathCache,
  setCanonicalWindowsPath,
  setWindowsRegistryQueryForTest,
  validWindowsDirectory,
  windowsPathKey,
} from "../src/runtime/windows-registry-path.js";

afterEach(() => {
  resetWindowsRegistryPathCache();
  setWindowsRegistryQueryForTest(undefined);
  vi.restoreAllMocks();
});

describe("Windows Registry Path parsing and environment expansion", () => {
  it("parses REG_EXPAND_SZ and REG_SZ values from reg.exe output", () => {
    const expandOutput = [
      "",
      "HKEY_CURRENT_USER\\Environment",
      "    Path    REG_EXPAND_SZ    %LOCALAPPDATA%\\agy\\bin;C:\\Program Files\\nodejs",
      "",
    ].join("\r\n");
    expect(parseWindowsRegistryQueryOutput(expandOutput)).toBe("%LOCALAPPDATA%\\agy\\bin;C:\\Program Files\\nodejs");

    const szOutput = "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    PATH    REG_SZ    C:\\Windows\\System32;D:\\Tools\\bin  \r\n";
    expect(parseWindowsRegistryQueryOutput(szOutput)).toBe("C:\\Windows\\System32;D:\\Tools\\bin");

    const emptyOutput = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    \r\n";
    expect(parseWindowsRegistryQueryOutput(emptyOutput)).toBe("");

    const unrelatedOutput = "\r\nHKEY_CURRENT_USER\\Environment\r\n    PathExt    REG_SZ    .EXE;.CMD\r\n    MyPath    REG_SZ    C:\\Other\r\n";
    expect(parseWindowsRegistryQueryOutput(unrelatedOutput)).toBeUndefined();
  });

  it("expands Windows %VAR% references case-insensitively and guards against cycles", () => {
    const env: NodeJS.ProcessEnv = {
      userprofile: "C:\\Users\\alice",
      LOCALAPPDATA: "%USERPROFILE%\\AppData\\Local",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOOP: "%LOOP%\\nested",
    };
    expect(expandWindowsEnvVars("%localappdata%\\agy\\bin", env)).toBe("C:\\Users\\alice\\AppData\\Local\\agy\\bin");
    expect(expandWindowsEnvVars("%programfiles(x86)%\\Vendor\\bin", env)).toBe("C:\\Program Files (x86)\\Vendor\\bin");
    expect(expandWindowsEnvVars("%UNKNOWN_VAR%\\bin", env)).toBe("%UNKNOWN_VAR%\\bin");
    // Bounded pass count terminates cleanly even on self-referential definitions.
    const cyclic = expandWindowsEnvVars("%LOOP%", env);
    expect(cyclic).toContain("%LOOP%");
    expect(cyclic.length).toBeLessThan(200);
  });

  it("filters unsafe, relative, and unexpanded registry PATH entries and deduplicates case-insensitively", () => {
    const env: NodeJS.ProcessEnv = {
      USERPROFILE: "C:\\Users\\alice",
      LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    };
    const entries = parseWindowsRegistryPathEntries([
      '"C:\\Program Files\\nodejs";C:\\Windows\\System32;.;relative\\bin;\\drive-relative',
      "%LOCALAPPDATA%\\agy\\bin;c:/users/alice/appdata/local/agy/bin\\;%MISSING_VAR%\\bin;C:\\Bad\u0000\\bin;\\\\server\\share\\tools",
    ], env);
    expect(entries).toEqual([
      "C:\\Program Files\\nodejs",
      "C:\\Windows\\System32",
      "C:\\Users\\alice\\AppData\\Local\\agy\\bin",
      "\\\\server\\share\\tools",
    ]);
  });

  it("merges Path and PATH variants cleanly into canonical PATH without duplicates", () => {
    const original: NodeJS.ProcessEnv = {
      Path: "C:\\Windows\\System32;C:\\Users\\alice\\AppData\\Local\\agy\\bin\\",
      PATH: "C:\\Custom\\bin;c:/users/alice/appdata/local/agy/bin",
      path: "D:\\Extra\\bin",
    };
    const read = readWindowsPathEntries(original);
    expect(read.hasKey).toBe(true);
    const merged = mergeWindowsPathEntries([read.entries, ["c:\\windows\\system32\\", "C:\\"]]);
    expect(merged).toEqual([
      "C:\\Custom\\bin",
      "c:/users/alice/appdata/local/agy/bin",
      "C:\\Windows\\System32",
      "D:\\Extra\\bin",
      "C:\\",
    ]);

    const copy: NodeJS.ProcessEnv = { ...original };
    setCanonicalWindowsPath(copy, merged, true);
    expect(Object.keys(copy).filter(key => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(copy.PATH).toBe(merged.join(";"));
    // Original object must never be mutated.
    expect(original.Path).toBe("C:\\Windows\\System32;C:\\Users\\alice\\AppData\\Local\\agy\\bin\\");
    expect(windowsPathKey("C:\\")).toBe("c:\\");
    expect(validWindowsDirectory("C:\\Tools")).toBe("C:\\Tools");
    expect(validWindowsDirectory("\\drive-relative")).toBeUndefined();
    expect(validWindowsDirectory("C:\\Tools;D:\\Injected")).toBeUndefined();
  });
});

describe("live Windows Registry Path refresh, caching, coalescing, and fallback", () => {
  it("merges HKLM then HKCU, respects TTL, coalesces concurrent calls, and supports forced refresh", async () => {
    let clock = 10_000;
    let hkcuValue = "%LOCALAPPDATA%\\agy\\bin";
    const env = markLiveHostEnvironment({
      USERPROFILE: "C:\\Users\\alice",
      LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    });
    expect(isLiveHostEnvironment(env)).toBe(true);

    let releaseQuery!: () => void;
    let gate: Promise<void> | undefined;
    const query = vi.fn(async (key: string) => {
      if (gate) await gate;
      if (key === WINDOWS_REGISTRY_PATH_KEYS[0]) return "C:\\Windows\\System32;C:\\Program Files\\nodejs";
      return hkcuValue;
    });

    // Coalesce concurrent callers while in flight.
    gate = new Promise<void>(resolve => { releaseQuery = resolve; });
    const concurrent = Promise.all([
      refreshWindowsRegistryPath(env, { platform: "win32", now: () => clock, query }),
      refreshWindowsRegistryPath(env, { platform: "win32", now: () => clock, query }),
      refreshWindowsRegistryPath(env, { platform: "win32", now: () => clock, query }),
    ]);
    releaseQuery();
    gate = undefined;
    const [first, second, third] = await concurrent;
    expect(query).toHaveBeenCalledTimes(2);
    expect(first).toEqual([
      "C:\\Windows\\System32",
      "C:\\Program Files\\nodejs",
      "C:\\Users\\alice\\AppData\\Local\\agy\\bin",
    ]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(cachedWindowsRegistryPathDirectories(env, "win32")).toEqual(first);

    // Within TTL (5000ms), cached result is returned without re-querying.
    clock += 3000;
    hkcuValue = "%LOCALAPPDATA%\\agy\\bin;D:\\NewCLI\\bin";
    const withinTtl = await refreshWindowsRegistryPath(env, { platform: "win32", now: () => clock, query });
    expect(query).toHaveBeenCalledTimes(2);
    expect(withinTtl).toEqual(first);

    // force: true bypasses TTL immediately.
    const forced = await refreshWindowsRegistryPath(env, { platform: "win32", force: true, now: () => clock, query });
    expect(query).toHaveBeenCalledTimes(4);
    expect(forced).toContain("D:\\NewCLI\\bin");

    // After TTL expires, refreshes automatically.
    clock += 6000;
    hkcuValue = "%LOCALAPPDATA%\\agy\\bin;D:\\NewCLI\\bin;D:\\ThirdCLI\\bin";
    const expired = await refreshWindowsRegistryPath(env, { platform: "win32", now: () => clock, query });
    expect(query).toHaveBeenCalledTimes(6);
    expect(expired).toContain("D:\\ThirdCLI\\bin");
  });

  it("handles partial registry availability (missing HKCU Path) and retains cache on total failure/timeout", async () => {
    let clock = 50_000;
    const env = markLiveHostEnvironment({
      USERPROFILE: "C:\\Users\\alice",
      LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    });

    // Fresh Windows user profile: HKLM succeeds, HKCU has no Path value (reg.exe exits 1).
    const partialQuery = vi.fn(async (key: string) => {
      if (key === WINDOWS_REGISTRY_PATH_KEYS[0]) return "C:\\Windows\\System32;D:\\MachineTool\\bin";
      throw new Error("ERROR: The system was unable to find the specified registry key or value.");
    });
    const partial = await refreshWindowsRegistryPath(env, { platform: "win32", now: () => clock, query: partialQuery });
    expect(partial).toEqual(["C:\\Windows\\System32", "D:\\MachineTool\\bin"]);
    expect(partialQuery).toHaveBeenCalledTimes(2);

    // Advance past TTL and simulate total failure / timeout on both keys.
    clock += 10_000;
    const failingQuery = vi.fn(async () => { throw new Error("ETIMEDOUT"); });
    const fallback = await refreshWindowsRegistryPath(env, { platform: "win32", now: () => clock, query: failingQuery });
    expect(failingQuery).toHaveBeenCalledTimes(2);
    // Previously cached entries are preserved on transient failure.
    expect(fallback).toEqual(["C:\\Windows\\System32", "D:\\MachineTool\\bin"]);

    // Failure cooldown skips re-querying for non-forced calls.
    clock += 5_000;
    const duringCooldown = await refreshWindowsRegistryPath(env, { platform: "win32", now: () => clock, query: failingQuery });
    expect(failingQuery).toHaveBeenCalledTimes(2);
    expect(duringCooldown).toEqual(["C:\\Windows\\System32", "D:\\MachineTool\\bin"]);

    // After cooldown expires, recovery succeeds.
    clock += 20_000;
    const recoveryQuery = vi.fn(async (key: string) => key === WINDOWS_REGISTRY_PATH_KEYS[1] ? "D:\\Recovered\\bin" : undefined);
    const recovered = await refreshWindowsRegistryPath(env, { platform: "win32", now: () => clock, query: recoveryQuery });
    expect(recoveryQuery).toHaveBeenCalledTimes(2);
    expect(recovered).toEqual(["D:\\Recovered\\bin"]);
  });

  it("stays isolated from synthetic test environments and is a no-op on POSIX", async () => {
    const query = vi.fn(async () => "D:\\ShouldNeverBeQueried\\bin");
    const synthetic = { USERPROFILE: "C:\\Users\\alice", PATH: "C:\\Tools" };
    expect(isLiveHostEnvironment(synthetic)).toBe(false);
    expect(await refreshWindowsRegistryPath(synthetic, { platform: "win32", query })).toEqual([]);
    expect(cachedWindowsRegistryPathDirectories(synthetic, "win32")).toEqual([]);
    expect(query).not.toHaveBeenCalled();

    const live = markLiveHostEnvironment({ HOME: "/home/alice", PATH: "/usr/bin" });
    expect(await refreshWindowsRegistryPath(live, { platform: "darwin", query })).toEqual([]);
    expect(await refreshWindowsRegistryPath(live, { platform: "linux", query })).toEqual([]);
    expect(cachedWindowsRegistryPathDirectories(live, "darwin")).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
