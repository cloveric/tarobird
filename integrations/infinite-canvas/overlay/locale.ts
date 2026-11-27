import { subscribeHostContextEvents } from "./host-bridge";

const zh = {
    startupError: "无法打开无限画布。请重试。",
    agentDescription: "连接当前对话中的 TaroBird Bot，使其可以操作当前画布。",
    agentReady: "Agent 连接已就绪",
    agentConnecting: "正在连接…",
    agentOffline: "尚未连接",
    agentError: "Agent 连接失败。请确认当前对话后重试。",
    disconnect: "断开连接",
    connect: "连接",
    thirdPartyNode: "第三方节点",
    thirdPartyNodes: "第三方节点",
    nodeDescription: "使用隔离环境运行已安装的第三方文本插件",
    enableNodes: "允许安装第三方节点",
    refresh: "刷新",
    operationError: "第三方节点操作未完成。请确认权限后重试。",
    sourceUrl: "源文件 URL",
    reviewInstall: "检查并安装",
    invalidSource: "请输入包含完整提交 SHA 的 GitHub Raw JavaScript 文件地址。",
    confirmNodeAction: "确认第三方节点操作",
    enableWarning: "第三方代码会处理你主动交给节点的文本，在独立运行环境中执行，无法使用 App 或网络或读取密钥。请只安装来源可信的节点。每个文件安装前还会显示来源与 SHA-256，供你确认。",
    installWarning: "检查并下载此源文件？宿主会校验地址并显示 SHA-256。确认安装前，文件不会运行。",
    removeWarning: (name: string) => `卸载「${name}」？画布保留节点和文本，重新选择已安装插件后可继续使用。`,
    continue: "继续",
    cancel: "取消",
    disabledNotice: "已停用第三方节点。安装记录仍保留。",
    thirdParty: "第三方 · Third-party",
    thirdPartyOption: (name: string) => `${name}（第三方）`,
    uninstall: "卸载",
    nodeDisabled: "第三方节点已停用",
    selectToRun: "选择节点后运行",
    chooseByDoubleClick: "双击选择已安装的第三方插件",
    runNode: "运行节点",
    runError: "运行失败。请确认节点已启用并重试。",
    thirdPartyPlugin: "第三方插件",
    choosePlugin: "选择插件",
    nodeText: "节点文本",
    saveError: "保存节点失败，请重试。",
    done: "完成",
};

const en: typeof zh = {
    startupError: "Infinite Canvas could not open. Please try again.",
    agentDescription: "Connect the TaroBird Bot in this conversation so it can work with the current canvas.",
    agentReady: "Agent connected",
    agentConnecting: "Connecting…",
    agentOffline: "Disconnected",
    agentError: "Could not connect the Agent. Check the current conversation and try again.",
    disconnect: "Disconnect",
    connect: "Connect",
    thirdPartyNode: "Third-party node",
    thirdPartyNodes: "Third-party nodes",
    nodeDescription: "Run an installed third-party text plugin in isolation.",
    enableNodes: "Allow third-party node installation",
    refresh: "Refresh",
    operationError: "The third-party node operation did not complete. Check permissions and try again.",
    sourceUrl: "Source file URL",
    reviewInstall: "Review and install",
    invalidSource: "Enter the URL of a GitHub Raw JavaScript file with the full commit SHA.",
    confirmNodeAction: "Confirm third-party node action",
    enableWarning: "Third-party code processes text you give to a node. It runs in isolation and cannot access the app, network, or credentials. Install nodes only from sources you trust. Review each file’s source and SHA-256 before installing.",
    installWarning: "Check and download this source file? The host will verify the URL and show its SHA-256. The file will run only after you approve installation.",
    removeWarning: name => `Uninstall “${name}”? The canvas keeps the nodes and their text. You can select another installed plugin to use them again.`,
    continue: "Continue",
    cancel: "Cancel",
    disabledNotice: "Third-party nodes are disabled. Installed plugins are kept.",
    thirdParty: "Third-party",
    thirdPartyOption: name => `${name} (third-party)`,
    uninstall: "Uninstall",
    nodeDisabled: "Third-party nodes are disabled",
    selectToRun: "Select the node to run it",
    chooseByDoubleClick: "Double-click to choose an installed third-party plugin",
    runNode: "Run node",
    runError: "The node could not run. Check that third-party nodes are enabled and try again.",
    thirdPartyPlugin: "Third-party plugin",
    choosePlugin: "Choose a plugin",
    nodeText: "Node text",
    saveError: "Could not save the node. Please try again.",
    done: "Done",
};

const ja: typeof zh = {
    startupError: "Infinite Canvas を開けませんでした。もう一度お試しください。",
    agentDescription: "この会話の TaroBird Bot を接続すると、現在のキャンバスを操作できるようになります。",
    agentReady: "Agent に接続済み",
    agentConnecting: "接続中…",
    agentOffline: "未接続",
    agentError: "Agent に接続できませんでした。現在の会話を確認して、もう一度お試しください。",
    disconnect: "接続を解除",
    connect: "接続する",
    thirdPartyNode: "サードパーティノード",
    thirdPartyNodes: "サードパーティノード",
    nodeDescription: "インストール済みのサードパーティ製テキストプラグインを隔離環境で実行します。",
    enableNodes: "サードパーティノードのインストールを許可",
    refresh: "更新",
    operationError: "サードパーティノードの操作を完了できませんでした。権限を確認して、もう一度お試しください。",
    sourceUrl: "ソースファイルの URL",
    reviewInstall: "確認してインストール",
    invalidSource: "完全なコミット SHA を含む GitHub Raw の JavaScript ファイルの URL を入力してください。",
    confirmNodeAction: "サードパーティノードの操作を確認",
    enableWarning: "サードパーティのコードは、ノードに渡したテキストを処理します。隔離環境で実行され、アプリ、ネットワーク、認証情報にはアクセスできません。信頼できる提供元のノードのみをインストールしてください。各ファイルの提供元と SHA-256 はインストール前に確認できます。",
    installWarning: "このソースファイルを確認してダウンロードしますか？ホストが URL を検証し、SHA-256 を表示します。インストールを承認するまでファイルは実行されません。",
    removeWarning: name => `「${name}」をアンインストールしますか？ノードとテキストはキャンバスに残ります。インストール済みのプラグインを選び直すと、引き続き使用できます。`,
    continue: "続ける",
    cancel: "キャンセル",
    disabledNotice: "サードパーティノードは無効です。インストール済みのプラグインは保持されます。",
    thirdParty: "サードパーティ",
    thirdPartyOption: name => `${name}（サードパーティ）`,
    uninstall: "アンインストール",
    nodeDisabled: "サードパーティノードは無効です",
    selectToRun: "ノードを選択して実行",
    chooseByDoubleClick: "ダブルクリックしてインストール済みのプラグインを選択",
    runNode: "ノードを実行",
    runError: "ノードを実行できませんでした。サードパーティノードが有効か確認して、もう一度お試しください。",
    thirdPartyPlugin: "サードパーティプラグイン",
    choosePlugin: "プラグインを選択",
    nodeText: "ノードのテキスト",
    saveError: "ノードを保存できませんでした。もう一度お試しください。",
    done: "完了",
};

const messagesByLanguage = { zh, en, ja };
let messages = zh;
const listeners = new Set<() => void>();

function applyLocale(locale: unknown): void {
    if (typeof locale !== "string") return;
    const language = locale.toLowerCase().split("-")[0];
    if (language !== "zh" && language !== "en" && language !== "ja") return;
    const next = messagesByLanguage[language];
    if (next === messages) return;
    messages = next;
    for (const listener of listeners) listener();
}

export function initializeCanvasLocale(locale: string): () => void {
    applyLocale(locale);
    return subscribeHostContextEvents(event => applyLocale(event.locale));
}

export const getCanvasMessages = () => messages;
export function subscribeCanvasLocale(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
