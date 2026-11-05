import path from "node:path";
import { readFile, open } from "node:fs/promises";
import { DEFAULT_ROTATE_OPTIONS } from "../state/log-rotation.js";
import { parseTimelineEvents, resolveTimelineLogPath, type TimelineEvent } from "../state/timeline-log.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
export const ROTATED_LOG_TAIL_DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function rotationCandidatesOldestFirst(filePath: string): string[] {
  return [
    ...Array.from({ length: DEFAULT_ROTATE_OPTIONS.keepCount }, (_value, index) =>
      `${filePath}.${DEFAULT_ROTATE_OPTIONS.keepCount - index}`),
    filePath,
  ];
}

/**
 * Read a rotated structured log (`<path>` plus `<path>.1`…`<path>.N`)
 * oldest-first. Returns null when no file exists yet. Shared by the Lark
 * timeline reader and by the CLI's `timeline` / `audit` readers, which
 * otherwise showed "(empty)" right after a rotation while tens of MB sat in the
 * retained files.
 */
export async function readRotatedLogFile(filePath: string): Promise<string | null> {
  const rawParts: string[] = [];
  for (const candidate of rotationCandidatesOldestFirst(filePath)) {
    const content = await readFileOrNull(candidate);
    if (content !== null) {
      rawParts.push(content);
    }
  }
  return rawParts.length > 0 ? rawParts.join("\n") : null;
}

/**
 * Bounded variant of {@link readRotatedLogFile}: walks the rotations
 * NEWEST-first and stops as soon as `maxBytes` is covered (or, with
 * `sinceMs`, as soon as the accumulated files reach back past that instant).
 * Still returns the text oldest-first so parsers see chronological order.
 *
 * Callers that only care about recent activity (the restart guard's in-flight
 * turns, boot recovery) must use this: the unbounded reader parsed all
 * retained rotations — 62 MB / ~165k events on a busy instance — to answer a
 * question about the last few hours.
 */
export async function readRotatedLogFileTail(filePath: string, options: {
  maxBytes?: number;
  sinceMs?: number;
  /**
   * Minimum number of existing files to read before any stop rule applies.
   * Defaults to 2 (current + newest rotation) so a turn whose start rotated out
   * is still paired with its terminal event — the whole reason the unbounded
   * reader existed.
   */
  minFiles?: number;
} = {}): Promise<string | null> {
  const maxBytes = options.maxBytes ?? ROTATED_LOG_TAIL_DEFAULT_MAX_BYTES;
  const minFiles = options.minFiles ?? 2;
  const newestFirst = [...rotationCandidatesOldestFirst(filePath)].reverse();
  const parts: string[] = [];
  let bytes = 0;
  for (const candidate of newestFirst) {
    const content = await readFileOrNull(candidate);
    if (content === null) {
      continue;
    }
    parts.push(content);
    bytes += Buffer.byteLength(content, "utf8");
    if (parts.length < minFiles) {
      continue;
    }
    // Coverage BEFORE budget: stopping on bytes first meant a busy instance could
    // return a window shorter than `sinceMs`, so a long turn whose start record
    // had rotated into .2+ looked idle and `restart --all` killed it mid-run.
    // The byte budget only applies once the caller's window is actually covered
    // (or when no window was requested).
    if (options.sinceMs !== undefined) {
      if (reachesBack(content, options.sinceMs)) {
        break;
      }
      continue;
    }
    if (bytes >= maxBytes) {
      break;
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.reverse().join("\n");
}

/** True when this log chunk's earliest event is at or before `sinceMs`. */
function reachesBack(content: string, sinceMs: number): boolean {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { timestamp?: unknown };
      if (typeof parsed.timestamp === "string") {
        const parsedMs = new Date(parsed.timestamp).getTime();
        return Number.isFinite(parsedMs) && parsedMs <= sinceMs;
      }
    } catch {
      // Not a parsable event line — keep looking.
    }
    return false;
  }
  return false;
}

/**
 * Read the instance timeline including retained rotations, oldest-first
 * (`.5` → `.1` → current). A turn accepted just before a 10 MB rotation has its
 * input.received in a rotated file while its terminal event (if any) lands in
 * the current file, so any pairing pass must see the concatenation. Returns
 * null when no timeline file exists yet. Shared with the CLI restart guard.
 */
export async function readCoreTimelineLogWithRotations(stateDir: string): Promise<string | null> {
  return await readRotatedLogFile(resolveTimelineLogPath(stateDir));
}

/**
 * Recent-window variant used by boot recovery and the CLI restart guard: both
 * only need to pair turns that are still plausibly in flight.
 */
export async function readCoreTimelineLogTail(stateDir: string, options: {
  maxBytes?: number;
  sinceMs?: number;
} = {}): Promise<string | null> {
  return await readRotatedLogFileTail(resolveTimelineLogPath(stateDir), options);
}

/** How far back boot recovery / the restart guard look for unpaired turns. */
export const CORE_PENDING_TURN_LOOKBACK_MS = 6 * 60 * 60_000;

export async function recoverInterruptedCoreTurns(stateDir: string, instanceName: string): Promise<number> {
  const raw = await readCoreTimelineLogTail(stateDir, {
    sinceMs: Date.now() - CORE_PENDING_TURN_LOOKBACK_MS,
  });
  if (raw === null) {
    return 0;
  }

  const pendingByConversationKey = new Map<string, TimelineEvent[]>();
  const terminalMessageIds = new Set<string>();
  const events = parseTimelineEvents(raw);
  for (const event of events) {
    if (event.channel !== "lark" && event.channel !== "gateway") {
      continue;
    }

    const messageId = getTimelineCoreMessageId(event);
    if (event.type === "input.received" && messageId) {
      const conversationKey = event.conversationKey ?? "";
      const pending = pendingByConversationKey.get(conversationKey) ?? [];
      pending.push(event);
      pendingByConversationKey.set(conversationKey, pending);
      continue;
    }

    if (!isCoreTerminalTimelineEvent(event)) {
      continue;
    }

    if (messageId) {
      terminalMessageIds.add(messageId);
      removePendingCoreTimelineEvent(pendingByConversationKey, event.conversationKey, messageId);
      continue;
    }

    // Older command timeline events did not include larkMessageId. They still
    // complete the oldest pending input in the same conversation.
    const pending = pendingByConversationKey.get(event.conversationKey ?? "");
    const matched = pending?.shift();
    const matchedMessageId = matched ? getTimelineCoreMessageId(matched) : undefined;
    if (matchedMessageId) {
      terminalMessageIds.add(matchedMessageId);
    }
    if (pending && pending.length === 0) {
      pendingByConversationKey.delete(event.conversationKey ?? "");
    }
  }

  let recovered = 0;
  const recoveredMessageIds = new Set<string>();
  const interruptedInputs = [...pendingByConversationKey.values()].flat();
  for (const event of interruptedInputs) {
    const messageId = getTimelineCoreMessageId(event);
    if (!messageId || terminalMessageIds.has(messageId) || recoveredMessageIds.has(messageId)) {
      continue;
    }
    recoveredMessageIds.add(messageId);
    recovered += 1;
    await appendTimelineEventBestEffort(stateDir, {
      type: "turn.completed",
      instanceName,
      channel: event.channel,
      chatId: event.chatId,
      userId: event.userId,
      conversationKey: event.conversationKey,
      outcome: "interrupted",
      detail: "service restarted before accepted turn reached a terminal state",
      metadata: {
        ...copyCoreTimelineMetadata(event.metadata),
        phase: "startup-recovery",
        acceptedAt: event.timestamp,
      },
    }, "Lark interrupted turn recovery timeline event");
  }
  return recovered;
}

function isCoreTerminalTimelineEvent(event: TimelineEvent): boolean {
  return event.type === "turn.completed" || event.type === "command.handled";
}

function removePendingCoreTimelineEvent(
  pendingByConversationKey: Map<string, TimelineEvent[]>,
  conversationKey: string | undefined,
  messageId: string,
): void {
  const key = conversationKey ?? "";
  const pending = pendingByConversationKey.get(key);
  if (!pending) {
    return;
  }
  const index = pending.findIndex((event) => getTimelineCoreMessageId(event) === messageId);
  if (index >= 0) {
    pending.splice(index, 1);
  }
  if (pending.length === 0) {
    pendingByConversationKey.delete(key);
  }
}

function getTimelineCoreMessageId(event: TimelineEvent): string | undefined {
  const value = event.metadata?.larkMessageId ?? event.metadata?.messageId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function copyCoreTimelineMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["sourceChatId", "larkChatId", "larkMessageId", "bridgeChatType", "messageId", "attachments"]) {
    const value = metadata?.[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
