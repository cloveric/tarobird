# 引擎、审批、定时任务与会话锁审阅（2026-10-19）

范围：核验 Fable 5 报告的 P1-2、P2-8/9/16/17，以及 Gateway/Core/cron 和引擎适配章节。以当前源码、回归和隔离进程实验为证据；没有操作生产 Bot、读取真实凭据或把脚本测试算成真实模型验收。GitHub Actions 计费问题不在本轮范围。

## 已确认并修复

| 报告项 | 核验与改动 | 证据 |
| --- | --- | --- |
| P1-2 Claude 子代理审批被一律拒绝 | 确认当前同一回合的合法子代理工具审批也被拒绝。现在只在子代理明确属于当前、未中止的回合时交给该回合的审批处理器。旧回合、歧义 ID、已关闭 scope 和子代理 App host capability 继续拒绝；审批等待期间回合失效也不能放行。原报告“没有测试”不准确，原仓库已有旧子代理不能借用新回合审批的回归，本次保留并新增有/无 parent marker 的正例。 | `claude-stream-adapter`；子事件留在 scoped journal，不写进主过程。尚未以真实 Claude 子代理人工审批操作作验收。 |
| P2-8 Codex normal 无 handler 降为 never | 核实为策略一致性问题，原 `never` 配合沙箱并不等于自动越权批准。审批策略现在由显式权限模式决定；normal 始终使用 `on-request`，无人处理的原生审批请求直接 `decline`，不生成不可操作的孤立 `permission_request`。full-auto/bypass 保留用户已有选择。`on-request` 仍遵循 Codex 原生沙箱规则，并非承诺每个工作区命令都弹卡。 | `app-server-adapter` 新增无 handler 时的拒绝回读且不发审批事件；既有 full-auto/bypass、会话恢复和 stop 回归保留。 |
| P2-9 DeepSeek 会话批准过宽 | 确认。缓存键改为工具名与规范化的完整工具输入；相同输入可复用，不同路径/命令必须重新批准。缺失 native call/input 或工具名不一致时只提供允许一次，不提供会话按钮；不把另一工具的输入显示为本次依据。非当前活跃 owner 或原生拒收均不能创建可复用授权。授权键以 SHA-256 存储，每会话最多 128 项，超限淘汰最早一项，后续使用需重新批准。主审补查还确认了等待原生 receipt 期间 Stop 的竞态，已在发送前/receipt 后重检 claim 和 abort，停止后晚到的 accepted 不会留下授权。 | `deepseek-harness-adapter` 覆盖不同输入再询问、相同输入复用、缺失证据与停止后的迟到审批。 |
| P2-16 排队时间耗尽 cron 执行时间 | 确认。共享 App/Feishu cron 执行器同步声明延后计时，并在会话队列真正接纳任务时启动 `timeoutMins`。worker、Gateway 和可选适配器包装透传生命周期，继续共用执行链。 | `cron-scheduler` 的延迟入队回归及 `cron-conversation-context` 的真实 ChatQueue 入队实验；执行超时仍能 abort。 |
| P2-17 停止无法取消等锁 | 确认。FileMutex 可取消进程内与文件锁等待，仅清理自身 ticket，不释放/绕过前任。Bridge 的逻辑会话锁、引擎 session 锁以及 Kimi 启动锁都传入当前回合 signal。 | `file-mutex`：取消后后续任务仍等原持有者；锁文件中他人 ticket 保留。`bridge`、`file-mutex-release`、`instance-lock-admission` 回归。 |
| P2-17 POSIX 活持有者被当作未知 owner | 确认。Linux 记录 `/proc` 原生 start ticks，macOS 记录 `ps` 原生启动时间，并与 boot UUID 一起持久化到 ticket/instance-lock。当前 owner 匹配时不套用未知 owner 的默认 5 分钟界限。旧 boot-only 记录仍保守处理。 | `process-epoch`、`file-mutex` 的快速推进时钟实验。macOS 的 `ps` 起点为秒级，不能称为与 Windows FILETIME 同精度；不可用时仍不会凭年龄抢锁。 |
| P3 停服中止 cron 误记失败 | 确认。调度器停止记 `cron.skipped` / `scheduler_stopped`，不增加 failureCount、不因正常停服禁用周期任务。干净停服时尚未开始的一次性任务保持启用。 | `cron-scheduler` 的停服回归。 |
| P3 一次性任务崩溃后重复 | 确认。真实队列 admission 先原子写执行 claim 并禁用该次计划，写入成功后才可产生副作用；未入队执行及写入中取消不消费任务。重启只恢复确认死亡的 owner，记录“结果未确认”并停止自动重试，不增加 failureCount。CAS 防止重复 scheduler 同时执行；新时间/显式重新启用可重新安排，手动 run 保持会消耗 enabled 一次性任务的旧语义。 | 新增 claim 回归覆盖真实 ChatQueue、并发 scheduler、活/死 owner、写失败、写入中取消、旧 schema 与显式重试；原代码隔离副本先红、修改后通过。后续补充真实 macOS 进程强杀验收，见文末；不代表断电或外部副作用 exactly-once。 |
| P3 裸 `/q` 缺终态 | 确认。用法回复后记录 `command.handled`，恢复逻辑不再把这条命令当成未结束任务。 | `lark-steer` 的终态断言；可选 transport 名称对应旧测试路径，共享实现位于 `core`。 |
| P3 备用 Claude permission hook secret 在 argv | 确认传给 `--mcp-config` 的 JSON 含短期 loopback bearer URL。改成权限 0600 的临时 JSON 文件，argv 仅包含路径，结束后清理。 | `claude-adapter` 检查实际 spawn args 不含 capability URL，并检查临时文件已清理；MCP server/hook 回归。 |
| P3 DeepSeek 私有 Host 只终止根进程 | 确认。停止时先走已有进程树终止器枚举后代再终止根；保留有界强制停止。 | `deepseek-harness-host` 的真实 macOS Node 父/子 fixture，子进程忽略 SIGTERM，Host 停止后子进程也退出。未以真实 DSH 工具树或 Windows 作实机验收。 |
| P3 Kimi 外部项目被启动锁写入 | 确认与文档“外部 workspace 不由 bridge 修改”不一致。锁移到系统临时目录下按 canonical workspace hash 划分的共享路径，保持跨进程互斥，不再为锁创建项目 `.kimi-code/`。 | `kimi-acp-adapter` 外部 workspace 不创建目录的断言；Kimi workspace/hook 回归。 |
| P3 DeepSeek 插件未声明 Node 最低版本 | 确认。子包、lockfile 与中英文 README 统一要求 Node >=20.17.0，与主机最低版本一致，覆盖 getBuiltinModule 所需版本。 | 独立子包 `npm ci` 后 typecheck、29 项测试、check:dist、pack dry-run 全过。没有重新发布包。 |
| P3 文件发送兼容说明矛盾 | 确认文档过于绝对。架构说明明确原生工具优先，仅不具备原生 App 工具的引擎保留能力门控的兼容指令；原生发送成功后禁止再发 marker 造成重复。 | 对照 `gateway/agent-instructions.ts` 的 nativeDelivery 分支；未移除仍被使用的能力回退。 |

## 未直接采用的建议与剩余边界

| 报告项 | 处置依据 |
| --- | --- |
| P3 `/meeting` 缺终态 | 当前共享实现已有 `command.handled`；Gateway 原生替代提示也记录终态。该半项为误报，保留回归，不重复改动。 |
| P3 Antigravity `/goal` prompt 放 argv | 已确认并在恢复审阅后修复。最初未取得 stdin 原生展开证据而暂缓；后续使用现有登录、禁止用户目录写入的隔离工作区，在 AGY 1.4.1 上对照验证 argv 与 text stdin 均原生展开 `/goal` 并成功完成。现改为 `--input-format text` 管道传入完整提示，保留独立 goal worker 和结构化输出，提示/私有上下文/附件不再放 argv。详见后文。 |
| P3 删除 ProcessClaudeAdapter | 生产 engine factory 当前选 stream adapter，但备用 process adapter 与 permission MCP helper 仍由构建配置、独立包验证和专门测试明确维护。仅删源码会破坏现有打包契约。本轮先修 argv secret，不声称已彻底移除；完整移除应同时改构建入口和兼容说明。 |
| P3 缓存 token 跨引擎语义 | 事实成立：各原生 SDK 的输入/cache 指标口径不同。`usage-store` 将 input/output/cache 分别累加，不是把 cache 再加入 input 的直接 bug；旧 dashboard cache ratio 仍有口径风险。对历史数字没有 provider/schema 信息不能无损重写。未伪造统一口径，后续需版本化计量字段与 UI 标签一起处理。 |
| P3 美元预算不能限制所有引擎 | 已有能力边界：Kimi/DeepSeek 文档和 `/usage` 明确“不上报美元成本”。不能从 token 量凭空推导订阅/代理计费。预算只约束已报告的费用，不能作为所有引擎真实账单的硬上限；本轮保留现有模型和提示。 |
| P3 process-tree 无 identity 时不发 SIGKILL | 这是避免 PID 复用误杀的保守行为，不能直接删保护。后代只枚举一次仍是已知限制，本轮修了 DeepSeek 未接入树终止的缺口；强敌对/不断 fork 的后代需要进程组/Job Object 方案，未声称当前 helper 是 OS 级进程沙箱。 |
| P3 Kimi hook 为用户级插件且使用 process.execPath | 官方 observer-hook 的发现面就是引擎 home 插件；使用当前 Node 绝对路径避免 GUI PATH 缺失，启动会原子重写 relay manifest。属于明确实现选择。原生旧 Kimi 进程在主机 Node 被人工删除后的可用性未验证，不能把这等同于 App 每轮运行失败。 |

## 验证与适用面

本次改变位于共享引擎、队列、状态与 Gateway 包装，桌面、手机连接的同一 Host 和 headless CLI 都使用这些实现；无需新增 CLI 命令。没有修改模型推理结果或在 UI 中虚构进度。

局部验证按独立运行记录，数字不可相加作为不重复总数：

- 审批与锁 8 套：443 项通过。
- Gateway/调度/互斥回归：44 项通过。
- 备用 Claude、Kimi、权限 helper、配置安全：183 项通过。
- 可选 transport 的 cron/steer/meeting：36 项通过。
- DeepSeek Host/实际 ChatQueue/Codex：176 项通过；新增真实进程树实验后 Host 27 项通过。
- Kimi 外部 workspace 新断言通过（初次漏测试 import 已修）；该轮其余 123 项通过。
- 主审追加 DeepSeek 晚到 receipt/锁取消回归：138 项通过。
- 实际 Opus 追加三引擎审批复核：372 项通过，含 Codex 无孤立审批事件、DeepSeek 证据不匹配/无输入仅允许一次、缓存淘汰与迟到 receipt，以及 Claude 子代理归属整套回归。
- 一次性 cron 持久化 admission：主回归 9 套 116 项通过；最终 claim/Telegram 执行器/service 回归 3 套 206 项通过；可选 Feishu cron 3 项通过。App 与 legacy 两套 TypeScript 类型检查通过。红测在外置盘的 HEAD 隔离副本运行，未替换共享工作树。
- 主机 `tsc -p tsconfig.app.json --noEmit` 通过。
- DeepSeek 插件完整 verify：typecheck、29 项测试、产物一致性、pack dry-run 通过。首次因子包未安装而误用根依赖导致 check:dist 失败，安装子包自己的锁定依赖后通过；没有提交无关 bundle 重建。

最终全仓构建、全集回归及 Opus 独立复核由主审统一汇总。以上不代表发版、替换已安装 App，或真实五引擎/Windows 设备验收已经完成。

## 恢复审阅后的隔离验收与补修

- 一次性任务已补真实进程强杀实验：在外置盘的独立状态目录启动 Node 子进程，
  通过生产 `CronScheduler` admission 写入 claim，执行一次本地文件副作用后发出就绪信号。
  另一 scheduler 在 owner 存活时不抢占；对 owner 发送 SIGKILL 后，使用全新 store/scheduler
  重启，执行器没有再次调用，副作用文件仍只有一条，状态为“结果未确认”、failureCount 为零。
  再次重启不重复添加恢复记录。这覆盖实际 macOS 进程崩溃，不代表机器断电或外部副作用 exactly-once。
- 同时补了真实跨进程会话锁验收：等待者收到取消后不进入任务，持锁子进程仍存活；
  后续等待者也不能提前进入，只有持锁进程被强杀后才回收旧 ticket 并取得锁。
  Windows 的进程身份、文件句柄语义仍需原生设备验收，未用 Mac 结果替代。
- 确认 `UsageStore.pendingWrites` 的静态 Map 保留已完成的每个账本路径，Bot/实例目录增加时会
  持续保留无用条目。回归先复现失败，再将已完成的队尾按 promise 身份释放；早期写入的清理
  不得删除后来追加的写入，异常路径同样释放。覆盖混合计量/未计量、两个 store 并发、写失败
  后继续记录，账本日/月历史与累计 token/费用均不删除、不改变保留口径。
- AGY 最初在禁外网/凭据读取的探测中停在鉴权门，未将该失败算作原生验收。随后使用 CLI
  自己的现有登录，继续禁止整个用户目录写入，在外置盘独立工作区进行真实对照：AGY 1.4.1
  的 argv `/help` 与 text-stdin `/help` 均返回原生 command_result、零模型回合；argv `/goal`
  与 text-stdin `/goal` 均在原生日志记录 `expanded slash command "goal" (system)`，完成一个
  不调用工具的极小目标并返回原生 `GOAL_COMPLETE` 标记。没有读取/复制凭据，没有修改
  现有配置/会话，原生持久化尝试被 OS 拒绝；结果仅证明本次短目标运行与原生展开，
  不冒充跨版本/持久化恢复验证。
- 据此把 `/goal` 从 argv 改为原生 text stdin，仍保留会话绑定、worker 切换、超时和停止规则。
  先红后绿回归检查提示、私有指令和附件均不在 argv，stdin 只发送一次完整文本。
  修改后的真实 `ProcessAntigravityAdapter` 再次成功完成极小目标，事件只有 session、
  assistant_text、result，无工具事件；其 spawn 参数确认不含目标文本。
- Opus 追加指出一次性任务在 executor 调用 admission 前失败后仍保持 enabled，其他任务的
  refresh 会把已经过期的 targetAt 再次触发。已独立复现并原子记录失败及停用该次计划，
  refresh/restart 不再自动重跑或重复通知；显式重新启用可以重试。停服/排队取消及 admission
  持久化失败仍保持原先未消费语义；版本校验保护用户并发修改后的新计划。
- 同一合同也覆盖 executor 没有请求 admission 却直接返回的情况：明确记录“未执行”，
  不再记成功，且不会由 refresh 自动补跑。admission 的进程身份读取、本 store 排队、跨进程
  文件互斥等待均已接取消信号；已经开始的原子落盘不被半途打断，仍等待完成后安全释放未执行
  claim。新增本 store 持有写入与真实外部进程持锁的取消回归，确认等待立即结束、owner
  保持存活且没有留下 claim。

没有照搬 Opus 建议把 claim 持久化失败也一律消费：未能持久化 admission 的任务保持启用，
但当前 scheduler 按任务 ID 与版本进入“未执行，等待重试”。无关 refresh、维护暂停后恢复
以及存储恢复本身均不会重投递/重发通知；手动运行、显式修改/重新启用或重启 scheduler
才允许再尝试，重启仍遵守原有错过执行时间的规则。失败记录也写不进去时，内存栅栏仍然
生效；用户并发改动形成的新版本不受旧栅栏影响，删除/禁用任务会清理栅栏。
这避免因刷新次数改变重试次数，且不把未执行的任务伪装成已经消费；不是跨重启持久化的
重试策略。真实 Gateway/Core 队列回归覆盖 claim 写失败、失败记录也写失败、连续刷新和
暂停恢复只通知一次，以及手动重试、修改、重新启用、重启与并发改期。

第一轮 `cron-native-crash`、`usage-store` 与相关回归共 9 套 154 项通过；追加 AGY text stdin、
cron preparation failure、取消与 claim 等待重试修复后，最终 11 套定向回归 192 项通过，
独立主机构建通过（374 个模块、无 legacy transport/Feishu SDK 依赖），legacy 全集 57 套
1,231 项通过。旧快照晚返回的刷新
也已先复现再回归，不能误解除新的等待重试栅栏。全仓最终检查由主审统一汇总。
主机共享状态修补同样适用桌面携带的 Hub 和 headless CLI，不引入额外命令。
没有启动第二个 Hub、重启生产服务或发版。
