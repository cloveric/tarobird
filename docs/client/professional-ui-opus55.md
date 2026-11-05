# TaroCub 专业工作界面（Opus 5.5 主导）

取代 `brand-upgrade-acceptance.md` 中的奶油/陶土 + 动物插画方向。
本文件只记录设计与实现；浏览器截图验收由上级流程执行，此处**没有**截图证据。

后续实测与修正见 [professional-ui-acceptance.md](professional-ui-acceptance.md)。实测后已移除本提案新增的顶栏“正在回复”提示（等待用户回答时不应显示为正在输出），扩大手机消息操作点击区域至 44px，并修正手机设置页的全屏尺寸。下文保留 Opus 初版设计记录。

## 设计依据

反馈："界面和动效很不专业……太低龄"。对照 `screenshots/professional-ui/before-*.png`，问题集中在：

- 狮子吉祥物与动物默认头像出现在侧栏、消息、空状态、配对页等日常工作界面；
- 金/陶土/薰衣草/绿多色并用，奶油底色上叠加粉彩底块；
- 胶囊按钮、卡片套卡片、阴影叠阴影，圆角 12–22px；
- 欢迎页逐项淡入、气泡弹出、头像环持续旋转/呼吸、按下缩放。

新方向：中性石色/石墨表面，**只用一个强调色**（taro 靛蓝）；层级靠字号、字重、间距和发丝分隔线表达，而不是每块都套卡片；动效只做 120–180ms 的功能反馈。

## 实际改动

| 区域 | 改动 |
|---|---|
| 主题 `brand-theme.css` | 整体重写（不是在旧主题上追加覆盖）。浅色/深色两套完整 token；圆角刻度 4/6/8/10/12；阴影仅用于浮层与对话框；`--blue`/`--selected` 仍是强调色别名，功能样式表无需改名。全局 lucide 线宽 1.75。 |
| 标识 `BrandScenes.tsx` | `BrandLion` → `BrandMark`：强调色方块内放 lucide `Layers` + "TaroCub" 字标，用于侧栏、配对页、加载页（加载失败页只用图标）。工作界面中不再出现手绘插画。 |
| 默认头像 `Avatar.tsx` | 没有自定义图片的 Bot 显示首字母（"研究助手"→"研"，"Research Bot"→"RB"；以符号/emoji 开头的名字回退到 Bot 图标）。触发条件与原"伙伴动物"完全一致（`!avatar.hasImage` 且 profile 已知），blob/缓存/revision 逻辑未改。人物为圆形，Bot/群组为圆角方形（26%），裁剪预览随 `kind` 切换形状。 |
| 侧栏树 `ConversationList.tsx` | Bot → 独立对话、群组 → 话题：父行 28px 头像；子行挂在父级的 1px 引导线上，对话只显示文字，话题显示 `#`；选中项为中性底色，并把引导线对应的一段点亮为强调色。置顶区保留头像。分区标题不再强制大写，计数改为等宽数字。 |
| 顶栏 `App.tsx` | 高 52px，头像 28px；"新对话"为描边次级按钮；连接状态改为无边框文字按钮（绿色只出现在图标上）；Bot 处于 pending/streaming 时副标题追加真实进度"正在回复"（spinner）。移除输入框下方"你的本地 AI 工作伙伴"宣传语。 |
| 话题导航 | 话题胶囊改为下划线标签：当前项靠颜色和 2px 强调色下划线标识，字重不变，切换时不重排。 |
| 消息区 | 阅读宽度 780px，输入框与之对齐；用户消息为中性石色气泡（8px 圆角）；卡片去阴影，统一 1px 边框；引用条 2px；运行状态从金色胶囊改为灰色文字 + 强调色 spinner。消息操作行高度固定，显隐不改变行高。 |
| 欢迎页 `WelcomeHome` | 去掉狮子、光晕和逐项淡入。标题"开始工作"；三个操作做成一个带分隔线的列表（首项图标用强调色）；下方"工作结构"两列说明 Bot/对话与群组/话题的关系。三个按钮的可访问名称未变。 |
| 空状态 | 群组/话题空状态改为无边框的居中文字，CTA 为主按钮；直聊空状态改为不加框的介绍区，底部一条分隔线。 |
| 配对页 | ≥960px 时左侧为表单卡片，右侧用分隔线隔开"如何连接"三步。步骤写的都是真实操作：`tarocub hub service start`、首台设备手动填写地址或在已配对设备上显示二维码、`tarocub hub devices approve <配对码>`，以及安全说明。删掉的装饰：特点 chip、渐变标题线、动物队列。扫码按钮加了 `QrCode` 图标；h1 仍是"连接你的 TaroCub"。 |
| 设置 `PreferencesPanel.tsx` + CSS | 按系统偏好设置面板来做：左侧导航用中性图标，不再按分类上色，选中项为中性底 + 强调色图标；每页首个 h3 是页面标题，其余 h3/h4 是 12.5px 分组标题；外观三项放进 `.settings-group` 圆角分组，行间有分隔线，控件右对齐（240px）；说明文字移到分组下方；危险操作统一为红色描边。手机端为分组列表（首尾圆角），切换为整屏 sheet。 |
| 其他面板 | 对话管理/运行状态面板中的 h3 加顶部分隔线；快捷操作、文件中心、仪表盘、诊断统一为 6/8px 圆角和中性次级按钮。 |
| `index.html` | `theme-color` 更新为新背景色（`#fdfdfc` / `#1c1c1a`）。 |
| `locales/en.json` | 新增 13 条中英映射，没有只有英文的装饰性眉题。 |

### 主要 token

| | 浅色 | 深色 |
|---|---|---|
| canvas / bg / raised | `#f6f5f2` / `#fdfdfc` / `#fff` | `#171716` / `#1c1c1a` / `#222220` |
| text / grey / muted | `#1d1c1a` / `#4d4a45` / `#6a665f` | `#ecebe7` / `#c3c1bb` / `#9a978f` |
| accent / primary | `#4a47b5`（白字 7.3:1） | 文字 `#a4a2f4`，填充 `#5b58d6`（白字 5.5:1） |
| border / strong | `#e6e4df` / `#d3d0c9` | `#30302d` / `#43423e` |

`--muted` 在 canvas、hover、选中行上均 ≥4.5:1（以上为按 WCAG 公式手算，需上级用工具复核）。

## 动效规格

| 场景 | 时长 / 曲线 | 属性 |
|---|---|---|
| 按钮、行、输入框的 hover/focus | 120ms `cubic-bezier(.2,0,0,1)` | background-color, border-color, color, box-shadow |
| 消息操作显隐 | 120ms | opacity（高度预留） |
| 遮罩 / 命令菜单 / 回到最新 | 120ms linear | opacity |
| 对话框进入（modal、`<dialog>`） | 160ms | opacity + translateY(4px→0) |
| 手机设置 sheet | 180ms | opacity .6→1 + translateY(16px→0) |
| 手机侧栏抽屉 | 180ms | `.sidebar` transform（功能性） |
| 头像回复状态环 | 160ms | 仅 box-shadow；**静态**，不循环 |
| 卡片折叠箭头 | 160ms | 箭头 svg 旋转 |
| 进度 spinner / 录音点 | 1.2s 循环 | 只在真实进度、真实录音时出现 |

已移除：`tc-bubble`、`tc-breathe`、圆锥渐变旋转环、欢迎页逐项淡入、空状态/配对/加载的 `tc-rise`、`tc-pop`、按下缩放 `.97`、欢迎卡片 hover 上浮。
`prefers-reduced-motion: reduce` 下所有 animation/transition 置为 none（含 `::backdrop`）。
全文件没有任何规则对 `.message` 做 transform、transition 或 animation；虚拟列表内没有入场动画。

## 未改动、明确保留

协议/后端/测试文件；头像 blob 缓存与 revision 冲突处理；草稿为空才显示"查看命令"的保护；创建 Bot/群组/话题、会话、工作区、附件与说明、原生问题卡、引用/转发、连接线路编辑；e2e 依赖的可访问名称（新建对话 / 新建 Bot / 新建群组 / 已连接 / 连接你的 TaroCub / 默认讨论 / 新建话题 / 设置分类等）；`.topic-row`、`.conversation-row`、`.connection-pill.online` 等类名。e2e fixture 只加载 `styles.css`，未修改。

## 需要上级 QA 重点检查的风险

1. **侧栏子行不再渲染头像**：`[data-avatar]` 数量会变少。`avatars.spec` 用的是 >0 和 =0 的断言，Bot 标题行、群组行和顶栏仍会渲染，请实际跑一遍确认。
2. **`hub.spec` 中 `新建对话` 的 `.last()`**：欢迎页的操作按钮仍叫"新建对话"，现在包在 `<li>` 里，DOM 顺序没有变。
3. **设置页**：桌面端输入/下拉高 34px，手机端 44px。请检查 390px 下 `scrollWidth <= innerWidth`、`route-save-bar` 吸底（内边距改为 28px / 手机 16px），以及"扫描新设备配对码"关闭后焦点是否回到原位。
4. **配对页 960–1000px**：两列布局为 420 + 40 + 40 + 内容。请确认没有横向溢出，左右两列在深色模式下的分隔线是否清晰。
5. **卡片 `border.color: "grey"`**：`card-layout.ts` 把它映射成 `var(--grey)`（正文色），所以飞书卡片的折叠块会出现深色边框（旧截图里的"过程 · 1 步"）。这是内容语义映射，不属于纯视觉范围，本次未改。建议后续把 grey 边框映射到 `--border-strong`，同时更新 `card-layout` 测试。
6. **全局 `.lucide{stroke-width:1.75}`**：请抽查二维码扫描器、文件中心等 13–14px 小图标在 1x 屏上的清晰度。
7. **首字母头像**：请检查 CJK、英文多词、emoji 开头三种 Bot 名在 28/32/40/64/224px 下的效果；224px 裁剪预览中字母较大，属正常。
8. **"正在回复"指示**：只在在线、且最近 8 条消息里有 pending/streaming 的 Bot 消息时出现。手机端副标题可能被截断，属正常。
9. **遗留资源**：favicon 仍是 `src/brand/lion.png`；`brand-assets.ts` 和动物 PNG 已不被界面引用，但保留在原处（`client/` 未被 git 跟踪，删除后无法恢复），由维护者决定是否删除。旧品牌的英文词条（如"TaroCub 特点"）仍在 `en.json` 中，无害，`check-translations` 只校验被使用的键。
10. **文档**：`docs/entrypoint-map.md` 第 36–41 行仍在描述奶油/陶土体系，需要改为指向本文件。
