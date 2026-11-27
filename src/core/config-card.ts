import path from "node:path";
import { randomUUID } from "node:crypto";
import { channelProfile } from "./channel-profile.js";
import { applyGatewayGroupMode } from "./platform-policy.js";
import { gatewayRequiresMention } from "./platform-policy.js";

import { loadCodexUserDefaults } from "../codex/user-defaults.js";
import { renderEngineEffortSetting, renderEngineModelSetting } from "../runtime/engine-settings-display.js";
import { renderApprovalModeStatus, resolveApprovalModeForEngine } from "../state/approval-mode.js";
import { AccessStore } from "../state/access-store.js";
import { SessionStore } from "../state/session-store.js";
import {
  applyEngineSelection,
  loadInstanceConfig,
  updateInstanceApprovalMode,
  updateInstanceConfig,
  type GroupModeConfig,
  type InstanceConfig,
  type InstanceEngine,
} from "../state/instance-config.js";
import { isChineseLocale, isSupportedLocale, normalizeLocale, type Locale } from "../runtime/locale.js";
import { hostT } from "../locales/index.js";
import { CoreGroupModeStore } from "./group-mode-store.js";
import { checkGroupMsgScope, renderGroupMsgScopeWarning } from "./group-scope-check.js";
import { CoreKnownChatStore } from "./known-chats.js";
import { readRawCoreConfig } from "./locale.js";
import { coreAccessChatIdFromConversationKey, stableCoreNumericId } from "./message-normalizer.js";

const CORE_CONFIG_ENGINES: InstanceEngine[] = ["codex", "claude", "kimi", "deepseek", "antigravity", "pi", "omp"];

export type CoreConfigActionName = "engine" | "fast" | "yolo" | "locale" | "group" | "refresh" | "submit";

export interface CoreConfigCardActionValue extends Record<string, unknown> {
  cctb_lark: "config";
  action: CoreConfigActionName;
  value?: string;
  conversationKey: string;
  bridgeChatType?: "private" | "group";
  replyInThread?: boolean;
  larkChatId?: string;
  bridgeChatId?: number;
}

export interface CoreConfigCardContext {
  stateDir: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  larkChatId: string;
  bridgeChatId: number;
  replyInThread?: boolean;
  locale: Locale;
  requireMentionInGroup?: boolean;
  notice?: string;
}

export function isCoreConfigCommand(text: string): boolean {
  return /^\/config(?:\s|$)/i.test(text.trim());
}

export function isCoreConfigCardActionValue(value: Record<string, unknown>): value is CoreConfigCardActionValue {
  return value.cctb_lark === "config" &&
    typeof value.conversationKey === "string" &&
    isCoreConfigActionName(value.action);
}

export async function renderCoreConfigCard(input: CoreConfigCardContext): Promise<Record<string, unknown>> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const raw = await readRawCoreConfig(input.stateDir);
  const resolvedApprovalMode = resolveApprovalModeForEngine(
    cfg.engine,
    raw.approvalMode,
    raw.kimiAutoNeverAskAcknowledged,
  );
  const groupState = await readCoreConfigGroupState(input, cfg);
  const accessState = await new AccessStore(path.join(input.stateDir, "access.json")).load().catch(() => null);
  const knownChat = await new CoreKnownChatStore(input.stateDir).get(input.conversationKey).catch(() => null);
  const codexDefaults = cfg.engine === "codex" ? await loadCodexUserDefaults() : undefined;
  const labels = {
    ...coreConfigLabels(input.locale),
    ...(channelProfile() === "gateway" ? { title: hostT(input.locale, "TaroBird 配置面板") } : {}),
  };
  const approvalMode = cfg.engine === "kimi"
    ? renderApprovalModeStatus(
        cfg.engine,
        raw.approvalMode,
        input.locale,
        raw.kimiAutoNeverAskAcknowledged,
      )
    : resolvedApprovalMode === "bypass"
      ? "unsafe/bypass"
      : resolvedApprovalMode === "full-auto"
        ? "full-auto"
        : hostT(input.locale, "普通审批");
  const fastOn = cfg.codexServiceTier === "fast";
  const modelLabel = renderEngineModelSetting(cfg.engine, cfg.model, codexDefaults, input.locale);
  const effortLabel = renderEngineEffortSetting(cfg.engine, cfg.effort, codexDefaults, input.locale);
  const requiresMention = input.bridgeChatType === "group"
    ? (channelProfile() === "gateway" || input.requireMentionInGroup !== false) && !groupState.listenAll
    : true;
  const summaryLines = [
    `**${labels.title}**`,
    "",
    input.notice ? `**${labels.updated}** ${input.notice}` : undefined,
    `- ${labels.chat}: ${knownChat?.label ?? input.larkChatId}`,
    `- ${labels.engine}: ${cfg.engine}`,
    `- ${labels.model}: ${modelLabel}`,
    `- ${labels.effort}: ${effortLabel}`,
    `- ${labels.fast}: ${fastOn ? labels.on : labels.off}`,
    `- ${labels.yolo}: ${approvalMode}`,
    `- ${labels.locale}: ${input.locale}`,
    `- ${labels.access}: ${channelProfile() === "gateway" ? hostT(input.locale, "Hub 已配对设备与会话成员") : accessState ? labels.accessSummary(accessState.pairedUsers.length, accessState.allowlist.length) : labels.defaultValue}`,
    `- ${labels.workspace}: ${cfg.workspacePath ?? cfg.resume?.workspacePath ?? path.join(input.stateDir, "workspace")}`,
    input.bridgeChatType === "group"
      ? `- ${labels.group}: ${groupState.allowed ? labels.groupAllowed : labels.groupNotAllowed}; ${requiresMention ? labels.groupAt : labels.groupAll}`
      : `- ${labels.group}: ${labels.privateChat}`,
  ].filter((line): line is string => line !== undefined);

  const normalizedLocale = normalizeLocale(input.locale, "en");
  const elements: unknown[] = [
    markdownElement(summaryLines.join("\n")),
    configFormSection(input, cfg, resolvedApprovalMode),
    section(labels.engineSection, [
      button(optionLabel(labels.codex, cfg.engine === "codex", labels), "engine", "codex", input, cfg.engine === "codex" ? "primary" : "default"),
      button(optionLabel(labels.claude, cfg.engine === "claude", labels), "engine", "claude", input, cfg.engine === "claude" ? "primary" : "default"),
      button(optionLabel(labels.kimi, cfg.engine === "kimi", labels), "engine", "kimi", input, cfg.engine === "kimi" ? "primary" : "default"),
      button(optionLabel(labels.deepseek, cfg.engine === "deepseek", labels), "engine", "deepseek", input, cfg.engine === "deepseek" ? "primary" : "default"),
      button(optionLabel(labels.antigravity, cfg.engine === "antigravity", labels), "engine", "antigravity", input, cfg.engine === "antigravity" ? "primary" : "default"),
      ...(cfg.role === "dispatcher" ? [] : [
        button(optionLabel(labels.pi, cfg.engine === "pi", labels), "engine", "pi", input, cfg.engine === "pi" ? "primary" : "default"),
        button(optionLabel(labels.omp, cfg.engine === "omp", labels), "engine", "omp", input, cfg.engine === "omp" ? "primary" : "default"),
      ]),
    ]),
    section(labels.speedSection, [
      button(optionLabel(labels.fastOn, fastOn, labels), "fast", "on", input, fastOn ? "primary" : "default"),
      button(optionLabel(labels.fastOff, !fastOn, labels), "fast", "off", input, !fastOn ? "primary" : "default"),
    ]),
    section(labels.approvalSection, [
      ...(cfg.engine === "pi" || cfg.engine === "omp" ? [] : [button(optionLabel(labels.yoloOn, resolvedApprovalMode === "full-auto", labels), "yolo", "on", input, resolvedApprovalMode === "full-auto" ? "primary" : "default")]),
      button(optionLabel(labels.yoloOff, resolvedApprovalMode === "normal", labels), "yolo", "off", input, resolvedApprovalMode === "normal" ? "primary" : "default"),
      button(optionLabel(labels.yoloUnsafe, resolvedApprovalMode === "bypass", labels), "yolo", "unsafe", input, resolvedApprovalMode === "bypass" ? "danger" : "default"),
    ]),
    section(labels.localeSection, [
      button(optionLabel("中文", normalizedLocale === "zh", labels), "locale", "zh", input, normalizedLocale === "zh" ? "primary" : "default"),
      button(optionLabel("English", normalizedLocale === "en", labels), "locale", "en", input, normalizedLocale === "en" ? "primary" : "default"),
      button(optionLabel("日本語", normalizedLocale === "ja", labels), "locale", "ja", input, normalizedLocale === "ja" ? "primary" : "default"),
    ]),
    markdownElement(channelProfile() === "gateway"
      ? hostT(input.locale, "设备权限在「设置 → 设备管理」中设置。")
      : [
          `**${labels.accessSection}**`,
          hostT(input.locale, "- `/invite group` / `/remove group`：允许或移除当前群。"),
          hostT(input.locale, "- `/invite user @某人` / `/remove user @某人`：管理群内可操作用户。"),
        ].join("\n")),
  ];

  if (input.bridgeChatType === "group") {
    elements.push(section(labels.groupSection, [
      ...(channelProfile() === "gateway" ? [] : [button(optionLabel(labels.groupAllow, groupState.allowed, labels), "group", "allow", input, groupState.allowed ? "primary" : "default")]),
      button(optionLabel(labels.groupAllButton, groupState.listenAll, labels), "group", "all", input, groupState.listenAll ? "primary" : "default"),
      button(optionLabel(labels.groupAtButton, !groupState.listenAll, labels), "group", "at", input, !groupState.listenAll ? "primary" : "default"),
    ]));
  }

  elements.push(section(labels.utilitySection, [
    button(labels.refresh, "refresh", "now", input, "default"),
  ]));

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: labels.title,
      },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

export async function applyCoreConfigCardAction(
  stateDir: string,
  value: CoreConfigCardActionValue,
  locale: Locale,
  formValue?: Record<string, unknown>,
  scopeContext?: { appId?: string; appSecret?: string; domain?: string; instanceName?: string },
): Promise<string> {
  const labels = coreConfigLabels(locale);
  if (value.action === "submit") {
    return await applySubmitAction(stateDir, value, formValue, locale, scopeContext);
  }
  if (value.action === "refresh") {
    return labels.refreshed;
  }
  if (value.action === "engine") {
    return await applyEngineAction(stateDir, value.value, locale);
  }
  if (value.action === "fast") {
    return await applyFastAction(stateDir, value.value, locale);
  }
  if (value.action === "yolo") {
    return await applyYoloAction(stateDir, value.value, locale);
  }
  if (value.action === "locale") {
    return await applyLocaleAction(stateDir, value.value, locale);
  }
  if (value.action === "group") {
    return await applyGroupAction(stateDir, value, locale, scopeContext);
  }
  return hostT(locale, "不支持的配置操作。");
}

async function applySubmitAction(
  stateDir: string,
  value: CoreConfigCardActionValue,
  formValue: Record<string, unknown> | undefined,
  locale: Locale,
  scopeContext?: { appId?: string; appSecret?: string; domain?: string; instanceName?: string },
): Promise<string> {
  // larkCardActionFormValue never returns undefined — it yields `{}` when the submit
  // carried no picks — so guarding only `!formValue` was dead and an empty submit fell
  // through to a misleading "nothing changed". Treat an empty object as no values too.
  if (!formValue || Object.keys(formValue).length === 0) {
    return hostT(locale, "没有收到表单值。");
  }
  const selectedEngine = stringFormValue(formValue.engine);
  const selectedFast = stringFormValue(formValue.fast);
  const selectedYolo = stringFormValue(formValue.yolo);
  const selectedLocale = stringFormValue(formValue.locale);
  const noticeLocale: Locale = isSupportedLocale(selectedLocale) ? selectedLocale : locale;

  const notices: string[] = [];
  if (selectedEngine) {
    notices.push(await applyEngineAction(stateDir, selectedEngine, noticeLocale));
  }
  if ((!selectedEngine || selectedEngine === "codex") && selectedFast) {
    notices.push(await applyFastAction(stateDir, selectedFast, noticeLocale));
  }
  if (selectedYolo) {
    notices.push(await applyYoloAction(stateDir, selectedYolo, noticeLocale));
  }
  if (selectedLocale) {
    notices.push(await applyLocaleAction(stateDir, selectedLocale, noticeLocale));
  }
  if (value.bridgeChatType === "group") {
    const groupAction = stringFormValue(formValue.group);
    if (groupAction && groupAction !== "keep") {
      notices.push(await applyGroupAction(
        stateDir,
        { ...value, action: "group", value: groupAction },
        noticeLocale,
        scopeContext,
      ));
    }
  }

  // There are at most five compact notices. Keep all of them so the group-scope
  // warning cannot be truncated when the form submits every field at once.
  const normalizedNoticeLocale = normalizeLocale(noticeLocale, "en");
  const compact = notices.filter(Boolean).join(normalizedNoticeLocale === "en" ? "; " : normalizedNoticeLocale === "ja" ? "、" : "；");
  return compact ? hostT(noticeLocale, "已保存。{0}", compact) : hostT(noticeLocale, "已保存。");
}

function stringFormValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const maybe = (value as Record<string, unknown>).value;
    return typeof maybe === "string" ? maybe : undefined;
  }
  return undefined;
}

async function applyEngineAction(stateDir: string, value: string | undefined, locale: Locale): Promise<string> {
  if (!CORE_CONFIG_ENGINES.includes(value as InstanceEngine)) {
    return hostT(locale, "无效的引擎选择。");
  }
  const selected = value as InstanceEngine;
  const cfg = await loadInstanceConfig(stateDir);
  if ((selected === "pi" || selected === "omp") && cfg.role === "dispatcher") {
    return selected === "omp"
      ? (!isChineseLocale(locale) ? "omp is available for ordinary Bots, not Superagent Bots." : "omp 仅用于普通 Bot，不支持幕僚长。")
      : (!isChineseLocale(locale) ? "Pi is available for ordinary Bots, not Superagent Bots." : "Pi 仅用于普通 Bot，不支持幕僚长。");
  }
  const engineChanged = cfg.engine !== selected;
  let resetSessionBindings = false;
  let clearedModel = false;
  let enabledFullAuto = false;
  const persist = () => updateInstanceConfig(stateDir, (config) => {
    const result = applyEngineSelection(config, selected);
    clearedModel = result.clearedModel;
    enabledFullAuto = result.enabledFullAuto;
  });
  if (engineChanged) {
    const result = await new SessionStore(path.join(stateDir, "session.json")).clearAllThen(persist);
    resetSessionBindings = result.removedCount > 0;
  } else await persist();
  const details = [
    clearedModel ? hostT(locale, "已清除模型覆盖") : undefined,
    resetSessionBindings ? hostT(locale, "已重置会话绑定") : undefined,
    enabledFullAuto ? hostT(locale, "Antigravity 已开启 YOLO/full-auto") : undefined,
  ].filter((detail): detail is string => Boolean(detail));
  const normalized = normalizeLocale(locale, "en");
  const detailText = details.length
    ? (normalized === "en" ? ` (${details.join("; ")})` : normalized === "ja" ? `（${details.join("、")}）` : `（${details.join("；")}）`)
    : "";
  const restartHint = channelProfile() === "gateway"
    ? hostT(locale, "请在「运行状态」安排此 Bot 空闲后重启以生效。")
    : hostT(locale, "重启 Lark service 后完全生效。");
  return hostT(locale, "引擎已设为 {0}{1}。{2}", selected, detailText, restartHint);
}

async function applyFastAction(stateDir: string, value: string | undefined, locale: Locale): Promise<string> {
  const cfg = await loadInstanceConfig(stateDir);
  if (cfg.engine !== "codex") {
    return hostT(locale, "Fast Mode 仅 Codex 支持。");
  }
  if (value === "on") {
    await updateInstanceConfig(stateDir, (config) => {
      config.codexServiceTier = "fast";
    });
    return hostT(locale, "Codex Fast Mode 已开启。");
  }
  if (value === "off") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.codexServiceTier;
    });
    return hostT(locale, "Codex Fast Mode 已关闭。");
  }
  return hostT(locale, "无效的 Fast Mode 选择。");
}

async function applyYoloAction(stateDir: string, value: string | undefined, locale: Locale): Promise<string> {
  if (value === "on") {
    const currentEngine = (await loadInstanceConfig(stateDir)).engine;
    if (currentEngine === "pi") return hostT(locale, "Pi 不提供带沙箱的 full-auto，权限未更改；请选择普通审批或 unsafe bypass。");
    if (currentEngine === "omp") return hostT(locale, "omp 不提供带沙箱的 full-auto，权限未更改；请选择普通审批或 unsafe bypass。");
    await updateInstanceApprovalMode(stateDir, "full-auto");
    return hostT(locale, "YOLO/full-auto 已开启。");
  }
  if (value === "off") {
    await updateInstanceApprovalMode(stateDir, "normal");
    return hostT(locale, "YOLO 已关闭，恢复普通审批。");
  }
  if (value === "unsafe") {
    await updateInstanceApprovalMode(stateDir, "bypass");
    return hostT(locale, "YOLO unsafe/bypass 已开启。");
  }
  return hostT(locale, "无效的 YOLO 选择。");
}

async function applyLocaleAction(stateDir: string, value: string | undefined, locale: Locale): Promise<string> {
  if (!isSupportedLocale(value)) {
    return hostT(locale, "无效的语言选择。");
  }
  await updateInstanceConfig(stateDir, (config) => {
    config.locale = value;
  });
  return hostT(value, value === "en" ? "语言已设为英文。" : value === "ja" ? "语言已设为日语。" : "语言已设为中文。");
}

async function applyGroupAction(
  stateDir: string,
  value: CoreConfigCardActionValue,
  locale: Locale,
  scopeContext?: { appId?: string; appSecret?: string; domain?: string; instanceName?: string },
): Promise<string> {
  if (channelProfile() === "gateway") return applyGatewayGroupMode(stateDir, value.larkChatId, value.bridgeChatType === "group", value.value ?? "status", locale);
  if (value.bridgeChatType !== "group" || !value.larkChatId) {
    return hostT(locale, "群聊设置只能在飞书群里使用。");
  }
  const groupAction = value.value;
  const store = new CoreGroupModeStore(stateDir);
  const bridgeChatId = coreAccessChatIdFromConversationKey(value.conversationKey);
  const conversationChatId = stableCoreNumericId(value.conversationKey);
  if (groupAction === "allow") {
    await updateGroupMode(stateDir, (groupMode) => {
      allowGroup(groupMode, bridgeChatId);
    });
    return hostT(locale, "当前飞书群已允许。");
  }
  if (groupAction === "all") {
    await updateGroupMode(stateDir, (groupMode) => {
      allowGroup(groupMode, bridgeChatId);
      if (!groupMode.listenAllChatIds.includes(bridgeChatId)) {
        groupMode.listenAllChatIds.push(bridgeChatId);
      }
    });
    await store.setListenAll(value.larkChatId, true);
    const notice = hostT(locale, "当前群已切到监听普通消息。");
    const scopeStatus = await checkGroupMsgScope({
      appId: scopeContext?.appId,
      appSecret: scopeContext?.appSecret,
      domain: scopeContext?.domain,
    });
    if (scopeStatus !== "missing") {
      return notice;
    }
    return `${notice}\n\n${renderGroupMsgScopeWarning(
      locale,
      scopeContext?.appId,
      scopeContext?.domain,
      scopeContext?.instanceName,
    )}`;
  }
  if (groupAction === "at") {
    await updateGroupMode(stateDir, (groupMode) => {
      allowGroup(groupMode, bridgeChatId);
      groupMode.listenAllChatIds = groupMode.listenAllChatIds.filter((chatId) => chatId !== bridgeChatId && chatId !== conversationChatId);
    });
    await store.setListenAll(value.larkChatId, false);
    return hostT(locale, "当前群已切回需要 @bot / mention。");
  }
  return hostT(locale, "无效的群聊设置。");
}

async function readCoreConfigGroupState(input: CoreConfigCardContext, cfg: InstanceConfig): Promise<{
  allowed: boolean;
  listenAll: boolean;
}> {
  if (input.bridgeChatType !== "group") {
    return { allowed: false, listenAll: false };
  }
  if (channelProfile() === "gateway") return { allowed: true, listenAll: !await gatewayRequiresMention(input.stateDir, input.larkChatId, input.requireMentionInGroup !== false) };
  const rawListenAll = await new CoreGroupModeStore(input.stateDir).isListenAll(input.larkChatId);
  const candidateChatIds = coreConfigGroupCandidateIds(input);
  return {
    allowed: cfg.groupMode.enabled && hasAnyConfiguredCoreGroupId(cfg.groupMode.allowedChatIds, candidateChatIds),
    listenAll: cfg.groupMode.enabled && (
      rawListenAll || hasAnyConfiguredCoreGroupId(cfg.groupMode.listenAllChatIds, candidateChatIds)
    ),
  };
}

function coreConfigGroupCandidateIds(input: CoreConfigCardContext): number[] {
  return [...new Set([
    input.bridgeChatId,
    coreAccessChatIdFromConversationKey(input.conversationKey),
    stableCoreNumericId(input.conversationKey),
  ])];
}

function hasAnyConfiguredCoreGroupId(configuredIds: number[], candidateIds: number[]): boolean {
  return candidateIds.some((chatId) => configuredIds.includes(chatId));
}

async function updateGroupMode(stateDir: string, updater: (groupMode: GroupModeConfig) => void): Promise<void> {
  await updateInstanceConfig(stateDir, (config) => {
    const groupMode = currentGroupMode(config.groupMode);
    updater(groupMode);
    config.groupMode = normalizeGroupMode(groupMode);
  });
}

function currentGroupMode(raw: unknown): GroupModeConfig {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return normalizeGroupMode({
    enabled: value.enabled === false ? false : true,
    allowedChatIds: Array.isArray(value.allowedChatIds)
      ? value.allowedChatIds.filter((item): item is number => Number.isInteger(item))
      : [],
    listenAllChatIds: Array.isArray(value.listenAllChatIds)
      ? value.listenAllChatIds.filter((item): item is number => Number.isInteger(item))
      : [],
  });
}

function normalizeGroupMode(groupMode: GroupModeConfig): GroupModeConfig {
  return {
    enabled: groupMode.enabled,
    allowedChatIds: [...new Set(groupMode.allowedChatIds)],
    listenAllChatIds: groupMode.enabled ? [...new Set(groupMode.listenAllChatIds)] : [],
  };
}

function allowGroup(groupMode: GroupModeConfig, chatId: number): void {
  groupMode.enabled = true;
  if (!groupMode.allowedChatIds.includes(chatId)) {
    groupMode.allowedChatIds.push(chatId);
  }
}

function configFormSection(
  context: CoreConfigCardContext,
  cfg: InstanceConfig,
  approvalMode: unknown,
): Record<string, unknown> {
  const { locale } = context;
  const labels = coreConfigLabels(locale);
  const yoloValue = approvalMode === "bypass" ? "unsafe" : approvalMode === "full-auto" ? "on" : "off";
  const formElements: unknown[] = [
    markdownElement(hostT(locale, "**引导式设置**\n可以一次调整多项配置后提交。下面的快捷按钮仍然可以单点修改。")),
    selectStatic("engine", cfg.engine, [
      ["codex", "Codex"],
      ["claude", "Claude"],
      ["kimi", "Kimi"],
      ["deepseek", "DeepSeek Harness"],
      ["antigravity", "Antigravity"],
      ...(cfg.role === "dispatcher" ? [] : [["pi", "Pi"] as [string, string], ["omp", "omp"] as [string, string]]),
    ]),
    selectStatic("fast", cfg.codexServiceTier === "fast" ? "on" : "off", [
      ["on", hostT(locale, "Fast 开")],
      ["off", hostT(locale, "Fast 关")],
    ]),
    selectStatic("yolo", yoloValue, [
      ...(cfg.engine === "pi" || cfg.engine === "omp" ? [] : [["on", hostT(locale, "YOLO 开")] as [string, string]]),
      ["off", hostT(locale, "YOLO 关")],
      ["unsafe", "Unsafe bypass"],
    ]),
    selectStatic("locale", normalizeLocale(locale, "en"), [
      ["zh", "中文"],
      ["en", "English"],
      ["ja", "日本語"],
    ]),
  ];

  if (context.bridgeChatType === "group") {
    formElements.push(selectStatic("group", "keep", [
      ["keep", labels.groupKeep],
      ...(channelProfile() === "gateway" ? [] : [["allow", hostT(locale, "允许本群")] as [string, string]]),
      ["all", hostT(locale, "监听普通消息")],
      ["at", hostT(locale, "仅 @bot")],
    ]));
  }

  formElements.push({
    tag: "button",
    text: { tag: "plain_text", content: hostT(locale, "保存设置") },
    type: "primary",
    width: "fill",
    form_action_type: "submit",
    behaviors: [callbackBehavior({
      cctb_lark: "config",
      action: "submit",
      conversationKey: context.conversationKey,
      bridgeChatType: context.bridgeChatType,
      ...(context.replyInThread ? { replyInThread: true } : {}),
      larkChatId: context.larkChatId,
      bridgeChatId: context.bridgeChatId,
    })],
  });

  return {
    tag: "form",
    name: "lark_config_form",
    elements: formElements,
  };
}

function selectStatic(name: string, initial: string, options: Array<[string, string]>): Record<string, unknown> {
  return {
    tag: "select_static",
    name,
    initial_option: initial,
    options: options.map(([value, label]) => ({
      text: { tag: "plain_text", content: label },
      value,
    })),
  };
}

function section(title: string, buttons: unknown[]): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "default",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          markdownElement(`**${title}**`),
          ...buttons,
        ],
      },
    ],
  };
}

function button(
  label: string,
  action: CoreConfigActionName,
  value: string,
  context: CoreConfigCardContext,
  type: "default" | "primary" | "danger",
): Record<string, unknown> {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: label,
    },
    width: "fill",
    type,
    behaviors: [callbackBehavior({
      cctb_lark: "config",
      action,
      value,
      conversationKey: context.conversationKey,
      bridgeChatType: context.bridgeChatType,
      ...(context.replyInThread ? { replyInThread: true } : {}),
      larkChatId: context.larkChatId,
      bridgeChatId: context.bridgeChatId,
    })],
  };
}

function optionLabel(label: string, selected: boolean, labels: ReturnType<typeof coreConfigLabels>): string {
  return selected ? `${labels.selectedPrefix}${label}` : label;
}

function markdownElement(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
  };
}

function callbackBehavior(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "callback",
    // The optional SDK deduplicates only the first 128 serialized characters.
    // Put a fresh render identity first; repeated delivery of the same click
    // remains deduplicated, but refreshing the card enables the next action.
    value: channelProfile() === "feishu" ? { revision: randomUUID(), ...value } : value,
  };
}

function isCoreConfigActionName(value: unknown): value is CoreConfigActionName {
  return value === "engine" ||
    value === "fast" ||
    value === "yolo" ||
    value === "locale" ||
    value === "group" ||
    value === "refresh" ||
    value === "submit";
}

function coreConfigLabels(locale: Locale): {
  title: string;
  updated: string;
  engine: string;
  model: string;
  effort: string;
  fast: string;
  yolo: string;
  locale: string;
  group: string;
  chat: string;
  access: string;
  workspace: string;
  defaultValue: string;
  on: string;
  off: string;
  privateChat: string;
  groupAllowed: string;
  groupNotAllowed: string;
  groupAt: string;
  groupAll: string;
  engineSection: string;
  codex: string;
  claude: string;
  kimi: string;
  deepseek: string;
  pi: string;
  omp: string;
  antigravity: string;
  speedSection: string;
  fastOn: string;
  fastOff: string;
  approvalSection: string;
  yoloOn: string;
  yoloOff: string;
  yoloUnsafe: string;
  localeSection: string;
  accessSection: string;
  groupSection: string;
  groupAllow: string;
  groupKeep: string;
  groupAllButton: string;
  groupAtButton: string;
  utilitySection: string;
  refresh: string;
  refreshed: string;
  selectedPrefix: string;
  accessSummary(pairedUsers: number, allowlistedUsers: number): string;
} {
  return {
    title: hostT(locale, "飞书配置面板"),
    updated: hostT(locale, "已更新："),
    engine: hostT(locale, "引擎"),
    model: hostT(locale, "模型"),
    effort: hostT(locale, "推理强度"),
    fast: "Codex Fast Mode",
    yolo: "YOLO",
    locale: hostT(locale, "语言"),
    group: hostT(locale, "群聊"),
    chat: hostT(locale, "聊天"),
    access: hostT(locale, "访问"),
    workspace: hostT(locale, "工作区"),
    defaultValue: hostT(locale, "默认"),
    on: hostT(locale, "开启"),
    off: hostT(locale, "关闭"),
    privateChat: hostT(locale, "私聊"),
    groupAllowed: hostT(locale, "已允许"),
    groupNotAllowed: hostT(locale, "未允许"),
    groupAt: hostT(locale, "需要 @bot"),
    groupAll: hostT(locale, "监听普通消息"),
    engineSection: hostT(locale, "引擎"),
    codex: "Codex",
    claude: "Claude",
    kimi: "Kimi",
    deepseek: "DeepSeek Harness",
    pi: "Pi",
    omp: "omp",
    antigravity: "Antigravity",
    speedSection: hostT(locale, "速度"),
    fastOn: hostT(locale, "Fast 开"),
    fastOff: hostT(locale, "Fast 关"),
    approvalSection: hostT(locale, "审批"),
    yoloOn: hostT(locale, "YOLO 开"),
    yoloOff: hostT(locale, "YOLO 关"),
    yoloUnsafe: "Unsafe",
    localeSection: hostT(locale, "语言区块"),
    accessSection: hostT(locale, "访问"),
    groupSection: hostT(locale, "群聊模式"),
    groupAllow: hostT(locale, "允许本群"),
    groupKeep: hostT(locale, "保持当前群聊设置"),
    groupAllButton: hostT(locale, "全量监听"),
    groupAtButton: hostT(locale, "仅 @"),
    utilitySection: hostT(locale, "工具"),
    refresh: hostT(locale, "刷新"),
    refreshed: hostT(locale, "已刷新。"),
    selectedPrefix: "✓ ",
    accessSummary: (pairedUsers, allowlistedUsers) => hostT(locale, "{0} 个配对用户，{1} 个白名单用户", pairedUsers, allowlistedUsers),
  };
}
