import { classifyFailure } from "../../runtime/error-classification.js";
import { hostT } from "../../locales/index.js";
import type { EngineContextUsage } from "../../codex/adapter.js";
import { chunkReplyMessage, type Locale } from "../../runtime/message-renderer.js";
import {
  appendCommandSuccessAuditEventBestEffort,
  type CoreTurnContext,
} from "./turn-bookkeeping.js";
import { applyEngineSelection } from "../../state/instance-config.js";
import type { CommandMessage } from "../../runtime/command-message.js";
import type { InstanceEngine } from "../../state/instance-config.js";

const ENGINE_CHOICES: InstanceEngine[] = ["claude", "codex", "kimi", "deepseek", "antigravity", "pi", "omp"];

function isCompactCommand(text: string): boolean {
  return /^\/compact(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isUltrareviewCommand(text: string): boolean {
  return /^\/ultrareview(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isContextCommand(text: string): boolean {
  return /^\/context(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isSwarmCommand(text: string): boolean {
  return /^\/swarm(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function renderContextUsage(usage: EngineContextUsage | null, locale: Locale, engineName = "DeepSeek Harness"): string {
  const used = usage?.projectedTokens ?? usage?.pressureTokens;
  const window = usage?.contextWindow;
  if (used === undefined || window === undefined || window <= 0) {
    return hostT(locale, "当前还没有可用的上下文统计。先发送一条消息，让 {0} 获得 provider 用量样本后再试。", engineName);
  }
  const format = (value: number) => Math.round(value).toLocaleString("en-US");
  const percent = Math.min(100, Math.max(0, used / window * 100)).toFixed(1);
  const sample = usage?.pressureTokens;
  return [
    hostT(locale, "上下文：约 {0} / {1} token（{2}%）", format(used), format(window), percent),
    ...(sample === undefined ? [] : [hostT(locale, "最近一次 provider 样本：{0} token", format(sample))]),
  ].join("\n");
}

function parseEngineCommand(text: string): { engine: string; invalid: boolean } | null {
  const match = text.trim().match(/^\/engine(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return null;
  const rawArgs = match[1]?.trim() ?? "";
  if (!rawArgs) {
    return { engine: "", invalid: false };
  }
  const parts = rawArgs.split(/\s+/).filter(Boolean);
  if (parts.length !== 1) {
    return { engine: "", invalid: true };
  }
  return { engine: parts[0] ?? "", invalid: false };
}

function renderEngineSwitchMessage(input: {
  locale: Locale;
  previousEngine?: InstanceEngine;
  engine: InstanceEngine;
  clearedModel: boolean;
  enabledFullAuto: boolean;
  resetSessionBindings: boolean;
  resetSessionBindingFailed: boolean;
}): string {
  const {
    locale,
    previousEngine,
    engine,
    clearedModel,
    enabledFullAuto,
    resetSessionBindings,
    resetSessionBindingFailed,
  } = input;
  const appendAntigravityYolo = (message: string) => {
    if (!enabledFullAuto) {
      return message;
    }
    return hostT(locale, "{0} Antigravity 已自动开启 YOLO/full-auto。", message);
  };

  if (resetSessionBindingFailed) {
    return hostT(locale, "未能切换到 {0}：该实例的会话绑定未能先清除。当前引擎仍是 {1}。", engine, previousEngine ?? engine);
  }
  if (clearedModel && resetSessionBindings) {
    return appendAntigravityYolo(hostT(locale, "引擎已设为 {0}。已清除先前的模型覆盖，并重置该实例的会话绑定。重启此实例后生效。", engine));
  }
  if (clearedModel) {
    return appendAntigravityYolo(hostT(locale, "引擎已设为 {0}。已清除先前的模型覆盖。重启此实例后生效。", engine));
  }
  if (resetSessionBindings) {
    return appendAntigravityYolo(hostT(locale, "引擎已设为 {0}。已重置该实例的会话绑定。重启此实例后生效。", engine));
  }
  return appendAntigravityYolo(hostT(locale, "引擎已设为 {0}。重启此实例后生效。", engine));
}

export interface EngineCommandConfig {
  engine: InstanceEngine;
  /** Antigravity transport; only "acp" has native /compact and context usage. */
  antigravityRuntime?: "acp";
  role?: "dispatcher";
  disableRuntimeTimeout?: boolean;
  model?: string;
  workspacePath?: string;
  resume?: {
    workspacePath: string;
  };
}

export interface EngineCommandBridge {
  handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    conversationKey?: string;
    locale: Locale;
    text: string;
    files: string[];
    workspaceOverride?: string;
    disableRuntimeTimeout?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<{ text: string }>;
  getContextUsage?(input: {
    chatId: number;
    messageThreadId?: number;
    conversationKey?: string;
    workspaceOverride?: string;
  }): Promise<EngineContextUsage | null>;
}

export interface EngineCommandContext extends CoreTurnContext {
  abortSignal?: AbortSignal;
}

export interface EngineCommandSessionStore {
  removeByChatId(chatId: number): Promise<boolean | void>;
  removeByConversationKey?(conversationKey: string): Promise<boolean | void>;
  clearAll(): Promise<number>;
  clearAllThen?<T>(operation: () => Promise<T>): Promise<{ removedCount: number; result: T }>;
}

export async function handleLocalEngineCoreCommand(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: EngineCommandConfig;
  normalized: CommandMessage;
  context: EngineCommandContext;
  bridge: EngineCommandBridge;
  sessionStore: EngineCommandSessionStore;
  updateInstanceConfig: (updater: (config: Record<string, unknown>) => void) => Promise<void>;
}): Promise<boolean> {
  const { stateDir, startedAt, locale, cfg, normalized, context, bridge, sessionStore, updateInstanceConfig } = input;

  const engineCmd = parseEngineCommand(normalized.text);
  if (engineCmd) {
    let engineMessage: string;
    if (!engineCmd.engine && !engineCmd.invalid) {
      const options = ENGINE_CHOICES.filter(engine => (engine !== "pi" && engine !== "omp") || cfg.role !== "dispatcher").map((engine) => `/engine ${engine}`).join("\n");
      engineMessage = hostT(locale, "当前引擎：{0}\n用 /engine <名称> 选择引擎：\n{1}\n切换后重启此实例以生效。", cfg.engine, options);
      await context.api.sendMessage(normalized.chatId, engineMessage);
    } else if (engineCmd.invalid || !ENGINE_CHOICES.includes(engineCmd.engine as InstanceEngine)) {
      engineMessage = hostT(locale, "用法: /engine [claude|codex|kimi|deepseek|antigravity|pi|omp]");
      await context.api.sendMessage(normalized.chatId, engineMessage);
    } else if ((engineCmd.engine === "pi" || engineCmd.engine === "omp") && cfg.role === "dispatcher") {
      engineMessage = engineCmd.engine === "omp"
        ? (locale === "zh" ? "omp 仅用于普通 Bot，不支持幕僚长。" : "omp is available for ordinary Bots, not Superagent Bots.")
        : (locale === "zh" ? "Pi 仅用于普通 Bot，不支持幕僚长。" : "Pi is available for ordinary Bots, not Superagent Bots.");
      await context.api.sendMessage(normalized.chatId, engineMessage);
    } else {
      const selectedEngine = engineCmd.engine as InstanceEngine;
      const engineChanged = cfg.engine !== selectedEngine;
      let clearedModel = false;
      let enabledFullAuto = false;
      let resetSessionBindings = false;
      let resetSessionBindingFailed = false;
      const applySelection = async () => await updateInstanceConfig((config) => {
        const result = applyEngineSelection(config, selectedEngine);
        clearedModel = result.clearedModel;
        enabledFullAuto = result.enabledFullAuto;
      });
      if (engineChanged) {
        try {
          if (!sessionStore.clearAllThen) throw new Error("session transaction unavailable");
          await sessionStore.clearAllThen(applySelection);
          resetSessionBindings = true;
        } catch (error) {
          resetSessionBindingFailed = true;
          console.error("Engine switch failed; session transaction rolled back:", error instanceof Error ? error.message : error);
        }
      } else await applySelection();
      engineMessage = renderEngineSwitchMessage({
        locale,
        previousEngine: cfg.engine,
        engine: selectedEngine,
        clearedModel,
        enabledFullAuto,
        resetSessionBindings,
        resetSessionBindingFailed,
      });
      await context.api.sendMessage(normalized.chatId, engineMessage);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "engine",
      responseText: engineMessage,
      metadata: { value: engineCmd.engine || "query" },
    });
    return true;
  }

  if (isCompactCommand(normalized.text)) {
    // Keep Pi/OMP's native command suffix, extension callbacks and turn scope.
    if (cfg.engine === "pi" || cfg.engine === "omp") return false;
    const agyAcp = cfg.engine === "antigravity" && cfg.antigravityRuntime === "acp";
    if (cfg.engine !== "claude" && cfg.engine !== "kimi" && cfg.engine !== "deepseek" && !agyAcp) {
      const msg = hostT(locale, "/compact 仅支持 Claude、Kimi 与 DeepSeek 引擎。当前引擎不会执行本地上下文压缩；如需清空当前会话，请使用 /reset。");
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "compact",
        responseText: msg,
        metadata: { rejected: "wrong-engine" },
      });
      return true;
    }

    await context.api.sendMessage(
      normalized.chatId,
      hostT(locale, "正在压缩会话上下文..."),
    );

    let compactAuditText: string | undefined;
    try {
      const result = await bridge.handleAuthorizedMessage({
        chatId: normalized.chatId,
        userId: normalized.userId,
        chatType: normalized.chatType,
        messageThreadId: normalized.messageThreadId,
        conversationKey: normalized.conversationKey,
        locale,
        text: "/compact",
        files: [],
        workspaceOverride: cfg.resume?.workspacePath ?? cfg.workspacePath,
        disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
        abortSignal: context.abortSignal,
      });

      // A native compact can finish without any text of its own (Antigravity ACP).
      const compactMsg = [hostT(locale, "上下文已压缩。"), result.text.trim() ? result.text : ""].filter(Boolean).join("\n\n");
      compactAuditText = compactMsg;
      const chunks = chunkReplyMessage(compactMsg);
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }
    } catch (error) {
      if (classifyFailure(error) === "auth") {
        throw error;
      }
      // Do NOT reset the session on a compact failure. Compaction is NOT the
      // same as a reset: it would have kept the conversation (summarized), while
      // a reset throws it away. Silently resetting here destroyed the very
      // conversation the user was trying to preserve. Leave the session intact
      // and let the user decide whether to /reset.
      const fallbackMsg = hostT(locale, "这次没能压缩上下文，会话保持不变。如果想清空、重新开始，请发送 /reset。");
      compactAuditText = fallbackMsg;
      await context.api.sendMessage(normalized.chatId, fallbackMsg);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "compact",
      responseText: compactAuditText,
    });
    return true;
  }

  if (isUltrareviewCommand(normalized.text)) {
    if (cfg.engine !== "claude") {
      const msg = hostT(locale, "/ultrareview 仅支持 Claude 引擎（Opus 4.7+）。");
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "ultrareview",
        responseText: msg,
        metadata: { rejected: "wrong-engine" },
      });
      return true;
    }

    await context.api.sendMessage(
      normalized.chatId,
      hostT(locale, "正在进行代码审查..."),
    );

    const result = await bridge.handleAuthorizedMessage({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      messageThreadId: normalized.messageThreadId,
      conversationKey: normalized.conversationKey,
      locale,
      text: "/ultrareview",
      files: [],
      workspaceOverride: cfg.resume?.workspacePath ?? cfg.workspacePath,
      disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
      abortSignal: context.abortSignal,
    });

    const chunks = chunkReplyMessage(result.text);
    await context.api.sendMessage(normalized.chatId, chunks[0]!);
    for (const chunk of chunks.slice(1)) {
      await context.api.sendMessage(normalized.chatId, chunk);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "ultrareview",
      responseText: result.text,
    });
    return true;
  }

  if (isContextCommand(normalized.text)) {
    if (cfg.engine === "deepseek" || cfg.engine === "pi" || cfg.engine === "omp" || cfg.engine === "antigravity" && cfg.antigravityRuntime === "acp") {
      const usage = await bridge.getContextUsage?.({
        chatId: normalized.chatId,
        messageThreadId: normalized.messageThreadId,
        conversationKey: normalized.conversationKey,
        workspaceOverride: cfg.engine === "pi" || cfg.engine === "omp" ? cfg.workspacePath ?? cfg.resume?.workspacePath : cfg.resume?.workspacePath ?? cfg.workspacePath,
      }) ?? null;
      const msg = renderContextUsage(usage, locale, cfg.engine === "omp" ? "oh-my-pi (omp)" : cfg.engine === "pi" ? "Pi" : cfg.engine === "antigravity" ? "Antigravity" : "DeepSeek Harness");
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "context",
        responseText: msg,
      });
      return true;
    }

    if (cfg.engine !== "claude") {
      const msg = hostT(locale, "/context 仅支持 Claude 或 DeepSeek 引擎。当前引擎不暴露本地上下文查询。");
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "context",
        responseText: msg,
        metadata: { rejected: "wrong-engine" },
      });
      return true;
    }

    const result = await bridge.handleAuthorizedMessage({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      messageThreadId: normalized.messageThreadId,
      conversationKey: normalized.conversationKey,
      locale,
      text: "/context",
      files: [],
      workspaceOverride: cfg.resume?.workspacePath ?? cfg.workspacePath,
      disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
      abortSignal: context.abortSignal,
    });

    const chunks = chunkReplyMessage(result.text);
    await context.api.sendMessage(normalized.chatId, chunks[0]!);
    for (const chunk of chunks.slice(1)) {
      await context.api.sendMessage(normalized.chatId, chunk);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "context",
      responseText: result.text,
    });
    return true;
  }

  if (isSwarmCommand(normalized.text)) {
    if (cfg.engine !== "antigravity") return false;
    if (cfg.antigravityRuntime === "acp") return false;
    const msg = locale === "zh"
      ? "当前 Antigravity Bot 运行在 print 模式，不支持 `/swarm`（仅 `agy acp` 交互运行时支持 `/swarm`）。本次未向模型发送任何内容；请新建使用 ACP 运行时的 Antigravity Bot 后重试。"
      : "`/swarm` is not available on Antigravity's print runtime (only the `agy acp` interactive runtime supports `/swarm`). Nothing was sent to the model; create a new Antigravity Bot on the ACP runtime to use `/swarm`.";
    await context.api.sendMessage(normalized.chatId, msg);
    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "swarm",
      responseText: msg,
      metadata: { rejected: "print-runtime" },
    });
    return true;
  }

  return false;
}
