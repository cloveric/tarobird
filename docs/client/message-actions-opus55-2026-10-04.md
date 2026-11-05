# 手机消息操作：单入口 + 文字底部面板 · 2026-10-04（Opus 5.5）

父代理验收更新：已完成构建、实际渲染与 Chromium/WebKit 定向回归，详见
[最终检查记录](message-actions-qa-2026-10-04.md)。另将手机弹层关闭区扩大至 44px，
并提取 `message-export.ts`，让桌面与手机共享导出进行中状态及结果，解决下文风险 4。
下文保留 Opus 原始交接记录；“未验证”描述的是交接时状态。

交接状态：**源码已修改；我没有构建、类型检查、运行测试，也没有在浏览器里渲染。**
本文结论只来自一张“修改前”截图（已用 Read 实际打开
`docs/client/screenshots/message-actions-20261004/01-phone-before.jpg`）和源码阅读。
构建、实际页面 QA、回归和修错由父代理负责；本文任何地方都不代表验收通过。

处理的问题：[上一轮报告](interaction-polish-opus55-2026-10-04.md) 第七节的 P2
“每条消息下 4–5 个图标重复偏重”。

## 一、截图观察（01-phone-before）

- 390px 宽。一屏内三条消息，每条下面都有一行常显图标：用户消息右对齐
  复制 / 引用 / 转发 / 导出文档 / 重发（5 个），两条 Bot 消息左对齐 4 个。
- 图标都没有文字，触屏上也没有 tooltip；“导出到 Google 文档”只是一个文档图标，
  “重发”是一个循环箭头，单看图标意思不清楚。
- 每屏重复 13 个同样的灰色图标，眼睛从一条气泡走到下一条，先要越过一排操作。
  和输入区的四个图标叠在一起，屏幕下半部分几乎全是图标。
- 右侧 y≈615 的圆形悬浮控件仍是 Read Frog 浏览器扩展，不属于应用。

## 二、设计依据

1. **每条消息只留一个入口“消息操作”（⋯）**，位置就是原来那一行。
   成熟 IM（微信、Telegram、Slack 手机端）主要靠长按，但长按会和系统选字、链接、
   卡片按钮冲突，而且新用户发现不了。这里保留一个可见、可点的 44px 入口，
   不依赖长按，也不加长按。
2. **操作放到有文字标签的底部面板里**，沿用聊天操作菜单已有的分组列表样式。
   面板顶部有两行预览（作者 · 时间 + 摘要），说明这些操作针对哪一条消息：
   面板盖住消息时，用户也能确认目标。
   - 第一组：复制消息、引用回复、转发消息（与桌面栏顺序一致，熟悉的人位置不变）。
   - 第二组：导出到 Google 文档、打开 Google 文档（导出成功后出现）、重新发送消息
     （只在原条件下出现）。这一组会产生外部结果，放在后面。
   - 不能用的操作照常显示，但禁用并写明原因：转发显示“生成完成后可转发”，
     已归档对话中的引用显示“对话已归档，恢复后可引用”。
3. **不压缩行高。** 入口沿用原来 32px 的行和 6px 上间距，44px 触控区上下各伸进
   6px 自身间距，不会盖住气泡、链接或卡片边缘；虚拟列表测量的行高也不变。
   我考虑过把入口放到“作者 · 时间”那一行以省掉整行，但 44px 触控区会向下压住
   气泡或卡片顶部 7–12px，挡住点击，所以没有采用。
4. **桌面不变。** `phone`（≤760px）时渲染单入口；桌面仍是原来的 hover/focus 操作栏，
   包括 `GoogleExport` 的就地结果。
5. 没有新增动画。面板沿用现有 `tc-sheet-up`；导出中的转圈是已有的 `.spin`。

## 三、修改

### 新增 `client/src/MessageActions.tsx`
- `MessageActionsEntry`：`<button aria-label="消息操作" aria-haspopup="dialog">`，Lucide
  `MoreHorizontal`；旁边有一个 `aria-live="polite"` 文本位，复制成功后显示“已复制”。
  这里**刻意不用** `role="status"`：每条消息一个 status 会让现有测试里未限定范围的
  `phone.getByRole("status")`（effort、collaboration 等）匹配到多个元素。
- `MessageActionSheet`：基于 `CreationDialog`（标题/可访问名称“消息操作”，关闭按钮
  “关闭消息操作”）。返回键、Escape、点遮罩都走 `CreationDialog` 原有的
  `useBackAction` / `onCancel` / 遮罩判断。
- Google 文档导出：请求、链接校验和错误文案与 `Content.tsx` 的 `GoogleExport` 相同
  （`POST /api/gdocs/export {messageId}`，同一正则，`文档链接无效` / `导出失败`）。
  不同之处是状态按 `HubConnection`（主机）+ 消息 ID 放在模块级 store，不放在面板里：
  导出中关掉面板不会丢结果；再打开时按钮是忙碌状态，不会诱导重复导出。
  打开面板只读状态，只有点击才会发请求，失败后不会自动重试。
  忙碌时用 `aria-disabled`，不用原生 `disabled`：原生禁用会让正在聚焦的按钮丢失焦点。
  错误放在按钮外面的 `<p role="alert">`，因为 button 的子元素会被当作纯展示内容，
  里面的 alert 不会被朗读。

### `client/src/App.tsx`
- 新增状态：`messageSheet {conversationId, messageId}`、`sheetOrigin`（入口元素与
  “关闭后焦点去处”）、`forwardOrigin`、`copied` + 定时器（卸载时清理）。
- `phone ? <MessageActionsEntry/> : <原桌面操作栏/>`。桌面栏的重发条件抽成
  `canRetry(message)`，桌面和面板共用，表达式没有改。
- `sheetTarget`：仅当 `visible && phone && !sidebar && 无搜索结果 && selected === 目标会话`
  时渲染面板；条件失效时，同一次渲染卸载面板，并用 effect 清空状态（之后再满足条件
  也不会自己弹出来）。原有“工作区不可见时关闭所有弹层”的 effect 也加了清空。
- `sheetMessage` 每次渲染都按 **会话 ID + 消息 ID** 从当前 `messages` 查找当前版本；
  找不到时（已删除）面板只显示“这条消息已不在当前对话中，可能已被删除。”
  （`role="status"`），不显示任何操作。
- 面板动作（语义与桌面栏相同）：
  - 复制：在点击的同步调用栈里先调用 `navigator.clipboard.writeText`（同步抛错也转成
    rejected promise），再关面板。成功后入口旁显示“已复制”3 秒；失败时撤掉任何
    “已复制”，并在现有错误横幅（`role="alert"`）显示“无法写入剪贴板。可以长按消息文字
    选择后复制。”
  - 引用：`setReply(当前消息)`，先原生 `dialog.close()` 解除模态 inert，再在同一次点击里
    `composer.focus()`，这样 iOS 键盘能弹出，然后关面板。草稿不动。归档时直接返回。
  - 转发：只在 complete/error 时可用；`forwardTrigger` 设为入口，关面板，同一批次打开
    `ForwardMessage`。
  - 重发：关面板后调用原 `retryMessage`（转发型来源仍走原来的 composer 焦点逻辑）。
- 焦点：新增 `messageFocus(conversationId, messageId, trigger)`。如果会话已切换，返回本会话
  的稳定控件（手机为头部“更多聊天操作”，桌面为输入框）；原触发元素仍挂载时用它；
  否则按 `data-message-id` 找同一条消息的入口或桌面栏按钮；都找不到就退回稳定控件。
  `sheetReturn` / `forwardReturn` 是 `useMemo([])` 的稳定 getter 对象，在
  `CreationDialog` 清理时才求值，所以拿到的是关闭那一刻的节点。
  `ForwardMessage` 的 `returnFocus` 改为 `forwardReturn`：桌面上触发按钮仍在时行为不变；
  转发成功切到目标会话后，焦点不再落到即将卸载的旧按钮上。

### `client/src/mobile-shell.css`
- 面板：`.message-sheet-preview`（surface-alt 圆角块，作者行单行省略，摘要两行截断）、
  `.message-sheet-list` 的链接行/分隔线/错误行（缩进 50px 与标签对齐）、
  `.message-sheet-gone`。
- 手机入口：用户消息 `row-reverse`（“已复制 ⋯”贴右）、图标 18px、状态 12px muted。
- 全部使用已有 token，未新增颜色。

### `client/src/brand-theme.css`
- 只改了两段注释，说明手机端的 `.message-actions` 现在承载单入口。规则未改。

### `client/src/locales/en.json`
新增 7 条：`消息操作`、`关闭消息操作`、`已复制`、
`无法写入剪贴板。可以长按消息文字选择后复制。`、`对话已归档，恢复后可引用`、
`正在导出…`、`这条消息已不在当前对话中，可能已被删除。`。其余文案都复用已有键。

没有修改：已有测试、后端、缓存模型、主机路由、媒体实现、`Content.tsx`、
`CreationDialog.tsx`、`ForwardMessage.tsx`；没有新增依赖，也没有手绘 SVG。

## 四、边界处理（源码层面，未实测）

| 要求 | 处理 |
|---|---|
| Safari 复制需要用户激活 | `writeText` 是复制回调里的第一个异步调用，前面没有 await 或 setState |
| 反馈不虚报 | “已复制”只在 promise resolve 后显示；reject 时撤销并报错 |
| 引用对象正确、保留草稿 | 按 ID 取当前消息；只调用 `setReply` |
| 转发焦点不落到已卸载节点 | `forwardReturn` 在关闭时检查 `isConnected`，再按 ID 查找，最后退回稳定控件 |
| 导出不因开菜单触发或自动重试 | 渲染只读 store；`exportMessage` 只由点击调用，忙碌时直接返回 |
| 用户重发 | 原 `retryMessage`，显示条件相同（`canRetry`） |
| 已删除 / 已归档 / 离线 | 删除：显示提示，不显示操作；归档：引用禁用并说明；离线：与桌面走同一代码路径（复制可用；转发/重发经 `connection.send` 进入 outbox；导出经 `connection.http`，失败时在面板显示它抛出的错误） |
| 切会话/主机、进入收件箱/搜索 | `sheetTarget` 失效后立即卸载并清空状态 |
| 滚动卸载、消息更新 | 面板不依赖行 DOM；按 ID 取当前版本；关闭时焦点按 ID 重新查找 |
| 旋转到桌面 | `phone` 为 false 时面板卸载；焦点落到该消息的桌面栏按钮 |
| Back / Escape / 遮罩 | `CreationDialog` 原有机制；转发时先关面板，任何时候只有一层 |
| 键盘 | 入口和各行都是原生 button / a；面板打开时的初始焦点沿用 `CreationDialog` 的 `showModal()` 默认行为（未改，具体落点以浏览器为准） |
| 不挡选字、链接、卡片 | 消息内容上没有 touch/长按处理；入口触控区只伸进行自身间距 |

## 五、未验证项与风险

1. **未构建、未类型检查。** 需要特别看：getter 对象赋给 React 19 `RefObject`；
   `sheetTarget && messages.find(...)` 的推断类型；`setTimeout` 返回类型；TS 7 对闭包收窄的处理
   （面板内已改为显式 `messageId`）。
2. **`aria-disabled` 与 Playwright `toBeDisabled()`。** 父代理的 spec 第 78 行断言导出按钮
   `toBeDisabled()`。我的理解是 Playwright 会把 `aria-disabled="true"` 视为禁用，
   但没有实际运行确认；如果失败，可以改回原生 `disabled`，代价是键盘焦点会在导出开始时丢失。
3. **原生 `dialog.close()` 后立刻 `focus()`**：Chromium 在 close 时会把焦点还给打开前的元素，
   随后再移到输入框。iOS Safari 能否在这次点击里弹出键盘，需要真机确认；WebKit
   Playwright 只能验证焦点。
4. **导出逻辑有重复**：`GoogleExport`（桌面）和 `MessageActions` 的 store（手机）是两份相同逻辑。
   桌面版状态仍然跟着行组件，行被回收后结果会丢（这是原有行为）。在手机导出中途旋转到
   桌面，桌面栏看不到这次导出结果。建议之后在 `Content.tsx` 中让 `GoogleExport`
   也使用同一个 store（不在我的可改范围内）。
5. **视觉未渲染**：⋯ 的灰度是否足够“明显可点击”；“已复制”和入口在 320px、用户消息
   右对齐时的位置；英文 “Couldn't copy to the clipboard…” 在错误横幅里的换行；
   面板在 320×568 小屏上的总高度（最多预览 + 两组 6 行 + 导出错误行，未测；手机 `.creation-dialog`
   有 max-height，内容在面板内滚动）；
   深色模式和四套配色下预览块 `--surface-alt` 的对比度。
6. 面板关闭后焦点会移到入口。触屏不显示 focus ring（`:focus-visible` 启发式），但
   Android 外接键盘时会看到焦点环，这是预期行为。
7. 入口每条消息都有 `aria-label="消息操作"`，读屏用户逐个浏览按钮时会听到重复名称。
   所在 article 提供了上下文，但没有加 `aria-describedby` 指向作者和时间；如果需要，
   后续可以补上。
8. 撰写过程中我读到父代理已经更新了 `message-actions.spec.ts`、`host-workspace.spec.ts`、
   `delegation.spec.ts` 和 `fixtures/message-actions.ts`。按源码阅读，它们的入口名、对话框名、
   按钮名、删除提示和焦点断言都与本实现一致，但**没有运行**。

## 六、建议父代理测试

- 构建：`client` 的 `build`（包含 `check-translations`），以及 `tsc`。
- 浏览器（Chromium + WebKit）：`message-actions`（三个用例）、`delegation`（手机复制）、
  `host-workspace`（跨主机关面板）、`effort` / `collaboration`（确认手机上未限定范围的
  `getByRole("status")` 没有歧义）、`mobile-im`、`native-back`、`long-messages`、
  `link-preview`、`card-layout`（行高与虚拟列表测量不变）。
- 建议补充断言：
  - 手机 article 内恰好只有 1 个 button 属于操作行（`消息操作`），桌面 hover 栏按钮数不变。
  - 复制成功后入口旁 `getByText("已复制")` 可见，3 秒后消失；连续两次复制，第二次失败时
    “已复制”消失，同时出现 alert。
  - 导出成功（route 返回合法 docs 链接）后，面板内出现 link “打开 Google 文档”；
    关掉再打开面板，链接仍在，`exports` 仍为 1。
  - 用户消息显示“重新发送消息”，Bot 正常消息不显示；error Bot 回复且其 `replyTo` 是用户消息时显示。
  - 320px 英文界面：面板行不溢出（沿用 `settings-language` 的行边界检查方式）。
  - WebKit：引用后 `composer` 获得焦点。
- 截图：390 / 320 浅色和深色，修改前后同一会话对比（01-phone-before 的场景）。

## 七、需父代理处理

- 在 `docs/entrypoint-map.md` 的 Mobile IM 段落加一句指向本文（我没有该文件的编辑权限）。
- 确认风险 2 之后，决定是否保留 `aria-disabled`。
- 可选：按风险 4 统一 `GoogleExport` 的状态来源。
