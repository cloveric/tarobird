import { randomInt } from "node:crypto";
import { SELECTABLE_BOT_AVATARS } from "../client-protocol/bot-avatar-catalog.js";
import type { HubDatabase } from "./database.js";

export const BOT_AVATAR_DEFAULT_PREFIX = "bot-avatar-default:v1:";
/** Call in the same transaction as a NEW Bot insert. Existing Bots are never
 * backfilled: preserving their old mapping is part of their visual identity.
 * The metadata lives in the existing SQLite backup and survives retries,
 * rename, delete/restore and later catalog additions without a schema bump. */
export async function assignNewBotAvatar(db: HubDatabase, botId: string): Promise<void> {
  const key = BOT_AVATAR_DEFAULT_PREFIX + botId;
  if (await db.get("SELECT 1 FROM meta WHERE key=?", [key])) return;
  // The new row already exists in this transaction. Count ALL other Bots,
  // including deletion tombstones, so deleting the last Bot or pairing a new
  // device cannot turn an established Host into a first-install experience.
  const previous = await db.get("SELECT 1 FROM bots WHERE id<>? LIMIT 1", [botId]);
  const avatarId = previous ? SELECTABLE_BOT_AVATARS[randomInt(SELECTABLE_BOT_AVATARS.length)]!.id : "pastel-fox";
  await db.run("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)", [key, avatarId]);
}
