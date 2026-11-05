import { loadBusConfig } from "../bus/bus-config.js";
import { createBusTalkHandler } from "../bus/bus-handler.js";
import { deregisterInstance, pruneStaleInstances, registerInstance, resolveChannelRoot } from "../bus/bus-registry.js";
import { createBusServer, startBusServer, stopBusServer } from "../bus/bus-server.js";
import type { CoreBridgeLike } from "../core/types.js";

/** Same authenticated Bus and accounting path as the CLI. Managed workers
 * discover peers under <hub>/bots only; no implicit access to the live fleet. */
export async function startGatewayBus(stateDir: string, botId: string, bridge: CoreBridgeLike) {
  const config = await loadBusConfig(stateDir); if (!config) return undefined;
  const channelRoot = resolveChannelRoot(stateDir); await pruneStaleInstances(channelRoot);
  const execute = createBusTalkHandler({ bridge, stateDir, instanceName: botId }); let active = 0;
  const server = createBusServer(botId, stateDir, async (request, context) => { active++; try { return await execute(request, context); } finally { active--; } }, config.secret);
  try {
    const port = await startBusServer(server, config.port); await registerInstance(channelRoot, botId, port, config.secret);
  } catch (error) { await stopBusServer(server); throw error; }
  return { isBusy: () => active > 0, activeCount: () => active, stop: async () => { try { await stopBusServer(server); } finally { await deregisterInstance(channelRoot, botId); } } };
}
