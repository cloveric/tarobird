# 对话工作台：实现与验收（#93）

对应 [issue #93](https://github.com/cloveric/tarobot/issues/93)。工作台属于当前主对话，复用原侧区和主输入框；没有增加项目管理入口、独立 Bot 会话或云端白板服务。本次没有发版、更新已安装 App 或重启生产 Host。

## 使用与内容边界

- 对话标题栏打开工作台；聊天图表可直接打开，图片可放到白板，链接菜单可选择内嵌浏览。普通点击链接仍使用系统浏览器。
- 标签支持重命名、左右排序、关闭、重开、加入/移出分屏及单区放大；最多四个不同内容同时显示。当前顶栏直接提供“分屏 / 合并 / 还原”，标签管理在右键菜单或标签列表每行入口，见[后续交互修订](workbench-split-controls-2026-10-31.md)。侧区与展开视图复用内容，保留主聊天草稿。手机以单页切换查看内容。
- Markdown 笔记采用锁定的 Vditor 4.0.1：源码编辑、预览、自动保存、文件导入导出和 Bot 读写，见[独立实现与验收记录](workbench-markdown-2026-10-30.md)。
- 白板采用锁定的 Excalidraw 0.18.1，按需加载。图形、文字、连线、图片、标注和受限 Bot 修改共用版本、撤销和保存机制。`.excalidraw` 导入新建白板，不覆盖当前内容。
- 关闭标签保留内容；删除本机白板经过确认，并在同一 IndexedDB 事务里删除内容和布局引用。最多 64 个打开和 64 个关闭引用；达到容量时明确拒绝，不能丢弃旧白板引用。图表/网页可以显式移除最近关闭引用；不删除聊天来源或网站数据。
- 白板保存在目标设备，不逐笔进入聊天同步。同一作用域的同一白板最多一个可写编辑器；其他窗口只读。保存失败保留未保存状态，不能返回 `applied/saved`。正常卸载等最后保存结束再释放锁。
- 主聊天发送时冻结目标、选区和版本。标注原图、预览、参考图分别上传；原图按 SHA-256 对齐，不能用标注预览代替原图。恢复草稿时只重绑定同设备、同对话、原白板的新窗口租约，不跟随另一张当前白板；原目标未打开则要求用户打开并保留草稿。
- 图表引用已有消息块，源版本/权限失效会显示不可用；更新先实际呈现候选，再保存引用。候选渲染失败保留旧图。现有 Report 交互和 Widget 沙箱继续生效。

## 实现入口

| 层 | 文件和职责 |
|---|---|
| App | `App.tsx`、`use-workbench.ts`、`WorkbenchEntry.tsx`：入口、主草稿、冻结上下文和注册；`SidePanelResize.tsx` 共享侧区调宽 |
| 工作台 | `Workbench.tsx`、`workbench-controller.ts`、`workbench-model.ts`：布局、目标命令、候选提交、保存回执 |
| 白板 | `WorkbenchCanvas.tsx`、`workbench-board.ts`：组件适配、稳定元素 ID、版本、写锁、受限增删改、图像材料 |
| 存储 | `storage.ts` 的 `workbenchLayouts/workbenchBoards/workbenchMarkdown`；数据库 v11 增加笔记 store，显式兼容 v9/v10 旧迁移导入，其他未知版本仍拒绝 |
| Host | `src/client-protocol/workbench.ts`、`src/hub/workbench.ts`：`workbench.v1`、授权、目标查找、一次性 admit、请求去重、取消与结果日志 |
| 模型 | `src/gateway/app-tools.ts/channel.ts/service.ts`：`app_workbench`、每轮来源绑定、附件上传/截图下载；`runtime/workbench-image.ts` 校验本地图片路径和字节 |
| CLI | `src/host-cli/workbench.ts`：同一 Host API、认证和回执，不另造 headless 实现 |
| Electron | `browser-contract.mjs/browser.mjs/browser-page.mjs/browser-policy.mjs`：同窗 WebContentsView、作用域 session、受限观察/操作、权限和生命周期 |
| 资源 | `client/excalidraw-assets.ts`、`licenses/excalidraw`：本地字体、许可和版本检查；工作台专属资源按需缓存 |

布局/内容按 Host 公钥、用户和对话隔离。每个工作台控制器使用独立逻辑窗口 ID；不同 ADHD 面板不能互相替换 Host 注册。原生窗口 ID 仅供 Electron 管理浏览器，不直接充当所有对话的注册 ID。

## CLI 和模型协议

```sh
tarobot workbench guide browser --json
tarobot workbench guide widgets --json
tarobot workbench context CONVERSATION --context-message MESSAGE_ID --json
tarobot workbench targets CONVERSATION --json
tarobot workbench run CONVERSATION --from REQUEST.json --request-id UNIQUE_ID --json
# 没有原生 App 工具的引擎也能发布报告并取得真实 source
tarobot workbench publish CONVERSATION --from WIDGET.json --request-id UNIQUE_ID --context-message MESSAGE_ID --json
# image.insert 允许本地授权文件；先通过同一附件通道上传
tarobot workbench run CONVERSATION --from REQUEST.json --request-id UNIQUE_ID --file result.png --json
```

请求使用 `operation`（`tabs.list`、`whiteboard.create/read/patch/undo/redo`、`markdown.create/read/replace/patch/undo/redo`、`chart.open/update`、`image.insert`、`browser`）、可选明确 `target`、`expectedRevision` 和有界 `payload`。Bot 工具由 Gateway 自动携带当前消息来源；CLI 在 Bot 运行环境中使用该 Bot 的凭证和来源，不能借用本机 owner 控制器。`guide` 只读取静态契约，`context` 返回当前真人消息的冻结上下文；`publish` 仅接受原有有界 Widget/Report 格式，经本轮来源、会话权限和 Host 组件开关校验后返回真实 `source`，供 `chart.open/update` 使用。相同来源和请求 ID 重放返回原消息，异参复用拒绝；原消息后来改过版本也拒绝，避免旧请求悄悄取得新的来源版本。非原生工具引擎不需要更换会话或增加工具 schema。

请求上限 256 KiB，回执上限 512 KiB。Host 操作/context 日志共享 20,000 行和 32 MiB 上限，以增量账本计量。容量不足时聊天照常保存、投递，只省略工作台上下文；`message.ack.workbenchContextOmitted=history_limit` 让 App 明确提示。来源消息超过 24 小时且全部投递 accepted（或没有投递）后，context 可回收；待投递、执行中、失败可重试的来源继续保留。消息表中的可空 `workbench_receipt_json` 仅保存摘要和省略原因，随消息保留，使 ACK 丢失、Host 重启和 context 回收后的同 ID 重试仍去重，异参仍报冲突；旧行回收前补摘要。本机 owner 和失败可重试来源的变更 journal 不按时间盲删，容量满只拒绝新工作台操作，避免旧请求再次执行；CLI 与 App 共用这一限制。场景上限 2 MiB/2,000 元素；整个白板含图像与历史上限 32 MiB，单图 16 MiB；保留 12 次撤销和重做、128 个白板操作去重回执。截图为目标网页的 PNG，最多 4 MiB，通过附件传输；不通过聊天事件持续广播 DOM 或画面。

`applied` 必须有 `saved:true`；`applied_not_saved`、`conflict`、`not_executed`、`failed`、`unknown`、`cancelled` 分别表示不同事实。尤其浏览器导航失败可能已显示错误页，返回 `failed`，不能说未执行；IPC 在动作派发后断开则可能为 `unknown`，不得自动换编号重试。无目标 App、关闭/失效目标、旧版本、权限不足都有明确错误。Host 先校验来源和附件，再发一次性 admit；准备图片/上传素材后，App 在最后写入前再次检查取消与作用域。

## 原生浏览器

网页与 App 主文档分开：独立持久 session、无 App preload、无 Node、启用 sandbox/contextIsolation/webSecurity；不导入系统浏览器资料。浏览器 scope 由可信 App 身份生成，Bot 不能传 profile 路径或覆盖 actor/scope。密码等敏感输入不进入观察结果。

支持同页观察、点击、输入、选择、按键、滚动、截图、导航、用户授权上传/下载、登录弹窗与新标签。用户接管后 Bot 暂停；只有可信 UI 可恢复控制，恢复使旧元素引用失效。打开本机下载、清理网站数据、撤销作用域同样属于用户操作。表单/beforeunload、下载、媒体、活动任务不能为了省资源被静默丢弃。

最多六个存活网页/原生窗口，最多四个可见。超限只休眠可安全休眠的后台页，否则提示用户处理。隐藏不是停止：原生测试中不可见网页仍可能显示 `visibilityState=visible`，保留内存并继续少量工作；显式休眠/关闭才释放网页进程。主窗口隐藏到托盘、关闭网页和真正退出分别处理，不能把 Host 一起重启。

已知浏览器边界：不提供任意脚本执行；跨源 iframe/Shadow DOM 没有完整结构化操作和上传覆盖；HTTP Basic/客户端证书默认取消；网站阻塞式 alert/confirm 可能使动作超时并返回未知。站点对嵌入浏览器/登录的限制不保证绕过。网页未声明的未保存状态不保证识别。

## 验收证据与实测修复

外部原始证据根目录：`/Volumes/gdrive/taro-tmp.noindex/workbench-93-20261030`。所有验收使用独立状态、测试对话和 `.noindex` 输出；没有使用生产数据副本。

- Opus 5.5 独立审查了 Electron 实现及整合 diff；实际原生测试包含权限、session 隔离、用户接管、上传/下载、页面/渲染进程崩溃、helper 恢复、退出取消和真实退出。原生对话框通过测试入口记录并应答，不能称人工点按通过。
- Chromium 中真实 App/Host 验证四分屏、图表点击/隐藏系列、放大返回、主草稿保留、遮挡历史不误标已读、白板真实命令/保存/冲突/撤销、导入新白板、跨窗口只读和手机布局。浏览器 viewport 不是真机验收。
- 实际图像模型两轮：`real-model-1793364613363/report.json`。完整 App → 独立 Hub/Gateway → Codex 原生图片编辑 → 主聊天附件 → 原白板保存。第一轮 revision 3，第二轮 revision 5；第二轮原图 SHA-256 与第一轮真实成品一致，最终保留三张图。第二轮材料同时包含原图、标注预览和参考图。
- 真实模型验收查出并修复：工作台上传 strict schema 错把授权字段交给附件校验；持久模型 worker 第二轮沿用第一轮异步来源。后者已将工具（包括恢复后的 schema handler）绑定到本轮 AsyncLocalStorage，并补跨轮回归。
- 最后实测还修复：连接自动续期后工作台登记丢失；手绘矩形重开时空绑定规范化误增版本/撤销；网页全屏时关闭、卡死或自行退出留下全屏状态。用户先手动全屏的选择仍保留。
- 真实图表验收又查出每轮指令过长会被模型宿主截断，现将定位/安全信息压缩、完整契约通过 capability 按本轮冻结上下文读取。白板/改图格式在始终可用的 browser capability 中可读，不受交互组件开关影响；图表仍遵守组件开关。浏览器指南包含授权上传、休眠/唤醒和下载管理，并区分用户专属操作。报告发布返回真实消息块和版本，不能猜来源；工具回执文本包装须解包，缺失来源在工具派发前规范化拒绝。首次缺少 source 的打开请求被拒绝；使用同一报告的真实来源恢复后，下一轮改折线并增加系列成功，Tab ID 未变，未重复发布原报告。
- 最后补齐没有原生 App 工具的引擎入口：静态 CLI 契约、当前轮冻结上下文和窄图表发布。发布绑定 Bot/会话/真人来源/请求 ID，事务中重验凭据与投递状态；不借用 owner 控制器，也不要求用户手动重新打开每轮图表。构建后的 CLI 离线指南和独立 Instance/WS 发布、去重与拒权均已验证；没有额外调用 Kimi/Antigravity 真模型。
- 四分屏的 Shift+1 实测发现 Excalidraw 0.18.1 使用页面绝对工具栏坐标计算画布局部空间，下排内容缩小并移出视野。锁定 dev/prod 代码哈希的适配只修正这三处矩形的相对坐标；上游变动构建即失败。实际 Mac 四白板已回验居中可见，独立真实 App 测试还覆盖滚动回到内容。
- 整合复核另修复：请求取消误停别页、取消后继续写入、草稿哈希期间取消/切会话仍发送、恢复草稿窗口租约失效、关闭历史丢白板引用、白板与布局分两步删除、Widget 错误误判成功，以及同原生窗口多对话目标冲突。

## 验证清单与边界

| 检查 | 结果与范围 |
| --- | --- |
| Electron 单元 | 153 项通过，覆盖新增 browser contract/policy/page 与既有 lifecycle |
| 实际 Electron 原生 | all 26/26、最新 events 4/4、全屏退出定向 6/6 + 4/4；相关代码未再变化的 restart 1/1、quit 3/3、thirdparty 4/4 |
| Host / CLI / 工具 | 156 项相关回归通过；容量遗漏补链另有 27 项专项和真实 WS push/pull；工具说明、开关兼容、来源回执和非原生 CLI 闭环最终 87 项通过，计数重叠，不相加；最后发布版本保护修正后该 socket 文件 8 项通过 |
| 工作台页面 | Chromium 5 条功能旅程、WebKit 5 条；Report/Widget 既有交互 2 条回归 |
| 原图草稿与发送 | 4 条真实 App/Host 流程：哈希期间取消、切换对话、Bot 修改后用户撤销/重做、重载后绑定原白板 |
| 本地保存 / 迁移 | 实际 IDB 3 条 Chromium + 3 条 WebKit，新增原子删除 1 条；模型与迁移单元 19 项，持久草稿 15 项 |
| 原生旧数据兼容 | Rust migration 5 项通过、1 项测试夹具生成器忽略；添加 v10 store，不放开未知 schema |
| 构建与类型 | Host 471 模块构建、client 翻译校验/tsc/Vite 构建通过；根级完整 tsc 有既有 138 条诊断、60 文件，精确未改 base 同样 138 条，最终按文件路径与 TS 诊断代码计数相同 |
| 真实模型 | 两轮图片编辑与正常聊天交付、同白板回填；两轮结构白板编辑；图表创建后同 Tab 改折线并加系列；原生网页读取/输入/点击/选择/滚动/截图/导航通过 |
| 本地工作旅程 | 1 条实际 React/Hub/Gateway 旅程通过：标签改名/排序、键盘分区比例、主输入焦点、模拟断网绘图保存/重开、联网重载；执行中的侧边对话、草稿附件与回答保留（侧边引擎为 fixture） |
| 后续边界 | 白板/资产 21 项、真实四板 Fit 和滚动回到内容通过；连接恢复 6 项及 2 条浏览器续期/重新登记通过，另有原生续期通过 |

两次构建的根级 TypeScript 对照复用相同依赖，基线 2,186 个源码/配置输入的原始 blob 与 `cf2cf5674b859e63f2fd90e30da0df4acc8da748` 一致。最终增量对照按文件路径与诊断代码计数相同，不承诺修改后行列位置仍一致；它证明没有新增这一口径的诊断，**不代表全仓类型检查通过**。测试期间发现的夹具分块大小、过期 CLI 会话、网页 HTML 引号/字符集错误均已单独修正，失败记录保留，不能算成功样本。

## 资源、延迟和体积实测

完整 React App、实际 Electron 45.1.0 / preload / Rust helper、独立 Hub 与 CLI 的 Mac arm64 开发运行验收。RSS 为 Electron 主进程及所有子孙进程的 RSS 求和（含 helper，可能重复计共享页），不是物理独占内存；独立 Host/Gateway 和模型服务不在此进程树中。每阶段 20 次输入、10 条 Host 发布消息；输入量到下一动画帧，收消息量 Host publish 开始到 DOM 中出现。CPU 是约 2 秒内进程 CPU 时间差，占单核百分比，短窗口和 0.01 秒计量有噪声。

| 场景 | RSS MiB | CPU 单核 % | 输入 p95 ms | Host→DOM p95 ms |
| --- | ---: | ---: | ---: | ---: |
| 白板，无图片 | 435.4 | 2.0 | 18.0 | 97.8 |
| 白板，真实模型图片 1.35 MiB | 561.8 | 5.4 | 19.1 | 89.0 |
| 同白板收起/再开 3 次 | 703.5 | 5.9 | 18.4 | 92.9 |
| 收起工作台 | 706.0 | 1.0 | 16.1 | 85.2 |
| 1 个可见网页 | 602.3 | 1.0 | 17.4 | 93.7 |
| 2 个可见网页 | 744.4 | <0.5 | 15.7 | 97.2 |
| 4 个可见网页 | 960.0 | 1.0 | 17.3 | 87.3 |
| 关闭所有网页 | 585.0 | 3.4 | 15.8 | 94.7 |
| 收起工作台并空闲 10 秒 | 595.5 | 6.4 | 23.5 | 91.2 |

本轮本地预警阈值为输入 p95 <50 ms、Host→DOM p95 <250 ms，样本均通过；这是隔离 loopback 和测试网页的阈值，不是手机或公网 SLA。最初同窗纯聊天样本输入 p95 16.9 ms、Host→DOM 186.7 ms；未请求 Excalidraw/白板字体。原生页面从 1→4 个、关闭后，进程数实际增加再回落；隐藏后编辑器和写锁均释放，但模块缓存与 GPU 分配不会立即归零。不能用短样本证明无内存泄漏。

Opus 的另一组真实 Electron **测试桩 App** 使用 1,500 段文字和持续动画网页：0/1/2/4 页 RSS 373/505/660/967 MiB；4 页活跃约占单核 48%，切走后仍约 7–8%，休眠后约 1%。10 轮关闭/重开后 webContents、子视图、路由、监听和待执行任务回到原数。该组证明隐藏不是停止，不能替代上表 React/Host 实测。测试桩启动到桥接就绪仅两个样本 647/1,225 ms，不冒充完整 App 启动对照；恢复既有聊天的冷启动与长时间视频/CPU 曲线仍待补。

补测完整 React **全新配置首次引导**启动（实际 preload、迁移 Gate 和 Rust helper），交替运行 base / 工作台各 3 次：base 为 1,307/1,144/1,280 ms，工作台为 1,256/1,296/1,415 ms，中位数 1,280→1,296 ms。六次均未请求白板资源。该小样本只说明首次引导启动，未验证已有大型聊天数据的冷启动。

同一实际 Mac App 另测两张带真实模型图片、共四张独立白板：2/3/4 个可见白板的整进程 RSS 为 678/786/845 MiB，输入 p95 为 23.0/28.1/28.2 ms，Host→DOM 为 92.1/115.8/112.6 ms，仍在本轮阈值内。真实 Chromium/Host 的另外 17 次操作覆盖保存、图片、独立写锁、手绘未保存时关闭，以及重开后四张白板场景/图片哈希和 revision 相同。该 headless 样本输入 p95 较高（基线113、四板150 ms），受测试调度和负载影响；不能混成原生时延，也不以单次差值证明因果。

原生完整 App 还缩短了**仅测试设备**的会话有效期，触发正常续期：第二次认证后原窗口/Tab/来源登记恢复，已保存白板不变。旧实现用内容 JSON 去重，会漏掉连接换代；已改为认证会话代次也参与登记。

同一 Electron 基线、相同已安装依赖下分别构建精确 base 与工作台 client：未压缩 `client/dist` 从 35,328,969 增至 56,714,114 字节，增量约 **20.4 MiB**。其中 JavaScript 增量约 7.3 MiB，字体增量约 12.5 MiB。白板固定 0.18.1，分发 233 个字体文件、13,036,400 字节，并携带来源哈希、组件/字体许可及实际打包依赖的许可合辑。纯聊天不会提前下载这些白板资源。这是前端产物增量，**不是安装包增量，也不是整个 Tauri→Electron 的体积差异**。

原始记录外置盘保留，仓库保存[有界验收摘要](workbench-93/acceptance-summary.json)与[28 项逐项验收矩阵](workbench-93/acceptance-matrix.md)便于复核。

实际 Mac 开发运行验收：模型生成并更新的图表、可编辑流程图和两轮改图结果同屏；不是安装版 (historical image omitted from this clean snapshot)

## 待完成的实际验收

本地源码、浏览器测试、开发 Electron 运行不能替代以下边界。未满足前不关闭 #93，不宣称全平台验收完成：

- Windows 原生运行（用户此前明确暂时没有 Windows 环境，保留待验）。
- iPhone/Android 真机绘图/触控及电脑工作时手机真实网络切换、重连、控制桌面网页。
- 多显示器不同 DPI 拖动、实体中文输入法组字、原生权限/下载保存对话框的人工作用。
- 正式签名/安装包中的增量验收与体积测量；需等用户明确发版授权。

任何模拟、测试桩、开发运行时和真实模型证据均分别列明。完整 issue 保持开放，等待上述硬件与发布包验收；源码提交不代表已安装。

## 紧凑右侧面板修订

按用户截图反馈，删除「工作台 · 与主对话一起工作」独立标题行，把展开和返回聊天按钮合并到 Tab 栏右端。保留可访问名称、手机触控尺寸、标签横向滚动、原有主聊天输入框和分屏能力。

右侧显示复用侧边对话已有的 `useSideWindowExpansion`、`SidePanelResize`，并将两者的宽度分配、入场动画和原生尺寸等待样式统一到 `conversation-side-panel`。正常初始布局从主聊天右侧打开；用户主动展开到主区的布局仍可保留和还原。手机仍为单页工作台，不受桌面右栏样式影响。原生网页在 CSS 入场动画期间隐藏，结束后按最终矩形显示，避免 WebContentsView 与动画中的界面错位。

Opus 5.5 独立复核发现手机标签选择器遗漏前导点，已修正并增加实际字号回读；其余宽度、隐藏优先级、窗口恢复和草稿边界复核通过。验证包括真实隔离 Hub 的工作台操作、共享原生窗口协议夹具的出现时序、模拟 Electron 桥的最终网页矩形，以及原侧边任务/附件/草稿切换。此处的桥接夹具不是新的原生 Mac、Windows 或手机真机验收。

本轮客户端翻译检查、TypeScript 和 Vite 构建通过；最终 Chromium 16 项、WebKit 5 项通过。

CLI 不适用：仅修改客户端布局与原生网页显示时机，没有改变 Host 协议、工作台权限或命令行接口。本次不发版、不更新安装版，#93 既有待验收边界保持不变。

浏览器实际界面截图：桌面右侧工作台 (historical image omitted from this clean snapshot)、手机尺寸工作台 (historical image omitted from this clean snapshot)。此前原生验收截图保留为该轮历史证据。


## 工作台标题与相邻对话栏对齐

后续截图反馈要求恢复明确的「工作台」标识。首轮把文字放在 Tab 栏左端，与标签和操作按钮共用一行（后续小标签布局见下节）。桌面停靠时按相邻对话标题栏的实际高度对齐，窄窗口、界面密度导致左侧标题换行时也跟随；不反过来修改对话栏高度。手机和展开视图使用紧凑行高，保留原有安全区域与主输入框。

文字占用空间后，选中的 Tab 会在选择或栏宽改变时滚入可视区；只滚动标签条，不移动聊天记录。ResizeObserver 在隐藏、切换布局或卸载时清理；原生网页仍根据最终区域布局。

CLI 不适用：此次仅改变客户端标题布局，没有改动协议或工作台内容。未发版、未更新安装版。

客户端翻译、TypeScript 和 Vite 构建通过；Chromium/WebKit 各 3 项通过（桌面多标签/四分屏/展开还原、手机尺寸切换保留草稿、模拟原生桥的动画结束后尺寸投递）。桌面 1360/1000 px 下实测左右标题栏上下边缘一致、当前标签可见，按钮不溢出。桥接夹具不是新的原生 App 验收。

预览：桌面 (historical image omitted from this clean snapshot)、窄窗口 (historical image omitted from this clean snapshot)、手机尺寸 (historical image omitted from this clean snapshot)。


### 小标签移到标题下方（2026-10-31）

按新的截图标注，桌面停靠标题栏有至少 64 px 高度时，上方保留「工作台」和操作按钮，下方放横向小标签：11 px 文字、24 px 按钮、12 px 图标。整体高度仍跟随左侧标题栏，内容区不会被额外挤低。选中标签继续自动滚入可见范围。

ADHD 等不足两行高度的紧凑标题、展开视图和手机保持原布局与点击尺寸。CLI 不适用：仅调整客户端展示，不改变工作台内容、Bot 控制协议或持久化数据。

验证：客户端翻译、TypeScript、Vite 构建通过；原有 Chromium 3 项、WebKit 2 项回归通过，覆盖 1360/1000 px 左右栏对齐、标签/分屏/展开还原、手机尺寸切换、ADHD 浏览器作用域与草稿。已查看实际浏览器截图；未执行新的原生安装或真机验收。未发版、未更新安装版。

本次预览：桌面 (historical image omitted from this clean snapshot)、窄窗口 (historical image omitted from this clean snapshot)。


### 单页不再重复区域标题（2026-10-31）

以下记录当时的交互；后续[分屏入口修订](workbench-split-controls-2026-10-31.md)已移除单页的移出分屏操作，并将放大后的还原操作归入顶栏。

单页查看时，上方标签已经标识当前内容，因此移除下方重复的区域标题行。网页地址栏、笔记或图表内容直接接在标签栏下方。桌面多分屏和放大区域仍保留区域标题、移出区域及返回分屏按钮；单页的「移出分屏，保留标签」移至标签菜单，重命名和关闭入口仍在同一菜单。手机单页同样不重复标题。

CLI 不适用：仅调整展示与现有操作入口，不改变 Host/CLI 协议、持久化数据或授权。

客户端构建通过；原有 Chromium 3 项、WebKit 2 项回归通过，覆盖标签/四分屏/放大还原、手机切换、笔记分屏移出后的草稿与 Bot 目标。真实 Electron + Rust helper + 隔离 Hub 验证通过（无模型调用、未使用生产配置）：单页无重复区域标题、原生网页尺寸正确、总览往返保留网页表单与草稿、窄窗口和 Agent Bus 遮挡恢复正常，页面错误为空。未发版、未更新安装版。

原生窗口预览 (historical image omitted from this clean snapshot)。


### 图表、组件和保存说明统一去重（2026-10-31）

检查了工作台内网页、图表/交互组件、Markdown 笔记和白板的标题及状态栏。单页沿用上一轮只保留标签标题；Report 与 Widget 由工作台承载时不再生成内部标题栏和重复放大按钮。多分屏每个区域只留一处区域标题与控制按钮。网页及笔记正文、组件作者编写的内容标题保持原内容。

移除工作台全局「笔记与白板保存在本机」和重复展开提示。笔记/白板自己的已保存、未保存、只读、失败状态保留；组件隐藏标题栏后，重新加载移到错误区域，错误摘要和修复草稿入口保留。聊天里的独立 Report/Widget 继续显示原标题及展开操作。

CLI 不适用：这是展示层去重，未改变工作台 Host/CLI 协议、持久化数据和内容授权。

客户端翻译、TypeScript、Vite 构建通过。Chromium 工作台 6 项、WebKit 4 项、聊天组件回归 2 项，共 12 项通过：覆盖图表数据更新/失败回滚、四分屏放大还原、手机尺寸、ADHD 隔离、笔记编辑、组件运行失败后重载及正文保留。浏览器验证不是新的原生安装或手机真机验收。未发版、未更新安装版。

预览：单页 (historical image omitted from this clean snapshot)、分屏 (historical image omitted from this clean snapshot)、交互组件 (historical image omitted from this clean snapshot)。


### 桌面工作台标题字号（2026-10-31）

普通桌面「工作台」标题从 14 px 调整为 16 px，与左侧对话标题同为 600 字重。小标签仍为 11 px；手机标题保持 14 px，ADHD 紧凑标题保持 12 px，调整只作用于截图反馈对应的普通桌面布局。

CLI 不适用：仅客户端字号调整，未改变协议、数据或交互。未发版、未更新安装版。

客户端构建与 3 项 Chromium 回归通过，覆盖普通/窄窗口标题对齐、手机切换和 ADHD 浏览器。已查看调整后的窄窗口截图 (historical image omitted from this clean snapshot)。
