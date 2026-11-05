import { z } from "zod";
import { idSchema } from "./index.js";
import { collaborationPatchSchema, collaborationSettingsSchema, type CollaborationSnapshot, type CollaborationSettings } from "./collaboration.js";

/** Minimal transport shared by browser and one-shot CLI callers. */
export interface CollaborationConnection {
  http<T = unknown>(route: string, options?: { method?: string; body?: string; signal?: AbortSignal }): Promise<T>;
}
const listenerSchema = z.enum(["online", "offline", "unknown"]);
export const collaborationSnapshotSchema: z.ZodType<CollaborationSnapshot> = z.object({
  taskSelection: z.boolean().optional(), revision: collaborationPatchSchema.shape.revision,
  settings: collaborationSettingsSchema, listener: listenerSchema,
  peers: z.array(z.object({ id: idSchema, name: z.string(), online: z.boolean(), allowsThisBot: z.boolean().nullable(), listener: listenerSchema })),
});
const restartReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.string().optional() }),
]);

export type PreparationStep = { botId: string; state: "reading" | "saving" | "connecting" | "saved" };
/** Accepted restarts stay deduplicated until a live listener is observed. A
 * later outage can then get a new receipt instead of replaying an old restart. */
export function settleCollaborationRestarts(config: CollaborationSnapshot, botId: string, restartIds: Map<string, string>): void {
  if (config.listener === "online") restartIds.delete(botId);
  for (const peer of config.peers) if (peer.listener === "online") restartIds.delete(peer.id);
}
export function collaborationIssues(config: CollaborationSnapshot, targets: string[]): { id: string; reason: "disabled" | "permission" | "reciprocal" | "offline" | "missing" }[] {
  const issues: ReturnType<typeof collaborationIssues> = [];
  if (!config.settings.enabled) issues.push({ id: "", reason: "disabled" });
  else if (config.listener !== "online") issues.push({ id: "", reason: "offline" });
  for (const id of targets) {
    const peer = config.peers.find(value => value.id === id);
    if (!peer) issues.push({ id, reason: "missing" });
    else if (config.settings.peers !== "*" && !config.settings.peers.includes(id)) issues.push({ id, reason: "permission" });
    else if (peer.allowsThisBot !== true) issues.push({ id, reason: "reciprocal" });
    else if (!peer.online || peer.listener !== "online") issues.push({ id, reason: "offline" });
  }
  return issues;
}

/** Owner-triggered, additive grants. Pre-read/validate every participant before
 * writing; each write remains revision checked by the Hub. A partial failure is
 * deliberately not rolled back over newer changes made on another device. */
export async function prepareCollaboration(connection: CollaborationConnection, coordinator: string, targets: string[], restartIds: Map<string, string>, progress: (step: PreparationStep) => void, signal: AbortSignal): Promise<void> {
  if (!targets.length || targets.length > 64 || [coordinator, ...targets].some(id => !/^[\w-]{1,128}$/.test(id)) || targets.includes(coordinator) || new Set(targets).size !== targets.length) throw new Error("collaboration_invalid_peer");
  const route = (id: string) => `/api/bots/${id}/collaboration`;
  const snapshots = new Map<string, CollaborationSnapshot>();
  for (const id of [coordinator, ...targets]) {
    signal.throwIfAborted(); progress({ botId: id, state: "reading" });
    const snapshot = collaborationSnapshotSchema.parse(await connection.http(route(id), { signal }));
    if (snapshot.listener === "unknown") throw new Error("collaboration_listener_unknown");
    snapshots.set(id, snapshot);
  }
  const patches = new Map<string, CollaborationSettings>();
  for (const [id, snapshot] of snapshots) {
    const additions = id === coordinator ? targets : [coordinator];
    if (additions.some(peer => !snapshot.peers.some(value => value.id === peer))) throw new Error("collaboration_invalid_peer");
    // Dormant selections are not active grants. Enabling unrelated saved peers
    // would authorize more than this participant's selected reciprocal pairs.
    if (!snapshot.settings.enabled && snapshot.settings.peers === "*") throw new Error("collaboration_disabled_wildcard_requires_review");
    if (!snapshot.settings.enabled && Array.isArray(snapshot.settings.peers) && snapshot.settings.peers.some(peer => !additions.includes(peer)))
      throw new Error("collaboration_disabled_peers_requires_review");
    const peers = snapshot.settings.peers === "*" ? "*" : [...new Set([...snapshot.settings.peers, ...additions])];
    patches.set(id, collaborationSettingsSchema.parse({ ...snapshot.settings, enabled: true, peers }));
  }
  for (const [id, snapshot] of snapshots) {
    signal.throwIfAborted();
    const settings = patches.get(id)!;
    if (JSON.stringify(settings) !== JSON.stringify(snapshot.settings)) {
      progress({ botId: id, state: "saving" });
      const saved = collaborationSnapshotSchema.parse(await connection.http(route(id), { method: "PUT", body: JSON.stringify({ revision: snapshot.revision, settings }), signal }));
      // The Hub reads the snapshot after its CAS write. A different device may
      // have changed it again before that read; never claim the old grants won.
      if (JSON.stringify(saved.settings) !== JSON.stringify(settings)) throw new Error("collaboration_conflict");
      if (saved.listener === "unknown") throw new Error("collaboration_listener_unknown");
      const additions = id === coordinator ? targets : [coordinator];
      if (additions.some(peer => !saved.peers.some(value => value.id === peer))) throw new Error("collaboration_invalid_peer");
      snapshots.set(id, saved);
    }
    progress({ botId: id, state: "saved" });
  }
  // Only disconnected services need a restart. Existing Bus listeners reload
  // authorization for each request, so permission-only edits need no restart.
  for (const [id, snapshot] of snapshots) {
    signal.throwIfAborted();
    if (snapshot.listener === "online") continue;
    progress({ botId: id, state: "connecting" });
    const receiptId = restartIds.get(id) ?? `collaboration_${crypto.randomUUID()}`;
    restartIds.set(id, receiptId);
    const result = restartReplySchema.parse(await connection.http(`/api/bots/${id}/restart`, { method: "POST", body: JSON.stringify({ receiptId }), signal }));
    if (!result.ok) { restartIds.delete(id); throw new Error(result.error ?? "restart_unconfirmed"); }
    // Retain the receipt across retries while an accepted idle restart is pending.
    progress({ botId: id, state: "saved" });
  }
}

/** Workspace roles can repeat a Bot. Grants belong to distinct remote Bots;
 * roles on the coordinator execute locally and need no self/network grant. */
export function agentBusPeerIds(coordinator: string, targets: string[]): string[] {
  return [...new Set(targets.filter(id => id && id !== coordinator))];
}
export function agentBusCollaborationIssues(config: CollaborationSnapshot, coordinator: string, targets: string[]): ReturnType<typeof collaborationIssues> {
  const peers = agentBusPeerIds(coordinator, targets);
  return peers.length ? collaborationIssues(config, peers) : [];
}
export async function prepareAgentBusCollaboration(connection: CollaborationConnection, coordinator: string, targets: string[], restartIds: Map<string, string>, progress: (step: PreparationStep) => void, signal: AbortSignal): Promise<void> {
  if (!targets.length || targets.length > 64 || [coordinator, ...targets].some(id => !/^[\w-]{1,128}$/.test(id))) throw new Error("collaboration_invalid_peer");
  const peers = agentBusPeerIds(coordinator, targets);
  if (peers.length) return prepareCollaboration(connection, coordinator, peers, restartIds, progress, signal);
  signal.throwIfAborted();
  // Preserve management authorization/availability checks, without enabling a
  // dormant wildcard configuration just to execute a local role.
  collaborationSnapshotSchema.parse(await connection.http(`/api/bots/${coordinator}/collaboration`, { signal }));
}
