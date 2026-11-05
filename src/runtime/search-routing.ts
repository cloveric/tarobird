import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

export const SEARCH_CREDENTIAL_KEYS = ["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY"] as const;
export type SearchRouting = {
  enabled: boolean;
  providers: { brave: boolean; tavily: boolean };
  source: "env" | "codex-fallback" | "none";
  /** Private child-process environment. Never serialize this into diagnostics or argv. */
  env: NodeJS.ProcessEnv;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Legacy native registrations remain a credential source, but disabled servers
 * and malformed/oversized/non-regular files must never enable managed search. */
function codexCredentials(env: NodeJS.ProcessEnv): Record<string, string> {
  const home = env.CODEX_HOME || ((env.HOME || env.USERPROFILE) ? path.join((env.HOME || env.USERPROFILE)!, ".codex") : undefined);
  if (!home) return {};
  let fd: number | undefined;
  try {
    fd = openSync(path.join(home, "config.toml"), constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return {};
    const config = parseToml(readFileSync(fd, "utf8"));
    const result: Record<string, string> = {};
    for (const value of Object.values(object(config.mcp_servers))) {
      const server = object(value);
      if (server.enabled === false || server.disabled === true) continue;
      const values = object(server.env);
      for (const key of SEARCH_CREDENTIAL_KEYS) if (typeof values[key] === "string" && values[key].trim() && result[key] === undefined) result[key] = values[key].trim();
    }
    return result;
  } catch { return {}; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Input is the worker's merged environment. An explicit blank disables that
 * provider's legacy fallback, including Brave's alternate key name. */
export function resolveSearchRoutingSync(input: NodeJS.ProcessEnv): SearchRouting {
  const env = { ...input };
  const present = (key: string) => input[key] !== undefined;
  const configured = (key: string) => Boolean(env[key]?.trim());
  const braveMissing = !present("BRAVE_API_KEY") && !present("BRAVE_SEARCH_API_KEY");
  const tavilyMissing = !present("TAVILY_API_KEY");
  let usedFallback = false;
  if (input.TAROBOT_SEARCH_CREDENTIAL_FALLBACK !== "0" && (braveMissing || tavilyMissing)) {
    const fallback = codexCredentials(input);
    for (const key of SEARCH_CREDENTIAL_KEYS) {
      if ((key === "TAVILY_API_KEY" ? tavilyMissing : braveMissing) && fallback[key]) { env[key] = fallback[key]; usedFallback = true; }
    }
  }
  const providers = { brave: configured("BRAVE_API_KEY") || configured("BRAVE_SEARCH_API_KEY"), tavily: configured("TAVILY_API_KEY") };
  const enabled = providers.brave || providers.tavily;
  // DSH serializes absent keys as blanks. Resolve once before that boundary;
  // the MCP must not independently resurrect explicitly disabled credentials.
  env.TAROBOT_SEARCH_CREDENTIAL_FALLBACK = "0";
  return { enabled, providers, source: usedFallback ? "codex-fallback" : enabled ? "env" : "none", env };
}
export async function resolveSearchRouting(env: NodeJS.ProcessEnv): Promise<SearchRouting> { return resolveSearchRoutingSync(env); }
