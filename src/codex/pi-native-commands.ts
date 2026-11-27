import path from "node:path";
import { normalizeLocale, type Locale } from "../runtime/locale.js";
import { parsePiModels, type PiModelChoice } from "./pi-models.js";
import {
  PiNativeBridgeUnavailableError, PiNativeBusyError, PiNativeRejectedError, PiNativeUncertainError,
  type PiNativeControls, type PiNativeGlobalSetting, type PiNativeModelScope, type PiNativeProjectTrust, type PiNativeState,
  type PiNativeTree, type PiNativeTreeNode,
} from "./pi-native-types.js";
import { PI_TUI_BUILTIN_COMMANDS, parsePiSlashCommand, piClip, sanitizePiErrorText, type PiModelRef, type PiThinkingLevel } from "./pi-rpc-protocol.js";

/**
 * Pi's terminal built-ins, typed as conversation text.
 *
 * These are not session commands: sent through RPC `prompt` they would reach
 * the model as prose. This layer serves each one through the native controls,
 * or declines it with a plain explanation. It never forwards a built-in.
 *
 * Precedence mirrors Pi 1.5.2. The terminal matches built-ins on the trimmed
 * text before anything reaches `session.prompt`
 * (interactive-mode.ts:3324-3469), and extension commands are only looked up
 * inside `prompt` (agent-session.ts:2171-2178). So a built-in beats a session
 * command of the same name; Pi reports that as a conflict
 * (interactive-mode.ts:738-751). The one path to such a session command is a
 * built-in that takes no argument followed by text (`/tree x`): Pi's exact
 * match misses, and the extension command or template runs. That case is
 * returned unhandled here too. With no such session command Pi would send
 * the text to the model; this layer answers instead.
 */

export interface PiCommandChoice { label: string; description?: string; value: string }
export interface PiCommandQuestion {
  /** Short header. */
  title: string;
  message?: string;
  /** May be empty when free text is allowed. */
  options: PiCommandChoice[];
  /** Present when free text is accepted. */
  text?: { placeholder?: string; prefill?: string; multiline?: boolean };
  /** Several options may be chosen; the answer is then `{ values }`. */
  multiple?: boolean;
}
export type PiCommandAnswer = { cancelled: true } | { value: string } | { values: string[] } | { text: string };

export interface PiNativeCommandContext {
  sessionId: string;
  controls: PiNativeControls;
  locale: Locale;
  approvalMode: "normal" | "bypass";
  /** Absent when the surface cannot show a card; choices are then printed with the argument form to send. */
  ask?: (question: PiCommandQuestion) => Promise<PiCommandAnswer>;
  /** Asks the owner before a `!command` runs in normal mode. Absent means it cannot be asked, so the command is refused. */
  approveBash?: (command: string) => Promise<boolean>;
  /** Per-request output directory; exports written here are delivered by the Host. */
  outputDir?: string;
  /**
   * Pi's effective (global and project) settings as the running session reads them; never credentials.
   * Absent or failing, Pi's defaults apply.
   */
  readNativeSettings?: () => Promise<Record<string, unknown>>;
  abortSignal?: AbortSignal;
}

export type PiNativeCommandResult =
  /** Not a terminal built-in and not `!`: the caller forwards the text to Pi unchanged. */
  | { handled: false }
  /** Host-authored reply, never empty. `sessionId` is set when the session was replaced. */
  | { handled: true; text: string; sessionId?: string };

/** Options one card can hold. Longer lists show this many and accept text to narrow. */
export const PI_COMMAND_CARD_LIMIT = 30;
const BASH_REPLY_TAIL_CHARS = 4_000;
const NARROW_ROUNDS = 6;
const NOT_HANDLED: PiNativeCommandResult = Object.freeze({ handled: false });

/** Built-ins Pi itself parses with an argument (interactive-mode.ts:3336-3442). */
const PI_ARGUMENT_BUILTINS: ReadonlySet<string> = new Set(["model", "thinking", "export", "import", "bug", "name", "login", "compact"]);
/**
 * Pi's editor matches these built-ins on the exact text only, so `/<name> <args>` is not the built-in there:
 * it goes to a session command of the same name when one exists (see `runPiNativeCommand`).
 */
export function piBuiltinYieldsToSessionCommand(name: string, args: string): boolean {
  return Boolean(args) && !PI_ARGUMENT_BUILTINS.has(name);
}
/** Selector built-ins that get a text form here, for surfaces without cards. */
const HOST_ARGUMENT_FORMS: ReadonlySet<string> = new Set(["fork", "tree", "settings", "trust", "scoped-models"]);

type Reply = { text: string; sessionId?: string };
type Copy = typeof EN;

class Cancelled extends Error {}

const number = (value: number): string => (Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0");
const oneLine = (value: string, limit = 80): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

const EN = {
  cancelled: "Cancelled. Nothing was changed.",
  unchanged: "Nothing was changed.",
  done: "Done.",
  noArguments: (name: string) => `/${name} takes no arguments. Nothing was changed.`,
  busy: (name: string) => `The session is busy. ${name} needs it idle; send it again when the current reply has finished.`,
  bridgeUnavailable: (name: string) => `The TaroBird bridge is not connected for this session, so ${name} cannot run.`,
  uncertain: (name: string) => `An earlier model or thinking change in this session got no confirmed answer and may still take effect, so ${name} was not attempted. Restart the Bot to change them again.`,
  rejectedModel: "That model is not available in this session. Its provider may not be signed in.",
  rejectedThinking: (allowed: string) => `The current model does not support that thinking level.${allowed ? ` Supported: ${allowed}.` : ""}`,
  rejectedNotFound: "That entry was not found in this session.",
  rejectedInvalid: (allowed: string) => `That value was not accepted.${allowed ? ` Allowed: ${allowed}.` : ""}`,
  failed: (name: string, detail: string) => `${name} failed.${detail ? ` ${detail}` : ""}`,
  invalidChoice: "That choice is not in the list. Nothing was changed.",
  tooManyRounds: "The list is still too long to choose from. Send the command with a more specific value.",
  narrowHint: (shown: number, total: number) => `${number(total)} entries; the first ${shown} are shown. Type part of a name to narrow the list.`,
  narrowNone: (text: string) => `Nothing matches "${oneLine(text, 60)}".`,
  more: (count: number) => `… and ${number(count)} more.`,
  current: "current",
  mark: (text: string) => ` (${text})`,
  quote: (text: string) => `"${text}"`,
  list: (items: string[]) => items.join(", "),
  sentences: (parts: string[]) => parts.filter(Boolean).join(" "),

  noModels: "No model is available. Sign in to a provider in a terminal with `pi auth login <provider>`; TaroBird uses the same sign-in.",
  modelProviderTitle: "Provider",
  modelProviderMessage: "Choose a provider, then a model.",
  modelProviderCount: (count: number) => `${number(count)} models`,
  modelTitle: "Model",
  modelMessage: "Choose a model for this conversation.",
  modelPlaceholder: "Type a model id or part of its name",
  modelCandidates: (ref: string) => `"${oneLine(ref, 60)}" matches several models.`,
  modelNoMatch: (ref: string) => `No available model matches "${oneLine(ref, 60)}". Nothing was changed.`,
  modelListHeader: (count: number) => `${number(count)} models are available:`,
  modelListHint: "Send `/model <provider>/<id>` to switch.",
  modelSet: (name: string, ref: string, level: string, before?: string) =>
    `Model set to ${name} (${ref}). Thinking level: ${level}${before && before !== level ? ` (was ${before})` : ""}. This changes the current conversation only; the Bot default is a separate setting.`,

  thinkingTitle: "Thinking level",
  thinkingMessage: "Choose a thinking level for this conversation.",
  thinkingUnsupported: "The current model does not support thinking. The level stays off.",
  thinkingUnknown: (value: string, allowed: string) => `Unknown thinking level "${oneLine(value, 40)}". Available levels: ${allowed}.`,
  thinkingSet: (level: string) => `Thinking level: ${level}. This changes the current conversation only.`,
  thinkingList: (level: string, allowed: string) => `Thinking level: ${level}. Available: ${allowed}. Send \`/thinking <level>\` to change it.`,

  nameShow: (name: string) => `Session name: ${name}`,
  nameUsage: "This session has no name. Send `/name <name>` to set one.",
  nameSet: (name: string) => `Session name set: ${name}`,

  sessionTitle: (id: string, name?: string) => (name ? `Session ${name} (${id})` : `Session ${id}`),
  sessionModel: (ref: string, level: string) => `Model: ${ref} · thinking ${level}`,
  sessionNoModel: "Model: none available",
  sessionMessages: (total: number, user: number, assistant: number, tools: number) =>
    `Messages: ${number(total)} (${number(user)} from you, ${number(assistant)} replies, ${number(tools)} tool calls)`,
  sessionTokens: (input: number, output: number, read: number, write: number, total: number) =>
    `Tokens: ${number(input)} in · ${number(output)} out · ${number(read)} cache read · ${number(write)} cache write · ${number(total)} total`,
  sessionCost: (cost: string) => `Cost: ${cost} at list price`,
  sessionCostByModel: (key: string, cost: string, tokens: string) => `  ${key}: ${cost} (${tokens} tokens)`,
  sessionCostOther: "Tool and summary calls",
  sessionContext: (percent: string, window: number) => `Context: ${percent} of ${number(window)} tokens`,
  sessionContextPending: (window: number) => `Context: not measured yet after compaction (window ${number(window)} tokens)`,
  sessionState: (state: string) => `State: ${state}`,
  stateIdle: "idle", stateRunning: "replying", stateCompacting: "compacting",

  copyNone: "There is no reply to copy yet.",

  compactDone: (before?: number, after?: number) =>
    `Context compacted.${before !== undefined ? ` Before: ${number(before)} tokens.` : ""}${after !== undefined ? ` After: about ${number(after)} tokens.` : ""}`,

  exportJsonlDone: (file: string, entries: number) => `Session exported to ${file}: ${number(entries)} entries of the current branch, in Pi's own session format. The file is delivered in this conversation.`,
  exportNoOutput: "Exports from TaroBird are delivered through the conversation, and there is no output to deliver one to here. Nothing was written.",
  exportDone: (file: string) => `Session exported to ${file}. The file is delivered in this conversation.`,
  exportDoneWorkspace: (file: string) => `Session exported to ${file} in the workspace.`,
  exportRedirected: "The requested location was not used; exports from TaroBird go to the conversation's own output.",

  importUsage: "Send `/import <path>` with the path of a Pi session file (.jsonl) on this computer.",
  importNotFound: (file: string) => `${file} was not found or cannot be read. Nothing was imported.`,
  importNotSession: (file: string) => `${file} is not a Pi session file. Nothing was imported.`,
  importOtherWorkspace: (file: string) => `${file} was recorded in a different working directory. Pi runs a session's tools in the directory recorded in that session, which is not this Bot's workspace, so it is not imported here.`,
  importAlreadyPresent: (file: string) => `${file} is already among this Bot's sessions. Open it from the session list with /resume.`,
  importNeedsCard: "Importing switches this conversation to another session, so it needs a confirmation card, and this surface cannot show one. Nothing was imported.",
  importTitle: "Import session",
  importConfirm: (file: string, name: string) => `Continue this conversation in the session from ${file}${name ? ` ("${name}")` : ""}? The current session stays available to resume. The file is copied on this computer; nothing is uploaded.`,
  importYes: "Import and switch",
  importNo: "Keep the current session",
  importDone: (file: string) => `Imported ${file}. This conversation now continues in that session; the previous one can still be resumed.`,
  importCancelled: "The import was cancelled. Nothing was changed.",

  trustTitle: "Project files",
  trustNoFiles: "This workspace has no project-local Pi files (a .pi folder or .agents/skills), so there is nothing to decide.",
  trustNotice: "This workspace has project-local Pi files, which can include settings, extensions, skills, prompts and MCP servers. Extensions and MCP servers in the project run code on this computer. Your answer applies to this workspace for this Bot only; Pi's own trust list, which the terminal uses, is not changed.",
  trustRecordedYes: "Recorded answer: trusted.",
  trustRecordedNo: "Recorded answer: do not load.",
  trustRecordedNone: "No answer is recorded yet.",
  trustLoaded: "The running Pi process has loaded them.",
  trustNotLoaded: "The running Pi process has not loaded them.",
  trustYes: "Trust and load",
  trustNo: "Do not load",
  trustHint: "Send `/trust yes` to trust and load them, or `/trust no` to leave them out.",
  trustUsage: "Use `/trust yes` or `/trust no`. Nothing was changed.",
  trustSetYes: (loaded?: boolean) => `Project files are now trusted for this workspace and this Bot.${loaded === true ? " Pi has loaded them." : loaded === false ? " Pi has not loaded them yet." : ""} Pi's own trust list is unchanged.`,
  trustSetNo: "Project files will not be loaded for this workspace and this Bot. Pi's own trust list is unchanged.",
  trustAlreadyYes: "Project files are already trusted and loaded for this workspace. Nothing was changed.",
  trustAlreadyNo: "Project files are already left out for this workspace. Nothing was changed.",

  scopeTitle: "Model scope",
  scopeCurrent: (list: string) => `This Bot's scope: ${list}.`,
  scopeNone: "This Bot has no model scope.",
  scopeNative: (list: string) => `Your global Pi list (enabledModels) is ${list}. It applies while this Bot has no scope of its own, and it is changed in a Pi terminal with /scoped-models because it affects every Pi session.`,
  scopeNativeNone: "Your global Pi list (enabledModels) is not set. That list is changed in a Pi terminal with /scoped-models because it affects every Pi session.",
  scopeEffect: "Models in scope are listed first in /model. A new session starts on Pi's default model if it is in scope, otherwise on the first scoped model. Sessions that already exist keep their model.",
  scopeHint: "Send `/scoped-models <provider>/<id>,<provider>/<id>` to set this Bot's scope, or `/scoped-models clear` to remove it.",
  scopeCardMessage: "Choose the models for this Bot's scope. Your selection replaces the current scope.",
  scopeProviderMessage: "Choose a provider to pick models from.",
  scopeProviderCount: (count: number, selected: number) => `${number(count)} models${selected ? ` · ${number(selected)} selected` : ""}`,
  scopeModelsMessage: "Choose the models to add from this provider.",
  scopeSave: (count: number) => `Save the ${number(count)} selected models`,
  scopeInScope: "in scope",
  scopeNothing: "Nothing was selected, so the scope is unchanged. `/scoped-models clear` removes it.",
  scopeNotSaved: "Nothing was saved: the selection was never confirmed with Save, so this Bot's scope is unchanged. Send `/scoped-models` again, or name the models directly: `/scoped-models provider/id, provider/id`.",
  scopeSet: (list: string) => `This Bot's scope is now ${list}.`,
  scopeCleared: (native: boolean) => `This Bot's scope is cleared.${native ? " Your global Pi list applies again." : " Every available model is offered as before."}`,
  scopeAlreadyClear: "This Bot has no model scope to clear. Nothing was changed.",
  scopeUnknown: (list: string) => `No available model matches ${list}.`,
  scopeAmbiguous: (list: string) => `More than one model matches ${list}; write each as provider/id.`,
  modelAll: "All models",
  modelScopeMessage: "The models in this Bot's scope come first.",

  reloadDone: "Reloaded extensions, skills, prompt templates and context files.",
  cloneDone: "Cloned to a new session. This conversation now continues in the copy.",
  cloneCancelled: "The clone was cancelled. Nothing was changed.",
  newDone: "Started a new session. This conversation now continues there.",
  newCancelled: "Starting a new session was cancelled. Nothing was changed.",

  forkNone: "There are no messages to fork from yet.",
  forkTitle: "Fork",
  forkMessage: "Choose the message to fork from. The new session ends just before it.",
  forkPlaceholder: "Type part of the message",
  forkListHeader: "Messages you can fork from, newest first:",
  forkListHint: "Send `/fork <number>` to fork from one.",
  forkDone: (text: string) => `Forked to a new session. This conversation now continues there.${text ? ` The message at the fork point, ready to send again:\n\n${text}` : ""}`,
  forkCancelled: "The fork was cancelled. Nothing was changed.",

  treeNone: "This session has no entries yet.",
  treeNoneFiltered: (filter: string) => `No entries match Pi's tree filter "${filter}". Send \`/tree <entry id>\` to go to a specific entry.`,
  treeTitle: "Session tree",
  treeMessage: "Choose the point to go back to.",
  treePlaceholder: "Type part of a message or label",
  treeListHeader: "Points in this session, newest first:",
  treeListHint: "Send `/tree <number>` to go there, `/tree <number> summarize [instructions]` to summarize the branch you leave, or `/tree label <number> [text]` to set or clear a label.",
  treeLeaf: "current position",
  treeOnBranch: "current branch",
  treeOtherBranch: "other branch",
  treeKind: (kind: string) => ({ assistant: "reply", toolResult: "tool result", bashExecution: "shell", compaction: "compaction", branch_summary: "branch summary", custom_message: "extension message" } as Record<string, string>)[kind] ?? kind,
  treeAlready: "Already at this point.",
  treeSummaryTitle: "Summarize branch?",
  treeSummaryMessage: "A summary of the branch you leave can be kept in the session.",
  treeSummaryNo: "No summary",
  treeSummaryYes: "Summarize",
  treeSummaryCustom: "Summarize with custom instructions",
  treeSummaryInstructions: "Summary instructions",
  treeDone: (text: string) => `Moved to the selected point.${text ? ` The message at that point, ready to send again:\n\n${text}` : ""}`,
  treeCancelled: "Navigation was cancelled. Nothing was changed.",
  treeLabelSet: (label: string) => `Label set: ${label}`,
  treeLabelCleared: "Label removed.",

  settingsTitle: "Pi settings",
  settingsMessage: "These are global Pi settings: a change applies to every Pi session on this computer, the terminal included. Other settings are edited in Pi's settings.json or with /settings in a Pi terminal.",
  settingsValueTitle: (label: string) => label,
  settingsConfirmTitle: "Change global Pi setting",
  settingsConfirmMessage: (label: string, value: string) => `Set ${label} to ${value} for every Pi session on this computer, the terminal included?`,
  settingsConfirmYes: "Change it",
  settingsConfirmNo: "Keep the current value",
  settingsDone: (label: string, value: string) => `${label} is now ${value}. This is a global Pi setting, so it also applies in the terminal.`,
  settingsList: (lines: string) => `Global Pi settings that can be changed here:\n${lines}\nSend \`/settings <name> <value> confirm\` to change one; it applies to every Pi session, the terminal included. Other settings are edited in Pi's settings.json or with /settings in a Pi terminal.`,
  settingsNeedsConfirm: (label: string, value: string, form: string) => `This would set ${label} to ${value} for every Pi session on this computer, the terminal included. Send \`${form}\` to apply it.`,
  settingsUnknown: (allowed: string) => `Use one of: ${allowed}. Nothing was changed.`,
  settingsLine: (name: string, label: string, value: string) => `- ${name} (${label}): ${value}`,
  settingSteering: "Steering mode", settingFollowUp: "Follow-up mode", settingAutoCompaction: "Auto-compaction", settingAutoRetry: "Auto-retry",
  valueAll: "all at once (all)", valueOne: "one at a time (one-at-a-time)", valueOn: "on", valueOff: "off", valueUnknown: "not reported by Pi",

  hostResume: "TaroBird resumes Pi sessions from its own session list. Nothing was changed here.",
  hostQuit: "TaroBird starts and stops the Pi process itself, so there is nothing to quit here.",
  terminalLogin: (provider: string) => `Signing in needs a terminal: run \`pi auth login ${provider}\` there. TaroBird uses the same sign-in.`,
  terminalLogout: "Signing out is done in a terminal: run `pi auth logout <provider>` there. TaroBird uses the same sign-in, so it applies here too.",
  terminalShare: "Sharing uploads the session to an outside service, and TaroBird does not do that from a conversation. Nothing was uploaded. /export gives you a local HTML copy.",
  terminalBug: "Bug reports are sent from a Pi terminal with /bug. Nothing was uploaded from TaroBird.",
  terminalHotkeys: "Keyboard shortcuts belong to Pi's terminal interface and do not apply here.",
  terminalChangelog: "The changelog is shown in a Pi terminal with /changelog, and in Pi's release notes.",
  terminalOnly: (name: string) => `/${name} only works in Pi's terminal interface. Nothing was done here.`,

  bashNeedsApproval: "Shell commands need your approval in this mode, and this surface cannot ask for it. Nothing was run.",
  bashDenied: "Not approved. Nothing was run.",
  bashExit: (code: number) => `Exit code ${code}.`,
  bashCancelled: "The command was cancelled.",
  bashNoExit: "The command ended without an exit code.",
  bashExcluded: "The output is kept out of the model's context.",
  bashNoOutput: "(no output)",
  bashTail: "Earlier output is omitted here.",
  bashTruncated: (file: string) => `Pi truncated the output; the full log is at ${file}.`,
};

const ZH: Copy = {
  cancelled: "已取消，没有任何改动。",
  unchanged: "没有任何改动。",
  done: "已完成。",
  noArguments: name => `/${name} 不带参数，没有任何改动。`,
  busy: name => `会话正在运行，${name} 需要等它空闲。当前回复结束后再发一次。`,
  bridgeUnavailable: name => `这个会话没有连上 TaroBird 桥接，${name} 无法执行。`,
  uncertain: name => `这个会话里之前一次模型或思考级别的更改没有得到确认，可能稍后才生效，所以没有执行 ${name}。重启 Bot 后可以再改。`,
  rejectedModel: "这个会话里用不了该模型，可能是对应的 provider 还没登录。",
  rejectedThinking: allowed => `当前模型不支持这个思考级别。${allowed ? `支持的级别：${allowed}。` : ""}`,
  rejectedNotFound: "这个会话里找不到该条目。",
  rejectedInvalid: allowed => `这个值没有被接受。${allowed ? `可用的值：${allowed}。` : ""}`,
  failed: (name, detail) => `${name} 没有成功。${detail}`,
  invalidChoice: "列表里没有这个选项，没有任何改动。",
  tooManyRounds: "候选仍然太多，无法选择。请在命令里写得更具体一些。",
  narrowHint: (shown, total) => `共 ${number(total)} 项，这里列出前 ${shown} 项。输入名称的一部分可以缩小范围。`,
  narrowNone: text => `没有匹配“${oneLine(text, 60)}”的项。`,
  more: count => `……还有 ${number(count)} 项。`,
  current: "当前",
  mark: text => `（${text}）`,
  quote: text => `“${text}”`,
  list: items => items.join("、"),
  sentences: parts => parts.filter(Boolean).join(""),

  noModels: "目前没有可用的模型。请在终端里用 `pi auth login <provider>` 登录一个 provider，TaroBird 与终端共用登录状态。",
  modelProviderTitle: "Provider",
  modelProviderMessage: "先选 provider，再选模型。",
  modelProviderCount: count => `${number(count)} 个模型`,
  modelTitle: "模型",
  modelMessage: "为当前对话选择模型。",
  modelPlaceholder: "输入模型 id 或名称的一部分",
  modelCandidates: ref => `“${oneLine(ref, 60)}”对应多个模型。`,
  modelNoMatch: ref => `没有可用模型匹配“${oneLine(ref, 60)}”，没有任何改动。`,
  modelListHeader: count => `共 ${number(count)} 个可用模型：`,
  modelListHint: "发送 `/model <provider>/<id>` 切换。",
  modelSet: (name, ref, level, before) =>
    `已切换到 ${name}（${ref}），思考级别 ${level}${before && before !== level ? `（原为 ${before}）` : ""}。只对当前对话生效，Bot 的默认模型是另一项设置。`,

  thinkingTitle: "思考级别",
  thinkingMessage: "为当前对话选择思考级别。",
  thinkingUnsupported: "当前模型不支持思考，级别保持 off。",
  thinkingUnknown: (value, allowed) => `没有“${oneLine(value, 40)}”这个思考级别。可用级别：${allowed}。`,
  thinkingSet: level => `思考级别已设为 ${level}，只对当前对话生效。`,
  thinkingList: (level, allowed) => `当前思考级别 ${level}。可用级别：${allowed}。发送 \`/thinking <级别>\` 修改。`,

  nameShow: name => `会话名称：${name}`,
  nameUsage: "这个会话还没有名称。发送 `/name <名称>` 设置。",
  nameSet: name => `会话名称已设为：${name}`,

  sessionTitle: (id, name) => (name ? `会话 ${name}（${id}）` : `会话 ${id}`),
  sessionModel: (ref, level) => `模型：${ref} · 思考级别 ${level}`,
  sessionNoModel: "模型：暂无可用模型",
  sessionMessages: (total, user, assistant, tools) =>
    `消息：${number(total)} 条（你发的 ${number(user)} 条，回复 ${number(assistant)} 条，工具调用 ${number(tools)} 次）`,
  sessionTokens: (input, output, read, write, total) =>
    `Token：输入 ${number(input)} · 输出 ${number(output)} · 缓存读取 ${number(read)} · 缓存写入 ${number(write)} · 合计 ${number(total)}`,
  sessionCost: cost => `成本：${cost}（按标价计算）`,
  sessionCostByModel: (key, cost, tokens) => `  ${key}：${cost}（${tokens} token）`,
  sessionCostOther: "工具与摘要调用",
  sessionContext: (percent, window) => `上下文：已用 ${percent}，窗口 ${number(window)} token`,
  sessionContextPending: window => `上下文：压缩后尚未重新计量（窗口 ${number(window)} token）`,
  sessionState: state => `状态：${state}`,
  stateIdle: "空闲", stateRunning: "正在回复", stateCompacting: "正在压缩",

  copyNone: "还没有可以复制的回复。",

  compactDone: (before, after) =>
    `上下文已压缩。${before !== undefined ? `压缩前 ${number(before)} token。` : ""}${after !== undefined ? `压缩后约 ${number(after)} token。` : ""}`,

  exportJsonlDone: (file, entries) => `会话已导出为 ${file}：当前分支的 ${number(entries)} 个条目，Pi 原生会话格式。文件会在这个对话里送达。`,
  exportNoOutput: "TaroBird 里的导出通过对话送达，而这里没有可以送达的输出位置。没有写入任何文件。",
  exportDone: file => `会话已导出为 ${file}，文件会在这个对话里送达。`,
  exportDoneWorkspace: file => `会话已导出到工作区里的 ${file}。`,
  exportRedirected: "没有使用你指定的位置：TaroBird 里的导出统一放到对话自己的输出里。",

  importUsage: "发送 `/import <路径>`，路径是这台电脑上的 Pi 会话文件（.jsonl）。",
  importNotFound: file => `找不到 ${file}，或者无法读取。没有导入任何内容。`,
  importNotSession: file => `${file} 不是 Pi 会话文件。没有导入任何内容。`,
  importOtherWorkspace: file => `${file} 记录的是另一个工作目录。Pi 会在会话里记录的目录中运行工具，而那不是这个 Bot 的工作区，所以不在这里导入。`,
  importAlreadyPresent: file => `${file} 已经在这个 Bot 的会话里了，用 /resume 从会话列表打开它。`,
  importNeedsCard: "导入会把这个对话切换到另一个会话，需要一张确认卡片，而这个入口无法显示卡片。没有导入任何内容。",
  importTitle: "导入会话",
  importConfirm: (file, name) => `让这个对话改在 ${file}${name ? `（“${name}”）` : ""}里的会话中继续？当前会话仍然可以恢复。文件只在这台电脑上复制，不会上传任何内容。`,
  importYes: "导入并切换",
  importNo: "保留当前会话",
  importDone: file => `已导入 ${file}，这个对话接下来在该会话里继续，原来的会话仍然可以恢复。`,
  importCancelled: "导入被取消，没有任何改动。",

  trustTitle: "项目文件",
  trustNoFiles: "这个工作区里没有项目级 Pi 文件（.pi 目录或 .agents/skills），不需要做信任决定。",
  trustNotice: "这个工作区里有项目级 Pi 文件，可能包含设置、扩展、技能、提示模板和 MCP 服务。其中的扩展和 MCP 服务会在这台电脑上执行代码。你的选择只对这个 Bot 的这个工作区生效，Pi 自己的信任列表（终端使用的那份）不会改动。",
  trustRecordedYes: "已记录的选择：信任。",
  trustRecordedNo: "已记录的选择：不加载。",
  trustRecordedNone: "还没有记录过选择。",
  trustLoaded: "当前运行的 Pi 进程已经加载了这些文件。",
  trustNotLoaded: "当前运行的 Pi 进程没有加载这些文件。",
  trustYes: "信任并加载",
  trustNo: "不加载",
  trustHint: "发送 `/trust yes` 信任并加载，或发送 `/trust no` 不加载。",
  trustUsage: "请使用 `/trust yes` 或 `/trust no`。没有任何改动。",
  trustSetYes: loaded => `已信任这个工作区的项目文件，只对这个 Bot 生效。${loaded === true ? "Pi 已经加载了它们。" : loaded === false ? "Pi 还没有加载它们。" : ""}Pi 自己的信任列表没有改动。`,
  trustSetNo: "这个工作区的项目文件不会被加载，只对这个 Bot 生效。Pi 自己的信任列表没有改动。",
  trustAlreadyYes: "这个工作区的项目文件已经被信任并加载，没有任何改动。",
  trustAlreadyNo: "这个工作区的项目文件本来就没有加载，没有任何改动。",

  scopeTitle: "模型范围",
  scopeCurrent: list => `这个 Bot 的模型范围：${list}。`,
  scopeNone: "这个 Bot 没有设置模型范围。",
  scopeNative: list => `你的 Pi 全局列表（enabledModels）是 ${list}。这个 Bot 没有自己的范围时由它生效；它会影响所有 Pi 会话，所以要在 Pi 终端里用 /scoped-models 修改。`,
  scopeNativeNone: "你的 Pi 全局列表（enabledModels）没有设置。它会影响所有 Pi 会话，所以要在 Pi 终端里用 /scoped-models 修改。",
  scopeEffect: "范围内的模型会排在 /model 列表的最前面。新会话在 Pi 默认模型属于范围时用默认模型，否则用范围里的第一个模型。已有的会话保持各自的模型。",
  scopeHint: "发送 `/scoped-models <provider>/<id>,<provider>/<id>` 设置这个 Bot 的范围，或发送 `/scoped-models clear` 清除。",
  scopeCardMessage: "选择这个 Bot 的模型范围，选中的模型会替换现有范围。",
  scopeProviderMessage: "选择一个 provider，从中挑选模型。",
  scopeProviderCount: (count, selected) => `${number(count)} 个模型${selected ? ` · 已选 ${number(selected)} 个` : ""}`,
  scopeModelsMessage: "从这个 provider 里选择要加入的模型。",
  scopeSave: count => `保存已选的 ${number(count)} 个模型`,
  scopeInScope: "范围内",
  scopeNothing: "没有选中任何模型，范围保持不变。要清除范围请发送 `/scoped-models clear`。",
  scopeNotSaved: "没有保存：这次选择一直没有用“保存”确认，此 Bot 的范围保持不变。可以重新发送 `/scoped-models`，或直接写出模型：`/scoped-models provider/id, provider/id`。",
  scopeSet: list => `这个 Bot 的模型范围已设为 ${list}。`,
  scopeCleared: native => `这个 Bot 的模型范围已清除。${native ? "你的 Pi 全局列表重新生效。" : "所有可用模型照常提供。"}`,
  scopeAlreadyClear: "这个 Bot 没有模型范围可以清除，没有任何改动。",
  scopeUnknown: list => `没有可用模型匹配 ${list}。`,
  scopeAmbiguous: list => `${list} 对应多个模型，请写成 provider/id。`,
  modelAll: "全部模型",
  modelScopeMessage: "这个 Bot 模型范围内的模型排在前面。",

  reloadDone: "已重新加载扩展、技能、提示模板和上下文文件。",
  cloneDone: "已克隆出新会话，这个对话接下来在副本里继续。",
  cloneCancelled: "克隆被取消，没有任何改动。",
  newDone: "已开始新会话，这个对话接下来在新会话里继续。",
  newCancelled: "新会话被取消，没有任何改动。",

  forkNone: "还没有可以分叉的消息。",
  forkTitle: "分叉",
  forkMessage: "选择要从哪条消息分叉，新会话停在这条消息之前。",
  forkPlaceholder: "输入消息内容的一部分",
  forkListHeader: "可以分叉的消息，从新到旧：",
  forkListHint: "发送 `/fork <序号>` 从对应消息分叉。",
  forkDone: text => `已分叉出新会话，这个对话接下来在新会话里继续。${text ? `分叉点的那条消息如下，可以直接再发一次：\n\n${text}` : ""}`,
  forkCancelled: "分叉被取消，没有任何改动。",

  treeNone: "这个会话还没有任何条目。",
  treeNoneFiltered: filter => `没有条目符合 Pi 的树过滤设置“${filter}”。可发送 \`/tree <条目 ID>\` 前往指定条目。`,
  treeTitle: "会话树",
  treeMessage: "选择要回到的位置。",
  treePlaceholder: "输入消息或标签的一部分",
  treeListHeader: "会话里的位置，从新到旧：",
  treeListHint: "发送 `/tree <序号>` 回到该位置；`/tree <序号> summarize [说明]` 同时为离开的分支生成摘要；`/tree label <序号> [文字]` 设置或清除标签。",
  treeLeaf: "当前位置",
  treeOnBranch: "当前分支",
  treeOtherBranch: "其他分支",
  treeKind: kind => ({ assistant: "回复", toolResult: "工具结果", bashExecution: "命令", compaction: "压缩", branch_summary: "分支摘要", custom_message: "扩展消息" } as Record<string, string>)[kind] ?? kind,
  treeAlready: "已经在这个位置。",
  treeSummaryTitle: "为分支生成摘要？",
  treeSummaryMessage: "可以把即将离开的分支总结成一段摘要，留在会话里。",
  treeSummaryNo: "不生成摘要",
  treeSummaryYes: "生成摘要",
  treeSummaryCustom: "按我的说明生成摘要",
  treeSummaryInstructions: "摘要说明",
  treeDone: text => `已回到所选位置。${text ? `该位置的消息如下，可以直接再发一次：\n\n${text}` : ""}`,
  treeCancelled: "导航被取消，没有任何改动。",
  treeLabelSet: label => `标签已设为：${label}`,
  treeLabelCleared: "标签已清除。",

  settingsTitle: "Pi 设置",
  settingsMessage: "这些是 Pi 的全局设置：改动会作用于这台电脑上所有 Pi 会话，包括终端。其他设置请在 Pi 的 settings.json 或 Pi 终端的 /settings 里修改。",
  settingsValueTitle: label => label,
  settingsConfirmTitle: "修改 Pi 全局设置",
  settingsConfirmMessage: (label, value) => `把${label}改为${value}？这会作用于这台电脑上所有 Pi 会话，包括终端。`,
  settingsConfirmYes: "确认修改",
  settingsConfirmNo: "保持现状",
  settingsDone: (label, value) => `${label}已改为${value}。这是 Pi 的全局设置，终端里同样生效。`,
  settingsList: lines => `可以在这里修改的 Pi 全局设置：\n${lines}\n发送 \`/settings <名称> <值> confirm\` 修改，改动作用于所有 Pi 会话，包括终端。其他设置请在 Pi 的 settings.json 或 Pi 终端的 /settings 里修改。`,
  settingsNeedsConfirm: (label, value, form) => `这会把${label}改为${value}，并作用于这台电脑上所有 Pi 会话，包括终端。确认的话请发送 \`${form}\`。`,
  settingsUnknown: allowed => `可用的写法：${allowed}。没有任何改动。`,
  settingsLine: (name, label, value) => `- ${name}（${label}）：${value}`,
  settingSteering: "运行中插话的投递方式", settingFollowUp: "后续消息的投递方式", settingAutoCompaction: "自动压缩", settingAutoRetry: "自动重试",
  valueAll: "一次全部（all）", valueOne: "逐条（one-at-a-time）", valueOn: "开启", valueOff: "关闭", valueUnknown: "Pi 未报告",

  hostResume: "TaroBird 用自己的会话列表恢复 Pi 会话，这里没有任何改动。",
  hostQuit: "Pi 进程由 TaroBird 负责启动和关闭，这里不需要退出。",
  terminalLogin: provider => `登录需要在终端里完成：运行 \`pi auth login ${provider}\`。TaroBird 与终端共用登录状态。`,
  terminalLogout: "登出需要在终端里完成：运行 `pi auth logout <provider>`。TaroBird 与终端共用登录状态，所以这里也会一并登出。",
  terminalShare: "分享会把会话上传到外部服务，TaroBird 不会在对话里做这件事，没有上传任何内容。需要本地副本可以用 /export 导出 HTML。",
  terminalBug: "问题反馈请在 Pi 终端里用 /bug 提交。TaroBird 没有上传任何内容。",
  terminalHotkeys: "快捷键属于 Pi 的终端界面，在这里不适用。",
  terminalChangelog: "更新日志可以在 Pi 终端里用 /changelog 查看，也可以看 Pi 的发布说明。",
  terminalOnly: name => `/${name} 只在 Pi 的终端界面里有效，这里没有执行任何操作。`,

  bashNeedsApproval: "当前模式下执行命令需要你批准，而这个入口无法发起询问。没有执行任何命令。",
  bashDenied: "未获批准，没有执行任何命令。",
  bashExit: code => `退出码 ${code}。`,
  bashCancelled: "命令已取消。",
  bashNoExit: "命令结束时没有退出码。",
  bashExcluded: "输出不会进入模型的上下文。",
  bashNoOutput: "（没有输出）",
  bashTail: "这里省略了更早的输出。",
  bashTruncated: file => `Pi 截断了输出，完整日志在 ${file}。`,
};

const JA: Copy = {
  cancelled: "キャンセルしました。変更はありません。",
  unchanged: "変更はありません。",
  done: "完了しました。",
  noArguments: name => `/${name} は引数を取らないため、何も変更しませんでした。`,
  busy: name => `セッションが実行中です。${name} はアイドル時に実行できます。現在の返信が終わってからもう一度送信してください。`,
  bridgeUnavailable: name => `このセッションでは TaroBird ブリッジが接続されていないため、${name} を実行できません。`,
  uncertain: name => `このセッションで先ほど行ったモデルまたは思考レベルの変更結果が確認できておらず、後から反映される可能性があるため、${name} は実行しませんでした。Bot を再起動してから再度変更してください。`,
  rejectedModel: "このモデルはこのセッションでは利用できません。プロバイダーにログインしていない可能性があります。",
  rejectedThinking: allowed => `現在のモデルはこの思考レベルに対応していません。${allowed ? `対応レベル：${allowed}。` : ""}`,
  rejectedNotFound: "このセッションでは該当する項目が見つかりませんでした。",
  rejectedInvalid: allowed => `この値は受け付けられませんでした。${allowed ? `有効な値：${allowed}。` : ""}`,
  failed: (name, detail) => `${name} に失敗しました。${detail ? ` ${detail}` : ""}`,
  invalidChoice: "選択肢が一覧にありません。変更はありません。",
  tooManyRounds: "候補が多すぎるため選択できません。より具体的な値を指定してコマンドを送信してください。",
  narrowHint: (shown, total) => `全 ${number(total)} 件中、先頭 ${shown} 件を表示しています。名前の一部を入力すると絞り込めます。`,
  narrowNone: text => `「${oneLine(text, 60)}」に一致する項目はありません。`,
  more: count => `…他 ${number(count)} 件`,
  current: "現在",
  mark: text => `（${text}）`,
  quote: text => `「${text}」`,
  list: items => items.join("、"),
  sentences: parts => parts.filter(Boolean).join(" "),

  noModels: "利用可能なモデルがありません。端末で `pi auth login <provider>` を実行してプロバイダーにログインしてください（TaroBird でも同じログイン情報が使われます）。",
  modelProviderTitle: "プロバイダー",
  modelProviderMessage: "プロバイダーを選択してからモデルを選んでください。",
  modelProviderCount: count => `${number(count)} 個のモデル`,
  modelTitle: "モデル",
  modelMessage: "この会話で使用するモデルを選択してください。",
  modelPlaceholder: "モデル ID または名前の一部を入力",
  modelCandidates: ref => `「${oneLine(ref, 60)}」に複数のモデルが一致しました。`,
  modelNoMatch: ref => `「${oneLine(ref, 60)}」に一致する利用可能なモデルはありません。変更はありません。`,
  modelListHeader: count => `${number(count)} 個のモデルが利用可能です：`,
  modelListHint: "切り替えるには `/model <provider>/<id>` を送信してください。",
  modelSet: (name, ref, level, before) =>
    `モデルを ${name} (${ref}) に設定しました。思考レベル：${level}${before && before !== level ? `（変更前：${before}）` : ""}。この変更は現在の会話にのみ適用され、Bot の既定設定とは別に管理されます。`,

  thinkingTitle: "思考レベル",
  thinkingMessage: "この会話の思考レベルを選択してください。",
  thinkingUnsupported: "現在のモデルは思考機能に対応していないため、オフのまま維持されます。",
  thinkingUnknown: (value, allowed) => `不明な思考レベル「${oneLine(value, 40)}」です。利用可能：${allowed}。`,
  thinkingSet: level => `思考レベル：${level}。この変更は現在の会話にのみ適用されます。`,
  thinkingList: (level, allowed) => `思考レベル：${level}。利用可能：${allowed}。変更するには \`/thinking <level>\` を送信してください。`,

  nameShow: name => `セッション名：${name}`,
  nameUsage: "このセッションには名前がありません。設定するには `/name <name>` を送信してください。",
  nameSet: name => `セッション名を設定しました：${name}`,

  sessionTitle: (id, name) => (name ? `セッション ${name} (${id})` : `セッション ${id}`),
  sessionModel: (ref, level) => `モデル：${ref} · 思考 ${level}`,
  sessionNoModel: "モデル：利用不可",
  sessionMessages: (total, user, assistant, tools) =>
    `メッセージ：${number(total)} 件（ユーザー ${number(user)}・返信 ${number(assistant)}・ツール呼び出し ${number(tools)}）`,
  sessionTokens: (input, output, read, write, total) =>
    `トークン：入力 ${number(input)} · 出力 ${number(output)} · キャッシュ読込 ${number(read)} · キャッシュ書込 ${number(write)} · 合計 ${number(total)}`,
  sessionCost: cost => `コスト：${cost}（標準単価換算）`,
  sessionCostByModel: (key, cost, tokens) => `  ${key}: ${cost} (${tokens} tokens)`,
  sessionCostOther: "ツール・要約呼び出し",
  sessionContext: (percent, window) => `コンテキスト：${number(window)} トークン中 ${percent}`,
  sessionContextPending: window => `コンテキスト：圧縮後の使用量は未計測（上限 ${number(window)} トークン）`,
  sessionState: state => `状態：${state}`,
  stateIdle: "アイドル", stateRunning: "返信中", stateCompacting: "圧縮中",

  copyNone: "コピーできる返信がまだありません。",

  compactDone: (before, after) =>
    `コンテキストを圧縮しました。${before !== undefined ? ` 圧縮前：${number(before)} トークン。` : ""}${after !== undefined ? ` 圧縮後：約 ${number(after)} トークン。` : ""}`,

  exportJsonlDone: (file, entries) => `セッションを ${file} にエクスポートしました（現在のブランチ ${number(entries)} エントリ、Pi セッション形式）。ファイルはこの会話で送信されます。`,
  exportNoOutput: "TaroBird からのエクスポートは会話内で送信されますが、ここには出力先がありません。書き込みは行いませんでした。",
  exportDone: file => `セッションを ${file} にエクスポートしました。ファイルはこの会話で送信されます。`,
  exportDoneWorkspace: file => `セッションをワークスペース内の ${file} にエクスポートしました。`,
  exportRedirected: "指定された保存先は使用されませんでした。TaroBird からのエクスポートは会話専用の出力先に保存されます。",

  importUsage: "このコンピュータ上の Pi セッションファイル（.jsonl）のパスを指定して `/import <path>` を送信してください。",
  importNotFound: file => `${file} が見つからないか読み込めません。インポートしませんでした。`,
  importNotSession: file => `${file} は Pi セッションファイルではありません。インポートしませんでした。`,
  importOtherWorkspace: file => `${file} は別の作業ディレクトリで記録されています。Pi はセッション内に記録されたディレクトリでツールを実行するため、この Bot のワークスペースとは一致せずインポートされませんでした。`,
  importAlreadyPresent: file => `${file} はすでにこの Bot のセッションに含まれています。/resume からセッション一覧を開いてください。`,
  importNeedsCard: "インポートするとこの会話が別のセッションに切り替わるため確認カードが必要ですが、この画面では表示できません。インポートしませんでした。",
  importTitle: "セッションをインポート",
  importConfirm: (file, name) => `${file}${name ? `（「${name}」）` : ""} のセッションでこの会話を続行しますか？現在のセッションも後から再開できる状態で残ります。ファイルはこのコンピュータ内でコピーされ、外部へはアップロードされません。`,
  importYes: "インポートして切り替え",
  importNo: "現在のセッションを保持",
  importDone: file => `${file} をインポートしました。この会話は読み込んだセッションで続行します（以前のセッションも再開可能です）。`,
  importCancelled: "インポートをキャンセルしました。変更はありません。",

  trustTitle: "プロジェクトファイル",
  trustNoFiles: "このワークスペースにはプロジェクト固有の Pi ファイル（.pi フォルダや .agents/skills）がないため、確認は不要です。",
  trustNotice: "このワークスペースには、設定・拡張機能・スキル・プロンプト・MCP サーバーなどを含むプロジェクト固有の Pi ファイルがあります。拡張機能や MCP サーバーはこのコンピュータ上でコードを実行します。ここでの回答はこの Bot のこのワークスペースにのみ適用され、端末で使われる Pi 本来の信頼リストは変更されません。",
  trustRecordedYes: "記録済みの回答：信頼する。",
  trustRecordedNo: "記録済みの回答：読み込まない。",
  trustRecordedNone: "まだ回答は記録されていません。",
  trustLoaded: "実行中の Pi プロセスはすでに読み込んでいます。",
  trustNotLoaded: "実行中の Pi プロセスはまだ読み込んでいません。",
  trustYes: "信頼して読み込む",
  trustNo: "読み込まない",
  trustHint: "信頼して読み込む場合は `/trust yes`、読み込まない場合は `/trust no` を送信してください。",
  trustUsage: "`/trust yes` または `/trust no` を使用してください。変更はありません。",
  trustSetYes: loaded => `このワークスペースとこの Bot でプロジェクトファイルを信頼するよう設定しました。${loaded === true ? " Pi が読み込みました。" : loaded === false ? " Pi はまだ読み込んでいません。" : ""} Pi 本来の信頼リストは変更されていません。`,
  trustSetNo: "このワークスペースとこの Bot ではプロジェクトファイルを読み込みません。Pi 本来の信頼リストは変更されていません。",
  trustAlreadyYes: "このワークスペースのプロジェクトファイルはすでに信頼され読み込まれています。変更はありません。",
  trustAlreadyNo: "このワークスペースのプロジェクトファイルはすでに読み込まない設定になっています。変更はありません。",

  scopeTitle: "モデルスコープ",
  scopeCurrent: list => `この Bot のスコープ：${list}。`,
  scopeNone: "この Bot にはモデルスコープが設定されていません。",
  scopeNative: list => `グローバルな Pi リスト（enabledModels）は ${list} です。この Bot 独自のスコープが未設定のあいだはこちらが適用されます。すべての Pi セッションに影響するため、変更は Pi 端末の /scoped-models で行います。`,
  scopeNativeNone: "グローバルな Pi リスト（enabledModels）は未設定です。すべての Pi セッションに影響するため、変更は Pi 端末の /scoped-models で行います。",
  scopeEffect: "スコープ内のモデルは /model の先頭に表示されます。新しいセッションは、Pi の既定モデルがスコープ内ならそれを、そうでなければスコープの先頭モデルを使います。既存セッションのモデルは変わりません。",
  scopeHint: "この Bot のスコープを設定するには `/scoped-models <provider>/<id>,<provider>/<id>`、解除するには `/scoped-models clear` を送信してください。",
  scopeCardMessage: "この Bot のスコープに含めるモデルを選択してください。現在のスコープを置き換えます。",
  scopeProviderMessage: "モデルを選ぶプロバイダーを選択してください。",
  scopeProviderCount: (count, selected) => `${number(count)} 個のモデル${selected ? ` · ${number(selected)} 個選択中` : ""}`,
  scopeModelsMessage: "このプロバイダーから追加するモデルを選択してください。",
  scopeSave: count => `選択した ${number(count)} 個のモデルを保存`,
  scopeInScope: "スコープ内",
  scopeNothing: "何も選択されなかったためスコープは変更されませんでした。解除するには `/scoped-models clear` を使用してください。",
  scopeNotSaved: "保存されませんでした：「保存」で確定されなかったため、この Bot のスコープは変更されていません。もう一度 `/scoped-models` を送信するか、`/scoped-models provider/id, provider/id` の形式で直接指定してください。",
  scopeSet: list => `この Bot のスコープを ${list} に設定しました。`,
  scopeCleared: native => `この Bot のスコープを解除しました。${native ? "グローバルな Pi リストが再び適用されます。" : "以前と同様にすべての利用可能モデルが表示されます。"}`,
  scopeAlreadyClear: "この Bot には解除すべきモデルスコープがありません。変更はありません。",
  scopeUnknown: list => `${list} に一致する利用可能なモデルがありません。`,
  scopeAmbiguous: list => `${list} に複数のモデルが一致しました。provider/id の形式で指定してください。`,
  modelAll: "すべてのモデル",
  modelScopeMessage: "この Bot のスコープ内のモデルが先頭に表示されます。",

  reloadDone: "拡張機能、スキル、プロンプトテンプレート、コンテキストファイルを再読み込みしました。",
  cloneDone: "新しいセッションへ複製しました。この会話は複製先で続行します。",
  cloneCancelled: "複製をキャンセルしました。変更はありません。",
  newDone: "新しいセッションを開始しました。この会話は新しいセッションで続行します。",
  newCancelled: "新しいセッションの開始をキャンセルしました。変更はありません。",

  forkNone: "フォーク元になるメッセージがまだありません。",
  forkTitle: "フォーク",
  forkMessage: "フォーク元にするメッセージを選択してください。新しいセッションはその直前までの状態で作成されます。",
  forkPlaceholder: "メッセージの一部を入力",
  forkListHeader: "フォーク可能なメッセージ（新しい順）：",
  forkListHint: "フォークするには `/fork <番号>` を送信してください。",
  forkDone: text => `新しいセッションへフォークしました。この会話はフォーク先で続行します。${text ? ` 分岐点のメッセージ（再送信できます）：\n\n${text}` : ""}`,
  forkCancelled: "フォークをキャンセルしました。変更はありません。",

  treeNone: "このセッションにはまだエントリがありません。",
  treeNoneFiltered: filter => `Pi のツリーフィルタ「${filter}」に一致するエントリがありません。特定のエントリへ移動するには \`/tree <entry id>\` を送信してください。`,
  treeTitle: "セッションツリー",
  treeMessage: "戻るポイントを選択してください。",
  treePlaceholder: "メッセージまたはラベルの一部を入力",
  treeListHeader: "このセッション内のポイント（新しい順）：",
  treeListHint: "移動するには `/tree <番号>`、元のブランチを要約して移動するには `/tree <番号> summarize [指示]`、ラベルを設定・削除するには `/tree label <番号> [テキスト]` を送信してください。",
  treeLeaf: "現在地",
  treeOnBranch: "現在のブランチ",
  treeOtherBranch: "別のブランチ",
  treeKind: kind => ({ assistant: "返信", toolResult: "ツール結果", bashExecution: "シェル", compaction: "圧縮", branch_summary: "ブランチ要約", custom_message: "拡張メッセージ" } as Record<string, string>)[kind] ?? kind,
  treeAlready: "すでにこのポイントにいます。",
  treeSummaryTitle: "ブランチを要約しますか？",
  treeSummaryMessage: "離れるブランチの要約をセッションに残すことができます。",
  treeSummaryNo: "要約しない",
  treeSummaryYes: "要約する",
  treeSummaryCustom: "カスタム指示で要約する",
  treeSummaryInstructions: "要約の指示",
  treeDone: text => `選択したポイントへ移動しました。${text ? ` そのポイントのメッセージ（再送信できます）：\n\n${text}` : ""}`,
  treeCancelled: "移動をキャンセルしました。変更はありません。",
  treeLabelSet: label => `ラベルを設定しました：${label}`,
  treeLabelCleared: "ラベルを削除しました。",

  settingsTitle: "Pi 設定",
  settingsMessage: "これらはグローバルな Pi 設定であり、変更すると端末を含むこのコンピュータ上のすべての Pi セッションに適用されます。その他の設定は Pi の settings.json または Pi 端末の /settings で編集してください。",
  settingsValueTitle: label => label,
  settingsConfirmTitle: "グローバル Pi 設定を変更",
  settingsConfirmMessage: (label, value) => `端末を含むこのコンピュータ上のすべての Pi セッションで ${label} を ${value} に設定しますか？`,
  settingsConfirmYes: "変更する",
  settingsConfirmNo: "現在の値を維持",
  settingsDone: (label, value) => `${label} を ${value} に設定しました。グローバルな Pi 設定のため、端末にも適用されます。`,
  settingsList: lines => `ここから変更できるグローバル Pi 設定：\n${lines}\n変更するには \`/settings <name> <value> confirm\` を送信してください（端末を含むすべての Pi セッションに適用されます）。その他の設定は Pi の settings.json または Pi 端末の /settings で編集してください。`,
  settingsNeedsConfirm: (label, value, form) => `端末を含むこのコンピュータ上のすべての Pi セッションで ${label} を ${value} に設定します。適用するには \`${form}\` を送信してください。`,
  settingsUnknown: allowed => `次のいずれかを指定してください：${allowed}。変更はありません。`,
  settingsLine: (name, label, value) => `- ${name} (${label}): ${value}`,
  settingSteering: "ステアリングモード", settingFollowUp: "フォローアップモード", settingAutoCompaction: "自動コンテキスト圧縮", settingAutoRetry: "自動リトライ",
  valueAll: "まとめて送信 (all)", valueOne: "1件ずつ送信 (one-at-a-time)", valueOn: "オン", valueOff: "オフ", valueUnknown: "Pi から未報告",

  hostResume: "TaroBird は自身のセッション一覧から Pi セッションを再開します。ここでは何も変更しませんでした。",
  hostQuit: "TaroBird は Pi プロセス自体を管理しているため、ここで終了するものはありません。",
  terminalLogin: provider => `ログインは端末で行う必要があります：端末で \`pi auth login ${provider}\` を実行してください。TaroBird でも同じログイン情報が使用されます。`,
  terminalLogout: "ログアウトは端末で行います：端末で `pi auth logout <provider>` を実行してください。TaroBird でも同じログイン情報を使うため、こちらにも反映されます。",
  terminalShare: "共有機能はセッションを外部サービスへアップロードするため、TaroBird の会話からは実行されません。何もアップロードしませんでした。ローカルの HTML コピーが必要な場合は /export を使用してください。",
  terminalBug: "バグ報告は Pi 端末から /bug で送信します。TaroBird からは何もアップロードしませんでした。",
  terminalHotkeys: "キーボードショートカットは Pi の端末 UI 専用であり、ここでは適用されません。",
  terminalChangelog: "更新履歴は Pi 端末の /changelog および Pi のリリースノートで確認できます。",
  terminalOnly: name => `/${name} は Pi の端末 UI でのみ動作します。ここでは何も実行しませんでした。`,

  bashNeedsApproval: "このモードではシェルコマンドの実行にあなたの承認が必要ですが、この画面では確認できません。コマンドは実行されませんでした。",
  bashDenied: "承認されなかったため、コマンドは実行されませんでした。",
  bashExit: code => `終了コード ${code}。`,
  bashCancelled: "コマンドがキャンセルされました。",
  bashNoExit: "終了コードなしで終了しました。",
  bashExcluded: "出力はモデルのコンテキストには含まれません。",
  bashNoOutput: "（出力なし）",
  bashTail: "これより前の出力は省略されています。",
  bashTruncated: file => `Pi が出力を切り詰めました。完全なログは ${file} にあります。`,
};

const COPY: Record<Locale, Copy> = { en: EN, zh: ZH, ja: JA };

interface Run { context: PiNativeCommandContext; t: Copy }

const live = (run: Run): void => { if (run.context.abortSignal?.aborted) throw new Cancelled(); };
/** Await a control call, treating an abort that arrived meanwhile as cancellation. */
async function call<T>(run: Run, work: Promise<T>): Promise<T> {
  live(run);
  const value = await work;
  live(run);
  return value;
}
type SingleAnswer = { cancelled: true } | { value: string } | { text: string };

async function askAny(run: Run, question: PiCommandQuestion): Promise<PiCommandAnswer> {
  live(run);
  const answer = await run.context.ask!(question);
  live(run);
  return answer;
}
/** A single-choice question. A surface that answers it with several values changes nothing. */
async function ask(run: Run, question: PiCommandQuestion): Promise<SingleAnswer> {
  const answer = await askAny(run, question);
  if (!("values" in answer)) return answer;
  return answer.values.length === 1 ? { value: answer.values[0] } : { cancelled: true };
}

interface ListItem<T> { choice: PiCommandChoice; search: string; item: T }
interface PickInput<T> { title: string; message: string; placeholder: string; items: ListItem<T>[] }
type PickedMany<T> = { kind: "picked"; items: T[] } | { kind: "cancelled" } | { kind: "reply"; text: string };
type Picked<T> = { kind: "picked"; item: T } | { kind: "cancelled" } | { kind: "reply"; text: string };

/** One card for short lists; longer ones show the first page and accept text to narrow, round by round. */
async function choose<T>(run: Run, input: PickInput<T>, multiple: boolean): Promise<PickedMany<T>> {
  let pool = input.items;
  let note = "";
  for (let round = 0; round < NARROW_ROUNDS; round++) {
    const paged = pool.length > PI_COMMAND_CARD_LIMIT;
    const shown = paged ? pool.slice(0, PI_COMMAND_CARD_LIMIT) : pool;
    const message = run.t.sentences([note, input.message, paged ? run.t.narrowHint(shown.length, pool.length) : ""]);
    const answer = await askAny(run, {
      title: input.title, message, options: shown.map(entry => entry.choice),
      ...(multiple ? { multiple: true } : {}),
      ...(paged ? { text: { placeholder: input.placeholder } } : {}),
    });
    if ("cancelled" in answer) return { kind: "cancelled" };
    if (!("text" in answer)) {
      const values = "values" in answer ? [...new Set(answer.values)] : [answer.value];
      if (!multiple && values.length !== 1) return { kind: "cancelled" };
      const hits: T[] = [];
      for (const value of values) {
        const hit = pool.find(entry => entry.choice.value === value);
        // One value outside the list voids the whole answer: nothing is applied on a partial match.
        if (!hit) return { kind: "reply", text: run.t.invalidChoice };
        hits.push(hit.item);
      }
      return { kind: "picked", items: hits };
    }
    const needle = answer.text.trim().toLowerCase();
    if (!needle) return { kind: "cancelled" };
    const narrowed = pool.filter(entry => entry.search.includes(needle));
    if (narrowed.length === 1) return { kind: "picked", items: [narrowed[0].item] };
    if (narrowed.length === 0) { note = run.t.narrowNone(answer.text); continue; }
    pool = narrowed;
    note = "";
  }
  return { kind: "reply", text: run.t.tooManyRounds };
}

async function pick<T>(run: Run, input: PickInput<T>): Promise<Picked<T>> {
  const result = await choose(run, input, false);
  if (result.kind !== "picked") return result;
  return result.items.length ? { kind: "picked", item: result.items[0] } : { kind: "cancelled" };
}

/** Bounded text listing for surfaces without cards. */
function listing(run: Run, lines: string[]): string {
  const shown = lines.slice(0, PI_COMMAND_CARD_LIMIT);
  return [...shown, ...(lines.length > shown.length ? [run.t.more(lines.length - shown.length)] : [])].join("\n");
}

// ---------------------------------------------------------------------------
// /model
// ---------------------------------------------------------------------------

interface ModelRow { choice: PiModelChoice; name: string; ref: string }

function modelRows(raw: unknown[]): ModelRow[] {
  return parsePiModels(raw).map(choice => {
    const suffix = ` · ${choice.provider}`;
    const name = choice.label.endsWith(suffix) ? choice.label.slice(0, -suffix.length) : choice.label;
    return { choice, name, ref: `${choice.provider}/${choice.modelId}` };
  });
}

/** Pi's exact rules first (id or provider/id, case-insensitive: model-resolver.ts:236-266), then a substring over id and name. Never picks among several. */
function resolveModel(rows: ModelRow[], reference: string): ModelRow[] {
  const exactCase = rows.filter(row => row.ref === reference || row.choice.id === reference);
  if (exactCase.length) return exactCase;
  const lower = reference.toLowerCase();
  const qualified = rows.filter(row => row.ref.toLowerCase() === lower || row.choice.id.toLowerCase() === lower);
  if (qualified.length) return qualified;
  const byId = rows.filter(row => row.choice.modelId === reference);
  if (byId.length) return byId;
  const byIdLoose = rows.filter(row => row.choice.modelId.toLowerCase() === lower);
  if (byIdLoose.length) return byIdLoose;
  return rows.filter(row => row.choice.modelId.toLowerCase().includes(lower) || row.name.toLowerCase().includes(lower) || row.ref.toLowerCase().includes(lower));
}

/** Never a model value: those are `provider/id` and always contain a slash. */
const ALL_MODELS = "all-models";
/** The scope's provider card prefixes its provider values, so this cannot be one of them. */
const SAVE_SCOPE = "save-scope";
const PROVIDER_VALUE = "provider:";

const refText = (ref: PiModelRef): string => `${ref.provider}/${ref.modelId}`;

/** The Bot's scope only orders and marks the list, so failing to read it must not block `/model`. */
async function botScope(run: Run): Promise<PiModelRef[]> {
  try { return (await run.context.controls.getModelScope(run.context.sessionId)).scope; } catch { return []; }
}

/** Scoped models first, in scope order, as the terminal's selector shows them; then the rest in catalog order. */
function scopedFirst(rows: ModelRow[], scope: PiModelRef[]): { ordered: ModelRow[]; scoped: Set<string> } {
  const scoped = new Set<string>();
  const first: ModelRow[] = [];
  for (const ref of scope) {
    const row = rows.find(candidate => candidate.choice.provider === ref.provider && candidate.choice.modelId === ref.modelId);
    if (row && !scoped.has(row.choice.id)) { scoped.add(row.choice.id); first.push(row); }
  }
  return { ordered: [...first, ...rows.filter(row => !scoped.has(row.choice.id))], scoped };
}

const modelItem = (run: Run, row: ModelRow, currentRef: string | undefined, scoped: ReadonlySet<string>): ListItem<ModelRow> => {
  const notes = [row.name !== row.choice.modelId ? row.name : "", scoped.has(row.choice.id) ? run.t.scopeInScope : "", row.ref === currentRef ? run.t.current : ""].filter(Boolean);
  return {
    choice: { label: row.ref, value: row.choice.id, ...(notes.length ? { description: notes.join(" · ") } : {}) },
    search: `${row.ref}\n${row.name}`.toLowerCase(),
    item: row,
  };
};

async function applyModel(run: Run, row: ModelRow, before: PiNativeState): Promise<Reply> {
  const { context, t } = run;
  const state = await call(run, context.controls.setModel(context.sessionId, { provider: row.choice.provider, modelId: row.choice.modelId }));
  const model = state.model;
  const ref = model ? `${model.provider}/${model.modelId}` : row.ref;
  return { text: t.modelSet(model?.name || row.name, ref, state.thinkingLevel, before.thinkingLevel) };
}

async function modelCommand(run: Run, args: string): Promise<Reply> {
  const { context, t } = run;
  const [raw, before, scope] = await call(run, Promise.all([
    context.controls.listModels(context.sessionId), context.controls.getState(context.sessionId), botScope(run),
  ]));
  const { ordered: rows, scoped } = scopedFirst(modelRows(raw), scope);
  if (!rows.length) return { text: t.noModels };
  const currentRef = before.model ? `${before.model.provider}/${before.model.modelId}` : undefined;
  const item = (row: ModelRow) => modelItem(run, row, currentRef, scoped);
  const textList = (pool: ModelRow[], header: string) => ({
    text: [header, listing(run, pool.map(row => [
      `- ${row.ref}`, row.name !== row.choice.modelId ? ` — ${row.name}` : "",
      scoped.has(row.choice.id) ? t.mark(t.scopeInScope) : "", row.ref === currentRef ? t.mark(t.current) : "",
    ].join(""))), t.modelListHint].join("\n"),
  });

  let pool = rows;
  let message = t.modelMessage;
  if (args) {
    const matches = resolveModel(rows, args);
    if (!matches.length) return { text: t.modelNoMatch(args) };
    if (matches.length === 1) return applyModel(run, matches[0], before);
    pool = matches;
    message = t.modelCandidates(args);
    if (!context.ask) return textList(pool, message);
  } else if (!context.ask) {
    return textList(rows, t.modelListHeader(rows.length));
  } else {
    if (scoped.size > 0 && scoped.size < PI_COMMAND_CARD_LIMIT) {
      // The scope and a way out to everything, like the terminal selector's scoped and all views.
      const chosen = await pick<ModelRow | undefined>(run, {
        title: t.modelTitle, message: t.modelScopeMessage, placeholder: t.modelPlaceholder,
        items: [...rows.slice(0, scoped.size).map(item), { choice: { label: t.modelAll, value: ALL_MODELS }, search: "", item: undefined }],
      });
      if (chosen.kind === "cancelled") return { text: t.cancelled };
      if (chosen.kind === "reply") return { text: chosen.text };
      if (chosen.item) return applyModel(run, chosen.item, before);
    }
    const providers = [...new Set(rows.map(row => row.choice.provider))];
    if (providers.length > 1) {
      const chosen = await pick(run, {
        title: t.modelProviderTitle, message: t.modelProviderMessage, placeholder: t.modelPlaceholder,
        items: providers.map(provider => ({
          choice: {
            label: provider, value: provider,
            description: [t.modelProviderCount(rows.filter(row => row.choice.provider === provider).length), provider === before.model?.provider ? t.current : ""].filter(Boolean).join(" · "),
          },
          search: provider.toLowerCase(), item: provider,
        })),
      });
      if (chosen.kind === "cancelled") return { text: t.cancelled };
      if (chosen.kind === "reply") return { text: chosen.text };
      pool = rows.filter(row => row.choice.provider === chosen.item);
    }
  }
  const chosen = await pick(run, { title: t.modelTitle, message, placeholder: t.modelPlaceholder, items: pool.map(item) });
  if (chosen.kind === "cancelled") return { text: t.cancelled };
  if (chosen.kind === "reply") return { text: chosen.text };
  return applyModel(run, chosen.item, before);
}

// ---------------------------------------------------------------------------
// /scoped-models
// ---------------------------------------------------------------------------

function scopeSummary(run: Run, scope: PiNativeModelScope): string[] {
  const { t } = run;
  return [
    scope.scope.length ? t.scopeCurrent(t.list(scope.scope.map(refText))) : t.scopeNone,
    scope.nativePatterns.length ? t.scopeNative(t.list(scope.nativePatterns.map(pattern => oneLine(pattern, 60)))) : t.scopeNativeNone,
    t.scopeEffect,
  ];
}

/**
 * The terminal edits the list in a selector and can save it to the owner's
 * global `enabledModels` (interactive-mode.ts:5570-5690). Here the command
 * manages this Bot's own scope, which reaches Pi as `--models`
 * (main.ts:872-876). The global list is shown, never written.
 */
async function scopedModelsCommand(run: Run, args: string): Promise<Reply> {
  const { context, t } = run;
  const current = await call(run, context.controls.getModelScope(context.sessionId));
  if (args.toLowerCase() === "clear") {
    if (!current.scope.length) return { text: t.scopeAlreadyClear };
    const next = await call(run, context.controls.setModelScope(context.sessionId, null));
    return { text: t.scopeCleared(next.nativePatterns.length > 0) };
  }
  const rows = modelRows(await call(run, context.controls.listModels(context.sessionId)));
  const apply = async (chosen: ModelRow[]): Promise<Reply> => {
    const refs = [...new Map(chosen.map(row => [row.choice.id, { provider: row.choice.provider, modelId: row.choice.modelId }])).values()];
    const next = await call(run, context.controls.setModelScope(context.sessionId, refs));
    return { text: t.sentences([t.scopeSet(t.list((next.scope.length ? next.scope : refs).map(refText))), t.scopeEffect]) };
  };

  if (args) {
    // Each comma-separated reference resolves exactly as `/model` does; one that does not voids the whole change.
    const resolved: ModelRow[] = [], unknown: string[] = [], ambiguous: string[] = [];
    for (const reference of args.split(",").map(part => part.trim()).filter(Boolean)) {
      const matches = resolveModel(rows, reference);
      if (matches.length === 1) resolved.push(matches[0]);
      else (matches.length ? ambiguous : unknown).push(t.quote(oneLine(reference, 60)));
    }
    if (unknown.length || ambiguous.length || !resolved.length) {
      return { text: t.sentences([unknown.length ? t.scopeUnknown(t.list(unknown)) : "", ambiguous.length ? t.scopeAmbiguous(t.list(ambiguous)) : "", t.unchanged]) };
    }
    return apply(resolved);
  }

  const summary = scopeSummary(run, current);
  if (!rows.length) return { text: [...summary, t.noModels].join("\n") };
  if (!context.ask) return { text: [...summary, t.scopeHint].join("\n") };

  const inScope = new Set(scopedFirst(rows, current.scope).scoped);
  const item = (row: ModelRow): ListItem<ModelRow> => modelItem(run, row, undefined, inScope);
  const message = t.sentences([...summary, t.scopeCardMessage]);
  if (rows.length <= PI_COMMAND_CARD_LIMIT) {
    const chosen = await choose(run, { title: t.scopeTitle, message, placeholder: t.modelPlaceholder, items: rows.map(item) }, true);
    if (chosen.kind === "cancelled") return { text: t.cancelled };
    if (chosen.kind === "reply") return { text: chosen.text };
    return chosen.items.length ? apply(chosen.items) : { text: t.scopeNothing };
  }

  // Too many for one card: provider by provider, as `/model` pages, until the owner saves.
  const providers = [...new Set(rows.map(row => row.choice.provider))];
  const selected: ModelRow[] = [];
  for (let round = 0; round < NARROW_ROUNDS * 2; round++) {
    const step = await pick<string | undefined>(run, {
      title: t.scopeTitle, message: round === 0 ? t.sentences([message, t.scopeProviderMessage]) : t.scopeProviderMessage, placeholder: t.modelPlaceholder,
      items: [
        ...(selected.length ? [{ choice: { label: t.scopeSave(selected.length), value: SAVE_SCOPE }, search: "", item: undefined }] : []),
        ...providers.map(provider => ({
          choice: {
            label: provider, value: `${PROVIDER_VALUE}${provider}`,
            description: t.scopeProviderCount(rows.filter(row => row.choice.provider === provider).length, selected.filter(row => row.choice.provider === provider).length),
          },
          search: provider.toLowerCase(), item: provider,
        })),
      ],
    });
    if (step.kind === "cancelled") return { text: t.cancelled };
    if (step.kind === "reply") return { text: step.text };
    if (step.item === undefined) return apply(selected);
    const provider = step.item;
    const chosen = await choose(run, {
      title: provider, message: t.scopeModelsMessage, placeholder: t.modelPlaceholder,
      items: rows.filter(row => row.choice.provider === provider).map(item),
    }, true);
    if (chosen.kind === "cancelled") return { text: t.cancelled };
    if (chosen.kind === "reply") return { text: chosen.text };
    for (const row of chosen.items) if (!selected.includes(row)) selected.push(row);
  }
  // The rounds ran out without Save. A selection the owner never confirmed is not a change.
  return { text: selected.length ? t.scopeNotSaved : t.tooManyRounds };
}

// ---------------------------------------------------------------------------
// /thinking, /name, /session, /copy, /compact
// ---------------------------------------------------------------------------

async function thinkingCommand(run: Run, args: string): Promise<Reply> {
  const { context, t } = run;
  const state = await call(run, context.controls.getState(context.sessionId));
  const levels = state.availableThinkingLevels;
  const apply = async (level: PiThinkingLevel): Promise<Reply> => {
    const next = await call(run, context.controls.setThinkingLevel(context.sessionId, level));
    return { text: t.thinkingSet(next.thinkingLevel) };
  };
  if (args) {
    // Pi matches the level case-insensitively and reports the available set otherwise (interactive-mode.ts:5344-5349).
    const level = levels.find(candidate => candidate.toLowerCase() === args.toLowerCase());
    return level ? apply(level) : { text: t.thinkingUnknown(args, levels.join(", ")) };
  }
  if (levels.length <= 1 && (levels[0] ?? "off") === "off") return { text: t.thinkingUnsupported };
  if (!context.ask) return { text: t.thinkingList(state.thinkingLevel, levels.join(", ")) };
  const answer = await ask(run, {
    title: t.thinkingTitle, message: t.thinkingMessage,
    options: levels.map(level => ({ label: level, value: level, ...(level === state.thinkingLevel ? { description: t.current } : {}) })),
  });
  if ("cancelled" in answer) return { text: t.cancelled };
  const picked = "value" in answer ? answer.value : answer.text.trim().toLowerCase();
  const level = levels.find(candidate => candidate === picked);
  return level ? apply(level) : { text: t.thinkingUnknown(picked, levels.join(", ")) };
}

async function nameCommand(run: Run, args: string): Promise<Reply> {
  const { context, t } = run;
  if (!args) {
    const state = await call(run, context.controls.getState(context.sessionId));
    return { text: state.sessionName ? t.nameShow(state.sessionName) : t.nameUsage };
  }
  await call(run, context.controls.setSessionName(context.sessionId, args));
  const state = await call(run, context.controls.getState(context.sessionId));
  return { text: t.nameSet(state.sessionName ?? args) };
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  return `$${value >= 1 ? value.toFixed(2) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

async function sessionCommand(run: Run): Promise<Reply> {
  const { context, t } = run;
  const [state, stats] = await call(run, Promise.all([context.controls.getState(context.sessionId), context.controls.getStats(context.sessionId)]));
  const lines = [
    t.sessionTitle(state.sessionId, state.sessionName),
    state.model ? t.sessionModel(`${state.model.provider}/${state.model.modelId}`, state.thinkingLevel) : t.sessionNoModel,
    t.sessionState(state.isCompacting ? t.stateCompacting : state.isStreaming ? t.stateRunning : t.stateIdle),
    t.sessionMessages(stats.totalMessages, stats.userMessages, stats.assistantMessages, stats.toolCalls),
    t.sessionTokens(stats.tokens.input, stats.tokens.output, stats.tokens.cacheRead, stats.tokens.cacheWrite, stats.tokens.total),
    t.sessionCost(formatCost(stats.costUsd)),
  ];
  // As in Pi's terminal UI: a single line that only repeats the selected model's total adds nothing.
  const breakdown = stats.costByModel ?? [];
  const selected = state.model ? `${state.model.provider}/${state.model.modelId}` : undefined;
  if (breakdown.length > 1 || (breakdown.length === 1 && breakdown[0]!.key !== selected)) {
    for (const item of breakdown) {
      lines.push(t.sessionCostByModel(item.key === "Tools/summaries" ? t.sessionCostOther : oneLine(item.key, 120), formatCost(item.costUsd), item.tokens.toLocaleString("en-US")));
    }
  }
  if (stats.context) {
    lines.push(stats.context.percent === null
      ? t.sessionContextPending(stats.context.contextWindow)
      : t.sessionContext(`${Math.round(stats.context.percent * 10) / 10}%`, stats.context.contextWindow));
  }
  return { text: lines.join("\n") };
}

async function copyCommand(run: Run): Promise<Reply> {
  const text = await call(run, run.context.controls.getLastAssistantText(run.context.sessionId));
  return { text: text?.trim() ? text : run.t.copyNone };
}

async function compactCommand(run: Run, args: string): Promise<Reply> {
  const result = await call(run, run.context.controls.compact(run.context.sessionId, args ? { instructions: args } : undefined));
  return { text: run.t.compactDone(result.tokensBefore, result.estimatedTokensAfter) };
}

// ---------------------------------------------------------------------------
// /export
// ---------------------------------------------------------------------------

/** First argument as Pi reads it: a quoted string or the first word (interactive-mode.ts:6726-6753). */
function pathArgument(args: string): string | undefined {
  const rest = args.trimStart();
  if (!rest) return;
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const close = rest.indexOf(quote, 1);
    return close < 0 ? undefined : rest.slice(1, close);
  }
  const space = rest.search(/\s/);
  return space < 0 ? rest : rest.slice(0, space);
}

function safeExportName(candidate: string | undefined, sessionId: string, extension: ".html" | ".jsonl"): string {
  // The same 80 units as before, but never half of a surrogate pair: that is not a file name.
  const clean = (value: string) => piClip(value.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[.-]+/, "").replace(/[.\s-]+$/, ""), 80);
  const stem = clean((candidate ?? "").replace(extension === ".jsonl" ? /\.jsonl$/i : /\.html?$/i, ""));
  return `${stem || `pi-session-${clean(sessionId).slice(0, 12) || "export"}`}${extension}`;
}

async function exportCommand(run: Run, args: string): Promise<Reply> {
  const { context, t } = run;
  const requested = pathArgument(args);
  // The terminal picks the format from the extension: `.jsonl` is the native session file, anything else HTML (interactive-mode.ts:6708-6724).
  const jsonl = requested?.toLowerCase().endsWith(".jsonl") === true;
  if (!context.outputDir) {
    if (jsonl) return { text: t.exportNoOutput };
    // Without a delivery directory Pi chooses its default file; a caller-supplied path is never written.
    const result = await call(run, context.controls.exportHtml(context.sessionId, {}));
    return { text: t.sentences([t.exportDoneWorkspace(path.basename(result.path)), requested ? t.exportRedirected : ""]) };
  }
  const root = path.resolve(context.outputDir);
  // Only a bare file name is honoured. Any path, relative or absolute, is reduced to its last segment and written here.
  const direct = requested !== undefined && !/[\\/]/.test(requested) && requested !== "." && requested !== "..";
  const leaf = requested?.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  const outputPath = path.join(root, safeExportName(leaf, context.sessionId, jsonl ? ".jsonl" : ".html"));
  const redirected = requested !== undefined && !direct ? t.exportRedirected : "";
  if (jsonl) {
    const result = await call(run, context.controls.exportJsonl(context.sessionId, { outputPath }));
    return { text: t.sentences([t.exportJsonlDone(path.basename(result.path), result.entries), redirected]) };
  }
  const result = await call(run, context.controls.exportHtml(context.sessionId, { outputPath }));
  return { text: t.sentences([t.exportDone(path.basename(result.path)), redirected]) };
}

// ---------------------------------------------------------------------------
// /import
// ---------------------------------------------------------------------------

/** Replies name a local file by its last segment only. */
const fileName = (value: string): string => oneLine(value.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "", 80) || "…";

/**
 * The terminal asks "Replace current session with <path>?" and then copies the
 * file into the session directory and switches to it (interactive-mode.ts:6755-6800).
 * Here the switch always needs the confirmation card; there is no text form.
 */
async function importCommand(run: Run, args: string): Promise<Reply> {
  const { context, t } = run;
  const source = pathArgument(args);
  if (!source) return { text: t.importUsage };
  const file = fileName(source);
  try {
    const found = await call(run, context.controls.inspectImport(context.sessionId, { path: source }));
    if (!found) return { text: t.importNotSession(file) };
    if (!found.sameWorkspace) return { text: t.importOtherWorkspace(file) };
    if (found.alreadyPresent) return { text: t.importAlreadyPresent(file) };
    if (!context.ask) return { text: t.importNeedsCard };
    const answer = await ask(run, {
      title: t.importTitle, message: t.importConfirm(file, found.name ? oneLine(found.name, 60) : ""),
      options: [{ label: t.importYes, value: "yes" }, { label: t.importNo, value: "no" }],
    });
    if (!("value" in answer) || answer.value !== "yes") return { text: t.cancelled };
    const result = await call(run, context.controls.importSession(context.sessionId, { path: source }));
    return result.cancelled ? { text: t.importCancelled } : { text: t.importDone(file), sessionId: result.sessionId };
  } catch (error) {
    if (error instanceof PiNativeRejectedError && error.reason === "not-found") return { text: t.importNotFound(file) };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// /trust
// ---------------------------------------------------------------------------

function trustStatus(run: Run, trust: PiNativeProjectTrust): string {
  const { t } = run;
  return t.sentences([
    trust.decision === "yes" ? t.trustRecordedYes : trust.decision === "no" ? t.trustRecordedNo : t.trustRecordedNone,
    trust.loaded === true ? t.trustLoaded : trust.loaded === false ? t.trustNotLoaded : "",
  ]);
}

/**
 * The terminal's `/trust` saves a decision to Pi's own trust.json and takes
 * effect after a restart (interactive-mode.ts:5509-5532). Here the answer is
 * kept for this Bot and workspace only; Pi's trust list is left alone.
 */
async function trustCommand(run: Run, args: string): Promise<Reply> {
  const { context, t } = run;
  const trust = await call(run, context.controls.getProjectTrust(context.sessionId));
  if (!trust.hasProjectFiles) return { text: t.trustNoFiles };
  const apply = async (decision: "yes" | "no"): Promise<Reply> => {
    if (trust.decision === decision && trust.loaded === (decision === "yes")) return { text: decision === "yes" ? t.trustAlreadyYes : t.trustAlreadyNo };
    const next = await call(run, context.controls.setProjectTrust(context.sessionId, decision));
    return { text: decision === "yes" ? t.trustSetYes(next.loaded) : t.trustSetNo };
  };
  if (args) {
    const word = args.toLowerCase();
    return word === "yes" || word === "no" ? apply(word) : { text: t.trustUsage };
  }
  const status = trustStatus(run, trust);
  if (!context.ask) return { text: [t.trustNotice, status, t.trustHint].join("\n") };
  const answer = await ask(run, {
    title: t.trustTitle, message: t.sentences([t.trustNotice, status]),
    options: [
      { label: t.trustYes, value: "yes", ...(trust.decision === "yes" ? { description: t.current } : {}) },
      { label: t.trustNo, value: "no", ...(trust.decision === "no" ? { description: t.current } : {}) },
    ],
  });
  if (!("value" in answer)) return { text: t.cancelled };
  return answer.value === "yes" || answer.value === "no" ? apply(answer.value) : { text: t.invalidChoice };
}

// ---------------------------------------------------------------------------
// /fork, /clone, /new, /reload
// ---------------------------------------------------------------------------

/** "3" is a position in the newest-first list; anything else is an entry id. */
function selectByArgument<T extends { id: string }>(ordered: T[], token: string): T | undefined {
  if (/^\d{1,4}$/.test(token)) {
    const index = Number(token);
    if (index >= 1 && index <= ordered.length) return ordered[index - 1];
  }
  return ordered.find(entry => entry.id === token);
}

async function forkCommand(run: Run, args: string): Promise<Reply> {
  const { context, t } = run;
  const points = (await call(run, context.controls.listForkPoints(context.sessionId))).map(point => ({ id: point.entryId, text: point.text })).reverse();
  if (!points.length) return { text: t.forkNone };
  let target: { id: string; text: string } | undefined;
  if (args) {
    target = selectByArgument(points, args.split(/\s+/)[0]);
    if (!target) return { text: t.rejectedNotFound };
  } else if (!context.ask) {
    return { text: [t.forkListHeader, listing(run, points.map((point, index) => `${index + 1}. ${oneLine(point.text) || point.id}`)), t.forkListHint].join("\n") };
  } else {
    const chosen = await pick(run, {
      title: t.forkTitle, message: t.forkMessage, placeholder: t.forkPlaceholder,
      items: points.map(point => ({ choice: { label: oneLine(point.text) || point.id, value: point.id }, search: point.text.toLowerCase(), item: point })),
    });
    if (chosen.kind === "cancelled") return { text: t.cancelled };
    if (chosen.kind === "reply") return { text: chosen.text };
    target = chosen.item;
  }
  const result = await call(run, context.controls.fork(context.sessionId, { entryId: target.id }));
  if (result.cancelled) return { text: t.forkCancelled };
  return { text: t.forkDone(result.text || target.text), sessionId: result.sessionId };
}

async function cloneCommand(run: Run): Promise<Reply> {
  const result = await call(run, run.context.controls.clone(run.context.sessionId));
  return result.cancelled ? { text: run.t.cloneCancelled } : { text: run.t.cloneDone, sessionId: result.sessionId };
}

async function newCommand(run: Run): Promise<Reply> {
  const result = await call(run, run.context.controls.newSession(run.context.sessionId));
  return result.cancelled ? { text: run.t.newCancelled } : { text: run.t.newDone, sessionId: result.sessionId };
}

async function reloadCommand(run: Run): Promise<Reply> {
  await call(run, run.context.controls.reload(run.context.sessionId));
  return { text: run.t.reloadDone };
}

// ---------------------------------------------------------------------------
// /tree
// ---------------------------------------------------------------------------

interface TreePoint { id: string; node: PiNativeTreeNode; depth: number; mark: string }

type TreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
const TREE_FILTERS: readonly TreeFilter[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
/** Bookkeeping entries Pi's tree hides in its default view (tree-selector.ts:359-367). */
const TREE_SETTINGS_ENTRIES: ReadonlySet<string> = new Set(["label", "context_edit", "custom", "model_change", "thinking_level_change", "session_info"]);

/** Pi's own tree settings: `treeFilterMode` (default "default") and `branchSummary.skipPrompt` (default false). */
async function treeSettings(run: Run): Promise<{ filter: TreeFilter; skipSummaryPrompt: boolean }> {
  let settings: Record<string, unknown> = {};
  try { settings = (await run.context.readNativeSettings?.()) ?? {}; } catch { /* Pi's defaults */ }
  const mode = settings.treeFilterMode, summary = settings.branchSummary;
  return {
    filter: TREE_FILTERS.includes(mode as TreeFilter) ? mode as TreeFilter : "default",
    skipSummaryPrompt: Boolean(summary && typeof summary === "object" && (summary as { skipPrompt?: unknown }).skipPrompt === true),
  };
}

/** What Pi's tree selector lists (tree-selector.ts:342-390), newest first. */
function treeVisible(tree: PiNativeTree, filter: TreeFilter): PiNativeTreeNode[] {
  const navigable = tree.nodes.filter(node => node.type !== "usage");
  const visible = navigable.filter(node => {
    // A reply that only called tools carries no text; Pi hides it unless it is the current position or failed (the preview then says so).
    if (node.type === "message" && node.role === "assistant" && node.id !== tree.leafId && !node.preview) return false;
    switch (filter) {
      case "user-only": return node.type === "message" && node.role === "user";
      case "no-tools": return !TREE_SETTINGS_ENTRIES.has(node.type) && !(node.type === "message" && node.role === "toolResult");
      case "labeled-only": return node.label !== undefined;
      case "all": return true;
      default: return !TREE_SETTINGS_ENTRIES.has(node.type);
    }
  });
  // An empty result stays empty, as in Pi's selector; an exact id still reaches any entry (treeTarget).
  return visible;
}

/**
 * What every listed point needs from the whole tree, worked out once. The
 * listing used to rebuild the id index and walk to the root again for every
 * entry, which made `/tree` quadratic in the length of the session.
 */
interface TreeShape { onPath: Set<string>; depth(node: PiNativeTreeNode): number }

function treeShape(tree: PiNativeTree): TreeShape {
  const byId = new Map(tree.nodes.map(entry => [entry.id, entry]));
  const limit = tree.nodes.length;
  const parent = (node: PiNativeTreeNode) => (node.parentId ? byId.get(node.parentId) : undefined);
  const onPath = new Set<string>();
  for (let cursor = tree.leafId ? byId.get(tree.leafId) : undefined, guard = 0; cursor && guard <= limit; guard++) {
    onPath.add(cursor.id);
    cursor = parent(cursor);
  }
  /** Ancestors that branch, by the bounded walk to the root: right for any data, a parent cycle included. */
  const walk = (node: PiNativeTreeNode): number => {
    let depth = 0;
    for (let cursor = parent(node), guard = 0; cursor && guard <= limit; guard++) {
      if (cursor.childIds.length > 1) depth++;
      cursor = parent(cursor);
    }
    return depth;
  };
  const known = new Map<PiNativeTreeNode, number>();
  const depth = (node: PiNativeTreeNode): number => {
    // Climb to the nearest ancestor already counted (or to a root), then count back down that chain.
    const chain: PiNativeTreeNode[] = [], climbed = new Set<PiNativeTreeNode>();
    let cursor: PiNativeTreeNode | undefined = node, above = 0;
    while (cursor) {
      const counted = known.get(cursor);
      if (counted !== undefined) { above = counted + (cursor.childIds.length > 1 ? 1 : 0); break; }
      // A parent cycle is not a tree. Count such an entry the long way, exactly as before, and remember nothing.
      if (climbed.has(cursor)) return walk(node);
      climbed.add(cursor);
      chain.push(cursor);
      cursor = parent(cursor);
    }
    for (let index = chain.length - 1; index >= 0; index--) {
      known.set(chain[index]!, above);
      above += chain[index]!.childIds.length > 1 ? 1 : 0;
    }
    return known.get(node)!;
  };
  return { onPath, depth };
}

function treePoint(run: Run, tree: PiNativeTree, shape: TreeShape, node: PiNativeTreeNode): TreePoint {
  return {
    id: node.id, node, depth: Math.min(shape.depth(node), 6),
    mark: node.id === tree.leafId ? run.t.treeLeaf : shape.onPath.has(node.id) ? run.t.treeOnBranch : run.t.treeOtherBranch,
  };
}

function treePoints(run: Run, tree: PiNativeTree, shape: TreeShape, filter: TreeFilter): TreePoint[] {
  return treeVisible(tree, filter).map(node => treePoint(run, tree, shape, node)).reverse();
}

/** A position in the list shown, or the exact id of any entry Pi can navigate to, listed or not. */
function treeTarget(run: Run, tree: PiNativeTree, shape: TreeShape, points: TreePoint[], token: string): TreePoint | undefined {
  const listed = selectByArgument(points, token);
  if (listed) return listed;
  const node = tree.nodes.find(entry => entry.id === token && entry.type !== "usage");
  return node ? treePoint(run, tree, shape, node) : undefined;
}

const treeLabel = (point: TreePoint): string => `${"· ".repeat(point.depth)}${oneLine(point.node.preview) || point.node.type}`;
const treeKindOf = (node: PiNativeTreeNode): string | undefined => node.type === "message" ? (node.role && node.role !== "user" ? node.role : undefined) : node.type;
const treeDescription = (run: Run, point: TreePoint): string => {
  const kind = treeKindOf(point.node);
  return [kind ? run.t.treeKind(kind) : "", point.node.label ? `[${oneLine(point.node.label, 40)}]` : "", point.mark].filter(Boolean).join(" · ");
};

async function summaryChoice(run: Run): Promise<{ summarize: boolean; customInstructions?: string } | undefined> {
  const { t } = run;
  // Same three choices as the terminal; cancelling the instructions returns to them (interactive-mode.ts:5784-5803).
  for (let round = 0; round < NARROW_ROUNDS; round++) {
    const answer = await ask(run, {
      title: t.treeSummaryTitle, message: t.treeSummaryMessage,
      options: [{ label: t.treeSummaryNo, value: "no" }, { label: t.treeSummaryYes, value: "yes" }, { label: t.treeSummaryCustom, value: "custom" }],
    });
    if ("cancelled" in answer || !("value" in answer)) return;
    if (answer.value === "no") return { summarize: false };
    if (answer.value === "yes") return { summarize: true };
    if (answer.value !== "custom") return;
    const instructions = await ask(run, { title: t.treeSummaryInstructions, options: [], text: { multiline: true } });
    if ("text" in instructions && instructions.text.trim()) return { summarize: true, customInstructions: instructions.text.trim() };
  }
  return;
}

async function treeCommand(run: Run, args: string): Promise<Reply> {
  const { context, t } = run;
  const [tree, settings] = await call(run, Promise.all([context.controls.getTree(context.sessionId), treeSettings(run)]));
  const shape = treeShape(tree);
  const points = treePoints(run, tree, shape, settings.filter);
  if (!tree.nodes.some(node => node.type !== "usage")) return { text: t.treeNone };
  const words = args ? args.split(/\s+/) : [];
  if (!points.length && !words.length) return { text: t.treeNoneFiltered(settings.filter) };

  if (words[0] === "label") {
    const target = words[1] ? treeTarget(run, tree, shape, points, words[1]) : undefined;
    if (!target) return { text: t.rejectedNotFound };
    const label = words.slice(2).join(" ").trim();
    await call(run, context.controls.setLabel(context.sessionId, { entryId: target.id, label: label || null }));
    return { text: label ? t.treeLabelSet(label) : t.treeLabelCleared };
  }

  let target: TreePoint | undefined;
  let summary: { summarize: boolean; customInstructions?: string } | undefined;
  if (words.length) {
    target = treeTarget(run, tree, shape, points, words[0]);
    if (!target) return { text: t.rejectedNotFound };
    if (words[1]?.toLowerCase() === "summarize") {
      const instructions = words.slice(2).join(" ").trim();
      summary = { summarize: true, ...(instructions ? { customInstructions: instructions } : {}) };
    }
  } else if (!context.ask) {
    const lines = points.map((point, index) => `${index + 1}. ${treeLabel(point)}${t.mark(treeDescription(run, point))}`);
    return { text: [t.treeListHeader, listing(run, lines), t.treeListHint].join("\n") };
  } else {
    const chosen = await pick(run, {
      title: t.treeTitle, message: t.treeMessage, placeholder: t.treePlaceholder,
      items: points.map(point => ({
        choice: { label: treeLabel(point), description: treeDescription(run, point), value: point.id },
        search: `${point.node.preview}\n${point.node.label ?? ""}\n${point.id}`.toLowerCase(), item: point,
      })),
    });
    if (chosen.kind === "cancelled") return { text: t.cancelled };
    if (chosen.kind === "reply") return { text: chosen.text };
    target = chosen.item;
  }
  if (target.id === tree.leafId) return { text: t.treeAlready };
  if (!summary) {
    // Pi skips the question when the owner chose that (interactive-mode.ts:5782).
    if (settings.skipSummaryPrompt) summary = { summarize: false };
    else if (context.ask) {
      summary = await summaryChoice(run);
      if (!summary) return { text: t.cancelled };
    } else {
      summary = { summarize: false };
    }
  }
  const result = await call(run, context.controls.navigateTree(context.sessionId, {
    targetId: target.id, summarize: summary.summarize, ...(summary.customInstructions ? { customInstructions: summary.customInstructions } : {}),
  }));
  return { text: result.cancelled ? t.treeCancelled : t.treeDone(result.editorText ?? "") };
}

// ---------------------------------------------------------------------------
// /settings
// ---------------------------------------------------------------------------

interface SettingRow {
  /** Name used in the text form. */
  name: string;
  label: string;
  /** Current native value as text; undefined when Pi does not report it. */
  current: string | undefined;
  values: Array<{ token: string; label: string; setting: PiNativeGlobalSetting }>;
}

function settingRows(run: Run, state: PiNativeState): SettingRow[] {
  const { t } = run;
  const mode = (key: "steeringMode" | "followUpMode") => [
    { token: "one-at-a-time", label: t.valueOne, setting: { key, value: "one-at-a-time" as const } },
    { token: "all", label: t.valueAll, setting: { key, value: "all" as const } },
  ];
  const toggle = (key: "autoCompaction" | "autoRetry") => [
    { token: "on", label: t.valueOn, setting: { key, value: true } },
    { token: "off", label: t.valueOff, setting: { key, value: false } },
  ];
  return [
    { name: "steering", label: t.settingSteering, current: state.steeringMode, values: mode("steeringMode") },
    { name: "follow-up", label: t.settingFollowUp, current: state.followUpMode, values: mode("followUpMode") },
    { name: "auto-compaction", label: t.settingAutoCompaction, current: state.autoCompactionEnabled ? "on" : "off", values: toggle("autoCompaction") },
    // Pi's RPC state does not report whether auto-retry is on.
    { name: "auto-retry", label: t.settingAutoRetry, current: undefined, values: toggle("autoRetry") },
  ];
}

const settingValueLabel = (run: Run, row: SettingRow): string => row.values.find(value => value.token === row.current)?.label ?? run.t.valueUnknown;

async function settingsCommand(run: Run, args: string): Promise<Reply> {
  const { context, t } = run;
  const state = await call(run, context.controls.getState(context.sessionId));
  const rows = settingRows(run, state);
  const words = args ? args.toLowerCase().split(/\s+/) : [];
  const forms = rows.map(row => `${row.name} ${row.values.map(value => value.token).join("|")}`).join(", ");

  let row: SettingRow | undefined;
  let value: SettingRow["values"][number] | undefined;
  let confirmed = false;
  if (words.length) {
    row = rows.find(candidate => candidate.name === words[0]);
    value = row?.values.find(candidate => candidate.token === words[1]);
    if (!row || !value) return { text: t.settingsUnknown(forms) };
    confirmed = words[2] === "confirm";
    if (!confirmed && !context.ask) return { text: t.settingsNeedsConfirm(row.label, value.label, `/settings ${row.name} ${value.token} confirm`) };
  } else if (!context.ask) {
    return { text: t.settingsList(rows.map(candidate => t.settingsLine(candidate.name, candidate.label, settingValueLabel(run, candidate))).join("\n")) };
  } else {
    const which = await ask(run, {
      title: t.settingsTitle, message: t.settingsMessage,
      options: rows.map(candidate => ({ label: candidate.label, description: settingValueLabel(run, candidate), value: candidate.name })),
    });
    if ("cancelled" in which || !("value" in which)) return { text: t.cancelled };
    row = rows.find(candidate => candidate.name === which.value);
    if (!row) return { text: t.invalidChoice };
    const chosenRow = row;
    const next = await ask(run, {
      title: t.settingsValueTitle(row.label), message: t.settingsMessage,
      options: row.values.map(candidate => ({ label: candidate.label, value: candidate.token, ...(candidate.token === chosenRow.current ? { description: t.current } : {}) })),
    });
    if ("cancelled" in next || !("value" in next)) return { text: t.cancelled };
    value = row.values.find(candidate => candidate.token === next.value);
    if (!value) return { text: t.invalidChoice };
  }
  if (!confirmed) {
    // A global write is never applied on a selection alone.
    const answer = await ask(run, {
      title: t.settingsConfirmTitle, message: t.settingsConfirmMessage(row.label, value.label),
      options: [{ label: t.settingsConfirmYes, value: "yes" }, { label: t.settingsConfirmNo, value: "no" }],
    });
    if (!("value" in answer) || answer.value !== "yes") return { text: t.cancelled };
  }
  await call(run, context.controls.setNativeGlobalSetting(context.sessionId, value.setting));
  return { text: t.settingsDone(row.label, value.label) };
}

// ---------------------------------------------------------------------------
// !command
// ---------------------------------------------------------------------------

async function bashCommand(run: Run, command: string, excludeFromContext: boolean): Promise<Reply> {
  const { context, t } = run;
  if (context.approvalMode !== "bypass") {
    if (!context.approveBash) return { text: t.bashNeedsApproval };
    live(run);
    const approved = await context.approveBash(command);
    live(run);
    if (!approved) return { text: t.bashDenied };
  }
  const result = await call(run, context.controls.runUserBash(context.sessionId, {
    command, excludeFromContext, ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  }));
  const output = result.output.replace(/\s+$/, "");
  const tail = output.length > BASH_REPLY_TAIL_CHARS ? output.slice(-BASH_REPLY_TAIL_CHARS) : output;
  // The fence must be longer than any backtick run in the output. Counted in a loop: output can hold
  // more runs than a call can take as arguments.
  let longest = 2;
  for (const ticks of tail.match(/`+/g) ?? []) if (ticks.length > longest) longest = ticks.length;
  const fence = "`".repeat(longest + 1);
  const status = result.cancelled ? t.bashCancelled : typeof result.exitCode === "number" ? t.bashExit(result.exitCode) : t.bashNoExit;
  return {
    text: [
      `\`${oneLine(command, 200).replace(/`/g, "'")}\``,
      status,
      `${fence}\n${tail || t.bashNoOutput}\n${fence}`,
      tail.length < output.length ? t.bashTail : "",
      result.truncated && result.fullOutputPath ? t.bashTruncated(result.fullOutputPath) : "",
      excludeFromContext ? t.bashExcluded : "",
    ].filter(Boolean).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function declined(run: Run, name: string, args: string): string | undefined {
  const { t } = run;
  switch (name) {
    case "resume": return t.hostResume;
    case "quit": return t.hostQuit;
    case "login": return t.terminalLogin(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(args) ? args : "<provider>");
    case "logout": return t.terminalLogout;
    case "share": return t.terminalShare;
    case "bug": return t.terminalBug;
    case "hotkeys": return t.terminalHotkeys;
    case "changelog": return t.terminalChangelog;
    case "debug": case "arminsayshi": case "dementedelves": return t.terminalOnly(name);
    default: return;
  }
}

function action(run: Run, name: string, args: string): Promise<Reply> | undefined {
  switch (name) {
    case "model": return modelCommand(run, args);
    case "thinking": return thinkingCommand(run, args);
    case "name": return nameCommand(run, args);
    case "session": return sessionCommand(run);
    case "copy": return copyCommand(run);
    case "compact": return compactCommand(run, args);
    case "export": return exportCommand(run, args);
    case "import": return importCommand(run, args);
    case "trust": return trustCommand(run, args);
    case "scoped-models": return scopedModelsCommand(run, args);
    case "reload": return reloadCommand(run);
    case "clone": return cloneCommand(run);
    case "new": return newCommand(run);
    case "fork": return forkCommand(run, args);
    case "tree": return treeCommand(run, args);
    case "settings": return settingsCommand(run, args);
    default: return;
  }
}

function failure(run: Run, label: string, error: unknown): string {
  const { t } = run;
  if (error instanceof Cancelled) return t.cancelled;
  if (error instanceof PiNativeBusyError) return t.busy(label);
  if (error instanceof PiNativeBridgeUnavailableError) return t.bridgeUnavailable(label);
  if (error instanceof PiNativeUncertainError) return t.uncertain(label);
  if (error instanceof PiNativeRejectedError) {
    const allowed = error.allowed?.length ? error.allowed.join(", ") : "";
    if (error.reason === "model-unavailable") return t.rejectedModel;
    if (error.reason === "thinking-unsupported") return t.rejectedThinking(allowed);
    if (error.reason === "not-found") return t.rejectedNotFound;
    return t.rejectedInvalid(allowed);
  }
  if (run.context.abortSignal?.aborted) return t.cancelled;
  // Native text can carry stack frames and local paths: frames are dropped here, the sanitizer reduces paths and bounds the rest.
  const message = error instanceof Error ? error.message.split(/\r?\n/).filter(line => !/^\s*at\s+\S/.test(line)).join("\n") : "";
  return t.failed(label, sanitizePiErrorText(message, 200));
}

async function settle(run: Run, label: string, work: () => Promise<Reply>): Promise<PiNativeCommandResult> {
  try {
    live(run);
    const reply = await work();
    return { handled: true, text: reply.text.trim() ? reply.text : run.t.done, ...(reply.sessionId ? { sessionId: reply.sessionId } : {}) };
  } catch (error) {
    return { handled: true, text: failure(run, label, error) };
  }
}

async function hasSessionCommand(context: PiNativeCommandContext, name: string): Promise<boolean> {
  try { return (await context.controls.listCommands(context.sessionId)).some(command => command.name === name); } catch { return false; }
}

/**
 * Serve one conversation message when it is a Pi terminal built-in or a `!`
 * shell line. Everything else (extension commands, prompt templates,
 * `/skill:name`, `/mcp …`, unknown `/x`, ordinary text) is left to Pi.
 */
export async function runPiNativeCommand(text: string, context: PiNativeCommandContext): Promise<PiNativeCommandResult> {
  const input = text.trim();
  if (!input) return NOT_HANDLED;
  const run: Run = { context, t: COPY[normalizeLocale(context.locale, "en")] ?? EN };

  if (input.startsWith("!")) {
    // `!` adds the output to the model's context, `!!` keeps it out; an empty command is ordinary text (interactive-mode.ts:3471-3487).
    const excluded = input.startsWith("!!");
    const command = input.slice(excluded ? 2 : 1).trim();
    if (!command) return NOT_HANDLED;
    return settle(run, excluded ? "!!" : "!", () => bashCommand(run, command, excluded));
  }

  const parsed = parsePiSlashCommand(input);
  if (!parsed || !Object.hasOwn(PI_TUI_BUILTIN_COMMANDS, parsed.name)) return NOT_HANDLED;
  const { name, args } = parsed;
  const label = `/${name}`;

  if (args && !PI_ARGUMENT_BUILTINS.has(name)) {
    // Pi matches these built-ins on the exact text only, so this goes to a session command of the same name when one exists.
    if (await hasSessionCommand(context, name)) return NOT_HANDLED;
    if (!HOST_ARGUMENT_FORMS.has(name) && declined(run, name, args) === undefined) return { handled: true, text: run.t.noArguments(name) };
  }

  const refusal = declined(run, name, args);
  if (refusal !== undefined) return { handled: true, text: refusal };
  return settle(run, label, () => action(run, name, args) ?? Promise.resolve({ text: run.t.terminalOnly(name) }));
}
