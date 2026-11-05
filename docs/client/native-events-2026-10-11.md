# 原生事件恢复与启动导航

2026-10-11。此轮修复手机／桌面 SDK 事件与 App 生命周期衔接。测试在浏览器中替换
SDK 导出接口，保留真实 `HostApp`、`Workspace`、IndexedDB 和原有多主机流程；
没有启动真实 Bot 会话，也没有把替换接口的通过结果算作手机或普通原生验收。

## 已复现的问题与修复

- `getLaunchUrl`／`getCurrent` 读取失败或一直未返回时，原来的串行安装阻断实时
  深链与手机前台恢复。现在分别安装；启动读取只做一次，失败不影响实时事件。
- `App`／`HostApp` 的 `Promise.all` 丢失已成功一路的清理函数，或一直等另一条
  未决调用。安装现在立即返回停止函数，晚到的 handle 仍会被清理。
- 注册拒绝、退出或替换组件后，旧 SDK 回调可能仍到达。每次尝试都有有效期；
  一次 App 生命周期共用一个 `ListenerScope`，先停用全部 native/push 回调并
  清空 consumer/factory，再逐项移除，防止 remove 期间同步触发另一条回调。
- 启动链接晚到时会覆盖新推送、实时深链或用户手动选择。深链版本与临时输入
  观察共同保护当前选择：用户开始点击或键盘操作后，不再应用迟到的启动结果。
  自动读取缓存、默认选中不视为人工操作；观察在读取结束、失败或退出时撤销。
- 更换独立 Workspace 的 connection 曾会重新应用旧启动链接。已处理的初始
  OS 状态只应用于当前页面生命周期一次；退出时仍未完成的首读不会消费下一次
  安装的启动机会。新的实时 OS 链接仍正常接收。
  有效实时导航在分发前就作废旧启动状态；读取明确失败同样结束此次启动尝试，
  避免失败后用户已开始操作、再重建页面却重新打开旧链接。
- 开启通知时，移除临时注册监听若抛错，可能使 token Promise 无法完成；异步
  拒绝还会成为未处理错误。现在先确定注册结果，再独立安全清理每个 handle，
  同样覆盖超时之后才返回的 handle，不重复执行 Hub 配置写入。
  Android 会保留旧注册错误；现在忽略本次 `register()` 尚未调用时的旧错误
  回放，本次注册真正返回的错误仍正常提示失败。若旧错误在跨桥后晚于
  `register()` 到达，SDK 不带调用身份，仍不能区分；未宣称完整解决该问题。

只有已经明确失败的监听注册会重试：总计最多 8 次，间隔为 1、2、5、15、30、30、
30 秒。达到上限后释放 consumer/factory，后续重新安装才重新尝试。未决注册
不因超时再次叠加。上限约束的是 App 发起的次数，不代表 SDK 能释放它未返回的
资源。默认没有权限申请或 provider 注册；这些仍只在用户开启通知时发生。
桌面通知 action 是例外：当前 Tauri 2.5.1 桌面插件没有对应监听命令，仅保留一次
兼容尝试，不反复申请必然拒绝的 Channel。这没有实现桌面系统通知点击直达。

## 审查与验证

实际 Opus 5.5 xhigh 的首轮审查、源码摘要、成功回执和逐项处理在
审查处置（本地材料：`evidence/native-events-20261011/opus-review-disposition.md`）。其中
“Tauri onOpenUrl 会内部回放 getCurrent”的假设经本地 2.6.1 源码核对不成立，
没有按猜测替换官方 helper。其他三项补了复现、修复和回归。

实际 Astra 发现跨 scope 的清理重入以及人工选中后的启动跳转问题；其
处置记录（本地材料：`evidence/native-events-20261011/astra-review-disposition.md`）明确区分
只读复核、父代理实测和 SDK 边界。最终 Opus 复核回执单独保存在
`evidence/native-events-20261011/opus-final/`，两轮均成功结束。最后几项小修发生
在该复核快照之后，由 Astra 只读确认并做针对性回归；不称作 Opus 对完全相同
最终源码的签字。

最终 验证回执（本地材料：`evidence/native-events-20261011/verification.json`）：Chromium、
WebKit 各 **75 项通过**，包含 32 个专项场景；根项目和客户端构建通过，已测
源码哈希与打包输入核对。没有新增真实 CLI、实际推送或原生设备验收。

已交付 r34 universal 开发 DMG（本地材料：`evidence/macos-r34-2026-10-11.json`），包含本轮修复
与 r33 全部功能。文件为 `TaroCub_1.0.0_universal-development_20261011-r34.dmg`，
17,074,866 字节，SHA-256 为
`f172456cacfe8c1aac78c55851feafca6a91e85db5f907506be051b515c57ce1`。
arm64／x86_64、严格 ad-hoc 签名、DMG 完整性、只读挂载后的完整文件比对、
Downloads 副本和测试源码一致性均已验证；挂载已卸载。303 个前端资源逐一复制
并核对到两套手机壳，但没有进行手机原生编译。本包未替换安装、公证或发布，
也不能替代下述普通原生和实体手机验收；运行完整功能仍需匹配的 Hub。

故障证据完整保留：

- `before.log`：最初 3 个场景在旧代码上失败。
- `astra-before.log`、`intent-before.log`：清理重入与实际手动选择被覆盖。
- `opus-before.log`：通知注册清理 throw/reject 与启动链接重复应用共 3 项失败。
- `opus-after.log`：修正后的 27 个专项场景通过。
- `combined-before.log`／`combined-after.log`：新通知后重建监听仍应用旧启动
  链接的组合竞态，及修复／取消首读正常接续。
- `final-review-before.log`／`final-review-after.log`：最终 SDK 前提核对后的
  3 项失败复现与 32 个专项场景通过。
- `final-chromium.log`／`final-webkit.log`：最终相关测试结果，包含多主机路由、
  原生返回、通知设置、UnifiedPush 和身份握手。

早期一次从错误工作目录启动的回归已中止；另一次两个浏览器默认输出目录重叠，
出现 3 个 Playwright trace 文件 ENOENT。两次均不计最终通过；最终运行使用互不
重叠的输出目录。测试本身没有访问真实推送服务或远端生产 Hub。

## 后续 Android 修复

同日后续 [FCM 请求回执与清理](android-fcm-registration-2026-10-11.md)替换 Android
注册事件广播，补上显式 Task 生命周期及已销毁 Activity 准入隔离。上文旧错误
跨桥串线是本报告当时的限制，已有后续源码修复；APK／真机与 SDK 自有自动刷新
边界仍未关闭。此修复不追溯计入本报告 r34 的包或测试。

## 尚未验收

本机 Capacitor Core 8.5.2 的 `addListenerNative` 不把内部 `call` 的拒绝转发到
返回的 Promise，`remove()` 也不等待内部 `removeListener()`。因此测试替换导出
API 不能证明真实 bridge 拒绝会以相同方式冒泡；remove 的 JS Promise 完成也不能
作为原生资源已释放的回执。本轮未修改上游 SDK。

CUA 本轮报告 Mac 锁屏且自动解锁失败。没有新增普通 App 实际运行、RSS／冷启动、
系统通知点击或后台前台切换验收；iOS SDK 缺失，Android SDK 许可仍待先前的明确
答复。锁屏实收、推送耗时、两条真实路线与实体手机验收仍然开放。
Tauri 2.5.1 的桌面通知 action 需要另行实现原生接入；SDK 替换测试中的成功回调
不能证明实际系统通知点击已可用。普通 OS 深链与通知 action 分别计入验收。
