import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { BusRegistryEntrySchema } from "./bus-registry-schema.js";
import { withFileMutex } from "../state/file-mutex.js";

export interface BusRegistryEntry {
  port: number;
  pid: number;
  secret: string;
  updatedAt: string;
}

export interface BusRegistryData {
  instances: Record<string, BusRegistryEntry>;
}

function resolveRegistryPath(channelRoot: string): string {
  return path.join(channelRoot, ".bus-registry.json");
}

export function resolveChannelRoot(stateDir: string): string {
  return path.dirname(stateDir);
}

export async function readRegistry(channelRoot: string): Promise<BusRegistryData> {
  try {
    const raw = await readFile(resolveRegistryPath(channelRoot), "utf8");
    const data = JSON.parse(raw) as unknown;
    if (typeof data === "object" && data !== null && "instances" in data) {
      const instances = (data as { instances?: unknown }).instances;
      if (typeof instances === "object" && instances !== null) {
        const filtered: Record<string, BusRegistryEntry> = {};
        for (const [name, entry] of Object.entries(instances as Record<string, unknown>)) {
          const result = BusRegistryEntrySchema.safeParse(entry);
          if (result.success) {
            filtered[name] = result.data;
          }
        }
        return { instances: filtered };
      }
    }
    throw new Error("registry root must contain an object-valued instances field");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { instances: {} };
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Bus registry is unreadable: ${detail}`, { cause: error });
  }
}

export async function registerInstance(
  channelRoot: string,
  instanceName: string,
  port: number,
  secret: string,
): Promise<void> {
  await mutateRegistry(channelRoot, (registry) => {
    registry.instances[instanceName] = {
      port,
      pid: process.pid,
      secret,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function deregisterInstance(
  channelRoot: string,
  instanceName: string,
): Promise<void> {
  await mutateRegistry(channelRoot, (registry) => {
    delete registry.instances[instanceName];
  });
}

export async function lookupInstance(
  channelRoot: string,
  instanceName: string,
): Promise<BusRegistryEntry | null> {
  const registry = await readRegistry(channelRoot);
  const entry = registry.instances[instanceName];
  if (!entry) return null;
  return (await isInstanceAlive(entry, instanceName)) ? entry : null;
}

/**
 * True when a compatible Agent Bus server is actually listening on the
 * registered port and identifies as the expected instance.
 *
 * Bare TCP connect is not enough — any unrelated local service binding the
 * same port would pass, and the caller would then POST the bus secret to a
 * stranger. So we do a quick HTTP GET /api/health and verify the response
 * is JSON with the historical fingerprint (kind="cc-telegram-bridge") and the
 * matching instance name. Keep the fingerprint stable for mixed-version local
 * peers; it identifies the Bus protocol, not a connection to Telegram.
 *
 * 500ms timeout is plenty for localhost. On any failure (connect refused,
 * wrong port occupant, JSON mismatch) we return false and the caller treats
 * the entry as stale.
 */
export async function isInstanceAlive(entry: BusRegistryEntry, expectedName?: string): Promise<boolean> {
  if (!Number.isInteger(entry.port) || entry.port <= 0 || entry.port > 65535) {
    return false;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const res = await fetch(`http://127.0.0.1:${entry.port}/api/health`, { signal: controller.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { kind?: unknown; instance?: unknown; status?: unknown };
      if (body.kind !== "cc-telegram-bridge") return false;
      if (body.status !== "ok") return false;
      if (expectedName !== undefined && body.instance !== expectedName) return false;
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function listRegisteredInstances(
  channelRoot: string,
): Promise<Array<{ name: string } & BusRegistryEntry>> {
  const registry = await readRegistry(channelRoot);
  return Object.entries(registry.instances).map(([name, entry]) => ({ name, ...entry }));
}

/**
 * Like listRegisteredInstances but drops entries whose bus server no longer
 * answers. Use for cross-instance delegation and UI — callers that need a
 * live target should never see a corpse.
 */
export async function listActiveInstances(
  channelRoot: string,
): Promise<Array<{ name: string } & BusRegistryEntry>> {
  const all = await listRegisteredInstances(channelRoot);
  const checks = await Promise.all(all.map(async (entry) => ({ entry, alive: await isInstanceAlive(entry, entry.name) })));
  return checks.filter(({ alive }) => alive).map(({ entry }) => entry);
}

/**
 * Remove entries whose port no longer answers and whose registering process
 * has exited. Safe to call at startup before a fresh registerInstance, to keep
 * `.bus-registry.json` from accumulating corpses.
 *
 * One missed 500ms probe is not proof of exit: a busy or briefly blocked live
 * bot keeps its entry, and listActiveInstances/lookupInstance keep hiding it
 * until it answers again. Probes run outside the registry lock; under the lock
 * a name is removed only while it still holds the exact probed entry, so a
 * concurrent re-registration is never deleted by a stale probe.
 */
export async function pruneStaleInstances(channelRoot: string): Promise<number> {
  const registry = await readRegistry(channelRoot);
  const entries = Object.entries(registry.instances);
  const checks = await Promise.all(entries.map(async ([name, entry]) => ({
    name,
    entry,
    stale: !(await isInstanceAlive(entry, name)) && isProcessConfirmedDead(entry.pid),
  })));
  const stale = checks.filter((check) => check.stale);
  if (stale.length === 0) {
    return 0;
  }

  let removed = 0;
  await mutateRegistry(channelRoot, (current) => {
    for (const { name, entry } of stale) {
      if (isDeepStrictEqual(current.instances[name], entry)) {
        delete current.instances[name];
        removed += 1;
      }
    }
  });
  return removed;
}

/** Only ESRCH proves exit; EPERM means alive and anything else is unknown. */
function isProcessConfirmedDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function mutateRegistry(
  channelRoot: string,
  mutate: (registry: BusRegistryData) => void,
): Promise<void> {
  const registryPath = resolveRegistryPath(channelRoot);
  await withFileMutex(registryPath, async () => {
    await mkdir(channelRoot, { recursive: true, mode: 0o700 });
    const registry = await readRegistry(channelRoot);
    mutate(registry);
    const tempPath = `${registryPath}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      await writeFile(tempPath, JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      const handle = await open(tempPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, registryPath);
      renamed = true;
    } finally {
      if (!renamed) await unlink(tempPath).catch(() => undefined);
    }
  });
}
