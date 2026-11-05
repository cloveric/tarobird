import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readCoreTimelineLogWithRotations, recoverInterruptedCoreTurns } from "../src/core/recovery.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";

describe("readCoreTimelineLogWithRotations", () => {
  it("returns null when no timeline file exists and concatenates rotations oldest-first", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-timeline-rotations-"));

    try {
      await expect(readCoreTimelineLogWithRotations(stateDir)).resolves.toBeNull();

      await writeFile(path.join(stateDir, "timeline.log.jsonl.2"), "oldest\n", "utf8");
      await writeFile(path.join(stateDir, "timeline.log.jsonl.1"), "older\n", "utf8");
      await writeFile(path.join(stateDir, "timeline.log.jsonl"), "current\n", "utf8");

      const raw = await readCoreTimelineLogWithRotations(stateDir);
      expect(raw).not.toBeNull();
      const oldestIndex = raw!.indexOf("oldest");
      const olderIndex = raw!.indexOf("older\n");
      const currentIndex = raw!.indexOf("current");
      expect(oldestIndex).toBeGreaterThanOrEqual(0);
      expect(olderIndex).toBeGreaterThan(oldestIndex);
      expect(currentIndex).toBeGreaterThan(olderIndex);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("startup recovery across rotated timelines", () => {
  it("recovers an unmatched input.received that rotated out of the current timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-recover-rotated-"));

    try {
      // Both turns were accepted before the 10 MB rotation; only om_done got its
      // terminal event, which landed in the NEW current file after rotation.
      await writeFile(path.join(stateDir, "timeline.log.jsonl.1"), `${JSON.stringify({
        timestamp: "2026-07-01T09:00:00.000Z",
        type: "input.received",
        channel: "lark",
        chatId: 1085422826,
        userId: 1159253041,
        conversationKey: "lark:oc_chat",
        outcome: "accepted",
        metadata: {
          larkChatId: "oc_chat",
          larkMessageId: "om_done",
          bridgeChatType: "private",
          attachments: 0,
        },
      })}\n${JSON.stringify({
        timestamp: "2026-07-01T09:00:05.000Z",
        type: "input.received",
        channel: "lark",
        chatId: 1085422826,
        userId: 1159253041,
        conversationKey: "lark:oc_chat",
        outcome: "accepted",
        metadata: {
          larkChatId: "oc_chat",
          larkMessageId: "om_orphan",
          bridgeChatType: "private",
          attachments: 0,
        },
      })}\n`, "utf8");
      await writeFile(path.join(stateDir, "timeline.log.jsonl"), `${JSON.stringify({
        timestamp: "2026-07-01T09:01:00.000Z",
        type: "turn.completed",
        channel: "lark",
        chatId: 1085422826,
        userId: 1159253041,
        conversationKey: "lark:oc_chat",
        outcome: "success",
        metadata: {
          larkMessageId: "om_done",
        },
      })}\n`, "utf8");

      await expect(recoverInterruptedCoreTurns(stateDir, "fixture")).resolves.toBe(1);

      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        channel: "lark",
        conversationKey: "lark:oc_chat",
        outcome: "interrupted",
        detail: "service restarted before accepted turn reached a terminal state",
        metadata: expect.objectContaining({
          larkMessageId: "om_orphan",
          phase: "startup-recovery",
          acceptedAt: "2026-07-01T09:00:05.000Z",
        }),
      }));
      // The turn whose start rotated out but whose terminal event exists in the
      // current file must pair across files instead of being falsely recovered.
      expect(timeline).not.toContainEqual(expect.objectContaining({
        type: "turn.completed",
        outcome: "interrupted",
        metadata: expect.objectContaining({
          larkMessageId: "om_done",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
