# Android 推送注册与清理回执

2026-10-11。补齐此前原生事件报告中“旧 registrationError 晚到时不能区分”的
Android 源码缺口。此轮没有 Android SDK、APK、Google 服务或实体手机验收。

## 修复

官方 Capacitor Android `register()` 先返回，再将 Firebase Task 结果广播到
`registration`／`registrationError`，事件没有调用身份。受控 SDK 复现了两种
错误：旧失败让新注册失败；旧成功让本次失败的注册反而写入 Hub。Android 现在
调用自有 `UnifiedPushPlugin.registerFirebase()`，只使用本次请求的 Task 回执。
iOS 保留 APNs 事件接口；官方接收、点击及现有 UnifiedPush 功能继续使用原路径。

`FirebaseTokenOperations` 是设备级的显式 Firebase Task 协调器。同一进行中的
取令牌 Task 可被多个主机共用，每个调用者独立限时 20 秒，并及时释放桥接回复和
定时器。JS 另有 25 秒桥接超时，迟到结果不会启动 Hub 写入。失败、缺少配置、
旧安装包和正在清理均提供中英文恢复说明；未获得有效令牌不替换原推送方式。

全设备清理的 JS 屏障现在覆盖 UnifiedPush、Firebase 令牌和已送达通知的完整
清理。原生清理先关闭 auto-init，等待**显式 getToken Task 实际结束**，再调用
deleteToken；超时或删除失败会报告未完成并保留准入限制，后续可重试。
单个主机断开不删除其他主机共用的设备令牌。新安装默认不自动注册，显式取令牌
成功且仍有有效调用者时才启用 auto-init，避免失败注册主动触发额外自动重试。

Activity 销毁会在协调器同一把锁内永久停用其 Owner，既清理已有回复，也拒绝
随后执行的旧排队注册／清理请求；新 Activity 的 Owner 不受影响。

## 审查和验证

Astra 只读审查核对了项目锁定的 Firebase 25.0.1 与 Capacitor 源码，指出
getToken 晚于 deleteToken 写回缓存，以及 Activity 销毁后旧排队调用重新准入。
后一个问题有失败复现和修复后回归，最终窄查确认闭合。此轮没有取得 Opus 审查
回执；此前另一批代码的超时请求不计为本轮审查。

- Chromium、WebKit 各 69 项通过，包括 26 项 Android/UnifiedPush 设置与注册流程，
  以及原生事件、通知设置、多主机推送、本地重置关联回归。
- 生产 Java 协调器使用 JDK 21、JUnit 独立编译执行，10 项通过：独立超时、失败
  重试、真实任务结束后删除、清理超时、删除失败恢复、销毁隔离和有界消费者。
  不是 Android Plugin/Service 编译，也不证明 APK 或系统服务行为。
- 客户端类型、翻译和构建检查通过；手机资源逐文件比对另有回执。
- 仓库 pre-complete hook 通过 bash 执行成功：237 个测试文件、3,802 项通过，
  1 项跳过，根构建通过。两个手机壳各 303 个前端资源逐字节一致。
- 初次浏览器命令工作目录错误，已中止并保留日志；从 client 目录重新进行的
  旧逻辑复现准确出现两种相反错误。最终测试使用两个独立输出目录。

原始日志、源码哈希、资源回执及仓库检查状态见
本轮证据（本地材料：`evidence/android-fcm-registration-20261011/`）。Mac 最新开发包仍为
r37，此轮手机改动没有重新包装或替换该文件。

## 未关闭的门槛

以上排序只覆盖 App 持有的**显式** Firebase Task。Firebase SDK 已经排队的
自动刷新／联网恢复任务，不由这个协调器完整控制，不能保证它们全部取消或
令牌永不再生成。令牌轮换向所有 Hub 自动同步、跨原生页面桥接重建的全部时序，
以及真实无 GMS、后台、锁屏实收／点击仍需进一步实现或实际验收。

Android SDK 许可未收到先前请求的答复，没有安装 SDK 或创建许可标记；iOS SDK
仍缺失；CUA 本轮再次报告 Mac 锁屏且自动解锁失败。手机原生编译、真机系统权限、
FCM／APNs／UnifiedPush provider 和实体手机两条线路门槛均保持开放。

依据：[Firebase Messaging 25.0.1 官方源码包](https://dl.google.com/dl/android/maven2/com/google/firebase/firebase-messaging/25.0.1/firebase-messaging-25.0.1-sources.jar)、
[Google Task API](https://developers.google.com/android/reference/com/google/android/gms/tasks/Task)。
