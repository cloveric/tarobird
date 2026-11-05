import type { EngineStreamEvent } from "../codex/adapter.js";
import { deliverCoreUserInputRequest } from "./delivery.js";
import { stableCoreNumericId } from "./message-normalizer.js";
import type { CoreBridgeLike } from "./types.js";

/** Same asynchronous question delivery on every visible engine entry point. */
export async function deliverEngineQuestion(event: EngineStreamEvent, input:
  Omit<Parameters<typeof deliverCoreUserInputRequest>[0], "toolInput" | "requestId" | "sessionId" | "answerActiveTurn"> & { bridge: CoreBridgeLike; conversationKey: string; isCurrentTurn: () => boolean },
): Promise<boolean> {
  if (event.type !== "user_input_request") return false;
  await deliverCoreUserInputRequest({ ...input, toolInput: event.toolInput, requestId: event.requestId, sessionId: event.sessionId,
    ...(input.bridge.supportsSteering?.() && input.bridge.steerActiveTurn ? {
      answerActiveTurn: async (text: string) => input.isCurrentTurn() && input.bridge.steerActiveTurn!({
        chatId: stableCoreNumericId(input.conversationKey), conversationKey: input.conversationKey,
        text, isCurrentTurn: input.isCurrentTurn, throwOnError: true,
      }),
    } : {}),
  });
  return true;
}
