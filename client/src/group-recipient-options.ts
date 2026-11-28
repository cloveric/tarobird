import type { RemoteGroupRoster } from "../../src/client-protocol/group-recipients.js";
import type { Bot } from "./connection.js";

export type GroupRecipientOption = {
  id: string;
  botId: string;
  name: string;
  label: string;
  source?: string;
  bot?: Bot;
};

export function groupRecipientOptions(botIds: readonly string[], bots: readonly Bot[], labels: ReadonlyMap<string, string>, hostName: string, remote: RemoteGroupRoster = []): GroupRecipientOption[] {
  const candidates = botIds.map((botId): Omit<GroupRecipientOption, "label"> & { hostName: string; hostId?: string } => {
    const bot = bots.find(value => value.id === botId);
    return { id: botId, botId, name: labels.get(botId) ?? bot?.name ?? botId, hostName, bot };
  }).concat(remote.map(({ memberKey, name, hostName }) => {
    const [, hostId, botId] = memberKey.split(":");
    return { id: memberKey, botId: botId!, name, hostName: hostName || hostId!, hostId };
  }));
  return candidates.map(candidate => {
    const duplicates = candidates.filter(other => other.name.toLowerCase() === candidate.name.toLowerCase());
    const needsHost = candidate.hostId || duplicates.length > 1;
    const needsId = needsHost && duplicates.filter(other => other.hostName.toLowerCase() === candidate.hostName.toLowerCase()).length > 1;
    const source = needsHost ? [candidate.hostName, ...(needsId ? [candidate.hostId ? `${candidate.hostId}/${candidate.botId}` : candidate.botId] : [])].join(" · ") : undefined;
    const { id, botId, name, bot } = candidate;
    return { id, botId, name, bot, source, label: source ? `${name} · ${source}` : name };
  });
}
