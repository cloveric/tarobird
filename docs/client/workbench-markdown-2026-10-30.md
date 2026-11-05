# 工作台 Markdown 笔记：Vditor 接入

用户要求在工作台加入可手动编辑、可被 Bot 操作的记事本，并指定复用
[Vditor](https://github.com/Vanessa219/vditor)。本次锁定 `vditor@4.0.1`，
实际使用其源码编辑器与格式工具栏，不另造 Markdown 编辑器。

## 界面与保存

- 「新建内容」可新建笔记或导入 `.md`、`.markdown`、`.txt`；支持一次选择多个文件。仅接受有效 UTF-8，每篇最多 128 KiB。
- Vditor 使用源码模式，一行工具栏提供预览、加粗、斜体、更多格式、撤销/重做、导出；预览复用现有安全 Markdown 渲染器。本次未开启 IR/WYSIWYG 模式。
- 笔记复用既有 Tab、分屏、改名、关闭/重开及右侧面板。手机尺寸保留同样的编辑功能。关闭 Tab 保留内容；删除内容需确认。
- 输入停止 400 ms 后保存，失焦/隐藏时也尝试保存；只显示实际保存状态。内容、12 步撤销/重做和最多 128 个请求回执保存在目标设备的 IndexedDB，不自动同步成聊天历史或任意磁盘文件。
- 同一笔记只有一个窗口可写，其他窗口只读但可复制、预览和导出；重新聚焦刷新保存版本并尝试接管已释放的写锁。
- 保存失败保留可导出的文字；显式重新载入需要确认放弃未保存修改。控制器卸载前保留按设备/作用域隔离的紧急草稿，正常保存成功后清掉。清理本地身份同时清理该设备的紧急草稿，异步旧保存不得重新插入。
- 紧急草稿优先使用本窗口 sessionStorage，失败时保留内存和关闭提醒。这不是任意系统崩溃、强制杀进程或存储耗尽时的无限持久性保证。
- 未编辑的导入文件保留 BOM、换行与原文；实际编辑保留一致的 CRLF/CR 习惯，混合换行在修改后统一为 LF。
- 文本粘贴采用纯文本，避免富 HTML 自动转换或把图片塞成大型 base64；笔记导入和附件上传仍是各自明确的入口。

## Bot 与 CLI

Host 广播 `workbench.markdown.v1`，窗口广播 `markdown.v1`。旧 Host 上可本地编辑，Bot 笔记操作明确要求更新；不会把新枚举发给不支持的 Host。Gateway 原生 App 工具 v7 增加 Markdown 操作，保持 v6 定义不变。已绑定旧工具 schema 的会话可通过现有 CLI 使用同一协议，无须替换会话。

操作为 `markdown.create/read/replace/patch/undo/redo`。主聊天发送时冻结设备、窗口、Tab 和版本；Bot 先读再改。修改携带 `expectedRevision`，手动编辑与 Bot 共用保存队列和撤销记录。中文组字期间拒绝 Bot 修改；旧 UI 草稿与新 Bot 内容冲突时保留草稿，不悄悄覆盖。

```sh
tarobot workbench guide browser --json
tarobot workbench context CONVERSATION --context-message MESSAGE_ID --json
tarobot workbench run CONVERSATION --from REQUEST.json --request-id UNIQUE_ID --json
```

`markdown.patch` 的 payload 为 `{"edits":[{"oldText":"唯一原文","newText":"新内容"}]}`。
逐项在候选文本中匹配，缺失或存在多个匹配时整批不写入。读取支持有界分页；偏移按 UTF-16 计数，遇到代理对边界会调整实际 offset，按返回的 nextOffset 继续，不能返回半个 emoji。

成功修改必须收到 `applied` 且 `saved:true`。同 ID 同参数重试返回原回执；异参复用拒绝。笔记保存失败时普通聊天仍可发送，并明确省略未保存的工作台上下文。Markdown 对象不赋予 Bot 任意文件写入权；已有来源授权、目标校验、一次性 admission 和取消机制保持生效。

## 资源与兼容

Vditor、Lute、语言及图标脚本全部本地打包并按需加载；普通聊天不预取编辑器资源。网页部署需首次打开笔记后才有相应运行时离线缓存；原生包直接携带文件。保持 `script-src 'self'`，不增加 eval、外部 CDN 或内联脚本许可。附带 Vditor MIT、Lute MulanPSL-2.0 许可证、来源及打包文件哈希。

接入封住上游隐藏模式快捷键，并保留 AltGr 字符的浏览器默认输入；Tab 可离开编辑器。Lute 加载后恢复全局 stackTraceLimit。Vite 对 iPhone 源码模式的页面 viewport 监听施加精确、版本检查的局部补丁，避免组件销毁后遗留监听。

数据库 v10→v11 只增加 `workbenchMarkdown`。桌面导入导出（JS 和 Rust）包含笔记和历史，兼容明确的 v9/v10→v11，未知版本仍拒绝。创建/删除笔记与布局引用使用同一事务，跨窗口旧 revision 不得覆盖。

## 验收记录

最终计数及证据见 [markdown-acceptance.json](workbench-93/markdown-acceptance.json)。Host 聚焦 51 项、客户端/迁移单测 39 项、Chromium 18 项（笔记 4、存储 7、发送回归 7）、WebKit 11 项、Electron 迁移 25 项、Rust 迁移 5 项通过（另 1 项夹具生成器按设计忽略）。客户端翻译、类型检查及构建、Host 构建通过。重复运行不叠加计数。覆盖：

- 本地 Vditor 资源、格式编辑、预览净化、导入导出、重开保存、窄屏布局；快捷键/粘贴、只读窗口复制及锁交接。
- 真实隔离 Hub 的 Bot 操作、版本冲突、批量失败原子性、请求去重、撤销/重做及模拟 IME 事件。
- 保存失败隐藏/恢复、设备重置清理、真实 IndexedDB v10→v11 保留原白板与待发消息。
- 真实隔离 Codex Bot：收到冻结笔记目标，调用读取、局部修改，再读回已保存内容；其余文字和 emoji 保留。生产配置与会话未修改。
- Opus 5.5 独立复核 Host 协议及客户端接入，并复查修复。

本轮不发版、不更新已安装 App。Chromium/WebKit 的尺寸与事件验证不是 iPhone/Android 真机或 Windows 原生验收；Windows AltGr 实体键盘、手机实体输入法与正式安装包仍待对应环境。#93 的其他未完成硬件验收保持开放。

扩大回归的 60 个文件中 1074/1076 通过：reports v4 旧契约夹具在未修改基线上也失败；讨论语音复用测试并行负载下 5 秒超时，单独复跑两次通过。根级全仓类型检查仍有 138 项既有诊断，记录的改动文件诊断为 0，不能宣称全仓类型检查通过。

测试界面预览：桌面 (historical image omitted from this clean snapshot)、手机尺寸 (historical image omitted from this clean snapshot)。

Opus 最终复核未发现阻塞；随后补齐其 N1/N2/N4 建议：保存失败后继续输入不因旧 UI revision 误报冲突，已保存的相同紧急草稿不再提示冲突，超限输入回退不丢换行习惯。N3 移除主机确认已说明本机笔记/白板会删除并提示先导出。

保留的边界：拖入纯文本按当前光标位置插入；没有 Web Locks 的旧环境保持只读；写锁在聚焦、恢复可见或读取时重新获取。账号切换保留旧作用域的紧急草稿供同账号恢复，不呈现给其他账号，移除主机/本地重置会清除；窗口关闭按 sessionStorage 规则结束。
