import { createContext } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeBase64 } from "../../src/client-protocol/base64.js";
import type { ConnectedHost } from "./host-connections.js";

// The App's authenticated connections supply display names, never authority.
// The receiving Host independently validates every grant and its network peer.
export const BotMessageHostsContext = createContext<ConnectedHost[]>([]);
export function botMessageHostId(key: string): string {
  return `hub_${bytesToHex(sha256(decodeBase64(key)))}`;
}
function messageSourceConnection(entries: ConnectedHost[], hostId: string) {
  const entry = entries.find(value => value.host.publicKey && botMessageHostId(value.host.publicKey) === hostId);
  const connection = entry?.connection;
  if (!connection || entry.host.networkBlocked || connection.isNetworkBlocked || connection.state.status !== "online") return undefined;
  return connection;
}
export function messageSourceBots(entries: ConnectedHost[], hostId: string) {
  return messageSourceConnection(entries, hostId)?.state.bots.filter(bot => bot.role !== "worker" && !bot.deletedAt) ?? [];
}
export function isInternalMessageSource(entries: ConnectedHost[], hostId: string, botId: string): boolean {
  const state = messageSourceConnection(entries, hostId)?.state;
  return !!state && [...state.bots, ...(state.dispatchWorkers ?? [])].some(bot => bot.id === botId && bot.role === "worker");
}
