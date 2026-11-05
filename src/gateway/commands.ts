import { CORE_SLASH_COMMANDS } from "../core/slash-command-registry.js";
import { GatewayGroupModeStore, gatewayRequiresMention } from "./group-mode.js";

/** Every canonical TaroCub command has an explicit client disposition. The
 * inventory test rejects new registry entries until their semantics are reviewed. */
export const GATEWAY_COMMAND_POLICIES: Readonly<Record<string, "shared" | "native" | "feishu">> = {
  help: "shared", status: "shared", usage: "shared", btw: "shared", ask: "shared",
  engine: "shared", model: "shared", effort: "shared", fast: "shared", yolo: "shared",
  config: "shared", stream: "shared", timeout: "shared", steer: "native", account: "native",
  goal: "shared", resume: "shared", detach: "shared", reset: "shared", stop: "shared",
  q: "shared", bg: "shared", continue: "shared", ws: "shared", context: "shared",
  compact: "shared", ultrareview: "shared", cron: "shared", board: "shared", mini: "shared",
  fan: "shared", chain: "shared", verify: "shared", group: "native", invite: "native",
  remove: "native", newgroup: "native", newtopic: "native", approve: "shared",
  "approve-session": "shared", deny: "shared", meeting: "feishu",
};

export function gatewayCommands(engine: string, query = "") {
  return CORE_SLASH_COMMANDS.filter(({ command }) =>
    (GATEWAY_COMMAND_POLICIES[command] === "shared" || command === "group")
    && (command !== "fast" || engine === "codex")
    && (command !== "ultrareview" || engine === "claude")
    && command.startsWith(query.replace(/^\//, "").toLowerCase()))
    .map((definition) => definition.command !== "group" ? definition : {
      ...definition,
      description: {
        defaultValue: "Set this Bot's group or topic reply mode (status/all/at)",
        i18n: {
          en_us: "Set this Bot's group or topic reply mode (status/all/at)",
          zh_cn: "设置此 Bot 在当前群组或话题的回复模式（status/all/at）",
        },
      },
    });
}

/** Hub membership owns access; only this Bot/conversation's reply policy changes.
 * Never write the Feishu allowlist or probe Feishu app scopes from this surface. */
export async function applyGatewayGroupMode(stateDir: string, chatId: string | undefined, isGroup: boolean, action: string, locale: "en" | "zh", defaultRequiresMention = true): Promise<string> {
  if (!isGroup || !chatId?.startsWith("gw_")) return locale === "en"
    ? "Use /group status|all|at inside a group or topic. Access is managed by Hub device pairing and conversation membership."
    : "请在群组或话题中使用 /group status|all|at。访问权限由 Hub 设备配对和会话成员管理。";
  const store = new GatewayGroupModeStore(stateDir);
  if (action === "all" || action === "at") await store.set(chatId, action);
  else if (action && action !== "status") return locale === "en"
    ? "Use /group status|all|at to manage this Bot's reply mode here. Manage devices in Settings → Device management; create or archive groups in the conversation list."
    : "使用 /group status|all|at 管理此 Bot 在当前群的回复模式。设备授权请到「设置 → 设备管理」；群组创建和归档请在会话列表操作。";
  const all = !await gatewayRequiresMention(stateDir, chatId, defaultRequiresMention);
  // The Host group policy owns delivery; this compatibility override cannot
  // expand or suppress the recipients selected by the Host.
  return locale === "en"
    ? `In App groups and topics, group settings choose who receives a message: ordinary chat requires @mentions; parallel replies address everyone unless specific Bots are mentioned. This Bot's saved reply mode here is "${all ? "all" : "at"}" (kept for compatibility; it does not change delivery). Choose parallel replies, sequential or independent discussion in the group settings.`
    : `App 群组／话题由群设置决定投递：普通群聊只响应 @；并行回复在未 @ 时发给全员，@ 时只发给被点名的 Bot。此 Bot 在当前群保存的回复模式为「${all ? "all" : "at"}」（仅为兼容保留，不改变投递）。并行回复、轮流讨论或独立评议请在群设置中选择。`;
}

export function gatewayNativeCommandHelp(command: string, locale: "en" | "zh"): string | undefined {
  if (!["native", "feishu"].includes(GATEWAY_COMMAND_POLICIES[command] ?? "")) return;
  const english = locale === "en";
  if (command === "steer") return english
    ? "In the App, Send queues a new turn and the Steer button adds text to the current task. Unsupported engines report their limit. /steer automatic-window settings belong to the Feishu surface; this command does not change them here."
    : "App 中，普通发送会排队另起一轮；输入补充文字后点击「引导」，即可补充当前任务。不支持的引擎会明确说明。/steer 自动窗口设置属于飞书端，此处不会修改。";
  if (command === "meeting") return english
    ? "Feishu meeting commands require the Feishu channel. You can send recordings or video files here for the Bot to process."
    : "飞书会议操作需要在飞书端使用。你可以在这里发送录音或视频文件，让 Bot 处理。";
  if (command === "newgroup") return english
    ? "Choose New group in the conversation list, then select existing Bots. This reuses their settings and starts separate sessions."
    : "在会话列表选择「新建群组」，再选择已有 Bot。沿用 Bot 的配置，群组使用独立会话。";
  if (command === "newtopic") return english
    ? "Open a group and choose New topic. Topics inherit its Bots and keep their own history and sessions."
    : "进入群组后选择「新建话题」。话题继承群里的 Bot，拥有独立的消息记录和会话。";
  if (command === "group") return english
    ? "Create groups and topics in the conversation list. Mention a Bot to select who responds. Device access is managed in Settings → Device management."
    : "在会话列表创建群组和话题；在消息中 @ Bot 选择由谁回应。设备访问权限在「设置 → 设备管理」中管理。";
  return english
    ? "This App connects through your Hub. Pair or revoke your own devices in Settings → Device management. Pairing grants your account access; it is not a restricted guest invitation."
    : "App 通过你的 Hub 连接。在「设置 → 设备管理」中配对或吊销自己的设备。配对会授予你的账号权限，不能当作受限访客邀请。";
}

export function renderGatewayHelp(engine: string, locale: "en" | "zh"): string {
  const english = locale === "en";
  return [
    english ? "**TaroBird App help**" : "**TaroBird App 使用帮助**",
    english
      ? "Create a Bot once with its engine, model and effort. New chats reuse that Bot's settings and start separate sessions. Create groups from the conversation list, and topics inside a group. Mention a Bot to choose who responds."
      : "Bot 创建时设置引擎、模型和 effort；「新对话」沿用 Bot 配置并开启独立会话。会话列表可新建群组，群里可新建话题，用 @ 选择回应的 Bot。",
    english
      ? "Messages, files, replies and card actions sync across paired devices. Add text to pictures, files or voice recordings before sending. Quote and forward from the message menu."
      : "消息、文件、回复和卡片操作会同步到已配对设备。图片、文件和录音都可附文字一起发送；消息菜单支持引用和转发。",
    ...gatewayCommands(engine).map(({ command, description }) => `- \`/${command}\` — ${english ? description.defaultValue : description.i18n.zh_cn}`),
    english
      ? "Send queues a separate turn while a task is running. Use Steer for a plain-text instruction to the current task; Codex app-server and DeepSeek Harness integrations support this. The App does not apply the automatic /steer window. Engine-specific unsupported operations explain their limits. Engine changes require an idle restart from Operations."
      : "任务执行中，普通发送会排队另起一轮。点击「引导」将纯文字补充给当前任务；Codex app-server／DeepSeek Harness 接入支持此操作。App 不使用 /steer 自动引导窗口。不支持的引擎能力会明确说明。切换引擎后，在「运行状态」安排空闲后重启。",
    english
      ? "Aliases: /start → /help, /queue → /q, /kanban → /board. Use /config for settings and each command without arguments for its usage. Pair and revoke your own devices in Settings → Device management."
      : "别名：/start 对应 /help，/queue 对应 /q，/kanban 对应 /board。常用设置见 /config；单独发送命令可查看用法。「设置 → 设备管理」可配对或吊销自己的设备。",
  ].join("\n\n");
}
