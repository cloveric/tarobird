# Bot 回复与文件的手机系统通知

2026-10-14。用户需要 Bot 完成回复、发来文件时，在手机通知栏或锁屏收到通知，
并点按回到对应对话。通知设置的首页应围绕这些结果，不要求普通用户理解推送协议。

## 2026-10-17 预览更新

下文保留 10 月 14 日的实现与验收记录。用户现要求通知说明“哪个对话、完成了什么”，
因此已改为对话名、Bot 名和有长度限制的最终回复摘要；文件通知包含文件名。
这取代了下文“仅通用描述、正文不进入推送”的历史行为。配置的推送服务会接触这些
摘要，不能再宣称内容不进入第三方服务。思考、工具日志和过程折叠区不参与摘要。
Android 使用私密通知及通用 publicVersion，锁屏是否显示内容遵循系统设置。
旧 Hub/旧 APK 的兼容边界和新验证见
[侧栏与通知摘要更新](adhd-sidebar-notification-preview-2026-10-17.md)。

## 行为与入口

- `client/src/NotificationSettings.tsx` 直接显示回复完成、收到文件、需要确认或处理错误
  三类提醒。UnifiedPush 保留在默认折叠的「通知连接选项」中，已有分发器注册仍会
  正常读取，不因折叠而失去就绪状态。展开本身不申请权限或注册令牌。
- 主机没有可用推送服务时，明确显示「手机通知尚未接通」，说明锁屏或离开 App 后
  还不能收到提醒，不将开启意愿或配置页面误当成已经可以送达。
- `src/hub/push/model.ts` 在已完成的 Bot 消息上区分回复与文件提示。流式更新不发
  通知，同一消息更新沿用原有去重、免打扰、静默时段及前台抑制机制。
- 原生运行阶段为 partial、interrupted、stopped 或 error 时，即使消息信封标记为
  complete，也只发「任务未完成」提示，不宣布回复完成。文件沿用兼容的 answer
  协议类型；未增加需要旧客户端升级才能解析的枚举。
- Android `NotificationMessage.java` 将可信的通用事件描述映射到系统通知。
  FCM 和 UnifiedPush 共用该路径，保留原有按主机和对话定位的点击行为。正文及文件名
  不进入锁屏提示；旧 Hub 的笼统 answer 提示保持为新消息提示，不推断任务已完成。

## 验证

- Hub 推送与令牌轮换：26 项通过，覆盖完成前不通知、文件与回复区分、内容隐私、
  同消息去重，以及四种未完成阶段不误报成功。
- Chromium、WebKit 各 26 项通知设置和就绪状态测试通过。390 像素手机布局已查看，
  未配置服务时不显示就绪，技术配置默认折叠，展开不会写入设置或获取令牌。
- Android Gradle 编译与 `NotificationMessageTest` 3 项通过，包含旧 Hub 兼容提示。
- 根项目与客户端构建通过。

以上是源码、浏览器及 Android 编译验证，不是手机实际送达证明。

## 真实推送接入门槛

用户确认 vivo 可以正常使用 Google Play，因此优先接入 FCM，无需另外安装 ntfy。
截至本次检查，Android 构建缺少 `google-services.json`，本机运行主机未配置 push，
也没有连接可供验证的 Android 设备。因此没有发布带 FCM 配置的安装包，也没有
声称后台或锁屏推送已接通。

后续需完成同一 Firebase 项目的 Android 应用配置和主机服务账号配置，再重新打包。
服务账号只放主机私有目录，不写入仓库或 APK。安装后检查系统权限、通知渠道、
设备注册，分别验证回复完成与文件通知、锁屏及切换 App 后送达、点击定位、免打扰
和重复通知。配置就绪与实际送达分开验收。

官方接入依据：[Android FCM 入门](https://firebase.google.com/docs/cloud-messaging/android/get-started)、
[Android 项目配置](https://firebase.google.com/docs/android/setup)、
[Android 消息接收](https://firebase.google.com/docs/cloud-messaging/android/receive-messages)。
