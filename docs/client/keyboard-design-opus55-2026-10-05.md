# 手机键盘与可见视口：布局分析与 CSS 设计（Opus 5.5，2026-10-05）

状态：**已交付 CSS 和本文档，尚未做任何验证**。本轮没有运行测试、构建、浏览器、模拟器或真机；文中所有高度，凡标注"估算"的，都是读 CSS 推算的，不是实测值。

## 交付与分工

| 文件 | 负责方 | 说明 |
|---|---|---|
| `client/src/viewport.css` | 本轮（新文件） | 只消费 `--app-height` / `--app-top` / `data-keyboard-open`，不读写 JS |
| `docs/client/keyboard-design-opus55-2026-10-05.md` | 本轮（新文件） | 本文 |
| `client/src/viewport.ts`、插件安装、`capacitor.config.ts`、import、tests | 父代理 | 本轮只读过 `viewport.ts`，未修改 |

沿用 Atelier 配色与动效 token。没有新增颜色、组件或动画，桌面布局不变。

## 真实布局分析

### 截图

- `01-chat-before.png`（390×844，无键盘）：顶部 header，底部 composer 卡片（草稿"检查手机键盘弹出时的输入位置…"，工具栏为附件 / 语音 / 协作 / 草稿已保存 / 发送）大约在 y≈725–836。
- `02-body-resize-before.png`（受控复现：body=500、window=844，不是实体键盘截图）：可见区域在 y=500（"01:06" 时间戳）处截断，composer **完全不在可见区域内**。

### 根因 1：外壳高度不跟随可见区域

- `.app-shell{height:100dvh;display:flex;overflow:hidden}`（`client/src/styles.css:10`）。`dvh` 跟随浏览器视口，不跟随 `<body>`。
- `capacitor.config.ts:7` 配置了 `Keyboard: { resize: "body" }`，但父代理确认插件并未安装。即使插件生效，`body` 模式也只缩 body，外壳仍是 844px，所以 composer 会落到 body 之外，和截图 02 一致。
- iOS Safari 这类浏览器弹出键盘时不缩小布局视口，而是平移视觉视口（`visualViewport.offsetTop > 0`），`100dvh` 不会扣除键盘高度。Android Chrome 默认也只缩小视觉视口。
- 其他全屏块也用了 `100dvh`：`.pairing-page{min-height:100dvh}`、`.loading-screen{height:100dvh}`（`styles.css:16`）；`.app-lock-screen{height:100dvh}`（`styles.css:38`）。

### 根因 2：外壳高度修好之后，聊天列内部仍会溢出

就算外壳高度正确，聊天列里 composer 也无法收缩：`.composer-wrap`、`.composer` 都是 `min-height:auto`，最低就是内容高度。消息区 `.message-scroll{flex:1}` 的 flex-basis 是 0，不参与收缩。列内放不下时，超出部分会被外壳的 `overflow:hidden` 从**底部**裁掉，最先被裁掉的正是工具栏和发送按钮。

下表是 500px 高可见区域的手机竖屏聊天列预算，数字来自 CSS 读取或估算：

| 区块 | 高度 | 来源 |
|---|---|---|
| header | 56 | `brand-theme.css:842` |
| 群话题导航 | ≈70–80（估算） | 话题栏 48（`brand-theme.css:859`）+ 上下文行 |
| 回到最新消息（in-flow） | 38 | `styles.css:62`、`brand-theme.css:525` |
| 多 Bot 选择 `.reply-bots` | 每行 ≈50，会换行 | 按钮 40（`brand-theme.css:889`）+ 下内边距 10；`flex-wrap:wrap`（`styles.css:60`） |
| 引用预览 | ≈40–45（估算） | 两行，引文单行省略（`styles.css:79`） |
| 附件草稿 | ≈150（估算） | 芯片行上限 95（`styles.css:81`）+ 标题 + 限额行 + 内边距 |
| 链接预览草稿 | ≈110–140（估算） | 标题行 + 44px 封面卡片 + 样式切换行 |
| 输入框（聚焦） | 60 | `calc(3em + 12px)` @16px（`brand-theme.css:903`） |
| 工具栏 | 48 | 44px 圆形按钮 + 4px（`brand-theme.css:905-909`） |
| composer 外边距 | 14–40 | `6px … max(8px, env(safe-area-inset-bottom))`（`brand-theme.css:901`）；Face ID iPhone 竖屏常见底部 inset 为 34px |

群聊里多 Bot、引用、附件、链接预览同时出现时，合计约 650px，比 500px 多出 ≈150px。这时消息区为 0，发送按钮被裁掉。即使只有附件和引用，在 440px 级别的可见高度（中文输入法候选栏更高）下，消息区也只剩很小一块。另外，"回到最新消息"出现时会占据 composer 的一行，导致消息区在用户回看时整体跳动 38px。

### 根因 3：弹层使用 dvh 或贴满布局视口

- `.modal-scrim{position:fixed;inset:0}`（`styles.css:15`）。设置类面板在手机上是底部 sheet，`max-height: calc(100dvh - …)`（`brand-theme.css:941-942`）。
- `dialog.creation-dialog.new-chat-panel`（`CreationDialog.tsx:11`）是 top-layer 弹窗，手机上 `margin:auto 0 0` 贴底，`max-height: calc(100dvh - …)`（`brand-theme.css:937`）。
- `.preferences-dialog{height:100dvh}`（手机，`brand-theme.css:948`）；`.file-center{height:100dvh}`（`file-center.css:12`）；`.operations-panel`、`.capabilities-panel` 为 `94dvh`。
- `.topic-directory-list{max-height:38dvh}`（`styles.css:74`）、`.forward-targets{max-height:26dvh}`（`styles.css:79`）这两个列表旁边都有搜索框。

在"平移视觉视口"的浏览器里，这些 sheet 贴的是布局视口底部，也就是键盘后面。如果 native resize 生效，WebView 本身变矮，`dvh` 应随之变化；这一点需要真机确认。

## 接口契约（以 2026-10-05 读到的 `viewport.ts` 为准）

- `--app-height`：可见高度（px），取 `innerHeight` 与 `visualViewport.height` 的较小值。双指缩放（|scale−1|>0.02）时这个值会**被移除**。
- `--app-top`：`visualViewport.offsetTop`（px），夹在 `[0, innerHeight − height]` 之间，缩放时同样被移除。native resize 下为 0。
- `data-keyboard-open`：只有窄屏或 coarse 指针下出现软键盘时才为 `"true"`，其余情况为 `"false"`，包括缩放。

CSS 这一侧的规则如下：

1. 只有 `data-keyboard-open="true"` 时才读 `--app-height` / `--app-top`。键盘收起时一律用 `100dvh`，和现在完全一致。
2. 变量缺失时（控制器未加载或正在缩放）回退为 `100dvh` / `0px`。
3. CSS 从不根据尺寸推断键盘，也就是不会把双指缩放当成键盘。高度媒体查询只看布局视口，不受 pinch 影响。

如果父代理改变这三个值的语义，需要同步检查 `viewport.css` 顶部注释。

## 设计

### 原则

- **空间优先级**：输入框和发送 > 消息列表 > 挂在 composer 上的附属内容（附件、链接预览）。附属内容只缩成"可原地滚动"，不会被隐藏。
- **临时让位，而不是长期隐藏**：只有两处会让控件暂时消失，而且都要求"键盘打开"**并且**"对应输入框有焦点"两个条件同时成立。失焦或收起键盘后立即恢复。即使属性卡在 true，也不会长期隐藏任何功能。
- **不新增动效**：本文件改动的几何属性在已读 CSS 中都没有 transition，布局与键盘在同一帧落定。`prefers-reduced-motion` 继续沿用 `styles.css:18` 的全局关闭，本文件没有任何依赖动画结束才显示的内容。
- **保留缩放**：不碰 `touch-action` 和 viewport meta。各处下限都用 rem/em，跟随用户字号放大。

### 外壳与全屏页（窄屏或触屏）

- `.app-shell` 高度改用 `var(--shell-height)`。键盘收起时为 `100dvh`，打开时为 `--app-height`。
- 键盘打开时，外壳改为 `position:fixed; inset: var(--app-top) 0 auto`，钉在视觉视口上。它不是 transform，所以内部的 fixed 弹层仍然相对视口定位。native resize 下 top 为 0，几何效果与 static 相同。
- `.loading-screen`、`.app-lock-screen`、`.pairing-page` 同样跟随可见高度。配对页在打字时改为顶部对齐，不在缩小后的空间里重新居中，避免卡片跳动。

### 聊天列

- `.message-scroll`：唯一的弹性区域，`overscroll-behavior-y: contain`，不把回弹传给页面。
- `.composer-wrap`：改为纵向 flex，`max-height: 60% × 可见高度`，可以收缩。空间不够时由它让步，而不是被外壳从底部裁掉。
- `.composer` 内部的让步顺序：
  1. 附件草稿、链接预览草稿先缩（`flex-shrink:40`），最低保留 3.25rem，之后在原地滚动。
  2. 输入框再缩，最低一行（`1.5em + 20px`）。
  3. 正在录音的区块、"显示链接预览"按钮、工具栏都不缩。
- **兜底**：字号极大时 composer 自身可以滚动，工具栏 `position: sticky; bottom: 0`，附件、语音、停止、发送始终可见。
- **多 Bot 选择**（手机，以及横屏触屏）：改为单行横向滚动，末端渐隐，和话题标签同一手法。不再随 Bot 数量增加行数。
- **回到最新消息**（手机）：浮在消息区底部（z 低于命令菜单），不再占用 composer 一行，出现时消息区不再跳动。
- 键盘打开时，composer 底部内边距从 safe-area 改为 8px。此时输入框贴着键盘，不再贴着 home indicator。

### 首页（手机）

`.mobile-home` 本来就是外壳高度的 100%，会自动跟随。只有在键盘打开**且**搜索框有焦点时才隐藏底部 tab bar，这与原生 IM 中键盘盖住 tab bar 的观感一致。

### 弹层

键盘打开时：

- `.modal-scrim` 只覆盖可见带：`top: --app-top`，`height: --app-height`。底部 sheet 因此贴在键盘上沿。
- 设置、运行状态、Skills 这类 `.settings-panel` sheet，以及 `.new-chat-panel`：`max-height` 按可见高度计算。
- 文件中心：`max-height` 等于可见高度，并去掉底部 safe-area。
- top-layer 弹窗 `dialog.creation-dialog:modal`（创建 Bot / 群 / 话题等）和 `dialog.preferences-dialog:modal`（设置）：通过 `top` 和 `bottom: calc(100% − top − height)` 把可布局带限定在可见区域内。现有的 `margin:auto 0 0` 继续让手机 sheet 贴底；平板弹窗仍在带内居中。
- 话题目录、转发目标列表：高度按可见高度的 26% / 24% 计算，最低 6rem，给搜索框和其他内容留出空间。

### 输入框 16px 下限（窄屏或触屏）

iOS 在聚焦字号小于 16px 的输入框时会自动放大并保持放大。这会改变阅读比例，`scale≠1` 还会让控制器放弃测量。`font-size: max(16px, 1em)` 去掉了这个触发条件，同时不禁用双指缩放；用户放大字号时仍以更大的字号为准。已确认：在 `client/src` 的 CSS 里，没有任何输入框字号大于 16px 的规则（grep 无匹配），所以这条下限不会让任何输入框变小。

### 极矮视口（横屏加键盘，高度 ≤360px，触屏）

只有在 composer 有焦点且键盘打开时，群话题栏才暂时让位，header 恢复分隔线。注意这一档依赖布局视口变矮（native resize）；在平移式浏览器里不会触发，但核心的 composer 让步规则仍然能保住发送按钮。

## 需求对照

| 要求 | 做法 |
|---|---|
| 输入框和发送可见 | 外壳跟随可见高度；composer 可收缩；附属内容先让；工具栏 sticky 兜底 |
| 消息区可滚动 | 唯一弹性区；composer 最多占 60% |
| 附件、引用、多 Bot 不挤走主要操作 | 附件、预览原地滚动；引用两行（原本已有单行省略）；多 Bot 单行横滑 |
| 创建 Bot、群、话题、设置可滚动 | 弹层限定在可见带内，max-height 按可见高度计算；内容区原本就有 overflow |
| 动效不延迟键盘 | 不新增 transition 或动画；几何属性没有过渡 |
| 减少动效不破坏 | 不依赖动画；沿用全局 reduce |
| 保留缩放、不把双指缩放当键盘 | 只读控制器的键盘属性；缩放时变量被移除，回退到 dvh；16px 下限避免自动放大 |
| 不改桌面 | 所有规则都在 `(max-width:760px)` 或 `(hover:none) and (pointer:coarse)` 之内 |
| 不新增长期隐藏 | 仅两处让位，都要求"键盘打开 + 对应焦点"同时成立 |

## 风险与已知限制（均未验证）

1. 键盘打开时外壳在 static 和 fixed 之间切换，会形成新的层叠上下文。已核对：图片灯箱和文件预览通过 portal 挂到 body（`Content.tsx:40,129`）；`.host-error` 的 z 值为 250；非活动主机是内联 `display:none`（`HostApp.tsx:180`）。没有逐一审计所有 fixed 元素。
2. 切换 position 后，`.message-scroll` 的 scrollTop 预期会保留，但**未验证**。需要测试键盘开关前后的滚动位置。
3. CSS 做不到"贴底锚定"：浏览器的滚动锚定保住的是顶部内容。用户处于"跟随最新"状态时，键盘弹出后需要 JS 再滚到底。没有确认 `App.tsx` 现有逻辑在容器变矮时是否会重新贴底。
4. iOS Safari 平移模式下，外壳 top 通过 rAF 跟随 `offsetTop`，平移动画期间可能落后一帧。native resize 不受影响。
5. top-layer 弹窗用 `bottom: calc(100% − …)` 时，假设包含块是布局视口，需要 iOS Safari 实测。
6. 16px 下限会**可见地**放大一些原本 12–13px 的字段（链接预览样式 select、文件中心筛选、设置 select、卡片表单、历史搜索筛选），需要做视觉验收。特异度高于 `(0,1,2)` 的小字号规则不受覆盖，没有穷举审计。
7. `.composer` 改为 flex 列加滚动容器后，录音区块和链接预览同时出现时外边距不再折叠（间距 8px 变为 16px）。
8. 兼容性：`:has()`、`:modal`、`:is()` 需要 Chrome/WebView 105+ 或 Safari 15.4/15.6+。不支持的引擎会跳过对应规则，退回现状，不会报错。
9. Android WebView 的 resize 行为（adjustResize、edge-to-edge）需要真机确认。本轮没有读原生工程。
10. 没有读消息内问答表单（`QuestionForm`）、`PdfReader`、`DelegationDialog`、`ShareInbox` 的内部结构。消息内输入框依赖浏览器聚焦时的滚动行为。

## 给父代理的集成清单

1. 在 `main.tsx` 中 import `./viewport.css`，建议放在所有 CSS 之后。各选择器的特异度已经高于被重述的规则，顺序不是硬性要求。
2. 安装键盘插件，设置 `resize: "native"`（父代理负责）。
3. 建议的自动化检查（mobile 390×844，人为设置 `--app-height:500px`、`data-keyboard-open="true"`）：
   - `.send-button` 和 `textarea` 的底边 ≤ 500，`.message-scroll` 高度 > 0；
   - 群聊加 3 个附件、链接预览和引用时，发送按钮仍然 ≤ 500；
   - `.reply-bots` 只有一行高度；
   - 显示"回到最新消息"前后，`.message-scroll` 高度不变；
   - `CreationDialog` 和设置 sheet 的底边 ≤ `app-top + app-height`；
   - 键盘开关前后 `.message-scroll` 的 scrollTop 不变；
   - 桌面 1280×800 下 computed style 不变（外壳为 static，composer 为 block）；
   - `prefers-reduced-motion: reduce` 下结果相同；
   - 移除变量后布局回到 100dvh。
4. 真机矩阵：iOS 原生（native resize）、iOS Safari（平移，`--app-top > 0`）、Android 原生、Android Chrome；竖屏和横屏；中文输入法候选栏；外接或悬浮键盘不应被判为键盘态。


## 父代理集成补充

以上保留 Opus 原始设计及未验证声明。后续发现和修正、实际截图、最终浏览器及根检查结果，见 [父代理验收](keyboard-qa-2026-10-05.md)。配对页的最终 CSS 增加了独立滚动边界；创建焦点与头像比例也由父代理补齐。
