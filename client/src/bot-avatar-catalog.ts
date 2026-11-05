import { BOT_AVATARS, SELECTABLE_BOT_AVATARS, botAvatarById, type BotAvatar } from "../../src/client-protocol/bot-avatar-catalog.js";
export { BOT_AVATARS, SELECTABLE_BOT_AVATARS, BOT_AVATAR_LIBRARY, type BotAvatar } from "../../src/client-protocol/bot-avatar-catalog.js";

// The original mapping is only the compatibility fallback for unassigned Bots.
// New Hosts assign once from the active shared catalog and persist the ID.
export function defaultBotAvatar(botId: string, assignedId?: string): BotAvatar {
  const assigned = botAvatarById(assignedId);
  if (assigned) return assigned;
  let hash = 2166136261;
  for (let i = 0; i < botId.length; i++) { hash ^= botId.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return BOT_AVATARS[(hash >>> 0) % 36]!;
}
export function randomBotAvatar(except?: string): BotAvatar {
  const choices = SELECTABLE_BOT_AVATARS.filter((avatar) => avatar.id !== except);
  const value = new Uint32Array(1); crypto.getRandomValues(value);
  return choices[value[0]! % choices.length]!;
}
