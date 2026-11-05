# 文档导航

[English documentation](README.en.md) · [英文产品指南](product-guide.md)

## 使用与开发

| 我想做什么 | 从这里开始 |
| --- | --- |
| 看首页挪出来的详细说明 | [详细说明](details.zh-CN.md)：功能清单、引擎与权限、Bot 间派任务、CLI、排队、隔离、数据去向、升级、源码构建、开发状态、名称与兼容 |
| 下载 App 或查看平台限制 | [当前下载](https://github.com/cloveric/tarobird/releases) |
| 从源码启动主机并配对设备 | [开始使用](getting-started.md) |
| 安装、运行或升级无界面主机 | [主机 CLI](host-cli.md) · [更新与回滚](host-cli-update.md) |
| 让 Bot 给另一台主机的 Bot 发任务 | [跨主机消息：授权、命令与回执](client/cross-host-bot-messages-2026-10-17.md)（App 与 CLI 共用主机 API） |
| 建 Bot、建群、开话题、发文件 | [使用指南](client/user-guide.md) |
| 了解完成度和下一步 | [当前开发状态](details.zh-CN.md#开发状态) |
| 配置、备份与恢复主机 | [本机运维](client/operations.md) |
| 在外面用手机连接电脑上的 Bot | [Agent 配置与手机连接](client/remote-access.md) · [手动部署命令](client/vps-relay-manual.zh-CN.md) · [完整 VPS 主机](client/host-deployment.md) |
| 部署可选中转 | [Relay 部署](client/relay-deployment.md) |
| 了解配对和传输保护 | [安全边界](client/security.md) |
| 理解产品流程和设置作用范围 | [产品指南（英文）](product-guide.md) · [逐屏使用指南](client/user-guide.md) |
| 配对设备和加入电脑 | [远程配对](client/remote-pairing-2026-10-14.md) · [私有组网](client/private-network.md) |
| 使用队列、回复标识与 Claude 过程详情 | [排队](client/prompt-queue-2026-10-14.md) · [回复状态](client/user-reply-status-2026-10-16.md) · [Claude 事件归属](client/claude-scoped-process-2026-10-15.md) |
| 讨论、查看图形或审阅代码 | [群聊方式](client/group-discussion-2026-10-20.md) · [可视化回复](client/inline-widgets-2026-10-22.md) · [本轮改动](client/run-diff-2026-10-20.md) |
| 调整头像、密度和主题 | [对话头像](client/conversation-avatars-2026-10-13.md) · [界面密度](client/layout-density-2026-10-13.md) · [CLI/像素主题](client/cli-pixel-themes-2026-10-12.md) |
| 配置通知、语音和搜索 | [语音路由设置](client/voice-transcription-settings-2026-10-21.md) · [通知前提](client/message-notifications-2026-10-14.md) · [集成说明](integrations.md) |
| 比较引擎和信任边界 | [能力对照](client/capability-map.md) · [权限](permissions.md) · [安全模型](client/security.md) |
| 开发与发布 | [代码入口](entrypoint-map.md) · [CLI 同步维护规则](../AGENTS.md#desktop-mobile-and-cli-evolve-together) · [发布清单](release-checklist.md) · [文档导航](README.md) |

带日期的设计、审计文档描述当时的检查，可能早于安装包发布。已打包功能以各平台发布记录为准，尚待发布的功能以对应源码验收记录为准。

## 架构与适配

- [代码入口](entrypoint-map.md) · [客户端架构](client/architecture.md) · [协议](client/protocol.md)
- [功能对照](client/capability-map.md) · [effort](client/effort-settings.md) · [执行中引导](client/steering.md)
- [Skills 与 MCP](client/skills-mcp.md) · [App 提示词与结构化能力](client/app-platform-prompt.md)
- [macOS 构建](client/macos-build.md) · [Android 构建](client/android-build.md)
- [验收门槛](client/acceptance-gates.md) · [实现记录](client/implementation-status.md)

## 原有通道

[飞书与 Telegram 完整参考](full-reference.md)保留原 TaroCub 的使用说明。App 的操作方式优先参照上方客户端指南。

带日期的审查和验收文档用于保留工程背景。原始验收截图、日志和录屏不进入源码仓库；相关本地链接不是公开下载。[首页演示截图](../assets/product/README.md)使用合成数据，记录了拍摄日期和版本；安装包通过 GitHub Release 资产分发。
