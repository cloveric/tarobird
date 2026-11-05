import { defaultCoreToolRegistry, type CoreToolRegistry } from "./tool-registry.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import type {
  ExecuteCoreToolInput,
  CoreToolResult,
} from "./tool-types.js";

export type {
  ExecuteCoreToolInput,
  CoreToolContext,
  CoreToolDefinition,
  CoreToolResult,
} from "./tool-types.js";

export async function executeCoreTool(
  input: ExecuteCoreToolInput,
  registry: CoreToolRegistry = defaultCoreToolRegistry,
): Promise<CoreToolResult> {
  try {
    const result = await registry.execute(input);
    await appendTimelineEventBestEffort(input.context.stateDir, {
      type: "tool.executed",
      instanceName: input.context.instanceName,
      channel: input.context.channel ?? "telegram",
      chatId: input.context.chatId,
      userId: input.context.userId,
      updateId: input.context.updateId,
      outcome: result.status ?? (result.ok ? "accepted" : "rejected"),
      detail: result.error,
      metadata: {
        toolName: input.name,
        status: result.status ?? (result.ok ? "accepted" : "rejected"),
        ok: result.ok,
      },
    }, "tool execution timeline event");
    return result;
  } catch (error) {
    await appendTimelineEventBestEffort(input.context.stateDir, {
      type: "tool.executed",
      instanceName: input.context.instanceName,
      channel: input.context.channel ?? "telegram",
      chatId: input.context.chatId,
      userId: input.context.userId,
      updateId: input.context.updateId,
      outcome: "rejected",
      detail: error instanceof Error ? error.message : String(error),
      metadata: {
        toolName: input.name,
        status: "rejected",
        ok: false,
      },
    }, "tool execution timeline event");
    throw error;
  }
}
