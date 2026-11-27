import { getEngineEffortValidationError } from "../state/instance-config.js";
import { decodePiModel, PI_THINKING_LEVELS } from "../codex/pi-models.js";
import { modelSettings } from "../runtime/model-settings.js";
import { effortValueSchema } from "../client-protocol/effort.js";
import { effortSettings } from "../runtime/effort-settings.js";
import { modelCatalog, modelEffortChoices, readModelCatalog } from "../runtime/model-catalog.js";
import { antigravityPresetEffort } from "../codex/antigravity-models.js";
import path from "node:path";
import { channelProfile } from "./channel-profile.js";
import { applyGatewayGroupMode, renderGatewayHelp } from "./platform-policy.js";

import type {
  CodexThreadGoal,
  EngineApprovalDecision,
  EngineApprovalRequest,
} from "../codex/adapter.js";
import {
  loadCodexUserDefaults,
} from "../codex/user-defaults.js";
import {
  CODEX_MODEL_CHOICES,
  isExtendedCodexEffort,
  knownCodexModelMaxEffort,
  knownCodexModelSupportsEffort,
} from "../codex/model-capabilities.js";
import { hostT } from "../locales/index.js";
import { CronScheduler } from "../runtime/cron-scheduler.js";
import { renderEngineEffortSetting, renderEngineModelSetting } from "../runtime/engine-settings-display.js";
import { renderRuntimeTimeoutMessage } from "../runtime/runtime-timeout-message.js";
import { resolveConversationResume } from "../runtime/conversation-resume.js";
import type { ScannedSession } from "../runtime/session-scanner.js";
import { CronStore } from "../state/cron-store.js";
import { AccessStore } from "../state/access-store.js";
import { renderApprovalModeStatus, resolveApprovalModeForEngine } from "../state/approval-mode.js";
import { FileWorkflowStore, type FileWorkflowStatus } from "../state/file-workflow-store.js";
import { SessionStore } from "../state/session-store.js";
import { UsageStore } from "../state/usage-store.js";
import { handleCronCommand, isCronCommand } from "./shared/cron-commands.js";
import { parseAntigravityLocalCommand, renderAntigravityLocalCommandReply } from "./shared/antigravity-commands.js";
import { handleLocalEngineCoreCommand } from "./shared/engine-commands.js";
import {
  ANTIGRAVITY_EFFORT_LEVELS,
  applyEngineSelection,
  CLAUDE_MODEL_CHOICES,
  KIMI_EFFORT_LEVELS,
  loadInstanceConfig,
  normalizeModelCommandInput,
  resolveInstanceWorkspacePath,
  updateInstanceApprovalMode,
  updateInstanceConfig,
  type EffortLevel,
  type GroupModeConfig,
  type InstanceConfig,
  type InstanceEngine,
  type ResumeState,
  DEFAULT_STEER_WINDOW_SECONDS,
} from "../state/instance-config.js";
import {
  killInstanceGroupOrphans,
  killInstanceGroupProcess,
  listInstanceProcessGroup,
} from "../runtime/background-processes.js";
import { renderUsageMessage, type Locale } from "../runtime/message-renderer.js";
import { isChineseLocale } from "../runtime/locale.js";
import { handleLocalSessionCoreCommand } from "./shared/session-commands.js";

import type { CommandMessage } from "../runtime/command-message.js";
import {
  CoreGoalRunController,
  handleCoreBoardCommand,
  handleCoreDelegationCommand,
  handleCoreMiniBusCommand,
} from "./bus.js";
import type { LarkCliStatus } from "./integration-ports.js";
import { sendCoreCardWithFallback } from "./card-delivery.js";
import { isLarkAccountCommand, renderLarkAccountCard } from "./account-card.js";
import { renderCommandResultCard, renderCommandUsageCard, renderCoreResumeScanCard, renderCoreStatusCard } from "./command-cards.js";
import { isCoreConfigCommand, renderCoreConfigCard } from "./config-card.js";
import { deliverCoreUserInputRequest, sendCoreMarkdown } from "./delivery.js";
import { CoreGroupModeStore } from "./group-mode-store.js";
import { checkGroupMsgScope, renderGroupMsgScopeWarning } from "./group-scope-check.js";
import { CoreKnownChatStore } from "./known-chats.js";
import { readRawCoreConfig, renderCoreCronRuntimeMissing, renderCoreUserAccessDenied, resolveCoreLocale } from "./locale.js";
import { buildCoreConversationKey, splitMessageContext, stableCoreNumericId, type CoreNormalizedBridgeMessage } from "./message-normalizer.js";
import { redactCoreErrorDetail } from "./redaction.js";
import { renderCoreUserFacingError } from "./errors.js";
import type { CoreServiceRuntime } from "./runtime.js";
import type { CoreBridgeLike, CoreChannelLike } from "./types.js";
import { appendCoreTimelineEvent } from "./timeline.js";

// Keep native cleanup (not card publication) by runtime/conversation until it drains.
const goalPursuitCompletions = new WeakMap<CoreServiceRuntime, Map<string, Promise<void>>>();
const goalCommandLocks = new WeakMap<CoreServiceRuntime, Map<string, Promise<unknown>>>();

const VALID_LARK_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const LARK_ENGINE_CHOICES: InstanceEngine[] = ["claude", "codex", "kimi", "deepseek", "antigravity", "pi", "omp"];

type RequestCoreApproval = (input: {
  channel: CoreChannelLike;
  runtime: CoreServiceRuntime;
  chatId: string;
  conversationKey?: string;
  bridgeChatType?: "private" | "group";
  requesterUserId?: number;
  replyTo?: string;
  replyInThread?: boolean;
  locale?: Locale;
  request: EngineApprovalRequest;
  abortSignal?: AbortSignal;
}) => Promise<EngineApprovalDecision>;

export type CoreCommandInput = {
  channel: CoreChannelLike;
  bridge: CoreBridgeLike;
  runtime: CoreServiceRuntime;
  stateDir: string;
  instanceName?: string;
  requestApproval: RequestCoreApproval;
  requireMentionInGroup?: boolean;
  abortSignal?: AbortSignal;
  /** Explicitly null means this conversation is attached to no resumed workspace. */
  conversationResume?: ResumeState | null;
  isCurrentGoalSession?: () => boolean | Promise<boolean>;
  workspaceOverride?: string;
  // Live run-card factory, supplied by message-handler. Typed via an erased type-query
  // so commands.ts keeps no runtime import of message-handler.ts (which imports this
  // file — a direct import would be a cycle).
  createRunCard?: typeof import("./message-handler.js")["createCoreRunCardController"];
};

export async function handleCoreSimpleCommand(
  input: CoreCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const commandLocale = await resolveCoreLocale(input.stateDir);
  if (isHelpCommand(commandText)) {
    const help = channelProfile() === "gateway"
      ? renderGatewayHelp((await loadInstanceConfig(input.stateDir)).engine, commandLocale, input.bridge.supportsConversationRestart?.() ?? false)
      : renderCoreHelpMessage(commandLocale, input.bridge.supportsConversationRestart?.() ?? false);
    await sendCoreCommandMarkdown(input, normalized, "/help", help);
    return true;
  }

  if (isCoreConfigCommand(commandText)) {
    await input.channel.send(normalized.chatId, {
      card: await renderCoreConfigCard({
        stateDir: input.stateDir,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        larkChatId: normalized.chatId,
        bridgeChatId: normalized.bridgeAccessChatId,
        replyInThread: Boolean(normalized.threadId),
        locale: commandLocale,
        requireMentionInGroup: input.requireMentionInGroup,
      }),
    }, coreCommandReplyOptions(normalized));
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail: "/config",
    });
    return true;
  }

  if (await handleCoreSessionCommand(input, normalized, commandText, commandLocale)) {
    return true;
  }

  const newGroupCommand = parseCoreNewGroupCommand(commandText);
  if (newGroupCommand) {
    await handleCoreNewGroupCommand(input, normalized, newGroupCommand, commandLocale);
    return true;
  }

  if (await handleCoreLocalEngineCommand(input, normalized, commandText, commandLocale)) {
    return true;
  }

  const agyLocalAction = parseAntigravityLocalCommand(commandText);
  if (agyLocalAction) {
    const cfg = await loadInstanceConfig(input.stateDir);
    if (cfg.engine === "antigravity") {
      const { commandLabel, markdown } = await renderAntigravityLocalCommandReply(agyLocalAction, commandLocale);
      await sendCoreCommandMarkdown(input, normalized, commandLabel, markdown);
      return true;
    }
  }

  const goalCfg = /^\/goal(?:\s|$)/i.test(commandText.trim()) ? await loadInstanceConfig(input.stateDir) : undefined;
  const goalCommand = goalCfg ? parseCoreGoalCommand(commandText, goalCfg.engine) : null;
  if (goalCommand && goalCfg) {
    const cfg = goalCfg;
    if (input.conversationResume !== undefined) {
      cfg.resume = input.conversationResume ?? undefined;
    }
    const handled = await handleCoreGoalCommand(input, normalized, cfg, goalCommand, commandText, commandLocale);
    if (handled !== null) {
      return handled;
    }
  }

  if (await handleCoreBoardCommand(input, normalized, commandText)) {
    return true;
  }

  if (await handleCoreMiniBusCommand(input, normalized, commandText)) {
    return true;
  }

  if (await handleCoreDelegationCommand(input, normalized, commandText)) {
    return true;
  }

  if (isGroupCommand(commandText)) {
    await sendCoreCommandMarkdown(input, normalized, "/group", await renderAndApplyCoreGroupCommand(input, normalized, commandText, commandLocale));
    return true;
  }

  if (isCoreInviteRemoveCommand(commandText)) {
    await handleCoreInviteRemoveCommand(input, normalized, commandText, commandLocale);
    return true;
  }

  if (isCronCommand(commandText)) {
    await handleCoreCronCommand(input, normalized, commandText, commandLocale);
    return true;
  }

  if (isLarkAccountCommand(commandText)) {
    const card = renderLarkAccountCard({
      ...(input.runtime.appInfo?.appId ? { appId: input.runtime.appInfo.appId } : {}),
      ...(input.runtime.appInfo?.domain ? { domain: input.runtime.appInfo.domain } : {}),
      ...(input.instanceName ? { instanceName: input.instanceName } : {}),
      stateDir: input.stateDir,
      locale: commandLocale,
    });
    await sendCoreCardWithFallback({
      channel: input.channel,
      chatId: normalized.chatId,
      card,
      fallbackText: !isChineseLocale(commandLocale)
        ? "Current Lark app status (run `lark wizard` to switch apps)."
        : "当前飞书应用状态（更换 app 请运行 `lark wizard`）。",
      options: coreCommandReplyOptions(normalized),
      locale: commandLocale,
    });
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail: "/account",
    });
    return true;
  }

  if (isStatusCommand(commandText)) {
    const markdown = await renderCoreStatusMessage(input.runtime, normalized, input.stateDir, commandLocale, input.requireMentionInGroup);
    await sendCoreCardWithFallback({
      channel: input.channel,
      chatId: normalized.chatId,
      card: renderCoreStatusCard({
        markdown,
        locale: commandLocale,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        larkChatId: normalized.chatId,
        bridgeChatId: normalized.bridgeAccessChatId,
        replyInThread: Boolean(normalized.threadId),
      }),
      fallbackText: markdown,
      options: coreCommandReplyOptions(normalized),
      locale: commandLocale,
    });
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail: "/status",
    });
    return true;
  }

  if (isUsageCommand(commandText)) {
    const usage = await new UsageStore(input.stateDir).load();
    const usageMessage = renderUsageMessage(usage, commandLocale);
    let usageNote = "";
    // Every non-Claude engine has a telemetry limitation. Kimi omits structured
    // usage entirely; DeepSeek reports tokens but no dollars; Codex/Antigravity
    // cannot enforce dollar budgets. Surface relevant gaps instead of implying
    // that the usage card or configured budget is complete.
    const usageCfg = await loadInstanceConfig(input.stateDir);
    if (usageCfg.engine === "kimi" || usageCfg.engine === "deepseek") {
      usageNote = renderCoreEngineUsageNote(usageCfg.engine, commandLocale, usageCfg.budgetUsd !== undefined);
    } else if (usageCfg.engine !== "claude" && (channelProfile() === "gateway" || usageCfg.budgetUsd !== undefined)) {
      usageNote = renderCoreEngineUsageNote(usageCfg.engine, commandLocale, usageCfg.budgetUsd !== undefined);
    }
    await sendCoreCommandMarkdown(input, normalized, "/usage", [usageMessage, usageNote].filter(Boolean).join("\n"), renderCommandUsageCard(usage, commandLocale, usageNote));
    return true;
  }

  const modelCommand = parseCoreModelCommand(commandText);
  if (modelCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    // Pi /model is a native per-session picker; the App's model settings remain
    // the explicit Bot-wide default. Do not silently rewrite that scope here.
    if (cfg.engine === "pi") return false;
    const message = await handleCoreModelCommand(input.stateDir, cfg, modelCommand.model, commandLocale);
    await sendCoreCommandMarkdown(input, normalized, "/model", message);
    return true;
  }

  const effortCommand = parseCoreEffortCommand(commandText);
  if (effortCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleCoreEffortCommand(input.stateDir, cfg, effortCommand.level, commandLocale);
    await sendCoreCommandMarkdown(input, normalized, "/effort", message);
    return true;
  }

  const fastCommand = parseCoreFastCommand(commandText);
  if (fastCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleCoreFastCommand(input.stateDir, cfg, fastCommand.action, commandLocale);
    await sendCoreCommandMarkdown(input, normalized, "/fast", message);
    return true;
  }

  const streamCommand = parseCoreStreamCommand(commandText);
  if (streamCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleCoreStreamCommand(input.stateDir, cfg, streamCommand.action, commandLocale);
    await sendCoreCommandMarkdown(input, normalized, "/stream", message);
    return true;
  }

  const timeoutCommand = parseCoreTimeoutCommand(commandText);
  if (timeoutCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleCoreTimeoutCommand(input.stateDir, cfg, timeoutCommand.action, commandLocale);
    await sendCoreCommandMarkdown(input, normalized, "/timeout", message);
    return true;
  }

  const steerCommand = parseCoreSteerCommand(commandText);
  if (steerCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleCoreSteerCommand(input.stateDir, cfg, steerCommand.action, commandLocale);
    await sendCoreCommandMarkdown(input, normalized, "/steer", message);
    return true;
  }

  // /bg is dispatched pre-queue in the message handler (instance-scoped process
  // control must not be serialized behind the running turn), so it never reaches
  // here. The predicate/handler are exported for that path.

  const engineCommand = parseCoreEngineCommand(commandText);
  if (engineCommand) {
    const cfg = await loadInstanceConfig(input.stateDir);
    const message = await handleCoreEngineCommand(input.stateDir, cfg, engineCommand.engine, engineCommand.invalid, commandLocale);
    await sendCoreCommandMarkdown(input, normalized, "/engine", message);
    return true;
  }

  const yoloCommand = parseCoreYoloCommand(commandText);
  if (yoloCommand) {
    const message = await handleCoreYoloCommand(input.stateDir, yoloCommand.action, commandLocale);
    await sendCoreCommandMarkdown(input, normalized, "/yolo", message);
    return true;
  }

  return false;
}

export async function handleCoreGroupCommandBeforeAccess(
  input: CoreCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
  locale: Locale = "zh",
): Promise<boolean> {
  const isAccessCommand = isGroupCommand(commandText) || isCoreInviteRemoveCommand(commandText);
  if (!isAccessCommand || normalized.bridgeChatType !== "group") {
    return false;
  }

  if (input.bridge.checkUserAuthorization) {
    const auth = await input.bridge.checkUserAuthorization({
      chatId: normalized.bridgeAccessChatId,
      userId: normalized.bridgeUserId,
      chatType: normalized.bridgeChatType,
      conversationKey: normalized.conversationKey,
      locale,
    });
    if (auth.kind !== "allow") {
      await input.channel.send(normalized.chatId, {
        text: formatCoreAccessReply(auth.text ?? renderCoreUserAccessDenied(locale)),
      }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "command.handled",
        outcome: "denied",
        detail: isGroupCommand(commandText) ? "/group" : extractCoreInviteRemoveCommandName(commandText),
        metadata: { rejected: "unauthorized-user" },
      });
      return true;
    }
  }

  if (isGroupCommand(commandText)) {
    await sendCoreCommandMarkdown(input, normalized, "/group", await renderAndApplyCoreGroupCommand(input, normalized, commandText, locale));
  } else {
    await handleCoreInviteRemoveCommand(input, normalized, commandText, locale);
  }
  return true;
}

async function sendCoreCommandMarkdown(
  input: {
    channel: CoreChannelLike;
    stateDir: string;
  },
  normalized: CoreNormalizedBridgeMessage,
  command: string,
  markdown: string,
  card?: Record<string, unknown>,
): Promise<void> {
  if (channelProfile() === "gateway") {
    await input.channel.send(normalized.chatId, { card: card ?? renderCommandResultCard(command, markdown) }, coreCommandReplyOptions(normalized));
  } else {
    await sendCoreMarkdown(input.channel, normalized.chatId, markdown, coreCommandReplyOptions(normalized));
  }
  await appendCoreTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail: command,
  });
}

function coreCommandReplyOptions(normalized: CoreNormalizedBridgeMessage): { replyTo: string; replyInThread: boolean } {
  return {
    replyTo: normalized.messageId,
    replyInThread: Boolean(normalized.threadId),
  };
}

export function isCoreLocalEngineCommand(text: string): boolean {
  // `/ultrareview` is the Claude deep-review path. NOTE: `/code-review` is NOT
  // implemented on either channel (no handler exists), so it must not be matched
  // here — matching it swallowed the message into a handler that returns false,
  // and it then reached the engine as plain prompt text anyway. Removed from the
  // predicate and from /help; use `/ultrareview` for the deep review path.
  // Claude-local engine command path, plus Antigravity `/swarm` capability gate.
  return /^\/(?:compact|context|ultrareview|swarm)(?:\s|$)/i.test(text.trim());
}

async function handleCoreLocalEngineCommand(
  input: CoreCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<boolean> {
  if (!isCoreLocalEngineCommand(commandText)) {
    return false;
  }

  const cfg = await loadInstanceConfig(input.stateDir);
  cfg.resume = input.conversationResume === undefined
    ? resolveConversationResume(
      (await new SessionStore(path.join(input.stateDir, "session.json"))
        .findByConversationKeySafe(normalized.conversationKey)).record,
      cfg.resume,
    )
    : input.conversationResume ?? undefined;
  return await handleLocalEngineCoreCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale,
    cfg: {
      engine: cfg.engine,
      role: cfg.role,
      model: cfg.model,
      disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
      workspacePath: input.workspaceOverride ?? normalized.workspaceOverride ?? cfg.workspacePath,
      resume: cfg.resume,
      ...(cfg.antigravityRuntime ? { antigravityRuntime: cfg.antigravityRuntime } : {}),
    },
    normalized: toSessionCommandMessage(normalized, commandText),
    context: {
      api: {
        sendMessage: async (_chatId: number, text: string) => {
          await sendCoreMarkdown(input.channel, normalized.chatId, text, coreCommandReplyOptions(normalized));
          return { message_id: 0, text };
        },
      },
      channel: "lark",
      instanceName: input.instanceName ?? "lark",
      abortSignal: input.abortSignal,
    },
    bridge: input.bridge,
    sessionStore: new SessionStore(path.join(input.stateDir, "session.json")),
    updateInstanceConfig: async (updater) => await updateInstanceConfig(input.stateDir, updater),
  });
}

async function handleCoreSessionCommand(
  input: CoreCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  cfg.resume = input.conversationResume === undefined
    ? resolveConversationResume(
      (await new SessionStore(path.join(input.stateDir, "session.json"))
        .findByConversationKeySafe(normalized.conversationKey)).record,
      cfg.resume,
    )
    : input.conversationResume ?? undefined;
  const effectiveWorkspace = input.workspaceOverride ?? normalized.workspaceOverride ?? resolveInstanceWorkspacePath(cfg);
  return await handleLocalSessionCoreCommand({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale,
    cfg: {
      engine: cfg.engine,
      resume: cfg.resume,
    },
    workspaceOverride: effectiveWorkspace,
    normalized: toSessionCommandMessage(normalized, commandText),
    context: {
      api: {
        sendMessage: async (_chatId: number, text: string) => {
          await sendCoreMarkdown(input.channel, normalized.chatId, text, coreCommandReplyOptions(normalized));
          return { message_id: 0, text };
        },
      },
      channel: "lark",
      instanceName: input.instanceName ?? "lark",
    },
    sessionStore: new SessionStore(path.join(input.stateDir, "session.json")),
    updateInstanceConfig: async (updater) => await updateInstanceConfig(input.stateDir, updater),
    validateCodexThread: input.bridge.validateCodexThread?.bind(input.bridge),
    scanRecentSessions: input.runtime.sessionRuntime?.scanRecentSessions,
    scanRecentAntigravitySessions: input.runtime.sessionRuntime?.scanRecentAntigravitySessions,
    scanRecentKimiSessions: input.bridge.listExternalSessions
      ? async () => (await input.bridge.listExternalSessions!({ ...(effectiveWorkspace ? { cwd: effectiveWorkspace } : {}), limit: 20 })).map((session) => {
          const modifiedAt = new Date(session.updatedAt ?? 0);
          return {
            sessionId: session.sessionId,
            dirName: session.sessionId,
            workspacePath: session.cwd,
            modifiedAt: Number.isNaN(modifiedAt.getTime()) ? new Date(0) : modifiedAt,
            displayName: session.title || session.sessionId,
          };
        })
      : undefined,
    scanRecentDeepSeekSessions: input.bridge.listExternalSessions
      ? async () => (await input.bridge.listExternalSessions!({ ...(effectiveWorkspace ? { cwd: effectiveWorkspace } : {}), limit: 20 })).map((session) => {
          const modifiedAt = new Date(session.updatedAt ?? 0);
          return {
            sessionId: session.sessionId,
            dirName: session.sessionId,
            workspacePath: session.cwd,
            modifiedAt: Number.isNaN(modifiedAt.getTime()) ? new Date(0) : modifiedAt,
            displayName: session.title || session.sessionId,
          };
        })
      : undefined,
    scanRecentPiSessions: input.bridge.listExternalSessions
      ? async () => (await input.bridge.listExternalSessions!({ ...(effectiveWorkspace ? { cwd: effectiveWorkspace } : {}), limit: 20 })).map((session) => {
          const modifiedAt = new Date(session.updatedAt ?? 0);
          return {
            sessionId: session.sessionId,
            dirName: session.sessionId,
            workspacePath: session.cwd,
            modifiedAt: Number.isNaN(modifiedAt.getTime()) ? new Date(0) : modifiedAt,
            displayName: session.title || session.sessionId,
          };
        })
      : undefined,
    scanRecentOmpSessions: input.bridge.listExternalSessions
      ? async () => (await input.bridge.listExternalSessions!({ limit: 20 })).map((session) => {
          const modifiedAt = new Date(session.updatedAt ?? 0);
          return {
            sessionId: session.sessionId,
            dirName: session.sessionId,
            workspacePath: session.cwd,
            modifiedAt: Number.isNaN(modifiedAt.getTime()) ? new Date(0) : modifiedAt,
            displayName: session.title || session.sessionId,
          };
        })
      : undefined,
    sendResumeScanResult: async ({ kind, visibleSessions }) => {
      await sendCoreCardWithFallback({
        channel: input.channel,
        chatId: normalized.chatId,
        card: renderCoreResumeScanCard({
          kind,
          sessions: visibleSessions,
          locale,
          conversationKey: normalized.conversationKey,
          bridgeChatType: normalized.bridgeChatType,
          replyInThread: Boolean(normalized.threadId),
        }),
        fallbackText: renderCoreResumeFallback(kind, visibleSessions, locale),
        options: coreCommandReplyOptions(normalized),
        locale,
      });
    },
  });
}

function renderCoreResumeFallback(
  kind: "claude" | "antigravity" | "kimi" | "deepseek" | "pi" | "omp",
  sessions: ScannedSession[],
  locale: Locale,
): string {
  if (sessions.length === 0) {
    return hostT(locale, "未找到最近的 {0} session。", kind);
  }
  const title = hostT(locale, "最近的 {0} session", kind);
  return [
    title,
    ...sessions.slice(0, 10).map((session, index) => `${index + 1}. ${session.displayName} (${session.sessionId}) @ ${session.modifiedAt.toISOString()}`),
  ].join("\n");
}

function toSessionCommandMessage(
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
): CommandMessage {
  return {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType === "private" ? "private" : "supergroup",
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}

export function formatCoreAccessReply(text: string): string {
  if (text.includes("lark access pair")) {
    return text;
  }

  const code = extractPairingCode(text);
  if (!code) {
    return text;
  }

  return `${text}\n在本机运行：node dist/src/index.js lark access pair ${code}`;
}

function extractPairingCode(text: string): string | null {
  return text.match(/使用配对码\s+([A-Z0-9]{6,12})\s+配对/)?.[1] ??
    text.match(/Pair this private chat with code\s+([A-Z0-9]{6,12})/i)?.[1]?.toUpperCase() ??
    null;
}

export function extractCoreMessageBody(text: string): string {
  return normalizeCoreSlashCommandMention(splitMessageContext(text).body.trim());
}

function normalizeCoreSlashCommandMention(text: string): string {
  return text.replace(
    /^(\/[a-z][\w.-]*)(@[a-z0-9_][\w.-]*)?(?=\s|$)/i,
    "$1",
  );
}

function isHelpCommand(text: string): boolean {
  return /^\/(?:help|start)(?:\s|$)/i.test(text.trim());
}

function isStatusCommand(text: string): boolean {
  return /^\/status(?:\s|$)/i.test(text.trim());
}

function isUsageCommand(text: string): boolean {
  return /^\/usage(?:\s|$)/i.test(text.trim());
}

function parseCoreModelCommand(text: string): { model: string } | null {
  const match = text.trim().match(/^\/model(?:\s+([\s\S]+))?$/i);
  return match ? { model: match[1]?.trim() ?? "" } : null;
}

function parseCoreEffortCommand(text: string): { level: string } | null {
  const match = text.trim().match(/^\/effort(?:\s+(\S+))?$/i);
  return match ? { level: match[1]?.toLowerCase() ?? "" } : null;
}

function parseCoreFastCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/fast(?:\s+(.*))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() || "status" } : null;
}

function parseCoreStreamCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/stream(?:\s+(.*))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() || "status" } : null;
}

function parseCoreTimeoutCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/timeout(?:\s+(.*))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() || "status" } : null;
}

function parseCoreSteerCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/steer(?:\s+(.*))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() || "status" } : null;
}

type CoreBgCommand = { action: "list" } | { action: "kill"; pid: number } | { action: "killall" } | { action: "usage" };

export function isCoreBgCommand(text: string): boolean {
  return /^\/bg(?:\s|$)/i.test(text.trim());
}

/**
 * Pre-queue /bg entrypoint: instance-scoped background-process control that must
 * run independently of the conversation session (like /stop), so it is dispatched
 * ahead of chatQueue rather than inside the queued-turn path. Returns the reply
 * text, or null when the text is not a /bg command.
 */
export async function handleCoreBgCommandText(text: string, locale: Locale): Promise<string | null> {
  const command = parseCoreBgCommand(text);
  return command ? await handleCoreBgCommand(command, locale) : null;
}

function parseCoreBgCommand(text: string): CoreBgCommand | null {
  const match = text.trim().match(/^\/bg(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }
  const args = (match[1] ?? "").trim().toLowerCase();
  if (!args || args === "list") {
    return { action: "list" };
  }
  if (args === "killall") {
    return { action: "killall" };
  }
  const killMatch = args.match(/^kill\s+(\d+)$/);
  if (killMatch) {
    return { action: "kill", pid: Number(killMatch[1]) };
  }
  return { action: "usage" };
}

async function handleCoreBgCommand(command: CoreBgCommand, locale: Locale): Promise<string> {
  if (command.action === "usage") {
    return hostT(locale, "用法：`/bg`（列出本实例的引擎/后台进程）· `/bg kill <pid>` 停掉指定进程树 · `/bg killall` 清掉所有孤儿后台进程");
  }
  if (command.action === "kill") {
    const result = await killInstanceGroupProcess(command.pid);
    if (result.killed) {
      return hostT(locale, "已停止进程树 pid={0} ✓", command.pid);
    }
    if (result.reason === "not-in-group") {
      return hostT(locale, "pid={0} 不在本实例的进程组里（可能已退出）。先用 /bg 看列表。", command.pid);
    }
    if (result.reason === "is-service") {
      return hostT(locale, "那是服务进程本体，不能从这里杀。");
    }
    return hostT(locale, "当前平台暂不支持 /bg。");
  }
  if (command.action === "killall") {
    const result = await killInstanceGroupOrphans();
    if (result.unsupported) {
      return hostT(locale, "当前平台暂不支持 /bg。");
    }
    if (result.killedPids.length === 0) {
      return hostT(locale, "没有孤儿后台进程，干净的 ✨");
    }
    return hostT(locale, "已清理 {0} 个孤儿进程树：{1}", result.killedPids.length, result.killedPids.join(", "));
  }

  const group = await listInstanceProcessGroup();
  if (group === null) {
    return hostT(locale, "当前平台暂不支持 /bg。");
  }
  if (group.length === 0) {
    return hostT(locale, "本实例没有任何引擎/后台进程在跑。");
  }
  const lines = group.slice(0, 15).map((proc) => {
    const cmd = proc.command.length > 70 ? `${proc.command.slice(0, 67)}...` : proc.command;
    const lineKey = proc.role === "engine"
      ? "- `{0}` · 引擎 · {1}MB · {2} · {3}"
      : proc.role === "child"
        ? "- `{0}` · 子进程 · {1}MB · {2} · {3}"
        : "- `{0}` · 孤儿 · {1}MB · {2} · {3}";
    return hostT(locale, lineKey, proc.pid, proc.rssMb, proc.etime, cmd);
  });
  const truncated = group.length > 15
    ? [hostT(locale, "…共 {0} 个，仅显示前 15", group.length)]
    : [];
  const footer = hostT(locale, "停止：`/bg kill <pid>` · 清理孤儿：`/bg killall`（孤儿 = 任务结束后仍残留的后台进程）");
  const header = hostT(locale, "**本实例进程组**（服务本体除外，按内存排序）");
  return [header, ...lines, ...truncated, "", footer].join("\n");
}

function parseCoreEngineCommand(text: string): { engine: string; invalid: boolean } | null {
  const match = text.trim().match(/^\/engine(?:\s+(.+))?$/i);
  if (!match) return null;
  const rawArgs = match[1]?.trim() ?? "";
  if (!rawArgs) {
    return { engine: "", invalid: false };
  }
  const parts = rawArgs.split(/\s+/).filter(Boolean);
  return parts.length === 1 ? { engine: parts[0] ?? "", invalid: false } : { engine: "", invalid: true };
}

function parseCoreYoloCommand(text: string): { action: string } | null {
  const match = text.trim().match(/^\/yolo(?:\s+(\S+))?$/i);
  return match ? { action: (match[1] ?? "").trim().toLowerCase() } : null;
}

type CoreNewGroupCommand =
  | { kind: "create"; mode: "group" | "topic"; name: string }
  | { kind: "invalid"; reason: "missing_name" };

function parseCoreNewGroupCommand(text: string): CoreNewGroupCommand | null {
  const trimmed = text.trim();
  const topicMatch = trimmed.match(/^\/newtopic(?:\s+([\s\S]+))?$/i);
  if (topicMatch) {
    const name = topicMatch[1]?.trim() ?? "";
    return name ? { kind: "create", mode: "topic", name } : { kind: "invalid", reason: "missing_name" };
  }

  const groupMatch = trimmed.match(/^\/newgroup(?:\s+([\s\S]+))?$/i);
  if (!groupMatch) return null;
  const rest = groupMatch[1]?.trim() ?? "";
  if (!rest) {
    return { kind: "invalid", reason: "missing_name" };
  }
  const topicPrefix = rest.match(/^(?:topic|--topic)(?:\s+([\s\S]+))?$/i);
  if (topicPrefix) {
    const name = topicPrefix[1]?.trim() ?? "";
    return name ? { kind: "create", mode: "topic", name } : { kind: "invalid", reason: "missing_name" };
  }
  return {
    kind: "create",
    mode: "group",
    name: rest,
  };
}

async function handleCoreNewGroupCommand(
  input: CoreCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  command: CoreNewGroupCommand,
  locale: Locale,
): Promise<void> {
  if (command.kind === "invalid") {
    await sendCoreCommandMarkdown(input, normalized, "/newgroup", renderCoreNewGroupUsage(locale));
    return;
  }

  let created: Awaited<ReturnType<CoreServiceRuntime["createChat"]>>;
  try {
    created = await input.runtime.createChat({
      name: command.name,
      mode: command.mode,
      operatorOpenId: normalized.senderId,
      ...(input.runtime.appInfo?.appId ? { botAppId: input.runtime.appInfo.appId } : {}),
      channel: input.channel,
    });
  } catch (error) {
    await sendCoreCommandMarkdown(input, normalized, "/newgroup", renderCoreNewGroupFailed(locale, error));
    return;
  }

  let authorizationWarning: string | undefined;
  try {
    const newGroupId = stableCoreNumericId(buildCoreConversationKey(created.chatId));
    await updateCoreGroupMode(input.stateDir, (groupMode) => {
      allowCoreGroup(groupMode, newGroupId);
    });
  } catch (error) {
    authorizationWarning = redactCoreErrorDetail(error);
  }

  let welcomeWarning: string | undefined;
  try {
    await input.channel.send(created.chatId, {
      markdown: renderCoreNewGroupWelcome(command.name, command.mode, locale, authorizationWarning === undefined),
    });
  } catch (error) {
    welcomeWarning = redactCoreErrorDetail(error);
  }

  await sendCoreCommandMarkdown(
    input,
    normalized,
    "/newgroup",
    renderCoreNewGroupCreated({
      locale,
      mode: command.mode,
      name: created.name ?? command.name,
      chatId: created.chatId,
      shareLink: created.shareLink,
      authorizationWarning,
      welcomeWarning,
    }),
  );
}

function renderCoreNewGroupUsage(locale: Locale): string {
  return hostT(
    locale,
    "**创建飞书会话**\n\n用法：\n- `/newgroup <名称>`：创建普通飞书群\n- `/newgroup topic <名称>` 或 `/newtopic <名称>`：创建飞书话题群\n\n默认用实例 bot 创建并拉入发起人；显式用户 OAuth 模式则由 OAuth 用户创建。两条路径都会确保实例 bot 入群并自动授权；用户权限仍会校验，默认仍需 @bot。",
  );
}

function renderCoreNewGroupWelcome(
  name: string,
  mode: "group" | "topic",
  locale: Locale,
  authorized: boolean,
): string {
  const modeDesc = mode === "topic"
    ? hostT(locale, "每个话题都是独立 session；在话题内发送 `/status` 可查看该会话。")
    : hostT(locale, "普通对话群全群共享一个 session，普通 reply/thread 也会延续该会话；发送 `/status` 可查看。");
  const authDesc = authorized
    ? hostT(locale, "新群已授权，但仍只允许已授权用户使用。默认需要 @bot。若要监听普通消息，请先开通应用权限 `im:message` + `im:message.group_msg`，再 @bot 发送 `/group all`；裸命令可能不会投递给 Bot。")
    : hostT(locale, "新群自动授权失败；请由已授权用户先 @bot 发送 `/group allow`，裸命令可能不会投递给 Bot。");
  return mode === "topic"
    ? hostT(locale, "**{0}** 这个话题群已经接入 TaroCub。\n\n{1}\n{2}", name, modeDesc, authDesc)
    : hostT(locale, "**{0}** 这个群已经接入 TaroCub。\n\n{1}\n{2}", name, modeDesc, authDesc);
}

function renderCoreNewGroupCreated(input: {
  locale: Locale;
  mode: "group" | "topic";
  name: string;
  chatId: string;
  shareLink?: string;
  authorizationWarning?: string;
  welcomeWarning?: string;
}): string {
  const kind = hostT(input.locale, input.mode === "topic" ? "飞书话题群" : "飞书群");
  const lines = [
    hostT(input.locale, "已创建{0}：{1}", kind, input.name),
    hostT(input.locale, "Chat ID：{0}", input.chatId),
  ];
  if (input.shareLink) {
    lines.push(hostT(input.locale, "链接：{0}", input.shareLink));
  }
  if (input.authorizationWarning) {
    lines.push("");
    lines.push(hostT(input.locale, "已创建，但自动授权新群失败：{0}。请在新群内先 @bot 发送 /group allow。", input.authorizationWarning));
  }
  if (input.welcomeWarning) {
    lines.push("");
    lines.push(hostT(input.locale, "已创建，但欢迎消息发送失败：{0}", input.welcomeWarning));
  }
  return lines.join("\n");
}

function renderCoreNewGroupFailed(locale: Locale, error: unknown): string {
  const detail = redactCoreErrorDetail(error);
  return hostT(
    locale,
    "创建飞书群失败：{0}\n\n请检查应用是否已开通 im:chat / im:chat:create，并重新运行 lark provision。如果配置为用户身份建群，还需要 im:chat:create_by_user。",
    detail,
  );
}

type CoreGoalCommand =
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "edit"; objective?: string; tokenBudget?: number | null }
  | { kind: "set"; objective: string; tokenBudget: number | null; explicitUnbounded: boolean }
  | { kind: "invalid"; reason: "invalid_budget" | "missing_objective" | "invalid_control" | "too_long" };

function parseCoreGoalTokenBudget(value: string): number | null {
  const normalized = value.trim().replace(/[,_]/g, "").toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const budget = amount * scale;
  return Number.isSafeInteger(budget) && budget >= 1 ? budget : null;
}

function parseCoreSetGoal(rest: string): Extract<CoreGoalCommand, { kind: "set" | "invalid" }> {
  const unboundedMatch = rest.match(/^(?:--unbounded|--no-budget)(?:\s+([\s\S]+))?$/i);
  if (/^(?:--unbounded|--no-budget)(?:$|\s+)/i.test(rest)) {
    const objective = unboundedMatch?.[1]?.trim() ?? "";
    if (!objective) {
      return { kind: "invalid", reason: "missing_objective" };
    }
    return { kind: "set", objective, tokenBudget: null, explicitUnbounded: true };
  }

  const budgetMatch = rest.match(/^(?:--budget|-b)(?:=|\s+)(\S+)(?:\s+([\s\S]+))?$/i);
  if (/^(?:--budget|-b)(?:$|=|\s+)/i.test(rest)) {
    const tokenBudget = budgetMatch ? parseCoreGoalTokenBudget(budgetMatch[1] ?? "") : null;
    if (!budgetMatch || tokenBudget === null) {
      return { kind: "invalid", reason: "invalid_budget" };
    }
    const objective = budgetMatch[2]?.trim() ?? "";
    if (!objective) {
      return { kind: "invalid", reason: "missing_objective" };
    }
    return { kind: "set", objective, tokenBudget, explicitUnbounded: false };
  }
  return { kind: "set", objective: rest, tokenBudget: null, explicitUnbounded: false };
}

function parseCoreGoalCommand(text: string, engine: InstanceEngine): CoreGoalCommand | null {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  const rest = match[1]?.trim() ?? "";
  if (!rest || /^status$/i.test(rest)) return { kind: "status" };
  if (/^(clear|off|reset)$/i.test(rest) || ((engine === "claude" || engine === "antigravity") && /^(stop|cancel|none)$/i.test(rest))) return { kind: "clear" };
  if (engine === "codex" || engine === "omp") {
    if (/^(pause|resume)$/i.test(rest)) return { kind: rest.toLowerCase() as "pause" | "resume" };
    if (/^(pause|resume)\s/i.test(rest)) return { kind: "invalid", reason: "invalid_control" };
    const edit = rest.match(/^edit(?:\s+([\s\S]+))?$/i);
    if (edit) {
      const value = edit[1]?.trim() ?? "";
      if (!value) return { kind: "edit" };
      // Budget-only edits preserve the native objective, status and counters.
      const budgetOnly = value.match(/^(?:--budget|-b)(?:=|\s+)(\S+)$/i);
      if (budgetOnly) {
        const tokenBudget = parseCoreGoalTokenBudget(budgetOnly[1]!);
        return tokenBudget === null ? { kind: "invalid", reason: "invalid_budget" } : { kind: "edit", tokenBudget };
      }
      if (/^(--unbounded|--no-budget)$/i.test(value)) return { kind: "edit", tokenBudget: null };
      const parsed = parseCoreSetGoal(value);
      if (parsed.kind === "invalid") return parsed;
      if (parsed.objective.length > 4000) return { kind: "invalid", reason: "too_long" };
      return { kind: "edit", objective: parsed.objective,
        ...(parsed.tokenBudget !== null || parsed.explicitUnbounded ? { tokenBudget: parsed.tokenBudget } : {}) };
    }
  }
  const parsed = parseCoreSetGoal(rest);
  if ((engine === "codex" || engine === "claude" || engine === "omp") && parsed.kind === "set" && parsed.objective.length > 4000) return { kind: "invalid", reason: "too_long" };
  return parsed;
}

/** Only existing-goal controls may bypass the ordinary chat queue. A new
 * objective (including --budget) keeps normal admission and preparation. */
export function isCoreGoalControlCommand(text: string): boolean {
  const action = parseCoreGoalCommand(text, "codex");
  return !!action && action.kind !== "set";
}

export function isRestartCommand(text: string): boolean {
  return /^\/restart(?:\s|$)/i.test(text.trim());
}

export function isStopCommand(text: string): boolean {
  return /^\/stop(?:\s|$)/i.test(text.trim());
}

function renderCoreHelpMessage(locale: Locale = "zh", supportsRestart = false): string {
  const help = hostT(
    locale,
    "**TaroCub · 飞书/Lark**\n\n直接发消息就能用 —— 私聊直接发，群里 @我 触发。也能发文件、图片、音视频（短音频走本地 Qwen ASR，长音频在已配置时走通义听悟）。大部分设置走 `/config` 交互面板。\n\n**会话**\n- `/status` 当前会话 · `/stop` 停当前任务（排队任务在各自排队卡片上取消）· `/reset` 重置会话\n- `/resume [编号]` 选 Claude/Kimi/DeepSeek Harness/Antigravity/Pi 会话 · Claude `/resume <完整 ID>` · Codex `/resume thread <id>` · Kimi/DeepSeek 也支持 `/resume session <id>` · `/detach` 解绑\n- `/goal […]` 设会话目标 · `/btw <问题>` 旁问不影响会话 · `/continue` 继续等待中的压缩包分析\n- `/q <消息>` 强制排队 — Codex/DeepSeek 任务运行中纯文本会注入当前任务，`/q` 则排在后面单独执行\n- `/bg` 列出本实例引擎/后台进程 · `/bg kill <pid>` 停指定进程树 · `/bg killall` 清理孤儿后台进程\n\n**设置**\n- `/config` 交互配置面板（推荐）· `/usage` 用量 · `/account` 当前绑定的飞书应用\n- `/model` · `/effort` · `/engine [claude|codex|kimi|deepseek|antigravity|pi]` · `/fast` Codex 快速模式 · `/yolo` 审批模式\n- `/stream [on|off]` 回答卡片打字机流式开关（off = 整卡刷新）\n- `/timeout [on|off]` 引擎运行时保护（硬上限和/或静默看门狗；off 会全部关闭）\n- `/steer [on|off|<秒数>|unlimited]` 任务中途引导的资格窗口（默认 30 秒，超窗排队）\n\n**群**\n- `/newgroup <名>` / `/newgroup topic <名>` / `/newtopic <名>` 新建并授权普通群 / 话题群（你是群主）\n- `/group [status|allow|deny|all|at]` 群授权与回复模式（`all`=不@也回，`at`=只@才回）\n- `/invite group|user @某人` · `/remove …` 群/用户授权 · `/cron …` 定时提醒与任务\n\n**进阶与协作**\n- `/board …` 持久任务板 · `/mini …` 把群 thread 注册成 peer 互联 · `/ask <实例> <提示>` 委托给别的 bot\n- `/fan` · `/chain` · `/verify` Agent Bus 并行 / 串联 / 验证\n- `/context` Claude/DeepSeek 上下文 · `/compact` Claude/Kimi/DeepSeek 压缩 · `/ultrareview` Claude 深度审查\n- `/approve [session]` · `/deny` 卡片按钮不可用时用文字处理审批\n\n完整命令表见 README 的 Slash Command Index。群里普通消息默认要@；`/group all` 开非@（应用还需有 `im:message` + `im:message.group_msg`）。若开了非@群消息仍收不到，运行 `node dist/src/index.js lark doctor`。",
  );
  if (!supportsRestart) return help;
  // Only engines whose adapter can end a session's process list /restart, under the /status line.
  const restart = hostT(locale, "- `/restart` 结束引擎进程，保留会话，下次发消息时启动");
  return help.replace(/^- `\/status`.*$/m, line => `${line}\n${restart}`);
}

function isGroupCommand(text: string): boolean {
  return /^\/group(?:\s|$)/i.test(text.trim());
}

function isCoreInviteRemoveCommand(text: string): boolean {
  return /^\/(?:invite|remove)(?:\s|$)/i.test(text.trim());
}

function extractCoreInviteRemoveCommandName(text: string): "/invite" | "/remove" {
  return /^\/remove(?:\s|$)/i.test(text.trim()) ? "/remove" : "/invite";
}

async function handleCoreInviteRemoveCommand(
  input: CoreCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<void> {
  const words = commandText.trim().split(/\s+/);
  const command = words[0]?.toLowerCase() === "/remove" ? "remove" : "invite";
  const targetKind = words[1]?.toLowerCase() ?? "group";
  const detail = command === "remove" ? "/remove" : "/invite";

  if (targetKind === "group") {
    const groupCommand = command === "remove" ? "/group deny" : "/group allow";
    await sendCoreMarkdown(
      input.channel,
      normalized.chatId,
      await renderAndApplyCoreGroupCommand(input, normalized, groupCommand, locale),
      coreAccessCommandReplyOptions(normalized),
    );
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "success",
      detail,
      metadata: { target: "group" },
    });
    return;
  }

  if (targetKind !== "user") {
    await sendCoreMarkdown(
      input.channel,
      normalized.chatId,
      renderCoreInviteRemoveUsage(command, locale),
      coreAccessCommandReplyOptions(normalized),
    );
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "error",
      detail,
      metadata: { reason: "unsupported-target", target: targetKind },
    });
    return;
  }

  const target = extractFirstCoreMentionTarget(normalized.mentions);
  if (!target) {
    await sendCoreMarkdown(
      input.channel,
      normalized.chatId,
      renderCoreInviteRemoveMissingMention(command, locale),
      coreAccessCommandReplyOptions(normalized),
    );
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: "error",
      detail,
      metadata: { reason: "missing-user-mention" },
    });
    return;
  }

  const accessStore = new AccessStore(path.join(input.stateDir, "access.json"));
  if (command === "remove") {
    await accessStore.revokeUser(target.bridgeUserId);
  } else {
    await accessStore.allowUser(target.bridgeUserId);
  }

  await sendCoreMarkdown(
    input.channel,
    normalized.chatId,
    renderCoreInviteRemoveUserResult(command, target.label, target.bridgeUserId, locale),
    coreAccessCommandReplyOptions(normalized),
  );
  await appendCoreTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail,
    metadata: {
      target: "user",
      userId: target.bridgeUserId,
    },
  });
}

function coreAccessCommandReplyOptions(normalized: CoreNormalizedBridgeMessage): { replyTo: string; replyInThread?: true } {
  return normalized.threadId
    ? { replyTo: normalized.messageId, replyInThread: true }
    : { replyTo: normalized.messageId };
}

function renderCoreInviteRemoveUsage(command: "invite" | "remove", locale: Locale): string {
  return command === "invite"
    ? hostT(locale, "用法：`/invite group` 或 `/invite user @某人`。")
    : hostT(locale, "用法：`/remove group` 或 `/remove user @某人`。");
}

function renderCoreInviteRemoveMissingMention(command: "invite" | "remove", locale: Locale): string {
  return command === "invite"
    ? hostT(locale, "请 @ 要邀请的用户：`/invite user @某人`。")
    : hostT(locale, "请 @ 要移除的用户：`/remove user @某人`。");
}

function renderCoreInviteRemoveUserResult(
  command: "invite" | "remove",
  label: string,
  userId: number,
  locale: Locale,
): string {
  return command === "invite"
    ? hostT(locale, "已邀请用户 {0} ({1})。", label, userId)
    : hostT(locale, "已移除用户 {0} ({1})。", label, userId);
}

function extractFirstCoreMentionTarget(mentions: unknown[]): { label: string; bridgeUserId: number } | null {
  for (const mention of mentions) {
    const record = isRecord(mention) ? mention : {};
    // The SDK includes the bot itself in mentions for commands such as
    // `@Bot /remove user @Alice`. Never treat that routing mention as the user
    // target, otherwise the command reports success while Alice remains allowed.
    if (record.isBot === true || record.is_bot === true) {
      continue;
    }
    const idRecord = isRecord(record.id) ? record.id : {};
    const rawId = firstString(
      idRecord.openId,
      idRecord.open_id,
      idRecord.userId,
      idRecord.user_id,
      idRecord.id,
      record.openId,
      record.open_id,
      record.userId,
      record.user_id,
      record.key,
    );
    if (!rawId) {
      continue;
    }
    const label = firstString(
      record.name,
      record.nameCn,
      record.name_cn,
      record.nameEn,
      record.name_en,
      record.text,
    ) ?? rawId;
    return {
      label,
      bridgeUserId: stableCoreNumericId(`user:${rawId}`),
    };
  }
  return null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function renderAndApplyCoreGroupCommand(
  input: CoreCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<string> {
  const action = commandText.trim().split(/\s+/)[1]?.toLowerCase() ?? "status";
  const store = new CoreGroupModeStore(input.stateDir);
  const isGroup = normalized.bridgeChatType === "group";
  if (isGroup && (action === "allow" || action === "add")) {
    await updateCoreGroupMode(input.stateDir, (groupMode) => {
      allowCoreGroup(groupMode, normalized.bridgeAccessChatId);
    });
  } else if (isGroup && (action === "deny" || action === "remove" || action === "rm")) {
    await updateCoreGroupMode(input.stateDir, (groupMode) => {
      groupMode.allowedChatIds = groupMode.allowedChatIds.filter((chatId) => !isCurrentCoreGroupNumericId(chatId, normalized));
      groupMode.listenAllChatIds = groupMode.listenAllChatIds.filter((chatId) => !isCurrentCoreGroupNumericId(chatId, normalized));
    });
    await store.setListenAll(normalized.chatId, false);
  } else if (action === "on" || action === "enable") {
    await updateCoreGroupMode(input.stateDir, (groupMode) => {
      groupMode.enabled = true;
    });
  } else if (action === "off" || action === "disable") {
    await updateCoreGroupMode(input.stateDir, (groupMode) => {
      groupMode.enabled = false;
      groupMode.listenAllChatIds = [];
    });
    await store.clearListenAll();
  } else if (isGroup && (action === "all" || action === "listen-all")) {
    await updateCoreGroupMode(input.stateDir, (groupMode) => {
      allowCoreGroup(groupMode, normalized.bridgeAccessChatId);
      if (!groupMode.listenAllChatIds.includes(normalized.bridgeAccessChatId)) {
        groupMode.listenAllChatIds.push(normalized.bridgeAccessChatId);
      }
    });
    await store.setListenAll(normalized.chatId, true);
  } else if (
    isGroup &&
    (action === "at" || action === "mention" || action === "mentions" || action === "listen-mentions")
  ) {
    await updateCoreGroupMode(input.stateDir, (groupMode) => {
      allowCoreGroup(groupMode, normalized.bridgeAccessChatId);
      groupMode.listenAllChatIds = groupMode.listenAllChatIds.filter((chatId) => !isCurrentCoreGroupNumericId(chatId, normalized));
    });
    await store.setListenAll(normalized.chatId, false);
  }
  const storedListenAll = normalized.bridgeChatType === "group" ? await store.isListenAll(normalized.chatId) : false;
  const countListenAll = await store.countListenAll();
  const groupMode = (await loadInstanceConfig(input.stateDir)).groupMode;
  const groupAllowed = normalized.bridgeChatType === "group" &&
    isConfiguredCoreGroupAllowed(groupMode, normalized.bridgeChatId, normalized.bridgeAccessChatId);
  const listenAll = normalized.bridgeChatType === "group" && groupMode.enabled && (
    storedListenAll || isConfiguredCoreListenAll(groupMode, normalized.bridgeChatId, normalized.bridgeAccessChatId)
  );
  const requiresMention = !groupMode.enabled || (input.requireMentionInGroup !== false && !listenAll);
  const status = renderCoreGroupModeStatus({
    locale,
    isGroup: normalized.bridgeChatType === "group",
    groupEnabled: groupMode.enabled,
    groupAllowed,
    bridgeChatId: normalized.bridgeAccessChatId,
    requiresMention,
    allowedCount: groupMode.allowedChatIds.length,
    listenAllCount: countListenAll,
  });
  if (action === "status") {
    return status;
  }
  if (action === "all" || action === "listen-all") {
    if (normalized.bridgeChatType !== "group") {
      return hostT(locale, "{0}\n\n请在要开启全量监听的飞书群里发送 /group all。", status);
    }
    const base = hostT(locale, "{0}\n\n当前飞书群已切到：监听所有普通消息。", status);
    // Proactively warn if the app lacks im:message.group_msg — without it,
    // non-@ group messages never arrive, so listen-all has no effect. Best-effort:
    // "unknown" (no creds / API failure) stays silent.
    const scopeStatus = await checkGroupMsgScope({
      appId: input.runtime.appInfo?.appId ?? process.env.LARK_APP_ID,
      appSecret: input.runtime.appInfo?.appSecret ?? process.env.LARK_APP_SECRET,
      domain: input.runtime.appInfo?.domain,
    });
    if (scopeStatus === "missing") {
      const warning = renderGroupMsgScopeWarning(
        locale,
        input.runtime.appInfo?.appId,
        input.runtime.appInfo?.domain,
        input.instanceName,
      );
      return `${base}\n\n${warning}`;
    }
    return base;
  }
  if (action === "at" || action === "mention" || action === "mentions" || action === "listen-mentions") {
    return normalized.bridgeChatType === "group"
      ? hostT(locale, "{0}\n\n当前飞书群已切到：只响应 @bot / mention。", status)
      : hostT(locale, "{0}\n\n请在要恢复 @bot 模式的飞书群里发送 /group at。", status);
  }
  if (action === "allow" || action === "add") {
    return normalized.bridgeChatType === "group"
      ? hostT(locale, "{0}\n\n已允许当前飞书群 ({1})。群内仍只有已授权用户可使用。", status, normalized.bridgeAccessChatId)
      : hostT(locale, "{0}\n\n请在要启用的飞书群里发送 /group allow。", status);
  }
  if (action === "deny" || action === "remove" || action === "rm") {
    return normalized.bridgeChatType === "group"
      ? hostT(locale, "{0}\n\n已移除当前飞书群 ({1})。", status, normalized.bridgeAccessChatId)
      : hostT(locale, "{0}\n\n请在要移除的飞书群里发送 /group deny。", status);
  }
  if (action === "on" || action === "enable") {
    return hostT(locale, "{0}\n\nLark 群聊模式已开启。", status);
  }
  if (action === "off" || action === "disable") {
    return hostT(locale, "{0}\n\nLark 群聊模式已关闭。", status);
  }
  return hostT(locale, "{0}\n\nLark 支持 `/group status|allow|deny|on|off|all|at`。", status);
}

function renderCoreGroupModeStatus(input: {
  locale: Locale;
  isGroup: boolean;
  groupEnabled: boolean;
  groupAllowed: boolean;
  bridgeChatId: number;
  requiresMention: boolean;
  allowedCount: number;
  listenAllCount: number;
}): string {
  const { locale } = input;
  return [
    hostT(locale, "**Lark 群聊模式**"),
    "",
    hostT(locale, "- 群聊模式：{0}", hostT(locale, input.groupEnabled ? "开启" : "关闭")),
    ...(input.isGroup ? [hostT(locale, "- 当前群：{0} ({1})", hostT(locale, input.groupAllowed ? "已允许" : "未允许"), input.bridgeChatId)] : []),
    hostT(locale, "- 当前触发：{0}", hostT(locale, input.requiresMention ? "需要 @bot / mention" : "接受普通群消息")),
    hostT(locale, "- 已允许的 Lark 群数：{0}", input.allowedCount),
    hostT(locale, "- 正在监听普通消息的 Lark 群数：{0}", input.listenAllCount),
    hostT(locale, "- 访问控制：授权用户可在 Lark 群内使用 `/group allow|deny`；CLI 侧仍用 `lark access` 管理用户/私聊。"),
    hostT(locale, "- 全局默认：`LARK_REQUIRE_MENTION_IN_GROUP=1` 时需要 @bot，除非当前群使用 `/group all`。"),
    hostT(locale, "- 平台要求：`/group all` 还需要飞书/Lark 应用权限 `im:message` 和 `im:message.group_msg`；普通群消息仍收不到时，请运行 `lark doctor` 检查。"),
  ].join("\n");
}

async function updateCoreGroupMode(stateDir: string, updater: (groupMode: GroupModeConfig) => void): Promise<void> {
  await updateInstanceConfig(stateDir, (config) => {
    const groupMode = currentCoreGroupMode(config);
    updater(groupMode);
    config.groupMode = normalizeCoreGroupMode(groupMode);
  });
}

function currentCoreGroupMode(config: Record<string, unknown>): GroupModeConfig {
  const raw = typeof config.groupMode === "object" && config.groupMode !== null
    ? config.groupMode as Record<string, unknown>
    : {};
  return normalizeCoreGroupMode({
    enabled: raw.enabled === false ? false : true,
    allowedChatIds: Array.isArray(raw.allowedChatIds)
      ? raw.allowedChatIds.filter((value): value is number => Number.isInteger(value))
      : [],
    listenAllChatIds: Array.isArray(raw.listenAllChatIds)
      ? raw.listenAllChatIds.filter((value): value is number => Number.isInteger(value))
      : [],
  });
}

function normalizeCoreGroupMode(groupMode: GroupModeConfig): GroupModeConfig {
  return {
    enabled: groupMode.enabled,
    allowedChatIds: [...new Set(groupMode.allowedChatIds)],
    listenAllChatIds: groupMode.enabled ? [...new Set(groupMode.listenAllChatIds)] : [],
  };
}

function allowCoreGroup(groupMode: GroupModeConfig, chatId: number): void {
  groupMode.enabled = true;
  if (!groupMode.allowedChatIds.includes(chatId)) {
    groupMode.allowedChatIds.push(chatId);
  }
}

async function renderCoreStatusMessage(
  runtime: CoreServiceRuntime,
  normalized: CoreNormalizedBridgeMessage,
  stateDir: string,
  locale: Locale,
  requireMentionInGroup?: boolean,
): Promise<string> {
  const cfg = await loadInstanceConfig(stateDir);
  const codexDefaults = cfg.engine === "codex" ? await loadCodexUserDefaults() : undefined;
  const rawConfig = await readRawCoreConfig(stateDir);
  const knownChat = await new CoreKnownChatStore(stateDir).get(normalized.conversationKey).catch(() => null);
  const session = await new SessionStore(path.join(stateDir, "session.json"))
    .findByConversationKeySafe(normalized.conversationKey);
  const currentSession = session.record;
  const workflowLines = await renderCoreWorkflowStatusLines(stateDir, normalized.bridgeChatId, locale);
  const groupModeLines = normalized.bridgeChatType === "group"
    ? await renderCoreGroupModeStatusLines({
      stateDir,
      chatId: normalized.chatId,
      bridgeChatId: normalized.bridgeChatId,
      bridgeAccessChatId: normalized.bridgeAccessChatId,
      groupMode: cfg.groupMode,
      locale,
      requireMentionInGroup,
    })
    : [];
  const larkCliStatus = channelProfile() === "gateway" ? { available: false } : await runtime.detectLarkCli().catch((error): LarkCliStatus => ({
    available: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  const activeRun = runtime.activeRuns.has(normalized.conversationKey);
  return [
    hostT(locale, channelProfile() === "gateway" ? "**TaroBird App 会话状态**" : "**Lark 会话状态**"),
    "",
    hostT(locale, "引擎：{0}", cfg.engine),
    hostT(locale, "模型：{0}", renderEngineModelSetting(cfg.engine, cfg.model, codexDefaults, locale)),
    hostT(locale, "推理强度：{0}", renderEngineEffortSetting(cfg.engine, cfg.effort, codexDefaults, locale)),
    hostT(locale, "Codex Fast Mode：{0}", hostT(locale, cfg.codexServiceTier === "fast" ? "开启" : "关闭")),
    hostT(locale, "审批模式：{0}", renderApprovalModeStatus(
      cfg.engine,
      rawConfig.approvalMode,
      locale,
      rawConfig.kimiAutoNeverAskAcknowledged,
    )),
    cfg.budgetUsd !== undefined ? hostT(locale, "预算：{0}", `$${cfg.budgetUsd.toFixed(2)}`) : hostT(locale, "预算：无"),
    // Kimi omits usage entirely and DeepSeek omits dollar cost. Show those
    // telemetry limits even without a budget so status never implies complete
    // accounting; other non-Claude engines need the warning only when a cap exists.
    ...(cfg.engine === "kimi" || cfg.engine === "deepseek"
      ? [renderCoreEngineUsageNote(cfg.engine, locale, cfg.budgetUsd !== undefined)]
      : cfg.budgetUsd !== undefined && cfg.engine !== "claude"
        ? [renderCoreEngineUsageNote(cfg.engine, locale, true)]
        : []),
    hostT(locale, "语言：{0}", locale),
    hostT(locale, "详细度：{0}", cfg.verbosity),
    hostT(locale, "时区：{0}", cfg.timezone),
    ...(channelProfile() === "gateway" ? [] : [hostT(locale, "Lark CLI：{0}", renderCoreCliStatus(larkCliStatus, locale))]),
    hostT(locale, "当前聊天：{0}", knownChat?.label ?? normalized.chatId),
    hostT(locale, "会话：{0}", normalized.conversationKey),
    hostT(locale, "聊天类型：{0}", normalized.bridgeChatType),
    ...groupModeLines,
    session.warning
      ? hostT(locale, "会话绑定：未知（{0}）", session.warning)
      : hostT(locale, currentSession ? "会话绑定：是" : "会话绑定：否"),
    ...(cfg.engine === "codex" && currentSession ? [hostT(locale, "当前 thread：{0}", currentSession.codexSessionId)] : []),
    ...(cfg.engine === "antigravity" && currentSession ? [hostT(locale, "当前 conversation：{0}", currentSession.codexSessionId)] : []),
    ...(cfg.engine === "kimi" && currentSession ? [hostT(locale, "当前 Kimi session：{0}", currentSession.codexSessionId)] : []),
    ...(cfg.engine === "deepseek" && currentSession ? [hostT(locale, "当前 DeepSeek Harness session：{0}", currentSession.codexSessionId)] : []),
    ...(cfg.engine === "pi" && currentSession ? [hostT(locale, "当前 Pi session：{0}", currentSession.codexSessionId)] : []),
    ...(cfg.engine === "omp" && currentSession ? [hostT(locale, "当前 omp session：{0}", currentSession.codexSessionId)] : []),
    ...workflowLines,
    hostT(locale, activeRun ? "当前运行：是" : "当前运行：否"),
    hostT(locale, "待处理审批：{0}", runtime.pendingApprovals.size),
  ].join("\n");
}

/**
 * One-line caveat shown next to a configured budget on non-Claude engines:
 * Non-Claude engines do not currently report dollar cost, so budgetUsd can never
 * trip there — pretending otherwise would be a false safety net.
 */
function renderCoreEngineUsageNote(engine: InstanceConfig["engine"], locale: Locale, budgetConfigured: boolean): string {
  if (engine === "pi") {
    return hostT(locale, "Pi 会记录提供商返回的用量和费用，费用可能为估算值；主机预算检查不等于原生单轮费用上限。");
  }
  if (engine === "omp") {
    return hostT(locale, "omp 会记录提供商返回的用量和费用，费用可能为估算值；主机预算检查不等于原生单轮费用上限。");
  }
  if (engine === "kimi") {
    const budgetSuffix = budgetConfigured ? hostT(locale, "，已配置的预算上限也无法追踪它们") : "";
    return hostT(locale, "注意：Kimi ACP 当前不上报结构化的单轮 token 或费用；这些累计数据不包含 Kimi turn{0}。", budgetSuffix);
  }
  if (engine === "deepseek") {
    const budgetSuffix = budgetConfigured ? hostT(locale, "；已配置的预算上限无法追踪或约束 DeepSeek turn") : "";
    return hostT(locale, "注意：DeepSeek Harness 会上报 token 用量，但不上报美元费用{0}。", budgetSuffix);
  }
  return hostT(locale, "注意：Codex/Antigravity 引擎不上报美元成本，预算上限目前只对 Claude 生效。");
}

function renderCoreCliStatus(status: LarkCliStatus, locale: Locale): string {
  if (status.available) {
    return status.version
      ? hostT(locale, "可用（{0}）", status.version)
      : hostT(locale, "可用");
  }
  const detail = status.error ? ` (${truncateCoreStatusDetail(status.error)})` : "";
  return hostT(locale, "不可用{0}", detail);
}

function truncateCoreStatusDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function isBlockingWorkflowStatus(status: FileWorkflowStatus): boolean {
  return status === "preparing" || status === "processing" || status === "failed";
}

async function renderCoreWorkflowStatusLines(stateDir: string, chatId: number, locale: Locale): Promise<string[]> {
  const workflowResult = await new FileWorkflowStore(stateDir).inspect();
  if (workflowResult.warning) {
    return [hostT(locale, "工作流：未知（{0}）", workflowResult.warning)];
  }
  const records = workflowResult.state.records.filter((record) => record.chatId === chatId);
  const blocking = records.filter((record) => isBlockingWorkflowStatus(record.status)).length;
  const waiting = records.filter((record) => record.status === "awaiting_continue").length;
  return [
    hostT(locale, "阻塞工作流：{0}", blocking),
    hostT(locale, "等待工作流：{0}", waiting),
  ];
}

async function renderCoreGroupModeStatusLines(input: {
  stateDir: string;
  chatId: string;
  bridgeChatId: number;
  bridgeAccessChatId: number;
  groupMode: GroupModeConfig;
  locale: Locale;
  requireMentionInGroup?: boolean;
}): Promise<string[]> {
  if (channelProfile() === "gateway") return [await applyGatewayGroupMode(input.stateDir, input.chatId, true, "status", input.locale, input.requireMentionInGroup !== false)];
  const store = new CoreGroupModeStore(input.stateDir);
  const listenAll = input.groupMode.enabled && (
    await store.isListenAll(input.chatId) ||
    isConfiguredCoreListenAll(input.groupMode, input.bridgeChatId, input.bridgeAccessChatId)
  );
  const requiresMention = !input.groupMode.enabled || (input.requireMentionInGroup !== false && !listenAll);
  const { locale } = input;
  const source = !input.groupMode.enabled
    ? hostT(locale, "群聊模式已关闭")
    : listenAll
      ? "/group all override"
      : input.requireMentionInGroup === false
        ? hostT(locale, "全局已关闭 @bot 要求")
        : hostT(locale, "默认 @bot 模式");
  return [
    hostT(locale, requiresMention ? "群聊触发：需要 @bot / mention" : "群聊触发：接受普通群消息"),
    hostT(locale, "群聊模式来源：{0}", source),
  ];
}

function isConfiguredCoreListenAll(groupMode: GroupModeConfig, bridgeChatId: number, bridgeAccessChatId: number): boolean {
  return groupMode.listenAllChatIds.includes(bridgeAccessChatId) || groupMode.listenAllChatIds.includes(bridgeChatId);
}

function isConfiguredCoreGroupAllowed(groupMode: GroupModeConfig, bridgeChatId: number, bridgeAccessChatId: number): boolean {
  return groupMode.allowedChatIds.includes(bridgeAccessChatId) || groupMode.allowedChatIds.includes(bridgeChatId);
}

function isCurrentCoreGroupNumericId(chatId: number, normalized: CoreNormalizedBridgeMessage): boolean {
  return chatId === normalized.bridgeAccessChatId || chatId === normalized.bridgeChatId;
}

function isSingleTokenCoreModelName(model: string): boolean {
  return !/\s/.test(model);
}

function renderCoreModelSelectionMessage(cfg: InstanceConfig, locale: Locale): string {
  const current = cfg.model ?? "default";
  if (cfg.engine === "claude") {
    return hostT(
      locale,
      "当前模型: `{0}`\n用 /model <名称> 选择模型：\n{1}\n`/model off`\n跟随最新 Opus 的别名：`/model opus[1m]`",
      current,
      CLAUDE_MODEL_CHOICES.map((model) => `\`/model ${model}\``).join("\n"),
    );
  }
  if (cfg.engine === "codex") {
    return hostT(
      locale,
      "当前模型: {0}\n用 /model <名称> 选择模型：\n{1}\n/model off\n{2}",
      current,
      CODEX_MODEL_CHOICES.map((model) => `/model ${model}`).join("\n"),
      hostT(locale, "Astra/Sol/Terra 支持 max 和 ultra；Luna 支持 max，但不支持 ultra。"),
    );
  }
  if (cfg.engine === "kimi") {
    return hostT(
      locale,
      "当前模型: {0}\n用 /model <id> 设置当前 Kimi provider 配置实际提供的模型。\n/model off\n下一轮开始时会通过 ACP 校验该模型 ID。",
      current,
    );
  }
  if (cfg.engine === "deepseek") {
    return hostT(
      locale,
      "当前模型: {0}\n用 /model <provider/model> 或 /model <model-id> 选择 DeepSeek Harness 提供的模型。\n/model off\nDeepSeek Harness 会通过 session model API 校验该选择。",
      current,
    );
  }
  if (cfg.engine === "omp") {
    return hostT(
      locale,
      "当前模型: {0}\n用 /model <provider/model> 选择 oh-my-pi (omp) 提供的模型。\n/model off\nomp 会通过 RPC 会话模型 API 校验该选择。",
      current,
    );
  }
  return hostT(
    locale,
    "当前模型: {0}\n用 /model <id> 设置 agy models 列出的模型；下一轮启动时由 agy 校验。\n/model off",
    current,
  );
}

function deepSeekSettingsError(code: string, locale: Locale): string {
  const description = code.endsWith("conflict")
    ? hostT(locale, "设置已变化，请重新读取后再试。")
    : code.endsWith("incompatible")
      ? hostT(locale, "当前模型未提供这个推理档位。请用 /effort default 或选择支持的档位。")
      : hostT(locale, "DeepSeek 模型目录或所选模型暂不可用。请重新读取目录并检查原生提供商配置。");
  return `${description} (${code})`;
}

async function handleCoreModelCommand(
  stateDir: string,
  cfg: InstanceConfig,
  model: string,
  locale: Locale,
): Promise<string> {
  if (cfg.engine === "deepseek") {
    const before = await modelSettings(stateDir, "deepseek", 0);
    if (!before.ok) return deepSeekSettingsError(before.error, locale);
    if (!model) return [renderCoreModelSelectionMessage(cfg, locale),
      ...(before.settings.catalogStatus === "ready" ? before.settings.choices.filter(choice => choice.id).map(choice => `/model ${choice.id}`) : [deepSeekSettingsError("model_catalog_unavailable", locale)]),
    ].join("\n");
    const selected = ["off", "default"].includes(model) ? "" : model;
    if (selected && (!isSingleTokenCoreModelName(selected) || selected.length > 512)) return hostT(locale, "用法: /model <单个模型名|default>");
    const result = await modelSettings(stateDir, "deepseek", 0, { revision: before.settings.revision, model: selected });
    if (!result.ok) return deepSeekSettingsError(result.error, locale);
    return result.settings.model ? hostT(locale, "模型已设为 `{0}`。", result.settings.model) : hostT(locale, "模型已恢复默认。");
  }
  if (!model) {
    return renderCoreModelSelectionMessage(cfg, locale);
  }
  const normalizedModel = normalizeModelCommandInput(cfg.engine, model);
  if (!isSingleTokenCoreModelName(normalizedModel)) {
    return hostT(locale, "用法: /model <单个模型名|off>");
  }
  if (normalizedModel === "off" || normalizedModel === "default") {
    if (cfg.engine === "codex" && isExtendedCodexEffort(cfg.effort)) {
      return hostT(locale, "当前 effort 为 {0}，不能恢复默认模型；请先重置 /effort。", cfg.effort);
    }
    await updateInstanceConfig(stateDir, (config) => {
      delete config.model;
    });
    return hostT(locale, "模型已恢复默认。");
  }
  if (
    cfg.engine === "codex" &&
    cfg.effort &&
    (knownCodexModelSupportsEffort(normalizedModel, cfg.effort) === false ||
      (knownCodexModelSupportsEffort(normalizedModel, cfg.effort) === undefined && isExtendedCodexEffort(cfg.effort)))
  ) {
    const maxEffort = knownCodexModelMaxEffort(normalizedModel);
    return maxEffort
      ? hostT(locale, "{0} 最高支持 {1}，与当前 effort {2} 不兼容；请先调整 /effort。", normalizedModel, maxEffort, cfg.effort)
      : hostT(locale, "无法确认 {0} 是否支持 {1}；请先降低 /effort 或选择列表中的模型。", normalizedModel, cfg.effort);
  }
  if (cfg.engine === "antigravity" && cfg.effort && antigravityPresetEffort(normalizedModel) && antigravityPresetEffort(normalizedModel) !== cfg.effort) {
    return hostT(locale, "{0} 与当前 effort {1} 不兼容；请先用 /effort default 重置，再切换模型。", normalizedModel, cfg.effort);
  }
  if (cfg.engine === "omp" && !decodePiModel(normalizedModel)) {
    return !isChineseLocale(locale)
      ? "omp models require a provider prefix, such as /model provider/model (or /model off)."
      : "omp 模型必须包含提供商前缀，例如 /model provider/model（或 /model off）。";
  }
  await updateInstanceConfig(stateDir, (config) => {
    config.model = normalizedModel;
  });
  return hostT(locale, "模型已设为 `{0}`。", normalizedModel);
}

async function handleCoreEffortCommand(
  stateDir: string,
  cfg: InstanceConfig,
  level: string,
  locale: Locale,
): Promise<string> {
  // Pi has a per-conversation level (/thinking) besides this Bot-wide default, so its replies name the scope.
  if (!level) {
    if (cfg.engine === "pi") {
      return hostT(locale, "Bot 默认思考强度：{0}。它作用于整个 Bot：改动后，这个 Bot 的所有对话从下一轮起都改用新档位。查看或调整当前对话请用 /thinking。", cfg.effort ?? "default");
    }
    return hostT(locale, "当前 effort: {0}", cfg.effort ?? "default");
  }
  if (cfg.engine === "deepseek") {
    const effort = level === "default" ? "" : level;
    if (!effortValueSchema.safeParse(effort).success) return deepSeekSettingsError("effort_incompatible", locale);
    const before = await effortSettings(stateDir, "deepseek", 0);
    if (!before.ok) return deepSeekSettingsError(before.error, locale);
    const result = await effortSettings(stateDir, "deepseek", 0, { revision: before.settings.revision, effort });
    if (!result.ok) return deepSeekSettingsError(result.error, locale);
    return effort ? hostT(locale, "Effort 已设为 {0}。", effort) : hostT(locale, "Effort 已恢复默认。");
  }
  if (level === "default" || level === "off" && cfg.engine !== "pi" && cfg.engine !== "omp") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.effort;
    });
    if (cfg.engine === "pi") {
      return hostT(locale, "已清除 Bot 默认思考强度，作用于整个 Bot：仍在用 Bot 所设档位的对话恢复到之前的档位；用 /thinking 自己选的保持不变。只改当前对话请用 /thinking。");
    }
    return hostT(locale, "Effort 已恢复默认。");
  }
  if (cfg.engine === "pi") {
    const models = await modelCatalog("pi", process.env, cfg.workspacePath ?? cfg.resume?.workspacePath ?? path.join(stateDir, "workspace"));
    const levels = modelEffortChoices("pi", cfg.model ?? "", models);
    if (!PI_THINKING_LEVELS.includes(level as typeof PI_THINKING_LEVELS[number]) || !levels.includes(level as EffortLevel)) {
      return hostT(locale, "Pi 尚未确认当前模型支持这个思考档位。请重新读取模型列表，或使用 /effort default。");
    }
    await updateInstanceConfig(stateDir, config => { config.effort = level; });
    return hostT(locale, "已把 Bot 默认思考强度设为 {0}，作用于整个 Bot：这个 Bot 的所有对话从下一轮起都改用这一档，包括在对话里用 /thinking 选过档位的。只改当前对话请用 /thinking {0}。", level);
  }
  if (cfg.engine === "omp") {
    if (!PI_THINKING_LEVELS.includes(level as typeof PI_THINKING_LEVELS[number])) {
      return !isChineseLocale(locale)
        ? `omp thinking level supports only ${PI_THINKING_LEVELS.join(", ")}, or default.`
        : `omp 思考强度仅支持 ${PI_THINKING_LEVELS.join("、")} 或 default。`;
    }
    const catalog = await readModelCatalog("omp", process.env, cfg.workspacePath ?? cfg.resume?.workspacePath ?? path.join(stateDir, "workspace"));
    if (catalog.status === "ready") {
      const levels = modelEffortChoices("omp", cfg.model ?? "", catalog.choices);
      const modelKnown = !cfg.model || catalog.choices.some(choice => choice.id === cfg.model);
      if (modelKnown && !levels.includes(level as EffortLevel)) {
        return !isChineseLocale(locale)
          ? "omp has not confirmed this thinking level for the selected model. Refresh the model list or use /effort default."
          : "omp 尚未确认当前模型支持这个思考档位。请重新读取模型列表，或使用 /effort default。";
      }
    }
    await updateInstanceConfig(stateDir, config => { config.effort = level; });
    return !isChineseLocale(locale) ? `Effort set to ${level}.` : `Effort 已设为 ${level}。`;
  }
  if (cfg.engine === "claude" && level === "ultra") {
    return hostT(locale, "Claude 不支持 ultra；最高可用 max。");
  }
  if (cfg.engine === "kimi" && !KIMI_EFFORT_LEVELS.includes(level as (typeof KIMI_EFFORT_LEVELS)[number])) {
    return hostT(locale, "Kimi effort 仅支持 low、high、max 或 off。");
  }
  if (cfg.engine === "antigravity" && !ANTIGRAVITY_EFFORT_LEVELS.includes(level as (typeof ANTIGRAVITY_EFFORT_LEVELS)[number])) {
    return hostT(locale, "Antigravity effort 仅支持 low、medium、high、xhigh、max 或 off。");
  }
  if (!VALID_LARK_EFFORT_LEVELS.includes(level as EffortLevel)) {
    return hostT(locale, "用法: /effort [low|medium|high|xhigh|max|ultra|off]");
  }
  if (cfg.engine === "claude" && getEngineEffortValidationError(cfg.engine, level as EffortLevel, cfg.model)) {
    return hostT(locale, "当前 Claude 模型不支持 {0}。", level);
  }
  if (cfg.engine === "antigravity" && antigravityPresetEffort(cfg.model) && antigravityPresetEffort(cfg.model) !== level) {
    return hostT(locale, "{0} 与 effort {1} 不兼容；请选择对应强度的模型，或用 /effort default 重置。", cfg.model ?? "", level);
  }
  if (cfg.engine === "codex") {
    const effort = level as EffortLevel;
    const support = knownCodexModelSupportsEffort(cfg.model, effort);
    if (support === false || (support === undefined && isExtendedCodexEffort(effort))) {
      const maxEffort = knownCodexModelMaxEffort(cfg.model);
      return maxEffort
        ? hostT(locale, "{0} 不支持 {1}；最高可用 {2}。", cfg.model ?? "", level, maxEffort)
        : hostT(locale, "请先选择明确兼容的模型再设置 {0}（例如 /model gpt-5.6-sol）。", level);
    }
  }
  await updateInstanceConfig(stateDir, (config) => {
    config.effort = level;
  });
  return hostT(locale, "Effort 已设为 {0}。", level);
}

async function handleCoreFastCommand(stateDir: string, cfg: InstanceConfig, action: string, locale: Locale): Promise<string> {
  if (cfg.engine !== "codex") {
    return hostT(locale, "Fast Mode 仅 Codex 支持。");
  }
  if (action === "on" || action === "enable" || action === "fast") {
    await updateInstanceConfig(stateDir, (config) => {
      config.codexServiceTier = "fast";
    });
    return hostT(locale, "Codex Fast Mode 已开启。支持的模型会更快，但会消耗更多 credits。");
  }
  if (action === "off" || action === "disable" || action === "standard" || action === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.codexServiceTier;
    });
    return hostT(locale, "Codex Fast Mode 已关闭。");
  }
  if (action === "status") {
    return hostT(locale, "Codex Fast Mode：{0}", hostT(locale, cfg.codexServiceTier === "fast" ? "开启" : "关闭"));
  }
  return hostT(locale, "用法: /fast [on|off|status]");
}

// /stream toggles Lark element-level streaming (the native typewriter on run
// cards). Off = every update goes through the full-card patch path — the
// pre-v0.1.160 behavior. Instance-level, persisted; applies from the NEXT
// turn (the running turn's controller already captured the flag).
async function handleCoreStreamCommand(stateDir: string, cfg: InstanceConfig, action: string, locale: Locale): Promise<string> {
  const envOff = ["off", "0", "false"].includes((process.env.TAROBOT_ELEMENT_STREAM ?? process.env.CCTB_LARK_ELEMENT_STREAM ?? "").trim().toLowerCase());
  const envNote = hostT(locale, "\n注意：环境变量 TAROBOT_ELEMENT_STREAM=off 当前强制关闭流式，此设置暂不生效。");
  if (action === "on" || action === "enable") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.elementStream;
    });
    return hostT(locale, "流式打字机已开启，下一轮回答生效。") + (envOff ? envNote : "");
  }
  if (action === "off" || action === "disable") {
    await updateInstanceConfig(stateDir, (config) => {
      config.elementStream = false;
    });
    return hostT(locale, "流式打字机已关闭，回答改回整卡刷新模式（打字机之前的行为），下一轮回答生效。");
  }
  if (action === "status") {
    const configured = cfg.elementStream !== false;
    const effective = configured && !envOff;
    return hostT(locale, "流式打字机：{0}{1}", hostT(locale, effective ? "开启" : "关闭"), configured && envOff ? envNote : "");
  }
  return hostT(locale, "用法: /stream [on|off|status]");
}

async function handleCoreTimeoutCommand(stateDir: string, cfg: InstanceConfig, action: string, locale: Locale): Promise<string> {
  if (action === "off" || action === "disable" || action === "long" || action === "unlimited") {
    await updateInstanceConfig(stateDir, (config) => {
      config.disableRuntimeTimeout = true;
    });
    return renderRuntimeTimeoutMessage(cfg.engine, false, "off", locale);
  }
  if (action === "on" || action === "enable" || action === "default") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.disableRuntimeTimeout;
    });
    return renderRuntimeTimeoutMessage(cfg.engine, true, "on", locale);
  }
  if (action === "status") {
    return renderRuntimeTimeoutMessage(cfg.engine, cfg.disableRuntimeTimeout !== true, "status", locale);
  }
  return hostT(locale, "用法: /timeout [on|off|status]");
}

/**
 * /steer — mid-turn steering policy (instance-level, like /stream and /timeout).
 * A running turn accepts injected follow-ups only within its eligibility window
 * (default 30s); later messages queue as their own turn. `off` disables steering
 * entirely, `<seconds>` tunes the window, `unlimited` (=0) restores steer-any-time.
 */
async function handleCoreSteerCommand(stateDir: string, cfg: InstanceConfig, action: string, locale: Locale): Promise<string> {
  // Codex app-server and DeepSeek Harness can steer active turns. The setting
  // still persists on engines without injection support, so explain that their
  // messages continue to queue instead of implying this toggle changes them.
  const engineNote = cfg.engine === "claude"
    ? hostT(locale, "（注意：当前是 Claude 引擎，不支持任务中途注入——进行中收到的消息本就一律排队；此设置仅在切换到 Codex 或 DeepSeek 引擎后生效。）")
    : cfg.engine === "kimi"
      ? hostT(locale, "（注意：Kimi ACP 不支持任务中途注入——进行中收到的消息会排队成为独立 turn；此设置仅在切换到 Codex 或 DeepSeek 后生效。）")
      : "";
  const describe = (enabled: boolean, windowSeconds: number): string => {
    if (!enabled) {
      return hostT(locale, "引导：已关闭——任务进行中发的消息一律排队作为独立任务执行（/steer on 重新开启）。");
    }
    if (windowSeconds === 0) {
      return hostT(locale, "引导：开启，不限时——任何时刻发消息都注入当前任务（/steer 30 可恢复窗口限制）。");
    }
    return hostT(locale, "引导：开启，资格窗口 {0} 秒——任务开跑 {0} 秒内的消息注入当前任务，之后的消息排队独立执行。（/steer <秒数> 调整，/steer unlimited 不限时，/steer off 关闭）", windowSeconds);
  };
  if (action === "off" || action === "disable") {
    await updateInstanceConfig(stateDir, (config) => {
      config.steerEnabled = false;
    });
    return describe(false, cfg.steerWindowSeconds ?? DEFAULT_STEER_WINDOW_SECONDS) + engineNote;
  }
  if (action === "on" || action === "enable") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.steerEnabled;
    });
    return describe(true, cfg.steerWindowSeconds ?? DEFAULT_STEER_WINDOW_SECONDS) + engineNote;
  }
  if (action === "unlimited" || action === "always" || action === "不限" || action === "0") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.steerEnabled;
      config.steerWindowSeconds = 0;
    });
    return describe(true, 0) + engineNote;
  }
  if (action === "default" || action === "reset") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.steerEnabled;
      delete config.steerWindowSeconds;
    });
    return describe(true, DEFAULT_STEER_WINDOW_SECONDS) + engineNote;
  }
  const secondsMatch = action.match(/^(\d+)\s*(s|秒)?$/) ?? action.match(/^(\d+)\s*(m|分|分钟)$/);
  if (secondsMatch) {
    const raw = Number.parseInt(secondsMatch[1]!, 10);
    const seconds = /m|分/.test(secondsMatch[2] ?? "") ? raw * 60 : raw;
    // Zero in ANY spelling (0s / 0秒 / 0m / 0分 / 0分钟) means unlimited, same
    // as the bare "0" alias above — `/steer 0s` used to error while `/steer 0`
    // lifted the window, which read as arbitrary.
    if (seconds === 0) {
      await updateInstanceConfig(stateDir, (config) => {
        delete config.steerEnabled;
        config.steerWindowSeconds = 0;
      });
      return describe(true, 0) + engineNote;
    }
    if (seconds < 1 || seconds > 86_400) {
      return hostT(locale, "窗口需在 1 秒～24 小时之间（或用 `unlimited` 不限时）。");
    }
    await updateInstanceConfig(stateDir, (config) => {
      delete config.steerEnabled;
      config.steerWindowSeconds = seconds;
    });
    return describe(true, seconds) + engineNote;
  }
  if (action === "status") {
    return describe(cfg.steerEnabled !== false, cfg.steerWindowSeconds ?? DEFAULT_STEER_WINDOW_SECONDS) + engineNote;
  }
  return hostT(locale, "用法: /steer [on|off|<秒数>|unlimited|default|status]");
}

async function handleCoreEngineCommand(
  stateDir: string,
  cfg: InstanceConfig,
  engine: string,
  invalid: boolean,
  locale: Locale,
): Promise<string> {
  const restartNote = channelProfile() === "gateway"
    ? hostT(locale, "请在「运行状态」安排此 Bot 空闲后重启以生效。")
    : hostT(locale, "切换后请重启 Lark service 以生效。");
  if (!engine && !invalid) {
    return hostT(
      locale,
      "当前引擎：{0}\n用 /engine <名称> 选择引擎：\n{1}\n{2}",
      cfg.engine,
      LARK_ENGINE_CHOICES.filter(choice => (choice !== "pi" && choice !== "omp") || cfg.role !== "dispatcher").map((choice) => `/engine ${choice}`).join("\n"),
      restartNote,
    );
  }
  if (invalid || !LARK_ENGINE_CHOICES.includes(engine as InstanceEngine)) {
    return hostT(locale, "用法: /engine [claude|codex|kimi|deepseek|antigravity|pi|omp]");
  }

  const selectedEngine = engine as InstanceEngine;
  if ((selectedEngine === "pi" || selectedEngine === "omp") && cfg.role === "dispatcher") {
    return selectedEngine === "omp"
      ? (!isChineseLocale(locale) ? "omp is available for ordinary Bots, not Superagent Bots." : "omp 仅用于普通 Bot，不支持幕僚长。")
      : (!isChineseLocale(locale) ? "Pi is available for ordinary Bots, not Superagent Bots." : "Pi 仅用于普通 Bot，不支持幕僚长。");
  }
  const engineChanged = cfg.engine !== selectedEngine;
  let resetSessionBindings = false;
  let clearedModel = false;
  let enabledFullAuto = false;
  const persist = () => updateInstanceConfig(stateDir, (config) => {
    const result = applyEngineSelection(config, selectedEngine);
    clearedModel = result.clearedModel;
    enabledFullAuto = result.enabledFullAuto;
  });
  if (engineChanged) {
    const result = await new SessionStore(path.join(stateDir, "session.json")).clearAllThen(persist);
    resetSessionBindings = result.removedCount > 0;
  } else await persist();

  const details: string[] = [];
  if (clearedModel) {
    details.push(hostT(locale, "已清除先前的模型覆盖"));
  }
  if (resetSessionBindings) {
    details.push(hostT(locale, "已重置该实例的会话绑定"));
  }
  if (enabledFullAuto) {
    details.push(hostT(locale, "Antigravity 已自动开启 YOLO/full-auto"));
  }
  const suffix = details.length > 0
    ? (locale === "en" ? ` ${details.join("; ")}.` : ` ${details.join(locale === "ja" ? "、" : "，")}。`)
    : "";
  const finalRestartNote = channelProfile() === "gateway" ? restartNote : hostT(locale, "重启 Lark service 后生效。");
  return hostT(locale, "引擎已设为 {0}。{1}{2}", selectedEngine, suffix, finalRestartNote);
}

async function handleCoreYoloCommand(stateDir: string, action: string, locale: Locale): Promise<string> {
  const cfg = await loadInstanceConfig(stateDir);
  if (!action || action === "status") {
    const raw = await readRawCoreConfig(stateDir);
    const mode = resolveApprovalModeForEngine(
      cfg.engine,
      raw.approvalMode,
      raw.kimiAutoNeverAskAcknowledged,
    );
    if (cfg.engine === "kimi") {
      const label = renderApprovalModeStatus(
        cfg.engine,
        raw.approvalMode,
        locale,
        raw.kimiAutoNeverAskAcknowledged,
      );
      return hostT(locale, "当前 YOLO: {0}", label);
    }
    const labelKey = mode === "bypass"
      ? "YOLO UNSAFE（跳过审批和 sandbox）"
      : mode === "full-auto" ? "YOLO（full-auto，sandboxed）" : "off（普通审批流程）";
    return hostT(locale, "当前 YOLO: {0}", hostT(locale, labelKey));
  }
  if (action === "on") {
    if (cfg.engine === "pi") {
      return hostT(locale, "Pi 不提供带沙箱的 full-auto，权限未更改。普通审批请用 /yolo off；跳过审批请用 /yolo unsafe，这不会提供 OS 沙箱。");
    }
    if (cfg.engine === "omp") {
      return hostT(locale, "omp 不提供带沙箱的 full-auto，权限未更改。工具审批请用 /yolo off；原生访问请用 /yolo unsafe，这不会提供 OS 沙箱。");
    }
    const engine = await updateInstanceApprovalMode(stateDir, "full-auto");
    if (engine === "kimi") {
      return hostT(locale, "Kimi YOLO 已开启。普通工具自动批准，敏感命令仍可能询问；这不是 OS 沙箱。");
    }
    return hostT(locale, "YOLO mode ON（full-auto，sandboxed）。当前引擎：{0}。", engine);
  }
  if (action === "off") {
    await updateInstanceApprovalMode(stateDir, "normal");
    return hostT(locale, "YOLO mode OFF。已恢复普通审批流程。");
  }
  if (action === "unsafe") {
    const engine = await updateInstanceApprovalMode(stateDir, "bypass");
    if (engine === "kimi") {
      return hostT(locale, "Kimi Auto 完全无人值守模式已开启。高危及无法分析的命令也会直接执行，且没有 OS 沙箱。");
    }
    return hostT(locale, "YOLO UNSAFE 已开启。将跳过审批和 sandbox，请只在可信机器和可信 workspace 使用。");
  }
  return hostT(locale, "用法: /yolo [on|off|unsafe|status]");
}

function renderCoreGoal(goal: CodexThreadGoal, locale: Locale): string {
  const budget = goal.tokenBudget === null
    ? hostT(locale, "预算：不限制（未设置 token 上限）")
    : hostT(locale, "预算：{0} token", goal.tokenBudget);
  const usage = goal.usageScope === "unavailable"
    ? hostT(locale, "目标用量：此主机暂无法统计")
    : goal.tokensUsed === 0 && Math.round(goal.timeUsedSeconds) === 0
      ? hostT(locale, "Goal 用量：尚未产生统计")
      : hostT(locale, "Goal 用量：{0} tokens，{1} 秒", goal.tokensUsed, Math.round(goal.timeUsedSeconds));
  const base = hostT(locale, "目标：{0}\n状态：{1}\n{2}\n{3}", goal.objective, goal.status, budget, usage);
  return goal.usageScope === "nativeGoalTurns"
    ? `${base}\n${hostT(locale, "仅统计目标轮次已上报的 token；不含普通聊天、后台及子任务。")}`
    : base;
}

function renderInvalidCoreGoalCommand(reason: Extract<CoreGoalCommand, { kind: "invalid" }>["reason"], locale: Locale): string {
  if (reason === "too_long") return hostT(locale, "原生目标最多支持 4,000 个字符。");
  if (reason === "invalid_control") {
    return hostT(locale, "请直接使用 /goal pause 或 /goal resume；修改目标或预算请用 /goal edit。");
  }
  if (reason === "missing_objective") {
    return hostT(locale, "请写目标，例如：/goal 写发布说明；如需限额，用 /goal --budget 50000 写发布说明。");
  }
  return hostT(locale, "无效的 /goal token 预算。用法：--budget 50000 或 -b 50k。");
}

function toNativeCoreGoalCommandText(
  action: CoreGoalCommand,
  commandText: string,
  engine: "claude" | "antigravity",
): string | null {
  if ((engine === "claude" || engine === "antigravity") && action.kind === "status") return "/goal";
  if ((engine === "claude" || engine === "antigravity") && action.kind === "clear") return "/goal clear";
  if (action.kind !== "set") return commandText.trim();
  if (action.tokenBudget === null) {
    return `/goal ${action.objective}`;
  }
  const engineName = engine === "antigravity" ? "Antigravity" : "Claude";
  return `/goal ${action.objective}\n\n[Bridge note: 用户请求 token 预算：${action.tokenBudget} tokens。原生 ${engineName} goal 可能只会把它当作指导，而不是强制预算。]`;
}

function renderCoreGoalEdit(goal: CodexThreadGoal, locale: Locale): string {
  return hostT(
    locale,
    "{0}\n\n使用 /goal edit <新目标>、/goal edit --budget 50000 或 /goal edit --unbounded。修改会保留已用量，暂停的目标不会自动恢复；继续执行请用 /goal resume。",
    renderCoreGoal(goal, locale),
  );
}

/** Existing-goal controls share authorization with normal input, but need no
 * model turn. Never prepare/rebind an App conversation while its turn runs. */
export async function tryHandleCoreGoalControlBeforeQueue(input: CoreCommandInput, normalized: CoreNormalizedBridgeMessage, text: string): Promise<boolean> {
  return withCoreGoalCommandLock(input.runtime, normalized.conversationKey, async () => {
    const cfg = await loadInstanceConfig(input.stateDir);
    const action = parseCoreGoalCommand(text, cfg.engine);
    if ((cfg.engine !== "codex" && cfg.engine !== "omp") || !action || action.kind === "set") return false;
    const current = () => input.channel.canSteerConversation?.(normalized.chatId) ?? true;
    if (!await current()) return false;
    const { record, warning } = await new SessionStore(path.join(input.stateDir, "session.json")).findByConversationKeySafe(normalized.conversationKey);
    cfg.resume = warning ? undefined : resolveConversationResume(record, cfg.resume);
    if (!await current()) return false;
    const handled = await applyCoreGoalCommand({ ...input,
      workspaceOverride: input.workspaceOverride ?? cfg.resume?.workspacePath ?? normalized.workspaceOverride ?? resolveInstanceWorkspacePath(cfg),
      isCurrentGoalSession: current,
    }, normalized, cfg, action, text, await resolveCoreLocale(input.stateDir));
    return handled ?? false;
  });
}

/** Serialize goal control transactions, never the autonomous pursuit itself. */
export async function withCoreGoalCommandLock<T>(runtime: CoreServiceRuntime, key: string, run: () => Promise<T>): Promise<T> {
  let locks = goalCommandLocks.get(runtime);
  if (!locks) { locks = new Map(); goalCommandLocks.set(runtime, locks); }
  const previous = locks.get(key);
  const operation = (async () => { await previous?.catch(() => {}); return await run(); })();
  locks.set(key, operation);
  try { return await operation; }
  finally { if (locks.get(key) === operation) locks.delete(key); }
}

async function handleCoreGoalCommand(...args: Parameters<typeof applyCoreGoalCommand>): Promise<boolean | null> {
  const [input, normalized] = args;
  return withCoreGoalCommandLock(input.runtime, normalized.conversationKey, () => applyCoreGoalCommand(...args));
}

async function applyCoreGoalCommand(
  input: CoreCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  cfg: InstanceConfig,
  action: CoreGoalCommand,
  commandText: string,
  locale: Locale,
): Promise<boolean | null> {
  if (action.kind === "invalid") {
    await sendCoreCommandMarkdown(input, normalized, "/goal", renderInvalidCoreGoalCommand(action.reason, locale));
    return true;
  }

  if (cfg.engine === "claude" && action.kind === "set" && action.tokenBudget !== null) {
    await sendCoreCommandMarkdown(input, normalized, "/goal", hostT(locale, "Claude 原生 /goal 不支持强制 token 预算，本次未启动目标。请去掉 --budget，使用 /goal <完成条件>；需要原生 token 限额时请使用 Codex。"));
    return true;
  }
  if (cfg.engine === "claude" || cfg.engine === "antigravity") {
    const nativeText = toNativeCoreGoalCommandText(action, commandText, cfg.engine);
    if (nativeText) {
      normalized.text = nativeText;
    }
    // Claude/Antigravity have a NATIVE /goal (autonomous multi-turn pursuit with an
    // independent completion checker), so we just forward "/goal <objective>" as a
    // normal engine turn — no thread-goal API needed. Tag the turn with the
    // objective so its run card renders the 🎯 goal banner, matching the framing of
    // the Codex goal card instead of looking like an ordinary reply.
    if (action.kind === "set") {
      normalized.goalObjective = action.objective;
    }
    return null;
  }

  if (cfg.engine === "kimi") {
    await sendCoreCommandMarkdown(input, normalized, "/goal", hostT(locale, "Kimi ACP 当前未提供 /goal 命令（真机返回 Unknown ACP command），bridge 不会把普通聊天伪装成 goal。请直接发送任务，或切换到 Codex、Claude 或 DeepSeek。"));
    return true;
  }

  if (cfg.engine === "pi") {
    // Pi has no goal mode and its adapter has no structured goal API. Without this the command either
    // threw or opened a run card that failed with a generic error.
    await sendCoreCommandMarkdown(input, normalized, "/goal", hostT(locale, "Pi 没有 /goal 目标模式，本次没有启动任何任务，也没有改动目标。请直接发送任务；需要目标模式时请切换到 Codex、Claude 或 DeepSeek。"));
    return true;
  }

  const goalInput = {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    workspaceOverride: input.workspaceOverride ?? cfg.resume?.workspacePath ?? normalized.workspaceOverride ?? resolveInstanceWorkspacePath(cfg),
    ...(input.isCurrentGoalSession ? { isCurrentSession: input.isCurrentGoalSession } : {}),
  };
  // activeRuns key for this conversation — shared by the live watcher (which claims
  // it) and by clear (which aborts it), so a detached goal watcher participates in
  // the same single-active-run tracking as normal turns instead of running unguarded.
  const conversationKey = normalized.conversationKey ?? `lark:${normalized.chatId}`;

  if (action.kind === "status") {
    if (!input.bridge.getThreadGoal) {
      await sendCoreCommandMarkdown(input, normalized, "/goal", hostT(locale, "当前 runtime 不支持结构化 /goal status。"));
      return true;
    }
    const { goal } = await input.bridge.getThreadGoal(goalInput);
    await sendCoreCommandMarkdown(input, normalized, "/goal", goal
      ? renderCoreGoal(goal, locale)
      : hostT(locale, "当前聊天没有活跃 goal。"));
    return true;
  }

  if (action.kind === "clear") {
    if (!input.bridge.clearThreadGoal) {
      await sendCoreCommandMarkdown(input, normalized, "/goal", hostT(locale, "当前 runtime 不支持结构化 /goal clear。"));
      return true;
    }
    // If a goal WATCHER is actively pursuing this conversation's goal, abort it first
    // so it stops cleanly — its abort path clears the goal in the engine and flips the
    // run card to interrupted. Guard on goalWatch so a normal turn sharing the
    // activeRuns slot is NOT killed (nor falsely reported "cleared") by /goal clear.
    const activeGoalRun = input.runtime.activeRuns.get(conversationKey);
    if (cfg.engine !== "codex" && cfg.engine !== "omp" && activeGoalRun?.goalWatch) {
      // End the PURSUIT specifically: abortGoal bypasses the stop routing that
      // would otherwise divert a plain abort() into an ordinary turn currently
      // running alongside the pursuit — /goal clear must kill the goal, never
      // that unrelated turn (which keeps running).
      if (activeGoalRun.abortController instanceof CoreGoalRunController) {
        activeGoalRun.abortController.abortGoal();
      } else {
        activeGoalRun.abortController.abort();
      }
      await sendCoreCommandMarkdown(input, normalized, "/goal", hostT(locale, "已清除当前 goal。"));
      return true;
    }
    const { cleared } = await input.bridge.clearThreadGoal({ ...goalInput, origin: "user" });
    await sendCoreCommandMarkdown(input, normalized, "/goal", cleared
      ? hostT(locale, "已清除当前 goal。")
      : hostT(locale, "当前聊天没有可清除的 goal。"));
    return true;
  }

  let watchMode: "replace" | "resume" = "replace";
  let resumeSessionId: string | undefined;
  if (action.kind === "pause" || action.kind === "resume" || action.kind === "edit") {
    if (!input.bridge.getThreadGoal || !input.bridge.updateThreadGoal) {
      await sendCoreCommandMarkdown(input, normalized, "/goal", hostT(locale, "当前 runtime 不支持原生目标控制。"));
      return true;
    }
    const { goal } = await input.bridge.getThreadGoal(goalInput);
    if (!goal) {
      await sendCoreCommandMarkdown(input, normalized, "/goal", hostT(locale, "当前聊天没有可控制的目标。"));
      return true;
    }
    if (action.kind === "edit" && action.objective === undefined && action.tokenBudget === undefined) {
      await sendCoreCommandMarkdown(input, normalized, "/goal", renderCoreGoalEdit(goal, locale));
      return true;
    }
    if (input.isCurrentGoalSession && !await input.isCurrentGoalSession()) {
      await sendCoreCommandMarkdown(input, normalized, "/goal", hostT(locale, "所选会话已变化，请为当前会话重新发送目标命令。"));
      return true;
    }
    const active = input.runtime.activeRuns.get(conversationKey);
    if (action.kind === "resume" && !active?.goalWatch && input.bridge.watchThreadGoal && input.createRunCard) {
      // Register an observer before native resume. Never clear/recreate the goal.
      watchMode = "resume";
      resumeSessionId = goal.threadId;
      action = { kind: "set", objective: goal.objective, tokenBudget: goal.tokenBudget, explicitUnbounded: false };
    } else {
      const changes = action.kind === "edit"
        ? { ...(action.objective !== undefined ? { objective: action.objective } : {}), ...(action.tokenBudget !== undefined ? { tokenBudget: action.tokenBudget } : {}) }
        : { status: action.kind === "pause" ? "paused" as const : "active" as const };
      const updated = await input.bridge.updateThreadGoal({ ...goalInput, sessionId: goal.threadId, ...changes, origin: "user" });
      if (updated.goal && input.runtime.activeRuns.get(conversationKey) === active) active?.updateGoalObjective?.(updated.goal.objective);
      await sendCoreCommandMarkdown(input, normalized, "/goal", updated.goal ? renderCoreGoal(updated.goal, locale)
        : hostT(locale, "该目标已不存在。"));
      return true;
    }
  }

  if (action.kind !== "set") return true;
  const pursuitAction = action;

  // Live path: set the goal AND watch the structured runtime's autonomous pursuit,
  // streaming progress into a run card. Codex and DeepSeek self-drive once the goal is set. The watch runs
  // detached so the command returns immediately while the card updates in the
  // background. Falls back to plain set-and-confirm when watch/CardKit is unavailable.
  if (input.bridge.watchThreadGoal && input.createRunCard) {
    const goalCfg = await loadInstanceConfig(input.stateDir);
    const abort = new CoreGoalRunController();
    const runCard = await input.createRunCard({
      channel: input.channel,
      chatId: normalized.chatId,
      conversationKey,
      bridgeChatType: normalized.bridgeChatType ?? "private",
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      goalObjective: pursuitAction.objective,
      abortSignal: abort.signal,
      elementStream: goalCfg.elementStream !== false,
    });
    if (runCard) {
      // Bind to the bridge: a bare `const fn = input.bridge.watchThreadGoal` loses
      // `this`, so the method's `this.adapter` would throw "Cannot read properties of
      // undefined (reading 'adapter')". (This is why /goal failed end-to-end while the
      // adapter passed in isolation.)
      const watchThreadGoal = input.bridge.watchThreadGoal.bind(input.bridge);
      const clearThreadGoal = input.bridge.clearThreadGoal?.bind(input.bridge);
      // Register the autonomous goal as the conversation's active run so /stop (and the
      // run card's stop button) can abort it — both flip activeRuns[key].abortController.
      // A LarkGoalRunController (bus.ts) rather than a plain AbortController: ordinary
      // turns arriving DURING the pursuit attach to it (claimLarkRunSlot) instead of
      // stealing the slot, and abort() routes to the attached turn first so the pursuit
      // survives everything except /stop-with-nothing-else-running and /goal clear.
      // Active protection: the watcher runs detached (outside the chat queue), so abort
      // any run already active for this conversation before claiming the slot —
      // otherwise overwriting activeRuns would orphan it (untracked; /stop can't reach
      // it). A replaced PURSUIT is ended entirely (goal + any attached ordinary turn:
      // both would be orphaned by the overwrite). Guarantees exactly one tracked
      // active run per conversation.
      const previousRun = input.runtime.activeRuns.get(conversationKey);
      const previousActive = previousRun?.abortController;
      let completions = goalPursuitCompletions.get(input.runtime);
      if (!completions) { completions = new Map(); goalPursuitCompletions.set(input.runtime, completions); }
      const previousCompletion = completions.get(conversationKey);
      if (previousActive instanceof CoreGoalRunController) {
        previousActive.abortAll();
      } else if (watchMode === "resume" && previousRun && !previousActive?.signal.aborted) {
        // Resuming an existing goal does not cancel an ordinary turn already
        // using this conversation. Its original release detaches this handle.
        abort.attachConcurrentTurn(previousRun);
        const concurrent = input.runtime.concurrentRuns.get(conversationKey) ?? new Set();
        concurrent.add(previousRun);
        input.runtime.concurrentRuns.set(conversationKey, concurrent);
      } else {
        previousActive?.abort();
      }
      input.runtime.activeRuns.set(conversationKey, { abortController: abort, hasRunCard: true, goalWatch: true, startedAt: Date.now(), updateGoalObjective: (objective) => runCard.setGoalObjective?.(objective) });
      let resolveNativeDone!: () => void, resolveStartup!: () => void;
      const nativeDone = new Promise<void>((resolve) => { resolveNativeDone = resolve; });
      const startup = new Promise<void>((resolve) => { resolveStartup = resolve; });
      const releaseGoalRun = () => {
        resolveNativeDone();
        resolveStartup();
        if (completions!.get(conversationKey) === nativeDone) completions!.delete(conversationKey);
        if (input.runtime.activeRuns.get(conversationKey)?.abortController !== abort) return;
        const concurrent = abort.liveConcurrentTurn();
        if (concurrent) input.runtime.activeRuns.set(conversationKey, concurrent);
        else input.runtime.activeRuns.delete(conversationKey);
      };
      const pursuit = (async () => {
        let goalSessionId: string | undefined;
        let goalFinalAnswer = "";
        try {
          await previousCompletion?.catch(() => {});
          if (abort.signal.aborted) { releaseGoalRun(); await runCard.interrupt(); return; }
          const result = await watchThreadGoal({
            ...goalInput,
            ...(watchMode !== "replace" ? { mode: watchMode, sessionId: resumeSessionId } : {}),
            objective: pursuitAction.objective,
            ...(watchMode === "replace" ? { tokenBudget: pursuitAction.tokenBudget } : {}),
            onEngineEvent: (event) => {
              if (event.type === "session" && event.sessionId) { goalSessionId ??= event.sessionId; resolveStartup(); }
              if (event.type === "result" && event.text.trim()) goalFinalAnswer = event.text;
              void runCard.apply(event);
              if (event.type !== "user_input_request") return;
              // An autonomous goal turn has no host-side pending turn, and steering
              // could land in an ordinary turn attached to this pursuit. Present the
              // form without a steer path so the answer is admitted through the
              // conversation queue; the pursuit's own signal closes it on stop/replace.
              void deliverCoreUserInputRequest({
                channel: input.channel,
                runtime: input.runtime,
                chatId: normalized.chatId,
                toolInput: event.toolInput,
                requestId: event.requestId,
                sessionId: event.sessionId,
                abortSignal: abort.signal,
                conversationKey,
                bridgeChatType: normalized.bridgeChatType,
                replyTo: normalized.messageId,
                replyInThread: Boolean(normalized.threadId),
                locale,
              }).catch((error) => appendCoreTimelineEvent(input.stateDir, normalized, {
                type: "engine.event.delivery_failed",
                outcome: "error",
                detail: redactCoreErrorDetail(error),
                metadata: { eventType: event.type, requestId: event.requestId },
              }).catch(() => {}));
            },
            onApprovalRequest: async (request) => {
              runCard.setPhase?.(request.toolName === "AskUserQuestion" ? "waiting_answer" : "waiting_approval");
              try { return await input.requestApproval({
              channel: input.channel,
              runtime: input.runtime,
              chatId: normalized.chatId,
              conversationKey: normalized.conversationKey,
              bridgeChatType: normalized.bridgeChatType,
              requesterUserId: normalized.bridgeUserId,
              replyTo: normalized.messageId,
              replyInThread: Boolean(normalized.threadId),
              locale,
              request,
              abortSignal: request.abortSignal ?? abort.signal,
            }); } finally { runCard.setPhase?.("working"); }
            },
            abortSignal: abort.signal,
          });
          goalSessionId ??= result.sessionId ?? result.goal?.threadId;
          const watched = result.goal;
          const retainsNativeGoal = cfg.engine === "codex" || cfg.engine === "omp";
          if (abort.signal.aborted || (!retainsNativeGoal && watched && !["complete", "budgetLimited"].includes(watched.status))) {
            // Stopped: clear the goal so the engine halts its autonomous pursuit
            // (aborting the watcher alone only stops us listening), then flip the card to "已中断".
            if (!retainsNativeGoal && goalSessionId) { try { await clearThreadGoal?.({ ...goalInput, sessionId: goalSessionId, origin: "automatic" }); } catch { /* best-effort */ } }
            releaseGoalRun();
            await runCard.interrupt();
          } else if (retainsNativeGoal && (!watched || watched.status !== "complete")) {
            releaseGoalRun();
            const summary = watched ? renderCoreGoal(watched, locale)
              : hostT(locale, "目标已清除。");
            const answer = goalFinalAnswer.trim() || runCard.resolveFinalText("").trim();
            // This run ended; the goal may still be resumable. Never mark the
            // objective completed or destroy its native state and usage.
            await runCard.interrupt(answer ? `${answer}\n\n---\n\n${summary}` : summary);
          } else {
            // Codex and omp retain completed state for native status/edit/resume. Keep
            // the existing cleanup contract for other structured adapters.
            if (!retainsNativeGoal && goalSessionId) { try { await clearThreadGoal?.({ ...goalInput, sessionId: goalSessionId, origin: "automatic" }); } catch { /* best-effort */ } }
            releaseGoalRun();
            const answer = goalFinalAnswer.trim() || runCard.resolveFinalText("").trim();
            const summary = watched ? renderCoreGoal(watched, locale)
              : hostT(locale, "Goal 已结束。");
            // The card already carries the objective and completion state.
            // Keep a successful answer primary instead of repeating the entire
            // goal definition and raw runtime metadata underneath it.
            await runCard.finish(answer && watched?.status === "complete" ? answer
              : answer ? `${answer}\n\n---\n\n${summary}` : summary);
          }
        } catch (error) {
          if (abort.signal.aborted) {
            if (cfg.engine !== "codex" && cfg.engine !== "omp" && goalSessionId) {
              try { await clearThreadGoal?.({ ...goalInput, sessionId: goalSessionId, origin: "automatic" }); } catch { /* best-effort */ }
            }
            releaseGoalRun();
            await runCard.interrupt();
            return;
          }
          releaseGoalRun();
          // Record the real reason so "详细原因已记录到日志" is actually true and the
          // failure is diagnosable from the timeline (the run card stays redacted).
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "command.handled",
            outcome: "error",
            detail: "/goal",
            metadata: { error: error instanceof Error ? (error.stack ?? error.message) : String(error) },
          }).catch(() => {});
          await runCard.fail(renderCoreUserFacingError(error, "engine", locale));
        } finally {
          // Release our slot only if a newer run hasn't already replaced it. If an
          // ordinary turn is still attached (it ran alongside the pursuit and the
          // pursuit ended first), PROMOTE it into the slot so /stop and the stop
          // buttons can still reach it for the rest of its run — its own guarded
          // release (claimLarkRunSlot) then cleans the promoted slot up.
          releaseGoalRun();
        }
      })();
      completions.set(conversationKey, nativeDone);
      const forget = () => { if (completions.get(conversationKey) === nativeDone) completions.delete(conversationKey); };
      void pursuit.then(forget, forget);
      await startup;
      return true;
    }
  }

  if (watchMode === "resume") {
    const { goal } = await input.bridge.updateThreadGoal!({ ...goalInput, sessionId: resumeSessionId, status: "active", origin: "user" });
    await sendCoreCommandMarkdown(input, normalized, "/goal", goal ? renderCoreGoal(goal, locale)
      : hostT(locale, "该目标已不存在。"));
    return true;
  }
  if (!input.bridge.setThreadGoal) {
    await sendCoreCommandMarkdown(input, normalized, "/goal", hostT(locale, "当前 runtime 不支持结构化 /goal。"));
    return true;
  }
  const { goal } = await input.bridge.setThreadGoal({
    ...goalInput,
    objective: pursuitAction.objective,
    tokenBudget: pursuitAction.tokenBudget,
  });
  await sendCoreCommandMarkdown(input, normalized, "/goal", goal
    ? hostT(locale, "Goal 已设置。\n\n{0}", renderCoreGoal(goal, locale))
    : hostT(locale, "Goal 已设置。"));
  return true;
}

async function handleCoreCronCommand(
  input: CoreCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<void> {
  if (!input.runtime.cronRuntime) {
    await sendCoreCommandMarkdown(input, normalized, "/cron", renderCoreCronRuntimeMissing(locale));
    return;
  }

  const api = {
    sendMessage: async (_chatId: number, text: string): Promise<{ message_id: number }> => {
      await sendCoreMarkdown(input.channel, normalized.chatId, text, coreCommandReplyOptions(normalized));
      return { message_id: 0 };
    },
  };

  await handleCronCommand(commandText, {
    api,
    store: input.runtime.cronRuntime.store as CronStore,
    scheduler: input.runtime.cronRuntime.scheduler as CronScheduler,
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    channel: "lark",
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    larkChatId: normalized.chatId,
    larkThreadId: normalized.threadId,
    larkMessageId: normalized.messageId,
    locale,
  });
  await appendCoreTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail: "/cron",
  });
}
