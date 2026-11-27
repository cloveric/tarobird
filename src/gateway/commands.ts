import { CORE_SLASH_COMMANDS } from "../core/slash-command-registry.js";
import { ANTIGRAVITY_APP_COMMANDS, ANTIGRAVITY_EXCLUDED_COMMANDS } from "./antigravity-commands.js";
import { normalizeLocale, type Locale } from "../runtime/locale.js";
import { hostT } from "../locales/index.js";
import { GatewayGroupModeStore, gatewayRequiresMention } from "./group-mode.js";
import { PI_APP_COMMANDS } from "./pi-commands.js";

/** Every canonical TaroCub command has an explicit client disposition. The
 * inventory test rejects new registry entries until their semantics are reviewed. */
export const GATEWAY_COMMAND_POLICIES: Readonly<Record<string, "shared" | "native" | "feishu">> = {
  help: "shared", status: "shared", usage: "shared", btw: "shared", ask: "shared",
  engine: "shared", model: "shared", effort: "shared", fast: "shared", yolo: "shared",
  config: "shared", stream: "shared", timeout: "shared", steer: "native", account: "native",
  goal: "shared", resume: "shared", detach: "shared", reset: "shared", restart: "shared", stop: "shared",
  q: "shared", bg: "shared", continue: "shared", context: "shared",
  compact: "shared", ultrareview: "shared", cron: "shared", board: "shared", mini: "shared",
  fan: "shared", chain: "shared", verify: "shared", group: "native", invite: "native",
  remove: "native", newgroup: "native", newtopic: "native", approve: "shared",
  "approve-session": "shared", deny: "shared", meeting: "feishu",
};

/** `engineCommands`: the live engine's own commands (Antigravity ACP). A Host command of the same name wins, since the Host handles it first. */
export function gatewayCommands(engine: string, query = "", engineCommands: ReadonlyArray<{ name: string; description?: string }> = [], supportsRestart = engine === "claude" || engine === "pi") {
  const shared = CORE_SLASH_COMMANDS.filter(({ command }) =>
    (GATEWAY_COMMAND_POLICIES[command] === "shared" || command === "group")
    && (command !== "fast" || engine === "codex")
    && (command !== "ultrareview" || engine === "claude")
    && (command !== "restart" || supportsRestart)
    && command.startsWith(query.replace(/^\//, "").toLowerCase()))
    .map((definition) => definition.command !== "group" ? definition : {
      ...definition,
      description: {
        defaultValue: "Set this Bot's group or topic reply mode (status/all/at)",
        i18n: {
          en_us: "Set this Bot's group or topic reply mode (status/all/at)",
          zh_cn: "设置此 Bot 在当前群组或话题的回复模式（status/all/at）",
          ja_jp: "このグループまたはトピックでの Bot の返信モードを設定（status/all/at）",
        },
      },
    });
  if (engine === "omp" && engineCommands.length) {
    const prefix = query.replace(/^\//, "").toLowerCase();
    const taken = new Set(CORE_SLASH_COMMANDS.map(({ command }) => command));
    const seen = new Set<string>();
    const omp = engineCommands.flatMap(({ name, description }) => {
      const command = name.toLowerCase();
      if (taken.has(command) || seen.has(command) || !command.startsWith(prefix)) return [];
      seen.add(command);
      const text = description?.trim() || name;
      return [{ command: name, description: { defaultValue: text, i18n: { en_us: text, zh_cn: text, ja_jp: text } } }];
    });
    return [...shared, ...omp];
  }
  if (engine === "antigravity") {
    const prefix = query.replace(/^\//, "").toLowerCase();
    const taken = new Set(CORE_SLASH_COMMANDS.map(({ command }) => command));
    const seen = new Set<string>();
    const curated = ANTIGRAVITY_APP_COMMANDS.filter(({ command }) => {
      const lower = command.toLowerCase();
      if (taken.has(lower) || seen.has(lower)) return false;
      seen.add(lower);
      return lower.startsWith(prefix);
    });
    const agy = engineCommands.flatMap(({ name, description }) => {
      const command = name.toLowerCase();
      if (taken.has(command) || seen.has(command) || ANTIGRAVITY_EXCLUDED_COMMANDS.has(command) || !command.startsWith(prefix)) return [];
      seen.add(command);
      let text = description?.trim() || name;
      if (command === "swarm" && !/preview/i.test(text)) {
        text = text === name ? "Start a multi-agent swarm (Preview & Quota Heavy)" : `${text} (Preview & Quota Heavy)`;
      }
      const zh = command === "swarm"
        ? (text.includes("Preview & Quota Heavy")
          ? "启动多智能体协作 Swarm（Preview & Quota Heavy · 预览 · 高配额消耗）"
          : `${text}（Preview & Quota Heavy）`)
        : text;
      return [{ command: name, description: { defaultValue: text, i18n: { en_us: text, zh_cn: zh } } }];
    });
    return [...shared, ...curated, ...agy];
  }
  if (engine !== "pi") return shared;
  const native = new Map(PI_APP_COMMANDS.map(command => [command.command, command]));
  const names = new Set(shared.map(command => command.command));
  return [...shared.map(command => native.get(command.command) ?? command),
    ...PI_APP_COMMANDS.filter(command => !names.has(command.command)
      && command.command.startsWith(query.replace(/^\//, "").toLowerCase()))];
}

function pickGatewayText(locale: Locale, copy: { en: string; zh: string; ja: string }): string {
  const normalized = normalizeLocale(locale, "en");
  return normalized === "ja" ? copy.ja : normalized === "zh" ? copy.zh : copy.en;
}

/** Hub membership owns access; only this Bot/conversation's reply policy changes.
 * Never write the Feishu allowlist or probe Feishu app scopes from this surface. */
export async function applyGatewayGroupMode(stateDir: string, chatId: string | undefined, isGroup: boolean, action: string, locale: Locale, defaultRequiresMention = true): Promise<string> {
  if (!isGroup || !chatId?.startsWith("gw_")) return pickGatewayText(locale, {
    en: "Use /group status|all|at inside a group or topic. Access is managed by Hub device pairing and conversation membership.",
    zh: "请在群组或话题中使用 /group status|all|at。访问权限由 Hub 设备配对和会话成员管理。",
    ja: "グループまたはトピック内で /group status|all|at を使用してください。アクセス権は Hub のデバイス連携と会話メンバーで管理されます。",
  });
  const store = new GatewayGroupModeStore(stateDir);
  if (action === "all" || action === "at") await store.set(chatId, action);
  else if (action && action !== "status") return pickGatewayText(locale, {
    en: "Use /group status|all|at to manage this Bot's reply mode here. Manage devices in Settings → Device management; create or archive groups in the conversation list.",
    zh: "使用 /group status|all|at 管理此 Bot 在当前群的回复模式。设备授权请到「设置 → 设备管理」；群组创建和归档请在会话列表操作。",
    ja: "ここでの Bot の返信モードを管理するには /group status|all|at を使用してください。デバイスの承認は「設定 → デバイス管理」、グループの作成やアーカイブは会話一覧から行えます。",
  });
  const all = !await gatewayRequiresMention(stateDir, chatId, defaultRequiresMention);
  const mode = all ? "all" : "at";
  // The Host group policy owns delivery; this compatibility override cannot
  // expand or suppress the recipients selected by the Host.
  return pickGatewayText(locale, {
    en: `In App groups and topics, group settings choose who receives a message: ordinary chat requires @mentions; parallel replies address everyone unless specific Bots are mentioned. This Bot's saved reply mode here is "${mode}" (kept for compatibility; it does not change delivery). Choose parallel replies, sequential or independent discussion in the group settings.`,
    zh: `App 群组／话题由群设置决定投递：普通群聊只响应 @；并行回复在未 @ 时发给全员，@ 时只发给被点名的 Bot。此 Bot 在当前群保存的回复模式为「${mode}」（仅为兼容保留，不改变投递）。并行回复、轮流讨论或独立评议请在群设置中选择。`,
    ja: `App のグループ／トピックでは、グループ設定によって配信先が決まります。通常チャットでは @メンションにのみ応答し、並列返信では @ がなければ全員、@ があれば指定された Bot のみに届きます。このグループに保存されているこの Bot の返信モードは「${mode}」です（互換性維持のため保持されており、配信動作は変更されません）。並列返信・順番に議論・独立コメントはグループ設定から選択してください。`,
  });
}

export function gatewayNativeCommandHelp(command: string, locale: Locale): string | undefined {
  if (!["native", "feishu"].includes(GATEWAY_COMMAND_POLICIES[command] ?? "")) return;
  if (command === "steer") return pickGatewayText(locale, {
    en: "In the App, Send queues a new turn and the Steer button adds text to the current task. Unsupported engines report their limit. /steer automatic-window settings belong to the Feishu surface; this command does not change them here.",
    zh: "App 中，普通发送会排队另起一轮；输入补充文字后点击「引导」，即可补充当前任务。不支持的引擎会明确说明。/steer 自动窗口设置属于飞书端，此处不会修改。",
    ja: "App では、通常の送信は新しいターンとしてキューに入り、追加テキストを入力して「誘導」を押すと現在のタスクに指示を追加できます。非対応のエンジンはその旨を通知します。/steer の自動ウィンドウ設定は Feishu 向けのため、ここでは変更されません。",
  });
  if (command === "meeting") return pickGatewayText(locale, {
    en: "Feishu meeting commands require the Feishu channel. You can send recordings or video files here for the Bot to process.",
    zh: "飞书会议操作需要在飞书端使用。你可以在这里发送录音或视频文件，让 Bot 处理。",
    ja: "Feishu 会議コマンドは Feishu チャネルでのみ利用できます。ここには録音や動画ファイルを送信して Bot に処理させることができます。",
  });
  if (command === "newgroup") return pickGatewayText(locale, {
    en: "Choose New group in the conversation list, then select existing Bots. This reuses their settings and starts separate sessions.",
    zh: "在会话列表选择「新建群组」，再选择已有 Bot。沿用 Bot 的配置，群组使用独立会话。",
    ja: "会話一覧で「新規グループ」を選び、既存の Bot を選択してください。Bot の設定を引き継ぎつつ独立したセッションが開始されます。",
  });
  if (command === "newtopic") return pickGatewayText(locale, {
    en: "Open a group and choose New topic. Topics inherit its Bots and keep their own history and sessions.",
    zh: "进入群组后选择「新建话题」。话题继承群里的 Bot，拥有独立的消息记录和会话。",
    ja: "グループを開いて「新規トピック」を選択してください。トピックはグループの Bot を引き継ぎ、独自の履歴とセッションを保持します。",
  });
  if (command === "group") return pickGatewayText(locale, {
    en: "Create groups and topics in the conversation list. Mention a Bot to select who responds. Device access is managed in Settings → Device management.",
    zh: "在会话列表创建群组和话题；在消息中 @ Bot 选择由谁回应。设备访问权限在「设置 → 设备管理」中管理。",
    ja: "会話一覧からグループやトピックを作成し、メッセージ内で @ Bot と指定して応答する Bot を選びます。デバイスのアクセス権は「設定 → デバイス管理」で管理できます。",
  });
  return pickGatewayText(locale, {
    en: "This App connects through your Hub. Pair or revoke your own devices in Settings → Device management. Pairing grants your account access; it is not a restricted guest invitation.",
    zh: "App 通过你的 Hub 连接。在「设置 → 设备管理」中配对或吊销自己的设备。配对会授予你的账号权限，不能当作受限访客邀请。",
    ja: "この App はあなたの Hub 経由で接続します。「設定 → デバイス管理」で自分のデバイスをペアリングまたは取り消しできます。ペアリングはアカウントへのアクセス権を付与するものであり、制限付きゲスト招待ではありません。",
  });
}

export function renderGatewayHelp(engine: string, locale: Locale, supportsRestart?: boolean): string {
  const normalized = normalizeLocale(locale, "en");
  const commandLine = (command: string, description: { defaultValue: string; i18n: Record<string, string> }) => {
    const desc = normalized === "ja"
      ? (description.i18n.ja_jp || description.defaultValue)
      : normalized === "zh"
        ? (description.i18n.zh_cn || description.defaultValue)
        : description.defaultValue;
    return `- \`/${command}\` — ${desc}`;
  };
  return [
    pickGatewayText(locale, {
      en: "**TaroBird App help**",
      zh: "**TaroBird App 使用帮助**",
      ja: "**TaroBird App ヘルプ**",
    }),
    pickGatewayText(locale, {
      en: "Create a Bot once with its engine, model and effort. New chats reuse that Bot's settings and start separate sessions. Create groups from the conversation list, and topics inside a group. Mention a Bot to choose who responds.",
      zh: "Bot 创建时设置引擎、模型和 effort；「新对话」沿用 Bot 配置并开启独立会话。会话列表可新建群组，群里可新建话题，用 @ 选择回应的 Bot。",
      ja: "Bot を作成する際にエンジン、モデル、effort を設定します。「新しいチャット」では Bot の設定を引き継ぎつつ別のセッションを開始します。会話一覧からグループを、グループ内からトピックを作成でき、@ メンションで応答する Bot を選べます。",
    }),
    pickGatewayText(locale, {
      en: "Messages, files, replies and card actions sync across paired devices. Add text to pictures, files or voice recordings before sending. Quote and forward from the message menu.",
      zh: "消息、文件、回复和卡片操作会同步到已配对设备。图片、文件和录音都可附文字一起发送；消息菜单支持引用和转发。",
      ja: "メッセージ、ファイル、返信、カード操作はペアリング済みデバイス間で同期されます。画像・ファイル・音声録音にテキストを添えて送信でき、メッセージメニューから引用や転送も行えます。",
    }),
    ...gatewayCommands(engine, "", [], supportsRestart).map(({ command, description }) => commandLine(command, description)),
    engine === "pi" ? pickGatewayText(locale, {
      en: "Pi model and thinking commands apply to the current conversation; Bot defaults remain separate. While Pi is replying, plain-text Send supplements that task; choose Next turn to use the Host queue. If the task can no longer receive input and delivery is definitely rejected, the unchanged message goes to the next turn; uncertain delivery is never resent automatically. Extension commands wait for their own turn; templates and skills can supplement the current task. Use Pi conversation settings to adjust the live model. Login, logout and terminal-only actions explain their native terminal route.",
      zh: "Pi 的模型和思考强度命令只调整当前对话，Bot 默认设置另行管理。回复中发送纯文字会补充当前任务；选择「下一轮」进入主机队列。任务已不能接收补充且确认未送达时，未改动的消息会转到下一轮；结果待确认时不会自动重发。扩展命令会单独排队执行；模板和技能可补充当前任务。「Pi 对话设置」可调整运行中的模型。登录、退出登录和终端专属操作会说明原生终端入口。",
      ja: "Pi のモデルおよび思考レベルコマンドはこの会話にのみ適用され、Bot の既定設定とは別に管理されます。Pi の返信中に通常のテキストを送信すると実行中タスクへの補足となり、「次のターン」を選ぶと Host キューに入ります。タスクが補足を受け付けられず未送信が確定した場合、元のメッセージはそのまま次のターンに回ります（送信成否が不明なものは自動再送しません）。拡張機能コマンドは順番待ちで実行され、テンプレートやスキルは現在のタスクを補足できます。「Pi 会話設定」から稼働中のモデルを調整でき、ログイン・ログアウトや端末専用操作についてはネイティブ端末での手順が案内されます。",
    }) : engine === "antigravity" ? hostT(locale, "Antigravity Bot 支持在对话中直接使用原生工作流命令（`/swarm`、`/swarm board`、`/grill-me`、`/plan`、`/teamwork`、`/run-workflow`、`/browser`、`/goal`、`/learn`、`/schedule`、`/boost`）以及 Antigravity ACP 动态广播的工作区 Skill。侧边追问继续使用 TaroBird 侧边对话或 `/btw`；桌面端专属命令 `/automation` 会指引使用 TaroBird `/cron` 或 `/schedule`。") : pickGatewayText(locale, {
      en: "Send queues a separate turn while a task is running. Use Steer for a plain-text instruction to the current task; Codex app-server and DeepSeek Harness integrations support this. The App does not apply the automatic /steer window. Engine-specific unsupported operations explain their limits. Engine changes require an idle restart from Operations.",
      zh: "任务执行中，普通发送会排队另起一轮。点击「引导」将纯文字补充给当前任务；Codex app-server／DeepSeek Harness 接入支持此操作。App 不使用 /steer 自动引导窗口。不支持的引擎能力会明确说明。切换引擎后，在「运行状态」安排空闲后重启。",
      ja: "タスクの実行中に通常の送信を行うと、別のターンとしてキューに入ります。「誘導」を使うと現在のタスクにテキストで指示を追加できます（Codex app-server／DeepSeek Harness 連携で対応）。App では /steer の自動ウィンドウは使用しません。エンジン固有の非対応機能はその制限が説明されます。エンジンを切り替えた後は「稼働状況」からアイドル時再起動を行ってください。",
    }),
    pickGatewayText(locale, {
      en: "Aliases: /start → /help, /queue → /q, /kanban → /board. Use /config for settings and each command without arguments for its usage. Pair and revoke your own devices in Settings → Device management.",
      zh: "别名：/start 对应 /help，/queue 对应 /q，/kanban 对应 /board。常用设置见 /config；单独发送命令可查看用法。「设置 → 设备管理」可配对或吊销自己的设备。",
      ja: "エイリアス：/start → /help、/queue → /q、/kanban → /board。各種設定には /config を、各コマンドの使い方は引数なしで送信して確認できます。自分のデバイスのペアリングや取り消しは「設定 → デバイス管理」で行えます。",
    }),
  ].join("\n\n");
}
