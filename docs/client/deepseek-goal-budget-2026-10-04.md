# DeepSeek 目标用量与普通聊天隔离（2026-10-04）

最终源码已通过根检查（234 个文件、3774 项通过、1 项跳过及构建）、208 项相关断言、5 项真实原生边界／故障验收，以及 Chromium／WebKit 各 1 项双端目标完成流程。回执与哈希（本地材料：`evidence/deepseek-goal-budget-2026-10-04.json`）。

本轮修复两个相关问题：目标用量原先取整个 session 的 token 增量，误包含同会话普通聊天；预算耗尽后直接调用原生 `goal.pause`，可能中断那时正在执行的普通聊天。

## 实现

- 私有原生插件注册 `tarocubGoalUsage` SessionProjection，按 `goal/change` 的目标 ID 和原生轮次第一条工作输入的 `source.kind=goal`、`goalId`、正整数 `round` 归属记账。普通聊天、无法追溯归属的 `tool-jobs` 轮次及独立子会话不计入；状态说明明确这个范围。
- 累计服务端已上报的 input/output/cache-read/cache-write；reasoning 不重复累加。遵循 dsh-token-meter v2 的同 turn/step 样本替换和 `llm/retry-started` 重试新增规则。暂停/恢复保留计数，新目标清零，旧轮次不能向新目标收费。
- 原生投影框架持久化、重放和恢复计数，适配器只保存目标 ID 和预算。v1 的全 session baseline 不再参与计费，下一次写入采用 v2；无法统计时通过 usageScope=unavailable 明确标记，界面不把协议占位显示成零；无预算目标保留兼容。
- `goal` 与用量分帧到达时，必须匹配同一目标 ID 才评估预算；一次读失败或错位先复读；恢复后继续。预算目标确认无法计量时进入下面的保护流程，无预算目标显示无法统计。创建带预算目标前缺少原生投影，不会先清除已有的无预算目标。空 session 的 `asOfSeq=-1` 初始快照现在也正确接收。
- 预算暂停通过私有 `pause-goal-budget` 调用，以目标 ID/revision 校验，并在原生进程同步检查本轮来源。先通过 `withInitiator` 阻止原生驱动的会话级取消，再仅当当前轮次属于该目标时取消。普通聊天继续执行，目标停止自动续轮。不存在公共 `goal.pause` / `session.cancel` 回退。
- 若私有暂停失败，或一致复读仍无法计量，只对同一目标 CAS 执行 `goal.clear` 以停止自动续轮，并明确返回降级错误。原生历史保留，clear 后不能直接 resume，需重新设置目标；当前轮次可能自然跑完。确认 clear 后同步结束匹配运行卡；确认不了就明确提示未确认。
- 原生完成优先于迟到的预算回执，刷新失败后再读到 complete 也不会误报失败。目标已被替换时不能清除新目标的本地缓存或预算。
- 预算 RPC 不占用流式帧处理队列，避免新主机恢复等待旧暂停时互相等待。

## 原生验证

`client/e2e/live-deepseek-goal-budget.spec.ts` 默认关闭，启用方式：

```sh
TAROCUB_LIVE_DEEPSEEK_GOAL_BUDGET=1 TMPDIR=/tmp/t npx playwright test e2e/live-deepseek-goal-budget.spec.ts
```

真实 dsh 0.2.0-rc.2 流程包含以下场景，最终结果见配套 JSON。测试控制原生 turn-stopping 边界、预算 RPC 派发时点和下列显式故障；真实模型、会话日志、inbox、目标驱动、usage 和产品插件未替换。

1. 预算请求到达时仍为目标轮次：真实原生终态 aborted，目标 paused，适配器显示 budgetLimited。
2. 先排入普通消息，再释放目标边界，等原生普通输入被消费后派发预算暂停：目标与普通轮次均正常 completed，普通故事含结尾标记；session 总用量增加，但目标用量不变。
3. 真正关闭私有 pipe，再派发预算暂停：计数投影保留，公开 CAS clear 停止目标自动续轮，普通故事完整结束。
4. 延迟预算 RPC 时通过原生 API 完成目标，再释放回执：最终显示 complete。
5. 持久化本轮记录后 SIGKILL 本测试拥有的主机，验证托管恢复不死锁、不额外启动目标轮次；崩溃后使用状态查询确认停止。

所有预算场景都独立将原生日志服务端 usage 四个 bucket 之和与投影比较；关闭并重启私有主机后，各自的预算、计数与停止／完成／清除状态保持一致，没有额外轮次。每次仅清理本测试临时 home/workspace，并确认所有拥有的子进程退出。

首次普通聊天样本把英文验收标记 ORDINARY-DONE 拼成 ORRINARY-DONE，实际原生终态 completed、目标用量隔离成立；保留失败记录，改用中文标记复验。第二次暴露测试对原生终态名称写成 done 的错误，按实际原生枚举修正为 completed；未改变产品逻辑以迁就断言。新增整机故障样本的原生恢复终态是 interrupted，已按真实日志修正测试的猜测枚举，并保留初次失败记录。

## 边界

- 这是已上报的原生目标轮次用量，**不是整个目标包含全部子代理/后台任务的账单**。该边界在 App/Lark/Telegram 状态文字中说明。
- 原生引擎在 assistant settlement 时上报 token；预算会在该时点评估，可能超过上限后才停止。它不是逐 token 的硬计费上限。
- 本轮原生验证不是实体手机验收。安装包、生产服务、共享 DeepSeek 配置、模型密钥没有替换或重启；仅本测试拥有的临时主机做故障注入。
- 两轮 Opus 只读审查与处置（本地材料：`evidence/deepseek-goal-budget-opus55-2026-10-04.md`）指出的边界已补测试。浏览器回归及最终根检查结果以配套 JSON 为准。
