import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodePiModel, parsePiModels, type PiModelChoice } from "../codex/pi-models.js";
import { modelDiscoveryEnabled } from "./cli-model-discovery.js";
import { queryOmpCatalog } from "../codex/omp-rpc-client.js";
import { resolveOmpExecutable } from "./omp-executable.js";

export type OmpModelCatalog = {
  status: "ready" | "no-models" | "unavailable";
  models: PiModelChoice[];
  defaultModel?: string;
};

const unavailable = (): OmpModelCatalog => ({ status: "unavailable", models: [] });
const cache = new Map<string, { expires: number; promise: Promise<OmpModelCatalog> }>();

export function discoverOmpModels(env: NodeJS.ProcessEnv = process.env, cwd?: string, reread = false): Promise<OmpModelCatalog> {
  if (!modelDiscoveryEnabled(env)) return Promise.resolve(unavailable());
  const key = createHash("sha256").update(JSON.stringify([resolveOmpExecutable(env), env, cwd])).digest("hex");
  const current = cache.get(key);
  if (current && (reread ? current.expires === Number.POSITIVE_INFINITY : current.expires > Date.now())) return current.promise;
  const entry = { expires: Number.POSITIVE_INFINITY, promise: Promise.resolve(unavailable()) };
  entry.promise = readOmpCatalog(env, cwd).catch(unavailable).then(result => {
    entry.expires = Date.now() + 1000;
    return result;
  });
  if (cache.size >= 16 && !current) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
  return entry.promise;
}

async function readOmpCatalog(env: NodeJS.ProcessEnv, cwd?: string): Promise<OmpModelCatalog> {
  const temporary = cwd ? undefined : await mkdtemp(path.join(os.tmpdir(), "tarobird-omp-catalog-"));
  try {
    const result = await queryOmpCatalog({ launch: { command: resolveOmpExecutable(env), args: [] }, cwd: cwd ?? temporary!, env });
    const models = parsePiModels(result.models);
    const defaultModel = result.current ? encodePiModel(result.current.provider, result.current.modelId) : undefined;
    return {
      status: models.length ? "ready" : "no-models",
      models,
      ...(defaultModel && models.some(model => model.id === defaultModel) ? { defaultModel } : {}),
    };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function resetOmpModelDiscoveryForTest(): void { cache.clear(); }
