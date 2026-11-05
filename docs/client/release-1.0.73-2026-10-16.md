# TaroBot 1.0.73 / host and CLI 0.1.425

[App Release](https://github.com/cloveric/tarobot/releases/tag/v0.1.425-test.1) · [CLI Release](https://github.com/cloveric/tarobot/releases/tag/cli-v0.1.425)

TaroBot App **1.0.73** / 主机与独立 CLI **0.1.425**（开发预览版）。

提供 Android APK、Mac Apple Silicon DMG、Windows x64 安装包及独立 CLI。Android versionCode 为 2026101602，应用 ID 与发布证书保持不变，可覆盖安装旧版。

本次包含：
- 主机与 Gateway 断连、启动失败后的恢复修复，以及桌面/CLI 引擎搜索路径一致性修复。
- AGY 模型选择支持 Gemini 4 Argon。
- 用户消息显示对应的回复状态；排队消息管理、草稿提示、附件操作和手机文件预览交互改进。
- Mac 的 Command+Return 换行；App 附件工作目录与共享核心改用 TaroBot 或中性名称，保留旧数据兼容。
- 复核后确认的数据库启动清理、跨块日志脱敏、空文件与变动文件处理、重复附件导入、CLI 重复更新预检及失败恢复修复。

验证结果：
- 发布源码独立构建通过；最终完整测试 **3,942 项通过、1 项条件跳过**（298 个文件），没有放宽断言或超时标准。最终运行减少测试进程并发，避免原生编译争抢资源。
- 客户端干净安装、翻译检查、TypeScript 和生产构建通过。19 项浏览器用例完成，其中真实 Codex 生命周期在构建结束后单独重跑通过。
- 真实 Codex 经配对浏览器 → Hub → Gateway 验证续聊、文件双端下载、进程中断恢复、停止恢复及异步提问回答。手机视口检查不是物理手机验收；其他四种引擎本轮没有做真实账号端到端验收。
- CLI 独立目录安装、打包解压后安装、实际 Hub 启动和网页资源服务通过；0.1.424 → 0.1.425 隔离升级保留主机/控制器身份、网络身份和工作区，未安装生产 OS 服务。
- Android release 构建、30 项 JVM 单元测试及 lint 通过（0 error、22 warning）；签名与旧版一致、非调试构建、全部 15 个图标密度资源和 390 个前端文件已核验。API 36 模拟器覆盖安装后首次安装时间保留，冷启动成功且没有崩溃记录。
- 最终 Mac DMG 只读挂载后，深度严格签名、版本、图标及 4,894 个主机文件检查通过；安装包内 Node 完成认证配对、Bot 创建、模拟引擎回复和重启保留检查。
- Windows 安装包解包检查通过，4,895 个主机文件匹配，12 个 npm 符号链接以相同字节实体化。桌面程序、Node、启动器和原生插件均为 Windows x64。两个桌面包分别有 751 个共享运行代码/客户端/辅助文件与 CLI 完全相同。

版本与升级：可执行源码 **53697911e447a344deba349ae23aacf45021b3d8**；App 1.0.73，host/CLI 0.1.425；协议 1，private-network.v2，Hub schema 读取 1–15、写入 15。CLI 下载后可用 `npm install -g ./tarobot-0.1.425.tgz` 安装，需要官方 Node 20.17+（建议 Node 24）；已有冻结后台服务仍需按 [CLI 更新指南](https://github.com/cloveric/tarobot/blob/main/docs/host-cli-update.md)执行升级，安装新命令不会自动切换后台版本。未向 npm 公共仓库发布。

验证期间的问题已保留记录：首次使用 Homebrew Node 被冻结运行时的外部依赖保护拒绝；改用官方 Node。原生构建并发时出现运行时探测/测试超时，相关 104 项重跑及最终完整测试均通过。首次真实 worker 验收与重建共用了输出目录，造成临时文件缺失；改为隔离构建目录后重新通过。Windows 的依赖链接路径导致 relay bundle 字节不同，最终封装复用与 Mac/CLI 同一份已验证的共享代码，并重新通过逐文件核对。没有把这些失败计为首次通过。

边界：Mac 使用 ad-hoc 签名，未 Apple 公证；Windows 未签名、交叉编译，尚未在 Windows 真机运行。Android 物理手机、iOS 和生产后台推送本轮未验收。GitHub Actions 因账户付款/额度限制未开始执行，本地通过不等于云端 CI 通过。Gemini Argon High 全项目审计受额度限制未完成；本次采用的是经主审与 Opus 复核确认的修复，不宣称全项目无缺陷。本次发布没有替换或重启生产主机，也没有操作无关的 Telegram/Lark 服务。

[审计记录](https://github.com/cloveric/tarobot/blob/main/docs/gemini-opus-audit-2026-10-16.md) · [发布检查记录](https://github.com/cloveric/tarobot/blob/main/docs/client/release-1.0.73-2026-10-16.md)

文件 SHA-256 见附件 `SHA256SUMS.txt`。仓库为私有仓库，下载需要有权限的 GitHub 账号。

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TaroBot-1.0.73-macos-arm64.dmg` | 128,455,980 | `e934598f8463e9583344bdabcb9f35b1e4ff908448eebead6e26615b952b165c` |
| `TaroBot-1.0.73-windows-x64-setup.exe` | 95,239,533 | `16b4ea4949137be4efe613dfcb0500fa45e29558976a1206994e016f7aa64504` |
| `TaroBot-1.0.73-android.apk` | 35,339,565 | `0748bb863f71512c51d3ff05929bd6c323f79cad7a04bd80ffa6d5dcbb7a11dd` |
| `tarobot-0.1.425.tgz` | 24,632,556 | `54d4694a5d472d0a6708b11ffb7441fbac995b266988ed0d4d4c24b1c7545ca5` |

交付已确认：App 与 CLI 两个开发预览 Release 已公开给有仓库权限的用户；共七个资产（包括重复提供的 CLI 与两份校验清单）上传后通过 GitHub API 重新下载，大小及 SHA-256 与本地原件一致。发布后的资产 ID 对应文件大小和摘要再次核对一致。[机器可读验收记录](evidence/release-1.0.73-2026-10-16.json)。本机已安装 App 和生产主机未替换。
