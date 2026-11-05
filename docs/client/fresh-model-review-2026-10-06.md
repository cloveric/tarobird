# 新 Opus 5.5 xhigh 与新 Astra 独立审查

2026-10-06。两位审查者使用全新的上下文，互相未看对方结论。Opus 实际调用 `claude-opus-5-5 --effort xhigh`，关闭会话持久化，成功返回；Astra 实际调用 `gpt-6-astra`，未继承父对话。主审随后核实调用链并在隔离 Hub + Chromium 上复现三项缺陷。本轮没有修改产品代码或重启现有服务。

本轮建议先补齐操作回执与草稿保护，再调整手机聊天的信息密度。新近完成的设备设置已经有读取乱序保护、写入回执与刷新分离、丢失响应后重读而不重复提交等机制；这些机制还没有一致地覆盖对话管理。

## 已复现的缺陷

### P2：免打扰已写入，但界面显示旧状态及错误

来源：Astra；Opus也指出开关缺少进行中反馈。

位置：[ConversationPanel.tsx:31](../../client/src/ConversationPanel.tsx#L31)、`:35`，以及 [server.ts:788](../../src/hub/server.ts#L788)。

触发：PUT `/api/conversations/mute` 成功后，让 `/api/notifications` 的 GET 返回 503，包括事件触发的刷新。实测 PUT 200、数据库 `muted=1`，UI 开关仍为关闭，并显示刷新错误。

影响：用户无法判断真正的通知状态，可能反复操作。

修复方向：以确认成功的写入更新共享状态；后续读取失败单独提示。对尚未确定的写入结果保留“不确定”的语义，避免简单回滚把已经生效的状态显示为关闭。增加进行中状态与请求序号，避免连点造成乱序覆盖。

证据：mute-reproduction.json（本地材料：`evidence/fresh-review-20261006/mute-reproduction.json`）。

### P2：归档会话仍可重发，留下必然失败的待发送项

来源：Astra。

位置：[App.tsx:333](../../client/src/App.tsx#L333)、`:362`、[MessageActions.tsx:58](../../client/src/MessageActions.tsx#L58)，服务端拒绝位于 [store.ts:179](../../src/hub/store.ts#L179)。

触发：已有消息的会话归档后重新打开，普通输入框已隐藏，但“重新发送消息”仍能点。实测出现 `conversation_archived` 提示和失败待发送记录。

修复方向：普通重发的显示条件和执行函数均检查本会话与父群归档状态；显示“恢复对话后可重新发送”。转发到其他可用会话的动作应单独处理。面向用户的错误文案应翻译为明确的操作说明。

证据：archived-retry-reproduction.json（本地材料：`evidence/fresh-review-20261006/archived-retry-reproduction.json`）。本轮桌面复现通过；手机共用该判断，未另做真机复现。

### P3：名称保存成功后仍提示未保存

来源：Opus。

位置：[ConversationPanel.tsx:18](../../client/src/ConversationPanel.tsx#L18)、`:35`。

触发：输入带尾随空格的名称并保存。服务端保存 trim 后的名称，输入框保留尾随空格；关闭弹窗仍问“放弃尚未保存的对话名称？”。已在隔离环境复现。

修复方向：成功回执确认后按服务端名称更新基线，统一比较规范化后的值，并保留保存期间用户继续输入的新版本。

证据：trimmed-title-reproduction.json（本地材料：`evidence/fresh-review-20261006/trimmed-title-reproduction.json`）。

## 优先改进的体验

| 优先级 | 来源 | 问题与影响 | 建议 |
|---|---|---|---|
| P2 | Astra | App.tsx:207 在切换会话时清空附件、录音文件、引用和预览选项；文字单独恢复。刚拍的照片或录音可能无法重新取得。 | 草稿按会话管理，先支持完整内存草稿；持久化前明确容量与清理策略。至少不能静默丢弃附件。此项已核对代码，未做真机测试。 |
| P2 | Opus | PreferencesPanel.tsx:122、179、257、284：批准/撤销期间锁住返回和设置操作，但没有对应“正在确认/撤销”的提示，弱网下可能持续到 20 秒超时。 | 保留避免重复提交的保护，显示具体操作状态、目标设备和主机；增加可读屏播报。属于源代码确认的反馈缺口，未测原生返回键。 |
| P2 | 两者 | 同名设备只有名称与平台；一次性配对码的结果不确定时，难判断列表里哪台刚获授权。 | 利用已返回的 created_at、last_seen 展示“最近连接”和配对时间；确认框补 ID 短尾；成功后定位返回 deviceId 对应的新设备。不把旧时间叫“在线”。 |
| P2 | Opus | 手机每条消息下方为“···”单独留出一行，降低一屏能阅读的内容量。 | 保留长按和无障碍操作入口，把“···”放到发送者/时间行，保持足够点击区域。需用长消息、连续短消息、引用、文件卡片分别验收。 |
| P2 | Opus | ConversationPanel.tsx:33–35 的快捷命令无提交中锁；每次点击生成不同消息 ID。 | 弱网下核实连点重复入队，随后统一进行中状态与防重复点击。尚未做 CLI 引擎执行复现，不把它报告成已发生的多轮引擎执行。 |
| P3 | Opus | 设备配对三步说明长期展开；部分系统 confirm 和其余 App 对话框风格不一致。 | 配对改为专门入口与逐步页面；统一现有 App 对话框。动效服务于展开、过渡和状态确认，保持克制。 |

## 对原始意见的校正

1. **未采纳“切换主机必然卡死设置页”为当前 bug。** Opus 明确未读父组件。实际 [HostApp.tsx:180](../../client/src/HostApp.tsx#L180) 按 registrationId 保留独立 Workspace；[host-connections.ts:40](../../client/src/host-connections.ts#L40) 复用同一注册记录的连接。普通切换主机不会向同一设置实例替换 connection。暂列未来重构时的防御性风险，未发现当前可达路径。也不能直接去掉 finally 的作用域判断，否则旧请求可能释放新请求的忙碌状态。
2. **不能以“已确认，连接”按钮出现判断配对成功。** [Pairing.tsx:49](../../client/src/Pairing.tsx#L49) 在配对码生成时就展示该按钮。Opus提出的这句状态判断文案不适用。应以真实连接成功、服务器设备记录或新增明确状态查询为依据。
3. **设备时间字段已经存在。** 服务端 [store.ts:71](../../src/hub/store.ts#L71) 已返回 created_at / last_seen；补设备辨識信息无需先扩展接口。
4. **不照搬“失败就回滚免打扰”。** 响应丢失不等于写入失败。应区分确定拒绝、已确认成功、结果不确定三种情况。
5. 手机截图右边的浮动小元素尚未确认属于产品本身，不计为布局缺陷；原生长按与系统选字冲突仍属真机待验证项。

## 验证边界与材料

三个定向复现用例均观察到了现有缺陷；它们不是修复后的回归通过声明。验证用的是隔离 Hub 与 Chromium，没有执行真实 Bot CLI、没有向用户业务会话发送消息，也没有原生 Android/iOS 验收。本轮不宣称整个产品无其他 bug。

- 复现脚本（本地材料：`evidence/fresh-review-20261006/reproduce.playwright.ts`）
- 验证记录及被审源码哈希（本地材料：`evidence/fresh-review-20261006/validation.json`）
- 新 Opus 原始意见（本地材料：`evidence/fresh-review-20261006/opus-fresh-report.md`）（未经过滤，使用时以本报告校正为准）
- 新 Astra 意见摘要（本地材料：`evidence/fresh-review-20261006/astra-fresh-report.md`）
- 手机聊天截图（本地材料：`evidence/fresh-review-20261006/chat-phone.jpg`）
- 手机设备页截图（本地材料：`evidence/fresh-review-20261006/devices-phone.jpg`）

建议下一轮顺序：免打扰回执与重发归档保护 → 完整聊天草稿 → 配对/撤销反馈和设备辨識 → 手机消息布局及设置层级。
