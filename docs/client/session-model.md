# Bot、群、会话、记忆与工作区

依据当前 TaroCub 共用的 Bridge、SessionManager、SessionStore 和原生适配器核对。Bot 是实例；一个 Bot 可以持有多个原生 CLI session。

| 对象 | 归属和行为 |
|---|---|
| Bot | 独立实例配置、模型、effort、默认 workspace、Bot 专用 AGENTS.md、会话映射、用量、任务及进程 |
| Bot 私聊／新对话 | 当前 Bot 的一个独立会话入口；第一次普通任务才建立原生 session |
| 群默认讨论 | 每个参与 Bot 各自绑定 session；多 Bot 群不是所有 Bot 共用一个 CLI session |
| 群内话题 | 独立 conversation ID；每个 Bot 在该话题中独立绑定 session |
| 两台设备看同一对话 | 使用同一 Hub 记录和同一个 Bot 会话绑定，不因换设备新建 session |

侧栏以 Bot 和群组为主体：Bot 下列自己的私聊会话，群下列话题。点 Bot 返回已有私聊，旁边加号明确创建新对话；新建群只选已有 Bot，不重复选择模型和 effort。

## 新群会带走什么

新群和新话题默认不继承旧对话的 session 历史。同一个 Bot 仍使用自己的实例设置、默认工作区和 Bot 专用 AGENTS.md。工作区中的文件没有被复制或清空；它们仍然位于同一目录。

“长期记忆文件仍在”与“新 session 自动加载它”是两件事。TaroCub 没有一个统一、强制读取任意 `MEMORY.md` 的跨引擎记忆系统。原生 CLI 如何发现项目指令、自动记忆及全局配置，仍由该引擎和用户配置负责；文件只在原生机制或明确指令要求读取时进入上下文。不要承诺每个同名 memory 文件都自动注入。

不同 Bot 默认拥有不同 workspace；用户可以明确指定同一个已有项目目录。CLI 的全局 HOME、登录、插件和全局记忆可能共享，独立 Bot 工作区不是操作系统沙箱。新建 App Bot 不自动复制现有飞书 Bot 的 workspace、Bot 专用 AGENTS.md 或记忆；把现有实例接入 Gateway 才会沿用那个实例本身的状态。

## 恢复、切断、重置、停止

- `/resume` 使用 TaroCub 原有扫描、校验和绑定规则。Codex 用 `/resume thread <id>`；其他引擎按原来的列表／编号或 session 语法处理。恢复会话可以带回其原生历史；有工作区元数据时按原规则使用该工作区。
- `/detach` 切断恢复的绑定。有此前挂起的会话则恢复它；否则解除当前绑定，后续普通消息按原引擎规则新建。它不删除磁盘上的长期记忆、旧 session 或 App 历史。
- `/reset` 重置当前会话绑定，后续普通消息开启新上下文；不是删除 workspace 或聊天存档。
- `/stop` 取消当前任务，不等于切断 session。

2026-10-04 真实手机布局验收发现并修复 DeepSeek `/reset` 后重新接入旧群历史的问题：未绑定时不再生成固定聊天标识，而是生成带 UUID 的新标识。已有映射（包含旧版原生标识）仍按原值恢复。详见[五引擎会话与手机切断验收](native-session-mobile-2026-10-04.md)。

App “绑定已有会话”现在记录一次选择，在下一条排队消息处理时应用；保存当前对话自己的旧绑定供 `/detach` 恢复。它不是每轮强制覆盖。应用收据随 Bot 状态持久化，重启后不因旧 Hub 元数据再次覆盖 `/resume`、`/detach` 或 `/reset`。中途崩溃的不确定写入拒绝自动重放，需重新选择；无操作编号的旧版绑定不自动复活已解除的会话。面板显示“最近选择的绑定”，实时引擎状态仍看 `/status`。

失败或中断的恢复不会把普通消息自动交给其他上下文。对话设置中的“清除会话选择”取消 Hub 的恢复选择，Bot 离线时也可操作；另一台设备已经改过选择时会拒绝旧操作。清除并不撤销此前实际发生的切换，恢复中断后需先切断或重置再发普通消息。损坏的收据会保留，清除后可用原生 `/resume`，再次用列表绑定前需修复收据。

Claude 的空白目标对话也保存明确的“此前未绑定”状态，因此先恢复旧会话、再切断，会回到新的上下文。模型运行期间，如果刚选择了另一个会话或恢复状态不确定，补发文字先排队校验，不直接注入旧任务。

多 Bot 群的对话设置可指定要操作的 Bot；恢复、切断、重置、模型等快捷命令只发送给它，并同步更新输入框接收者。“新建独立对话”打开已有 Bot 的新对话表单，不再发送未定义的 `/new` 命令。

## system prompt 与 workspace 管理

Gateway 与无界面 Host 共用 `createBridgeDependencies` 和 adapter。人设是 `<Bot 状态目录>/workspace/AGENTS.md` 中的一段用户指令；各引擎接收明确的 Bot 文件路径，旧人设全文注入已移除。修改文件后可在对话中让 Bot 重新读取；保存不表示运行中的会话已经读取新版。原生引擎继续处理其项目和全局指令。App 的平台说明已独立成短提示词，按需补充能力说明；Codex、Claude 和 DeepSeek 已接入各自原生 App 文件工具，不支持的版本、会话或引擎保留必要兼容。详见 [App 平台提示词与结构化交付](app-platform-prompt.md)。

创建 Bot 时可选择已有工作区，不填则建立该 Bot 的独立目录；`/ws list|save|use|remove` 沿用原管理逻辑。恢复会话的工作区只属于那条对话，不改其他对话的恢复绑定。App 的“人设”编辑器只修改 Bot 专用 AGENTS.md 的人设小节，保留其他规则。CLI 使用同一权限和 revision 校验：`tarobot bots persona ID`，写入用 `--from PATCH.json`。详见[人设文件与迁移](persona-agents-2026-11-04.md)。

验证入口：`gateway-service` 的会话隔离、绑定／恢复／切断／重置与跨频道锁测试；`gateway-session-binding` 的旧版、崩溃和损坏收据保护；`telegram-session-commands` 原有引擎语法回归。运行证据以 [验收记录](implementation-status.md) 为准。
