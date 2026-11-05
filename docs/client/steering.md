# App 排队与引导

更新：2026-10-30

Claude 的当前原生 worker 明确支持运行中输入时，单聊普通纯文字发送会补充当前任务；「作为下一轮发送」保留队列。当前轮刚结束等确定未投递的拒绝，普通发送会回落为下一轮；不确定的结果和会话绑定变化不会自动重发。其他引擎保留普通发送排队、显式引导的操作方式。附件、引用、群组路由及普通命令保留原有处理流程，不静默转成纯文字引导。

App 不使用旧传输的自动 30 秒引导窗口或新消息抢占策略；旧传输已退休。Claude 的任务、停止与真实验证边界见 [交互对齐说明](claude-interaction-parity-2026-10-23.md)。

输入框的「引导」将纯文字补充到一个选定 Bot 的当前任务，不停止或重建任务。CLI 接收后显示「CLI 已接收引导」。这不承诺立即中断正在生成的文字或工具：原生 CLI 在它的输入处理点采用补充要求。需要中断时使用「停止」。

| 当前适配器 | 引导 |
| --- | --- |
| Codex app-server | `turn/steer`，携带原生 `expectedTurnId` |
| DeepSeek Harness | 私有原生管道核验普通输入 ID 与原生轮次，`agent.inject` 只进入该轮下一步；排队时明确拒绝 |
| Claude Code | 当前 worker 声明 `msg_lifecycle_v1` 时用原生 streaming user input；在下一模型请求边界采用，错过合入时接续同一主机轮次 |
| Kimi / Antigravity | 当前适配器未实现原生入口，点击时提示暂不支持，保留草稿 |

能力来自实际 Bridge adapter，不根据 Bot 的模型名称猜测。参考 [Codex 官方协议](https://developers.openai.com/codex/app-server#steer-an-active-turn)。

## 交付与恢复

- Hub 验证设备、用户会话成员资格和 Bot 成员资格。群组需要选一个 Bot；话题以自己的 conversationId 隔离。
- GET 获取当前运行对象的临时 token；POST 限定该 token。绑定和 session 异步读取之后再次检查任务，已结束的指令不会注入下一轮。自主 goal watcher 本身不可引导，普通附属轮次按自己的运行对象识别。
- 显式引导通过在线 HTTP 控制入口，永不进入普通消息 outbox 或 delivery 队列，也不因断线自动重发。拒绝时保留输入。Claude 普通发送的确定未投递回落不改变显式引导的严格语义。
- Claude 原生 adoption outcome 通过声明过能力的持久上报更新原卡片：已进入模型、已进入后台复核或未采纳；不把“接收”当作“已执行”，不自动重发未采纳内容。
- 独立用户消息保存文字和结构化回执，桌面/手机正常同步并持久化。回执自身不再发送给模型；转发只保留原文字。
- Gateway 在副作用前落盘 request receipt，重复请求和重启不重复调用 CLI。超时/断线显示待确认，允许使用原请求 ID「核对引导回执」。Hub 重启将未完成状态标为待确认，晚到的失败不能覆盖确定成功。
- 附件、录音、引用不能通过纯文字引导入口静默丢弃。用户需移除它们或普通发送。

## 2026-10-04 补充

DeepSeek 不再使用无目标条件的全局 steer：队列、目标、轮次结束和中止的边界已补齐。详见 [原生引导验收](deepseek-steering-2026-10-04.md)。

## 2026-10-03 历史验收

- 完整 pre-complete：223 个测试文件，3,476 通过、1 跳过，根项目构建通过。
- Chromium / WebKit：真实 Hub 和 Gateway 的双设备队列/引导、回执重放、冲突拒绝、附件保护、空闲拒绝及三个不支持适配器的提示。现有停止、队列和话题隔离回归通过。
- 真实 Codex 与 DeepSeek：桌面发起任务，手机中途补充，CLI 返回接收回执；最终按补充输出指定标记，timeline 只有一个 `turn.started`，引导没有普通 delivery。Codex 验收会话在临时进程停止后按工作目录精确归档。
- 连续长文本实验确认：原生 Codex 的接收回执并不代表立即打断输出，因此 UI 明确写「接收」。以有界工具执行后继续回答的任务验证同轮采用。
- `client/e2e/live-steering.spec.ts` 是显式启用的真实 CLI 验收：`TAROCUB_LIVE_STEERING=1 TAROCUB_LIVE_ENGINE=codex|deepseek`。
- 浏览器证据在 `design/steering/2026-10-03/`。当前 55834 演示引擎不支持引导，不会冒充真实 CLI。Mac 调试包构建成功不等于已在实体手机或原生窗口完成手工验收。


## Bot 协作与命令行投递状态（2026-10-30）

常规 Bot 协作及跨轮补充使用 `messages send/wait`，不借用仅限当前任务的 `steer send`。旧任务 token 被拒绝是隔离保护，不应通过自动获取新 token 或自动排入下一轮绕过。

CLI 现在将回执中的拒绝、未采纳和结果待确认映射为非零退出码，并在 stderr 显示处理方向；stdout 仍为原结构化回执。已接收后晚到的 adoption/native-input 证据在再次核对时优先采用。App/手机/桌面继续读取同一份 Host 回执，权限、队列及去重语义不变。相关实证和验收见[投递回执修复](bot-delivery-receipts-2026-10-30.md)。
