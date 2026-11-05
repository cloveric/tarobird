import { spawnEngine } from "../runtime/engine-process.js";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { EFFORT_LEVELS, type EffortLevel } from "../state/config-file-schema.js";

const run = promisify(execFile);
export type AntigravityModel = { id: string; label?: string; efforts: ("" | EffortLevel)[] };
export function antigravityPresetEffort(model: string | undefined): EffortLevel | undefined {
  return model?.match(/-(low|medium|high|xhigh|max|ultra)$/)?.[1] as EffortLevel | undefined;
}
/** agy models advertises concrete provider variants, not the CLI flag's union. */
export function parseAntigravityModels(output: string): AntigravityModel[] {
  const labels = new Map<string, string>();
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._/-]{0,127})\t(\S[^\t]*)/);
    if (match && !labels.has(match[1]!)) labels.set(match[1]!, match[2]!.trim().slice(0, 160));
  }
  return [...labels].map(([id, label]) => {
    // A concrete preset already fixes the effort. agy rejects a different
    // --effort even when a sibling model supports it. The App's grouped picker
    // changes both model and effort atomically when choosing another preset.
    const effort = antigravityPresetEffort(id);
    return { id, label, efforts: ["", ...(effort ? [effort] : [])] };
  });
}
/** Prefer Argon for new Bots only when this host/account actually advertises it. */
export function preferredAntigravityModel(models: readonly { id: string }[]): string {
  return models.find((model) => model.id === "gemini-4-argon-medium")?.id ?? "";
}
export function antigravityEffortChoices(models: AntigravityModel[], model: string): ("" | EffortLevel)[] {
  // An unspecified/default model can change independently of this App. Never
  // claim its capabilities from the first list row or from another provider.
  if (!model) return [""];
  const exact = models.find((item) => item.id === model);
  if (exact) return exact.efforts;
  const variants = models.filter((item) => item.id.replace(/-(low|medium|high|xhigh|max|ultra)$/, "") === model);
  return ["", ...EFFORT_LEVELS.filter(level => variants.some(item => item.efforts.includes(level)))];
}
const cache = new Map<string, { expires: number; result: Promise<AntigravityModel[]> }>();
/** Bounded read-only discovery; never runs a model turn or exposes stderr. */
export function discoverAntigravityModels(env: NodeJS.ProcessEnv = process.env): Promise<AntigravityModel[]> {
  const executable = (env.ANTIGRAVITY_EXECUTABLE || "agy").trim().replace(/^"(.*)"$/, "$1");
  const key = createHash("sha256").update(JSON.stringify([executable, env])).digest("hex");
  const current = cache.get(key); if (current && current.expires > Date.now()) return current.result;
  let command = executable, args = ["models"];
  if (/\.(cmd|bat)$/i.test(command)) { args = ["/d", "/s", "/c", command, ...args]; command = env.ComSpec || "cmd.exe"; }
  else if (/\.ps1$/i.test(command)) { args = ["-NoProfile", "-File", command, ...args]; command = "pwsh"; }
  const entry = { expires: Date.now() + 300_000, result: Promise.resolve([] as AntigravityModel[]) };
  const result = process.platform === "win32" ? new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawnEngine(executable, ["models"], { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"], timeout: 8000, killSignal: "SIGKILL" });
    let output = "", length = 0;
    child.stdout?.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 128 * 1024) { child.kill(); reject(new Error("model_output_limit")); } else output += chunk; });
    child.stderr?.resume(); child.once("error", reject); child.once("close", code => code === 0 ? resolve({ stdout: output }) : reject(new Error("model_list_failed")));
  }) : run(command, args, { env, cwd: os.tmpdir(), encoding: "utf8", timeout: 8000, killSignal: "SIGKILL", maxBuffer: 128 * 1024, windowsHide: true });
  entry.result = result
    .then(({ stdout }) => parseAntigravityModels(stdout), () => []).then((models) => { if (!models.length) entry.expires = Date.now() + 3000; return models; });
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, entry); return entry.result;
}
