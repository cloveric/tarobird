# Opus 5.5 会话与手机切断审查

实际调用 `claude-opus-5-5 --effort xhigh`；只读、无工具、无持久化会话。模型意见由主代理独立核验，不把审查通过替代真实 CLI 验收。

## 第一轮：发现验收缺口

## 阻断

1. **「手机切断回到群原会话」只在 store 层证明。** 群会话没有自己的独有标记。切断和 reload 后只验证「回复不含 story」，所以如果原生侧其实开了一个全新会话，测试同样会通过。restored 回合后也没有复核 codexSessionId 仍等于 groupSession，`phoneDetachRestoredPreviousGroupSession` 属于过度声明。
   - 修法：群首轮种一个独立标题 B。切断并 reload 后，要求回复答出 B 且不含 story，同时复核会话 id，并断言 bindingId 已清空。

## 未证明边界

- **cleanup 未见越界。** Claude 在启动前先确认项目目录不存在，清理时再按观测到的 sessionId 和 cwd 双重核对。Kimi 的 rm 对 symlink 只删除链接本身。不足之处：
  - Codex 依赖 archiveAcceptanceThreads，但这个函数没有给出，无法核实。
  - DeepSeek 既没有隔离 home，也没有清理。
  - finally 是串行的，任一步抛错就会跳过后面的清理。
  - credentials 软链意味着 token 刷新会写穿到原生账号。
- **Kimi 参数化疑点**（都会显式失败，不会掩盖问题）：
  - trust key 用的是未 realpath 的路径。macOS 临时目录实际在 /private 下，如果 Kimi 按物理 cwd 计算哈希就不会命中，建议两种路径各写一份。
  - `wd_workspace_`+12 位的格式我无法核实。
  - agent.md 在 create() 之后才覆盖，可能和启动时的同步发生竞态。
- **DeepSeek**：`/resume session`、`--version` 和会话列表都不在引擎表里，需要对照 docs 确认。
- **版本记录**：各 `*_EXECUTABLE` 是否就是生产实际启动的二进制，未确认。
- **MEMORY 与人设**：每轮都显式提示读取 MEMORY，人设也来自测试自己写的 agent.md。这只证明了同一 workspace 可读，不证明生产 bot 会自动使用它。引擎自带的记忆功能也被 prompt 压制了，没有覆盖到。
- **Claude 用例**：仍用「临时口令」，负向判定可能因模型拒答而假阳性。目前靠 freshSession≠source 兜底，建议统一改为故事标题。
- **0.160.0 改动**不在所给文件里，无法审查。

## 第二轮：加强断言复核

**结论**：按所给代码，手机切断这条验收链已没有阻断问题。

- **切断前**：记录是 original，轮询到 groupSession 才放行，能区分是否真的切断。
- **reload 后**：提示不含 B，要求答出 B 并排除 A，响应后核对 native id。
- **/resume 与 /reset**：前后 id 都有可区分的断言，并且符合“保留最近选择 + applied 收据只应用一次”的合同。

**证据边界（不阻断）**

1. **尚无运行证据**：四引擎和 Claude 的产物出来之前，只能说用例设计已闭合，不能说验收通过。
2. **reload 范围有限**：这里只是浏览器重载，没有覆盖 Hub/Bot 进程重启后收据仍然生效。这一点只靠 `gateway-session-binding` 单测，本轮没看到它的运行结果。
3. **绑定轮缺 id 断言**：绑定那一轮没断言 native id 为 original，Claude 用例也没核对 source。切断轮询的区分度目前靠“群会话答出 A”这条文本证据，补一行 id 断言就能变成硬证据。
4. **Codex 归档可能空跑**：归档函数的返回值没有被使用，cwd 按 realpath 精确匹配。如果 Codex 记录的是未解析路径（macOS 上 `/var` 与 `/private/var`），会归档 0 条，之后的复查也会空跑通过。Codex 是否规范化 cwd 我没有核实。建议断言归档集合包含 original、groupSession、freshSession 三个 id。
5. **超时预算偏紧**：共 7 轮真实回合，每轮最多 90s，总超时 360s。AGY 或 Kimi 偏慢时出现的超时属于预算问题，不是会话丢失。
6. **原始失败可能被覆盖**：finally 里 hub.close 或归档抛错，会盖掉原来的失败，排查时以 failure json 为准。
7. **JSON 字段是硬编码**：布尔值只表示成功路径走完了。手机是模拟视口，不是真机。Claude 的 `cleanup.json` 依赖未提供的 fixture 实现，我没有核对。

## 独立处理

- 采纳群独有标题 B 和恢复后原生 ID 检查，补齐绑定后的 ID 检查。加强后确实暴露了 DeepSeek `/reset` 回到旧群上下文的生产问题。
- 不采用“切断必须清空 Hub bindingId”：该字段记录最近选择，applied 收据控制只应用一次；真正的原生绑定由 SessionStore 管理。保留元数据是已明确的产品合同。
- DeepSeek 的私有 home 已由 `deepseek-harness-host.ts` 建在 Bot stateDir/dsh-home，并随本轮临时状态清理；首轮审查只看用例而未看到 Host，因此“没有隔离 home”不是现状。Kimi 和 DeepSeek 使用原有凭证引用，token 刷新可能写回账号，不声称账号只读。
- Kimi 的信任记录仅针对自己创建的临时 workspace；当前版本实际运行通过，不为未复现的 realpath 猜测增加额外受信任路径。
- 浏览器 close 用 allSettled；随后必须先关闭 Hub 再清理原生历史和状态。Hub 关闭或原生清理失败时保留文件。
- Codex 归档现在要求包含本轮观测到的原生 ID，防止空清单被误称成功；新增缺项拒绝回归。Claude 仅删除启动前不存在、sessionId 与 cwd 都匹配的专用 fixture 转录。
- 真实验收只从回答正文匹配标记；折叠过程里引用提示词不能代替答案。
- 第三次 UUID 修复审查的 CLI 返回 success，但正文为空，因此不计为有效审查；保留回执并请求结构化复核。

完整实验和最终结论见 [验收记录](native-session-mobile-2026-10-04.md)。

## 第三轮有效复核：UUID 与后台 goal 边界

有条件通过。方向正确：没有绑定时用随机 UUID，已有绑定（包括旧的 telegram-84）原样返回，直接修掉了 DeepSeek 在 /reset 后重开旧上下文的根因。在已展示的代码里，没有看到确定的并发、旧会话恢复或重置回归。但"会话进行中被 /reset 或 /resume，结束时又把旧 id 写回"这一点，必须先确认才能发布。DeepSeek 端到端尚未最终通过，不能算完成。

- 正确性：bound 时原样返回，unbound 时返回 telegram-{chatId}[-topic-N]-uuid，其余四家的 startsWith 判定不受影响。测试覆盖了三种 scope，并且换了一个新的 SessionManager 实例（模拟重启）后确认 id 不同。如果 Lark 中不同 conversationKey 可能映射到同一个 chatId，旧方案会让 DeepSeek 跨会话共用上下文，新方案顺带修掉了这个问题（取决于 chatId 的映射方式，未确认）。
- 同一会话的并发：外层 conversationKey 锁把解析、执行、绑定放在同一个临界区里，第二轮会看到第一轮写入的绑定，不会拿到两个 UUID。唯一的例外是第一轮在发出 session 事件之前、也在返回 result 之前就失败或中止：这时 native 会话成了孤儿，下一轮会新开。旧方案用的是稳定 id，会重新接上。这是失败路径上的轻微行为变化。
- 重置回归风险（重点）：现在 event 和 result 路径会在 id 等于临时 id 或已有 id 时也写绑定。如果 /reset 或 /resume 不拿同一把 conversation 锁，也不先中止进行中的轮次，那么这一轮结束时会把旧 id 重新绑回去，等于撤销了 reset/resume，DeepSeek 又会重开旧上下文。需要确认 /reset 和 /resume 的加锁或中止语义，并补上"轮次进行中执行 reset"的测试。
- 没有外层锁的路径：setThreadGoal 和 watchThreadGoal 直接调用 getOrCreateSession。如果和尚未绑定的聊天轮次同时发生，两边会拿到不同的临时 id，各自新建 thread，最后写入的那个生效。旧方案下两者共用占位 id，可能被内层 sessionId 锁串行化；现在不会了。目前只影响 Codex，DeepSeek 是否走这条路径未知。
- 每轮写入：result 路径的条件是 !== boundSessionIdFromEvent。对已经绑定、又不发 session 事件的引擎，每一轮都会调用 bindSession。bindSession 会把 status 设为 idle，并且只保留 resume 和 suspendedPrevious；如果 upsert 是整条替换，其他字段每轮都可能丢失。
- 测试缺口：缺少 Bridge 层验证 DeepSeek 临时 id 能通过 event 和 result 两条路径持久化的测试；缺少负数群组 chatId、首轮失败未绑定、轮次进行中 reset/resume 的用例。

证据边界：

- 没有看到 diff，不知道 result 和 event 路径改动前的绑定条件，所以无法判断"每轮写入"和"重绑"是不是这次新引入的。
- 没有看到 /reset、/resume、/stop 的实现，无法确认它们是否持有 conversation 锁、是否会先中止进行中的轮次。
- 没有对仓库全局做过检查：是否有代码精确匹配 telegram-${chatId}，或用正则解析 session id（dashboard、status、bus、cron、file-inventory 等）；随机后缀会让这类代码失效。
- 不清楚各个适配器是否按 sessionId 缓存 worker 或文件（例如 claude-instructions-file）；如果是，每个 UUID 都可能留下泄漏。也不清楚 SessionStore.upsert 是合并还是整条替换。
- 实测方面：DeepSeek 的格式提示改过之后还没有复测；Claude 只验证了"空目的绑定后切断"这一种场景，reload、/resume、/reset 都还没覆盖。

## 第四轮：只读工具检查调用链

这一轮改动没有引入死锁或硬阻断。锁的获取顺序始终是 conversation 锁在前、session 锁在后，session 锁只在 bridge.ts:429 获取一次。watch 只在 session 绑定写入（publish）之前持有 conversation 锁。Codex 和 DeepSeek 都先发出 session 事件、再设置 goal。reset/resume/detach 与 Telegram/Lark 主路径用的锁 key 一致。你说的这些行为在代码里都能对上。不过有 1 个中危的取消语义缺陷（早已存在，不是这一轮引入的），建议发布前修掉；另有 1 个低中危的锁 key 不一致和 1 个低危问题。

- [中] goal 停止或结束后，clear 会打到错误的会话。src/lark/commands.ts:2638 和 :2645 调用 clearThreadGoal(goalInput)，而 bridge.ts:717 按“当前绑定”来解析会话。触发一：/goal → /reset 或 /resume thread X → /stop。Codex watch 中止时只是停止监听（app-server-adapter.ts:875），clear 落到空绑定或 X，原线程的 goal 在后台继续自动跑、继续耗 token，事后 /goal clear 也找不到它。触发二：先 /goal A，再直接 /goal B。A 中止后的 clear 可能晚于 B 的 set，结果清掉 B 并结束 B 的 watcher（app-server-adapter.ts:955，DeepSeek 在 :579 同理），取决于时序。最小修法：Bridge.watchThreadGoal 返回已写入绑定的 sessionId，Lark 用这个固定 id 去 clear（clearThreadGoal 增加 sessionIdOverride）；如果 activeRuns 里的槽位已被新的 goal 替换，就跳过这次 clear。
- [低中] src/telegram/delegation-commands.ts:287（/fan 自身那一轮）和 :478（/verify）调用时没有传 conversationKey/messageThreadId。这样锁 id 变成 conversation-scope:telegram:<id>:root，而 message-turn 和 session-commands 用的是 conversation-scope:chat:<id>，两者不同。另外在论坛 topic 内触发时会落到根会话上。触发条件：在 topic 内执行 /fan 或 /verify，同时根会话有 /reset 或首轮在跑。此时会话锁被绕过：reset 之后旧会话可能被 session 事件重新绑定回来；如果还没有绑定，两个 UUID 会互相覆盖。最小修法：turn-lock.ts:16 的默认值改为 getTelegramConversationKey(chatId, messageThreadId)，并在这两处补传 key 和 thread。Lark 的 bus.ts:446 已经补了 key，不受影响。
- [低] bridge.ts:669 在等锁期间不检查 abortSignal。锁释放后，一个已取消的 /goal 仍会建线程、写绑定，并执行 clear+set（app-server-adapter.ts:868-894）。修法：拿到锁后先检查是否已 aborted，是就直接返回。

证据边界：

- 只读静态审查，没有运行测试或构建；全量测试结果以你们最终运行的为准。
- 文件锁放在 os.tmpdir() 下，跨进程能否互斥取决于各进程的 TMPDIR 是否一致。这是原有设计，我没有核查各服务的实际环境。
- 无法确认生产里是否有从未持久化、原生 id 仍为 telegram-<chatId> 的 DeepSeek 旧会话。如果有，升级后这些会话会一次性开新上下文。
- bridge-goal-sessions 的测试都显式传了 conversationKey，没有覆盖不传 key 的调用方。我也没有逐条读 app-server 在同一线程上普通轮和 goal 并行时的全部路径。

## 后续实现与核验

第三轮所缺的 Bridge 事件／返回值持久化测试已在仓库，另补旧标识、无绑定重置、负数聊天、topic 和 Lark key。第四轮实际读取源码 47 轮，无权限拒绝。其三个发现均采纳：

- 后台 goal 在原生 session 事件时发布绑定，正常聊天不等待整个 goal。结束不回写旧绑定；清理固定指向原生 session。替换目标等待上一轮清理完成。
- `/reset`、`/resume`、`/detach` 与建立会话使用同一把会话锁。Telegram 缺省／显式 key 统一，`/fan`、`/verify` 的自身轮次保留 topic 范围。
- 取消检查覆盖等待会话锁、等待旧目标、Codex 初始化及发布 session 后；已取消的目标不会继续创建任务。

定向用例验证旧目标完成不会覆盖 reset/resume，清理不会打到新会话，目标替换不会误清新目标。检查还记录了原有边界：原生确认前失败的首轮不会擅自接回不确定上下文；跨进程文件锁依赖相同 TMPDIR。最终复核和全量结果以本页后续记录及验收回执为准。

## 最后一轮三项修复复核

有条件通过：按所贴代码看，三项修复的逻辑成立，修复本身没有阻断问题。F1 是会话锁的命名范围问题，合并前需确认。

- [需确认/可能阻断] 会话锁 id 不含实例名，锁文件放在全局 os.tmpdir()。Telegram 私聊的 chatId 等于用户 id，同一用户分别私聊两个 bot 时，两边都会算出 chat:<uid>，拿的是同一把锁。复现：A 实例执行一个长轮次时，发给 B 实例的私聊要等 A 结束才会处理。同一个群里有多个 bot 也一样。如果这把锁是本分支新加的，应把实例名并入锁 id。
- [非阻断] Lark 正常完成和 abort 后正常返回这两条路径，在 goalSessionId 缺失时会按当前绑定清理，可能清到 /resume 后的新会话并重新绑定。这与 catch 分支“没有 id 就不清”不一致。app-server 每次都返回 threadId，所以目前只影响旧适配器。
- [测试缺口] Lark 层“固定 id 清理”没有被断言：bridge 测试是手动把 sessionId 传给 clearThreadGoal；Lark 替换测试既不发 session 事件，也不检查 clear 的参数；catch 分支的清理、以及适配器“发布 session 后 abort 就不 set”都没有测试。

边界：

- 只根据所贴片段做静态推理，没有运行测试。没看到 conversationScope、handleAuthorizedMessage、claimLarkRunSlot、Lark /reset 的实现，也没看到 Lark conversationKey 的格式。
- reset/resume 后不回写，只用 Telegram 命令处理器验证过；Lark /reset 是否持有同一把会话锁，需要确认。
- 完成 promise 是按 controller 索引的。如果旧目标已被 abort、还在 clear，而槽位已被普通轮次占用，新的 /goal 就不会等它。是否会这样取决于 claimLarkRunSlot，我没法确认；改成按 conversationKey 索引更稳。
- 适配器只在发布 session 事件后检查一次 abort；从那之后到 set 之前取消，目标仍会被 set，要靠 Lark 事后 clear 兜底（顺序是对的）。
- 没有部署，也没有在真实飞书上验证。

## 最终独立处置

- 会话锁的 Bot 范围担忧成立：加入 SessionStore 文件的规范路径作为 namespace。同一 Bot 的路径别名通过 realpath 对齐，不同 Bot 的同一用户／群 key 不互相阻塞；底层原生 session 锁仍保护显式共享的原生会话。真实两个 SessionManager/Bridge 的并发回归验证另一 Bot 可在首个 Bot 的长轮次未结束时正常回复。
- 正常完成／中断返回不再缺 ID 时按当前绑定清理；优先 session 事件／response.sessionId，再用结构化 goal.threadId，仍未知时跳过清理，避免误清其他会话。catch 中断分支单独有固定 ID 清理断言。
- 目标完成 promise 按 runtime+conversationKey 保存，活动槽位变化也不丢失未完成的清理。
- Lark 完成分支已断言清理的原生 ID；补上取消异常分支及 Codex 发布 session 后取消不得 goal/set 的回归。
- 最后一轮为只读静态意见；这些最终处置由主代理实现和运行验收，没有将其冒称 Opus 执行测试或部署批准。
