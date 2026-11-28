import { expect, it, vi } from "vitest";
import type { BotMessageGrantsCommand } from "../../src/client-protocol/bot-message-grants.js";
import { applyLocalMesh, localMeshCounts, missingLocalGrants } from "./local-bot-mesh.js";

const revision = "a".repeat(64);
const bots = ["alpha", "beta", "gamma"].map(id => ({ id, name: id, online: true }));

it("lists every missing directed pair between different Bots, never self-grants", () => {
  const view = { revision, bots, grants: [{ sourceBot: "alpha", targetBot: "beta" }, { sourceBot: "alpha", targetBot: "alpha" }] };
  expect(missingLocalGrants(view)).toEqual([
    { sourceBot: "alpha", targets: ["gamma"] },
    { sourceBot: "beta", targets: ["alpha", "gamma"] },
    { sourceBot: "gamma", targets: ["alpha", "beta"] },
  ]);
  expect(localMeshCounts(view)).toEqual({ bots: 3, total: 6, allowed: 1 });
});

it("is empty once every pair is allowed, and ignores grants to Bots that are no longer listed", () => {
  const grants = bots.flatMap(source => bots.filter(target => target.id !== source.id).map(target => ({ sourceBot: source.id, targetBot: target.id })));
  const view = { revision, bots, grants: [...grants, { sourceBot: "alpha", targetBot: "deleted" }] };
  expect(missingLocalGrants(view)).toEqual([]);
  expect(localMeshCounts(view)).toEqual({ bots: 3, total: 6, allowed: 6 });
});

it("has nothing to do with fewer than two Bots", () => {
  expect(missingLocalGrants({ revision, bots: bots.slice(0, 1), grants: [] })).toEqual([]);
  expect(localMeshCounts({ revision, bots: [], grants: [] })).toEqual({ bots: 0, total: 0, allowed: 0 });
});

it("bounds each signed batch and stops on a stale revision without replay", async () => {
  const crowded = Array.from({ length: 258 }, (_, index) => ({ id: `bot_${index}`, name: `Bot ${index}`, online: true }));
  const before = { revision, bots: crowded, grants: [] };
  const nextRevision = "b".repeat(64);
  const conflict = new Error("bot_message_grants_changed");
  const save = vi.fn(async (command: BotMessageGrantsCommand) => {
    if (command.revision !== revision) throw conflict;
    return { ...before, revision: nextRevision, grants: command.changes.map(({ targetBot }) => ({ sourceBot: command.sourceBot, targetBot })) };
  });
  const complete = vi.fn();
  await expect(applyLocalMesh(before, save, complete)).rejects.toBe(conflict);
  expect(save.mock.calls.map(([command]) => [command.sourceBot, command.revision, command.changes.length])).toEqual([
    ["bot_0", revision, 256],
    ["bot_0", nextRevision, 1],
  ]);
  expect(complete).not.toHaveBeenCalled();
});
