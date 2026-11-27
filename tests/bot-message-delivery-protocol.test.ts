import { describe, expect, it } from "vitest";
import {
  BOT_MESSAGE_STEER_CAPABILITY, BOT_MESSAGE_STEER_ENGINES, botMessageCapabilitiesSchema, botMessageDeliveryReceiptSchema,
  botMessageDeliverySchema, botMessageSendSchema, supportsBotMessageSteerEngine,
} from "../src/client-protocol/bot-message-delivery.js";
import { botSteerCallSchema, botSteerStatusCallSchema, botSteerStatusSchema } from "../src/client-protocol/steering.js";

describe("bot-message delivery protocol (#62)", () => {
  it("keeps a send without delivery exactly the legacy body and rejects unknown fields", () => {
    expect(botMessageSendSchema.parse({ text: "Task" })).toEqual({ text: "Task", attachments: [] });
    expect(botMessageSendSchema.parse({ text: "Task", attachments: ["att_1"] })).toEqual({ text: "Task", attachments: ["att_1"] });
    expect(() => botMessageSendSchema.parse({ text: "Task", mode: "steer" })).toThrow();
    expect(() => botMessageSendSchema.parse({ text: "Task", delivery: "interrupt" })).toThrow();
  });

  it("accepts only queue or steer as the requested delivery", () => {
    expect(botMessageSendSchema.parse({ text: "Fix", delivery: "steer" })).toEqual({ text: "Fix", attachments: [], delivery: "steer" });
    expect(botMessageDeliverySchema.options).toEqual(["queue", "steer"]);
  });

  it("opens steering only to Codex, Claude Code, and omp", () => {
    expect(BOT_MESSAGE_STEER_ENGINES).toEqual(["codex", "claude", "omp"]);
    for (const engine of ["codex", "claude", "omp"]) expect(supportsBotMessageSteerEngine(engine)).toBe(true);
    for (const engine of ["pi", "kimi", "deepseek", "antigravity", ""]) expect(supportsBotMessageSteerEngine(engine)).toBe(false);
    expect(BOT_MESSAGE_STEER_CAPABILITY).toBe("bot-messages.steer.v1");
  });

  it("describes the actual delivery with reason and merged turn", () => {
    expect(botMessageDeliveryReceiptSchema.parse({ requested: "steer", actual: "steered", turn: { messageId: "msg_turn" } })).toEqual({ requested: "steer", actual: "steered", turn: { messageId: "msg_turn" } });
    expect(botMessageDeliveryReceiptSchema.parse({ requested: "steer", actual: "fell_back_to_queue", reason: "no_active_turn" }).reason).toBe("no_active_turn");
    expect(botMessageDeliveryReceiptSchema.parse({ requested: "steer", actual: "steer_uncertain", turn: { messageId: "msg_turn" } }).actual).toBe("steer_uncertain");
    expect(() => botMessageDeliveryReceiptSchema.parse({ requested: "steer", actual: "maybe" })).toThrow();
    expect(() => botMessageDeliveryReceiptSchema.parse({ requested: "steer", actual: "queued", reason: "Not a code" })).toThrow();
  });

  it("advertises receiving-host delivery support in a strict capability reply", () => {
    expect(botMessageCapabilitiesSchema.parse({ hostId: "hub_abc", deliveries: ["queue", "steer"] }).deliveries).toEqual(["queue", "steer"]);
    expect(() => botMessageCapabilitiesSchema.parse({ hostId: "hub_abc", deliveries: [] })).toThrow();
  });

  it("binds a Gateway steer to one conversation, run token, run source and signed origin", () => {
    expect(botSteerStatusCallSchema.parse({ conversationId: "conv_1" })).toEqual({ conversationId: "conv_1" });
    expect(() => botSteerStatusCallSchema.parse({ conversationId: "conv_1", backgroundReview: true })).toThrow();
    expect(botSteerStatusSchema.parse({ supported: true, targetId: "run_1", sourceMessageId: "msg_turn" }).sourceMessageId).toBe("msg_turn");
    expect(botSteerStatusSchema.parse({ supported: true, reason: "no_active_turn" }).reason).toBe("no_active_turn");
    const source = { hostId: "hub_a", hostName: "Mac", botId: "coordinator", botName: "Coordinator", requestId: "req_1", hops: 1 };
    const call = { conversationId: "conv_1", userId: "owner", requestId: "bm_1", targetId: "run_1", sourceMessageId: "msg_turn", text: "Use the staging DB", source };
    expect(botSteerCallSchema.parse(call)).toEqual(call);
    expect(() => botSteerCallSchema.parse({ ...call, mode: "message" })).toThrow();
    expect(() => botSteerCallSchema.parse({ ...call, text: "   " })).toThrow();
  });
});
