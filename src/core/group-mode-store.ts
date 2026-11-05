import { channelProfile } from "./channel-profile.js";
import path from "node:path";

import { JsonStore } from "../state/json-store.js";

interface CoreGroupModeState {
  listenAllChatIds: string[];
}

function parseState(value: unknown): CoreGroupModeState {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const listenAllChatIds = Array.isArray(raw.listenAllChatIds)
    ? raw.listenAllChatIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    listenAllChatIds: [...new Set(listenAllChatIds)],
  };
}

export class CoreGroupModeStore {
  private static readonly writeQueues = new Map<string, Promise<void>>();
  private readonly store: JsonStore<CoreGroupModeState>;
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, channelProfile() === "gateway" ? "group-mode.json" : "lark-group-mode.json");
    this.store = new JsonStore(this.filePath, parseState, [path.join(stateDir, "lark-group-mode.json")]);
  }

  async isListenAll(chatId: string): Promise<boolean> {
    const state = await this.store.read({ listenAllChatIds: [] });
    return state.listenAllChatIds.includes(chatId);
  }

  async setListenAll(chatId: string, enabled: boolean): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.store.read({ listenAllChatIds: [] });
      const next = enabled
        ? [...new Set([...state.listenAllChatIds, chatId])]
        : state.listenAllChatIds.filter((entry) => entry !== chatId);
      await this.store.write({ listenAllChatIds: next });
    });
  }

  async clearListenAll(): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.store.write({ listenAllChatIds: [] });
    });
  }

  async countListenAll(): Promise<number> {
    const state = await this.store.read({ listenAllChatIds: [] });
    return state.listenAllChatIds.length;
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const previous = CoreGroupModeStore.writeQueues.get(this.filePath) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const queued = next.catch(() => undefined);
    CoreGroupModeStore.writeQueues.set(this.filePath, queued);
    try {
      await next;
    } finally {
      if (CoreGroupModeStore.writeQueues.get(this.filePath) === queued) {
        CoreGroupModeStore.writeQueues.delete(this.filePath);
      }
    }
  }
}
