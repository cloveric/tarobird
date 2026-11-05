import { spawn } from "node:child_process";
import { z } from "zod";

/** Fixed argv: own node only, no peer list is requested or reported. */
export const TAILSCALE_STATUS_ARGS = ["status", "--json", "--peers=false"] as const;
const MAX_OUTPUT_BYTES = 256 * 1024;
const statusSchema = z.object({
  BackendState: z.string().max(64),
  Self: z.object({ Online: z.boolean().optional(), TailscaleIPs: z.array(z.string().max(64)).max(32).nullish() }).passthrough().nullish(),
}).passthrough();

export type TailscaleDiagnostic =
  | { available: false; reason: "missing" | "timeout" | "failed" | "invalid" }
  | { available: true; backendState: string; online?: boolean; addresses: { address: string; held: boolean }[] };

/** Host-side view at one moment, for CLI diagnosis only. It never gates
 * publication and says nothing about the phone, ACLs or the current path. */
export async function tailscaleDiagnostic(boundAddresses: readonly string[], options: { commands?: readonly string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<TailscaleDiagnostic> {
  const commands = options.commands ?? ["tailscale", ...(process.platform === "darwin" ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"] : [])];
  for (const command of commands) {
    const result = await run(command, options.timeoutMs ?? 3000, options.env);
    if (result === "missing") continue;
    if (typeof result === "string") return { available: false, reason: result };
    const parsed = statusSchema.safeParse(result.json);
    if (!parsed.success) return { available: false, reason: "invalid" };
    const held = new Set(parsed.data.Self?.TailscaleIPs ?? []);
    return { available: true, backendState: /^[A-Za-z]{1,32}$/.test(parsed.data.BackendState) ? parsed.data.BackendState : "unknown",
      ...(typeof parsed.data.Self?.Online === "boolean" ? { online: parsed.data.Self.Online } : {}),
      addresses: boundAddresses.map(address => ({ address, held: held.has(address) })) };
  }
  return { available: false, reason: "missing" };
}

function run(command: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ json: unknown } | "missing" | "timeout" | "failed" | "invalid"> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command, [...TAILSCALE_STATUS_ARGS], { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, ...(env ? { env } : {}) }); }
    catch { resolve("missing"); return; }
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const finish = (value: { json: unknown } | "missing" | "timeout" | "failed" | "invalid") => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish("timeout"); }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) { child.kill("SIGKILL"); finish("invalid"); return; }
      chunks.push(chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" || error.code === "EACCES" ? "missing" : "failed"));
    child.once("close", code => {
      if (code !== 0) { finish("failed"); return; }
      try { finish({ json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { finish("invalid"); }
    });
  });
}
