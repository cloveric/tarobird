import { z } from "zod";
import { idSchema, textSchema } from "./index.js";
import { networkCanonical } from "./private-network.js";

/** Gateway capability (issue #62): this worker can merge a signed Bot message
 * into the live turn of the same conversation. Advertised only by Codex and
 * Claude Code workers; every other worker keeps queueing Bot messages. */
export const BOT_MESSAGE_STEER_CAPABILITY = "bot-messages.steer.v1";
/** Engines whose adapters natively append input to a running turn. Others
 * (Pi, Kimi, DeepSeek, Antigravity…) never steer a Bot message, even when
 * their adapter has an owner-only steering path. */
export const BOT_MESSAGE_STEER_ENGINES = ["codex", "claude", "omp"] as const;
export const supportsBotMessageSteerEngine = (engine: string): boolean => (BOT_MESSAGE_STEER_ENGINES as readonly string[]).includes(engine);

/** The sender's choice for one message. Omitted on the wire means queue and
 * keeps the legacy request bytes; CLI `--delivery queue` therefore omits it. */
export const botMessageDeliverySchema = z.enum(["queue", "steer"]);
export type BotMessageDelivery = z.infer<typeof botMessageDeliverySchema>;
/** Body of `/api/bot-messages/send`. `delivery` is a preference, not content:
 * it never enters the request-ID content digest on either Hub. */
export const botMessageSendSchema = z.object({ text: textSchema, attachments: z.array(idSchema).max(50).default([]), delivery: botMessageDeliverySchema.optional() }).strict();

/** Why a steer request was queued instead (fell_back_to_queue). */
export const BOT_STEER_FALLBACK_REASONS = [
  "steering_disabled", "unsupported_engine", "unsupported_conversation", "attachments_unsupported", "bot_offline", "worker_update_required",
  "receiver_update_required", "status_unavailable", "no_active_turn", "background_review", "turn_not_from_sender", "pending_card",
  "turn_steer_limit", "steer_rate_limited", "turn_ended", "engine_not_ready", "session_busy", "session_changed", "blank_text", "self_target",
] as const;
export type BotSteerFallbackReason = typeof BOT_STEER_FALLBACK_REASONS[number];
/** Map a Gateway pre-admission rejection to the sender-visible reason. */
export function botSteerRejectionReason(reason: string | undefined): BotSteerFallbackReason {
  return reason === "queued" ? "session_busy" : reason === "binding_changed" ? "session_changed" : reason === "unsupported" ? "unsupported_engine"
    : reason === "idle" ? "no_active_turn" : reason === "not_ready" ? "engine_not_ready" : "turn_ended";
}

/** Returned only when the request carried `delivery`; legacy receipts are unchanged.
 * `actual` is what happened, not what was asked:
 * - steered: merged into `turn` (the input message of the recipient's live turn);
 * - queued / fell_back_to_queue: a normal queued Bot message, exactly once;
 * - steer_uncertain: the engine may have taken it; never queued again;
 * - pending: no final outcome yet (reason steer_in_flight or steer_unconfirmed);
 * - not_delivered: never merged and never queued, e.g. the source's grant was
 *   revoked before a recorded refusal could be queued on worker attach. */
export const botMessageDeliveryReceiptSchema = z.object({
  requested: botMessageDeliverySchema,
  actual: z.enum(["queued", "steered", "fell_back_to_queue", "steer_uncertain", "pending", "not_delivered"]),
  reason: z.string().regex(/^[a-z_]{1,64}$/).optional(),
  turn: z.object({ messageId: idSchema }).strict().optional(),
  dropped: z.enum(["stopped", "turn_failed", "not_started", "engine_exit"]).optional(),
}).strict();
export type BotMessageDeliveryReceipt = z.infer<typeof botMessageDeliveryReceiptSchema>;

/** Signed reply of `/api/bot-messages/capabilities` on a receiving Host. An
 * older Host refuses the unknown route before any write; the sender then
 * queues and reports `receiver_update_required`. */
export const botMessageCapabilitiesSchema = z.object({ hostId: idSchema, deliveries: z.array(botMessageDeliverySchema).min(1).max(8) }).strict();

/** Receiving owner's switch "allow other Bots to steer this Bot" (default on).
 * Changed only with the owner's one-use device proof (operation
 * `bot-message-grant`, the same control right as message grants). */
export const botMessageSteeringCommandSchema = z.object({ botId: idSchema, allowed: z.boolean() }).strict();
export type BotMessageSteeringCommand = z.infer<typeof botMessageSteeringCommandSchema>;
/** `supported` is false for engines that never steer; Apps hide the switch then. */
export const botMessageSteeringSnapshotSchema = z.object({ botId: idSchema, allowed: z.boolean(), supported: z.boolean() }).strict();
export type BotMessageSteeringSnapshot = z.infer<typeof botMessageSteeringSnapshotSchema>;
/** Signed device-action target bytes (SHA-256 hex on both sides). The scope
 * keeps a grant-edit proof from ever matching a steering change. */
export const botMessageSteeringProofPayload = (command: BotMessageSteeringCommand): string => networkCanonical({ scope: "bot-message-steering", botId: command.botId, allowed: command.allowed });
