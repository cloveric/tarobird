import { blocksText, type Message } from "../../src/client-protocol/index.js";

export type MessageRailItem = {
  id: string;
  /** Index inside `displayedMessages` (virtualizer row index). */
  index: number;
  /** 1-based ordinal among all rail items in the conversation. */
  turnNumber: number;
  /** Single-line user prompt / trigger summary. */
  prompt: string;
  /** Optional single-line preview of the first Bot reply to this turn. */
  replyPreview?: string;
  /** Optional reply author label (populated for group chats or multi-bot replies). */
  replyAuthor?: string;
  /** Optional source label for delegated/automated turns. */
  sourceLabel?: string;
  createdAt: number;
};

export type BuildMessageRailOptions = {
  /** Fallback text when a user message contains only non-text blocks. */
  attachmentFallback?: string;
  /** Fallback text when a message has only card/interactive blocks. */
  cardFallback?: string;
  /** Resolve a Bot's display name (used in reply previews). */
  botName?: (botId: string) => string | undefined;
  /** Whether this conversation is a group chat (includes reply author in preview). */
  isGroup?: boolean;
};

const MAX_PROMPT_CHARS = 120;
const MAX_REPLY_CHARS = 120;

function collapseLine(raw: string, limit: number): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function summarizeMessage(message: Message, attachmentFallback: string, cardFallback: string): string {
  const plainText = collapseLine(
    message.blocks
      .filter((block): block is Extract<Message["blocks"][number], { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join(" "),
    MAX_PROMPT_CHARS,
  );
  if (plainText) return plainText;
  const media = message.blocks
    .filter((block): block is Extract<Message["blocks"][number], { type: "file" | "image" | "audio" }> =>
      block.type === "file" || block.type === "image" || block.type === "audio")
    .map((block) => {
      const label = block.type === "image" ? block.title : block.name;
      return typeof label === "string" ? label.trim() : "";
    })
    .filter(Boolean);
  if (media.length) return collapseLine(media.join(" · "), MAX_PROMPT_CHARS);
  if (message.blocks.some((block) => block.type === "file" || block.type === "image" || block.type === "audio")) {
    return attachmentFallback;
  }
  const fallback = collapseLine(blocksText(message.blocks), MAX_PROMPT_CHARS);
  return fallback || cardFallback;
}

/** Whether a displayed message represents a user-turn anchor on the right-edge rail.
 * Excludes deleted messages and internal group-discussion speaker handoffs. */
export function isRailAnchorMessage(message: Message): boolean {
  if (message.status === "deleted") return false;
  if (message.authorType !== "user") return false;
  if (message.groupDiscussion?.role === "input") return false;
  return true;
}

/** Build ordered message-rail entries from `displayedMessages`. */
export function buildMessageRailItems(
  displayedMessages: readonly Message[],
  options: BuildMessageRailOptions = {},
): MessageRailItem[] {
  const attachmentFallback = options.attachmentFallback ?? "[Attachment]";
  const cardFallback = options.cardFallback ?? "[Message]";
  const anchors: Array<{ message: Message; index: number }> = [];
  const replyByTarget = new Map<string, Message>();

  for (let index = 0; index < displayedMessages.length; index++) {
    const message = displayedMessages[index]!;
    if (isRailAnchorMessage(message)) {
      anchors.push({ message, index });
    } else if (message.status !== "deleted" && message.authorType === "bot" && message.replyTo && !replyByTarget.has(message.replyTo)) {
      replyByTarget.set(message.replyTo, message);
    }
  }

  return anchors.map(({ message, index }, ordinal) => {
    const nextAnchorIndex = anchors[ordinal + 1]?.index ?? displayedMessages.length;
    let reply = replyByTarget.get(message.id);
    if (!reply) {
      // Fall back to the first non-deleted Bot message before the next user turn
      // that does not explicitly reply to a different message.
      for (let cursor = index + 1; cursor < nextAnchorIndex; cursor++) {
        const candidate = displayedMessages[cursor]!;
        if (candidate.status === "deleted" || candidate.authorType !== "bot") continue;
        if (candidate.replyTo && candidate.replyTo !== message.id) continue;
        reply = candidate;
        break;
      }
    }

    const replyPreview = reply
      ? collapseLine(summarizeMessage(reply, attachmentFallback, cardFallback), MAX_REPLY_CHARS)
      : undefined;
    const replyAuthor = reply && options.isGroup
      ? (options.botName?.(reply.authorId) || reply.authorId)
      : undefined;
    const sourceLabel = message.botSource?.botName
      ? (message.botSource.hostName ? `${message.botSource.hostName} · ${message.botSource.botName}` : message.botSource.botName)
      : undefined;

    return {
      id: message.id,
      index,
      turnNumber: ordinal + 1,
      prompt: summarizeMessage(message, attachmentFallback, cardFallback),
      ...(replyPreview ? { replyPreview } : {}),
      ...(replyAuthor ? { replyAuthor } : {}),
      ...(sourceLabel ? { sourceLabel } : {}),
      createdAt: message.createdAt,
    };
  });
}

/** Evenly sample long histories down to at most `maxTicks` ticks while ALWAYS
 * preserving the first item, the last item, and the currently active item. */
export function sampleMessageRailItems(
  items: readonly MessageRailItem[],
  activeId: string | undefined,
  maxTicks = 44,
): MessageRailItem[] {
  if (maxTicks <= 0 || !items.length) return [];
  if (items.length <= maxTicks) return [...items];

  const lastIndex = items.length - 1;
  const activeIndex = activeId ? items.findIndex((item) => item.id === activeId) : -1;
  if (maxTicks === 1) return [items[activeIndex >= 0 ? activeIndex : lastIndex]!];
  if (maxTicks === 2) return [items[0]!, items[lastIndex]!];

  const picked = new Set<number>([0, lastIndex]);
  if (activeIndex >= 0) picked.add(activeIndex);

  const slots = maxTicks - picked.size;
  if (slots > 0) {
    const step = lastIndex / (maxTicks - 1);
    for (let i = 1; i < maxTicks - 1 && picked.size < maxTicks; i++) {
      const candidate = Math.round(i * step);
      if (candidate > 0 && candidate < lastIndex) picked.add(candidate);
    }
    // Fill any rounding collisions deterministically from interior indices.
    if (picked.size < maxTicks) {
      for (let candidate = 1; candidate < lastIndex && picked.size < maxTicks; candidate++) {
        picked.add(candidate);
      }
    }
  }

  return [...picked].sort((a, b) => a - b).map((idx) => items[idx]!);
}

/** Pick the active rail item for the reader's current position in `displayedMessages`.
 * When `atBottom` is true, highlights the final turn. Otherwise selects the latest
 * turn whose `index <= anchorMessageIndex` (clamped to the first turn). */
export function findActiveRailItemId(
  items: readonly MessageRailItem[],
  anchorMessageIndex: number,
  atBottom = false,
): string | undefined {
  if (!items.length) return undefined;
  if (atBottom) return items[items.length - 1]!.id;
  let active = items[0]!;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.index <= anchorMessageIndex) active = item;
    else break;
  }
  return active.id;
}

/** Compute the maximum number of ticks that fit vertically inside the rail
 * without overflowing into the conversation header or composer. */
export function railTickBudget(railHeight: number, maxTicks = 44): number {
  if (!Number.isFinite(railHeight) || railHeight < 48) return 0;
  // Dense ticks take ~6.5px + 2px gap (9px slot), with 32px total vertical padding/margin.
  return Math.max(2, Math.min(maxTicks, Math.floor((railHeight - 30) / 9)));
}

/** Whether ticks should switch to compact spacing to fit cleanly inside `railHeight`. */
export function isRailDense(visibleCount: number, railHeight?: number): boolean {
  if (visibleCount >= 24) return true;
  if (railHeight === undefined || !Number.isFinite(railHeight)) return false;
  // Normal ticks take ~8.5px + 5px gap (14px slot) inside `railHeight - 32` px.
  return visibleCount * 14 - 5 > Math.max(0, railHeight - 32);
}

/** Clamp a vertically centered preview popover's `top` coordinate so both edges
 * stay inside `[edgePadding, railHeight - edgePadding]` (or centered if taller). */
export function clampPreviewCenter(
  anchorY: number,
  railHeight: number,
  halfHeight: number,
  edgePadding = 4,
): number {
  if (!Number.isFinite(railHeight) || railHeight <= 0) return Math.max(0, anchorY);
  const margin = Math.max(0, halfHeight) + Math.max(0, edgePadding);
  if (margin * 2 >= railHeight) return railHeight / 2;
  return Math.max(margin, Math.min(railHeight - margin, anchorY));
}

/** Normalize `WheelEvent.deltaY` to CSS pixels across pixel/line/page delta modes. */
export function normalizeWheelDeltaY(
  deltaY: number,
  deltaMode: number,
  lineHeightPx = 24,
  pageHeightPx = 400,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  if (deltaMode === 1) return deltaY * (lineHeightPx > 0 ? lineHeightPx : 24);
  if (deltaMode === 2) return deltaY * (pageHeightPx > 0 ? pageHeightPx : 400);
  return deltaY;
}

export type RailScrollAnchor = {
  index: number;
  atBottom: boolean;
};

/** Resolve the active displayed-message index and bottom state from scroll geometry
 * and currently virtualized items. Guards both `atTop` and `atBottom`, subtracts
 * the virtual list's top offset (`origin`), and interpolates the viewport probe
 * smoothly near the top and bottom edges while staying centered mid-thread. */
export function resolveRailScrollAnchor(params: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  shift: number;
  origin: number;
  messageCount: number;
  virtualItems: ReadonlyArray<{ index: number; start: number }>;
}): RailScrollAnchor {
  const { scrollTop, scrollHeight, clientHeight, shift, origin, messageCount, virtualItems } = params;
  if (messageCount <= 0) return { index: 0, atBottom: true };

  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const canScroll = maxScroll > 2;
  if (!canScroll) return { index: messageCount - 1, atBottom: true };

  const clampedScrollTop = Math.min(maxScroll, Math.max(0, scrollTop));
  const distFromBottom = maxScroll - clampedScrollTop;
  const edge = Math.min(8, Math.max(1, maxScroll / 3));

  if (distFromBottom <= edge) return { index: messageCount - 1, atBottom: true };
  if (clampedScrollTop <= edge) return { index: 0, atBottom: false };

  const half = clientHeight * 0.48;
  const probeOffset = maxScroll < clientHeight
    ? (clampedScrollTop / maxScroll) * clientHeight
    : clampedScrollTop < half
      ? clampedScrollTop
      : distFromBottom < clientHeight - half
        ? clientHeight - distFromBottom
        : half;
  const probe = clampedScrollTop + shift + probeOffset - origin;

  let index = 0;
  if (virtualItems.length) {
    index = virtualItems[0]!.index;
    for (const item of virtualItems) {
      if (item.start <= probe) index = item.index;
      else break;
    }
  }
  return { index, atBottom: false };
}
