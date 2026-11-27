import { blocksText, type Message } from "../../src/client-protocol/index.js";
import type { PromptQueueSnapshot } from "../../src/client-protocol/prompt-queue.js";
import { isAgentBusRecord } from "./agent-bus-record.js";
import { queueRequest } from "./prompt-queue-request.js";

export type PromptQueueItem = PromptQueueSnapshot["items"][number];

export interface ScopedPromptQueueState {
  scope: string;
  snapshot: PromptQueueSnapshot;
}

export interface ReplyingEntry {
  key: string;
  botId: string;
  botName: string;
  text: string;
  /** When this reply or handed-over message began, for the rail's "working for …" note. */
  startedAt?: number;
}

export const WORKSPACE_QUEUE_POLL_MS = 2_000;
export const WORKSPACE_QUEUE_POLL_MAX_MS = 16_000;
export const WORKSPACE_QUEUE_TIMEOUT_MS = 10_000;

export function previewWorkspaceMessage(message: Message | undefined, attachmentLabel: string): string {
  if (!message || message.status === "deleted" || message.groupDiscussion?.role === "input") return "";
  const text = blocksText(message.blocks).replace(/\s+/g, " ").trim();
  if (text) return text;
  if (message.blocks.some(block => ["file", "image", "audio"].includes(block.type))) return attachmentLabel;
  return "";
}

export function scopePromptQueue(
  state: ScopedPromptQueueState | undefined,
  scope: string,
  conversationId: string,
  directBotId: string | undefined,
): PromptQueueSnapshot | undefined {
  if (!directBotId || !scope || !state || state.scope !== scope) return undefined;
  if (state.snapshot.conversationId !== conversationId || state.snapshot.botId !== directBotId) return undefined;
  return state.snapshot;
}

export function buildReplyingEntries({
  messages,
  conversationId,
  online,
  directBotId,
  dispatchedItems,
  streamingBots,
  resolveBotName,
  attachmentLabel,
}: {
  messages: readonly Message[];
  conversationId: string;
  online: boolean;
  directBotId: string | undefined;
  dispatchedItems: readonly PromptQueueItem[];
  streamingBots: readonly string[];
  resolveBotName: (botId: string) => string;
  attachmentLabel: string;
}): ReplyingEntry[] {
  if (!online) return [];

  const byId = new Map<string, Message>();
  const activeByBot = new Map<string, Message>();
  for (const msg of messages) {
    if (msg.conversationId !== conversationId) continue;
    if (msg.status !== "deleted") byId.set(msg.id, msg);
    if (
      msg.authorType !== "bot" ||
      msg.forwardedFrom ||
      isAgentBusRecord(msg) ||
      msg.status !== "streaming"
    ) continue;
    activeByBot.set(msg.authorId, msg);
  }

  const entries: ReplyingEntry[] = [];
  const coveredBots = new Set<string>();
  const coveredMessages = new Set<string>();

  for (const [botId, reply] of activeByBot) {
    const rawSource = reply.replyTo ? byId.get(reply.replyTo) : undefined;
    // Group discussion turns publish synthetic Chinese scheduler inputs whose replyTo
    // points at the user's topic message; unwrap to the topic and never preview the input text.
    const source = rawSource?.groupDiscussion?.role === "input"
      ? (rawSource.replyTo ? byId.get(rawSource.replyTo) : undefined)
      : rawSource;
    let text = previewWorkspaceMessage(source, attachmentLabel);
    let sourceId = reply.replyTo ?? source?.id;
    if (!text && directBotId === botId) {
      // Preserve explicit reply ownership: only match the exact replyTo message when set,
      // and fall back to dispatchedItems[0] only when the streaming reply carries no replyTo.
      const matchedDispatched = reply.replyTo
        ? dispatchedItems.find(item => item.message.id === reply.replyTo)
        : dispatchedItems[0];
      if (matchedDispatched) {
        text = previewWorkspaceMessage(matchedDispatched.message, attachmentLabel);
        sourceId = matchedDispatched.message.id;
      }
    }
    coveredBots.add(botId);
    if (sourceId) coveredMessages.add(sourceId);
    entries.push({ key: `reply:${botId}:${reply.id}`, botId, botName: resolveBotName(botId), text, startedAt: reply.createdAt });
  }

  if (directBotId) {
    for (const item of dispatchedItems) {
      if (coveredBots.has(directBotId) || coveredMessages.has(item.message.id)) continue;
      coveredBots.add(directBotId);
      coveredMessages.add(item.message.id);
      entries.push({
        key: `dispatched:${item.message.id}`,
        botId: directBotId,
        botName: resolveBotName(directBotId),
        text: previewWorkspaceMessage(item.message, attachmentLabel),
        startedAt: item.message.createdAt,
      });
    }
  }

  if (entries.length === 0 && streamingBots.length > 0) {
    for (const name of streamingBots) {
      entries.push({ key: `streaming:${name}`, botId: name, botName: name, text: "" });
    }
  }

  return entries;
}

export interface WorkspaceQueueReader {
  trigger(): void;
  setPolling(enabled: boolean): void;
  onVisibilityChange(): void;
  dispose(): void;
}

export interface WorkspaceQueueReaderOptions<T> {
  fetch: (signal: AbortSignal) => Promise<T>;
  onSnapshot: (snapshot: T) => void;
  timeoutMs?: number;
  pollMs?: number;
  maxPollMs?: number;
  isVisible?: () => boolean;
}

/** Single-in-flight serialized queue reader with bounded per-request timeout,
 * monotonic ordering, visibility gating, and decoupled polling. */
export function createWorkspaceQueueReader<T>({
  fetch,
  onSnapshot,
  timeoutMs = WORKSPACE_QUEUE_TIMEOUT_MS,
  pollMs = WORKSPACE_QUEUE_POLL_MS,
  maxPollMs = WORKSPACE_QUEUE_POLL_MAX_MS,
  isVisible = () => typeof document === "undefined" || document.visibilityState === "visible",
}: WorkspaceQueueReaderOptions<T>): WorkspaceQueueReader {
  const lifetime = new AbortController();
  let disposed = false;
  let inFlight = false;
  let followUp = false;
  let polling = false;
  let delay = pollMs;
  let version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    if (disposed || !polling || inFlight) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void pollTick();
    }, delay);
  };

  const runRead = async (): Promise<boolean> => {
    if (disposed || inFlight) return true;
    inFlight = true;
    clearTimer();
    let ok = true;
    try {
      do {
        followUp = false;
        const seq = ++version;
        const req = queueRequest([lifetime.signal], timeoutMs);
        try {
          const snapshot = await req.wait(fetch(req.signal));
          if (!disposed && !lifetime.signal.aborted && seq === version) {
            onSnapshot(snapshot);
            ok = true;
          }
        } catch {
          ok = false;
        } finally {
          req.dispose();
        }
      } while (followUp && !disposed && !lifetime.signal.aborted);
    } finally {
      inFlight = false;
      if (!disposed && polling) {
        delay = ok ? pollMs : Math.min(delay * 2, maxPollMs);
        schedule();
      }
    }
    return ok;
  };

  const pollTick = async () => {
    if (disposed || !polling || inFlight) return;
    if (!isVisible()) {
      delay = pollMs;
      schedule();
      return;
    }
    await runRead();
  };

  return {
    trigger() {
      if (disposed) return;
      delay = pollMs;
      if (inFlight) {
        followUp = true;
        return;
      }
      void runRead();
    },
    setPolling(enabled: boolean) {
      if (disposed || polling === enabled) return;
      polling = enabled;
      if (enabled) {
        delay = pollMs;
        schedule();
      } else {
        clearTimer();
      }
    },
    onVisibilityChange() {
      if (disposed || !polling || inFlight || !isVisible()) return;
      delay = pollMs;
      clearTimer();
      void runRead();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      polling = false;
      followUp = false;
      ++version;
      clearTimer();
      lifetime.abort();
    },
  };
}
