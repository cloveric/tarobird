import { channelProfile } from "./channel-profile.js";
import path from "node:path";

import { withFileMutex } from "../state/file-mutex.js";
import { JsonStore } from "../state/json-store.js";
import type { CoreNormalizedBridgeMessage } from "./message-normalizer.js";

const CHAT_ID_MAP_FILENAME = "chat-id-map.json";
const USER_ID_MAP_FILENAME = "user-id-map.json";

type CoreNumericIdKind = "chat" | "user";

export async function verifyCoreNumericIds(stateDir: string, normalized: CoreNormalizedBridgeMessage): Promise<void> {
  await assertStableCoreIdMappings(stateDir, [
    ["chat", normalized.bridgeChatId, normalized.conversationKey],
    ["chat", normalized.bridgeAccessChatId, normalized.accessConversationKey],
    ["user", normalized.bridgeUserId, normalized.senderId],
  ]);
}

export async function assertStableCoreIdMappings(
  stateDir: string,
  mappings: Array<[CoreNumericIdKind, number, string]>,
): Promise<void> {
  const grouped = new Map<CoreNumericIdKind, Array<[number, string]>>();
  for (const [kind, numericId, rawId] of mappings) {
    const entries = grouped.get(kind) ?? [];
    entries.push([numericId, rawId]);
    grouped.set(kind, entries);
  }

  for (const [kind, entries] of grouped) {
    const legacyPath = path.join(stateDir, `lark-${kind}-id-map.json`);
    const mapPath = channelProfile() === "gateway" ? path.join(stateDir, coreIdMapFilename(kind)) : legacyPath;
    await withFileMutex(mapPath, async () => {
      const store = new JsonStore<Record<string, string>>(mapPath, parseCoreIdMap, mapPath === legacyPath ? [] : [legacyPath]);
      const current = await store.read({});
      let changed = false;
      for (const [numericId, rawId] of entries) {
        const key = String(numericId);
        const existing = current[key];
        if (existing && existing !== rawId) {
          throw new Error(`Conversation ${kind} numeric ID collision for ${numericId}`);
        }
        if (!existing) {
          current[key] = rawId;
          changed = true;
        }
      }
      if (changed) {
        await store.write(current);
      }
    });
  }
}

function coreIdMapFilename(kind: CoreNumericIdKind): string {
  return kind === "chat" ? CHAT_ID_MAP_FILENAME : USER_ID_MAP_FILENAME;
}

function parseCoreIdMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const parsed: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/^\d+$/.test(key) && typeof raw === "string") {
      parsed[key] = raw;
    }
  }
  return parsed;
}
