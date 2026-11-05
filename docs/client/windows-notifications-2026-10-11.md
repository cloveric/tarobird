# Windows 原生通知与桌面清理顺序

2026-10-11。本轮实现 Windows 通知显示、真实权限读取、原生点击保留与安装器接入。
这些是代码、模块类型检查和受控 SDK 证据，不是 Windows 安装或系统实收验收。

## 行为

Windows 使用本应用 AUMID `com.tarocub.client` 的 WinRT `ToastNotifier.Setting`，
不使用桌面插件恒定返回 granted 的权限结果。系统禁用时保持禁用；只有明确开启
操作才更新 Hub 偏好。缺少有效安装快捷方式、系统版本过低或权限读取失败时，
设置显示中英文操作指引。支持 Windows 10 1703（15063）及以后版本。

通知使用 protocol-only ToastGeneric；专用 `tarocub://notification/…` 严格验证
主机、对话和消息标识，拒绝重复／未知参数、路径注入及 fragment。正文和 launch
参数经过 XML 转义。冷启动在 Builder 前解析，热启动通过首个 single-instance
插件直接进入同一个原生 Inbox，不依赖 deep-link state 或 WebView 监听先准备好。
普通 JS 深链不会再次消费专用通知 URI。点击只请求导航，不执行 Bot 指令。

按主机指纹分组，去掉固定 hub_ 前缀后为 64 字符，保留完整身份；每次提交使用独立
UUID tag。主机清理只删除对应组，迟到取消只删除该提交。COM/WinRT 对象在同一
blocking worker apartment 内创建和释放。Show 成功只表示 API 接受请求，不能据此
声称横幅已显示、通知已收到或用户已读。

## 安装与卸载

NSIS POSTINSTALL 原位使用安装器现有且目标确实指向当前 EXE 的 Start Menu
快捷方式，包括升级沿用的位置，不再创建第二份快捷方式。原生早退出 helper 写
AUMID 和 VT_CLSID stub 属性、Commit/Save，并重新读取目标和属性；不注册 COM
server 或 LocalServer32。安装目录的 receipt 仅记录该快捷方式路径，运行时仍会
核验实际 link 与属性，不能只靠 receipt 宣称已安装。`/NS` 且无有效快捷方式时，
保留 App 的其他功能并明确通知不可用。

真正卸载时，仅当协议 handler 仍属于当前安装，先停止 App、执行通知历史清理，
再删除 EXE。失败会中止卸载；升级跳过历史清空。安装器脚本尚未由 NSIS 编译或
真实执行。全用户安装／其他用户通知中心的行为也未验收。

## 发现和修复

1. 在等待通知能力读取时开始移除主机，旧提醒仍可能继续提交。先用行为测试复现，
   再在清理入口同步取消本主机未提交任务；另一主机和清理后的新任务不受误伤。
2. Tauri 把 async command 分别交给异步执行器，不提供 IPC FIFO。前端增加按主机
   的 show/clear 顺序屏障：清理等待已有发送 RPC 返回，再执行原生清理；全局清理
   等所有主机，之后的新发送等待该清理。失败结果保留，不超时后假报清理完成。
3. 非 MSIX 卸载原先没有主动清除通知历史，补上上述卸载 helper 和所有权判断。

Astra 先前关于“共享 supported Promise 未返回时 clear 已完成”的具体时序描述
不成立，已明确撤回；修复与测试对应的是清理开始后不应继续提交，以及原生命令
独立调度的实际边界。前端队列处理当前页面；原生另有跨页面操作屏障与文档代次校验。
show 和 clear 都在取得原生许可后核验 documentId，页面提交时取消旧任务并更换代次。
许可随 Windows blocking closure／Mac async 清理一直持有，避免已调度的旧清理
迟到删除新提醒。全局清理独占；主机清理只占本主机通道，其他主机仍可发送。
Mac 查询超时后，迟到的通知清理回调由 ClearLifetime 禁止继续操作。Rust 行为测试
覆盖换代后的旧发送／旧清理拒绝、持有旧清理时新发送等待和全局清理隔离。
这补的是源码中的排序缺口，真实系统服务的展示和点击仍须原生验收。

## 验证与未完成项

- Chromium、WebKit 各 36 项通过：32 项通知专项，加多主机推送／本地清理 4 项。
- Rust 通知模块 17 项通过，包含既有 Apple 内容对象测试和新增 Windows URI/XML。
- Windows x64、ARM64 类型检查直接 include 生产 WinRT/COM 模块，使用匹配版本
  的依赖；不是替身实现，也不是完整 Tauri App 编译或链接。
- 完整 Windows x64 App 检查在 ring C 编译处失败：本机缺少 Windows 的 assert.h
  等 SDK 头文件。保留失败日志，没有通过删依赖或跳过代码把失败记成成功。
- 根项目与客户端构建、翻译检查通过。

一次关联回归发现原有 Keychain 测试替身未支持新通知清理命令，已补齐该契约，
保留其拒绝／重试／恢复断言。另一项失败来自并行 Playwright 输出目录相互覆盖；
最终两引擎使用独立输出目录。原始失败日志仍保留。

真实 Windows 安装、升级、卸载、冷／热启动通知点击、系统禁止通知、当前用户与
全用户安装仍开放。Mac 锁屏，没有本轮 OS 通知实收／点击证据；手机原生编译、
APNs／FCM／UnifiedPush 锁屏实收、正式签名与发布也没有因此完成。

证据在 本轮目录（本地材料：`evidence/windows-notifications-20261011/`）。

## 开发包与独立审查

r37 Mac 开发包回执（本地材料：`evidence/macos-r37-2026-10-11.json`）确认 arm64／x86_64、严格
ad-hoc 签名、DMG 校验、只读挂载内容比对及 Downloads 副本一致。该包包含最终
跨页面通知排序修复，体积 17,196,808 字节，SHA-256 为
`3c5ea572be4788191801fee314fcbe9cd8896cba25f461e7569e64bdbea49be1`。
两个手机壳各 303 个前端资源与构建输出一致，不计为手机原生编译。没有安装、
发布、公证或新增 OS 通知实收验收；r36 中间包保留原证据，交付以 r37 为准。

Astra 最终只读复核未发现新的确定阻断。实际 Opus 5.5 xhigh 首轮请求，以及
缩小为 Windows API／COM／安装器三份文件的重试，都在 600 秒后被 runner 终止，
exitCode=143，正文和 stderr 均为空。没有成功模型回执，不能算作审查通过；
原始状态与快照保留在本轮证据目录及其 `opus-focused/` 子目录。

实现依据：[Microsoft unpackaged toast/stub CLSID](https://learn.microsoft.com/pt-br/windows/apps/design/shell/tiles-and-notifications/toast-desktop-apps)、[Tauri CLI 2.12.1 NSIS 模板](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)。
