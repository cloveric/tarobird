import { admitWindowsDirectory, inspectableWindowsDirectory, HostDirectoryError } from "./windows-state-admission.js";
import os from "node:os";
import path from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";

/** Matches Tauri PathResolver.app_data_dir, including Windows Roaming AppData. */
export function desktopHostDirectory(platform = process.platform, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  const appDataIsAbsolute = env.APPDATA && p.isAbsolute(env.APPDATA)
    && (p.parse(env.APPDATA).root.startsWith("\\\\") || /^[a-z]:[\\/]/i.test(env.APPDATA));
  if (platform === "win32" && env.APPDATA && !appDataIsAbsolute) {
    throw new Error("host_appdata_path_not_absolute: APPDATA must be an absolute Windows path; use --state-dir to select an explicit host.");
  }
  const base = platform === "darwin" ? p.join(home, "Library", "Application Support")
    : platform === "win32" ? env.APPDATA || p.join(home, "AppData", "Roaming")
    : env.XDG_DATA_HOME && p.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : p.join(home, ".local", "share");
  return p.join(base, "com.tarobot.client", "host");
}

export async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
}

/** Read-only desktop location, including native-identity compatibility. Unlike
 * resolveHostDirectory, this ignores explicit CLI state and old headless state. */
export async function resolveDesktopHostDirectory(options: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): Promise<string> {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  if (platform === "win32") return inspectableWindowsDirectory();
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  return canonicalDirectory(await existingDesktopHost(desktopHostDirectory(platform, home, env)));
}

/** Canonicalize the nearest existing ancestor, including before first init. */
export async function canonicalDirectory(directory: string): Promise<string> {
  let current = path.resolve(directory); const tail: string[] = [];
  for (;;) {
    try { return path.join(await realpath(current), ...tail.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current); if (parent === current) throw error;
      tail.push(path.basename(current)); current = parent;
    }
  }
}

export async function resolveHostDirectory(explicit?: string, options: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; inspection?: boolean } = {}): Promise<string> {
  const home = options.home ?? os.homedir(), env = options.env ?? process.env;
  const selected = explicit ?? env.TAROBOT_HOST_DIR;
  if ((options.platform ?? process.platform) === "win32") {
    if (selected !== undefined && !selected.trim()) throw new Error("主机目录不能为空。");
    const preferred = await (options.inspection ? inspectableWindowsDirectory(selected) : admitWindowsDirectory(selected));
    // Keep the existing no-silent-abandon rule when switching the Windows default
    // to Known Folders. Explicit selections remain available after admission.
    const legacy = path.join(home, ".cctb", "hub");
    if (selected === undefined && await exists(path.join(legacy, "hub.sqlite"))) throw new Error(`发现旧版主机 ${legacy}。请明确传入 --state-dir 选择这台主机或桌面主机 ${preferred}；不会自动合并身份。`);
    return preferred;
  }
  if (selected !== undefined) {
    if (!selected.trim()) throw new Error("主机目录不能为空。");
    return canonicalDirectory(selected);
  }
  const preferred = desktopHostDirectory(options.platform, home, env), legacy = path.join(home, ".cctb", "hub");
  // Never silently abandon an older headless identity or pick one of two hosts.
  if (await exists(path.join(legacy, "hub.sqlite"))) throw new Error(`发现旧版主机 ${legacy}。请明确传入 --state-dir 选择这台主机或桌面主机 ${preferred}；不会自动合并身份。`);
  return canonicalDirectory(await existingDesktopHost(preferred));
}

/** Native rename does not move live databases, workspace paths or client keys. */
async function existingDesktopHost(preferred: string): Promise<string> {
  const base = path.dirname(path.dirname(preferred)), legacy = path.join(base, "com.tarocub.client", "host");
  const present = async (directory: string): Promise<boolean> => {
    for (const item of [path.dirname(directory), directory]) {
      try {
        const info = await lstat(item);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new HostDirectoryError("redirected");
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }
    return true;
  };
  const [currentExists, legacyExists] = await Promise.all([present(preferred), present(legacy)]);
  if (currentExists && legacyExists) throw new HostDirectoryError("conflict");
  return legacyExists ? legacy : preferred;
}
