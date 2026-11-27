import { memo, type ReactNode } from "react";
import { Check, Copy, Forward, LoaderCircle, MessageSquare, RotateCcw } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { Avatar } from "./Avatar.js";
import { BackgroundTaskGroup } from "./BackgroundTaskGroup.js";
import type { BackgroundTaskGroup as BackgroundTaskGroupModel } from "./background-task-groups.js";
import { ConversationMessageContent } from "./ConversationMessageContent.js";
import { HistoryExclusion } from "./ConversationHistoryDialog.js";
import { DispatchNotice } from "./DispatchTickets.js";
import { GoogleExport } from "./Content.js";
import { UserReplyStatus } from "./UserReplyStatus.js";
import type { UserReply } from "./user-reply-status.js";
import { WidgetComposeProvider } from "./widget-compose.js";
import { formatMessageTime } from "./conversation-inbox.js";
import { messageExcerpt } from "./MessageReference.js";
import { isAgentBusRecord } from "./agent-bus-record.js";
import { isTranscriptionMessage } from "../../src/client-protocol/voice-presentation.js";
import { t, type Locale } from "./i18n.js";

// Host audio transcription is not a Bot reply, so it never shows Bot typing dots.
const presence = (message: Message) =>
  message.authorType !== "bot" || isAgentBusRecord(message) || isTranscriptionMessage(message)
    ? ""
    : message.status === "streaming"
      ? " is-working"
      : message.status === "pending"
        ? " is-pending"
        : "";

export type WorkspaceMessageRowProps = {
  message: Message;
  /** Stable row identity (`messageRowKey` or background group key); survives the pending to canonical ID change. */
  rowKey: string;
  /** Set while the row is an online outbox item rendered as a normal bubble. */
  pending?: { sent: boolean; syncing: boolean };
  index: number;
  start: number;
  measureRef: (node: HTMLElement | null) => void;
  connection: HubConnection;
  locale: Locale;
  localDay: number;
  phone: boolean;
  compactTime: boolean;
  live: boolean;
  isGroup: boolean;
  archived: boolean;
  groupSending: boolean;
  retryBlocked: boolean;
  canRetryMessage: boolean;
  isTicketNoticeRow: boolean;
  copiedHere: boolean;
  focusedHere: boolean;
  focusRequest?: { conversationId: string; messageId?: string; searchQuery?: string };
  sheetExpanded?: boolean;
  deletionActive: boolean;
  deletionSelected: boolean;
  renderDeletionCheck?: (id: string) => ReactNode;
  authorLabel: string;
  botLabel?: string;
  botName?: string;
  scheduledName: string;
  original?: Message;
  referenceAuthor?: string;
  referenceAvailable: boolean;
  backgroundGroup?: BackgroundTaskGroupModel;
  userReplies?: UserReply[];
  labels: ReadonlyMap<string, string>;
  widgetOwner: string;
  widgetActive: boolean;
  widgetScope: string;
  onLocate: (conversationId: string, messageId: string) => void;
  onWidgetCompose: (message: Message, text: string) => boolean;
  onPreparePlainText: (message: Message) => void;
  onCopy: (message: Message) => void;
  onQuote: (message: Message) => void;
  onForward: (message: Message, trigger: HTMLElement) => void;
  onRetry: (message: Message) => void;
  onOpenSheet: (message: Message, trigger: HTMLElement) => void;
  onDeletionToggle: (id: string) => void;
  onDeletionClose: () => void;
};

/**
 * Memoized virtualized message row. Keeps typing in the composer, opening
 * menus, or streaming other messages from re-rendering unchanged rows.
 */
export const WorkspaceMessageRow = memo(function WorkspaceMessageRow({
  message,
  rowKey,
  pending,
  index,
  start,
  measureRef,
  connection,
  locale,
  localDay,
  phone,
  compactTime,
  live,
  isGroup,
  archived,
  groupSending,
  retryBlocked,
  canRetryMessage,
  isTicketNoticeRow,
  copiedHere,
  focusedHere,
  focusRequest,
  sheetExpanded,
  deletionActive,
  deletionSelected,
  renderDeletionCheck,
  authorLabel,
  botLabel,
  botName,
  scheduledName,
  original,
  referenceAuthor,
  referenceAvailable,
  backgroundGroup,
  userReplies,
  labels,
  widgetOwner,
  widgetActive,
  widgetScope,
  onLocate,
  onWidgetCompose,
  onPreparePlainText,
  onCopy,
  onQuote,
  onForward,
  onRetry,
  onOpenSheet,
  onDeletionToggle,
  onDeletionClose,
}: WorkspaceMessageRowProps) {
  // Invalidates memo once per calendar day so relative timestamps update across local midnight.
  void localDay;
  if (isTicketNoticeRow) {
    return (
      <article
        ref={measureRef}
        data-index={index}
        data-message-id={message.id}
        data-row-key={rowKey}
        className="message dispatch-notice-row"
        style={{ transform: `translateY(${start}px)` }}
      >
        <DispatchNotice message={message} />
      </article>
    );
  }

  const scheduled = message.groupDiscussion?.role === "input";
  const hasBackgroundGroup = !!backgroundGroup;
  // An outbox bubble is not a stored message yet: no selection, sheet, or actions.
  const selecting = !pending && deletionActive;

  return (
    <article
      ref={measureRef}
      data-index={index}
      data-message-id={message.id}
      data-row-key={rowKey}
      tabIndex={0}
      role={selecting ? "checkbox" : undefined}
      aria-checked={selecting ? deletionSelected : undefined}
      aria-label={selecting ? t("选择消息：{0}", messageExcerpt(message).slice(0, 80) || authorLabel) : undefined}
      aria-haspopup={!pending && phone && !deletionActive && !scheduled && !hasBackgroundGroup ? "dialog" : undefined}
      aria-expanded={!pending && phone && !deletionActive && !scheduled && !hasBackgroundGroup ? sheetExpanded : undefined}
      onKeyDown={(event) => {
        if (pending) return;
        if (deletionActive) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onDeletionToggle(message.id);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDeletionClose();
          }
          return;
        }
        if (
          phone &&
          !hasBackgroundGroup &&
          event.target === event.currentTarget &&
          (event.key === "Enter" || event.key === " " || event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))
        ) {
          event.preventDefault();
          event.stopPropagation();
          onOpenSheet(message, event.currentTarget);
        }
      }}
      onClick={(event) => {
        if (pending) return;
        if (deletionActive) {
          event.preventDefault();
          event.stopPropagation();
          onDeletionToggle(message.id);
          return;
        }
        if (phone && !hasBackgroundGroup && event.detail === 0 && event.target === event.currentTarget) {
          onOpenSheet(message, event.currentTarget);
        }
      }}
      className={`message ${message.authorType}${pending ? " is-pending-outbox" : ""} ${scheduled ? "is-discussion-input" : ""} ${
        selecting ? `is-selecting ${deletionSelected ? "is-selected" : ""}` : ""
      } ${focusedHere ? "focused-message" : ""}`}
      style={{ transform: `translateY(${start}px)` }}
    >
      {selecting && renderDeletionCheck?.(message.id)}
      <div className="message-selection-content" inert={selecting || undefined}>
        <div className={`message-avatar ${message.authorType}${live ? presence(message) : ""}`}>
          <Avatar kind={message.authorType === "bot" ? "bot" : "user"} id={message.authorId} name={authorLabel} size={32} />
        </div>
        <div className="message-body">
          <div className="message-meta">
            <strong>{message.botSource?.botName ?? botLabel ?? botName ?? authorLabel}</strong>
            <time>{formatMessageTime(message.createdAt, locale, compactTime)}</time>
            <HistoryExclusion message={message} />
            {pending ? (
              <span className="user-reply-status message-send-status" role="status">
                <span className={`user-reply-state${pending.sent ? " is-done" : " is-sending"}`}>
                  {pending.sent ? <Check /> : <LoaderCircle className="reply-status-spinner" />}
                  <span>{pending.sent ? t("已发送") : pending.syncing ? t("正在同步发送状态…") : t("发送中…")}</span>
                </span>
              </span>
            ) : (
              message.authorType === "user" && <UserReplyStatus replies={userReplies} group={isGroup} labels={labels} />
            )}
            {phone && (
              <span className="message-action-status" aria-live="polite">
                {copiedHere ? t("已复制") : ""}
              </span>
            )}
            {!pending && !phone && !scheduled && !hasBackgroundGroup && (
              <div className="message-actions">
                <button
                  aria-label={t("复制消息")}
                  onPointerDown={() => onPreparePlainText(message)}
                  onClick={() => onCopy(message)}
                >
                  <Copy size={13} />
                </button>
                <button
                  aria-label={t("引用回复")}
                  title={t("引用回复")}
                  disabled={groupSending || archived}
                  onClick={() => onQuote(message)}
                >
                  <MessageSquare size={13} />
                  <span>{t("引用")}</span>
                </button>
                <button
                  aria-label={t("转发消息")}
                  title={message.status === "streaming" ? t("生成完成后可转发") : t("转发消息")}
                  disabled={!["complete", "error"].includes(message.status)}
                  onClick={(event) => onForward(message, event.currentTarget)}
                >
                  <Forward size={13} />
                  <span>{t("转发")}</span>
                </button>
                <GoogleExport connection={connection} messageId={message.id} />
                {canRetryMessage && (
                  <button
                    aria-label={t("重新发送消息")}
                    disabled={retryBlocked}
                    title={retryBlocked ? t("对话已归档，恢复后可重新发送。") : t("重新发送消息")}
                    onClick={() => onRetry(message)}
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
              </div>
            )}
          </div>
          {message.botSource && (
            <div className="bot-message-source" title={`${message.botSource.hostId}/${message.botSource.botId}`}>
              <span>{t("来自 {0} · {1}", message.botSource.hostName, message.botSource.botName)}</span>
              <small>{t("转发 {0} 层", message.botSource.hops)}</small>
            </div>
          )}
          <WidgetComposeProvider owner={widgetOwner} active={widgetActive} scope={widgetScope} message={message} compose={onWidgetCompose}>
            {backgroundGroup ? (
              <BackgroundTaskGroup
                group={backgroundGroup}
                connection={connection}
                original={original}
                locate={onLocate}
                focusRequest={focusRequest}
              />
            ) : (
              <ConversationMessageContent
                focusRequest={focusRequest}
                message={message}
                original={original}
                referenceAuthor={referenceAuthor}
                referenceAvailable={referenceAvailable}
                scheduledName={scheduledName}
                connection={connection}
                locate={onLocate}
              />
            )}
          </WidgetComposeProvider>
        </div>
      </div>
    </article>
  );
});
