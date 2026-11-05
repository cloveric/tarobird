import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { HubConnection } from "./connection.js";
import type { GroupReplyMode } from "./group-composer-send.js";
import { LEGACY_GROUP_REPLY_REVISION } from "./group-reply-guard.js";

const capabilitiesKey = "group-reply-capabilities";
const capabilitySchema = z.object({ hub: z.string(), discussion: z.boolean(), guard: z.boolean() });
const modeSchema = z.object({ hub: z.string(), conversationId: z.string(), mode: z.enum(["mentions", "parallel", "sequential", "independent"]), revision: z.string().min(1), delivery: z.enum(["guarded", "legacy", "unguarded"]), botOrder: z.array(z.string()).max(32).optional(), activeRun: z.object({ id: z.string(), conversationId: z.string(), revision: z.string().optional(), topic: z.string().max(500).optional(), status: z.enum(["running", "pausing", "paused", "ending"]).optional(), pauseReason: z.string().optional(), actions: z.array(z.enum(["pause", "resume", "end", "retry"])).optional(), participants: z.array(z.object({ botId: z.string(), name: z.string(), active: z.boolean().optional() })).max(8).optional() }).optional() });
const memory = new WeakMap<HubConnection, Map<string, GroupReplyMode>>();
const legacyMode = (conversationId: string): GroupReplyMode => ({ conversationId, mode: "mentions", revision: LEGACY_GROUP_REPLY_REVISION, delivery: "legacy" });
const hubKey = (connection: HubConnection) => connection.identity.hubPublicKey ?? "";

/** Cache only authenticated handshake facts, under the identity-owned cache. */
export async function rememberGroupReplyCapabilities(connection: HubConnection): Promise<void> {
  if (connection.state.status !== "online" || connection.state.groupDiscussionAvailable === undefined) return;
  await connection.cache.saveGroupReplyMetadata(capabilitiesKey, JSON.stringify({ hub: hubKey(connection), discussion: connection.state.groupDiscussionAvailable, guard: !!connection.state.groupReplyGuardAvailable }), connection.identity);
}

/** Online views are authoritative. Cached views only authorize a guarded queue;
 * they never start a discussion or override a new Host handshake. */
export function useGroupReplyMode(connection: HubConnection, conversationId: string): readonly [GroupReplyMode | undefined, (value: GroupReplyMode) => void] {
  const [stored, setStored] = useState<{ connection: HubConnection; mode: GroupReplyMode }>();
  const active = useRef(conversationId); active.current = conversationId;
  let modes = memory.get(connection);
  if (!modes) { modes = new Map(); memory.set(connection, modes); }
  const modesForHost = modes;
  const accept = useCallback((value: GroupReplyMode) => {
    const next: GroupReplyMode = { ...value, delivery: connection.state.groupReplyGuardAvailable ? "guarded" : "unguarded" };
    modesForHost.set(value.conversationId, next);
    if (active.current === value.conversationId) setStored({ connection, mode: next });
    if (connection.state.status === "online") void connection.cache.saveGroupReplyMetadata(`group-reply-mode:${value.conversationId}`, JSON.stringify({ ...next, hub: hubKey(connection) }), connection.identity).catch(() => undefined);
  }, [connection, modesForHost]);
  useEffect(() => {
    let disposed = false;
    if (!conversationId) return;
    const previous = modesForHost.get(conversationId);
    if (previous) setStored({ connection, mode: previous });
    void Promise.all([connection.cache.groupReplyMetadata(`group-reply-mode:${conversationId}`), connection.cache.groupReplyMetadata(capabilitiesKey)]).then(([rawMode, rawCapabilities]) => {
      if (disposed || modesForHost.has(conversationId)) return;
      const parse = (raw: string) => { try { return JSON.parse(raw); } catch { return undefined; } };
      const saved = modeSchema.safeParse(parse(rawMode)), capabilities = capabilitySchema.safeParse(parse(rawCapabilities));
      if (!capabilities.success || capabilities.data.hub !== hubKey(connection)) return;
      const value = !capabilities.data.discussion ? legacyMode(conversationId)
        : saved.success && saved.data.hub === hubKey(connection) && saved.data.conversationId === conversationId ? saved.data : undefined;
      if (value) { modesForHost.set(conversationId, value); setStored({ connection, mode: value }); }
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [connection, conversationId, modesForHost]);
  // Even a fast first send to a legacy Hub is available after its live handshake.
  const current = connection.state.groupDiscussionAvailable === false ? legacyMode(conversationId)
    : stored?.connection === connection && stored.mode.conversationId === conversationId ? stored.mode : modesForHost.get(conversationId);
  // An upgraded Host must not inherit a legacy-mode display or routing decision.
  return [connection.state.groupDiscussionAvailable === true && current?.delivery === "legacy" ? undefined : current, accept];
}
