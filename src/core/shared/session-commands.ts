import { lstat, realpath, stat, unlink } from "node:fs/promises";

import type { ExternalSessionInfo } from "../../codex/adapter.js";
import { SessionStateError } from "../../runtime/session-manager.js";
import {
  formatAntigravityConversationList,
  formatSessionList,
  MAX_FORMATTED_ANTIGRAVITY_CONVERSATIONS,
  scanRecentAntigravityConversations,
  scanRecentClaudeSessions,
  findClaudeSession,
  CLAUDE_SESSION_ID,
  type ScannedSession,
} from "../../runtime/session-scanner.js";
import type { InstanceEngine, ResumeState } from "../../state/instance-config.js";
import { renderSessionResetMessage, type Locale } from "../../runtime/message-renderer.js";
import { normalizeLocale } from "../../runtime/locale.js";
import { hostT } from "../../locales/index.js";
import {
  appendCommandSuccessAuditEventBestEffort,
  type CoreTurnContext,
} from "./turn-bookkeeping.js";
import type { CommandMessage } from "../../runtime/command-message.js";
import { isResetCommand } from "../../runtime/command-detection.js";
import path from "node:path";
import { getNormalizedConversationKey, getConversationKey } from "../../runtime/conversation-key.js";
import { bridgeConversationLockId, sessionLockNamespace, withBridgeTurnLock } from "../../runtime/turn-lock.js";
import { resolveConversationResume } from "../../runtime/conversation-resume.js";

export interface SessionCommandConfig {
  engine: InstanceEngine;
  resume?: ResumeState;
}

export interface SessionCommandStore {
  inspect(): Promise<{ warning?: string; repairable?: boolean }>;
  findByChatIdSafe(chatId: number): Promise<{
    record: {
      codexSessionId: string;
      resume?: ResumeState | null;
      suspendedPrevious?: {
        sessionId: string | null;
        resume: ResumeState | null;
      };
    } | null;
    warning?: string;
    repairable?: boolean;
  }>;
  findByConversationKeySafe?(conversationKey: string): Promise<{
    record: {
      codexSessionId: string;
      resume?: ResumeState | null;
      suspendedPrevious?: {
        sessionId: string | null;
        resume: ResumeState | null;
      };
    } | null;
    warning?: string;
    repairable?: boolean;
  }>;
  removeByChatId(chatId: number): Promise<boolean | void>;
  removeByConversationKey?(conversationKey: string): Promise<boolean | void>;
  upsert(record: {
    telegramChatId: number;
    telegramThreadId?: number;
    conversationKey?: string;
    codexSessionId: string;
    status: "idle";
    updatedAt: string;
    resume?: ResumeState | null;
    suspendedPrevious?: {
      sessionId: string | null;
      resume: ResumeState | null;
    };
  }): Promise<void>;
}

const RESUME_SCAN_TTL_MS = 10 * 60 * 1000;
const ANTIGRAVITY_CONVERSATION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type PendingResumeScanKind = "claude" | "antigravity" | "kimi" | "deepseek" | "pi" | "omp";

const pendingResumeScans = new Map<string, {
  kind: PendingResumeScanKind;
  scannedAt: number;
  sessions: ScannedSession[];
}>();

type ResumeCommand =
  | { kind: "scan" }
  | { kind: "pick"; pick: number }
  | { kind: "thread"; threadId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "conversation"; conversationId: string }
  | { kind: "invalid" };

function parseResumeCommand(text: string): ResumeCommand | null {
  const match = text.trim().match(/^\/resume(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return null;
  const arg = match[1]?.trim();
  if (!arg) return { kind: "scan" };

  const threadMatch = arg.match(/^thread\s+(\S+)$/i);
  if (threadMatch?.[1]?.trim()) {
    return { kind: "thread", threadId: threadMatch[1].trim() };
  }

  const conversationMatch = arg.match(/^(?:conversation|conv)\s+(\S+)$/i);
  if (conversationMatch?.[1]?.trim()) {
    return { kind: "conversation", conversationId: conversationMatch[1].trim() };
  }

  const sessionMatch = arg.match(/^session\s+(\S+)$/i);
  if (sessionMatch?.[1]?.trim()) {
    return { kind: "session", sessionId: sessionMatch[1].trim() };
  }

  const bareId = arg.startsWith("[") && arg.endsWith("]") ? arg.slice(1, -1).trim() : arg;
  if (CLAUDE_SESSION_ID.test(bareId)) return { kind: "session", sessionId: bareId.toLowerCase() };

  const num = Number(arg);
  if (!Number.isInteger(num) || num < 1) return { kind: "invalid" };
  return { kind: "pick", pick: num };
}

function isDetachCommand(text: string): boolean {
  return /^\/detach(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export function resetPendingResumeScans(): void {
  pendingResumeScans.clear();
}

function getPendingResumeScan(conversationKey: string, kind: PendingResumeScanKind): ScannedSession[] | null {
  const entry = pendingResumeScans.get(conversationKey);
  if (!entry) {
    return null;
  }

  if (entry.kind !== kind || Date.now() - entry.scannedAt > RESUME_SCAN_TTL_MS) {
    pendingResumeScans.delete(conversationKey);
    return null;
  }

  return entry.sessions;
}

function isAntigravityConversationId(value: string): boolean {
  return ANTIGRAVITY_CONVERSATION_ID_PATTERN.test(value);
}

function buildSuspendedPreviousSnapshot(input: {
  existingRecord: {
    codexSessionId: string;
    resume?: ResumeState | null;
    suspendedPrevious?: {
      sessionId: string | null;
      resume: ResumeState | null;
    };
  } | null;
  currentResume: ResumeState | undefined;
}): { sessionId: string | null; resume: ResumeState | null } | undefined {
  if (input.existingRecord?.suspendedPrevious) {
    return input.existingRecord.suspendedPrevious;
  }

  if (!input.existingRecord?.codexSessionId && !input.currentResume) {
    return undefined;
  }

  return {
    sessionId: input.existingRecord?.codexSessionId ?? null,
    resume: input.currentResume ?? null,
  };
}

function findSessionForConversation(
  store: SessionCommandStore,
  normalized: CommandMessage,
): ReturnType<SessionCommandStore["findByChatIdSafe"]> {
  const conversationKey = getNormalizedConversationKey(normalized);
  return store.findByConversationKeySafe
    ? store.findByConversationKeySafe(conversationKey)
    : store.findByChatIdSafe(normalized.chatId);
}

function removeSessionForConversation(
  store: SessionCommandStore,
  normalized: CommandMessage,
): Promise<boolean | void> {
  const conversationKey = getNormalizedConversationKey(normalized);
  return store.removeByConversationKey
    ? store.removeByConversationKey(conversationKey)
    : store.removeByChatId(normalized.chatId);
}

function sessionScopeRecordFields(normalized: CommandMessage): {
  telegramThreadId?: number;
  conversationKey?: string;
} {
  const conversationKey = getNormalizedConversationKey(normalized);
  const defaultConversationKey = getConversationKey(normalized.chatId, normalized.messageThreadId);
  if (normalized.messageThreadId === undefined) {
    return conversationKey === defaultConversationKey ? {} : { conversationKey };
  }
  return {
    telegramThreadId: normalized.messageThreadId,
    conversationKey,
  };
}

interface LocalSessionCommandInput {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: SessionCommandConfig;
  workspaceOverride?: string;
  normalized: CommandMessage;
  context: CoreTurnContext;
  sessionStore: SessionCommandStore;
  updateInstanceConfig: (updater: (config: Record<string, unknown>) => void) => Promise<void>;
  validateCodexThread?: (
    threadId: string,
    input?: { workspaceOverride?: string },
  ) => Promise<ExternalSessionInfo | void>;
  scanRecentSessions?: (hours: number) => Promise<ScannedSession[]>;
  findClaudeSessionById?: (sessionId: string) => Promise<ScannedSession | null>;
  scanRecentAntigravitySessions?: (hours: number) => Promise<ScannedSession[]>;
  scanRecentKimiSessions?: () => Promise<ScannedSession[]>;
  scanRecentDeepSeekSessions?: () => Promise<ScannedSession[]>;
  scanRecentPiSessions?: () => Promise<ScannedSession[]>;
  scanRecentOmpSessions?: () => Promise<ScannedSession[]>;
  formatSessionListMessage?: (sessions: ScannedSession[], locale: Locale) => string;
  formatAntigravityConversationListMessage?: (sessions: ScannedSession[], locale: Locale) => string;
  sendResumeScanResult?: (input: {
    kind: "claude" | "antigravity" | "kimi" | "deepseek" | "pi" | "omp";
    sessions: ScannedSession[];
    visibleSessions: ScannedSession[];
    locale: Locale;
  }) => Promise<void>;
}

export async function handleLocalSessionCoreCommand(input: LocalSessionCommandInput): Promise<boolean> {
  if (!/^\/(?:reset|resume|detach)(?:@\w+)?(?:\s|$)/i.test(input.normalized.text.trim())) return false;
  const namespace = await sessionLockNamespace(path.join(input.stateDir, "session.json"));
  return await withBridgeTurnLock(bridgeConversationLockId(input.normalized, namespace), async () => await handleLocalSessionCommandUnlocked(input));
}

async function handleLocalSessionCommandUnlocked(input: LocalSessionCommandInput): Promise<boolean> {
  const {
    stateDir,
    startedAt,
    locale,
    cfg,
    workspaceOverride,
    normalized,
    context,
    sessionStore,
    updateInstanceConfig,
    validateCodexThread,
    scanRecentSessions = scanRecentClaudeSessions,
    findClaudeSessionById = findClaudeSession,
    scanRecentAntigravitySessions = scanRecentAntigravityConversations,
    scanRecentKimiSessions,
    scanRecentDeepSeekSessions,
    scanRecentPiSessions,
    scanRecentOmpSessions,
    formatSessionListMessage = formatSessionList,
    formatAntigravityConversationListMessage = formatAntigravityConversationList,
    sendResumeScanResult,
  } = input;
  const conversationKey = getNormalizedConversationKey(normalized);

  if (isResetCommand(normalized.text)) {
    const inspectedState = await sessionStore.inspect();
    if (inspectedState.warning) {
      throw new SessionStateError(
        inspectedState.repairable
          ? "Session state is unreadable right now. The operator needs to repair session state and retry."
          : "Session state is unavailable right now. The operator needs to restore read access and retry.",
        inspectedState.repairable ?? false,
      );
    }

    const current = await findSessionForConversation(sessionStore, normalized);
    const currentResume = current.warning
      ? undefined
      : resolveConversationResume(current.record, cfg.resume);
    if (currentResume) {
      if (currentResume.symlinkPath) {
        try {
          const st = await lstat(currentResume.symlinkPath);
          if (st.isSymbolicLink()) await unlink(currentResume.symlinkPath);
        } catch {
          // ok
        }
      }
    }
    await removeSessionForConversation(sessionStore, normalized);
    await updateInstanceConfig((c) => { delete c.resume; });

    const resetMessage = renderSessionResetMessage(false, locale);
    await context.api.sendMessage(normalized.chatId, resetMessage);
    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "reset",
      responseText: resetMessage,
    });
    return true;
  }

  const resumeCmd = parseResumeCommand(normalized.text);
  if (resumeCmd) {
    if (cfg.engine === "kimi" || cfg.engine === "deepseek" || cfg.engine === "pi" || cfg.engine === "omp") {
      const isDeepSeek = cfg.engine === "deepseek";
      const scanKind = cfg.engine;
      const engineName = cfg.engine === "omp" ? "omp" : cfg.engine === "pi" ? "Pi" : isDeepSeek ? "DeepSeek Harness" : "Kimi";
      const scanRecentHarnessSessions = cfg.engine === "omp" ? scanRecentOmpSessions : cfg.engine === "pi" ? scanRecentPiSessions : isDeepSeek ? scanRecentDeepSeekSessions : scanRecentKimiSessions;
      if (resumeCmd.kind === "scan") {
        if (!scanRecentHarnessSessions) {
          const msg = hostT(locale, "当前 {0} runtime 未提供 session 列表。", engineName);
          await context.api.sendMessage(normalized.chatId, msg);
          await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
            startedAt,
            command: "resume",
            responseText: msg,
            metadata: { engine: cfg.engine, rejected: "listing-unavailable" },
          });
          return true;
        }
        const sessions = (await scanRecentHarnessSessions()).slice(0, MAX_FORMATTED_ANTIGRAVITY_CONVERSATIONS);
        if (sessions.length > 0) {
          pendingResumeScans.set(conversationKey, { kind: scanKind, scannedAt: Date.now(), sessions });
        } else {
          pendingResumeScans.delete(conversationKey);
        }
        const msg = sessions.length > 0
          ? [
              hostT(locale, "{0} sessions：", engineName),
              ...sessions.map((session, index) => `${index + 1}. [${session.displayName}] ${session.sessionId}`),
              hostT(locale, "\n回复 /resume <编号> 继续。"),
            ].join("\n")
          : hostT(locale, "没有找到 {0} session。", engineName);
        if (sendResumeScanResult) {
          await sendResumeScanResult({ kind: scanKind, sessions, visibleSessions: sessions, locale });
        } else {
          await context.api.sendMessage(normalized.chatId, msg);
        }
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { engine: cfg.engine, scanned: sessions.length },
        });
        return true;
      }

      let sessionId: string | null = null;
      let selectedSession: ScannedSession | undefined;
      if (resumeCmd.kind === "pick") {
        const cached = getPendingResumeScan(conversationKey, scanKind);
        if (!cached || resumeCmd.pick < 1 || resumeCmd.pick > cached.length) {
          const msg = hostT(locale, "无效选择，请先发 /resume 扫描 {0} session。", engineName);
          await context.api.sendMessage(normalized.chatId, msg);
          await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
            startedAt,
            command: "resume",
            responseText: msg,
            metadata: { engine: cfg.engine, rejected: "invalid-pick" },
          });
          return true;
        }
        selectedSession = cached[resumeCmd.pick - 1]!;
        sessionId = selectedSession.sessionId;
        pendingResumeScans.delete(conversationKey);
      } else if (resumeCmd.kind === "session") {
        sessionId = resumeCmd.sessionId;
      } else {
        const msg = hostT(locale, "用法: /resume、/resume <编号> 或 /resume session <session-id>");
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { engine: cfg.engine, rejected: "invalid-session-arg" },
        });
        return true;
      }

      let validatedSession: ExternalSessionInfo | void;
      let workspacePath: string;
      try {
        if (!validateCodexThread) {
          throw new Error("external session validation unsupported");
        }
        validatedSession = workspaceOverride
          ? await validateCodexThread(sessionId, { workspaceOverride })
          : await validateCodexThread(sessionId);
        const candidate = validatedSession?.cwd ?? selectedSession?.workspacePath;
        if (!candidate) {
          throw new Error(`${engineName} session workspace is unavailable`);
        }
        workspacePath = await realpath(candidate);
        const workspaceInfo = await stat(workspacePath);
        if (!workspaceInfo.isDirectory()) {
          throw new Error(`${engineName} session workspace is not a directory`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const unsupported = /validation unsupported|listing unsupported/i.test(detail);
        const msg = unsupported
          ? hostT(locale, "当前 {0} runtime 无法验证 session id。", engineName)
          : hostT(locale, "无法加载 {0} session：{1}", engineName, sessionId);
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: {
            engine: cfg.engine,
            rejected: unsupported ? "session-validation-unavailable" : "session-load-failed",
          },
        });
        return true;
      }

      const existing = await findSessionForConversation(sessionStore, normalized);
      const nextResume: ResumeState = {
        sessionId,
        dirName: selectedSession?.dirName ?? sessionId,
        workspacePath,
      };
      await sessionStore.upsert({
        telegramChatId: normalized.chatId,
        ...sessionScopeRecordFields(normalized),
        codexSessionId: sessionId,
        status: "idle",
        updatedAt: new Date().toISOString(),
        resume: nextResume,
        suspendedPrevious: buildSuspendedPreviousSnapshot({
          existingRecord: existing.record,
          currentResume: resolveConversationResume(existing.record, cfg.resume),
        }),
      });
      await updateInstanceConfig((c) => { delete c.resume; });

      const msg = hostT(locale, "已绑定 {0} session：{1}\n工作区：{2}\n\n发送消息继续对话，完成后发 /detach 断开。", engineName, sessionId, workspacePath);
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "resume",
        responseText: msg,
        metadata: { engine: cfg.engine, sessionId },
      });
      return true;
    }

    if (cfg.engine === "antigravity") {
      if (resumeCmd.kind === "scan") {
        const sessions = await scanRecentAntigravitySessions(24);
        const selectableSessions = sessions.slice(0, MAX_FORMATTED_ANTIGRAVITY_CONVERSATIONS);
        const msg = formatAntigravityConversationListMessage(sessions, locale);
        if (selectableSessions.length > 0) {
          pendingResumeScans.set(conversationKey, {
            kind: "antigravity",
            scannedAt: Date.now(),
            sessions: selectableSessions,
          });
        } else {
          pendingResumeScans.delete(conversationKey);
        }
        if (sendResumeScanResult) {
          await sendResumeScanResult({
            kind: "antigravity",
            sessions,
            visibleSessions: selectableSessions,
            locale,
          });
        } else {
          await context.api.sendMessage(normalized.chatId, msg);
        }
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { engine: "antigravity", scanned: sessions.length },
        });
        return true;
      }

      let pickedConversationId: string | null = null;
      if (resumeCmd.kind === "pick") {
        const cached = getPendingResumeScan(conversationKey, "antigravity");
        if (!cached || resumeCmd.pick < 1 || resumeCmd.pick > cached.length) {
          const msg = hostT(locale, "无效选择，请先发 /resume 扫描 Antigravity conversation。");
          await context.api.sendMessage(normalized.chatId, msg);
          await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
            startedAt,
            command: "resume",
            responseText: msg,
            metadata: { engine: "antigravity", rejected: "invalid-pick" },
          });
          return true;
        }
        pickedConversationId = cached[resumeCmd.pick - 1]!.sessionId;
        pendingResumeScans.delete(conversationKey);
      }

      if (resumeCmd.kind !== "conversation" && resumeCmd.kind !== "pick") {
        const msg = hostT(locale, "用法: /resume、/resume <编号> 或 /resume conversation <conversation-id>。");
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { rejected: "invalid-antigravity-arg" },
        });
        return true;
      }

      const conversationId = pickedConversationId ?? (resumeCmd.kind === "conversation" ? resumeCmd.conversationId : null);
      if (!conversationId) {
        return true;
      }
      if (!isAntigravityConversationId(conversationId)) {
        const msg = hostT(locale, "Antigravity conversation id 无效。请使用 /resume 扫描最近 conversation，或发送 /resume conversation <uuid>。");
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { engine: "antigravity", rejected: "invalid-conversation-id" },
        });
        return true;
      }
      const existing = await findSessionForConversation(sessionStore, normalized);
      await sessionStore.upsert({
        telegramChatId: normalized.chatId,
        ...sessionScopeRecordFields(normalized),
        codexSessionId: conversationId,
        status: "idle",
        updatedAt: new Date().toISOString(),
        resume: null,
        suspendedPrevious: buildSuspendedPreviousSnapshot({
          existingRecord: existing.record,
          currentResume: resolveConversationResume(existing.record, cfg.resume),
        }),
      });
      await updateInstanceConfig((c) => { delete c.resume; });

      const msg = hostT(locale, "已绑定 Antigravity conversation：{0}\n\n发送消息继续对话，完成后发 /detach 断开。", conversationId);
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "resume",
        responseText: msg,
        metadata: { conversationId },
      });
      return true;
    }

    if (cfg.engine === "codex") {
      if (resumeCmd.kind !== "thread") {
        const msg = hostT(locale, "Codex 请使用 /resume thread <thread-id>。普通 /resume 扫描仅适用于 Claude。");
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: { rejected: "codex-requires-thread-id" },
        });
        return true;
      }

      try {
        if (!validateCodexThread) {
          throw new Error("codex thread validation unsupported");
        }
        if (workspaceOverride) {
          await validateCodexThread(resumeCmd.threadId, { workspaceOverride });
        } else {
          await validateCodexThread(resumeCmd.threadId);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const isNotFound = /could not resume thread|thread not found|no rollout found/i.test(detail);
        const isUnsupported = /validation unsupported/i.test(detail);
        const isActiveWriter = /already has an active writer/i.test(detail);
        const activeWriterDiagnosis = detail.split(/\n\s*\n/).slice(1).join("\n\n").trim();
        const activeWriterBody = normalizeLocale(locale, "en") === "zh" && activeWriterDiagnosis
          ? activeWriterDiagnosis
          : hostT(locale, "该会话正被另一个 Codex 进程占用。结束占用方后重试；重启本 bot 无效。");
        const msg = isActiveWriter
          ? hostT(locale, "Codex thread 正被占用：{0}\n\n{1}", resumeCmd.threadId, activeWriterBody)
          : isNotFound
            ? hostT(locale, "未找到 Codex thread：{0}\n\n请检查 thread id 后重试。", resumeCmd.threadId)
            : isUnsupported
              ? hostT(locale, "当前 Codex runtime 无法为 /resume thread 验证外部 thread id。")
              : hostT(locale, "验证 Codex thread 失败：{0}", resumeCmd.threadId);
        await context.api.sendMessage(normalized.chatId, msg);
        await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
          startedAt,
          command: "resume",
          responseText: msg,
          metadata: {
            rejected: isActiveWriter
              ? "thread-active-writer"
              : isNotFound
                ? "thread-not-found"
                : "thread-validation-unavailable",
          },
        });
        return true;
      }

      const existing = await findSessionForConversation(sessionStore, normalized);
      await sessionStore.upsert({
        telegramChatId: normalized.chatId,
        ...sessionScopeRecordFields(normalized),
        codexSessionId: resumeCmd.threadId,
        status: "idle",
        updatedAt: new Date().toISOString(),
        resume: null,
        suspendedPrevious: buildSuspendedPreviousSnapshot({
          existingRecord: existing.record,
          currentResume: resolveConversationResume(existing.record, cfg.resume),
        }),
      });
      await updateInstanceConfig((c) => { delete c.resume; });

      const msg = hostT(locale, "已绑定 Codex thread：{0}\n\n发送消息继续对话，完成后发 /detach 断开。", resumeCmd.threadId);
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "resume",
        responseText: msg,
        metadata: { threadId: resumeCmd.threadId },
      });
      return true;
    }

    if (resumeCmd.kind === "invalid" || resumeCmd.kind === "thread" || resumeCmd.kind === "conversation" || resumeCmd.kind === "session" && !CLAUDE_SESSION_ID.test(resumeCmd.sessionId)) {
      const msg = hostT(locale, "用法：/resume 扫描后按编号选择，或 /resume <完整 session ID> 直接绑定本机 Claude 会话。");
      await context.api.sendMessage(normalized.chatId, msg);
      await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
        startedAt,
        command: "resume",
        responseText: msg,
        metadata: { rejected: "invalid-arg" },
      });
      return true;
    }

    let resumeAuditText: string | undefined;
    if (resumeCmd.kind === "scan") {
      const sessions = await scanRecentSessions(1);
      if (sessions.length === 0) {
        pendingResumeScans.delete(conversationKey);
        resumeAuditText = hostT(locale, "最近 1 小时内没有找到本地 session。");
        if (sendResumeScanResult) {
          await sendResumeScanResult({
            kind: "claude",
            sessions: [],
            visibleSessions: [],
            locale,
          });
        } else {
          await context.api.sendMessage(normalized.chatId, resumeAuditText);
        }
      } else {
        resumeAuditText = formatSessionListMessage(sessions, locale);
        pendingResumeScans.set(conversationKey, {
          kind: "claude",
          scannedAt: Date.now(),
          sessions,
        });
        if (sendResumeScanResult) {
          await sendResumeScanResult({
            kind: "claude",
            sessions,
            visibleSessions: sessions,
            locale,
          });
        } else {
          await context.api.sendMessage(normalized.chatId, resumeAuditText);
        }
      }
    } else {
      const cached = getPendingResumeScan(conversationKey, "claude");
      let picked: ScannedSession | null | undefined;
      let lookupError = false;
      if (resumeCmd.kind === "session") {
        try { picked = await findClaudeSessionById(resumeCmd.sessionId); }
        catch { lookupError = true; }
      } else if (cached) picked = cached[resumeCmd.pick - 1];
      if (!picked) {
        if (resumeCmd.kind !== "session") {
          resumeAuditText = hostT(locale, "无效选择，请先发 /resume 扫描。");
        } else if (lookupError) {
          resumeAuditText = hostT(locale, "无法安全读取此 Claude 会话，请检查主机文件访问权限及是否存在重复 ID。当前对话未改变。");
        } else {
          resumeAuditText = hostT(locale, "此主机未找到该 Claude session ID。请核对 ID 及运行 Bot 的主机；当前对话未改变。");
        }
        await context.api.sendMessage(normalized.chatId, resumeAuditText);
      } else {
        pendingResumeScans.delete(conversationKey);

        if (!picked.workspacePath) {
          resumeAuditText = hostT(locale, "无法从 session 元数据确认工作区路径（{0}），当前对话未改变。请先在主机 Claude CLI 中打开此会话后重试。", picked.dirName);
          await context.api.sendMessage(normalized.chatId, resumeAuditText);
        } else {
          const existing = await findSessionForConversation(sessionStore, normalized);
          const nextResume: ResumeState = {
            sessionId: picked.sessionId,
            dirName: picked.dirName,
            workspacePath: picked.workspacePath,
          };
          await sessionStore.upsert({
            telegramChatId: normalized.chatId,
            ...sessionScopeRecordFields(normalized),
            codexSessionId: picked.sessionId,
            status: "idle",
            updatedAt: new Date().toISOString(),
            resume: nextResume,
            suspendedPrevious: buildSuspendedPreviousSnapshot({
              existingRecord: existing.record,
              currentResume: resolveConversationResume(existing.record, cfg.resume),
            }),
          });
          await updateInstanceConfig((c) => { delete c.resume; });

          resumeAuditText = hostT(locale, "已绑定 session：{0}\n工作区：{1}\n\n发送下一条消息时由 Claude 加载并继续；大会话可能需要较长时间。完成后发 /detach 返回之前的对话。", picked.sessionId, picked.workspacePath);
          await context.api.sendMessage(normalized.chatId, resumeAuditText);
        }
      }
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "resume",
      responseText: resumeAuditText,
      metadata: { pick: resumeCmd.kind === "pick" ? resumeCmd.pick : null, sessionId: resumeCmd.kind === "session" ? resumeCmd.sessionId : null },
    });
    return true;
  }

  if (isDetachCommand(normalized.text)) {
    const current = await findSessionForConversation(sessionStore, normalized);
    const currentResume = current.warning
      ? undefined
      : resolveConversationResume(current.record, cfg.resume);
    let detachMessage: string;
    if (current.record?.suspendedPrevious) {
      const previous = current.record.suspendedPrevious;
      if (previous.sessionId) {
        await sessionStore.upsert({
          telegramChatId: normalized.chatId,
          ...sessionScopeRecordFields(normalized),
          codexSessionId: previous.sessionId,
          status: "idle",
          updatedAt: new Date().toISOString(),
          resume: previous.resume,
        });
      } else {
        await removeSessionForConversation(sessionStore, normalized);
      }

      await updateInstanceConfig((c) => { delete c.resume; });

      detachMessage = hostT(
        locale,
        cfg.engine === "codex"
          ? "已断开当前 Codex thread，并恢复到 /resume 之前的对话。"
          : cfg.engine === "antigravity"
            ? "已断开当前 Antigravity conversation，并恢复到 /resume 之前的对话。"
            : cfg.engine === "kimi"
              ? "已断开当前 Kimi session，并恢复到 /resume 之前的对话。"
              : cfg.engine === "deepseek"
                ? "已断开当前 DeepSeek Harness session，并恢复到 /resume 之前的对话。"
                : cfg.engine === "pi"
                  ? "已断开当前 Pi session，并恢复到 /resume 之前的对话。"
                  : cfg.engine === "omp"
                    ? "已断开当前 omp session，并恢复到 /resume 之前的对话。"
                    : "已断开恢复的 session，并恢复到 /resume 之前的对话。",
      );
      await context.api.sendMessage(normalized.chatId, detachMessage);
    } else if (currentResume) {
      if (currentResume.symlinkPath) {
        try {
          const st = await lstat(currentResume.symlinkPath);
          if (st.isSymbolicLink()) await unlink(currentResume.symlinkPath);
        } catch {
          // ok
        }
      }

      await removeSessionForConversation(sessionStore, normalized);
      await updateInstanceConfig((c) => { delete c.resume; });

      detachMessage = hostT(locale, "已断开恢复的 session，回到 bot 默认工作区。");
      await context.api.sendMessage(normalized.chatId, detachMessage);
    } else if (cfg.engine === "codex" || cfg.engine === "antigravity" || cfg.engine === "kimi" || cfg.engine === "deepseek" || cfg.engine === "pi" || cfg.engine === "omp") {
      const removed = await removeSessionForConversation(sessionStore, normalized);
      if (cfg.engine === "codex") {
        detachMessage = hostT(locale, removed ? "已断开当前 Codex thread。下一条消息会新建 thread。" : "当前没有绑定的 Codex thread。");
      } else if (cfg.engine === "antigravity") {
        detachMessage = hostT(locale, removed ? "已断开当前 Antigravity conversation。下一条消息会新建 conversation。" : "当前没有绑定的 Antigravity conversation。");
      } else if (cfg.engine === "kimi") {
        detachMessage = hostT(locale, removed ? "已断开当前 Kimi session。下一条消息会新建 session。" : "当前没有绑定的 Kimi session。");
      } else if (cfg.engine === "pi") {
        detachMessage = hostT(locale, removed ? "已断开当前 Pi 会话。下一条消息会新建会话。" : "当前没有绑定的 Pi 会话。");
      } else if (cfg.engine === "omp") {
        detachMessage = hostT(locale, removed ? "已断开当前 omp 会话。下一条消息会新建会话。" : "当前没有绑定的 omp 会话。");
      } else {
        detachMessage = hostT(locale, removed ? "已断开当前 DeepSeek Harness session。下一条消息会新建 session。" : "当前没有绑定的 DeepSeek Harness session。");
      }
      await context.api.sendMessage(normalized.chatId, detachMessage);
    } else {
      detachMessage = hostT(locale, "当前没有恢复的 session。");
      await context.api.sendMessage(normalized.chatId, detachMessage);
    }

    await appendCommandSuccessAuditEventBestEffort(stateDir, context, normalized, {
      startedAt,
      command: "detach",
      responseText: detachMessage,
    });
    return true;
  }

  return false;
}
