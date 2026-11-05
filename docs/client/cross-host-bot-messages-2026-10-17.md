# 跨主机 Bot 消息 MVP

状态：功能已实现；真实 Mac mini 与 Windows 双向文字、文件和回复验收通过。验收使用物理电脑上的隔离 Hub 与真实 Bot，并非生产安装包升级验收。

**发布边界（2026-10-17）**：App 1.0.83 与 CLI 0.1.431 已打包本功能，使用 schema 17；旧 CLI 0.1.430 包为 schema 16。两端主机与调用方 CLI 都需升级，按[更新流程](../host-cli-update.md)保留身份与数据；不应将旧运行时直接指向新数据库。[本次安装包及验证范围](release-1.0.83-2026-10-17.md)。

## 使用方式

Bot 在 App 主机管理的运行环境中使用下列命令。命令连接已经运行的本机 Hub，执行后退出；不会启动 Hub，也不需要常驻 CLI。

```sh
tarobot conversations list --host "Windows 电脑" --bot "审阅助手" --json

tarobot messages send --to "Windows 电脑/审阅助手" \
  --text-file /absolute/task.txt --file /absolute/report.pdf \
  --request-id UNIQUE_TASK_ID --context-message CURRENT_INPUT_ID --json

# 复制 send 返回的三个 ID；以下是占位符，不是现有主机的 ID。
tarobot messages wait --to "hub_HEX/BOT_ID/CONVERSATION_ID" \
  --message MESSAGE_ID --timeout 120 --out /absolute/replies --json
```

每个新任务用新的 `UNIQUE_TASK_ID`，手动恢复同一次发送时保留原编号。上例的 `CURRENT_INPUT_ID` 来自 Bot 本轮附加提示；不要填写历史消息 ID。普通终端操作员在 **list、send、wait 三条命令上都加** `--source-bot LOCAL_BOT_ID`，不传 `--context-message`。目标主机需要先按下节完成授权。

`--file` 可重复，单次最多 50 个文件，每个最多 512 MiB，并受目标 Hub 的实际上传限额约束。文字文件为 UTF-8，最多 200 KiB。文件先完整上传并验哈希，然后才发布消息。回复文件下载后再次验 SHA-256，输出本地路径；使用独立目录，已有同名文件仅在大小与 SHA-256 一致时复用，其他情况拒绝覆盖。

后续[当日审计修订](day-commit-audit-2026-10-17.md)在发送端按目标公钥协调
请求节奏，并将短探测时限和文件传输时限分开；这不会在断线后自动重发。
回复文件元数据在落盘前校验，长名称截断保留扩展名。接收模型会看到本轮
来源 ID 和层数。App 不把协作任务或其失败回复通过普通“重新发送”转成
用户消息；核对原结果后，由来源 Bot 明确发起新任务。

指定已有对话：`--to "主机/Bot/对话"`。创建新对话：省略第三段并加 `--new-conversation "专项协作"`。名称里含 `/` 时写成 `%2F`，含 `%` 时写成 `%25`。主机、Bot、对话都优先按 ID 匹配，否则要求名称精确且唯一；不使用包含匹配或第一项。失败会返回候选名称和 ID，先 list 再用 ID。Bot 只能看到已授权目标的目录。

没有第三段且没有 `--new-conversation` 时，目标 Hub 为 `(来源主机公钥, 来源 Bot ID, 目标 Bot ID)` 持久化一个独立对话，名称为“来自 来源Bot 的协作”。不使用最近打开的用户对话。改名不会改变绑定。send 回显 `hostId/hostName/botId/botName/conversationId/conversationName/messageId/requestId/duplicate/status`。

MVP 单次回复读取最多 200 条关联消息，超过时返回 `truncated: true`；不把截断结果当作完整记录。过大响应会明确报错，不自动重发。

wait 必须带目标对话及 messageId；它只读取该来源请求对应的目标 Bot 回复（相同对话、Bot 与 `replyTo`），不读取其他历史。交付未确认，或交付已确认但关联回复仍在运行时返回 `pending`；后者附带可选 `activeReplies`。判断包括 `pending/streaming` 消息，以及外壳虽为 `complete`、但 `nativeRun/scopedRun` 仍处于活动阶段的后台过程卡。

交付已确认且已记录回复均已结束时，返回 `completed`；错误回复为 `failed`，交付失败或取消为 `failed/cancelled`。`completed` 表示等待结束，不保证每个子任务成功：子代理失败/中断保留在其卡片和返回文字中。回复读取仍有上述 200 条文本上限，活动计数不受此截断影响。尚未发布或未关联到本次输入的未来后台工作无法据此预测。

达到本地等待时限返回 `timeout`、`deliveryStatus: pending`，并保留已收到的文本和文件；不会重新投递或停止任务。长时间静默本身不是完成依据，等待接口没有新增过期结算规则。原任务继续遵守目标队列和引擎已有的终态/恢复规则。超时后用同一消息 ID 再次执行 wait。状态枚举保持不变，旧 CLI 可继续轮询；新的 `activeReplies` 字段是可选的。

如果 send 的连接中断，结果可能已经提交：保留 stderr 中提前打印的请求编号。调用方明确核对时可以用相同编号、相同目标 ID 和相同内容重新执行 send；目标 Hub 返回原 messageId，不再次排队。禁止自动换编号重发。发生无法确认的错误时，不宣称“发送失败所以未送达”。

## 授权及操作员入口

组网内设备的控制权限不自动赋予 Bot。目标主机默认拒绝跨 Bot 消息。所有者通过已有、本机已登记的 CLI 控制器授予精确的来源主机/来源 Bot → 目标 Bot 权限：

```sh
# 在目标 Hub 所在电脑执行；先从来源主机的 bots list 获取来源 Bot ID。
tarobot messages allow --from "Mac mini/SOURCE_BOT_ID" --bot "审阅助手" --json
tarobot messages revoke --from "Mac mini/SOURCE_BOT_ID" --bot "审阅助手" --json
```

授权/撤销使用当前所有者会话及一次性 Ed25519 操作证明，绑定完整命令摘要；只开放给本机登记控制器。Bot 的 instance 凭证不能管理这些授权。MVP 授权粒度是目标 Bot，包括列出它的对话名称，以及向它的指定对话发送消息；返回内容仍仅限自己的请求及关联回复。授权需由明确的用户协作需求驱动。

操作员在普通终端使用三条命令时额外传 `--source-bot LOCAL_BOT_ID`，代表明确选择的本机 Bot。App 内 Bot 运行时自动携带自己的身份；当前输入消息由临时环境或本轮提示中的 `--context-message` 参数提供，不应伪造来源或申请所有者控制器。未登记的操作员使用现有 `tarobot enroll` 流程，不会静默登记。

## 实现与边界

1. CLI → 本机 Hub：Bot 使用本 Bot 的 `gateway.key` 访问 loopback instance API；操作员用既有本机控制器。检查运行中服务身份，不读取远端 Hub 私钥，不启动第二个 Hub。
2. 本机 Hub：从已签名网络目录按名称/ID定位主机；主机 ID 与 App 一致，为 `hub_` 加 Ed25519 SPKI DER 的 SHA-256。来源主机名/Bot 名由 Hub 查询，来源转发层数从该 Bot 正在执行的输入记录计算。
3. Hub → Hub：先经正常 HTTPS CA/主机名校验，要求对端签署随机挑战，核对预期 Hub 公钥；再发送独立域签名的短期通行证。通行证绑定来源、目标公钥、Bot、对话、HTTP方法/路径、内容摘要、请求编号、nonce、过期时间，签发有效期 60 秒，接收端允许最多 ±30 秒的时钟偏差（过旧或超过这一未来窗口均拒绝），不调整系统时钟。对端回复亦签名。探测可以选择另一条线路；一旦发送有副作用的请求，不切线路重发。
4. 目标 Hub：确认两端仍是同一网络的有效主机、授权仍有效、Bot 未删除、对话成员关系有效。写入及读取返回前重新检查。撤销后的新请求、等待和文件读取均拒绝；已提交的排队任务按既有语义保留。
5. 文件：签名请求走目标 Hub 的 `/api/uploads`、`/api/uploads/:id/:chunk`、`/api/uploads/:id/complete`，复用 `HubAttachments`。上传权限额外绑定来源和目标对话，不能拿其他对话的 attachmentId 投递。回复下载只接受该请求关联回复实际引用的文件。
6. 投递：复用 `HubStore.sendMessage`、`deliveries` 和 `HubPromptQueue`，在同一事务持久化请求摘要、限流、消息、队列和发送审计。相同来源请求编号改变目标或内容时拒绝。按原队列追加，不打断正在执行的任务。
7. Gateway：`botSource` 元数据经过协议解析、标准化和持久化保留；专用分支只进入普通任务队列，跳过问题答案、审批文本、引导、批处理及控制命令入口。Hub 与 Core 双重拒绝斜杠控制命令。旧 Gateway 不声明 `bot-messages.v1` 时不会执行这类输入。
8. 界面：消息显示“来自 主机 · Bot”和层数，tooltip 可核对稳定身份。来源快照与消息一起存储，对话改名不改变请求目标。

每个目标 Hub 对每个来源主机/Bot 最多接收 10 条新消息/分钟，重复请求不消耗新的发送额度；计数落盘，重启不会清零。转发层数上限为 3：普通用户触发的首次委托为 1，由跨 Bot 输入再次委托时递增。超过上限拒绝，不交给模型自行判断。

通行证本身只在传输期间存在；长期身份沿用 Hub 私钥与每个 Bot 的私有 gateway 凭证。凭证文件保持既有私有目录/0600边界；轮换或删除 Bot 后，本机 Hub 重新核对密钥摘要。远端授权存放在目标 Hub 数据库中，可撤销；换主机密钥会改变身份，需要重新授权。正文、文件字节、凭证不进入审计日志；记录发送、等待、拒绝、授权和撤销的身份、编号及结果。

拒绝日志使用既有有限采样与次数汇总，等待轮询仍逐次记账；两者使用有界
流量保留分区，避免大量失败请求或长期轮询挤掉授权、撤销等重要收据。

这不是任意同一 OS 用户代码之间的强隔离：具有整机文件访问权的进程仍属于既有系统信任边界。不能声称环境变量或 0600 文件能抵御同一用户下的恶意进程。文件发送保留既有有效权限检查，默认限制工作区/输出目录；最高权限时可允许外部路径，但凭证形状文件始终拒绝。参见 [安全边界](../security-boundaries.md)。

数据库升级至 schema 17，新增消息来源列；旧列和历史消息保留。旧的 schema 16 运行时不能直接打开升级后的数据库，应遵守现有 update/backup/restore 流程。App 与 CLI 必须来自同一功能修订，旧安装包不会因源代码提交而更新。

## Bot 使用约束

运行时说明位于 `src/gateway/agent-instructions.ts`，适用于共享 Gateway 的引擎。只在用户要求跨 Bot 委托或回复协作请求时使用。默认协作对话；明确指定用户对话才可向该对话发任务。重名时先 list 再使用 ID。遇到未授权、撤销、深度或频率限制时停止，不复制密钥、绕过权限或通过另一身份继续。

本功能不改 Agent Bus。`/ask`、`/fan`、`/chain`、`/verify` 的本机范围保持不变，也不能把这些字符串当作远程控制命令发送。发送给 Bot 的文字是新任务，不是 UI 问题卡片、审批或引导操作。

## 验证记录

基础功能提交：`85104cbd5b6f5f40258a597743be14ada0e7e3b2`；时钟容差和长等待会话修复：`92ed121ed6a5b3f4ef9ca6f077821d1e041f5feb`。最终真机验收固定提交：`f80dfb5ffdf0803d2506f63ddf97aa53b7efee70`（另含验收观察器会话复用修复）。

- 完整本机回归：`npm test -- --maxWorkers=2`，313 个测试文件通过；4,134 项通过、1 项跳过，最终轮用时 257.91 秒。唯一跳过项为仅在 Windows 上执行的已安装 Codex shim 检查；这不是 Windows 全套回归通过的证明。
- Host 构建通过：355 个 standalone 模块，无旧渠道/Feishu SDK 依赖。客户端构建（翻译检查、TypeScript、Vite）通过。
- 新增覆盖：名称唯一/重名/不存在/改名后 ID；默认独立协作对话；队列顺序和旧 worker 门禁；原生问题卡未被误答；控制命令拒绝；未授权、撤销、签名、过期和密钥轮换；层数/频率；断线后只投递一次；超过一整块的文件上传、完整哈希回传；审计；常驻引擎本轮身份参数。
- 真实 HTTPS 套接字测试 3 项通过：既有上传路径、正常 CA 校验、已收到 POST 后断线不切换线路重发。它们在一台 Mac 上运行，不计作两台物理电脑验收。
- `client/e2e/bot-message-source.spec.ts` 通过：桌面和 390×844 手机视口来源标记可见，刷新后保留；截图已检查。这是浏览器 UI 验收，不冒充 Android 真机。
- GitHub Actions 本次 Source checks **未执行**：账号付款失败或额度限制导致 job 未启动，不能写成云端通过。固定最终验收提交的两个 job 均无已执行步骤，见 [本次检查](https://github.com/cloveric/tarobot/actions/runs/38939738420)。

物理验收使用真实 Mac 主机（darwin/arm64）与 Windows 主机（win32/x64），Node 均为 24.14.0。两边运行固定提交的隔离 Hub，采用全新身份/状态目录和真实 Codex sender/receiver，经过既有签名 propose/admit/join 流程组网；未替换生产安装、未迁移现有聊天。两端 sender ID 和 receiver ID 有意相同，用来验证主机身份参与定位。CLI 本身始终只连接已运行的测试 Hub。

| 路径 | 实际结果 | messageId | 文件 SHA-256 |
| --- | --- | --- | --- |
| Mac 同机两 Bot | completed，真实文字及文件往返，verified=true | msg_c6868e88ab6f4b6ea230b121c2348451 | 091d5fbc07a13c47ed8d055ee0fbcc70e59bb9eb7c46bab4bc5f0a390de23373 |
| Mac → Windows（最终提交） | completed，真实文字及文件往返，verified=true | msg_4b6484874a9642e198876abc213b0c6a | add2903434246aa3c28fd21f1d0779a1e3c3157058c5d873ce0b5dd120df1191 |
| Windows → Mac（最终提交） | completed，真实文字及文件往返，verified=true | msg_3523147ecc124033b7b83cd35807438c | 066699813fae5b4b8812d0af2fac14968dc39a3c72bd4b8128fb821c3dc937c7 |

同机验收和首次 Mac → Windows 验收在基础功能提交执行；修复时钟偏差后，两台电脑均更新到最终验收提交，再完成上述双向验收。每次 CLI 都实际执行 list、send、wait；接收 Bot 读取文件、计算哈希并通过 `app_send_file` 返回原文件。最终 Mac → Windows 回传文件为 61 字节，Windows → Mac 为 55 字节，落盘字节已独立核对。

[脱敏验收证据](evidence/cross-host-bot-messages-2026-10-17.json) 使用示例设备名并省略系统补丁版本；保留隔离验收身份、请求/回复 ID、接收次数、交付状态和文件哈希，便于核对关系。这些改动仅作用于文档副本。两端最终请求均只出现一次；来源字段、发送/等待/拒绝审计均已读回。验收结束后两端隔离 Hub 和四个 Bot 已优雅退出，测试监听端口已关闭，正式主机仍在运行；保留测试目录供复核。

可复用的真机准备脚本：`scripts/verify-bot-messages-physical.mjs`；`serve` 要求全新测试目录，`resume` 只接受带专用标记的已有验收目录，拒绝复用生产状态，并有两小时退出上限。这是显式搭建验收环境的操作，三条产品 CLI 不会调用它。

验收中发现 Windows 时钟比 Mac 快约 20 秒，旧通行证检查因此拒绝反向请求。已修正为有界时钟容差，并测试超过容差仍拒绝。此前失败均停在 CLI 启动前或 list 阶段，没有投递目标消息；受控重试保留原请求编号，不属于断线自动重发。未修改任一电脑的系统时间。

### 常驻引擎的本轮身份

Codex 常驻进程不接收每轮临时环境变量。Gateway 因此在附加提示中提供 `--context-message msg_...`，Bot 将其追加到 `messages send`；其他引擎也可使用同一参数。Hub 验证该消息确实属于来源 Bot、仍在下发执行中，再从持久化来源字段计算下一跳。这个 ID 不是通行证，不能替代 Bot 私有凭据。过期轮次或其他 Bot 的消息 ID 会被拒绝。

长时间操作员等待/上传会在下一次操作前更新即将过期的本机控制会话；这不是重发已传输请求，也不会静默登记新控制器。Bot instance 仍逐次检查原有凭据。

## 群内讨论进行中（2026-10-28）

目标群或话题有进行中的讨论（运行、暂停中、已暂停、结束中）时，接收方 Hub 以
`group_discussion_active`（409）拒绝新的跨 Bot 输入，与人工 @ 的规则一致：讨论期间只有
Hub 决定谁发言、看到什么；独立评议第一轮中，对外来输入的回复也不会被封存。拒绝与请求
登记、限流在同一事务中回滚，讨论结束后同一请求按新请求处理；讨论开始前已接受的请求
重放仍返回原回执。普通群聊与单聊不受影响。回归：`hub-bot-messages`（独立评议首轮、
轮流讨论、暂停、结束后重试、普通群与重放）。

## 尚未覆盖与发布边界

- 下述源码与物理主机验收先于发版；App 1.0.83 / CLI 0.1.431 的安装包检查单独记录在[发布说明](release-1.0.83-2026-10-17.md)。已安装产品不会自动更新。
- Windows 完成了相同源代码的构建和真实 Bot/CLI 往返；完整回归在 Mac 上执行，4,134 项通过、1 项 Windows 专用测试跳过，未宣称 Windows 全套回归通过。
- 来源标记完成桌面/手机浏览器视口测试，未作为 Android/iOS 原生设备验收。
- GitHub 云端检查被账号账单/额度问题阻塞；本地通过不能替代云端 job 实际执行。
- Agent Bus 跨主机路由、超过 200 条关联回复的分页以及可配置限流不属于本次 MVP。
