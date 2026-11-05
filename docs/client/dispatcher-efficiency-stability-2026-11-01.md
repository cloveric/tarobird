# 幕僚长效率与稳定性审计（2026-11-01）

基线：`1d889cd45472f1094e24596c9f34acab6b254cb0`，即 PR #111 合并后首轮修复。
本轮由主实现和实际 Opus 5.5 独立复查；保留上轮的权限、精确停止目标和
停止证据要求。本次只提交源码，不发版、不替换安装版，不改真实 Host 数据。

## 已复现的 Hub 问题与修复

1. **运行中的正文被反复搬进 JS。** 每两秒 settlement 先读取最多 201 条
   完整回复，再判断输入是否还在执行／等待投递。改为先查状态；仍活动或投递
   pending 时不读取正文摘要。活动检测只需存在性，`COUNT(*)` 改为 `LIMIT 1`。
   SQLite 仍需解析回复 JSON 来读取 run／等待状态，不能称“完全不读正文”。
2. **回复定位绕经同对话的旧历史。** 原查询计划只按 conversation_id 索引，
   再过滤 reply_to 并排序。增加 `messages_bot_replies` 部分索引，限定 Bot 的
   非删除消息，按 conversation_id、reply_to、author_id、created_at、id 定位。
   这是既有列的附加索引，schema 仍为 23，重开旧数据库时补建，不改变消息数据。
3. **201 条之后的失败或未完成 run 被忽略。** 合法第 202 条错误回复曾使工单
   被误结算为“待验收”。停止前检查也用了相同截断。统一改为按时间／ID 分页
   扫描终态回复，每批 32 条；只累计状态、分类和有界首尾摘要，不把全部消息
   拼进内存。错误分类优先级、跨页额度 reset hint、停止前后不同的完成证据均保留。
   同时间戳按 ID 继续翻页。分页仍在同一数据库事务内，确保结算与通知一致；
   不承诺任意大工单的结算耗时恒定。
4. **App 工单轮询携带不用的长正文。** 新增 owner GET
   `/api/bots/:bot/tickets?summary=1`，可叠加 `open=1`。授权和 200 条上限相同，
   只返回列表字段及最后一次 attempt，从 SQL 投影就不返回 request/result/note
   和全量 attempts。CLI、Bot 实例接口、默认 full list 和 show/action 完整合同不变。
   新客户端用 overview schema 丢弃额外字段，也能读取忽略该查询参数的旧 Host。

### 隔离测量

使用独立 SQLite fixture 和真实 HubDispatch，worker registry 是替身，没有运行
真实模型，也没有读写当前安装 Host。基线与修复各一次预热、12 次 sweep：

| 指标 | 基线 | 修复 |
|---|---:|---:|
| 8 个活动工单 sweep 中位数 | 50.8 ms | 25.7 ms |
| 12 次样本 p95（最大样本） | 65.1 ms | 46.9 ms |
| 12 次由 db.all 返回到 JS 的回复正文 | 50,334,240 B | 0 B |
| 查询计划 | 对话历史索引＋临时排序 | reply_to 精确索引，无临时排序 |

每工单有 500 条旧消息和一条 512 KiB 活动回复。计时样本少且环境负载不恒定，
不外推为安装版速度改善比例；确定性收益是减少重复正文 materialization 和旧历史过滤。
两轮测量早于终态分页修复，后续改动没有改变所测的活动 pending 分支。
表中中位数取排序后第 6、7 项的平均值；原始 JSON 的 `p50` 字段取上中位数
（51.5／25.9 ms），原文件保留未覆盖。
首次索引创建另用 100,000 条、每条 1 KiB 文字的独立 Hub SQLite fixture 测得
约 **364 ms**（`index-cost.json`，SQLite 3.52.0）。仅一次本机外置盘测量，数据已热，
不能保证真实大库／冷盘／其他设备的启动耗时；后续打开不会重复创建已有索引。

另用 200 张工单（各 1500 字任务、4000 字结果、一次 attempt）调用真实 list 与
新 overview：JSON 为 **3,375,390 B → 70,390 B**，约减少 **97.9%**。
这是指定数据集的响应体积，不是实机日常流量统计，也不是删除历史。

## Opus 客户端复查

Opus 用生产组件＋最小 Hook／HTTP 替身复现：GET 只有底层 300 秒上限，一次
悬挂请求阻止后续刷新；action POST 同样可使所有按钮锁住数分钟；工单列表
与头像同时轮询同一个 Bot；列表隐藏后仍继续读。替身的 60 秒窗口中，正常列表
16 次、头像 8 次；隐藏列表也有 16 次。未将此模拟数字称为真实后台浏览器流量。

客户端 GET 使用 8 秒请求上限，action／引擎状态重置使用 20 秒上限；等待本身
也可中止，不依赖原生 transport 是否及时确认取消。操作超时仍显示“结果未确认”，
原 requestId 保留给重试，不自动重发。组件卸载后不再写其状态。

可见工单列表每 4 秒发布结果给该 Host／Bot 的共享头像状态；共享状态有 8 秒
有效期，停止发布后头像轮询会自行恢复。读请求带递增代次，旧响应不能覆盖已发布
的新结果。列表隐藏时停止发起新读取，回到可见时立即读取；所有轮询使用 overview。
头像原有的隐藏检测保留；离开列表后，其有效期加轮询周期可能约 16 秒才恢复读取。

## 验证与边界

- `efficiency-red.log`：旧逻辑重复返回正文和缺 reply_to 索引，2 项负向失败。
- `long-reply-red.log`：第 202 条失败误判完成，1 项负向失败。
- `overview-red.log`：摘要请求仍携带完整正文，1 项负向失败。
- `host-final-regression.log`：Hub 效率／账本／鉴权／Gateway 4 套 **47/47** 通过；
  覆盖分页错误、同时间戳、quota/auth 优先级、末尾 reset hint、停止前后 partial run、
  旧库补索引、摘要列与旧 Host 响应兼容、HTTP 完整读取和设备撤销。
- `cli-regression.log`：owner 与 Bot 身份 CLI **2/2** 通过，明确断言 list 仍保留
  原始 request 和 attempts。`build-host.log`：Host 构建通过，standalone graph 484 模块。
- Opus 复核后补充未知分类优先级保护、首段摘要填满后停止重复拼接，并把索引
  计划回归改为真实首页／后续页 SQL。`host-opus-followup.log` **36/36** 通过；
  最终 Host 构建 `build-host-final.log` 通过。这 36 项与上述 47 项重叠。
- `client-signal-regression.log`：头像合并逻辑 **3/3** 通过。
- `client-build.log`：翻译检查、客户端 TypeScript 和 Vite 构建通过；保留已有大 chunk
  和静态／动态混合导入警告，没有更改构建阈值压掉警告。
- `root-browser-regression.log`：生产构建＋独立 Hub 的 Chromium **3/3** 通过，覆盖
  桌面、iOS／Android 尺寸下的工单面板、操作、隐藏 worker 与头像状态。
  首次启动目录配置不正确后主动中止（`root-browser-setup-aborted.log`），不计通过。
- `e2e-fix.log`：新增 Chromium 专项 **4/4** 通过：共享／恢复轮询、头像超时与
  迟到响应、列表／操作超时及原 requestId 重试、隐藏／返回可见。
  最初两个浏览器用例未考虑配对后自动打开幕僚长，已修正测试前置并保留首次失败；
  没有为迁就测试修改共享轮询行为。
- `root-webkit-regression.log`：主实现独立验证 WebKit 的列表／操作超时与原编号
  重试 **1/1** 通过。浏览器用例运行真实生产构建和独立 Hub，但挂起 HTTP 与
  visibility 属性／事件是受控模拟，不是实体设备后台冻结或原生 IPC 验收。
- Opus 的旧版浏览器对照 `e2e-baseline.log` 四项均失败于所针对的行为。
  最初状态断言会被后续刷新掩盖，去掉代次保护的 mutant 仍能通过
  （`e2e-mutant.log`）。随后改为 MutationObserver 记录每次状态变化：
  `e2e-out-mutant-2/*/error-context.md` 明确捕获回退到 `working`，修复版同一用例
  单独复跑通过（Opus 工具输出／`opus-fix-review.md`，该次通过未另存独立日志）。
- `e2e-existing.log`：Opus 的创建、工单面板及隐藏 worker 会话 **5/5** 通过，其中
  三项与主实现的尺寸回归重叠。`probes/probe-run-fix.log` 组件替身 **8/8** 通过，
  含底层不 settle 时的超时边界；不计为真实原生 transport 结果。
- 上述先后回归有重叠，不能相加为独立覆盖数。最终复审记录为 `opus-fix-review.md`；
  主实现另外验证 WebKit、首次索引成本与新的 47 项 Hub 回归，不把 Opus 较早读到的
  44 项数字或未测索引成本推广到整合结果。

Opus 对 worker 并发换代、停止 RPC 持久意图及重启重试作了代码审阅，未确认
新增缺陷；没有把只读分析当作真实进程重启验收。退出顺序及跨重新挂载的 resume
请求编号仍属未复现风险，没有凭推测修改控制逻辑。上轮报告列明的真实五引擎、
原生安装版、实体手机、卡片续跑／DeepSeek goal 传递等缺口不被本轮覆盖。

证据目录：`/Volumes/gdrive/taro-tmp.noindex/dispatcher-efficiency-20261101/`；
原始探针和 Opus 报告保留在该目录。生产回归保留在仓库，临时测量不是产品代码。

复审中还保留了停止恢复的组件探针：重启 Hub 后只有新 Gateway 的 `stopped:false`，
没有旧执行已终止的证据时，工单继续等待并占槽。这与上轮明确的安全边界一致；
探针没有真实旧引擎进程，不能证明它已经退出。本轮没有用重启／RPC 应答推断
执行结束。将来需要可信的执行代次终止协议来改善此恢复路径。
`bot-messages.ts` 的通用等待接口还存在相似的正文 201 条截断；本轮只读记录，
未复现或修改，不能将工单结算的修复泛称为全部 Bot 消息接口已修复。
