export function getConversationKey(chatId: number, messageThreadId?: number): string {
  return typeof messageThreadId === "number"
    ? `chat:${chatId}:topic:${messageThreadId}`
    : `chat:${chatId}`;
}

export function getNormalizedConversationKey(input: {
  chatId: number;
  messageThreadId?: number;
  conversationKey?: string;
}): string {
  return input.conversationKey ?? getConversationKey(input.chatId, input.messageThreadId);
}

export function getConversationLogScope(input: {
  chatId: number;
  messageThreadId?: number;
  conversationKey?: string;
}): { messageThreadId?: number; conversationKey: string } {
  return {
    ...(typeof input.messageThreadId === "number" ? { messageThreadId: input.messageThreadId } : {}),
    conversationKey: getNormalizedConversationKey(input),
  };
}

export function isSameConversation(
  left: { chatId: number; messageThreadId?: number },
  right: { chatId: number; messageThreadId?: number },
): boolean {
  return left.chatId === right.chatId && left.messageThreadId === right.messageThreadId;
}
