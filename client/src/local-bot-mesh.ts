import { LOCAL_MESSAGE_GRANT_BATCH_LIMIT, type BotMessageGrantsCommand, type BotMessageGrantsSnapshot } from "../../src/client-protocol/bot-message-grants.js";

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

/** Apply the plan from the confirmed snapshot, advancing the revision after each signed write.
 * A conflict stops the plan and leaves reconciliation to the caller's next read. */
export async function applyLocalMesh(
  initial: BotMessageGrantsSnapshot,
  save: (command: BotMessageGrantsCommand) => Promise<BotMessageGrantsSnapshot>,
  onSourceComplete: (view: BotMessageGrantsSnapshot) => void,
) {
  let current = initial;
  for (const { sourceBot, targets } of missingLocalGrants(initial)) {
    for (let start = 0; start < targets.length; start += LOCAL_MESSAGE_GRANT_BATCH_LIMIT) {
      const changes = targets.slice(start, start + LOCAL_MESSAGE_GRANT_BATCH_LIMIT).map(targetBot => ({ targetBot, allowed: true }));
      current = await save({ operation: "local-message-grants", sourceBot, revision: current.revision, changes });
    }
    const granted = new Set(current.grants.filter(grant => grant.sourceBot === sourceBot).map(grant => grant.targetBot));
    if (!targets.every(target => granted.has(target))) throw new Error("grants_changed");
    onSourceComplete(current);
  }
}
