import { type Message } from "../../src/client-protocol/index.js";
import { AGENT_BUS_STAGE_EXTRA, agentBusStageRecordSchema } from "../../src/client-protocol/agent-bus.js";
import { nativeRun } from "../../src/client-protocol/run.js";

/** A mirrored independent run record is not the ordinary chat's active reply.
 * Native foreground evidence always wins if both occur in the same message. */
export function isAgentBusRecord(message: Pick<Message, "authorType" | "blocks">): boolean {
  if (message.authorType !== "bot" || message.blocks.some(block => block.type === "card" && nativeRun(block))) return false;
  return message.blocks.some(block => block.type === "card" && agentBusStageRecordSchema.safeParse(block.extra?.[AGENT_BUS_STAGE_EXTRA]).success);
}
