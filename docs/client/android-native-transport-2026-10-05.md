# Android 原生 TLS 接入 · 2026-10-05

Android 源码已接入原生 HTTP / WebSocket 传输，要求普通 CA、主机名验证以及
Hub 身份对实际 TLS 叶证书的签名。此次仍按用户决定，不增加应用层端到端加密。
VPS 只转发 TLS 字节时不需要持有 Hub TLS 私钥；若 VPS 本身运行 Hub，它就是
能读取业务内容的运行主机。

**本页记录源码与隔离 JVM 验证，不是 Android APK、手机真机或正式发布验收。**
Android SDK 许可仍待用户处理，没有代为接受或安装。后续 [iOS 原生源码接入](ios-native-transport-2026-10-05.md)已有隔离 Foundation 验证，但不是手机验收；
没有替换已安装客户端、r25 安装包、在线 Hub 或 VPS 服务。

## 实现

- `client/android/app/src/main/java/com/tarocub/client/HubTls.java` 是无 Android
  依赖的 TLS 核心。无凭证证明探测同时检查随机数、独立取得的 Hub 公钥、实际
  连接的证书摘要和 Ed25519 签名。正式请求换用固定 DER 摘要的 TrustManager，
  通过 `X509ExtendedTrustManager` 把 Socket/SSLEngine 的主机上下文继续传给
  系统校验器，再检查证书摘要；保留 OkHttp 主机名验证，不再叠加会退化为
  默认信任锚集合的 SPKI 链清理。
  每个线路、公钥及固定证书代际使用独立 SSLContext 和连接池，缓存五分钟。
  该实现允许同一可信范围内 TLS 会话恢复，不等同于桌面 Rust 的禁用恢复策略。

- 不跟随重定向，不使用系统代理，不自动重试业务请求。Android 的 Hub 连接
  全部要求 HTTPS，包括 loopback；开发 APK 也没有明文例外，不影响 App 自身的
  Capacitor 本地资源加载。
  路径限制为同源 `/health` 和 `/api/`，排除内部实例入口及编码、大小写、空段和路径参数变体；上传最多 8 MiB，
  按需读取每块最多 256 KiB。底层 8 KiB 段合并后，512 MiB 测试产生
  2,048 个数据块；每个请求复用有界缓冲区，避免为每个小段重复分配大缓冲。
  Android IPC 将单块编码为 Base64，前端再次验证大小。
- `HubTransport.java` 维护单 WebView 的页面凭证、HTTP 32 / Socket 8 个名额、
  请求取消和超时。新页面作废旧凭证、取消旧工作；迟到的 POST 和响应不能继续。
  HTTP EOF、失败和取消都释放名额，过期任务会从调度队列移除。
- `HubTransportPlugin.java` 提供 Capacitor 接口。网络工作使用有界线程队列；
  分配、确认、发送、关闭和取消不等待阻塞的 HTTP 读取。页面开始加载和新凭证
  都清理旧订阅；事件按页面代际隔离，Activity 销毁清理全部工作。
- `client/src/native-network.ts` 将 Android 插件和 Tauri 接口接入同一前端传输层。
  前端先注册 Socket 事件，原生确认订阅存在后才允许连接；关闭、失败和取消
  移除通道。Android 原生失败不回退 WebView；首次 HTTPS 配对同样需要可信二维码或独立取得的公钥。

后续已将 WebSocket 换为固定版本的有界解码器，在分配正文前检查帧长度，
并补齐分片、握手、队列、上传累计预算和底层 TCP 取消。旧的“OkHttp 已组装完
才检查”限制现已在源码修正，详见[追加验证与边界](android-socket-bounds-2026-10-05.md)。
这仍不是实体手机内存、后台及原生容器验收。

## 隔离验证

`client/scripts/android-transport-audit.mjs` 通过 Java 8 目标编译生产核心，再在 JVM
连接真实临时 Hub 和两张由同一临时 CA 签发的不同证书。依赖来自 Maven Central，
版本及 SHA-256 固定在 `client/android/audit/dependencies.json`。只在测试进程内
信任临时 CA，不安装系统证书；脚本管理自己的子进程、临时 Hub、密钥和状态目录。
测试类不属于 Android App 的源码目录，不随 App 打包。

覆盖普通 CA 和主机名拒绝、冒用中转、真实配对与设备认证、认证后 HTTP / WS、
关闭回执、8 MiB 上传、512 MiB 流式下载哈希、重载期间阻塞读取取消、阻塞上传取消、
旧页面/迟到 POST 拒绝、异常请求释放名额、未确认消息积压时关闭、异常 EOF、
证书轮换时 HTTP / WS 旧绑定拒绝和新签名恢复。中转敏感请求计数为零。
下载时间只反映本机测试，不能用作公网 VPS 吞吐比较。

初始测试保留了两类失败记录：配对接口实际返回 201，测试原先只接受 200；
直接全双工回显的 HTTP/1 上传会等待服务端读取，测试服务现按生产上传流程
消费完请求再回复。另补了“不读取上传”的独立取消用例，没有把挂起场景删除。

浏览器合同测试单独验证移动桥接的订阅顺序、二进制分块、序列化字段、取消/关闭
清理和拒绝未知命令；不冒充 Capacitor 容器测试。桌面另重跑实际隐藏 macOS
WebView / Tauri IPC / Rust / 临时 Hub 的完整隔离路径，确保共享适配层没有回归。

精确结果、复审结论和源文件哈希见
本轮收据（本地材料：`evidence/android-native-transport-2026-10-05/summary.json`）。

## Opus 复核与修正

首轮大范围 `claude-opus-5-5 --effort xhigh` 900 秒未返回，保留超时记录；缩小到
TLS 核心与 Capacitor 插件后，实际 Opus 5.5 xhigh 于 310.868 秒完成复核，提出
三个中等级别问题，没有高等级别问题。此为修正前的静态报告，不是修正后的批准。

1. Android 不能把 loopback 当作跨 App 的身份边界。现直接禁止所有明文 Hub
   连接，不以 debug APK 或设备本机地址豁免。
2. 原包装器只传两个参数给系统信任检查，可能丢失按域名选取策略的上下文。
   先用要求 Socket/SSLEngine 上下文的测试信任管理器复现“证明成功，正式请求
   失败”，再改为完整委托 `X509ExtendedTrustManager` 的各重载。修正后全部
   真实 TLS 测试通过，未调用不带主机上下文的 server 检查方法；同时移除多余的
   SPKI CertificatePinner。Android 实际 `<domain-config>` 仍列入真机验收。
   依据 [Android RootTrustManager 源码](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/security/net/config/RootTrustManager.java)
   及 [官方扩展信任管理器接口](https://developer.android.com/reference/javax/net/ssl/X509ExtendedTrustManager)。
3. 收紧内部接口路径变体。当前 Hub 按原始 `pathname` 精确匹配，尚未复现
   审查报告所假设的代理解码／合并后绕过；这里记为防御性加固，不能写成已证实
   的 Hub 越权漏洞。WebSocket 始终使用固定 `/ws`，没有来自 JS 的可变路径。

具体报告和父代理处置见收据；不宣称 Opus 已复审修正后的全部实现。

## 保持开放

Android 插件的真实 SDK 编译、APK 安装与真机证书/后台/恢复验收；iOS 原生通道；
原生大文件峰值内存；同一 App 内的配对、流式停止、双线路切换和续传串联验收；
发布、签名和部署。TLS 私钥或会话秘密共享给中转仍超出此机制能区分的范围。
不以本页测试关闭原计划安全项或全计划。
