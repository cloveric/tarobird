# Opus 5.5 手机真实 CLI 验收迁移审查

2026-10-04，实际模型 `claude-opus-5-5`，CLI 指定 `--effort xhigh`、`--no-session-persistence`，仅允许 Read/Edit。55 个工具/模型轮次；返回 success，没有工具权限拒绝。下面保留模型返回原文。测试执行、结果判断和生产修复由主代理另行完成。

## 模型原文

8 个文件都改完了。**我没有运行任何测试、类型检查、构建或 shell 命令**，也没有 commit 或 push。生产代码、`fixtures/mobile.ts` 和主代理负责的那 8 个 live 文件都没动。

## 改了什么

改法参照主代理已经改好的 `live-stop.spec.ts`。

**1. 配对后的在线等待（8 个文件，共 9 个 `pair`）**
`pair()` 里原来写的是 `expect(device.locator(".connection-pill.online")).toBeVisible()`，现在换成 `waitForClientOnline(device)`。这个 helper 在桌面上照样检查连接状态胶囊可见，所以桌面端的检查没有变弱。

**2. 手机从收件箱进入对话（9 个测试）**
每个测试都是在桌面点"开始对话"、`pair(phone)` 之后，按原逻辑从 Hub 读出 `conversation`，然后马上加一行 `await selectConversation(phone, conversation.title)`。
- 用的是本次测试实际创建的那个对话的标题，没有写死字符串。我对过源码：`App.tsx:381` 建对话时标题是 `与 {Bot名} 的新对话`，`MobileHome.tsx` 的收件箱行原样显示这个标题。
- `pair` 本身不会选对话；桌面的步骤和顺序都没改。
- 这 8 个文件里没有页面 reload，所以不涉及 reload 后重新进入的问题。

**3. 手机上的停止按钮（`live-codex-input` 2 处，`live-codex-permissions` 1 处）**
新版手机界面只在有回复正在进行时，才在输入框旁边显示"停止当前轮次"（`App.tsx:358`）；其余时候这个按钮在"更多聊天操作"菜单里（`App.tsx:377`）。所以我在这两个文件里各加了一个本地的 `stopFromPhone()`：
- 如果输入框旁的停止按钮可见，就点它；
- 否则调用 `mobileChatAction(phone, "停止当前轮次")`，从菜单里点。

两条路发出的都是同一个 `turn.stop`。停止之后的所有断言都照旧：两端问题或授权卡片消失、pending 为 0、没有写入文件、后一轮正常完成。

提示词、模型调用、下载和哈希校验、授权允许/拒绝、截图、证据 JSON、清理/归档逻辑都没改，也没有加自动重试。

## 需要主代理验证

1. **类型检查**：确认新加的 import 和 `stopFromPhone` 能编译通过。项目具体用什么命令我没确认。
2. **普通套件**：不设环境变量时，这 8 个文件应该仍然被 skip。
3. **停止走哪条路还没确认**：问题或授权卡片等待回答时，运行卡片是不是 `streaming` 状态，我没有核实。Gateway 只在卡片带 `streaming_mode` 时才标成 streaming（`channel.ts:225`）。真跑时建议看一眼实际走的是输入框按钮还是菜单。如果你们要求必须从输入框停止，可以改成像 live-stop 那样先断言按钮可见。
4. **真实引擎验收**：要设各自的 `TAROCUB_LIVE_*=1`，在 Chromium 和 WebKit 上跑。这些会花钱，要不要跑由你们决定。我这边没有任何真实运行的结果。
5. **一个原有的时间竞争没处理**：`conversations("owner")[0]` 靠 `pair(phone)` 拖出来的时间来保证对话已经建好。这个竞争原来就有，我和 live-stop 一样没改。

## 主代理处理

- 已检查变更，8 个指定文件共 9 条测试使用可见手机 IM 入口，业务与安全断言保留。其余 7 个文件由主代理更新；WebKit 现在收集全部 16 个 live 文件的 21 条测试。
- 两套浏览器无开关均跳过全部 21 条真实引擎测试；没有因扩大收集范围自动调用模型。Playwright 实际加载解析全部测试；客户端 TypeScript 构建通过，但该构建并不对全部 e2e 代码做独立类型检查。
- 本轮已执行 Codex 原生提问/MCP、Claude 10 图与 PDF、DeepSeek 原生 App 工具、Kimi 提问/审批，以及五引擎停止续聊。未宣称所有迁移后的 live 文件都已运行。
- Stop 的普通流程由 live-stop 的可见按钮断言覆盖；原生表单允许通过输入栏或更多菜单停止，两者均属实际产品入口。保留全套停止后安全断言。
- 关于 conversations()[0] 的竞态只是代码风险提示，本轮未复现；测试创建的是隔离 Hub 中的唯一对话，所有已执行流程均成功获取并通过可见标题进入。没有以重试或删断言掩盖失败。
- 首次真实 Codex MCP 表单暴露了真实焦点抢占问题，已单独复现、修复及复测；详见手机原生 CLI 调试记录。
