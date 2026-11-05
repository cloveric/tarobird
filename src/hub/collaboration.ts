import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { collaborationPatchSchema, collaborationSettingsSchema, type CollaborationSettings, type CollaborationSnapshot } from "../client-protocol/collaboration.js";
import { ConfigFileSchema } from "../state/config-file-schema.js";
import { withFileMutex } from "../state/file-mutex.js";
import { listActiveInstances } from "../bus/bus-registry.js";
import { HubError } from "./store.js";
import type { BotManager } from "./bot-manager.js";

const digest = (bus: unknown) => createHash("sha256").update(JSON.stringify(bus ?? null)).digest("hex");
function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function settings(bus: unknown): CollaborationSettings {
  const value = object(bus);
  // Keep disabled settings editable without losing their selected workflow.
  const result = collaborationSettingsSchema.safeParse({
    enabled: bus === true || value.peers === true || value.peers === "*" || Array.isArray(value.peers) && value.peers.length > 0,
    peers: bus === true || value.peers === true ? "*" : value.peers === false || value.peers == null ? value._clientDisabledPeers ?? [] : value.peers,
    maxDepth: value.maxDepth ?? 3, parallel: value.parallel ?? [], chain: value.chain ?? [], verifier: value.verifier ?? null,
    crew: value.crew && object(value.crew).enabled !== false ? value.crew : null,
  });
  if (!result.success || bus != null && bus !== true && bus !== false && (typeof bus !== "object" || Array.isArray(bus))) throw new HubError("collaboration_config_unsupported", 409);
  return result.data;
}
async function readConfig(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!ConfigFileSchema.safeParse(parsed).success) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch { throw new HubError("collaboration_config_unreadable", 409); }
}
async function authorize(manager: BotManager, userId: string, botId: string): Promise<void> {
  await manager.store.db.serial(() => manager.store.requireOwner(userId));
  if (!await manager.owns(botId)) throw new HubError("collaboration_managed_only", 403);
}
export async function readCollaboration(manager: BotManager, userId: string, botId: string): Promise<CollaborationSnapshot> {
  await authorize(manager, userId, botId);
  const config = await readConfig(path.join(manager.directory, "bots", botId, "config.json"));
  const active = await listActiveInstances(path.join(manager.directory, "bots")).then((entries) => new Set(entries.map((entry) => entry.name)), () => null);
  const listener = (id: string) => active === null ? "unknown" as const : active.has(id) ? "online" as const : "offline" as const;
  const peers: CollaborationSnapshot["peers"] = [];
  for (const bot of await manager.store.bots(userId)) {
    if (bot.id === botId || !await manager.owns(bot.id)) continue;
    let allowsThisBot: boolean | null = null;
    try { const peer = settings((await readConfig(path.join(manager.directory, "bots", bot.id, "config.json"))).bus); allowsThisBot = peer.enabled && (peer.peers === "*" || peer.peers.includes(botId)); } catch { /* Unknown is not permission. */ }
    peers.push({ id: bot.id, name: bot.name, online: !!bot.online, allowsThisBot, listener: listener(bot.id) });
  }
  return { taskSelection: true, revision: digest(config.bus), settings: settings(config.bus), listener: listener(botId), peers };
}
/** Only the managed instance's Bus subtree is owned here. Use the same mutex as
 * native /model and /config writers, but never reset or repair unreadable config. */
export async function saveCollaboration(manager: BotManager, userId: string, botId: string, input: unknown, authorizeCommit?: () => Promise<unknown>): Promise<void> {
  await authorize(manager, userId, botId);
  const patch = collaborationPatchSchema.parse(input);
  const known = new Set((await manager.store.bots(userId)).filter((bot) => bot.managed).map((bot) => bot.id));
  const file = path.join(manager.directory, "bots", botId, "config.json");
  await withFileMutex(file, async () => {
    const config = await readConfig(file), previous = settings(config.bus);
    if (digest(config.bus) !== patch.revision) throw new HubError("collaboration_conflict", 409);
    const next = patch.settings;
    const oldPeers = previous.peers === "*" ? [] : previous.peers;
    if (next.peers !== "*" && next.peers.some((id) => id === botId || !known.has(id) && !oldPeers.includes(id))) throw new HubError("collaboration_invalid_peer");
    const targets = [...next.parallel, ...next.chain, ...(next.verifier ? [next.verifier] : []), ...(next.crew ? [next.crew.coordinator, ...Object.values(next.crew.roles)].filter((id) => id !== botId) : [])];
    if (targets.some((id) => id === botId || next.peers !== "*" && !next.peers.includes(id))) throw new HubError("collaboration_target_not_allowed");
    // Wildcard permits discovery, but API clients still cannot invent unmanaged
    // workflow targets. Existing manually configured targets may be retained.
    const oldTargets = [...previous.parallel, ...previous.chain, ...(previous.verifier ? [previous.verifier] : []), ...(previous.crew ? [previous.crew.coordinator, ...Object.values(previous.crew.roles)] : [])];
    if (targets.some((id) => !known.has(id) && !oldTargets.includes(id))) throw new HubError("collaboration_invalid_peer");
    const old = object(config.bus);
    config.bus = { ...old, ...next, peers: next.enabled ? next.peers : false, _clientDisabledPeers: next.peers,
      secret: typeof old.secret === "string" && old.secret ? old.secret : randomBytes(32).toString("hex"),
      // Monotonic identity prevents an old device's update from passing an ABA
      // conflict check after another device changes settings and changes back.
      _clientRevision: randomUUID(),
    };
    delete (config.bus as Record<string, unknown>).enabled;
    // Device trust and owner role may change while waiting for the config lock.
    await authorizeCommit?.();
    await manager.store.db.serial(() => manager.store.requireOwner(userId));
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => undefined); }
  });
}
