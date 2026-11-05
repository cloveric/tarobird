# TaroBot 1.0.71 / host and CLI 0.1.424

[App release](https://github.com/cloveric/tarobot/releases/tag/v0.1.424-test.1) · [Standalone CLI](https://github.com/cloveric/tarobot/releases/tag/cli-v0.1.424)

TaroBot App 1.0.71 / 主机与独立 CLI 0.1.424（开发预览版）

本次发布 Mac Apple Silicon、Windows x64、Android 与独立 CLI，包含与 Opus 联合复核的真实缺陷修复。Android 1.0.71（versionCode 2026101502）沿用原应用 ID 和原发布证书，支持覆盖更新旧版；没有更换签名或卸载清空数据。

修复内容：
- 自主目标的提问与审批按原生轮次归属，停止或替换后撤销旧请求。
- Kimi 停止与终结事件不再串入后续任务；DeepSeek 迟到审批及重复问题正确隔离。
- 停止按钮可从未确认状态恢复，历史消息定位不反复抢走阅读位置，卡片输入与计划任务反馈正确。
- 并发状态原子保存、Bot 注册保留、幂等重放、日志和诊断边界修复。
- 链接预览降级、长 URL 校验及离线缓存安装修复。

验证：
- 发布源码完整检查：3,806 项通过、1 项跳过；可选旧适配器 1,230 项通过。客户端干净依赖安装、翻译检查、TypeScript 和生产构建通过。
- CLI 独立目录安装、打包解压后安装及 0.1.423 → 0.1.424 隔离升级通过；主机/控制器身份、组网身份、名称、工作区保留。
- Android release 构建、30 项 JVM 单元测试及 lint 通过（0 error、22 warning）；390 个前端文件与构建一致，index.html 仅应用仓库规定的移动端 CSP。签名、非调试标记和全部 15 个图标密度资源已检查；API 36 模拟器通过覆盖安装和冷启动，未出现崩溃日志。
- 最终 Mac DMG 只读挂载后，签名、版本、图标及全部 4,895 文件匹配通过；使用安装包内 Node 完成配对、Bot 创建、模拟引擎回复和重启保留检查。
- Windows 安装包解压检查通过，4,892 个主机文件一致，12 个 npm 符号链接以相同字节实体化；桌面程序、Node、启动器和原生插件为 Windows x64。两个桌面包均有 748 个运行代码、客户端及辅助文件与独立 CLI 完全一致。
- 真实 Codex 经配对浏览器 → Hub → Gateway 完成续聊、文件双端下载、故障恢复、停止恢复和异步问题回答。浏览器手机视口不是物理手机验收。
- 按住录音 14 项交互检查通过；实际短音频经 Qwen 转写成功，Kimi 后续回答受五小时额度用完阻塞。原录音全链路脚本仍使用旧操作，未把该脚本失败计为通过。

版本映射：可执行源码 82f72dd609bd0a7f2f760545dc125f0e66485c54（包含修复 3c0f6de）。App 1.0.71 / host、CLI 0.1.424；协议 1，private-network.v2，Hub schema 读取 1–15、写入 15。按 CLI 更新指南操作；仅安装新 CLI 不会自动替换已冻结的后台服务版本。

边界：Mac 使用 ad-hoc 签名，未 Apple 公证；Finder 自动排版超时后使用无界面封装。Windows 未签名、交叉编译，真机运行尚未验收。Android 物理手机、iOS、后台推送和其他真实引擎本轮未完整验收；Android 未配置生产 FCM。WebKit 仍有已记录的页面创建环境阻塞。一次历史定位测试初始居中偏移为 43.2px（阈值 40px），独立复测通过，未改断言；仍记录这次布局时序波动。GitHub Actions 因账户付款/额度限制未开始执行，本地通过不代表云端 CI 通过。发布构建与本机生产升级分别验收；无关 Telegram/Lark 服务不在本次操作范围。

[完整发布记录](https://github.com/cloveric/tarobot/blob/main/docs/client/release-1.0.71-2026-10-15.md) · [修复详情](https://github.com/cloveric/tarobot/blob/main/docs/bugfix-review-2026-10-15.md) · [CLI 更新指南](https://github.com/cloveric/tarobot/blob/main/docs/host-cli-update.md)

文件 SHA-256 见附件 SHA256SUMS.txt。

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TaroBot-1.0.71-macos-arm64.dmg` | 128,451,394 | `852ef1aed84b11d736cd64cb5179908052831936573621660db4a8e1e8657085` |
| `TaroBot-1.0.71-windows-x64-setup.exe` | 95,293,918 | `f7c0c013cc599b963f7306395a1eb50b90cd83e6d2997b823730ab09628c5cc8` |
| `tarobot-0.1.424.tgz` | 24,619,335 | `ffcfa70e43e7be87ccb83140aff848a0e4ce4d2e4bba09b49ce6c116ff88b406` |
| `TaroBot-1.0.71-android.apk` | 35,335,469 | `6a0e74c1aa2a2c323e901c60536cebb8d8a0d4a0c9e94d2df303e7658d77cf92` |

发布交付已确认：App 与 CLI 两个 GitHub Release 均已发布为开发预览版；七个已上传资产（含重复提供的 CLI 和校验清单）均通过认证 API 重新下载，字节数和 SHA-256 与本地原件完全一致。仓库为私有仓库，下载仍需有权限的 GitHub 账户。
