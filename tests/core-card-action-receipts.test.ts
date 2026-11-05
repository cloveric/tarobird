import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handleCoreCardAction } from "../src/core/card-actions.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";

describe("core card-action receipts", () => {
  it("records a stop card-action receipt in the timeline (the 108002 diagnosability gap)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-stop-receipt-"));
    const channel = {
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      stream: vi.fn(async () => ({ messageId: "stream_1" })),
      updateCard: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };

    try {
      await handleCoreCardAction({
        channel,
        runtime: createCoreServiceRuntime(),
        stateDir,
        event: {
          messageId: "om_stop_tap",
          chatId: "oc_group",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "stop",
              conversationKey: "lark:oc_group:omt_topic",
              bridgeChatType: "group",
              replyInThread: true,
            },
          },
        },
      });

      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.event",
        channel: "lark",
        conversationKey: "lark:oc_group:omt_topic",
        outcome: "received",
        detail: "stop_button",
        metadata: expect.objectContaining({
          source: "card_action",
          action: "stop",
          larkMessageId: "om_stop_tap",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
