/** Synthetic host IDs request a fresh engine session. Existing native bindings
 * are never renamed. Accept the old prefix for persisted queues and cron runs. */
export function isLogicalSessionId(sessionId: string): boolean {
  return sessionId.startsWith("tarobot-") || sessionId.startsWith("telegram-");
}
