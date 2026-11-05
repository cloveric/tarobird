# macOS 系统通知权限与点击导航

2026-10-11。本轮补上 macOS 原生通知实现，以及系统点击与多主机界面的衔接。
这份报告区分原生源码／Apple 对象测试、浏览器回归、安装包核验和真实 OS 操作；
没有把前三类结果当作系统通知实收、实际点击或手机锁屏推送的验收。

## 实现

`client/src-tauri/src/notifications/` 使用 Apple `UNUserNotificationCenter`。
原生 delegate 在 Tauri Builder 前安装，并由进程强引用持有；默认点击显示窗口，
仅有效的 hostId／conversationId／messageId 导航。关闭通知或未知 action 不导航，
所有回调都会完成系统 completion。点击早于 WebView 就绪时，在原生端保留最新一条
点击；多条通知仍分别保留在系统通知中心，这个单槽只约束尚未消费的导航意图。

前端先监听再读取点击，通过随机回执 ID 比较并确认消费。事件只用来唤醒读取，
不携带第二份导航数据。旧 ACK 不会消费新点击；未知主机提示错误，不能猜另一台主机；
主机尚在准备、connection 尚未建立且无明确错误，或配对页面遮住对话时，保留点击。
接收页面确认接受或明确拒绝后才 ACK。这里的接受是页面取得导航命令，不宣称消息已滚动到位。

实测修复了普通深链被迟到通知覆盖，以及初始化期间新的 OS 点击被旧 suppression
吞掉。点击年龄由 Rust `Instant` 在 IPC 序列化时计算；前端用 `performance.now()`
记录请求起止和用户操作时间，从往返区间判断先后，避免系统墙钟调整影响。
只有整个区间都早于用户操作才丢弃；不确定时最多连续三次新读取，仍不确定则保留
pending 等后续唤醒，不误 ACK。明确 IPC 错误最多八次读取，退避且可随页面退出取消。
输入、页面就绪及停止函数由同一个 ListenerScope 同步拥有；未决原生注册不阻止 DOM 清理。

macOS 开启通知读取真实系统授权状态；只有用户明确开启时申请权限。普通消息发送
只查询权限，不自动弹出授权框。权限拒绝不会写入 Hub 已开启状态，也不退回旧插件的
桌面权限结果。发送回执表示系统接受了请求，不是横幅显示或用户已读证明。

通知标识包含主机和独立提交 ID。移除主机／清理本地身份时取消对应在途发送，并先清
pending、后清 delivered。晚到的 OS completion 仍检查取消标记，只清理自己的唯一
请求，不会删掉重新配对后的新通知。在途记录有数量上限并回收已完成的弱引用。
没有 .app bundle 的开发进程不初始化系统通知中心；本地身份清理仍可成功，权限和发送
报告原生通知不可用。Windows 继续原有显示路径，点击入口仍待实现。

## 审查与验证

实际 Opus 5.5 xhigh 完成一次独立静态审查，成功回执和模型标识均保存在
审查处置（本地材料：`evidence/desktop-notifications-20261011/review-disposition.md`）及同目录 JSON。
Astra 多轮只读审查发现初始化窗口、新点击误消费与清理问题，最后复核单调钟协议
和同步释放逻辑。Opus 审阅的是较早快照，不是对最终每一字节的批准；Astra 最后
也仅检查限定部分，不是对整程序作无缺陷担保。

最终验证回执（本地材料：`evidence/desktop-notifications-20261011/verification.json`）：

- Chromium、WebKit 各 **99 项通过**，其中通知专项各 24 项。
- Rust 通知测试 **11 项通过**，包含真实 Foundation／UserNotifications 内容
  对象、复制后的路由字段、共享协议 fixture、回执隔离、在途取消与非 .app 清理。
- 客户端构建、翻译检查和根项目构建通过。源码哈希保存在 `tested-source.json`。
- 两浏览器保留真实 HostApp、路由确认和缓存逻辑，替换 Tauri SDK；没有产生 Bot 会话。
  Rust 对象测试也没有申请通知权限或向系统实际发通知。

失败证据保留：`deeplink-before.log` 为普通深链被旧通知覆盖；`setup-before.log`
为两个 await 窗口；`intent-before.log` 为两个新通知被误丢弃。中间版本日志不代替
最终 `verified-chromium.log`／`verified-webkit.log`。早期一次 TypeScript 事件参数
类型错误在最终构建前修正；没有忽略编译失败或用测试模式绕过类型检查。

## 开发包

已交付 r35 universal 开发 DMG（本地材料：`evidence/macos-r35-2026-10-11.json`），包含本轮修复
以及 r34 全部功能。文件名为 `TaroCub_1.0.0_universal-development_20261011-r35.dmg`，
17,184,111 字节；SHA-256：
`0a60723ab027e2c2e3b5235b58b823a4f43dedfb4df6f8ab39f429db0ca67c0e`。

arm64／x86_64 两种架构、严格 ad-hoc 签名、DMG 完整性、只读挂载完整文件比对、
Downloads 副本和打包期间源码不变均已独立核验；挂载已卸载。303 个前端文件逐一
匹配 iOS／Android 壳资源。本轮未替换安装、公证或发布，也未编译手机原生包。

## 尚需验收

CUA 在本轮报告 Mac 锁屏、自动解锁失败。未实际申请 OS 权限、发送系统通知、点击
通知横幅／通知中心，亦未验证退出后的冷启动点击。需要在普通 .app 上分别验收允许、
拒绝、前后台、两台主机同 ID、移除主机和重新启动后的行为。

iOS／Android 手机锁屏实收、系统点击、手机原生编译和 Windows 点击入口仍开放。
本轮没有测得新的普通 App RSS／冷启动数字，不能关闭 200 MB 或启动时延门槛。
运行完整功能需匹配 Hub；没有部署、重启生产服务、替换安装、公证或正式发布。
