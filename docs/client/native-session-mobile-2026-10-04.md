# 原生会话、手机切断与后台目标复核

2026-10-04，按用户要求实际使用 Opus 5.5 xhigh 审查手机操作及共用运行层。主代理执行真实 CLI 和配对浏览器验收、独立复现并修复问题。[审查原文与处理](native-session-opus55-2026-10-04.md)；机器回执（本地材料：`evidence/native-session-mobile-2026-10-04.json`）。不是实体手机或部署完成声明。

## 发现并修复的问题

原来的验收只检查切断后没有私聊的内容，无法证明已经恢复群自己的上下文。采纳 Opus 的意见，给私聊和群分别设置普通故事标题 A、B；手机切断、刷新后必须答出 B、排除 A，且完成回答后仍是原群的原生 session ID。

加强后抓到真实 DeepSeek 问题：`/reset` 删除了会话映射，但下一轮仍生成同一个固定聊天标识；Harness 直接按该标识重新打开了旧历史。现在只在没有已有绑定时生成带 UUID 的新标识。已有映射，包括旧版 `telegram-<chatId>` 原生会话，仍原样恢复。新建 session 不清空 workspace、记忆文件或 App 历史。

进一步的 Opus 源码复核和主代理核验补齐后台 `/goal`：

- 目标在原生 session 建立后立即持久化绑定，正常聊天不必等整个目标结束。目标结束不会覆盖后来执行的 `/reset` 或 `/resume`。
- 目标清理固定指向原来的 native session，避免误清切换后的会话。新目标等待旧目标清理完成，避免旧 cleanup 清掉新目标。
- 会话建立与 reset/resume/detach 使用一致的会话锁，按 Bot 的规范状态路径隔离，避免不同 Bot 的同一用户互相阻塞；Telegram 的缺省／显式 key 统一，fan/verify 的本地轮次保留 topic。
- 等锁、等旧目标和 Codex 初始化期间的取消会在启动前检查；取消被显示为中断。

## 真实运行结果

| 流程 | 引擎与版本 | 浏览器 | 范围 |
|---|---|---|---|
| 私聊 A、新群 B、绑定、手机切断和刷新、resume、reset | Codex 0.160.0 / gpt-6-astra | Chromium | 正文标记、每次切换的 native ID、两端消息、记忆文件未改 |
| 同一完整流程 | Kimi 2.1.1 / 默认模型 | WebKit | 私有原生 home，仅受信任的测试工作区 |
| 同一完整流程 | DeepSeek Harness 0.2.0-rc.2 / 默认模型 | Chromium 与最终 WebKit 复测 | 修复前真实失败，修复后新 ID 且排除 A、B |
| 同一完整流程 | Antigravity 1.2.16 / 默认模型 | WebKit | 原生 conversation 恢复与重置 |
| 没有首轮的空目标对话绑定旧 session，再从手机切断、刷新并回复 | Claude Code 2.1.287 / claude-opus-5-5 | WebKit | 新 native ID、没有源上下文、源会话映射不变；两份专属转录清理读回 |
| 允许、拒绝、停止权限请求，再开启新轮 | Codex 0.160.0 | WebKit | 真实 native 请求；允许时准确写入，拒绝与停止无文件写入；此权限验收早于后续 goal 修改 |

上述 engine effort 为 low；审查用的 Opus 为 xhigh。不是用 Opus 替代 Kimi、DeepSeek 或 AGY 实测。Kimi/AGY 与 Claude 流程通过于 UUID 修复后；后台目标及命令锁修改后另复测 Codex、DeepSeek。后台目标并发、清理和等待取消的新增验证为真实 Bridge/SessionStore 加可控 adapter，以及原生适配器协议测试，不伪称为实体手机或真实云模型长目标的完整验收。

DeepSeek 手机收件箱（本地材料：`screenshots/native-session-20261004/deepseek-phone-inbox.png`）

DeepSeek 手机群聊（本地材料：`screenshots/native-session-20261004/deepseek-phone-chat.png`）

## 失败样本与验证口径

- 初始 Codex 的合成“临时口令”被模型拒绝复述；只读取精确归属的测试原生线程确认输入及回复。改用普通故事标题并要求首轮正向确认。另一轮回复未知时，原线程中确有标题和恢复后的请求；随后将询问改为“已有原生对话历史”，避免把当前 chat_id 与原生历史混为一谈。
- DeepSeek 真实 reset 失败保留完整失败回执。早先只排除 A 的用例会误把重接群 B 当作全新会话；旧的成功记录不能证明 reset 创建了新上下文。
- 回答正文必须包含预期内容；折叠 thinking/tool 区域引用提示词不再算答案。避免用 `blocksText` 混合过程文字导致假通过。
- DeepSeek 一次恢复已答出正确标题，但因“只回复标题”没有人设前缀而失败；修改测试提示为按约定格式回复后重新跑完整流程，没有删除人设断言。
- 全量回归中发现新增 session 事件导致旧快照预期不同，已补精确事件断言；新测试初次把读取会话时的 inspect 当作 reset 的 inspect，已在进入运行后清空观测。一次既有密集消息批处理断言在并发负载下失败，未修改其断言或实现，随后该文件完整复测通过。开发过程中一次 build 与接口修改交叠失败，最终构建需以最后回执为准。最后加入 namespace 时一度缺少 path 导入，由定向用例及构建抓出，修正后重新跑完整检查。
- 一次 Opus CLI success 的正文为空，不计为有效审查，保留记录后重新复核。

## 隔离与边界

最终 `scripts/pre-complete-hook.sh`：233 个文件、3676 项通过、1 项既有跳过，构建通过。只在验收进程移除继承的 `CCTB_LARK_ALLOW_ANY_FILE_PATH=1`，没有修改用户生产环境。`git diff --check` 通过。完整日志与源文件哈希见机器回执。

测试由显式环境变量启动；不启用时 Chromium/WebKit 的 21 个 live 用例全部跳过。手机为 390×844 浏览器上下文，桌面与手机配对到临时 Hub。Codex 只归档本次工作区的线程，并要求包含实际观测到的 native ID；Claude 只清理启动前不存在且 sessionId/cwd 匹配的专属项目转录。Hub 必须先关闭才清理状态，关闭失败保留文件。Kimi 与 DeepSeek 使用私有 home 和原有凭证引用；token 刷新可能写回原账号。不声称清除了 AGY 的全局原生历史。

本轮证明显式读取同一 MEMORY.md、保留实例人设和正确切换上下文，不证明各家会自动加载任意 memory 文件。原生确认前失败的首轮可能留下未确认的上游会话，下一轮不擅自恢复该不确定历史。

没有修改前端资源，因此 r9 客户端开发包仍是当前前端；本轮修复属于 Hub/共用运行层，需要后续部署匹配的程序才能作用于已有服务。没有安装替换、发布或重启生产 Bot。实体手机软键盘/输入法、后台生命周期、推送和分享、完整 Android/iOS 工具链等仍是外部验收门槛。整体计划继续开放。
