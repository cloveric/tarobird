import type { AppPlatformTools } from "../codex/adapter.js";
import type { Json } from "../client-protocol/index.js";
import { sideDeliverySchema, type SideDelivery } from "../client-protocol/side.js";
import { createAppPlatformTools } from "./app-tools.js";
import { GatewayArtifactUploadError, type GatewayArtifact, type GatewayChannel } from "./channel.js";
import type { ReceiptResult } from "./receipts.js";

export type SideDeliveryBudget = { bytes: number; files: number };
export const SIDE_DELIVERY_BYTES = 256 * 1024 * 1024;
export const SIDE_DELIVERY_FILES = 50;
const instructions = "App files in this temporary side conversation: use app_send_file or app_send_batch to show generated images and files directly in this side panel. No additional approval is needed for delivery here. These tools return a receipt after the side output is attached, not a main-chat message. Do not ask the user to repeat the request in the main conversation. Only claim delivery after delivered:true; never repeat it with text markers. Existing path and file safety checks still apply. app_show_widget, schedules, questions and parent controls are not provided by this side receiver.";

/** Reuse main-chat preflight, content deduplication and byte checks, but bind
 * publication to the active side exchange. Receipts live only in this turn. */
export function createSideDeliveryTools(input: {
  channel: Pick<GatewayChannel, "uploadSideArtifact">; stateDir: string;
  conversationId: string; workspaceOverride?: string; signal: AbortSignal;
  budget: SideDeliveryBudget; publish(delivery: SideDelivery): void;
}): AppPlatformTools {
  const receipts = new Map<string, Promise<ReceiptResult>>();
  const send = async (id: string, artifacts: GatewayArtifact[], caption: string | undefined, signal: AbortSignal, onActivity?: () => void) => {
    signal.throwIfAborted(); input.signal.throwIfAborted();
    const bytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes.length, 0);
    if (input.budget.bytes + bytes > SIDE_DELIVERY_BYTES || input.budget.files + artifacts.length > SIDE_DELIVERY_FILES) throw new GatewayArtifactUploadError("too-large");
    // Reserve synchronously before the first upload, including parallel calls.
    input.budget.bytes += bytes; input.budget.files += artifacts.length;
    try {
      const attachments: SideDelivery["attachments"] = [];
      for (const artifact of artifacts) {
        const attachmentId = await input.channel.uploadSideArtifact(input.conversationId, artifact, signal, onActivity);
        signal.throwIfAborted(); input.signal.throwIfAborted();
        const caption = artifact.caption ? { caption: artifact.caption } : {};
        attachments.push(artifact.kind === "image" ? { type: "image", attachmentId, title: artifact.name, ...caption }
          : { type: "file", attachmentId, name: artifact.name, size: artifact.bytes.length, mime: artifact.mime, ...caption });
      }
      input.publish(sideDeliverySchema.parse({ id, ...(caption ? { caption } : {}), attachments }));
      return { messageId: id };
    } catch (error) {
      input.budget.bytes -= bytes; input.budget.files -= artifacts.length;
      throw error instanceof GatewayArtifactUploadError ? error : new GatewayArtifactUploadError("upload_failed");
    }
  };
  const base = createAppPlatformTools({ ...input, ephemeral: true, options: { widgetsEnabled: false },
    receipts: { run: (key, operation) => {
      let result = receipts.get(key);
      if (!result) {
        if (receipts.size >= 100) return Promise.resolve({ ok: false, error: "operation_failed" });
        result = Promise.resolve().then(operation).then(value => ({ ok: true, result: value } as ReceiptResult), () => ({ ok: false, error: "operation_failed" } as ReceiptResult));
        receipts.set(key, result);
      }
      return result;
    } },
    channel: {
      sendArtifact: artifact => send(artifact.messageId, [artifact], undefined, artifact.abortSignal, artifact.onActivity),
      sendArtifactBatch: batch => send(batch.messageId, batch.artifacts, batch.caption, batch.abortSignal, batch.onActivity),
    },
  });
  const names = new Set(["app_send_file", "app_send_batch", "app_capability"]);
  return { definitions: base.definitions.filter(tool => names.has(tool.name)), instructions,
    register: async () => {}, isRegistered: async () => true,
    call: async call => {
      if (input.signal.aborted || call.abortSignal.aborted) return { text: JSON.stringify({ error: "turn_ended" }), isError: true };
      if (call.name === "app_capability") return { text: instructions };
      if (!names.has(call.name)) return { text: JSON.stringify({ error: "side_tool_unavailable" }), isError: true };
      const result = await base.call(call);
      // Preserve the common receipt key for compatibility, but make the target
      // explicit: this ID is an ephemeral side output, never a Hub message.
      try { const receipt = JSON.parse(result.text) as Record<string, Json>; if (receipt.delivered) return { ...result, text: JSON.stringify({ ...receipt, destination: "side", temporary: true }) }; } catch { /* Preserve error text. */ }
      return result;
    },
  };
}
