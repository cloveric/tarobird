# Opus 5.5 mobile audit — original report

Executed with `claude --model claude-opus-5-5 --effort xhigh --no-session-persistence`. Canonical model receipt: claude-opus-5-5; success, 12 turns, no denied tools. This is the uncorrected first review, not the final acceptance report.

我没有跑浏览器测试，下面的结论都来自阅读源码和这 4 张截图。代码一共读了 7 次，读到第 7 次 HostApp 时达到上限。

## 已从源码确认的问题

**1. 高严重度（逻辑已确认，长会话的实际效果还要复现）：从收件箱打开会话后，不会自动滚到最新消息**
- **原因：** `HostApp.tsx:178` 里 `mobileSelect` 就是 `command`。`App.tsx:181` 收到 `select` 后总会设置 `focusTarget={conversationId, messageId: undefined}`。
  - `App.tsx:149` 和 `:289` 只要 `focusTarget` 有值，就跳过滚到底部。
  - `App.tsx:211` 在没有 `messageId` 时什么也不做。
  - 之后只有打字（`changeDraft`）、Back、点「回到最新消息」才会清掉它。
  - 所以手机打开会话后，大概会停在已缓存消息的最上面，流式回复也不会自动跟随。桌面主机目录（`HostApp.tsx:155`）走的是同一条路径，可能也受影响。
- **为什么测试没发现：** 现有 e2e 里每个会话只有 1–2 条消息，截图 01 也只有一条。
- **复现：** 390×844，造一个约 40 条消息的会话 → 在收件箱点开 → 看 `.message-scroll` 是否停在顶部 → 再推一条 bot 消息，看是否跟随。
- **最小修复：** 在 `App.tsx:181` 改成只有带 `action.messageId` 时才 `setFocusTarget`，否则 `setFocusTarget(undefined)`。保留 `setSelected` 和 `setSidebar(false)`。
- **检查：** 在 `mobile-im.spec.ts` 加长会话用例，断言 `scrollHeight - scrollTop - clientHeight < 80`，新消息到达后仍然满足。桌面也加一个同样的断言。

**2. 中：切换主机后，搜索词和筛选会变成另一台主机上残留的状态**
- **原因：** `query` 和 `filter` 是 `MobileHome.tsx:223-224` 里的局部 state。但每个 Workspace 都挂了自己的 MobileHome（`App.tsx:332`），HostApp 也为每台访问过的主机各保留一个 Workspace（`HostApp.tsx:175`）。点另一台主机的会话行时，`command` 会切换当前主机（`HostApp.tsx:90`），Back 回来看到的就是那台主机的收件箱和它自己的状态。收件箱本身是跨主机的，用户看不出自己换了实例。
- **复现：** 两台主机，320px。
  1. 在 B 的收件箱输入 "xyz"。
  2. 「我的」→ 切换到主机 A → 回到「消息」页，在 A 的收件箱点一条 B 的会话 → Back。
  3. 这时又看到 "xyz"，大部分会话行被过滤掉了。反过来，在 A 上选了「未读」，回来后会变成 B 的「全部」。滚动位置也会跟着变。
- **最小修复：** 在 `MobileHome.tsx` 里用一个模块级的小 store 加 `useSyncExternalStore` 存 query 和 filter，让所有实例共享。或者把它们提升到 HostApp，通过 `shell` 传下来。
- **检查：** 扩展 spec 第 2 个用例：在 A 输入搜索词 → 点 B 的会话行 → Back → 断言搜索框的值不变，筛选 chip 的 `aria-pressed` 不变。

**3. 中低：手机上历史搜索结果的 X 按钮回不到收件箱**
- **原因：** `App.tsx:343` 的「关闭搜索」只调了 `closeSearch`。原生 Back（`App.tsx:282`）会额外 `setSidebar(true)`。手机启动时还会自动选中一个会话（`App.tsx:191-196`），所以点 X 会进入一个不相干的会话。另外，搜索期间 header 和 GroupTopics 仍然显示这个旧会话的标题和话题栏（`App.tsx:339-340`），「更多」里的停止和引导也作用在这个会话上。
- **复现：** 390px 收件箱 → 输入「设计」→「搜索历史消息」→ 点 X → 看到的是聊天页，不是收件箱。
- **最小修复：** X 改成 `() => { closeSearch(); if (phone) setSidebar(true); }`，和 Back 共用一个函数。
- **检查：** spec 第 1 个用例里，搜索 → 点 X → `expect(home(page)).toBeVisible()`。

**4. 低：聊天页 header 的「思考强度」触控区只有 24px**
- **证据：** `mobile-shell.css:20` 写的是 `.header-effort { min-height:24px }`，截图 01 里这一行带 ⌄，看起来是个下拉入口。我没读 EffortControl，所以它的根节点是不是按钮还要确认。
- **另一个疑点（只从截图量的，没读 CSS）：** 消息操作行里只有图标的「复制」和导出按钮，宽度看起来不到 44px。
- **最小修复：** 给 `.header-effort` 加 `position:relative`，再用 `::after` 把点击区上下扩到约 44px。
- **检查：** 在 320px 用 Playwright `boundingBox()` 断言 `.header-effort` 和 `.message-actions button` 都 ≥44（或者至少 ≥24 且互不重叠）。

## 需要复现的推测

**5. 矮屏加软键盘时，消息区可能被挤没**
- 按截图 01 估算：顶部 header 加话题栏约 104px，底部「让谁回复」加 3 行输入框加工具栏约 175px，固定部分合计约 280px。
- 在 320×568 上键盘弹起（大约 250px）后，消息区可能只剩几十像素，或者输入框被键盘挡住。具体是哪种，取决于没读到的 viewport 和键盘处理代码，所以不算确认的问题。
- 这次 4 张图里没有 320×568 的聊天页，建议补一张：在聊天页聚焦输入框，用移动端模拟或真机，确认消息区可见高度和输入框位置。

## 看过、没发现问题的部分
- 筛选 chip、清除按钮、「新对话」按钮都通过 `::after` 扩到了约 44px（`mobile-im.css:223-228`、`190-194`、`591-595`）。
- 隐藏 Workspace 的 Back 动作会被 `[hidden]` 过滤掉（`back-navigation.ts:12`）。
- 截图 03 里新建菜单在 320px 没有溢出，截图 04 里「我的」页可以正常滚动。
- 截图 01 里「话题 2」左边那个淡淡的字形，是 `mask-image` 渐隐出来的下一个话题标签，属于有意设计的溢出提示，不是 bug。

模型：Opus 5.5（`claude-opus-5-5`）。运行时没有告诉我 effort 档位，所以没法确认是不是 xhigh。