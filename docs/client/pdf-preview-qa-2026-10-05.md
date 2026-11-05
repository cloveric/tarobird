# PDF 阅读体验验收 · 2026-10-05

实际 Opus 5.5 xhigh 负责阅读器设计与实现，父代理负责接入、异常处理和渲染验收。
这是文件阅读功能的跟进，整体产品计划仍未完成。

## 发现并修复的问题

原来通过带 sandbox 的 iframe 打开 PDF，真实 Chrome 显示“此页面已被 Chrome 屏蔽”。
此前“文件已下载”和 Blob 格式测试并不能证明正文可读。本轮修改前的四项测试全部失败：
1360 / 390 / 320px 均没有 PDF 正文，文本拖选到窗口外松开也会误关预览。

原预览被浏览器阻止（本地材料：`screenshots/pdf-preview-20261005/01-blocked-before.png`）

现在按需加载本地 PDF.js canvas / 文本层阅读器；父代理同时修复了外层拖选误关闭。
完整文件仍沿用已经校验哈希的附件下载与保存路径。

## 实际操作与截图

1. **打开文档：通过。** 正文和中文字体实际绘制，文件名、保存、关闭位于顶部；页码与缩放位于阅读区下方。
   纸面保留文档原色，周围沿用 Atelier 色彩与阴影。这里展示的是合成测试文档。

   桌面阅读（本地材料：`screenshots/pdf-preview-20261005/02-desktop-page-one.png`）

2. **手机翻页：通过浏览器验收。** 390px 下工具栏保持一行，省去缩放步进按钮，保留菜单；触控区域至少 44px。
   第二页为独立蓝色内容，测试同时检查真实 canvas 像素与页面文字，避免只检查页码变化。

   手机第二页（本地材料：`screenshots/pdf-preview-20261005/03-phone-page-two.png`）

3. **缩放与窄屏：通过浏览器验收。** 放大后可在阅读区内滚动；同页重绘期间短暂沿用现有画面，120ms 后重绘清晰正文。
   320px 工具栏自然分成两行。截图曾捕获重绘前的模糊画面，已丢弃并替换为清晰重绘结果。

   手机放大（本地材料：`screenshots/pdf-preview-20261005/04-phone-zoom.png`）
   320px 重排（本地材料：`screenshots/pdf-preview-20261005/05-phone-320.png`）

4. **深色英文与关闭：通过浏览器验收。** 英文控件不溢出，PDF 原文不翻译；暗色背景下纸张仍保留原色。
   Esc、关闭按钮和真实背景点击正常关闭并恢复文件入口焦点；从正文向外拖选不再关闭。

   WebKit 深色英文小屏（本地材料：`screenshots/pdf-preview-20261005/06-webkit-dark-english-320.png`）

## 实现与验证

- Opus 实际完成 96 个工具轮次；原始结果摘录（本地材料：`evidence/pdf-preview-opus55-2026-10-05.json`）与[设计说明](pdf-preview-opus55-2026-10-05.md)保留。
- 父代理增加懒加载错误边界、本地 cmap / 标准字体 / wasm / ICC 打包、Hub 的 `.mjs` / `.wasm` MIME；没有放宽脚本 CSP。
- 父代理改为显式持有同包 Worker，绕开 PDF.js 对自定义协议创建 blob 包装的分支，且不回退到主线程解析。
  Worker 错误可重试；销毁文档后释放 Worker，失去响应时最多保留 1 秒退出宽限。
  PDF.js 6.4.299 自动生成的 port 构造器类型为 null，使用一个局部类型边界匹配已核对的运行时 Worker API。
- 翻页、缩放、尺寸变化会取消旧绘制。只挂载当前页，单张 canvas 上限 8 Mi 像素；重绘期间旧 canvas 与新 canvas 可以短暂同时存在，不能把单张预算称作总内存上限。
- 密码只用于当前查看；错误密码、正确解锁、关闭后重新输入、浏览器存储不包含密码均通过。浏览器自己的密码管理器不受 App 完全控制。
- 无注释/表单交互层、脚本执行器或自动外部链接。带提交脚本的合成 PDF 没有发起外部请求或弹出对话框；这不是全面 PDF 安全审计。
- Chromium：最终候选 19 项，加深色英文 1 项，共 20 个不同流程通过；另有附件安全逻辑 1 项通过。
  WebKit：相同 20 项通过。包括真实原始文件下载字节、损坏文件、启动失败重试、启动中关闭、快速翻页/缩放、8 Mi 像素限制、释放 Worker，以及停止 Hub 后重载并离线翻到第二页。
- 配对首屏没有请求 PDF 模块/Worker；初始 JS 616,445 B。所有资源供离线缓存，不代表全部在首屏执行。
  本地空缓存浏览器配对样本中位数 Chromium 104.8ms / WebKit 101ms，只是此环境样本，不是原生冷启动或公网速度。
- 必须执行的根检查通过：235 个测试文件，3,782 通过、1 跳过；根构建和客户端翻译、类型、Vite 构建通过。

日志目录 `/tmp/t/tarocub-pdf-preview-20261005/`；可核对的源文件、截图与日志哈希见验收记录（本地材料：`evidence/pdf-preview-2026-10-05.json`）。

## 开发包

已生成 `~/Downloads/TaroCub_1.0.0_universal-development_20261005-r15.dmg`，16,665,499 B。
Apple Silicon / Intel、严格 ad-hoc 签名、DMG 校验、只读挂载后完整包对比及下载副本哈希均通过。
302 个前端文件与已验收页面、iOS 和 Android 资源副本逐一一致；手机壳尚未编译。
构建记录（本地材料：`evidence/macos-r15-2026-10-05.json`）。

SHA-256：`4f244525362cfbe1d0e5eb46189463df6113cefcf7924d4367b33b5366c88ac1`。

## 尚未验收

手机截图和 WebKit 测试不能替代实体 iOS / Android 的手势、长按选字、分享面板及自定义协议 Worker 验收。
本轮没有运行最终 macOS 原生包，未替换已安装 App，未发布或部署；Hub 只重启了隔离的本地设计预览。
旧 WebView、JPX / JBIG2 扫描页、CMYK ICC、自定义协议资源加载及超大 PDF 仍需单独验证。
上游列出的 legacy Safari 支持范围从 18 起，不能据此承诺全部 macOS 13 / 旧 iOS WebView 可预览；
失败时保留另存为入口。[PDF.js 支持说明](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported)

没有用截图宣称完整可访问性合规；读屏、多页复杂文本阅读顺序以及真机手势仍需后续检查。
