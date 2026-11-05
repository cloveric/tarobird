import path from "node:path";
import { loadGatewayEnvironment } from "../gateway/environment.js";
import { resolveSearchRouting, SEARCH_CREDENTIAL_KEYS } from "./search-routing.js";
import { runSearchMcpServer } from "../../deepseek-harness-plugin/src/search-mcp-server.js";

/** Both standalone CLI and native MCP launcher share private credential loading. */
export async function runConfiguredSearchMcp(): Promise<void> {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const loaded = home ? await loadGatewayEnvironment(path.join(home, ".tarobot", "search-mcp"), "search-mcp", process.env) : process.env;
  const routing = await resolveSearchRouting({ ...loaded, TAROBOT_SEARCH_CREDENTIAL_FALLBACK: process.env.TAROBOT_SEARCH_CREDENTIAL_FALLBACK });
  for (const key of [...SEARCH_CREDENTIAL_KEYS, "TAROBOT_SEARCH_CREDENTIAL_FALLBACK"]) if (routing.env[key] !== undefined) process.env[key] = routing.env[key];
  await runSearchMcpServer();
}
