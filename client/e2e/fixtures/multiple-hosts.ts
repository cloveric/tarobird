import { ClientCache, cache } from "../../src/storage.js";
import { HubConnection } from "../../src/connection.js";
import { HostConnections } from "../../src/host-connections.js";
import { HostRegistry, runtimeHostId, type RuntimeHostHandle } from "../../src/host-registry.js";
import { createIdentity, randomNonce } from "../../src/identity.js";
import { questionDraftKey } from "../../src/question-draft.js";

const registry = new HostRegistry();
const pool = new HostConnections(registry);
const handles = new Map<string, RuntimeHostHandle>();
const connections = new Map<string, HubConnection>();
export const multipleHosts = {
  ClientCache, HubConnection, HostRegistry, HostConnections, runtimeHostId, createIdentity, questionDraftKey, cache, registry, pool, handles, connections,
  async pair(url: string, name: string, invite: string) {
    const identity = await createIdentity(name, [{ name: "Direct", url }]);
    const health = await (await fetch(`${url}/health`)).json();
    const response = await fetch(`${url}/api/pair`, { method: "POST", body: JSON.stringify({ deviceId: identity.deviceId, name, platform: "web", publicKey: identity.publicKey, invite, requestId: randomNonce() }) });
    const result = await response.json(); if (!response.ok || result.hubPublicKey !== health.publicKey) throw new Error("pair_failed");
    identity.hubPublicKey = result.hubPublicKey;
    const host = await registry.add(identity, name);
    return { host, code: result.code as string };
  },
  async start(id: string) {
    if (!handles.has(id)) handles.set(id, await registry.open(id));
    const handle = handles.get(id)!;
    if (!connections.has(id)) connections.set(id, new HubConnection(handle.identity, handle.cache));
    await connections.get(id)!.start();
  },
  async inspect(id: string) {
    const { cache } = handles.get(id) ?? await registry.open(id);
    return { conversations: await cache.conversations(), messages: await cache.messages("same_conversation"), cursors: await cache.cursors(), activity: await cache.activity(), draft: await cache.draft("same_conversation"), outbox: await cache.outbox(), profiles: await cache.profiles() };
  },
};
Object.assign(window, { multipleHosts });
