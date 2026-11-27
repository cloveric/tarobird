import type { CoreSlashCommandDefinition } from "../core/slash-command-registry.js";

function command(name: string, en: string, zh: string, ja: string): CoreSlashCommandDefinition {
  return { command: name, description: { defaultValue: en, i18n: { en_us: en, zh_cn: zh, ja_jp: ja } } };
}

/** Pi 1.5.2's public built-ins. Descriptions describe the App action, including
 * explicit terminal handoffs; hidden terminal/debug commands stay hidden. */
export const PI_APP_COMMANDS: readonly CoreSlashCommandDefinition[] = [
  command("settings", "Inspect Pi settings; confirm changes to native user settings", "查看 Pi 设置；修改原生用户设置前需确认", "Pi 設定を確認（ネイティブユーザー設定の変更は確認が必要）"),
  command("model", "Choose the model for this conversation only", "选择当前对话的模型，不改变 Bot 默认设置", "この会話専用のモデルを選択（Bot の既定設定は変更しません）"),
  command("tree", "Navigate the native session tree and branches", "查看原生会话树并切换分支", "ネイティブセッションツリーとブランチを移動"),
  command("thinking", "Choose the thinking level for this conversation", "选择当前对话的思考强度", "この会話の思考レベルを選択"),
  command("scoped-models", "Choose the model scope for this Bot", "选择此 Bot 的可切换模型范围", "この Bot で切り替え可能なモデル範囲を選択"),
  command("export", "Export the native session as HTML or JSONL", "将原生会话导出为 HTML 或 JSONL", "ネイティブセッションを HTML または JSONL でエクスポート"),
  command("import", "Import a native JSONL session after confirmation", "确认后导入原生 JSONL 会话", "確認後にネイティブ JSONL セッションをインポート"),
  command("share", "Show how to share through the native Pi terminal", "查看通过 Pi 原生终端分享会话的方法", "Pi ネイティブ端末での共有方法を表示"),
  command("bug", "Show how to report a bug through the Pi terminal", "查看通过 Pi 原生终端提交问题的方法", "Pi ネイティブ端末でのバグ報告方法を表示"),
  command("copy", "Show the last native reply for copying", "显示最近一条原生回复，便于复制", "コピー用に直前のネイティブ返信を表示"),
  command("name", "Show or set the native session name", "查看或设置原生会话名称", "ネイティブセッション名を表示または設定"),
  command("session", "Show native session statistics and per-model usage", "查看原生会话统计及各模型用量", "ネイティブセッション統計とモデル別使用量を表示"),
  command("changelog", "Show where to read Pi's native changelog", "查看 Pi 原生更新记录的入口", "Pi のネイティブ更新履歴の閲覧方法を表示"),
  command("hotkeys", "Show the native terminal keyboard-shortcut guidance", "查看原生终端快捷键指引", "ネイティブ端末のキーボードショートカット案内を表示"),
  command("fork", "Fork from a previous native user message", "从之前的原生用户消息建立分支", "以前のネイティブユーザーメッセージからフォーク"),
  command("clone", "Clone the current native session", "复制当前原生会话", "現在のネイティブセッションを複製"),
  command("trust", "Manage this Bot's trust for its workspace", "管理此 Bot 对当前工作区的信任", "ワークスペースに対するこの Bot の信頼設定を管理"),
  command("login", "Show provider sign-in instructions for the Pi terminal", "查看在 Pi 原生终端登录提供商的指引", "Pi 端末でのプロバイダーログイン手順を表示"),
  command("logout", "Show provider sign-out instructions for the Pi terminal", "查看在 Pi 原生终端退出提供商的指引", "Pi 端末でのプロバイダーログアウト手順を表示"),
  command("new", "Start a new native session for this conversation", "为当前对话开启新的原生会话", "この会話の新しいネイティブセッションを開始"),
  command("compact", "Compact this native session, optionally with instructions", "压缩当前原生会话，可附加指引", "現在のネイティブセッションを圧縮（指示の指定も可能）"),
  command("resume", "Find or bind an existing native Pi session", "查找或绑定已有的 Pi 原生会话", "既存の Pi ネイティブセッションを検索・紐付け"),
  command("reload", "Reload the native workspace resources", "重新加载原生工作区资源", "ネイティブワークスペースリソースを再読み込み"),
  command("quit", "Show how to stop the Bot from the App", "查看在 App 中停止 Bot 的方法", "App から Bot を停止する方法を表示"),
];
