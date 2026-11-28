import type { BotMessageGrantsSnapshot } from "../../src/client-protocol/bot-message-grants.js";

/** For each local Bot, the other local Bots it may not message yet. Self-grants are never included. */
export function missingLocalGrants(view: BotMessageGrantsSnapshot): { sourceBot: string; targets: string[] }[] {
  const allowed = new Set(view.grants.map(grant => `${grant.sourceBot}\u0000${grant.targetBot}`));
  return view.bots.flatMap(source => {
    const targets = view.bots
      .filter(target => target.id !== source.id && !allowed.has(`${source.id}\u0000${target.id}`))
      .map(target => target.id);
    return targets.length ? [{ sourceBot: source.id, targets }] : [];
  });
}

/** How many of the N×(N−1) directed grants between different local Bots exist. */
export function localMeshCounts(view: BotMessageGrantsSnapshot): { bots: number; total: number; allowed: number } {
  const bots = view.bots.length, total = bots > 1 ? bots * (bots - 1) : 0;
  const missing = missingLocalGrants(view).reduce((sum, entry) => sum + entry.targets.length, 0);
  return { bots, total, allowed: total - missing };
}
