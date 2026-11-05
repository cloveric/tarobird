import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { botMessageHostId, isInternalMessageSource, messageSourceBots } from "./bot-message-hosts.js";
import type { ConnectedHost } from "./host-connections.js";

it("resolves source Bots by authenticated host identity, not a duplicate display name", () => {
  const key = Buffer.alloc(44, 3).toString('base64'), other = Buffer.alloc(44, 4).toString('base64');
  const id = `hub_${createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')}`;
  expect(botMessageHostId(key)).toBe(id);
  const bots = [{ id: 'one', name: 'Assistant' }, { id: 'chief', name: 'Chancellor', role: 'dispatcher' }, { id: 'internal', role: 'worker' }, { id: 'deleted', deletedAt: 1 }];
  const entries = [
    { host: { publicKey: other, name: 'Same host' }, connection: { state: { status: 'online', bots: [{ id: 'wrong' }] } } },
    { host: { publicKey: key, name: 'Same host' }, connection: { state: { status: 'online', bots, dispatchWorkers: [{ id: 'hidden', role: 'worker' }] } } },
  ] as unknown as ConnectedHost[];
  expect(messageSourceBots(entries, id).map(bot => bot.id)).toEqual(['one', 'chief']);
  expect(isInternalMessageSource(entries, id, 'internal')).toBe(true);
  expect(isInternalMessageSource(entries, id, 'hidden')).toBe(true);
  expect(isInternalMessageSource(entries, id, 'chief')).toBe(false);
  expect(isInternalMessageSource(entries, botMessageHostId(other), 'internal')).toBe(false);
  entries[1]!.host.networkBlocked = true;
  expect(messageSourceBots(entries, id)).toEqual([]);
  expect(isInternalMessageSource(entries, id, 'internal')).toBe(false);
  entries[1]!.host.networkBlocked = false;
  entries[1]!.connection!.state.status = 'offline';
  expect(messageSourceBots(entries, id)).toEqual([]);
  expect(messageSourceBots(entries, botMessageHostId(Buffer.alloc(44, 5).toString('base64')))).toEqual([]);
});
