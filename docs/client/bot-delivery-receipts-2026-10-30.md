# Bot 协作补充与 CLI 投递回执

2026-10-30；源码基线 `6172b6d56c8c661287242ae4e86c549adb67bc7d`。

## 现场结论

用户截图的 15:40「未投递的补充」对应持久记录中的
`outcome=rejected, reason=stale`。它由精确轮次的 `steer send` 发起，
没有 Bot 普通消息的来源标记，也没有进入普通队列。
旧轮次结束后拒绝补充是预期隔离保护；不能把它改成自动寻找新轮次注入。
额外只读核对确认：前两条已采纳补充与失败补充确实复用了同一个 targetId；
距离最近一次成功补充约 299.637 秒。没有获取到每个原生阶段的完整计时，
不将这段间隔当作网络延迟。

约 53.729 秒后，同一协作对话收到持久队列的普通 Bot 消息，已有完成回复。
因此截图不能证明后续审计任务丢失；本次没有重投历史任务或复跑审计。
生产数据只读，精确记录和时间差保存在本地 `historical-receipts.json`、`target-reuse.json`、`opus-findings.md`。

确认的程序缺陷是 CLI 的返回信号：Hub 的 HTTP 200 表示结构化回执已保存，
可能包含拒绝或不确定状态；旧 CLI 无条件以退出码 0 结束，容易让自动化调用者
把“请求成功返回”误认为“补充成功投递”。真实 CLI/Hub/Gateway 的基线测试
在 stale、not-ready 和 unknown 三类情况均复现了错误的成功退出。

## 修改与约束

- `steer send`、`send-now`、`cancel` 保留原 JSON stdout，已知拒绝或不确定结果
  使用非零退出码，并在 stderr 解释下一步。状态查询成功仍退出 0。
- 核对同一发送请求时，优先采用已经持久化的模型接收、未采纳、撤回或不确定证据；
  不把早先的 accepted 当作永久成功。退出 0 只证明当前回执的接收状态，不证明任务完成。
- Host 给五种引擎的共用协作说明明确要求常规任务、报告、后续补充走
  `messages send/wait`。接收 Bot 忙碌时也进入持久队列，不能用精确轮次 steering 替代。
- 已知未投递后，发送方先判断内容是否仍有效，再明确发送新的普通消息。
  unknown/pending 不授权重发；绑定变化需先核对会话。
- 不修改 Hub/Gateway 的权限、队列、幂等编号、轮次隔离或线上数据。
  不自动获取新 token、不自动 fallback、不重放旧补充。

CLI 是本次直接修改的入口。手机、桌面和 Bot 共用 Host 中的原始回执，协议和
UI 布局不变；五种引擎收到同一常规协作路由指引。

## 验证

- 修改前：3 项定向实证测试失败，均是预期退出 1、实际退出 0。
- 修改后：11 个测试文件、189 项不同测试通过（首轮 187 项，新增 2 项控制检查后重跑对应 25 项）。包括新加的 11 项实际 CLI/Hub/Gateway
  检查，以及 steering/native-input、Bot messages/transport、权限和提示契约回归。
- 新测试真正启动独立 CLI 子进程，确认退出 1、stdout 仍可解析为完整 JSON，
  stderr 明确未投递。重查同一回执不再次调用模型适配器，也不生成排队任务。
- 已接收之后再收到 applied/absorbed/dropped、native received/unknown/cancelled
  等证据的回执核对均覆盖。模型使用隔离适配器，不声称真实服务故障复现。
- Host TypeScript/standalone 构建通过。首次提示契约测试发现超出 1,600 字符预算，
  已缩短新增指引并通过原预算，不放宽测试阈值。

Opus 5.5 已独立复核并同意当前最小修复：核心队列与轮次隔离未发现需要修复的新问题，
退出码、JSON 兼容和不确定结果的处理方向正确。它另外在最终工作树实测 59 项通过
（与上述测试有重叠）；中间检查的 gateway-service 指令预算等也通过。
采纳其文案建议：stale 的恢复提示区分人类用户的新消息与 Bot 协作 CLI，
避免让操作员误以为可直接用不带来源身份的 messages send。
本次不扩大为自动重投，也不改生产审计字段或权限语义。本次仅源码修复，不发版、不更新安装版，
不重启生产 Host；没有实体手机验收声明。

本地证据目录：`/Volumes/gdrive/taro-tmp.noindex/bot-delivery-20261030/`。
主要文件：`before.log`、`regression.log`、`controls-final.log`、`final-cli.log`、`build-final.log`、`historical-receipts.json`、`target-reuse.json`、`opus-findings.md`。
