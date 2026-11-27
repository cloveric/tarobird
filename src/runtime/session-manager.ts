import { SessionHistoryPendingError } from "../state/session-history-error.js";
import { randomUUID } from "node:crypto";
import { SessionStore, type SessionHistoryBinding, type SessionHistoryFinalization } from "../state/session-store.js";
import type { CodexAdapter } from "../codex/adapter.js";
import { getConversationKey } from "./conversation-key.js";
import { sessionLockNamespace } from "./turn-lock.js";

export class SessionStateError extends Error {
  readonly repairable: boolean;

  constructor(message: string, repairable: boolean) {
    super(message);
    this.name = "SessionStateError";
    this.repairable = repairable;
  }
}

const REPAIRABLE_SESSION_STATE_ERROR =
  "Session state is unreadable right now. The operator needs to repair session state and retry.";
const NON_REPAIRABLE_SESSION_STATE_ERROR =
  "Session state is unavailable right now. The operator needs to restore read access and retry.";

export class SessionManager {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly adapter: CodexAdapter,
  ) {}

  async getLockNamespace(): Promise<string> {
    return await sessionLockNamespace(this.sessionStore.filePath);
  }

  async getOrCreateSession(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }): Promise<{ sessionId: string }> {
    const chatId = typeof scope === "number" ? scope : scope.chatId;
    const messageThreadId = typeof scope === "number" ? undefined : scope.messageThreadId;
    const conversationKey = typeof scope === "number"
      ? getConversationKey(scope)
      : scope.conversationKey ?? getConversationKey(scope.chatId, scope.messageThreadId);
    const existing = await this.sessionStore.findByConversationKeySafe(conversationKey);

    if (existing.warning) {
      throw new SessionStateError(
        existing.repairable ? REPAIRABLE_SESSION_STATE_ERROR : NON_REPAIRABLE_SESSION_STATE_ERROR,
        existing.repairable ?? false,
      );
    }

    if (existing.record) {
      if (existing.record.historyFence) throw new SessionHistoryPendingError();
      return { sessionId: existing.record.codexSessionId };
    }

    // A missing binding means a fresh native context. Some engines use this
    // supplied id verbatim, so a stable chat-derived id would reopen history
    // after /reset. Keep the logical prefix expected by the other adapters;
    // existing (including legacy) native bindings still return unchanged above.
    const scopePrefix = messageThreadId === undefined ? `tarobot-${chatId}` : `tarobot-${chatId}-topic-${messageThreadId}`;
    return { sessionId: `${scopePrefix}-${randomUUID()}` };
  }

  async getExistingSession(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }): Promise<{ sessionId: string } | null> {
    const conversationKey = typeof scope === "number"
      ? getConversationKey(scope)
      : scope.conversationKey ?? getConversationKey(scope.chatId, scope.messageThreadId);
    const existing = await this.sessionStore.findByConversationKeySafe(conversationKey);

    if (existing.warning) {
      throw new SessionStateError(
        existing.repairable ? REPAIRABLE_SESSION_STATE_ERROR : NON_REPAIRABLE_SESSION_STATE_ERROR,
        existing.repairable ?? false,
      );
    }

    return existing.record ? { sessionId: existing.record.codexSessionId } : null;
  }

  async isSessionShared(conversationKey: string, sessionId: string): Promise<boolean> {
    const snapshot = await this.sessionStore.inspect();
    if (snapshot.warning) throw new SessionStateError(NON_REPAIRABLE_SESSION_STATE_ERROR, false);
    return snapshot.state.chats.some(record => record.codexSessionId === sessionId
      && (record.conversationKey ?? getConversationKey(record.telegramChatId, record.telegramThreadId)) !== conversationKey);
  }

  async bindSession(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }, sessionId: string): Promise<void> {
    const chatId = typeof scope === "number" ? scope : scope.chatId;
    const messageThreadId = typeof scope === "number" ? undefined : scope.messageThreadId;
    const conversationKey = typeof scope === "number"
      ? getConversationKey(scope)
      : scope.conversationKey ?? getConversationKey(scope.chatId, scope.messageThreadId);
    const existing = await this.sessionStore.findByConversationKey(conversationKey);
    await this.sessionStore.upsert({
      telegramChatId: chatId,
      telegramThreadId: messageThreadId,
      conversationKey,
      codexSessionId: sessionId,
      status: "idle",
      updatedAt: new Date().toISOString(),
      resume: existing?.resume,
      suspendedPrevious: existing?.suspendedPrevious,
    });
  }

  async clearSession(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }): Promise<boolean> {
    const conversationKey = typeof scope === "number"
      ? getConversationKey(scope)
      : scope.conversationKey ?? getConversationKey(scope.chatId, scope.messageThreadId);
    return await this.sessionStore.removeByConversationKey(conversationKey);
  }

  async assertHistoryAvailable(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }): Promise<void> {
    const record = await this.sessionStore.findByConversationKey(this.historyKey(scope));
    if (record?.historyFence) throw new SessionHistoryPendingError();
  }

  getHistoryBinding(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }): Promise<SessionHistoryBinding | null> {
    return this.sessionStore.inspectHistory(this.historyKey(scope));
  }

  reserveHistory(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }, revision: string, operationId: string): Promise<SessionHistoryBinding> {
    return this.sessionStore.reserveHistory(this.historyKey(scope), revision, operationId);
  }

  releaseHistory(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }, operationId: string): Promise<void> {
    return this.sessionStore.releaseHistory(this.historyKey(scope), operationId);
  }

  finalizeHistory(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }, input: SessionHistoryFinalization): Promise<{ revision: string }> {
    return this.sessionStore.finalizeHistory(this.historyKey(scope), input);
  }

  private historyKey(scope: number | { chatId: number; messageThreadId?: number; conversationKey?: string }): string {
    return typeof scope === "number" ? getConversationKey(scope) : scope.conversationKey ?? getConversationKey(scope.chatId, scope.messageThreadId);
  }
}
