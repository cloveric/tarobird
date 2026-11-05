# 手机设置导航 · 2026-10-04（Opus 5.5）

交接状态：**源码已修改，未构建、未运行任何测试、未在浏览器中渲染。** 本文结论来自
三张“修改前”截图（已用 Read 实际打开）和源码阅读，不构成验收。构建、真实浏览器检查和
测试调整由父代理负责。

范围：只改 `client/src/PreferencesPanel.tsx`、`client/src/preferences.css`、
`client/src/brand-theme.css` 的设置相关规则。`en.json` 未改（没有新增界面字符串）。
未改 App.tsx、MobileHome.tsx、测试、后端、路由和缓存模型；`PreferencesPanel` 的 props
签名保持不变。没有新增动画、依赖、颜色或手绘 SVG。

## 一、截图发现

| 截图 | 观察 | 判断 |
|---|---|---|
| 01 聊天页 | 头部为“‹ + 16.5px 标题”的推入页样式。输入区：附件 / 语音 / 机器人图标 / 发送，机器人图标在触屏上无文字说明。 | 设置页应沿用同一头部语言；机器人图标见第七节 |
| 02 设置首页 | 左侧 15px 小标题“设置”，右上角 ✕。像桌面弹窗，与聊天页“左侧返回”的推入页不一致。 | P1 |
| 03 通用页 | 顶栏左“‹”，标题仍是“设置”，右上角还有 ✕；正文再出现 18px “通用”。当前页名称出现在正文而非顶栏，两个出口（‹ 和 ✕）并存。 | P1 |
| 03 | 语言下拉框约 34px 高，低于 44px。原因：`.settings-content .settings-row select{min-height:34px}`（0,2,1）高于手机的 `.settings-content select{min-height:44px}`（0,1,1）。 | P2，已修 |
| 03 | “14px”被挤到滑块下方单独一行：标签“字号”沿用 120px 最小宽度。 | P3，已修 |
| 源码 | 设备页“断开并重新配对”（`.settings-danger button.text-danger`）手机上仍为 32px：同样是特异性压过手机 44px 规则。 | P2，已修 |

## 二、导航规则

手机（≤760px）一次只显示一层，顶栏标题就是当前页；顶栏左侧按钮、Android 原生 Back、
Escape 三者行为一致，都只向上一层；只有最终离开设置才走未保存线路确认。桌面保持侧栏
分类布局，右上角 ✕ 和 Escape 在任何分类都直接关闭（与修改前相同）。

| 进入方式 | 手机页面 | 顶栏左侧按钮（可访问名称） | Back / Escape |
|---|---|---|---|
| “我的”→设置、桌面齿轮/头像（`initialSection="general"`） | 分类列表，标题“设置” | ‹「关闭设置」 | 关闭设置（有未保存线路则先确认） |
| 由分类列表进入某分类 | 标题为该分类，如“通用” | ‹「返回设置分类」 | 回到分类列表，焦点落回刚才那一行 |
| 聊天菜单“连接” / 连接胶囊（`initialSection="connection"`） | 直接是“连接”页，标题“连接” | ‹「关闭设置」 | 回到来处（聊天），有未保存线路则先确认 |

直接打开的分类页被当作“第一页”：返回去往打开它的地方，而不是一个用户从未看到的分类
列表。一旦用户在分类导航中点过任何分类（例如桌面侧栏，或窗口跨断点后），这个“直接”
标记就清除，之后按普通层级返回。

保留的守卫（逻辑未改，只改了谁调用它们）：

- **未保存线路**：分类内容仍以 `hidden` 保持挂载，返回分类再进入“连接”时草稿仍在，
  分类行上的橙点仍提示“有未保存的修改”。只有 `requestClose`（最终退出）和“管理运行主机”
  会弹“放弃未保存的修改？”。
- **忙碌**：`busy`/`routeBusy` 时顶栏按钮与分类行禁用；Back 被消费但不导航（不会让应用退到后台）；Escape 无效果。
- **嵌套弹层优先**：扫码器与确认框都是 `CreationDialog`（嵌套 `<dialog>`），它们自己的
  Back/Escape 先处理；外层 `onCancel` 仍用 `event.target !== event.currentTarget` 过滤冒泡。
- **强制关闭兜底**（`onClose` 重新 `showModal` 并询问放弃）、**主机管理**（`openHosts`）
  与卸载时的焦点归还（`returnFocus` 或打开前的元素）均未改。

焦点：

- 打开时，焦点给顶栏第一个按钮（手机为 ‹，桌面为 ✕），改为在 `showModal()` 之后显式
  `focus()`，不再用 `autoFocus`。原因：iPhone 横屏宽 844px，会跨过 760px 断点，按钮在
  手机/桌面形态间重新挂载；`autoFocus` 会在重挂载时抢走焦点（例如正在编辑线路地址时收起键盘）。
- 手机进入分类：焦点到顶栏标题（`tabIndex=-1`）。返回分类：焦点到刚离开的那一行
  （改用 `data-section` 定位）。桌面：仍聚焦正文首个 `h3`。

## 三、实际修改

### `client/src/PreferencesPanel.tsx`
- 新增模块级 `phoneQuery` / `subscribePhone` / `phoneLayout`，组件内用
  `useSyncExternalStore` 得到 `phone`（与 App.tsx 的同名判断相同，760px）。
- 新增状态 `direct`（`initialSection !== "general"`），`select()` 时清除。
- 派生 `page = phone && !overview`、`upToCategories = page && !direct`、`pageTitle`。
- `goBack()` 统一处理顶栏左键、`useBackAction`、`onCancel`（扫码打开时仍先关扫码）。
- 顶栏：手机渲染一个前置 ‹（`ChevronLeft` 24px，名称随层级切换），桌面渲染尾部 ✕；
  同一时刻只存在一个出口按钮，没有为测试保留的隐藏控件。
- `h2` 文本：手机分类页为当前分类名，其余为“设置”。
- `<dialog>` 由 `aria-labelledby="settings-title"` 改为 `aria-label={t("设置")}`，
  对话框名称在任何页面都稳定为“设置”/“Settings”；`h2` 不再带 `id`。
- 分类按钮：新增 `data-section`；`aria-current="page"` 只在桌面（侧栏常驻、确有“当前项”）
  输出，手机分类列表本身就是当前页，不再把上次去过的分类报成“当前页”。

### `client/src/preferences.css`
- 删除 `.settings-back{display:none}` 与 `.settings-detail .settings-back{display:inline-flex}`：
  显示与否改由 JSX 决定，避免 CSS 把手机首页的前置按钮隐藏。

### `client/src/brand-theme.css`（仅设置规则）
- 手机顶栏：左右安全区内边距，左 6px，按钮 44×44 圆形、`margin:0`（抵消全局
  `.icon-button{margin-left:auto}`），标题 16.5px / 650 / -.015em、单行省略，与聊天头部一致。
- 手机正文：隐藏每页首个 `h3`（标题已在顶栏），引导语 `settings-lede` 上边距从 -14px 改为 0。
- 手机 44px：`.settings-row select`、`.settings-row>input[type=range]`、`.settings-danger button.text-danger`。
- 手机字号行：含滑块的行，首个标签 `flex:0 0 auto; min-width:0`，让“14px”与滑块同行。
- 新增 `@media(min-width:761px) and (pointer:coarse)`：宽于手机的触屏（如竖屏 iPad）沿用
  桌面布局，但顶栏按钮、分类行和表单控件不低于 44px。鼠标桌面不受影响。

## 四、可访问名称变化（供父代理改测试）

- 对话框：名称来源由 `aria-labelledby` 改为 `aria-label`，**值不变**（“设置”/“Settings”）。
- 手机上的“关闭设置”只存在于首页（分类列表，或直接打开的“连接”页），是左侧 ‹ 而不是 ✕。
  手机分类详情页**不再有**“关闭设置”按钮，只有“返回设置分类”。
- 手机直接打开的“连接”页**没有**“返回设置分类”按钮。
- 手机分类页 `heading` 名称：顶栏 `h2` 为分类名（如“通用”/“General”）；正文同名 `h3`
  为 `display:none`，不再计入可访问树。桌面不变（`h2`“设置” + 正文 `h3`“通用”）。
- 手机分类按钮不再带 `aria-current`。

## 五、预计需调整的现有用例（只读检索，未运行）

| 用例 | 冲突点 |
|---|---|
| `settings.spec.ts`（phone） | 从聊天“打开连接设置”进入后，第一次 `category()` 点“返回设置分类”（直接页没有）；第 25/42/45 行在分类详情点“关闭设置”；第 27 行手机分类详情按 Escape 现在先回分类，需要第二次 Escape 才弹放弃确认。 |
| `settings-language.spec.ts`（320px） | 同上：第 23 行首次 `category()`；第 39/53/57/68 行在分类详情点“Close settings”/“关闭设置”。第 32/64 行 `heading "General"` 预计仍通过（来自顶栏）。 |
| `native-back.spec.ts` | 第 40–41 行：从聊天直接打开“连接”且有未保存线路时，第一次 Back 现在弹放弃确认，而不是回分类列表；关掉确认后仍停在“连接”页，第 46 行点分类导航需改为先离开再经“我的”进入。之后经分类进入设备页、扫码 Back、两次 Back 离开的行为与新规则一致，但前置状态要随前半段一起改。 |
| `mobile-im.spec.ts` 第 133 行 | 手机“通用”详情点“Close settings”，需先返回分类，或用两次 Back。 |
| `palettes.spec.ts` 第 101 行 | 390px 下同上。 |

桌面用例（`openSettings(desktop, …)` 后点“关闭设置”）与 `deployment.spec.ts` 第 84 行（经分类进入，手机点“返回设置分类”）预计不受影响。

建议新增断言：手机分类页 `getByRole("heading", { level: 2 })` 为分类名；直接打开“连接”后
Back 回到聊天且焦点在“更多聊天操作”；经分类进入后两次 Back 才离开，且第二次之前未保存
线路仍在；手机语言下拉框和“断开并重新配对”高度 ≥44px；320px 字号行“14px”与滑块同一行。

## 六、未验证项与风险

1. 未跑 `tsc`/构建。新增代码只用到已导入的 `useSyncExternalStore`、`useRef`、`ChevronLeft`、`X`。
2. 初始焦点依赖 `showModal()` 后的显式 `focus()`；未在 WebKit 中确认与 `showModal` 自身聚焦的先后关系。
3. 跨 760px 断点时（手机横屏）前置/尾部按钮会互换并重新挂载；若焦点恰好在该按钮上会丢到对话框外。未实测。
4. 隐藏正文首个 `h3` 依赖四个分类都以 `h3` 开头（含 `NotificationSettings` 的两个返回分支，已读源码确认）。将来若某页不以 `h3` 开头，顶栏仍有标题，但引导语边距会不同。
5. `(pointer:coarse)` 规则未在任何触屏桌面渲染过；Playwright 默认桌面上下文不会命中。
6. 字号行规则用到 `:has()`，与本仓库其他样式一致；未在 320px 英文下实测。
7. 分类行不再输出 `aria-current` 后，手机 VoiceOver/TalkBack 的朗读未实测。

## 七、需父代理同步的文档

- `docs/client/native-back-navigation.md` 第 18 行：补充“从聊天直接打开的设置分类，Back 返回来处；经分类列表进入的才返回分类”。
- `docs/entrypoint-map.md` 设置段落（`PreferencesPanel.tsx` 条目）可加一句指向本文。

## 八、手机输入区“Bot 协作”图标：一条低风险建议（仅建议，未改）

现状（`App.tsx` 输入区工具栏）：`BotIcon` 18px 纯图标按钮，`aria-label` / `title` 为
“发起 Bot 协作”；触屏没有 tooltip，机器人图形容易被理解为“切换 Bot/AI”，而它实际打开
委托 / 并行 / 串联 / 复核的协作面板。附件和语音是通用图标，可以只用图标；“协作”不是，
需要一个可见文字。

建议：**手机空闲时，把这个按钮改成与“引导”同一套胶囊样式：图标 + 可见短标签“协作”。**

- 标签放在 `<span>` 中，按钮保留 `aria-label="发起 Bot 协作"`，可访问名称不变，现有用例不受影响。
- 只在空闲态显示标签：`.composer-toolbar:has(.composer-stop.is-live)` 时与 ≤360px 时收回成
  44px 圆形图标，复用 `.send-mode-label` / `.composer-steer>span` 已有的收起写法。回复中
  工具栏已有“引导”和“排队”两个标签，不再加第三个。
- 不改图标、位置、禁用条件与点击行为；只加一个 span、一条 en.json 短词和几行 CSS。
- 需要验证：390/360/320px 中英文下工具栏不换行、不溢出；英文短词宜 ≤8 字符（如 “Team up” 或沿用默认模式 “Delegate”，由父代理定）；草稿保存状态 `draft-save-status` 不与标签挤占。
