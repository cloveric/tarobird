import type { CardElement, Message } from '../../src/client-protocol/index.js';
import { nativeQuestionData } from './question-draft.js';

/** A local projection of an actionable request, never of a running turn. */
export type MessageAttention = { kind: 'question' | 'approval'; at: number };

/** Resolved cards drop or disable their actions. Do not infer completion from
 * message status: a complete message can still contain a live question. */
export function messageAttention(message: Message): MessageAttention | undefined {
  if (message.authorType !== 'bot' || message.forwardedFrom || message.status === 'deleted' || message.status === 'error') return;
  let kind: MessageAttention['kind'] | undefined;
  const visit = (elements: CardElement[]) => {
    for (const element of elements) {
      if (element.disabled) continue;
      if (element.type === 'form' && nativeQuestionData(element)
        && element.children?.some((child) => child.type === 'button' && child.name === 'askq_submit' && child.actionId && !child.disabled && !child.url)) kind = 'question';
      if (element.type === 'button' && element.actionId && !element.url) {
        const value = element.value;
        if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.requestId === 'string' && value.requestId) {
          if (value.cctb_lark === 'ask_user_question' && value.action === 'form_submit') kind = 'question';
          if (!kind && value.cctb_lark === 'approval' && ['allow_once', 'allow_session', 'deny'].includes(String(value.decision))) kind = 'approval';
        }
      }
      visit(element.children ?? []);
    }
  };
  for (const block of message.blocks) if (block.type === 'card') visit(block.elements);
  return kind ? { kind, at: message.createdAt } : undefined;
}

export type AttentionTarget = MessageAttention & { conversationId: string; messageId: string; topicTitle?: string };

/** Oldest request first gives an unchanged target until it is resolved. Each
 * owning host supplies its own activity; IDs never cross a cache boundary. */
export function attentionTargets(
  conversations: Array<{ id: string; title: string }>,
  activity: Record<string, { attention?: Record<string, MessageAttention> }>,
): AttentionTarget[] {
  return conversations.flatMap((conversation, index) => Object.entries(activity[conversation.id]?.attention ?? {})
    .map(([messageId, value]) => ({ ...value, conversationId: conversation.id, messageId, ...(index ? { topicTitle: conversation.title } : {}) })))
    .sort((a, b) => a.at - b.at || a.messageId.localeCompare(b.messageId) || a.conversationId.localeCompare(b.conversationId));
}
