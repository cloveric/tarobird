# TaroCub 全功能对齐审查

> 历史审查记录（2026-10-01—02），保留当时的路径和范围供追溯。
> 其中飞书／Telegram 适配器及入口已退役，不是当前部署或开发指令。
> 当前架构、共享测试与兼容边界见 [适配器退役说明](../adapter-retirement-2026-10-21.md)
> 和 [入口地图](../entrypoint-map.md)。

核对日期：2026-10-01—02。基线为原 TaroCub 与客户端工作树共同的 `2941619`，以及当前客户端工作树的实现。原仓库、在线实例、账号和部署配置均未改动。

本表以源代码入口为依据。“共享”表示 App 调用同一处理器，“本地验证”表示测试使用真实 Hub/Gateway/状态文件和受控引擎，“真机／外部验收”必须有实际设备或服务结果。三者不能互相代替。完整验收记录见 [implementation-status.md](implementation-status.md)，媒体与 MCP 细节见 [capability-map.md](capability-map.md)。

详细的 Bot／群／session／记忆／workspace／system prompt 关系见[会话与记忆说明](session-model.md)。

## 对齐原则和状态所有权

- **Bot 是实例**：拥有引擎、模型、effort、审批策略、workspace、usage、board、cron 和可选 Bus 配置。新建对话不重复创建 Bot。`hub/bot-manager.ts` 初始化配置后不覆盖用户后续更改。
- **对话是会话入口**：单聊、群默认讨论、群内话题各有 conversation ID；同一个 Bot 在不同对话中建立不同 native session。绑定已有会话才共享上下文；相同 native session 仍共用 turn lock。
- **多端共享已发送状态**：Hub 的持久化事件是消息、卡片更新、审批、附件、引用、转发、已读和会话元数据的依据。页面、尚未发送的草稿和录音草稿仍属于设备本地。
- **共享处理链**：Hub → Gateway → `lark/message-handler.ts`、`lark/commands.ts`、`lark/card-actions.ts` → Bridge → 本机原生引擎。Gateway 不自建第二份模型对话、计费、排队或 ASR 逻辑。
- **入口权限分开**：App 使用 Hub 配对和成员权限；飞书保留其用户／群授权。App 群回复模式只写该 Bot 的 `gateway-group-mode.json` 中的 `gw_` 会话条目，不修改飞书全局 groupMode、allowlist 或应用 scopes。

## 全部正式命令

源清单为 [`slash-command-registry.ts`](../../src/lark/slash-command-registry.ts)，共 42 项。每项在 [`gateway/commands.ts`](../../src/gateway/commands.ts) 明确标记。`gateway-command-parity` 会检查清单集合，新增命令未分类时失败。也核对了 `src/service.ts` 的 Telegram 菜单和 `src/telegram/*commands.ts`：菜单的 24 项均落在下表中，群授权按 Hub 原生方式处理，Telegram 的内联选择交互由 App 卡片承接。该检查防止遗漏入口，不代表每个子命令已经真机验收。

| 命令 | App 语义与关键边界 | 主要执行者／本地证据 |
|---|---|---|
| `/help` | App 帮助，显示可用命令、Bot／对话区别和双端用法 | `commands`；`gateway-command-parity` |
| `/status` | 当前引擎、模型、effort、会话、运行和审批；不显示飞书 CLI 故障 | `commands`；`gateway-command-parity` |
| `/usage` | 同一实例账本；缺失用量必须说明，不能当成零成本 | `commands`、`UsageStore`；既有 usage 测试 |
| `/btw` | 临时旁问，不改变主会话绑定 | 共享命令与 Bridge；既有旁问／session 测试 |
| `/ask` | 已配置 peer 委托，保留身份、权限、用量和审计 | `lark/bus`；`gateway-bus` 真实本地 HTTP |
| `/engine` | 修改实例引擎并清理不兼容绑定；明确提示空闲后重启 | `commands`、`config-card`；`gateway-command-parity` |
| `/model` | 引擎原生模型名及兼容性校验；动态 provider 仍由引擎确认 | 共享 engine commands；五引擎回归 |
| `/effort` | 沿用引擎／模型支持范围，不能任意提供 ultra | `instance-config`、model capabilities；五引擎回归 |
| `/fast` | 仅 Codex；命令菜单和帮助读取当前配置 | `commands`；`gateway-command-parity` |
| `/yolo` | 普通审批、full-auto、unsafe 的原引擎语义 | `approval-mode`、`config-card`；既有审批测试 |
| `/config` | 原配置卡和表单；设备权限用 Hub，群回复按钮独立适配 | `config-card`、`card-actions`；命令／卡片／双端浏览器测试 |
| `/stream` | 共享流式开关；Gateway 消息保留原版本更新语义 | `commands`、managed card、transport；stream/card 测试 |
| `/timeout` | 原引擎硬上限／无输出保护，不另造超时策略 | 共享 commands；runtime timeout 测试 |
| `/steer` | Codex／DeepSeek 运行中纯文字引导窗口；其他情况排队 | `message-handler`；原 steer/queue 回归 |
| `/account` | 指向 Hub 设备管理，不虚构飞书应用身份 | `gatewayNativeCommandHelp`；命令集成测试 |
| `/goal` | 原生／桥接目标、预算、status/clear；保留引擎不支持提示 | `commands`、`lark/bus`；`gateway-workflows` |
| `/resume` | 原生扫描、标题、cwd 校验、会话绑定；不改其他对话 | SessionStore、native adapters；`gateway-service`、`gateway-operations` |
| `/detach` | 解绑当前对话与恢复的 native session | 共享 session commands；会话回归 |
| `/reset` | 重置当前会话绑定，不能删除其他对话记录 | 共享 session commands；会话回归 |
| `/stop` | 取消当前任务／语音预处理／待选择操作，让队列继续 | `message-handler`；`gateway-service`、`gateway-voice`、`gateway-workflows` |
| `/q` | 强制作为新一轮 FIFO 排队，不当成 steer | 共享 message handler；queue 回归 |
| `/bg` | 该实例的后台进程检查／终止；仍由现有进程归属检查负责 | `background-processes`；既有后台进程测试 |
| `/continue` | 继续等待中的压缩包分析工作流 | `file-workflow` 与共享命令；既有工作流回归 |
| `/ws` | list/save/use/remove；切换 workspace 按原规则清理绑定 | `commands`、SessionStore；workspace/session 回归 |
| `/context` | 原引擎 context 数据；没有原生数据时明确说明 | 共享命令、adapter；五引擎回归 |
| `/compact` | 原生 compact 或既有 fallback；不当作普通提示发送 | 共享 session commands；五引擎回归 |
| `/ultrareview` | 仅 Claude 专用审查；其他引擎菜单不展示 | 共享命令；命令清单和 Claude 回归 |
| `/cron` | list/add/rm/toggle/mode/run，按当前对话保存，逐条提醒 | 同一 CronStore/Scheduler/executor；`gateway-workflows`、cron 回归 |
| `/board` | 持久化任务、依赖、状态、run/review/heartbeat/recover/worktree | 同一 board service 与卡片回调；`gateway-workflows`、board 回归 |
| `/mini` | here/ask/fan/chain/verify/crew，保持群／话题边界 | `lark/bus`、MiniBusStore；Gateway 注册测试与既有 mini/crew 回归 |
| `/fan` | 配置 peer 并行协作，使用既有工作流 | `lark/bus`；`gateway-workflows` |
| `/chain` | 配置 peer 串行协作，前一步结果进入下一步 | 同一 delegation handler；既有 delegation/crew 回归 |
| `/verify` | 本机执行后交配置 peer 复核 | `lark/bus`；`gateway-workflows` |
| `/group` | status/all/at 按当前 Bot＋群／话题设置；授权类动作指向 Hub UI | `applyGatewayGroupMode`；命令、配置卡、话题隔离测试 |
| `/invite` | 指向设备管理，明确不是受限访客邀请 | native guidance；不修改飞书 access 配置 |
| `/remove` | 指向 Hub 设备吊销／会话管理 | native guidance；不修改飞书 access 配置 |
| `/newgroup` | 指向“新建群组”，选已有 Bot；避免创建飞书群 | Hub 原生 UI；creation/topics 浏览器测试 |
| `/newtopic` | 指向群内“新建话题”；独立历史和 session | Hub 原生 UI；creation/topics 浏览器测试 |
| `/approve` | 单次或原引擎支持的 session/turn/always 批准 | `card-actions`；`gateway-workflows`、审批回归 |
| `/approve-session` | 对指定请求授予原引擎支持的 session 权限 | 同上；不得扩大到另一对话／请求 |
| `/deny` | 拒绝当前或指定待审批请求 | 同上；无 `/deny session` 语义 |
| `/meeting` | 飞书会议为原计划非目标；明确提示使用飞书端 | 入口拦截，不访问 VC API、不启动引擎 |

隐藏别名仍由原解析器处理：`/start`→帮助、`/queue`→排队、`/kanban`→看板；`/approval` 是审批文本回退，不重复塞进菜单。

## 不属于斜杠菜单的功能

| 功能族 | 保留的逻辑与验收点 | 源码／证据 |
|---|---|---|
| 引擎生命周期 | native CLI 登录、工作区指令、adapter 重连、后台事件、session lock | `runtime/bridge`、五引擎 adapters；原引擎测试＋真实 Codex／Claude／Kimi／DeepSeek 双端 worker 验收 |
| MCP／技能／插件 | 原生配置与 HOME，instance/shared.env 允许键；不把凭证下发手机 | `gateway/environment`；环境与 MCP 卡片测试；真实所有远端 MCP 仍未逐项验收 |
| 运行卡 | 思考仅属进度；工具开始／完成／报错、子代理、todo、完成用量 | `card-renderer`、`managed-card`、翻译器；card inventory/golden/stream |
| 问题与审批 | 单选、多选、数量限制、自定义答案按引擎能力；提交后关闭旧按钮 | `card-actions`；Gateway workflows/card states、双端交互 |
| 输入分类 | 附件、引用、普通文本、中途引导、队列、归档输入，逐入口权限检查 | `message-handler`；Gateway 服务、媒体、转发与共享 handler 回归 |
| 语音 | 录音／试听／取消／附文字；短 Qwen、长 Tingwu、强制路由、缺段标记 | capability map 详述；Gateway voice、真实本地 Qwen、两种浏览器编码解码 |
| 视频 | ≤10 秒抽帧与尽力转写；长视频原文件交引擎 | 原视频预处理；原视频回归，不声称长视频自动完整理解 |
| 文件输入 | 多图＋PDF、caption、引用附件、压缩包分析与 continue | shared files/workflow；Gateway 11 附件验证和浏览器 composer |
| 结果投递 | send.file/image/audio/video/batch、whole-file block；realpath、凭证路径、工作区限制、修复预检 | `delivery`、`delivery-followup`、`delivery-preflight`；Gateway 与原投递回归 |
| 长回答 | 完整 Markdown、表格、公式、卡片布局；禁用飞书长度／表格限制 | translator、fragments、Markdown worker；50k 字、多表格、超 1 MiB 重连验证 |
| 引用／转发 | 引用内容和附件进入引擎；转发副本只读，不重触发原操作 | store/attachments；forwarding、message-actions |
| 链接预览 | 标题／卡片选择、取消、跨端同步；公开元信息、安全 fetch 与图片代理 | link-preview；协议、SSRF 边界和双浏览器验证 |
| 崩溃恢复 | 先重放未确认发布，再补发已生成答案，再处理输入回执；不重跑引擎 | Gateway transport 与共享 delivery recovery；新集成测试 |
| 后台结果／定时推送 | 使用原运行时和对话归属，提醒不合并；App 锁屏依赖系统推送 | cron/workflows/push；本地消息／outbox 验证，真机推送待部署 |
| 运维／审计 | 忙碌时延迟重启，实例归属、健康、usage、日志脱敏；未上报的 token／费用显示未知，保留切换引擎前的累计记录。App 已有 Hub 审计与 Bot 时间线／审计，可筛选、分页、查看详情和原规则的事件统计；自建 Bot 停止后仍能读取日志 | bot manager、operations、runtime/diagnostics、hub/diagnostics；原事件 schema、脱敏及统计函数；`diagnostics` 和双浏览器双端流程。Dashboard 现有在线活动、cron 设置／执行历史、最近 crew 阶段与 UTC 日／月用量；共享 cron 读取／时区／单次提醒规则，并区分实时进程与保存记录；`bot-dashboard`、原 Dashboard／CronStore 回归、浏览器 `dashboard` |
| 本机 Web Console／File Center | App 已接入原文件盘点逻辑：只盘点 Hub 登记 Bot 的 workspace、inbox、ASR，去重共享工作区；可筛选、查看占用／来源／分类依据，保存重要标记、分类和备注，双端共享且冲突保留草稿。首次导入原 Console 标注，之后由 Hub 管理。手机明确请求在 Hub 的 Mac 中显示；不修改或删除文件正文 | `hub/file-center`、共享 `ui/file-inventory`、`client-protocol/file-center`、App `FileCenter`；`hub-file-center`、原 Console 回归、备份恢复与两种浏览器双端用例。已测隔离工作区 10,000 文件／2,000 文件组；真实 Finder／原生容器及实际大工作区仍待验收 |
| 备份恢复 | 同机原路径恢复 Hub 身份、Bot 配置、session 引用、附件及上传进度 | `state-backup`；21 定向检查＋真实 Codex 备份恢复 |
| 安全／同步 | 设备签名、Hub 身份固定、吊销、会话成员、幂等事件和离线队列 | auth/store/server；安全、快照、断线、跨端浏览器测试 |

## 引擎差异不能被 App 掩盖

以实际 adapter 和 [`kimi-capability-matrix`](../kimi-capability-matrix.md)、[`deepseek-harness-engine`](../deepseek-harness-engine.md) 为准，而非把所有按钮解释成所有引擎都有：

- Codex／DeepSeek 支持指定条件下的 mid-turn steer；Claude、Kimi、Antigravity 后续输入排队。
- Kimi 的 ACP goal 不支持时明确拒绝；选项表单按协议版本提供，不能把任意自由输入强塞进 option ID 回调。
- Kimi 没有结构化逐轮 token／费用；DeepSeek 有 token 但没有美元费用；USD 预算不能伪装成这些引擎的成本硬限制。
- Claude 的 ultrareview 和 Codex 的 Fast Mode 是引擎专属。切换 engine 需要受控重启；菜单读取已保存设置不代表运行中的旧引擎已经热切换。
- MCP、插件和搜索的真实可用性取决于原生配置、登录和服务状态。新 App 不重写引擎配置，也不自动安装高权限插件。

## 本轮发现并修复

1. `/help`、`/status`、`/config`、engine 重启说明残留飞书操作指引：按 Gateway 画像给出 App 入口；原飞书文案保留。
2. 菜单采用启动时 engine：改为读取当前保存的实例配置；help 与菜单采用同一过滤函数。
3. App 群设置复用了飞书授权和 scope 查询：改为本 Bot、当前群／话题的回复规则，按钮和命令共用逻辑；单独的状态文件使“仅 @”能覆盖实例全量默认，且飞书清除群设置不会影响 App 的显式设置；Hub 成员权限不受影响。
4. 两个频道共用 `channel=lark` 补发账本：在 claim 前按 `gw_` 对话过滤，其他通道的 attempts／owner 保持不变。
5. 独立 Gateway worker 缺少最终回复补发：attach 时先完成 journal 重放和一次 boot sweep，再处理未确认输入；补发进入同一附件预检和上下文。原 Lark 的 crash-loop 开关也传递给 Gateway。独立 worker 现也读取同一异常启动窗口：强杀、捕获的启动异常和清理异常均纳入规则；触发时跳过本次启动恢复，保留待补发正文，并继续重放已提交的 journal。审计页可见暂缓原因，正常关闭／空闲重启后重新启用恢复。
6. App 运行状态页把未上报费用展示为 `$0.0000`：改为未知提示，Kimi 未计量请求不显示成零 token；已有费用和 token 累计仍保留，明确它们不覆盖缺失的数据。旧账本不能区分已上报零费用与没有费用字段，所以零额不会被当作“确认免费”。
7. App 缺少原文件中心入口：复用原扫描器，加入已登记根目录限制、可取消盘点、共享标注、冲突保护和桌面／手机页面。取消等待所有读取任务结束，失败保留旧快照；旧标注首次导入且清除后不复活；重新分类不会绕过凭证保护。已验证身份／成员／吊销、未知路径拒绝、共享工作区去重、不跟随符号链接、备份恢复和保存中编辑保护。
8. App 只有原始日志尾部：加入 Bot 审计／时间线、Hub 审计的结构化阅读与筛选。读取保留轮转文件、稳定翻页，沿用原 timeline 计数；按 App／飞书会话区分显示，日志不改写。损坏、超长和未写完的记录明确提示，脱敏后才搜索和截短；未知 Hub 结果显示信息。手机收起高级筛选与统计，避免首屏被控件占满。

9. App 缺少详细运行看板：新增当前活动、定时任务、协作流程、日／月用量四个分类。旧磁盘运行标记不参与实时计数；crew 状态明确是保存记录。原账本缺失期间保持未知，有效备份回退标明来源，浏览普通概览也不再触发账本修复。沿用原 CronStore 兼容规则、时区及原 Dashboard 的计划计算函数；未创建记录不假造执行历史。

10. 超长回复跳过投递账本：Gateway 显式使用独立正文存储，写正文与更新索引受同一互斥锁保护；读取校验、私有权限、过期孤儿清理和完整备份均有覆盖。`gateway-delivery-recovery` 在真实子进程的最终／后台通知投递前强杀；浏览器 `final-recovery` 验证双端完整内容、10 表格、原公式展示规则及重启不再补发。
11. Hub 的自动重启次数原先永久累积，IPC 错误也可能被误判为进程退出。现按十分钟窗口限制三次自动重试，保留通信异常但仍存活的子进程；只有匹配请求与 PID 的确认才显示“已安排”。托管重启也使用持久化操作回执，重复 HTTP 请求或恢复完整备份不再触发第二次重启。测试 `hub-supervision`、`hub-state-backup`、`diagnostics` 覆盖窗口、通信错误、启动失败、去重与计划退出的事件分类。
12. App 输入框停止按钮原先只中止 active run，遗漏待合并附件；群中首个 Bot 离线会提前中断分发，前序命令查询也可能拖住停止。现与 `/stop`、运行卡共用取消及提示函数，关闭被取消输入的时间线记录，保留 FIFO 队列及其他话题。Hub 认证后的停止操作独立处理、并发分发，继续检查设备有效期、成员及 Bot 归属；部分未确认会明确提示。`hub-server`、`gateway-service` 和原飞书回归覆盖权限、排队与附件；浏览器 `stop` 验证双端同步和本机小于一秒的取消信号。
13. 历史搜索原来始终使用 ESCAPE，导致 trigram 索引无法加速，且与写入共用队列。现保留字面匹配和成员／Bot／日期／附件过滤，使用索引候选及独立只读队列；HTTP 严格检查输入，返回前再次确认设备授权。手机搜索收起侧栏，面板内可改关键词，有加载／空结果／日期错误提示，旧请求不会覆盖新查询或重新打开已关闭搜索。后续补上每页 50 条短摘要的分页，能继续查找超过 100 条的历史；游标按时间／ID 排序并绑定查询与用户，翻页失败保留当前结果。`hub-search`、`hub-server`、浏览器 `search` 覆盖特殊字符、短中文、更新删除、权限、翻页和跨端导航。旧 100 条完整消息接口仅保留兼容。详见 [分页搜索](history-search.md)。
14. Claude 原适配只订阅完整 assistant block：新增真实 partial 订阅与文本／思考增量，完整块去重；拆开的内部控制帧先隐藏，子代理／后台通知仍走原归属。真实 CLI 双端测试已经等到正文流式后再强杀并恢复。
15. 原 Bridge 忽略“引擎确认 ID 等于临时 ID”的绑定，DeepSeek 因而有真实回复却没有 session.json 记录。现确认后照常落盘，重复事件／结果合并，临时旁问不替换主绑定。真实 Harness 重启记忆通过。
16. Harness 0.2 把流式移到单独通道：新增严格解析、重连前缀去重、缺段最终补齐及 Goal／普通轮次隔离。真实流式通过后发现父 Bot 被强杀时 DSH 保留写锁，现加仅作用于自身子进程的父生命周期守卫；修复后真实双端完整恢复通过：同一 session 可继续回答，恢复提示不重复。

17. 真实 MCP 验收发现工具调用和它的审批通知被重复记成两步，完成后还留着假“运行中”。四个原生适配器现保留同一 tool call ID，共享运行面板按 ID 合并，无论审批先到还是工具开始先到；同名并发调用仍独立计数，迟到审批不复活已完成步骤。审批按钮、授权范围和实际执行逻辑不变。

18. Codex 原适配只接命令／文件审批，原生 `requestUserInput` 与 MCP 表单会被当作不支持的请求并打断整轮。现接入共享问答卡，保留问题 ID、枚举原值、数字／布尔／多选类型及字段约束；空字段 MCP 确认必须显式选择“允许本次”，不会自动授权。停止、完成、进程退出和原生已解决通知都关闭对应卡片，迟到回答不作用于新进程。无选项字段可直接填写，有限选项可禁止自定义输入。URL／凭证／OpenAI 扩展表单未声称支持；额外 permissions 由下面的独立审批处理。真实运行与回归证据见验收账本。

19. 共享审批 UI 原先把所有 `scope: session` 显示为“本轮允许”，但 Codex app-server、Claude 持续进程与 Harness 实际可记住整个会话的授权。现由各适配器声明实际范围，卡片、文本回退及已处理收据共同显示“一次／本轮／本会话／后续调用”。一次性 Codex／Antigravity 的批准原本覆盖整轮，现不再显示成单条命令；Kimi 仅展示 ACP 实际提供的选项，持续授权明确不限本轮。无效按钮及文本范围不消耗待审批请求；Kimi 也不再把一次授权回退升级成 `allow_always`。除修正上述越界回退外，Bot 默认模式及已有授权记录保持原语义。

20. Codex 的 `item/permissions/requestApproval` 原先会作为未知请求打断整轮。现完整验证文件／网络权限及约束，展示字面 JSON 后按本轮／本会话回传原始权限；未知约束、超长详情、无归属及自动模式下无法人工审批的请求返回空授权。回调修改不能扩大权限。停止、完成、进程退出、原生已解决通知都使迟到点击失效。原生协议没有普通工具结束事件时，发送决定后关闭对应权限过程行，后续命令保留独立执行状态；显示失败不会重复答复或破坏已授权的轮次。

21. 跨 Bot 委托的停止原先只中断调用方 HTTP 等待，接收方引擎没有收到取消。Bus 服务现将未完成连接断开转成该请求独立的取消信号，经 Gateway 转交共享 Bridge；普通请求读完、正常响应结束及其他并发请求不受影响。显式取消与超时区分，均不自动重试；任务真正结束后才清除忙碌计数。完成恰好遇到取消时保留引擎已上报用量，但时间线标记中断。取消无法撤销已执行工具，不能将客户端停止收据解释成副作用回滚。

22. 客户端重开原先按 IndexedDB 的随机会话 ID 顺序选最后一项，可能从刚才的群组跳到其他话题。现保存本机所选会话；电脑、手机各自恢复，不互相切换页面。没有有效记录时选择最近创建的未归档会话，通知／搜索导航仍可覆盖它，重新配对随本机 Hub 状态一并清除。草稿仍按设备和会话独立保留。


23. App 原先只能使用预先编辑的 Bus 配置，缺少完整操作入口。现为 Hub 托管 Bot 提供协作设置：双向许可状态、并行成员、串联排序、复核 Bot、五角色 Crew 和有界高级参数。保存只修改当前实例的 Bus 子树，保留模型、密钥及未知原生配置字段；沿用共享文件锁，并以版本检查阻止双端覆盖。损坏配置拒绝写入，客户端看不到密钥，吊销或降权后提交前再次鉴权。服务启停通过已有空闲重启流程，连接状态与配置完全生效明确区分；外接实例配置及完整多引擎 Crew 仍待补齐。

24. 协作此前依赖手输内部实例 ID，结果和引用也充斥 ID。新增输入框／命令菜单的协作操作表单，选择发起者、对象及 ask/fan/chain/verify 流程，明确显示配置顺序、成员授权及服务状态。同名名称附 ID 后缀并始终用稳定 ID 路由；配置刷新后撤权或移除的对象不可发送。任务文字沿用本机对话草稿。显示层只标注已知托管实例引用，排除代码、链接、路径、数学节点；消息原文、复制、转发及后端处理保持原始 ID。名称缓存按本机 Hub 身份隔离，断网重开可读，身份清除后不允许迟到写入重新填充。

25. App 的“绑定已有会话”原先每条消息前强制复制绑定，会覆盖后续 `/resume`、`/detach`、`/reset`，且没有保存目标对话自己的旧绑定。现给每次选择分配操作编号，在原会话队列内只应用一次，保存自身的旧绑定供切断恢复；严格持久化收据避免重连／重启复活旧绑定，不导入来源对话的恢复栈。旧版无操作编号且已解除的绑定要求重新选择，损坏／不确定写入不会自动重放。侧栏也调整为 Bot → 私聊、群 → 话题的组织方式，新增明确的切断入口。具体测试与真实引擎证据以验收记录为准。

26. 设备通过请求头鉴权后被吊销，慢请求原先仍可批准新设备或写入上传分片；两个真实 HTTP 用例均先复现成功写入。现于请求体读完、受保护的写入队列入口、配对／吊销事务及私有响应返回前重新校验，传输中的附件下载也会被切断。十个集成用例覆盖过期、降权、自身吊销回执、独立 CLI 吊销及另一可信设备的完整下载。已收到的数据和先前获准的工具副作用不会回滚；其他服务等待窗口与完整安全矩阵仍需独立验收。见 [HTTP 吊销边界](http-revocation.md)。

27. 实时连接也存在鉴权后等待的窗口：已吊销设备的消息和卡片审批原先仍能排队入库，迟到的 Bot RPC 结果也会送达。三个实际连接用例先复现后修复；网络来源的消息／转发、审批、已读及会话／话题操作现于写入事务内校验设备，审批同时重查会话成员。私有实时输出在进入 socket 写入前校验设备，停止操作在发往 Bot 前重查目标；18 个集成用例覆盖同步、快照、另一可信设备、过期以及共享 HTTP 入口。已提交工作不会回滚，已经交给网络的数据无法召回；不等于全部角色／授权变更与服务等待窗口均已验收。见 [实时吊销边界](socket-revocation.md)。

28. 管理操作等待期间吊销设备，原先可能先执行副作用、最后才返回 401。九个真实 HTTP 用例复现了创建 Bot、标注文件、打开 Finder、导出文档与安排重启的等待窗口；现于实际执行前重新验证。拒绝的重启恢复原收据状态，未注册的 Bot 保留惰性准备文件并绑定原始规格；已获准的创建／文档操作仍完成持久化，可信设备重试不会重复交付。18 个用例同时覆盖令牌过期、降权、会话成员移除、队列隔离与可信重试。见 [管理操作授权边界](control-revocation.md)。

29. AskUserQuestion 填写到一半时，切换对话或刷新原先会丢失答案及当前题目。现按消息、原生请求和问题结构保存本机草稿；恢复先读取待发送答案，避免重复提交。问题修改／结束、快照移除及重新配对会清理对应草稿，旧页面的迟到写入不能恢复它们。电脑和手机的未提交草稿各自独立，提交后的权威结果仍双端同步。Chromium、WebKit 各 17 项回归覆盖真实 IndexedDB、原生问答处理链、失败重试、快照和清理；不等于原生手机容器验收。见 [原生问答体验](native-question-experience.md)。

补发沿用 TaroCub 的有界、至少一次语义：pending 原文补发；attempting/failed 显示 ♻️ 并说明可能重复；最多 3 次，超过 24 小时放弃。补发开始前写 attempting；只重放安全的文件投递，移除 cron／建文档等副作用。Gateway 最终回复及后台任务通知超过 200,000 UTF-8 字节时，现改存独立正文文件，账本保留长度与 SHA-256 引用；原平台默认的行内上限不变。真实进程在正文／账本落盘、尚未发布时被 SIGKILL 后，完整长文恢复且输入不重跑；损坏正文记录失败，不发送空回复。保存前的崩溃、关闭账本、磁盘故障、次数／时效／200 行保留上限仍是边界，不能声称任意崩溃均无损或全局 exactly-once。

## 仍需保留的验收边界

- 本轮补齐功能映射和已发现的程序差异，不等于五个真实引擎、全部子命令、后台生命周期和所有手机系统行为都已逐一验收。
- 原计划明确排除飞书 Docs 评论、会议、平台群授权。工具层具备飞书登录时仍可做飞书业务；App 不伪造这些平台事件。
- 长回复账本缺口已补齐，普通最终回复与后台通知的指定窗口真实强杀验证通过；全部恢复异常组合、真实多 peer crew／后台结果、native 运行指标还要继续验收。
- App 当前有健康、累计用量、只读日志、空闲后重启、文件中心，以及审计／时间线的筛选、翻页与事件统计。详细概览新增在线活动、cron／crew 详情及 UTC 日／月用量；当前活动不冒充完整任务追踪，事件细节通过时间线查看。已完成本机合成 5,000 条定时任务和 10,000 文件／2,000 单元的性能验证，包括概览刷新期间的手机停止操作；见 [规模测试](dashboard-scale.md)。真实 Finder、原生容器和实际用户工作区性能仍待验收。不能用“CLI 仍可用”代替 App 的操作验收。
- 所有引擎共同受 adapter 的原生能力限制；原生限制应明确显示，不能把缺失数据显示成成功或零值。
- Windows／iOS／Android 安装包仍待编译验收；通用 macOS 开发包已在 2026-10-03 完成双架构优化编译和本地临时签名，镜像及包内文件校验通过，原生运行仍待验收。真实麦克风中断、推送、12 类以上真实飞书视觉基准及全部性能预算仍未最终通过。
- VPS、真实双线路、Google OAuth、签名／发布依照用户要求后置。全计划保持进行中，详细剩余清单见 implementation-status。
