# 原生客户端与输入保护 · 2026-10-11

## 普通 Mac App 实际验收

本轮通过 macOS 原生界面操作普通 universal r28 开发包，入口为
`tauri://localhost`，没有使用专用 audit 页面或浏览器 IPC 替身。临时 Hub 和
Gateway 仅包含合成内容，不加载真实 Bot 配置，也没有创建模型会话。

已逐项观察并核对：

- 手工添加隔离主机、主机端批准配对、系统设备密钥认证、新建独立对话。
- 用系统文件选择器添加附件，同时填写文字；显示草稿已保存后退出进程。
  重开后无需重新配对，文字和文件均恢复；一条消息同时包含说明和文件。
- 回复中的过程、表格和公式在原生 WebView 中可见；引用文件消息后，Hub
  持久化记录保留正确的原消息 ID。
- 点击文件打开预览，通过真实系统“另存为”窗口保存，95 字节合成文件与
  原文件 SHA-256 完全一致。
- 主机端撤销设备后 App 断开；退出并重开仍显示已吊销，没有恢复访问。
  最后仅移除本轮临时主机，原有主机及记录保留，临时 Hub 已退出。

机器可读回执（本地材料：`evidence/native-product-20261011/native-product-receipt.json`）、
Hub 消息与附件回执（本地材料：`evidence/native-product-20261011/hub-receipts.json`）、
实际保存校验（本地材料：`evidence/native-product-20261011/file-save.json`）。

真实 Mac App 中的消息和过程（本地材料：`evidence/native-product-20261011/native-chat.jpg`）

这是普通产品路径的本机验证，但传输只用 HTTP loopback。它不证明 HTTPS
系统信任链、公网中转、新 Mac 扫码、实体手机、真实 CLI 或完整停止延迟通过。
本轮源码修复晚于 r28，不能把这次 r28 验收当作后续修复已经出包。

## 内存测量保持未通过

计入新启动的 App 主进程及其 WebContent、Networking 进程，排除旧开发进程和
Playwright。附件与预览操作后的十次样本中，合计 RSS 为
282,968,064—290,881,536 字节（约 270—277 MiB），超过原定 200 MB。
同一组进程的 macOS `footprint` 后续测量为 151,063,288 字节；此口径与 RSS
不同，不能替换前者宣称预算通过。也没有取得规范的冷启动到可交互计时。

RSS 样本（本地材料：`evidence/native-product-20261011/resident-samples.json`）和
系统 footprint（本地材料：`evidence/native-product-20261011/footprint-after-file.json`）
保留原始数据。下轮需在一致工作负载下定位常驻与共享页、缓存和峰值。

## 本轮修复

- 录音明确结束后，编码回执即使晚于切换会话，也回到开始录音的主机和对话
  草稿。明确取消和未完成录音仍会丢弃；旧回执不会重置新录音。持久化失败
  保留文件并允许重试。验证使用真实 MediaRecorder 编码、合成麦克风和真实
  IndexedDB，不等于实体手机麦克风及系统中断验收。
- 全局快捷键注册失败不再导致整个桌面启动中止；固定日志不包含系统错误
  详情，stderr 管道关闭也不会因日志失败而 panic。验证通过注入注册失败及
  BrokenPipe 完成，未抢占用户快捷键。
- 原生审计子进程超时后有 TERM 宽限和 KILL 回收上限；验证只使用测试自己
  创建的进程组，不按进程名称结束应用。退出后继续有界排空管道，并确认日志
  文件关闭；日志失败不会误报成功。主动离开该进程组的进程不会被扩大追杀，
  若其继续持有管道则明确报告不完整。审计开始即显示日志目录。
- 系统分享的编辑文字、目标话题和回复 Bot 按主机及配对身份保存，关闭重开
  后恢复；发送前校验版本，另一窗口的更新不会被旧稿覆盖发送。已发送或丢弃
  的小记录防止迟到写入复活，24 小时过期与原生条目创建时间绑定。所有主机
  缓存在启动打开时清理过期副本，不依赖先访问该主机界面；App 关闭期间不
  执行清理，在下次打开处理。移除主机的草稿提示包含这些未发送修改。
- 修正两处飞书卡片测试的清理时序：等待实际队列及落盘结束再移除测试目录，
  不使用文件删除重试掩盖问题，也未修改生产机群。

## 独立审查与验证

实际 Opus 5.5 xhigh 做了一轮源代码静态复核，提出日志尾部丢失、快捷键错误
日志可能 panic、分享草稿留存和默认审计日志不可定位四项问题，均有处置。
它未执行产品或测试；父代理与 Astra 完成复现、修复和运行验证。
审查原文（本地材料：`evidence/native-product-20261011/opus-final-review.md`）及
逐项处置（本地材料：`evidence/native-product-20261011/opus-review-disposition.json`）。

- 根检查（本地材料：`evidence/native-product-20261011/root-gate-final-verified.log`）：237
  个测试文件、3,802 通过、1 跳过，随后 TypeScript 与 relay 构建通过。
- 最终全部相关回归 Chromium／WebKit 各 45 项通过：录音生命周期 6 项、系统
  分享草稿 8 项，以及旧分享、语音、引导草稿、持久化和主机工作区 31 项。
  Chromium（本地材料：`evidence/native-product-20261011/all-input-final-chromium.log`）／
  WebKit（本地材料：`evidence/native-product-20261011/all-input-final-webkit.log`）。较早运行中
  各 2 项 opt-in 真实语音测试未启用，最终选择明确排除了它们，未计为通过。
- 审计 runner（本地材料：`evidence/native-product-20261011/audit-runner-final.log`）7 项、
  快捷键 Rust（本地材料：`evidence/native-product-20261011/optional-shortcut-final.log`）3 项通过。
  大输出测试覆盖 stdout／stderr、成功／失败四种组合，各 9,000,012 字节一致。
- 隔离真实 macOS WebView/IPC 传输回执（本地材料：`evidence/native-product-20261011/native-runtime-final/native-runtime-result.json`）
  通过实际 Tauri、HTTP/WS 认证、主动代理与 socket 冒用拒绝、重定向拒绝、对端
  确认关闭、8 MiB 上传和 512 MiB 下载哈希。512 MiB 样本用时 7,275 ms，是
  本机隔离环境，不代表公网速度。审计使用专用入口和测试 CA，不等于普通 App
  的系统 CA、完整原生聊天或手机验收。

全项目的原生手机、签名、推送、完整公网与发布验收继续开放，应用层端到端
加密及 Rust 迁移仍按用户决定暂缓。

## r29 开发包与真实打开验证

最终源码已构建为 `TaroCub_1.0.0_universal-development_20261011-r29.dmg`，
约 16.3 MiB，已复制到 Downloads。包含 arm64／x86_64，严格 ad-hoc 签名、
DMG 校验、只读挂载后完整文件比较、复制后的 SHA-256 均通过；211 个输入文件
在构建与核验间不变，两套手机壳的 303 个前端文件与本次构建逐一相同。
包回执（本地材料：`evidence/macos-r29-2026-10-11.json`）。复制手机资源不等于原生编译。

另实际打开该 r29 普通 App，观察 `tauri://localhost`，核对进程执行文件与包，
通过隔离 HTTP Hub 完成手工配对、独立对话、草稿状态、消息及流式合成回复、
表格和公式渲染，随后主机撤销授权，App 显示吊销并断开。Hub 内恰有两条对应
消息、Bot 为完成状态。原生回执（本地材料：`evidence/native-product-20261011/r29-native-product-receipt.json`）
和截图（本地材料：`evidence/native-product-20261011/r29-native-chat.jpg`）。

临时测试设备已撤销，测试主机已从新包中移除，原有主机保留；新启动进程及
临时 Hub 已退出。没有安装替换现有 App、启动真实模型、变更生产机群或发布。
这里补充 r29 的普通启动／消息／撤销证据；r28 的文件与重开验证仍单独记录，
不能据此关闭所有原生功能、TLS 系统 CA、性能和手机门槛。
