# 工作台「演示文稿」（原 Baoyu Design 画布与 Baoyu PPT 已移除）

> **变更说明（#89）**：Baoyu Design 画布编辑器（`claude-design`、`client/vendor/baoyu-design`、`skills/baoyu-design`）已从工作台移除，没有替代的画布编辑器。1.6.0 及更早版本留在本机的画布项目不再打开、编辑、导入、共享或交给 Bot 读写，只能导出或删除：画布标签页显示「导出项目」，「设置 → 工作台文件」中该项目一行显示「导出」，两处都保存与「备份项目」相同格式的 `.tarobot-design.json`（1.6.0 及更早版本可以导入它，本版本不能）。`design.open` / `design.create` 仅接受 `format: "slides"`，画布请求返回 `design_canvas_removed`。演示文稿能力由 `workbench.design.slides.v1` / `design.slides.v1` 承载；为保持与 v1.6.0 旧版 App/Host/Gateway 的跨版本互操作，Host 在兼容周期内继续声明 `workbench.design.v1`（App 仅在 Host 同时声明两者时附带声明 `design.v1`），并统一在派发前拒绝所有画布操作。
>
> **变更说明（#90）**：Baoyu PPT 编辑器（`client/vendor/baoyu-slides`）和 `skills/baoyu-ppt` 技能已移除，改用 Apache-2.0 的 Open Artifact 幻灯片编辑器（`client/vendor/workbench-slides`，`@open-artifact/slides-editor` 0.14.6）。项目格式不变（`project/deck.json` v4 加 `project/slides/<id>.html`），1.6.0 的 PPT 项目不迁移、直接由新编辑器打开。入口为 `+ → 演示文稿`、`+ → 导入演示文稿 (.pptx)` 和 `+ → 导入项目`（`.tarobot-design.json`）。手机以及宽度不超过 760 px 的窗口只能预览（显示「手机端仅预览」），不能新建或编辑。

工作台的 `+ → 演示文稿` 使用 [Open Artifact](https://github.com/JimLiu/open-artifact)
的幻灯片编辑器，支持编辑幻灯片、文字、形状、表格和图片；可以让当前对话里的 Bot
读取、创建并修改演示文稿。不是跳转到网站，也不需要启动另一项本地服务。

1.6.0 编辑器保存的项目在新编辑器中的打开情况由 `client/e2e/workbench-legacy-1.6.0.spec.ts`
用真实的 1.6.0 数据（`client/e2e/fixtures/legacy-1.6.0/`）验证。已知的一处写法差异在读取时处理：
1.6.0 工具栏插入的形状存为 `top:50%; left:50%; transform:translate(-50%, -50%)`，新编辑器的
`<x-shape>` 只接受 `rotate()`，因此交给编辑器的文本里把位移折算进 `left`/`top`
（`client/src/workbench-slides-legacy.ts`）；本机存储的文件不改，用户编辑该页后才按新格式保存。

## 使用与保存范围

- 每个设计是当前设备、当前主机身份、当前用户、当前对话中的独立工作台内容。
- 自动保存到本机 IndexedDB；关闭标签保留内容，可从「全部标签和已关闭内容」重新打开。
- 「删除这个设计」只删除当前选中的设计及其本机内容，不影响同对话的其他设计、白板、笔记或聊天。
- 「备份项目」保存完整 `.tarobot-design.json`，包含幻灯片、素材和文件，可通过 `+ → 导入项目` 创建独立副本（导入旧画布备份会返回 `design_canvas_removed`）。
- 目前不跨设备同步设计。手机与另一台电脑不会自动获得本机设计；需要导出后在目标设备导入。
- 单设计最多 32 MiB / 512 个文件，单文件最多 8 MiB。网络资源、CDN 字体和本机路径不在设计预览中开放。
- 当前仅集成演示文稿编辑器（canvas 画布编辑器已在 #89 移除）。上游的其他编辑器、服务端与模型调用功能未搬入。
- 底部「备份项目」保存可重新导入的项目；编辑器的 Export 菜单另提供 PowerPoint (.pptx)、PDF、网页 (.html) 和当前页 PNG 导出。

## Bot 与 CLI

使用 `workbench.design.slides.v1` Host 能力和 `design.slides.v1` App 注册能力（兼容周期内为 v1.6.0 PPT 互操作保留 `workbench.design.v1` / `design.v1`，但所有画布请求均以 `design_canvas_removed` 拒绝）：
`design.open`、`design.create`、`design.read`、`design.publish`。原生 App 工具与
`tarobot workbench guide widgets|browser` / `tarobot workbench run` 使用同一合同，
具体 JSON 由 `src/gateway/design-guidance.ts` 给出。

操作绑定当前消息的设备、窗口、对话和标签；未授权、旧 Host、不在线或隐藏的工作台不能借其他目标执行。
读取得到实际 revision，修改需要 expectedRevision；文件批量更新全部成功后才落库。
手动编辑先 flush，Bot 修改时暂时冻结该编辑器的输入，避免覆盖尚未提交的文字。
持久化后的写入 requestId 回执随设计保存；写入结果不确定时，只能用原 requestId 和原内容核对，不能换新 ID 重复写。
只读请求的持久回执可能只保留摘要、不含 `result`，这不表示文件为空。需要重新取得正文时，用新 requestId 对同一明确目标重新 `design.read`；这条只读恢复规则不适用于创建、发布等写入操作。
`applied + saved:true` 只证明保存，不能代替画面渲染或真机验收。

旧原生工具线程保持历史摘要；新线程使用当前合同。`design.open/create` 仅接受 `format:slides`，需要 Host 的 `workbench.design.slides.v1` 和 App 的 `design.slides.v1`，缺少 `format` 或传入 `format:canvas` 均返回 `design_canvas_removed`。旧线程可使用当前回合 CLI。
用户要求把演示文稿/PPT 放到工作台时，Bot 用 `design.open`（`format:slides`）打开工作台演示文稿并按本格式发布；只要一个独立 .pptx 文件时仍使用引擎自带的演示技能。不再有 Baoyu PPT 技能，也不再给每个回合附加 PPT 选择说明（#90）。用户明确要求用 Baoyu Design 做画布时，Bot 只说明画布已移除、已有项目可由用户在 App 中导出，不推荐其他产品。ADHD 不自动展开。旧的接入过程见[技能与 PPT 接入记录](baoyu-design-ppt-skills-2026-11-03.md)。
设计文件路径是 App 内容命名空间，不是 Host 文件路径，也不给 Bot 新增系统权限。

## 安全和生命周期

`client/vendor/workbench-slides/UPSTREAM.json` 记录上游仓库、提交
`132c038529e4527d1bc30561a855ffd958aa7302`（`@open-artifact/slides-editor` 0.14.6）、对上游源码所做九处修改的说明，
以及每个随附文件的 SHA-256；构建时逐文件校验。随附的是已经构建好的包，那九处源码修改本身不在本仓库。
`client/design-assets.ts` 在构建时再对包内明确入口做精确匹配修改，匹配失败终止构建。

固定可信 `design-loader.html` 只跳转到一个不含项目数据的 data URL。编辑器随后在独立
opaque origin 中初始化，项目代码从不进入 App origin。`allow-same-origin` 仅用于让
上游访问它自己的嵌套画板 DOM；data 文档仍不能读取父 App 的 DOM、cookie、存储或原生桥。
主 App 的 `script-src 'self'` 保持不变。编辑器的独立 CSP 禁止网络、表单、弹窗和原生能力。
Electron 从 `tarobot-widget://sandbox` 加载固定入口；手机需要现有主框架原生消息隔离保护。

每个编辑器只有一个绑定到该标签的 MessagePort。路径、大小、文件数、摘要、版本均校验；
没有 Host 文件读取、任意 native IPC 或自动发送聊天任务接口。导出需要真实用户操作，
取消保存不能报告成功。App 菜单和对话框显示时，编辑器让出显示和输入区域。
关闭/切换时等待上游 flush 后销毁页面；失败时保留编辑器并提示，不能假装已保存。
正常退出桌面 App 时，主进程先请求每个设计锁定输入、结束当前文字编辑并等待真实保存。
只有仍保持锁定且保存成功的同一个编辑器才可复用这次确认；取消退出、重载或新打开的设计
都必须重新检查。保存失败、异常或超时会取消退出并恢复编辑，迟到的回执不能恢复旧许可。
安装更新也先等待设计保存，再替换程序文件；实际退出仍检查当前编辑器和浏览器页面。
此时 Bot 修改会收到「应用正在退出或更新」说明，不会覆盖正在保存的设计。

直接浏览器关闭或页面重载使用保守的确认提示，干净设计也可能提示；不增加 sandbox 模态权限。
原生渲染进程仍活着但 11 秒内不能确认保存时，会取消退出；这是保守退出的使用限制。
强制退出或系统终止进程不能保证尚未持久化的内容保留。

数据库升级到 v12，新增 workbenchDesign。创建/删除内容与标签布局在同一 IDB 事务内完成。
桌面迁移导出、导入和原生校验允许此新存储，按单条读取较大设计记录；旧 v9–v11 可升级，
不允许把新数据降级到不能保存设计的旧 schema。完整本机重置包括设计存储。

## 不同对话里的 Bot 遥控

同一个 Bot 的不同对话，也各有自己的设计。操作绑定当前用户消息所属的对话以及明确的
设备、窗口、标签，不会因为切换了聊天或设计标签而把待执行操作转到另一份设计。
工作台未打开、已隐藏或目标已关闭时，Bot 会收到失败原因，不会另选一个设计执行。

读取可以沿用发消息时冻结的完整目标；写入必须明确指定具体设计的完整目标。
Bot 新建设计后应使用创建回执中的标签编号，不能继续套用新建之前的选中项。
两个设计可能恰好有相同版本号，因此版本号不能代替目标身份。
新操作要使用新请求编号；同一轮同一操作重试才沿用原编号，避免把旧操作回执当作新成功。
详见[跨对话遥控审计](design-conversation-control-2026-10-31.md)。

## 许可与验证

演示文稿编辑器核心来自 Open Artifact，采用 Apache-2.0；随附上游原样的 `LICENSE` 和 `NOTICE`。发布资产包含
`licenses/workbench-slides/LICENSE`、`NOTICE`、`UPSTREAM.json` 和 `THIRD-PARTY-NOTICES.txt`。
最后一个文件由本仓库编写：上游没有为包内编译进去的第三方代码和 Inter 字体提供声明。它列出在包内能确认的组件及其许可文本，
并在文件内写明哪些组件的声明尚缺、哪些依赖未在包内找到；目前不完整。
「设置 → 关于 → 致谢」与 `LICENSING.md` 由 `third-party/acknowledgements.json` 生成，其中列出 Open Artifact、Excalidraw 和 Vditor；许可证约束由相应原文决定。

## 整合复查与修复

以下表格与本节之后的验证结果记录的是 2026-10 至 2026-11 初对 Baoyu 编辑器的整合过程，保留作历史参考；其中的上游指当时的 baoyu-design。

| 实际发现 | 修复与验证边界 |
| --- | --- |
| 上游已镜像文字到预览，但编辑模型仍标记未提交，关闭时等待保存失败 | 先调用上游原有编辑 settle，再等待其 publish/dirty 检查；手动改字后立即关闭、重开、导出和导入均验证，未绕过保存结果。 |
| 隔离预览无法直接读取上游 `/_blob/` 素材地址，实时更新还会覆盖初次替换 | 初次与实时预览使用本设计的 Blob URL；保存转换回稳定素材引用，导出不携带短期 Blob URL。真实 Electron 验证了图片刷新及带图片的手动编辑。 |
| 原路径检查拒绝中文名和复制操作生成的带空格名称 | 接纳受限 Unicode 文件名及空格，继续拒绝目录穿越、编码分隔符和保留对象键。 |
| body 下的编辑器层级低于手机工作台背景，DOM 显示正常但画布被遮挡 | 按实际工作台层级放置编辑器；菜单和对话框仍使其隐藏。回归检查实际命中元素，避免仅依赖 DOM 可见性。 |
| 重试可能沿用失败的保存队列、持久化后刷新失败可能误报未执行 | 保存队列可恢复，保存成功回执和刷新结果分开；同 requestId 持久回执防止重复写。 |
| 上游代理及评论入口没有对应 TaroBot 处理能力 | 不向编辑器声明这些能力；Bot 使用已有对话与共享工作台工具，不从设计内自动发送新任务。 |

资源随设计保存在本机；静态素材引用已验证，任意动态脚本构造网络地址不在支持范围。
编辑器包延迟加载，主页不预载整套编辑器；设计预览不能联网获取外部字体或脚本。

后续全面审计还修复了：Unicode 中间偏移读取断开 emoji、Bot 更新后画布不再跟随
面板缩放、已打开的编辑器不跟随 App/系统主题，以及直接退出 App 时尚在编辑的文字
可能丢失。主题变化保持当前编辑器；不再因拖动分隔线写 CSS 变量而重复读取样式。
详见[发版后审计与验收边界](post-1.0.122-audit-2026-10-31.md)。

## 验证入口与结果

回归入口：
- `client/tests/workbench-design.test.ts`：文件边界、批量原子更新、CAS、重试、回执和 Unicode。
- `tests/hub-workbench.test.ts` / `tests/workbench-cli-tools.test.ts`：授权与目标、App/CLI 合同。
- `client/src/desktop-migration.test.ts` / `tests/widget-format-policy.test.ts`：迁移与旧线程兼容。
- `client/e2e/workbench-slides.spec.ts` / `client/e2e/workbench-slides-multipage.spec.ts`：实际演示文稿编辑器、手动编辑、PPTX 导出、Bot 修改与窄屏多页。
- `client/e2e/workbench-legacy-1.6.0.spec.ts`、`client/tests/workbench-slides-legacy.test.ts`：1.6.0 编辑器保存的 PPT 项目（普通多页、带设计系统）在新编辑器中打开、编辑、保存和导出；1.6.0 画布项目只能导出。数据来源见 `client/e2e/fixtures/legacy-1.6.0/README.md`。
- `client/tests/workbench-presentation-pptx.test.ts`：`.pptx` 导入。
- `client/electron/tests/design-quit.test.mjs`、`updater.test.mjs`、`lifecycle.test.mjs`：退出保存、取消、超时、安装前保存与实例许可边界。
- `client/electron/tests/slides.smoke.mjs --lab <.noindex> --cache-root <.noindex>`：真实隔离 Electron 的 CSP、PPT 演示、保存刷新和销毁。

初次集成的定向逻辑回归 192/192、Electron 资产/安全/迁移单测 15/15 通过，Host 与客户端构建通过。
Chromium 4/4、WebKit 4/4 的工作台端到端用例通过，包含真实手动改字、立即关闭与重开、
导出/导入独立副本、删除副本保留原件、手机命中层级、菜单让位、分屏目标与 revision。
真实隔离 Electron 验证使用生产资产协议、CSP 和 preload，覆盖真实上游画布、隔离、
Bot 文件更新后渲染、离线素材、手动保存可移植引用与关闭销毁；未使用生产 Host。
Bot 流程使用真实 Hub/工作台接口和测试请求，不冒称真实模型任务或物理手机验收。

后续审计的最终结果另见[发版后审计记录](post-1.0.122-audit-2026-10-31.md)，不要把初次集成和后续重复用例相加。

本次不发版、不替换安装版。浏览器手机尺寸测试不等于 iPhone/Android 真机验收；原生测试使用
独立 Electron 状态目录，不使用用户的生产 Host、设计或对话。

Upstream 2.7.1 LAN sharing, roles and the Share button require its standalone local server and are not included in TaroBot. The unused `editor/share-ui.js` is excluded from the vendored subset; the embedded editor remains isolated behind the existing App/Host permissions.

## 底部栏精简（2026-11-04）

画布和 PPT 底部隐藏 TaroBot 的“共享”入口，移除常驻“本机保存 · 当前对话”提示。
保存中、尚未保存和错误重试提示继续显示，自动保存与已有共享协议不变。
这是 App 的展示调整，无新增 Host 能力或 CLI 命令；本轮不发版、不更新安装版。
共享组件回归在隔离浏览器中明确解除入口隐藏后运行，用于保留协议覆盖，
不能当作产品仍显示共享入口的证据。
验证：客户端类型/翻译检查与构建、根构建通过；Chromium 5 项、WebKit 3 项通过，
覆盖桌面/窄屏画布、PPT 保存重开和既有共享组件，已查看桌面、窄屏及 PPT 截图。
