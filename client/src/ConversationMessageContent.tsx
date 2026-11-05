import { memo } from "react";
import type { Message } from "../../src/client-protocol/index.js";
import { backgroundTaskNotice } from "../../src/client-protocol/background-task.js";
import type { HubConnection } from "./connection.js";
import { MessageReference } from "./MessageReference.js";
import { BotReplySource } from "./BotReplySource.js";
import { GroupDiscussionInput } from "./GroupDiscussionInput.js";
import { MessageContent } from "./Content.js";
import { useLocale } from "./i18n.js";

/** Construct references inside the memo boundary. An inline React element or
 * backgroundSource object from Workspace otherwise defeats MessageContent's
 * memo on every unrelated stream event and every virtual-scroll render. */
export const ConversationMessageContent = memo(function ConversationMessageContent({ message, original, referenceAuthor, referenceAvailable, scheduledName, connection, locate }: {
  message: Message; original?: Message; referenceAuthor?: string; referenceAvailable: boolean; scheduledName: string;
  connection: HubConnection; locate: (conversationId: string, messageId: string) => void;
}) {
  useLocale();
  const scheduled = message.groupDiscussion?.role === "input";
  const inline = !scheduled && message.authorType === "user" && !!(message.replyTo || message.forwardedFrom);
  const bound = message.authorType === "bot" && message.blocks.some(block => block.type === "card" && backgroundTaskNotice(block)?.origin === "bound");
  const openReply = () => locate(message.conversationId, message.replyTo!);
  const reference = !scheduled && (message.forwardedFrom || message.authorType === "user" && message.replyTo)
    ? <MessageReference connection={connection} message={message} original={original} author={referenceAuthor} available={referenceAvailable}
      open={() => locate(message.forwardedFrom?.conversationId ?? message.conversationId, message.forwardedFrom?.messageId ?? message.replyTo!)}/>
    : undefined;
  return <>
    {!inline && reference}
    {message.authorType === "bot" && message.replyTo && original?.groupDiscussion?.role !== "input" && !message.forwardedFrom && !bound
      && <BotReplySource message={message} original={original} open={openReply}/>}
    {scheduled ? <GroupDiscussionInput message={message} name={scheduledName}/>
      : <MessageContent message={message} connection={connection} reference={inline ? reference : undefined}
        backgroundSource={bound && message.replyTo ? { original, open: openReply } : undefined}/>}
  </>;
});
