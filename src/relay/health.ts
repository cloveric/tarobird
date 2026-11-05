import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";

const exec = promisify(execFile);
const configSchema = z.object({ ntfyPort: z.number().int().min(1024).max(65535).optional(), peerRelay: z.boolean() }).strict();
export const companionStatusSchema = z.object({
  ntfy: z.object({ running: z.boolean(), healthy: z.boolean() }).strict().optional(),
  peerRelay: z.object({ running: z.boolean(), backend: z.enum(["Running", "NeedsLogin", "Stopped", "NeedsMachineAuth", "Unknown"]), port: z.number().int().min(0).max(65535).nullable(), policy: z.literal("verify in tailnet") }).strict().optional(),
}).strict();
export async function inspectRelayCompanions(root: string, hooks: { fetcher?: typeof fetch; command?: (file: string, args: string[]) => Promise<string> } = {}): Promise<z.infer<typeof companionStatusSchema>> {
  let config: z.infer<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(await readFile(path.join(root, "current", "companion-health.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const command = hooks.command ?? (async (file, args) => (await exec(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout);
  const running = (name: string) => command("systemctl", ["is-active", "--quiet", name]).then(() => true, () => false);
  const result: z.infer<typeof companionStatusSchema> = {};
  if (config.ntfyPort) {
    let healthy = false;
    try {
      const response = await (hooks.fetcher ?? fetch)(`http://127.0.0.1:${config.ntfyPort}/v1/health`, { redirect: "error", signal: AbortSignal.timeout(2000) });
      if (response.ok) healthy = z.object({ healthy: z.literal(true) }).safeParse(await response.json()).success;
    } catch { /* Report service failure without response bodies or credentials. */ }
    result.ntfy = { running: await running("tarocub-ntfy.service"), healthy };
  }
  if (config.peerRelay) {
    const entry: NonNullable<z.infer<typeof companionStatusSchema>["peerRelay"]> = { running: await running("tarocub-tailscaled.service"), backend: "Unknown", port: null, policy: "verify in tailnet" };
    const cli = path.join(root, "current", "tailscale"), socket = "--socket=/run/tarocub-tailscale/tailscaled.sock";
    try { const status = z.object({ BackendState: z.enum(["Running", "NeedsLogin", "Stopped", "NeedsMachineAuth"]) }).parse(JSON.parse(await command(cli, [socket, "status", "--json"]))); entry.backend = status.BackendState; } catch { /* Do not expose machine identities from the full status JSON. */ }
    try { entry.port = z.object({ RelayServerPort: z.number().int().min(0).max(65535).nullable().optional() }).parse(JSON.parse(await command(cli, [socket, "debug", "prefs"]))).RelayServerPort ?? null; } catch { /* Keep unknown distinct from a verified relay port. */ }
    result.peerRelay = entry;
  }
  return result;
}
