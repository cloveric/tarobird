import { busFailureDetail, describeBusFailure } from "../../bus/error-presentation.js";
import { randomUUID } from "node:crypto";

import { isPeerAllowed, loadBusConfig as defaultLoadBusConfig, type BusConfig } from "../../bus/bus-config.js";
import { parseDelegationPlan } from "../../bus/delegation-plan.js";
import { hasVisibleAgentBusText } from "../../client-protocol/agent-bus.js";
import { delegateToInstance as defaultDelegateToInstance } from "../../bus/bus-client.js";
import type { EngineStreamEvent } from "../../codex/adapter.js";
import {
  appendUpdateHandleAuditEventBestEffort,
  maybeReplyWithBudgetExhausted,
  recordTurnUsageAndBudgetAudit,
  type CoreTurnContext,
} from "./turn-bookkeeping.js";
import type { Locale } from "../../runtime/locale.js";
import { hostT } from "../../locales/index.js";
import { commandReplyChunks } from "./command-reply.js";
import type { CoreCommandMessage } from "./command-message.js";

function renderNonEmptyEngineText(text: string, locale: Locale): string {
  return text.trim() || hostT(locale, "（引擎未返回文本）");
}

function parseBtwCommand(text: string): { prompt: string } | null {
  const match = text.trim().match(/^\/btw(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prompt: match[1]!.trim() };
}

function parseAskCommand(text: string): { targetInstance: string; prompt: string } | null {
  const match = text.trim().match(/^\/ask(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) return null;
  return { targetInstance: match[1]!, prompt: match[2]!.trim() };
}

function parseFanCommand(text: string): { prompt: string } | null {
  const match = text.trim().match(/^\/fan(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prompt: match[1]!.trim() };
}

function parseChainCommand(text: string): { prompt: string } | null {
  const match = text.trim().match(/^\/chain(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prompt: match[1]!.trim() };
}

function parseVerifyCommand(text: string): { prompt: string } | null {
  const match = text.trim().match(/^\/verify(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prompt: match[1]!.trim() };
}

function buildChainStagePrompt(input: {
  locale: Locale;
  originalPrompt: string;
  previousInstance: string;
  previousOutput: string;
}): string {
  return hostT(
    input.locale,
    "原始问题：{0}\n\n上一阶段（{1}）输出：\n{2}\n\n请在此基础上继续处理，并返回你的结果。",
    input.originalPrompt,
    input.previousInstance,
    input.previousOutput,
  );
}

export interface DelegationCommandContext extends CoreTurnContext {
  abortSignal?: AbortSignal;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
}

export interface DelegationCommandBridge {
  handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    locale: Locale;
    text: string;
    files: string[];
    workspaceOverride?: string;
    disableRuntimeTimeout?: boolean;
    abortSignal?: AbortSignal;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    sessionIdOverride?: string;
    messageThreadId?: number;
    conversationKey?: string;
  }): Promise<{
    text: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      costUsd?: number;
    };
  }>;
}

export async function handleDelegationCoreCommand(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: {
    budgetUsd?: number;
    disableRuntimeTimeout?: boolean;
    resume?: {
      workspacePath: string;
    };
  };
  normalized: CoreCommandMessage;
  context: DelegationCommandContext;
  bridge: DelegationCommandBridge;
  loadBusConfig?: (stateDir: string) => Promise<BusConfig | null>;
  delegateToInstance?: typeof defaultDelegateToInstance;
  /** Only supplied by the validated Hub dispatch, never by slash commands. */
  agentBusMembers?: string[];
}): Promise<boolean> {
  const {
    stateDir,
    startedAt,
    locale,
    cfg,
    normalized,
    context,
    bridge,
    loadBusConfig = defaultLoadBusConfig,
    delegateToInstance = defaultDelegateToInstance,
  } = input;

  if (context.abortSignal?.aborted && /^\/(?:ask|fan|chain|verify|btw)(?:@\w+)?\s+/i.test(normalized.text.trim())) {
    await context.api.sendMessage(normalized.chatId, hostT(locale, "协作已停止，任务未启动。"));
    return true;
  }

  // Validate explicit task members before starting any local or delegated work.
  // The Bus still checks both sides' permissions at each actual request.
  const replyUsage = (mode: string) => context.api.sendMessage(
    normalized.chatId,
    hostT(locale, "用法：{0}。请填写任务内容；尚未启动协作。", mode === "ask" ? hostT(locale, "/ask <Bot> <任务>") : hostT(locale, "/{0} <任务>", mode)),
  );
  let taskPlan: ReturnType<typeof parseDelegationPlan> | undefined;
  const taskCommand = normalized.text.trim().match(/^\/(fan|chain|verify)(?:@\w+)?\s+([\s\S]+)$/i);
  if (taskCommand && taskCommand[2]!.startsWith("--bots=")) {
    // An unfinished explicit selection has no task to authorise or dispatch.
    // Do not mislabel a missing goal as a permission failure.
    if (/^--bots=\S+(?:\s+--)?\s*$/.test(taskCommand[2]!)) {
      await replyUsage(taskCommand[1]!.toLowerCase()); return true;
    }
    try {
      taskPlan = parseDelegationPlan(taskCommand[2]!, !!input.agentBusMembers);
      if (input.agentBusMembers && JSON.stringify(taskPlan.targets) !== JSON.stringify(input.agentBusMembers)) throw new Error("collaboration_target_not_allowed");
      const config = await loadBusConfig(stateDir);
      if (taskPlan.targets!.some(id => id === (context.instanceName ?? "default") ? !input.agentBusMembers : !config || !isPeerAllowed(config, id)) || taskCommand[1]!.toLowerCase() === "verify" && taskPlan.targets!.length !== 1) throw new Error("collaboration_target_not_allowed");
    } catch {
      await context.api.sendMessage(normalized.chatId, hostT(locale, "协作成员无效或尚未获准。请重新选择成员并检查协作权限；任务未启动。"));
      return true;
    }
  }

  // Recognized but incomplete commands must not fall through to the model.
  // Inspect the goal after --bots parsing so selection syntax is not content.
  const command = normalized.text.trim().match(/^\/(ask|fan|chain|verify)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (command) {
    const mode = command[1]!.toLowerCase();
    const prompt = mode === "ask" ? parseAskCommand(normalized.text)?.prompt : taskPlan?.prompt ?? command[2];
    if (!prompt || !hasVisibleAgentBusText(prompt)) {
      await replyUsage(mode);
      return true;
    }
  }

  const btwCmd = parseBtwCommand(normalized.text);
  if (btwCmd) {
    try {
      if (await maybeReplyWithBudgetExhausted(stateDir, cfg.budgetUsd, locale, context, normalized)) {
        return true;
      }
      const btwChatId = -(2_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
      // /btw is a one-off side question: run it on a fresh ephemeral session
      // (sessionIdOverride bypasses getOrCreateSession + bindSession) so it never
      // resumes a stale prior side-question session and never grows stored sessions.
      const result = await bridge.handleAuthorizedMessage({
        chatId: btwChatId,
        userId: normalized.userId,
        chatType: "bus",
        locale,
        text: btwCmd.prompt,
        files: [],
        disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
        abortSignal: context.abortSignal,
        onEngineEvent: context.onEngineEvent,
        // Must carry the `tarobot-` marker: every adapter's
        // isLogicalTelegramSessionId() treats anything else as an EXISTING
        // session to resume, so a bare `btw-<uuid>` made Claude run
        // `-r btw-…` → "not a UUID" and the side question failed outright.
        sessionIdOverride: `tarobot-btw-${randomUUID()}`,
      });
      await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);
      const responseText = renderNonEmptyEngineText(result.text, locale);
      const chunks = commandReplyChunks(context, responseText);
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }
      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "btw",
          responseChars: responseText.length,
          chunkCount: chunks.length,
        },
      });
    } catch (error) {
      const detail = describeBusFailure(error, locale);
      const msg = hostT(locale, "旁问失败：{0}", detail);
      await context.api.sendMessage(normalized.chatId, msg);
      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "error",
        detail: busFailureDetail(error),
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "btw",
        },
      });
    }
    return true;
  }

  const askCommand = parseAskCommand(normalized.text);
  if (askCommand) {
    const currentInstance = context.instanceName ?? "default";
    if (askCommand.targetInstance === currentInstance && !input.agentBusMembers) {
      await context.api.sendMessage(
        normalized.chatId,
        hostT(locale, "不能委托给自己。"),
      );
      return true;
    }

    const askLabel = hostT(locale, "正在转发给 {0}...", askCommand.targetInstance);
    await context.api.sendMessage(normalized.chatId, askLabel);

    try {
      const result = await delegateToInstance({
        fromInstance: currentInstance,
        targetInstance: askCommand.targetInstance,
        ...(input.agentBusMembers ? { agentBusMemberIndex: 0 } : {}),
        prompt: askCommand.prompt,
        depth: 0,
        stateDir,
        abortSignal: context.abortSignal,
      });

      const askText = renderNonEmptyEngineText(result.text, locale);
      const askResponse = hostT(locale, "[来自 {0}]\n\n{1}", askCommand.targetInstance, askText);
      const chunks = commandReplyChunks(context, askResponse);
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }

      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "ask",
          delegatedTo: askCommand.targetInstance,
          responseChars: askResponse.length,
        },
      });
    } catch (error) {
      const detail = describeBusFailure(error, locale);
      const errorMsg = context.abortSignal?.aborted
        ? hostT(locale, "协作已停止。")
        : hostT(locale, "委托给 {0} 失败：{1}", askCommand.targetInstance, detail);
      await context.api.sendMessage(normalized.chatId, errorMsg);
      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "error",
        detail: busFailureDetail(error),
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "ask",
          delegatedTo: askCommand.targetInstance,
        },
      });
    }
    return true;
  }

  const fanCommand = parseFanCommand(normalized.text);
  if (fanCommand) {
    if (taskPlan) fanCommand.prompt = taskPlan.prompt;
    const busConfig = await loadBusConfig(stateDir);
    const currentInstance = context.instanceName ?? "default";
    // The current instance always runs the prompt locally (selfPromise below), so
    // drop it from the peer fan-out — otherwise a self-listed bus.parallel entry
    // would run this instance's turn twice. Mirrors the self-checks in /chain and /ask.
    const configuredParallel = taskPlan?.targets ?? busConfig?.parallel ?? [];
    const targets = input.agentBusMembers ? configuredParallel : configuredParallel.filter((target) => target !== currentInstance);
    // Error only when bus.parallel is genuinely empty. A config that lists only
    // the current instance (targets now empty after self-exclusion) still runs a
    // valid local-only fan via selfPromise — don't turn that into an error.
    if (configuredParallel.length === 0) {
      await context.api.sendMessage(
        normalized.chatId,
        hostT(locale, "未配置 parallel bot。在 config.json 的 bus.parallel 中添加实例名。"),
      );
      return true;
    }

    if (await maybeReplyWithBudgetExhausted(stateDir, cfg.budgetUsd, locale, context, normalized)) {
      return true;
    }
    await context.api.sendMessage(
      normalized.chatId,
      hostT(locale, "正在并行查询 {0} 个 bot...", targets.length + 1),
    );

    let fanOutcome: "success" | "error" = "success";
    let fanErrorCount = 0;
    let fanResponseLength = 0;
    let fanChunkCount = 0;
    try {
      const selfPromise = bridge.handleAuthorizedMessage({
        chatId: normalized.chatId,
        userId: normalized.userId,
        chatType: normalized.chatType,
        locale,
        text: fanCommand.prompt,
        messageThreadId: normalized.messageThreadId,
        conversationKey: normalized.conversationKey,
        files: [],
        workspaceOverride: cfg.resume?.workspacePath,
        disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
        onEngineEvent: context.onEngineEvent,
        abortSignal: context.abortSignal,
      })
        .then(async (r) => {
          await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, r.usage);
          return { name: currentInstance, text: r.text, error: null as string | null, stopped: false };
        })
        // Capture cancellation when this branch settles, so a later Stop does
        // not relabel an already observed failure. Never infer it from text.
        .catch((e) => ({ name: currentInstance, text: "", error: describeBusFailure(e, locale), stopped: context.abortSignal?.aborted === true }));

      const peerPromises = targets.map((target, index) =>
        delegateToInstance({ fromInstance: currentInstance, targetInstance: target, prompt: fanCommand.prompt, depth: 0, stateDir, abortSignal: context.abortSignal, ...(input.agentBusMembers ? { agentBusMemberIndex: index } : {}) })
          .then((r) => ({ name: target, text: r.text, error: null as string | null, stopped: false }))
          .catch((e) => ({ name: target, text: "", error: describeBusFailure(e, locale), stopped: context.abortSignal?.aborted === true })),
      );

      const results = await Promise.all([selfPromise, ...peerPromises]);
      const sections: string[] = [];
      for (const r of results) {
        sections.push(r.stopped
          ? `[${r.name}] ${hostT(locale, "已停止，未返回完成结果。")}`
          : r.error !== null
          ? `[${r.name}] Error: ${r.error}`
          : `[${r.name}]\n${renderNonEmptyEngineText(r.text, locale)}`);
      }
      fanErrorCount = results.filter((r) => r.error !== null).length;
      if (fanErrorCount || context.abortSignal?.aborted) fanOutcome = "error";

      const completed = results.length - fanErrorCount;
      const stoppedSummary = completed === 0
        ? hostT(locale, "协作已停止，尚未取得完成结果。")
        : completed === results.length
          ? hostT(locale, "已收到停止请求；所有 {0} 个 Bot 均已返回结果。", completed)
          : hostT(locale, "协作已停止，已保留 {0}/{1} 个 Bot 返回的结果。", completed, results.length);
      const summary = context.abortSignal?.aborted
        ? stoppedSummary
        : fanErrorCount ? hostT(locale, "部分完成：{0}/{1} 个 Bot 返回结果。", completed, results.length) : "";
      const fanResponse = [summary, sections.join("\n\n---\n\n")].filter(Boolean).join("\n\n");
      const chunks = commandReplyChunks(context, fanResponse);
      fanResponseLength = fanResponse.length;
      fanChunkCount = chunks.length;
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }
    } catch (error) {
      fanOutcome = "error";
      const detail = describeBusFailure(error, locale);
      await context.api.sendMessage(
        normalized.chatId,
        hostT(locale, "并行执行失败：{0}", detail),
      );
    }

    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: fanOutcome,
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "fan",
        fanTargets: targets,
        errorCount: fanErrorCount,
        responseChars: fanResponseLength || undefined,
        chunkCount: fanChunkCount || undefined,
      },
    });
    return true;
  }

  const chainCommand = parseChainCommand(normalized.text);
  if (chainCommand) {
    if (taskPlan) chainCommand.prompt = taskPlan.prompt;
    const busConfig = await loadBusConfig(stateDir);
    const chainTargets = taskPlan?.targets ?? busConfig?.chain ?? [];
    if (chainTargets.length === 0) {
      await context.api.sendMessage(
        normalized.chatId,
        hostT(locale, "未配置 chain bot。在 config.json 的 bus.chain 中添加实例名。"),
      );
      return true;
    }

    const currentInstance = context.instanceName ?? "default";
    if (chainTargets.includes(currentInstance) && !input.agentBusMembers) {
      await context.api.sendMessage(
        normalized.chatId,
        hostT(locale, "chain 配置不能包含当前实例。请从 bus.chain 中移除 self-target。"),
      );
      return true;
    }
    await context.api.sendMessage(
      normalized.chatId,
      hostT(locale, "正在顺序串联 {0} 个 bot...", chainTargets.length),
    );

    let chainOutcome: "success" | "error" = "success";
    let chainResponseLength = 0;
    let chainChunkCount = 0;
    const sections: string[] = [];
    try {
      let stagePrompt = chainCommand.prompt;
      let previousInstance = currentInstance;

      for (const [index, target] of chainTargets.entries()) {
        context.abortSignal?.throwIfAborted();
        await context.api.sendMessage(normalized.chatId, hostT(locale, "正在执行第 {0}/{1} 步：{2}", index + 1, chainTargets.length, target));
        const result = await delegateToInstance({
          fromInstance: currentInstance,
          targetInstance: target,
          ...(input.agentBusMembers ? { agentBusMemberIndex: index } : {}),
          prompt: stagePrompt,
          depth: 0,
          stateDir,
          abortSignal: context.abortSignal,
        });

        const stageText = renderNonEmptyEngineText(result.text, locale);
        sections.push(
          hostT(locale, "[链路阶段 {0}: {1}]\n{2}", index + 1, target, stageText),
        );
        context.abortSignal?.throwIfAborted();

        previousInstance = target;
        stagePrompt = buildChainStagePrompt({
          locale,
          originalPrompt: chainCommand.prompt,
          previousInstance,
          previousOutput: stageText,
        });
      }

      const chainResponse = sections.join("\n\n---\n\n");
      const chunks = commandReplyChunks(context, chainResponse);
      chainResponseLength = chainResponse.length;
      chainChunkCount = chunks.length;
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }
    } catch (error) {
      chainOutcome = "error";
      const detail = describeBusFailure(error, locale);
      const status = context.abortSignal?.aborted ? hostT(locale, "串联已停止。") : hostT(locale, "串联执行失败：{0}", detail);
      for (const chunk of commandReplyChunks(context, [status, ...sections].join("\n\n"))) await context.api.sendMessage(normalized.chatId, chunk);
    }

    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: chainOutcome,
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "chain",
        chainTargets,
        stageCount: sections.length,
        responseChars: chainResponseLength || undefined,
        chunkCount: chainChunkCount || undefined,
      },
    });
    return true;
  }

  const verifyCommand = parseVerifyCommand(normalized.text);
  if (verifyCommand) {
    if (taskPlan) verifyCommand.prompt = taskPlan.prompt;
    const busConfig = await loadBusConfig(stateDir);
    const verifier = taskPlan?.targets?.[0] ?? busConfig?.verifier;
    if (!verifier) {
      await context.api.sendMessage(
        normalized.chatId,
        hostT(locale, "未配置验证 bot。在 config.json 的 bus.verifier 中设置实例名。"),
      );
      return true;
    }

    const currentInstance = context.instanceName ?? "default";
    if (verifier === currentInstance && !input.agentBusMembers) {
      await context.api.sendMessage(
        normalized.chatId,
        hostT(locale, "验证 bot 不能是自己。"),
      );
      return true;
    }

    if (await maybeReplyWithBudgetExhausted(stateDir, cfg.budgetUsd, locale, context, normalized)) {
      return true;
    }
    await context.api.sendMessage(normalized.chatId, hostT(locale, "正在执行..."));

    let verifyOutcome: "success" | "error" = "success";
    let verifyResponseLength = 0;
    let verifyChunkCount = 0;
    let initialAnswer = "";
    try {
      const result = await bridge.handleAuthorizedMessage({
        chatId: normalized.chatId,
        userId: normalized.userId,
        chatType: normalized.chatType,
        locale,
        text: verifyCommand.prompt,
        messageThreadId: normalized.messageThreadId,
        conversationKey: normalized.conversationKey,
        files: [],
        workspaceOverride: cfg.resume?.workspacePath,
        disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
        onEngineEvent: context.onEngineEvent,
        abortSignal: context.abortSignal,
      });
      await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);
      const resultText = renderNonEmptyEngineText(result.text, locale);
      initialAnswer = resultText;
      context.abortSignal?.throwIfAborted();

      await context.api.sendMessage(
        normalized.chatId,
        hostT(locale, "正在让 {0} 验证...", verifier),
      );

      const verifyResult = await delegateToInstance({
        fromInstance: currentInstance,
        targetInstance: verifier,
        ...(input.agentBusMembers ? { agentBusMemberIndex: 0 } : {}),
        prompt: hostT(locale, "请验证以下回复的正确性和质量：\n\n原始问题：{0}\n\n回复：{1}", verifyCommand.prompt, resultText),
        depth: 0,
        stateDir,
        abortSignal: context.abortSignal,
      });
      const verificationText = renderNonEmptyEngineText(verifyResult.text, locale);

      const verifyResponse = [
        hostT(locale, "[{0} 的回复]", currentInstance),
        resultText,
        "",
        "---",
        "",
        hostT(locale, "[{0} 的验证]", verifier),
        verificationText,
      ].join("\n");

      const chunks = commandReplyChunks(context, verifyResponse);
      verifyResponseLength = verifyResponse.length;
      verifyChunkCount = chunks.length;
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }
    } catch (error) {
      verifyOutcome = "error";
      const detail = describeBusFailure(error, locale);
      const status = context.abortSignal?.aborted ? hostT(locale, "复核已停止。") : hostT(locale, "验证流程失败：{0}", detail);
      const retained = initialAnswer ? hostT(locale, "以下为尚未完成复核的原始回答：\n\n{0}", initialAnswer) : "";
      for (const chunk of commandReplyChunks(context, [status, retained].filter(Boolean).join("\n\n"))) await context.api.sendMessage(normalized.chatId, chunk);
    }

    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: verifyOutcome,
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "verify",
        verifier,
        responseChars: verifyResponseLength || undefined,
        chunkCount: verifyChunkCount || undefined,
      },
    });
    return true;
  }

  return false;
}
