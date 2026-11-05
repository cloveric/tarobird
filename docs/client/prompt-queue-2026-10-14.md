# 待执行消息队列

## 所管理的内容

这项功能管理 **TaroBot 主机尚未下发给 Bot 的普通消息**。用户可以调整下一轮消息的顺序、修改文字或取消其中一条。它不是对 CLI 内部队列的镜像，也不改变正在执行的任务、后台任务、子代理或审批回答。

消息列表保持发送时间顺序；输入区域附近的“待执行”入口单独显示执行顺序。编辑不占用当前输入草稿，不移动历史气泡；附件和引用保留。取消不删除原消息，也不代表停止当前任务。

新版队列将每次发送视为独立请求。同一次提交的文字与附件保持完整；用户随后另发的 prompt 不再隐式并入上一条附件请求。旧 worker 的连续附件合并逻辑保留兼容覆盖。这里的“下一条”指本对话的下一条普通消息，定时任务、Bot 协作等仍遵循既有 worker 调度规则。

只有目标主机和 worker 明确支持 `prompt-queue.v1` 时才显示操作。新版 Hub 配旧版 worker、未知引擎、群聊及话题子对话均不冒充支持。已经下发的条目锁定；下发并不等于 CLI 已开始执行，故界面不把它标成“正在运行”。

## CLI 能力核对

2026-10-14 对本机安装版本进行只读核查，未发起真实模型任务。

| 引擎 | 本机版本 | 核实到的原生能力 | 本功能的实现边界 |
| --- | --- | --- | --- |
| Codex | 0.162.1 | 实验 app-server 协议有 queue add/list/update/delete/reorder/start；普通协议没有这些接口，终端 `queue` 只追加 | 由 Hub 保存尚未下发的普通消息，不启用实验原生队列 |
| Claude Code | 2.1.296 | 本机帮助未提供可寻址的队列重排、编辑、删除接口；当前 adapter 每 session 只允许一个执行中的 turn | 主机逐条下发；不显示“引导当前任务” |
| Antigravity | 1.3.5 | stream-json 逐行 turn，当前接入没有队列编辑、重排接口 | 主机逐条下发；不显示“引导当前任务” |
| Kimi Code | 2.1.1 | 当前 ACP schema 提供 prompt/cancel，没有队列重排或编辑接口 | 主机逐条下发；不显示“引导当前任务” |
| DeepSeek Harness | 0.2.0-rc.2 | prompt 支持 queue/steer；updateQueue 支持文本编辑、移除、转 steer，没有 reorder action | 不接管原生队列；只调整主机尚未下发的消息 |

“引导当前任务”仍使用独立的原生接入，由 `/steer` 的 `supported` 结果决定是否显示。现有 adapter 中仅 Codex、DeepSeek 提供该能力；不能用主机待执行队列模拟引导成功。

证据来源为本机 `--version`/`--help`、Codex `app-server generate-ts` 的实验与普通输出对比、已安装 DSH 的 `QueueAction`/`SessionPromptRequest`/`SessionUpdateQueueRequest` 类型，以及项目各 adapter 的实际入口。以上是所核版本和接入路径的能力判断，不声称所有未来版本都相同。

## 数据与并发

队列权威位于 Bot 所属的 Hub，同一对话中的一条普通消息完成交接前，后续普通消息留在持久化队列中。所有移动、编辑、取消和下发都进入数据库事务；客户端提交所见版本，过期版本返回冲突，不悄悄覆盖另一台设备的操作。

每次修改有独立请求编号。响应丢失时核对同一编号及相同参数；不能生成新编号重试未知结果。队列编辑不进入客户端离线发件箱。手机、电脑、headless CLI 共用已认证 API、对话成员权限及事务内设备有效性检查。

已下发状态持久保存，重连或重启不能把它恢复成可编辑。worker 的既有持久回执仍负责恢复已下发消息，避免重复执行。旧数据中无法确认是否下发的消息按已下发处理。命令仍沿用既有控制入口和顺序屏障，不把 `/stop` 困在普通消息后面，也不允许通过编辑把普通消息换成命令。

发送控制命令时，它之前的普通消息可能随屏障一起交给 worker，随后就不能在这里编辑或移动。输入栏的停止按钮不等同于取消整个队列；取消某一条也不会停止当前任务。以 `/Users/...`、`/tmp/...` 开头的文件路径仍按普通文字处理。

Bot 等待问题回答时，应在问题卡片中提交答案；审批同样使用其专用入口。这些交互直接送到正在等待的任务，不经过普通消息队列。在聊天输入框另外发送的普通文字是下一条任务，不会被猜成问题的答案。支持引导的引擎还可通过明确的“补充当前任务”入口继续当前任务。

派发按 Bot 分别串行，某个 Bot 的慢连接不会阻塞其他 Bot；确认回执也不等待下一次派发。数据库读写或发送异常后，通过重连和持久回执恢复已下发消息，不把未知执行结果重置成未执行。删除未下发消息会取消其 delivery；转发已取消的消息会去掉源消息的取消状态，以新消息自身的派发结果为准。

新增持久状态使用 Hub schema 15。旧运行时不能打开新数据库；发布必须经过备份、兼容检查和正式升级流程，不能把源码直接注入正在运行的生产主机。

## Headless CLI

`tarobot queue list|move|edit|cancel` 使用同一 Hub API，详见 [主机 CLI](../host-cli.md)。它不直接打开另一份可写数据库、不启动新的模型会话，也不引入第二套队列。所有操作仍限定在显式选择的主机、Bot 和对话内，不改变大组网归属。

## 验证记录

通过实际 `claude-opus-5-5 --effort xhigh` 进行设计讨论，并另开无历史会话审查当前源码。设计讨论中采纳了移动位置反馈、下一条预览、手机全屏、完整文本展开、编辑草稿隔离和取消不升级为停止等建议。结合现有结构，继续以 Hub 数据库为队列权威，保持历史气泡的发送顺序，不新增会改变停止语义的暂停/编辑租约。

复查修正了编辑并发覆盖：编辑开始时保存看到的队列版本，后台刷新不能自动替换该版本。另一台设备修改后，第一次保存返回冲突并保留文字，用户核对最新条目后才能再次保存。编辑内容只取文字块，避免把附件文件名重复写进 prompt。

界面采用桌面侧栏、手机全屏；手机支持上下移动，桌面额外支持拖动到队尾。长文本按实际溢出提供展开，不按字符数量猜测。错误提示区分版本冲突、消息已下发、控制命令屏障、权限和能力不支持；只有真正的版本冲突才允许核对后重新提交草稿。请求取消与超时采用兼容 iOS 15 的 `AbortController`，不依赖新版本 `AbortSignal.any/timeout`。

最后复查还修正了横屏键盘仅剩 220px 时的高度冲突：该场景改用单层滚动和完整覆盖的固定标题背景，输入框与保存按钮可分别滚动触达并实际保存。操作编号复用安全随机字节，不依赖 `crypto.randomUUID`。取消状态保留旧客户端的卡片回退，但从复制、全文索引和引用用的正文中排除。

Opus 的静态复核提出“离线 Bot 有待执行消息时被移出群聊，会形成重连循环”的假设。补充完整代码及真实 HTTP 测试后确认，既有 `updateGroup` 会在事务内以 `group_bot_busy` 拒绝这种移除；该保护继续保留。额外补了旧数据中失效成员关系的结算、claim 后权限变化防御，以及跨成功握手保留的指数退避（最高 15 秒，成功交接后重置）。公开撤回接口也经真实 worker RPC 核对：只能撤回 Bot 自己的回复，不能删除用户输入，因此未将假设中的用户撤回当成已发生回归。

将完整证据交给 Opus 再次独立核验后，它撤回了上述 P1 判断，未在这些补丁中发现新的风暴、丢输入或误撤回问题。其补充的“稳定连接不应清空尚未结算的持久化失败退避”也已修正并添加回归；`requireBot` 的实际判断与失效成员关系清理条件一致。Opus 的意见属于源码静态复核，测试由本轮实际运行完成。

验证覆盖实际派发顺序、编辑后的真实内容、附件/引用保留、取消不执行、已下发不可改、版本冲突、断线同编号核对、主机重启、旧 worker 能力门控、设备撤销，以及桌面/手机的阅读与草稿稳定性。

- 主机正式构建通过；全量根测试为 270 个文件、3556 项通过、1 项跳过。最后一处退避条件修正另通过队列与 Gateway 定向回归，并重新构建。
- 后端重点回归 6 组、158 项通过，包括慢连接、派发与持久化故障、关闭/收尾、有效 Claude 问题表单和停止后的下一条任务。
- Headless CLI 15 项通过，其中包含实际本地控制器认证、真实 Hub API 和 `runHostCli` 入口的编辑操作。
- Chromium、WebKit 的队列及引导完整流程各 2 项通过；额外删除 `AbortSignal.any` 后的 WebKit 2 项通过。最终还覆盖删除 `crypto.randomUUID` 后的操作，以及 220px 横屏键盘下实际保存与标题遮罩。翻译校验、客户端 TypeScript 和生产构建通过。
- 既有停止、输入区高度和消息滚动相关回归通过；手机触控专用用例在不支持该手势的环境按原规则跳过。

测试使用隔离 Hub、真实 Gateway/transport 及受控引擎回调；没有让五种真实模型执行付费任务。浏览器中的手机视口和键盘模拟不能代替 vivo、iPhone 或 Windows 原生安装验收。本次是源码改动，尚未构建发布或安装新的 App/独立 CLI 包，也没有打开或迁移生产主机数据库。

## 2026-10-15 再审计

针对 `9bae7cf` 的队列功能，在 `b71ed64` 基础上与实际
`claude-opus-5-5 --effort xhigh` 再次独立审阅。Opus 的意见是静态检查，
故障注入和回归由本轮实际执行，两者不混为真机验收。

确认并修正两处前端问题：

1. 每两秒轮询会取消上一条尚未完成的读取。读取需要三秒时，队列入口始终
   不出现。现在轮询不取消进行中的读取，手动刷新重新读取最新状态；读取期间
   收到缓存变化则结束后补读一次，普通轮询不累计补读。保留十秒请求超时、
   切换作用域和提交修改时的取消保护，以及旧响应不能覆盖新结果的版本检查。
2. 刷新中提交移动等修改，会取消读取，却可能留下“正在刷新”的状态，遮住
   已成功保存的反馈。取消读取进入修改或切换作用域时，现在同步清除加载状态。

新增浏览器故障注入分别复现以上问题；第二项还检查迟到的读取不能还原已保存
的顺序。补充未确认操作在对话 X → Y → X 之间的隔离与保留，以及转发插入
已有队列、前后移动后的顺序和位置唯一性。

Opus 第二轮复核提出，手动刷新不能仅加入点击前已生成快照的旧读取；据此
调整为显式刷新重新请求，并补上“服务端已生成旧快照、响应尚未返回时修改
队列再刷新”的回归，确认显示新内容且旧响应到达后不回退。

第三轮局部复核还提示原生 IPC 可能延迟响应取消。新增独立的请求等待边界：
即使底层 Promise 不结束，读取／引导能力查询仍在超时后退出并允许重读；
修改请求超时则保留原操作编号，等待核对，不自动重发。测试注入永不结束的
Promise、取消后的迟到成功／失败，确认不会恢复旧结果或产生未处理拒绝。
同时捕获读取所属作用域，避免旧作用域回写；缓存版本未变化时不额外补读。

对 Opus 提出的条件性风险，源码补查结果如下：

- `App.tsx` 原本已按主机公钥、对话、Bot 给队列组件设 `key`；正常断线重连
  复用连接对象。保留按连接对象隔离草稿和未确认操作，避免不同注册身份混用。
- 普通发送与转发的两处 `INSERT INTO deliveries` 原本均分配队尾位置，
  无需另做一次数据库迁移。
- Gateway 的普通消息 listener 等待共享 handler，释放 admission 不代表 ack。
  五种 adapter 的发送入口等待其 turn 结果；DeepSeek 的 admission 返回后仍
  等待 `pending.promise`。既有 adapter 协议测试与受控 Gateway 测试均纳入全量
  回归，但这不等于五种真实 CLI 与模型的联合实测。
- 编辑仍保留整队列 revision 检查：无关条目发生变化也可能要求再次核对。
  这是已有的保守并发策略，本轮没有加入自动重新提交，也没有放松另一设备
  修改同一条内容时的冲突保护。

CLI 影响：本轮产品修复限于 App 读取及反馈状态，桌面与手机共享修复；
`queue list/move/edit/cancel`、Hub API、派发和组网身份不变，无需新增 CLI 命令。

验证结果：主机正式构建和完整检查通过，273 个测试文件、3588 项通过、
1 项按原规则跳过；客户端翻译校验、TypeScript、生产构建通过；Chromium
队列、引导当前任务、停止和输入区布局共 11 项通过。

本轮 WebKit 在 `browserContext.newPage` 创建空白页时超时，未进入产品页面；
独立的空白页探针也复现，因此记录为环境阻塞，不沿用上轮通过结果。
源码审计与浏览器模拟不能代替手机或桌面原生安装验收，本轮不发布安装包。

## 2026-10-15 取消确认与迟到请求审计

继续审计队列功能，在 `c9bca85` 基础上确认两处取消交互问题。先用未修复的
生产构建复现，两项桌面浏览器回归均失败，再修复并验证桌面与手机视口：

1. 打开取消确认后，另一台设备修改同一条任务，轮询会刷新正文，却也让取消
   使用最新队列版本。用户先前打开的确认可以直接取消新内容。现在取消确认
   固定打开时的 revision；队列改变后，主机拒绝旧确认并提示核对，须重新
   打开确认才可取消。与编辑及 CLI 显式 `--revision` 使用同一并发规则。
2. 打开取消确认后，任务已经交给 Bot，旧确认按钮仍可点击。主机原有派发
   保护能阻止取消，但界面有误导。确认区域现在同时检查当前状态、条目权限
   和取消能力，已下发或失去权限的任务不再显示取消确认。
3. 主机已保存修改、响应丢失后，再次核对如果返回 401 等前置错误，原先会
   清除待确认操作。认证失败只能说明本次没能核对，不能否定第一次已经保存。
   现在重试仅在成功回执或主机查询历史回执之后的明确业务拒绝时结束待确认
   状态；认证、权限、路由、请求格式等前置错误仍保留原编号和完整请求。
   浏览器注入“已提交但响应丢失 → 核对返回 401 → 再次核对成功”，确认三次
   POST 内容完全相同，结果只生效一次。该回归修复前同样实际失败。

与实际 `claude-opus-5-5 --effort xhigh` 独立审计后，还确认并处理以下问题：

4. 队列 revision 是状态哈希：改序后再恢复原序，哈希会恢复。一条已被拒绝
   的请求如果稍后再到达，原先可能重新执行。新增真实 Hub 回归先复现返回
   200 并意外取消任务，再修复：在同一事务中保留明确的业务拒绝记录，事务
   提交后才向调用方返回错误；同编号重试返回原拒绝结果。新增检查覆盖重启
   后拒绝仍有效、改用同编号但不同内容被拒绝。只在业务数据写入之前记录
   拒绝；写入故障仍抛异常回滚整笔事务，不能提交部分修改。
5. Worker 暂不支持队列时，关闭面板会藏掉待确认操作入口。现在有编辑草稿
   或未确认操作仍能打开面板，修改按钮继续受能力限制，旧成功回执仍可核对。
   浏览器回归覆盖能力变化期间切换对话再返回，原请求编号和内容保持不变。
6. 部分 WebView 没有 Clipboard API，原复制按钮会同步抛错而不提示。现在
   同步与异步错误统一提示，编辑文字保持可选中；桌面与手机视口均模拟验证。

“核对操作结果”更名为“重试并核对结果”，中英文同步；这是用同编号重试，
不是只读查询。若原请求未提交且版本仍匹配，点击会执行原操作。对未知结果
仍不提供本地强行解锁，以免迟到请求和新操作并发；独立的服务端作废协议
不在此修复中引入。

Opus 的条件性意见经过源码和测试核实：

- 已派发消息的删除已有 `saveMessage` 保护；Worker 重连原本就更新能力记录，
  正常直接对话只能有一个 Bot，没有新增绕过派发边界的入口。
- 新增真实 Hub + Gateway + 共享消息 handler 的 `/stop` 回归：中断活动回调，
  前置排队消息各执行一次、每条输入都有结算，之后的新消息正常推进；模型回调
  受控，不等于实际 CLI 或付费模型验收。
- 整队 revision 的保守冲突检查保留；无关条目变化可能要求重新核对。归档
  仍是收纳操作，继续执行已提交任务；恢复对话后管理队列，不暗中改变其含义。
- `activity` 实际为 working/pending/idle 三态，不随每个 token 更新。
  `HubConnection` 按身份创建、正常重连复用，组件另按主机/对话/Bot 设 key。
  text block 只有类型和文本两个字段；正常用户输入是文字在前、附件在后。
  上传文件名禁止路径分隔符，CLI 的 UTF-8 TextDecoder 默认去 BOM，未对这些
  条件性猜测增加无用修改。

CLI 影响：主机拒绝记录由 App 和 CLI 共享；明确拒绝后须以新请求编号提交
修订，已更新 CLI 文档。成功回执格式保持原样，拒绝记录复用现有表的带标记
值；旧主机遇到该记录会按编号冲突拒绝，不能重新执行。不增加 CLI 命令，
不更改 schema/protocol 版本、五种引擎派发、主机身份或组网边界。

验证：主机正式构建、客户端翻译校验/TypeScript/生产构建通过；队列/CLI/
请求等待专项 62 项通过，全量 274 个文件、3607 项通过、1 项按原规则跳过；
Chromium 队列、引导、停止共 12 项通过。模拟手机视口和故障注入不能替代
真机安装与真实 CLI 模型联测，本轮没有发布或安装新的 App/CLI 包。

第二轮实际 Opus 5.5 xhigh 对最终两个产品文件作局部复核，返回“未发现确定
回归”，确认拒绝记录只在业务写入前提交、成功/拒绝重放与前端错误分类一致。
它提醒核实 CLI 是否沿用旧编号自动换 revision 重试；已核对 `runQueueCommand`
没有该行为，默认每次新操作生成新编号，显式编号用于原请求核对，文档同步说明。

## 2026-10-16 取消确认区样式

取消确认区由一行说明和两个无明显边界的文字操作，改为有独立底色与边框的
紧凑确认区。标题和影响说明分开；左侧“保留”为描边次按钮，右侧“确认取消
排队”为当前主题的主按钮。桌面按钮高 32px，手机触控目标保持 44px；颜色、
圆角和键盘焦点沿用现有主题，包含 CLI 的方角与黑白按钮。

本次只调整客户端呈现和按钮排列，使用原有取消与保留回调、禁用条件及版本
检查。没有新增主机能力，headless CLI 的队列接口与命令不需要变化。

翻译检查、客户端类型检查与生产构建通过。既有取消版本冲突、派发后关闭
确认区的桌面/手机回归，在 Chromium 与 WebKit 中各 4 项通过。隔离 Hub 的
实页截图覆盖 1360、390、320px 宽度、默认白青与 CLI 主题、深浅色共 12 种
组合，人工检查了桌面深浅色、手机默认主题及窄屏 CLI；各宽度均验证“保留”
只关闭确认区而不改动队列。产物位于外置盘
`/Volumes/gdrive/taro-tmp/tarobot-queue-confirm-20261016`。

这属于源码与浏览器验证，尚未打包、发布或安装新版原生客户端。


## Pending editor newline shortcut (2026-10-20)

The queue editor supports Option/Alt+Enter at the current selection, using the
same native line-break insertion approach as the chat composer. Plain Enter and
Shift+Enter retain normal textarea behavior. Newlines never save or dispatch the
queued prompt; the explicit Save changes button remains the submission action.
IME confirmation keys are left to the input method. Native insertion retains
undo where supported; a DOM selection fallback updates the existing queue edit
draft when native insertion is unavailable. The chat composer draft, message
attachments, queue order, revision conflicts and dispatch fences are unchanged.
CLI impact: none; this is a client keyboard handler, with no API or queue changes.

Eleven isolated keyboard-handler sanity cases passed and the proposed browser
test file passed TypeScript syntax parsing. These are not browser or native
acceptance results. The four added Playwright cases cover Mac/Windows keyboard
profiles in ordinary chat and ADHD, selection replacement, undo, IME guards,
native insertion fallback, draft retention and explicit saving.

The change is merged on main. The 2026-10-22 three-day audit reran all four
Alt+Enter browser cases successfully in Chromium, plus the queue backend and
client build. The original draft checkout restriction no longer describes this
checkout. This does not update the installed App or establish native Windows/
physical-phone acceptance; see the three-day audit for current verification.

## Phone drag handles (2026-10-23)

The initial phone pending-message implementation exposed the same grip as desktop. Drag the
grip to preview an insertion line; release to save one move through the existing
queue API. Touch and pen work regardless of screen width, including wide phone
landscape layouts. The grip has a touch-sized target. Up/Down buttons remain an
alternative for precise moves and keyboard/screen-reader access. Message text
and card space retain ordinary native scrolling.

Holding a grip without moving does not scroll or change the queue. Once dragging,
approaching the list edge scrolls it at a frame-rate-independent speed. When a
landscape keyboard makes the dialog the scroll surface, dragging scrolls that
dialog and respects its sticky header. The source card stays in place until the
host confirms the move; an insertion line previews the destination. Control
commands and non-movable messages remain barriers.

The gesture retains its starting queue revision. Revision/capability changes,
closing, navigation, loss of pointer capture, pointer cancellation, a second
pointer, Escape, loss of focus and viewport changes cancel the drag. Release
outside the list does not save. The host still checks permissions, dispatch
state, revision and the same request-ID receipt rules; pending receipt recovery
is unchanged. No move is sent per pointer movement or auto-scroll frame.

CLI impact: presentation/input only. The existing headless `queue move` command
and authenticated Host API already expose this capability, so neither changes.
The current task, steering, queued-message contents, attachments, references and
main composer draft remain independent of queue reordering.

Validation: client translations, TypeScript and production build pass; 64 Host,
CLI and request-lifetime tests pass. Browser coverage includes 14 existing queue
journeys per engine, plus four new drag journeys per engine (Chromium and
WebKit). The new journeys cover 390/320-width phone layouts, persistence and
draft retention, one save per release, cancellation/revision races, normal body
scrolling, long-list edge scrolling, command barriers and landscape keyboard
scroll ownership. Chromium uses browser-driven touch input; WebKit uses trusted
mouse input through the phone pointer path because its automation transport has
no touch-move driver. Landscape keyboard signals are simulated. Screenshots were
inspected for phone grip alignment and the landscape scroll surface.

Evidence: `/Volumes/gdrive/taro-tmp/phone-queue-drag-20261023`.
This is source/browser verification, not physical iPhone/Android acceptance;
the installed App has not been updated by this change.

## Animated queue reordering (2026-10-23)

This supersedes the insertion-line-only preview above. Desktop mouse, phone
touch and pen now use the same handle gesture. The grabbed card follows the
pointer without a position transition; adjacent cards make room and the released
card settles into its slot with ADHD's short 200ms easing. A faint placeholder
marks the destination. Different text lengths, references and attachments can
produce different card heights; destinations are computed from those actual
heights, not equal-sized slots. Up/Down buttons use the same placement animation.

Hit testing uses fixed layout positions so animated neighbours cannot oscillate
under a stationary finger. Drag frames update transforms without React renders
or Host writes. Equivalent transforms are normalized so untouched cards do not
acquire empty animations/compositor layers. Holding a handle without moving does
not reorder or auto-scroll.
An interrupted return animation can be picked up again at its visible position;
neighbours finish returning even when that new gesture has no insertion target.
Both the App's animation switch and live system reduced-motion preference skip
the tweens while keeping sorting functional. Platform sizing is unchanged.

Release sends one existing revision-checked move. A slow save keeps the preview
in place until the authoritative snapshot arrives. Normal saving displays the
existing status line rather than prematurely inserting an uncertain-result
alert that shifts the list. An existing error remains until the next operation
has a result, so removing it cannot discard a held preview during another save.
Errors restore the known order; an unknown result
retains its request-ID recovery controls, and a later authoritative poll animates
the confirmed order. If a connection loss aborts a new save after an earlier
rejection, recovery shows the new operation as unconfirmed rather than retaining
the previous rejection's copy; the same request ID/body remains available for
receipt checking. Snapshot positions are captured before React changes DOM
order or inserts an error surface, with current animation progress included when
rendering resumes. Rollback and the error surface share one layout commit rather
than moving the origin underneath a return animation. Scroll
anchoring is suppressed on the actual list/dialog scroll owner during movement.

Revision/capability changes, resizing, keyboard/rotation geometry changes,
expanded row geometry and the existing gesture cancellation paths cannot commit
stale positions. The existing permission, control-command barrier, dispatch and
receipt rules remain Host-owned. CLI impact: presentation/input only; the same
headless `queue move` command and authenticated API remain unchanged.

Validation includes 13 drag journeys in each of Chromium and WebKit, plus the
14 existing queue journeys in each engine. Coverage includes variable heights,
desktop and phone preview geometry, delayed saves, rejected/unknown saves,
later polling, retrying after an error, offline receipt recovery, continuous
pickup, native scrolling, keyboard scroll ownership,
draft retention, one write per release and both motion preferences. Client
translations, TypeScript and production build pass. Desktop/phone preview
screenshots were inspected. Chromium touch is browser-driven; WebKit uses
trusted mouse events through the phone path, and keyboard geometry is simulated.
These checks do not establish physical iPhone/Android or installed App acceptance.

Evidence: `/Volumes/gdrive/taro-tmp/queue-drag-motion-20261023`.

## 2026-10-26: quiet queue editor focus

The pending-message editor no longer paints the outer focus shadow in
Monochrome and Porcelain palettes. Its existing focus border and caret remain;
this is scoped to the queue editor, with no changes to dimensions, typing,
drafts, save/cancel, attachments or references. It is App styling only; Host
queue semantics and headless CLI commands are unchanged. Not yet packaged or
installed as an App update.

Client translation/type/build and Host build passed. Existing Chromium and
WebKit queue tests passed 3 each: ordinary/ADHD editor selection, newline and
explicit save, plus long-list scrolling and retained drafts. The focused editor
was visually checked in the WebKit screenshot; no native-device claim is made.


## 2026-10-26: compact phone page introduction

Superseded on phones by the quiet-header follow-up below.

The full-screen phone queue page places its existing refresh control beside the
help text, instead of reserving a separate mostly empty refresh row. The header
bottom margin is reduced locally. Desktop presentation uses `display: contents`
for the new neutral wrapper and retains the previous layout. Refresh keeps its
44px phone target; pending reads, saves, offline notices and feedback still use
the same persistent status region on a separate line when it has content.

A 390px production-component browser fixture places the list at 104px from the
page top, previously about 135px, excluding unchanged native safe areas.
320px/390px, Chinese/English, light/dark and offline checks showed no horizontal
overflow or status/list overlap. CLI not applicable: this is App layout only;
queue operations, receipts, ordering, drafts and attachments are unchanged.

Validation: client translation/type/build passed; existing Chromium queue suite
16/16, WebKit queue/drag checks 6/6, Chromium touch drag/landscape checks 2/2.
The existing keyboard-module static/dynamic-import build warning remains.
Browser evidence is not physical-device or installed-App acceptance. No version
bump, package publication, installation or Host restart is included.


## 2026-10-26: quiet phone queue header

The phone no longer shows the explanatory sentence or the “message moved to
position N” receipt above the list. Refresh now shares the title bar, retaining
its accessible name and 44px target. CreationDialog accepts an optional header
action; existing callers without it retain their layout.

Reorder progress and success still update the persistent live region for screen
readers, but reserve no visible row on phones. Offline state, operation errors,
uncertain receipts, explicit refresh, edit/cancel results and copy confirmation
remain visible. Desktop instructions and status presentation are unchanged.
This supersedes the previous phone help-plus-refresh row. Queue requests,
receipts, canonical order, attachments and drafts are unchanged; CLI impact is
not applicable because the change is App presentation only.

Client translation/type/build passes. Focused Chromium and WebKit coverage
checks phone touch/pointer reordering at 320/390px, unchanged list position after
a move, landscape keyboard scrolling, refresh races, editing, cancellation and
uncertain receipts. These are isolated-Hub browser checks, not physical-device
acceptance. No release, installation or production Host operation is included.
