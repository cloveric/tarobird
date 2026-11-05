import type { CronStore } from "../state/cron-store.js";
import type { DeliveryAcceptedReceipt, DeliveryRejectedReceipt, DeliverySource } from "../runtime/delivery-ledger.js";
import type { ReplyChannel } from "../runtime/reply-channel.js";
import type { Locale } from "../runtime/locale.js";

export interface CoreToolCronRuntime {
  store: CronStore;
  scheduler: {
    refresh(): Promise<void> | void;
    runJobNow(id: string): Promise<void>;
  };
}

export interface CoreToolContext {
  cronRuntime: CoreToolCronRuntime | null;
  stateDir: string;
  channel?: "telegram" | "lark";
  chatId: number;
  userId: number;
  chatType?: string;
  messageThreadId?: number;
  conversationKey?: string;
  larkChatId?: string;
  larkThreadId?: string;
  larkMessageId?: string;
  locale: Locale;
  instanceName?: string;
  updateId?: number;
  delivery?: {
    api: Pick<ReplyChannel, "sendMessage" | "sendDocument" | "sendPhoto" | "sendVoice">;
    inboxDir: string;
    workspaceOverride?: string;
    requestOutputDir?: string;
    source?: DeliverySource;
    allowAnyAbsolutePath?: boolean;
    notifyRejected?: boolean;
    deliverArtifactResponse?: (
      api: Pick<ReplyChannel, "sendMessage" | "sendDocument" | "sendPhoto" | "sendVoice">,
      chatId: number,
      text: string,
      inboxDir: string,
      workspaceOverride: string | undefined,
      requestOutputDir: string | undefined,
      locale: Locale,
      options?: {
        onFileAccepted?: (sourcePath: string) => void;
        onDeliveryAccepted?: (receipt: DeliveryAcceptedReceipt) => void;
        onDeliveryRejected?: (receipt: DeliveryRejectedReceipt) => void;
        source?: DeliverySource;
        allowAnyAbsolutePath?: boolean;
        notifyRejected?: boolean;
      },
    ) => Promise<number>;
    onFileAccepted?: (sourcePath: string) => void;
    onDeliveryAccepted?: (receipt: DeliveryAcceptedReceipt) => void;
    onDeliveryRejected?: (receipt: DeliveryRejectedReceipt) => void;
  };
}

export interface CoreToolResult {
  ok: boolean;
  status?: "accepted" | "rejected" | "partial";
  message: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecuteCoreToolInput {
  name: string;
  payload: unknown;
  context: CoreToolContext;
}

export interface CoreToolInputSchema {
  type: "object";
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  oneOf?: Array<Record<string, unknown>>;
  additionalProperties?: boolean;
}

export interface CoreToolDefinition {
  name: string;
  description: string;
  examples?: Record<string, unknown>[];
  inputSchema?: CoreToolInputSchema;
  execute: (payload: unknown, context: CoreToolContext) => Promise<CoreToolResult>;
}
