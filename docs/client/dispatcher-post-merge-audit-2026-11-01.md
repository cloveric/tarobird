# 幕僚长 PR #111 合并后审阅（2026-11-01）

PR #111 已合并为 `b899b65610e7cc92a21c98e502e362c01a44f833`。
本次由主实现和 Claude Opus 5.5 独立复查，针对确认的问题补回归及修复。
只提交源码，不发版，不替换安装版，不修改真实 Host 数据或模型配置。

## 确认并修复

| 问题 | 根因与修复 |
| --- | --- |
| 暂停／取消后输入仍会执行；停止 RPC 失败也释放槽位 | 原实现只关闭账本 attempt。未下发输入改为同事务取消；已下发输入持久记录 `stopRequested`，按精确 input message ID 停止并重试，保留槽位直到终态 delivery 且无活动回复。 |
| 停止等待拖慢界面、重连又重放输入 | API 返回已保存的停止意图，不等待 RPC 超时。重连只阻止重放，不伪造“已停止”回执；普通 claim 不修改已下发输入。停止中的 UI 和头像仍表示活动。 |
| 结果恰好先于暂停完成，被重新排队 | 已接受的完整结果在暂停时保留为待验收；明确的 done run 也保留 completed outcome。取消仍按主人意图取消，结果摘录保留。不会唤醒 planner 覆盖暂停／取消意图。 |
| 成功完成撞上暂停时，仍保留旧引擎冷却状态 | 在停止意图前已确认完成、以及停止意图后有明确 done run 的两条成功分支，同正常完成一样清理旧健康标记；不对不确定的停止清理。两条负向回归确认后修复。 |
| 撤销设备后请求仍写入，最后却返回 401 | 设置、工单操作、派单、引擎状态重置及 worker 准备，在事务内复核 session／设备；Bot 凭据也在写入前复核。缓存回执同样先验权限。 |
| 无效派单或重试回执仍启动 worker | 幂等回执、工单状态、允许列表、健康、effort、并发上限先预检；新写入事务仍复检。回执重放不准备新 worker。 |
| 删除幕僚长的竞态留下常驻 worker | worker 注册和归属关系同事务写入；删除父 Bot 后再查询并删除关联 worker。创建时复核父 Bot 存在。 |
| 删除执行 Bot 后该引擎永久不可用 | 下一次创建使用确定的新代次，重复请求复用同一替代 worker；旧 Bot、会话和历史保留。 |
| 删除幕僚长后工单永远“进行中” | 结算不再尝试唤醒已删除的 planner；有停止／删除终态证据后收尾。 |
| 普通审批设置被隐藏 worker 的默认完全访问替代 | worker 继承幕僚长权限。跨引擎不可等价的自动模式保守转为普通审批；权限变化仅在 worker 空闲时替换，活动输入／卡片动作／回复存在时拒绝新派单并提示忙碌。 |
| 隐藏 worker 等回答／审批，主列表仍只显示运行 | `attempt.waitingFor` 驱动注意状态和去重提醒，用户从工单打开执行会话处理；仍保留并发槽位，恢复后清除等待标记。 |
| 早期 64 张长期工单挡住后续结算 | 按 `(status,id)` 索引轮转每批 64 张，避免固定前排饥饿。 |
| 新完成历史挤掉旧的未完工单 | 仍限制 200 条，但未结束工单优先，不宣称实现了全量历史搜索。 |
| 保存设置暗中扩大可用 CLI 范围 | 不再把显式允许列表与当前安装目录取交集；缺失 CLI 保留并显示，全部勾选也保留显式范围。是否允许以后安装的 CLI 改为单独的明确选择。 |
| CLI 目录读取失败导致设置页空白 | 显示错误与重试入口；仍可修改其他设置，原允许列表保留，重试目录不会覆盖草稿。 |
| 内部执行会话出现无法使用的新建入口 | 依据 dispatchWorkers 身份隐藏“新建独立对话”，普通 Bot 的入口保留。 |
| 离线 Claude 会话输入框上方出现多余的 0 | `online` 是数字，条件渲染把 0 当成文字；改为布尔判断。主实现从手机截图发现后补浏览器负向回归，原构建明确读到 `" 0"`。 |

持久引擎会话不保证收到每轮 `TAROBOT_MESSAGE_ID`。Opus 已复现原指引使实际 CLI 写入返回 `dispatch_context_not_active`；修复在本轮幕僚长指引中直接写明消息 ID，要求每个工单写命令显式携带 `--context-message`；也保留 Cross-Bot context line。经过真实 Hub／Gateway 和脚本引擎的回归同时证明：无上下文被拒绝、正确本轮上下文能创建工单。这不是调用真实模型的验收。

## 验证口径

证据位于本机 `/Volumes/gdrive/taro-tmp.noindex/pr111-review-20261101/`。
负向复现包括 `stop-red.log`、`bounds-red.log`、`deletion-red.log`、
`replay-red.log`、`replay-receipt-red.log`、`opus-boundaries-red.log`，以及
Opus 在合并提交快照上的 `opus/probes.log`、`probe-orphan.log`、
`probe-worker-delete.log`。探针明确标注断言的是旧缺陷行为，不把其“通过”说成修复通过。

- Opus 合并提交基线：13 个文件、671 项通过；只属于原始快照。
- 主实现最终生命周期回归：6 个文件、104 项通过，涵盖 Hub、Gateway、事务鉴权、worker 管理、队列及头像状态；其中 Gateway 使用脚本引擎。
- Opus 另在中间冻结快照复跑 96 项，并通过真实 Hub/Gateway 加脚本引擎复现停止边界，主实现再复现并修正 F1、B3。
- 主实现独立复跑设置、CLI 和上下文回归：3 个文件、7 项通过（`settings-context-cli-final.log`）。
- Opus 对较新冻结树再次独立运行 14 个缺陷探针，逐条核对实际值：撤销后的写入、删除竞态、worker 重建、无效派单预检、重放、普通 claim 和暂停前完成均已符合修复预期（`opus/auth-probes-current.log`、`opus/probes-handoff/README.md`）。探针保留旧缺陷断言，因此日志里的 11 个失败不能直接当作产品回归失败；剩余保守停止等待见下文限制。
- 最终 Host 构建通过：484 个模块（`build-host-final-context.log`，包含最终上下文改动）。
- Opus 最终补充回归：6 文件、61 项通过（`opus/round3-green-unit.log`），与前述测试存在重叠。
- 客户端翻译键、类型检查及 Vite 构建通过（`opus/round3-green-build.log`）。主实现比对了快照与待提交树的 13 个已修改生产文件，字节全部相同（`integrated-build-inputs.json`）。这轮 Chromium 32 项中 31 通过，群聊创建用例未及时看到回复；同一用例单独在修复与原合并提交各重跑一次均通过，保留首次失败及复跑日志，不据此改无关模块。主实现另跑 WebKit 9/9 通过。随后截图复查发现裸 0，再单独修复／构建，最终回归见下条。
- 最后一个布尔显示修复：负向 `zero-red-verified.log` 明确失败于收到 `" 0"`；`zero-setup-aborted.log` 是路径写入失败后中止的无效预备运行，不计入负向证据。最终客户端构建通过（`build-client-final.log`），Chromium 与 WebKit 各 4 项通过（`zero-green-*.log`）；测试覆盖桌面、iOS／Android 尺寸及消除裸 0。
- 最后的健康状态补丁：`health-red.log` 2 项负向失败，修复后的 Hub 账本、鉴权及 Gateway 3 套 37 项通过（`health-final-regression.log`）。最后 Host 构建见 `build-host-final-health.log`。
- 扩大 Gateway 回归首次出现 8 项失败。收窄到相关 6 个套件后，在修复树及未修改的合并提交 `b899b65` 都得到 130 通过、1 超时；同为 `gateway-discussion-voice-reuse` 的 5 秒测试超时（`opus/gw6-worktree.log`、`opus/gw6-b899b65.log`）。未据此修改语音模块，也不宣称扩大回归全绿。
- Opus 在 `snap7` 上扩大到 216 个套件、4 个并行 worker：209 套通过、7 套失败，3254 项通过、14 项失败、1 项跳过（`opus/round3-regression.log`）。其中 13 项为 5 秒超时；另一个 `host-cli-asr` 失败是快照缺少 `dist/src/index.js`。主实现使用已完成最终 Host 构建的工作树复跑该项通过（`asr-built-final.log`）。此快照早于最后的裸 0 与健康状态补丁，不将扩大回归当作这两项最终验证。
- 同时运行扩大回归期间，收窄 Gateway 测试也曾出现 `gateway-async-questions` 超时；在 `snap7` 和原合并提交各单独复跑均为 48/48 通过（`opus/async-questions-snap7.log`、`opus/async-questions-snap.log`）。
- 扩大回归中的 7 个失败套件随后分别在 `snap7` 与原合并提交收窄复跑，两棵树均为 6 套／107 项通过，另 1 套／1 项失败仍是未构建的 ASR 入口（`opus/fail7-snap7.log`、`opus/fail7-snap.log`）。此前超时的语音复用也在这次通过。记录与负载／时序波动相符，但有限复跑不能保证以后不再波动；保留首次失败，不宣称 216 套全绿，不改变超时或无关生产代码。

以上测试相互有重叠，不能相加为独立覆盖总数。合并提交在 GitHub 的
source、desktop-native、gitleaks 检查通过；本次修复提交的 CI 另行核对。

## 明确保留的边界

- 没有运行真实五引擎的完整工单，也没有安装版或实体手机验收。真实 Codex
  CLI 的 schema 检查只证明该版本接受 per-turn model／effort 字段，不证明端到端执行。
- `ask` 是先在对话中征求确认的 planner 指引，不是 Hub 强制的逐工单审批令牌；
  工具权限是独立的引擎审批层，不能混称为同一种保障。
- 无法取得停止证据时保持等待，不声称已停。即使重连重放已被拦下、当前 Gateway 回答“不在运行”，也不足以证明旧执行进程已停；这类输入仍占并发槽。本补丁不新增“放弃等待”；
  主人可通过既有管理／CLI 删除受管 worker，保留其历史。
- 既有卡片续跑、DeepSeek `/goal`、侧会话的 model／effort／工单 workspace
  传递缺口未在本轮扩展 Core 修复。尤其卡片新轮次可能使用幕僚长根目录；
  不能把普通消息工单的通过结果推广到这些路径。
- 内部 worker 从普通 Bot／对话列表隐藏；运维、升级提示和文件诊断接口仍可列出，
  这有助于恢复故障，不宣称“所有管理接口都不可见”。
- 停止前的 accepted＋完整无错误回复可以确认已完成；停止意图之后 accepted 也可能只是取消回执，因此仍要求明确 done run。复审建议没有机械地统一成较弱判定。
- 错误 model 是否会被真实 CLI 归类为引擎故障，只是待验证假设，未据此修改全局错误分类。
- #110 已约定的期限、模型规则表、附件转交、登录预检、历史清理等后续范围不变。
