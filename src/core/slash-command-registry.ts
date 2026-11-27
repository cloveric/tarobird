export interface CoreSlashCommandDefinition {
  command: string;
  description: {
    defaultValue: string;
    i18n: Record<string, string>;
  };
}

function defineCommand(command: string, en: string, zh: string, ja: string): CoreSlashCommandDefinition {
  return {
    command,
    description: {
      defaultValue: en,
      i18n: { en_us: en, zh_cn: zh, ja_jp: ja },
    },
  };
}

/** Canonical command panel. Aliases stay out so the native picker remains useful. */
export const CORE_SLASH_COMMANDS: readonly CoreSlashCommandDefinition[] = [
  defineCommand("help", "Show TaroBird help and command groups", "查看 TaroBird 帮助与命令分类", "TaroBird のヘルプとコマンド一覧を表示"),
  defineCommand("status", "Show engine, session, and runtime status", "查看引擎、会话与运行状态", "エンジン、セッション、実行状態を表示"),
  defineCommand("usage", "Show token usage and cost for this bot", "查看当前 Bot 的用量与成本", "この Bot のトークン使用量とコストを表示"),
  defineCommand("btw", "Ask a side question without changing the session", "旁问一个不影响当前会话的问题", "セッションを変更せずに補足質問をする"),
  defineCommand("ask", "Delegate a prompt to another configured bot", "把任务委托给另一个已配置 Bot", "別の設定済み Bot にタスクを委任する"),
  defineCommand("engine", "Inspect or switch the agent engine", "查看或切换 Agent 引擎", "Agent エンジンを確認または切り替える"),
  defineCommand("model", "Inspect or change the current model", "查看或切换当前模型", "現在のモデルを確認または変更する"),
  defineCommand("effort", "Inspect or change reasoning effort", "查看或调整推理强度", "推論レベルを確認または変更する"),
  defineCommand("fast", "Inspect or toggle Codex Fast Mode", "查看或切换 Codex 快速模式", "Codex 高速モードを確認または切り替える"),
  defineCommand("yolo", "Inspect or change tool approval mode", "查看或调整工具审批模式", "ツール承認モードを確認または変更する"),
  defineCommand("config", "Open the interactive settings panel", "打开交互式设置面板", "対話型の設定パネルを開く"),
  defineCommand("stream", "Inspect or toggle typewriter streaming", "查看或切换打字机流式输出", "タイプライターストリーミングを確認または切り替える"),
  defineCommand("timeout", "Inspect or change runtime safeguards", "查看或调整任务超时保护", "実行タイムアウト保護を確認または変更する"),
  defineCommand("steer", "Inspect or change the mid-turn steering window", "查看或调整任务中途引导窗口", "実行中の指示追加ウィンドウを確認または変更する"),
  defineCommand("account", "Show the bound Feishu or Lark app", "查看当前绑定的飞书或 Lark 应用", "連携中の Feishu / Lark アプリを表示"),
  defineCommand("goal", "Manage the native goal; Codex also supports pause, resume and edit", "管理原生目标；Codex 支持暂停、恢复和编辑", "ネイティブ目標を管理（Codex は一時停止・再開・編集にも対応）"),
  defineCommand("resume", "Find or bind an existing native agent session", "查找或绑定已有原生 Agent 会话", "既存のネイティブ Agent セッションを検索・紐付け"),
  defineCommand("detach", "Detach the current native agent session", "解绑当前原生 Agent 会话", "現在のネイティブ Agent セッションの紐付けを解除"),
  defineCommand("reset", "Reset the current chat session binding", "重置当前聊天的会话绑定", "現在のチャットのセッション紐付けをリセット"),
  defineCommand("restart", "Close this chat's engine process and reopen the session on the next message", "结束当前对话的引擎进程，保留会话，下次发消息时启动", "このチャットのエンジンプロセスを終了し、セッションを保持したまま次のメッセージで起動"),
  defineCommand("stop", "Stop the current running task", "停止当前正在运行的任务", "現在実行中のタスクを停止"),
  defineCommand("q", "Force a message into the task queue", "强制把消息作为新任务排队", "メッセージを新しいタスクとして強制キューイング"),
  defineCommand("bg", "Inspect or stop engine background processes", "查看或停止引擎后台进程", "エンジンのバックグラウンドプロセスを確認または停止"),
  defineCommand("continue", "Continue the latest waiting archive analysis", "继续最近一个等待中的压缩包分析", "待機中の最新アーカイブ解析を続行"),
  defineCommand("context", "Show engine context usage where supported", "查看支持引擎的上下文用量", "対応エンジンのコンテキスト使用量を表示"),
  defineCommand("compact", "Compact the current native agent session", "压缩当前原生 Agent 会话", "現在のネイティブ Agent セッションを圧縮"),
  defineCommand("ultrareview", "Run the Claude deep-review workflow", "运行 Claude 深度审查流程", "Claude の詳細レビューワークフローを実行"),
  defineCommand("cron", "Manage reminders and scheduled agent tasks", "管理提醒与定时 Agent 任务", "リマインダーと定期 Agent タスクを管理"),
  defineCommand("board", "Manage durable Kanban tasks", "管理持久化看板任务", "永続カンバンタスクを管理"),
  defineCommand("mini", "Manage lightweight peer agents in threads", "管理话题中的轻量 Peer Agent", "スレッド内の軽量 Peer Agent を管理"),
  defineCommand("fan", "Run a prompt across configured peers in parallel", "让已配置 Peer 并行执行同一任务", "設定済みの Peer 全体でプロンプトを並列実行"),
  defineCommand("chain", "Run a prompt through configured peers in sequence", "让已配置 Peer 串行执行任务", "設定済みの Peer でプロンプトを順次実行"),
  defineCommand("verify", "Execute locally, then ask a peer to verify", "本地执行后再交给 Peer 复核", "ローカルで実行し、別の Peer に検証を依頼"),
  defineCommand("group", "Manage group access and mention mode", "管理群授权与 @ 提及模式", "グループ権限とメンションモードを管理"),
  defineCommand("invite", "Grant group or user access by mention", "通过 @ 提及授予群或用户访问权", "@ メンションでグループまたはユーザーにアクセス権を付与"),
  defineCommand("remove", "Revoke group or user access by mention", "通过 @ 提及撤销群或用户访问权", "@ メンションでグループまたはユーザーのアクセス権を剥奪"),
  defineCommand("newgroup", "Create and authorize a new project group", "创建并授权新的项目群", "新しいプロジェクトグループを作成して承認"),
  defineCommand("newtopic", "Create and authorize a new topic group", "创建并授权新的话题群", "新しいトピックグループを作成して承認"),
  defineCommand("approve", "Approve a pending tool request", "批准待处理的工具请求", "保留中のツールリクエストを承認"),
  defineCommand("approve-session", "Approve using the request's extended scope", "按请求显示的持续授权范围批准", "リクエストの拡張スコープで承認"),
  defineCommand("deny", "Deny a pending tool request", "拒绝待处理的工具请求", "保留中のツールリクエストを拒否"),
  defineCommand("meeting", "Join, inspect, invite to, or end a meeting", "加入、查看、邀请成员或结束会议", "会議への参加・確認・招待・終了"),
];

// These are implemented but intentionally omitted from the native picker:
// aliases would add noise, while /approval is an internal text fallback.
// "kanban" is the documented alias of /board (docs/slash-commands.md); dropping
// it from this set silently ate /kanban in mention-only groups.
const LARK_HIDDEN_OR_ALIAS_COMMANDS = ["start", "queue", "approval", "kanban"] as const;
const LARK_SLASH_COMMAND_NAMES = new Set([
  ...CORE_SLASH_COMMANDS.map((definition) => definition.command),
  ...LARK_HIDDEN_OR_ALIAS_COMMANDS,
]);

/** Return true only for a command TaroCub actually implements, not an absolute path. */
export function isTaroCubCoreSlashCommand(content: string | undefined): boolean {
  const match = content?.trim().match(
    /^\/([a-z][a-z0-9_-]*)(?:@[a-z0-9_][a-z0-9_.-]*)?(?=\s|$)/i,
  );
  return Boolean(match?.[1] && LARK_SLASH_COMMAND_NAMES.has(match[1].toLowerCase()));
}
