import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const directoryExists = (directory: string) => { try { return statSync(directory).isDirectory(); } catch { return false; } };
function smallAlias(file: string): string | undefined {
  try { const info = statSync(file); if (info.isFile() && info.size <= 4096) return readFileSync(file, "utf8").trim(); } catch { /* Not configured. */ }
}
/** Read nvm's selected default only. Never add every installed Node version,
 * execute shell profiles, or guess a version when an alias cannot be resolved. */
function nvmDefault(root: string): string | undefined {
  let alias = "default";
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(alias)) return; seen.add(alias);
    if (/^v?\d+(?:\.\d+){0,2}$/.test(alias) || alias === "node" || alias === "stable") {
      try {
        const names = readdirSync(path.join(root, "versions/node"));
        if (names.length > 1024) return;
        // nvm documents `stable` as an alias for `node`: the newest installed version.
        const prefix = alias.replace(/^v/, ""), any = alias === "node" || alias === "stable";
        const selected = names.filter(name => /^v\d+\.\d+\.\d+$/.test(name))
          .filter(name => any || name.slice(1) === prefix || name.slice(1).startsWith(`${prefix}.`))
          .sort((a, b) => { const aa = a.slice(1).split(".").map(Number), bb = b.slice(1).split(".").map(Number); return bb[0]! - aa[0]! || bb[1]! - aa[1]! || bb[2]! - aa[2]!; })[0];
        return selected ? path.join(root, "versions/node", selected, "bin") : undefined;
      } catch { return; }
    }
    if (!/^(?:[a-zA-Z0-9_-]+|lts\/(?:[a-zA-Z0-9_-]+|\*))$/.test(alias)) return;
    const next = smallAlias(path.join(root, "alias", alias)); if (!next) return; alias = next;
  }
}

/** fnm uses the first existing base directory: XDG data (also on macOS), then
 * the legacy ~/.fnm, then macOS Application Support. Mirror that order instead
 * of searching a directory fnm itself would not use. */
function fnmDirectory(home: string, data: string, platform: NodeJS.Platform): string {
  const candidates = [path.join(data, "fnm"), path.join(home, ".fnm"), ...(platform === "darwin" ? [path.join(home, "Library/Application Support/fnm")] : [])];
  return candidates.find(directoryExists) ?? candidates[0]!;
}

/** Fallbacks follow the inherited PATH, preserving the operator's selection.
 * fnm's alias is a symlink to its installation; asdf/mise/Volta use stable shims. */
export function discoverEngineDirectories(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") return [];
  const root = (key: string, fallback: string) => env[key] && path.posix.isAbsolute(env[key]!) && !/[\x00-\x1f\x7f:]/.test(env[key]!) ? env[key]! : fallback;
  const data = root("XDG_DATA_HOME", path.join(home, ".local/share"));
  const fnm = root("FNM_DIR", fnmDirectory(home, data, platform));
  const candidates = [
    path.join(root("VOLTA_HOME", path.join(home, ".volta")), "bin"),
    path.join(root("BUN_INSTALL", path.join(home, ".bun")), "bin"),
    path.join(root("ASDF_DATA_DIR", path.join(home, ".asdf")), "shims"),
    path.join(root("MISE_DATA_DIR", path.join(data, "mise")), "shims"),
    path.join(fnm, "aliases/default/bin"),
    nvmDefault(root("NVM_DIR", path.join(home, ".nvm"))),
  ];
  return candidates.filter((directory): directory is string => !!directory && !/[\x00-\x1f\x7f:]/.test(directory) && directoryExists(directory));
}
